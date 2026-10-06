use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use russh::client::{self, Handle};
use russh::keys::PrivateKeyWithHashAlg;
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::{FileAttributes, OpenFlags};

use super::fs::{self, FileEntry};
use crate::error::{Error, Result};

/// SSH 客户端事件回调。
///
/// 安全说明：MVP 阶段 `check_server_key` 信任所有主机密钥，
/// known_hosts 校验（TOFU，首次信任 + 指纹变更告警）在 M2 落地。
pub struct ClientHandler;

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &russh::keys::PublicKeyOrCertificate,
    ) -> std::result::Result<bool, Self::Error> {
        Ok(true)
    }
}

pub enum AuthMethod {
    Password { password: String },
    PrivateKey { path: String, passphrase: Option<String> },
}

/// 一台远程主机的完整会话：SSH 传输层 + 常开的 SFTP 通道。
/// 后续里程碑的终端（shell channel）也复用这里的 handle。
pub struct SshSession {
    handle: Handle<ClientHandler>,
    sftp: SftpSession,
}

impl SshSession {
    pub async fn connect(
        host: &str,
        port: u16,
        username: &str,
        auth: &AuthMethod,
    ) -> Result<Self> {
        let config = Arc::new(client::Config {
            keepalive_interval: Some(Duration::from_secs(30)),
            keepalive_max: 3,
            nodelay: true,
            ..Default::default()
        });

        let mut handle = client::connect(config, (host, port), ClientHandler)
            .await
            .map_err(|e| Error::Connect {
                host: host.to_string(),
                port,
                reason: e.to_string(),
            })?;

        let auth_result = match auth {
            AuthMethod::Password { password } => handle
                .authenticate_password(username, password.as_str())
                .await
                .map_err(|e| Error::Auth(format!("认证过程出错: {e}")))?,
            AuthMethod::PrivateKey { path, passphrase } => {
                let key = russh::keys::load_secret_key(path, passphrase.as_deref())
                    .map_err(|e| Error::Auth(format!("无法读取私钥 {path}: {e}")))?;
                // RSA 密钥需要按服务器支持情况选择散列算法，其余算法忽略该参数
                let hash_alg = handle
                    .best_supported_rsa_hash()
                    .await
                    .map_err(|e| Error::Auth(format!("协商签名算法失败: {e}")))?
                    .flatten();
                let key = PrivateKeyWithHashAlg::new(Arc::new(key), hash_alg);
                handle
                    .authenticate_publickey(username, key)
                    .await
                    .map_err(|e| Error::Auth(format!("认证过程出错: {e}")))?
            }
        };

        if !auth_result.success() {
            return Err(Error::Auth(match auth {
                AuthMethod::Password { .. } => "用户名或密码被服务器拒绝".into(),
                AuthMethod::PrivateKey { .. } => "服务器拒绝了这把私钥".into(),
            }));
        }

        let sftp = Self::open_sftp(&handle).await?;
        Ok(Self { handle, sftp })
    }

    async fn open_sftp(handle: &Handle<ClientHandler>) -> Result<SftpSession> {
        let channel = handle
            .channel_open_session()
            .await
            .map_err(|e| Error::Sftp(format!("无法打开会话通道: {e}")))?;
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|e| Error::Sftp(format!("请求 SFTP 子系统失败: {e}")))?;
        SftpSession::new(channel.into_stream())
            .await
            .map_err(|e| Error::Sftp(format!("SFTP 握手失败: {e}")))
    }

    /// 解析路径为绝对、无符号链接的真实路径（用于确定根目录）。
    pub async fn canonicalize(&self, path: &str) -> Result<String> {
        self.sftp
            .canonicalize(path)
            .await
            .map_err(|e| Error::Sftp(format!("解析路径 {path} 失败: {e}")))
    }

    /// 读取目录并按「文件夹优先 + 名称不区分大小写」排序。
    pub async fn list_dir(&self, path: &str) -> Result<Vec<FileEntry>> {
        let read_dir = self
            .sftp
            .read_dir(path)
            .await
            .map_err(|e| Error::ReadDir(format!("{path}: {e}")))?;
        Ok(fs::to_file_entries(read_dir))
    }

    pub async fn disconnect(&self) {
        let _ = self.sftp.close().await;
        let _ = self
            .handle
            .disconnect(
                russh::Disconnect::ByApplication,
                "Connection closed by VisualSSH",
                "en",
            )
            .await;
    }

    pub async fn mkdir(&self, path: &str) -> Result<()> {
        self.sftp
            .create_dir(path)
            .await
            .map_err(|e| Error::Sftp(format!("创建目录 {path} 失败: {e}")))
    }

    /// 新建空文件：CREATE|WRITE 在文件已存在时不截断（touch 语义）。
    pub async fn touch(&self, path: &str) -> Result<()> {
        let file = self
            .sftp
            .open_with_flags(path, OpenFlags::CREATE | OpenFlags::WRITE)
            .await
            .map_err(|e| Error::Sftp(format!("新建文件 {path} 失败: {e}")))?;
        file.close()
            .await
            .map_err(|e| Error::Sftp(format!("新建文件 {path} 失败: {e}")))
    }

    pub async fn rename(&self, old_path: &str, new_path: &str) -> Result<()> {
        self.sftp
            .rename(old_path, new_path)
            .await
            .map_err(|e| Error::Sftp(format!("重命名 {old_path} 为 {new_path} 失败: {e}")))
    }

    /// 删除单个条目。非递归时按文件删除，失败再按空目录尝试；
    /// 递归时先删光子项再删目录本身（russh-sftp 没有 remove_dir_all）。
    pub async fn delete(&self, path: &str, recursive: bool) -> Result<()> {
        if recursive {
            return self.delete_tree(path).await;
        }
        if self.sftp.remove_file(path).await.is_ok() {
            return Ok(());
        }
        self.sftp
            .remove_dir(path)
            .await
            .map_err(|e| Error::Sftp(format!("删除 {path} 失败: {e}")))
    }

    /// 递归删除要装箱才能成为合法的递归 async 闭包。
    fn delete_tree<'a>(
        &'a self,
        path: &'a str,
    ) -> std::pin::Pin<Box<dyn Future<Output = Result<()>> + Send + 'a>> {
        Box::pin(async move {
            for entry in self.list_dir(path).await? {
                let child = join_remote(path, &entry.name);
                if entry.kind == "dir" {
                    self.delete_tree(&child).await?;
                } else {
                    // 符号链接只删除链接自身，不跟随目标
                    self.sftp
                        .remove_file(&child)
                        .await
                        .map_err(|e| Error::Sftp(format!("删除 {child} 失败: {e}")))?;
                }
            }
            self.sftp
                .remove_dir(path)
                .await
                .map_err(|e| Error::Sftp(format!("删除目录 {path} 失败: {e}")))
        })
    }

    /// 修改权限位（setstat）。mode 由调用方保证只含低 12 位。
    pub async fn chmod(&self, path: &str, mode: u32) -> Result<()> {
        let attrs = FileAttributes {
            permissions: Some(mode & 0o7777),
            ..FileAttributes::default()
        };
        self.sftp
            .set_metadata(path, attrs)
            .await
            .map_err(|e| Error::Sftp(format!("修改 {path} 权限失败: {e}")))
    }
}

/// 拼接远程路径（根目录单独处理，避免出现 //x）。
fn join_remote(dir: &str, name: &str) -> String {
    if dir == "/" {
        format!("/{name}")
    } else {
        format!("{dir}/{name}")
    }
}
