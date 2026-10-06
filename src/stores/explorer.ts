import { defineStore } from "pinia";
import { computed, ref } from "vue";

import { listDir } from "@/api/ssh";
import type { FileEntry } from "@/types";
import { joinPath, parentPath } from "@/utils/format";

/**
 * 远程文件浏览器状态。
 * 连接建立后由 Workspace 视图调用 open(rootPath) 完成首次加载。
 */
export const useExplorerStore = defineStore("explorer", () => {
  const connectionId = ref("");
  const cwd = ref("/");
  const entries = ref<FileEntry[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const showHidden = ref(false);
  /** 返回上一级的历史栈（Phase 1 仅支持向上） */
  const selectedName = ref<string | null>(null);

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

  const visibleEntries = computed(() =>
    showHidden.value
      ? entries.value
      : entries.value.filter((e) => !e.name.startsWith(".")),
  );

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
    visibleEntries,
    breadcrumbSegments,
    open,
    enter,
    refresh,
    up,
    reset,
    clear,
    select,
  };
});
