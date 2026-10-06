import { defineStore } from "pinia";
import { computed, ref } from "vue";

import { listDir } from "@/api/ssh";
import type { FileEntry } from "@/types";
import { joinPath, parentPath } from "@/utils/format";

/**
 * 远程文件浏览器状态。
 * 连接建立后由 Workspace 视图调用 open(rootPath) 完成首次加载。
 */
export type SortKey = "name" | "mtime" | "kind" | "size" | "permissions";

export const SORT_KEYS: SortKey[] = [
  "name",
  "mtime",
  "kind",
  "size",
  "permissions",
];

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

  async function open(path: string) {
    if (!connectionId.value || loading.value) return;
    loading.value = true;
    error.value = null;
    selectedName.value = null;
    try {
      entries.value = await listDir(connectionId.value, path);
      cwd.value = path;
    } catch (e) {
      // 失败时保留旧目录内容，仅呈现错误横幅
      error.value = e instanceof Error ? e.message : String(e);
    } finally {
      loading.value = false;
    }
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

  function reset(nextConnectionId: string, rootPath: string) {
    connectionId.value = nextConnectionId;
    cwd.value = rootPath;
    entries.value = [];
    error.value = null;
    selectedName.value = null;
    void open(rootPath);
  }

  function clear() {
    connectionId.value = "";
    entries.value = [];
    cwd.value = "/";
    error.value = null;
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
    visibleEntries,
    breadcrumbSegments,
    open,
    enter,
    refresh,
    up,
    reset,
    clear,
    select,
    sortBy,
  };
});
