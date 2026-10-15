//! 已保存连接配置（profile）元数据缓存。
//! profile 列表本存在前端 localStorage，Rust 引导期拿不到；
//! 前端启动与增删改时推送快照到此（只含连接参数，绝不含凭据——
//! 凭据始终留在系统加密存储，MCP connect 时由本进程直读）。

use std::sync::RwLock;

use serde::{Deserialize, Serialize};

/// 与前端 SshProfile 的连接字段对应（凭据字段刻意不存在）。
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProfileMeta {
    pub id: String,
    pub name: String,
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
    pub username: String,
    pub private_key_path: Option<String>,
}

fn default_port() -> u16 {
    22
}

#[derive(Default)]
pub struct ProfileCache {
    inner: RwLock<Vec<ProfileMeta>>,
}

impl ProfileCache {
    /// 前端推送全量快照（localStorage 里 profile 数量级很小，全量替换即可）。
    pub fn replace(&self, profiles: Vec<ProfileMeta>) {
        *self.inner.write().unwrap() = profiles;
    }

    pub fn list(&self) -> Vec<ProfileMeta> {
        self.inner.read().unwrap().clone()
    }

    /// 按 id 或显示名匹配（connect 工具的 connection 参数语义之一）。
    pub fn find(&self, key: &str) -> Option<ProfileMeta> {
        let key = key.trim();
        self.inner
            .read()
            .unwrap()
            .iter()
            .find(|p| p.id == key || p.name == key)
            .cloned()
    }
}
