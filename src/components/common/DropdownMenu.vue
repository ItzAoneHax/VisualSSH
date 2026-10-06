<script setup lang="ts">
import type { Component } from "vue";

import { onBeforeUnmount, onMounted } from "vue";

export interface MenuItem {
  key: string;
  label: string;
  icon?: Component;
  danger?: boolean;
  checked?: boolean;
  separator?: boolean;
  /** 未实现/不适用的操作置灰，不 emit */
  disabled?: boolean;
}

defineProps<{
  open: boolean;
  items: MenuItem[];
}>();

const emit = defineEmits<{
  select: [key: string];
  close: [];
}>();

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") emit("close");
}

onMounted(() => window.addEventListener("keydown", onKeydown));
onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown));
</script>

<template>
  <div v-if="open" class="relative">
    <!-- 点击外部关闭 -->
    <div class="fixed inset-0 z-40" @click="emit('close')" @contextmenu.prevent="emit('close')" />

    <!-- MenuFlyout：8 圆角卡片 + 1px 描边 -->
    <Transition name="popup">
      <div
        role="menu"
        class="absolute right-0 z-50 mt-1 min-w-44 rounded-lg p-1 shadow-xl"
        :style="{
          background: 'var(--surface-solid)',
          border: '1px solid var(--stroke-flyout)',
        }"
      >
        <template v-for="item in items" :key="item.key">
          <div v-if="item.separator" class="mx-2 my-1 h-px" :style="{ background: 'var(--line)' }" />
          <button
            v-else
            type="button"
            role="menuitem"
            class="flex h-8 w-full items-center gap-2.5 rounded-[4px] px-2.5 text-left text-sm transition-colors"
            :class="item.disabled ? 'cursor-not-allowed opacity-40' : 'hover:bg-fill-subtle'"
            :style="{ color: item.danger ? 'var(--danger)' : 'var(--ink)' }"
            :disabled="item.disabled"
            :aria-disabled="item.disabled"
            @click="!item.disabled && emit('select', item.key)"
          >
            <span class="flex w-4 justify-center">
              <component :is="item.icon" v-if="item.icon" :size="15" class="text-dim" />
              <span
                v-else-if="item.checked"
                class="h-[7px] w-[7px] rounded-full"
                :style="{ background: 'var(--accent)' }"
              />
            </span>
            {{ item.label }}
          </button>
        </template>
      </div>
    </Transition>
  </div>
</template>
