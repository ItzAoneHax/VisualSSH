use keyring::Entry;

use crate::error::{Error, Result};

/// Windows 凭据管理器里的服务名（用户可见，凭据按 key 区分）。
const SERVICE: &str = "VisualSSH";

fn open_entry(key: &str) -> Result<Entry> {
    Entry::new(SERVICE, key)
        .map_err(|e| Error::Credential(format!("打开系统凭据存储失败: {e}")))
}

/// 读取凭据；不存在返回 None（供前端判断「未保存」）。
#[tauri::command]
pub async fn credential_get(key: String) -> Result<Option<String>> {
    match open_entry(&key)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(Error::Credential(format!("读取凭据失败: {e}"))),
    }
}

#[tauri::command]
pub async fn credential_put(key: String, value: String) -> Result<()> {
    open_entry(&key)?
        .set_password(&value)
        .map_err(|e| Error::Credential(format!("写入凭据失败: {e}")))
}

/// 删除凭据；本就不存在时同样成功（幂等）。
#[tauri::command]
pub async fn credential_delete(key: String) -> Result<()> {
    match open_entry(&key)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(Error::Credential(format!("删除凭据失败: {e}"))),
    }
}
