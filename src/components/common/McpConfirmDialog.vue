<script setup lang="ts">
/**
 * MCP 确认对话框：危险操作拦截 / 首次接入批准共用（ContentDialog 样式）。
 * 主文案为 Rust 侧翻译的人读中文描述；可展开查看原始指令（命令/参数 JSON）。
 */

import { Bot, ChevronDown } from "@lucide/vue";
import { ref, watch } from "vue";

import Modal from "@/components/common/Modal.vue";
import { hasRawDetail, useMcpGateStore } from "@/stores/mcpGate";

const gate = useMcpGateStore();
const showRaw = ref(false);
// 切换到下一条请求时收起展开态
watch(
  () => gate.current?.id,
  () => {
    showRaw.value = false;
  },
);
</script>

<template>
  <Modal
    :open="!!gate.current"
    title="VisualSSH MCP 请求确认"
    :max-width="440"
    @close="gate.resolve(false)"
  >
    <div class="flex items-center gap-3">
      <div
        class="flex h-8 w-8 shrink-0 items-center justify-center rounded-[4px]"
        :style="{ background: 'var(--row-hover)' }"
      >
        <Bot :size="16" class="text-dim" />
      </div>
      <p class="min-w-0 flex-1 break-words whitespace-pre-line text-sm leading-6">
        {{ gate.current?.summary }}
      </p>
    </div>

    <!-- 原始指令：默认折叠，点开查看 Agent 实际发出的命令/参数 -->
    <div v-if="hasRawDetail(gate.current)" class="mt-3">
      <button
        type="button"
        class="flex items-center gap-1 text-xs text-dim transition-colors hover:text-ink"
        :aria-expanded="showRaw"
        @click="showRaw = !showRaw"
      >
        <ChevronDown :size="12" class="transition-transform" :class="showRaw && 'rotate-180'" />
        {{ showRaw ? "收起原始指令" : "查看原始指令" }}
      </button>
      <pre
        v-if="showRaw"
        class="mt-2 max-h-48 overflow-auto rounded-[4px] p-2.5 font-mono text-xs leading-5"
        :style="{ background: 'var(--row-hover)' }"
        >{{ gate.current?.raw }}</pre
      >
    </div>

    <p class="mt-3 text-xs text-dim">
      请确认这次操作符合预期；25 秒内未回应将视为拒绝。
    </p>
    <div class="mt-4 flex justify-end gap-2">
      <button type="button" class="btn-secondary" @click="gate.resolve(false)">拒绝</button>
      <button type="button" class="btn-primary" @click="gate.resolve(true)">允许</button>
    </div>
  </Modal>
</template>
