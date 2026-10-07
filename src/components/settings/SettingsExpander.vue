<script setup lang="ts">
import type { Component } from "vue";
import { ChevronDown } from "@lucide/vue";
import { ref } from "vue";

/**
 * 折叠设置组（仿 wct SettingsExpander）：头部 = 图标/标题/说明 + 右侧控件 + chevron，
 * 点击头部整行折叠；子项以分隔线分行排在卡内。grid-rows 过渡展开动画。
 */
const props = withDefaults(
  defineProps<{
    icon?: Component;
    title: string;
    description?: string;
    defaultOpen?: boolean;
  }>(),
  { defaultOpen: false },
);

const expanded = ref(props.defaultOpen);
</script>

<template>
  <div class="settings-expander" :class="expanded && 'open'">
    <button
      type="button"
      class="settings-expander-header"
      :aria-expanded="expanded"
      @click="expanded = !expanded"
    >
      <component :is="icon" v-if="icon" :size="20" class="shrink-0 text-dim" />
      <span class="flex min-w-0 flex-1 flex-col items-start">
        <span class="text-sm font-medium">{{ title }}</span>
        <span
          v-if="description"
          class="mt-0.5 w-full truncate text-left text-xs text-dim"
          :title="description"
        >
          {{ description }}
        </span>
      </span>
      <!-- 右侧控件区：点击不触发折叠 -->
      <span v-if="$slots.control" class="flex shrink-0 items-center" @click.stop>
        <slot name="control" />
      </span>
      <ChevronDown :size="14" class="settings-expander-chevron shrink-0 text-dim" />
    </button>
    <div
      class="grid transition-[grid-template-rows] duration-200 ease-out"
      :style="{ gridTemplateRows: expanded ? '1fr' : '0fr' }"
    >
      <div class="overflow-hidden">
        <div v-if="expanded" class="settings-expander-items">
          <slot name="items" />
        </div>
      </div>
    </div>
  </div>
</template>
