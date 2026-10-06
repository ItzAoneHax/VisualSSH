<script setup lang="ts">
import { ChevronRight, HardDrive } from "@lucide/vue";
import { computed } from "vue";

import { useExplorerStore } from "@/stores/explorer";
import { joinPath } from "@/utils/format";

const explorer = useExplorerStore();

/** 每段对应的可跳转路径：[ "/", "/var", "/var/log" ... ] */
const crumbs = computed(() => {
  const parts = explorer.breadcrumbSegments;
  return [
    ...parts.map((name, i) => ({
      name,
      path: joinPath("/", parts.slice(0, i + 1).join("/")),
    })),
  ];
});

function pathOf(index: number) {
  return index < 0 ? "/" : crumbs.value[index].path;
}
</script>

<template>
  <!-- BreadcrumbBar：34 高，Layer 填充 + 1px 描边，圆角 4 -->
  <nav
    class="flex h-[34px] min-w-0 items-center overflow-hidden rounded-[4px]"
    :style="{ background: 'var(--sidebar)', border: '1px solid var(--line)' }"
    aria-label="路径导航"
  >
    <!-- 根项：左侧全圆（BreadcrumbBar 根项 radius 16,2,2,16） -->
    <button
      type="button"
      class="flex h-8 shrink-0 items-center gap-1.5 rounded-l-[16px] rounded-r-[2px] pr-2 pl-3 text-sm transition-colors"
      :class="explorer.cwd === '/' ? 'font-semibold text-ink' : 'text-dim hover:bg-fill-subtle hover:text-ink'"
      title="/"
      @click="explorer.open('/')"
    >
      <HardDrive :size="14" class="shrink-0" />
      <span v-if="explorer.cwd === '/'">此电脑</span>
    </button>

    <template v-for="(crumb, i) in crumbs" :key="crumb.path">
      <ChevronRight :size="13" class="mx-0.5 shrink-0 text-faint" aria-hidden="true" />
      <button
        type="button"
        class="h-8 shrink-0 rounded-[2px] px-2 text-sm whitespace-nowrap transition-colors"
        :class="i === crumbs.length - 1
          ? 'font-semibold text-ink'
          : 'text-dim hover:bg-fill-subtle hover:text-ink'"
        :title="crumb.path"
        @click="i < crumbs.length - 1 && explorer.open(pathOf(i))"
      >
        {{ crumb.name }}
      </button>
    </template>
  </nav>
</template>
