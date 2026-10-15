//! MCP 配置（%APPDATA%/visualssh/mcp.json）。
//! 与其余前端设置（localStorage）分开存放的原因：hub 在 Tauri setup 阶段
//! （前端尚未启动）就要读端口/开关，引导期必须 Rust 侧自持。

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};

/// 默认端口：高位冷门段，避开常见开发端口冲突（可在设置页修改）。
pub const DEFAULT_PORT: u16 = 27117;

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct McpConfig {
    /// MCP 服务总开关（默认开：localhost + token + 首次接入批准三重门槛已够）
    pub enabled: bool,
    /// streamable HTTP 监听端口（仅 127.0.0.1）
    pub port: u16,
    /// 64 hex 随机令牌；stdio shim 与 HTTP 客户端共用
    pub token: String,
    /// 首次接入批准（GUI 弹窗批准一次后落盘，重置可撤销）
    pub approved: bool,
    /// 危险操作拦截（默认全放行）：删除前弹窗确认
    pub confirm_delete: bool,
    /// 危险操作拦截：exec 前弹窗确认
    pub confirm_exec: bool,
    /// 危险操作拦截：覆盖写已存在文件前弹窗确认
    pub confirm_overwrite: bool,
}

impl Default for McpConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            port: DEFAULT_PORT,
            token: new_token(),
            approved: false,
            confirm_delete: false,
            confirm_exec: false,
            confirm_overwrite: false,
        }
    }
}

/// 64 hex 随机令牌（两个 v4 UUID 拼接，熵 256 bit 足够；免引入 rand 依赖）。
pub fn new_token() -> String {
    let a = uuid::Uuid::new_v4().simple().to_string();
    let b = uuid::Uuid::new_v4().simple().to_string();
    format!("{a}{b}")
}

fn config_path() -> Result<PathBuf> {
    dirs::config_dir()
        .map(|d| d.join("visualssh").join("mcp.json"))
        .ok_or_else(|| Error::Io("无法定位用户配置目录".into()))
}

/// 读取配置；文件不存在或损坏时生成默认配置（含新 token）并落盘。
pub fn load_or_init() -> McpConfig {
    let read = (|| -> Result<McpConfig> {
        let raw = std::fs::read_to_string(config_path()?)?;
        serde_json::from_str(&raw).map_err(|e| Error::Io(e.to_string()))
    })();
    match read {
        Ok(mut cfg) => {
            // 兼容手工编辑出空 token 的情况
            if cfg.token.trim().is_empty() {
                cfg.token = new_token();
                let _ = save(&cfg);
            }
            cfg
        }
        Err(_) => {
            let cfg = McpConfig::default();
            let _ = save(&cfg);
            cfg
        }
    }
}

pub fn save(cfg: &McpConfig) -> Result<()> {
    let path = config_path()?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let raw = serde_json::to_string_pretty(cfg).map_err(|e| Error::Io(e.to_string()))?;
    std::fs::write(&path, raw)?;
    Ok(())
}

/// 端口约束：避开 0/1（保留）与 65536 溢出；其余交给用户。
pub fn sanitize_port(port: u16) -> u16 {
    if port < 1024 { DEFAULT_PORT } else { port }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_is_64_hex() {
        let t = new_token();
        assert_eq!(t.len(), 64);
        assert!(t.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn deserialize_defaults_for_missing_fields() {
        // 旧版本配置文件新增字段后仍可读
        let cfg: McpConfig = serde_json::from_str(r#"{"port": 30000}"#).unwrap();
        assert!(cfg.enabled);
        assert_eq!(cfg.port, 30000);
        assert!(!cfg.approved);
    }
}
