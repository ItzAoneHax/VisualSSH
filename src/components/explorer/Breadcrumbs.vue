<script setup lang="ts">
import { ChevronRight, Folder, HardDrive, LoaderCircle } from "@lucide/vue";
import { computed, nextTick, onBeforeUnmount, ref } from "vue";

import { listDir } from "@/api/ssh";
import { useExplorer } from "@/stores/explorer";
import { joinPath } from "@/utils/format";
import {
  hasFilesPayload,
  readFilesPayload,
  resolveDropMode,
  type FilesDragPayload,
} from "@/utils/dragDrop";

const props = defineProps<{ paneId: string }>();

// 窗格实例（paneId 与组件实例一一对应）
const explorer = useExplorer(props.paneId);

/** 每段对应的可跳转路径：[ "/", "/var", "/var/log" ... ] */
const crumbs = computed(() => {
  const parts = explorer.breadcrumbSegments;
  return parts.map((name, i) => ({
    name,
    path: joinPath("/", parts.slice(0, i + 1).join("/")),
  }));
});

/* ---- 手填模式（资源管理器：点击地址栏空白进入编辑） ---- */

const editing = ref(false);
const inputEl = ref<HTMLInputElement | null>(null);
const draft = ref("");
const suggestions = ref<string[]>([]);
const highlight = ref(-1);
const suggesting = ref(false);
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

function enterEdit() {
  if (explorer.loading) return;
  draft.value = explorer.cwd;
  editing.value = true;
  suggestions.value = [];
  highlight.value = -1;
  void nextTick(() => {
    inputEl.value?.focus();
    inputEl.value?.select();
  });
}

function exitEdit() {
  if (debounceTimer) clearTimeout(debounceTimer);
  editing.value = false;
  suggestions.value = [];
  highlight.value = -1;
}

function navigate(raw: string) {
  const value = raw.trim();
  // 空输入回车：留在当前目录
  const target = value ? normalize(value).dir : explorer.cwd;
  exitEdit();
  explorer.open(target);
}

/**
 * 解析输入：相对路径以当前目录为基；处理 . 与 ..
 * "/var/lo" → { dir: "/var", prefix: "lo" }；"/var/log/" → { dir: "/var/log", prefix: "" }
 */
function normalize(raw: string) {
  const value = raw.trim();
  const base = value.startsWith("/") ? [] : explorer.cwd.split("/").filter(Boolean);
  const parts = value.split("/").filter((p) => p.length > 0);
  const resolved = [...base];
  for (const part of parts) {
    if (part === ".") continue;
    if (part === "..") {
      resolved.pop();
      continue;
    }
    resolved.push(part);
  }
  // 以 / 结尾视为完整目录；否则最后一段是待补全的前缀
  const prefix = value.endsWith("/") ? "" : (resolved.pop() ?? "");
  const dir = `/${resolved.join("/")}`;
  return { dir, prefix };
}

async function refreshSuggestions() {
  const { dir, prefix } = normalize(draft.value);
  if (!explorer.connectionId) {
    suggestions.value = [];
    return;
  }
  suggesting.value = true;
  try {
    const entries = await listDir(explorer.connectionId, dir);
    const current = normalize(draft.value);
    // 请求返回时输入可能已变化，丢弃过期结果
    if (current.dir !== dir || current.prefix !== prefix) return;
    suggestions.value = entries
      .filter((e) => e.kind === "dir" && e.name.startsWith(prefix))
      .slice(0, 8)
      .map((e) => e.name);
    highlight.value = -1;
  } catch {
    // 目录不存在或不可读：无提示
    suggestions.value = [];
  } finally {
    suggesting.value = false;
  }
}

function onInput() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => void refreshSuggestions(), 250);
}

function suggestionPath(name: string) {
  const { dir } = normalize(draft.value);
  return joinPath(dir === "/" ? "/" : dir.replace(/\/$/, ""), name);
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    exitEdit();
    return;
  }
  if (!suggestions.value.length) {
    if (e.key === "Enter") navigate(draft.value);
    return;
  }
  if (e.key === "ArrowDown") {
    e.preventDefault();
    highlight.value = (highlight.value + 1) % suggestions.value.length;
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    highlight.value =
      (highlight.value - 1 + suggestions.value.length) % suggestions.value.length;
  } else if (e.key === "Enter") {
    e.preventDefault();
    const name = highlight.value >= 0 ? suggestions.value[highlight.value] : null;
    navigate(name ? suggestionPath(name) : draft.value);
  }
}

onBeforeUnmount(() => {
  if (debounceTimer) clearTimeout(debounceTimer);
});

/** —— 行内拖拽落点（M7 步骤 4）：面包屑分段 = 移动/复制到该祖先目录（Explorer 惯例） —— */
const emit = defineEmits<{
  dropFiles: [payload: FilesDragPayload, targetDir: string, ctrlKey: boolean];
}>();

const dragOverPath = ref<string | null>(null);

function onCrumbDragOver(path: string, e: DragEvent) {
  if (!hasFilesPayload(e.dataTransfer!)) return;
  e.preventDefault();
  e.stopPropagation();
  e.dataTransfer!.dropEffect = resolveDropMode(e.ctrlKey) === "copy" ? "copy" : "move";
  dragOverPath.value = path;
}

function onCrumbDragLeave(path: string) {
  if (dragOverPath.value === path) dragOverPath.value = null;
}

function onCrumbDrop(path: string, e: DragEvent) {
  if (!hasFilesPayload(e.dataTransfer!)) return;
  e.preventDefault();
  e.stopPropagation();
  dragOverPath.value = null;
  const payload = readFilesPayload(e.dataTransfer!);
  if (!payload) return;
  emit("dropFiles", payload, path, e.ctrlKey);
}
</script>

<template>
  <!-- BreadcrumbBar：34 高，Layer 填充 + 1px 描边，圆角 4；点击空白进入手填 -->
  <div class="relative min-w-0 flex-1">
    <nav
      v-if="!editing"
      class="flex h-[34px] min-w-0 cursor-text items-center overflow-hidden rounded-[4px]"
      :style="{ background: 'var(--sidebar)', border: '1px solid var(--line)' }"
      aria-label="路径导航"
      @click.self="enterEdit"
    >
      <!-- 根项（悬浮高亮为直角矩形；可作拖拽落点 = 根目录） -->
      <button
        type="button"
        class="flex h-8 shrink-0 items-center gap-1.5 rounded-[2px] pr-2 pl-3 text-sm transition-colors"
        :class="[
          explorer.cwd === '/' ? 'font-semibold text-ink' : 'text-dim hover:bg-fill-subtle hover:text-ink',
          dragOverPath === '/' && 'bg-row-active ring-1 ring-[var(--accent)]',
        ]"
        title="/"
        @click.stop="explorer.open('/')"
        @dragover="onCrumbDragOver('/', $event)"
        @dragleave="onCrumbDragLeave('/')"
        @drop="onCrumbDrop('/', $event)"
      >
        <HardDrive :size="14" class="shrink-0" />
        <span v-if="explorer.cwd === '/'">此电脑</span>
      </button>

      <template v-for="(crumb, i) in crumbs" :key="crumb.path">
        <ChevronRight :size="13" class="mx-0.5 shrink-0 text-faint" aria-hidden="true" />
        <button
          type="button"
          class="h-8 shrink-0 rounded-[2px] px-2 text-sm whitespace-nowrap transition-colors"
          :class="[
            i === crumbs.length - 1
              ? 'font-semibold text-ink'
              : 'text-dim hover:bg-fill-subtle hover:text-ink',
            dragOverPath === crumb.path && 'bg-row-active ring-1 ring-[var(--accent)]',
          ]"
          :title="crumb.path"
          @click.stop="i < crumbs.length - 1 && explorer.open(crumb.path)"
          @dragover="onCrumbDragOver(crumb.path, $event)"
          @dragleave="onCrumbDragLeave(crumb.path)"
          @drop="onCrumbDrop(crumb.path, $event)"
        >
          {{ crumb.name }}
        </button>
      </template>

      <!-- 尾部空白也可点击进入编辑 -->
      <span class="h-full min-w-2 flex-1" @click.stop="enterEdit" />
    </nav>

    <!-- 手填模式 -->
    <input
      v-else
      ref="inputEl"
      v-model="draft"
      class="h-[34px] w-full rounded-[4px] px-3 font-mono text-sm text-ink outline-none"
      :style="{ background: 'var(--panel)', border: '1px solid var(--accent)' }"
      spellcheck="false"
      autocomplete="off"
      aria-label="输入路径"
      placeholder="/var/log"
      @input="onInput"
      @keydown="onKeydown"
      @blur="exitEdit"
      @mousedown.stop
    />

    <!-- 路径提示列表（子目录前缀匹配，↓↑ 选择，回车跳转） -->
    <Transition name="popup">
      <div
        v-if="editing && suggestions.length"
        class="absolute top-[38px] right-0 left-0 z-50 overflow-hidden rounded-lg shadow-xl"
        :style="{ background: 'var(--surface-solid)', border: '1px solid var(--stroke-flyout)' }"
      >
        <button
          v-for="(name, i) in suggestions"
          :key="name"
          type="button"
          class="flex h-8 w-full items-center gap-2.5 px-3 text-left text-sm transition-colors"
          :style="i === highlight ? { background: 'var(--fill-subtle)' } : undefined"
          @mouseenter="highlight = i"
          @mousedown.prevent="navigate(suggestionPath(name))"
        >
          <Folder :size="14" class="shrink-0 text-folder" fill="currentColor" />
          <span class="truncate">{{ name }}</span>
          <LoaderCircle v-if="suggesting && i === 0" :size="12" class="ml-auto animate-spin text-faint" />
        </button>
      </div>
    </Transition>
  </div>
</template>
