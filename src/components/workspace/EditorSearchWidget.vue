<script setup lang="ts">
import {
  CaseSensitive,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Regex,
  Replace,
  ReplaceAll,
  WholeWord,
  X,
} from "@lucide/vue";
import { nextTick, ref, watch } from "vue";

import type { EditorSearchController } from "@/composables/editorSearch";

/**
 * 编辑器查找/替换悬浮卡（G2，VSCode find widget 语义）：
 * 查找行 = 展开替换箭头 + 查找输入（内嵌三态按钮 + 计数）+ 上一个/下一个 + 关闭；
 * 替换行 = 替换输入 + 替换/全部替换。风格对齐 TransferCenter 浮层
 * （surface-solid 实色 + stroke-flyout 描边 + 8 圆角 + 深影）。
 */

const props = defineProps<{ search: EditorSearchController }>();

const findInput = ref<HTMLInputElement | null>(null);

// 打开/重复 Ctrl+F：聚焦并全选查找框（VSCode 语义）
watch(
  () => props.search.focusSeq,
  () => {
    void nextTick(() => {
      const el = findInput.value;
      if (el) {
        el.focus();
        el.select();
      }
    });
  },
);

function onFindKeydown(e: KeyboardEvent) {
  if (e.key === "Enter") {
    e.preventDefault();
    if (e.shiftKey) props.search.findPrevious();
    else props.search.findNext();
  } else if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    props.search.close();
  }
}

function onReplaceKeydown(e: KeyboardEvent) {
  if (e.key === "Enter") {
    e.preventDefault();
    props.search.replaceOne();
  } else if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    props.search.close();
  }
}

/** 三态切换（Aa / .* / 全词）：切换后立即重新查询 */
function toggle(key: "caseSensitive" | "regexp" | "wholeWord") {
  props.search[key] = !props.search[key];
  props.search.applyQuery();
}
</script>

<template>
  <div
    class="absolute top-2 right-4 z-20 flex flex-col gap-1 rounded-lg p-1.5 shadow-xl"
    :style="{
      background: 'var(--surface-solid)',
      border: '1px solid var(--stroke-flyout)',
    }"
    role="search"
    aria-label="查找与替换"
  >
    <!-- 查找行 -->
    <div class="flex items-center gap-1">
      <button
        type="button"
        class="btn-icon h-7 w-5"
        :title="search.replaceOpen ? '收起替换' : '展开替换'"
        :aria-label="search.replaceOpen ? '收起替换' : '展开替换'"
        @click="search.replaceOpen = !search.replaceOpen"
      >
        <ChevronDown v-if="search.replaceOpen" :size="13" />
        <ChevronRight v-else :size="13" />
      </button>

      <div
        class="flex h-7 w-[240px] items-center gap-0.5 rounded-[4px] px-1.5"
        :style="{
          background: 'var(--fill-control)',
          border: `1px solid ${search.invalid ? 'var(--danger)' : 'var(--line-strong)'}`,
        }"
      >
        <input
          ref="findInput"
          v-model="search.text"
          class="h-full min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none"
          placeholder="查找"
          aria-label="查找"
          spellcheck="false"
          @input="search.applyQuery()"
          @keydown="onFindKeydown"
        />
        <!-- 三态：区分大小写 / 正则 / 全词（激活态 accent） -->
        <button
          type="button"
          class="btn-icon h-6 w-6"
          :class="search.caseSensitive && 'text-accent'"
          title="区分大小写"
          :aria-pressed="search.caseSensitive"
          @click="toggle('caseSensitive')"
        >
          <CaseSensitive :size="13" />
        </button>
        <button
          type="button"
          class="btn-icon h-6 w-6"
          :class="search.regexp && 'text-accent'"
          title="使用正则表达式"
          :aria-pressed="search.regexp"
          @click="toggle('regexp')"
        >
          <Regex :size="13" />
        </button>
        <button
          type="button"
          class="btn-icon h-6 w-6"
          :class="search.wholeWord && 'text-accent'"
          title="全字匹配"
          :aria-pressed="search.wholeWord"
          @click="toggle('wholeWord')"
        >
          <WholeWord :size="13" />
        </button>
        <span
          class="shrink-0 px-1 text-[11px] tabular-nums"
          :class="search.text && !search.invalid && search.total === 0 ? 'text-danger' : 'text-faint'"
        >
          <template v-if="search.invalid">正则无效</template>
          <template v-else-if="!search.text">&nbsp;</template>
          <template v-else>{{ search.current || "–" }}/{{ search.total }}</template>
        </span>
      </div>

      <button
        type="button"
        class="btn-icon h-7 w-7"
        title="上一个（Shift+F3 / Shift+Enter）"
        aria-label="上一个匹配"
        @click="search.findPrevious()"
      >
        <ChevronUp :size="14" />
      </button>
      <button
        type="button"
        class="btn-icon h-7 w-7"
        title="下一个（F3 / Enter）"
        aria-label="下一个匹配"
        @click="search.findNext()"
      >
        <ChevronDown :size="14" />
      </button>
      <button
        type="button"
        class="btn-icon h-7 w-7"
        title="关闭（Esc）"
        aria-label="关闭查找"
        @click="search.close()"
      >
        <X :size="14" />
      </button>
    </div>

    <!-- 替换行（展开时） -->
    <div v-if="search.replaceOpen" class="flex items-center gap-1 pl-6">
      <div
        class="flex h-7 w-[240px] items-center rounded-[4px] px-1.5"
        :style="{
          background: 'var(--fill-control)',
          border: '1px solid var(--line-strong)',
        }"
      >
        <input
          v-model="search.replacement"
          class="h-full min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none"
          placeholder="替换"
          aria-label="替换"
          spellcheck="false"
          @input="search.applyQuery()"
          @keydown="onReplaceKeydown"
        />
      </div>
      <button
        type="button"
        class="btn-icon h-7 w-7"
        title="替换（Enter）"
        aria-label="替换"
        @click="search.replaceOne()"
      >
        <Replace :size="14" />
      </button>
      <button
        type="button"
        class="btn-icon h-7 w-7"
        title="全部替换"
        aria-label="全部替换"
        @click="search.replaceAll()"
      >
        <ReplaceAll :size="14" />
      </button>
    </div>
  </div>
</template>
