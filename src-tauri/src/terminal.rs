use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use tauri::Emitter;
use tokio::sync::mpsc;

use crate::error::{Error, Result};
use crate::state::SessionHandle;
use russh::ChannelMsg;

/// 终端数据事件（payload 为 base64，避免 Vec<u8> 在 JSON 里膨胀 3 倍）。
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TerminalDataEvent {
    pub terminal_id: String,
    pub data: String,
}

/// 终端退出事件（shell 结束 / 连接断开）。
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TerminalExitEvent {
    pub terminal_id: String,
    pub exit_status: Option<u32>,
}

pub const EVENT_DATA: &str = "terminal://data";
pub const EVENT_EXIT: &str = "terminal://exit";

/// 任务命令：写 / 改窗口 / 关闭。写与 resize 都是 channel 的 &self 方法，
/// 但 channel 由读任务独占（wait 需要 &mut），故全部经 mpsc 转交任务执行。
pub enum TerminalCmd {
    Write(Vec<u8>),
    Resize(u32, u32),
    Close,
}

/// 一条已打开的终端会话（命令通道仅剩发送端）。
pub struct TerminalSession {
    pub connection_id: String,
    pub cmd_tx: mpsc::UnboundedSender<TerminalCmd>,
}

/// 全局终端管理器。锁内不含 await；会话任务自终止后自行摘除。
#[derive(Default)]
pub struct TerminalManager {
    sessions: Mutex<HashMap<String, TerminalSession>>,
}

impl TerminalManager {
    pub fn insert(&self, terminal_id: String, session: TerminalSession) {
        self.sessions.lock().unwrap().insert(terminal_id, session);
    }

    pub fn send(&self, terminal_id: &str, cmd: TerminalCmd) -> Result<()> {
        let tx = self
            .sessions
            .lock()
            .unwrap()
            .get(terminal_id)
            .map(|s| s.cmd_tx.clone());
        match tx {
            Some(tx) => tx.send(cmd).map_err(|_| Error::Terminal("终端已关闭".into())),
            None => Err(Error::Terminal("终端不存在或已关闭".into())),
        }
    }

    /// 断开连接时关闭该连接的全部终端。
    pub fn close_for_connection(&self, connection_id: &str) {
        for (_, session) in self
            .sessions
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, s)| s.connection_id == connection_id)
        {
            let _ = session.cmd_tx.send(TerminalCmd::Close);
        }
    }

    fn remove(&self, terminal_id: &str) {
        self.sessions.lock().unwrap().remove(terminal_id);
    }
}

/// 建立 PTY：xterm-256color 120×30，cd 到指定目录后 exec 登录 shell。
/// shell 命令用单引号包裹 cwd（内部单引号转义），并 exec 保证 wait 语义干净。
pub async fn open_terminal(
    app: tauri::AppHandle,
    manager: Arc<TerminalManager>,
    session: SessionHandle,
    terminal_id: String,
    connection_id: String,
    cwd: &str,
) -> Result<()> {
    let channel = {
        let s = session.session.lock().await;
        s.open_session_channel().await?
    };
    channel
        .request_pty(true, "xterm-256color", 120, 30, 0, 0, &[])
        .await
        .map_err(|e| Error::Terminal(format!("申请伪终端失败: {e}")))?;

    let safe_cwd = cwd.replace('\'', r"'\''");
    let command = format!("cd '{safe_cwd}' && exec $SHELL -l");
    channel
        .exec(true, command.as_bytes().to_vec())
        .await
        .map_err(|e| Error::Terminal(format!("启动 shell 失败: {e}")))?;

    let (cmd_tx, cmd_rx) = mpsc::unbounded_channel();
    manager.insert(
        terminal_id.clone(),
        TerminalSession {
            connection_id: connection_id.clone(),
            cmd_tx,
        },
    );
    tauri::async_runtime::spawn(run_terminal(
        app,
        manager,
        channel,
        terminal_id,
        cmd_rx,
    ));
    Ok(())
}

/// 终端会话任务：wait() 消息循环 + mpsc 命令分支；输出按 4ms 窗口批量合并，
/// 避免高频事件打爆 IPC。
async fn run_terminal(
    app: tauri::AppHandle,
    manager: Arc<TerminalManager>,
    mut channel: russh::Channel<russh::client::Msg>,
    terminal_id: String,
    mut cmd_rx: mpsc::UnboundedReceiver<TerminalCmd>,
) {
    let mut pending: Vec<u8> = Vec::with_capacity(8 * 1024);
    let mut exit_status: Option<u32> = None;
    let mut running = true;
    while running {
        tokio::select! {
            cmd = cmd_rx.recv() => match cmd {
                None | Some(TerminalCmd::Close) => break,
                Some(TerminalCmd::Write(bytes)) => {
                    if channel.data(bytes.as_slice()).await.is_err() {
                        break;
                    }
                }
                Some(TerminalCmd::Resize(cols, rows)) => {
                    let _ = channel.window_change(cols, rows, 0, 0).await;
                }
            },
            msg = channel.wait() => match msg {
                Some(ChannelMsg::Data { data }) => {
                    pending.extend_from_slice(&data);
                }
                // stderr（如 bash 报错）一并送入终端显示
                Some(ChannelMsg::ExtendedData { data, .. }) => {
                    pending.extend_from_slice(&data);
                }
                Some(ChannelMsg::ExitStatus { exit_status: code }) => {
                    exit_status = Some(code);
                }
                Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => {
                    running = false;
                }
                _ => {}
            },
            // 无新数据也定期冲刷，保证提示符低延迟
            _ = tokio::time::sleep(Duration::from_millis(4)), if !pending.is_empty() => {
                flush(&app, &terminal_id, &mut pending);
            }
        }
    }
    flush(&app, &terminal_id, &mut pending);
    let _ = channel.close().await;
    let _ = app.emit(
        EVENT_EXIT,
        TerminalExitEvent {
            terminal_id: terminal_id.clone(),
            exit_status,
        },
    );
    manager.remove(&terminal_id);
}

fn flush(app: &tauri::AppHandle, terminal_id: &str, pending: &mut Vec<u8>) {
    if pending.is_empty() {
        return;
    }
    let _ = app.emit(
        EVENT_DATA,
        TerminalDataEvent {
            terminal_id: terminal_id.to_string(),
            data: STANDARD.encode(&pending),
        },
    );
    pending.clear();
}
