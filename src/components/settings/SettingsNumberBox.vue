<script setup lang="ts">
/**
 * 数字输入（Files 设置页 NumberBox 语义，参照 AdvancedPage 缩略图缓存上限）：
 * 32px 高 Fluent 输入框 + 内联 −/+ 步进（WinUI SpinButtonPlacementMode="Inline"）。
 * 外观规格对齐 SettingsSelect（右侧控件位 h-8 w-35，fill-control 底 + line-strong 边）。
 */

import { computed, ref, watch } from "vue";

const props = withDefaults(
  defineProps<{
    modelValue: number;
    min: number;
    max: number;
    /** 无障碍名（不含当前值） */
    label: string;
    step?: number;
  }>(),
  { step: 1 },
);

const emit = defineEmits<{
  "update:modelValue": [value: number];
}>();

const draft = ref(String(props.modelValue));

watch(
  () => props.modelValue,
  (v) => {
    draft.value = String(v);
  },
);

const clamp = (v: number) => Math.min(props.max, Math.max(props.min, v));

const canStepDown = computed(() => props.modelValue > props.min);
const canStepUp = computed(() => props.modelValue < props.max);

function commit() {
  const parsed = Number(draft.value);
  if (!Number.isFinite(parsed)) {
    draft.value = String(props.modelValue);
    return;
  }
  const next = clamp(Math.round(parsed));
  if (next === props.modelValue) {
    draft.value = String(next);
  } else {
    emit("update:modelValue", next);
  }
}

function stepBy(dir: 1 | -1) {
  const next = clamp(props.modelValue + dir * props.step);
  if (next !== props.modelValue) emit("update:modelValue", next);
}
</script>

<template>
  <div class="flex h-8 w-35 shrink-0 items-stretch">
    <input
      v-model="draft"
      type="text"
      inputmode="numeric"
      class="min-w-0 flex-1 rounded-l-[4px] px-3 text-right font-mono text-sm tabular-nums text-ink outline-none"
      :style="{
        background: 'var(--fill-control)',
        borderTop: '1px solid var(--line-strong)',
        borderBottom: '1px solid var(--line-strong)',
        borderLeft: '1px solid var(--line-strong)',
      }"
      :aria-label="`${label}，范围 ${min} 到 ${max}`"
      @blur="commit"
      @keydown.enter.prevent="($event.target as HTMLInputElement).blur()"
    />
    <div
      class="flex w-6 shrink-0 flex-col"
      :style="{ border: '1px solid var(--line-strong)', borderLeft: 'none', borderRadius: '0 4px 4px 0' }"
    >
      <button
        type="button"
        class="flex flex-1 items-center justify-center text-dim transition-colors hover:bg-[var(--fill-subtle)] hover:text-ink disabled:opacity-40"
        :aria-label="`增大${label}`"
        :disabled="!canStepUp"
        @click="stepBy(1)"
      >
        <svg width="8" height="8" viewBox="0 0 8 8" fill="none" aria-hidden="true">
          <path d="M4 1.5 L7 6.5 H1 Z" fill="currentColor" />
        </svg>
      </button>
      <button
        type="button"
        class="flex flex-1 items-center justify-center border-t text-dim transition-colors hover:bg-[var(--fill-subtle)] hover:text-ink disabled:opacity-40"
        :style="{ borderColor: 'var(--line)' }"
        :aria-label="`减小${label}`"
        :disabled="!canStepDown"
        @click="stepBy(-1)"
      >
        <svg width="8" height="8" viewBox="0 0 8 8" fill="none" aria-hidden="true">
          <path d="M4 6.5 L1 1.5 H7 Z" fill="currentColor" />
        </svg>
      </button>
    </div>
  </div>
</template>
