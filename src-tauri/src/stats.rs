use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::Emitter;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio::task::JoinSet;

use crate::state::SessionHandle;

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

/// 并发 readdir 上限。
const WALK_CONCURRENCY: usize = 16;
/// 等待并发额度时轮询取消的间隔。
const CANCEL_POLL: Duration = Duration::from_millis(100);
/// 单目录 listDir 预算。
const LIST_TIMEOUT: Duration = Duration::from_secs(30);
/// 进度事件节流间隔。
const EMIT_INTERVAL: Duration = Duration::from_millis(200);

/// 取消标志登记表（取消机制与 transfer.rs 同款：注册表 + 原子标志）。
#[derive(Default)]
pub struct StatsManager {
    entries: Mutex<HashMap<String, (String, Arc<AtomicBool>)>>,
}

impl StatsManager {
    fn register(&self, stats_id: &str, connection_id: &str) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        self.entries
            .lock()
            .unwrap()
            .insert(stats_id.to_string(), (connection_id.to_string(), Arc::clone(&flag)));
        flag
    }

    /// 请求取消；返回 false 表示不存在。
    pub fn cancel(&self, stats_id: &str) -> bool {
        self.entries
            .lock()
            .unwrap()
            .get(stats_id)
            .map(|(_, flag)| flag.store(true, Ordering::Relaxed))
            .is_some()
    }

    /// 断开连接时取消该连接的全部统计。
    pub fn cancel_for_connection(&self, connection_id: &str) {
        for (cid, flag) in self.entries.lock().unwrap().values() {
            if cid == connection_id {
                flag.store(true, Ordering::Relaxed);
            }
        }
    }

    fn remove(&self, stats_id: &str) {
        self.entries.lock().unwrap().remove(stats_id);
    }
}

/// walk 任务共享的计数与控制状态。
struct WalkCtx {
    session: SessionHandle,
    sem: Arc<Semaphore>,
    cancelled: Arc<AtomicBool>,
    files: AtomicU64,
    dirs: AtomicU64,
    bytes: AtomicU64,
    last_emit: Mutex<Instant>,
    app: tauri::AppHandle,
    stats_id: String,
}

impl WalkCtx {
    /// 获取并发额度；等待期间响应取消（tokio Semaphore 无 acquire_timeout，轮询实现）。
    async fn acquire(&self) -> Option<OwnedSemaphorePermit> {
        loop {
            if self.cancelled.load(Ordering::Relaxed) {
                return None;
            }
            match self.sem.clone().try_acquire_owned() {
                Ok(permit) => return Some(permit),
                Err(_) => tokio::time::sleep(CANCEL_POLL).await,
            }
        }
    }

    /// 节流推送当前计数（done=false）。
    fn emit_progress(&self, force: bool) {
        let mut last = self.last_emit.lock().unwrap();
        if !force && last.elapsed() < EMIT_INTERVAL {
            return;
        }
        *last = Instant::now();
        let _ = self.app.emit(
            &stats_event(&self.stats_id),
            StatsProgress {
                stats_id: self.stats_id.clone(),
                files: self.files.load(Ordering::Relaxed),
                dirs: self.dirs.load(Ordering::Relaxed),
                bytes: self.bytes.load(Ordering::Relaxed),
                done: false,
            },
        );
    }
}

/// 启动统计任务：对每个根目录并发递归 readdir，累计文件/文件夹数与字节数。
/// 符号链接不跟随（防环，Files BaseProperties 跳过 ReparsePoint 的远端版）；
/// 单目录失败静默跳过（统计尽力而为）。结束后补发 done=true。
pub async fn run_stats(
    app: tauri::AppHandle,
    manager: Arc<StatsManager>,
    session: SessionHandle,
    stats_id: String,
    connection_id: String,
    roots: Vec<String>,
) {
    let cancelled = manager.register(&stats_id, &connection_id);
    let ctx = Arc::new(WalkCtx {
        session,
        sem: Arc::new(Semaphore::new(WALK_CONCURRENCY)),
        cancelled,
        files: AtomicU64::new(0),
        dirs: AtomicU64::new(0),
        bytes: AtomicU64::new(0),
        last_emit: Mutex::new(Instant::now()),
        app: app.clone(),
        stats_id: stats_id.clone(),
    });

    let mut set = JoinSet::new();
    for root in roots {
        set.spawn(walk_dir(Arc::clone(&ctx), root));
    }
    while set.join_next().await.is_some() {}

    manager.remove(&stats_id);
    let _ = app.emit(
        &stats_event(&stats_id),
        StatsProgress {
            stats_id,
            files: ctx.files.load(Ordering::Relaxed),
            dirs: ctx.dirs.load(Ordering::Relaxed),
            bytes: ctx.bytes.load(Ordering::Relaxed),
            done: true,
        },
    );
}

/// 单目录任务：listDir 计数 → 子目录递归（JoinSet 结构化并发）。
/// 递归 future 要装箱才能成为合法的递归 spawn（同 session.rs delete_tree）。
fn walk_dir(ctx: Arc<WalkCtx>, path: String) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> {
    Box::pin(async move {
        let Some(_permit) = ctx.acquire().await else {
            return;
        };
        let entries = {
            let s = ctx.session.session.lock().await;
            match tokio::time::timeout(LIST_TIMEOUT, s.list_dir(&path)).await {
                Ok(Ok(entries)) => entries,
                // 超时/错误：该目录不计入，继续其余分支
                _ => return,
            }
        };
        drop(_permit);

        let mut subdirs = Vec::new();
        for entry in entries {
            if entry.kind == "dir" {
                ctx.dirs.fetch_add(1, Ordering::Relaxed);
                subdirs.push(crate::ssh::join_remote(&path, &entry.name));
            } else {
                // 符号链接按条目自身计入，不跟随目标
                ctx.files.fetch_add(1, Ordering::Relaxed);
                ctx.bytes.fetch_add(entry.size, Ordering::Relaxed);
            }
        }
        ctx.emit_progress(false);

        let mut set = JoinSet::new();
        for sub in subdirs {
            set.spawn(walk_dir(Arc::clone(&ctx), sub));
        }
        while set.join_next().await.is_some() {}
    })
}
