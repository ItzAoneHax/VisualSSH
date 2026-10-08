//! 服务器侧压缩/解压执行层（第五阶段块 C）：exec 路线（远端本地压缩，零流量）。
//! 任务后台执行、可取消（关闭通道 → 远端进程随通道终止），终态经
//! archive://done:{runId} 事件回传（搜索 search.rs 同款：注册表 + 原子标志）。
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::ChannelMsg;
use serde::Serialize;
use tauri::Emitter;

use crate::state::SessionHandle;
use crate::ssh::build_command;

/// 完成事件名（含 runId，前端按 id 订阅）。
pub fn archive_event(run_id: &str) -> String {
    format!("archive://done:{run_id}")
}

/// 取消标志登记表（与 search.rs SearchManager 同款）。
#[derive(Default)]
pub struct ArchiveManager {
    entries: Mutex<HashMap<String, (String, Arc<AtomicBool>)>>,
}

impl ArchiveManager {
    fn register(&self, run_id: &str, connection_id: &str) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        self.entries
            .lock()
            .unwrap()
            .insert(run_id.to_string(), (connection_id.to_string(), Arc::clone(&flag)));
        flag
    }

    /// 请求取消；返回 false 表示任务不存在或已结束。
    pub fn cancel(&self, run_id: &str) -> bool {
        self.entries
            .lock()
            .unwrap()
            .get(run_id)
            .map(|(_, flag)| flag.store(true, Ordering::Relaxed))
            .is_some()
    }

    /// 断开连接时取消该连接的全部任务（连接随会话消失，卡片由前端标失败）。
    pub fn cancel_for_connection(&self, connection_id: &str) {
        for (cid, flag) in self.entries.lock().unwrap().values() {
            if cid == connection_id {
                flag.store(true, Ordering::Relaxed);
            }
        }
    }

    fn remove(&self, run_id: &str) {
        self.entries.lock().unwrap().remove(run_id);
    }
}

/// 终态事件负载：ok = 退出码 0；cancelled = 用户取消。
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveDone {
    pub run_id: String,
    pub ok: bool,
    pub exit_code: Option<u32>,
    pub stderr: String,
    pub cancelled: bool,
}

/// 压缩/解压整体预算（tar 静默运行无输出流可观察，取消是主要逃生通道；
/// 30 分钟兜底防服务器无响应挂死卡片）。
const ARCHIVE_TIMEOUT: Duration = Duration::from_secs(30 * 60);

/// 后台执行一条远端命令；取消 = 关闭通道（远端进程随通道终止）。
pub async fn run_archive(
    app: tauri::AppHandle,
    manager: Arc<ArchiveManager>,
    session: SessionHandle,
    run_id: String,
    connection_id: String,
    program: String,
    args: Vec<String>,
) {
    let cancelled_flag = manager.register(&run_id, &connection_id);

    // 打开通道并启动 exec；会话锁只在打开期间持有
    let mut channel_opt = {
        let s = session.session.lock().await;
        s.open_session_channel().await.ok()
    };
    let exec_ok = if let Some(channel) = channel_opt.as_mut() {
        let command = build_command(&program, &args);
        channel.exec(true, command.into_bytes()).await.is_ok()
    } else {
        false
    };

    let mut stderr: Vec<u8> = Vec::new();
    let mut exit_code: Option<u32> = None;
    if exec_ok {
        let channel = channel_opt.as_mut().expect("channel 在执行期间不会被取走");
        let collected = tokio::time::timeout(ARCHIVE_TIMEOUT, async {
            while let Some(msg) = channel.wait().await {
                if cancelled_flag.load(Ordering::Relaxed) {
                    break;
                }
                match msg {
                    ChannelMsg::ExtendedData { data, .. } => stderr.extend_from_slice(&data),
                    ChannelMsg::ExitStatus { exit_status } => exit_code = Some(exit_status),
                    ChannelMsg::Eof | ChannelMsg::Close => break,
                    _ => {}
                }
            }
        })
        .await;
        // 超时/取消：显式关闭通道终止远端进程
        if collected.is_err() || cancelled_flag.load(Ordering::Relaxed) {
            if let Some(channel) = channel_opt.take() {
                let _ = channel.close().await;
            }
        }
    } else if let Some(channel) = channel_opt.take() {
        let _ = channel.close().await;
    }

    let cancelled = cancelled_flag.load(Ordering::Relaxed);
    manager.remove(&run_id);
    let _ = app.emit(
        &archive_event(&run_id),
        ArchiveDone {
            run_id,
            ok: !cancelled && exec_ok && exit_code == Some(0),
            exit_code,
            // stderr 仅用于错误提示，截断防超长刷屏
            stderr: String::from_utf8_lossy(&stderr)
                .into_owned()
                .chars()
                .take(2000)
                .collect(),
            cancelled,
        },
    );
}
