import { invoke } from "@tauri-apps/api/core";

/**
 * 系统剪贴板薄封装：
 * 远端 Ctrl+C → OLE 虚拟文件（粘贴到本地资源管理器时才下载）；
 * 本地 Ctrl+V → 读 CF_HDROP 文件列表上传远端。
 */

/** 虚拟文件清单条目（name/size/mtime 来自前端 FileEntry，复制瞬间零网络） */
export interface VirtualFileSpec {
  name: string;
  size: number;
  mtime: number | null;
}

/** 远端文件 → OLE 虚拟文件剪贴板（FileZilla 式，粘贴时才经 IStream 流式拉取） */
export function copyVirtualFiles(
  connectionId: string,
  remoteDir: string,
  files: VirtualFileSpec[],
): Promise<void> {
  return invoke("ssh_clipboard_copy_virtual", { connectionId, remoteDir, files });
}

export function readClipboardFiles(): Promise<string[]> {
  return invoke("clipboard_read_files");
}

/** 把本地路径写入系统剪贴板（CF_HDROP）；与虚拟文件无关的原生能力出口 */
export function writeClipboardFiles(paths: string[]): Promise<void> {
  return invoke("clipboard_write_files", { paths });
}
