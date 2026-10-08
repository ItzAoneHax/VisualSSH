<script setup lang="ts">
import { X } from "@lucide/vue";

import { useToastStore } from "@/stores/toast";

/** 全局轻提示（底部右侧浮出，可带动作按钮；块 C2） */
const toast = useToastStore();
</script>

<template>
  <div class="pointer-events-none fixed bottom-10 right-4 z-[60] flex flex-col gap-2">
    <TransitionGroup name="toast">
      <div
        v-for="item in toast.items"
        :key="item.id"
        class="pointer-events-auto flex items-center gap-3 rounded-lg px-3.5 py-2.5 shadow-lg"
        :style="{
          background: 'var(--surface-solid)',
          border: '1px solid var(--stroke-flyout)',
        }"
        role="status"
      >
        <span class="min-w-0 text-sm">{{ item.message }}</span>
        <button
          v-if="item.action"
          type="button"
          class="shrink-0 rounded-[4px] px-2 py-1 text-xs font-medium text-accent transition-colors hover:bg-fill-subtle"
          @click="item.action.run(); toast.dismiss(item.id)"
        >
          {{ item.action.label }}
        </button>
        <button
          type="button"
          class="btn-icon h-6 w-6 shrink-0"
          aria-label="关闭提示"
          @click="toast.dismiss(item.id)"
        >
          <X :size="13" />
        </button>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.toast-enter-active,
.toast-leave-active {
  transition: all 0.2s ease;
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(8px);
}
</style>
