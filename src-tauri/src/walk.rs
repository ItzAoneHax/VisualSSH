//! 通用远端递归枚举（walk）。第二阶段属性统计与第四阶段递归传输共用：
//! 并发 readdir（Semaphore 16）、单目录失败尽力而为、符号链接不跟随。
//! 输出相对 root 的 posix 路径清单；进度以增量回调交调用方累计与节流。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio::task::JoinSet;

use crate::state::SessionHandle;

/// 并发 readdir 上限（与属性统计同款）。
const WALK_CONCURRENCY: usize = 16;
/// 等待并发额度时轮询取消的间隔。
const CANCEL_POLL: Duration = Duration::from_millis(100);
/// 单目录 listDir 预算。
const LIST_TIMEOUT: Duration = Duration::from_secs(30);

/// 清单文件条目（相对 root 的 posix 分隔路径；kind 与 FileEntry 同义）。
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WalkFile {
    pub path: String,
    pub size: u64,
    pub kind: &'static str,
}

/// 枚举结果：root 下的全部子目录与文件（不含 root 本身）。
/// 取消时返回已收集部分（cancelled 标志由调用方读取）。
#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct WalkOutput {
    /// 子目录相对路径（父先于子不保证——并发枚举；建目录请用 mkdir -p 语义）
    pub dirs: Vec<String>,
    pub files: Vec<WalkFile>,
    /// 跳过的符号链接数（不跟随，防环）
    pub skipped_links: u64,
    /// readdir 失败的目录数（计入后继续其余分支）
    pub failed_dirs: u64,
}

/// 一次 readdir 完成后的进度增量（回调方自行累计与节流）。
#[derive(Clone, Copy, Default)]
pub struct WalkDelta {
    /// 刚完成枚举的目录数（恒 1）
    pub dirs: u64,
    /// 新发现的非目录条目数（含符号链接，语义同属性统计的 files）
    pub files: u64,
    /// 新发现条目的字节数
    pub bytes: u64,
    /// 新发现的符号链接数
    pub links: u64,
}

/// 取消标志登记表（属性统计与递归传输的枚举共用；模式同 transfer.rs）。
#[derive(Default)]
pub struct WalkManager {
    entries: Mutex<HashMap<String, (String, Arc<AtomicBool>)>>,
}

impl WalkManager {
    pub(crate) fn register(&self, walk_id: &str, connection_id: &str) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        self.entries
            .lock()
            .unwrap()
            .insert(walk_id.to_string(), (connection_id.to_string(), Arc::clone(&flag)));
        flag
    }

    /// 请求取消；返回 false 表示不存在。
    pub fn cancel(&self, walk_id: &str) -> bool {
        self.entries
            .lock()
            .unwrap()
            .get(walk_id)
            .map(|(_, flag)| flag.store(true, Ordering::Relaxed))
            .is_some()
    }

    /// 断开连接时取消该连接的全部枚举。
    pub fn cancel_for_connection(&self, connection_id: &str) {
        for (cid, flag) in self.entries.lock().unwrap().values() {
            if cid == connection_id {
                flag.store(true, Ordering::Relaxed);
            }
        }
    }

    pub(crate) fn remove(&self, walk_id: &str) {
        self.entries.lock().unwrap().remove(walk_id);
    }
}

struct WalkCtx {
    session: SessionHandle,
    sem: Arc<Semaphore>,
    cancelled: Arc<AtomicBool>,
    on_delta: Box<dyn Fn(WalkDelta) + Send + Sync>,
    output: Mutex<WalkOutput>,
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
}

/// 递归枚举 root 下的全部目录与文件。
/// 符号链接不跟随（计数进 skipped_links，条目仍入 files 供统计方复用）；
/// 单目录失败计入 failed_dirs 继续；取消时返回已收集部分。
pub async fn run_walk(
    session: SessionHandle,
    root: String,
    cancelled: Arc<AtomicBool>,
    on_delta: Box<dyn Fn(WalkDelta) + Send + Sync>,
) -> WalkOutput {
    let ctx = Arc::new(WalkCtx {
        session,
        sem: Arc::new(Semaphore::new(WALK_CONCURRENCY)),
        cancelled,
        on_delta,
        output: Mutex::new(WalkOutput::default()),
    });

    let mut set = JoinSet::new();
    set.spawn(walk_dir(Arc::clone(&ctx), root, String::new()));
    while set.join_next().await.is_some() {}

    let mut guard = ctx.output.lock().unwrap();
    std::mem::take(&mut *guard)
}

/// 单目录任务：listDir → 记录条目 → 子目录递归（JoinSet 结构化并发）。
/// 递归 future 要装箱才能成为合法的递归 spawn（同 stats.rs 原实现）。
fn walk_dir(ctx: Arc<WalkCtx>, abs_path: String, rel: String) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> {
    Box::pin(async move {
        let Some(_permit) = ctx.acquire().await else {
            return;
        };
        let entries = {
            let s = ctx.session.session.lock().await;
            match tokio::time::timeout(LIST_TIMEOUT, s.list_dir(&abs_path)).await {
                Ok(Ok(entries)) => entries,
                // 超时/错误：该目录计入失败，继续其余分支
                _ => {
                    ctx.output.lock().unwrap().failed_dirs += 1;
                    return;
                }
            }
        };
        drop(_permit);

        let mut subdirs = Vec::new();
        let mut files = Vec::new();
        let mut links = 0u64;
        for entry in entries {
            let child_rel = if rel.is_empty() {
                entry.name.clone()
            } else {
                format!("{rel}/{}", entry.name)
            };
            if entry.kind == "dir" {
                subdirs.push((crate::ssh::join_remote(&abs_path, &entry.name), child_rel));
            } else {
                if entry.kind == "symlink" {
                    links += 1;
                }
                files.push(WalkFile {
                    path: child_rel,
                    size: entry.size,
                    kind: entry.kind,
                });
            }
        }

        {
            let mut out = ctx.output.lock().unwrap();
            out.dirs.extend(subdirs.iter().map(|(_, r)| r.clone()));
            out.files.extend(files.iter().cloned());
            out.skipped_links += links;
        }
        (ctx.on_delta)(WalkDelta {
            dirs: 1,
            files: files.len() as u64,
            bytes: files.iter().map(|f| f.size).sum(),
            links,
        });

        let mut set = JoinSet::new();
        for (abs, rel) in subdirs {
            set.spawn(walk_dir(Arc::clone(&ctx), abs, rel));
        }
        while set.join_next().await.is_some() {}
    })
}
