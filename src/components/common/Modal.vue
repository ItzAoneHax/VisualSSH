<script setup lang="ts">
import { X } from "@lucide/vue";

defineProps<{
  title: string;
  open: boolean;
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
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 backdrop-blur-[2px]"
        @click.self="emit('close')"
        @keydown.esc="emit('close')"
      >
        <div
          role="dialog"
          aria-modal="true"
          :aria-label="title"
          class="w-full max-w-md rounded-2xl border border-line bg-panel shadow-2xl"
        >
          <header class="flex items-center justify-between border-b border-line px-5 py-3.5">
            <h2 class="text-sm font-bold tracking-wide">{{ title }}</h2>
            <button type="button" class="btn-icon" aria-label="关闭" @click="emit('close')">
              <X :size="16" />
            </button>
          </header>
          <div class="px-5 py-4">
            <slot />
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
