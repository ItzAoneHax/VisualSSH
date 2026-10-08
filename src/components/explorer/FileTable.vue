<script setup lang="ts">
import { ChevronDown, ChevronUp, File, Folder, Link2, SearchX } from "@lucide/vue";
import { computed, nextTick, ref, watch } from "vue";

import ContextMenu from "@/components/common/ContextMenu.vue";
import type { MenuItem } from "@/components/common/DropdownMenu.vue";
import { useClipboardStore } from "@/stores/clipboard";
import {
  useExplorer,
  type SortKey,
  type SearchHitRow,
} from "@/stores/explorer";
import { useSettingsStore } from "@/stores/settings";
import type { FileEntry } from "@/types";
import { formatMtime, formatSize, joinPath, kindLabel } from "@/utils/format";
import {
  isThumbnailCandidate,
  thumbnailCache,
  THUMBNAIL_MAX,
} from "@/utils/preview";
import { registerThumb, thumbVersion, type ThumbRequest } from "@/utils/thumbs";
import {
  hasFilesPayload,
  readFilesPayload,
  resolveDragNames,
  resolveDropMode,
  writeFilesPayload,
  type FilesDragPayload,
} from "@/utils/dragDrop";

const props = defineProps<{ paneId: string }>();

// 窗格实例（paneId 与组件实例一一对应；非活动标签不渲染 DOM、状态留在 store）
const explorer = useExplorer(props.paneId);
const settings = useSettingsStore();
const clip = useClipboardStore();

/** 列头文案与数据单元格对齐/字体（等宽字体只加在数据单元格上：表头是中文，等宽栈会回退成宋体） */
const COLUMN_META: Record<
  SortKey,
  { label: string; cellClass: string; headerClass: string }
> = {
  name: { label: "名称", cellClass: "", headerClass: "pl-3" },
  mtime: { label: "修改时间", cellClass: "text-xs text-dim", headerClass: "pl-2.5" },
  kind: { label: "类型", cellClass: "text-xs text-dim", headerClass: "pl-2.5" },
  size: {
    label: "大小",
    cellClass: "text-right text-xs text-dim",
    headerClass: "pl-2.5 pr-3 text-right",
  },
  permissions: {
    label: "权限",
    cellClass: "pl-2.5 font-mono text-xs text-dim",
    headerClass: "pl-2.5",
  },
  owner: { label: "所有者", cellClass: "pl-2.5 text-xs text-dim", headerClass: "pl-2.5" },
  group: { label: "组", cellClass: "pl-2.5 text-xs text-dim", headerClass: "pl-2.5" },
  path: { label: "位置", cellClass: "pl-2.5 text-xs text-dim", headerClass: "pl-2.5" },
};

/** 递归搜索结果视图（临时插入「位置」列，Files SortOption.Path 专用搜索结果页的作法） */
const inSearch = computed(() => !!explorer.searchSession);
const PATH_COL_WIDTH = 192; // 12rem

/** 可见列（名称恒在首；搜索模式在名称后插「位置」列）：名称 minmax(0,1fr) 弹性，其余列 px 宽 */
const visibleColumns = computed(() => {
  const cols = explorer.columns.filter((c) => c.visible || c.key === "name");
  if (!inSearch.value) return cols;
  const [name, ...rest] = cols;
  return [name, { key: "path" as SortKey, width: PATH_COL_WIDTH, visible: true }, ...rest];
});

/** 数据单元格列（名称列模板特殊处理，不进循环） */
const dataColumns = computed(() => visibleColumns.value.filter((c) => c.key !== "name"));

const gridTemplate = computed(() =>
  visibleColumns.value
    .map((c) => (c.key === "name" ? "minmax(0,1fr)" : `${c.width}px`))
    .join(" "),
);

const headerLabel = (key: SortKey) => COLUMN_META[key].label;
const headerClass = (key: SortKey) => COLUMN_META[key].headerClass;
const cellClass = (key: SortKey) => COLUMN_META[key].cellClass;

/** 数据单元格文本（名称列含图标/重命名，单独在模板里处理） */
function cellText(entry: FileEntry, key: SortKey): string {
  switch (key) {
    case "mtime":
      return formatMtime(entry.mtime);
    case "kind":
      return kindLabel(entry.kind);
    case "size":
      return entry.kind === "dir" ? "" : formatSize(entry.size);
    case "permissions":
      return entry.permissions;
    case "owner":
      return entry.owner ?? "";
    case "group":
      return entry.group ?? "";
    case "path":
      return (entry as SearchHitRow).relPath ?? "";
    default:
      return "";
  }
}

/** 行标识键：搜索结果按 relPath（不同目录可重名），主视图按名称 */
function rowKey(entry: FileEntry): string {
  return explorer.rowKeyOf(entry);
}

/** 列宽拖拽/双击命中区（列头右缘 4px；名称列恒弹性不提供） */
const MIN_COL_WIDTH = 48; // 3rem
const MAX_FIT_WIDTH = 384; // 24rem（双击自适应上限）

const resizing = ref<{ key: SortKey; startX: number; startWidth: number } | null>(null);

function onResizeHandleDown(key: SortKey, e: PointerEvent) {
  if (key === "name") return;
  e.preventDefault();
  e.stopPropagation();
  const col = explorer.columns.find((c) => c.key === key);
  if (!col) return;
  resizing.value = { key, startX: e.clientX, startWidth: col.width };
  const onMove = (ev: PointerEvent) => {
    const r = resizing.value;
    if (!r) return;
    const width = Math.max(MIN_COL_WIDTH, r.startWidth + ev.clientX - r.startX);
    explorer.setColumnWidth(key, width);
  };
  const onUp = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    resizing.value = null;
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

/** 双击分隔线自适应列宽（GridSplitter_DoubleTapped）：扫该列单元格 scrollWidth
 *  最大值 + padding + 排序图标余量 36（Files DetailsLayoutPage.xaml.cs:945-953），上限 24rem */
function onResizeHandleDblClick(key: SortKey) {
  if (key === "name") return;
  let max = 0;
  for (const el of document.querySelectorAll<HTMLElement>(`[data-col="${key}"]`)) {
    max = Math.max(max, el.scrollWidth);
  }
  if (max <= 0) return;
  const width = Math.min(Math.max(max + 36, MIN_COL_WIDTH), MAX_FIT_WIDTH);
  explorer.setColumnWidth(key, width);
}

/** —— 列头右键菜单：列显隐勾选（名称列不可隐藏；DetailsLayoutPage.xaml:277-411） —— */
const colMenu = ref<{ open: boolean; x: number; y: number }>({
  open: false,
  x: 0,
  y: 0,
});

function onHeaderContextMenu(e: MouseEvent) {
  colMenu.value = { open: true, x: e.clientX, y: e.clientY };
}

const colMenuItems = computed<MenuItem[]>(() =>
  explorer.columns
    .filter((c) => c.key !== "name")
    .map((c) => ({
      key: c.key,
      label: COLUMN_META[c.key].label,
      checked: c.visible,
    })),
);

function onColMenuSelect(key: string) {
  colMenu.value.open = false;
  explorer.toggleColumn(key as SortKey);
}

/** 显示扩展名关闭时，名称单元格展示层去扩展名（点开头文件视为无扩展名不裁剪）；重命名仍操作完整名 */
function displayName(entry: FileEntry): string {
  if (settings.settings.showFileExtensions) return entry.name;
  const dot = entry.name.lastIndexOf(".");
  return dot > 0 ? entry.name.slice(0, dot) : entry.name;
}

/** 返回上级后滚动定位选中的原目录行（ScrollToPreviousFolderWhenNavigatingUp） */
watch(
  () => explorer.selectAfterLoad,
  (name) => {
    if (!name) return;
    void nextTick(() => {
      const row = document.querySelector(`[data-row="${CSS.escape(name)}"]`);
      row?.scrollIntoView({ block: "nearest" });
      explorer.selectAfterLoad = null;
    });
  },
);

/** 剪切中的行变暗（Files DimItemOpacity 0.4，TransferHelpers.cs:125-132）；搜索结果视图不适用 */
function isCutRow(entry: FileEntry): boolean {
  if (inSearch.value) return false;
  return clip.isCut(explorer.connectionId, explorer.cwd, entry.name);
}

/** 单击打开（Files SingleClickToOpen）：无修饰键单击直接进入/打开。
 *  搜索结果视图：双击/单击目录 = 退出搜索并进入所在目录（文件不打开编辑器） */
function openEntry(entry: FileEntry) {
  if (inSearch.value) {
    if (entry.kind === "dir") explorer.enterSearchEntry((entry as SearchHitRow).relPath);
    return;
  }
  if (entry.kind === "dir") explorer.enter(entry.name);
  else emit("openFile", entry);
}

const emit = defineEmits<{
  contextMenu: [payload: { entry: FileEntry | null; x: number; y: number }];
  openFile: [entry: FileEntry];
  /** 行内拖拽落点（空白/文件夹行）：载荷 + 目标目录 + 是否按住 Ctrl（复制） */
  dropFiles: [payload: FilesDragPayload, targetDir: string, ctrlKey: boolean];
}>();

/** 就地编辑的实时值（重命名初值 = 原名，新建为空） */
const editValue = ref("");

watch(
  () => explorer.renamingName,
  (name) => {
    if (name !== null) editValue.value = name;
  },
);
watch(
  () => explorer.newDraft,
  (draft) => {
    if (draft !== null) editValue.value = "";
  },
);

/** 进入编辑态时聚焦，并选中文件名主体（Windows 语义：不含扩展名）。
 *  v-model 的 value 赋值发生在 ref 回调之后（会把光标推到末尾），
 *  因此选区推迟到下一帧再设置。 */
function focusEditInput(el: unknown, name: string) {
  if (!(el instanceof HTMLInputElement)) return;
  el.focus();
  requestAnimationFrame(() => {
    const dot = name.lastIndexOf(".");
    if (dot > 0) el.setSelectionRange(0, dot);
    else el.select();
  });
}

function commitRename(entry: FileEntry) {
  explorer.renameEntry(entry.name, editValue.value);
}

function commitDraft() {
  if (!explorer.newDraft) return;
  explorer.createEntry(explorer.newDraft, editValue.value);
}

function iconFor(entry: FileEntry) {
  switch (entry.kind) {
    case "dir":
      return Folder;
    case "symlink":
      return Link2;
    default:
      return File;
  }
}

function iconClass(entry: FileEntry): string {
  switch (entry.kind) {
    case "dir":
      return "text-folder";
    case "symlink":
      return "text-accent";
    default:
      return "text-dim";
  }
}

/** —— 表格缩略图（第五阶段块 B）：图片文件（≤2MB）在图标位渲染小缩略图，
 *  IntersectionObserver 视口内才拉取（utils/thumbs 调度：并发 4/空闲调度/滚动稳定），
 *  失败静默回退现有图标；搜索结果视图不参与（键为 relPath） —— */

/** 缩略图展示尺寸随行高密度档：紧凑 28 行用 18px，其余 20px（2px 圆角既有定稿） */
const thumbSize = computed(() =>
  settings.settings.detailsRowHeight <= 28 ? 18 : 20,
);

function thumbKeyOf(entry: FileEntry): string {
  return `${explorer.connectionId}:${joinPath(explorer.cwd, entry.name)}:${entry.mtime ?? 0}`;
}

function isThumbRow(entry: FileEntry): boolean {
  return (
    !inSearch.value &&
    !!explorer.connectionId &&
    settings.settings.showThumbnails &&
    isThumbnailCandidate(entry)
  );
}

/** 渲染期取缓存（void 版本号建立响应式依赖：任一缩略图完成即重算） */
function thumbSrc(entry: FileEntry): string | null {
  if (!isThumbRow(entry)) return null;
  void thumbVersion.value;
  return thumbnailCache.get(thumbKeyOf(entry));
}

function makeThumbRequest(entry: FileEntry): ThumbRequest {
  return {
    key: thumbKeyOf(entry),
    connectionId: explorer.connectionId,
    path: joinPath(explorer.cwd, entry.name),
    maxBytes: THUMBNAIL_MAX,
  };
}

/** 行 ref 工厂按 rowKey 缓存（稳定函数身份：重渲染不重挂 IntersectionObserver）；
 *  注册时以 explorer 里的当前条目构造请求（重载后 mtime 变化即换缓存键） */
const thumbRefs = new Map<string, (el: unknown) => (() => void) | undefined>();

function thumbRefFor(entry: FileEntry): (el: unknown) => (() => void) | undefined {
  const key = rowKey(entry);
  let fn = thumbRefs.get(key);
  if (!fn) {
    fn = (el: unknown) => {
      const target = explorer.entryByName(key) ?? entry;
      return registerThumb(el, makeThumbRequest(target));
    };
    thumbRefs.set(key, fn);
  }
  return fn;
}

// 目录切换后丢弃旧 ref 工厂（行全部重建，闭包里的 cwd/请求已过期）
watch(
  () => explorer.cwd,
  () => thumbRefs.clear(),
);

/** Windows 资源管理器语义：单击单选 / Ctrl+单击反选 / Shift+单击范围；
 *  开启「单击打开」后，无修饰键单击 = 打开 */
function onRowClick(entry: FileEntry, e: MouseEvent) {
  const key = rowKey(entry);
  if (e.ctrlKey) {
    explorer.toggleSelect(key);
  } else if (e.shiftKey) {
    explorer.selectRange(key);
  } else if (settings.settings.singleClickOpen) {
    openEntry(entry);
  } else {
    explorer.selectOnly(key);
  }
}

function onRowDblClick(entry: FileEntry) {
  // 单击打开模式下双击不重复触发（click 已打开，目录此时已切换）
  if (settings.settings.singleClickOpen) return;
  openEntry(entry);
}

/** 双击空白处转到上一级（Files DoubleClickBlankSpaceToGoUp） */
function onBlankDblClick(e: MouseEvent) {
  if (!settings.settings.dblClickBlankGoUp) return;
  if ((e.target as HTMLElement).closest("[data-row], button, input")) return;
  explorer.up();
}

/** 右键未选中项时先单选（资源管理器行为）；已选中则保持多选 */
function onRowContextMenu(entry: FileEntry, e: MouseEvent) {
  if (!explorer.isSelected(rowKey(entry))) explorer.selectOnly(rowKey(entry));
  emit("contextMenu", { entry, x: e.clientX, y: e.clientY });
}

function onBlankContextMenu(e: MouseEvent) {
  emit("contextMenu", { entry: null, x: e.clientX, y: e.clientY });
}

/** —— 行高密度（LayoutSizeKindHelper.GetDetailsViewRowHeight）：
 *  紧凑 28 / 小 36（默认）/ 中 40 / 大 44 / 特大 48；Ctrl+滚轮升降档
 *  （BaseLayoutViewModel.PointerWheelChanged：上滚增大、下滚减小，饱和即停） —— */
const ROW_HEIGHTS = [28, 36, 40, 44, 48];

function onWheel(e: WheelEvent) {
  if (!e.ctrlKey) return;
  e.preventDefault();
  const current = settings.settings.detailsRowHeight;
  const idx = Math.max(0, ROW_HEIGHTS.indexOf(current));
  const next = ROW_HEIGHTS[Math.min(ROW_HEIGHTS.length - 1, Math.max(0, e.deltaY < 0 ? idx + 1 : idx - 1))];
  if (next !== current) settings.update({ detailsRowHeight: next });
}

/** —— 橡皮筋框选：空白处按下拖动画框，拖动过程中相交行实时选中 —— */
const rubber = ref<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
/** 框选进行中禁文本选择 */
const rubberActive = ref(false);

/** 命中测试：与选框相交的行名（Explorer 语义） */
function hitTest(x1: number, y1: number, x2: number, y2: number): string[] {
  const box = {
    left: Math.min(x1, x2),
    right: Math.max(x1, x2),
    top: Math.min(y1, y2),
    bottom: Math.max(y1, y2),
  };
  const hits: string[] = [];
  for (const el of document.querySelectorAll("[data-row]")) {
    const r = el.getBoundingClientRect();
    const intersect =
      r.left < box.right && r.right > box.left && r.top < box.bottom && r.bottom > box.top;
    if (intersect) hits.push((el as HTMLElement).dataset.row!);
  }
  return hits;
}

function onContainerPointerDown(e: PointerEvent) {
  if (e.button !== 0) return;
  // 按钮/输入框不启动框选。行上按下也允许启动：真机 WebView2（Tauri 接管拖放）
  // 不派发 HTML5 dragstart，行内拖拽不可用——行上拖动回落为框选（Win11 Explorer
  // 同款手感）；支持 HTML5 DnD 的环境里 dragstart 触发 pointercancel 中止框选并
  // 还原按下时的选择快照，行拖拽语义不受影响。
  if ((e.target as HTMLElement).closest("button, input, textarea, [contenteditable]")) return;
  const onRow = !!(e.target as HTMLElement).closest("[data-row]");
  const startX = e.clientX;
  const startY = e.clientY;
  const additive = e.ctrlKey;
  const snapshot = [...explorer.selectedNames];
  let moved = false;
  let raf = 0;

  const onMove = (ev: PointerEvent) => {
    if (Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) > 4) {
      moved = true;
      rubberActive.value = true;
      rubber.value = { x1: startX, y1: startY, x2: ev.clientX, y2: ev.clientY };
      // 实时选中：rAF 节流命中测试，状态栏随拖动即时计数
      if (!raf) {
        raf = requestAnimationFrame(() => {
          raf = 0;
          if (rubber.value) {
            explorer.applyRubberSelection(
              hitTest(startX, startY, rubber.value.x2, rubber.value.y2),
              additive,
            );
          }
        });
      }
    }
  };
  const cleanup = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onCancel);
    if (raf) cancelAnimationFrame(raf);
    rubber.value = null;
    rubberActive.value = false;
  };
  // drag 会话接管（浏览器环境行拖拽）：中止框选；拖动已污染的选择还原快照
  //（行拖拽携带按下时的选中集合，Files 语义）
  const onCancel = () => {
    cleanup();
    if (moved) explorer.applyRubberSelection(snapshot, false);
  };
  const onUp = (ev: PointerEvent) => {
    cleanup();
    if (moved) {
      explorer.applyRubberSelection(hitTest(startX, startY, ev.clientX, ev.clientY), additive);
    } else if (!onRow) {
      // 未拖动的空白单击：清除选择（行上的单击选中交给行自身处理）
      explorer.clearSelection();
    }
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onCancel);
}

/** —— 行内拖拽（M7 步骤 4）：行 draggable，dragstart 写自定义载荷 + 「N 项」拖影；
 *  默认移动、Ctrl 复制（拖影角标随 drag 事件的按键状态切换）；落点走 drop-files 事件 —— */

/** 拖影 ghost（屏幕外挂载供 setDragImage；drag 事件里同步 Ctrl 角标） */
let ghostEl: HTMLElement | null = null;
let ghostBadge: HTMLElement | null = null;

function startDragGhost(e: DragEvent, count: number) {
  removeDragGhost();
  ghostEl = document.createElement("div");
  ghostEl.style.cssText =
    "position:fixed;top:-200px;left:-200px;display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border-radius:4px;background:var(--accent);color:var(--accent-fg);font-size:12px;font-weight:600;pointer-events:none;z-index:9999;white-space:nowrap;";
  ghostEl.textContent = count > 1 ? `${count} 项` : "1 项";
  ghostBadge = document.createElement("span");
  ghostBadge.textContent = "+";
  ghostBadge.style.cssText = "display:none;font-weight:700;";
  ghostEl.appendChild(ghostBadge);
  document.body.appendChild(ghostEl);
  if (e.dataTransfer) {
    try {
      e.dataTransfer.setDragImage(ghostEl, 10, 10);
    } catch {
      // 个别环境不支持自定义拖影：退回浏览器默认
    }
  }
}

function removeDragGhost() {
  ghostEl?.remove();
  ghostEl = null;
  ghostBadge = null;
}

/** drag 事件持续触发：Ctrl 按下 → 角标显示「+」（复制语义），松开移除 */
function onRowDrag(e: DragEvent) {
  if (ghostBadge) ghostBadge.style.display = e.ctrlKey ? "inline" : "none";
}

function onRowDragStart(entry: FileEntry, e: DragEvent) {
  // 搜索结果行（键为 relPath）不做行内拖拽：载荷按「源目录内名称」语义
  if (inSearch.value || !explorer.connectionId) {
    e.preventDefault();
    return;
  }
  const names = resolveDragNames(entry.name, explorer.selectedNames);
  writeFilesPayload(e.dataTransfer!, {
    connectionId: explorer.connectionId,
    dir: explorer.cwd,
    names,
  });
  startDragGhost(e, names.length);
}

function onRowDragEnd() {
  dragOverDir.value = null;
  removeDragGhost();
}

/** 文件夹行 dragover：命中高亮 + 放行 drop（stopPropagation 防止落到空白） */
function onRowDragOver(entry: FileEntry, e: DragEvent) {
  if (entry.kind !== "dir" || !hasFilesPayload(e.dataTransfer!)) return;
  e.preventDefault();
  e.stopPropagation();
  e.dataTransfer!.dropEffect = resolveDropMode(e.ctrlKey) === "copy" ? "copy" : "move";
  dragOverDir.value = entry.name;
}

function onRowDragLeave(entry: FileEntry) {
  if (dragOverDir.value === entry.name) dragOverDir.value = null;
}

function onRowDrop(entry: FileEntry, e: DragEvent) {
  if (entry.kind !== "dir") return;
  e.preventDefault();
  e.stopPropagation();
  dragOverDir.value = null;
  removeDragGhost();
  const payload = readFilesPayload(e.dataTransfer!);
  if (!payload) return;
  emit("dropFiles", payload, joinPath(explorer.cwd, entry.name), e.ctrlKey);
}

/** 文件区空白落点 = 当前目录（行内 drop 已 stopPropagation） */
function onBlankDragOver(e: DragEvent) {
  if (!hasFilesPayload(e.dataTransfer!)) return;
  e.preventDefault();
  e.dataTransfer!.dropEffect = resolveDropMode(e.ctrlKey) === "copy" ? "copy" : "move";
  dragOverDir.value = ".";
}

function onBlankDrop(e: DragEvent) {
  if (!hasFilesPayload(e.dataTransfer!)) return;
  e.preventDefault();
  if (dragOverDir.value === ".") dragOverDir.value = null;
  removeDragGhost();
  const payload = readFilesPayload(e.dataTransfer!);
  if (!payload) return;
  emit("dropFiles", payload, explorer.cwd, e.ctrlKey);
}

/** 文件夹行拖拽命中高亮（hover 高亮语义；"." 代表空白区） */
const dragOverDir = ref<string | null>(null);
</script>

<template>
  <!-- 列表容器内边距 8（DetailsLayoutPage ListView padding）；空白拖动 = 橡皮筋框选；Ctrl+滚轮 = 行高密度 -->
  <div
    class="relative min-h-full px-2 pb-3"
    :class="rubberActive && 'select-none'"
    @pointerdown="onContainerPointerDown"
    @dblclick="onBlankDblClick"
    @contextmenu.prevent="onBlankContextMenu($event)"
    @wheel="onWheel"
    @dragover="onBlankDragOver"
    @drop="onBlankDrop"
  >
    <!-- 列头：40 高、左距 24、底部分隔线，点击排序；右缘 4px 拖宽/双击自适应；右键勾选列显隐 -->
    <div
      class="sticky top-0 z-10 grid items-center border-b pl-6 text-xs text-dim"
      :style="{ height: '40px', borderColor: 'var(--line)', background: 'var(--panel-solid)', gridTemplateColumns: gridTemplate }"
      @contextmenu.stop.prevent="onHeaderContextMenu"
    >
      <button
        v-for="col in visibleColumns"
        :key="col.key"
        type="button"
        class="relative flex h-full items-center gap-1 text-left font-normal hover:text-ink"
        :class="headerClass(col.key)"
        @click="explorer.sortBy(col.key)"
      >
        {{ headerLabel(col.key) }}
        <ChevronUp
          v-if="explorer.sortKey === col.key && explorer.sortAsc"
          :size="12"
          class="text-dim"
        />
        <ChevronDown
          v-else-if="explorer.sortKey === col.key"
          :size="12"
          class="text-dim"
        />
        <!-- 拖宽/双击自适应命中区（名称列恒弹性不提供；拦下 click 防误触排序） -->
        <span
          v-if="col.key !== 'name'"
          class="absolute top-0 -right-1 z-20 h-full w-2 cursor-col-resize"
          @pointerdown="onResizeHandleDown(col.key, $event)"
          @click.stop
          @dblclick.stop="onResizeHandleDblClick(col.key)"
        />
      </button>
    </div>

    <!-- 加载骨架 -->
    <div v-if="explorer.loading && !explorer.entries.length">
      <div v-for="i in 9" :key="i" class="flex h-9 items-center px-3">
        <div
          class="h-4 animate-pulse rounded-[2px]"
          :style="{ width: `${18 + ((i * 13) % 40)}%`, background: 'var(--line)' }"
        />
      </div>
    </div>

    <template v-else>
      <!-- 新建草稿行：列表顶部就地输入名称 -->
      <div
        v-if="explorer.newDraft"
        class="grid items-center rounded-[4px] px-3 text-sm"
        :style="{ height: `${settings.settings.detailsRowHeight}px`, background: 'var(--fill-control)', gridTemplateColumns: gridTemplate }"
        @click.stop
        @contextmenu.stop.prevent
      >
        <span class="flex min-w-0 items-center pl-3">
          <Folder
            v-if="explorer.newDraft === 'dir'"
            :size="16"
            class="shrink-0 text-folder"
            fill="currentColor"
          />
          <File v-else :size="16" class="shrink-0 text-dim" />
          <input
            :ref="(el) => focusEditInput(el, '')"
            v-model="editValue"
            class="rename-input ml-1.5"
            :placeholder="explorer.newDraft === 'dir' ? '新建文件夹' : '新建文件'"
            spellcheck="false"
            @keydown.enter.prevent.stop="commitDraft"
            @keydown.esc.prevent.stop="explorer.cancelEdit()"
            @blur="explorer.cancelEdit()"
          />
        </span>
      </div>

      <div v-if="explorer.visibleEntries.length">
        <div
          v-for="entry in explorer.visibleEntries"
          :key="rowKey(entry)"
          class="relative grid cursor-default items-center rounded-[4px] px-3 text-sm transition-colors"
          :style="{ height: `${settings.settings.detailsRowHeight}px`, gridTemplateColumns: gridTemplate }"
          :class="[
            explorer.isSelected(rowKey(entry))
              ? 'bg-row-active hover:bg-row-active-hover'
              : 'hover:bg-row-hover',
            isCutRow(entry) && 'opacity-40',
            dragOverDir === entry.name && 'bg-row-active ring-1 ring-[var(--accent)]',
          ]"
          role="row"
          :data-row="rowKey(entry)"
          :aria-selected="explorer.isSelected(rowKey(entry))"
          tabindex="0"
          :draggable="!inSearch"
          @click.stop="onRowClick(entry, $event)"
          @dblclick.stop="onRowDblClick(entry)"
          @contextmenu.stop.prevent="onRowContextMenu(entry, $event)"
          @keydown.enter="entry.kind === 'dir' && explorer.enter(entry.name)"
          @dragstart="onRowDragStart(entry, $event)"
          @drag="onRowDrag($event)"
          @dragend="onRowDragEnd"
          @dragover="onRowDragOver(entry, $event)"
          @dragleave="onRowDragLeave(entry)"
          @drop="onRowDrop(entry, $event)"
        >
          <!-- 选中指示竖条（WinUI ListViewItemPresenter SelectionIndicator：3×16、1.5 圆角、左缘居中） -->
          <span
            v-if="explorer.isSelected(rowKey(entry))"
            class="pointer-events-none absolute top-1/2 left-0 h-4 w-[3px] -translate-y-1/2 rounded-[1.5px] bg-accent"
            aria-hidden="true"
          />
          <!-- 名称列：图标 16 + 文字距 6（DetailsLayoutPage IconColumn）；
              图片文件渲染缩略图（20px 方块 2px 圆角，紧凑行 18px），未加载/失败回退图标 -->
          <span class="flex min-w-0 items-center pl-3">
            <span
              v-if="isThumbRow(entry)"
              :ref="thumbRefFor(entry)"
              class="flex shrink-0 items-center justify-center"
              :style="{ width: `${thumbSize}px`, height: `${thumbSize}px` }"
            >
              <img
                v-if="thumbSrc(entry)"
                :src="thumbSrc(entry)!"
                class="h-full w-full rounded-[2px] object-cover"
                alt=""
              />
              <component
                v-else
                :is="iconFor(entry)"
                :size="16"
                :class="iconClass(entry)"
              />
            </span>
            <component
              v-else
              :is="iconFor(entry)"
              :size="16"
              class="shrink-0"
              :class="iconClass(entry)"
              :fill="entry.kind === 'dir' ? 'currentColor' : 'none'"
            />
            <!-- 就地重命名（F2 / 右键菜单）：Enter 确认，Esc 取消 -->
            <input
              v-if="explorer.renamingName === entry.name"
              :ref="(el) => focusEditInput(el, entry.name)"
              v-model="editValue"
              class="rename-input ml-1.5"
              spellcheck="false"
              @click.stop
              @dblclick.stop
              @keydown.enter.prevent.stop="commitRename(entry)"
              @keydown.esc.prevent.stop="explorer.cancelEdit()"
              @blur="explorer.cancelEdit()"
            />
            <span
              v-else
              class="truncate pl-1.5"
              :title="inSearch
                ? (entry as SearchHitRow).relPath
                : settings.settings.showFileExtensions ? undefined : entry.name"
            >{{ displayName(entry) }}</span>
          </span>
          <!-- 其余列：caption 12、次级文字（ColumnContentTextBlock opacity .6） -->
          <span
            v-for="col in dataColumns"
            :key="col.key"
            :data-col="col.key"
            class="truncate"
            :class="cellClass(col.key)"
          >{{ cellText(entry, col.key) }}</span>
        </div>
      </div>

      <div v-else-if="!explorer.newDraft" class="flex flex-col items-center pt-20 text-dim">
        <component :is="explorer.searchQuery ? SearchX : Folder" :size="28" class="mb-3 text-faint" />
        <span class="text-sm">
          {{ explorer.searchQuery ? `没有匹配「${explorer.searchQuery}」的项目` : "此目录为空" }}
        </span>
      </div>
    </template>

    <!-- 橡皮筋选框（视口坐标，强调色描边 + 半透明填充） -->
    <div
      v-if="rubber"
      class="pointer-events-none fixed z-30"
      :style="{
        left: `${Math.min(rubber.x1, rubber.x2)}px`,
        top: `${Math.min(rubber.y1, rubber.y2)}px`,
        width: `${Math.abs(rubber.x2 - rubber.x1)}px`,
        height: `${Math.abs(rubber.y2 - rubber.y1)}px`,
        background: 'color-mix(in srgb, var(--accent) 10%, transparent)',
        border: '1px solid var(--accent)',
      }"
    />

    <!-- 列头右键菜单：列显隐勾选（DetailsLayoutPage 列开关菜单） -->
    <ContextMenu
      :open="colMenu.open"
      :x="colMenu.x"
      :y="colMenu.y"
      :items="colMenuItems"
      @select="onColMenuSelect"
      @close="colMenu.open = false"
    />
  </div>
</template>
