/**
 * MCP 确认门（全局）：危险操作拦截与首次接入批准的弹窗状态机。
 * Rust 侧 wait_approval 挂起 → emit mcp://confirm {id, summary} →
 * 本 store 入列 → McpConfirmDialog 渲染 → mcp_confirm_resolve 回传。
 * 挂载时拉一次 pending（重挂/刷新后恢复未决弹窗）。
 */

import { defineStore } from "pinia";
import { ref } from "vue";

import { mcpConfirmResolve, mcpPendingConfirms } from "@/api/mcp";

export interface McpConfirmRequest {
  id: number;
  /** 人读的中文描述 */
  summary: string;
  /** 原始指令（命令串或参数 JSON）；接入批准等无指令事件为空 */
  raw?: string | null;
}

/** 原始指令是否值得展开（极短且与摘要相同的就不必了） */
export function hasRawDetail(req: McpConfirmRequest | null): boolean {
  const raw = req?.raw?.trim();
  return !!raw && raw !== req?.summary;
}

export const useMcpGateStore = defineStore("mcpGate", () => {
  /** 同一时刻至多展示最早一条（MCP 客户端按序请求时天然串行） */
  const queue = ref<McpConfirmRequest[]>([]);

  const current = ref<McpConfirmRequest | null>(null);

  function push(req: McpConfirmRequest) {
    if (queue.value.some((q) => q.id === req.id)) return;
    queue.value.push(req);
    advance();
  }

  function advance() {
    if (!current.value && queue.value.length) {
      current.value = queue.value.shift() ?? null;
    }
  }

  async function resolve(approved: boolean) {
    const req = current.value;
    current.value = null;
    advance();
    if (!req) return;
    try {
      await mcpConfirmResolve(req.id, approved);
    } catch {
      // Rust 侧已超时清理：忽略
    }
  }

  async function restore() {
    if (!("__TAURI_INTERNALS__" in window)) return;
    try {
      const pending = await mcpPendingConfirms();
      for (const p of pending) push(p);
    } catch {
      // 非 Tauri 环境（浏览器预览）：无操作
    }
  }

  void restore();

  return { current, push, resolve, restore };
});
