<script setup lang="ts">
import { ChevronDown, ChevronUp, File, Folder, Link2 } from "@lucide/vue";
import { ref, watch } from "vue";

import { useExplorerStore, type SortKey } from "@/stores/explorer";
import type { FileEntry } from "@/types";
import { formatMtime, formatSize, kindLabel } from "@/utils/format";

const explorer = useExplorerStore();

const emit = defineEmits<{
  contextMenu: [payload: { entry: FileEntry | null; x: number; y: number }];
}>();

/** 就地编辑的实时值（重命名初值 = 原名，新建为空） */
const editValue = ref("");

watch(
  () => explorer.renamingName,
  (name) => {
    if (name !== null) editValue.value = name;
  },
);
watch(
  () => explorer.newDraft,
  (draft) => {
    if (draft !== null) editValue.value = "";
  },
);

/** 进入编辑态时聚焦，并选中文件名主体（Windows 语义：不含扩展名） */
function focusEditInput(el: unknown, name: string) {
  if (!(el instanceof HTMLInputElement)) return;
  el.focus();
  const dot = name.lastIndexOf(".");
  if (dot > 0) el.setSelectionRange(0, dot);
  else el.select();
}

function commitRename(entry: FileEntry) {
  explorer.renameEntry(entry.name, editValue.value);
}

function commitDraft() {
  if (!explorer.newDraft) return;
  explorer.createEntry(explorer.newDraft, editValue.value);
}

/** DetailsLayoutPage 列序：名称 | 修改时间 | 类型 | 大小（+权限） */
const columns: { key: SortKey; label: string; class: string }[] = [
  { key: "name", label: "名称", class: "" },
  { key: "mtime", label: "修改时间", class: "w-40" },
  { key: "kind", label: "类型", class: "w-24" },
  { key: "size", label: "大小", class: "w-24 text-right" },
  // 等宽字体只加在数据单元格上：表头是中文，等宽栈会回退成宋体
  { key: "permissions", label: "权限", class: "w-28 pl-2.5" },
];

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
      return "text-accent";
    default:
      return "text-dim";
  }
}

/** Windows 资源管理器语义：单击选中（不切换）、Ctrl+单击反选 */
function onRowClick(entry: FileEntry, e: MouseEvent) {
  if (e.ctrlKey) {
    explorer.select(explorer.selectedName === entry.name ? null : entry.name);
  } else {
    explorer.select(entry.name);
  }
}

function onRowDblClick(entry: FileEntry) {
  if (entry.kind === "dir") explorer.enter(entry.name);
}

/** 右键未选中项时先选中（资源管理器行为），再上报菜单位置 */
function onRowContextMenu(entry: FileEntry, e: MouseEvent) {
  if (explorer.selectedName !== entry.name) explorer.select(entry.name);
  emit("contextMenu", { entry, x: e.clientX, y: e.clientY });
}

function onBlankContextMenu(e: MouseEvent) {
  emit("contextMenu", { entry: null, x: e.clientX, y: e.clientY });
}

/** 点击列表空白区域清除选中 */
function onBlankClick() {
  if (explorer.selectedName) explorer.select(null);
}
</script>

<template>
  <!-- 列表容器内边距 8（DetailsLayoutPage ListView padding） -->
  <div class="min-h-full px-2 pb-3" @click="onBlankClick" @contextmenu.prevent="onBlankContextMenu($event)">
    <!-- 列头：40 高、左距 24、底部分隔线，点击排序 -->
    <div
      class="grid grid-cols-[minmax(0,1fr)_10rem_6rem_6rem_7rem] items-center border-b pl-6 text-xs text-dim"
      :style="{ height: '40px', borderColor: 'var(--line)' }"
    >
      <button
        v-for="col in columns"
        :key="col.key"
        type="button"
        class="flex h-full items-center gap-1 text-left font-normal hover:text-ink"
        :class="[col.class, col.key === 'name' ? 'pl-3' : 'pl-2.5']"
        @click="explorer.sortBy(col.key)"
      >
        {{ col.label }}
        <ChevronUp
          v-if="explorer.sortKey === col.key && explorer.sortAsc"
          :size="12"
          class="text-dim"
        />
        <ChevronDown
          v-else-if="explorer.sortKey === col.key"
          :size="12"
          class="text-dim"
        />
      </button>
    </div>

    <!-- 加载骨架 -->
    <div v-if="explorer.loading && !explorer.entries.length">
      <div v-for="i in 9" :key="i" class="flex h-9 items-center px-3">
        <div
          class="h-4 animate-pulse rounded-[2px]"
          :style="{ width: `${18 + ((i * 13) % 40)}%`, background: 'var(--line)' }"
        />
      </div>
    </div>

    <template v-else>
      <!-- 新建草稿行：列表顶部就地输入名称 -->
      <div
        v-if="explorer.newDraft"
        class="grid grid-cols-[minmax(0,1fr)_10rem_6rem_6rem_7rem] items-center rounded-[4px] px-3 text-sm"
        :style="{ height: '36px', background: 'var(--fill-control)' }"
        @click.stop
        @contextmenu.stop.prevent
      >
        <span class="flex min-w-0 items-center pl-3">
          <Folder
            v-if="explorer.newDraft === 'dir'"
            :size="16"
            class="shrink-0 text-folder"
            fill="currentColor"
          />
          <File v-else :size="16" class="shrink-0 text-dim" />
          <input
            :ref="(el) => focusEditInput(el, '')"
            v-model="editValue"
            class="rename-input ml-1.5"
            :placeholder="explorer.newDraft === 'dir' ? '新建文件夹' : '新建文件'"
            spellcheck="false"
            @keydown.enter.prevent.stop="commitDraft"
            @keydown.esc.prevent.stop="explorer.cancelEdit()"
            @blur="explorer.cancelEdit()"
          />
        </span>
      </div>

      <div v-if="explorer.visibleEntries.length">
        <div
          v-for="entry in explorer.visibleEntries"
          :key="entry.name"
          class="grid cursor-default grid-cols-[minmax(0,1fr)_10rem_6rem_6rem_7rem] items-center rounded-[4px] px-3 text-sm transition-colors"
          :style="{ height: '36px' }"
          :class="explorer.selectedName === entry.name ? 'bg-row-active' : 'hover:bg-row-hover'"
          role="row"
          :aria-selected="explorer.selectedName === entry.name"
          tabindex="0"
          @click.stop="onRowClick(entry, $event)"
          @dblclick.stop="onRowDblClick(entry)"
          @contextmenu.stop.prevent="onRowContextMenu(entry, $event)"
          @keydown.enter="entry.kind === 'dir' && explorer.enter(entry.name)"
        >
          <!-- 名称列：图标 16 + 文字距 6（DetailsLayoutPage IconColumn） -->
          <span class="flex min-w-0 items-center pl-3">
            <component
              :is="iconFor(entry)"
              :size="16"
              class="shrink-0"
              :class="iconClass(entry)"
              :fill="entry.kind === 'dir' ? 'currentColor' : 'none'"
            />
            <!-- 就地重命名（F2 / 右键菜单）：Enter 确认，Esc 取消 -->
            <input
              v-if="explorer.renamingName === entry.name"
              :ref="(el) => focusEditInput(el, entry.name)"
              v-model="editValue"
              class="rename-input ml-1.5"
              spellcheck="false"
              @click.stop
              @dblclick.stop
              @keydown.enter.prevent.stop="commitRename(entry)"
              @keydown.esc.prevent.stop="explorer.cancelEdit()"
              @blur="explorer.cancelEdit()"
            />
            <span v-else class="truncate pl-1.5">{{ entry.name }}</span>
          </span>
          <!-- 列内容：caption 12、次级文字（ColumnContentTextBlock opacity .6） -->
          <span class="truncate pl-2.5 text-xs text-dim">{{ formatMtime(entry.mtime) }}</span>
          <span class="truncate pl-2.5 text-xs text-dim">{{ kindLabel(entry.kind) }}</span>
          <span class="truncate text-right text-xs text-dim">
            {{ entry.kind === "dir" ? "" : formatSize(entry.size) }}
          </span>
          <span class="truncate pl-2.5 font-mono text-xs text-dim">{{ entry.permissions }}</span>
        </div>
      </div>

      <div v-else-if="!explorer.newDraft" class="flex flex-col items-center pt-20 text-dim">
        <Folder :size="28" class="mb-3 text-faint" />
        <span class="text-sm">此目录为空</span>
      </div>
    </template>
  </div>
</template>
