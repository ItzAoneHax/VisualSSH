use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::State;
use tokio::sync::Mutex as AsyncMutex;

use crate::error::{Error, Result};
use crate::ssh::{AuthMethod, FileEntry, HostEntry, KnownHosts, SshSession};
use crate::state::{AppState, SessionHandle};

/// 连接 + 首次 SFTP 握手的总预算
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
/// 单次文件系统操作的预算
const IO_TIMEOUT: Duration = Duration::from_secs(30);

/// 与前端 SshProfileInput 对应（camelCase 由 serde 转换）
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshProfileInput {
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
    pub username: String,
    pub password: Option<String>,
    pub private_key_path: Option<String>,
    pub passphrase: Option<String>,
}

fn default_port() -> u16 {
    22
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectResult {
    pub connection_id: String,
    pub root_path: String,
    pub latency_ms: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestResult {
    pub ok: bool,
    pub latency_ms: u64,
    pub message: Option<String>,
}

fn auth_method_of(profile: &SshProfileInput) -> Result<AuthMethod> {
    if let Some(path) = non_empty(&profile.private_key_path) {
        return Ok(AuthMethod::PrivateKey {
            path,
            passphrase: non_empty(&profile.passphrase),
        });
    }
    if let Some(password) = non_empty(&profile.password) {
        return Ok(AuthMethod::Password { password });
    }
    Err(Error::Auth("请提供密码或私钥文件路径".into()))
}

fn non_empty(value: &Option<String>) -> Option<String> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

async fn connect_with_timeout(
    profile: &SshProfileInput,
    known: KnownHosts,
) -> Result<(SshSession, crate::ssh::HostKeyRecord)> {
    let host = profile.host.trim().to_string();
    if host.is_empty() {
        return Err(Error::Connect {
            host: profile.host.clone(),
            port: profile.port,
            reason: "主机名为空".into(),
        });
    }
    let username = profile.username.trim();
    let auth = auth_method_of(profile)?;

    tokio::time::timeout(
        CONNECT_TIMEOUT,
        SshSession::connect(&host, profile.port, username, &auth, known),
    )
    .await
    .map_err(|_| Error::Timeout)?
}

/// 建立连接并注册到全局会话池，返回根目录路径供浏览器首次加载。
#[tauri::command]
pub async fn ssh_connect(
    alias: String,
    profile: SshProfileInput,
    state: State<'_, AppState>,
) -> Result<ConnectResult> {
    let started = Instant::now();
    let mut known = KnownHosts::load()?;
    // 快照交给回调做 TOFU 校验；命令层保留一份用于首次信任后落盘
    let (session, host_key) = connect_with_timeout(&profile, known.clone()).await?;

    if host_key.first_time {
        // 信任记录落盘失败视为连接失败：没有基线的 TOFU 等于没有防护
        known.upsert(HostEntry {
            host: profile.host.trim().to_string(),
            port: profile.port,
            algorithm: host_key.algorithm,
            fingerprint: host_key.fingerprint,
        });
        known.save()?;
    }

    let root_path = tokio::time::timeout(IO_TIMEOUT, session.canonicalize("/"))
        .await
        .map_err(|_| Error::Timeout)??;

    let connection_id = uuid::Uuid::new_v4().to_string();
    state.insert(
        connection_id.clone(),
        SessionHandle {
            alias,
            host: profile.host.trim().to_string(),
            port: profile.port,
            session: Arc::new(AsyncMutex::new(session)),
        },
    );

    Ok(ConnectResult {
        connection_id,
        root_path,
        latency_ms: started.elapsed().as_millis() as u64,
    })
}

/// 测试连接：完整走一遍「TCP + 认证 + SFTP 握手」，结果以值返回而非 Err，
/// 让前端能区分「测试失败」与「命令本身异常」。探测不落盘首次信任记录，
/// 由正式连接（ssh_connect）负责写入。
#[tauri::command]
pub async fn ssh_test(profile: SshProfileInput) -> Result<TestResult> {
    let started = Instant::now();
    let known = KnownHosts::load()?;
    let outcome = connect_with_timeout(&profile, known).await;
    let latency_ms = started.elapsed().as_millis() as u64;

    let session = match outcome {
        Ok((session, _)) => session,
        Err(e) => {
            return Ok(TestResult {
                ok: false,
                latency_ms,
                message: Some(e.to_string()),
            })
        }
    };

    let sftp_ok = tokio::time::timeout(IO_TIMEOUT, session.canonicalize("/"))
        .await
        .map_err(|_| Error::Timeout)?
        .is_ok();
    session.disconnect().await;

    Ok(if sftp_ok {
        TestResult {
            ok: true,
            latency_ms,
            message: None,
        }
    } else {
        TestResult {
            ok: false,
            latency_ms,
            message: Some("SSH 已连通，但 SFTP 子系统不可用".into()),
        }
    })
}

/// 读取远程目录。entries 已按「文件夹优先 + 名称序」排好。
#[tauri::command]
pub async fn ssh_list_dir(
    connection_id: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<Vec<FileEntry>> {
    let handle = state
        .get(&connection_id)
        .ok_or_else(|| Error::NoSession(connection_id.clone()))?;
    let session = handle.session.lock().await;
    tokio::time::timeout(IO_TIMEOUT, session.list_dir(&path))
        .await
        .map_err(|_| Error::Timeout)?
}

#[tauri::command]
pub async fn ssh_mkdir(
    connection_id: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<()> {
    let handle = state
        .get(&connection_id)
        .ok_or_else(|| Error::NoSession(connection_id.clone()))?;
    let session = handle.session.lock().await;
    tokio::time::timeout(IO_TIMEOUT, session.mkdir(&path))
        .await
        .map_err(|_| Error::Timeout)?
}

#[tauri::command]
pub async fn ssh_touch(
    connection_id: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<()> {
    let handle = state
        .get(&connection_id)
        .ok_or_else(|| Error::NoSession(connection_id.clone()))?;
    let session = handle.session.lock().await;
    tokio::time::timeout(IO_TIMEOUT, session.touch(&path))
        .await
        .map_err(|_| Error::Timeout)?
}

#[tauri::command]
pub async fn ssh_rename(
    connection_id: String,
    old_path: String,
    new_path: String,
    state: State<'_, AppState>,
) -> Result<()> {
    let handle = state
        .get(&connection_id)
        .ok_or_else(|| Error::NoSession(connection_id.clone()))?;
    let session = handle.session.lock().await;
    tokio::time::timeout(IO_TIMEOUT, session.rename(&old_path, &new_path))
        .await
        .map_err(|_| Error::Timeout)?
}

#[tauri::command]
pub async fn ssh_delete(
    connection_id: String,
    path: String,
    recursive: bool,
    state: State<'_, AppState>,
) -> Result<()> {
    let handle = state
        .get(&connection_id)
        .ok_or_else(|| Error::NoSession(connection_id.clone()))?;
    let session = handle.session.lock().await;
    tokio::time::timeout(IO_TIMEOUT, session.delete(&path, recursive))
        .await
        .map_err(|_| Error::Timeout)?
}

#[tauri::command]
pub async fn ssh_chmod(
    connection_id: String,
    path: String,
    mode: u32,
    state: State<'_, AppState>,
) -> Result<()> {
    let handle = state
        .get(&connection_id)
        .ok_or_else(|| Error::NoSession(connection_id.clone()))?;
    let session = handle.session.lock().await;
    tokio::time::timeout(IO_TIMEOUT, session.chmod(&path, mode))
        .await
        .map_err(|_| Error::Timeout)?
}

/// 读文本文件（UTF-8，≤2MB），供编辑抽屉加载。
#[tauri::command]
pub async fn ssh_read_file(
    connection_id: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<String> {
    let handle = state
        .get(&connection_id)
        .ok_or_else(|| Error::NoSession(connection_id.clone()))?;
    let session = handle.session.lock().await;
    tokio::time::timeout(IO_TIMEOUT, session.read_file(&path))
        .await
        .map_err(|_| Error::Timeout)?
}

/// 读取符号链接目标（属性对话框）。
#[tauri::command]
pub async fn ssh_read_link(
    connection_id: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<String> {
    let handle = state
        .get(&connection_id)
        .ok_or_else(|| Error::NoSession(connection_id.clone()))?;
    let session = handle.session.lock().await;
    tokio::time::timeout(IO_TIMEOUT, session.read_link(&path))
        .await
        .map_err(|_| Error::Timeout)?
}

/// 原子写回：同目录临时文件落盘后 rename 替换。
#[tauri::command]
pub async fn ssh_write_file(
    connection_id: String,
    path: String,
    content: String,
    state: State<'_, AppState>,
) -> Result<()> {
    let handle = state
        .get(&connection_id)
        .ok_or_else(|| Error::NoSession(connection_id.clone()))?;
    let session = handle.session.lock().await;
    tokio::time::timeout(IO_TIMEOUT, session.write_file(&path, &content))
        .await
        .map_err(|_| Error::Timeout)?
}

/// 在远端 shell 执行命令（内部复制/移动用），收集 stdout/stderr/退出码。
#[tauri::command]
pub async fn ssh_exec(
    connection_id: String,
    program: String,
    args: Vec<String>,
    state: State<'_, AppState>,
) -> Result<crate::ssh::ExecOutput> {
    let handle = state
        .get(&connection_id)
        .ok_or_else(|| Error::NoSession(connection_id.clone()))?;
    let session = handle.session.lock().await;
    tokio::time::timeout(IO_TIMEOUT, session.exec(&program, &args))
        .await
        .map_err(|_| Error::Timeout)?
}

/// 断开并移除会话池中的连接；同时取消该连接的全部传输/统计并关闭其全部终端。
#[tauri::command]
pub async fn ssh_disconnect(
    connection_id: String,
    state: State<'_, AppState>,
    transfers: State<'_, crate::transfer::TransferManager>,
    terminals: State<'_, std::sync::Arc<crate::terminal::TerminalManager>>,
    stats: State<'_, std::sync::Arc<crate::stats::StatsManager>>,
) -> Result<()> {
    transfers.cancel_for_connection(&connection_id);
    terminals.close_for_connection(&connection_id);
    stats.cancel_for_connection(&connection_id);
    if let Some(handle) = state.remove(&connection_id) {
        let session = handle.session.lock().await;
        session.disconnect().await;
    }
    Ok(())
}

/// 用户在指纹变更对话框确认后更新 known_hosts（随后由前端发起重连）。
#[tauri::command]
pub async fn ssh_trust_host(
    host: String,
    port: u16,
    algorithm: String,
    fingerprint: String,
) -> Result<()> {
    let mut known = KnownHosts::load()?;
    known.upsert(HostEntry {
        host: host.trim().to_string(),
        port,
        algorithm,
        fingerprint,
    });
    known.save()
}

/// 设置页：全部已信任主机记录。
#[tauri::command]
pub async fn ssh_known_hosts_list() -> Result<Vec<HostEntry>> {
    Ok(KnownHosts::load()?.list())
}

/// 设置页：删除一条信任记录（下次连接将重新触发 TOFU 首次信任）。
#[tauri::command]
pub async fn ssh_known_hosts_remove(host: String, port: u16) -> Result<bool> {
    let mut known = KnownHosts::load()?;
    let removed = known.remove(host.trim(), port);
    if removed {
        known.save()?;
    }
    Ok(removed)
}
