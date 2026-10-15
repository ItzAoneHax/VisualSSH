//! 运行中交付的自动换版（pack-exe 改名腾位后的热升级）。
//!
//! 判定不依赖改名后缀——运行中进程的 current_exe() 返回启动时记录的路径
//! 字符串，之后的文件改名不会反映进来；改用「该路径上的文件在本进程启动
//! 后被替换过」（mtime > 启动时刻）：pack-exe 撞锁改名腾位后，canonical
//! 原路径上已是新版，而 current_exe() 恰好指向该路径（拉起目标也自动正确）。
//! 前端轮询 upgrade_state（含 MCP 忙碌判定），条件齐备（任务清空 + 用户
//! 闲置 5 分钟）时写会话快照后调 upgrade_apply：拉起新版 → 本进程退出；
//! 新版启动时消费快照恢复原页面。

use std::sync::OnceLock;
use std::time::SystemTime;

static STARTED_AT: OnceLock<SystemTime> = OnceLock::new();

/// 记录进程启动时刻（lib.rs run() 入口调用——换版判定的基准）。
pub(crate) fn mark_started() {
    let _ = STARTED_AT.set(SystemTime::now());
}

/// 待启用的更新：本进程 exe 路径上的文件在启动后被替换过 → Some(该路径)。
/// 返回的路径即拉起目标（路径上的文件已是新版）。
///
/// 判据取 max(创建时间, 修改时间)：Windows 上的复制（CopyFileW——Explorer/
/// node copyFile 都走它）**保留源文件的修改时间**，换入的 exe 带的是构建时刻
/// （早于本进程启动，mtime 判定会漏报），但创建时间是拷贝时刻——两者较新者
/// 落在启动之后即视为「路径上的文件被换过」。
pub(crate) fn pending_upgrade() -> Option<std::path::PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let started = *STARTED_AT.get_or_init(SystemTime::now);
    let meta = std::fs::metadata(&exe).ok()?;
    let mtime = meta.modified().ok()?;
    let replaced_at = meta.created().map_or(mtime, |c| c.max(mtime));
    (replaced_at > started).then_some(exe)
}

/// 前端 30s 轮询：是否有待启用的更新 + MCP 是否忙碌。
#[tauri::command]
pub fn upgrade_state(
    hub: tauri::State<'_, std::sync::Arc<crate::mcp::hub::McpHub>>,
) -> serde_json::Value {
    serde_json::json!({
        "pending": pending_upgrade().is_some(),
        "mcpBusy": hub.ctx.busy.is_busy(),
    })
}

/// 执行换版：拉起原路径上的新版进程，随后退出本进程。
#[tauri::command]
pub async fn upgrade_apply(app: tauri::AppHandle) -> Result<(), crate::error::Error> {
    let exe = pending_upgrade().ok_or_else(|| {
        crate::error::Error::Io("没有待启用的更新（exe 路径上的文件未在启动后替换）".into())
    })?;
    // 顺序：先拉起新版再退出——本进程的 hub listener 在线到最后，新版本的
    // 绑定重试（hub::start）等端口释放；交接窗口内的 MCP 请求失败由 shim
    // 自愈（连接失败 → 重置就绪缓存 → 重新探测 → 重放）
    std::process::Command::new(&exe)
        .spawn()
        .map_err(|e| crate::error::Error::Io(format!("拉起新版失败: {e}")))?;
    // 小缓冲：让新版先到达绑定重试阶段再放手，缩短 shim 自愈窗口
    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
    app.exit(0);
    Ok(())
}
