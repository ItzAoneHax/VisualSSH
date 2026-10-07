import { defineStore } from "pinia";
import { computed, ref } from "vue";

import { disposeExplorer, useExplorer } from "@/stores/explorer";

/**
 * 工作区标签/窗格结构（M7）。
 * 标签绑定一个 connectionId（窗格共享其连接），各自独立目录/历史/选择/搜索；
 * explorer 实例键 = 窗格 id；非活动标签不渲染 DOM、状态留在实例里。
 * 标签操作语义对照 Files BaseTabBar/TabBar（重开栈上限 10）。
 */

export interface WorkspacePane {
  id: string;
}

export interface WorkspaceTab {
  id: string;
  connectionId: string;
  /** 目录记忆/侧栏收藏的键（profile.id） */
  profileId: string;
  /** 连接别名（标签标题/tooltip 用，连接时快照） */
  alias: string;
  panes: WorkspacePane[];
  activePaneId: string;
  /** 标签标题 = 当前目录名（导航实时更新，Workspace 层经 explorer 回写） */
  title: string;
}

/** 重开已关闭标签的记录（Files TabBarItemParameter：连接 + 路径） */
export interface ClosedTabRecord {
  connectionId: string;
  profileId: string;
  alias: string;
  cwd: string;
}

const REOPEN_STACK_LIMIT = 10;

function newId(): string {
  return crypto.randomUUID();
}

export const useWorkspaceStore = defineStore("workspace", () => {
  const tabs = ref<WorkspaceTab[]>([]);
  const activeTabId = ref("");
  /** 重开已关闭标签栈（最近在上，上限 10） */
  const closedTabs = ref<ClosedTabRecord[]>([]);

  const activeTab = computed(
    () => tabs.value.find((t) => t.id === activeTabId.value) ?? null,
  );
  const activePaneId = computed(() => activeTab.value?.activePaneId ?? "");
  const activePaneCount = computed(() => activeTab.value?.panes.length ?? 0);
  const activeConnectionId = computed(() => activeTab.value?.connectionId ?? "");

  /** 进入工作区（Workspace 首次挂载）：重置为单标签单窗格 */
  function init(connectionId: string, profileId: string, alias: string) {
    resetAll();
    const tab = createTab(connectionId, profileId, alias);
    tabs.value = [tab];
    activeTabId.value = tab.id;
    return tab;
  }

  function createTab(connectionId: string, profileId: string, alias: string): WorkspaceTab {
    const pane: WorkspacePane = { id: newId() };
    return {
      id: newId(),
      connectionId,
      profileId,
      alias,
      panes: [pane],
      activePaneId: pane.id,
      title: alias,
    };
  }

  /** 新标签打开一个已连接的会话（同连接可多标签）并激活 */
  function openTab(connectionId: string, profileId: string, alias: string): WorkspaceTab {
    const tab = createTab(connectionId, profileId, alias);
    tabs.value.push(tab);
    activeTabId.value = tab.id;
    return tab;
  }

  function activateTab(id: string) {
    if (tabs.value.some((t) => t.id === id)) activeTabId.value = id;
  }

  /** 关闭标签：窗格 explorer 实例回收，连接保持后台；cwd 提供时记入重开栈
   *  （Files CloseTab → PushRecentTab 语义，栈上限 10） */
  function closeTab(id: string, cwd?: string) {
    const idx = tabs.value.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const tab = tabs.value[idx];
    if (cwd) {
      closedTabs.value = [
        { connectionId: tab.connectionId, profileId: tab.profileId, alias: tab.alias, cwd },
        ...closedTabs.value,
      ].slice(0, REOPEN_STACK_LIMIT);
    }
    tabs.value.splice(idx, 1);
    for (const pane of tab.panes) disposeExplorer(pane.id);
    if (activeTabId.value === id) {
      // 激活相邻标签（右优先）
      const next = tabs.value[Math.min(idx, tabs.value.length - 1)];
      activeTabId.value = next?.id ?? "";
    }
  }

  /** 重开最近关闭的标签（弹栈；返回记录供调用方恢复路径） */
  function popClosedTab(): ClosedTabRecord | null {
    const [record] = closedTabs.value;
    if (!record) return null;
    closedTabs.value = closedTabs.value.slice(1);
    return record;
  }

  /** 复制标签：同连接同路径的新标签（Files DuplicateSelectedTab） */
  function duplicateTab(id: string): WorkspaceTab | null {
    const tab = tabs.value.find((t) => t.id === id);
    if (!tab) return null;
    return openTab(tab.connectionId, tab.profileId, tab.alias);
  }

  function closeOtherTabs(id: string) {
    for (const tab of [...tabs.value]) {
      if (tab.id !== id) closeTab(tab.id);
    }
    activeTabId.value = id;
  }

  function closeTabsToRight(id: string) {
    const idx = tabs.value.findIndex((t) => t.id === id);
    if (idx < 0) return;
    for (const tab of [...tabs.value.slice(idx + 1)]) {
      closeTab(tab.id);
    }
  }

  function closeTabsToLeft(id: string) {
    const idx = tabs.value.findIndex((t) => t.id === id);
    if (idx < 0) return;
    for (const tab of [...tabs.value.slice(0, idx)]) {
      closeTab(tab.id);
    }
  }

  /** 拖动重排 */
  function moveTab(fromId: string, toIndex: number) {
    const from = tabs.value.findIndex((t) => t.id === fromId);
    if (from < 0 || toIndex < 0 || toIndex >= tabs.value.length) return;
    const [tab] = tabs.value.splice(from, 1);
    tabs.value.splice(toIndex, 0, tab);
  }

  /** 初始化窗格实例（新建/重开/复制标签时调用；已有连接的实例跳过，幂等）。
   *  exactCwd 提供时最终定位到该目录（reset 的 lastDir 恢复会覆盖 rootPath，
   *  重开/复制标签必须精确回到关闭时路径，故二次 open） */
  function initPane(
    paneId: string,
    connectionId: string,
    rootPath: string,
    profileId: string,
    exactCwd?: string,
  ) {
    const ex = useExplorer(paneId);
    if (ex.connectionId) return;
    void (async () => {
      await ex.reset(connectionId, rootPath, profileId);
      if (exactCwd && ex.cwd !== exactCwd) await ex.open(exactCwd);
    })();
  }

  /** 断开/离开工作区：回收全部 explorer 实例并清空结构 */
  function resetAll() {
    for (const tab of tabs.value) {
      for (const pane of tab.panes) disposeExplorer(pane.id);
    }
    tabs.value = [];
    activeTabId.value = "";
    closedTabs.value = [];
  }

  /** 当前活动窗格的浏览器状态（组件统一经此取实例） */
  function activeExplorer() {
    return useExplorer(activePaneId.value);
  }

  return {
    tabs,
    activeTabId,
    activeTab,
    activePaneId,
    activePaneCount,
    activeConnectionId,
    closedTabs,
    init,
    openTab,
    activateTab,
    closeTab,
    popClosedTab,
    duplicateTab,
    closeOtherTabs,
    closeTabsToRight,
    closeTabsToLeft,
    moveTab,
    initPane,
    resetAll,
    activeExplorer,
  };
});
