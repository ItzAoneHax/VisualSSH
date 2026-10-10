<script setup lang="ts">
import { Folder, Plus, X } from "@lucide/vue";
import { computed, nextTick, onBeforeUnmount, ref } from "vue";

import ContextMenu from "@/components/common/ContextMenu.vue";
import type { MenuItem } from "@/components/common/DropdownMenu.vue";
import { useConnectionsStore } from "@/stores/connections";
import { useExitGuardStore } from "@/stores/exitGuard";
import { useExplorer } from "@/stores/explorer";
import { useWorkspaceStore, type WorkspaceTab } from "@/stores/workspace";
import {
  isCrossConnection,
  isSameDir,
  resolveDropMode,
  type FilesDragPayload,
} from "@/utils/dragDrop";
import { consumeClickGuard, fileDrag } from "@/utils/fileDrag";
import { joinPath } from "@/utils/format";
import { crossConnectionTransfer, remoteMoveCopy } from "@/utils/remoteOps";

/**
 * 标签条（M7 步骤 2，对照 Files UserControls/TabBar）：
 * 选中态 = Win11 TabView「凸起卡片」（背景浮一层 + 顶部圆角 + 字重 600，无 accent 下划线，
 * TabBarStyles.xaml:241-258 Selected 状态），并与下方面板直角熔接为一个连续页面
 * （无内凹圆弧，见模板注释）；关闭按钮常驻视觉树（弱显，hover 提高）；
 * 右端「+」按钮 30×30 透明底（TabBar.xaml TabStripFooter TabBarAddNewTabButton）。
 * 拖动重排 = Files TabView CanReorderTabs（WinUI ListView 重排语义）的指针自绘版：
 * WebView2 被 Tauri 接管拖放后不派发 HTML5 dragstart——按下移动超阈值即起拖，
 * 浮起快照（0.75 透明度 + 阴影，ListViewItemReorderThemeOpacity）跟手，原位转
 * 不可见占位（不再是完整标签），其余标签实时合拢让位（live moveTab + FLIP 滑动）。
 */

/** 选中标签：仅背景色（侧边框渐隐由下方 SVG 负责，见模板注释） */
const ACTIVE_TAB_STYLE = { background: "var(--toolbar)" } as const;

const emit = defineEmits<{
  "new-tab": [e?: MouseEvent];
  "reopen-tab": [];
  /** 文件拖到「+」：新标签打开该文件夹 */
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

/** —— 标签拖动重排（指针自绘，Files TabView CanReorderTabs 语义）——
 *  按下移动超阈值即起拖：ghost = 标签快照克隆（去覆盖层、边框显色、0.75 透明度 +
 *  阴影）跟手；原标签转 invisible 占位——保留槽宽即插入点空档，但不再渲染为完整
 *  标签；指针越过其余标签中点即 live moveTab，FLIP 动画让其余标签滑动合拢/让位；
 *  Escape 取消还原原位（moveTab 以按下时序号回插即还原：其余标签相对序不变）。 */
const stripRef = ref<HTMLElement | null>(null);
const TAB_DRAG_SLOP_PX = 4;

interface TabDragSession {
  id: string;
  originIndex: number;
  startX: number;
  startY: number;
  grabDx: number;
  grabDy: number;
  ghost: HTMLElement | null;
  moved: boolean;
}
let tabDrag: TabDragSession | null = null;
let suppressClickUntil = 0;

function onTabPointerDown(tab: WorkspaceTab, e: PointerEvent) {
  if (e.button !== 0) return;
  // 关闭按钮等按钮上的按下归按钮自身语义
  if ((e.target as HTMLElement).closest("button")) return;
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  tabDrag = {
    id: tab.id,
    originIndex: workspace.tabs.findIndex((t) => t.id === tab.id),
    startX: e.clientX,
    startY: e.clientY,
    grabDx: e.clientX - rect.left,
    grabDy: e.clientY - rect.top,
    ghost: null,
    moved: false,
  };
  window.addEventListener("pointermove", onTabDragMove);
  window.addEventListener("pointerup", onTabDragUp);
  window.addEventListener("pointercancel", endTabDrag);
  window.addEventListener("keydown", onTabDragKey);
}

function onTabDragMove(e: PointerEvent) {
  const s = tabDrag;
  if (!s) return;
  if (!s.moved) {
    if (Math.abs(e.clientX - s.startX) + Math.abs(e.clientY - s.startY) < TAB_DRAG_SLOP_PX) {
      return;
    }
    s.moved = true;
    const el = stripRef.value?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(s.id)}"]`);
    if (el) {
      s.ghost = buildTabGhost(el, el.getBoundingClientRect());
      document.body.appendChild(s.ghost);
    }
    workspace.tabDragId = s.id;
    document.body.classList.add("tab-dragging");
  }
  e.preventDefault();
  if (s.ghost) {
    s.ghost.style.left = `${e.clientX - s.grabDx}px`;
    s.ghost.style.top = `${e.clientY - s.grabDy}px`;
  }
  updateTabInsertion(e.clientX);
}

/** 指针 x 决定插入位：越过多少个「其余标签中点」即插到第几位（WinUI 重排判定） */
function updateTabInsertion(x: number) {
  const s = tabDrag;
  const strip = stripRef.value;
  if (!s || !strip) return;
  let k = 0;
  for (const el of strip.querySelectorAll<HTMLElement>("[data-tab-id]")) {
    if (el.dataset.tabId === s.id) continue;
    const r = el.getBoundingClientRect();
    if (x > r.left + r.width / 2) k += 1;
  }
  const cur = workspace.tabs.findIndex((t) => t.id === s.id);
  if (k !== cur) reorderLive(s.id, k);
}

/** live 重排 + FLIP 滑动：先记当前视觉位（含进行中动画的 transform 位移），移完后把
 *  每个标签从旧视觉位动画到新布局位（仅 transform，不动文档流；快速连续穿越时取消
 *  未完动画再按视觉位链式起步，不跳变） */
function reorderLive(id: string, toIndex: number) {
  const strip = stripRef.value;
  const before = new Map<string, number>();
  if (strip) {
    for (const el of strip.querySelectorAll<HTMLElement>("[data-tab-id]")) {
      before.set(el.dataset.tabId!, el.getBoundingClientRect().left);
    }
  }
  workspace.moveTab(id, toIndex);
  void nextTick(() => {
    if (!strip) return;
    for (const el of strip.querySelectorAll<HTMLElement>("[data-tab-id]")) {
      const oldLeft = before.get(el.dataset.tabId!);
      if (oldLeft == null) continue;
      for (const a of el.getAnimations()) {
        if (a.id === "tab-flip") a.cancel();
      }
      const dx = oldLeft - el.getBoundingClientRect().left;
      if (dx) {
        const anim = el.animate(
          [{ transform: `translateX(${dx}px)` }, { transform: "none" }],
          { duration: 190, easing: "cubic-bezier(0.2, 0, 0, 1)" },
        );
        anim.id = "tab-flip";
      }
    }
  });
}

function onTabDragUp() {
  if (tabDrag?.moved) suppressClickUntil = performance.now() + 150;
  endTabDrag();
}

function onTabDragKey(e: KeyboardEvent) {
  if (e.key !== "Escape" || !tabDrag?.moved) return;
  workspace.moveTab(tabDrag.id, tabDrag.originIndex);
  endTabDrag();
}

function endTabDrag() {
  const s = tabDrag;
  if (!s) return;
  tabDrag = null;
  s.ghost?.remove();
  workspace.tabDragId = null;
  document.body.classList.remove("tab-dragging");
  window.removeEventListener("pointermove", onTabDragMove);
  window.removeEventListener("pointerup", onTabDragUp);
  window.removeEventListener("pointercancel", endTabDrag);
  window.removeEventListener("keydown", onTabDragKey);
}

onBeforeUnmount(endTabDrag);

/** ghost：标签克隆（去掉边线覆盖层避免与显色边框双重描线；去掉 data-* 锚点属性，
 *  不污染全局 element/attribute 查询），固定定位跟手 */
function buildTabGhost(el: HTMLElement, rect: DOMRect): HTMLElement {
  const clone = el.cloneNode(true) as HTMLElement;
  clone.querySelectorAll(".pointer-events-none").forEach((n) => n.remove());
  clone.removeAttribute("data-tab-id");
  clone.removeAttribute("data-active-tab");
  clone.removeAttribute("data-drop-tab");
  clone.classList.add("tab-drag-ghost");
  clone.style.width = `${rect.width}px`;
  clone.style.left = `${rect.left}px`;
  clone.style.top = `${rect.top}px`;
  clone.style.background = "var(--toolbar)";
  clone.style.borderColor = "var(--line)";
  return clone;
}

/** 点击 = 激活（拖拽刚结束的短窗内吞掉，防止落点误激活） */
function onTabClick(tab: WorkspaceTab) {
  if (performance.now() < suppressClickUntil) return;
  if (consumeClickGuard()) return;
  workspace.activateTab(tab.id);
}

/** —— 标签上的文件拖放（Files TabBar.xaml.cs TabViewItem_Drop：移动/复制到该标签当前目录；
 *  悬停 1300ms 切换到该标签，TabHoverSelected）：文件走指针拖拽通道（utils/fileDrag
 *  派发 files-drop），标签重排走上方指针重排会话，两通道互不交叉 —— */
const tabFileDropId = computed(() => {
  const t = fileDrag.target;
  return t?.kind === "tab" ? t.el.dataset.dropTab : null;
});
const tabNewOver = computed(() => fileDrag.target?.kind === "tab-new");

async function onTabFilesDrop(tab: WorkspaceTab, e: Event) {
  const { payload, ctrlKey } = (e as CustomEvent).detail as {
    payload: FilesDragPayload;
    ctrlKey: boolean;
  };
  if (!payload) return;
  const target = useExplorer(tab.activePaneId);
  const mode = resolveDropMode(ctrlKey);
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

/** 拖到「+」：新标签打开拖动集合中的第一个文件夹（Files TabBarAddNewTabButton_Drop） */
function onTabNewFilesDrop(e: Event) {
  const { payload, firstDirName } = (e as CustomEvent).detail as {
    payload: FilesDragPayload;
    firstDirName: string | null;
  };
  if (!payload || !firstDirName) return;
  emit("open-path", joinPath(payload.dir, firstDirName));
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
  <!-- 左距 = 侧栏 w-56(14rem) + 10px：首标签左缘与下方面板（工具条卡）左缘对齐——
      选中首标签的左侧外框与卡片左边框同 x 连成一条竖线（卡片顶左角同步转直角，
      见 ExplorerPane / Workspace 双栏行按 activeTabIsFirst 置 0）。
      relative z-10：标签条绘制在文件区卡投影之上——卡片顶边（熔接处）的阴影
      泛出段被选中标签背景盖住，与 Files 的 ThemeShadow 被标签遮挡一致 -->
  <div
    ref="stripRef"
    class="relative z-10 flex h-9 shrink-0 items-end gap-1 pl-[calc(14rem+10px)] pr-1"
  >
    <!-- 活动标签背景与下方工具条同色熔接；顶边线的缺口由主列统一绘制（Workspace 熔接顶线），
        标签只需 data-active-tab 供其测量缺口位置 -->
    <div
      v-for="(tab, i) in workspace.tabs"
      :key="tab.id"
      :data-tab-id="tab.id"
      :data-active-tab="tab.id === workspace.activeTabId ? '' : undefined"
      class="group relative flex h-8 min-w-[110px] max-w-[200px] shrink cursor-default select-none items-center gap-1.5 rounded-t-[8px] border border-b-0 pl-2.5 pr-1.5 text-xs transition-colors"
      :class="[
        tab.id === workspace.activeTabId
          ? 'border-transparent font-semibold text-ink'
          : 'border-transparent text-dim hover:bg-fill-subtle hover:text-ink',
        // 文件拖入标签高亮：2px accent 边框 + 仅顶角圆角（TabBarStyles StorageItemDragOverIndicator）
        tabFileDropId === tab.id && 'tab-storage-drop',
        // 拖拽重排中：本标签浮起为 ghost，条内转不可见占位（保留槽宽 = 插入点空档）
        workspace.tabDragId === tab.id && 'invisible pointer-events-none',
      ]"
      :style="tab.id === workspace.activeTabId ? ACTIVE_TAB_STYLE : undefined"
      :title="tooltipOf(tab)"
      :data-drop-tab="tab.id"
      @pointerdown="onTabPointerDown(tab, $event)"
      @click="onTabClick(tab)"
      @auxclick.middle.prevent="onCloseRequest(tab)"
      @contextmenu.prevent="onTabContextMenu(tab, $event)"
      @files-drop="onTabFilesDrop(tab, $event)"
      @files-hover-open="workspace.activateTab(tab.id)"
    >
      <!-- 选中标签的外框 + 与下方面板的圆角熔接（一个连续页面）：
          标签自带 1px 透明 CSS border 占位（保持 Tailwind 盒模型与非活动标签等宽），
          线条全部由下列覆盖层按「标签盒内 1px 外框」绘制，与下方面板的 1px 边框同宽同色：
          ① 顶边：盒内 1px，两端让出 8px 给顶圆角；
          ② 顶圆角：8px 圆弧（描边中心半径 7.5，外沿贴盒边）；
          ③ 侧边：盒内左右各 1px，自顶圆角下端直落到 bottom:3.5px 交给 ④ 凹弧；
             首标签左侧豁免（i === 0）：侧边直接下延 1px 嵌进熔接顶线行（bottom:-1px），
             与卡片左边框贯通成一条竖线；
          ④ 底部凹弧 r=4（5×5 SVG）：与侧边、面板顶线分别相切（圆心在侧边内侧 4px、
             面板顶线中心上方 4px），把 90° 接头变成向内凹陷的圆角过渡；夹角填充
             （--toolbar，截到标签边缘）填住弧与边框之间的月牙，标签面与面板面连成
             一片不露底色；左弧带 0.5px 残段接熔接顶线缺口端，像素级对接；
          ⑤ 首标签（左缘 = 卡片左缘）豁免：左侧不画凹弧（竖线融合处无转角），左侧
             外框与卡片左边框同 x 贯通，卡片顶左角同步转直角（activeTabIsFirst，由
             Workspace/ExplorerPane 按 tabDragId 判定），顶线左侧不再有线段；本标签
             被拖拽中时不算完整标签（invisible 隐藏全部线条；卡片恢复圆角、顶线连续）；
          ⑥ 背景：标签盒填 --toolbar 与下方面板同色，两个框熔为一个连续页面。
          坐标口径：标签带 1px 透明 border（border-b-0），绝对定位以 padding box 为基准，
          故 left/right/top 一律再减 1px 落在盒外沿；凹弧 svg bottom:-1px 使其水平切点
          落在新线行（卡片顶边框行，比标签底缘低 1px）中心。 -->
      <template v-if="tab.id === workspace.activeTabId">
        <span
          class="pointer-events-none absolute"
          :style="{ top: '-1px', left: '7px', right: '7px', height: '1px', background: 'var(--line)' }"
          aria-hidden="true"
        />
        <span
          class="pointer-events-none absolute"
          :style="{
            top: '7px',
            bottom: i === 0 ? '-1px' : '3.5px',
            left: '-1px',
            width: '1px',
            background: 'var(--line)',
          }"
          aria-hidden="true"
        />
        <span
          class="pointer-events-none absolute"
          :style="{ top: '7px', bottom: '3.5px', right: '-1px', width: '1px', background: 'var(--line)' }"
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
        <!-- 底部凹弧 r=4（左）：残段 0→0.5 接熔接顶线缺口端，0.5→4.5 为凹弧，末端切线
            竖直上接侧边；夹角填充截到 x=4（= 标签左缘）不与标签底色叠加发亮。
            首标签豁免：左侧是竖线融合（无转角），整枚左弧不渲染 -->
        <svg
          v-if="i > 0"
          class="pointer-events-none absolute"
          :style="{ left: '-5px', bottom: '-1px', width: '5px', height: '5px' }"
          viewBox="0 0 5 5"
          fill="none"
          aria-hidden="true"
        >
          <path d="M0.5 4.5A4 4 0 0 0 4 2.436492L4 5L0.5 5Z" style="fill: var(--toolbar)" />
          <path d="M0 4.5H0.5A4 4 0 0 0 4.5 0.5" style="stroke: var(--line)" stroke-width="1" />
        </svg>
        <!-- 底部凹弧 r=4（右）：镜像；填充截到 x=1（= 标签右缘）为止 -->
        <svg
          class="pointer-events-none absolute"
          :style="{ right: '-5px', bottom: '-1px', width: '5px', height: '5px' }"
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

    <!-- 新建标签（Files TabBarAddNewTabButton：30×30 透明底；文件拖入 = 新标签打开被拖文件夹） -->
    <button
      type="button"
      class="btn-icon mb-0.5 h-[30px] w-[30px] shrink-0"
      :class="tabNewOver && 'text-accent'"
      title="新建标签（Ctrl+T）— 拖入文件夹在此打开"
      aria-label="新建标签"
      data-drop-tab-new
      @click="!consumeClickGuard() && emit('new-tab', $event)"
      @files-drop="onTabNewFilesDrop($event)"
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
