import { invoke } from "@tauri-apps/api/core";

/**
 * 传输命令薄封装。transferId 由前端生成（crypto.randomUUID()），
 * 后端事件以它回推进度。
 */

export function uploadTransfer(
  transferId: string,
  connectionId: string,
  localPath: string,
  remotePath: string,
): Promise<void> {
  return invoke("ssh_upload", { transferId, connectionId, localPath, remotePath });
}

export function downloadTransfer(
  transferId: string,
  connectionId: string,
  remotePath: string,
  localPath: string,
): Promise<void> {
  return invoke("ssh_download", { transferId, connectionId, remotePath, localPath });
}

export function listTransfers(): Promise<unknown[]> {
  return invoke("ssh_transfer_list");
}

export function cancelTransfer(transferId: string): Promise<boolean> {
  return invoke("ssh_transfer_cancel", { transferId });
}

export function removeTransfer(transferId: string): Promise<boolean> {
  return invoke("ssh_transfer_remove", { transferId });
}

/** 本地文件元数据（冲突对话框展示传入项）；读不到的槽位为 null */
export interface LocalFileMeta {
  size: number;
  mtime: number | null;
}

export function localFileMeta(paths: string[]): Promise<(LocalFileMeta | null)[]> {
  return invoke("local_file_meta", { paths });
}
