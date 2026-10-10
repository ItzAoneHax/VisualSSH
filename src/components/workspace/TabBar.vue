<script setup lang="ts">
import { Folder, Plus, X } from "@lucide/vue";
import { ref } from "vue";

import ContextMenu from "@/components/common/ContextMenu.vue";
import type { MenuItem } from "@/components/common/DropdownMenu.vue";
import { useConnectionsStore } from "@/stores/connections";
import { useExitGuardStore } from "@/stores/exitGuard";
import { useExplorer } from "@/stores/explorer";
import { useWorkspaceStore, type WorkspaceTab } from "@/stores/workspace";
import {
  FILES_DND_TYPE,
  hasFilesPayload,
  isCrossConnection,
  isSameDir,
  readFilesPayload,
  resolveDropMode,
} from "@/utils/dragDrop";
import { crossConnectionTransfer, remoteMoveCopy } from "@/utils/remoteOps";

/**
 * 标签条（M7 步骤 2，对照 Files UserControls/TabBar）：
 * 选中态 = Win11 TabView「凸起卡片」（背景浮一层 + 顶部圆角 + 字重 600，无 accent 下划线，
 * TabBarStyles.xaml:241-258 Selected 状态）；关闭按钮常驻视觉树（弱显，hover 提高）；
 * 右端「+」按钮 30×30 透明底（TabBar.xaml TabStripFooter TabBarAddNewTabButton）。
 * 拖动重排与文件拖放同为 HTML5 DnD（自定义类型区分，见步骤 4）。
 */

/** 选中标签：仅背景色（侧边框渐隐由下方 SVG 负责，见模板注释） */
const ACTIVE_TAB_STYLE = { background: "var(--toolbar)" } as const;

const emit = defineEmits<{
  "new-tab": [e?: MouseEvent];
  "reopen-tab": [];
  /** 文件拖到「+」：新标签打开该源目录 */
  "open-path": [path: string];
}>();

const workspace = useWorkspaceStore();
const connections = useConnectionsStore();
const exitGuard = useExitGuardStore();

function tooltipOf(tab: WorkspaceTab): string {
  const conn = connections.byId[tab.connectionId];
  const cwd = tab.activePaneId ? useExplorer(tab.activePaneId).cwd : "";
  return `${conn ? `${conn.profile.username}@${conn.profile.host}` : tab.alias} — ${cwd}`;
}

/** 关闭（中键/关闭按钮）：带当前目录入重开栈；
 *  关闭最后一个标签（离开语义）前经退出保护确认（C3） */
async function onCloseRequest(tab: WorkspaceTab) {
  if (workspace.tabs.length === 1 && !(await exitGuard.request())) return;
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

/** 标签上的拖拽分流：文件载荷（x-visualssh-files）走移动/复制落点，
 *  标签重排载荷（x-visualssh-tab）走重排（类型互斥） */
function onTabDragOverCombined(tab: WorkspaceTab, index: number, e: DragEvent) {
  if (e.dataTransfer?.types.includes(FILES_DND_TYPE)) onTabFileDragOver(tab, e);
  else onTabDragOver(index, e);
}

function onTabDropCombined(tab: WorkspaceTab, index: number, e: DragEvent) {
  if (e.dataTransfer?.types.includes(FILES_DND_TYPE)) void onTabFileDrop(tab, e);
  else onTabDrop(index, e);
}

function onTabDragLeaveCombined(tab: WorkspaceTab) {
  onTabFileDragLeave(tab);
}

/** —— 文件拖到标签（Files TabBar.xaml.cs TabViewItem_Drop：移动/复制到该标签当前目录；
 *  拖到「+」= 新标签打开源目录，TabBarAddNewTabButton_Drop） —— */
const fileDragOverTabId = ref<string | null>(null);
const fileDragOverPlus = ref(false);

function onTabFileDragOver(tab: WorkspaceTab, e: DragEvent) {
  if (!hasFilesPayload(e.dataTransfer!)) return;
  e.preventDefault();
  e.stopPropagation();
  e.dataTransfer!.dropEffect = resolveDropMode(e.ctrlKey) === "copy" ? "copy" : "move";
  fileDragOverTabId.value = tab.id;
}

function onTabFileDragLeave(tab: WorkspaceTab) {
  if (fileDragOverTabId.value === tab.id) fileDragOverTabId.value = null;
}

async function onTabFileDrop(tab: WorkspaceTab, e: DragEvent) {
  if (!hasFilesPayload(e.dataTransfer!)) return;
  e.preventDefault();
  e.stopPropagation();
  fileDragOverTabId.value = null;
  const payload = readFilesPayload(e.dataTransfer!);
  if (!payload) return;
  const target = useExplorer(tab.activePaneId);
  const mode = resolveDropMode(e.ctrlKey);
  try {
    if (isCrossConnection(payload, tab.connectionId)) {
      // 跨连接：文件走「暂存下载→上传」管线（文件夹跳过，横幅提示）
      const result = await crossConnectionTransfer(
        payload.connectionId,
        payload.dir,
        payload.names,
        mode,
        tab.connectionId,
        target.cwd,
      );
      if (result.skippedFolders > 0) {
        target.error = `跨连接拖拽暂不支持文件夹（已跳过 ${result.skippedFolders} 项）`;
      } else if (result.failed.length) {
        target.error = `跨连接${mode === "move" ? "移动" : "复制"}未全部完成 — ${result.failed.join("；")}`;
      }
      await target.reloadPreserve();
      return;
    }
    if (isSameDir(payload, target.cwd)) return;
    const result = await remoteMoveCopy(
      tab.connectionId,
      payload.dir,
      payload.names,
      target.cwd,
      mode,
    );
    if (result.cancelled) return;
    if (result.failed.length) {
      target.error = `${mode === "move" ? "移动" : "复制"}未全部完成 — ${result.failed.join("；")}`;
    }
    await target.reloadPreserve();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message !== "cancelled") target.error = message;
  }
}

function onPlusDragOver(e: DragEvent) {
  if (!hasFilesPayload(e.dataTransfer!)) return;
  e.preventDefault();
  e.stopPropagation();
  e.dataTransfer!.dropEffect = "link";
  fileDragOverPlus.value = true;
}

/** 拖到「+」：新标签打开该源目录（同连接复用会话；Files OpenPathInNewTab） */
function onPlusDrop(e: DragEvent) {
  if (!hasFilesPayload(e.dataTransfer!)) return;
  e.preventDefault();
  e.stopPropagation();
  fileDragOverPlus.value = false;
  const payload = readFilesPayload(e.dataTransfer!);
  if (!payload) return;
  emit("open-path", payload.dir);
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
  <!-- 左距 = 侧栏 w-56(14rem) + 32px：32px 取 Files 标签条的首标签左侧留白
      （TabBar.xaml:98-109 TabStripHeader 的 30×30 按钮 Margin="4,0,-2,0" → 4+30-2=32；
      再加 WinUI TabView.xaml 里 ScrollContentPresenter 的 Padding="1,0,0,0" 共 33px，此处取 32）。
      留白后首标签左缘在主列 pl-2.5(10px) 之内 22px 处，卡片顶线在标签凹弧左侧露出的
      10px 直线段与 Files 的观感一致（此前 18px 时几乎贴住卡片左上圆角） -->
  <div
    class="flex h-9 shrink-0 items-end gap-1 pl-[calc(14rem+32px)] pr-1"
    @dragleave="onDragLeave"
  >
    <!-- 活动标签背景与下方工具条同色熔接；顶边线的缺口由主列统一绘制（Workspace 熔接顶线），
        标签只需 data-active-tab 供其测量缺口位置 -->
    <div
      v-for="(tab, i) in workspace.tabs"
      :key="tab.id"
      :data-active-tab="tab.id === workspace.activeTabId ? '' : undefined"
      class="group relative flex h-8 min-w-[110px] max-w-[200px] shrink cursor-default select-none items-center gap-1.5 rounded-t-[8px] border border-b-0 pl-2.5 pr-1.5 text-xs transition-colors"
      :class="[
        tab.id === workspace.activeTabId
          ? 'border-transparent font-semibold text-ink'
          : 'border-transparent text-dim hover:bg-fill-subtle hover:text-ink',
        dragOverIndex === i && 'bg-fill-subtle',
        fileDragOverTabId === tab.id && 'ring-1 ring-[var(--accent)] bg-fill-subtle',
      ]"
      :style="tab.id === workspace.activeTabId ? ACTIVE_TAB_STYLE : undefined"
      :title="tooltipOf(tab)"
      draggable="true"
      @click="workspace.activateTab(tab.id)"
      @auxclick.middle.prevent="onCloseRequest(tab)"
      @contextmenu.prevent="onTabContextMenu(tab, $event)"
      @dragstart="onTabDragStart(tab, $event)"
      @dragover="onTabDragOverCombined(tab, i, $event)"
      @drop="onTabDropCombined(tab, i, $event)"
      @dragleave="onTabDragLeaveCombined(tab)"
    >
      <!-- 选中标签的外框 + 与下方面板外框的连接。标签自身 border 透明占位（保持 Tailwind
          盒模型与非活动标签等宽），线条全部由下列覆盖层按「标签盒内 1px 外框」绘制，
          与下方面板的 1px 边框同宽同色，构成一圈连续外框：
          ① 顶边：盒内 1px，两端让出 8px 给顶圆角；
          ② 顶圆角：8px 圆弧（描边中心半径 7.5，外沿贴盒边）；
          ③ 侧边：盒内左右各 1px，自圆角下端直落到底部 4px 处 —— 不做渐隐，而是由 ④ 接管；
          ④ 底部凹弧 r=4：圆心在 (侧边内侧 4px, 面板顶线中心上方 4px)，与侧边、面板顶线
             分别相切，形成向内侧凹陷的圆角，外框顺滑拐入下方面板顶线；
             弧前残段与熔接顶线缺口端在整数像素处对接（无重叠、无缝）；
          ⑤ 夹角填充：弧与两侧边框夹角之间那块圆形三角填 --toolbar（截到标签边为止），
             使标签面与下方面板面连成一片，夹角处不露出页面底色；
          ⑥ 背景：标签盒填 --toolbar，与下方面板同色，缺口内不画线，两框自然熔接。
          坐标口径：标签带 1px 透明 CSS border（border-b-0），绝对定位以 padding box 为基准，
          故 left/right/top 一率再减 1px 落在盒外沿，bottom 因无下边框不受影响。
          首标签同样渲染左弧（无首标签特判）。 -->
      <template v-if="tab.id === workspace.activeTabId">
        <span
          class="pointer-events-none absolute"
          :style="{ top: '-1px', left: '7px', right: '7px', height: '1px', background: 'var(--line)' }"
          aria-hidden="true"
        />
        <span
          class="pointer-events-none absolute"
          :style="{ top: '7px', bottom: '4.5px', left: '-1px', width: '1px', background: 'var(--line)' }"
          aria-hidden="true"
        />
        <span
          class="pointer-events-none absolute"
          :style="{ top: '7px', bottom: '4.5px', right: '-1px', width: '1px', background: 'var(--line)' }"
          aria-hidden="true"
        />
        <svg
          class="pointer-events-none absolute"
          :style="{ left: '-1px', top: '-1px' }"
          width="8"
          height="8"
          viewBox="0 0 8 8"
          fill="none"
          aria-hidden="true"
        >
          <path d="M0.5 8A7.5 7.5 0 0 1 8 0.5" style="stroke: var(--line)" stroke-width="1" />
        </svg>
        <svg
          class="pointer-events-none absolute"
          :style="{ right: '-1px', top: '-1px' }"
          width="8"
          height="8"
          viewBox="0 0 8 8"
          fill="none"
          aria-hidden="true"
        >
          <path d="M7.5 8A7.5 7.5 0 0 0 0 0.5" style="stroke: var(--line)" stroke-width="1" />
        </svg>
        <!-- 底部凹弧 r=4（左）：x 0→0.5 残段接熔接顶线，0.5→4.5 为凹弧，末端切线竖直接侧边。
             首标签左侧没有邻居线（卡片 8px 圆角让位区正好到标签左缘），故不画残段，
             弧尾自然收止，避免留下悬空线头。
             夹角填充：弧与「侧边／顶线夹角」之间那块圆形三角必须填标签底色，否则标签面与
             面板面之间露出一块页面底色（用户报告的「边框和夹角之间没填充」）；填充截到
             x=4（= 标签左缘）为止，不与标签自身底色叠加发亮 -->
        <svg
          class="pointer-events-none absolute"
          :style="{ left: '-5px', bottom: '0', width: '5px', height: '5px' }"
          viewBox="0 0 5 5"
          fill="none"
          aria-hidden="true"
        >
          <path d="M0.5 4.5A4 4 0 0 0 4 2.436492L4 5L0.5 5Z" style="fill: var(--toolbar)" />
          <path
            :d="i > 0 ? 'M0 4.5H0.5A4 4 0 0 0 4.5 0.5' : 'M0.5 4.5A4 4 0 0 0 4.5 0.5'"
            style="stroke: var(--line)"
            stroke-width="1"
          />
        </svg>
        <!-- 底部凹弧 r=4（右）：镜像；填充截到 x=1（= 标签右缘）为止 -->
        <svg
          class="pointer-events-none absolute"
          :style="{ right: '-5px', bottom: '0', width: '5px', height: '5px' }"
          viewBox="0 0 5 5"
          fill="none"
          aria-hidden="true"
        >
          <path d="M4.5 4.5A4 4 0 0 1 1 2.436492L1 5L4.5 5Z" style="fill: var(--toolbar)" />
          <path d="M5 4.5H4.5A4 4 0 0 1 0.5 0.5" style="stroke: var(--line)" stroke-width="1" />
        </svg>
      </template>
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

    <!-- 新建标签（Files TabBarAddNewTabButton：30×30 透明底；可接收文件拖放 = 新标签打开源目录） -->
    <button
      type="button"
      class="btn-icon mb-0.5 h-[30px] w-[30px] shrink-0"
      :class="fileDragOverPlus && 'text-accent'"
      title="新建标签（Ctrl+T）— 拖入文件夹在此打开"
      aria-label="新建标签"
      @click="emit('new-tab', $event)"
      @dragover="onPlusDragOver"
      @dragleave="fileDragOverPlus = false"
      @drop="onPlusDrop"
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
