use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::error::{Error, Result};
use crate::state::AppState;
use crate::transfer::{
    emit_state, finish_failed, run_download, run_upload, TransferHandle, TransferInfo,
    TransferManager,
};

/// 本地文件元数据（上传冲突对话框展示传入项的大小/修改时间）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalFileMeta {
    pub size: u64,
    pub mtime: Option<i64>,
    /// 递归传输冲突探测用：目录命中的条目按「合并」处理而非文件替换
    pub is_dir: bool,
}

/// 逐个读取本地文件元数据；读不到的槽位为 null（前端显示 —）。
#[tauri::command]
pub async fn local_file_meta(paths: Vec<String>) -> Result<Vec<Option<LocalFileMeta>>> {
    let mut out = Vec::with_capacity(paths.len());
    for path in &paths {
        out.push(tokio::fs::metadata(path).await.ok().map(|m| LocalFileMeta {
            size: m.len(),
            mtime: m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64),
            is_dir: m.is_dir(),
        }));
    }
    Ok(out)
}

/// 取路径最后一段做展示名（兼容 / 与 \）。
fn base_name(path: &str) -> String {
    path.rsplit(['/', '\\'])
        .next()
        .unwrap_or(path)
        .to_string()
}

/// 注册上传并立即返回；实际拷贝在后台任务流式进行。
#[tauri::command]
pub async fn ssh_upload(
    transfer_id: String,
    connection_id: String,
    local_path: String,
    remote_path: String,
    app: AppHandle,
    state: State<'_, AppState>,
    transfers: State<'_, TransferManager>,
) -> Result<()> {
    let session = state
        .get(&connection_id)
        .ok_or_else(|| Error::NoSession(connection_id.clone()))?;
    let handle = Arc::new(TransferHandle::new(
        transfer_id,
        connection_id.clone(),
        "upload",
        base_name(&local_path),
        0,
    ));
    transfers.register(handle.clone());

    // 本地元数据先行：文件夹直接判失败（面板可见，不占并发额度）
    match tokio::fs::metadata(&local_path).await {
        Err(e) => {
            finish_failed(&app, &handle, format!("读取本地文件失败: {e}")).await;
            return Ok(());
        }
        Ok(meta) if meta.is_dir() => {
            finish_failed(&app, &handle, "暂不支持上传文件夹，请拖入文件".into()).await;
            return Ok(());
        }
        Ok(meta) => handle.set_total(meta.len()),
    }
    emit_state(&app, &handle).await;

    let sem = transfers.semaphore(&connection_id);
    tauri::async_runtime::spawn(run_upload(
        app,
        handle,
        session,
        sem,
        local_path,
        remote_path,
    ));
    Ok(())
}

/// 注册下载并立即返回；先写 <目标>.vsshpart，成功后改名。
#[tauri::command]
pub async fn ssh_download(
    transfer_id: String,
    connection_id: String,
    remote_path: String,
    local_path: String,
    app: AppHandle,
    state: State<'_, AppState>,
    transfers: State<'_, TransferManager>,
) -> Result<()> {
    let session = state
        .get(&connection_id)
        .ok_or_else(|| Error::NoSession(connection_id.clone()))?;
    let handle = Arc::new(TransferHandle::new(
        transfer_id,
        connection_id.clone(),
        "download",
        base_name(&remote_path),
        0,
    ));
    transfers.register(handle.clone());
    emit_state(&app, &handle).await;

    let sem = transfers.semaphore(&connection_id);
    tauri::async_runtime::spawn(run_download(
        app,
        handle,
        session,
        sem,
        remote_path,
        local_path,
    ));
    Ok(())
}

/// 全部传输的当前快照（重启后队列为空属预期）。
#[tauri::command]
pub async fn ssh_transfer_list(
    transfers: State<'_, TransferManager>,
) -> Result<Vec<TransferInfo>> {
    Ok(transfers.list())
}

/// 请求取消；false = 不存在或已结束。
#[tauri::command]
pub async fn ssh_transfer_cancel(
    transfer_id: String,
    transfers: State<'_, TransferManager>,
) -> Result<bool> {
    Ok(transfers.cancel(&transfer_id))
}

/// 清除已结束的传输记录。
#[tauri::command]
pub async fn ssh_transfer_remove(
    transfer_id: String,
    transfers: State<'_, TransferManager>,
) -> Result<bool> {
    transfers.remove(&transfer_id)
}
