<script setup lang="ts">
import { File, Folder, Link2 } from "@lucide/vue";

import { useExplorerStore } from "@/stores/explorer";
import type { FileEntry } from "@/types";
import { formatMtime, formatSize } from "@/utils/format";

const explorer = useExplorerStore();

function iconFor(entry: FileEntry) {
  switch (entry.kind) {
    case "dir":
      return Folder;
    case "symlink":
      return Link2;
    default:
      return File;
  }
}

function iconClass(entry: FileEntry): string {
  switch (entry.kind) {
    case "dir":
      return "text-folder";
    case "symlink":
      return "text-accent-2";
    default:
      return "text-faint";
  }
}

function onRowClick(entry: FileEntry) {
  explorer.select(explorer.selectedName === entry.name ? null : entry.name);
}

function onRowDblClick(entry: FileEntry) {
  if (entry.kind === "dir") explorer.enter(entry.name);
}
</script>

<template>
  <div class="overflow-hidden rounded-xl border border-line bg-panel">
    <div
      class="grid grid-cols-[minmax(0,1fr)_88px_112px_150px] items-center border-b border-line bg-panel-2/60 px-3 py-2 text-[11px] font-semibold tracking-[0.08em] text-faint uppercase"
    >
      <span>名称</span>
      <span class="text-right">大小</span>
      <span class="pl-4">权限</span>
      <span class="pl-4">修改时间</span>
    </div>

    <!-- 加载骨架 -->
    <div v-if="explorer.loading && !explorer.entries.length">
      <div v-for="i in 9" :key="i" class="flex h-10 items-center px-3">
        <div class="h-4 animate-pulse rounded bg-line" :style="{ width: `${18 + ((i * 13) % 40)}%` }" />
      </div>
    </div>

    <div v-else-if="explorer.visibleEntries.length" class="max-h-full overflow-y-auto">
      <div
        v-for="entry in explorer.visibleEntries"
        :key="entry.name"
        class="grid cursor-default grid-cols-[minmax(0,1fr)_88px_112px_150px] items-center border-b border-line/50 px-3 py-1.5 transition-colors last:border-0 hover:bg-row-hover"
        :class="explorer.selectedName === entry.name && 'bg-row-active'"
        role="row"
        :aria-selected="explorer.selectedName === entry.name"
        tabindex="0"
        @click="onRowClick(entry)"
        @dblclick="onRowDblClick(entry)"
        @keydown.enter="entry.kind === 'dir' && explorer.enter(entry.name)"
      >
        <span class="flex min-w-0 items-center gap-2.5">
          <component
            :is="iconFor(entry)"
            :size="15"
            class="shrink-0"
            :class="iconClass(entry)"
            :fill="entry.kind === 'dir' ? 'currentColor' : 'none'"
          />
          <span class="truncate font-mono text-[13px]">{{ entry.name }}</span>
        </span>
        <span class="text-right font-mono text-xs text-dim">
          {{ entry.kind === "dir" ? "—" : formatSize(entry.size) }}
        </span>
        <span class="pl-4 font-mono text-xs text-dim">{{ entry.permissions }}</span>
        <span class="pl-4 font-mono text-xs text-dim">{{ formatMtime(entry.mtime) }}</span>
      </div>
    </div>

    <div v-else class="flex flex-col items-center py-16 text-sm text-dim">
      <Folder :size="26" class="mb-2 text-faint" />
      此目录为空
    </div>
  </div>
</template>
