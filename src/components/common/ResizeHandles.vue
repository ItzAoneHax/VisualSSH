<script setup lang="ts">
import type { ResizeDir } from "@/composables/floatingResize";

/**
 * 悬浮窗全边界拖拽调整大小（与系统窗口一致）：四边 6px 细条 + 四角 12px 方块，
 * 透明覆盖在窗体最上层（本体 pointer-events-none，仅条块可命中）。
 * 边条两端内缩 12px 让位角块，避免角上光标被边条抢走。
 */

const emit = defineEmits<{ down: [e: PointerEvent, dir: ResizeDir] }>();

const HANDLES: { dir: ResizeDir; cls: string; title?: string }[] = [
  { dir: "n", cls: "inset-x-3 top-0 h-1.5 cursor-ns-resize" },
  { dir: "s", cls: "inset-x-3 bottom-0 h-1.5 cursor-ns-resize" },
  { dir: "w", cls: "inset-y-3 left-0 w-1.5 cursor-ew-resize" },
  { dir: "e", cls: "inset-y-3 right-0 w-1.5 cursor-ew-resize" },
  { dir: "nw", cls: "top-0 left-0 h-3 w-3 cursor-nwse-resize" },
  { dir: "ne", cls: "top-0 right-0 h-3 w-3 cursor-nesw-resize" },
  { dir: "sw", cls: "bottom-0 left-0 h-3 w-3 cursor-nesw-resize" },
  { dir: "se", cls: "bottom-0 right-0 h-3 w-3 cursor-nwse-resize", title: "拖拽调整大小" },
];
</script>

<template>
  <div class="pointer-events-none absolute inset-0 z-10">
    <div
      v-for="h in HANDLES"
      :key="h.dir"
      class="pointer-events-auto absolute"
      :class="h.cls"
      :data-resize-dir="h.dir"
      :title="h.title"
      @pointerdown="emit('down', $event, h.dir)"
    />
  </div>
</template>
