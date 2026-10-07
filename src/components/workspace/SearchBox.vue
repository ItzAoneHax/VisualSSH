<script setup lang="ts">
import { FolderSearch, History, Search, X } from "@lucide/vue";
import { ref } from "vue";

import { useExplorer } from "@/stores/explorer";

/**
 * 地址栏搜索框（M7 步骤 3 从窗格挖出为独立组件）：即时过滤当前目录，
 * Enter / 下拉提示项进入递归结果模式。作用于指定窗格的 explorer 实例；
 * 非活动窗格中隐藏（双栏时仅全局工具栏行的一份，作用于活动窗格）。
 */

const props = defineProps<{ paneId: string; open: boolean }>();

const emit = defineEmits<{
  "update:open": [value: boolean];
}>();

const explorer = useExplorer(props.paneId);
/** 搜索框聚焦态（下拉提示/历史仅聚焦时展示） */
const searchFocused = ref(false);

function closeSearch() {
  emit("update:open", false);
  explorer.exitSearch(true);
}

/** 搜索框 Enter：非空词进入递归搜索（当前目录为根） */
function onSearchEnter() {
  if (explorer.searchQuery.trim()) {
    explorer.startRecursiveSearch(explorer.searchQuery);
  }
}

/** 搜索框 Esc：结果模式先退出回原目录，否则收起搜索框 */
function onSearchEsc() {
  if (explorer.searchSession) {
    explorer.exitSearch(true);
  } else {
    closeSearch();
  }
}

/** 下拉提示项点击（mousedown.prevent 保住输入框焦点） */
function onSuggestionSearch(query: string) {
  explorer.searchQuery = query;
  explorer.startRecursiveSearch(query);
}
</script>

<template>
  <div
    class="flex h-[34px] shrink-0 items-center rounded-[4px]"
    :class="open ? 'overflow-visible' : 'overflow-hidden'"
    :style="{
      width: open ? '250px' : '0px',
      padding: open ? '0px 10px' : '0px',
      borderWidth: open ? '1px' : '0px',
      borderStyle: 'solid',
      borderColor: 'var(--line)',
      background: 'var(--sidebar)',
      transition:
        'width 0.25s cubic-bezier(0.16, 1, 0.3, 1), border-width 0.1s linear, padding 0.1s linear',
    }"
  >
    <div class="relative flex h-full w-[228px] shrink-0 items-center gap-1.5">
      <Search :size="14" class="shrink-0 text-dim" />
      <input
        v-model="explorer.searchQuery"
        class="h-full min-w-0 flex-1 bg-transparent text-sm text-ink outline-none"
        placeholder="搜索当前目录"
        aria-label="搜索当前目录"
        @focus="searchFocused = true"
        @blur="searchFocused = false"
        @keydown.enter.prevent="onSearchEnter"
        @keydown.esc.stop="onSearchEsc"
      />
      <button
        v-if="explorer.searchQuery"
        type="button"
        class="btn-icon h-6 w-6 shrink-0"
        title="清空"
        aria-label="清空搜索"
        @click="explorer.searchQuery = ''"
      >
        <X :size="13" />
      </button>

      <!-- 下拉提示：输入非空 → 「在子目录中搜索」；聚焦且为空 → 搜索历史（点击即执行） -->
      <Transition name="popup">
        <div
          v-if="open && searchFocused && (explorer.searchQuery.trim() || (!explorer.searchQuery && explorer.searchHistory.length))"
          class="absolute top-[38px] right-0 z-50 min-w-full overflow-hidden rounded-lg shadow-xl"
          :style="{ background: 'var(--surface-solid)', border: '1px solid var(--stroke-flyout)' }"
        >
          <template v-if="explorer.searchQuery.trim()">
            <button
              type="button"
              class="flex h-8 w-full items-center gap-2.5 px-3 text-left text-sm whitespace-nowrap transition-colors hover:bg-fill-subtle"
              @mousedown.prevent="onSuggestionSearch(explorer.searchQuery.trim())"
            >
              <FolderSearch :size="14" class="shrink-0 text-dim" />
              在子目录中搜索「{{ explorer.searchQuery.trim() }}」
            </button>
          </template>
          <template v-else>
            <button
              v-for="q in explorer.searchHistory"
              :key="q"
              type="button"
              class="flex h-8 w-full items-center gap-2.5 px-3 text-left text-sm whitespace-nowrap transition-colors hover:bg-fill-subtle"
              @mousedown.prevent="onSuggestionSearch(q)"
            >
              <History :size="14" class="shrink-0 text-faint" />
              {{ q }}
            </button>
          </template>
        </div>
      </Transition>
    </div>
  </div>
</template>
