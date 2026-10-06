<script setup lang="ts">
import { ChevronsDownUp, ChevronsUpDown, SquareTerminal, X } from "@lucide/vue";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal, type ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { nextTick, onBeforeUnmount, ref, watch } from "vue";

import { useTerminalStore } from "@/stores/terminal";

/**
 * 底部终端面板：默认高 35%、顶边拖拽调高（15%–85%）、可最大化/还原、可关闭。
 * xterm.js 双向转发：onData → ssh_terminal_write；terminal://data → xterm.write。
 * fit addon 自适应面板尺寸，变化时同步 ssh_terminal_resize；主题跟随明暗。
 */

const terminalStore = useTerminalStore();

const basis = ref("35%");
const dragging = ref(false);
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

  // 面板尺寸变化（拖拽/最大化/窗口缩放）→ fit + 同步后端
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
        `\r\n\x1b[90m[进程已退出${status == null ? "" : `，退出码 ${status}`}] — 可关闭此面板\x1b[0m\r\n`,
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

// 面板打开 → 等 terminalId → 挂载 xterm；关闭/退出 → 销毁
watch(
  () => terminalStore.open,
  (open) => {
    if (!open) destroyXterm();
  },
);
watch(
  () => terminalStore.terminalId,
  (id) => {
    if (id) void mountXterm();
  },
);

/** 顶边拖拽调高：按主列高度换算 15%–85% */
function onHandleDown(e: PointerEvent) {
  if (terminalStore.open === false) return;
  const pane = (e.currentTarget as HTMLElement).closest("[data-main-col]") as HTMLElement | null;
  if (!pane) return;
  dragging.value = true;
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  const paneRect = pane.getBoundingClientRect();
  const onMove = (ev: PointerEvent) => {
    const pct = ((paneRect.bottom - ev.clientY) / paneRect.height) * 100;
    basis.value = `${Math.min(85, Math.max(15, pct)).toFixed(1)}%`;
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

const maximized = ref(false);
</script>

<template>
  <!-- 底部滑出终端面板（主列 flex 成员） -->
  <div
    v-if="terminalStore.open"
    class="flex shrink-0 flex-col overflow-hidden rounded-lg"
    :style="{
      flexBasis: maximized ? 'calc(100% - 2rem)' : basis,
      transition: dragging ? 'none' : 'flex-basis 0.2s ease',
      background: 'var(--toolbar)',
      border: '1px solid var(--line)',
    }"
    role="complementary"
    aria-label="终端"
  >
    <!-- 顶边拖拽把手 -->
    <div class="h-1.5 shrink-0 cursor-row-resize" @pointerdown="onHandleDown" @dblclick="toggleMaximized" />

    <!-- 标题栏 -->
    <header class="flex h-9 shrink-0 items-center gap-2 px-2.5">
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
        :aria-label="maximized ? '还原终端面板' : '最大化终端面板'"
        @click="toggleMaximized"
      >
        <ChevronsDownUp v-if="maximized" :size="14" />
        <ChevronsUpDown v-else :size="14" />
      </button>
      <button
        type="button"
        class="btn-icon h-7 w-7"
        title="关闭终端"
        aria-label="关闭终端面板"
        @click="terminalStore.close()"
      >
        <X :size="15" />
      </button>
    </header>

    <!-- xterm 挂载点（终端本体走自身黑/白底，不套卡片样式） -->
    <div
      ref="host"
      class="min-h-0 flex-1 overflow-hidden rounded-md px-1.5 pb-1"
      :style="{ background: currentTheme().background }"
    />
  </div>
</template>
