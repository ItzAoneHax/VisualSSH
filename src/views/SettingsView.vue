<script setup lang="ts">
import { ArrowLeft, Info, Palette, ShieldCheck, SlidersHorizontal } from "@lucide/vue";
import { ref, type Component } from "vue";

import AboutSection from "@/components/settings/AboutSection.vue";
import AppearanceSection from "@/components/settings/AppearanceSection.vue";
import PreferencesSection from "@/components/settings/PreferencesSection.vue";
import SecuritySection from "@/components/settings/SecuritySection.vue";
import { useSettingsStore } from "@/stores/settings";

/**
 * 设置页 —— 布局仿 files-community/Files（SidebarView 240px 导航 +
 * SettingsCard 卡片），各分区拆分为独立组件（外观/首选项/SSH 安全/关于）。
 */
const settings = useSettingsStore();

type Section = "appearance" | "preferences" | "security" | "about";

const sections: { key: Section; label: string; icon: Component }[] = [
  { key: "appearance", label: "外观", icon: Palette },
  { key: "preferences", label: "首选项", icon: SlidersHorizontal },
  { key: "security", label: "SSH 安全", icon: ShieldCheck },
  { key: "about", label: "关于", icon: Info },
];

const sectionViews: Record<Section, Component> = {
  appearance: AppearanceSection,
  preferences: PreferencesSection,
  security: SecuritySection,
  about: AboutSection,
};

const section = ref<Section>("appearance");

const sectionTitles: Record<Section, string> = {
  appearance: "外观",
  preferences: "首选项",
  security: "SSH 安全",
  about: "关于",
};
</script>

<template>
  <div class="flex h-full">
    <!-- 设置导航侧栏（Files SidebarView 240px） -->
    <aside class="flex w-60 shrink-0 flex-col py-2 pl-1.5">
      <div class="flex h-12 items-center px-4">
        <h1 class="text-xl font-semibold">设置</h1>
      </div>

      <nav aria-label="设置导航" class="mt-1">
        <button
          v-for="s in sections"
          :key="s.key"
          type="button"
          class="nav-item"
          :class="section === s.key && 'active'"
          @click="section = s.key"
        >
          <component :is="s.icon" :size="16" class="ml-1 shrink-0" />
          <span class="ml-3 truncate">{{ s.label }}</span>
        </button>
      </nav>
    </aside>

    <!-- 主列：标题行 + 内容卡 -->
    <div class="flex min-w-0 flex-1 flex-col gap-1 p-2 pl-2.5">
      <div
        class="flex h-12 shrink-0 items-center gap-1 rounded-lg px-1"
        :style="{ background: 'var(--toolbar)', border: '1px solid var(--line)' }"
      >
        <button
          type="button"
          class="btn-icon"
          title="返回"
          aria-label="返回"
          @click="settings.closeSettings()"
        >
          <ArrowLeft :size="16" />
        </button>
        <span class="ml-1.5 text-sm font-semibold">{{ sectionTitles[section] }}</span>
      </div>

      <div
        class="min-h-0 flex-1 overflow-y-auto rounded-lg"
        :style="{ background: 'var(--panel)', border: '1px solid var(--line)' }"
      >
        <div class="mx-auto max-w-3xl px-6 py-5">
          <component :is="sectionViews[section]" />
        </div>
      </div>
    </div>
  </div>
</template>
