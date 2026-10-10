import { ref } from "vue";

/**
 * 悬浮窗（编辑器/终端）8 向调整大小：四边 + 四角。
 *
 * 拖拽开始即把窗体从 flex 居中切换为遮罩内 absolute 定位并锁定左上角——
 * 居中态下宽度 +d 会被两侧平分（右缘只右移 d/2），句柄只走一半不跟手
 * （终端旧实现的问题）；锚定后增量全额作用于拖拽侧边缘，1:1 跟手。
 * 西/北侧收缩触到 min 尺寸时对侧边缘保持不动（位置回推），不漂移。
 */

/** 8 个拖拽方向；组合向（ne 等）同时命中两条轴 */
export type ResizeDir = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

export function useFloatingResize(opts: {
  initial: { w: number; h: number };
  minW: number;
  minH: number;
  /** 上限占视口比例（默认 0.92 / 0.9） */
  maxWRatio?: number;
  maxHRatio?: number;
}) {
  const { initial, minW, minH, maxWRatio = 0.92, maxHRatio = 0.9 } = opts;

  /** 窗体尺寸（px）；拖拽期间关闭过渡 */
  const size = ref({ ...initial });
  /** resize 锁定的左上角位置（相对遮罩；null = flex 居中常态） */
  const pos = ref<{ x: number; y: number } | null>(null);
  const dragging = ref(false);

  /** 关闭/重开时复位居中 */
  function resetAnchor() {
    pos.value = null;
  }

  function startResize(e: PointerEvent, dir: ResizeDir) {
    // 锚定坐标取窗体与遮罩 rect 差，不硬编码「遮罩顶部让位标题栏 36px」
    const win = (e.currentTarget as HTMLElement).closest(
      '[role="dialog"]',
    ) as HTMLElement | null;
    if (win?.parentElement) {
      const r = win.getBoundingClientRect();
      const o = win.parentElement.getBoundingClientRect();
      pos.value = { x: r.left - o.left, y: r.top - o.top };
    }
    dragging.value = true;
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // 合成事件无活动指针（CDP 测试）：window 监听本就兜底，捕获失败不碍事
    }
    const startX = e.clientX;
    const startY = e.clientY;
    const startW = size.value.w;
    const startH = size.value.h;
    const startL = pos.value?.x ?? 0;
    const startT = pos.value?.y ?? 0;
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      const maxW = Math.round(window.innerWidth * maxWRatio);
      const maxH = Math.round(window.innerHeight * maxHRatio);
      let w = startW;
      let h = startH;
      if (dir.includes("e")) w = startW + dx;
      if (dir.includes("s")) h = startH + dy;
      if (dir.includes("w")) w = startW - dx;
      if (dir.includes("n")) h = startH - dy;
      w = Math.min(maxW, Math.max(minW, w));
      h = Math.min(maxH, Math.max(minH, h));
      size.value = { w, h };
      // 西/北侧：对侧边缘锚定（clamp 截断时位置随尺寸回推）
      if (pos.value) {
        pos.value = {
          x: dir.includes("w") ? startL + startW - w : startL,
          y: dir.includes("n") ? startT + startH - h : startT,
        };
      }
    };
    const onUp = () => {
      dragging.value = false;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }

  return { size, pos, dragging, startResize, resetAnchor };
}
