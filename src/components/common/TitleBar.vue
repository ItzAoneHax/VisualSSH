<script setup lang="ts">
import { Copy, Minus, Square, X } from "@lucide/vue";
import { onBeforeUnmount, onMounted, ref } from "vue";

/** 非表格下的默认标题高度 */
const hasTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const maximized = ref(false);
let unlisten: (() => void) | null = null;

onMounted(async () => {
  if (!hasTauri) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const appWindow = getCurrentWindow();
    maximized.value = await appWindow.isMaximized();
    unlisten = await appWindow.onResized(async () => {
      try {
        maximized.value = await appWindow.isMaximized();
      } catch {
        /* 窗口关闭竞态，忽略 */
      }
    });
  } catch {
    // 窗口 API 不可用时仅展示标题，不提供窗口控制
  }
});

onBeforeUnmount(() => unlisten?.());

async function callWindow(action: "minimize" | "toggleMaximize" | "close") {
  if (!hasTauri) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow()[action]();
  } catch {
    // 权限缺失或窗口已销毁时静默
  }
}
</script>

<template>
  <!-- 自绘标题栏：跟随应用主题；拖拽区双击可最大化/还原 -->
  <div
    class="flex h-9 shrink-0 items-stretch justify-between select-none"
    :style="{ background: 'var(--bg)' }"
  >
    <div
      class="flex min-w-0 flex-1 items-center gap-2 pl-3"
      data-tauri-drag-region
    >
      <img
        src="/favicon.svg"
        alt=""
        class="pointer-events-none h-4 w-4"
        draggable="false"
      />
      <span class="pointer-events-none text-xs font-medium text-dim">
        VisualSSH
      </span>
    </div>

    <!-- 窗口控制（Windows 规格：46px 宽按钮，关闭悬停红底） -->
    <div v-if="hasTauri" class="flex items-stretch">
      <button
        type="button"
        class="flex w-[46px] items-center justify-center text-dim transition-colors hover:bg-fill-subtle hover:text-ink"
        aria-label="最小化"
        title="最小化"
        @click="callWindow('minimize')"
      >
        <Minus :size="14" />
      </button>
      <button
        type="button"
        class="flex w-[46px] items-center justify-center text-dim transition-colors hover:bg-fill-subtle hover:text-ink"
        :aria-label="maximized ? '还原' : '最大化'"
        :title="maximized ? '还原' : '最大化'"
        @click="callWindow('toggleMaximize')"
      >
        <Square v-if="!maximized" :size="11" />
        <Copy v-else :size="11" class="-scale-x-100" />
      </button>
      <button
        type="button"
        class="flex w-[46px] items-center justify-center text-dim transition-colors hover:bg-[#c42b1c] hover:text-white"
        aria-label="关闭"
        title="关闭"
        @click="callWindow('close')"
      >
        <X :size="15" />
      </button>
    </div>
  </div>
</template>
