use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};

/// 一台主机的已信任公钥指纹（TOFU 记录）。
#[derive(Clone, Serialize, Deserialize)]
pub struct HostEntry {
    pub host: String,
    pub port: u16,
    /// 形如 ssh-ed25519
    pub algorithm: String,
    /// 形如 SHA256:base64（OpenSSH 同款格式）
    pub fingerprint: String,
}

/// known_hosts 存储：%APPDATA%/visualssh/known_hosts（JSON 数组，可读性优先）。
/// 每次连接时整体加载，写入用 临时文件 + rename 原子替换。
#[derive(Clone, Default)]
pub struct KnownHosts {
    entries: Vec<HostEntry>,
}

impl KnownHosts {
    pub fn load() -> Result<Self> {
        let path = Self::path()?;
        if !path.exists() {
            return Ok(Self::default());
        }
        let raw = fs::read_to_string(&path)
            .map_err(|e| Error::KnownHosts(format!("读取 {} 失败: {e}", path.display())))?;
        if raw.trim().is_empty() {
            return Ok(Self::default());
        }
        serde_json::from_str::<Vec<HostEntry>>(&raw)
            .map(|entries| Self { entries })
            .map_err(|e| {
                Error::KnownHosts(format!(
                    "known_hosts 文件格式损坏（{}）: {e}",
                    path.display()
                ))
            })
    }

    pub fn lookup(&self, host: &str, port: u16) -> Option<&HostEntry> {
        self.entries
            .iter()
            .find(|e| e.port == port && e.host.eq_ignore_ascii_case(host))
    }

    pub fn upsert(&mut self, entry: HostEntry) {
        match self.entries.iter_mut().find(|e| {
            e.port == entry.port && e.host.eq_ignore_ascii_case(&entry.host)
        }) {
            Some(existing) => *existing = entry,
            None => self.entries.push(entry),
        }
    }

    pub fn save(&self) -> Result<()> {
        let path = Self::path()?;
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir)
                .map_err(|e| Error::KnownHosts(format!("创建 {} 失败: {e}", dir.display())))?;
        }
        let body = serde_json::to_string_pretty(&self.entries)
            .map_err(|e| Error::KnownHosts(format!("序列化 known_hosts 失败: {e}")))?;
        let tmp = path.with_extension("tmp");
        fs::write(&tmp, body)
            .map_err(|e| Error::KnownHosts(format!("写入 {} 失败: {e}", tmp.display())))?;
        fs::rename(&tmp, &path)
            .map_err(|e| Error::KnownHosts(format!("替换 {} 失败: {e}", path.display())))
    }

    fn path() -> Result<PathBuf> {
        dirs::config_dir()
            .map(|d| d.join("visualssh").join("known_hosts"))
            .ok_or_else(|| Error::KnownHosts("无法定位用户配置目录".into()))
    }
}
