use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::Emitter;
use tokio::task::JoinSet;

use crate::state::SessionHandle;
use crate::walk::{run_walk, WalkDelta, WalkManager};

/// 统计进度事件名（含 statsId，前端按 id 订阅）。
pub fn stats_event(stats_id: &str) -> String {
    format!("props://stats:{stats_id}")
}

/// 统计进度事件负载；done=true 为最终结果（取消时也发，携带已统计的部分值）。
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StatsProgress {
    pub stats_id: String,
    pub files: u64,
    pub dirs: u64,
    pub bytes: u64,
    pub done: bool,
}

/// 进度事件节流间隔。
const EMIT_INTERVAL: Duration = Duration::from_millis(200);

/// 取消登记类型沿用通用 walk 的管理器（命令层类型引用不变）。
pub use crate::walk::WalkManager as StatsManager;

/// 启动统计任务：对每个根目录并发递归 readdir，累计文件/文件夹数与字节数。
/// 枚举本体抽为通用 walk（walk.rs，本阶段起与递归传输共用）；
/// 符号链接不跟随（防环，Files BaseProperties 跳过 ReparsePoint 的远端版）；
/// 单目录失败静默跳过（统计尽力而为）。结束后补发 done=true（取消时带部分值）。
pub async fn run_stats(
    app: tauri::AppHandle,
    manager: Arc<WalkManager>,
    session: SessionHandle,
    stats_id: String,
    connection_id: String,
    roots: Vec<String>,
) {
    let cancelled = manager.register(&stats_id, &connection_id);
    let files = Arc::new(AtomicU64::new(0));
    let dirs = Arc::new(AtomicU64::new(0));
    let bytes = Arc::new(AtomicU64::new(0));
    let last_emit = Arc::new(Mutex::new(Instant::now()));

    // 每次 readdir 完成的增量回调：累计计数并节流推送（与原 walk 内置节流同款）
    let on_delta = {
        let app = app.clone();
        let stats_id = stats_id.clone();
        let files = Arc::clone(&files);
        let dirs = Arc::clone(&dirs);
        let bytes = Arc::clone(&bytes);
        let last_emit = Arc::clone(&last_emit);
        move |d: WalkDelta| {
            files.fetch_add(d.files, Ordering::Relaxed);
            dirs.fetch_add(d.dirs, Ordering::Relaxed);
            bytes.fetch_add(d.bytes, Ordering::Relaxed);
            let mut last = last_emit.lock().unwrap();
            if last.elapsed() < EMIT_INTERVAL {
                return;
            }
            *last = Instant::now();
            let _ = app.emit(
                &stats_event(&stats_id),
                StatsProgress {
                    stats_id: stats_id.clone(),
                    files: files.load(Ordering::Relaxed),
                    dirs: dirs.load(Ordering::Relaxed),
                    bytes: bytes.load(Ordering::Relaxed),
                    done: false,
                },
            );
        }
    };

    let mut set = JoinSet::new();
    for root in roots {
        let session = session.clone();
        let cancelled = Arc::clone(&cancelled);
        let on_delta: Box<dyn Fn(WalkDelta) + Send + Sync> = Box::new(on_delta.clone());
        set.spawn(async move { run_walk(session, root, cancelled, on_delta).await });
    }
    while set.join_next().await.is_some() {}

    manager.remove(&stats_id);
    let _ = app.emit(
        &stats_event(&stats_id),
        StatsProgress {
            stats_id,
            files: files.load(Ordering::Relaxed),
            dirs: dirs.load(Ordering::Relaxed),
            bytes: bytes.load(Ordering::Relaxed),
            done: true,
        },
    );
}
