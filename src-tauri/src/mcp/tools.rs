//! MCP 工具层：清单（名称/描述/JSON Schema）+ 数据驱动 dispatch。
//! hub 的 rmcp handler 与 stdio shim 的内部 /rpc 端点共用这一份实现，
//! 保证两条传输的行为、审计、拦截完全一致。

use std::sync::{Arc, RwLock};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{Emitter, Manager};

use crate::mcp::audit::AuditLog;
use crate::mcp::config::McpConfig;
use crate::mcp::profiles::ProfileCache;
use crate::state::{AppState, SessionHandle};
use crate::transfer::{run_download, run_upload, TransferHandle, TransferManager};
use crate::walk::run_walk;

/// 与 commands::ssh 同款预算。
const IO_TIMEOUT: Duration = Duration::from_secs(30);
/// read_file 文本模式上限（与编辑器一致的量级）。
const READ_TEXT_LIMIT: u64 = 2 * 1024 * 1024;
/// read_file base64 模式上限（与 InfoPane 预览一致）。
const READ_BINARY_LIMIT: u64 = 10 * 1024 * 1024;
/// exec 输出保留上限：头尾各半，中间折叠提示。
const EXEC_OUTPUT_LIMIT: usize = 64 * 1024;
/// exec 超时上下限。
const EXEC_TIMEOUT_MIN: u64 = 5;
const EXEC_TIMEOUT_MAX: u64 = 600;
/// tree / search 结果条数上限。
const ENTRY_LIMIT: usize = 2000;

/// 调用来源（审计用）：http 直连 / stdio shim。
#[derive(Clone, Copy, PartialEq)]
pub enum Via {
    Http,
    Stdio,
}

impl Via {
    pub fn as_str(self) -> &'static str {
        match self {
            Via::Http => "http",
            Via::Stdio => "stdio",
        }
    }
}

/// 工具执行上下文：GUI 进程内共享的全部状态入口。
/// 会话池/传输管理器经 app.state() 按需短借用（与 tauri 命令同一路径）。
#[derive(Clone)]
pub struct McpCtx {
    pub app: tauri::AppHandle,
    pub profiles: Arc<ProfileCache>,
    pub audit: Arc<AuditLog>,
    pub confirms: Arc<crate::mcp::audit::ConfirmQueue>,
    pub config: Arc<RwLock<McpConfig>>,
    /// 自动换版的等待条件（Arc：McpCtx 派生 Clone，原子/锁不可 Clone）
    pub busy: Arc<McpBusy>,
}

/// MCP 活动度量：在途工具调用数 + 最近一次调用时刻。
pub struct McpBusy {
    in_flight: std::sync::atomic::AtomicI64,
    last_activity: std::sync::Mutex<Option<std::time::Instant>>,
}

impl Default for McpBusy {
    fn default() -> Self {
        Self {
            in_flight: std::sync::atomic::AtomicI64::new(0),
            last_activity: std::sync::Mutex::new(None),
        }
    }
}

impl McpBusy {
    /// MCP 是否忙碌（自动换版据此推迟重启）：在途调用 > 0，
    /// 或最近 30s 内有过调用（Agent 的会话还热着，别杀）
    pub fn is_busy(&self) -> bool {
        if self.in_flight.load(std::sync::atomic::Ordering::Relaxed) > 0 {
            return true;
        }
        self.last_activity
            .lock()
            .unwrap()
            .is_some_and(|t| t.elapsed() < Duration::from_secs(30))
    }
}

/// dispatch 的忙碌计数 RAII：入口 +1 / 出口 -1，两端都刷新活动时刻。
struct BusyGuard<'a>(&'a McpBusy);

impl<'a> BusyGuard<'a> {
    fn enter(busy: &'a McpBusy) -> Self {
        busy.in_flight.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        *busy.last_activity.lock().unwrap() = Some(std::time::Instant::now());
        Self(busy)
    }
}

impl Drop for BusyGuard<'_> {
    fn drop(&mut self) {
        self.0
            .in_flight
            .fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
        *self.0.last_activity.lock().unwrap() = Some(std::time::Instant::now());
    }
}

pub struct ToolSpec {
    pub name: &'static str,
    pub description: &'static str,
    pub schema: Value,
}

fn str_param(desc: &str) -> Value {
    json!({ "type": "string", "description": desc })
}

const CONNECTION_DESC: &str =
    "目标连接：connectionId 或 profile 名。省略时若只有一个活跃连接则自动使用；多个活跃连接时必须指定";

/// 工具清单。rmcp handler / 内部 /rpc / 设置页都从这里生成，是唯一的清单事实源。
pub fn tool_specs() -> Vec<ToolSpec> {
    vec![
        ToolSpec {
            name: "list_connections",
            description: "列出当前活跃的 SSH 连接与全部已保存的 profile（含连接状态），供选择 connection 参数",
            schema: json!({ "type": "object", "properties": {}, "additionalProperties": false }),
        },
        ToolSpec {
            name: "connect",
            description: "按已保存的 profile 名建立新的 SSH 连接（凭据由 VisualSSH 安全存储提供）。主机指纹变更会以错误返回，需用户先在 VisualSSH 界面连接一次完成信任",
            schema: json!({
                "type": "object",
                "properties": { "profile": str_param("已保存的 profile 名（见 list_connections）") },
                "required": ["profile"],
                "additionalProperties": false
            }),
        },
        ToolSpec {
            name: "list_dir",
            description: "列出远端目录内容（文件夹优先、名称序），返回名称/类型/大小/权限/属主/修改时间",
            schema: json!({
                "type": "object",
                "properties": {
                    "path": str_param("远端目录绝对路径"),
                    "connection": str_param(CONNECTION_DESC),
                },
                "required": ["path"],
                "additionalProperties": false
            }),
        },
        ToolSpec {
            name: "stat",
            description: "读取远端文件/目录的详细属性（类型/大小/权限/属主/修改时间）",
            schema: json!({
                "type": "object",
                "properties": {
                    "path": str_param("远端路径"),
                    "connection": str_param(CONNECTION_DESC),
                },
                "required": ["path"],
                "additionalProperties": false
            }),
        },
        ToolSpec {
            name: "read_file",
            description: "读取远端文件。文本模式返回 UTF-8 内容（上限 2MB）；base64 模式返回编码字节（上限 10MB）。大文件或只看尾部请用 exec（tail/head）",
            schema: json!({
                "type": "object",
                "properties": {
                    "path": str_param("远端文件路径"),
                    "encoding": json!({ "type": "string", "enum": ["text", "base64"], "description": "默认 text" }),
                    "connection": str_param(CONNECTION_DESC),
                },
                "required": ["path"],
                "additionalProperties": false
            }),
        },
        ToolSpec {
            name: "write_file",
            description: "写入/覆盖远端文件（原子替换：临时文件 + rename）。非 UTF-8 内容用 base64 模式",
            schema: json!({
                "type": "object",
                "properties": {
                    "path": str_param("远端目标文件路径"),
                    "content": str_param("文件内容（encoding=text 时为 UTF-8 文本，base64 时为编码）"),
                    "encoding": json!({ "type": "string", "enum": ["text", "base64"], "description": "content 的编码方式，默认 text" }),
                    "connection": str_param(CONNECTION_DESC),
                },
                "required": ["path", "content"],
                "additionalProperties": false
            }),
        },
        ToolSpec {
            name: "mkdir",
            description: "创建远端目录；parents=true（默认）时逐级创建，已存在的中间目录视为成功",
            schema: json!({
                "type": "object",
                "properties": {
                    "path": str_param("远端目录路径"),
                    "parents": json!({ "type": "boolean", "description": "是否递归创建父目录，默认 true" }),
                    "connection": str_param(CONNECTION_DESC),
                },
                "required": ["path"],
                "additionalProperties": false
            }),
        },
        ToolSpec {
            name: "touch",
            description: "创建空文件或更新时间戳",
            schema: json!({
                "type": "object",
                "properties": {
                    "path": str_param("远端文件路径"),
                    "connection": str_param(CONNECTION_DESC),
                },
                "required": ["path"],
                "additionalProperties": false
            }),
        },
        ToolSpec {
            name: "rename",
            description: "重命名或移动远端文件/目录",
            schema: json!({
                "type": "object",
                "properties": {
                    "oldPath": str_param("原路径"),
                    "newPath": str_param("新路径（目标已存在多数服务器会拒绝）"),
                    "connection": str_param(CONNECTION_DESC),
                },
                "required": ["oldPath", "newPath"],
                "additionalProperties": false
            }),
        },
        ToolSpec {
            name: "delete",
            description: "删除远端文件；目录需 recursive=true（整棵删除，不可恢复）",
            schema: json!({
                "type": "object",
                "properties": {
                    "path": str_param("远端路径"),
                    "recursive": json!({ "type": "boolean", "description": "目录递归删除，默认 false" }),
                    "connection": str_param(CONNECTION_DESC),
                },
                "required": ["path"],
                "additionalProperties": false
            }),
        },
        ToolSpec {
            name: "chmod",
            description: "修改远端文件/目录权限",
            schema: json!({
                "type": "object",
                "properties": {
                    "path": str_param("远端路径"),
                    "mode": str_param("八进制权限字符串，如 \"755\""),
                    "connection": str_param(CONNECTION_DESC),
                },
                "required": ["path", "mode"],
                "additionalProperties": false
            }),
        },
        ToolSpec {
            name: "read_link",
            description: "解析远端符号链接的目标路径",
            schema: json!({
                "type": "object",
                "properties": {
                    "path": str_param("远端符号链接路径"),
                    "connection": str_param(CONNECTION_DESC),
                },
                "required": ["path"],
                "additionalProperties": false
            }),
        },
        ToolSpec {
            name: "search_files",
            description: "按名称递归搜索远端文件（find -iname 优先，SFTP 枚举回退）。query 含点按扩展名匹配，否则子串匹配",
            schema: json!({
                "type": "object",
                "properties": {
                    "dir": str_param("搜索起始目录"),
                    "query": str_param("文件名关键字或扩展名（如 \".conf\"）"),
                    "maxDepth": json!({ "type": "integer", "description": "递归深度上限（1–16），默认 6" }),
                    "connection": str_param(CONNECTION_DESC),
                },
                "required": ["dir", "query"],
                "additionalProperties": false
            }),
        },
        ToolSpec {
            name: "tree",
            description: "递归枚举远端目录树（不跟随符号链接），返回目录与文件清单（相对路径 + 大小）。了解结构用它，找文件用 search_files",
            schema: json!({
                "type": "object",
                "properties": {
                    "path": str_param("远端目录路径"),
                    "connection": str_param(CONNECTION_DESC),
                },
                "required": ["path"],
                "additionalProperties": false
            }),
        },
        ToolSpec {
            name: "disk_usage",
            description: "读取远端路径所在文件系统的容量（总量/可用）；服务器不支持 statvfs 时返回 null",
            schema: json!({
                "type": "object",
                "properties": {
                    "path": str_param("远端路径"),
                    "connection": str_param(CONNECTION_DESC),
                },
                "required": ["path"],
                "additionalProperties": false
            }),
        },
        ToolSpec {
            name: "exec",
            description: "在远端通过 sh -c 执行 shell 命令（支持管道/重定向），收集 stdout/stderr/退出码。输出超 64KB 时头尾各保留 32KB。默认超时 30 秒",
            schema: json!({
                "type": "object",
                "properties": {
                    "command": str_param("shell 命令字符串"),
                    "timeoutSec": json!({ "type": "integer", "description": "超时秒数（5–600），默认 30" }),
                    "connection": str_param(CONNECTION_DESC),
                },
                "required": ["command"],
                "additionalProperties": false
            }),
        },
        ToolSpec {
            name: "download",
            description: "下载远端文件/目录到本地（入队异步传输，立即返回 transferId，用 transfers 查进度；目录递归）",
            schema: json!({
                "type": "object",
                "properties": {
                    "path": str_param("远端文件或目录"),
                    "localPath": str_param("本地目标：文件为完整路径，目录为父目录（自动建同名子目录）"),
                    "connection": str_param(CONNECTION_DESC),
                },
                "required": ["path", "localPath"],
                "additionalProperties": false
            }),
        },
        ToolSpec {
            name: "upload",
            description: "上传本地文件/目录到远端（入队异步传输，立即返回 transferId，用 transfers 查进度；目录递归，直接覆盖同名目标）",
            schema: json!({
                "type": "object",
                "properties": {
                    "localPath": str_param("本地文件或目录"),
                    "path": str_param("远端目标：文件为完整路径，目录为父目录（自动建同名子目录）"),
                    "connection": str_param(CONNECTION_DESC),
                },
                "required": ["localPath", "path"],
                "additionalProperties": false
            }),
        },
        ToolSpec {
            name: "transfers",
            description: "查询传输队列快照（进度/速度/状态/错误），download/upload 的结果轮询入口",
            schema: json!({
                "type": "object",
                "properties": {
                    "connection": str_param("按连接过滤，省略列出全部"),
                },
                "additionalProperties": false
            }),
        },
    ]
}

/// 待确认操作的完整信息：人读中文描述 + 原始指令（弹窗可展开）。
pub struct ConfirmRequest {
    pub summary: String,
    pub raw: Option<String>,
}

/// chmod 的八进制参数渲染为可读权限串（如 755 → rwxr-xr-x）。
fn octal_to_rwx(mode: &str) -> Option<String> {
    let bits = u32::from_str_radix(mode, 8).ok()?;
    let full = crate::ssh::mode_string(Some(bits), "file");
    Some(full[1..].to_string())
}

/// 翻译一条不含 `;`/`&&` 的命令为动词短语（不带"将"前缀，供拼接）。
/// 含管道时按 `|` 拆级、各级短语用 " → " 连接（贴近管道语义）。
fn translate_segment(c: &str) -> String {
    let c = c.trim();
    if c.contains('|') {
        // 各级翻译不出（如只读工具）就显示该级原文，保持管道结构可见
        let parts: Vec<String> = c
            .split('|')
            .map(|p| translate_pure(p).unwrap_or_else(|| p.trim().to_string()))
            .collect();
        return parts.join(" → ");
    }
    translate_pure(c).unwrap_or_else(|| format!("执行命令 {c}"))
}

/// 翻译单条纯命令（无管道/无组合）。None = 不含可识别结构（回退原文）。
fn translate_pure(c: &str) -> Option<String> {
    let c = c.trim();
    if c.is_empty() {
        return None;
    }
    // 重定向符号说明（cat x > y 这类：翻译主命令并点出写入文件）
    let redirect = if c.contains('>') { "（输出写入文件）" } else { "" };
    let core = c.split(['>', '<']).next().unwrap_or(c).trim();
    let (prog, rest) = match core.split_once(' ') {
        Some((p, r)) => (p, r),
        None => (core, ""),
    };
    let operands: Vec<&str> = rest.split_whitespace().filter(|t| !t.starts_with('-')).collect();
    let has_flag = |names: &[&str]| rest.split_whitespace().any(|t| names.contains(&t));
    let phrase = match prog {
        "sudo" if !rest.is_empty() => {
            return Some(format!("以管理员权限{}", translate_segment(rest)));
        }
        "rm" => {
            let targets = operands.join("、");
            if has_flag(&["-r", "-R", "-rf", "-fr", "-rF", "-rv", "-Rv"]) {
                format!("递归删除文件夹 {targets}——其中的全部内容都会被永久删除，无法恢复")
            } else {
                format!("删除文件 {targets}")
            }
        }
        "mv" if operands.len() >= 2 => format!("把 {} 移动或重命名为 {}", operands[0], operands[1]),
        "cp" if operands.len() >= 2 => {
            if has_flag(&["-r", "-R", "-a", "-rf", "-rF"]) {
                format!("把文件夹 {}（含全部内容）复制到 {}", operands[0], operands[1])
            } else {
                format!("把文件 {} 复制到 {}", operands[0], operands[1])
            }
        }
        "chmod" if !operands.is_empty() => {
            let targets = operands[1..].join("、");
            let readable = octal_to_rwx(operands[0])
                .map(|r| format!("，即 {r}"))
                .unwrap_or_default();
            format!("把 {} 的权限改为 {}{readable}", if targets.is_empty() { "文件" } else { &targets }, operands[0])
        }
        "chown" if !operands.is_empty() => {
            format!("把 {} 的所有者改为 {}", operands[1..].join("、"), operands[0])
        }
        "systemctl" if operands.len() >= 2 => {
            let svc = operands[1];
            match operands[0] {
                "restart" => format!("重启 {svc} 服务（服务会短暂中断）"),
                "stop" => format!("停止 {svc} 服务（依赖它的站点或程序会不可用）"),
                "start" => format!("启动 {svc} 服务"),
                "enable" => format!("设置 {svc} 服务开机自启"),
                "disable" => format!("取消 {svc} 服务开机自启"),
                "reload" => format!("重新加载 {svc} 的配置（不中断服务）"),
                _ => format!("对 {svc} 服务执行 {}", operands[0]),
            }
        }
        "reboot" | "shutdown" | "poweroff" | "halt" => {
            "重启或关闭整台服务器（所有连接与服务都会中断）".to_string()
        }
        "kill" | "pkill" | "killall" if !operands.is_empty() => {
            format!("强制终止进程 {}", operands.join("、"))
        }
        "apt" | "apt-get" | "yum" | "dnf" | "pacman" if !operands.is_empty() => {
            let pkgs = operands[1..].join("、");
            if operands[0] == "install" {
                format!("安装软件包 {pkgs}")
            } else if operands[0] == "remove" || operands[0] == "purge" {
                format!("卸载软件包 {pkgs}")
            } else if operands[0] == "update" || operands[0] == "upgrade" {
                "更新软件包列表或升级已装的软件".to_string()
            } else {
                return None;
            }
        }
        "docker" | "podman" if !operands.is_empty() => {
            format!("执行容器操作：{}", operands.join(" "))
        }
        "curl" | "wget" => format!("从网络下载（{}）", operands.join(" ")),
        "cat" | "head" | "tail" | "less" | "grep" | "awk" | "sed" | "sort" | "wc" | "find" | "ls" | "du" | "df" | "ps" | "top" | "free" | "uname" | "whoami" | "id" | "date" | "echo" | "which" | "stat" => {
            return None; // 只读类命令不值得逐个翻译——上层回退原文
        }
        _ => return None,
    };
    Some(format!("{phrase}{redirect}"))
}

/// 把 exec 的 shell 命令翻译成人读中文句子：
/// 单条 → "将…"；多条（;/&&）→ 换行编号列出每条的短语。
fn translate_exec(cmd: &str) -> String {
    let c = cmd.trim();
    // 按 ; 与 && 拆多条（优先；&& 同级）
    let segments: Vec<&str> = c
        .split([';', ';'])
        .flat_map(|part| part.split("&&"))
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .collect();
    if segments.len() <= 1 {
        let phrase = translate_segment(c);
        return format!("将{phrase}");
    }
    let list_sep = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧'];
    let mut lines = String::from("将依次执行以下命令：");
    for (i, seg) in segments.iter().enumerate() {
        let marker = list_sep.get(i).map(|c| c.to_string()).unwrap_or_else(|| format!("{}.", i + 1));
        lines.push('\n');
        lines.push_str(&format!("{marker} {}", translate_segment(seg)));
    }
    lines
}

/// 危险操作判定：返回（人读摘要，原始指令）二元组（None = 无需确认）。
fn confirm_request_for(ctx: &McpCtx, name: &str, args: &Value) -> Option<ConfirmRequest> {
    let path = args.get("path").and_then(|v| v.as_str());
    let raw_json = serde_json::to_string_pretty(args).ok();
    let cfg = ctx.config.read().unwrap();
    match name {
        "delete" if cfg.confirm_delete => {
            let recursive = args.get("recursive").and_then(|v| v.as_bool()).unwrap_or(false);
            Some(ConfirmRequest {
                summary: if recursive {
                    format!("将递归删除文件夹 {}——其中的全部内容都会被永久删除，无法恢复", path.unwrap_or("?"))
                } else {
                    format!("将删除文件 {}", path.unwrap_or("?"))
                },
                raw: raw_json,
            })
        }
        "exec" if cfg.confirm_exec => {
            let cmd = args.get("command").and_then(|v| v.as_str()).unwrap_or("?");
            Some(ConfirmRequest {
                summary: translate_exec(cmd),
                raw: Some(cmd.to_string()),
            })
        }
        _ => None,
    }
}

/// 统一入口：审计 + 危险操作拦截 + 分发。
pub async fn dispatch(ctx: &McpCtx, via: Via, name: &str, args: Value) -> Result<Value, String> {
    let _busy = BusyGuard::enter(&ctx.busy);
    let args = if args.is_null() { json!({}) } else { args };

    if !tool_specs().iter().any(|t| t.name == name) {
        ctx.audit
            .record_args(via.as_str(), name, "error", "未知工具".into(), Some(args.clone()));
        return Err(format!("未知工具: {name}"));
    }

    if let Some(req) = confirm_request_for(ctx, name, &args) {
        match ctx.confirms.wait_approval(&ctx.app, req.summary, req.raw).await {
            crate::mcp::audit::ApprovalOutcome::Approved => {}
            crate::mcp::audit::ApprovalOutcome::Denied => {
                ctx.audit.record_args(
                    via.as_str(),
                    name,
                    "denied",
                    "用户拒绝了该操作".into(),
                    Some(args.clone()),
                );
                return Err("用户拒绝了该操作".into());
            }
            crate::mcp::audit::ApprovalOutcome::Timeout => {
                ctx.audit.record_args(
                    via.as_str(),
                    name,
                    "timeout",
                    "等待确认超时，未响应".into(),
                    Some(args.clone()),
                );
                return Err(format!(
                    "确认超时：{} 秒内未获用户响应，本次操作未执行（用户未主动拒绝，可再次尝试）",
                    crate::mcp::audit::CONFIRM_TIMEOUT_SECS
                ));
            }
        }
    }

    let detail = summarize_call(name, &args);
    let started = std::time::Instant::now();
    let result = dispatch_inner(ctx, name, &args).await;
    let elapsed = started.elapsed().as_millis();
    match result {
        Ok(v) => {
            ctx.audit.record_args(
                via.as_str(),
                name,
                "ok",
                format!("{detail}（{elapsed}ms）"),
                Some(args.clone()),
            );
            Ok(v)
        }
        Err(e) => {
            ctx.audit.record_args(
                via.as_str(),
                name,
                "error",
                format!("{detail}：{e}"),
                Some(args.clone()),
            );
            Err(e)
        }
    }
}

/// 参数要点一行摘要（审计展示，不含文件内容）。
fn summarize_call(name: &str, args: &Value) -> String {
    let get = |k: &str| args.get(k).and_then(|v| v.as_str());
    match name {
        "exec" => format!("exec「{}」", get("command").unwrap_or("?")),
        _ => {
            let mut parts: Vec<String> = Vec::new();
            for key in ["path", "oldPath", "newPath", "localPath", "dir", "profile"] {
                if let Some(v) = get(key) {
                    parts.push(v.to_string());
                }
            }
            if parts.is_empty() {
                name.to_string()
            } else {
                parts.join(" → ")
            }
        }
    }
}

/// 解析 connection 参数 → (connectionId, 会话句柄)。
/// 省略时唯一活跃连接自动选中；多个则报错并列出可选值。
fn resolve_session(ctx: &McpCtx, args: &Value) -> Result<(String, SessionHandle), String> {
    let state = ctx.app.state::<AppState>();
    let spec = args
        .get("connection")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let sessions = state.list();
    let names = || {
        sessions
            .iter()
            .map(|(id, h)| format!("{}({id})", h.alias))
            .collect::<Vec<_>>()
            .join("、")
    };

    match spec {
        Some(spec) => {
            if let Some(h) = state.get(spec) {
                return Ok((spec.to_string(), h));
            }
            if let Some((id, h)) = sessions.iter().find(|(_, h)| h.alias == spec) {
                return Ok((id.clone(), h.clone()));
            }
            Err(format!(
                "连接「{spec}」不存在。活跃连接：{}；未连接的 profile 请先 connect",
                names()
            ))
        }
        None => {
            if sessions.len() == 1 {
                let (id, h) = sessions.into_iter().next().unwrap();
                return Ok((id, h));
            }
            Err(format!(
                "当前有 {} 个活跃连接，必须指定 connection 参数。活跃连接：{}",
                sessions.len(),
                names()
            ))
        }
    }
}

/// IO_TIMEOUT 包装的会话锁执行器：拿锁 → 限时执行 → 释放。
async fn with_session<T>(
    handle: &SessionHandle,
    f: impl for<'a> AsyncFnOnce(&'a crate::ssh::SshSession) -> crate::error::Result<T>,
) -> Result<T, String> {
    let session = handle.session.lock().await;
    tokio::time::timeout(IO_TIMEOUT, f(&session))
        .await
        .map_err(|_| "操作超时（30s）".to_string())?
        .map_err(|e| e.to_string())
}

fn arg_str(args: &Value, key: &str) -> Result<String, String> {
    args.get(key)
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| format!("缺少必填参数 {key}"))
}

fn arg_opt_str(args: &Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .filter(|s| !s.trim().is_empty())
}

async fn dispatch_inner(ctx: &McpCtx, name: &str, args: &Value) -> Result<Value, String> {
    match name {
        "list_connections" => tool_list_connections(ctx),
        "connect" => tool_connect(ctx, args).await,
        "list_dir" => {
            let path = arg_str(args, "path")?;
            let (_, handle) = resolve_session(ctx, args)?;
            let entries = with_session(&handle, async |s| s.list_dir(&path).await).await?;
            serde_json::to_value(entries).map_err(|e| e.to_string())
        }
        "stat" => {
            let path = arg_str(args, "path")?;
            let (_, handle) = resolve_session(ctx, args)?;
            let attrs = with_session(&handle, async |s| s.stat(&path).await).await?;
            Ok(stat_entry(&path, &attrs))
        }
        "read_file" => {
            let path = arg_str(args, "path")?;
            let (_, handle) = resolve_session(ctx, args)?;
            let b64 = arg_opt_str(args, "encoding").as_deref() == Some("base64");
            let limit = if b64 { READ_BINARY_LIMIT } else { READ_TEXT_LIMIT };
            let bytes = with_session(&handle, async |s| s.read_file_bytes(&path, limit).await).await?;
            if b64 {
                use base64::Engine as _;
                let size = bytes.len();
                Ok(json!({
                    "encoding": "base64",
                    "base64": base64::engine::general_purpose::STANDARD.encode(&bytes),
                    "size": size,
                }))
            } else {
                let text = String::from_utf8(bytes)
                    .map_err(|_| format!("{path} 不是 UTF-8 文本，可用 encoding=base64 读取"))?;
                Ok(json!({ "encoding": "text", "content": text }))
            }
        }
        "write_file" => {
            let path = arg_str(args, "path")?;
            let content = arg_str(args, "content")?;
            let (_, handle) = resolve_session(ctx, args)?;
            let bytes = if arg_opt_str(args, "encoding").as_deref() == Some("base64") {
                use base64::Engine as _;
                base64::engine::general_purpose::STANDARD
                    .decode(content.as_bytes())
                    .map_err(|e| format!("base64 解码失败: {e}"))?
            } else {
                content.into_bytes()
            };
            // 覆盖拦截：目标已存在时按配置弹窗（拒绝/超时分别报告）
            if ctx.config.read().unwrap().confirm_overwrite
                && with_session(&handle, async |s| s.stat(&path).await).await.is_ok()
            {
                let raw = serde_json::to_string_pretty(&args).ok();
                match ctx
                    .confirms
                    .wait_approval(
                        &ctx.app,
                        format!("将覆盖写入文件 {path}（同名文件的原有内容会被替换）"),
                        raw,
                    )
                    .await
                {
                    crate::mcp::audit::ApprovalOutcome::Approved => {}
                    crate::mcp::audit::ApprovalOutcome::Denied => {
                        return Err("用户拒绝了覆盖写入".into());
                    }
                    crate::mcp::audit::ApprovalOutcome::Timeout => {
                        return Err(format!(
                            "确认超时：{} 秒内未获用户响应，覆盖写入未执行（可再次尝试）",
                            crate::mcp::audit::CONFIRM_TIMEOUT_SECS
                        ));
                    }
                }
            }
            let written = bytes.len();
            with_session(&handle, async |s| s.write_file_bytes(&path, &bytes).await).await?;
            Ok(json!({ "written": written }))
        }
        "mkdir" => {
            let path = arg_str(args, "path")?;
            let (_, handle) = resolve_session(ctx, args)?;
            if !args.get("parents").and_then(|v| v.as_bool()).unwrap_or(true) {
                with_session(&handle, async |s| s.mkdir(&path).await).await?;
                return Ok(json!({ "created": true, "alreadyExisted": false }));
            }
            let created = ensure_remote_dir(&handle, &path).await?;
            Ok(json!({ "created": created, "alreadyExisted": !created }))
        }
        "touch" => {
            let path = arg_str(args, "path")?;
            let (_, handle) = resolve_session(ctx, args)?;
            with_session(&handle, async |s| s.touch(&path).await).await?;
            Ok(json!({ "touched": true }))
        }
        "rename" => {
            let old_path = arg_str(args, "oldPath")?;
            let new_path = arg_str(args, "newPath")?;
            let (_, handle) = resolve_session(ctx, args)?;
            with_session(&handle, async |s| s.rename(&old_path, &new_path).await).await?;
            Ok(json!({ "renamed": true }))
        }
        "delete" => {
            let path = arg_str(args, "path")?;
            let recursive = args.get("recursive").and_then(|v| v.as_bool()).unwrap_or(false);
            let (_, handle) = resolve_session(ctx, args)?;
            let kind = with_session(&handle, async |s| s.stat(&path).await)
                .await
                .map(|a| crate::ssh::kind_from_mode(a.permissions))
                .map_err(|e| format!("{path}: {e}"))?;
            if kind == "dir" && !recursive {
                return Err(format!("{path} 是目录，删除需 recursive=true"));
            }
            with_session(&handle, async |s| s.delete(&path, recursive).await).await?;
            Ok(json!({ "deleted": true }))
        }
        "chmod" => {
            let path = arg_str(args, "path")?;
            let mode = arg_str(args, "mode")?;
            let (_, handle) = resolve_session(ctx, args)?;
            let mode = u32::from_str_radix(mode.trim(), 8)
                .map_err(|_| format!("无效的八进制权限「{mode}」，示例：755"))?;
            with_session(&handle, async |s| s.chmod(&path, mode).await).await?;
            Ok(json!({ "chmod": mode }))
        }
        "read_link" => {
            let path = arg_str(args, "path")?;
            let (_, handle) = resolve_session(ctx, args)?;
            let target = with_session(&handle, async |s| s.read_link(&path).await).await?;
            Ok(json!({ "target": target }))
        }
        "search_files" => {
            let dir = arg_str(args, "dir")?;
            let query = arg_str(args, "query")?;
            let max_depth = args.get("maxDepth").and_then(|v| v.as_u64()).unwrap_or(6).clamp(1, 16);
            let (_, handle) = resolve_session(ctx, args)?;
            tool_search_files(&handle, &dir, &query, max_depth).await
        }
        "tree" => {
            let path = arg_str(args, "path")?;
            let (_, handle) = resolve_session(ctx, args)?;
            // 根不存在/不是目录时明确报错（此前只记 failedDirs 静默返回）
            let kind = with_session(&handle, async |s| s.stat(&path).await)
                .await
                .map(|attrs| crate::ssh::kind_from_mode(attrs.permissions))
                .map_err(|e| format!("{path}: {e}"))?;
            if kind == "file" {
                return Err(format!("{path} 是文件，tree 只能枚举目录"));
            }
            let flag = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let out = run_walk(handle, path, flag, Box::new(|_| {})).await;
            let total = out.dirs.len() + out.files.len();
            Ok(json!({
                "dirs": out.dirs.iter().take(ENTRY_LIMIT).cloned().collect::<Vec<_>>(),
                "files": out.files.iter().take(ENTRY_LIMIT).map(|f| json!({ "path": f.path, "kind": f.kind, "size": f.size })).collect::<Vec<_>>(),
                "skippedLinks": out.skipped_links,
                "failedDirs": out.failed_dirs,
                "truncated": total > ENTRY_LIMIT,
            }))
        }
        "disk_usage" => {
            let path = arg_str(args, "path")?;
            let (_, handle) = resolve_session(ctx, args)?;
            let info = with_session(&handle, async |s| s.fs_info(&path).await)
                .await?
                .map(|st| {
                    json!({
                        "total": st.blocks * st.fragment_size,
                        "free": st.blocks_avail * st.fragment_size,
                    })
                });
            Ok(info.unwrap_or(Value::Null))
        }
        "exec" => {
            let command = arg_str(args, "command")?;
            let timeout = args
                .get("timeoutSec")
                .and_then(|v| v.as_u64())
                .unwrap_or(30)
                .clamp(EXEC_TIMEOUT_MIN, EXEC_TIMEOUT_MAX);
            let (_, handle) = resolve_session(ctx, args)?;
            let session = handle.session.lock().await;
            let argv: Vec<String> = vec!["-c".into(), command];
            let out = tokio::time::timeout(Duration::from_secs(timeout), session.exec("sh", &argv))
                .await
                .map_err(|_| format!("命令超时（{timeout}s），可传 timeoutSec 上调（≤600）"))?
                .map_err(|e| e.to_string())?;
            let (stdout, stdout_truncated) = clip(&out.stdout);
            let (stderr, stderr_truncated) = clip(&out.stderr);
            Ok(json!({
                "exitCode": out.exit_code,
                "stdout": stdout,
                "stderr": stderr,
                "stdoutTruncated": stdout_truncated,
                "stderrTruncated": stderr_truncated,
            }))
        }
        "download" => {
            let path = arg_str(args, "path")?;
            let local_path = arg_str(args, "localPath")?;
            let (connection_id, handle) = resolve_session(ctx, args)?;
            tool_transfer(ctx, &connection_id, &handle, Direction::Download, &path, &local_path).await
        }
        "upload" => {
            let local_path = arg_str(args, "localPath")?;
            let path = arg_str(args, "path")?;
            let (connection_id, handle) = resolve_session(ctx, args)?;
            tool_transfer(ctx, &connection_id, &handle, Direction::Upload, &local_path, &path).await
        }
        "transfers" => {
            let filter = arg_opt_str(args, "connection");
            // 与其他工具一致：connection 参数收 connectionId 或 profile 名（别名）
            let alias_of = |cid: &str| {
                ctx.app
                    .state::<AppState>()
                    .list()
                    .into_iter()
                    .find(|(id, _)| id == cid)
                    .map(|(_, h)| h.alias)
            };
            let list = ctx.app.state::<TransferManager>().list();
            let filtered: Vec<Value> = list
                .into_iter()
                .filter(|t| match &filter {
                    Some(c) => c == &t.connection_id || alias_of(&t.connection_id).as_deref() == Some(c),
                    None => true,
                })
                .map(|t| serde_json::to_value(t).unwrap_or(Value::Null))
                .collect();
            Ok(json!({ "transfers": filtered }))
        }
        _ => Err(format!("未知工具: {name}")),
    }
}

/// stdout/stderr 保留头尾各半，中间折叠。
fn clip(raw: &str) -> (String, bool) {
    if raw.len() <= EXEC_OUTPUT_LIMIT {
        return (raw.to_string(), false);
    }
    let half = EXEC_OUTPUT_LIMIT / 2;
    let head = &raw[..floor_char_boundary(raw, half)];
    let tail = &raw[floor_char_boundary(raw, raw.len() - half)..];
    let omitted = raw.len() - head.len() - tail.len();
    (
        format!("{head}\n…（中间省略 {omitted} 字节）…\n{tail}"),
        true,
    )
}

fn floor_char_boundary(s: &str, mut i: usize) -> usize {
    if i >= s.len() {
        return s.len();
    }
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

fn stat_entry(path: &str, attrs: &russh_sftp::protocol::FileAttributes) -> Value {
    let kind = crate::ssh::kind_from_mode(attrs.permissions);
    json!({
        "path": path,
        "name": path.rsplit('/').next().unwrap_or(path),
        "kind": kind,
        "size": attrs.size.unwrap_or(0),
        "mode": format!("{:o}", attrs.permissions.unwrap_or(0)),
        "permissions": crate::ssh::mode_string(attrs.permissions, kind),
        "owner": attrs.user.clone().or_else(|| attrs.uid.map(|u| u.to_string())),
        "group": attrs.group.clone().or_else(|| attrs.gid.map(|g| g.to_string())),
        "mtime": attrs.mtime.map(|t| t as i64),
    })
}

fn tool_list_connections(ctx: &McpCtx) -> Result<Value, String> {
    let state = ctx.app.state::<AppState>();
    let sessions = state.list();
    let profiles = ctx.profiles.list();

    let connections: Vec<Value> = sessions
        .iter()
        .map(|(id, h)| {
            json!({
                "connectionId": id,
                "profile": h.alias,
                "host": h.host,
                "port": h.port,
            })
        })
        .collect();
    let profile_list: Vec<Value> = profiles
        .iter()
        .map(|p| {
            json!({
                "name": p.name,
                "host": p.host,
                "port": p.port,
                "username": p.username,
                "connected": sessions.iter().any(|(_, h)| h.alias == p.name),
            })
        })
        .collect();
    Ok(json!({
        "connections": connections,
        "profiles": profile_list,
        "hint": "connect 用 profile 名建立新连接；其余工具的 connection 参数用 connectionId 或 profile 名",
    }))
}

/// keyring 读取（service 与 commands/credentials.rs 一致）。
fn keyring_get(key: &str) -> Option<String> {
    use keyring::Entry;
    Entry::new("VisualSSH", key)
        .ok()?
        .get_password()
        .ok()
        .filter(|s| !s.is_empty())
}

async fn tool_connect(ctx: &McpCtx, args: &Value) -> Result<Value, String> {
    let profile_name = arg_str(args, "profile")?;
    let meta = ctx
        .profiles
        .find(&profile_name)
        .ok_or_else(|| format!("没有名为「{profile_name}」的已保存 profile"))?;

    // 凭据只在本进程内从系统加密存储读取，不经过任何 Agent 可见的通道
    let password = keyring_get(&format!("profile:{}:password", meta.id));
    let passphrase = keyring_get(&format!("profile:{}:passphrase", meta.id));

    let profile = crate::commands::ssh::SshProfileInput {
        host: meta.host.clone(),
        port: meta.port,
        username: meta.username.clone(),
        password,
        private_key_path: meta.private_key_path.clone(),
        passphrase,
    };
    let alias = meta.name.clone();
    let host = meta.host.trim().to_string();
    let port = meta.port;

    // 复用 GUI 连接内核（TOFU/指纹/SFTP 握手一致）；HOSTKEY_CHANGED 以错误
    // 返回给 Agent，由用户在 GUI 连接一次完成信任
    let mut known = crate::ssh::KnownHosts::load().map_err(|e| e.to_string())?;
    let (session, host_key, lost_rx) =
        crate::commands::ssh::connect_with_timeout(&profile, known.clone())
            .await
            .map_err(|e| e.to_string())?;

    if host_key.first_time {
        known.upsert(crate::ssh::HostEntry {
            host: host.clone(),
            port,
            algorithm: host_key.algorithm,
            fingerprint: host_key.fingerprint,
        });
        known.save().map_err(|e| e.to_string())?;
    }

    let root_path = tokio::time::timeout(IO_TIMEOUT, session.canonicalize("/"))
        .await
        .map_err(|_| "连接超时".to_string())?
        .map_err(|e| e.to_string())?;

    let connection_id = uuid::Uuid::new_v4().to_string();
    let intentional_close = Arc::new(std::sync::atomic::AtomicBool::new(false));
    {
        let state = ctx.app.state::<AppState>();
        state.insert(
            connection_id.clone(),
            SessionHandle {
                alias,
                host,
                port,
                session: Arc::new(tokio::sync::Mutex::new(session)),
                intentional_close: Arc::clone(&intentional_close),
            },
        );
    }

    // 断线感知与 GUI 连接同款（前端按未知 connectionId 忽略即可）
    let lost_id = connection_id.clone();
    let lost_app = ctx.app.clone();
    let lost_flag = Arc::clone(&intentional_close);
    tauri::async_runtime::spawn(async move {
        let mut lost_rx = lost_rx;
        let lost = lost_rx.recv().await.is_some()
            && !lost_flag.load(std::sync::atomic::Ordering::Relaxed);
        if lost {
            let _ = lost_app.emit(
                "ssh://disconnected",
                serde_json::json!({ "connectionId": lost_id }),
            );
        }
    });

    Ok(json!({
        "connectionId": connection_id,
        "rootPath": root_path,
        "profile": meta.name,
    }))
}

/// exec find 优先（argv 直传，无 shell 注入面），回退 run_walk 名称过滤。
async fn tool_search_files(
    handle: &SessionHandle,
    dir: &str,
    query: &str,
    max_depth: u64,
) -> Result<Value, String> {
    let glob = crate::search::find_pattern(query);
    let find_args: Vec<String> = vec![
        dir.to_string(),
        "-maxdepth".into(),
        max_depth.to_string(),
        "-iname".into(),
        glob,
        "-print0".into(),
    ];
    let find_out = {
        let session = handle.session.lock().await;
        tokio::time::timeout(IO_TIMEOUT, session.exec("find", &find_args))
            .await
            .map_err(|_| "搜索超时".to_string())?
            .ok()
            .filter(|o| o.exit_code == Some(0))
            .map(|o| o.stdout)
    };
    let mut paths: Vec<String> = if let Some(out) = find_out {
        out.split('\0')
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect()
    } else {
        // 回退：SFTP 枚举 + 名称包含
        let flag = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let out = run_walk(handle.clone(), dir.to_string(), flag, Box::new(|_| {})).await;
        let needle = query.to_lowercase();
        let mut hits: Vec<String> = out
            .files
            .iter()
            .filter(|f| {
                f.path
                    .rsplit('/')
                    .next()
                    .unwrap_or(&f.path)
                    .to_lowercase()
                    .contains(&needle)
            })
            .map(|f| f.path.clone())
            .collect();
        hits.extend(
            out.dirs
                .iter()
                .filter(|d| d.rsplit('/').next().unwrap_or(d).to_lowercase().contains(&needle))
                .cloned(),
        );
        hits.sort();
        hits
    };

    paths.dedup();
    let truncated = paths.len() > ENTRY_LIMIT;
    paths.truncate(ENTRY_LIMIT);
    Ok(json!({ "matches": paths, "count": paths.len(), "truncated": truncated }))
}

enum Direction {
    Upload,
    Download,
}

/// 传输编排：文件单发；目录递归（walk → mkdir → 逐文件入队）。
/// 覆盖语义 = 直接覆盖（Agent 场景不走冲突对话框）。
async fn tool_transfer(
    ctx: &McpCtx,
    connection_id: &str,
    handle: &SessionHandle,
    direction: Direction,
    a: &str,
    b: &str,
) -> Result<Value, String> {
    let mut ids: Vec<String> = Vec::new();

    let enqueue = |ctx: &McpCtx,
                   connection_id: &str,
                   handle: &SessionHandle,
                   dir: Direction,
                   local: String,
                   remote: String,
                   name: String,
                   total: u64|
     -> String {
        let transfers = ctx.app.state::<TransferManager>();
        let transfer_id = uuid::Uuid::new_v4().to_string();
        let label = match dir {
            Direction::Upload => "upload",
            Direction::Download => "download",
        };
        let h = Arc::new(TransferHandle::new(
            transfer_id.clone(),
            connection_id.to_string(),
            label,
            name,
            total,
        ));
        transfers.register(h.clone());
        let sem = transfers.semaphore(connection_id);
        let app = ctx.app.clone();
        match dir {
            Direction::Upload => {
                tauri::async_runtime::spawn(run_upload(app, h, handle.clone(), sem, local, remote))
            }
            Direction::Download => {
                tauri::async_runtime::spawn(run_download(app, h, handle.clone(), sem, remote, local))
            }
        };
        transfer_id
    };

    match direction {
        Direction::Upload => {
            let (local_root, remote_dir) = (a.to_string(), b.to_string());
            let meta = tokio::fs::metadata(&local_root)
                .await
                .map_err(|e| format!("读取本地 {local_root} 失败: {e}"))?;
            if !meta.is_dir() {
                let name = base_name_of(&local_root);
                // 目标语义与描述一致：远端 path 是目录才落入其下，否则视为完整目标路径
                let remote_is_dir = with_session(handle, async |s| s.stat(&remote_dir).await)
                    .await
                    .map(|attrs| crate::ssh::kind_from_mode(attrs.permissions) == "dir")
                    .unwrap_or(false);
                let remote = if remote_is_dir {
                    join_remote_dir(&remote_dir, &name)
                } else {
                    remote_dir.clone()
                };
                ids.push(enqueue(ctx, &connection_id, handle, Direction::Upload, local_root, remote, name, meta.len()));
            } else {
                let root_name = base_name_of(&local_root);
                let out = crate::commands::walk::walk_local(local_root.clone())
                    .await
                    .map_err(|e| e.to_string())?;
                // 自顶向下建目录（按路径深度排序保证父先于子）
                let mut dirs = out.dirs.clone();
                dirs.sort_by_key(|d| d.matches('/').count());
                for d in &dirs {
                    let remote = join_remote_dir(&remote_dir, &format!("{root_name}/{d}"));
                    ensure_remote_dir(handle, &remote).await?;
                }
                for f in &out.files {
                    let rel = format!("{root_name}/{}", f.path);
                    let remote = join_remote_dir(&remote_dir, &rel);
                    let local = join_local(&local_root, &f.path);
                    ids.push(enqueue(ctx, &connection_id, handle, Direction::Upload, local, remote, f.path.clone(), f.size));
                }
            }
        }
        Direction::Download => {
            let (remote_root, local_dir) = (a.to_string(), b.to_string());
            let kind = with_session(handle, async |s| s.stat(&remote_root).await)
                .await
                .map(|attrs| crate::ssh::kind_from_mode(attrs.permissions))
                .map_err(|e| format!("{remote_root}: {e}"))?;
            if kind != "dir" {
                let name = base_name_of(&remote_root);
                // 目标语义与描述一致：本地路径是已存在目录才落入其下，否则视为完整文件路径
                let local_is_dir = tokio::fs::metadata(&local_dir)
                    .await
                    .map(|m| m.is_dir())
                    .unwrap_or(false);
                let local = if local_is_dir {
                    join_local(&local_dir, &name)
                } else {
                    // 完整路径：确保父目录存在（避免 os error 3）
                    if let Some(parent) = std::path::Path::new(&local_dir).parent() {
                        let _ = tokio::fs::create_dir_all(parent).await;
                    }
                    local_dir.clone()
                };
                let size = with_session(handle, async |s| s.file_size(&remote_root).await)
                    .await
                    .unwrap_or(0);
                ids.push(enqueue(ctx, &connection_id, handle, Direction::Download, local, remote_root.clone(), name, size));
            } else {
                let flag = Arc::new(std::sync::atomic::AtomicBool::new(false));
                let out = run_walk(handle.clone(), remote_root.clone(), flag, Box::new(|_| {})).await;
                let root_name = base_name_of(&remote_root);
                let mut dirs = out.dirs.clone();
                dirs.sort_by_key(|d| d.matches('/').count());
                for d in &dirs {
                    let local = join_local(&local_dir, &format!("{root_name}/{d}"));
                    tokio::fs::create_dir_all(&local)
                        .await
                        .map_err(|e| format!("创建本地目录 {local} 失败: {e}"))?;
                }
                for f in &out.files {
                    let local = join_local(&local_dir, &format!("{root_name}/{}", f.path));
                    ids.push(enqueue(ctx, &connection_id, handle, Direction::Download, local, remote_root.clone(), f.path.clone(), f.size));
                }
            }
        }
    }

    Ok(json!({ "transferIds": ids, "count": ids.len(), "hint": "用 transfers 工具查询进度与终态" }))
}

/// 逐级建目录；返回是否新建过至少一级（全已存在 → false）。
async fn ensure_remote_dir(handle: &SessionHandle, path: &str) -> Result<bool, String> {
    let mut cur = String::new();
    let mut created_any = false;
    for seg in path.split('/').filter(|s| !s.is_empty()) {
        cur.push('/');
        cur.push_str(seg);
        let created = with_session(handle, async |s| s.mkdir(&cur).await).await.is_ok();
        if created {
            created_any = true;
        } else {
            let is_dir = with_session(handle, async |s| s.stat(&cur).await)
                .await
                .map(|a| crate::ssh::kind_from_mode(a.permissions) == "dir")
                .unwrap_or(false);
            if !is_dir {
                return Err(format!("创建远端目录 {cur} 失败"));
            }
        }
    }
    Ok(created_any)
}

fn base_name_of(path: &str) -> String {
    path.replace('\\', "/")
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or(path)
        .to_string()
}

fn join_remote_dir(dir: &str, rel: &str) -> String {
    let dir = dir.trim_end_matches('/');
    format!("{dir}/{rel}")
}

fn join_local(dir: &str, rel: &str) -> String {
    let rel = rel.replace('/', std::path::MAIN_SEPARATOR_STR);
    let dir = dir.trim_end_matches(['/', '\\']);
    let sep = std::path::MAIN_SEPARATOR;
    format!("{dir}{sep}{rel}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clip_keeps_head_and_tail() {
        let raw = "x".repeat(EXEC_OUTPUT_LIMIT + 1000);
        let (out, truncated) = clip(&raw);
        assert!(truncated);
        assert!(out.starts_with('x') && out.ends_with('x'));
        assert!(out.contains("中间省略"));
        // 不超限时原样
        let (out2, t2) = clip("short");
        assert_eq!(out2, "short");
        assert!(!t2);
    }

    #[test]
    fn floor_char_boundary_respects_utf8() {
        let s = "中文abc";
        // 「中」占 3 字节：1/2 落在其内部应回退到 0，3 是「文」的起始边界
        assert_eq!(floor_char_boundary(s, 1), 0);
        assert_eq!(floor_char_boundary(s, 2), 0);
        assert_eq!(floor_char_boundary(s, 3), 3);
        assert_eq!(floor_char_boundary(s, 6), 6);
    }

    #[test]
    fn translate_exec_common_patterns() {
        assert_eq!(
            translate_exec("rm -rf /var/www/build"),
            "将递归删除文件夹 /var/www/build——其中的全部内容都会被永久删除，无法恢复"
        );
        assert_eq!(translate_exec("rm notes.txt"), "将删除文件 notes.txt");
        assert_eq!(
            translate_exec("systemctl restart nginx"),
            "将重启 nginx 服务（服务会短暂中断）"
        );
        assert_eq!(
            translate_exec("sudo reboot"),
            "将以管理员权限重启或关闭整台服务器（所有连接与服务都会中断）"
        );
        assert_eq!(
            translate_exec("mv a.conf b.conf"),
            "将把 a.conf 移动或重命名为 b.conf"
        );
        assert_eq!(
            translate_exec("apt install htop"),
            "将安装软件包 htop"
        );
        assert_eq!(
            translate_exec("chmod 755 deploy.sh"),
            "将把 deploy.sh 的权限改为 755，即 rwxr-xr-x"
        );
        // 管道：各级短语用 → 连接
        assert_eq!(
            translate_exec("cat app.log | grep ERROR"),
            "将cat app.log → grep ERROR"
        );
        // 只读命令不硬译，回退原文
        assert_eq!(translate_exec("make install"), "将执行命令 make install");
        // 多条命令：编号分行
        assert_eq!(
            translate_exec("cd /tmp && rm -rf build"),
            "将依次执行以下命令：\n① 执行命令 cd /tmp\n② 递归删除文件夹 build——其中的全部内容都会被永久删除，无法恢复"
        );
    }

        #[test]
    fn join_paths() {
        assert_eq!(join_remote_dir("/var/www", "site/index.html"), "/var/www/site/index.html");
        assert_eq!(base_name_of("/a/b/c.txt"), "c.txt");
        assert_eq!(base_name_of("C:\\dir\\file.txt"), "file.txt");
    }
}
