import { defineStore } from "pinia";
import { computed, ref, watch } from "vue";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import {
  searchCancel,
  searchStart,
  type SearchProgress,
} from "@/api/ssh";
import { chmodSsh, deleteSsh, listDir, mkdirSsh, renameSsh, touchSsh } from "@/api/ssh";
import type { FileEntry } from "@/types";
import { joinPath, parentPath } from "@/utils/format";
import {
  getFolderPref,
  putFolderPref,
  type ColumnState,
} from "@/stores/folderPrefs";
import { useSettingsStore } from "@/stores/settings";

/** path 排序键专用于搜索结果页（Files SortOption.Path），不写入目录记忆 */
export type SortKey =
  | "name"
  | "mtime"
  | "kind"
  | "size"
  | "permissions"
  | "owner"
  | "group"
  | "path";

export const SORT_KEYS: SortKey[] = [
  "name",
  "mtime",
  "kind",
  "size",
  "permissions",
  "owner",
  "group",
];

/** 详情视图列默认状态（默认宽与 Files DetailsLayoutPage 现状一致；owner/group 默认隐藏） */
export const DEFAULT_COLUMNS: ColumnState[] = [
  { key: "name", width: 0, visible: true },
  { key: "mtime", width: 160, visible: true },
  { key: "kind", width: 96, visible: true },
  { key: "size", width: 96, visible: true },
  { key: "permissions", width: 112, visible: true },
  { key: "owner", width: 128, visible: false },
  { key: "group", width: 128, visible: false },
];

/** 搜索结果行：条目元数据 + 相对路径（FileEntry 超集） */
export interface SearchHitRow extends FileEntry {
  relPath: string;
}

/** 递归搜索会话（进入即表格切换为结果视图；Esc/清词退出回原目录） */
export interface SearchSession {
  searchId: string;
  query: string;
  dir: string;
  hits: SearchHitRow[];
  running: boolean;
  cancelled: boolean;
  capped: boolean;
}

/** 搜索历史（GeneralSettingsService.PreviousSearchQueriesList 语义：去重置顶，上限 10） */
const SEARCH_HISTORY_KEY = "visualssh:search-history:v1";
const SEARCH_HISTORY_LIMIT = 10;

function loadSearchHistory(): string[] {
  try {
    const raw = localStorage.getItem(SEARCH_HISTORY_KEY);
    const parsed = raw ? (JSON.parse(raw) as string[]) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** 每连接上次浏览目录（visualssh:session:v1：map profileId → lastDir） */
const SESSION_KEY = "visualssh:session:v1";

function loadLastDirs(): Record<string, string> {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, string>) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveLastDir(profileId: string, dir: string) {
  if (!profileId) return;
  try {
    const map = loadLastDirs();
    map[profileId] = dir;
    localStorage.setItem(SESSION_KEY, JSON.stringify(map));
  } catch {
    // 隐私模式：跳过
  }
}

/**
 * 远程文件浏览器状态（每「标签×窗格」一个实例，M7）。
 * 含浏览历史栈，支持资源管理器语义的后退/前进。
 *
 * 实例化选型：动态 id 的 Pinia defineStore（explorer-{paneId}）+ 工厂缓存——
 * 现有 setup 体原样复用（目录/历史/选择/搜索/草稿全套状态零改动），
 * 各实例经 Pinia 天然隔离，devtools 可见；关闭窗格经 disposeExplorer 显式回收。
 * 组件一律经 useExplorer(paneId) 取实例，不直接使用本模块的 defineStore 产物。
 */
function buildExplorerStore() {
  const connectionId = ref("");
  /** 目录记忆/侧栏收藏的键（profile.id；连接切换时更新） */
  const profileId = ref("");
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

  function defaultColumns(): ColumnState[] {
    return DEFAULT_COLUMNS.map((c) => ({ ...c }));
  }
  /** 详情视图列状态（宽/显隐，按目录记忆；名称列恒弹性且不可隐藏） */
  const columns = ref<ColumnState[]>(defaultColumns());

  /** 浏览历史（资源管理器 ←/→） */
  const history = ref<string[]>([]);
  const historyIndex = ref(-1);
  let viaHistory = false;

  /** 地址栏搜索：即时过滤当前目录（名称 contains，不区分大小写；空 = 不过滤） */
  const searchQuery = ref("");

  /** 递归搜索会话（非空 = 结果视图模式） */
  const searchSession = ref<SearchSession | null>(null);
  /** 搜索历史（聚焦且输入为空时下拉展示，点击即执行递归搜索） */
  const searchHistory = ref<string[]>(loadSearchHistory());
  let unlistenSearch: UnlistenFn | null = null;
  /** 进入搜索前的主视图排序（退出时恢复） */
  let savedSort: { key: SortKey; asc: boolean } | null = null;

  function pushSearchHistory(query: string) {
    const q = query.trim();
    if (!q) return;
    const next = [q, ...searchHistory.value.filter((h) => h !== q)].slice(
      0,
      SEARCH_HISTORY_LIMIT,
    );
    searchHistory.value = next;
    try {
      localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(next));
    } catch {
      // 隐私模式：仅会话内生效
    }
  }

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
    // 浏览新目录即离开搜索结果视图
    if (searchSession.value) exitSearch(true);
    loading.value = true;
    error.value = null;
    selectedNames.value = new Set();
    anchorName = null;
    cancelEdit();
    try {
      entries.value = await listDir(connectionId.value, path);
      cwd.value = path;
      // 记录每连接上次浏览目录（AppLifecycleHelper.SaveSessionTabs 的每连接简化版）
      saveLastDir(profileId.value, path);
      // 刷新（同路径）不入历史栈，避免后退在相同目录间空转
      if (!viaHistory && path !== history.value[historyIndex.value]) {
        history.value = [...history.value.slice(0, historyIndex.value + 1), path];
        historyIndex.value = history.value.length - 1;
      }
      applyFolderPrefs(path);
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

  /** 连接建立：优先恢复该 profile 上次浏览目录（设置可关），listDir 失败回退默认目录 */
  async function reset(nextConnectionId: string, rootPath: string, nextProfileId = "") {
    connectionId.value = nextConnectionId;
    profileId.value = nextProfileId;
    cwd.value = rootPath;
    entries.value = [];
    error.value = null;
    selectedNames.value = new Set();
    anchorName = null;
    // 连接初始态应用设置默认值（排序/方向/隐藏项显隐/列状态）
    const s = useSettingsStore().settings;
    showHidden.value = s.showHidden;
    sortKey.value = s.defaultSortKey;
    sortAsc.value = !s.defaultSortDesc;
    columns.value = defaultColumns();
    history.value = [];
    historyIndex.value = -1;
    viaHistory = false;
    selectAfterLoad.value = null;
    const lastDir = s.restoreLastDir ? loadLastDirs()[nextProfileId] : null;
    if (lastDir && lastDir !== rootPath) {
      await open(lastDir);
      if (error.value) {
        // 上次目录已失效（被删/无权限）：回退默认目录并清掉错误横幅
        error.value = null;
        await open(rootPath);
      }
    } else {
      await open(rootPath);
    }
  }

  function clear() {
    connectionId.value = "";
    profileId.value = "";
    entries.value = [];
    cwd.value = "/";
    error.value = null;
    history.value = [];
    historyIndex.value = -1;
    selectedNames.value = new Set();
    anchorName = null;
    searchQuery.value = "";
    exitSearch();
    cancelEdit();
  }

  const visibleEntries = computed<FileEntry[]>(() => {
    // 递归搜索结果视图：按主排序键作用于命中集合（path 键即相对路径）
    if (searchSession.value) {
      const key = sortKey.value;
      const asc = sortAsc.value ? 1 : -1;
      const dirOrder = (e: FileEntry) => (e.kind === "dir" ? 0 : 1);
      const prio = useSettingsStore().settings.sortPriority === "files" ? -1 : useSettingsStore().settings.sortPriority === "mixed" ? 0 : 1;
      const rel = (e: FileEntry) => (e as SearchHitRow).relPath ?? "";
      const compare: Record<SortKey, (a: FileEntry, b: FileEntry) => number> = {
        name: (a, b) =>
          a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }),
        mtime: (a, b) => (a.mtime ?? 0) - (b.mtime ?? 0),
        kind: (a, b) => a.kind.localeCompare(b.kind),
        size: (a, b) => a.size - b.size,
        permissions: (a, b) => a.permissions.localeCompare(b.permissions),
        owner: (a, b) => compareOptional(a.owner, b.owner),
        group: (a, b) => compareOptional(a.group, b.group),
        path: (a, b) =>
          rel(a).localeCompare(rel(b), undefined, { numeric: true, sensitivity: "base" }),
      };
      return searchSession.value.hits.slice().sort((a, b) => {
        const primary = prio * (dirOrder(a) - dirOrder(b)) || asc * compare[key](a, b);
        if (primary !== 0) return primary;
        // 并列时以位置/名称收尾，保证顺序稳定
        return key === "name"
          ? asc * compare.path(a, b)
          : asc * compare.name(a, b);
      });
    }

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
      owner: (a, b) => compareOptional(a.owner, b.owner),
      group: (a, b) => compareOptional(a.group, b.group),
      path: () => 0,
    };

    const q = searchQuery.value.trim().toLowerCase();
    return entries.value
      .filter((e) => showHidden.value || !e.name.startsWith("."))
      .filter((e) => !q || e.name.toLowerCase().includes(q))
      .slice()
      .sort((a, b) => {
        const primary = prio * (dirOrder(a) - dirOrder(b)) || asc * compare[key](a, b);
        // 非名称键并列时以名称做次级排序（方向跟随主方向，SortingHelper.cs:31-93）
        if (primary !== 0 || key === "name") return primary;
        return asc * compare.name(a, b);
      });
  });

  /** 可空字符串比较（owner/group）：null 视为小于任意值，升序时排在前 */
  function compareOptional(a?: string | null, b?: string | null): number {
    if (a == null && b == null) return 0;
    if (a == null) return -1;
    if (b == null) return 1;
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
  }

  // 目录内容变化后剔除已不存在的选择项（保持其余选择）
  watch(visibleEntries, (rows) => {
    const alive = new Set(rows.map((e) => rowKeyOf(e)));
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
    // 搜索结果是临时视图（含 path 专用键），排序不写入目录记忆
    if (!searchSession.value) persistFolderPrefs();
  }

  /** —— 递归搜索（块 D）：结果流式追加，表格临时切换为结果视图 —— */

  /** 搜索模式下行的标识键：结果按 relPath（可能重名），主视图按名称 */
  function rowKeyOf(entry: FileEntry): string {
    const row = entry as SearchHitRow;
    return searchSession.value && row.relPath !== undefined ? row.relPath : entry.name;
  }

  /** 发起递归搜索：cwd 为根，结果按「位置」排序展示；正在搜索时旧任务先取消 */
  function startRecursiveSearch(rawQuery: string) {
    const query = rawQuery.trim();
    if (!query || !connectionId.value) return;
    if (searchSession.value) void stopSearch();
    void unlistenSearch?.();
    unlistenSearch = null;

    const searchId = crypto.randomUUID();
    const session: SearchSession = {
      searchId,
      query,
      dir: cwd.value,
      hits: [],
      running: true,
      cancelled: false,
      capped: false,
    };
    searchSession.value = session;
    // 进入搜索视图默认按位置排序（Files SortOption.Path）；退出时恢复
    savedSort = { key: sortKey.value, asc: sortAsc.value };
    sortKey.value = "path";
    sortAsc.value = true;
    pushSearchHistory(query);

    void listen<SearchProgress>(`search://result:${searchId}`, (event) => {
      const payload = event.payload;
      // 事件可能晚于退出/新搜索到达：只认当前会话
      const current = searchSession.value;
      if (!current || current.searchId !== payload.searchId) return;
      if (payload.hits.length) {
        current.hits.push(...payload.hits.map((h) => ({ ...h })));
        // 触发响应式更新（hits 数组引用未变）
        searchSession.value = { ...current, hits: [...current.hits] };
      }
      if (payload.done) {
        searchSession.value = {
          ...searchSession.value!,
          running: false,
          cancelled: payload.cancelled,
          capped: payload.capped,
        };
        void unlistenSearch?.();
        unlistenSearch = null;
      }
    }).then((unlisten) => {
      // 期间会话已被替换/退出：立即解除监听
      if (searchSession.value?.searchId !== searchId) {
        unlisten();
        return;
      }
      unlistenSearch = unlisten;
    });

    void searchStart(searchId, connectionId.value, cwd.value, query).catch((e) => {
      error.value = e instanceof Error ? e.message : String(e);
      searchSession.value = null;
      void unlistenSearch?.();
      unlistenSearch = null;
    });
  }

  /** 停止按钮：请求取消后端任务；running 由 done 事件收尾（已找到的结果保留） */
  async function stopSearch() {
    const session = searchSession.value;
    if (session?.running) {
      try {
        await searchCancel(session.searchId);
      } catch {
        // 任务可能已自然结束
      }
    }
  }

  /** 退出结果视图回原目录（clearQuery=true 时同时清空搜索框） */
  function exitSearch(clearQuery = false) {
    void stopSearch();
    void unlistenSearch?.();
    unlistenSearch = null;
    if (savedSort) {
      sortKey.value = savedSort.key;
      sortAsc.value = savedSort.asc;
      savedSort = null;
    }
    searchSession.value = null;
    if (clearQuery) searchQuery.value = "";
  }

  /** 搜索结果中打开文件夹：退出搜索并进入其所在目录 */
  function enterSearchEntry(relPath: string) {
    const session = searchSession.value;
    if (!session) return;
    const dir = relPath.split("/").slice(0, -1).join("/");
    const target = dir ? joinPath(session.dir, dir) : session.dir;
    void open(target);
  }

  /** —— 按目录记忆视图（LayoutPreferencesManager 语义：进入读取、修改即写回） —— */

  /** 进入目录应用记忆：无记忆则重置为默认列 + 设置页默认排序（Files GetDefaultLayoutPreferences） */
  function applyFolderPrefs(path: string) {
    const pref = getFolderPref(profileId.value, path);
    if (pref) {
      sortKey.value = pref.sortKey;
      sortAsc.value = !pref.sortDesc;
      columns.value = pref.columns.map((c) => ({ ...c }));
    } else {
      const s = useSettingsStore().settings;
      sortKey.value = s.defaultSortKey;
      sortAsc.value = !s.defaultSortDesc;
      columns.value = defaultColumns();
    }
  }

  function persistFolderPrefs() {
    if (!profileId.value) return;
    putFolderPref(profileId.value, cwd.value, {
      sortKey: sortKey.value,
      sortDesc: !sortAsc.value,
      columns: columns.value.map((c) => ({ ...c })),
    });
  }

  /** 列宽调整结束（拖拽/双击自适应）后写回目录记忆 */
  function setColumnWidth(key: SortKey, width: number) {
    const col = columns.value.find((c) => c.key === key);
    if (!col || key === "name") return;
    col.width = width;
    persistFolderPrefs();
  }

  /** 列显隐切换（名称列不可隐藏） */
  function toggleColumn(key: SortKey) {
    const col = columns.value.find((c) => c.key === key);
    if (!col || key === "name") return;
    col.visible = !col.visible;
    persistFolderPrefs();
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

  /** Shift 范围：锚点 → 当前项（按可见顺序；键为 rowKey，搜索结果即 relPath） */
  function selectRange(name: string) {
    const names = visibleEntries.value.map((e) => rowKeyOf(e));
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

  /** 全选（Ctrl+A）：按当前过滤后的可见集合（搜索结果按 relPath 键） */
  function selectAll() {
    const names = visibleEntries.value.map((e) => rowKeyOf(e));
    selectedNames.value = new Set(names);
    anchorName = names.length ? names[names.length - 1] : null;
  }

  /** 反选（Ctrl+I，Files InvertSelectionAction）：可见集合内取补集 */
  function invertSelection() {
    const inverted = visibleEntries.value
      .map((e) => rowKeyOf(e))
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
    profileId,
    cwd,
    entries,
    loading,
    error,
    showHidden,
    searchQuery,
    searchSession,
    searchHistory,
    selectedNames,
    sortKey,
    sortAsc,
    columns,
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
    setColumnWidth,
    toggleColumn,
    rowKeyOf,
    startRecursiveSearch,
    stopSearch,
    exitSearch,
    enterSearchEntry,
  };
}

/** 实例类型（组件 prop 与消费方引用用） */
export type ExplorerStore = ReturnType<typeof useExplorer>;

/** paneId → defineStore 产物缓存（同一 paneId 复用同一 store 定义） */
const storeFactories = new Map<string, ReturnType<typeof buildExplorerUse>>();

function buildExplorerUse(paneId: string) {
  return defineStore(`explorer-${paneId}`, buildExplorerStore);
}

/** 取（或创建）某「标签×窗格」的浏览器状态实例 */
export function useExplorer(paneId: string) {
  let factory = storeFactories.get(paneId);
  if (!factory) {
    factory = buildExplorerUse(paneId);
    storeFactories.set(paneId, factory);
  }
  return factory();
}

/** 关闭窗格/标签时回收实例：先 clear()（释放搜索事件监听等外部资源）再 $dispose */
export function disposeExplorer(paneId: string) {
  const factory = storeFactories.get(paneId);
  if (!factory) return;
  storeFactories.delete(paneId);
  let store: ExplorerStore;
  try {
    store = factory();
  } catch {
    return; // pinia 未安装（异常时序）：定义已删，无状态可清
  }
  store.clear();
  store.$dispose();
}
