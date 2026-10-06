<script setup lang="ts">
import { computed } from "vue";

import { useExplorerStore } from "@/stores/explorer";
import { joinPath } from "@/utils/format";

const explorer = useExplorerStore();

/** 每段对应的可跳转路径：[ "/", "/var", "/var/log" ... ] */
const crumbs = computed(() => {
  const parts = explorer.breadcrumbSegments;
  return [
    { name: "/", path: "/" },
    ...parts.map((name, i) => ({
      name,
      path: joinPath("/", parts.slice(0, i + 1).join("/")),
    })),
  ];
});

function pathOf(index: number) {
  return crumbs.value[index].path;
}
</script>

<template>
  <nav
    class="flex min-w-0 items-center gap-1 overflow-x-auto font-mono text-[13px] whitespace-nowrap"
    aria-label="路径导航"
  >
    <template v-for="(crumb, i) in crumbs" :key="crumb.path">
      <span v-if="i > 0" class="px-0.5 text-[11px] text-faint select-none" aria-hidden="true">❯</span>
      <button
        type="button"
        class="rounded px-1.5 py-0.5 transition-colors"
        :class="i === crumbs.length - 1
          ? 'font-bold text-ink'
          : 'text-dim hover:text-accent'"
        :title="crumb.path"
        @click="i < crumbs.length - 1 && explorer.open(pathOf(i))"
      >
        {{ crumb.name }}
      </button>
    </template>
  </nav>
</template>
