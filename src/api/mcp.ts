/**
 * MCP 命令层包装：配置读写、状态、审计、确认回传、配置片段。
 * 配置本体在 Rust 侧 %APPDATA%/visualssh/mcp.json（hub 引导期自持），
 * 与其余 localStorage 设置分开。
 */

import { invoke } from "@tauri-apps/api/core";

export interface McpConfig {
  enabled: boolean;
  port: number;
  token: string;
  approved: boolean;
  confirmDelete: boolean;
  confirmExec: boolean;
  confirmOverwrite: boolean;
}

export interface McpStatus {
  running: boolean;
  enabled: boolean;
  port: number;
  error: string | null;
}

export interface McpAuditEntry {
  id: number;
  atMs: number;
  via: "http" | "stdio";
  tool: string;
  outcome: "ok" | "error" | "denied" | "timeout" | "trimmed";
  detail: string;
  /** 完整调用参数（大载荷已截断+指纹） */
  args?: Record<string, unknown>;
}

export interface McpAuditStats {
  total: number;
  diskBytes: number;
  buffered: number;
  degraded: string | null;
}

export interface McpGuide {
  key: string;
  name: string;
  steps: string[];
  /** 可复制内容（命令或 JSON；空 = 无代码块） */
  code: string;
}

export interface McpSnippets {
  guides: McpGuide[];
  httpUrl: string;
  httpToken: string;
  exePath: string;
}

export interface McpConfigPatch {
  enabled?: boolean;
  port?: number;
  confirmDelete?: boolean;
  confirmExec?: boolean;
  confirmOverwrite?: boolean;
}

export function mcpGetConfig() {
  return invoke<McpConfig>("mcp_get_config");
}

export function mcpSetConfig(patch: McpConfigPatch) {
  return invoke<McpStatus>("mcp_set_config", { patch });
}

export function mcpStatus() {
  return invoke<McpStatus>("mcp_status");
}

export function mcpResetToken() {
  return invoke<McpConfig>("mcp_reset_token");
}

export function mcpResetApproval() {
  return invoke<void>("mcp_reset_approval");
}

export function mcpAuditList(sinceId = 0, limit = 200) {
  return invoke<McpAuditEntry[]>("mcp_audit_list", { sinceId, limit });
}

export function mcpAuditStats() {
  return invoke<McpAuditStats>("mcp_audit_stats");
}

/** 导出全量审计为解压 JSONL；返回导出条数 */
export function mcpAuditExport(dest: string) {
  return invoke<number>("mcp_audit_export", { dest });
}

export function mcpAuditClear() {
  return invoke<void>("mcp_audit_clear");
}

export function mcpConfirmResolve(id: number, approved: boolean) {
  return invoke<boolean>("mcp_confirm_resolve", { id, approved });
}

export function mcpPendingConfirms() {
  return invoke<{ id: number; summary: string; raw?: string | null }[]>(
    "mcp_pending_confirms",
  );
}

/** profiles 推送：只含连接元数据，绝不含凭据字段 */
export function mcpSyncProfiles(
  profiles: {
    id: string;
    name: string;
    host: string;
    port: number;
    username: string;
    privateKeyPath?: string | null;
  }[],
) {
  return invoke<void>("mcp_sync_profiles", { profiles });
}

export function mcpSnippets() {
  return invoke<McpSnippets>("mcp_snippets");
}
