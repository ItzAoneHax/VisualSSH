<script setup lang="ts">
import { Folder, Plus, X } from "@lucide/vue";
import { ref } from "vue";

import ContextMenu from "@/components/common/ContextMenu.vue";
import type { MenuItem } from "@/components/common/DropdownMenu.vue";
import { useConnectionsStore } from "@/stores/connections";
import { useExplorer } from "@/stores/explorer";
import { useWorkspaceStore, type WorkspaceTab } from "@/stores/workspace";

/**
 * 标签条（M7 步骤 2，对照 Files UserControls/TabBar）：
 * 选中态 = Win11 TabView「凸起卡片」（背景浮一层 + 顶部圆角 + 字重 600，无 accent 下划线，
 * TabBarStyles.xaml:241-258 Selected 状态）；关闭按钮常驻视觉树（弱显，hover 提高）；
 * 右端「+」按钮 30×30 透明底（TabBar.xaml TabStripFooter TabBarAddNewTabButton）。
 * 拖动重排与文件拖放同为 HTML5 DnD（自定义类型区分，见步骤 4）。
 */

const emit = defineEmits<{
  "new-tab": [e?: MouseEvent];
  "reopen-tab": [];
}>();

const workspace = useWorkspaceStore();
const connections = useConnectionsStore();

function tooltipOf(tab: WorkspaceTab): string {
  const conn = connections.byId[tab.connectionId];
  const cwd = tab.activePaneId ? useExplorer(tab.activePaneId).cwd : "";
  return `${conn ? `${conn.profile.username}@${conn.profile.host}` : tab.alias} — ${cwd}`;
}

/** 关闭（中键/关闭按钮）：带当前目录入重开栈 */
function onCloseRequest(tab: WorkspaceTab) {
  workspace.closeTab(tab.id, useExplorer(tab.activePaneId).cwd);
}

/** —— 标签拖动重排（HTML5 DnD）—— */
const dragOverIndex = ref(-1);

function onTabDragStart(tab: WorkspaceTab, e: DragEvent) {
  e.dataTransfer?.setData("application/x-visualssh-tab", tab.id);
  if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
}

function onTabDragOver(index: number, e: DragEvent) {
  if (!e.dataTransfer?.types.includes("application/x-visualssh-tab")) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
  dragOverIndex.value = index;
}

function onTabDrop(index: number, e: DragEvent) {
  const id = e.dataTransfer?.getData("application/x-visualssh-tab");
  dragOverIndex.value = -1;
  if (!id) return;
  e.preventDefault();
  e.stopPropagation();
  // 目标 index 在源之后时 -1 修正（先移除再插入）
  const from = workspace.tabs.findIndex((t) => t.id === id);
  const to = from < index ? index - 1 : index;
  workspace.moveTab(id, to);
}

function onDragLeave() {
  dragOverIndex.value = -1;
}

/** —— 右键菜单（Files TabBar.xaml TabFlyout：新建/复制/关闭左侧/右侧/其他 + 关闭/重开） —— */
const tabMenu = ref<{ open: boolean; x: number; y: number; tabId: string } | null>(null);
const tabMenuItems = ref<MenuItem[]>([]);

function onTabContextMenu(tab: WorkspaceTab, e: MouseEvent) {
  const items: MenuItem[] = [
    { key: "new", label: "新建标签", icon: Plus },
    { key: "duplicate", label: "复制标签", icon: Folder },
  ];
  if (workspace.tabs.length > 1) {
    items.push(
      { key: "sepClose", label: "", separator: true },
      { key: "closeLeft", label: "关闭左侧标签" },
      { key: "closeRight", label: "关闭右侧标签" },
      { key: "closeOthers", label: "关闭其他标签" },
    );
  }
  items.push(
    { key: "sepClose2", label: "", separator: true },
    { key: "close", label: "关闭标签", icon: X },
  );
  if (workspace.closedTabs.length) {
    items.push({ key: "reopen", label: "重新打开已关闭标签" });
  }
  tabMenuItems.value = items;
  tabMenu.value = { open: true, x: e.clientX, y: e.clientY, tabId: tab.id };
}

function onTabMenuSelect(key: string) {
  const menu = tabMenu.value;
  tabMenu.value = null;
  if (!menu) return;
  const tab = workspace.tabs.find((t) => t.id === menu.tabId);
  if (!tab) return;
  switch (key) {
    case "new":
      emit("new-tab");
      break;
    case "duplicate":
      duplicateTab(tab);
      break;
    case "close":
      onCloseRequest(tab);
      break;
    case "closeLeft":
      workspace.closeTabsToLeft(tab.id);
      break;
    case "closeRight":
      workspace.closeTabsToRight(tab.id);
      break;
    case "closeOthers":
      workspace.closeOtherTabs(tab.id);
      break;
    case "reopen":
      emit("reopen-tab");
      break;
  }
}

/** 复制标签：新标签进入同连接同路径（Files DuplicateSelectedTab） */
function duplicateTab(tab: WorkspaceTab) {
  const sourceCwd = useExplorer(tab.activePaneId).cwd;
  const newTab = workspace.duplicateTab(tab.id);
  if (!newTab) return;
  // 新窗格实例恢复到源标签当前目录（rootPath 传 cwd 即初始目录）
  void useExplorer(newTab.activePaneId).reset(tab.connectionId, sourceCwd, tab.profileId);
}
</script>

<template>
  <div
    class="flex h-9 shrink-0 items-end gap-1 pl-2 pr-1"
    @dragleave="onDragLeave"
  >
    <div
      v-for="(tab, i) in workspace.tabs"
      :key="tab.id"
      class="group flex h-8 min-w-[110px] max-w-[200px] shrink cursor-default select-none items-center gap-1.5 rounded-t-[6px] border border-b-0 pl-2.5 pr-1.5 text-xs transition-colors"
      :class="[
        tab.id === workspace.activeTabId
          ? 'border-[var(--line)] font-semibold text-ink'
          : 'border-transparent text-dim hover:bg-fill-subtle hover:text-ink',
        dragOverIndex === i && 'bg-fill-subtle',
      ]"
      :style="tab.id === workspace.activeTabId ? { background: 'var(--fill-control)' } : undefined"
      :title="tooltipOf(tab)"
      draggable="true"
      @click="workspace.activateTab(tab.id)"
      @auxclick.middle.prevent="onCloseRequest(tab)"
      @contextmenu.prevent="onTabContextMenu(tab, $event)"
      @dragstart="onTabDragStart(tab, $event)"
      @dragover="onTabDragOver(i, $event)"
      @drop="onTabDrop(i, $event)"
    >
      <Folder
        :size="14"
        class="shrink-0"
        :class="tab.id === workspace.activeTabId ? 'text-accent' : 'text-faint'"
      />
      <span class="min-w-0 flex-1 truncate">{{ tab.title }}</span>
      <!-- 关闭按钮：活动标签弱显常驻，非活动 hover 显现 -->
      <button
        type="button"
        class="btn-icon h-5 w-5 shrink-0 rounded-[3px] p-0"
        :class="tab.id === workspace.activeTabId ? 'opacity-70' : 'opacity-0 group-hover:opacity-70'"
        :aria-label="`关闭标签 ${tab.title}`"
        @click.stop="onCloseRequest(tab)"
      >
        <X :size="12" />
      </button>
    </div>

    <!-- 新建标签（Files TabBarAddNewTabButton：30×30 透明底） -->
    <button
      type="button"
      class="btn-icon mb-0.5 h-[30px] w-[30px] shrink-0"
      title="新建标签（Ctrl+T）"
      aria-label="新建标签"
      @click="emit('new-tab', $event)"
    >
      <Plus :size="14" />
    </button>

    <!-- 标签右键菜单 -->
    <ContextMenu
      :open="!!tabMenu?.open"
      :x="tabMenu?.x ?? 0"
      :y="tabMenu?.y ?? 0"
      :items="tabMenuItems"
      @select="onTabMenuSelect"
      @close="tabMenu = null"
    />
  </div>
</template>
