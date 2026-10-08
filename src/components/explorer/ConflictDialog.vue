<script setup lang="ts">
import { ArrowRight, File, Folder, Link2 } from "@lucide/vue";
import { computed } from "vue";

import Modal from "@/components/common/Modal.vue";
import SettingsSelect from "@/components/settings/SettingsSelect.vue";
import { useConflictStore, type ConflictRow } from "@/stores/conflicts";
import type { ConflictResolveOption } from "@/stores/settings";
import { formatMtime, formatSize, pathBaseName } from "@/utils/format";

/**
 * 传输/粘贴冲突对话框（Files FilesystemOperationDialog 的远端版）：
 * 每行 = 图标 + 原名 →（生成新名称时）可编辑新名 + 已存在/传入的大小与时间 +
 * 行尾三选下拉；底部「应用到所有冲突项」聚合下拉（自定义/生成新名称/替换/跳过）。
 */
const conflicts = useConflictStore();

const RESOLUTION_OPTIONS = [
  { key: "newName", label: "生成新名称" },
  { key: "replace", label: "替换" },
  { key: "skip", label: "跳过" },
];
const AGGREGATE_OPTIONS = [
  { key: "custom", label: "自定义" },
  { key: "newName", label: "生成新名称" },
  { key: "replace", label: "替换" },
  { key: "skip", label: "跳过" },
];

const title = computed(() => {
  const s = conflicts.session;
  if (!s) return "";
  if (s.multi) {
    const dirs = new Set(s.rows.map((r) => r.targetDir)).size;
    return `${s.rows.length} 个项目已存在于 ${dirs} 个目录`;
  }
  return `${s.rows.length} 个项目已存在于 ${pathBaseName(s.targetDir)}`;
});

function iconFor(row: ConflictRow) {
  switch (row.incoming.kind ?? row.existing.kind) {
    case "dir":
      return Folder;
    case "symlink":
      return Link2;
    default:
      return File;
  }
}

function iconClass(row: ConflictRow): string {
  switch (row.incoming.kind ?? row.existing.kind) {
    case "dir":
      return "text-folder";
    case "symlink":
      return "text-accent";
    default:
      return "text-dim";
  }
}

function metaText(row: ConflictRow, side: "existing" | "incoming"): string {
  if (side === "incoming" && row.incoming.kind === "dir") return "文件夹";
  const size = side === "existing" ? row.existing.size : row.incoming.size;
  const mtime = side === "existing" ? row.existing.mtime : row.incoming.mtime;
  return `${size == null ? "—" : formatSize(size)} · ${formatMtime(mtime)}`;
}

function newNameInvalid(row: ConflictRow): boolean {
  return row.resolution === "newName" && !conflicts.isNewNameValid(row);
}
</script>

<template>
  <Modal
    :open="!!conflicts.session"
    :title="title"
    :max-width="640"
    @close="conflicts.cancel()"
  >
    <div v-if="conflicts.session" class="flex flex-col gap-3">
      <p class="text-xs text-dim">目标目录已包含同名项目，请为每一项选择处理方式。</p>

      <!-- 冲突项列表（Files 冲突 ListView MaxHeight 200 → 两行式行高放宽到 320） -->
      <div class="-mx-1 max-h-80 overflow-y-auto px-1">
        <div
          v-for="row in conflicts.rows"
          :key="conflicts.rowKey(row)"
          class="grid grid-cols-[minmax(0,1fr)_9.5rem] items-start gap-x-3 rounded-[4px] px-1 py-2 hover:bg-fill-subtle"
        >
          <div class="flex min-w-0 items-start gap-2.5">
            <component
              :is="iconFor(row)"
              :size="20"
              class="mt-0.5 shrink-0"
              :class="iconClass(row)"
              :fill="(row.incoming.kind ?? row.existing.kind) === 'dir' ? 'currentColor' : 'none'"
            />
            <div class="min-w-0 flex-1">
              <!-- 名称行：原名 →（生成新名称时）可编辑新名 -->
              <div class="flex min-w-0 items-center gap-1.5 text-sm">
                <span class="max-w-40 truncate" :title="row.name">{{ row.name }}</span>
                <template v-if="row.resolution === 'newName'">
                  <ArrowRight :size="12" class="shrink-0 text-faint" />
                  <input
                    v-model="row.newName"
                    class="rename-input h-6"
                    spellcheck="false"
                    aria-label="新名称"
                    :style="newNameInvalid(row) ? { borderColor: 'var(--danger)' } : undefined"
                    @keydown.enter.prevent="conflicts.confirm()"
                    @keydown.esc.stop.prevent="conflicts.cancel()"
                  />
                </template>
              </div>
              <!-- 大小/修改时间对照 -->
              <p class="mt-0.5 truncate text-xs text-dim">
                已存在 {{ metaText(row, "existing") }}
              </p>
              <p class="truncate text-xs text-dim">
                传入 {{ metaText(row, "incoming") }}
              </p>
              <!-- 多目录批次（递归传输）：行内标注所属目标目录 -->
              <p
                v-if="conflicts.session?.multi"
                class="truncate text-xs text-faint"
                :title="row.targetDir"
              >
                位于 {{ row.targetDir }}
              </p>
            </div>
          </div>
          <SettingsSelect
            :model-value="row.resolution"
            :options="RESOLUTION_OPTIONS"
            :label="`「${row.name}」的处理方式`"
            class="w-full"
            @update:model-value="(v) => conflicts.setRowResolution(row, v as ConflictRow['resolution'])"
          />
        </div>
      </div>

      <!-- 聚合下拉（Files ApplyToAll：应用到所有冲突项） -->
      <div
        class="flex items-center justify-between gap-3 border-t pt-3"
        :style="{ borderColor: 'var(--line)' }"
      >
        <span class="text-sm">应用到所有冲突项</span>
          <SettingsSelect
            :model-value="conflicts.aggregate"
            :options="AGGREGATE_OPTIONS"
            label="应用到所有冲突项"
            @update:model-value="(v) => conflicts.applyAggregate(v as 'custom' | ConflictResolveOption)"
          />
      </div>

      <footer class="mt-1 flex justify-end gap-2">
        <button type="button" class="btn-secondary" @click="conflicts.cancel()">取消</button>
        <button type="button" class="btn-secondary" @click="conflicts.skipAllConflicts()">
          全部跳过
        </button>
        <button
          type="button"
          class="btn-primary"
          :disabled="!conflicts.canContinue"
          @click="conflicts.confirm()"
        >
          继续
        </button>
      </footer>
    </div>
  </Modal>
</template>
