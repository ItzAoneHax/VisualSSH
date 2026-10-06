use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tokio::sync::Mutex as AsyncMutex;

use crate::ssh::SshSession;

/// 一条已建立的连接。session 放入 AsyncMutex：
/// 所有 SFTP 操作都要按连接串行化，同时不阻塞其他连接。
#[derive(Clone)]
pub struct SessionHandle {
    /// alias/host/port 供断线提示与传输中心显示目标，M1 阶段尚未读取
    #[allow(dead_code)]
    pub alias: String,
    #[allow(dead_code)]
    pub host: String,
    #[allow(dead_code)]
    pub port: u16,
    pub session: Arc<AsyncMutex<SshSession>>,
}

/// 全局会话池。外层 Mutex 仅做短暂的 HashMap 存取，
/// 锁内不含 await，不会跨异步点持有。
#[derive(Default)]
pub struct AppState {
    sessions: Mutex<HashMap<String, SessionHandle>>,
}

impl AppState {
    pub fn insert(&self, connection_id: String, handle: SessionHandle) {
        self.sessions.lock().unwrap().insert(connection_id, handle);
    }

    pub fn remove(&self, connection_id: &str) -> Option<SessionHandle> {
        self.sessions.lock().unwrap().remove(connection_id)
    }

    pub fn get(&self, connection_id: &str) -> Option<SessionHandle> {
        self.sessions.lock().unwrap().get(connection_id).cloned()
    }
}
