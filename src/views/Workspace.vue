<script setup lang="ts">
import type { UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  ClipboardCopy,
  Columns2,
  FolderOpen,
  FolderTree,
  HardDrive,
  House,
  PinOff,
  ScrollText,
  Search,
  Settings,
  SquareTerminal,
} from "@lucide/vue";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";

import ContextMenu from "@/components/common/ContextMenu.vue";
import type { MenuItem } from "@/components/common/DropdownMenu.vue";
import ConflictDialog from "@/components/explorer/ConflictDialog.vue";
import EditorDrawer from "@/components/workspace/EditorDrawer.vue";
import ExplorerPane from "@/components/workspace/ExplorerPane.vue";
import SearchBox from "@/components/workspace/SearchBox.vue";
import TabBar from "@/components/workspace/TabBar.vue";
import TerminalPanel from "@/components/workspace/TerminalPanel.vue";
import TransferCenter from "@/components/workspace/TransferCenter.vue";
import { useConnectionsStore } from "@/stores/connections";
import { useClipboardStore } from "@/stores/clipboard";
import { useExplorer } from "@/stores/explorer";
import { usePinnedStore } from "@/stores/pinned";
import { useSettingsStore } from "@/stores/settings";
import { useTerminalStore } from "@/stores/terminal";
import { useWorkspaceStore } from "@/stores/workspace";
import { formatSize, pathBaseName } from "@/utils/format";
import {
  hasFilesPayload,
  isCrossConnection,
  isSameDir,
  readFilesPayload,
  resolveDropMode,
  type FilesDragPayload,
} from "@/utils/dragDrop";
import { crossConnectionTransfer, remoteMoveCopy } from "@/utils/remoteOps";
import { uploadMixedPaths } from "@/utils/recursiveTransfer";
import { fsInfo, type FsInfo } from "@/api/ssh";

/**
 * 工作区（M7）：标签条 + 侧栏 + 活动窗格（ExplorerPane）+ 全局工具按钮 + 状态栏。
 * 标签各绑一个连接（关闭标签不断开）；窗格状态在 explorer 实例里，非活动标签
 * 不渲染 DOM（ExplorerPane :key=窗格 id，切回重挂载 + 静默刷新）。
 * 编辑器/终端为全局浮层，不随标签切换关闭。
 */

const emit = defineEmits<{
  disconnect: [];
}>();

const connections = useConnectionsStore();
const workspace = useWorkspaceStore();
const clip = useClipboardStore();
const terminalStore = useTerminalStore();
const settings = useSettingsStore();
const pinnedStore = usePinnedStore();

/** 活动标签（computed 保响应性：切标签时状态栏/侧栏/连接随之切换） */
const activeTab = computed(() => workspace.activeTab);
/** 活动标签的连接（窗格共享标签的连接；状态栏/侧栏/终端按钮都用它） */
const activeConn = computed(
  () => connections.byId[activeTab.value?.connectionId ?? ""] ?? null,
);
/** 活动窗格的浏览器状态（状态栏统计/终端打开/拖放上传用） */
const activeExplorer = computed(() =>
  workspace.activePaneId ? useExplorer(workspace.activePaneId) : null,
);

/** —— 双栏分屏（Files ShellPanesPage：每标签最多 2 窗格） —— */
const isDualPane = computed(() => (activeTab.value?.panes.length ?? 1) > 1);
const arrangement = computed(() => activeTab.value?.arrangement ?? null);
const paneRatio = computed(() => activeTab.value?.paneRatio ?? 50);
/** 搜索框展开态（全局一份，作用于活动窗格） */
const searchOpen = ref(false);

/** 分屏按钮：单窗格 → 默认左右分屏（进活动窗格当前目录）；双栏 → 关闭活动窗格 */
function toggleSplit(arrangement?: "vertical" | "horizontal") {
  const tab = activeTab.value;
  const ex = activeExplorer.value;
  if (!tab || !ex) return;
  if (tab.panes.length < 2) {
    workspace.openSecondaryPane(arrangement ?? "vertical", ex.cwd);
  } else {
    workspace.closePane(tab.activePaneId);
    searchOpen.value = false;
  }
}

/** 分隔条拖动（4px 透明，Files GridSplitter；双击 1:1 等分 Sizer_OnDoubleTapped） */
const splitterDragging = ref(false);

function onSplitterDown(e: PointerEvent) {
  const tab = activeTab.value;
  if (!tab?.arrangement) return;
  splitterDragging.value = true;
  // 基准容器 = 双栏容器（分隔条 → 窗格 wrapper → 容器）
  const container = (e.currentTarget as HTMLElement).parentElement?.parentElement;
  if (!container) return;
  const rect = container.getBoundingClientRect();
  const vertical = tab.arrangement === "vertical"; // 左右并排
  const start = vertical ? e.clientX : e.clientY;
  const total = vertical ? rect.width : rect.height;
  const startRatio = tab.paneRatio;
  const onMove = (ev: PointerEvent) => {
    if (!total) return;
    const delta = (vertical ? ev.clientX : ev.clientY) - start;
    const pct = startRatio + (delta / total) * 100;
    tab.paneRatio = Math.min(85, Math.max(15, pct));
  };
  const onUp = () => {
    splitterDragging.value = false;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

function onSplitterDblClick() {
  const tab = activeTab.value;
  if (tab) tab.paneRatio = 50;
}

/** 挂载：建立工作区会话（单标签单窗格）并加载初始目录。
 *  App 以「是否在主页」控制本组件挂载，连接数变化不重建（多标签共存） */
onMounted(() => {
  if (connections.active && !workspace.tabs.length) {
    const conn = connections.active;
    const tab = workspace.init(conn.connectionId, conn.profile.id, conn.alias);
    workspace.initPane(tab.activePaneId, conn.connectionId, conn.rootPath, conn.profile.id);
  }
  window.addEventListener("keydown", onKeydown);
  // 系统文件拖入上传（WebView2 dragDropEnabled 默认开启；浏览器预览跳过）——
  // 作用于活动窗格的当前目录
  if ("__TAURI_INTERNALS__" in window) {
    void getCurrentWebview()
      .onDragDropEvent(async (event) => {
        const payload = event.payload;
        const ex = activeExplorer.value;
        const cid = activeConn.value?.connectionId;
        if (payload.type === "enter") {
          // 非文件拖拽（paths 为空）不显示覆盖层
          dragOver.value = payload.paths.length > 0;
        } else if (payload.type === "leave") {
          dragOver.value = false;
        } else if (payload.type === "drop") {
          dragOver.value = false;
          if (!cid || !ex) return;
          // 目录走递归上传（聚合卡编排），文件走冲突对话框 + 逐个上传
          try {
            await uploadMixedPaths(cid, payload.paths, ex.cwd);
          } catch (e) {
            ex.error = e instanceof Error ? e.message : String(e);
          }
        }
      })
      .then((unlisten) => {
        unlistenDrag = unlisten;
      });
  }
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
  unlistenDrag?.();
  // 工作区销毁（断开连接）：回收窗格 explorer 实例 + 终端面板复位 + 内部剪贴板清空
  workspace.resetAll();
  terminalStore.reset();
  clip.clear();
});

/** 非活动标签不渲染 DOM：切回时静默刷新一次（reloadPreserve 保选中/滚动；
 *  失败保留旧数据，错误横幅在窗格文件区呈现） */
watch(
  () => workspace.activeTabId,
  (id, old) => {
    if (!id || id === old) return;
    const ex = useExplorer(workspace.activePaneId);
    if (ex.connectionId) void ex.reloadPreserve();
  },
);

/** 打开终端（活动窗格连接 + 当前目录启动 shell；该连接已有会话则直接展示） */
function onOpenTerminal() {
  const cid = activeConn.value?.connectionId;
  const ex = activeExplorer.value;
  if (cid && ex) void terminalStore.openIn(ex.cwd, cid);
}

/** —— 新建标签：已连接会话 + 已保存 profile 快速列表（复用 ContextMenu 定位） —— */
const newTabMenu = ref<{ open: boolean; x: number; y: number } | null>(null);
const newTabItems = computed<MenuItem[]>(() => {
  const items: MenuItem[] = [];
  const connected = Object.values(connections.byId);
  if (connected.length) {
    for (const conn of connected) {
      items.push({
        key: `conn:${conn.connectionId}`,
        label: `${conn.alias}（已连接）`,
        icon: SquareTerminal,
      });
    }
    items.push({ key: "sepConn", label: "", separator: true });
  }
  for (const p of connections.profiles) {
    items.push({ key: `profile:${p.id}`, label: p.alias, icon: FolderTree });
  }
  return items;
});

function onNewTabRequest(e?: MouseEvent) {
  let x = window.innerWidth / 2 - 100;
  let y = 40;
  if (e) {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    x = rect.left;
    y = rect.bottom + 2;
  }
  newTabMenu.value = { open: true, x, y };
}

async function onNewTabSelect(key: string) {
  newTabMenu.value = null;
  if (key.startsWith("conn:")) {
    // 已连接会话：直接开新标签进入（根目录）
    const conn = connections.byId[key.slice(5)];
    if (!conn) return;
    openTabForConnection(conn, conn.rootPath);
    return;
  }
  if (!key.startsWith("profile:")) return;
  // 未连接：走连接流程，成功后开标签（Ctrl+T 无事件坐标时居中）
  const profile = connections.profiles.find((p) => p.id === key.slice(8));
  if (!profile) return;
  const before = new Set(Object.keys(connections.byId));
  await connections.connect(profile);
  const newConn = Object.values(connections.byId).find((c) => !before.has(c.connectionId));
  if (newConn) openTabForConnection(newConn, newConn.rootPath);
}

/** 开新标签并初始化窗格（title 由 ExplorerPane 导航时回写） */
function openTabForConnection(
  conn: { connectionId: string; profile: { id: string }; alias: string },
  cwd: string,
) {
  const tab = workspace.openTab(conn.connectionId, conn.profile.id, conn.alias);
  workspace.initPane(tab.activePaneId, conn.connectionId, cwd, conn.profile.id, cwd);
}

/** 重开已关闭标签（连接仍在时）：恢复到关闭时的目录 */
function onReopenTab() {
  const record = workspace.popClosedTab();
  if (!record) return;
  const conn = connections.byId[record.connectionId];
  if (!conn) return;
  openTabForConnection(conn, record.cwd || conn.rootPath);
}

/** Ctrl+T 新建（弹列表）/ Ctrl+W 关闭当前 / Ctrl+Shift+T 重开已关闭；
 *  Alt+Shift+V/H 分屏（Files SplitPaneVertically/HorizontallyAction，按分隔条方向命名：
 *  V=左右并排 / H=上下堆叠）；Ctrl+Shift+→/← 焦点切换（FocusOtherPaneAction，← 为对称补充） */
function onKeydown(e: KeyboardEvent) {
  if (e.altKey && e.shiftKey && !e.ctrlKey) {
    const key = e.key.toLowerCase();
    if (key === "v") {
      e.preventDefault();
      toggleSplit("vertical");
      return;
    }
    if (key === "h") {
      e.preventDefault();
      toggleSplit("horizontal");
      return;
    }
  }
  if (e.ctrlKey && e.shiftKey && !e.altKey && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
    if (isDualPane.value) {
      e.preventDefault();
      workspace.focusOtherPane();
    }
    return;
  }
  if (!e.ctrlKey) return;
  const key = e.key.toLowerCase();
  if (key === "t" && !e.shiftKey) {
    e.preventDefault();
    onNewTabRequest();
  } else if (key === "w" && !e.shiftKey) {
    e.preventDefault();
    const tab = activeTab.value;
    if (!tab) return;
    workspace.closeTab(tab.id, activeExplorer.value?.cwd);
  } else if (key === "t" && e.shiftKey) {
    e.preventDefault();
    onReopenTab();
  }
}

/** —— 侧栏：按 profile 固定的收藏（活动标签 profile） —— */
const PIN_ICONS = {
  hardDrive: HardDrive,
  house: House,
  folderTree: FolderTree,
  scrollText: ScrollText,
  folder: FolderOpen,
} as const;

const pinnedFolders = computed(() =>
  pinnedStore.pinsFor(activeTab.value?.profileId ?? ""),
);

/** 侧栏项右键菜单（打开/取消固定） */
const pinMenu = ref<{ open: boolean; x: number; y: number; path: string } | null>(null);

function onPinContextMenu(folder: { path: string }, e: MouseEvent) {
  pinMenu.value = { open: true, x: e.clientX, y: e.clientY, path: folder.path };
}

const pinMenuItems = computed<MenuItem[]>(() => [
  { key: "open", label: "打开", icon: FolderOpen },
  { key: "openInNewTab", label: "在新标签页中打开", icon: FolderOpen },
  { key: "sepP", label: "", separator: true },
  { key: "unpin", label: "取消固定", icon: PinOff },
]);

function onPinMenuSelect(key: string) {
  const menu = pinMenu.value;
  pinMenu.value = null;
  if (!menu) return;
  const pid = activeTab.value?.profileId;
  if (key === "open") activeExplorer.value?.open(menu.path);
  else if (key === "openInNewTab") {
    const conn = activeConn.value;
    if (conn) openTabForConnection(conn, menu.path);
  } else if (key === "unpin" && pid) pinnedStore.unpin(pid, menu.path);
}

/** —— 行内拖拽落点（M7 步骤 4，Files SidebarViewModel.cs HandleLocationItemDroppedAsync）：
 *  拖到具体收藏项 = 移动/复制到该目录；拖到 Pinned 区空白 = 固定该源文件夹 —— */
const pinDragOverPath = ref<string | null>(null);
const pinBlankOver = ref(false);

function onPinDragOver(path: string, e: DragEvent) {
  if (!hasFilesPayload(e.dataTransfer!)) return;
  e.preventDefault();
  e.stopPropagation();
  e.dataTransfer!.dropEffect = resolveDropMode(e.ctrlKey) === "copy" ? "copy" : "move";
  pinDragOverPath.value = path;
}

function onPinDrop(path: string, e: DragEvent) {
  if (!hasFilesPayload(e.dataTransfer!)) return;
  e.preventDefault();
  e.stopPropagation();
  pinDragOverPath.value = null;
  const payload = readFilesPayload(e.dataTransfer!);
  const ex = activeExplorer.value;
  const cid = activeConn.value?.connectionId;
  if (!payload || !ex || !cid) return;
  void executePaneMoveCopy(payload, path, e.ctrlKey, ex, cid);
}

/** Pinned 区空白（nav 自身收到 drop = 非按钮区域）：固定源文件夹（仅文件夹） */
function onPinBlankDragOver(e: DragEvent) {
  if (!hasFilesPayload(e.dataTransfer!)) return;
  e.preventDefault();
  pinBlankOver.value = true;
}

function onPinBlankDrop(e: DragEvent) {
  if (!hasFilesPayload(e.dataTransfer!)) return;
  e.preventDefault();
  pinBlankOver.value = false;
  const payload = readFilesPayload(e.dataTransfer!);
  const ex = activeExplorer.value;
  const pid = activeTab.value?.profileId;
  if (!payload || !ex || !pid) return;
  if (isCrossConnection(payload, activeConn.value?.connectionId ?? "")) {
    ex.error = "暂不支持跨连接拖拽";
    return;
  }
  // 固定源目录本身；拖多选时仅固定源目录（与 Files 一致：逐项固定目录）
  if (payload.dir !== "/" && !pinnedStore.isPinned(pid, payload.dir)) {
    pinnedStore.pin(pid, { name: pathBaseName(payload.dir) || payload.dir, path: payload.dir });
  }
}

/** 侧栏拖放落点执行（结果横幅写窗格 error；轻提示无 hint 通道，失败走 error） */
async function executePaneMoveCopy(
  payload: FilesDragPayload,
  targetDir: string,
  ctrlKey: boolean,
  ex: { error: string | null; reloadPreserve: () => Promise<void>; cwd: string },
  cid: string,
) {
  const mode = resolveDropMode(ctrlKey);
  try {
    if (isCrossConnection(payload, cid)) {
      const result = await crossConnectionTransfer(
        payload.connectionId,
        payload.dir,
        payload.names,
        mode,
        cid,
        targetDir,
      );
      if (result.skippedFolders > 0) {
        ex.error = `跨连接拖拽暂不支持文件夹（已跳过 ${result.skippedFolders} 项）`;
      } else if (result.failed.length) {
        ex.error = `跨连接${mode === "move" ? "移动" : "复制"}未全部完成 — ${result.failed.join("；")}`;
      }
      if (targetDir === ex.cwd) await ex.reloadPreserve();
      return;
    }
    if (isSameDir(payload, targetDir)) return;
    const result = await remoteMoveCopy(cid, payload.dir, payload.names, targetDir, mode);
    if (result.cancelled) return;
    if (result.failed.length) {
      ex.error = `${mode === "move" ? "移动" : "复制"}未全部完成 — ${result.failed.join("；")}`;
    }
    if (targetDir === ex.cwd || payload.dir === ex.cwd) await ex.reloadPreserve();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (message !== "cancelled") ex.error = message;
  }
}

/** 拖拽悬停：文件区显示「释放以上传」覆盖层 */
const dragOver = ref(false);
let unlistenDrag: UnlistenFn | null = null;

/** A5 状态栏已选累计大小：仅文件计入（遵循 sizeUnit 设置） */
const selectedSizeLabel = computed(() => {
  const ex = activeExplorer.value;
  if (!ex) return "";
  let bytes = 0;
  let hasFile = false;
  for (const name of ex.selectedNames) {
    const entry = ex.entryByName(name);
    if (entry?.kind === "file") {
      hasFile = true;
      bytes += entry.size;
    }
  }
  return hasFile ? formatSize(bytes) : "";
});

/** —— F 状态栏磁盘容量条：导航到新目录读 fs_info(cwd)；不支持则整体不渲染 —— */
const diskInfo = ref<FsInfo | null>(null);
let diskSeq = 0;

const diskUsed = computed(() =>
  diskInfo.value ? diskInfo.value.total - diskInfo.value.free : 0,
);
const diskPercent = computed(() =>
  diskInfo.value && diskInfo.value.total > 0
    ? Math.min(100, (diskUsed.value / diskInfo.value.total) * 100)
    : 0,
);
/** 剩余 <10% 转 danger（DrivesWidget DriveSpaceProgressBar 语义） */
const diskLow = computed(
  () => !!diskInfo.value && diskInfo.value.free / diskInfo.value.total < 0.1,
);
const diskTitle = computed(() =>
  diskInfo.value
    ? `已用 ${diskUsed.value} B，共 ${diskInfo.value.total} B（剩余 ${Math.round(100 - diskPercent.value)}%）`
    : "",
);

watch(
  () => [activeConn.value?.connectionId, activeExplorer.value?.cwd] as const,
  ([cid, dir]) => {
    if (!cid || !dir) {
      diskInfo.value = null;
      return;
    }
    const seq = ++diskSeq;
    void fsInfo(cid, dir).then(
      (info) => {
        // 过期响应丢弃（快速连续导航时）
        if (seq === diskSeq) diskInfo.value = info;
      },
      () => {
        if (seq === diskSeq) diskInfo.value = null;
      },
    );
  },
  { immediate: true },
);
</script>

<template>
  <div v-if="connections.active" class="flex h-full flex-col">
    <!-- 标签条：仅工作区视图（本组件即工作区视图；主页/设置不挂载本组件） -->
    <TabBar @new-tab="onNewTabRequest($event)" @reopen-tab="onReopenTab" />

    <div class="flex min-h-0 flex-1">
      <!-- 侧栏：裸 Mica 层（无边框），32px 导航项 + 3px 强调指示条 -->
      <aside class="flex w-56 shrink-0 flex-col py-2 pl-1.5">
        <nav aria-label="导航">
          <button type="button" class="nav-item" @click="emit('disconnect')">
            <House :size="16" class="ml-1 shrink-0" />
            <span class="ml-3 truncate">主页</span>
          </button>

          <p
            class="mt-4 mb-1 px-2.5 text-xs font-medium text-faint"
            :class="pinBlankOver && 'rounded bg-fill-subtle ring-1 ring-[var(--accent)]'"
            @dragover="onPinBlankDragOver"
            @dragleave="pinBlankOver = false"
            @drop="onPinBlankDrop"
          >
            此服务器
          </p>
          <button
            v-for="link in pinnedFolders"
            :key="link.path"
            type="button"
            class="nav-item"
            :class="[
              activeExplorer?.cwd === link.path && 'active',
              pinDragOverPath === link.path && 'bg-row-active ring-1 ring-[var(--accent)]',
            ]"
            :title="link.path"
            @click="activeExplorer?.open(link.path)"
            @contextmenu.prevent="onPinContextMenu(link, $event)"
            @dragover="onPinDragOver(link.path, $event)"
            @dragleave="pinDragOverPath === link.path && (pinDragOverPath = null)"
            @drop="onPinDrop(link.path, $event)"
          >
            <component :is="PIN_ICONS[link.icon]" :size="16" class="ml-1 shrink-0" />
            <span class="ml-3 truncate">{{ link.name }}</span>
          </button>
        </nav>

        <button
          type="button"
          class="nav-item mt-auto"
          title="设置"
          @click="settings.openSettings()"
        >
          <Settings :size="16" class="ml-1 shrink-0" />
          <span class="ml-3 truncate">设置</span>
        </button>
      </aside>

      <!-- 主列：窗格（地址行卡 + 文件区）+ 状态栏（min-h-0 截断 min-content 传播，保证文件区内部滚动） -->
      <div class="flex min-h-0 min-w-0 flex-1 flex-col gap-1 p-2 pl-2.5">
        <!-- 单窗格：全局工具（搜索框/终端/传输/分屏）嵌在窗格地址行卡内（与单栏现状一致） -->
        <ExplorerPane
          v-if="activeTab && workspace.activePaneId && !isDualPane"
          :key="workspace.activePaneId"
          :pane-id="workspace.activePaneId"
          :tab-id="activeTab.id"
        >
          <template #actions>
            <SearchBox :pane-id="workspace.activePaneId" v-model:open="searchOpen" />
            <button
              type="button"
              class="btn-icon"
              :class="searchOpen && 'text-accent'"
              :title="searchOpen ? '关闭搜索' : '搜索当前目录'"
              aria-label="搜索"
              @click="searchOpen = !searchOpen"
            >
              <Search :size="16" />
            </button>
            <button
              type="button"
              class="btn-icon"
              title="打开终端（当前目录）"
              aria-label="打开终端"
              @click="onOpenTerminal"
            >
              <SquareTerminal :size="16" />
            </button>

            <TransferCenter />

            <button
              type="button"
              class="btn-icon"
              title="分屏（Alt+Shift+V 左右 / Alt+Shift+H 上下）"
              aria-label="分屏"
              @click="toggleSplit()"
            >
              <Columns2 :size="16" />
            </button>
          </template>
        </ExplorerPane>

        <!-- 双窗格：全局工具行独立一行，两窗格各自渲染导航段 + 文件区 -->
        <template v-else-if="activeTab && workspace.activePaneId">
          <!-- 全局工具行（一份：搜索框作用于活动窗格，无双份终端/传输） -->
          <div
            class="flex h-12 shrink-0 items-center gap-1 rounded-lg px-1"
            :style="{ background: 'var(--toolbar)', border: '1px solid var(--line)' }"
          >
            <span class="min-w-0 flex-1 truncate px-2 text-xs text-faint">
              {{ arrangement === "horizontal" ? "上下分屏" : "左右分屏" }} — 点击窗格切换焦点（Ctrl+Shift+→/←）
            </span>
            <SearchBox :pane-id="workspace.activePaneId" v-model:open="searchOpen" />
            <button
              type="button"
              class="btn-icon"
              :class="searchOpen && 'text-accent'"
              :title="searchOpen ? '关闭搜索' : '搜索当前目录'"
              aria-label="搜索"
              @click="searchOpen = !searchOpen"
            >
              <Search :size="16" />
            </button>
            <button
              type="button"
              class="btn-icon"
              title="打开终端（活动窗格当前目录）"
              aria-label="打开终端"
              @click="onOpenTerminal"
            >
              <SquareTerminal :size="16" />
            </button>

            <TransferCenter />

            <button
              type="button"
              class="btn-icon"
              title="关闭活动窗格（恢复单栏）"
              aria-label="关闭活动窗格"
              @click="toggleSplit()"
            >
              <Columns2 :size="16" />
            </button>
          </div>

          <!-- 双栏容器：vertical=左右并排（分隔条竖直）/ horizontal=上下堆叠（Files 按分隔条方向命名） -->
          <div
            class="flex min-h-0 flex-1"
            :class="arrangement === 'horizontal' ? 'flex-col' : 'flex-row'"
          >
            <div
              v-for="(pane, i) in activeTab.panes"
              :key="pane.id"
              class="flex min-h-0 min-w-0"
              :style="i === 0 ? {
                flexBasis: `${paneRatio}%`,
                flexGrow: 0,
                flexShrink: 0,
              } : { flex: '1 1 0%' }"
            >
              <ExplorerPane :pane-id="pane.id" :tab-id="activeTab.id" />
              <!-- 分隔条（仅第 0 窗格后渲染）：4px 透明命中区，中心短指示线，拖拽时转 accent -->
              <div
                v-if="i === 0"
                class="relative shrink-0"
                :class="arrangement === 'horizontal' ? 'h-4 w-full cursor-row-resize' : 'w-4 self-stretch cursor-col-resize'"
                role="separator"
                :aria-orientation="arrangement === 'horizontal' ? 'horizontal' : 'vertical'"
                title="拖拽调整 · 双击等分"
                @pointerdown="onSplitterDown"
                @dblclick="onSplitterDblClick"
              >
                <span
                  class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full"
                  :class="arrangement === 'horizontal' ? 'h-[2px] w-8' : 'h-8 w-[2px]'"
                  :style="{ background: splitterDragging ? 'var(--accent)' : 'var(--line-strong)' }"
                />
              </div>
            </div>
          </div>
        </template>
      </div>
    </div>

    <!-- 通栏状态栏：项目统计 + 连接状态（全宽一条，底部唯一收边；可在设置中隐藏） -->
    <footer
      v-if="settings.settings.showStatusBar"
      class="flex h-8 shrink-0 items-center justify-between border-t px-3 text-xs text-dim"
      :style="{ borderColor: 'var(--line)' }"
    >
      <span>
        {{ activeExplorer?.visibleEntries.length ?? 0 }} 个项目
        <span v-if="activeExplorer?.selectedNames.size">
          · 已选择 {{ activeExplorer.selectedNames.size }} 项
          <template v-if="selectedSizeLabel">· 共 {{ selectedSizeLabel }}</template>
        </span>
      </span>
      <span class="flex min-w-0 items-baseline gap-3">
        <!-- 磁盘容量条（120px 细条 + 已用/总量缩写，剩余<10% 转 danger） -->
        <span
          v-if="diskInfo"
          class="flex shrink-0 items-center gap-2 self-center"
          :title="diskTitle"
        >
          <span
            class="relative block h-[2px] w-[120px] overflow-hidden rounded-full"
            :style="{ background: 'var(--line-strong)' }"
            role="progressbar"
            :aria-valuenow="Math.round(diskPercent)"
            aria-valuemin="0"
            aria-valuemax="100"
          >
            <span
              class="absolute inset-y-0 left-0 rounded-full"
              :style="{
                width: `${diskPercent}%`,
                background: diskLow ? 'var(--danger)' : 'var(--accent)',
              }"
            />
          </span>
          <span
            class="font-mono text-[11px]"
            :style="{ color: diskLow ? 'var(--danger)' : undefined }"
          >
            {{ formatSize(diskUsed) }} / {{ formatSize(diskInfo.total) }}
          </span>
        </span>
        <span
          v-if="activeConn"
          class="flex min-w-0 items-baseline gap-1.5"
          :title="`${activeConn.profile.username}@${activeConn.profile.host}`"
        >
          <span class="h-1.5 w-1.5 shrink-0 self-center rounded-full bg-live" aria-hidden="true" />
          <span class="truncate font-medium">{{ activeConn.alias }}</span>
          <span class="truncate font-mono text-[11px]">
            {{ activeConn.profile.username }}@{{ activeConn.profile.host }}
          </span>
        </span>
        <span v-if="activeConn" class="shrink-0 font-mono">{{ activeConn.latencyMs }} ms</span>
      </span>
    </footer>

    <!-- 拖拽悬停覆盖层：释放以上传到活动窗格当前目录 -->
    <div
      v-if="dragOver"
      class="pointer-events-none fixed inset-0 top-9 z-30 flex items-center justify-center"
      :style="{
        background: 'color-mix(in srgb, var(--accent) 8%, transparent)',
        border: '2px dashed var(--accent)',
      }"
    >
      <div
        class="flex flex-col items-center gap-1 rounded-lg px-6 py-4 shadow-xl"
        :style="{
          background: 'var(--surface-solid)',
          border: '1px solid var(--stroke-flyout)',
        }"
      >
        <ClipboardCopy :size="22" class="text-accent" />
        <span class="text-sm font-semibold">释放以上传到</span>
        <span class="max-w-64 truncate font-mono text-xs text-dim" :title="activeExplorer?.cwd">
          {{ activeExplorer?.cwd }}
        </span>
      </div>
    </div>

    <!-- 新建标签快速列表（已连接会话 + 已保存 profile） -->
    <ContextMenu
      :open="!!newTabMenu?.open"
      :x="newTabMenu?.x ?? 0"
      :y="newTabMenu?.y ?? 0"
      :items="newTabItems"
      @select="onNewTabSelect"
      @close="newTabMenu = null"
    />

    <!-- 侧栏收藏项右键菜单（打开/取消固定） -->
    <ContextMenu
      :open="!!pinMenu?.open"
      :x="pinMenu?.x ?? 0"
      :y="pinMenu?.y ?? 0"
      :items="pinMenuItems"
      @select="onPinMenuSelect"
      @close="pinMenu = null"
    />

    <!-- 上传/粘贴冲突：同名项逐个决策（生成新名称/替换/跳过），支持应用到所有 -->
    <ConflictDialog />

    <!-- 悬浮编辑器 / 终端（全局浮层，不随标签切换关闭） -->
    <EditorDrawer />
    <TerminalPanel />
  </div>
</template>
