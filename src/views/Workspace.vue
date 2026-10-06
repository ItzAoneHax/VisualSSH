<script setup lang="ts">
import {
  ArrowLeft,
  Eye,
  EyeOff,
  FolderTree,
  HardDrive,
  Home,
  LogOut,
  RefreshCw,
  TriangleAlert,
} from "@lucide/vue";
import { onBeforeUnmount, onMounted } from "vue";

import ThemeToggle from "@/components/common/ThemeToggle.vue";
import Breadcrumbs from "@/components/explorer/Breadcrumbs.vue";
import FileTable from "@/components/explorer/FileTable.vue";
import { useConnectionsStore } from "@/stores/connections";
import { useExplorerStore } from "@/stores/explorer";

const emit = defineEmits<{
  disconnect: [];
}>();

const connections = useConnectionsStore();
const explorer = useExplorerStore();

const quickLinks = [
  { label: "根目录 /", path: "/", icon: HardDrive },
  { label: "/home", path: "/home", icon: Home },
  { label: "/etc", path: "/etc", icon: FolderTree },
  { label: "/var", path: "/var", icon: FolderTree },
];

onMounted(() => {
  if (connections.active) {
    explorer.reset(connections.active.connectionId, connections.active.rootPath);
  }
  window.addEventListener("keydown", onKeydown);
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
});

/** Alt+↑ 返回上一级 */
function onKeydown(e: KeyboardEvent) {
  if (e.altKey && e.key === "ArrowUp") {
    e.preventDefault();
    explorer.up();
  }
}
</script>

<template>
  <div v-if="connections.active" class="flex h-full flex-col">
    <!-- 顶栏 -->
    <header
      class="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-panel px-3"
    >
      <button
        type="button"
        class="btn-icon"
        title="返回连接管理"
        aria-label="返回连接管理"
        @click="emit('disconnect')"
      >
        <ArrowLeft :size="16" />
      </button>

      <div class="flex min-w-0 items-center gap-2 border-l border-line pl-3">
        <span class="relative flex h-2 w-2 shrink-0" aria-hidden="true">
          <span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-live opacity-60" />
          <span class="relative inline-flex h-2 w-2 rounded-full bg-live" />
        </span>
        <span class="truncate text-sm font-bold">{{ connections.active.alias }}</span>
        <span class="hidden truncate font-mono text-xs text-faint md:inline">
          {{ connections.active.profile.username }}@{{ connections.active.profile.host }}
        </span>
      </div>

      <div class="mx-3 min-w-0 flex-1">
        <Breadcrumbs />
      </div>

      <button
        type="button"
        class="btn-icon"
        :title="explorer.showHidden ? '隐藏点开头的文件' : '显示点开头的文件'"
        :aria-label="explorer.showHidden ? '隐藏点开头的文件' : '显示点开头的文件'"
        @click="explorer.showHidden = !explorer.showHidden"
      >
        <EyeOff v-if="explorer.showHidden" :size="15" />
        <Eye v-else :size="15" />
      </button>
      <button
        type="button"
        class="btn-icon"
        :class="explorer.loading && 'pointer-events-none'"
        title="刷新（Alt+↑ 返回上一级）"
        aria-label="刷新当前目录"
        @click="explorer.refresh()"
      >
        <RefreshCw :size="15" :class="explorer.loading && 'animate-spin'" />
      </button>
      <ThemeToggle />
      <button type="button" class="btn-ghost ml-1 h-8 px-2.5 text-xs" @click="emit('disconnect')">
        <LogOut :size="13" />
        断开
      </button>
    </header>

    <!-- 主体 -->
    <div class="flex min-h-0 flex-1">
      <aside class="hidden w-52 shrink-0 flex-col justify-between overflow-y-auto border-r border-line bg-panel/60 p-3 lg:flex">
        <nav aria-label="快速跳转">
          <p class="mb-2 px-2 text-[11px] font-bold tracking-[0.12em] text-faint uppercase">快速跳转</p>
          <button
            v-for="link in quickLinks"
            :key="link.path"
            type="button"
            class="mb-0.5 flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left font-mono text-[13px] transition-colors"
            :class="explorer.cwd === link.path
              ? 'bg-row-active font-bold text-ink'
              : 'text-dim hover:bg-row-hover hover:text-ink'"
            @click="explorer.open(link.path)"
          >
            <component :is="link.icon" :size="14" class="shrink-0 text-faint" />
            {{ link.label }}
          </button>
        </nav>

        <div class="rounded-lg border border-dashed border-line px-3 py-2.5 text-[11px] leading-5 text-faint">
          树状导航、拖拽传输与内置终端将在后续里程碑加入。
        </div>
      </aside>

      <main class="flex min-w-0 flex-1 flex-col gap-3 overflow-hidden p-4">
        <div
          v-if="explorer.error"
          class="flex items-center gap-2.5 rounded-lg border border-danger/30 bg-danger/10 px-3.5 py-2.5 text-sm text-danger"
        >
          <TriangleAlert :size="15" class="shrink-0" />
          <span class="min-w-0 flex-1 truncate font-mono text-xs" :title="explorer.error">
            {{ explorer.error }}
          </span>
          <button type="button" class="btn-ghost h-7 px-2 text-xs" @click="explorer.refresh()">
            <RefreshCw :size="12" />
            重试
          </button>
        </div>

        <div class="min-h-0 flex-1 overflow-y-auto">
          <FileTable />
        </div>
      </main>
    </div>

    <!-- 状态栏：路径即提示符 -->
    <footer
      class="flex h-8 shrink-0 items-center justify-between border-t border-line bg-panel px-4 font-mono text-[11px] text-dim"
    >
      <span class="flex min-w-0 items-center">
        <span class="truncate">{{ explorer.cwd }}</span>
        <span class="cursor-blink ml-1 inline-block h-3.5 w-[7px] bg-accent/80" aria-hidden="true" />
      </span>
      <span class="ml-4 shrink-0">
        {{ explorer.visibleEntries.length }} 项 · {{ connections.active.latencyMs }} ms
      </span>
    </footer>
  </div>
</template>
