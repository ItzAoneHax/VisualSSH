<script setup lang="ts">
import type { UnlistenFn } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  ArrowLeft,
  ArrowRight,
  ClipboardCopy,
  ClipboardPaste,
  Copy,
  Download,
  Eye,
  FilePlus,
  FolderOpen,
  FolderPlus,
  FolderTree,
  HardDrive,
  House,
  Info,
  Lock,
  Pencil,
  RefreshCw,
  Scissors,
  ScrollText,
  Search,
  Settings,
  SquareTerminal,
  TextSelect,
  Trash2,
  TriangleAlert,
  Upload,
  X,
} from "@lucide/vue";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { nextTick } from "vue";
import { tempDir } from "@tauri-apps/api/path";

import ContextMenu from "@/components/common/ContextMenu.vue";
import type { MenuItem } from "@/components/common/DropdownMenu.vue";
import Modal from "@/components/common/Modal.vue";
import Breadcrumbs from "@/components/explorer/Breadcrumbs.vue";
import ChmodDialog from "@/components/explorer/ChmodDialog.vue";
import ConflictDialog from "@/components/explorer/ConflictDialog.vue";
import FileTable from "@/components/explorer/FileTable.vue";
import PropertiesDialog from "@/components/explorer/PropertiesDialog.vue";
import EditorDrawer from "@/components/workspace/EditorDrawer.vue";
import TerminalPanel from "@/components/workspace/TerminalPanel.vue";
import TransferCenter from "@/components/workspace/TransferCenter.vue";
import { useConnectionsStore } from "@/stores/connections";
import { useClipboardStore } from "@/stores/clipboard";
import { useConflictStore, type IncomingItem } from "@/stores/conflicts";
import { useEditorStore } from "@/stores/editor";
import { useExplorerStore } from "@/stores/explorer";
import { useSettingsStore } from "@/stores/settings";
import { useTerminalStore } from "@/stores/terminal";
import { useTransferStore } from "@/stores/transfer";
import type { FileEntry } from "@/types";
import { copyText, joinPath, pathBaseName } from "@/utils/format";
import {
  copyVirtualFiles,
  readClipboardFiles,
} from "@/api/clipboard";
import {
  execSsh,
  listDir,
  renameSsh,
  type ExecOutput,
} from "@/api/ssh";
import { localFileMeta } from "@/api/transfer";

const emit = defineEmits<{
  disconnect: [];
}>();

const connections = useConnectionsStore();
const explorer = useExplorerStore();
const transfers = useTransferStore();
const conflicts = useConflictStore();
const clip = useClipboardStore();
const editor = useEditorStore();
const terminalStore = useTerminalStore();
const settings = useSettingsStore();

/** 双击文本文件 → 打开编辑抽屉 */
function onOpenFile(entry: FileEntry) {
  const connectionId = connections.active?.connectionId;
  if (connectionId) void editor.openEntry(entry, explorer.cwd, connectionId);
}

/** 打开终端（在当前目录启动 shell；已开则聚焦面板） */
function onOpenTerminal() {
  const connectionId = connections.active?.connectionId;
  if (connectionId) void terminalStore.openIn(explorer.cwd, connectionId);
}

/** —— 地址栏搜索：面包屑收缩 + 搜索框展开（即时过滤当前目录） —— */
const searchOpen = ref(false);

function toggleSearch() {
  if (searchOpen.value) {
    closeSearch();
  } else {
    // 只展开，不抢焦点——用户想输入时自己点搜索框
    searchOpen.value = true;
  }
}

function closeSearch() {
  searchOpen.value = false;
  explorer.searchQuery = "";
}

/** 右键项在多选集合内 → 整个集合；否则单项 / 当前选择（Delete 同款规则） */
function resolveTargetNames(entry: FileEntry | null): string[] | null {
  if (entry && explorer.isSelected(entry.name) && explorer.selectedNames.size > 1) {
    return [...explorer.selectedNames];
  }
  if (entry) return [entry.name];
  const names = [...explorer.selectedNames];
  return names.length ? names : null;
}

/** Ctrl+C：双写——系统虚拟文件剪贴板（本地 Explorer 粘贴用，仅文件）+
 *  内部剪贴板（远端 Ctrl+V 粘贴用，含文件夹；文件夹走系统侧会失败故静默跳过） */
async function copySelectionToClipboard(entry?: FileEntry | null) {
  const connectionId = connections.active?.connectionId;
  const names = resolveTargetNames(entry ?? null);
  if (!connectionId || !names?.length) return;
  const files = names
    .map((n) => explorer.entryByName(n))
    .filter((e): e is FileEntry => !!e);
  clip.write("copy", connectionId, explorer.cwd, files.map((f) => f.name));
  if (!files.some((f) => f.kind === "dir")) {
    try {
      await copyVirtualFiles(
        connectionId,
        explorer.cwd,
        files.map((f) => ({ name: f.name, size: f.size, mtime: f.mtime })),
      );
    } catch (e) {
      explorer.error = e instanceof Error ? e.message : String(e);
      return;
    }
  }
  showHint(`已复制 ${files.length} 项`);
}

/** Ctrl+X：仅写内部剪贴板；被剪切行以 0.4 透明度标记（Files DimItemOpacity） */
function cutSelectionToClipboard(entry?: FileEntry | null) {
  const connectionId = connections.active?.connectionId;
  const names = resolveTargetNames(entry ?? null);
  if (!connectionId || !names?.length) return;
  clip.write("cut", connectionId, explorer.cwd, names);
  showHint(`已剪切 ${names.length} 项`);
}

/** 轻提示：3 秒自动消失（错误横幅仍走 explorer.error） */
const hint = ref("");
let hintTimer: ReturnType<typeof setTimeout> | undefined;

function showHint(text: string) {
  hint.value = text;
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => (hint.value = ""), 3000);
}

/** 上传前冲突解析（Ctrl+V 与拖放共用）：有同名先弹对话框，取消/出错返回 null */
async function resolveUploadConflicts(
  localPaths: string[],
): Promise<{ path: string; finalName: string }[] | null> {
  const connectionId = connections.active?.connectionId;
  if (!connectionId) return null;
  const metas = await localFileMeta(localPaths).catch(() => []);
  const incoming: IncomingItem[] = localPaths.map((p, i) => ({
    name: pathBaseName(p),
    size: metas[i]?.size ?? null,
    mtime: metas[i]?.mtime ?? null,
  }));
  try {
    const decisions = await conflicts.resolve(connectionId, explorer.cwd, incoming);
    if (!decisions) return null;
    const out: { path: string; finalName: string }[] = [];
    for (const d of decisions) {
      if (d.action !== "proceed") continue;
      const path = localPaths.find((lp) => pathBaseName(lp) === d.name);
      if (path) out.push({ path, finalName: d.finalName });
    }
    return out;
  } catch (e) {
    explorer.error = e instanceof Error ? e.message : String(e);
    return null;
  }
}

/** Ctrl+V：内部剪贴板非空 → 远端粘贴（内部优先）；为空回落系统 HDROP 上传 */
async function pasteFromClipboard(pasteIntoSelection = false) {
  const connectionId = connections.active?.connectionId;
  if (!connectionId) return;
  if (clip.clip && clip.clip.names.length) {
    if (clip.clip.connectionId !== connectionId) {
      clip.clear();
    } else {
      await pasteRemote(connectionId, pasteIntoSelection);
      return;
    }
  }
  let localPaths: string[];
  try {
    localPaths = await readClipboardFiles();
  } catch {
    return;
  }
  if (!localPaths.length) return;
  const resolved = await resolveUploadConflicts(localPaths);
  if (!resolved) return;
  for (const item of resolved) {
    await transfers.startUpload(connectionId, item.path, explorer.cwd, item.finalName);
  }
}

/** 远端粘贴：先过冲突对话框（目标 = 粘贴目录），再按模式执行。
 *  cut = SFTP rename → exec mv -f 回退；copy = exec cp -a → 单文件「暂存下载→上传」回退。 */
async function pasteRemote(connectionId: string, pasteIntoSelection: boolean) {
  const c = clip.clip;
  if (!c) return;

  // Ctrl+Shift+V：恰好选中一个文件夹 → 粘贴进该文件夹（Files PasteItemToSelectionAction）
  let targetDir = explorer.cwd;
  if (pasteIntoSelection && explorer.selectedNames.size === 1) {
    const entry = explorer.entryByName([...explorer.selectedNames][0]);
    if (entry?.kind === "dir") targetDir = joinPath(explorer.cwd, entry.name);
  }

  if (c.mode === "cut" && c.sourceDir === targetDir) {
    showHint("源目录与目标目录相同，无需移动");
    return;
  }

  // 源目录现状：取条目元数据（同时校验源项仍存在，删除/移动后标记自然失效）
  let sourceEntries: FileEntry[];
  try {
    sourceEntries = await listDir(connectionId, c.sourceDir);
  } catch (e) {
    explorer.error = e instanceof Error ? e.message : String(e);
    return;
  }
  const byName = new Map(sourceEntries.map((e) => [e.name, e]));
  const present = c.names.filter((n) => byName.has(n));
  if (!present.length) {
    clip.clear();
    return;
  }
  const incoming: IncomingItem[] = present.map((n) => {
    const e = byName.get(n)!;
    return { name: e.name, size: e.size, mtime: e.mtime, kind: e.kind };
  });

  let decisions;
  try {
    decisions = await conflicts.resolve(connectionId, targetDir, incoming);
  } catch (e) {
    explorer.error = e instanceof Error ? e.message : String(e);
    return;
  }
  if (!decisions) return;
  const jobs = decisions
    .filter((d) => d.action === "proceed")
    .map((d) => ({ ...d, source: byName.get(d.name)! }));
  if (!jobs.length) return; // 全部跳过：剪贴板保留

  const op = await transfers.startRemoteOp(
    c.mode === "cut" ? "remote-move" : "remote-copy",
    jobs.length,
    targetDir,
  );
  const failed: string[] = [];
  let done = 0;
  for (const job of jobs) {
    if (op.isCancelled()) break;
    const src = joinPath(c.sourceDir, job.name);
    const dst = joinPath(targetDir, job.finalName);
    try {
      if (c.mode === "cut") {
        try {
          // 同文件系统跨目录改名零拷贝
          await renameSsh(connectionId, src, dst);
        } catch {
          const r = await execSsh(connectionId, "mv", ["-f", "--", src, dst]);
          if (r.exitCode !== 0) {
            throw new Error(r.stderr.trim() || `mv 退出码 ${r.exitCode ?? "未知"}`);
          }
        }
      } else {
        let result: ExecOutput | null = null;
        try {
          result = await execSsh(connectionId, "cp", ["-a", "--", src, dst]);
        } catch {
          result = null;
        }
        if (!result || result.exitCode === 126 || result.exitCode === 127) {
          // shell/cp 不可用：仅单文件可走「暂存下载→上传」回退
          if (job.source.kind !== "file") {
            throw new Error("服务器 shell 不可用，无法复制文件夹");
          }
          await fallbackCopyViaTemp(connectionId, src, job.finalName, targetDir);
        } else if (result.exitCode !== 0) {
          throw new Error(result.stderr.trim() || `cp 退出码 ${result.exitCode ?? "未知"}`);
        }
      }
      done += 1;
    } catch (e) {
      failed.push(`${job.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (op.isCancelled()) {
    // cancelRemoteOp 已把卡片置为已取消
  } else if (failed.length) {
    op.setFailed(`完成 ${done} 项，失败 ${failed.length} 项 — ${failed[0]}`);
  } else {
    op.setDone();
  }
  clip.clear();
  if (targetDir === explorer.cwd || c.sourceDir === explorer.cwd) {
    await explorer.reloadPreserve();
  }
  if (!failed.length && !op.isCancelled()) {
    showHint(`已${c.mode === "cut" ? "移动" : "复制"} ${done} 项`);
  } else if (failed.length) {
    explorer.error = `${c.mode === "cut" ? "移动" : "复制"}未全部完成 — ${failed.join("；")}`;
  }
}

/** exec 不可用时的单文件复制回退：暂存下载到本地临时目录再上传（复用传输中心管线） */
async function fallbackCopyViaTemp(
  connectionId: string,
  remotePath: string,
  name: string,
  targetDir: string,
) {
  const base = (await tempDir()).replace(/[\\/]+$/, "");
  const local = `${base}/VisualSSH/${crypto.randomUUID()}-${name}`;
  const transferId = await transfers.startDownloadTo(connectionId, remotePath, local);
  const ok = await transfers.waitAllDone([transferId]);
  if (!ok) throw new Error(`暂存下载失败（${name}）`);
  await transfers.startUpload(connectionId, local, targetDir, name);
}

/** Files 快速跳转（对应侧栏驱动器/常用位置区） */
const quickLinks = [
  { label: "根目录", path: "/", icon: HardDrive },
  { label: "主目录", path: "/home", icon: House },
  { label: "系统配置", path: "/etc", icon: FolderTree },
  { label: "日志", path: "/var", icon: ScrollText },
];

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


/** 文件区右键菜单状态 */
const ctxMenu = ref<{ open: boolean; x: number; y: number; entry: FileEntry | null }>({
  open: false,
  x: 0,
  y: 0,
  entry: null,
});

/** 删除确认与权限编辑的目标条目（删除支持批量） */
const deleteTargets = ref<FileEntry[] | null>(null);
const chmodTarget = ref<FileEntry | null>(null);
/** 属性对话框目标（单选/多选） */
const propertiesTargets = ref<FileEntry[] | null>(null);

/** 属性入口（右键菜单 / Alt+Enter）：右键项在多选集合内时对整个集合生效 */
function openProperties(entry: FileEntry | null) {
  if (entry && explorer.isSelected(entry.name) && explorer.selectedNames.size > 1) {
    propertiesTargets.value = [...explorer.selectedNames]
      .map((n) => explorer.entryByName(n))
      .filter((e): e is FileEntry => !!e);
    return;
  }
  if (entry) {
    propertiesTargets.value = [entry];
    return;
  }
  const targets = [...explorer.selectedNames]
    .map((n) => explorer.entryByName(n))
    .filter((e): e is FileEntry => !!e);
  if (targets.length) propertiesTargets.value = targets;
}

/** 单条删除（右键菜单）或按当前多选批量（Delete 键）。
 *  设置关闭「删除前确认」时跳过对话框直接执行（Files ShowConfirmationWhenDeletingItems）。 */
function requestDelete(entry: FileEntry | null) {
  if (collectDeleteTargets(entry)) {
    if (settings.settings.confirmDelete) return; // 弹确认框
    confirmDelete();
  }
}

function collectDeleteTargets(entry: FileEntry | null): boolean {
  if (entry && explorer.isSelected(entry.name) && explorer.selectedNames.size > 1) {
    // 右键项在多选集合内：批量删整个集合
    deleteTargets.value = [...explorer.selectedNames]
      .map((n) => explorer.entryByName(n))
      .filter((e): e is FileEntry => !!e);
    return true;
  }
  if (entry) {
    deleteTargets.value = [entry];
    return true;
  }
  // 无参调用 = Delete 键作用于当前选择
  const targets = [...explorer.selectedNames]
    .map((n) => explorer.entryByName(n))
    .filter((e): e is FileEntry => !!e);
  if (targets.length) {
    deleteTargets.value = targets;
    return true;
  }
  return false;
}

function confirmDelete() {
  const targets = deleteTargets.value;
  deleteTargets.value = null;
  if (!targets?.length) return;
  if (targets.length === 1) {
    explorer.deleteEntry(targets[0].name, targets[0].kind === "dir");
  } else {
    void explorer.deleteEntries(
      targets.map((t) => t.name),
      (name) => targets.find((t) => t.name === name)?.kind === "dir",
    );
  }
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
      {
        key: "paste",
        label: clip.count ? `粘贴（${clip.count} 项）` : "粘贴",
        icon: ClipboardPaste,
        disabled: clip.count === 0,
      },
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
    { key: "cut", label: "剪切", icon: Scissors },
    { key: "copy", label: "复制", icon: Copy },
    { key: "copyName", label: "复制名称", icon: TextSelect },
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
    { key: "sep4", label: "", separator: true },
    { key: "properties", label: "属性", icon: Info },
  );
  return items;
});

async function onCtxMenuSelect(key: string) {
  const entry = ctxMenu.value.entry;
  ctxMenu.value = { ...ctxMenu.value, open: false };
  if (!entry) {
    if (key === "newDir") explorer.startCreate("dir");
    else if (key === "newFile") explorer.startCreate("file");
    else if (key === "refresh" || key === "refresh2") explorer.refresh();
    else if (key === "paste") void pasteFromClipboard(false);
    return;
  }
  switch (key) {
    case "open":
      explorer.enter(entry.name);
      break;
    case "cut":
      cutSelectionToClipboard(entry);
      break;
    case "copy":
      void copySelectionToClipboard(entry);
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
    case "properties":
      openProperties(entry);
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
    unlistenDrag = await getCurrentWebview().onDragDropEvent(async (event) => {
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
        const resolved = await resolveUploadConflicts(payload.paths);
        if (!resolved) return;
        for (const item of resolved) {
          void transfers.startUpload(connectionId, item.path, explorer.cwd, item.finalName);
        }
      }
    });
  }
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
  clearTimeout(hintTimer);
  unlistenDrag?.();
  // 工作区销毁（断开连接）→ 终端面板复位 + 内部剪贴板清空
  terminalStore.reset();
  clip.clear();
});

/** 拖拽悬停：文件区显示「释放以上传」覆盖层 */
const dragOver = ref(false);
let unlistenDrag: UnlistenFn | null = null;

/** F2 重命名、Delete 删除选中项、Ctrl+C/X/V 剪贴板；Alt+Enter 属性；
 *  Alt+↑ 上一级 / Alt+← 后退 / Alt+→ 前进 */
function onKeydown(e: KeyboardEvent) {
  // 就地编辑/表单输入时快捷键让位
  if (
    e.target instanceof HTMLInputElement ||
    e.target instanceof HTMLTextAreaElement
  ) {
    return;
  }
  // 悬浮窗（编辑器/终端）打开时让位
  if (editor.open || terminalStore.open) return;
  if (e.ctrlKey && (e.key === "c" || e.key === "C")) {
    e.preventDefault();
    void copySelectionToClipboard();
    return;
  }
  if (e.ctrlKey && (e.key === "x" || e.key === "X")) {
    e.preventDefault();
    cutSelectionToClipboard();
    return;
  }
  if (e.ctrlKey && (e.key === "v" || e.key === "V")) {
    e.preventDefault();
    // Ctrl+Shift+V：恰好选中一个文件夹时粘贴进该文件夹
    void pasteFromClipboard(e.shiftKey);
    return;
  }
  if (e.key === "F2" && explorer.selectedNames.size === 1) {
    e.preventDefault();
    explorer.startRename([...explorer.selectedNames][0]);
    return;
  }
  if (e.key === "Delete" && explorer.selectedNames.size > 0) {
    e.preventDefault();
    requestDelete(null);
    return;
  }
  if (!e.altKey) return;
  if (e.key === "Enter" && explorer.selectedNames.size > 0) {
    // Alt+Enter：属性（Files OpenPropertiesAction 热键）
    e.preventDefault();
    openProperties(null);
    return;
  }
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
  <div v-if="connections.active" class="flex h-full flex-col">
    <div class="flex min-h-0 flex-1">
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

        <!-- 面包屑 ⇄ 搜索框：面包屑左对齐固定、从右缘被裁剪让位；搜索框自身宽度动画
             （flex 末项右缘固定、左缘向左扫出，四条边框全程绘制，内容定宽防回流） -->
        <div class="mx-1.5 flex min-w-0 flex-1 items-center gap-1.5">
          <div class="min-w-0 flex-1 overflow-hidden">
            <Breadcrumbs />
          </div>

          <div
            class="flex h-[34px] shrink-0 items-center overflow-hidden rounded-[4px]"
            :style="{
              width: searchOpen ? '250px' : '0px',
              padding: searchOpen ? '0px 10px' : '0px',
              borderWidth: searchOpen ? '1px' : '0px',
              borderStyle: 'solid',
              borderColor: 'var(--line)',
              background: 'var(--sidebar)',
              transition:
                'width 0.25s cubic-bezier(0.16, 1, 0.3, 1), border-width 0.1s linear, padding 0.1s linear',
            }"
          >
            <div class="flex h-full w-[228px] shrink-0 items-center gap-1.5">
              <Search :size="14" class="shrink-0 text-dim" />
              <input
                v-model="explorer.searchQuery"
                class="h-full min-w-0 flex-1 bg-transparent text-sm text-ink outline-none"
                placeholder="搜索当前目录"
                aria-label="搜索当前目录"
                @keydown.esc.stop="closeSearch"
              />
              <button
                v-if="explorer.searchQuery"
                type="button"
                class="btn-icon h-6 w-6 shrink-0"
                title="清空"
                aria-label="清空搜索"
                @click="explorer.searchQuery = ''"
              >
                <X :size="13" />
              </button>
            </div>
          </div>
        </div>

        <button
          type="button"
          class="btn-icon"
          :class="searchOpen && 'text-accent'"
          :title="searchOpen ? '关闭搜索' : '搜索当前目录'"
          aria-label="搜索"
          @click="toggleSearch"
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
          <!-- 轻提示（accent 色，自动消失；与错误横幅同形） -->
          <div
            v-if="hint"
            class="m-2 flex items-center gap-2.5 rounded-lg px-3.5 py-2.5"
            :style="{ background: 'color-mix(in srgb, var(--accent) 8%, transparent)' }"
          >
            <ClipboardCopy :size="15" class="shrink-0 text-accent" />
            <span class="min-w-0 flex-1 truncate text-xs text-dim">{{ hint }}</span>
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

      <!-- 底部终端面板 -->
      <TerminalPanel />
      </div>
    </div>

    <!-- 通栏状态栏：项目统计 + 连接状态（全宽一条，底部唯一收边；可在设置中隐藏） -->
    <footer
      v-if="settings.settings.showStatusBar"
      class="flex h-8 shrink-0 items-center justify-between border-t px-3 text-xs text-dim"
      :style="{ borderColor: 'var(--line)' }"
    >
      <span>
        {{ explorer.visibleEntries.length }} 个项目
        <span v-if="explorer.selectedNames.size">· 已选择 {{ explorer.selectedNames.size }} 项</span>
      </span>
      <span class="flex min-w-0 items-baseline gap-3">
        <span class="flex min-w-0 items-baseline gap-1.5" :title="`${connections.active.profile.username}@${connections.active.profile.host}`">
          <span class="h-1.5 w-1.5 shrink-0 self-center rounded-full bg-live" aria-hidden="true" />
          <span class="truncate font-medium">{{ connections.active.alias }}</span>
          <span class="truncate font-mono text-[11px]">
            {{ connections.active.profile.username }}@{{ connections.active.profile.host }}
          </span>
        </span>
        <span class="shrink-0 font-mono">{{ connections.active.latencyMs }} ms</span>
      </span>
    </footer>

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
    <Modal :open="!!deleteTargets" title="删除确认" @close="deleteTargets = null">
      <div v-if="deleteTargets?.length" class="flex flex-col gap-4">
        <p class="text-sm leading-6">
          <template v-if="deleteTargets.length === 1">
            确定要删除「<span class="font-semibold">{{ deleteTargets[0].name }}</span>
            {{ deleteTargets[0].kind === "dir" ? "」文件夹吗？其中的所有内容都将被一并删除。" : "」吗？" }}
          </template>
          <template v-else>
            确定要删除这 <span class="font-semibold">{{ deleteTargets.length }}</span> 个项目吗？
            <span v-if="deleteTargets.some((t) => t.kind === 'dir')">文件夹中的所有内容都将被一并删除。</span>
          </template>
        </p>
        <p class="text-xs text-faint">
          路径 {{ explorer.cwd }}/{{ deleteTargets.length === 1 ? deleteTargets[0].name : "…" }} — 远程删除无法撤销。
        </p>
        <footer class="mt-1 flex justify-end gap-2">
          <button type="button" class="btn-secondary" @click="deleteTargets = null">
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

    <!-- 上传/粘贴冲突：同名项逐个决策（生成新名称/替换/跳过），支持应用到所有 -->
    <ConflictDialog />

    <!-- 属性：单页（类型/位置/时间/属主组/权限/链接目标 + 递归统计），单选可改名 -->
    <PropertiesDialog
      :targets="propertiesTargets"
      :parent-dir="explorer.cwd"
      @close="propertiesTargets = null"
      @rename="(oldName, newName) => {
        propertiesTargets = null;
        explorer.renameEntry(oldName, newName);
      }"
      @chmod="(entry) => {
        propertiesTargets = null;
        chmodTarget = entry;
      }"
    />
  </div>
</template>
