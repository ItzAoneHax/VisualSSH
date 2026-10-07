use clipboard_win::{formats::FileList, get_clipboard, is_format_avail, Setter};

use crate::clipboard_vfile::{self, VirtualFileEntry};
use crate::error::{Error, Result};
use crate::state::AppState;

/// 读取系统剪贴板的文件列表（CF_HDROP，本地资源管理器 Ctrl+C 的内容）。
/// 无文件列表时返回空 Vec（不视为错误）。
#[tauri::command]
pub async fn clipboard_read_files() -> Result<Vec<String>> {
    if !is_format_avail(FileList.into()) {
        return Ok(Vec::new());
    }
    match get_clipboard(FileList) {
        Ok(files) => Ok(files),
        // 剪贴板被其他进程短暂占用等情形：按"无文件"处理
        Err(_) => Ok(Vec::new()),
    }
}

/// 把一组本地文件路径写入系统剪贴板（CF_HDROP）。
/// 本地 → 远端方向之外的原生能力出口，保留备用。
#[tauri::command]
pub async fn clipboard_write_files(paths: Vec<String>) -> Result<()> {
    FileList
        .write_clipboard(&paths)
        .map_err(|e| Error::Clipboard(format!("写入系统剪贴板失败: {e}")))
}

/// 远端文件 → OLE 虚拟文件剪贴板（CFSTR_FILEDESCRIPTORW + FILECONTENTS）。
/// 复制瞬间零下载：粘贴到本地资源管理器时才经 IStream 按需流式拉取。
#[tauri::command]
pub async fn ssh_clipboard_copy_virtual(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    remote_dir: String,
    files: Vec<VirtualFileEntry>,
) -> Result<()> {
    let session = state
        .get(&connection_id)
        .ok_or_else(|| Error::NoSession(connection_id.clone()))?;
    clipboard_vfile::set_virtual_files(session, remote_dir, files).await
}
