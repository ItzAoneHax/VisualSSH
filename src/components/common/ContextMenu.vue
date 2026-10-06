<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from "vue";

import type { MenuItem } from "@/components/common/DropdownMenu.vue";

const props = defineProps<{
  open: boolean;
  /** 视口坐标 */
  x: number;
  y: number;
  items: MenuItem[];
}>();

const emit = defineEmits<{
  select: [key: string];
  close: [];
}>();

const MENU_WIDTH = 200;
const MENU_ITEM_HEIGHT = 36;

/** 靠近屏幕右/下边缘时向内收（MenuFlyout 定位策略的简化版） */
const position = computed(() => {
  const margin = 8;
  const estHeight = props.items.length * MENU_ITEM_HEIGHT + 16;
  return {
    left: Math.min(props.x, window.innerWidth - MENU_WIDTH - margin),
    top: Math.min(props.y, Math.max(window.innerHeight - estHeight - margin, margin)),
    maxHeight: `calc(100vh - 2 * ${margin}px)`,
  };
});

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") emit("close");
}

onMounted(() => window.addEventListener("keydown", onKeydown));
onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown));
</script>

<template>
  <div v-if="open">
    <!-- 点击外部关闭 -->
    <div class="fixed inset-0 z-40" @click="emit('close')" @contextmenu.prevent="emit('close')" />

    <!-- MenuFlyout：不透明实体表面 + 8 圆角 + 描边 + 阴影 -->
    <Transition name="popup">
      <div
        role="menu"
        class="fixed z-50 overflow-y-auto rounded-lg p-1 shadow-xl"
        :style="{
          left: `${position.left}px`,
          top: `${position.top}px`,
          maxHeight: position.maxHeight,
          minWidth: `${MENU_WIDTH}px`,
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
            class="flex h-8 w-full items-center gap-2.5 px-2.5 text-left text-sm transition-colors"
            :class="item.disabled ? 'cursor-not-allowed opacity-40' : 'hover:bg-fill-subtle'"
            :style="{ color: item.danger ? 'var(--danger)' : 'var(--ink)' }"
            :disabled="item.disabled"
            :aria-disabled="item.disabled"
            @click="!item.disabled && emit('select', item.key)"
          >
            <span class="flex w-4 shrink-0 justify-center">
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
