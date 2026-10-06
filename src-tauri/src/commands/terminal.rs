use std::sync::Arc;

use base64::{engine::general_purpose::STANDARD, Engine};
use tauri::{AppHandle, State};

use crate::error::{Error, Result};
use crate::state::AppState;
use crate::terminal::{open_terminal, TerminalCmd, TerminalManager};

/// 打开终端（PTY → cd cwd → 登录 shell），返回 terminalId。
#[tauri::command]
pub async fn ssh_open_terminal(
    connection_id: String,
    cwd: String,
    app: AppHandle,
    state: State<'_, AppState>,
    terminals: State<'_, Arc<TerminalManager>>,
) -> Result<String> {
    let session = state
        .get(&connection_id)
        .ok_or_else(|| Error::NoSession(connection_id.clone()))?;
    let terminal_id = uuid::Uuid::new_v4().to_string();
    open_terminal(
        app,
        Arc::clone(&terminals),
        session,
        terminal_id.clone(),
        connection_id,
        &cwd,
    )
    .await?;
    Ok(terminal_id)
}

/// 终端输入（base64）。
#[tauri::command]
pub async fn ssh_terminal_write(
    terminal_id: String,
    data: String,
    terminals: State<'_, Arc<TerminalManager>>,
) -> Result<()> {
    let bytes = STANDARD
        .decode(data)
        .map_err(|_| Error::Terminal("终端输入编码错误".into()))?;
    terminals.send(&terminal_id, TerminalCmd::Write(bytes))
}

/// 终端尺寸变更（fit addon 计算出的 cols/rows）。
#[tauri::command]
pub async fn ssh_terminal_resize(
    terminal_id: String,
    cols: u32,
    rows: u32,
    terminals: State<'_, Arc<TerminalManager>>,
) -> Result<()> {
    terminals.send(&terminal_id, TerminalCmd::Resize(cols, rows))
}

/// 主动关闭终端（面板关闭时调用；连接断开由后端联动）。
#[tauri::command]
pub async fn ssh_terminal_close(
    terminal_id: String,
    terminals: State<'_, Arc<TerminalManager>>,
) -> Result<()> {
    terminals.send(&terminal_id, TerminalCmd::Close)
}
