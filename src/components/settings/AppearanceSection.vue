<script setup lang="ts">
import {
  Code,
  Image as ImageIcon,
  Paintbrush,
  Palette,
  PanelBottom,
  Rows3,
  SquareTerminal,
  X,
  ArrowDownUp,
} from "@lucide/vue";
import { ChevronDown } from "@lucide/vue";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { computed, ref } from "vue";
import { storeToRefs } from "pinia";

import ColorPickerFlyout from "@/components/settings/ColorPickerFlyout.vue";
import SettingsExpander from "@/components/settings/SettingsExpander.vue";
import SettingsSelect from "@/components/settings/SettingsSelect.vue";
import SettingsSlider from "@/components/settings/SettingsSlider.vue";
import { useSettingsStore, type ThemeMode } from "@/stores/settings";

/**
 * 外观分区（仿 Files AppearancePage）：
 * 主题三态 → 应用背景色（预设色卡 + 紧凑取色器）→ 背景图片（浏览/移除 +
 * 不透明度/契合方式/对齐）→ 字号 → 状态栏。文案与预设色取自 Files zh-Hans 资源。
 */
const settings = useSettingsStore();
// storeToRefs：update() 整体替换 settings.value，直接取 settings.settings 会拿到冻结快照
const { settings: s } = storeToRefs(settings);

const THEME_MODES: { key: ThemeMode; label: string }[] = [
  { key: "system", label: "跟随系统" },
  { key: "light", label: "浅色" },
  { key: "dark", label: "深色" },
];

/** 预设背景色卡（Files AppThemeResourceFactory：0x32 即 20% 不透明度；
 *  XAML #AARRGGBB 已转 CSS #RRGGBBAA；上游 Red/RoseBright 色值重复，保留其一） */
const BG_PRESETS: { color: string; name: string }[] = [
  { color: "#00000000", name: "默认" },
  { color: "#FFB90032", name: "金黄色" },
  { color: "#F7630C32", name: "浅橙色" },
  { color: "#D1343832", name: "砖红色" },
  { color: "#FF434332", name: "鸢红色" },
  { color: "#EA005E32", name: "红色" },
  { color: "#0078D732", name: "蓝色" },
  { color: "#8764B832", name: "粉鸢尾花色" },
  { color: "#B146C232", name: "菖蒲色" },
  { color: "#0099BC32", name: "浅蓝色" },
  { color: "#00B7C332", name: "海泡石" },
  { color: "#00B29432", name: "天青色" },
  { color: "#7A757432", name: "灰色" },
  { color: "#107C1032", name: "绿色" },
  { color: "#76767632", name: "阴天" },
  { color: "#4C4A4832", name: "风暴" },
  { color: "#69797E32", name: "蓝灰色" },
  { color: "#4A545932", name: "暗灰色" },
  { color: "#7E735F32", name: "迷彩色" },
];

/** 当前色不在预设中时追加「自定义」卡（Files UpdateSelectedResource） */
const swatches = computed(() =>
  BG_PRESETS.some((p) => p.color === s.value.bgColor)
    ? BG_PRESETS
    : [...BG_PRESETS, { color: s.value.bgColor, name: "自定义" }],
);

/** —— 背景图片 ——（Files 图像过滤器后缀清单） */
const IMAGE_FILTERS = [
  {
    name: "图像文件",
    extensions: [
      "bmp", "dib", "jpg", "jpeg", "jpe", "jfif", "gif",
      "tif", "tiff", "png", "heic", "hif", "webp",
    ],
  },
];

async function browseImage() {
  try {
    const path = await openFileDialog({ multiple: false, filters: IMAGE_FILTERS });
    if (typeof path === "string") settings.update({ bgImage: path });
  } catch {
    // 对话框取消或不可用
  }
}

const removeMenuOpen = ref(false);
function removeImage() {
  removeMenuOpen.value = false;
  settings.update({ bgImage: "" });
}

const FIT_OPTIONS = [
  { key: "none", label: "无" },
  { key: "fill", label: "填充" },
  { key: "uniform", label: "均匀" },
  { key: "uniformToFill", label: "均匀填充" },
];
const VALIGN_OPTIONS = [
  { key: "start", label: "顶部" },
  { key: "center", label: "居中" },
  { key: "end", label: "底部" },
];
const HALIGN_OPTIONS = [
  { key: "start", label: "左" },
  { key: "center", label: "居中" },
  { key: "end", label: "右" },
];

/** 传输中心入口可见性（Files StatusCenterVisibility：始终 / 仅传输进行中） */
const TRANSFER_VISIBILITY_OPTIONS = [
  { key: "always", label: "始终显示" },
  { key: "activeOnly", label: "仅传输进行中显示" },
];

/** 详情视图行高密度（LayoutSizeKindHelper.GetDetailsViewRowHeight 五档） */
const ROW_HEIGHT_OPTIONS = [
  { key: "28", label: "紧凑（28px）" },
  { key: "36", label: "小（36px）" },
  { key: "40", label: "中（40px）" },
  { key: "44", label: "大（44px）" },
  { key: "48", label: "特大（48px）" },
];

/** —— 字号步进（编辑器 11–20 / 终端 10–20） —— */
function stepFontSize(which: "editorFontSize" | "terminalFontSize", delta: number) {
  const min = which === "editorFontSize" ? 11 : 10;
  const next = Math.min(20, Math.max(min, s.value[which] + delta));
  settings.update({ [which]: next });
}
</script>

<template>
  <h2 class="text-xl font-semibold">外观</h2>
  <p class="mt-1 mb-4 text-xs text-dim">配置应用的视觉表现。</p>

  <div class="flex flex-col gap-1">
    <!-- 应用主题 -->
    <div class="settings-card">
      <Palette :size="20" class="shrink-0 text-dim" />
      <div class="min-w-0 flex-1">
        <p class="text-sm font-medium">应用主题</p>
        <p class="mt-0.5 text-xs text-dim">选择应用的外观主题。</p>
      </div>
      <div
        class="flex shrink-0 rounded-md p-0.5"
        :style="{ background: 'var(--fill-subtle)', border: '1px solid var(--line)' }"
      >
        <button
          v-for="mode in THEME_MODES"
          :key="mode.key"
          type="button"
          class="rounded-[4px] px-2.5 py-1 text-xs font-medium transition-colors"
          :class="s.theme === mode.key ? 'text-ink' : 'text-dim hover:text-ink'"
          :style="
            s.theme === mode.key
              ? { background: 'var(--surface-solid)', boxShadow: '0 1px 2px rgba(0,0,0,0.16)' }
              : undefined
          "
          @click="settings.update({ theme: mode.key })"
        >
          {{ mode.label }}
        </button>
      </div>
    </div>

    <!-- 应用背景色：预设色卡 + 自定义取色器 -->
    <SettingsExpander
      :icon="Paintbrush"
      title="应用背景色"
      description="为应用背景选择颜色。"
      default-open
    >
      <template #control>
        <ColorPickerFlyout
          :color="s.bgColor"
          @update="(color) => settings.update({ bgColor: color })"
        />
      </template>
      <template #items>
        <!-- 色卡（Files AppThemeResourcesItemTemplate：小窗预览 = 标签条 + 文件区），5 等分撑满一行 -->
        <div class="grid grid-cols-5 gap-2 p-2" role="listbox" aria-label="预设背景色">
          <button
            v-for="sw in swatches"
            :key="sw.color + sw.name"
            type="button"
            role="option"
            :aria-selected="s.bgColor === sw.color"
            :title="sw.name"
            class="overflow-hidden rounded-md text-center transition-shadow"
            :style="{
              border: '1px solid ' + (s.bgColor === sw.color ? 'var(--accent)' : 'var(--line-strong)'),
              boxShadow: s.bgColor === sw.color ? '0 0 0 1px var(--accent)' : undefined,
            }"
            @click="settings.update({ bgColor: sw.color })"
          >
            <span class="block h-[66px] overflow-hidden rounded-t-[4px]" :style="{ background: sw.color }">
              <!-- 标签条 mock：分隔线 + 32×12 页签 + 分隔线 -->
              <span class="flex h-4 items-end">
                <span class="h-px w-1 shrink-0" :style="{ background: 'var(--line-strong)' }" />
                <span
                  class="h-3 w-8 shrink-0 rounded-t-[4px]"
                  :style="{ background: 'var(--panel-solid)', border: '1px solid var(--line-strong)', borderBottom: 'none' }"
                />
                <span class="h-px min-w-0 flex-1" :style="{ background: 'var(--line-strong)' }" />
              </span>
              <!-- 文件区 mock -->
              <span
                class="block h-[50px]"
                :style="{ background: 'var(--panel-solid)', borderBottom: '1px solid var(--line)' }"
              />
            </span>
            <span class="block truncate px-1 py-1 text-xs text-dim">{{ sw.name }}</span>
          </button>
        </div>
      </template>
    </SettingsExpander>

    <!-- 背景图片：浏览/移除 + 不透明度/契合方式/对齐 -->
    <SettingsExpander
      :icon="ImageIcon"
      title="背景图片"
      :description="s.bgImage || undefined"
    >
      <template #control>
        <!-- SplitButton：主按钮浏览，下拉「移除」 -->
        <div
          class="relative flex h-8 shrink-0 overflow-hidden rounded-[4px]"
          :style="{ background: 'var(--fill-control)', border: '1px solid var(--line-strong)' }"
        >
          <button
            type="button"
            class="px-3 text-sm transition-colors hover:brightness-[0.98]"
            aria-label="浏览背景图片"
            @click="browseImage"
          >
            浏览
          </button>
          <div class="w-px" :style="{ background: 'var(--line-strong)' }" />
          <button
            type="button"
            class="flex w-7 items-center justify-center text-dim transition-colors hover:bg-fill-subtle hover:text-ink"
            aria-label="背景图片更多操作"
            @click="removeMenuOpen = !removeMenuOpen"
          >
            <ChevronDown :size="13" :class="removeMenuOpen && 'rotate-180'" />
          </button>
          <div v-if="removeMenuOpen" class="absolute top-8 right-0 z-50">
            <div class="fixed inset-0 -z-10" @click="removeMenuOpen = false" />
            <div
              class="mt-1 min-w-28 rounded-lg p-1 shadow-xl"
              :style="{ background: 'var(--surface-solid)', border: '1px solid var(--stroke-flyout)' }"
            >
              <button
                type="button"
                class="flex h-8 w-full items-center gap-2.5 rounded-[2px] px-2.5 text-left text-sm transition-colors hover:bg-fill-subtle"
                :disabled="!s.bgImage"
                :class="!s.bgImage && 'cursor-not-allowed opacity-40'"
                @click="removeImage"
              >
                <X :size="15" class="text-dim" />
                移除
              </button>
            </div>
          </div>
        </div>
      </template>
      <template #items>
        <div class="settings-expander-item">
          <div class="min-w-0 flex-1">
            <p class="text-sm font-medium">不透明度</p>
          </div>
          <SettingsSlider
            :model-value="s.bgImageOpacity"
            label="背景图片不透明度"
            @update:model-value="(v) => settings.update({ bgImageOpacity: v })"
          />
        </div>
        <div class="settings-expander-item">
          <div class="min-w-0 flex-1">
            <p class="text-sm font-medium">图片契合方式</p>
          </div>
          <SettingsSelect
            :model-value="s.bgImageFit"
            :options="FIT_OPTIONS"
            label="图片契合方式"
            @update:model-value="(key) => settings.update({ bgImageFit: key as typeof s.bgImageFit })"
          />
        </div>
        <div class="settings-expander-item">
          <div class="min-w-0 flex-1">
            <p class="text-sm font-medium">垂直对齐方式</p>
          </div>
          <SettingsSelect
            :model-value="s.bgImageVAlign"
            :options="VALIGN_OPTIONS"
            label="垂直对齐方式"
            @update:model-value="(key) => settings.update({ bgImageVAlign: key as typeof s.bgImageVAlign })"
          />
        </div>
        <div class="settings-expander-item">
          <div class="min-w-0 flex-1">
            <p class="text-sm font-medium">水平对齐方式</p>
          </div>
          <SettingsSelect
            :model-value="s.bgImageHAlign"
            :options="HALIGN_OPTIONS"
            label="水平对齐方式"
            @update:model-value="(key) => settings.update({ bgImageHAlign: key as typeof s.bgImageHAlign })"
          />
        </div>
      </template>
    </SettingsExpander>

    <!-- 编辑器字号 -->
    <div class="settings-card">
      <Code :size="20" class="shrink-0 text-dim" />
      <div class="min-w-0 flex-1">
        <p class="text-sm font-medium">编辑器字号</p>
        <p class="mt-0.5 text-xs text-dim">内置编辑器正文字号。</p>
      </div>
      <div class="flex shrink-0 items-center gap-1">
        <button
          type="button"
          class="btn-icon h-7 w-7"
          aria-label="减小字号"
          :disabled="s.editorFontSize <= 11"
          @click="stepFontSize('editorFontSize', -1)"
        >
          −
        </button>
        <span class="w-10 text-center font-mono text-sm tabular-nums">{{ s.editorFontSize }} px</span>
        <button
          type="button"
          class="btn-icon h-7 w-7"
          aria-label="增大字号"
          :disabled="s.editorFontSize >= 20"
          @click="stepFontSize('editorFontSize', 1)"
        >
          +
        </button>
      </div>
    </div>

    <!-- 终端字号 -->
    <div class="settings-card">
      <SquareTerminal :size="20" class="shrink-0 text-dim" />
      <div class="min-w-0 flex-1">
        <p class="text-sm font-medium">终端字号</p>
        <p class="mt-0.5 text-xs text-dim">内置终端的等宽字号。</p>
      </div>
      <div class="flex shrink-0 items-center gap-1">
        <button
          type="button"
          class="btn-icon h-7 w-7"
          aria-label="减小字号"
          :disabled="s.terminalFontSize <= 10"
          @click="stepFontSize('terminalFontSize', -1)"
        >
          −
        </button>
        <span class="w-10 text-center font-mono text-sm tabular-nums">{{ s.terminalFontSize }} px</span>
        <button
          type="button"
          class="btn-icon h-7 w-7"
          aria-label="增大字号"
          :disabled="s.terminalFontSize >= 20"
          @click="stepFontSize('terminalFontSize', 1)"
        >
          +
        </button>
      </div>
    </div>

    <!-- 行高密度（文件区 Ctrl+滚轮可快速升降档） -->
    <div class="settings-card">
      <Rows3 :size="20" class="shrink-0 text-dim" />
      <div class="min-w-0 flex-1">
        <p class="text-sm font-medium">文件列表行高</p>
        <p class="mt-0.5 text-xs text-dim">详情视图行高密度，文件区按住 Ctrl 滚动可快速调整。</p>
      </div>
      <SettingsSelect
        :model-value="String(s.detailsRowHeight)"
        :options="ROW_HEIGHT_OPTIONS"
        label="文件列表行高"
        @update:model-value="(key) => settings.update({ detailsRowHeight: Number(key) })"
      />
    </div>

    <!-- 传输中心入口可见性 -->
    <div class="settings-card">
      <ArrowDownUp :size="20" class="shrink-0 text-dim" />
      <div class="min-w-0 flex-1">
        <p class="text-sm font-medium">传输中心</p>
        <p class="mt-0.5 text-xs text-dim">控制工具栏中传输中心入口的显示时机。</p>
      </div>
      <SettingsSelect
        :model-value="s.transferCenterVisibility"
        :options="TRANSFER_VISIBILITY_OPTIONS"
        label="传输中心可见性"
        @update:model-value="(key) => settings.update({ transferCenterVisibility: key as typeof s.transferCenterVisibility })"
      />
    </div>

    <!-- 显示状态栏 -->
    <div class="settings-card">
      <PanelBottom :size="20" class="shrink-0 text-dim" />
      <div class="min-w-0 flex-1">
        <p class="text-sm font-medium">显示状态栏</p>
        <p class="mt-0.5 text-xs text-dim">在窗口底部显示项目统计与连接状态。</p>
      </div>
      <button
        type="button"
        role="switch"
        :aria-checked="s.showStatusBar"
        class="toggle-switch"
        :class="s.showStatusBar && 'on'"
        @click="settings.update({ showStatusBar: !s.showStatusBar })"
      >
        <span class="toggle-knob" />
      </button>
    </div>
  </div>
</template>
