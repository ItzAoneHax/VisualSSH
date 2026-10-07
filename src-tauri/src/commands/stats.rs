use std::sync::Arc;

use tauri::{AppHandle, State};

use crate::error::{Error, Result};
use crate::ssh::join_remote;
use crate::state::AppState;
use crate::stats::{self, StatsManager};

/// 启动目录递归统计并立即返回；进度经 props://stats:{stats_id} 事件推送。
/// subpaths 为空统计 path 本身，否则统计 path 下指定子项（多选属性）。
#[tauri::command]
pub async fn ssh_dir_stats(
    stats_id: String,
    connection_id: String,
    path: String,
    subpaths: Option<Vec<String>>,
    app: AppHandle,
    state: State<'_, AppState>,
    stats: State<'_, Arc<StatsManager>>,
) -> Result<()> {
    let session = state
        .get(&connection_id)
        .ok_or_else(|| Error::NoSession(connection_id.clone()))?;
    let subs = subpaths.unwrap_or_default();
    let roots = if subs.is_empty() {
        vec![path]
    } else {
        subs.into_iter().map(|name| join_remote(&path, &name)).collect()
    };
    tauri::async_runtime::spawn(stats::run_stats(
        app,
        Arc::clone(&stats),
        session,
        stats_id,
        connection_id,
        roots,
    ));
    Ok(())
}

/// 请求取消统计；false = 任务不存在或已结束。
#[tauri::command]
pub async fn ssh_dir_stats_cancel(
    stats_id: String,
    stats: State<'_, Arc<StatsManager>>,
) -> Result<bool> {
    Ok(stats.cancel(&stats_id))
}
