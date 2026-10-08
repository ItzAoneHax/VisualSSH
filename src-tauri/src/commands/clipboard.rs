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

/// 读取剪贴板图片为 PNG 字节（块 B）。格式优先级 CF_PNG > CF_DIBV5 > CF_DIB；
/// 无图返回 None。剪贴板 API 为同步阻塞，放阻塞线程池避免卡命令调度。
#[tauri::command]
pub async fn clipboard_read_image() -> Result<Option<Vec<u8>>> {
    tauri::async_runtime::spawn_blocking(|| Ok(crate::clipboard_image::read_image_png()))
        .await
        .map_err(|e| Error::Clipboard(format!("读取剪贴板图片失败: {e}")))?
}

/// paste-<yyyyMMdd-HHmmss> 时间戳（ASCII 安全文件名；Howard Hinnant civil_from_days）
fn paste_timestamp() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let (h, min, s) = ((secs % 86400) / 3600, (secs % 3600) / 60, secs % 60);
    let days = (secs / 86400) as i64;
    // civil_from_days：Unix 天数 → (y, mo, d)
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if mo <= 2 { y + 1 } else { y };
    format!("{y:04}{mo:02}{d:02}-{h:02}{min:02}{s:02}")
}

/// 把 PNG 字节落盘到系统临时目录 paste-<yyyyMMdd-HHmmss>.png，返回路径（上传管线消费）。
#[tauri::command]
pub async fn clipboard_save_image(png: Vec<u8>) -> Result<String> {
    let name = format!("paste-{}.png", paste_timestamp());
    let path = std::env::temp_dir().join(name);
    tokio::fs::write(&path, png)
        .await
        .map_err(|e| Error::Clipboard(format!("写入临时图片失败: {e}")))?;
    Ok(path.to_string_lossy().to_string())
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
