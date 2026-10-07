use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use russh::ChannelMsg;
use serde::Serialize;
use tauri::Emitter;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio::task::JoinSet;

use crate::ssh::fs::{kind_from_mode, mode_string, FileEntry};
use crate::ssh::shell_quote;
use crate::ssh::join_remote;
use crate::state::SessionHandle;

/// 搜索进度事件名（含 searchId，前端按 id 订阅）。
pub fn search_event(search_id: &str) -> String {
    format!("search://result:{search_id}")
}

/// 取消标志登记表（与 stats.rs 同款：注册表 + 原子标志）。
#[derive(Default)]
pub struct SearchManager {
    entries: Mutex<HashMap<String, (String, Arc<AtomicBool>)>>,
}

impl SearchManager {
    fn register(&self, search_id: &str, connection_id: &str) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        self.entries
            .lock()
            .unwrap()
            .insert(search_id.to_string(), (connection_id.to_string(), Arc::clone(&flag)));
        flag
    }

    /// 请求取消；返回 false 表示不存在。
    pub fn cancel(&self, search_id: &str) -> bool {
        self.entries
            .lock()
            .unwrap()
            .get(search_id)
            .map(|(_, flag)| flag.store(true, Ordering::Relaxed))
            .is_some()
    }

    /// 断开连接时取消该连接的全部搜索。
    pub fn cancel_for_connection(&self, connection_id: &str) {
        for (cid, flag) in self.entries.lock().unwrap().values() {
            if cid == connection_id {
                flag.store(true, Ordering::Relaxed);
            }
        }
    }

    fn remove(&self, search_id: &str) {
        self.entries.lock().unwrap().remove(search_id);
    }
}

/// 单条命中：条目元数据 + 相对搜索目录的路径（前端「位置」列显示）。
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    #[serde(flatten)]
    pub entry: FileEntry,
    pub rel_path: String,
}

/// 搜索事件负载：批量追加；done=true 为终态（cancelled 标记用户停止）。
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SearchProgress {
    pub search_id: String,
    pub hits: Vec<SearchHit>,
    pub done: bool,
    pub cancelled: bool,
    pub capped: bool,
}

/// 结果封顶数。
const MAX_RESULTS: u64 = 2000;
/// 结果批次节流（FolderSearch.cs:45-47 IntervalSampler 范式）。
const FLUSH_INTERVAL: Duration = Duration::from_millis(500);
/// find 深度上限。
const FIND_MAXDEPTH: u32 = 6;
/// exec 流读保护上限（用户可随时停止，此处只防服务器无响应挂死任务）。
const EXEC_READ_TIMEOUT: Duration = Duration::from_secs(120);
/// walk 回退单目录 readdir 预算。
const LIST_TIMEOUT: Duration = Duration::from_secs(30);
/// walk 回退总超时（FolderSearch.cs:650-667 网络位置超时保护的远端版）。
const WALK_TOTAL_TIMEOUT: Duration = Duration::from_secs(30);
/// walk 并发 readdir 上限。
const WALK_CONCURRENCY: usize = 16;
/// 等待并发额度时轮询取消的间隔。
const CANCEL_POLL: Duration = Duration::from_millis(100);

/// 搜索任务共享状态：两个执行层共用累积器与事件推送。
struct SearchCtx {
    session: SessionHandle,
    app: tauri::AppHandle,
    search_id: String,
    dir: String,
    query_lower: String,
    /// find 的 -iname 模式（启动时由原始 query 生成）
    find_glob: String,
    cancelled: Arc<AtomicBool>,
    total: AtomicU64,
    capped: AtomicBool,
    /// exec find 阶段待补元数据的路径批次
    pending_paths: Mutex<Vec<String>>,
    /// walk 阶段自带元数据的命中批次
    pending_hits: Mutex<Vec<SearchHit>>,
    last_emit: Mutex<Instant>,
}

impl SearchCtx {
    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Relaxed)
    }

    fn reached_cap(&self) -> bool {
        self.total.load(Ordering::Relaxed) >= MAX_RESULTS
    }

    /// rel 路径 = 去掉搜索根前缀。
    fn rel_path(&self, path: &str) -> String {
        let stripped = path.strip_prefix(&self.dir).unwrap_or(path);
        stripped.trim_start_matches('/').to_string()
    }

    fn push_hit(&self, entry: FileEntry, path: &str) -> bool {
        if self.reached_cap() {
            self.capped.store(true, Ordering::Relaxed);
            return false;
        }
        self.total.fetch_add(1, Ordering::Relaxed);
        self.pending_hits.lock().unwrap().push(SearchHit {
            entry,
            rel_path: self.rel_path(path),
        });
        true
    }

    /// 推送 pending_hits 批次（force=true 收尾推送）。
    fn emit_hits(&self, force: bool) {
        let mut last = self.last_emit.lock().unwrap();
        if !force && last.elapsed() < FLUSH_INTERVAL {
            return;
        }
        *last = Instant::now();
        let hits: Vec<SearchHit> = self.pending_hits.lock().unwrap().drain(..).collect();
        if hits.is_empty() && !force {
            return;
        }
        drop(last);
        let _ = self.app.emit(
            &search_event(&self.search_id),
            SearchProgress {
                search_id: self.search_id.clone(),
                hits,
                done: false,
                cancelled: false,
                capped: self.capped.load(Ordering::Relaxed),
            },
        );
    }

    /// exec find 批次：把 pending_paths 逐条 stat 补元数据，转成 hits 后走统一推送。
    /// 一次 flush 持一次会话锁（批次内串行 stat，与 stats.rs 的锁粒度一致）。
    async fn flush_paths(&self, force: bool) {
        if !force && self.last_emit.lock().unwrap().elapsed() < FLUSH_INTERVAL {
            return;
        }
        let paths: Vec<String> = {
            let mut p = self.pending_paths.lock().unwrap();
            if p.is_empty() && !force {
                return;
            }
            std::mem::take(&mut *p)
        };
        let s = self.session.session.lock().await;
        for path in paths {
            let name = path.rsplit('/').next().unwrap_or(&path).to_string();
            let entry = match s.stat(&path).await {
                Ok(meta) => {
                    let kind = kind_from_mode(meta.permissions);
                    FileEntry {
                        name,
                        kind,
                        size: meta.size.unwrap_or(0),
                        permissions: mode_string(meta.permissions, kind),
                        mtime: meta.mtime.map(|t| t as i64),
                        owner: meta.user.clone().or_else(|| meta.uid.map(|u| u.to_string())),
                        group: meta.group.clone().or_else(|| meta.gid.map(|g| g.to_string())),
                        atime: meta.atime.map(|t| t as i64),
                    }
                }
                // 条目在搜索窗口期被删/不可读：占位行保住路径信息
                Err(_) => FileEntry {
                    name,
                    kind: "other",
                    size: 0,
                    permissions: "?".to_string(),
                    mtime: None,
                    owner: None,
                    group: None,
                    atime: None,
                },
            };
            if !self.push_hit(entry, &path) {
                break;
            }
        }
        drop(s);
        self.emit_hits(force);
    }

    /// 记录一条 find 命中路径；返回 false 表示已达封顶。
    fn push_path(&self, path: &str) -> bool {
        if self.reached_cap() {
            self.capped.store(true, Ordering::Relaxed);
            return false;
        }
        self.pending_paths.lock().unwrap().push(path.to_string());
        true
    }
}

/// find 的 -iname 模式（FolderSearch.cs:64-67）：
/// 含点按扩展名匹配（".docx" → "*.docx*"）；否则 *q*；find glob 元字符反斜杠转义。
fn find_pattern(query: &str) -> String {
    let escaped = query
        .replace('[', r"\[")
        .replace(']', r"\]")
        .replace('*', r"\*")
        .replace('?', r"\?");
    if escaped.contains('.') {
        match escaped.split_once('.') {
            Some((lead, ext)) => format!("{lead}*.{ext}*"),
            None => format!("*{escaped}*"),
        }
    } else {
        format!("*{escaped}*")
    }
}

/// 执行层①：exec find 流式读取（-print0 NUL 分隔防文件名含换行）。
/// 返回 false = exec 不可用（通道打开/执行失败），调用方回退 walk。
async fn exec_find(ctx: &Arc<SearchCtx>) -> bool {
    let command = format!(
        "find {} -maxdepth {FIND_MAXDEPTH} -iname {} -print0",
        shell_quote(&ctx.dir),
        shell_quote(&ctx.find_glob),
    );
    // 打开通道并启动 exec；通道所有权随即移出，会话锁只在打开期间持有
    let mut channel = {
        let s = ctx.session.session.lock().await;
        match s.open_session_channel().await {
            Ok(ch) => ch,
            Err(_) => return false,
        }
    };
    if channel.exec(true, command.into_bytes()).await.is_err() {
        let _ = channel.close().await;
        return false;
    }

    let mut buf: Vec<u8> = Vec::new();
    let mut stop = false;
    let read = tokio::time::timeout(EXEC_READ_TIMEOUT, async {
        while let Some(msg) = channel.wait().await {
            if ctx.is_cancelled() {
                break;
            }
            match msg {
                ChannelMsg::Data { data } => {
                    buf.extend_from_slice(&data);
                    while let Some(pos) = buf.iter().position(|&b| b == 0) {
                        let path = String::from_utf8_lossy(&buf[..pos]).into_owned();
                        buf.drain(..=pos);
                        if path.is_empty() {
                            continue;
                        }
                        if !ctx.push_path(&path) {
                            stop = true;
                            return;
                        }
                    }
                    ctx.flush_paths(false).await;
                }
                ChannelMsg::Eof | ChannelMsg::Close => break,
                _ => {}
            }
        }
    })
    .await;
    if read.is_err() || ctx.is_cancelled() || stop {
        let _ = channel.close().await;
    }
    true
}

/// 执行层②：SFTP 并发 readdir walk，名称 contains 匹配（exec 不可用时的回退）。
async fn walk_search(ctx: &Arc<SearchCtx>) {
    let started = Instant::now();
    let sem = Arc::new(Semaphore::new(WALK_CONCURRENCY));
    let mut set = JoinSet::new();
    set.spawn(walk_dir(Arc::clone(ctx), Arc::clone(&sem), ctx.dir.clone()));
    while set.join_next().await.is_some() {
        if ctx.is_cancelled()
            || ctx.reached_cap()
            || started.elapsed() > WALK_TOTAL_TIMEOUT
        {
            set.abort_all();
            // 等一拍让 abort 的任务退出，避免它们在 ctx 释放后仍推送
            while set.join_next().await.is_some() {}
            break;
        }
    }
}

/// 单目录任务：listDir → 名称匹配 → 子目录递归（JoinSet 结构化并发，递归装箱同 delete_tree）。
fn walk_dir(
    ctx: Arc<SearchCtx>,
    sem: Arc<Semaphore>,
    path: String,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> {
    Box::pin(async move {
        let Some(_permit) = acquire(ctx.as_ref(), &sem).await else {
            return;
        };
        let entries = {
            let s = ctx.session.session.lock().await;
            match tokio::time::timeout(LIST_TIMEOUT, s.list_dir(&path)).await {
                Ok(Ok(entries)) => entries,
                _ => return,
            }
        };
        drop(_permit);

        let mut subdirs = Vec::new();
        for entry in entries {
            let is_dir = entry.kind == "dir";
            let name = entry.name.clone();
            if name.to_lowercase().contains(&ctx.query_lower)
                && !ctx.push_hit(entry, &path)
            {
                return;
            }
            if is_dir {
                subdirs.push(join_remote(&path, &name));
            }
        }
        ctx.emit_hits(false);

        let mut set = JoinSet::new();
        for sub in subdirs {
            set.spawn(walk_dir(
                Arc::clone(&ctx),
                Arc::clone(&sem),
                sub,
            ));
        }
        while set.join_next().await.is_some() {}
    })
}

/// 获取并发额度；等待期间响应取消（tokio Semaphore 无 acquire_timeout，轮询实现）。
async fn acquire(ctx: &SearchCtx, sem: &Arc<Semaphore>) -> Option<OwnedSemaphorePermit> {
    loop {
        if ctx.is_cancelled() {
            return None;
        }
        match sem.clone().try_acquire_owned() {
            Ok(permit) => return Some(permit),
            Err(_) => tokio::time::sleep(CANCEL_POLL).await,
        }
    }
}

/// 启动递归搜索：exec find 优先，通道不可用回退 SFTP walk；结束补发 done 事件。
pub async fn run_search(
    app: tauri::AppHandle,
    manager: Arc<SearchManager>,
    session: SessionHandle,
    search_id: String,
    connection_id: String,
    dir: String,
    query: String,
) {
    let cancelled_flag = manager.register(&search_id, &connection_id);
    let ctx = Arc::new(SearchCtx {
        session,
        app,
        search_id: search_id.clone(),
        dir,
        query_lower: query.to_lowercase(),
        find_glob: find_pattern(&query),
        cancelled: cancelled_flag,
        total: AtomicU64::new(0),
        capped: AtomicBool::new(false),
        pending_paths: Mutex::new(Vec::new()),
        pending_hits: Mutex::new(Vec::new()),
        last_emit: Mutex::new(Instant::now()),
    });

    let exec_ok = exec_find(&ctx).await;
    if exec_ok {
        ctx.flush_paths(true).await;
    } else {
        walk_search(&ctx).await;
    }

    let cancelled = ctx.is_cancelled();
    ctx.emit_hits(true);
    manager.remove(&search_id);
    let _ = ctx.app.emit(
        &search_event(&search_id),
        SearchProgress {
            search_id,
            hits: Vec::new(),
            done: true,
            cancelled,
            capped: ctx.capped.load(Ordering::Relaxed),
        },
    );
}
