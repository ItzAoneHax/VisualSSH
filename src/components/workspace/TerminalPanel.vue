<script setup lang="ts">
import { ChevronsDownUp, ChevronsUpDown, SquareTerminal, X } from "@lucide/vue";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal, type ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { nextTick, onBeforeUnmount, ref, watch } from "vue";

import { useTerminalStore } from "@/stores/terminal";

/**
 * 悬浮终端窗（与编辑器同款形态）：全页模糊遮罩（避开标题栏）+ 居中亚克力窗体，
 * 自底部升起。终端习惯宽扁比例，默认 86vw × 64vh，右下角可拖拽调整大小。
 * xterm.js 双向转发：onData → ssh_terminal_write；terminal://data → xterm.write；
 * fit addon 自适应窗体尺寸，变化时同步 ssh_terminal_resize；主题跟随明暗。
 */

const terminalStore = useTerminalStore();

/** 窗体尺寸（px）；拖拽期间关闭过渡 */
const size = ref({
  w: Math.min(1024, Math.round(window.innerWidth * 0.86)),
  h: Math.min(520, Math.round(window.innerHeight * 0.64)),
});
const dragging = ref(false);
const maximized = ref(false);
const host = ref<HTMLElement | null>(null);

/** Windows Terminal Campbell 暗色（#0C0C0C 底） */
const DARK_THEME: ITheme = {
  background: "#0c0c0c",
  foreground: "#cccccc",
  cursor: "#cccccc",
  cursorAccent: "#0c0c0c",
  selectionBackground: "#ffffff40",
  black: "#0c0c0c",
  red: "#c50f1f",
  green: "#13a10e",
  yellow: "#c19c00",
  blue: "#0037da",
  magenta: "#881798",
  cyan: "#3a96dd",
  white: "#cccccc",
  brightBlack: "#767676",
  brightRed: "#e74856",
  brightGreen: "#16c60c",
  brightYellow: "#f9f1a5",
  brightBlue: "#3b78ff",
  brightMagenta: "#b4009e",
  brightCyan: "#61d6d6",
  brightWhite: "#f2f2f2",
};

/** 亮色底（VSCode Light 终端色，白底友好） */
const LIGHT_THEME: ITheme = {
  background: "#ffffff",
  foreground: "#1a1a1a",
  cursor: "#1a1a1a",
  cursorAccent: "#ffffff",
  selectionBackground: "#add6ff",
  black: "#0c0c0c",
  red: "#cd3131",
  green: "#0dbc8b",
  yellow: "#e5e510",
  blue: "#2472c8",
  magenta: "#bc3fbc",
  cyan: "#11a8cd",
  white: "#e5e5e5",
  brightBlack: "#666666",
  brightRed: "#f14c4c",
  brightGreen: "#23d18b",
  brightYellow: "#f5f543",
  brightBlue: "#3b8eea",
  brightMagenta: "#d670d6",
  brightCyan: "#29b8db",
  brightWhite: "#ffffff",
};

const encoder = new TextEncoder();
let xterm: Terminal | null = null;
let fitAddon: FitAddon | null = null;
let resizeObserver: ResizeObserver | null = null;
let themeObserver: MutationObserver | null = null;
let lastCols = 0;
let lastRows = 0;

function currentTheme(): ITheme {
  return document.documentElement.classList.contains("dark")
    ? DARK_THEME
    : LIGHT_THEME;
}

/** 创建 xterm 并接线（terminalId 就绪后执行一次） */
async function mountXterm() {
  await nextTick();
  if (!host.value || xterm || !terminalStore.terminalId) return;
  xterm = new Terminal({
    fontFamily: '"JetBrains Mono Variable", "Cascadia Code", Consolas, monospace',
    fontSize: 13,
    cursorBlink: true,
    theme: currentTheme(),
    scrollback: 4000,
  });
  fitAddon = new FitAddon();
  xterm.loadAddon(fitAddon);
  xterm.open(host.value);
  fitAddon.fit();
  syncSize();
  xterm.onData((data) => terminalStore.write(encoder.encode(data)));
  xterm.focus();

  // 窗体尺寸变化（拖拽/最大化/窗口缩放）→ fit + 同步后端
  resizeObserver = new ResizeObserver(() => {
    try {
      fitAddon?.fit();
      syncSize();
    } catch {
      // 容器不可见时 fit 会抛错，忽略
    }
  });
  resizeObserver.observe(host.value);

  // 明暗主题跟随（.dark class 变化）
  themeObserver = new MutationObserver(() => {
    if (xterm) xterm.options.theme = currentTheme();
  });
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });

  terminalStore.setSink(
    (bytes) => xterm?.write(bytes),
    (status) => {
      xterm?.write(
        `\r\n\x1b[90m[进程已退出${status == null ? "" : `，退出码 ${status}`}] — 可关闭此窗口\x1b[0m\r\n`,
      );
    },
  );
}

function syncSize() {
  if (!xterm || !fitAddon) return;
  const { cols, rows } = xterm;
  if (cols !== lastCols || rows !== lastRows) {
    lastCols = cols;
    lastRows = rows;
    terminalStore.resize(cols, rows);
  }
}

function destroyXterm() {
  terminalStore.setSink(null, null);
  resizeObserver?.disconnect();
  resizeObserver = null;
  themeObserver?.disconnect();
  themeObserver = null;
  xterm?.dispose();
  xterm = null;
  fitAddon = null;
}

onBeforeUnmount(destroyXterm);

// 窗口关闭 → 销毁 xterm；terminalId 就绪 → 挂载
watch(
  () => terminalStore.open,
  (open) => {
    if (!open) destroyXterm();
  },
);
// terminalId 就绪 → 挂载 xterm。immediate 兜底：openIn 的 invoke 若快于面板
// 挂载完成，普通 watch 会错过赋值瞬间（mock 即时 resolve 时必现）
watch(
  () => terminalStore.terminalId,
  (id) => {
    if (id) void mountXterm();
  },
  { immediate: true },
);

/** 右下角拖拽调整窗体大小（宽 480–92vw / 高 240–90vh） */
function onResizeDown(e: PointerEvent) {
  if (maximized.value) return;
  dragging.value = true;
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  const startX = e.clientX;
  const startY = e.clientY;
  const startW = size.value.w;
  const startH = size.value.h;
  const onMove = (ev: PointerEvent) => {
    const maxW = Math.round(window.innerWidth * 0.92);
    const maxH = Math.round(window.innerHeight * 0.9);
    size.value = {
      w: Math.min(maxW, Math.max(480, startW + ev.clientX - startX)),
      h: Math.min(maxH, Math.max(240, startH + ev.clientY - startY)),
    };
  };
  const onUp = () => {
    dragging.value = false;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

function toggleMaximized() {
  maximized.value = !maximized.value;
}
</script>

<template>
  <Teleport to="body">
    <!-- 全页模糊遮罩（避开标题栏）+ 悬浮终端窗 -->
    <Transition name="editor-pop" appear>
      <div
        v-if="terminalStore.open"
        class="fixed inset-0 top-9 z-40 flex items-center justify-center p-6"
        :style="{
          background: 'color-mix(in srgb, var(--bg) 30%, rgba(0, 0, 0, 0.32))',
          backdropFilter: 'blur(6px)',
        }"
        @click.self="terminalStore.close()"
      >
        <div
          class="flex min-w-0 flex-col overflow-hidden"
          :style="{
            width: maximized ? 'auto' : `${size.w}px`,
            height: maximized ? 'auto' : `${size.h}px`,
            inset: maximized ? '20px' : undefined,
            position: maximized ? 'absolute' : undefined,
            transition: dragging ? 'none' : 'width 0.15s ease, height 0.15s ease',
            background: 'color-mix(in srgb, var(--surface-solid) 84%, transparent)',
            backdropFilter: 'blur(20px) saturate(1.15)',
            border: '1px solid var(--stroke-flyout)',
            borderRadius: '12px',
            boxShadow: '0 32px 64px rgba(0, 0, 0, 0.36)',
          }"
          role="dialog"
          aria-modal="true"
          aria-label="终端"
        >
          <!-- 标题栏（双击空白=最大化切换） -->
          <header
            class="flex h-10 shrink-0 items-center gap-2 px-3"
            @dblclick.self="toggleMaximized"
          >
            <SquareTerminal :size="15" class="shrink-0" :class="terminalStore.exited ? 'text-faint' : 'text-accent'" />
            <span class="text-[13px] font-semibold">终端</span>
            <span v-if="terminalStore.exited" class="text-xs text-faint">已结束</span>
            <span v-if="terminalStore.error" class="min-w-0 flex-1 truncate text-xs text-danger" :title="terminalStore.error">
              {{ terminalStore.error }}
            </span>
            <span class="min-w-0 flex-1" />
            <button
              type="button"
              class="btn-icon h-7 w-7"
              :title="maximized ? '还原' : '最大化'"
              :aria-label="maximized ? '还原终端窗口' : '最大化终端窗口'"
              @click="toggleMaximized"
            >
              <ChevronsDownUp v-if="maximized" :size="14" />
              <ChevronsUpDown v-else :size="14" />
            </button>
            <button
              type="button"
              class="btn-icon h-7 w-7"
              title="关闭终端"
              aria-label="关闭终端窗口"
              @click="terminalStore.close()"
            >
              <X :size="15" />
            </button>
          </header>

          <!-- xterm 挂载点（终端本体走自身黑/白底） -->
          <div class="relative min-h-0 flex-1">
            <div
              ref="host"
              class="absolute inset-0 overflow-hidden rounded-md px-1.5 pb-1"
              :style="{ background: currentTheme().background }"
            />

            <!-- 右下角拖拽调整大小 -->
            <div
              v-if="!maximized"
              class="absolute right-0 bottom-0 h-4 w-4 cursor-nwse-resize"
              title="拖拽调整大小"
              @pointerdown="onResizeDown"
            />
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
