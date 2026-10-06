use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::State;
use tokio::sync::Mutex as AsyncMutex;

use crate::error::{Error, Result};
use crate::ssh::{AuthMethod, FileEntry, SshSession};
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

async fn connect_with_timeout(profile: &SshProfileInput) -> Result<SshSession> {
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
        SshSession::connect(&host, profile.port, username, &auth),
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
    let session = connect_with_timeout(&profile).await?;

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
/// 让前端能区分「测试失败」与「命令本身异常」。
#[tauri::command]
pub async fn ssh_test(profile: SshProfileInput) -> Result<TestResult> {
    let started = Instant::now();
    let outcome = connect_with_timeout(&profile).await;
    let latency_ms = started.elapsed().as_millis() as u64;

    let session = match outcome {
        Ok(session) => session,
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

/// 断开并移除会话池中的连接。
#[tauri::command]
pub async fn ssh_disconnect(connection_id: String, state: State<'_, AppState>) -> Result<()> {
    if let Some(handle) = state.remove(&connection_id) {
        let session = handle.session.lock().await;
        session.disconnect().await;
    }
    Ok(())
}
