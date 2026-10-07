import { defineStore } from "pinia";
import { computed, ref } from "vue";

import { disposeExplorer, useExplorer } from "@/stores/explorer";

/**
 * 工作区标签/窗格结构（M7）。状态层先于 UI：
 * 步骤 1 仅单标签单窗格（界面与单例时代一致），步骤 2/3 在此结构上补标签条与分屏。
 *
 * explorer 实例键 = 窗格 id（每「标签×窗格」独立目录/历史/选择/搜索状态）；
 * 标签持有 connectionId（窗格共享标签的连接），非活动标签不渲染 DOM、状态留在实例里。
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
}

function newId(): string {
  return crypto.randomUUID();
}

export const useWorkspaceStore = defineStore("workspace", () => {
  const tabs = ref<WorkspaceTab[]>([]);
  const activeTabId = ref("");

  const activeTab = computed(
    () => tabs.value.find((t) => t.id === activeTabId.value) ?? null,
  );
  const activePaneId = computed(() => activeTab.value?.activePaneId ?? "");
  const activePaneCount = computed(() => activeTab.value?.panes.length ?? 0);

  /** 进入工作区（Workspace 挂载）：重置为单标签单窗格并初始化 explorer 实例 */
  function init(connectionId: string, profileId: string, alias: string) {
    resetAll();
    const pane: WorkspacePane = { id: newId() };
    const tab: WorkspaceTab = {
      id: newId(),
      connectionId,
      profileId,
      alias,
      panes: [pane],
      activePaneId: pane.id,
    };
    tabs.value = [tab];
    activeTabId.value = tab.id;
    return tab;
  }

  /** 断开/离开工作区：回收全部 explorer 实例并清空结构 */
  function resetAll() {
    for (const tab of tabs.value) {
      for (const pane of tab.panes) disposeExplorer(pane.id);
    }
    tabs.value = [];
    activeTabId.value = "";
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
    init,
    resetAll,
    activeExplorer,
  };
});
