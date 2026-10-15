//! stdio shim：`VisualSSH.exe mcp` 子命令。
//! harness 以 stdio 拉起本进程；进程内跑 rmcp stdio server，
//! list_tools / call_tool 全部转发到 GUI 主进程 hub 的内部 /rpc 端点。
//! GUI 未运行时自动拉起主程序（同 exe 无参数；端口占用天然去重）。
//!
//! Windows 注意：GUI 子系统的进程没有控制台，但被父进程以管道重定向方式
//! spawn 时标准句柄有效；诊断信息只写 stderr，写失败静默。

use std::io::Write;
use std::time::Duration;

use serde_json::{json, Value};

use crate::mcp::config;

/// 等待 hub 就绪的上限（拉起主程序后的轮询窗口）。
const WAIT_HUB_TIMEOUT: Duration = Duration::from_secs(30);

pub async fn run() -> i32 {
    let mut stderr = std::io::stderr();
    let _ = writeln!(stderr, "[visualssh-mcp] stdio 模式启动");

    let cfg = config::load_or_init();
    if !cfg.enabled {
        let _ = writeln!(stderr, "[visualssh-mcp] MCP 已在 VisualSSH 设置中禁用");
        return 2;
    }

    // stdio 服务先行：initialize 握手静态应答（毫秒级），
    // 避免客户端在 GUI 冷启动期间把连接误判为“进程启动失败”。
    // GUI 的探测/拉起惰性化到首次工具请求（HttpRpc::ensure_hub）。
    let server = ShimServer {
        port: cfg.port,
        token: cfg.token.clone(),
        client: HttpRpc::new(),
    };

    match rmcp::serve_server(server, rmcp::transport::io::stdio()).await {
        Ok(running) => {
            let _ = writeln!(stderr, "[visualssh-mcp] stdio 服务就绪（hub 端口 {}，GUI 按需拉起）", cfg.port);
            let quit = running.waiting().await;
            let _ = writeln!(stderr, "[visualssh-mcp] 会话结束: {quit:?}");
            0
        }
        Err(e) => {
            let _ = writeln!(stderr, "[visualssh-mcp] 启动失败: {e}");
            1
        }
    }
}

/// 端口可连即认为 hub 就绪（cold start 时配置文件可能刚生成）。
async fn wait_hub(port: u16, timeout: Duration) -> bool {
    let started = std::time::Instant::now();
    loop {
        if tokio::net::TcpStream::connect(("127.0.0.1", port)).await.is_ok() {
            return true;
        }
        if started.elapsed() >= timeout {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
}

/// /rpc 的极简 HTTP/1.1 客户端（仅 127.0.0.1，hyper legacy client）。
/// hub 的探测/拉起惰性化：首次请求时进行（OnceCell 保证并发只做一次）。
#[derive(Clone)]
struct HttpRpc {
    /// 就绪状态可重置（GUI 关闭后失效）：包一层 async Mutex 拿 &mut
    /// （Arc 直接共享无 &mut；std Mutex 不能跨 get_or_try_init 的 await 持有）
    hub_ready: std::sync::Arc<tokio::sync::Mutex<tokio::sync::OnceCell<()>>>,
}

/// 单次 HTTP 请求的失败：connect 标记传输层连不上（hub 进程不在了），
/// 与「连上了但请求/响应出错」区分——前者值得重置就绪缓存重新拉起。
struct HttpFail {
    message: String,
    connect: bool,
}

impl HttpRpc {
    fn new() -> Self {
        Self {
            hub_ready: std::sync::Arc::new(tokio::sync::Mutex::new(
                tokio::sync::OnceCell::new(),
            )),
        }
    }

    /// 确保 GUI 主进程 hub 在线；不通则拉起主程序并等待就绪。
    async fn ensure_hub(&self, port: u16) -> Result<(), String> {
        let cell = self.hub_ready.lock().await;
        cell.get_or_try_init(|| async move {
                if wait_hub(port, Duration::ZERO).await {
                    return Ok(());
                }
                eprintln!("[visualssh-mcp] GUI 未运行，自动拉起主程序");
                if let Ok(exe) = std::env::current_exe() {
                    // current_exe 是启动时记录的路径：pack-exe 换版腾位后该路径上
                    // 已是新版——拉起自然落在最新版本；--background 静默拉起
                    //（不弹窗，托盘常驻，用户点开后才见窗口）
                    let _ = std::process::Command::new(exe).arg("--background").spawn();
                }
                if wait_hub(port, WAIT_HUB_TIMEOUT).await {
                    Ok(())
                } else {
                    Err(format!(
                        "等待 VisualSSH 主程序就绪超时（{}s，端口 {port}）",
                        WAIT_HUB_TIMEOUT.as_secs()
                    ))
                }
            })
            .await
            .map(|_| ())
    }

    async fn request(&self, port: u16, token: &str, path: &str, body: Value) -> Result<Value, String> {
        self.ensure_hub(port).await?;
        match self.post(port, token, path, &body).await {
            Ok(v) => Ok(v),
            // OnceCell 缓存的就绪状态已失效（GUI 被关闭）：重置后重新
            // 探测/拉起一次，成功则重放请求——shim 不会因 GUI 重启而报废
            Err(e) if e.connect => {
                self.hub_ready.lock().await.take();
                self.ensure_hub(port).await?;
                self.post(port, token, path, &body).await.map_err(|e| e.message)
            }
            Err(e) => Err(e.message),
        }
    }

    async fn post(
        &self,
        port: u16,
        token: &str,
        path: &str,
        body: &Value,
    ) -> Result<Value, HttpFail> {
        use http_body_util::{BodyExt, Full};
        use hyper::body::Bytes;
        use hyper_util::client::legacy::Client;
        use hyper_util::rt::TokioExecutor;

        let client: Client<_, Full<Bytes>> = Client::builder(TokioExecutor::new()).build_http();
        let uri: hyper::Uri = format!("http://127.0.0.1:{port}{path}")
            .parse()
            .map_err(|e| HttpFail {
                message: format!("构造请求失败: {e}"),
                connect: false,
            })?;
        let payload = Full::new(
            Bytes::from(serde_json::to_vec(body).map_err(|e| HttpFail {
                message: e.to_string(),
                connect: false,
            })?),
        );
        let req = hyper::Request::builder()
            .method(hyper::Method::POST)
            .uri(uri)
            .header("content-type", "application/json")
            .header("x-visualssh-token", token)
            .body(payload)
            .map_err(|e| HttpFail {
                message: format!("构造请求失败: {e}"),
                connect: false,
            })?;
        let res = client.request(req).await.map_err(|e| HttpFail {
            connect: e.is_connect(),
            message: format!("请求 hub 失败: {e}"),
        })?;
        let status = res.status();
        let bytes = res
            .into_body()
            .collect()
            .await
            .map_err(|e| HttpFail {
                message: format!("读取响应失败: {e}"),
                connect: false,
            })?
            .to_bytes();
        if !status.is_success() {
            return Err(HttpFail {
                message: format!("hub 返回 {}: {}", status, String::from_utf8_lossy(&bytes)),
                connect: false,
            });
        }
        serde_json::from_slice(&bytes).map_err(|e| HttpFail {
            message: format!("响应解析失败: {e}"),
            connect: false,
        })
    }
}

#[derive(Clone)]
struct ShimServer {
    port: u16,
    token: String,
    client: HttpRpc,
}

impl rmcp::ServerHandler for ShimServer {
    fn get_info(&self) -> rmcp::model::ServerConfig {
        rmcp::model::InitializeResult::new(
            rmcp::model::ServerCapabilities::builder()
                .enable_tools()
                .build(),
        )
        .with_instructions("VisualSSH 远程服务器网关（stdio 模式）")
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
        // 清单转发 hub（单一事实源；未来工具开关等只影响 GUI 侧一份逻辑）
        let v = self
            .client
            .request(self.port, &self.token, "/rpc/tools", json!({}))
            .await
            .map_err(|e| rmcp::ErrorData::internal_error(e, None))?;
        let tools: Vec<rmcp::model::Tool> = v["tools"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|t| {
                        Some(rmcp::model::Tool::new(
                            t["name"].as_str()?.to_owned(),
                            t["description"].as_str().unwrap_or("").to_owned(),
                            match t["schema"].clone() {
                                Value::Object(map) => map,
                                _ => serde_json::Map::new(),
                            },
                        ))
                    })
                    .collect()
            })
            .unwrap_or_default();
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
        let args =
            serde_json::to_value(params.arguments.unwrap_or_default()).unwrap_or_else(|_| json!({}));
        let v = self
            .client
            .request(self.port, &self.token, "/rpc", json!({ "tool": name, "arguments": args }))
            .await
            .map_err(|e| rmcp::ErrorData::internal_error(e, None))?;
        let is_error = v["ok"] != json!(true);
        let text = if is_error {
            v["error"].as_str().unwrap_or("未知错误").to_string()
        } else {
            v["result"].to_string()
        };
        if is_error {
            Ok(rmcp::model::CallToolResponse::Complete(
                rmcp::model::CallToolResult::error(vec![rmcp::model::ContentBlock::text(text)]),
            ))
        } else {
            let structured = v["result"].clone();
            let mut result = rmcp::model::CallToolResult::success(vec![
                rmcp::model::ContentBlock::text(text),
            ]);
            result.structured_content = Some(structured);
            Ok(rmcp::model::CallToolResponse::Complete(result))
        }
    }
}
