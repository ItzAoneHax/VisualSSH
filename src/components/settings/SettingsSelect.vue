<script setup lang="ts">
import { ChevronDown } from "@lucide/vue";
import { computed, ref } from "vue";

import DropdownMenu, { type MenuItem } from "@/components/common/DropdownMenu.vue";

/**
 * 设置页下拉单选（仿 WinUI ComboBox）：按钮 + MenuFlyout 单选列表，
 * 当前项打点、chevron 展开时翻转。
 */
const props = defineProps<{
  modelValue: string;
  options: { key: string; label: string }[];
  /** 无障碍名称（命名避开原生 aria-label 属性） */
  label: string;
}>();

const emit = defineEmits<{
  "update:modelValue": [key: string];
}>();

const open = ref(false);

const currentLabel = computed(
  () =>
    props.options.find((o) => o.key === props.modelValue)?.label ??
    props.options[0]?.label ??
    "",
);

const items = computed<MenuItem[]>(() =>
  props.options.map((o) => ({
    key: o.key,
    label: o.label,
    checked: o.key === props.modelValue,
  })),
);

function onSelect(key: string) {
  open.value = false;
  emit("update:modelValue", key);
}
</script>

<template>
  <div class="relative shrink-0">
    <button
      type="button"
      class="flex h-8 min-w-35 items-center justify-between gap-2 rounded-[4px] px-3 text-sm transition-colors hover:brightness-[0.98]"
      :style="{ background: 'var(--fill-control)', border: '1px solid var(--line-strong)' }"
      :aria-label="`${label}，当前 ${currentLabel}`"
      @click="open = !open"
    >
      <span class="truncate">{{ currentLabel }}</span>
      <ChevronDown :size="14" class="shrink-0 text-dim" :class="open && 'rotate-180'" />
    </button>
    <DropdownMenu :open="open" :items="items" @select="onSelect" @close="open = false" />
  </div>
</template>
