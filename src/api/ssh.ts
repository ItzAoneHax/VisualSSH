import { invoke } from "@tauri-apps/api/core";

import type {
  ConnectResult,
  FileEntry,
  SshProfileInput,
  TestResult,
} from "@/types";

/**
 * 前端 ↔ Rust 核心的唯一通道薄封装。
 * 所有命令的参数/返回与 src-tauri/src/commands/ssh.rs 中的结构体一一对应。
 */

export function connectSsh(
  alias: string,
  profile: SshProfileInput,
): Promise<ConnectResult> {
  return invoke("ssh_connect", { alias, profile });
}

export function testSsh(profile: SshProfileInput): Promise<TestResult> {
  return invoke("ssh_test", { profile });
}

export function listDir(
  connectionId: string,
  path: string,
): Promise<FileEntry[]> {
  return invoke("ssh_list_dir", { connectionId, path });
}

export function disconnectSsh(connectionId: string): Promise<void> {
  return invoke("ssh_disconnect", { connectionId });
}
