use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::Emitter;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use crate::error::{Error, Result};
use crate::state::SessionHandle;

/// 进度/状态事件通道；负载即 TransferInfo 快照。
pub const EVENT_PROGRESS: &str = "transfer://progress";

/// 事件负载与列表查询共用的传输快照（字段与前端 stores/transfer.ts 对应）。
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TransferInfo {
    pub transfer_id: String,
    /// upload | download
    pub direction: &'static str,
    pub file_name: String,
    pub bytes: u64,
    pub total: u64,
    pub speed_bps: u64,
    /// queued | running | done | failed | cancelled
    pub status: &'static str,
    pub error: Option<String>,
}

/// 一条传输的活状态：进度/速度/取消标志全部原子量，任务与命令线程共享。
pub struct TransferHandle {
    pub transfer_id: String,
    pub connection_id: String,
    pub direction: &'static str,
    pub file_name: String,
    bytes: AtomicU64,
    total: AtomicU64,
    speed_bps: AtomicU64,
    status: Mutex<&'static str>,
    error: Mutex<Option<String>>,
    cancelled: AtomicBool,
}

impl TransferHandle {
    pub fn new(
        transfer_id: String,
        connection_id: String,
        direction: &'static str,
        file_name: String,
        total: u64,
    ) -> Self {
        Self {
            transfer_id,
            connection_id,
            direction,
            file_name,
            bytes: AtomicU64::new(0),
            total: AtomicU64::new(total),
            speed_bps: AtomicU64::new(0),
            status: Mutex::new("queued"),
            error: Mutex::new(None),
            cancelled: AtomicBool::new(false),
        }
    }

    pub fn snapshot(&self) -> TransferInfo {
        TransferInfo {
            transfer_id: self.transfer_id.clone(),
            direction: self.direction,
            file_name: self.file_name.clone(),
            bytes: self.bytes.load(Ordering::Relaxed),
            total: self.total.load(Ordering::Relaxed),
            speed_bps: self.speed_bps.load(Ordering::Relaxed),
            status: *self.status.lock().unwrap(),
            error: self.error.lock().unwrap().clone(),
        }
    }

    pub fn set_total(&self, total: u64) {
        self.total.store(total, Ordering::Relaxed);
    }

    fn set_status(&self, status: &'static str) {
        *self.status.lock().unwrap() = status;
    }

    fn status(&self) -> &'static str {
        *self.status.lock().unwrap()
    }

    pub fn is_terminal(&self) -> bool {
        matches!(self.status(), "done" | "failed" | "cancelled")
    }

    fn add_bytes(&self, n: u64) {
        self.bytes.fetch_add(n, Ordering::Relaxed);
    }

    fn update_speed(&self, window_bytes: u64, elapsed: Duration) {
        let bps = if elapsed.as_secs_f64() > 0.0 {
            (window_bytes as f64 / elapsed.as_secs_f64()) as u64
        } else {
            0
        };
        self.speed_bps.store(bps, Ordering::Relaxed);
    }

    fn reset_speed(&self) {
        self.speed_bps.store(0, Ordering::Relaxed);
    }

    /// 请求取消；已结束的传输返回 false（由管理器转成 bool 给前端）。
    fn request_cancel(&self) -> bool {
        if self.is_terminal() {
            return false;
        }
        self.cancelled.store(true, Ordering::Relaxed);
        true
    }

    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Relaxed)
    }
}

/// 单连接并发上限，超出排队。
const PER_CONNECTION_LIMIT: usize = 3;
/// 读写分块大小。
const CHUNK_SIZE: usize = 64 * 1024;
/// 进度事件节流间隔。
const EMIT_INTERVAL: Duration = Duration::from_millis(200);
/// 排队期间轮询取消请求的间隔。
const CANCEL_POLL: Duration = Duration::from_millis(150);

/// 全局传输管理器。外层 Mutex 只做短暂的 HashMap 存取，锁内不含 await。
#[derive(Default)]
pub struct TransferManager {
    transfers: Mutex<HashMap<String, Arc<TransferHandle>>>,
    semaphores: Mutex<HashMap<String, Arc<Semaphore>>>,
}

impl TransferManager {
    pub fn semaphore(&self, connection_id: &str) -> Arc<Semaphore> {
        self.semaphores
            .lock()
            .unwrap()
            .entry(connection_id.to_string())
            .or_insert_with(|| Arc::new(Semaphore::new(PER_CONNECTION_LIMIT)))
            .clone()
    }

    pub fn register(&self, handle: Arc<TransferHandle>) {
        self.transfers
            .lock()
            .unwrap()
            .insert(handle.transfer_id.clone(), handle);
    }

    pub fn list(&self) -> Vec<TransferInfo> {
        self.transfers
            .lock()
            .unwrap()
            .values()
            .map(|h| h.snapshot())
            .collect()
    }

    /// 请求取消；返回 false 表示不存在或已结束。
    pub fn cancel(&self, transfer_id: &str) -> bool {
        self.transfers
            .lock()
            .unwrap()
            .get(transfer_id)
            .map(|h| h.request_cancel())
            .unwrap_or(false)
    }

    /// 断开连接时批量取消该连接的全部传输。
    pub fn cancel_for_connection(&self, connection_id: &str) {
        for handle in self
            .transfers
            .lock()
            .unwrap()
            .values()
            .filter(|h| h.connection_id == connection_id)
        {
            handle.request_cancel();
        }
    }

    /// 清除已结束的记录；仍在进行的返回 Err 由前端提示。
    pub fn remove(&self, transfer_id: &str) -> Result<bool> {
        let handle = self.transfers.lock().unwrap().get(transfer_id).cloned();
        match handle {
            None => Ok(false),
            Some(h) if !h.is_terminal() => Err(Error::Transfer(format!(
                "「{}」仍在进行中，无法清除",
                h.file_name
            ))),
            Some(_) => {
                self.transfers.lock().unwrap().remove(transfer_id);
                Ok(true)
            }
        }
    }
}

pub(crate) async fn emit_state(app: &tauri::AppHandle, handle: &TransferHandle) {
    let _ = app.emit(EVENT_PROGRESS, handle.snapshot());
}

/// 任务内失败的统一收尾：置错误、清速度、推终态事件。
pub(crate) async fn finish_failed(
    app: &tauri::AppHandle,
    handle: &TransferHandle,
    message: String,
) {
    *handle.error.lock().unwrap() = Some(message);
    handle.reset_speed();
    handle.set_status("failed");
    emit_state(app, handle).await;
}

async fn finish_cancelled(app: &tauri::AppHandle, handle: &TransferHandle) {
    handle.reset_speed();
    handle.set_status("cancelled");
    emit_state(app, handle).await;
}

/// 排队获取并发额度；等待期间每 150ms 检查一次取消请求。
/// （tokio 的 Semaphore 没有 acquire_timeout，用 try_acquire_owned + 轮询实现。）
async fn acquire_permit(
    sem: &Arc<Semaphore>,
    handle: &TransferHandle,
) -> Option<OwnedSemaphorePermit> {
    loop {
        if handle.is_cancelled() {
            return None;
        }
        match sem.clone().try_acquire_owned() {
            Ok(permit) => return Some(permit),
            Err(_) => tokio::time::sleep(CANCEL_POLL).await,
        }
    }
}

/// 进度节流：到达间隔就更新速度并推事件。
struct EmitThrottle {
    last: Instant,
    window_bytes: u64,
}

impl EmitThrottle {
    fn new() -> Self {
        Self {
            last: Instant::now(),
            window_bytes: 0,
        }
    }

    async fn on_chunk(&mut self, handle: &TransferHandle, app: &tauri::AppHandle, n: u64) {
        handle.add_bytes(n);
        self.window_bytes += n;
        let elapsed = self.last.elapsed();
        if elapsed >= EMIT_INTERVAL {
            handle.update_speed(self.window_bytes, elapsed);
            emit_state(app, handle).await;
            self.last = Instant::now();
            self.window_bytes = 0;
        }
    }
}

/// 上传任务：本地读 → 远端写。会话锁只在打开远端句柄的一瞬持有，
/// 之后流式读写不占锁，浏览等其他 SFTP 操作照常进行。
pub async fn run_upload(
    app: tauri::AppHandle,
    handle: Arc<TransferHandle>,
    session: SessionHandle,
    sem: Arc<Semaphore>,
    local_path: String,
    remote_path: String,
) {
    let Some(_permit) = acquire_permit(&sem, &handle).await else {
        finish_cancelled(&app, &handle).await;
        return;
    };
    handle.set_status("running");
    emit_state(&app, &handle).await;

    let mut local = match tokio::fs::File::open(&local_path).await {
        Ok(f) => f,
        Err(e) => {
            finish_failed(&app, &handle, format!("打开本地文件失败: {e}")).await;
            return;
        }
    };
    let mut remote = {
        let s = session.session.lock().await;
        match s.open_write(&remote_path).await {
            Ok(f) => f,
            Err(e) => {
                finish_failed(&app, &handle, e.to_string()).await;
                return;
            }
        }
    };

    let mut buf = vec![0u8; CHUNK_SIZE];
    let mut throttle = EmitThrottle::new();
    loop {
        if handle.is_cancelled() {
            // 上传无临时文件语义：远端保留已写入部分
            finish_cancelled(&app, &handle).await;
            return;
        }
        match local.read(&mut buf).await {
            Ok(0) => break,
            Ok(n) => {
                if let Err(e) = remote.write_all(&buf[..n]).await {
                    finish_failed(&app, &handle, format!("写入远端失败: {e}")).await;
                    return;
                }
                throttle.on_chunk(&handle, &app, n as u64).await;
            }
            Err(e) => {
                finish_failed(&app, &handle, format!("读取本地文件失败: {e}")).await;
                return;
            }
        }
    }
    // close 等待远端确认全部写入落盘
    if let Err(e) = remote.close().await {
        finish_failed(&app, &handle, format!("远端落盘确认失败: {e}")).await;
        return;
    }
    handle.reset_speed();
    handle.set_status("done");
    emit_state(&app, &handle).await;
}

/// 下载任务：远端读 → 本地写。先写 <目标>.vsshpart，成功后原子改名；
/// 取消/失败时清理临时文件。
pub async fn run_download(
    app: tauri::AppHandle,
    handle: Arc<TransferHandle>,
    session: SessionHandle,
    sem: Arc<Semaphore>,
    remote_path: String,
    local_path: String,
) {
    let Some(_permit) = acquire_permit(&sem, &handle).await else {
        finish_cancelled(&app, &handle).await;
        return;
    };
    handle.set_status("running");
    emit_state(&app, &handle).await;

    // 锁内瞬间完成：取大小 + 打开远端只读句柄
    let opened = {
        let s = session.session.lock().await;
        match s.file_size(&remote_path).await {
            Ok(size) => match s.open_read(&remote_path).await {
                Ok(file) => Ok((size, file)),
                Err(e) => Err(e),
            },
            Err(e) => Err(e),
        }
    };
    let (size, mut remote) = match opened {
        Ok(v) => v,
        Err(e) => {
            finish_failed(&app, &handle, e.to_string()).await;
            return;
        }
    };
    handle.set_total(size);
    emit_state(&app, &handle).await;

    let part_path = format!("{local_path}.vsshpart");
    let mut out = match tokio::fs::File::create(&part_path).await {
        Ok(f) => f,
        Err(e) => {
            finish_failed(&app, &handle, format!("创建本地临时文件失败: {e}")).await;
            return;
        }
    };

    let cleanup_part = || {
        let path = part_path.clone();
        async move {
            let _ = tokio::fs::remove_file(&path).await;
        }
    };

    let mut buf = vec![0u8; CHUNK_SIZE];
    let mut throttle = EmitThrottle::new();
    loop {
        if handle.is_cancelled() {
            drop(out);
            cleanup_part().await;
            finish_cancelled(&app, &handle).await;
            return;
        }
        match remote.read(&mut buf).await {
            Ok(0) => break,
            Ok(n) => {
                if let Err(e) = out.write_all(&buf[..n]).await {
                    cleanup_part().await;
                    finish_failed(&app, &handle, format!("写入本地文件失败: {e}")).await;
                    return;
                }
                throttle.on_chunk(&handle, &app, n as u64).await;
            }
            Err(e) => {
                cleanup_part().await;
                finish_failed(&app, &handle, format!("读取远端失败: {e}")).await;
                return;
            }
        }
    }
    if let Err(e) = out.flush().await {
        cleanup_part().await;
        finish_failed(&app, &handle, format!("写入本地文件失败: {e}")).await;
        return;
    }
    drop(out);
    // 目标已存在时 Windows 的 rename 不覆盖 → 先删（保存对话框已确认覆盖意图）
    let _ = tokio::fs::remove_file(&local_path).await;
    if let Err(e) = tokio::fs::rename(&part_path, &local_path).await {
        cleanup_part().await;
        finish_failed(&app, &handle, format!("保存本地文件失败: {e}")).await;
        return;
    }
    handle.reset_speed();
    handle.set_status("done");
    emit_state(&app, &handle).await;
}
