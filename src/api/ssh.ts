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

export function mkdirSsh(connectionId: string, path: string): Promise<void> {
  return invoke("ssh_mkdir", { connectionId, path });
}

export function touchSsh(connectionId: string, path: string): Promise<void> {
  return invoke("ssh_touch", { connectionId, path });
}

export function renameSsh(
  connectionId: string,
  oldPath: string,
  newPath: string,
): Promise<void> {
  return invoke("ssh_rename", { connectionId, oldPath, newPath });
}

export function deleteSsh(
  connectionId: string,
  path: string,
  recursive: boolean,
): Promise<void> {
  return invoke("ssh_delete", { connectionId, path, recursive });
}

export function chmodSsh(
  connectionId: string,
  path: string,
  mode: number,
): Promise<void> {
  return invoke("ssh_chmod", { connectionId, path, mode });
}

/** 读文本文件（UTF-8，≤2MB） */
export function readFileSsh(connectionId: string, path: string): Promise<string> {
  return invoke("ssh_read_file", { connectionId, path });
}

/** 原子写回（同目录临时文件 + rename） */
export function writeFileSsh(
  connectionId: string,
  path: string,
  content: string,
): Promise<void> {
  return invoke("ssh_write_file", { connectionId, path, content });
}

export function disconnectSsh(connectionId: string): Promise<void> {
  return invoke("ssh_disconnect", { connectionId });
}

/** 读取符号链接目标（属性对话框） */
export function readLinkSsh(connectionId: string, path: string): Promise<string> {
  return invoke("ssh_read_link", { connectionId, path });
}

/** 目录递归统计进度事件负载（props://stats:{statsId}） */
export interface DirStatsProgress {
  statsId: string;
  files: number;
  dirs: number;
  bytes: number;
  done: boolean;
}

/** 启动目录递归统计；进度经 props://stats:{statsId} 推送，subpaths 为多选子项名 */
export function dirStats(
  connectionId: string,
  path: string,
  subpaths?: string[],
): Promise<void> {
  return invoke("ssh_dir_stats", { connectionId, path, subpaths });
}

/** 请求取消统计任务 */
export function dirStatsCancel(statsId: string): Promise<boolean> {
  return invoke("ssh_dir_stats_cancel", { statsId });
}

/** 指纹变更经用户确认后，更新 known_hosts 记录（随后重连） */
export function trustHost(
  host: string,
  port: number,
  algorithm: string,
  fingerprint: string,
): Promise<void> {
  return invoke("ssh_trust_host", { host, port, algorithm, fingerprint });
}
