use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::client::{self, Handle};
use russh::keys::{HashAlg, PrivateKeyWithHashAlg};
use russh_sftp::client::fs::File as RemoteFile;
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::{FileAttributes, OpenFlags};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::fs::{self, FileEntry};
use super::known_hosts::KnownHosts;
use crate::error::{Error, Result};

/// 单次连接的主机密钥校验结论。
#[derive(Clone)]
enum CheckOutcome {
    /// 首次见到该主机：TOFU 自动信任，由命令层在认证成功后落盘
    FirstTime,
    /// 指纹与已存记录一致
    Matched,
    /// 指纹与已存记录不一致（可能换钥，也可能中间人）
    Mismatch { old: String },
}

/// check_server_key 回调写入的结论快照，connect 返回后供命令层读取。
#[derive(Clone)]
struct CheckRecord {
    outcome: CheckOutcome,
    algorithm: String,
    fingerprint: String,
}

/// SSH 客户端事件回调：check_server_key 实现 TOFU（首次信任 + 变更拒绝）。
pub struct ClientHandler {
    host: String,
    port: u16,
    known: KnownHosts,
    check: Arc<Mutex<Option<CheckRecord>>>,
}

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::PublicKeyOrCertificate,
    ) -> std::result::Result<bool, Self::Error> {
        let key = server_public_key.public_key();
        let algorithm = key.algorithm().to_string();
        let fingerprint = key.fingerprint(HashAlg::Sha256).to_string();

        let (outcome, ok) = match self.known.lookup(&self.host, self.port) {
            Some(e) if e.fingerprint == fingerprint => (CheckOutcome::Matched, true),
            Some(e) => (CheckOutcome::Mismatch { old: e.fingerprint.clone() }, false),
            None => (CheckOutcome::FirstTime, true),
        };
        *self.check.lock().unwrap() = Some(CheckRecord {
            outcome,
            algorithm,
            fingerprint,
        });
        Ok(ok)
    }
}

/// 连接成功后交给命令层的主机密钥摘要。
#[derive(Clone)]
pub struct HostKeyRecord {
    pub algorithm: String,
    pub fingerprint: String,
    pub first_time: bool,
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
        known: KnownHosts,
    ) -> Result<(Self, HostKeyRecord)> {
        let config = Arc::new(client::Config {
            keepalive_interval: Some(Duration::from_secs(30)),
            keepalive_max: 3,
            nodelay: true,
            ..Default::default()
        });

        let check = Arc::new(Mutex::new(None));
        let handler = ClientHandler {
            host: host.to_string(),
            port,
            known,
            check: Arc::clone(&check),
        };

        let mut handle = client::connect(config, (host, port), handler)
            .await
            .map_err(|e| {
                // 指纹不匹配时 russh 只报泛型错误；用回调结论改写为结构化错误
                let record = check.lock().unwrap().clone();
                if let Some(CheckRecord {
                    outcome: CheckOutcome::Mismatch { old },
                    algorithm,
                    fingerprint,
                }) = record
                {
                    return Error::HostKeyChanged {
                        new_fingerprint: fingerprint,
                        old_fingerprint: old,
                        algorithm,
                    };
                }
                Error::Connect {
                    host: host.to_string(),
                    port,
                    reason: e.to_string(),
                }
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

        let host_key = match check.lock().unwrap().clone() {
            Some(record) => HostKeyRecord {
                first_time: matches!(record.outcome, CheckOutcome::FirstTime),
                algorithm: record.algorithm,
                fingerprint: record.fingerprint,
            },
            // check_server_key 必然先于认证被调用；防御性兜底按「已匹配」处理
            None => HostKeyRecord {
                first_time: false,
                algorithm: String::new(),
                fingerprint: String::new(),
            },
        };
        Ok((Self { handle, sftp }, host_key))
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

    /// 打开远端文件只读句柄（下载流用；句柄持有期间可释放会话锁继续浏览）。
    pub async fn open_read(&self, path: &str) -> Result<RemoteFile> {
        self.sftp
            .open(path)
            .await
            .map_err(|e| Error::Sftp(format!("打开远端文件 {path} 失败: {e}")))
    }

    /// 创建远端文件写入句柄（上传流用；已存在则截断）。
    pub async fn open_write(&self, path: &str) -> Result<RemoteFile> {
        self.sftp
            .create(path)
            .await
            .map_err(|e| Error::Sftp(format!("创建远端文件 {path} 失败: {e}")))
    }

    /// 读取远端文件大小（下载前确定 total）。
    pub async fn file_size(&self, path: &str) -> Result<u64> {
        let meta = self
            .sftp
            .metadata(path)
            .await
            .map_err(|e| Error::Sftp(format!("读取 {path} 属性失败: {e}")))?;
        meta.size
            .ok_or_else(|| Error::Sftp(format!("服务器未返回 {path} 的大小")))
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

    /// 读整个文本文件（UTF-8）。大小上限与前端预览限制一致。
    pub async fn read_file(&self, path: &str) -> Result<String> {
        const MAX_TEXT_BYTES: u64 = 2 * 1024 * 1024;
        let size = self.file_size(path).await?;
        if size > MAX_TEXT_BYTES {
            return Err(Error::Sftp(format!("{path} 超过 2MB，不支持文本预览")));
        }

        let mut file = self.open_read(path).await?;
        let mut buf = Vec::with_capacity(size as usize);
        let mut chunk = vec![0u8; 64 * 1024];
        loop {
            let n = file
                .read(&mut chunk)
                .await
                .map_err(|e| Error::Sftp(format!("读取 {path} 失败: {e}")))?;
            if n == 0 {
                break;
            }
            buf.extend_from_slice(&chunk[..n]);
            if buf.len() as u64 > MAX_TEXT_BYTES {
                return Err(Error::Sftp(format!("{path} 超过 2MB，不支持文本预览")));
            }
        }
        String::from_utf8(buf)
            .map_err(|_| Error::Sftp(format!("{path} 不是 UTF-8 文本，无法预览")))
    }

    /// 原子写：先写同目录临时文件，close 确认落盘后 rename 替换目标。
    pub async fn write_file(&self, path: &str, content: &str) -> Result<()> {
        let tmp_path = format!("{path}.vsshtmp");
        let mut tmp = match self.open_write(&tmp_path).await {
            Ok(f) => f,
            Err(e) => return Err(e),
        };
        if let Err(e) = tmp.write_all(content.as_bytes()).await {
            let _ = self.sftp.remove_file(&tmp_path).await;
            return Err(Error::Sftp(format!("写入 {path} 失败: {e}")));
        }
        // close 等待远端确认全部写入；失败则清理临时文件
        if let Err(e) = tmp.close().await {
            let _ = self.sftp.remove_file(&tmp_path).await;
            return Err(Error::Sftp(format!("写入 {path} 失败: {e}")));
        }
        // SFTP 的 RENAME 在目标已存在时被多数服务器拒绝（russh-sftp 未暴露
        // posix-rename 扩展，无法原子覆盖）。参照 WinSCP 同款回退：删旧后重试。
        // 窗口期内目标短暂不可见，但新内容始终完整保留在临时文件中：
        // 若重试仍失败，明确告知用户恢复路径。
        if let Err(first) = self.sftp.rename(&tmp_path, path).await {
            self.sftp.remove_file(path).await.map_err(|e| {
                Error::Sftp(format!(
                    "替换 {path} 失败: {first}（清理旧文件也失败: {e}）。新内容完整保留在 {tmp_path}，可手动恢复"
                ))
            })?;
            if let Err(e) = self.sftp.rename(&tmp_path, path).await {
                return Err(Error::Sftp(format!(
                    "替换 {path} 失败: {e}。你的新内容完整保留在 {tmp_path}，可在文件列表中手动重命名恢复"
                )));
            }
        }
        Ok(())
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
