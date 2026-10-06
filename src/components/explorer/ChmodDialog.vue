<script setup lang="ts">
import { Check } from "@lucide/vue";
import { computed, ref, watch } from "vue";

import Modal from "@/components/common/Modal.vue";
import type { FileEntry } from "@/types";

/**
 * 权限编辑对话框：属主/组/其他 × 读/写/执行 3×3 勾选，
 * 实时预览 rwx 字符串与八进制，确认后由父级调 ssh_chmod。
 */
const props = defineProps<{
  open: boolean;
  entry: FileEntry | null;
}>();

const emit = defineEmits<{
  close: [];
  apply: [mode: number];
}>();

const ROWS = [
  { key: "owner", label: "属主" },
  { key: "group", label: "组" },
  { key: "other", label: "其他" },
] as const;
const COLS = ["读取", "写入", "执行"] as const;

/** 从 drwxr-xr-x 字符串还原九个权限位 */
function modeFromPermissions(p: string): number {
  let mode = 0;
  for (let i = 0; i < 9; i++) {
    if (p[1 + i] !== undefined && p[1 + i] !== "-") mode |= 1 << (8 - i);
  }
  return mode;
}

const bits = ref(0);

watch(
  () => props.open,
  (open) => {
    if (open && props.entry) bits.value = modeFromPermissions(props.entry.permissions);
  },
);

function bitIndex(row: number, col: number): number {
  return 8 - (row * 3 + col);
}

function toggle(row: number, col: number) {
  bits.value ^= 1 << bitIndex(row, col);
}

const RWX_CHARS = ["r", "w", "x"];

const rwxPreview = computed(() => {
  let s = "";
  for (let shift = 8; shift >= 0; shift--) {
    s += (bits.value >> shift) & 1 ? RWX_CHARS[(8 - shift) % 3] : "-";
  }
  return s;
});

const octalPreview = computed(
  () => "0" + bits.value.toString(8).padStart(3, "0"),
);

function apply() {
  emit("apply", bits.value);
}
</script>

<template>
  <Modal :open="open" title="修改权限" @close="emit('close')">
    <div v-if="entry" class="flex flex-col gap-4">
      <div class="flex items-baseline gap-2 text-sm">
        <span class="text-dim">对象</span>
        <span class="truncate font-mono text-xs">{{ entry.name }}</span>
      </div>

      <!-- 3×3 勾选矩阵：行=属主/组/其他，列=读/写/执行 -->
      <div class="grid grid-cols-[4.5rem_repeat(3,minmax(0,1fr))] items-center gap-y-1">
        <span />
        <span
          v-for="col in COLS"
          :key="col"
          class="text-center text-xs font-medium text-dim"
        >
          {{ col }}
        </span>

        <template v-for="(row, rowIdx) in ROWS" :key="row.key">
          <span class="text-sm">{{ row.label }}</span>
          <button
            v-for="(col, colIdx) in COLS"
            :key="col"
            type="button"
            role="checkbox"
            :aria-checked="Boolean((bits >> bitIndex(rowIdx, colIdx)) & 1)"
            :aria-label="`${row.label}${col}`"
            class="flex h-9 items-center justify-center rounded-[4px] transition-colors hover:bg-fill-subtle"
            @click="toggle(rowIdx, colIdx)"
          >
            <span
              class="flex h-4 w-4 items-center justify-center rounded-[4px] border"
              :style="
                (bits >> bitIndex(rowIdx, colIdx)) & 1
                  ? { background: 'var(--accent)', borderColor: 'var(--accent)', color: 'var(--accent-fg)' }
                  : { borderColor: 'var(--line-strong)' }
              "
            >
              <Check v-if="(bits >> bitIndex(rowIdx, colIdx)) & 1" :size="12" :stroke-width="3" />
            </span>
          </button>
        </template>
      </div>

      <!-- 实时预览 -->
      <div class="flex items-center gap-3">
        <span class="text-xs text-dim">预览</span>
        <span
          class="rounded-[4px] px-2.5 py-1 font-mono text-sm tracking-wider"
          :style="{ background: 'var(--fill-control)' }"
        >
          {{ entry.permissions[0] ?? "-" }}{{ rwxPreview }}
        </span>
        <span
          class="rounded-[4px] px-2.5 py-1 font-mono text-sm"
          :style="{ background: 'var(--fill-control)' }"
        >
          {{ octalPreview }}
        </span>
      </div>

      <footer class="mt-1 flex justify-end gap-2">
        <button type="button" class="btn-secondary" @click="emit('close')">取消</button>
        <button type="button" class="btn-primary" @click="apply">应用</button>
      </footer>
    </div>
  </Modal>
</template>
