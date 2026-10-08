import { invoke } from "@tauri-apps/api/core";

import type {
  ConnectResult,
  FileEntry,
  FileKind,
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

/** 单路径属性（递归传输用：mkdir 报错时判定「已存在目录」当成功） */
export interface SshStat {
  kind: FileEntry["kind"];
  size: number;
}

export function statSsh(connectionId: string, path: string): Promise<SshStat> {
  return invoke("ssh_stat", { connectionId, path });
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

/** 读文件字节（base64；图片预览 ≤10MB / 缩略图 ≤2MB，上限由前端按用途传入） */
export function readFileBase64(
  connectionId: string,
  path: string,
  maxBytes: number,
): Promise<string> {
  return invoke("ssh_read_file_base64", { connectionId, path, maxBytes });
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
  statsId: string,
  subpaths?: string[],
): Promise<void> {
  return invoke("ssh_dir_stats", { connectionId, path, statsId, subpaths });
}

/** 请求取消统计任务 */
export function dirStatsCancel(statsId: string): Promise<boolean> {
  return invoke("ssh_dir_stats_cancel", { statsId });
}

/** 远端 exec 结果（UTF-8 lossy）；exitCode 为 null 表示被信号终止或未收到退出状态 */
export interface ExecOutput {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/** 在远端 shell 执行命令（argv 由后端 POSIX 单引号包裹，30s 整体超时） */
export function execSsh(
  connectionId: string,
  program: string,
  args: string[],
): Promise<ExecOutput> {
  return invoke("ssh_exec", { connectionId, program, args });
}

/** 递归搜索命中：条目元数据 + 相对搜索目录的路径 */
export interface SearchHit {
  name: string;
  kind: FileKind;
  size: number;
  permissions: string;
  mtime: number | null;
  owner?: string | null;
  group?: string | null;
  atime?: number | null;
  relPath: string;
}

/** 搜索事件负载（search://result:{searchId}）：批量追加，done=true 终态 */
export interface SearchProgress {
  searchId: string;
  hits: SearchHit[];
  done: boolean;
  cancelled: boolean;
  capped: boolean;
}

/** 启动递归搜索（exec find 优先，不可用回退 SFTP walk）；结果经事件批量推送 */
export function searchStart(
  searchId: string,
  connectionId: string,
  dir: string,
  query: string,
): Promise<void> {
  return invoke("ssh_search_start", { searchId, connectionId, dir, query });
}

/** 请求取消递归搜索；false = 任务不存在或已结束 */
export function searchCancel(searchId: string): Promise<boolean> {
  return invoke("ssh_search_cancel", { searchId });
}

/** 文件系统容量（fs_info；服务器不支持 statvfs 时为 null） */
export interface FsInfo {
  total: number;
  free: number;
}

/** 读取路径所在文件系统容量；None = 服务器不支持，UI 整体不渲染 */
export function fsInfo(connectionId: string, path: string): Promise<FsInfo | null> {
  return invoke("ssh_fs_info", { connectionId, path });
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
