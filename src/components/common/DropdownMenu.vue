<script setup lang="ts">
import type { Component } from "vue";

import { computed, onBeforeUnmount, onMounted } from "vue";

export interface MenuItem {
  key: string;
  label: string;
  icon?: Component;
  danger?: boolean;
  checked?: boolean;
  separator?: boolean;
  /** 未实现/不适用的操作置灰，不 emit */
  disabled?: boolean;
  /** 置灰原因等悬浮提示（ContextMenu 透传 title） */
  title?: string;
  /** 进顶部一级图标命令行（Win11 右键菜单 38×38 图标按钮；
   *  Files FastContextFlyout.cs IsPrimary 过滤，App.xaml:37-86 PrimaryCommandButtonStyle） */
  primary?: boolean;
  /** 快捷键提示列文本（如 "Ctrl+C"；仅标真实存在的绑定；
   *  MenuFlyoutItemWithImage.xaml:67-79 Caption 右对齐、左距 24） */
  accelerator?: string;
}

const props = defineProps<{
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

/** 折叠连续分隔线并去首尾（Files FastContextFlyout.TrimSeparators 同款防御） */
const listItems = computed(() => {
  const out: MenuItem[] = [];
  for (const item of props.items) {
    if (item.separator && (out.length === 0 || out[out.length - 1].separator)) continue;
    out.push(item);
  }
  while (out.length && out[out.length - 1].separator) out.pop();
  return out;
});

onMounted(() => window.addEventListener("keydown", onKeydown));
onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown));
</script>

<template>
  <div v-if="open" class="relative">
    <!-- 点击外部关闭 -->
    <div class="fixed inset-0 z-40" @click="emit('close')" @contextmenu.prevent="emit('close')" />

    <!-- MenuFlyout：亚克力表面（menu-surface 按窗口材质分级不透明度）+ 8 圆角 + 描边 -->
    <Transition name="popup">
      <div
        role="menu"
        class="menu-surface absolute right-0 z-50 mt-1 min-w-44 rounded-lg p-1 shadow-xl"
        :style="{
          backdropFilter: 'blur(20px) saturate(1.15)',
          WebkitBackdropFilter: 'blur(20px) saturate(1.15)',
          border: '1px solid var(--stroke-flyout)',
        }"
      >
        <template v-for="item in listItems" :key="item.key">
          <div v-if="item.separator" class="mx-2 my-1 h-px" :style="{ background: 'var(--line)' }" />
          <button
            v-else
            type="button"
            role="menuitem"
            class="flex h-8 w-full items-center gap-2.5 rounded-[2px] px-2.5 text-left text-sm transition-colors"
            :class="item.disabled ? 'cursor-not-allowed opacity-40' : 'hover:bg-fill-subtle'"
            :style="{ color: item.danger ? 'var(--danger)' : 'var(--ink)' }"
            :disabled="item.disabled"
            :aria-disabled="item.disabled"
            @click="!item.disabled && emit('select', item.key)"
          >
            <span class="flex w-4 justify-center">
              <component :is="item.icon" v-if="item.icon" :size="16" class="text-dim" />
              <span
                v-else-if="item.checked"
                class="h-[7px] w-[7px] rounded-full"
                :style="{ background: 'var(--accent)' }"
              />
            </span>
            <span class="min-w-0 flex-1 truncate">{{ item.label }}</span>
            <!-- 快捷键提示列（MenuFlyoutItemWithImage.xaml:67-79：Caption 右对齐、左距 24） -->
            <span v-if="item.accelerator" class="ml-6 shrink-0 text-xs text-dim">
              {{ item.accelerator }}
            </span>
          </button>
        </template>
      </div>
    </Transition>
  </div>
</template>
