//! MCP 设置/审计/确认的 tauri 命令层（设置页与全局确认弹窗消费）。

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::Result;
use crate::mcp::audit::{AuditEntry, ConfirmQueue};
use crate::mcp::config::{self, McpConfig};
use crate::mcp::hub::McpHub;
use crate::mcp::profiles::{ProfileCache, ProfileMeta};
use crate::mcp::tools::McpCtx;

/// hub 运行状态（设置页显示）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpStatus {
    pub running: bool,
    pub enabled: bool,
    pub port: u16,
    pub error: Option<String>,
}

#[tauri::command]
pub async fn mcp_status(hub: State<'_, Arc<McpHub>>) -> Result<McpStatus> {
    let cfg = hub.ctx.config.read().unwrap().clone();
    Ok(McpStatus {
        running: hub.is_running(),
        enabled: cfg.enabled,
        port: cfg.port,
        error: hub.last_error.lock().unwrap().clone(),
    })
}

#[tauri::command]
pub async fn mcp_get_config(hub: State<'_, Arc<McpHub>>) -> Result<McpConfig> {
    Ok(hub.ctx.config.read().unwrap().clone())
}

/// 设置页可改的字段（token/approved 专用命令管理，不在此处）。
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct McpConfigPatch {
    pub enabled: Option<bool>,
    pub port: Option<u16>,
    pub confirm_delete: Option<bool>,
    pub confirm_exec: Option<bool>,
    pub confirm_overwrite: Option<bool>,
}

/// 更新配置并按需热重启 hub（enabled/port 变化；confirm 开关热读无需重启）。
#[tauri::command]
pub async fn mcp_set_config(
    patch: McpConfigPatch,
    hub: State<'_, Arc<McpHub>>,
) -> Result<McpStatus> {
    let need_restart = {
        let mut cfg = hub.ctx.config.write().unwrap();
        let before = cfg.clone();
        if let Some(v) = patch.enabled {
            cfg.enabled = v;
        }
        if let Some(p) = patch.port {
            cfg.port = config::sanitize_port(p);
        }
        if let Some(v) = patch.confirm_delete {
            cfg.confirm_delete = v;
        }
        if let Some(v) = patch.confirm_exec {
            cfg.confirm_exec = v;
        }
        if let Some(v) = patch.confirm_overwrite {
            cfg.confirm_overwrite = v;
        }
        config::save(&cfg).map_err(|e| crate::error::Error::Io(e.to_string()))?;
        before.enabled != cfg.enabled || before.port != cfg.port
    };

    if need_restart {
        hub.stop();
        if hub.ctx.config.read().unwrap().enabled {
            hub.start()
                .await
                .map_err(|e| crate::error::Error::Io(e.to_string()))?;
        }
    }
    let cfg = hub.ctx.config.read().unwrap().clone();
    Ok(McpStatus {
        running: hub.is_running(),
        enabled: cfg.enabled,
        port: cfg.port,
        error: hub.last_error.lock().unwrap().clone(),
    })
}

/// 重置 token：旧客户端全部失效（harness 直连配置里的 token 需更新）。
#[tauri::command]
pub async fn mcp_reset_token(hub: State<'_, Arc<McpHub>>) -> Result<McpConfig> {
    {
        let mut cfg = hub.ctx.config.write().unwrap();
        cfg.token = config::new_token();
        config::save(&cfg).map_err(|e| crate::error::Error::Io(e.to_string()))?;
    }
    Ok(hub.ctx.config.read().unwrap().clone())
}

/// 撤销首次接入批准：下一个客户端接入将再次弹窗。
#[tauri::command]
pub async fn mcp_reset_approval(hub: State<'_, Arc<McpHub>>) -> Result<()> {
    let mut cfg = hub.ctx.config.write().unwrap();
    cfg.approved = false;
    config::save(&cfg).map_err(|e| crate::error::Error::Io(e.to_string()))
}

/// 审计日志增量查询（内存 ring 窗口；全量走导出）。
#[tauri::command]
pub async fn mcp_audit_list(
    since_id: u64,
    limit: Option<usize>,
    hub: State<'_, Arc<McpHub>>,
) -> Result<Vec<AuditEntry>> {
    Ok(hub.ctx.audit.list_since(since_id, limit.unwrap_or(200)))
}

/// 审计体量与状态（设置页展示）。
#[tauri::command]
pub async fn mcp_audit_stats(hub: State<'_, Arc<McpHub>>) -> Result<crate::mcp::audit::AuditStats> {
    Ok(hub.ctx.audit.stats())
}

/// 导出全量审计为解压 JSONL；返回条数。
#[tauri::command]
pub async fn mcp_audit_export(
    dest: String,
    hub: State<'_, Arc<McpHub>>,
) -> Result<u64> {
    hub.ctx
        .audit
        .export_to(std::path::Path::new(&dest))
        .map_err(|e| crate::error::Error::Io(e.to_string()))
}

/// 清空全部审计（id 续号保留）。
#[tauri::command]
pub async fn mcp_audit_clear(hub: State<'_, Arc<McpHub>>) -> Result<()> {
    hub.ctx.audit.clear();
    Ok(())
}

/// 前端确认弹窗回传决定。
#[tauri::command]
pub async fn mcp_confirm_resolve(
    id: u64,
    approved: bool,
    confirms: State<'_, Arc<ConfirmQueue>>,
) -> Result<bool> {
    Ok(confirms.resolve(id, approved))
}

/// 当前挂起中的确认（前端重挂/刷新后恢复弹窗）。
#[tauri::command]
pub async fn mcp_pending_confirms(
    confirms: State<'_, Arc<ConfirmQueue>>,
) -> Result<Vec<serde_json::Value>> {
    Ok(confirms
        .snapshot()
        .into_iter()
        .map(|(id, summary, raw)| serde_json::json!({ "id": id, "summary": summary, "raw": raw }))
        .collect())
}

/// 前端推送 profile 元数据快照（不含凭据；connect 工具按 id 直读 keyring）。
#[tauri::command]
pub async fn mcp_sync_profiles(
    profiles: Vec<ProfileMeta>,
    cache: State<'_, Arc<ProfileCache>>,
) -> Result<()> {
    cache.replace(profiles);
    Ok(())
}

/// 单个工具的接入指南：步骤说明 + 可复制内容。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpGuide {
    pub key: String,
    pub name: String,
    /// 分行渲染的步骤说明
    pub steps: Vec<String>,
    /// 可复制内容（命令或 JSON；空 = 无代码块）
    pub code: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpSnippets {
    pub guides: Vec<McpGuide>,
    pub exe_path: String,
    pub http_url: String,
    pub http_token: String,
}

/// 各 AI 编程工具的接入指南。新工具持续补充即可：
/// 本质只有两条信息——本地命令 `<exe> mcp` 与服务地址 /mcp。
#[tauri::command]
pub async fn mcp_snippets(hub: State<'_, Arc<McpHub>>) -> Result<McpSnippets> {
    let cfg = hub.ctx.config.read().unwrap().clone();
    let exe = std::env::current_exe()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| "VisualSSH.exe".into());
    let exe_json = serde_json::to_string(&exe).unwrap_or_else(|_| format!("\"{exe}\""));
    let url = format!("http://127.0.0.1:{}/mcp", cfg.port);

    let json_servers = format!(
        "{{\"mcpServers\":{{\"visualssh\":{{\"command\":{exe_json},\"args\":[\"mcp\"]}}}}}}"
    );
    let zcode_json = format!(
        "{{
  \"mcp\": {{
    \"servers\": {{
      \"visualssh\": {{
        \"type\": \"stdio\",
        \"command\": {exe_json},
        \"args\": [\"mcp\"]
      }}
    }}
  }}
}}"
    );

    let guides = vec![
        McpGuide {
            key: "zcode".into(),
            name: "ZCode".into(),
            steps: vec![
                "打开 设置 → MCP，新建服务器，按下面填写（表单模式）：".into(),
                "名称：visualssh".into(),
                "类型：stdio（本地命令）".into(),
                format!("命令：{exe}（粘贴完整路径）"),
                "参数：mcp（只填这一个词，不要填路径）".into(),
                "保存后重启会话即可；也可用 JSON 模式粘贴，或编辑 ~/.zcode/cli/config.json。".into(),
            ],
            code: format!("// ~/.zcode/cli/config.json → mcp.servers
{zcode_json}"),
        },
        McpGuide {
            key: "opencode".into(),
            name: "OpenCode".into(),
            steps: vec!["编辑 opencode.json（项目根目录或全局配置），加入：".into()],
            code: format!(
                "{{\"mcp\":{{\"visualssh\":{{\"type\":\"local\",\"command\":[{exe_json},\"mcp\"],\"enabled\":true}}}}}}"
            ),
        },
        McpGuide {
            key: "dsh".into(),
            name: "DeepSeek Harness".into(),
            steps: vec!["在 cordis.patch.yml（或当前 profile 的补丁层）追加：".into()],
            code: format!(
                "- name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: visualssh
    transport: stdio
    command: '{exe}'
    args: ['mcp']"
            ),
        },
        McpGuide {
            key: "claude-code".into(),
            name: "Claude Code".into(),
            steps: vec!["在终端执行（保存到 ~/.claude.json 的 mcpServers）：".into()],
            code: format!("claude mcp add visualssh -- \"{exe}\" mcp"),
        },
        McpGuide {
            key: "cursor".into(),
            name: "Cursor".into(),
            steps: vec!["编辑 ~/.cursor/mcp.json（全局）或项目内 .cursor/mcp.json，加入：".into()],
            code: json_servers.clone(),
        },
        McpGuide {
            key: "codex".into(),
            name: "Codex CLI".into(),
            steps: vec!["在 ~/.codex/config.toml 追加：".into()],
            code: format!("[mcp_servers.visualssh]
command = \"{exe}\"
args = [\"mcp\"]"),
        },
        McpGuide {
            key: "gemini".into(),
            name: "Gemini CLI".into(),
            steps: vec!["编辑 ~/.gemini/settings.json，加入：".into()],
            code: json_servers.clone(),
        },
        McpGuide {
            key: "generic".into(),
            name: "其他工具（通用）".into(),
            steps: vec![
                "任何支持 MCP 的工具都能接入，两种方式任选其一：".into(),
                format!("· 本地命令：命令填 {exe}，参数填 mcp"),
                format!("· 服务器地址：{url}，验证方式选 Bearer 令牌（内容见上方「访问令牌」）"),
                "Claude Desktop、Windsurf、Cline 等使用标准 mcpServers 格式的工具，可直接复制：".into(),
            ],
            code: json_servers,
        },
    ];

    Ok(McpSnippets {
        guides,
        exe_path: exe,
        http_url: url,
        http_token: cfg.token,
    })
}

/// 审计文件位置（与 mcp.json 同目录）。
pub fn audit_path() -> Option<std::path::PathBuf> {
    dirs::config_dir().map(|d| d.join("visualssh").join("mcp-audit.log"))
}

/// 供 lib.rs setup 构造共享上下文（审计打开磁盘存储，跨会话可追溯）。
pub fn build_ctx(app: tauri::AppHandle) -> (McpCtx, Arc<McpHub>) {
    let cfg = config::load_or_init();
    let audit = audit_path()
        .map(|p| crate::mcp::audit::AuditLog::open(&p))
        .unwrap_or_default();
    let ctx = McpCtx {
        app,
        profiles: Arc::new(ProfileCache::default()),
        audit: Arc::new(audit),
        confirms: Arc::new(ConfirmQueue::default()),
        config: Arc::new(std::sync::RwLock::new(cfg)),
    };
    let hub = Arc::new(McpHub::new(ctx.clone()));
    (ctx, hub)
}
