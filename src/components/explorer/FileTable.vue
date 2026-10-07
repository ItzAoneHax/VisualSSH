<script setup lang="ts">
import { ChevronDown, ChevronUp, File, Folder, Link2, SearchX } from "@lucide/vue";
import { ref, watch } from "vue";

import { useClipboardStore } from "@/stores/clipboard";
import { useExplorerStore, type SortKey } from "@/stores/explorer";
import { useSettingsStore } from "@/stores/settings";
import type { FileEntry } from "@/types";
import { formatMtime, formatSize, kindLabel } from "@/utils/format";

const explorer = useExplorerStore();
const settings = useSettingsStore();
const clip = useClipboardStore();

/** 剪切中的行变暗（Files DimItemOpacity 0.4，TransferHelpers.cs:125-132） */
function isCutRow(entry: FileEntry): boolean {
  return clip.isCut(explorer.connectionId, explorer.cwd, entry.name);
}

/** 单击打开（Files SingleClickToOpen）：无修饰键单击直接进入/打开 */
function openEntry(entry: FileEntry) {
  if (entry.kind === "dir") explorer.enter(entry.name);
  else emit("openFile", entry);
}

const emit = defineEmits<{
  contextMenu: [payload: { entry: FileEntry | null; x: number; y: number }];
  openFile: [entry: FileEntry];
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

/** 进入编辑态时聚焦，并选中文件名主体（Windows 语义：不含扩展名）。
 *  v-model 的 value 赋值发生在 ref 回调之后（会把光标推到末尾），
 *  因此选区推迟到下一帧再设置。 */
function focusEditInput(el: unknown, name: string) {
  if (!(el instanceof HTMLInputElement)) return;
  el.focus();
  requestAnimationFrame(() => {
    const dot = name.lastIndexOf(".");
    if (dot > 0) el.setSelectionRange(0, dot);
    else el.select();
  });
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

/** Windows 资源管理器语义：单击单选 / Ctrl+单击反选 / Shift+单击范围；
 *  开启「单击打开」后，无修饰键单击 = 打开 */
function onRowClick(entry: FileEntry, e: MouseEvent) {
  if (e.ctrlKey) {
    explorer.toggleSelect(entry.name);
  } else if (e.shiftKey) {
    explorer.selectRange(entry.name);
  } else if (settings.settings.singleClickOpen) {
    openEntry(entry);
  } else {
    explorer.selectOnly(entry.name);
  }
}

function onRowDblClick(entry: FileEntry) {
  // 单击打开模式下双击不重复触发（click 已打开，目录此时已切换）
  if (settings.settings.singleClickOpen) return;
  openEntry(entry);
}

/** 双击空白处转到上一级（Files DoubleClickBlankSpaceToGoUp） */
function onBlankDblClick(e: MouseEvent) {
  if (!settings.settings.dblClickBlankGoUp) return;
  if ((e.target as HTMLElement).closest("[data-row], button, input")) return;
  explorer.up();
}

/** 右键未选中项时先单选（资源管理器行为）；已选中则保持多选 */
function onRowContextMenu(entry: FileEntry, e: MouseEvent) {
  if (!explorer.isSelected(entry.name)) explorer.selectOnly(entry.name);
  emit("contextMenu", { entry, x: e.clientX, y: e.clientY });
}

function onBlankContextMenu(e: MouseEvent) {
  emit("contextMenu", { entry: null, x: e.clientX, y: e.clientY });
}

/** —— 橡皮筋框选：空白处按下拖动画框，拖动过程中相交行实时选中 —— */
const rubber = ref<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
/** 框选进行中禁文本选择 */
const rubberActive = ref(false);

/** 命中测试：与选框相交的行名（Explorer 语义） */
function hitTest(x1: number, y1: number, x2: number, y2: number): string[] {
  const box = {
    left: Math.min(x1, x2),
    right: Math.max(x1, x2),
    top: Math.min(y1, y2),
    bottom: Math.max(y1, y2),
  };
  const hits: string[] = [];
  for (const el of document.querySelectorAll("[data-row]")) {
    const r = el.getBoundingClientRect();
    const intersect =
      r.left < box.right && r.right > box.left && r.top < box.bottom && r.bottom > box.top;
    if (intersect) hits.push((el as HTMLElement).dataset.row!);
  }
  return hits;
}

function onContainerPointerDown(e: PointerEvent) {
  if (e.button !== 0) return;
  // 按钮/输入框不启动框选；行上按下也允许拖拽框选（Explorer 语义，文本已全局禁选）
  if ((e.target as HTMLElement).closest("button, input, textarea, [contenteditable]")) return;
  const fromRow = !!(e.target as HTMLElement).closest("[data-row]");
  const startX = e.clientX;
  const startY = e.clientY;
  const additive = e.ctrlKey;
  let moved = false;
  let raf = 0;

  const onMove = (ev: PointerEvent) => {
    if (Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) > 4) {
      moved = true;
      rubberActive.value = true;
      rubber.value = { x1: startX, y1: startY, x2: ev.clientX, y2: ev.clientY };
      // 实时选中：rAF 节流命中测试，状态栏随拖动即时计数
      if (!raf) {
        raf = requestAnimationFrame(() => {
          raf = 0;
          if (rubber.value) {
            explorer.applyRubberSelection(
              hitTest(startX, startY, rubber.value.x2, rubber.value.y2),
              additive,
            );
          }
        });
      }
    }
  };
  const onUp = (ev: PointerEvent) => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    if (raf) cancelAnimationFrame(raf);
    if (moved) {
      explorer.applyRubberSelection(hitTest(startX, startY, ev.clientX, ev.clientY), additive);
    } else if (!fromRow) {
      // 未拖动的空白单击：清除选择（行上的单击交给行自身 click 处理）
      explorer.clearSelection();
    }
    rubber.value = null;
    rubberActive.value = false;
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}
</script>

<template>
  <!-- 列表容器内边距 8（DetailsLayoutPage ListView padding）；空白拖动 = 橡皮筋框选 -->
  <div
    class="relative min-h-full px-2 pb-3"
    :class="rubberActive && 'select-none'"
    @pointerdown="onContainerPointerDown"
    @dblclick="onBlankDblClick"
    @contextmenu.prevent="onBlankContextMenu($event)"
  >
    <!-- 列头：40 高、左距 24、底部分隔线，点击排序；sticky 钉在文件区顶部 -->
    <div
      class="sticky top-0 z-10 grid grid-cols-[minmax(0,1fr)_10rem_6rem_6rem_7rem] items-center border-b pl-6 text-xs text-dim"
      :style="{ height: '40px', borderColor: 'var(--line)', background: 'var(--panel-solid)' }"
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
          class="relative grid cursor-default grid-cols-[minmax(0,1fr)_10rem_6rem_6rem_7rem] items-center rounded-[4px] px-3 text-sm transition-colors"
          :style="{ height: '36px' }"
          :class="[
            explorer.isSelected(entry.name)
              ? 'bg-row-active hover:bg-row-active-hover'
              : 'hover:bg-row-hover',
            isCutRow(entry) && 'opacity-40',
          ]"
          role="row"
          :data-row="entry.name"
          :aria-selected="explorer.isSelected(entry.name)"
          tabindex="0"
          @click.stop="onRowClick(entry, $event)"
          @dblclick.stop="onRowDblClick(entry)"
          @contextmenu.stop.prevent="onRowContextMenu(entry, $event)"
          @keydown.enter="entry.kind === 'dir' && explorer.enter(entry.name)"
        >
          <!-- 选中指示竖条（WinUI ListViewItemPresenter SelectionIndicator：3×16、1.5 圆角、左缘居中） -->
          <span
            v-if="explorer.isSelected(entry.name)"
            class="pointer-events-none absolute top-1/2 left-0 h-4 w-[3px] -translate-y-1/2 rounded-[1.5px] bg-accent"
            aria-hidden="true"
          />
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
        <component :is="explorer.searchQuery ? SearchX : Folder" :size="28" class="mb-3 text-faint" />
        <span class="text-sm">
          {{ explorer.searchQuery ? `没有匹配「${explorer.searchQuery}」的项目` : "此目录为空" }}
        </span>
      </div>
    </template>

    <!-- 橡皮筋选框（视口坐标，强调色描边 + 半透明填充） -->
    <div
      v-if="rubber"
      class="pointer-events-none fixed z-30"
      :style="{
        left: `${Math.min(rubber.x1, rubber.x2)}px`,
        top: `${Math.min(rubber.y1, rubber.y2)}px`,
        width: `${Math.abs(rubber.x2 - rubber.x1)}px`,
        height: `${Math.abs(rubber.y2 - rubber.y1)}px`,
        background: 'color-mix(in srgb, var(--accent) 10%, transparent)',
        border: '1px solid var(--accent)',
      }"
    />
  </div>
</template>
