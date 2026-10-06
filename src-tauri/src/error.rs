use serde::{ser::Serializer, Serialize};

pub type Result<T> = std::result::Result<T, Error>;

/// 统一错误类型：实现 Serialize 后，Tauri 会把 Err 以字符串形式
/// reject 给前端 `invoke` 的 Promise，直接可读、无需二次解码。
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("无法连接 {host}:{port} — {reason}")]
    Connect {
        host: String,
        port: u16,
        reason: String,
    },

    #[error("认证失败 — {0}")]
    Auth(String),

    #[error("SFTP 会话错误 — {0}")]
    Sftp(String),

    #[error("读取目录失败 — {0}")]
    ReadDir(String),

    /// 前端协议错误：消息固定为 `HOSTKEY_CHANGED|新指纹|旧指纹|算法`，
    /// connections store 按该前缀截获并弹指纹确认对话框。
    #[error("HOSTKEY_CHANGED|{new_fingerprint}|{old_fingerprint}|{algorithm}")]
    HostKeyChanged {
        new_fingerprint: String,
        old_fingerprint: String,
        algorithm: String,
    },

    #[error("known_hosts 记录异常 — {0}")]
    KnownHosts(String),

    #[error("系统凭据存储 — {0}")]
    Credential(String),

    #[error("传输 — {0}")]
    Transfer(String),

    #[error("连接不存在或已断开 — {0}")]
    NoSession(String),

    #[error("操作超时，服务器未在限定时间内响应")]
    Timeout,
}

impl Serialize for Error {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

impl From<russh_sftp::client::error::Error> for Error {
    fn from(e: russh_sftp::client::error::Error) -> Self {
        Error::Sftp(e.to_string())
    }
}
