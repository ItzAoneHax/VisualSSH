<script setup lang="ts">
import type { UnlistenFn } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  ArrowLeft,
  ArrowRight,
  ClipboardCopy,
  Copy,
  Download,
  Eye,
  FilePlus,
  FolderOpen,
  FolderPlus,
  FolderTree,
  HardDrive,
  House,
  Lock,
  LogOut,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  ScrollText,
  Trash2,
  TriangleAlert,
  Upload,
} from "@lucide/vue";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { nextTick } from "vue";

import ContextMenu from "@/components/common/ContextMenu.vue";
import DropdownMenu, { type MenuItem } from "@/components/common/DropdownMenu.vue";
import Modal from "@/components/common/Modal.vue";
import ThemeToggle from "@/components/common/ThemeToggle.vue";
import Breadcrumbs from "@/components/explorer/Breadcrumbs.vue";
import ChmodDialog from "@/components/explorer/ChmodDialog.vue";
import FileTable from "@/components/explorer/FileTable.vue";
import EditorDrawer from "@/components/workspace/EditorDrawer.vue";
import TransferCenter from "@/components/workspace/TransferCenter.vue";
import { useConnectionsStore } from "@/stores/connections";
import { useEditorStore } from "@/stores/editor";
import { useExplorerStore } from "@/stores/explorer";
import { useTransferStore } from "@/stores/transfer";
import type { FileEntry } from "@/types";
import { copyText, joinPath } from "@/utils/format";

const emit = defineEmits<{
  disconnect: [];
}>();

const connections = useConnectionsStore();
const explorer = useExplorerStore();
const transfers = useTransferStore();
const editor = useEditorStore();

/** 双击文本文件 → 打开编辑抽屉 */
function onOpenFile(entry: FileEntry) {
  const connectionId = connections.active?.connectionId;
  if (connectionId) void editor.openEntry(entry, explorer.cwd, connectionId);
}

/** Files 快速跳转（对应侧栏驱动器/常用位置区） */
const quickLinks = [
  { label: "根目录", path: "/", icon: HardDrive },
  { label: "主目录", path: "/home", icon: House },
  { label: "系统配置", path: "/etc", icon: FolderTree },
  { label: "日志", path: "/var", icon: ScrollText },
];

const menuOpen = ref(false);

/** 文件区滚动容器：进入新目录回顶部；原地刷新（文件操作后）保持滚动 */
const fileAreaRef = ref<HTMLElement | null>(null);
watch(
  () => explorer.cwd,
  () => {
    void nextTick(() => {
      if (fileAreaRef.value) fileAreaRef.value.scrollTop = 0;
    });
  },
);

const menuItems = computed<MenuItem[]>(() => [
  { key: "refresh", label: "刷新", icon: RefreshCw },
  {
    key: "hidden",
    label: explorer.showHidden ? "隐藏点开头的项目" : "显示点开头的项目",
    icon: Eye,
    checked: explorer.showHidden,
  },
  { key: "sep", label: "", separator: true },
  { key: "disconnect", label: "断开连接", icon: LogOut, danger: true },
]);

function onMenuSelect(key: string) {
  menuOpen.value = false;
  switch (key) {
    case "refresh":
      explorer.refresh();
      break;
    case "hidden":
      explorer.showHidden = !explorer.showHidden;
      break;
    case "disconnect":
      emit("disconnect");
      break;
  }
}

/** 文件区右键菜单状态 */
const ctxMenu = ref<{ open: boolean; x: number; y: number; entry: FileEntry | null }>({
  open: false,
  x: 0,
  y: 0,
  entry: null,
});

/** 删除确认与权限编辑的目标条目 */
const deleteTarget = ref<FileEntry | null>(null);
const chmodTarget = ref<FileEntry | null>(null);

function requestDelete(entry: FileEntry | null) {
  if (entry) deleteTarget.value = entry;
}

function confirmDelete() {
  const target = deleteTarget.value;
  deleteTarget.value = null;
  if (target) explorer.deleteEntry(target.name, target.kind === "dir");
}

function onFileContextMenu(payload: { entry: FileEntry | null; x: number; y: number }) {
  ctxMenu.value = { open: true, ...payload };
}

const ctxMenuItems = computed<MenuItem[]>(() => {
  const entry = ctxMenu.value.entry;
  if (!entry) {
    return [
      { key: "newDir", label: "新建文件夹", icon: FolderPlus },
      { key: "newFile", label: "新建文件", icon: FilePlus },
      { key: "sep", label: "", separator: true },
      { key: "refresh", label: "刷新", icon: RefreshCw },
      { key: "sep2", label: "", separator: true },
      {
        key: "hidden",
        label: explorer.showHidden ? "隐藏点开头的项目" : "显示点开头的项目",
        icon: Eye,
        checked: explorer.showHidden,
      },
    ];
  }
  const items: MenuItem[] = [];
  if (entry.kind === "dir") {
    items.push({ key: "open", label: "打开", icon: FolderOpen });
    items.push({ key: "sep", label: "", separator: true });
  }
  items.push(
    { key: "copyName", label: "复制名称", icon: Copy },
    { key: "copyPath", label: "复制路径", icon: ClipboardCopy },
    {
      key: "download",
      label: "下载到…",
      icon: Download,
      // 目录/链接暂不支持（未递归、不跟随目标）
      disabled: entry.kind !== "file",
    },
    { key: "sep2", label: "", separator: true },
    { key: "rename", label: "重命名", icon: Pencil },
    { key: "delete", label: "删除", icon: Trash2 },
    { key: "sep3", label: "", separator: true },
    { key: "chmod", label: "修改权限", icon: Lock },
  );
  return items;
});

async function onCtxMenuSelect(key: string) {
  const entry = ctxMenu.value.entry;
  ctxMenu.value = { ...ctxMenu.value, open: false };
  if (!entry) {
    if (key === "newDir") explorer.startCreate("dir");
    else if (key === "newFile") explorer.startCreate("file");
    else if (key === "refresh") explorer.refresh();
    else if (key === "hidden") explorer.showHidden = !explorer.showHidden;
    return;
  }
  switch (key) {
    case "open":
      explorer.enter(entry.name);
      break;
    case "copyName":
      await copyText(entry.name);
      break;
    case "copyPath":
      await copyText(joinPath(explorer.cwd, entry.name));
      break;
    case "download": {
      // 目录/链接置灰，双保险再判一次
      if (entry.kind !== "file") break;
      const target = await save({ defaultPath: entry.name });
      // 取消保存对话框返回 null
      if (!target) break;
      const connectionId = connections.active?.connectionId;
      if (connectionId) {
        await transfers.startDownload(
          connectionId,
          joinPath(explorer.cwd, entry.name),
          target,
        );
      }
      break;
    }
    case "rename":
      explorer.startRename(entry.name);
      break;
    case "delete":
      requestDelete(entry);
      break;
    case "chmod":
      chmodTarget.value = entry;
      break;
  }
}

onMounted(async () => {
  if (connections.active) {
    explorer.reset(connections.active.connectionId, connections.active.rootPath);
  }
  window.addEventListener("keydown", onKeydown);
  // 系统文件拖入上传（WebView2 dragDropEnabled 默认开启；浏览器预览跳过）
  if ("__TAURI_INTERNALS__" in window) {
    unlistenDrag = await getCurrentWebview().onDragDropEvent((event) => {
      const payload = event.payload;
      if (payload.type === "enter") {
        // 非文件拖拽（paths 为空）不显示覆盖层
        dragOver.value = payload.paths.length > 0;
      } else if (payload.type === "leave") {
        dragOver.value = false;
      } else if (payload.type === "drop") {
        dragOver.value = false;
        const connectionId = connections.active?.connectionId;
        if (!connectionId) return;
        for (const path of payload.paths) {
          void transfers.startUpload(connectionId, path, explorer.cwd);
        }
      }
    });
  }
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
  unlistenDrag?.();
});

/** 拖拽悬停：文件区显示「释放以上传」覆盖层 */
const dragOver = ref(false);
let unlistenDrag: UnlistenFn | null = null;

/** F2 重命名、Delete 删除选中项；Alt+↑ 上一级 / Alt+← 后退 / Alt+→ 前进 */
function onKeydown(e: KeyboardEvent) {
  // 就地编辑/表单输入时快捷键让位
  if (
    e.target instanceof HTMLInputElement ||
    e.target instanceof HTMLTextAreaElement
  ) {
    return;
  }
  if (e.key === "F2" && explorer.selectedName) {
    e.preventDefault();
    explorer.startRename(explorer.selectedName);
    return;
  }
  if (e.key === "Delete" && explorer.selectedName) {
    e.preventDefault();
    requestDelete(explorer.entryByName(explorer.selectedName));
    return;
  }
  if (!e.altKey) return;
  if (e.key === "ArrowUp") {
    e.preventDefault();
    explorer.up();
  } else if (e.key === "ArrowLeft") {
    e.preventDefault();
    explorer.back();
  } else if (e.key === "ArrowRight") {
    e.preventDefault();
    explorer.forward();
  }
}
</script>

<template>
  <div v-if="connections.active" class="flex h-full">
    <!-- 侧栏：裸 Mica 层（无边框），32px 导航项 + 3px 强调指示条 -->
    <aside class="flex w-56 shrink-0 flex-col py-2 pl-1.5">
      <nav aria-label="导航">
        <button type="button" class="nav-item" @click="emit('disconnect')">
          <House :size="16" class="ml-1 shrink-0" />
          <span class="ml-3 truncate">主页</span>
        </button>

        <p class="mt-4 mb-1 px-2.5 text-xs font-medium text-faint">此服务器</p>
        <button
          v-for="link in quickLinks"
          :key="link.path"
          type="button"
          class="nav-item"
          :class="explorer.cwd === link.path && 'active'"
          @click="explorer.open(link.path)"
        >
          <component :is="link.icon" :size="16" class="ml-1 shrink-0" />
          <span class="ml-3 truncate">{{ link.label }}</span>
        </button>
      </nav>

      <!-- 底部连接信息卡 -->
      <div class="mt-auto px-1.5 pb-1">
        <div
          class="rounded-lg p-3"
          :style="{ background: 'var(--toolbar)', border: '1px solid var(--line)' }"
        >
          <p class="flex items-center gap-1.5 text-[13px] font-semibold">
            <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-live" aria-hidden="true" />
            <span class="truncate">{{ connections.active.alias }}</span>
          </p>
          <p class="mt-1 truncate font-mono text-[11px] text-dim">
            {{ connections.active.profile.username }}@{{ connections.active.profile.host }}
          </p>
        </div>
      </div>
    </aside>

    <!-- 主列：地址行卡 + 文件区卡 + 编辑抽屉 + 状态栏 -->
    <div class="flex min-w-0 flex-1 flex-col gap-1 p-2 pl-2.5" data-main-col>
      <!-- 地址行（Win11：后退/前进/刷新在地址栏左侧） -->
      <div
        class="flex h-12 shrink-0 items-center gap-1 rounded-lg px-1"
        :style="{ background: 'var(--toolbar)', border: '1px solid var(--line)' }"
      >
        <button
          type="button"
          class="btn-icon"
          :disabled="!explorer.canBack || explorer.loading"
          title="后退（Alt+←）"
          aria-label="后退"
          @click="explorer.back()"
        >
          <ArrowLeft :size="16" />
        </button>
        <button
          type="button"
          class="btn-icon"
          :disabled="!explorer.canForward || explorer.loading"
          title="前进（Alt+→）"
          aria-label="前进"
          @click="explorer.forward()"
        >
          <ArrowRight :size="16" />
        </button>
        <button
          type="button"
          class="btn-icon"
          :disabled="explorer.loading"
          title="刷新"
          aria-label="刷新"
          @click="explorer.refresh()"
        >
          <RefreshCw :size="15" :class="explorer.loading && 'animate-spin'" />
        </button>

        <div class="mx-1.5 min-w-0 flex-1">
          <Breadcrumbs />
        </div>

        <TransferCenter />
        <ThemeToggle />
        <div class="relative">
          <button
            type="button"
            class="btn-icon"
            title="更多选项"
            aria-label="更多选项"
            @click="menuOpen = !menuOpen"
          >
            <MoreHorizontal :size="16" />
          </button>
          <DropdownMenu :open="menuOpen" :items="menuItems" @select="onMenuSelect" @close="menuOpen = false" />
        </div>
      </div>

      <!-- 文件区：FileArea 卡（8 圆角 + 1px 描边） -->
      <div class="relative min-h-0 flex-1">
        <div
          ref="fileAreaRef"
          class="h-full overflow-y-auto rounded-lg"
          :style="{ background: 'var(--panel)', border: '1px solid var(--line)' }"
        >
          <div
            v-if="explorer.error"
            class="m-2 flex items-center gap-2.5 rounded-lg px-3.5 py-2.5 text-sm"
            :style="{ background: 'color-mix(in srgb, var(--danger) 10%, transparent)', color: 'var(--danger)' }"
          >
            <TriangleAlert :size="15" class="shrink-0" />
            <span class="min-w-0 flex-1 truncate text-xs" :title="explorer.error">
              {{ explorer.error }}
            </span>
            <button type="button" class="btn-secondary h-7 px-2 text-xs" @click="explorer.refresh()">
              重试
            </button>
          </div>
          <FileTable @context-menu="onFileContextMenu" @open-file="onOpenFile" />
        </div>

        <!-- 拖拽悬停覆盖层：释放以上传到当前目录 -->
        <div
          v-if="dragOver"
          class="pointer-events-none absolute inset-0 z-30 flex items-center justify-center rounded-lg"
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
            <Upload :size="22" class="text-accent" />
            <span class="text-sm font-semibold">释放以上传到</span>
            <span class="max-w-64 truncate font-mono text-xs text-dim" :title="explorer.cwd">
              {{ explorer.cwd }}
            </span>
          </div>
        </div>
      </div>

      <!-- 底部编辑抽屉 -->
      <EditorDrawer />

      <!-- 状态栏（Files StatusBar：无传输元素，仅目录统计） -->
      <footer class="flex h-8 shrink-0 items-center justify-between px-3 text-xs text-dim">
        <span>
          {{ explorer.visibleEntries.length }} 个项目
          <span v-if="explorer.selectedName">· 已选择 1 项</span>
        </span>
        <span class="font-mono">{{ connections.active.latencyMs }} ms</span>
      </footer>
    </div>

    <!-- 文件区右键菜单（光标定位） -->
    <ContextMenu
      :open="ctxMenu.open"
      :x="ctxMenu.x"
      :y="ctxMenu.y"
      :items="ctxMenuItems"
      @select="onCtxMenuSelect"
      @close="ctxMenu.open = false"
    />

    <!-- 删除确认：远程删除不可恢复，红色主按钮 -->
    <Modal :open="!!deleteTarget" title="删除确认" @close="deleteTarget = null">
      <div v-if="deleteTarget" class="flex flex-col gap-4">
        <p class="text-sm leading-6">
          确定要删除「<span class="font-semibold">{{ deleteTarget.name }}</span>
          {{ deleteTarget.kind === "dir" ? "」文件夹吗？其中的所有内容都将被一并删除。" : "」吗？" }}
        </p>
        <p class="text-xs text-faint">
          路径 {{ explorer.cwd }}/{{ deleteTarget.name }} — 远程删除无法撤销。
        </p>
        <footer class="mt-1 flex justify-end gap-2">
          <button type="button" class="btn-secondary" @click="deleteTarget = null">
            取消
          </button>
          <button type="button" class="btn-danger" @click="confirmDelete">
            删除
          </button>
        </footer>
      </div>
    </Modal>

    <!-- 修改权限：3×3 勾选 + rwx/八进制实时预览 -->
    <ChmodDialog
      :open="!!chmodTarget"
      :entry="chmodTarget"
      @close="chmodTarget = null"
      @apply="(mode) => {
        const target = chmodTarget;
        chmodTarget = null;
        if (target) explorer.chmodEntry(target.name, mode);
      }"
    />
  </div>
</template>
