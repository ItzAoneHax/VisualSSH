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
  /** 双栏排列（Files ShellPaneArrangement：按分隔条方向命名——vertical=左右并排，horizontal=上下堆叠；null=单窗格） */
  arrangement: "vertical" | "horizontal" | null;
  /** 窗格 1 占比（双栏分隔条位置，%；双击分隔条复位 50） */
  paneRatio: number;
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
      arrangement: null,
      paneRatio: 50,
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

  /** —— 块 D 断线联动 —— */

  /** 断开：受影响标签窗格的 explorer 转断开占位（错误横幅风格） */
  function markConnectionLost(connectionId: string) {
    for (const tab of tabs.value) {
      if (tab.connectionId !== connectionId) continue;
      for (const pane of tab.panes) {
        useExplorer(pane.id).error = "连接已断开，正在尝试自动重连…";
      }
    }
  }

  /** 重连成功：explorer 状态未清（cwd 即断开时路径），清占位并静默刷新恢复 */
  function markConnectionRestored(oldId: string, newId: string) {
    for (const tab of tabs.value) {
      if (tab.connectionId !== oldId) continue;
      for (const pane of tab.panes) {
        const ex = useExplorer(pane.id);
        ex.connectionId = newId;
        ex.error = null;
        void ex.reloadPreserve();
      }
    }
  }

  /** 重连成功后替换连接标识（byId 键已换，标签与其 explorer 实例同步） */
  function remapConnection(oldId: string, newId: string) {
    for (const tab of tabs.value) {
      if (tab.connectionId !== oldId) continue;
      tab.connectionId = newId;
      for (const pane of tab.panes) {
        useExplorer(pane.id).connectionId = newId;
      }
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

  /** —— 双栏分屏（Files ShellPanesPage：每标签最多 2 窗格，共享标签的连接） —— */

  /** 打开第二窗格（Files OpenSecondaryPane：新窗格进入当前活动窗格的目录） */
  function openSecondaryPane(arrangement: "vertical" | "horizontal", cwd: string) {
    const tab = activeTab.value;
    if (!tab || tab.panes.length >= 2) return;
    const pane: WorkspacePane = { id: newId() };
    tab.panes.push(pane);
    tab.arrangement = arrangement;
    tab.paneRatio = 50;
    initPane(pane.id, tab.connectionId, cwd, tab.profileId, cwd);
    return pane;
  }

  /** 关闭指定窗格（余一窗格时回到单窗格布局） */
  function closePane(paneId: string) {
    const tab = activeTab.value;
    if (!tab || tab.panes.length < 2) return;
    const idx = tab.panes.findIndex((p) => p.id === paneId);
    if (idx < 0) return;
    disposeExplorer(paneId);
    tab.panes.splice(idx, 1);
    tab.arrangement = null;
    if (tab.activePaneId === paneId) {
      tab.activePaneId = tab.panes[Math.max(0, idx - 1)].id;
    }
  }

  /** 切换活动窗格（Files Pane_GotFocus：点击/右键另一窗格聚焦时清空原活动窗格的选择） */
  function setActivePane(paneId: string) {
    const tab = activeTab.value;
    if (!tab || paneId === tab.activePaneId) return;
    if (tab.panes.some((p) => p.id === paneId)) {
      useExplorer(tab.activePaneId).clearSelection();
      tab.activePaneId = paneId;
    }
  }

  /** 焦点切到另一窗格（Files FocusOtherPaneAction Ctrl+Shift+→；← 为对称补充） */
  function focusOtherPane() {
    const tab = activeTab.value;
    if (!tab || tab.panes.length < 2) return;
    const idx = tab.panes.findIndex((p) => p.id === tab.activePaneId);
    const other = tab.panes[(idx + 1) % tab.panes.length];
    setActivePane(other.id);
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
    openSecondaryPane,
    closePane,
    setActivePane,
    focusOtherPane,
    resetAll,
    activeExplorer,
    markConnectionLost,
    markConnectionRestored,
    remapConnection,
  };
});
