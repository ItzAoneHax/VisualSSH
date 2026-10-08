import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/**
 * 递归枚举命令封装（远端 walk 通用层 + 本地 walk）。清单编排（recursiveTransfer.ts）消费。
 */

/** 清单文件条目（相对 root 的 posix 分隔路径；本地版 path 为绝对路径） */
export interface WalkFile {
  path: string;
  size: number;
  kind: "file" | "symlink" | "other";
}

export interface WalkOutput {
  dirs: string[];
  files: WalkFile[];
  skippedLinks: number;
  failedDirs: number;
}

export interface WalkResult {
  cancelled: boolean;
  output: WalkOutput;
}

/** walk://progress:{walkId} 事件负载 */
export interface WalkProgress {
  walkId: string;
  dirs: number;
  files: number;
  bytes: number;
  skippedLinks: number;
}

/** 递归枚举远端目录（await 返回清单；进度经事件，取消经 sshWalkCancel） */
export function walkRemote(walkId: string, connectionId: string, root: string): Promise<WalkResult> {
  return invoke("ssh_walk_remote", { walkId, connectionId, root });
}

export function walkCancel(walkId: string): Promise<boolean> {
  return invoke("ssh_walk_cancel", { walkId });
}

/** 本地目录枚举（上传文件夹清单；不跟随符号链接） */
export function walkLocal(root: string): Promise<WalkOutput> {
  return invoke("walk_local", { root });
}

/** 本地逐级建目录（下载文件夹本地侧；幂等） */
export function localMkdirP(path: string): Promise<void> {
  return invoke("local_mkdir_p", { path });
}

/** 订阅指定枚举的进度（事件名 walk://progress:{walkId}，同 props://stats 模式） */
export function onWalkProgress(
  walkId: string,
  handler: (p: WalkProgress) => void,
): Promise<() => void> {
  return listen<WalkProgress>(`walk://progress:${walkId}`, (event) => handler(event.payload));
}
