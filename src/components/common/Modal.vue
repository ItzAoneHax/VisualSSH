<script setup lang="ts">
import { X } from "@lucide/vue";

defineProps<{
  title: string;
  open: boolean;
  /** 覆盖默认 max-w-md 的内容宽度（如冲突/属性对话框），单位 px */
  maxWidth?: number;
}>();

const emit = defineEmits<{
  close: [];
}>();
</script>

<template>
  <Teleport to="body">
    <Transition
      enter-active-class="transition duration-150 ease-out"
      enter-from-class="opacity-0"
      leave-active-class="transition duration-100 ease-in"
      leave-to-class="opacity-0"
    >
      <div
        v-if="open"
        class="fixed inset-0 z-50 flex items-center justify-center p-4"
        :style="{ background: '#0000004d' }"
        @click.self="emit('close')"
        @keydown.esc="emit('close')"
      >
        <!-- ContentDialog：8 圆角、不透明实体表面、Subtitle(20) 标题 -->
        <div
          role="dialog"
          aria-modal="true"
          :aria-label="title"
          class="w-full max-w-md rounded-lg p-6 shadow-2xl"
          :style="{ background: 'var(--surface-solid)', border: '1px solid var(--stroke-flyout)', maxWidth: maxWidth ? `${maxWidth}px` : undefined }"
        >
          <header class="mb-4 flex items-start justify-between gap-4">
            <h2 class="text-xl leading-7 font-semibold">{{ title }}</h2>
            <button type="button" class="btn-icon -mt-1 -mr-2" aria-label="关闭" @click="emit('close')">
              <X :size="16" />
            </button>
          </header>
          <slot />
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
