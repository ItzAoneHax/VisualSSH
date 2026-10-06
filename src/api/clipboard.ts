import { invoke } from "@tauri-apps/api/core";

/**
 * 系统剪贴板文件列表（CF_HDROP）薄封装：
 * 远端 Ctrl+C（写）/ 本地 Ctrl+V（读）的跨端文件通道。
 */

export function readClipboardFiles(): Promise<string[]> {
  return invoke("clipboard_read_files");
}

export function writeClipboardFiles(paths: string[]): Promise<void> {
  return invoke("clipboard_write_files", { paths });
}

/** 暂存目录（%TEMP%/VisualSSH/<uuid>），剪贴板下载落地区 */
export function stageDir(): Promise<string> {
  return invoke("ssh_clipboard_stage_dir");
}
