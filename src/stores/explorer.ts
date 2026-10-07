import { defineStore } from "pinia";
import { computed, ref, watch } from "vue";

import { chmodSsh, deleteSsh, listDir, mkdirSsh, renameSsh, touchSsh } from "@/api/ssh";
import type { FileEntry } from "@/types";
import { joinPath, parentPath } from "@/utils/format";
import { useSettingsStore } from "@/stores/settings";

export type SortKey = "name" | "mtime" | "kind" | "size" | "permissions";

export const SORT_KEYS: SortKey[] = [
  "name",
  "mtime",
  "kind",
  "size",
  "permissions",
];

/**
 * 远程文件浏览器状态（单工作区）。
 * 含浏览历史栈，支持资源管理器语义的后退/前进。
 */
export const useExplorerStore = defineStore("explorer", () => {
  const connectionId = ref("");
  const cwd = ref("/");
  const entries = ref<FileEntry[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const showHidden = ref(false);
  /** 多选集合（Windows 语义：单击/Ctrl 反选/Shift 范围/框选） */
  const selectedNames = ref<Set<string>>(new Set());
  /** Shift 范围选择锚点（上次单选/反选项，非响应式） */
  let anchorName: string | null = null;
  /** 详情视图列排序（Files：点击列头切换，同列翻转方向） */
  const sortKey = ref<SortKey>("name");
  const sortAsc = ref(true);

  /** 浏览历史（资源管理器 ←/→） */
  const history = ref<string[]>([]);
  const historyIndex = ref(-1);
  let viaHistory = false;

  /** 地址栏搜索：即时过滤当前目录（名称 contains，不区分大小写；空 = 不过滤） */
  const searchQuery = ref("");

  /** 就地重命名中的条目名（FileTable 在名称列渲染输入框） */
  const renamingName = ref<string | null>(null);
  /** 新建草稿类型（列表顶部渲染输入行） */
  const newDraft = ref<"dir" | "file" | null>(null);
  /** 文件操作进行中（防重入，右键菜单/快捷键据此置灰） */
  const opPending = ref(false);
  /** 返回上级后待定位选中的条目名（ScrollToPreviousFolderWhenNavigatingUp；FileTable 滚动到位后置回 null） */
  const selectAfterLoad = ref<string | null>(null);

  const canBack = computed(() => historyIndex.value > 0);
  const canForward = computed(
    () => historyIndex.value < history.value.length - 1,
  );

  async function open(path: string) {
    if (!connectionId.value || loading.value) return;
    loading.value = true;
    error.value = null;
    selectedNames.value = new Set();
    anchorName = null;
    cancelEdit();
    try {
      entries.value = await listDir(connectionId.value, path);
      cwd.value = path;
      // 刷新（同路径）不入历史栈，避免后退在相同目录间空转
      if (!viaHistory && path !== history.value[historyIndex.value]) {
        history.value = [...history.value.slice(0, historyIndex.value + 1), path];
        historyIndex.value = history.value.length - 1;
      }
      // 返回上级：定位并选中原目录行（滚动由 FileTable 处理）
      const pending = selectAfterLoad.value;
      if (pending) {
        if (entries.value.some((e) => e.name === pending)) selectOnly(pending);
        else selectAfterLoad.value = null;
      }
    } catch (e) {
      // 失败时保留旧目录内容，仅呈现错误横幅
      error.value = e instanceof Error ? e.message : String(e);
      selectAfterLoad.value = null;
    } finally {
      viaHistory = false;
      loading.value = false;
    }
  }

  /** 文件操作成功后的原地重载：保持排序、选中与滚动位置（不动历史栈） */
  async function reloadPreserve() {
    if (!connectionId.value || loading.value) return;
    loading.value = true;
    try {
      entries.value = await listDir(connectionId.value, cwd.value);
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
    } finally {
      loading.value = false;
    }
  }

  function back() {
    if (!canBack.value || loading.value) return;
    viaHistory = true;
    historyIndex.value -= 1;
    void open(history.value[historyIndex.value]);
  }

  function forward() {
    if (!canForward.value || loading.value) return;
    viaHistory = true;
    historyIndex.value += 1;
    void open(history.value[historyIndex.value]);
  }

  /** 后退历史飞出直达：跳到指定历史位置（该位置之后的路径出栈） */
  function navigateToHistory(index: number) {
    if (loading.value || index < 0 || index >= history.value.length) return;
    viaHistory = true;
    historyIndex.value = index;
    void open(history.value[index]);
  }

  /** 后退可达的历史路径（当前索引之前，最近在上） */
  const backHistory = computed(() =>
    history.value
      .slice(0, historyIndex.value)
      .map((path, i) => ({ path, index: i }))
      .reverse(),
  );

  function enter(name: string) {
    if (!loading.value) void open(joinPath(cwd.value, name));
  }

  function refresh() {
    void open(cwd.value);
  }

  function up() {
    if (cwd.value !== "/" && !loading.value) {
      // 返回上级后定位选中原目录（ScrollToPreviousFolderWhenNavigatingUp，默认开启）
      selectAfterLoad.value = cwd.value.split("/").filter(Boolean).pop() ?? null;
      void open(parentPath(cwd.value));
    }
  }

  function entryByName(name: string | null): FileEntry | null {
    if (!name) return null;
    return entries.value.find((e) => e.name === name) ?? null;
  }

  function startRename(name: string | null) {
    if (!entryByName(name)) return;
    newDraft.value = null;
    renamingName.value = name;
  }

  function startCreate(kind: "dir" | "file") {
    renamingName.value = null;
    newDraft.value = kind;
  }

  function cancelEdit() {
    renamingName.value = null;
    newDraft.value = null;
  }

  /** 名称预校验：去空白、拒绝斜杠与重名；不合法时置错误横幅并返回 null */
  function validateName(name: string, origin?: string): string | null {
    const trimmed = name.trim();
    if (!trimmed || trimmed === origin) return null;
    if (trimmed.includes("/")) {
      error.value = "名称不能包含斜杠 “/”";
      return null;
    }
    if (entries.value.some((e) => e.name === trimmed)) {
      error.value = `「${trimmed}」已存在`;
      return null;
    }
    return trimmed;
  }

  /** 执行文件操作：成功后原地刷新（onSuccess 先行调整选中态），失败走错误横幅 */
  async function runOp(op: () => Promise<void>, onSuccess?: () => void) {
    if (opPending.value || !connectionId.value) return;
    opPending.value = true;
    error.value = null;
    try {
      await op();
      onSuccess?.();
      await reloadPreserve();
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
    } finally {
      opPending.value = false;
    }
  }

  function createEntry(kind: "dir" | "file", rawName: string) {
    const name = validateName(rawName);
    cancelEdit();
    if (!name) return;
    const path = joinPath(cwd.value, name);
    void runOp(
      () => (kind === "dir" ? mkdirSsh : touchSsh)(connectionId.value, path),
      () => {
        selectOnly(name);
      },
    );
  }

  function renameEntry(oldName: string, rawName: string) {
    const name = validateName(rawName, oldName);
    cancelEdit();
    if (!name) return;
    void runOp(
      () =>
        renameSsh(
          connectionId.value,
          joinPath(cwd.value, oldName),
          joinPath(cwd.value, name),
        ),
      () => {
        selectOnly(name);
      },
    );
  }

  function deleteEntry(name: string, recursive: boolean) {
    void runOp(
      () => deleteSsh(connectionId.value, joinPath(cwd.value, name), recursive),
      () => {
        if (selectedNames.value.has(name)) {
          const next = new Set(selectedNames.value);
          next.delete(name);
          selectedNames.value = next;
        }
      },
    );
  }

  function chmodEntry(name: string, mode: number) {
    void runOp(() => chmodSsh(connectionId.value, joinPath(cwd.value, name), mode));
  }

  function reset(nextConnectionId: string, rootPath: string) {
    connectionId.value = nextConnectionId;
    cwd.value = rootPath;
    entries.value = [];
    error.value = null;
    selectedNames.value = new Set();
    anchorName = null;
    // 连接初始态应用设置默认值（排序/方向/隐藏项显隐）
    showHidden.value = useSettingsStore().settings.showHidden;
    sortKey.value = useSettingsStore().settings.defaultSortKey;
    sortAsc.value = !useSettingsStore().settings.defaultSortDesc;
    history.value = [];
    historyIndex.value = -1;
    viaHistory = false;
    void open(rootPath);
  }

  function clear() {
    connectionId.value = "";
    entries.value = [];
    cwd.value = "/";
    error.value = null;
    history.value = [];
    historyIndex.value = -1;
    selectedNames.value = new Set();
    anchorName = null;
    searchQuery.value = "";
    cancelEdit();
  }

  const visibleEntries = computed(() => {
    const key = sortKey.value;
    const asc = sortAsc.value ? 1 : -1;
    // 排序优先级（Files SortPriority）：文件夹优先 / 文件优先 / 混合
    const dirOrder = (e: FileEntry) => (e.kind === "dir" ? 0 : 1);
    const priority = useSettingsStore().settings.sortPriority;
    const prio =
      priority === "mixed"
        ? 0
        : priority === "folders"
          ? 1
          : -1;

    const compare: Record<SortKey, (a: FileEntry, b: FileEntry) => number> = {
      name: (a, b) =>
        a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }),
      mtime: (a, b) => (a.mtime ?? 0) - (b.mtime ?? 0),
      kind: (a, b) => a.kind.localeCompare(b.kind),
      size: (a, b) => a.size - b.size,
      permissions: (a, b) => a.permissions.localeCompare(b.permissions),
    };

    const q = searchQuery.value.trim().toLowerCase();
    return entries.value
      .filter((e) => showHidden.value || !e.name.startsWith("."))
      .filter((e) => !q || e.name.toLowerCase().includes(q))
      .slice()
      .sort((a, b) => prio * (dirOrder(a) - dirOrder(b)) || asc * compare[key](a, b));
  });

  // 目录内容变化后剔除已不存在的选择项（保持其余选择）
  watch(visibleEntries, (entries) => {
    const alive = new Set(entries.map((e) => e.name));
    const kept = [...selectedNames.value].filter((n) => alive.has(n));
    if (kept.length !== selectedNames.value.size) {
      selectedNames.value = new Set(kept);
    }
  });

  function sortBy(key: SortKey) {
    if (sortKey.value === key) {
      sortAsc.value = !sortAsc.value;
    } else {
      sortKey.value = key;
      // 换列默认升序（方向由设置「降序排序」决定初始态，列头点击不再有列特例）
      sortAsc.value = true;
    }
  }

  /** 面包屑分段："/" → []，"/var/log" → ["var", "log"] */
  const breadcrumbSegments = computed(() =>
    cwd.value.split("/").filter(Boolean),
  );

  function select(name: string | null) {
    if (name) selectOnly(name);
    else clearSelection();
  }

  function selectOnly(name: string) {
    selectedNames.value = new Set([name]);
    anchorName = name;
  }

  function toggleSelect(name: string) {
    const next = new Set(selectedNames.value);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    selectedNames.value = next;
    anchorName = name;
  }

  /** Shift 范围：锚点 → 当前项（按可见顺序） */
  function selectRange(name: string) {
    const names = visibleEntries.value.map((e) => e.name);
    const a = names.indexOf(anchorName ?? name);
    const b = names.indexOf(name);
    if (a < 0 || b < 0) {
      selectOnly(name);
      return;
    }
    const [lo, hi] = a < b ? [a, b] : [b, a];
    selectedNames.value = new Set(names.slice(lo, hi + 1));
  }

  /** 框选结果应用（additive = 按住 Ctrl 的并集框选） */
  function applyRubberSelection(names: string[], additive: boolean) {
    if (additive) {
      const next = new Set(selectedNames.value);
      for (const n of names) next.add(n);
      selectedNames.value = next;
    } else {
      selectedNames.value = new Set(names);
    }
  }

  function clearSelection() {
    selectedNames.value = new Set();
    anchorName = null;
  }

  /** 全选（Ctrl+A）：按当前过滤后的可见集合 */
  function selectAll() {
    const names = visibleEntries.value.map((e) => e.name);
    selectedNames.value = new Set(names);
    anchorName = names.length ? names[names.length - 1] : null;
  }

  /** 反选（Ctrl+I，Files InvertSelectionAction）：可见集合内取补集 */
  function invertSelection() {
    const inverted = visibleEntries.value
      .map((e) => e.name)
      .filter((n) => !selectedNames.value.has(n));
    selectedNames.value = new Set(inverted);
    // 锚点移出集合时清除，避免下一次 Shift 范围从不可见锚点起算
    if (anchorName && !inverted.includes(anchorName)) anchorName = null;
  }

  function isSelected(name: string): boolean {
    return selectedNames.value.has(name);
  }

  /** 批量删除：单个 runOp 内串行执行，失败即停（剩余保持） */
  async function deleteEntries(names: string[], recursive: (name: string) => boolean) {
    if (opPending.value || !connectionId.value) return;
    opPending.value = true;
    error.value = null;
    const failed: string[] = [];
    for (const name of names) {
      try {
        await deleteSsh(connectionId.value, joinPath(cwd.value, name), recursive(name));
      } catch (e) {
        failed.push(name);
        error.value = e instanceof Error ? e.message : String(e);
        break;
      }
    }
    opPending.value = false;
    if (!failed.length) {
      await reloadPreserve();
      const removed = new Set(names);
      const kept = [...selectedNames.value].filter((n) => !removed.has(n));
      selectedNames.value = new Set(kept);
    }
  }

  return {
    connectionId,
    cwd,
    entries,
    loading,
    error,
    showHidden,
    searchQuery,
    selectedNames,
    sortKey,
    sortAsc,
    renamingName,
    newDraft,
    opPending,
    selectAfterLoad,
    canBack,
    canForward,
    backHistory,
    visibleEntries,
    breadcrumbSegments,
    open,
    reloadPreserve,
    back,
    forward,
    navigateToHistory,
    enter,
    refresh,
    up,
    reset,
    clear,
    select,
    selectOnly,
    toggleSelect,
    selectRange,
    applyRubberSelection,
    clearSelection,
    selectAll,
    invertSelection,
    isSelected,
    deleteEntries,
    sortBy,
    entryByName,
    startRename,
    startCreate,
    cancelEdit,
    createEntry,
    renameEntry,
    deleteEntry,
    chmodEntry,
  };
});
