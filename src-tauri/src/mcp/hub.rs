//! MCP HTTP hub：GUI 进程内的 streamable HTTP 服务器。
//! 路由：
//!   POST /mcp —— 标准 MCP 端点（rmcp StreamableHttpService，harness 直连）
//!   POST /rpc —— 内部工具转发端点（stdio shim 专用，同一份 dispatch）
//! 两者都经 token 中间件 + 首次接入批准门。

use std::sync::{Arc, Mutex};

use axum::extract::{Request, State};
use axum::http::{header, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::Router;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::mcp::tools::{dispatch, tool_specs, McpCtx, Via};

/// stdio shim 的 /rpc 请求体。
#[derive(Deserialize)]
struct RpcBody {
    tool: String,
    #[serde(default)]
    arguments: Value,
}

/// hub 的进程级句柄：listener 任务 + 共享上下文（tauri manage 注入）。
pub struct McpHub {
    pub ctx: McpCtx,
    /// 首次批准的串行门（并发首连只弹一次窗）
    approve_gate: tokio::sync::Mutex<()>,
    listener_task: Mutex<Option<tokio::task::JoinHandle<()>>>,
    /// 最近一次 start 失败的原因（设置页展示）
    pub last_error: Mutex<Option<String>>,
}

impl McpHub {
    pub fn new(ctx: McpCtx) -> Self {
        Self {
            ctx,
            approve_gate: tokio::sync::Mutex::new(()),
            listener_task: Mutex::new(None),
            last_error: Mutex::new(None),
        }
    }

    /// 是否在监听（设置页状态显示）。
    pub fn is_running(&self) -> bool {
        self.listener_task
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|t| !t.is_finished())
    }

    /// 绑定 127.0.0.1:port 并启动服务；端口被占时返回错误。
    /// （重复拉起主程序的去重正是靠这里的端口占用失败。）
    pub async fn start(self: &Arc<Self>) -> Result<(), String> {
        let cfg = self.ctx.config.read().unwrap().clone();
        let addr = std::net::SocketAddr::from(([127, 0, 0, 1], cfg.port));

        // rmcp handler：与 /rpc 共用 dispatch，行为/审计/拦截完全一致
        let server_ctx = self.ctx.clone();
        let mcp_service = rmcp::transport::streamable_http_server::StreamableHttpService::new(
            move || Ok::<_, std::io::Error>(McpServer { ctx: server_ctx.clone() }),
            std::sync::Arc::new(
                rmcp::transport::streamable_http_server::session::local::LocalSessionManager::default(),
            ),
            Default::default(),
        );

        let app = Router::new()
            .nest_service("/mcp", mcp_service)
            .route("/rpc", post(rpc_call))
            .route("/rpc/tools", axum::routing::get(rpc_tools).post(rpc_tools))
            .layer(middleware::from_fn_with_state(self.clone(), auth_gate))
            .with_state(self.clone());

        let listener = match tokio::net::TcpListener::bind(addr).await {
            Ok(l) => l,
            Err(e) => {
                let msg = format!("MCP 端口 {} 绑定失败: {e}", cfg.port);
                *self.last_error.lock().unwrap() = Some(msg.clone());
                return Err(msg);
            }
        };
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        *self.listener_task.lock().unwrap() = Some(task);
        *self.last_error.lock().unwrap() = None;
        Ok(())
    }

    /// 停止 listener（设置变更端口/关闭时调用；进行中的请求随任务终止）。
    pub fn stop(&self) {
        if let Some(task) = self.listener_task.lock().unwrap().take() {
            task.abort();
        }
    }
}

/// rmcp 服务器实现：仅 tools，list/call 全部落到共享 dispatch。
#[derive(Clone)]
struct McpServer {
    ctx: McpCtx,
}

impl rmcp::ServerHandler for McpServer {
    fn get_info(&self) -> rmcp::model::ServerConfig {
        rmcp::model::InitializeResult::new(
            rmcp::model::ServerCapabilities::builder()
                .enable_tools()
                .build(),
        )
        .with_instructions(
            "VisualSSH 远程服务器网关：先 list_connections 查看连接与 profile；\
             未连接的 profile 用 connect 建立；文件/命令/传输操作通过可选的 \
             connection 参数指定目标（唯一连接时可省略）。",
        )
        .with_server_info(rmcp::model::Implementation::new(
            "visualssh",
            env!("CARGO_PKG_VERSION"),
        ))
    }

    async fn list_tools(
        &self,
        _pagination: Option<rmcp::model::PaginatedRequestParams>,
        _context: rmcp::service::RequestContext<rmcp::service::RoleServer>,
    ) -> Result<rmcp::model::ListToolsResult, rmcp::ErrorData> {
        let tools = tool_specs()
            .into_iter()
            .map(|t| {
                rmcp::model::Tool::new(t.name, t.description, schema_to_json_object(t.schema))
            })
            .collect();
        Ok(rmcp::model::ListToolsResult {
            tools,
            ..Default::default()
        })
    }

    async fn call_tool(
        &self,
        params: rmcp::model::CallToolRequestParams,
        _context: rmcp::service::RequestContext<rmcp::service::RoleServer>,
    ) -> Result<rmcp::model::CallToolResponse, rmcp::ErrorData> {
        let name = params.name.as_ref().to_string();
        let args = serde_json::to_value(params.arguments.unwrap_or_default())
            .unwrap_or_else(|_| json!({}));
        Ok(call_shared(&self.ctx, Via::Http, &name, args).await?.into())
    }
}

/// /rpc 端点：stdio shim 的工具转发（via = stdio）。
async fn rpc_call(State(hub): State<Arc<McpHub>>, body: axum::Json<RpcBody>) -> Response {
    let result = dispatch(&hub.ctx, Via::Stdio, &body.tool, body.arguments.clone()).await;
    let payload = match result {
        Ok(v) => json!({ "ok": true, "result": v }),
        Err(e) => json!({ "ok": false, "error": e }),
    };
    axum::Json(payload).into_response()
}

/// /rpc/tools：stdio shim 的工具清单来源（与 rmcp list_tools 同源）。
async fn rpc_tools() -> Response {
    let tools: Vec<Value> = tool_specs()
        .into_iter()
        .map(|t| {
            json!({
                "name": t.name,
                "description": t.description,
                "schema": t.schema,
            })
        })
        .collect();
    axum::Json(json!({ "tools": tools })).into_response()
}

/// dispatch 的统一结果包装（rmcp 与 /rpc 同款语义：错误作为 is_error 结果返回，
/// 而非协议层错误——Agent 能读到错误文本）。
async fn call_shared(
    ctx: &McpCtx,
    via: Via,
    name: &str,
    args: Value,
) -> Result<rmcp::model::CallToolResult, rmcp::ErrorData> {
    match dispatch(ctx, via, name, args).await {
        Ok(v) => {
            let text = v.to_string();
            let mut result = rmcp::model::CallToolResult::success(vec![rmcp::model::ContentBlock::text(text)]);
            result.structured_content = Some(v);
            Ok(result)
        }
        Err(e) => Ok(rmcp::model::CallToolResult::error(vec![
            rmcp::model::ContentBlock::text(e),
        ])),
    }
}

fn schema_to_json_object(schema: Value) -> rmcp::model::JsonObject {
    match schema {
        Value::Object(map) => map,
        _ => serde_json::Map::new(),
    }
}

/// token 校验 + 首次接入批准门。
async fn auth_gate(State(hub): State<Arc<McpHub>>, req: Request, next: Next) -> Response {
    let token = hub.ctx.config.read().unwrap().token.clone();

    // Bearer 或自定义头任一；stdio shim 与 harness 直连共用同一 token
    let provided = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::to_string)
        .or_else(|| {
            req.headers()
                .get("x-visualssh-token")
                .and_then(|v| v.to_str().ok())
                .map(str::to_string)
        });

    let Some(provided) = provided else {
        return unauthorized("缺少 token（Authorization: Bearer <token> 或 x-visualssh-token）");
    };
    if !constant_time_eq(provided.as_bytes(), token.as_bytes()) {
        return unauthorized("token 不正确");
    }

    // 首次接入批准：批准一次落盘，之后放行（设置页可重置再批）
    let already = hub.ctx.config.read().unwrap().approved;
    if !already {
        let _guard = hub.approve_gate.lock().await;
        // 拿到门闩后再查一次（等待期间可能已被前一个请求批准）
        if !hub.ctx.config.read().unwrap().approved {
            match hub
                .ctx
                .confirms
                .wait_approval(
                    &hub.ctx.app,
                    "一个 MCP 客户端请求接入 VisualSSH（批准后不再询问，可在设置中重置）".into(),
                    None,
                )
                .await
            {
                crate::mcp::audit::ApprovalOutcome::Approved => {
                    let mut cfg = hub.ctx.config.write().unwrap();
                    cfg.approved = true;
                    let _ = crate::mcp::config::save(&cfg);
                    hub.ctx.audit.record("http", "@approve", "ok", "首次接入已批准".into());
                }
                crate::mcp::audit::ApprovalOutcome::Denied => {
                    hub.ctx
                        .audit
                        .record("http", "@approve", "denied", "首次接入被拒绝".into());
                    return unauthorized("接入被用户拒绝");
                }
                crate::mcp::audit::ApprovalOutcome::Timeout => {
                    hub.ctx.audit.record(
                        "http",
                        "@approve",
                        "timeout",
                        "首次接入批准等待超时".into(),
                    );
                    return unauthorized(format!(
                        "接入确认超时（{} 秒未响应，未被拒绝，可重新连接再试）",
                        crate::mcp::audit::CONFIRM_TIMEOUT_SECS
                    ));
                }
            }
        }
    }

    next.run(req).await
}

fn unauthorized(message: impl Into<String>) -> Response {
    (
        StatusCode::UNAUTHORIZED,
        [(header::WWW_AUTHENTICATE, "Bearer")],
        message.into(),
    )
        .into_response()
}

/// 常量时间字符串比较（token 校验防时序侧信道，本地场景属纵深防御）。
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_compare_is_strict() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"abcd"));
    }
}
