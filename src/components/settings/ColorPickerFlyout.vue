<script setup lang="ts">
import { ChevronDown } from "@lucide/vue";
import { computed, reactive, ref, watch } from "vue";

/**
 * 紧凑取色器（仿 Files 背景色的 wct ColorPicker：IsColorSpectrumVisible=False
 * + IsAlphaEnabled=True —— 无色轮，仅预览/HEX/RGB/不透明度输入）。
 * 触发按钮 = 棋盘格底 + 当前色 24×24 色块 + chevron；颜色即时应用（TwoWay）。
 * 存储格式统一 CSS #RRGGBBAA（8 位）。
 */
const props = defineProps<{ color: string }>();
const emit = defineEmits<{ update: [color: string] }>();

const open = ref(false);

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number; // 0-255
}

function parseHex(input: string): Rgba | null {
  const m = input.trim().replace(/^#/, "");
  const full = m.length === 3 || m.length === 4
    ? m.split("").map((c) => c + c).join("")
    : m;
  if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(full)) return null;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  const a = full.length === 8 ? parseInt(full.slice(6, 8), 16) : 255;
  return { r, g, b, a };
}

function toHex8(c: Rgba): string {
  const hex = (n: number) => n.toString(16).padStart(2, "0").toUpperCase();
  return `#${hex(c.r)}${hex(c.g)}${hex(c.b)}${hex(c.a)}`;
}

/** props.color → 编辑通道；HEX 文本单独维护（输入中间态不合法时保留原文） */
const channels = reactive<Rgba>({ r: 0, g: 0, b: 0, a: 255 });
const hexText = ref("#00000000");

function syncFromProp() {
  const parsed = parseHex(props.color) ?? { r: 0, g: 0, b: 0, a: 0 };
  channels.r = parsed.r;
  channels.g = parsed.g;
  channels.b = parsed.b;
  channels.a = parsed.a;
  hexText.value = toHex8(parsed);
}

watch(() => props.color, syncFromProp, { immediate: true });

function apply() {
  const hex = toHex8({ ...channels });
  hexText.value = hex;
  emit("update", hex);
}

function onHexCommit() {
  const parsed = parseHex(hexText.value);
  if (parsed) {
    channels.r = parsed.r;
    channels.g = parsed.g;
    channels.b = parsed.b;
    channels.a = parsed.a;
    apply();
  } else {
    hexText.value = toHex8({ ...channels });
  }
}

function channelInput(e: Event, key: keyof Rgba, max: number) {
  const raw = (e.target as HTMLInputElement).value;
  const n = Math.min(max, Math.max(0, Number.parseInt(raw, 10)));
  if (Number.isNaN(n)) {
    (e.target as HTMLInputElement).value = String(channels[key]);
    return;
  }
  channels[key] = n;
  (e.target as HTMLInputElement).value = String(n);
  apply();
}

const alphaPercent = computed(() => Math.round((channels.a / 255) * 100));

function onAlphaInput(e: Event) {
  const raw = (e.target as HTMLInputElement).value;
  const n = Math.min(100, Math.max(0, Number.parseInt(raw, 10)));
  if (Number.isNaN(n)) {
    (e.target as HTMLInputElement).value = String(alphaPercent.value);
    return;
  }
  channels.a = Math.round((n / 100) * 255);
  (e.target as HTMLInputElement).value = String(n);
  apply();
}

const previewStyle = computed(() => ({
  background: `rgba(${channels.r}, ${channels.g}, ${channels.b}, ${channels.a / 255})`,
}));
</script>

<template>
  <div class="relative shrink-0">
    <!-- 触发按钮：棋盘格 + 当前色 + chevron（Files AppearancePage 色块按钮） -->
    <button
      type="button"
      class="flex h-8 items-center gap-1.5 rounded-[4px] px-1.5 transition-colors hover:brightness-[0.98]"
      :style="{ background: 'var(--fill-control)', border: '1px solid var(--line-strong)' }"
      :aria-label="`自定义背景色，当前 ${hexText}`"
      @click="open = !open"
    >
      <span
        class="alpha-checker h-6 w-6 overflow-hidden rounded-[4px]"
        :style="{ border: '1px solid var(--line)' }"
      >
        <span class="block h-full w-full" :style="previewStyle" />
      </span>
      <ChevronDown :size="13" class="text-dim" :class="open && 'rotate-180'" />
    </button>

    <div v-if="open">
      <div class="fixed inset-0 z-40" @click="open = false" />
      <div
        class="absolute right-0 z-50 mt-1 w-64 rounded-lg p-3 shadow-xl"
        :style="{ background: 'var(--surface-solid)', border: '1px solid var(--stroke-flyout)' }"
      >
        <div class="flex items-center gap-2.5">
          <span
            class="alpha-checker h-9 w-9 shrink-0 overflow-hidden rounded-[4px]"
            :style="{ border: '1px solid var(--line)' }"
          >
            <span class="block h-full w-full" :style="previewStyle" />
          </span>
          <label class="flex min-w-0 flex-1 flex-col gap-1">
            <span class="text-[11px] font-medium text-dim">十六进制</span>
            <input
              v-model="hexText"
              class="field-input h-7 px-2 font-mono text-xs uppercase"
              spellcheck="false"
              aria-label="十六进制颜色值"
              @change="onHexCommit"
              @keydown.enter.prevent="onHexCommit"
            />
          </label>
        </div>

        <div class="mt-3 grid grid-cols-3 gap-2">
          <label
            v-for="key in (['r', 'g', 'b'] as const)"
            :key="key"
            class="flex flex-col gap-1"
          >
            <span class="text-[11px] font-medium text-dim">
              {{ key === "r" ? "R 红" : key === "g" ? "G 绿" : "B 蓝" }}
            </span>
            <input
              type="number"
              min="0"
              max="255"
              :value="channels[key]"
              class="field-input h-7 px-2 font-mono text-xs tabular-nums"
              :aria-label="`${key} 通道`"
              @input="channelInput($event, key, 255)"
            />
          </label>
        </div>

        <label class="mt-2 flex flex-col gap-1">
          <span class="text-[11px] font-medium text-dim">不透明度</span>
          <div class="relative">
            <input
              type="number"
              min="0"
              max="100"
              :value="alphaPercent"
              class="field-input h-7 pr-7 pl-2 font-mono text-xs tabular-nums"
              aria-label="不透明度百分比"
              @input="onAlphaInput"
            />
            <span class="absolute top-1/2 right-2 -translate-y-1/2 text-xs text-dim">%</span>
          </div>
        </label>
      </div>
    </div>
  </div>
</template>
