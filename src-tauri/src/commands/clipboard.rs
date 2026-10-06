use clipboard_win::{formats::FileList, get_clipboard, is_format_avail, Setter};

use crate::error::{Error, Result};

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

/// 把一组本地文件路径写入系统剪贴板（CF_HDROP），
/// 之后可在本地资源管理器 Ctrl+V 粘贴。
#[tauri::command]
pub async fn clipboard_write_files(paths: Vec<String>) -> Result<()> {
    FileList
        .write_clipboard(&paths)
        .map_err(|e| Error::Clipboard(format!("写入系统剪贴板失败: {e}")))
}

/// 为"远端 → 本地剪贴板"准备暂存目录：%TEMP%/VisualSSH/<uuid>。
/// 文件先静默下载到这里，全部完成后写入剪贴板。
#[tauri::command]
pub async fn ssh_clipboard_stage_dir() -> Result<String> {
    let dir = std::env::temp_dir()
        .join("VisualSSH")
        .join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir_all(&dir)
        .map_err(|e| Error::Clipboard(format!("创建暂存目录失败: {e}")))?;
    Ok(dir.to_string_lossy().into_owned())
}
