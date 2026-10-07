<script setup lang="ts">
import type { UnlistenFn } from "@tauri-apps/api/event";
import { open as openDialog, save } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ClipboardCopy,
  ClipboardPaste,
  Copy,
  Download,
  Eye,
  FilePlus,
  Folder,
  FolderOpen,
  FolderPlus,
  FolderSearch,
  FolderTree,
  HardDrive,
  History,
  House,
  Info,
  Lock,
  Pencil,
  Pin,
  PinOff,
  RefreshCw,
  Scissors,
  ScrollText,
  Search,
  Settings,
  SquareTerminal,
  StopCircle,
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
import { usePinnedStore } from "@/stores/pinned";
import { useSettingsStore } from "@/stores/settings";
import { useTerminalStore } from "@/stores/terminal";
import { useTransferStore } from "@/stores/transfer";
import type { FileEntry } from "@/types";
import { copyText, formatSize, joinPath, pathBaseName } from "@/utils/format";
import {
  copyVirtualFiles,
  readClipboardFiles,
} from "@/api/clipboard";
import {
  execSsh,
  fsInfo,
  listDir,
  renameSsh,
  type ExecOutput,
  type FsInfo,
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

/** —— 地址栏搜索：面包屑收缩 + 搜索框展开（即时过滤当前目录；
 *  Enter / 下拉提示项进入递归结果模式） —— */
const searchOpen = ref(false);
/** 搜索框聚焦态（下拉提示/历史仅聚焦时展示） */
const searchFocused = ref(false);

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
  explorer.exitSearch(true);
}

/** 搜索框 Enter：非空词进入递归搜索（当前目录为根） */
function onSearchEnter() {
  if (explorer.searchQuery.trim()) {
    explorer.startRecursiveSearch(explorer.searchQuery);
  }
}

/** 搜索框 Esc：结果模式先退出回原目录，否则收起搜索框 */
function onSearchEsc() {
  if (explorer.searchSession) {
    explorer.exitSearch(true);
  } else {
    closeSearch();
  }
}

/** 下拉提示项点击（mousedown.prevent 保住输入框焦点） */
function onSuggestionSearch(query: string) {
  explorer.searchQuery = query;
  explorer.startRecursiveSearch(query);
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

/** Files 快速跳转 → 按 profile 固定的侧栏收藏（PinFolderToSidebarAction 语义） */
const pinnedStore = usePinnedStore();

/** 收藏图标键 → lucide 组件（新固定的默认 Folder） */
const PIN_ICONS = {
  hardDrive: HardDrive,
  house: House,
  folderTree: FolderTree,
  scrollText: ScrollText,
  folder: Folder,
} as const;

const pinnedFolders = computed(() =>
  pinnedStore.pinsFor(connections.active?.profile.id ?? ""),
);

/** 侧栏项右键菜单（打开/取消固定） */
const pinMenu = ref<{ open: boolean; x: number; y: number; path: string } | null>(null);

function onPinContextMenu(folder: { path: string }, e: MouseEvent) {
  pinMenu.value = { open: true, x: e.clientX, y: e.clientY, path: folder.path };
}

const pinMenuItems = computed<MenuItem[]>(() => [
  { key: "open", label: "打开", icon: FolderOpen },
  { key: "sepP", label: "", separator: true },
  { key: "unpin", label: "取消固定", icon: PinOff },
]);

function onPinMenuSelect(key: string) {
  const menu = pinMenu.value;
  pinMenu.value = null;
  if (!menu) return;
  const profileId = connections.active?.profile.id;
  if (key === "open") explorer.open(menu.path);
  else if (key === "unpin" && profileId) pinnedStore.unpin(profileId, menu.path);
}

/** —— A2 后退按钮右键：历史飞出（Files BackHistoryFlyout，仅 Back 有；最近在上，点击直达） —— */
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

/** —— A6 「下载到…」多选放开：右键项在多选集合内且集合全为文件时逐文件下载（文件夹仍置灰） —— */
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
    const connectionId = connections.active?.connectionId;
    if (connectionId) {
      await transfers.startDownload(
        connectionId,
        joinPath(explorer.cwd, files[0].name),
        target,
      );
    }
    return;
  }
  // 多选：弹文件夹选择器，逐文件独立下载任务
  const dir = await openDialog({ directory: true, multiple: false });
  if (typeof dir !== "string") return;
  const connectionId = connections.active?.connectionId;
  if (!connectionId) return;
  for (const f of files) {
    await transfers.startDownload(
      connectionId,
      joinPath(explorer.cwd, f.name),
      joinPath(dir, f.name),
    );
  }
}

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


/** A5 状态栏已选累计大小：仅文件计入（文件夹不计），遵循 sizeUnit 设置（StatusBar.xaml ItemSize） */
const selectedSizeLabel = computed(() => {
  let bytes = 0;
  let hasFile = false;
  for (const name of explorer.selectedNames) {
    const entry = explorer.entryByName(name);
    if (entry?.kind === "file") {
      hasFile = true;
      bytes += entry.size;
    }
  }
  return hasFile ? formatSize(bytes) : "";
});

/** 搜索横幅中的目录名（根目录显示 /） */
const searchDirName = computed(() => {
  const dir = explorer.searchSession?.dir ?? "";
  return dir === "/" ? "/" : (pathBaseName(dir) || dir);
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
  () => [connections.active?.connectionId, explorer.cwd] as const,
  ([cid, dir]) => {
    if (!cid) {
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
    // 固定到侧栏（PinFolderToSidebarAction；已固定显示取消固定）
    const folderPath = joinPath(explorer.cwd, entry.name);
    const profileId = connections.active?.profile.id;
    const pinned = profileId ? pinnedStore.isPinned(profileId, folderPath) : false;
    items.push({
      key: "pin",
      label: pinned ? "取消固定" : "固定到侧栏",
      icon: pinned ? PinOff : Pin,
    });
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
      // 单文件直接下；多选集合全为文件时放开逐个下载，含文件夹/链接仍置灰（未递归）
      disabled: downloadTargets(entry).length === 0,
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
  // 递归搜索结果分支：按完整路径操作
  if (explorer.searchSession) {
    if (!entry) return;
    if (key === "open") {
      explorer.enterSearchEntry((entry as { relPath?: string }).relPath ?? entry.name);
    } else if (key === "copyPath") {
      await copyText(searchHitFullPath(entry));
    } else if (key === "download") {
      if (entry.kind !== "file") return;
      const target = await save({ defaultPath: entry.name });
      if (!target) return;
      const connectionId = connections.active?.connectionId;
      if (connectionId) {
        await transfers.startDownload(connectionId, searchHitFullPath(entry), target);
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
    case "pin": {
      const profileId = connections.active?.profile.id;
      if (!profileId) break;
      const folderPath = joinPath(explorer.cwd, entry.name);
      if (pinnedStore.isPinned(profileId, folderPath)) {
        pinnedStore.unpin(profileId, folderPath);
      } else {
        pinnedStore.pin(profileId, { name: entry.name, path: folderPath });
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

onMounted(async () => {
  if (connections.active) {
    explorer.reset(
      connections.active.connectionId,
      connections.active.rootPath,
      connections.active.profile.id,
    );
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
 *  Alt+↑ 上一级 / Alt+← 后退 / Alt+→ 前进；
 *  F5·Ctrl+R 刷新 / Backspace 上一级 / Ctrl+A 全选 / Ctrl+I 反选 /
 *  Ctrl+Shift+C 复制路径 / Ctrl+Shift+N 新建文件夹 */
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
            v-for="link in pinnedFolders"
            :key="link.path"
            type="button"
            class="nav-item"
            :class="explorer.cwd === link.path && 'active'"
            :title="link.path"
            @click="explorer.open(link.path)"
            @contextmenu.prevent="onPinContextMenu(link, $event)"
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

        <!-- 面包屑 ⇄ 搜索框：面包屑左对齐固定、从右缘被裁剪让位；搜索框自身宽度动画
             （flex 末项右缘固定、左缘向左扫出，四条边框全程绘制，内容定宽防回流） -->
        <div class="mx-1.5 flex min-w-0 flex-1 items-center gap-1.5">
          <div class="min-w-0 flex-1 overflow-hidden">
            <Breadcrumbs />
          </div>

          <div
            class="flex h-[34px] shrink-0 items-center overflow-visible rounded-[4px]"
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
            <div class="relative flex h-full w-[228px] shrink-0 items-center gap-1.5">
              <Search :size="14" class="shrink-0 text-dim" />
              <input
                v-model="explorer.searchQuery"
                class="h-full min-w-0 flex-1 bg-transparent text-sm text-ink outline-none"
                placeholder="搜索当前目录"
                aria-label="搜索当前目录"
                @focus="searchFocused = true"
                @blur="searchFocused = false"
                @keydown.enter.prevent="onSearchEnter"
                @keydown.esc.stop="onSearchEsc"
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

              <!-- 下拉提示：输入非空 → 「在子目录中搜索」；聚焦且为空 → 搜索历史（点击即执行） -->
              <Transition name="popup">
                <div
                  v-if="searchOpen && searchFocused && (explorer.searchQuery.trim() || (!explorer.searchQuery && explorer.searchHistory.length))"
                  class="absolute top-[38px] right-0 z-50 min-w-full overflow-hidden rounded-lg shadow-xl"
                  :style="{ background: 'var(--surface-solid)', border: '1px solid var(--stroke-flyout)' }"
                >
                  <template v-if="explorer.searchQuery.trim()">
                    <button
                      type="button"
                      class="flex h-8 w-full items-center gap-2.5 px-3 text-left text-sm whitespace-nowrap transition-colors hover:bg-fill-subtle"
                      @mousedown.prevent="onSuggestionSearch(explorer.searchQuery.trim())"
                    >
                      <FolderSearch :size="14" class="shrink-0 text-dim" />
                      在子目录中搜索「{{ explorer.searchQuery.trim() }}」
                    </button>
                  </template>
                  <template v-else>
                    <button
                      v-for="q in explorer.searchHistory"
                      :key="q"
                      type="button"
                      class="flex h-8 w-full items-center gap-2.5 px-3 text-left text-sm whitespace-nowrap transition-colors hover:bg-fill-subtle"
                      @mousedown.prevent="onSuggestionSearch(q)"
                    >
                      <History :size="14" class="shrink-0 text-faint" />
                      {{ q }}
                    </button>
                  </template>
                </div>
              </Transition>
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
        <span v-if="explorer.selectedNames.size">
          · 已选择 {{ explorer.selectedNames.size }} 项
          <template v-if="selectedSizeLabel">· 共 {{ selectedSizeLabel }}</template>
        </span>
      </span>
      <span class="flex min-w-0 items-baseline gap-3">
        <!-- 磁盘容量条（DrivesWidget DriveSpaceProgressBar：120px 细条 + 已用/总量缩写，剩余<10% 转 danger） -->
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

    <!-- 后退历史飞出（Files BackHistoryFlyout：仅 Back 有，最近在上，点击直达） -->
    <ContextMenu
      :open="backHistoryMenu.open"
      :x="backHistoryMenu.x"
      :y="backHistoryMenu.y"
      :items="backHistoryItems"
      @select="onBackHistorySelect"
      @close="backHistoryMenu.open = false"
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
