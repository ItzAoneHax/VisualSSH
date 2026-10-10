<script setup lang="ts">
import { open as openDialog, save } from "@tauri-apps/plugin-dialog";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ClipboardCopy,
  ClipboardPaste,
  Copy,
  Download,
  Eye,
  FileArchive,
  FilePlus,
  FolderDown,
  FolderInput,
  FolderOpen,
  FolderPlus,
  FolderSearch,
  History,
  Info,
  Lock,
  Pencil,
  Pin,
  PinOff,
  RefreshCw,
  Scissors,
  SquareTerminal,
  StopCircle,
  TextSelect,
  Trash2,
  TriangleAlert,
  X,
} from "@lucide/vue";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";

import ContextMenu from "@/components/common/ContextMenu.vue";
import type { MenuItem } from "@/components/common/DropdownMenu.vue";
import Modal from "@/components/common/Modal.vue";
import ArchiveDialog from "@/components/explorer/ArchiveDialog.vue";
import Breadcrumbs from "@/components/explorer/Breadcrumbs.vue";
import ChmodDialog from "@/components/explorer/ChmodDialog.vue";
import FileTable from "@/components/explorer/FileTable.vue";
import PropertiesDialog from "@/components/explorer/PropertiesDialog.vue";
import { useClipboardStore } from "@/stores/clipboard";
import { useArchivesStore } from "@/stores/archives";
import { useConnectionsStore } from "@/stores/connections";
import { useConflictStore, type ConflictDecision } from "@/stores/conflicts";
import { useEditorStore } from "@/stores/editor";
import { useExplorer } from "@/stores/explorer";
import { usePinnedStore } from "@/stores/pinned";
import { useSettingsStore } from "@/stores/settings";
import { useTerminalStore } from "@/stores/terminal";
import { useTransferStore } from "@/stores/transfer";
import { useToastStore } from "@/stores/toast";
import { useWorkspaceStore } from "@/stores/workspace";
import type { FileEntry } from "@/types";
import {
  archiveBaseName,
  archiveFamilyOf,
  defaultArchiveName,
  requiredToolFor,
} from "@/utils/archive";
import { compressSelection, extractArchive } from "@/utils/archiveOps";
import { buildScpCommand } from "@/utils/scp";
import { copyText, joinPath, pathBaseName } from "@/utils/format";
import {
  isCrossConnection,
  isSameDir,
  resolveDropMode,
  type FilesDragPayload,
} from "@/utils/dragDrop";
import {
  downloadFolderTo,
  uploadMixedPaths,
} from "@/utils/recursiveTransfer";
import { crossConnectionTransfer, remoteMoveCopy } from "@/utils/remoteOps";
import { copyVirtualFiles, readClipboardFiles } from "@/api/clipboard";
import { readClipboardImage, saveClipboardImage } from "@/api/clipboard";
import { revealItemInDir } from "@tauri-apps/plugin-opener";

/**
 * 单个窗格（M7 步骤 2/3）：导航段（后退/前进/上一级/刷新/面包屑）+ 文件区 +
 * 右键菜单/删除/权限/属性对话框 + 剪贴板/上传粘贴逻辑 + 窗格级快捷键。
 * 每个窗格实例绑定自己的 explorer 实例（props.paneId）；
 * 快捷键/侧键仅在自己是活动窗格时响应（双栏时另一窗格忽略）。
 * 工具栏行的全局按钮（终端/传输中心等）经 #actions 插槽由父组件注入。
 */

const props = defineProps<{ paneId: string; tabId: string }>();

const connectionsStore = useConnectionsStore();
const workspace = useWorkspaceStore();
const explorer = useExplorer(props.paneId);
const editor = useEditorStore();
const transfers = useTransferStore();
const toastStore = useToastStore();
const conflicts = useConflictStore();
const clip = useClipboardStore();
const settings = useSettingsStore();
const terminalStore = useTerminalStore();
const archivesStore = useArchivesStore();

/** 本窗格所属标签的连接（窗格共享标签的 connectionId） */
const conn = computed(() => connectionsStore.byId[connectionId.value] ?? null);
const connectionId = computed(
  () => workspace.tabs.find((t) => t.id === props.tabId)?.connectionId ?? "",
);
const profileId = computed(() => conn.value?.profile.id ?? "");
/** 双栏时本标签显示窗格关闭按钮 */
const isDualPane = computed(
  () => (workspace.tabs.find((t) => t.id === props.tabId)?.panes.length ?? 1) > 1,
);

/** 点击/右键切换活动窗格（Files Pane_PointerPressed/GotFocus：按钮/输入框上按下除外，
 *  切换时清空另一窗格选择——setActivePane 内处理） */
function activatePane(e: Event) {
  if (!isActivePane() && !(e.target instanceof HTMLElement && e.target.closest("button, input, textarea"))) {
    workspace.setActivePane(props.paneId);
  }
}

/** 活动窗格检查：快捷键/侧键只作用于活动窗格（双栏语义，ShellPanesPage ActivePane） */
function isActivePane() {
  return workspace.activePaneId === props.paneId;
}

/** 双击文本文件 → 打开编辑抽屉（编辑器为全局浮层） */
function onOpenFile(entry: FileEntry) {
  const cid = connectionId.value;
  if (cid) void editor.openEntry(entry, explorer.cwd, cid);
}

/** —— 地址栏搜索已抽为 SearchBox 组件（步骤 3，随全局工具按钮经 #actions 注入） —— */

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
  const cid = connectionId.value;
  const names = resolveTargetNames(entry ?? null);
  if (!cid || !names?.length) return;
  const files = names
    .map((n) => explorer.entryByName(n))
    .filter((e): e is FileEntry => !!e);
  clip.write("copy", cid, explorer.cwd, files.map((f) => f.name));
  if (!files.some((f) => f.kind === "dir")) {
    try {
      await copyVirtualFiles(
        cid,
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
  const cid = connectionId.value;
  const names = resolveTargetNames(entry ?? null);
  if (!cid || !names?.length) return;
  clip.write("cut", cid, explorer.cwd, names);
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

/** Ctrl+V：内部剪贴板非空 → 远端粘贴（同连接走 SFTP 直操；跨连接走下载→上传）；
 *  为空回落系统 HDROP 上传 */
async function pasteFromClipboard(pasteIntoSelection = false) {
  const cid = connectionId.value;
  if (!cid) return;
  if (clip.clip && clip.clip.names.length) {
    if (clip.clip.connectionId !== cid) {
      await pasteCrossConnection(cid);
      return;
    }
    await pasteRemote(cid, pasteIntoSelection);
    return;
  }
  let localPaths: string[];
  try {
    localPaths = await readClipboardFiles();
  } catch {
    localPaths = [];
  }
  if (localPaths.length) {
    try {
      await uploadMixedPaths(cid, localPaths, explorer.cwd);
    } catch (e) {
      explorer.error = e instanceof Error ? e.message : String(e);
    }
    return;
  }
  await pasteImageFromClipboard(cid);
}

/** 图片直传回落（块 B）：HDROP 空而含位图 → PNG 上传活动窗格目录，
 *  冲突走对话框；完成后 toast + 选中。无图静默（终端/编辑器已让位不达此处）。 */
async function pasteImageFromClipboard(cid: string) {
  let png: Uint8Array | null;
  try {
    png = await readClipboardImage();
  } catch {
    return; // 剪贴板占用等：按无图处理
  }
  if (!png || !png.length) return;
  let tempPath: string;
  try {
    tempPath = await saveClipboardImage(png);
  } catch (e) {
    explorer.error = e instanceof Error ? e.message : String(e);
    return;
  }
  const incomingName = pathBaseName(tempPath);
  let decisions: ConflictDecision[] | null;
  try {
    decisions = await conflicts.resolve(cid, explorer.cwd, [
      { name: incomingName, size: png.length, mtime: null, kind: "file" },
    ]);
  } catch (e) {
    explorer.error = e instanceof Error ? e.message : String(e);
    return;
  }
  const decision = decisions?.[0];
  if (!decisions || !decision || decision.action !== "proceed") return;
  const id = await transfers.startUpload(cid, tempPath, explorer.cwd, decision.finalName);
  const ok = await transfers.waitAllDone([id]);
  await explorer.reloadPreserve();
  if (ok) {
    explorer.selectedNames = new Set([decision.finalName]);
    showHint(`已粘贴图片 ${decision.finalName}`);
  } else {
    explorer.error = `图片粘贴失败 — ${decision.finalName}`;
  }
}

/** 跨连接粘贴（Ctrl+C 于连接 A → Ctrl+V 于连接 B）。cut = move（复制后删源，全部成功才清剪贴板） */
async function pasteCrossConnection(targetCid: string) {
  const c = clip.clip;
  if (!c || !c.names.length) return;
  try {
    const result = await crossConnectionTransfer(
      c.connectionId,
      c.sourceDir,
      c.names,
      c.mode === "cut" ? "move" : "copy",
      targetCid,
      explorer.cwd,
    );
    if (result.skippedFolders > 0) {
      showHint(`跨连接粘贴暂不支持文件夹（已跳过 ${result.skippedFolders} 项）`);
    }
    if (c.mode === "cut" && !result.failed.length) {
      clip.clear();
    }
    await explorer.reloadPreserve();
    if (result.failed.length) {
      explorer.error = `跨连接${c.mode === "cut" ? "移动" : "复制"}未全部完成 — ${result.failed.join("；")}`;
    } else {
      showHint(`已跨连接${c.mode === "cut" ? "移动" : "复制"} ${result.done} 项`);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (message !== "cancelled") explorer.error = message;
  }
}

/** 远端粘贴：内部剪贴板语义（源 = 剪贴板记录）→ 冲突解析与执行走 remoteMoveCopy 共用管线 */
async function pasteRemote(cid: string, pasteIntoSelection: boolean) {
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

  try {
    const result = await remoteMoveCopy(cid, c.sourceDir, c.names, targetDir, c.mode === "cut" ? "move" : "copy");
    clip.clear();
    if (targetDir === explorer.cwd || c.sourceDir === explorer.cwd) {
      await explorer.reloadPreserve();
    }
    if (result.cancelled) {
      // cancelRemoteOp 已把卡片置为已取消
    } else if (result.failed.length) {
      explorer.error = `${c.mode === "cut" ? "移动" : "复制"}未全部完成 — ${result.failed.join("；")}`;
    } else {
      showHint(`已${c.mode === "cut" ? "移动" : "复制"} ${result.done} 项`);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (message !== "cancelled") explorer.error = message;
  }
}

/** —— 行内拖拽落点（M7 步骤 4）：文件区空白 / 文件夹行 / 面包屑分段 → 移动/复制；
 *  跨连接文件自动走「暂存下载→上传」管线（文件夹跳过并提示） —— */
async function onFilesDropped(payload: FilesDragPayload, targetDir: string, ctrlKey: boolean) {
  const mode = resolveDropMode(ctrlKey);
  if (isCrossConnection(payload, connectionId.value)) {
    try {
      const result = await crossConnectionTransfer(
        payload.connectionId,
        payload.dir,
        payload.names,
        mode,
        connectionId.value,
        targetDir,
      );
      if (result.skippedFolders > 0) {
        showHint(`跨连接拖拽暂不支持文件夹（已跳过 ${result.skippedFolders} 项）`);
      }
      if (result.failed.length) {
        explorer.error = `跨连接${mode === "move" ? "移动" : "复制"}未全部完成 — ${result.failed.join("；")}`;
      } else {
        showHint(`已跨连接${mode === "move" ? "移动" : "复制"} ${result.done} 项`);
      }
      if (targetDir === explorer.cwd) await explorer.reloadPreserve();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (message !== "cancelled") explorer.error = message;
    }
    return;
  }
  if (isSameDir(payload, targetDir)) {
    showHint("源目录与目标目录相同");
    return;
  }
  try {
    const result = await remoteMoveCopy(
      connectionId.value,
      payload.dir,
      payload.names,
      targetDir,
      mode,
    );
    if (result.cancelled) return;
    if (result.failed.length) {
      explorer.error = `${mode === "move" ? "移动" : "复制"}未全部完成 — ${result.failed.join("；")}`;
    } else {
      showHint(`已${mode === "move" ? "移动" : "复制"} ${result.done} 项`);
    }
    // 目标目录是当前目录（或源目录是当前目录）→ 刷新
    if (targetDir === explorer.cwd || payload.dir === explorer.cwd) {
      await explorer.reloadPreserve();
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (message !== "cancelled") explorer.error = message;
  }
}

/** Files 快速跳转 → 按 profile 固定的侧栏收藏（PinFolderToSidebarAction 语义） */
const pinnedStore = usePinnedStore();

/** 侧栏项右键菜单（打开/取消固定）——侧栏在 Workspace，菜单逻辑经 provide 由父组件处理 */
/** A2 后退按钮右键：历史飞出（Files BackHistoryFlyout，仅 Back 有；最近在上，点击直达） */
const backHistoryMenu = ref<{ open: boolean; x: number; y: number }>({
  open: false,
  x: 0,
  y: 0,
});

function onBackContextMenu(e: MouseEvent) {
  if (!explorer.backHistory.length) return;
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  backHistoryMenu.value = { open: true, x: rect.left, y: rect.bottom + 2 };
}

const backHistoryItems = computed<MenuItem[]>(() =>
  explorer.backHistory.map((h) => ({
    key: String(h.index),
    label: h.path,
    icon: History,
  })),
);

function onBackHistorySelect(key: string) {
  backHistoryMenu.value.open = false;
  explorer.navigateToHistory(Number(key));
}

/** 「下载到…」多选放开：右键项在多选集合内且集合全为文件时逐文件下载（文件夹仍置灰） */
function downloadTargets(entry: FileEntry): FileEntry[] {
  if (explorer.isSelected(entry.name) && explorer.selectedNames.size > 1) {
    const files = [...explorer.selectedNames]
      .map((n) => explorer.entryByName(n))
      .filter((e): e is FileEntry => !!e);
    if (files.every((e) => e.kind === "file")) return files;
  }
  return entry.kind === "file" ? [entry] : [];
}

async function downloadEntries(files: FileEntry[]) {
  if (!files.length) return;
  if (files.length === 1) {
    const target = await save({ defaultPath: files[0].name });
    if (!target) return;
    const cid = connectionId.value;
    if (cid) {
      const id = await transfers.startDownloadTo(cid, joinPath(explorer.cwd, files[0].name), target);
      // C2：单文件下载完成 toast +「打开所在文件夹」（tauri-plugin-opener reveal）
      if (await transfers.waitAllDone([id])) {
        toastStore.show(`已下载 ${files[0].name}`, {
          label: "打开所在文件夹",
          run: () => void revealItemInDir(target).catch(() => {}),
        });
      }
    }
    return;
  }
  // 多选：弹文件夹选择器，逐文件独立下载任务
  const dir = await openDialog({ directory: true, multiple: false });
  if (typeof dir !== "string") return;
  const cid = connectionId.value;
  if (!cid) return;
  for (const f of files) {
    await transfers.startDownload(cid, joinPath(explorer.cwd, f.name), joinPath(dir, f.name));
  }
}

/** —— 压缩/解压（第五阶段块 C）：能力探测（C1）+ 菜单项 + 创建/解压编排 —— */

// 连接建立后惰性探测一次服务器压缩工具（缓存于 archives store）
watch(
  connectionId,
  (cid) => {
    if (cid) void archivesStore.ensureProbe(cid);
  },
  { immediate: true },
);

/** 压缩菜单可用性：tar 或 zip 任一存在（C6：全缺才置灰 + tooltip） */
const canCompress = computed(
  () =>
    archivesStore.has(connectionId.value, "tar") ||
    archivesStore.has(connectionId.value, "zip"),
);

/** 档案解压工具就绪（tar 家族→tar / zip→unzip / gz→gzip） */
function extractReady(name: string): { ok: boolean; tool: string } {
  const family = archiveFamilyOf(name);
  if (!family) return { ok: false, tool: "" };
  const tool = requiredToolFor(family);
  return { ok: archivesStore.has(connectionId.value, tool), tool };
}

/** 「压缩为…」对话框状态（打开时按选择预填默认名） */
const archiveDialog = ref<{ names: string[]; defaultName: string } | null>(null);

function openArchiveDialog(entry: FileEntry | null) {
  const names = resolveTargetNames(entry);
  if (!names?.length || !canCompress.value) return;
  const first = names.length === 1 ? (explorer.entryByName(names[0])?.name ?? null) : null;
  archiveDialog.value = {
    names,
    defaultName: defaultArchiveName(first, archivesStore.has(connectionId.value, "tar") ? "tar.gz" : "zip"),
  };
}

async function onArchiveSubmit({ format, name }: { format: "tar.gz" | "zip"; name: string }) {
  const dialog = archiveDialog.value;
  archiveDialog.value = null;
  const cid = connectionId.value;
  if (!dialog || !cid) return;
  await compressSelection(explorer, cid, dialog.names, format, name);
}

/** 解压入口（菜单/Ctrl+Shift+E smart） */
async function runExtract(entry: FileEntry, mode: "here" | "subdir" | "smart") {
  const cid = connectionId.value;
  if (!cid) return;
  await extractArchive(explorer, cid, entry, mode, {
    has: (tool) => archivesStore.has(cid, tool),
  });
}

/** —— 复制 scp 命令（第五阶段块 D1）：scp -P <port> "user@host:path" . —— */
async function copyScpCommand(entry: FileEntry | null) {
  const connSnap = conn.value;
  if (!connSnap) return;
  const names = resolveTargetNames(entry);
  if (!names?.length) return;
  const paths = names.map((n) => joinPath(explorer.cwd, n));
  await copyText(
    buildScpCommand({ host: connSnap.profile.host, port: connSnap.profile.port, username: connSnap.profile.username }, paths),
  );
  showHint(`已复制 ${paths.length} 项的 scp 命令`);
}

/** 文件区滚动容器：进入新目录回顶部；原地刷新（文件操作后）保持滚动 */
const fileAreaRef = ref<HTMLElement | null>(null);
/** 标签标题 = 当前目录名（挂载即同步一次——导航可能早于组件挂载完成，watch 会错过） */
function syncTabTitle() {
  const tab = workspace.tabs.find((t) => t.id === props.tabId);
  if (tab) tab.title = pathBaseName(explorer.cwd) || explorer.cwd;
}
watch(
  () => explorer.cwd,
  () => {
    syncTabTitle();
    void nextTick(() => {
      if (fileAreaRef.value) fileAreaRef.value.scrollTop = 0;
    });
  },
);

/** 搜索横幅中的目录名（根目录显示 /） */
const searchDirName = computed(() => {
  const dir = explorer.searchSession?.dir ?? "";
  return dir === "/" ? "/" : pathBaseName(dir) || dir;
});

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
 *  删除确认策略（Files DeleteConfirmationPolicies）：never 直接执行；
 *  always 恒弹；permanentOnly 仅永久删除时弹——远端删除皆为永久删除，行为同 always。 */
function requestDelete(entry: FileEntry | null) {
  if (collectDeleteTargets(entry)) {
    if (settings.settings.deleteConfirmation !== "never") return; // 弹确认框
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

/** 搜索结果行的完整远端路径（搜索根 + relPath） */
function searchHitFullPath(entry: FileEntry): string {
  const session = explorer.searchSession;
  const rel = (entry as { relPath?: string }).relPath ?? entry.name;
  return session ? joinPath(session.dir, rel) : joinPath(explorer.cwd, entry.name);
}

/** 在新标签页中打开目录（本窗格标签的连接；Files 文件夹右键 Open in new tab） */
function openTabAt(path: string) {
  const tab = workspace.tabs.find((t) => t.id === props.tabId);
  if (!tab) return;
  const newTab = workspace.openTab(tab.connectionId, tab.profileId, tab.alias);
  workspace.initPane(newTab.activePaneId, tab.connectionId, path, tab.profileId, path);
}

const ctxMenuItems = computed<MenuItem[]>(() => {
  const entry = ctxMenu.value.entry;
  // 递归搜索结果视图：操作依赖完整路径而非当前目录条目，仅保留三项
  if (explorer.searchSession) {
    const items: MenuItem[] = [];
    if (entry?.kind === "dir") {
      items.push({ key: "open", label: "打开", icon: FolderOpen });
      items.push({ key: "sepS1", label: "", separator: true });
    }
    items.push(
      { key: "copyPath", label: "复制路径", icon: ClipboardCopy },
      { key: "copyScp", label: "复制 scp 命令", icon: SquareTerminal },
      {
        key: "download",
        label: "下载到…",
        icon: Download,
        disabled: !entry || entry.kind !== "file",
      },
    );
    return items;
  }
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
    items.push({ key: "openInNewTab", label: "在新标签页中打开", icon: FolderOpen });
    // 固定到侧栏（PinFolderToSidebarAction；已固定显示取消固定）
    const folderPath = joinPath(explorer.cwd, entry.name);
    const pid = profileId.value;
    const pinned = pid ? pinnedStore.isPinned(pid, folderPath) : false;
    items.push({
      key: "pin",
      label: pinned ? "取消固定" : "固定到侧栏",
      icon: pinned ? PinOff : Pin,
    });
    items.push({ key: "sep", label: "", separator: true });
    // 递归下载（第四阶段块 A：清单编排 → 冲突 → 聚合卡）
    items.push({ key: "downloadFolder", label: "下载文件夹…", icon: FolderDown });
  }
  items.push(
    { key: "cut", label: "剪切", icon: Scissors },
    { key: "copy", label: "复制", icon: Copy },
    { key: "copyName", label: "复制名称", icon: TextSelect },
    { key: "copyPath", label: "复制路径", icon: ClipboardCopy },
    { key: "copyScp", label: "复制 scp 命令", icon: SquareTerminal },
    {
      key: "download",
      label: "下载到…",
      icon: Download,
      // 单文件直接下；多选集合全为文件时放开逐个下载，含文件夹/链接仍置灰（未递归）
      disabled: downloadTargets(entry).length === 0,
    },
  );
  // 压缩为…（C2）：tar/zip 全缺置灰 + tooltip（C6）
  items.push({
    key: "compress",
    label: "压缩为…",
    icon: FileArchive,
    disabled: !canCompress.value,
    title: canCompress.value ? undefined : "服务器缺少 tar/zip 命令，无法压缩",
  });
  // 解压（C3）：仅支持的档案格式出现菜单项；工具缺失置灰 + tooltip（C6）
  const family = archiveFamilyOf(entry.name);
  if (family) {
    const ready = extractReady(entry.name);
    const title = ready.ok ? undefined : `服务器缺少 ${ready.tool} 命令`;
    items.push(
      {
        key: "extractHere",
        label: "解压到当前目录",
        icon: FolderInput,
        disabled: !ready.ok,
        title,
      },
      {
        key: "extractSubdir",
        label: `解压到 “${archiveBaseName(entry.name)}”`,
        icon: FolderPlus,
        disabled: !ready.ok,
        title,
      },
    );
  }
  items.push(
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
  // 递归搜索结果分支：按完整路径操作
  if (explorer.searchSession) {
    if (!entry) return;
    if (key === "open") {
      explorer.enterSearchEntry((entry as { relPath?: string }).relPath ?? entry.name);
    } else if (key === "copyPath") {
      await copyText(searchHitFullPath(entry));
    } else if (key === "copyScp") {
      const connSnap = conn.value;
      if (connSnap) {
        await copyText(
          buildScpCommand(
            {
              host: connSnap.profile.host,
              port: connSnap.profile.port,
              username: connSnap.profile.username,
            },
            [searchHitFullPath(entry)],
          ),
        );
        showHint("已复制 scp 命令");
      }
    } else if (key === "download") {
      if (entry.kind !== "file") return;
      const target = await save({ defaultPath: entry.name });
      if (!target) return;
      const cid = connectionId.value;
      if (cid) {
        await transfers.startDownload(cid, searchHitFullPath(entry), target);
      }
    }
    return;
  }
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
    case "openInNewTab":
      openTabAt(joinPath(explorer.cwd, entry.name));
      break;
    case "pin": {
      const pid = profileId.value;
      if (!pid) break;
      const folderPath = joinPath(explorer.cwd, entry.name);
      if (pinnedStore.isPinned(pid, folderPath)) {
        pinnedStore.unpin(pid, folderPath);
      } else {
        pinnedStore.pin(pid, { name: entry.name, path: folderPath });
      }
      break;
    }
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
    case "copyScp":
      await copyScpCommand(entry);
      break;
    case "compress":
      openArchiveDialog(entry);
      break;
    case "extractHere":
      void runExtract(entry, "here");
      break;
    case "extractSubdir":
      void runExtract(entry, "subdir");
      break;
    case "downloadFolder": {
      if (connectionId.value) {
        void downloadFolderTo(connectionId.value, joinPath(explorer.cwd, entry.name));
      }
      break;
    }
    case "download": {
      // 置灰态双保险（多选含文件夹/链接时不下载）
      const files = downloadTargets(entry);
      if (!files.length) break;
      await downloadEntries(files);
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

onMounted(() => {
  // 窗格初始加载（重开/复制标签由调用方先行 reset，此处兜底空实例）
  if (!explorer.connectionId && connectionId.value) {
    void explorer.reset(connectionId.value, conn.value?.rootPath ?? "/", profileId.value);
  }
  syncTabTitle();
  window.addEventListener("keydown", onKeydown);
  // G4 鼠标侧键（捕获阶段）：仅活动窗格响应
  window.addEventListener("pointerdown", onMouseSideButton, true);
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
  window.removeEventListener("pointerdown", onMouseSideButton, true);
  clearTimeout(hintTimer);
});

/** G4 鼠标侧键：XButton1（button 3）后退、XButton2（button 4）前进 */
function onMouseSideButton(e: PointerEvent) {
  if (!isActivePane()) return;
  if (e.button !== 3 && e.button !== 4) return;
  e.preventDefault();
  if (e.button === 3) explorer.back();
  else explorer.forward();
}

/** —— 输入即定位（第五阶段块 D2，Explorer 惯例；Files 无此功能）：
 *  300ms 内连续输入拼接为前缀，匹配首个可见行（单选 + scrollIntoView）；
 *  超时重置。输入框聚焦与编辑器/终端浮层让位由 onKeydown 前置分支完成 —— */
let typeBuffer = "";
let typeTimer: ReturnType<typeof setTimeout> | undefined;

function handleTypeAhead(e: KeyboardEvent) {
  if (e.isComposing || e.key === " ") return;
  typeBuffer = (typeBuffer + e.key).toLowerCase();
  clearTimeout(typeTimer);
  typeTimer = setTimeout(() => (typeBuffer = ""), 300);
  const hit = explorer.visibleEntries.find((entry) =>
    explorer.rowKeyOf(entry).toLowerCase().startsWith(typeBuffer),
  );
  if (!hit) return;
  const key = explorer.rowKeyOf(hit);
  explorer.selectOnly(key);
  void nextTick(() => {
    document
      .querySelector(`[data-row="${CSS.escape(key)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  });
}

/** F2 重命名、Delete 删除选中项、Ctrl+C/X/V 剪贴板；Alt+Enter 属性；
 *  Alt+↑ 上一级 / Alt+← 后退 / Alt+→ 前进；
 *  F5·Ctrl+R 刷新 / Backspace 上一级 / Ctrl+A 全选 / Ctrl+I 反选 /
 *  Ctrl+Shift+C 复制路径 / Ctrl+Shift+N 新建文件夹 */
function onKeydown(e: KeyboardEvent) {
  if (!isActivePane()) return;
  // 就地编辑/表单输入时快捷键让位
  if (
    e.target instanceof HTMLInputElement ||
    e.target instanceof HTMLTextAreaElement
  ) {
    return;
  }
  // 悬浮窗（编辑器/终端）打开时让位
  if (editor.open || terminalStore.open) return;
  // D2 输入即定位：可打印字符（无修饰键）前缀匹配首行
  if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
    handleTypeAhead(e);
    return;
  }
  if (e.ctrlKey && (e.key === "c" || e.key === "C")) {
    // Ctrl+Shift+C：复制选中项路径（Files CopyItemPathAction：多选换行连接，无选中复制当前目录）
    if (e.shiftKey) {
      e.preventDefault();
      const paths = [...explorer.selectedNames].map((n) =>
        joinPath(explorer.cwd, n),
      );
      void copyText(paths.length ? paths.join("\n") : explorer.cwd);
      return;
    }
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
  if (e.ctrlKey && e.shiftKey && !e.altKey && (e.key === "e" || e.key === "E")) {
    // Ctrl+Shift+E smart 解压（Files DecompressArchiveHereSmartAction 热键）：单选档案生效
    e.preventDefault();
    if (explorer.selectedNames.size === 1) {
      const entry = explorer.entryByName([...explorer.selectedNames][0]);
      if (entry && archiveFamilyOf(entry.name)) void runExtract(entry, "smart");
    }
    return;
  }
  if (e.ctrlKey && (e.key === "r" || e.key === "R")) {
    e.preventDefault();
    explorer.refresh();
    return;
  }
  if (e.ctrlKey && (e.key === "a" || e.key === "A")) {
    e.preventDefault();
    explorer.selectAll();
    return;
  }
  if (e.ctrlKey && (e.key === "i" || e.key === "I")) {
    e.preventDefault();
    explorer.invertSelection();
    return;
  }
  if (e.ctrlKey && e.shiftKey && (e.key === "n" || e.key === "N")) {
    e.preventDefault();
    explorer.startCreate("dir");
    return;
  }
  if (e.key === "F5") {
    e.preventDefault();
    explorer.refresh();
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
  if (e.key === "Backspace" && !e.ctrlKey && !e.altKey && !e.metaKey) {
    e.preventDefault();
    explorer.up();
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
  <div
    class="flex min-h-0 min-w-0 flex-1 flex-col gap-1"
    @pointerdown="activatePane"
    @contextmenu="activatePane"
  >
    <!-- 地址行卡（Win11：后退/前进/刷新在地址栏左侧）；#actions 插槽承载搜索框与全局按钮。
        单栏时本卡承接上方选中标签的熔接：顶边透明，可视线由主列熔接顶线绘制（带标签缺口） -->
    <div
      class="flex h-12 shrink-0 items-center gap-1 rounded-lg px-1"
      :style="{
        background: 'var(--toolbar)',
        border: '1px solid var(--line)',
        borderTopColor: isDualPane ? 'var(--line)' : 'transparent',
      }"
    >
      <button
        type="button"
        class="btn-icon"
        :disabled="!explorer.canBack || explorer.loading"
        title="后退（Alt+←，右键查看历史）"
        aria-label="后退"
        @click="explorer.back()"
        @contextmenu.prevent="onBackContextMenu"
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
        :disabled="explorer.cwd === '/' || explorer.loading"
        title="上一级（Alt+↑）"
        aria-label="上一级"
        @click="explorer.up()"
      >
        <ArrowUp :size="16" />
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

      <!-- 面包屑（搜索框经 #actions 注入，位置在其右侧与现状一致；分段可作拖拽落点） -->
      <div class="mx-1.5 flex min-w-0 flex-1 items-center gap-1.5">
        <div class="min-w-0 flex-1 overflow-hidden">
          <Breadcrumbs :pane-id="paneId" @drop-files="onFilesDropped" />
        </div>
      </div>

      <!-- 全局工具（搜索框/终端/传输/分屏）：父组件注入，单栏时嵌本行、双栏时为空 -->
      <slot name="actions" />

      <!-- 窗格关闭按钮（仅双栏时显示，Files CloseActivePane） -->
      <button
        v-if="isDualPane"
        type="button"
        class="btn-icon"
        title="关闭此窗格"
        aria-label="关闭此窗格"
        @click="workspace.closePane(paneId)"
      >
        <X :size="15" />
      </button>
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
        <!-- 递归搜索横幅：进行中（停止）/ 完成（关闭）；达封顶提示 -->
        <div
          v-if="explorer.searchSession"
          class="m-2 flex items-center gap-2.5 rounded-lg px-3.5 py-2.5"
          :style="{ background: 'color-mix(in srgb, var(--accent) 8%, transparent)' }"
        >
          <FolderSearch :size="15" class="shrink-0 text-accent" />
          <span class="min-w-0 flex-1 truncate text-xs text-dim">
            <template v-if="explorer.searchSession.running">
              正在「{{ searchDirName }}」中搜索「{{ explorer.searchSession.query }}」 —— 已找到
              {{ explorer.searchSession.hits.length }} 项
            </template>
            <template v-else>
              {{ explorer.searchSession.cancelled ? "已停止 — " : "" }}在「{{ searchDirName }}」中搜索「{{
                explorer.searchSession.query
              }}」 —— 共 {{ explorer.searchSession.hits.length }} 项
            </template>
            <span v-if="explorer.searchSession.capped" class="text-accent">
              （已达 {{ 2000 }} 条上限，仅显示部分结果）
            </span>
          </span>
          <button
            v-if="explorer.searchSession.running"
            type="button"
            class="btn-secondary h-7 px-2 text-xs"
            @click="explorer.stopSearch()"
          >
            <StopCircle :size="13" class="mr-1 inline" />停止
          </button>
          <button
            v-else
            type="button"
            class="btn-icon h-6 w-6 shrink-0"
            title="关闭搜索结果"
            aria-label="关闭搜索结果"
            @click="explorer.exitSearch(true)"
          >
            <X :size="13" />
          </button>
        </div>
        <FileTable
          :pane-id="paneId"
          @context-menu="onFileContextMenu"
          @open-file="onOpenFile"
          @drop-files="(payload, dir, ctrl) => onFilesDropped(payload, dir, ctrl)"
        />
      </div>
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

    <!-- 后退历史飞出（Files BackHistoryFlyout：仅 Back 有，最近在上，点击直达） -->
    <ContextMenu
      :open="backHistoryMenu.open"
      :x="backHistoryMenu.x"
      :y="backHistoryMenu.y"
      :items="backHistoryItems"
      @select="onBackHistorySelect"
      @close="backHistoryMenu.open = false"
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

    <!-- 压缩为…（C2：格式 + 文件名，服务器侧 exec 创建） -->
    <ArchiveDialog
      :open="!!archiveDialog"
      :default-name="archiveDialog?.defaultName ?? ''"
      :tar-available="archivesStore.has(connectionId, 'tar')"
      :zip-available="archivesStore.has(connectionId, 'zip')"
      @close="archiveDialog = null"
      @submit="onArchiveSubmit"
    />

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
