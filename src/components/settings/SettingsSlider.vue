<script setup lang="ts">
import { computed } from "vue";

/**
 * WinUI 3 默认 Slider（Files AppearancePage 的 Slider 原样，模板取自
 * microsoft-ui-xaml Slider_themeresources.xaml）：
 * - 轨道 4px 高 / 2px 圆角，未填段 ControlStrongFillColorDefault，已填段 accent
 * - 滑块 = 18px Thumb + Border margin -2 → 22px 外圆（ControlSolidFillColorDefault
 *   底 + 1px 描边），中心 12px accent 内圆；常态缩放 0.86 / hover 1.167 / 按下 0.71
 * - 滑块中心可达轨道两端（无收进）
 * 实体 DOM 绘制，原生 input 透明覆盖负责交互与键盘。
 */
const props = withDefaults(
  defineProps<{
    modelValue: number;
    label: string;
    min?: number;
    max?: number;
    step?: number;
  }>(),
  { min: 0.1, max: 1, step: 0.1 },
);

const emit = defineEmits<{
  "update:modelValue": [value: number];
}>();

/** 0–1 归一化位置 */
const norm = computed(() => {
  const p = (props.modelValue - props.min) / (props.max - props.min);
  return Math.min(1, Math.max(0, Number.isNaN(p) ? 0 : p));
});

const atNorm = computed(() => `${(norm.value * 100).toFixed(2)}%`);

function onInput(e: Event) {
  emit("update:modelValue", Number((e.target as HTMLInputElement).value));
}
</script>

<template>
  <div class="group/slider relative flex h-8 w-35 shrink-0 items-center">
    <div
      class="h-1 w-full overflow-hidden rounded-full"
      :style="{ background: 'var(--slider-track-rest)' }"
    >
      <div
        class="h-full rounded-full"
        :style="{ width: atNorm, background: 'var(--accent)' }"
      />
    </div>
    <!-- 外圆 22px（18px Thumb + margin -2）：实心底 + 1px 描边 -->
    <div
      class="pointer-events-none absolute top-1/2 flex h-[22px] w-[22px] items-center justify-center rounded-full"
      :style="{
        left: atNorm,
        translate: '-50% -50%',
        background: 'var(--slider-thumb-outer)',
        border: '1px solid var(--line-strong)',
      }"
    >
      <!-- 内圆 12px accent：0.86 / 1.167 / 0.71 状态缩放（同一变量通道避免相乘） -->
      <span
        class="block h-3 w-3 rounded-full transition-transform duration-200 ease-out group-hover/slider:[--thumb-scale:1.167] group-active/slider:[--thumb-scale:0.71]"
        :style="{ background: 'var(--accent)', transform: 'scale(var(--thumb-scale, 0.86))' }"
      />
    </div>
    <input
      type="range"
      class="absolute inset-0 h-full w-full cursor-pointer opacity-0"
      :min="min"
      :max="max"
      :step="step"
      :value="modelValue"
      :aria-label="label"
      @input="onInput"
    />
  </div>
</template>
