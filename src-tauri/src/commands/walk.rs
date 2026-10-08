use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::error::{Error, Result};
use crate::state::AppState;
use crate::walk::{run_walk, WalkManager, WalkOutput};

/// 枚举进度事件节流间隔。
const EMIT_INTERVAL: Duration = Duration::from_millis(200);

/// 远端枚举结果：cancelled=true 时 output 为已收集部分。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WalkResult {
    pub cancelled: bool,
    pub output: WalkOutput,
}

/// 枚举进度事件负载（walk://progress:{walk_id}）。
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WalkProgress {
    pub walk_id: String,
    pub dirs: u64,
    pub files: u64,
    pub bytes: u64,
    pub skipped_links: u64,
}

fn walk_event(walk_id: &str) -> String {
    format!("walk://progress:{walk_id}")
}

/// 递归枚举远端目录并 await 清单（递归传输编排入口；属性统计走 spawn 版 stats）。
/// 进度经 walk://progress:{walk_id} 事件推送；取消走 ssh_walk_cancel（返回已收集部分）。
#[tauri::command]
pub async fn ssh_walk_remote(
    walk_id: String,
    connection_id: String,
    root: String,
    app: AppHandle,
    state: State<'_, AppState>,
    walks: State<'_, Arc<WalkManager>>,
) -> Result<WalkResult> {
    let session = state
        .get(&connection_id)
        .ok_or_else(|| Error::NoSession(connection_id.clone()))?;
    let cancelled = walks.register(&walk_id, &connection_id);

    let dirs = AtomicU64::new(0);
    let files = AtomicU64::new(0);
    let bytes = AtomicU64::new(0);
    let links = AtomicU64::new(0);
    let last_emit = Mutex::new(Instant::now());
    let on_delta = {
        let app = app.clone();
        let walk_id = walk_id.clone();
        move |d: crate::walk::WalkDelta| {
            dirs.fetch_add(d.dirs, Ordering::Relaxed);
            files.fetch_add(d.files, Ordering::Relaxed);
            bytes.fetch_add(d.bytes, Ordering::Relaxed);
            links.fetch_add(d.links, Ordering::Relaxed);
            let mut last = last_emit.lock().unwrap();
            if last.elapsed() < EMIT_INTERVAL {
                return;
            }
            *last = Instant::now();
            let _ = app.emit(
                &walk_event(&walk_id),
                WalkProgress {
                    walk_id: walk_id.clone(),
                    dirs: dirs.load(Ordering::Relaxed),
                    files: files.load(Ordering::Relaxed),
                    bytes: bytes.load(Ordering::Relaxed),
                    skipped_links: links.load(Ordering::Relaxed),
                },
            );
        }
    };

    let output = run_walk(
        session,
        root,
        Arc::clone(&cancelled),
        Box::new(on_delta),
    )
    .await;
    let was_cancelled = cancelled.load(std::sync::atomic::Ordering::Relaxed);
    walks.remove(&walk_id);
    Ok(WalkResult {
        cancelled: was_cancelled,
        output,
    })
}

/// 请求取消远端枚举；false = 不存在或已结束。
#[tauri::command]
pub async fn ssh_walk_cancel(walk_id: String, walks: State<'_, Arc<WalkManager>>) -> Result<bool> {
    Ok(walks.cancel(&walk_id))
}

/// 本地目录枚举清单（上传文件夹编排）。不跟随符号链接（防环防越界）；
/// path 为绝对路径（Windows 原生分隔，root 已含前缀，前端自行截取相对部分）。
#[tauri::command]
pub async fn walk_local(root: String) -> Result<WalkOutput> {
    let meta = tokio::fs::metadata(&root).await;
    match meta {
        Ok(m) if m.is_dir() => {}
        Ok(_) => return Err(Error::Transfer("本地路径不是文件夹".into())),
        Err(e) => return Err(Error::Transfer(format!("读取本地文件夹失败: {e}"))),
    }

    let mut out = WalkOutput::default();
    // 迭代式栈遍历（目录深度不可控，避免递归栈溢出）
    let mut stack = vec![root.clone()];
    while let Some(dir) = stack.pop() {
        let mut rd = match tokio::fs::read_dir(&dir).await {
            Ok(rd) => rd,
            Err(_) => {
                out.failed_dirs += 1;
                continue;
            }
        };
        while let Ok(Some(entry)) = rd.next_entry().await {
            let Ok(ft) = entry.file_type().await else { continue };
            let path = entry.path().to_string_lossy().to_string();
            if ft.is_symlink() {
                out.skipped_links += 1;
                let size = entry.metadata().await.map(|m| m.len()).unwrap_or(0);
                out.files.push(crate::walk::WalkFile {
                    path,
                    size,
                    kind: "symlink",
                });
            } else if ft.is_dir() {
                out.dirs.push(path.clone());
                stack.push(path);
            } else if ft.is_file() {
                let size = entry.metadata().await.map(|m| m.len()).unwrap_or(0);
                out.files.push(crate::walk::WalkFile {
                    path,
                    size,
                    kind: "file",
                });
            }
        }
    }
    Ok(out)
}

/// 本地逐级建目录（下载文件夹的本地侧；幂等）。
#[tauri::command]
pub async fn local_mkdir_p(path: String) -> Result<()> {
    tokio::fs::create_dir_all(&path)
        .await
        .map_err(|e| Error::Transfer(format!("创建本地目录失败: {e}")))
}
