<script setup lang="ts">
import { ArrowDown, ArrowDownUp, ArrowUp, Trash2, X } from "@lucide/vue";
import { ref } from "vue";

import { useTransferStore, type TransferRow } from "@/stores/transfer";
import { formatEta, formatSpeed } from "@/utils/format";

/**
 * 传输中心：状态栏右侧常驻微型指示（总速度 + 进行中数量），
 * 点击弹出 Fluent 浮层面板（队列/进度/取消/清除）。
 */
const transfers = useTransferStore();
const open = ref(false);

function percent(row: TransferRow): number {
  if (row.total <= 0) return 0;
  return Math.min(100, (row.bytes / row.total) * 100);
}

/** 行右侧统计文案 */
function statText(row: TransferRow): string {
  switch (row.status) {
    case "queued":
      return "排队中";
    case "running": {
      const eta = formatEta(row.total - row.bytes, row.speedBps);
      return eta === "—"
        ? formatSpeed(row.speedBps)
        : `${formatSpeed(row.speedBps)} · 剩余 ${eta}`;
    }
    case "done":
      return "已完成";
    case "failed":
      return "失败";
    case "cancelled":
      return "已取消";
  }
}

function iconOf(row: TransferRow) {
  return row.direction === "upload" ? ArrowUp : ArrowDown;
}

const isActive = (row: TransferRow) =>
  row.status === "queued" || row.status === "running";
</script>

<template>
  <div class="relative">
    <!-- 点击外部关闭 -->
    <div v-if="open" class="fixed inset-0 z-40" @click="open = false" />

    <!-- 常驻微型指示 -->
    <button
      type="button"
      class="btn-icon h-7 gap-1.5 px-2 text-xs"
      :class="transfers.activeCount > 0 && 'text-accent'"
      :title="`传输中心${transfers.activeCount > 0 ? ` · ${transfers.activeCount} 项进行中` : ''}`"
      aria-label="传输中心"
      @click="open = !open"
    >
      <ArrowDownUp :size="14" />
      <span v-if="transfers.activeCount > 0" class="font-mono tabular-nums">
        {{ formatSpeed(transfers.totalSpeedBps) }} · {{ transfers.activeCount }}
      </span>
      <span v-else>传输</span>
    </button>

    <!-- Fluent 浮层面板（不透明实体表面） -->
    <Transition name="popup">
      <div
        v-if="open"
        class="absolute right-0 bottom-full z-50 mb-1.5 flex max-h-[26rem] w-96 flex-col overflow-hidden rounded-lg shadow-xl"
        :style="{
          background: 'var(--surface-solid)',
          border: '1px solid var(--stroke-flyout)',
        }"
      >
        <header class="flex shrink-0 items-center justify-between px-3 pt-2.5 pb-1.5">
          <h3 class="text-xs font-semibold text-dim">
            传输中心
            <span v-if="transfers.rows.length" class="ml-1 text-faint">
              {{ transfers.rows.length }}
            </span>
          </h3>
          <button type="button" class="btn-icon -mr-1 h-7 w-7" aria-label="关闭" @click="open = false">
            <X :size="14" />
          </button>
        </header>

        <div class="min-h-0 flex-1 overflow-y-auto px-1.5 pb-1.5">
          <!-- 空态 -->
          <div
            v-if="!transfers.rows.length"
            class="flex flex-col items-center py-10 text-dim"
          >
            <ArrowDownUp :size="24" class="mb-2 text-faint" />
            <span class="text-xs">没有进行中的传输</span>
          </div>

          <div
            v-for="row in transfers.rows"
            :key="row.id"
            class="flex items-center gap-2.5 rounded-[4px] px-2 py-2 transition-colors hover:bg-fill-subtle"
          >
            <component
              :is="iconOf(row)"
              :size="16"
              class="shrink-0"
              :class="row.status === 'failed' ? 'text-danger' : row.direction === 'upload' ? 'text-accent' : 'text-live'"
            />
            <div class="min-w-0 flex-1">
              <div class="flex items-baseline justify-between gap-2">
                <span
                  class="truncate text-[13px] font-medium"
                  :title="row.error ?? row.fileName"
                >
                  {{ row.fileName }}
                </span>
                <span
                  class="shrink-0 font-mono text-[11px] tabular-nums"
                  :style="{ color: row.status === 'failed' ? 'var(--danger)' : undefined }"
                  :class="row.status !== 'failed' && 'text-dim'"
                >
                  {{ statText(row) }}
                </span>
              </div>
              <div class="mt-1.5 flex items-center gap-2">
                <!-- 单行进度条 -->
                <div
                  class="h-1 min-w-0 flex-1 overflow-hidden rounded-full"
                  :style="{ background: 'var(--fill-control)' }"
                >
                  <div
                    class="h-full rounded-full transition-[width] duration-200"
                    :style="{
                      width: `${percent(row)}%`,
                      background:
                        row.status === 'failed' ? 'var(--danger)' : 'var(--accent)',
                    }"
                  />
                </div>
                <span class="w-10 shrink-0 text-right font-mono text-[10px] tabular-nums text-faint">
                  {{ row.total > 0 ? `${Math.floor(percent(row))}%` : "" }}
                </span>
              </div>
            </div>
            <!-- 取消（进行中）/ 清除（已结束） -->
            <button
              v-if="isActive(row)"
              type="button"
              class="btn-icon h-7 w-7 shrink-0"
              title="取消传输"
              :aria-label="`取消 ${row.fileName}`"
              @click="transfers.cancel(row.id)"
            >
              <X :size="14" />
            </button>
            <button
              v-else
              type="button"
              class="btn-icon h-7 w-7 shrink-0"
              title="清除记录"
              :aria-label="`清除 ${row.fileName}`"
              @click="transfers.removeRow(row.id)"
            >
              <Trash2 :size="13" />
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>
