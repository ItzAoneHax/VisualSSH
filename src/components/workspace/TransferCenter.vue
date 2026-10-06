<script setup lang="ts">
import {
  ArrowDown,
  ArrowDownUp,
  ArrowUp,
  Check,
  ChevronDown,
  MoreHorizontal,
  X,
} from "@lucide/vue";
import { computed, ref } from "vue";

import ContextMenu from "@/components/common/ContextMenu.vue";
import type { MenuItem } from "@/components/common/DropdownMenu.vue";
import { useTransferStore, type TransferRow } from "@/stores/transfer";
import { formatEta, formatSize, formatSpeed } from "@/utils/format";

/**
 * 传输中心 —— 严格对齐 files-community/Files：
 * 入口 = 地址栏行右侧按钮（空闲静态图标；活动中 = 平均进度环 + InfoBadge 计数角标），
 * 点击弹出 BottomEdgeAlignedRight 浮层（宽 400，MinHeight 120 / MaxHeight 500）。
 * 面板为 StatusCenter 卡片列表：32px 圆底状态图标 + ⋯ 菜单取消（X 仅清除）+
 * chevron 展开 88px 速度折线 + 头部「清除已完成」。
 */
const transfers = useTransferStore();
const open = ref(false);

/** 展开速度折线的行 */
const expandedIds = ref<Set<string>>(new Set());
/** ⋯ 取消菜单所在行与锚点（按钮左下角，对齐 Files MenuFlyout） */
const cancelMenu = ref<{ id: string; x: number; y: number } | null>(null);

const cancelMenuItems: MenuItem[] = [{ key: "cancel", label: "取消", icon: X }];

const hasFinished = computed(() =>
  transfers.rows.some((r) => !isActive(r)),
);

/** 全部可测进度传输的平均百分比（Files AverageOperationProgressValue） */
const averagePercent = computed(() => {
  const measurable = transfers.rows.filter(
    (r) => r.status === "running" && r.total > 0,
  );
  if (!measurable.length) return 0;
  return (
    measurable.reduce(
      (sum, r) => sum + Math.min(100, (r.bytes / r.total) * 100),
      0,
    ) / measurable.length
  );
});

/** InfoBadge 计数（WinUI 99+ 封顶） */
const badgeCount = computed(() =>
  transfers.activeCount > 99 ? "99+" : String(transfers.activeCount),
);

const indicatorTitle = computed(() =>
  transfers.activeCount > 0
    ? `传输中心 · ${transfers.activeCount} 项进行中 · 总速度 ${formatSpeed(transfers.totalSpeedBps)}`
    : "传输中心",
);

function isActive(row: TransferRow): boolean {
  return row.status === "queued" || row.status === "running";
}

function percent(row: TransferRow): number {
  if (row.total <= 0) return 0;
  return Math.min(100, (row.bytes / row.total) * 100);
}

/** 状态图标：进行中=方向箭头，完成=✓，失败/取消=X（Files StatusCenterItem） */
function stateIcon(row: TransferRow) {
  switch (row.status) {
    case "done":
      return Check;
    case "failed":
    case "cancelled":
      return X;
    default:
      return row.direction === "upload" ? ArrowUp : ArrowDown;
  }
}

function stateColor(row: TransferRow): string {
  switch (row.status) {
    case "running":
      return "var(--accent)";
    case "done":
      return "var(--live)";
    case "failed":
      return "var(--danger)";
    default:
      return "var(--dim)";
  }
}

/** 终态卡片标题下方的 caption */
function terminalCaption(row: TransferRow): string {
  switch (row.status) {
    case "done":
      return "已完成";
    case "cancelled":
      return "已取消";
    case "failed":
      return row.error ?? "失败";
    default:
      return "";
  }
}

/** 收起态进度行下方的统计文案（Files 的 Message 行） */
function progressCaption(row: TransferRow): string {
  if (row.status === "queued") return "排队中";
  const eta = formatEta(row.total - row.bytes, row.speedBps);
  const speed = formatSpeed(row.speedBps);
  if (row.total <= 0) return speed;
  return eta === "—"
    ? `${formatSize(row.bytes)} / ${formatSize(row.total)} · ${speed}`
    : `${formatSize(row.bytes)} / ${formatSize(row.total)} · ${speed} · 剩余 ${eta}`;
}

function toggleExpand(id: string) {
  const next = new Set(expandedIds.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expandedIds.value = next;
}

function isExpanded(id: string): boolean {
  return expandedIds.value.has(id);
}

/** 速度折线采样点（viewBox 0 0 100 32） */
function speedPoints(row: TransferRow): string {
  const h = row.speedHistory;
  if (h.length < 2) return "";
  const max = Math.max(...h);
  if (max <= 0) return "";
  return h
    .map(
      (v, i) =>
        `${((i / (h.length - 1)) * 100).toFixed(1)},${(32 - (v / max) * 28 - 2).toFixed(1)}`,
    )
    .join(" ");
}

/** ⋯ 菜单锚定在按钮正下方（Files MenuFlyout 语义） */
function openCancelMenu(row: TransferRow, e: MouseEvent) {
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  cancelMenu.value = { id: row.id, x: rect.left, y: rect.bottom + 2 };
}

function onCancelMenuSelect(key: string) {
  const target = cancelMenu.value;
  cancelMenu.value = null;
  if (target && key === "cancel") transfers.cancel(target.id);
}
</script>

<template>
  <div class="relative">
    <!-- 点击外部关闭 -->
    <div v-if="open" class="fixed inset-0 z-40" @click="open = false" />

    <!-- 入口按钮（Files NavigationToolbar.ShowStatusCenterButton） -->
    <button
      type="button"
      class="btn-icon relative"
      :title="indicatorTitle"
      aria-label="传输中心"
      @click="open = !open"
    >
      <!-- 空闲：静态图标 -->
      <ArrowDownUp v-if="transfers.activeCount === 0" :size="16" />
      <!-- 活动中：平均进度环 + InfoBadge 计数角标（居中覆盖，Files 同款） -->
      <span v-else class="relative flex h-8 w-8 items-center justify-center">
        <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true">
          <circle
            cx="13"
            cy="13"
            r="10"
            fill="none"
            stroke="var(--line-strong)"
            stroke-width="2"
          />
          <circle
            cx="13"
            cy="13"
            r="10"
            fill="none"
            stroke="var(--accent)"
            stroke-width="2"
            stroke-linecap="round"
            pathLength="100"
            :stroke-dasharray="`${averagePercent} ${100 - averagePercent}`"
            transform="rotate(-90 13 13)"
          />
        </svg>
        <span
          class="absolute flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 text-[10px] leading-none font-semibold tabular-nums"
          :style="{ background: 'var(--accent)', color: 'var(--accent-fg)' }"
        >
          {{ badgeCount }}
        </span>
      </span>
    </button>

    <!-- 浮层：BottomEdgeAlignedRight（按钮下方右对齐，宽 400 / 120–500 高） -->
    <Transition name="popup">
      <div
        v-if="open"
        class="absolute top-full right-0 z-50 mt-1 flex w-[400px] flex-col overflow-hidden rounded-lg shadow-xl"
        :style="{
          minHeight: '120px',
          maxHeight: '500px',
          background: 'var(--surface-solid)',
          border: '1px solid var(--stroke-flyout)',
        }"
        role="dialog"
        aria-label="传输中心"
      >
        <!-- 头部：标题 + 清除已完成（Files StatusCenter 同款） -->
        <header class="flex shrink-0 items-center justify-between px-3 pt-2 pb-2">
          <h3 class="text-sm font-semibold">传输中心</h3>
          <button
            type="button"
            class="inline-flex h-6 items-center rounded-[4px] px-2 text-xs text-dim transition-colors"
            :class="hasFinished ? 'hover:bg-fill-subtle hover:text-ink' : 'cursor-not-allowed opacity-40'"
            :disabled="!hasFinished"
            @click="transfers.clearFinished()"
          >
            清除已完成
          </button>
        </header>

        <div class="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
          <!-- 空态 -->
          <div
            v-if="!transfers.rows.length"
            class="flex flex-col items-center justify-center py-10 text-dim"
          >
            <ArrowDownUp :size="22" class="mb-2 text-faint" />
            <span class="text-xs">没有进行中的传输</span>
          </div>

          <!-- 条目卡片（RepositionThemeTransition → card-list-move） -->
          <TransitionGroup name="card-list" tag="div">
            <div
              v-for="row in transfers.rows"
              :key="row.id"
              class="mb-1.5 rounded-lg p-2 last:mb-0"
              :style="{
                background: 'var(--fill-control)',
                border: '1px solid var(--line)',
              }"
            >
              <!-- 卡片头部：圆底状态图标 + 文件名 + 动作 -->
              <div class="flex items-center gap-3">
                <span
                  class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full"
                  :style="{ background: `color-mix(in srgb, ${stateColor(row)} 12%, transparent)` }"
                >
                  <component
                    :is="stateIcon(row)"
                    :size="16"
                    :style="{ color: stateColor(row) }"
                  />
                </span>
                <div class="min-w-0 flex-1">
                  <p class="truncate text-[13px]" :title="row.error ?? row.fileName">
                    {{ row.fileName }}
                  </p>
                  <p
                    v-if="!isActive(row)"
                    class="mt-0.5 truncate text-xs"
                    :style="{ color: row.status === 'failed' ? 'var(--danger)' : 'var(--dim)' }"
                    :title="terminalCaption(row)"
                  >
                    {{ terminalCaption(row) }}
                  </p>
                </div>
                <div class="flex shrink-0 items-center">
                  <template v-if="isActive(row)">
                    <!-- ⋯ 取消（Files MoreOptions → MenuFlyout） -->
                    <button
                      type="button"
                      class="btn-icon h-8 w-8"
                      title="更多选项"
                      :aria-label="`更多选项 ${row.fileName}`"
                      @click.stop="openCancelMenu(row, $event)"
                    >
                      <MoreHorizontal :size="16" />
                    </button>
                    <!-- 展开速度折线（仅运行中有速度数据） -->
                    <button
                      v-if="row.status === 'running'"
                      type="button"
                      class="btn-icon h-8 w-8"
                      :title="isExpanded(row.id) ? '收起' : '速度图表'"
                      :aria-label="isExpanded(row.id) ? `收起速度图表 ${row.fileName}` : `展开速度图表 ${row.fileName}`"
                      @click="toggleExpand(row.id)"
                    >
                      <ChevronDown
                        :size="16"
                        class="transition-transform"
                        :class="isExpanded(row.id) && 'rotate-180'"
                      />
                    </button>
                  </template>
                  <button
                    v-else
                    type="button"
                    class="btn-icon h-8 w-8"
                    title="清除"
                    :aria-label="`清除 ${row.fileName}`"
                    @click="transfers.removeRow(row.id)"
                  >
                    <X :size="16" />
                  </button>
                </div>
              </div>

              <!-- 进度区（仅进行中） -->
              <div v-if="isActive(row)" class="mt-2 pl-11">
                <!-- 排队：不定进度条 -->
                <template v-if="row.status === 'queued'">
                  <div
                    class="progress-indeterminate h-1 rounded-full"
                    :style="{ background: 'var(--fill-subtle)' }"
                  />
                  <p class="mt-1.5 text-xs text-dim">{{ progressCaption(row) }}</p>
                </template>

                <!-- 运行中：收起 = 进度条+百分比；展开 = 速度折线（Files SpeedGraph 近似） -->
                <template v-else>
                  <div v-if="!isExpanded(row.id)">
                    <div class="flex items-center gap-2">
                      <div
                        class="h-1 min-w-0 flex-1 rounded-full"
                        :style="{ background: 'var(--fill-subtle)' }"
                      >
                        <div
                          class="h-full rounded-full transition-[width] duration-200"
                          :style="{ width: `${percent(row)}%`, background: 'var(--accent)' }"
                        />
                      </div>
                      <span class="w-9 shrink-0 text-right font-mono text-[11px] tabular-nums text-dim">
                        {{ Math.floor(percent(row)) }}%
                      </span>
                    </div>
                    <p class="mt-1.5 truncate text-xs text-dim" :title="progressCaption(row)">
                      {{ progressCaption(row) }}
                    </p>
                  </div>
                  <div v-else>
                    <div
                      class="relative h-[88px] overflow-hidden rounded-md"
                      :style="{ border: '1px solid var(--line-strong)', background: 'var(--fill-subtle)' }"
                    >
                      <svg
                        class="absolute inset-0 h-full w-full"
                        viewBox="0 0 100 32"
                        preserveAspectRatio="none"
                        aria-hidden="true"
                      >
                        <defs>
                          <linearGradient
                            :id="`speed-grad-${row.id}`"
                            x1="0"
                            y1="0"
                            x2="0"
                            y2="1"
                          >
                            <stop offset="0%" stop-color="var(--accent)" stop-opacity="0.32" />
                            <stop offset="100%" stop-color="var(--accent)" stop-opacity="0" />
                          </linearGradient>
                        </defs>
                        <!-- 折线下渐变填充（Files SpeedGraph 的同款手法） -->
                        <polygon
                          v-if="speedPoints(row)"
                          :points="`${speedPoints(row)} 100,32 0,32`"
                          :fill="`url(#speed-grad-${row.id})`"
                        />
                        <polyline
                          :points="speedPoints(row)"
                          fill="none"
                          stroke="var(--accent)"
                          stroke-width="1.5"
                          vector-effect="non-scaling-stroke"
                          stroke-linejoin="round"
                          stroke-linecap="round"
                        />
                      </svg>
                      <!-- 速度芯片：实体底隔绝折线穿字 -->
                      <div
                        class="absolute top-1.5 right-1.5 rounded-[4px] px-2 py-1 text-right shadow-sm"
                        :style="{ background: 'var(--surface-solid)', border: '1px solid var(--line)' }"
                      >
                        <p class="text-[10px] leading-none text-dim">速度</p>
                        <p class="mt-1 text-[13px] leading-none font-semibold tabular-nums">
                          {{ formatSpeed(row.speedBps) }}
                        </p>
                      </div>
                    </div>
                    <!-- 展开态保留进度感知：进度条 + 百分比 + 字节数 -->
                    <div class="mt-2 flex items-center gap-2">
                      <div
                        class="h-1 min-w-0 flex-1 rounded-full"
                        :style="{ background: 'var(--fill-subtle)' }"
                      >
                        <div
                          class="h-full rounded-full transition-[width] duration-200"
                          :style="{ width: `${percent(row)}%`, background: 'var(--accent)' }"
                        />
                      </div>
                      <span class="w-9 shrink-0 text-right font-mono text-[11px] tabular-nums text-dim">
                        {{ Math.floor(percent(row)) }}%
                      </span>
                    </div>
                    <p class="mt-1 truncate text-xs text-dim">
                      {{ formatSize(row.bytes) }} / {{ formatSize(row.total) }}
                    </p>
                  </div>
                </template>
              </div>
            </div>
          </TransitionGroup>
        </div>
      </div>
    </Transition>

    <!-- 行级 ⋯ 菜单：取消传输（锚定按钮下方，不受面板裁剪） -->
    <ContextMenu
      :open="!!cancelMenu"
      :x="cancelMenu?.x ?? 0"
      :y="cancelMenu?.y ?? 0"
      :items="cancelMenuItems"
      @select="onCancelMenuSelect"
      @close="cancelMenu = null"
    />
  </div>
</template>
