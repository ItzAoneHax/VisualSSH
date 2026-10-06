import { defineStore } from "pinia";
import { computed, ref } from "vue";

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
  const selectedName = ref<string | null>(null);
  /** 详情视图列排序（Files：点击列头切换，同列翻转方向） */
  const sortKey = ref<SortKey>("name");
  const sortAsc = ref(true);

  /** 浏览历史（资源管理器 ←/→） */
  const history = ref<string[]>([]);
  const historyIndex = ref(-1);
  let viaHistory = false;

  /** 就地重命名中的条目名（FileTable 在名称列渲染输入框） */
  const renamingName = ref<string | null>(null);
  /** 新建草稿类型（列表顶部渲染输入行） */
  const newDraft = ref<"dir" | "file" | null>(null);
  /** 文件操作进行中（防重入，右键菜单/快捷键据此置灰） */
  const opPending = ref(false);

  const canBack = computed(() => historyIndex.value > 0);
  const canForward = computed(
    () => historyIndex.value < history.value.length - 1,
  );

  async function open(path: string) {
    if (!connectionId.value || loading.value) return;
    loading.value = true;
    error.value = null;
    selectedName.value = null;
    cancelEdit();
    try {
      entries.value = await listDir(connectionId.value, path);
      cwd.value = path;
      // 刷新（同路径）不入历史栈，避免后退在相同目录间空转
      if (!viaHistory && path !== history.value[historyIndex.value]) {
        history.value = [...history.value.slice(0, historyIndex.value + 1), path];
        historyIndex.value = history.value.length - 1;
      }
    } catch (e) {
      // 失败时保留旧目录内容，仅呈现错误横幅
      error.value = e instanceof Error ? e.message : String(e);
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

  function enter(name: string) {
    if (!loading.value) void open(joinPath(cwd.value, name));
  }

  function refresh() {
    void open(cwd.value);
  }

  function up() {
    if (cwd.value !== "/" && !loading.value) void open(parentPath(cwd.value));
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
        selectedName.value = name;
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
        selectedName.value = name;
      },
    );
  }

  function deleteEntry(name: string, recursive: boolean) {
    void runOp(
      () => deleteSsh(connectionId.value, joinPath(cwd.value, name), recursive),
      () => {
        if (selectedName.value === name) selectedName.value = null;
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
    selectedName.value = null;
    // 连接初始态应用设置默认值（排序/隐藏项显隐）
    showHidden.value = useSettingsStore().settings.showHidden;
    sortKey.value = useSettingsStore().settings.defaultSortKey;
    sortAsc.value = useSettingsStore().settings.defaultSortKey !== "mtime";
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
    cancelEdit();
  }

  const visibleEntries = computed(() => {
    const key = sortKey.value;
    const asc = sortAsc.value ? 1 : -1;
    const dirFirst = (a: FileEntry, b: FileEntry) =>
      (a.kind === "dir" ? 0 : 1) - (b.kind === "dir" ? 0 : 1);

    const compare: Record<SortKey, (a: FileEntry, b: FileEntry) => number> = {
      name: (a, b) =>
        a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }),
      mtime: (a, b) => (a.mtime ?? 0) - (b.mtime ?? 0),
      kind: (a, b) => a.kind.localeCompare(b.kind),
      size: (a, b) => a.size - b.size,
      permissions: (a, b) => a.permissions.localeCompare(b.permissions),
    };

    return entries.value
      .filter((e) => showHidden.value || !e.name.startsWith("."))
      .slice()
      .sort((a, b) => dirFirst(a, b) || asc * compare[key](a, b));
  });

  function sortBy(key: SortKey) {
    if (sortKey.value === key) {
      sortAsc.value = !sortAsc.value;
    } else {
      sortKey.value = key;
      // 修改时间默认最新在前，其余列默认升序
      sortAsc.value = key !== "mtime";
    }
  }

  /** 面包屑分段："/" → []，"/var/log" → ["var", "log"] */
  const breadcrumbSegments = computed(() =>
    cwd.value.split("/").filter(Boolean),
  );

  function select(name: string | null) {
    selectedName.value = name;
  }

  return {
    connectionId,
    cwd,
    entries,
    loading,
    error,
    showHidden,
    selectedName,
    sortKey,
    sortAsc,
    renamingName,
    newDraft,
    opPending,
    canBack,
    canForward,
    visibleEntries,
    breadcrumbSegments,
    open,
    back,
    forward,
    enter,
    refresh,
    up,
    reset,
    clear,
    select,
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
