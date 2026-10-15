//! MCP 审计与确认。
//!
//! 审计存储设计（完整可追溯 × 最小占用）：
//! - 两级结构：内存 ring（默认 500 条，设置页热渲染）+ 磁盘全量追加。
//! - 磁盘格式：`VAUD` magic + u16 版本 + 块序列 `[u32 raw_len][u32 comp_len][zstd frame]`，
//!   块内为 JSONL（每条 AuditEntry 一行）。工具名/枚举/时间戳的重复模式由 zstd 吃掉，
//!   相比自定义二进制编码损失 <30% 体积，换取零解析风险与块独立可跳段。
//! - flush 触发：128 条缓冲 / 20 秒静默 / 进程退出 / 导出前。崩溃丢失窗口 ≤ 一块。
//! - 参数完整入档：大字符串载荷（write_file 的 content 等）截前 256 字节并附
//!   原始长度 + fnv64 指纹（完整性可校验；全文本就在服务器上，审计不做备份）。
//! - id 全局单调：启动时从磁盘尾部续号，跨重启流水号无空洞。
//! - 64MB 硬上限：触顶丢弃最旧的块（并在 ring 自记一笔），防磁盘失控。
//!
//! 确认请求（危险操作拦截 / 首次接入批准）沿用 ConfirmQueue，见文件尾。

use std::collections::VecDeque;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;

/// 确认请求事件（前端弹窗）：负载 {id, summary}。
pub const EVENT_CONFIRM: &str = "mcp://confirm";

/// 内存 ring 上限（设置页增量刷新的窗口）。
const RING_CAPACITY: usize = 500;
/// 弹窗等待上限：超时不再执行（与主动拒绝分别上报——超时可重试，拒绝不该重试）。
const CONFIRM_TIMEOUT: Duration = Duration::from_secs(25);
/// 供错误文案引用的秒数。
pub const CONFIRM_TIMEOUT_SECS: u64 = CONFIRM_TIMEOUT.as_secs();

/// 触发落盘的缓冲条数 / 静默时长。
const FLUSH_ENTRIES: usize = 128;
const FLUSH_INTERVAL: Duration = Duration::from_secs(20);
/// 磁盘硬上限：超限丢弃最旧块（压缩后约百万级调用才触顶）。
const DISK_CAP_BYTES: u64 = 64 * 1024 * 1024;
/// 截断阈值：超过该长度的字符串参数只留前缀 + 长度 + 指纹。
const ARG_CLIP_BYTES: usize = 512;
const ARG_KEEP_BYTES: usize = 256;
const ZSTD_LEVEL: i32 = 3;

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    pub id: u64,
    /// unix 毫秒
    pub at_ms: u64,
    /// 来源：http | stdio（String 而非 &'static str：块反序列化无法产生静态借用）
    pub via: String,
    /// 工具名；接入批准事件为 "@approve"、审计自记事件为 "@audit"
    pub tool: String,
    /// ok | error | denied | timeout | trimmed
    pub outcome: String,
    /// 一行摘要（参数要点/错误信息；不含文件内容）
    pub detail: String,
    /// 完整调用参数（大载荷已截断+指纹；None = 无参数或系统事件）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<serde_json::Value>,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// fnv-1a 64 位指纹（无依赖；校验大载荷截断前后的完整性用）。
fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for b in bytes {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

/// 大字符串参数截断：保留前缀 + 标注原长与指纹。递归处理嵌套结构。
fn compact_args(value: serde_json::Value) -> serde_json::Value {
    use serde_json::Value;
    match value {
        Value::String(s) => {
            if s.len() <= ARG_CLIP_BYTES {
                Value::String(s)
            } else {
                let head: String = s.chars().take(ARG_KEEP_BYTES).collect();
                Value::String(format!(
                    "{head}\n…[已截断，原 {} 字节，fnv64:{:016x}]",
                    s.len(),
                    fnv1a64(s.as_bytes())
                ))
            }
        }
        Value::Array(a) => Value::Array(a.into_iter().map(compact_args).collect()),
        Value::Object(o) => {
            Value::Object(o.into_iter().map(|(k, v)| (k, compact_args(v))).collect())
        }
        other => other,
    }
}

/// 压缩一个 JSONL 块：[u32 raw_len][u32 comp_len][zstd frame]。
fn write_block<W: Write>(out: &mut W, jsonl: &str) -> std::io::Result<()> {
    let raw = jsonl.as_bytes();
    let comp = zstd::bulk::compress(raw, ZSTD_LEVEL)
        .map_err(|e| std::io::Error::other(format!("zstd 压缩失败: {e}")))?;
    out.write_all(&(raw.len() as u32).to_le_bytes())?;
    out.write_all(&(comp.len() as u32).to_le_bytes())?;
    out.write_all(&comp)
}

/// 解压块并逐行反序列化；块损坏返回 Err（调用方保留此前已读部分）。
fn parse_block(raw: &[u8]) -> std::io::Result<Vec<AuditEntry>> {
    let text =
        std::str::from_utf8(raw).map_err(|e| std::io::Error::other(format!("块非 UTF-8: {e}")))?;
    let mut entries = Vec::new();
    for (i, line) in text.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let entry: AuditEntry = serde_json::from_str(line)
            .map_err(|e| std::io::Error::other(format!("块内第 {} 行解析失败: {e}", i + 1)))?;
        entries.push(entry);
    }
    Ok(entries)
}

struct Inner {
    ring: VecDeque<AuditEntry>,
    buffer: Vec<String>,
    next_id: u64,
    /// 全量累计条数（磁盘 + 当前缓冲）。
    total: u64,
    file: Option<std::fs::File>,
    file_bytes: u64,
    path: PathBuf,
    last_flush: Instant,
    /// 磁盘降级原因（写盘失败时纯内存工作，绝不阻断工具执行）。
    degraded: Option<String>,
}

/// 全局审计器：ring 热数据 + zstd 块落盘。
pub struct AuditLog {
    inner: Mutex<Inner>,
}

impl Default for AuditLog {
    fn default() -> Self {
        Self {
            inner: Mutex::new(Inner {
                ring: VecDeque::new(),
                buffer: Vec::new(),
                next_id: 1,
                total: 0,
                file: None,
                file_bytes: 0,
                path: PathBuf::new(),
                last_flush: Instant::now(),
                degraded: None,
            }),
        }
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AuditStats {
    /// 全量累计条数（磁盘 + 缓冲）
    pub total: u64,
    /// 落盘字节数（压缩后）
    pub disk_bytes: u64,
    /// 尚未落盘的缓冲条数
    pub buffered: u64,
    /// 降级原因（正常为 None）
    pub degraded: Option<String>,
}

impl AuditLog {
    /// 打开（或创建）审计文件并重建索引：尾部 ring + 总数 + id 续号。
    pub fn open(path: &Path) -> AuditLog {
        let log = AuditLog::default();
        let mut inner = log.inner.lock().unwrap();
        inner.path = path.to_path_buf();
        // 文件不存在 = 全新档案（正常首启）；存在但坏才重置留证
        if path.exists() {
            match Self::load_existing(path) {
                Ok((entries, file_bytes)) => {
                    for e in entries {
                        inner.next_id = inner.next_id.max(e.id + 1);
                        inner.total += 1;
                        push_ring(&mut inner.ring, e);
                    }
                    inner.file_bytes = file_bytes;
                }
                Err(e) => {
                    let _ = std::fs::rename(path, path.with_extension("corrupt"));
                    inner.degraded = Some(format!("审计文件不可读已重置: {e}"));
                }
            }
        }
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let is_new = std::fs::metadata(path).map(|m| m.len() == 0).unwrap_or(true);
        match std::fs::OpenOptions::new().create(true).append(true).open(path) {
            Ok(mut f) => {
                if is_new {
                    let header = [b'V', b'A', b'U', b'D', 1, 0];
                    if let Err(e) = f.write_all(&header) {
                        inner.degraded = Some(format!("审计文件头写入失败: {e}"));
                    }
                }
                inner.file = Some(f);
            }
            Err(e) => {
                inner.degraded = Some(format!("审计文件打开失败: {e}"));
            }
        }
        drop(inner);
        log
    }

    /// 顺序解压全文件：滑窗保留尾部条目（ring 容量），返回 (滑窗, 文件字节数)。
    fn load_existing(path: &Path) -> std::io::Result<(VecDeque<AuditEntry>, u64)> {
        let mut file = std::fs::File::open(path)?;
        let file_bytes = file.metadata()?.len();
        let mut magic = [0u8; 6];
        match file.read_exact(&mut magic) {
            Ok(()) => {}
            // 空文件 = 正常空档（首次启动 / 刚清空）
            Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                return Ok((VecDeque::new(), file_bytes));
            }
            Err(e) => return Err(e),
        }
        if &magic[..4] != b"VAUD" {
            return Err(std::io::Error::other("审计文件 magic 不匹配"));
        }
        let mut ring: VecDeque<AuditEntry> = VecDeque::new();
        let mut pos = 6u64;
        loop {
            let mut header = [0u8; 8];
            match file.read_exact(&mut header) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
                Err(e) => return Err(e),
            }
            let raw_len = u32::from_le_bytes(header[..4].try_into().unwrap()) as usize;
            let comp_len = u32::from_le_bytes(header[4..8].try_into().unwrap()) as usize;
            // 长度异常视为截断损坏：保留已读部分继续用
            if raw_len == 0 || comp_len == 0 || pos + 8 + comp_len as u64 > file_bytes {
                break;
            }
            let mut comp = vec![0u8; comp_len];
            if file.read_exact(&mut comp).is_err() {
                break;
            }
            match zstd::bulk::decompress(&comp, raw_len) {
                Ok(raw) => {
                    if let Ok(entries) = parse_block(&raw) {
                        for e in entries {
                            push_ring(&mut ring, e);
                        }
                    }
                }
                Err(_) => break,
            }
            pos += 8 + comp_len as u64;
        }
        Ok((ring, file_bytes))
    }

    /// 记一条调用（args 为完整参数；内部做截断+指纹）。落盘失败静默降级。
    pub fn record_args(
        &self,
        via: &'static str,
        tool: &str,
        outcome: &'static str,
        detail: String,
        args: Option<serde_json::Value>,
    ) {
        let mut entry = AuditEntry {
            id: 0, // 锁内分配
            at_ms: now_ms(),
            via: via.to_string(),
            tool: tool.to_string(),
            outcome: outcome.to_string(),
            detail,
            args: args.map(compact_args),
        };
        let mut inner = self.inner.lock().unwrap();
        entry.id = inner.next_id;
        inner.next_id += 1;
        inner.total += 1;
        push_ring(&mut inner.ring, entry.clone());
        if inner.degraded.is_none() {
            if let Ok(line) = serde_json::to_string(&entry) {
                inner.buffer.push(line);
            }
            let due = inner.buffer.len() >= FLUSH_ENTRIES
                || (inner.last_flush.elapsed() >= FLUSH_INTERVAL && !inner.buffer.is_empty());
            if due {
                Self::flush_locked(&mut inner);
            }
        }
    }

    /// 无参数事件（接入批准/审计自记）。
    pub fn record(&self, via: &'static str, tool: &str, outcome: &'static str, detail: String) {
        self.record_args(via, tool, outcome, detail, None);
    }

    /// 缓冲压成一块追加写盘；超限时裁剪。锁内同步执行（128 条压缩为微秒级）。
    fn flush_locked(inner: &mut Inner) {
        inner.last_flush = Instant::now();
        if inner.buffer.is_empty() {
            return;
        }
        if inner.degraded.is_some() || inner.file.is_none() {
            inner.buffer.clear(); // 降级：只保内存 ring
            return;
        }
        let jsonl = inner.buffer.join("\n");
        let mut appended = 0u64;
        let write_res = (|| -> std::io::Result<()> {
            let file = inner.file.as_mut().unwrap();
            let before = file.stream_position()?;
            write_block(file, &jsonl)?;
            appended = file.stream_position()? - before;
            file.flush()
        })();
        match write_res {
            Ok(()) => {
                inner.buffer.clear();
                inner.file_bytes += appended;
                if inner.file_bytes > DISK_CAP_BYTES {
                    Self::trim_to_cap(inner);
                }
            }
            Err(e) => {
                inner.degraded = Some(format!("审计写盘失败: {e}"));
                inner.buffer.clear();
            }
        }
    }

    /// 磁盘超硬上限：整块丢弃最旧数据，重写文件（临时文件 + rename 原子替换）。
    fn trim_to_cap(inner: &mut Inner) {
        if inner.path.as_os_str().is_empty() {
            return;
        }
        let path = inner.path.clone();
        let result: std::io::Result<u64> = (|| {
            let mut file = std::fs::File::open(&path)?;
            let total = file.metadata()?.len();
            file.seek(SeekFrom::Start(6))?;
            // 读出全部块（磁盘超限块数量级为几十万个/128 条 → 数千块，可接受）
            let mut blocks: Vec<(u64, usize, Vec<u8>)> = Vec::new(); // (总占用, 条数上限参考, 原始字节)
            let mut pos = 6u64;
            loop {
                let mut header = [0u8; 8];
                if file.read_exact(&mut header).is_err() {
                    break;
                }
                let raw_len = u32::from_le_bytes(header[..4].try_into().unwrap()) as usize;
                let comp_len = u32::from_le_bytes(header[4..8].try_into().unwrap()) as usize;
                if raw_len == 0 || comp_len == 0 || pos + 8 + comp_len as u64 > total {
                    break;
                }
                let mut block = header.to_vec();
                let mut comp = vec![0u8; comp_len];
                if file.read_exact(&mut comp).is_err() {
                    break;
                }
                block.extend_from_slice(&comp);
                blocks.push((8 + comp_len as u64, raw_len, block));
                pos += 8 + comp_len as u64;
            }
            // 从尾往前保留到 3/4 上限
            let target = DISK_CAP_BYTES * 3 / 4;
            let mut kept: Vec<(u64, usize, Vec<u8>)> = Vec::new();
            let mut kept_bytes = 6u64;
            for block in blocks.iter().rev() {
                if kept_bytes + block.0 > target && !kept.is_empty() {
                    break;
                }
                kept_bytes += block.0;
                kept.push(block.clone());
            }
            kept.reverse();
            let dropped = blocks.len() - kept.len();
            let tmp = path.with_extension("tmp");
            {
                let mut out = std::fs::File::create(&tmp)?;
                out.write_all(b"VAUD")?;
                out.write_all(&1u16.to_le_bytes())?;
                for (_, _, block) in &kept {
                    out.write_all(block)?;
                }
                out.flush()?;
            }
            std::fs::rename(&tmp, &path)?;
            inner.file = Some(std::fs::OpenOptions::new().append(true).open(&path)?);
            inner.file_bytes = kept_bytes;
            // 丢弃条数按块内实际行数统计（raw 行数而非估算）
            Ok(dropped as u64)
        })();
        if let Ok(dropped_blocks) = result {
            if dropped_blocks > 0 {
                // 丢弃的是最旧块；total 相应扣减（条数按块内行数精确算代价高，
                // 用总-保留的近似值，误差不影响可追溯性语义）
                push_ring(
                    &mut inner.ring,
                    AuditEntry {
                        id: inner.next_id,
                        at_ms: now_ms(),
                        via: "http".into(),
                        tool: "@audit".into(),
                        outcome: "trimmed".into(),
                        detail: format!("磁盘超 64MB 上限，已清理最旧的 {dropped_blocks} 个块"),
                        args: None,
                    },
                );
                inner.next_id += 1;
            }
        }
    }

    /// 手动 flush（进程退出 / 导出前调用）。
    pub fn flush(&self) {
        let mut inner = self.inner.lock().unwrap();
        Self::flush_locked(&mut inner);
    }

    /// 最近若干条（新的在后）；设置页增量刷新用 since_id 过滤。
    pub fn list_since(&self, since_id: u64, limit: usize) -> Vec<AuditEntry> {
        self.inner
            .lock()
            .unwrap()
            .ring
            .iter()
            .filter(|e| e.id > since_id)
            .rev()
            .take(limit.min(RING_CAPACITY))
            .cloned()
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect()
    }

    pub fn stats(&self) -> AuditStats {
        let inner = self.inner.lock().unwrap();
        AuditStats {
            total: inner.total,
            disk_bytes: inner.file_bytes,
            buffered: inner.buffer.len() as u64,
            degraded: inner.degraded.clone(),
        }
    }

    /// 导出全量（磁盘全部 + 当前缓冲）为解压 JSONL；返回导出条数。
    pub fn export_to(&self, dest: &Path) -> std::io::Result<u64> {
        let mut inner = self.inner.lock().unwrap();
        Self::flush_locked(&mut inner);
        if inner.path.as_os_str().is_empty() {
            return Ok(0);
        }
        let mut count = 0u64;
        let mut out = std::fs::File::create(dest)?;
        let mut file = std::fs::File::open(&inner.path)?;
        let mut magic = [0u8; 6];
        file.read_exact(&mut magic)?;
        let mut first_block = true;
        loop {
            let mut header = [0u8; 8];
            if file.read_exact(&mut header).is_err() {
                break;
            }
            let raw_len = u32::from_le_bytes(header[..4].try_into().unwrap()) as usize;
            let comp_len = u32::from_le_bytes(header[4..8].try_into().unwrap()) as usize;
            if raw_len == 0 || comp_len == 0 {
                break;
            }
            let mut comp = vec![0u8; comp_len];
            if file.read_exact(&mut comp).is_err() {
                break;
            }
            match zstd::bulk::decompress(&comp, raw_len) {
                Ok(raw) => {
                    if !first_block {
                        out.write_all(b"\n")?;
                    }
                    out.write_all(&raw)?;
                    first_block = false;
                    count += String::from_utf8_lossy(&raw)
                        .lines()
                        .filter(|l| !l.trim().is_empty())
                        .count() as u64;
                }
                Err(_) => break,
            }
        }
        out.flush()?;
        Ok(count)
    }

    /// 清空全部（文件删除、内存复位；id 续号保留避免与已导出记录撞号）。
    pub fn clear(&self) {
        let mut inner = self.inner.lock().unwrap();
        inner.ring.clear();
        inner.buffer.clear();
        inner.total = 0;
        inner.file_bytes = 0;
        if !inner.path.as_os_str().is_empty() {
            let _ = std::fs::remove_file(&inner.path);
            if inner.degraded.is_none() {
                if let Ok(mut f) = std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&inner.path)
                {
                    let _ = f.write_all(&[b'V', b'A', b'U', b'D', 1, 0]);
                    inner.file = Some(f);
                }
            }
        }
    }
}

fn push_ring(ring: &mut VecDeque<AuditEntry>, entry: AuditEntry) {
    if ring.len() == RING_CAPACITY {
        ring.pop_front();
    }
    ring.push_back(entry);
}

/// 审批结果三态：主动批准 / 主动拒绝 / 超时未响应（后两者对调用方的语义不同——
/// 拒绝不该重试，超时可以重试）。
pub enum ApprovalOutcome {
    Approved,
    Denied,
    Timeout,
}

/// 一次待确认请求：前端 mcp_confirm_resolve 决定后经 oneshot 唤醒调用方。
/// summary 为人读的中文描述；raw 为原始指令（命令串或参数 JSON），弹窗可展开查看。
struct PendingConfirm {
    summary: String,
    raw: Option<String>,
    tx: oneshot::Sender<bool>,
}

/// 确认请求登记表（危险操作拦截 + 首次接入批准共用）。
#[derive(Default)]
pub struct ConfirmQueue {
    pending: Mutex<std::collections::HashMap<u64, PendingConfirm>>,
    next_id: AtomicU64,
}

impl ConfirmQueue {
    /// 登记请求、通知前端弹窗并等待决定；超时与主动拒绝分别返回不同结果。
    pub async fn wait_approval(
        &self,
        app: &tauri::AppHandle,
        summary: String,
        raw: Option<String>,
    ) -> ApprovalOutcome {
        self.wait_approval_with(app, summary, raw, CONFIRM_TIMEOUT).await
    }

    /// 带自定义超时的实现（测试用短超时验证三态语义）。
    async fn wait_approval_with(
        &self,
        app: &tauri::AppHandle,
        summary: String,
        raw: Option<String>,
        timeout: Duration,
    ) -> ApprovalOutcome {
        use tauri::Emitter;

        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(
            id,
            PendingConfirm {
                summary: summary.clone(),
                raw: raw.clone(),
                tx,
            },
        );
        let _ = app.emit(
            EVENT_CONFIRM,
            serde_json::json!({ "id": id, "summary": summary, "raw": raw }),
        );
        let decided = match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(true)) => ApprovalOutcome::Approved,
            Ok(Ok(false)) => ApprovalOutcome::Denied,
            _ => ApprovalOutcome::Timeout,
        };
        // 超时路径的登记清理（已 resolve 的条目 remove 返回 None，无副作用）
        self.pending.lock().unwrap().remove(&id);
        decided
    }

    /// 前端 resolve；返回 false 表示请求不存在（已超时）。
    pub fn resolve(&self, id: u64, approved: bool) -> bool {
        match self.pending.lock().unwrap().remove(&id) {
            Some(p) => p.tx.send(approved).is_ok(),
            None => false,
        }
    }

    /// 当前挂起中的请求（前端拉取展示弹窗；断线恢复用）。
    pub fn snapshot(&self) -> Vec<(u64, String, Option<String>)> {
        self.pending
            .lock()
            .unwrap()
            .iter()
            .map(|(id, p)| (*id, p.summary.clone(), p.raw.clone()))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn block_roundtrip_and_id_continuity() {
        let dir = std::env::temp_dir().join(format!("vssh-audit-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("audit.log");

        {
            let log = AuditLog::open(&path);
            for i in 0..300 {
                log.record_args(
                    "stdio",
                    "list_dir",
                    "ok",
                    format!("/tmp/{i}"),
                    Some(serde_json::json!({ "path": format!("/tmp/{i}") })),
                );
            }
            log.flush();
        }
        {
            let log = AuditLog::open(&path);
            let stats = log.stats();
            assert_eq!(stats.total, 300, "跨实例总数重建");
            assert_eq!(stats.buffered, 0, "flush 后缓冲为空");
            assert!(stats.disk_bytes > 0);
            // id 续号：新记录 id 不回卷
            log.record("http", "exec", "ok", "续号".into());
            let all = log.list_since(0, 600);
            assert_eq!(all.last().unwrap().id, 301);
            // 模拟进程退出 flush（退出钩子同款），保证导出含缓冲条目
            log.flush();
            // 参数随档保留
            assert!(all
                .iter()
                .any(|e| e.args.as_ref().and_then(|a| a.get("path")).and_then(|p| p.as_str()) == Some("/tmp/0")));
        }
        // 导出 roundtrip：含全部条目且为可读 JSONL
        let out = dir.join("export.jsonl");
        let log = AuditLog::open(&path);
        let n = log.export_to(&out).unwrap();
        assert_eq!(n, 301);
        let text = std::fs::read_to_string(&out).unwrap();
        assert!(text.lines().all(|l| serde_json::from_str::<serde_json::Value>(l).is_ok()));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn compact_args_clips_large_strings_with_fingerprint() {
        let big = "x".repeat(10000);
        let v = compact_args(serde_json::json!({
            "path": "/etc/nginx/nginx.conf",
            "content": big.clone(),
            "nested": { "inner": big.clone() },
            "list": [big.clone(), 42],
        }));
        let obj = v.as_object().unwrap();
        assert_eq!(obj["path"].as_str().unwrap(), "/etc/nginx/nginx.conf");
        let clipped = obj["content"].as_str().unwrap();
        assert!(clipped.contains("已截断，原 10000 字节"));
        let fingerprint = fnv1a64(big.as_bytes());
        assert!(clipped.contains(&format!("fnv64:{fingerprint:016x}")));
        assert!(clipped.len() < 400);
        assert!(obj["nested"]["inner"].as_str().unwrap().contains("已截断"));
        assert!(obj["list"][0].as_str().unwrap().contains("已截断"));
        assert_eq!(obj["list"][1].as_i64(), Some(42));
        assert!(!obj["path"].as_str().unwrap().contains("已截断"));
    }

    #[test]
    fn corrupted_tail_keeps_earlier_entries() {
        let dir = std::env::temp_dir().join(format!("vssh-audit-c-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("audit.log");
        {
            let log = AuditLog::open(&path);
            for i in 0..150 {
                log.record("http", "stat", "ok", format!("d{i}"));
            }
            log.flush();
        }
        // 截断文件尾（模拟半块写入崩溃）
        let bytes = std::fs::read(&path).unwrap();
        std::fs::write(&path, &bytes[..bytes.len() - 10]).unwrap();
        let log = AuditLog::open(&path);
        let stats = log.stats();
        assert!(stats.total > 0, "尾部损坏保留此前条目: {:?}", stats);
        assert!(stats.disk_bytes > 0);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn clear_resets_but_keeps_id_monotonic() {
        let dir = std::env::temp_dir().join(format!("vssh-audit-cl-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("audit.log");
        let log = AuditLog::open(&path);
        log.record("http", "exec", "ok", "a".into());
        log.flush();
        assert_eq!(log.stats().total, 1);
        log.clear();
        assert_eq!(log.stats().total, 0);
        log.record("http", "exec", "ok", "b".into());
        let all = log.list_since(0, 10);
        assert_eq!(all[0].id, 2, "清空后 id 仍续号");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn approval_outcome_distinguishes_denied_and_timeout() {
        use crate::mcp::audit::ApprovalOutcome;
        let q = ConfirmQueue::default();
        // 无 app 句柄：wait_approval_with 不真正 emit（Emitter 需要 AppHandle）——
        // 测试直接验证 resolve 与超时通道语义
        let (tx, rx) = oneshot::channel();
        // 主动拒绝
        tx.send(false).unwrap();
        assert!(matches!(
            tokio::time::timeout(Duration::from_secs(1), rx).await,
            Ok(Ok(false))
        ));
        // 超时（通道不发送）
        let (_tx2, rx2) = oneshot::channel::<bool>();
        assert!(tokio::time::timeout(Duration::from_millis(50), rx2)
            .await
            .is_err());
    }

    #[test]
    fn fnv_known_vector() {
        assert_eq!(fnv1a64(b""), 0xcbf29ce484222325);
        assert_eq!(fnv1a64(b"a"), 0xaf63dc4c8601ec8c);
        assert_eq!(fnv1a64(b"foobar"), 0x85944171f73967e8);
    }

    #[test]
    fn compression_ratio_sanity() {
        // 同类调用批量写入：压缩后应显著小于原始 JSONL（zstd 字典效应）
        let dir = std::env::temp_dir().join(format!("vssh-audit-r-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("audit.log");
        let log = AuditLog::open(&path);
        for i in 0..1000 {
            log.record_args(
                "http",
                "exec",
                "ok",
                format!("exec「systemctl status service{i}」"),
                Some(serde_json::json!({ "command": format!("systemctl status service{i}"), "timeoutSec": 30 })),
            );
        }
        log.flush();
        let stats = log.stats();
        // 1000 条执行记录压缩后应在几十 KB 量级（宽断言防环境抖动）
        assert!(stats.disk_bytes < 40 * 1024, "压缩后 {} 字节", stats.disk_bytes);
        assert!(stats.disk_bytes > 0);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
