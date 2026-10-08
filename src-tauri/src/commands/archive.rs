//! 压缩/解压命令层（第五阶段块 C）：启动后台 exec 任务 + 请求取消。
//! 命令的拼装（格式 → tar/zip 参数）在前端 utils/archive.ts，此处只负责执行与取消。
use std::sync::Arc;

use tauri::{AppHandle, State};

use crate::archive::{run_archive, ArchiveManager};
use crate::error::{Error, Result};
use crate::state::AppState;

/// 启动后台压缩/解压 exec；终态经 archive://done:{runId} 事件推送。
#[tauri::command]
pub async fn ssh_archive_start(
    run_id: String,
    connection_id: String,
    program: String,
    args: Vec<String>,
    app: AppHandle,
    state: State<'_, AppState>,
    manager: State<'_, Arc<ArchiveManager>>,
) -> Result<()> {
    let session = state
        .get(&connection_id)
        .ok_or_else(|| Error::NoSession(connection_id.clone()))?;
    tauri::async_runtime::spawn(run_archive(
        app,
        Arc::clone(&manager),
        session,
        run_id,
        connection_id,
        program,
        args,
    ));
    Ok(())
}

/// 请求取消；false = 任务不存在或已结束。
#[tauri::command]
pub async fn ssh_archive_cancel(
    run_id: String,
    manager: State<'_, Arc<ArchiveManager>>,
) -> Result<bool> {
    Ok(manager.cancel(&run_id))
}
