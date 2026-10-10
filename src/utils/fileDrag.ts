/**
 * 指针长按拖拽会话（对照 Files BaseLayoutPage.cs / WinUI ListViewBase 平台拖拽）：
 * 真机 WebView2 里 Tauri 接管系统拖放后不派发 HTML5 dragstart，行内拖拽全部失效，
 * 故以 window 指针流自绘：按下 400ms 武装（行微抬，WinUI 触控 press-and-hold 手势的
 * 鼠标等价物，同时与橡皮筋框选互斥），随后移动拖动快照 ghost。
 *
 * Files 源码定论（本地快照 9bc7472 / 主线 1994d9a4 双验）：
 * - ghost = 系统默认条目快照，无自定义；拖起源行淡化到 ListViewItemDragThemeOpacity=0.8
 * - 反馈主体是光标旁系统 caption「移动到/复制到 {X}」（DragUIOverride.Caption，
 *   zh-Hans：移动到 {0} / 复制到 {0}）；文件行/面包屑无拖拽专属高亮
 * - 文件夹行/文件行悬停 1300ms（HoverToOpenTimespan）选中并打开（含文件）；
 *   空白区 caption「移动到 {当前文件夹}」+ 清空选择；标签=2px accent 顶圆角边框
 *   （StorageItemDragOverIndicator）+ 悬停 1300ms 切换；侧栏收藏=ControlFillColorTertiary
 *   底 + 2px accent 边框外扩 1px（DragOnTopIndicator）
 * - 「+」仅接受含文件夹的拖拽：caption「在新标签页中打开」，落号新标签打开该文件夹
 *
 * 落点用 DOM 属性声明（data-drop-dir/kind/label、data-drop-tab、data-drop-tab-new、
 * data-drop-pin-blank），命中后在该元素上派发 files-drop / files-hover-open /
 * files-hover-blank CustomEvent，由各组件就地复用既有执行器（pane 内 hint/error 语义不变）。
 */
import { reactive } from "vue";

import { resolveDropMode, type FilesDragPayload } from "@/utils/dragDrop";
import { joinPath, pathBaseName } from "@/utils/format";

/** 长按武装阈值（ms）。Files 无此值（平台手势）；本值是「长按 vs 框选/单击」的取舍 */
export const HOLD_TO_DRAG_MS = 400;
/** 武装后拖动激活的位移阈值（px），与框选一致 */
const DRAG_SLOP_PX = 4;
/** 悬停自动打开/切换（Constants.DragAndDrop.HoverToOpenTimespan = 1300） */
const HOVER_OPEN_MS = 1300;
/** ghost 快照不透明度（WinUI ListViewItemDragThemeOpacity） */
const GHOST_OPACITY = 0.8;
/** 多选拖动快照最多层数（额外项在主快照右下角级联） */
const MAX_GHOST_ROWS = 3;
const GHOST_STEP_X = 10;
const GHOST_STEP_Y = 8;
/** caption 芯片相对光标的偏移（系统 caption 画在光标右下方） */
const CAPTION_OFFSET_X = 16;
const CAPTION_OFFSET_Y = 20;
/** 拖拽结束后吞掉紧随的 click（防止落点单击误开/误选） */
const CLICK_SUPPRESS_MS = 150;

/** 落点属性选择器（容器空白 / 文件夹行 / 面包屑 / 侧栏收藏 / 标签 / 「+」/ 收藏区空白） */
const DROP_ATTRS =
  "[data-drop-dir],[data-drop-tab],[data-drop-tab-new],[data-drop-pin-blank]";

export type DropKind = "folder" | "blank" | "breadcrumb" | "pinned-item";

/** 指针拖拽的命中落点（dir 类目标带绝对目录；tab/tab-new/pinned-blank 无目录） */
export interface PointerDropTarget {
  kind: DropKind | "pinned-blank" | "tab" | "tab-new";
  dir: string | null;
  el: HTMLElement;
}

/** 模块单例状态（组件经 fileDrag.* 做高亮/变暗/点击抑制） */
export const fileDrag = reactive({
  /** idle=无会话；holding=按下计时中；dragging=武装后（含未移动） */
  phase: "idle" as "idle" | "holding" | "dragging",
  /** 拖动集合的行键（拖起源行 0.8 变暗） */
  names: [] as string[],
  /** 武装中的行键（微抬反馈） */
  armedKey: null as string | null,
  /** 当前命中落点（组件比对自身 dir/tabId 决定高亮） */
  target: null as PointerDropTarget | null,
  mode: "move" as "move" | "copy",
  /** 光标旁 caption 文案（无有效落点时 null） */
  caption: null as string | null,
});

let suppressClickUntil = 0;

/** 拖拽刚结束的短时间内吞掉 click（行选中/空白清选不受落点误触） */
export function consumeClickGuard(): boolean {
  return performance.now() < suppressClickUntil;
}

/** 会话内部态 */
interface DragSession {
  payload: FilesDragPayload;
  /** 武装的行键（长按完成时行微抬） */
  armedKey: string;
  /** 拖动集合中第一个文件夹名（「+」落点：新标签打开它；真拖动开始时按行图标回填） */
  firstDirName: string | null;
  rowEl: HTMLElement;
  startX: number;
  startY: number;
  /** 抓取点在行内的偏移（ghost 顶左 = 指针 - 偏移，抓哪儿拖哪儿） */
  grabDx: number;
  grabDy: number;
  holdTimer: number | undefined;
  ghost: HTMLElement | null;
  captionEl: HTMLElement | null;
  hoverTimer: number | undefined;
  hoverEl: HTMLElement | null;
  moved: boolean;
}

let session: DragSession | null = null;

/** 按下行启动长按计时（FileTable 在行上 pointerdown 时调用，须先于其框选监听注册，
 *  使框选的 move 处理总能看到本模块已就位的 phase） */
export function beginFileDragHold(
  rowEl: HTMLElement,
  payload: FilesDragPayload,
  armedKey: string,
  e: PointerEvent,
): void {
  cancelFileDrag();
  // 按下等待期零视觉（Files/WinUI：平台按住识别静默，条目只在拖拽真正开始
  // （DragStarting=移动触发）时才有反应）——单击/双击绝不能闪出武装动画
  fileDrag.phase = "holding";
  fileDrag.names = [];
  fileDrag.armedKey = null;
  const rect = rowEl.getBoundingClientRect();
  session = {
    payload,
    armedKey,
    firstDirName: null,
    rowEl,
    startX: e.clientX,
    startY: e.clientY,
    grabDx: e.clientX - rect.left,
    grabDy: e.clientY - rect.top,
    holdTimer: window.setTimeout(armDrag, HOLD_TO_DRAG_MS),
    ghost: null,
    captionEl: null,
    hoverTimer: undefined,
    hoverEl: null,
    moved: false,
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onCancel);
  window.addEventListener("keydown", onKeydown);
}

/** 长按到位：武装。此时只有行微抬一个信号（解锁可拖），ghost/变暗/命中
 *  全部推迟到真移动（moved）——WinUI 的 ghost 与 DragItemThemeAnimation
 *  都挂在 DragStarting（拖拽开始）而非 hold 完成 */
function armDrag(): void {
  if (!session) return;
  session.holdTimer = undefined;
  fileDrag.phase = "dragging";
  fileDrag.armedKey = session.armedKey;
  document.body.classList.add("file-dragging");
}

function onMove(e: PointerEvent): void {
  if (!session) return;
  if (fileDrag.phase === "holding") {
    if (
      Math.abs(e.clientX - session.startX) + Math.abs(e.clientY - session.startY) >
      DRAG_SLOP_PX
    ) {
      // 未武装先移动 → 交还框选/单击语义
      cancelFileDrag();
    }
    return;
  }
  if (!session.moved) {
    if (
      Math.abs(e.clientX - session.startX) + Math.abs(e.clientY - session.startY) <
      DRAG_SLOP_PX
    ) {
      return;
    }
    // 真拖动开始（DragStarting 语义）：微抬让位，源行变暗 + ghost 上场
    session.moved = true;
    fileDrag.armedKey = null;
    fileDrag.names = session.payload.names;
    buildGhost();
  }
  e.preventDefault();
  positionGhost(e.clientX, e.clientY);
  updateHit(e.clientX, e.clientY, e.ctrlKey);
}

function onUp(e: PointerEvent): void {
  if (!session) return;
  if (fileDrag.phase === "dragging") {
    updateHit(e.clientX, e.clientY, e.ctrlKey);
    const target = fileDrag.target;
    if (session.moved && target) {
      target.el.dispatchEvent(
        new CustomEvent("files-drop", {
          detail: {
            payload: session.payload,
            ctrlKey: e.ctrlKey,
            firstDirName: session.firstDirName,
          },
        }),
      );
      suppressClickUntil = performance.now() + CLICK_SUPPRESS_MS;
    }
  }
  endSession();
}

function onCancel(): void {
  endSession();
}

function onKeydown(e: KeyboardEvent): void {
  // Escape 取消拖拽（Files TabDragging_PreviewKeyDown 同语义）
  if (e.key === "Escape") endSession();
}

/** 立即中止会话（外部调用：目录切换等使行失效时） */
export function cancelFileDrag(): void {
  if (session) endSession();
}

function endSession(): void {
  const s = session;
  if (!s) return;
  if (s.holdTimer) window.clearTimeout(s.holdTimer);
  if (s.hoverTimer) window.clearTimeout(s.hoverTimer);
  s.ghost?.remove();
  document.body.classList.remove("file-dragging");
  session = null;
  fileDrag.phase = "idle";
  fileDrag.names = [];
  fileDrag.armedKey = null;
  fileDrag.target = null;
  fileDrag.caption = null;
  fileDrag.mode = "move";
  window.removeEventListener("pointermove", onMove);
  window.removeEventListener("pointerup", onUp);
  window.removeEventListener("pointercancel", onCancel);
  window.removeEventListener("keydown", onKeydown);
}

/** —— ghost：拖起源行快照（保持抓取偏移），多选时级联至多 3 层 —— */

function buildGhost(): void {
  if (!session) return;
  removeGhost();
  const container = document.createElement("div");
  container.className = "file-drag-ghost";
  container.style.opacity = String(GHOST_OPACITY);

  const inSet = draggedRowEls();
  for (let i = Math.min(inSet.length, MAX_GHOST_ROWS) - 1; i >= 0; i -= 1) {
    const el = inSet[i];
    const clone = el.cloneNode(true) as HTMLElement;
    clone.style.width = `${el.getBoundingClientRect().width}px`;
    clone.style.margin = "0";
    clone.style.animation = "none";
    const layer = document.createElement("div");
    layer.className = "file-drag-ghost-layer";
    layer.style.width = `${el.getBoundingClientRect().width}px`;
    layer.style.left = `${i * GHOST_STEP_X}px`;
    layer.style.top = `${i * GHOST_STEP_Y}px`;
    layer.appendChild(clone);
    container.appendChild(layer);
  }

  const caption = document.createElement("div");
  caption.className = "file-drag-caption";
  caption.style.display = "none";
  container.appendChild(caption);

  document.body.appendChild(container);
  session.ghost = container;
  session.captionEl = caption;

  // 「+」落点需要拖动集合中的文件夹（Files 仅目录可落「+」）：按行文件夹图标判定
  session.firstDirName =
    inSet.find((el) => el.querySelector(".text-folder"))?.dataset.row ?? null;
}

/** 拖动集合的行元素：FileTable 容器内按 DOM 顺序，按下行居首（Files 视觉序）。
 *  容器锚定用 data-drop-kind=blank——文件夹行自身也带 data-drop-dir，不能用其定位 */
function draggedRowEls(): HTMLElement[] {
  const s = session;
  if (!s) return [];
  const scope = s.rowEl.closest("[data-drop-kind='blank']");
  const all = scope
    ? [...scope.querySelectorAll<HTMLElement>("[data-row]")]
    : [s.rowEl];
  const inSet = all.filter((el) => s.payload.names.includes(el.dataset.row!));
  const pressed = inSet.find((el) => el === s.rowEl) ?? s.rowEl;
  return [pressed, ...inSet.filter((el) => el !== pressed)];
}

function removeGhost(): void {
  if (!session) return;
  session.ghost?.remove();
  session.ghost = null;
  session.captionEl = null;
}

function positionGhost(x: number, y: number): void {
  if (!session?.ghost) return;
  session.ghost.style.left = `${x - session.grabDx}px`;
  session.ghost.style.top = `${y - session.grabDy}px`;
}

/** —— 命中测试与 caption / 悬停定时 —— */

interface HitResult {
  target: PointerDropTarget | null;
  /** 悬停 1300ms 后派发 files-hover-open 的元素（文件夹/文件行、面包屑、收藏、标签） */
  hoverEl: HTMLElement | null;
}

function hitTest(x: number, y: number): HitResult {
  for (const raw of document.elementsFromPoint(x, y)) {
    if (!(raw instanceof HTMLElement)) continue;
    const el = raw.closest<HTMLElement>(DROP_ATTRS);
    // 光标下的行（文件夹行有 data-drop-dir；文件行没有）
    const row = raw.closest<HTMLElement>("[data-row]");
    if (el) {
      if (el.dataset.dropTab !== undefined) {
        return { target: { kind: "tab", dir: null, el }, hoverEl: el };
      }
      if (el.hasAttribute("data-drop-tab-new")) {
        // 仅文件夹可落「+」（Files TabBar.xaml.cs:385-407：无目录则 None）
        if (session?.firstDirName) {
          return { target: { kind: "tab-new", dir: null, el }, hoverEl: null };
        }
        continue;
      }
      if (el.hasAttribute("data-drop-pin-blank")) {
        return { target: { kind: "pinned-blank", dir: null, el }, hoverEl: null };
      }
      // 文件行挡住容器级空白落点（文件不是有效落点，但可悬停打开）
      if (row && row !== el && !row.hasAttribute("data-drop-dir")) {
        return { target: null, hoverEl: row };
      }
      const dir = el.dataset.dropDir!;
      if (session && isSelfOrAncestorTarget(session.payload, dir)) {
        // 拖入自身或子孙目录：拒绝（Files ContainsDestinationOrAncestor → None，无悬停打开）
        return { target: null, hoverEl: null };
      }
      const kind = (el.dataset.dropKind as DropKind | undefined) ?? "blank";
      return {
        target: { kind, dir, el },
        // 空白容器无悬停打开；文件夹/面包屑/收藏在元素上悬停
        hoverEl: kind === "blank" ? null : el,
      };
    }
    if (row) return { target: null, hoverEl: row };
  }
  return { target: null, hoverEl: null };
}

/** 拖动目录是落点自身或其祖先（如把 b 拖进 b/ 里） → 无效落点 */
export function isSelfOrAncestorTarget(
  payload: FilesDragPayload,
  targetDir: string,
): boolean {
  for (const name of payload.names) {
    const p = joinPath(payload.dir, name);
    if (p === targetDir || targetDir.startsWith(`${p === "/" ? "" : p}/`)) return true;
  }
  return false;
}

function updateHit(x: number, y: number, ctrlKey: boolean): void {
  if (!session) return;
  fileDrag.mode = resolveDropMode(ctrlKey);
  const { target, hoverEl: hitHoverEl } = hitTest(x, y);
  // 悬停打开不作用于被拖行自身（Files：self 项 AcceptedOperation=None，不启动 hover 定时）
  const hoverKey = hitHoverEl?.dataset.row;
  const hoverEl =
    hoverKey && session.payload.names.includes(hoverKey) ? null : hitHoverEl;
  const prevEl = fileDrag.target?.el ?? null;
  fileDrag.target = target;

  // caption：文件夹/空白/面包屑/收藏 = 移动/复制到 {X}；「+」= 在新标签页中打开；
  // 标签/收藏区空白无 caption（Files 同源码结论）
  if (!target) {
    fileDrag.caption = null;
  } else if (target.kind === "tab-new") {
    fileDrag.caption = "在新标签页中打开";
  } else if (target.kind === "tab" || target.kind === "pinned-blank") {
    fileDrag.caption = null;
  } else {
    const label = target.el.dataset.dropLabel;
    fileDrag.caption = label
      ? `${fileDrag.mode === "copy" ? "复制" : "移动"}到 ${label}`
      : null;
  }
  if (session.captionEl) {
    if (fileDrag.caption) {
      session.captionEl.textContent = fileDrag.caption;
      session.captionEl.style.display = "";
      session.captionEl.style.left = `${session.grabDx + CAPTION_OFFSET_X}px`;
      session.captionEl.style.top = `${session.grabDy + CAPTION_OFFSET_Y}px`;
    } else {
      session.captionEl.style.display = "none";
    }
  }

  // 空白落点：清空选择（Files BaseLayoutViewModel DragOverCommand → ClearSelection）
  if (target?.kind === "blank" && prevEl !== target.el) {
    target.el.dispatchEvent(new CustomEvent("files-hover-blank"));
  }

  // 悬停 1300ms：换目标即重置计时（Files DragOverTimer.Debounce，无前沿）
  if (hoverEl !== session.hoverEl) {
    if (session.hoverTimer) window.clearTimeout(session.hoverTimer);
    session.hoverEl = hoverEl;
    if (hoverEl) {
      session.hoverTimer = window.setTimeout(() => {
        if (session?.hoverEl) {
          session.hoverEl.dispatchEvent(new CustomEvent("files-hover-open"));
          session.hoverEl = null;
        }
      }, HOVER_OPEN_MS);
    }
  }
}

/** 目录标签的短名（caption 用；根为 /） */
export function dropLabelOfDir(dir: string): string {
  return pathBaseName(dir) || "/";
}
