//! MCP 服务器（Model Context Protocol）：让 ZCode / DeepSeek Harness / OpenCode
//! 等 Agent harness 把 VisualSSH 当作远程文件系统 + 命令网关使用。
//!
//! 架构（工具逻辑单一事实源 = tools::dispatch）：
//! - hub（GUI 进程内）：127.0.0.1 上的 axum——/mcp 挂 rmcp StreamableHttpService
//!   供 harness 直连，/rpc 供 stdio shim 转发；token + 首次接入批准门。
//! - shim（`VisualSSH.exe mcp` 子命令）：rmcp stdio server，list/call 转发 /rpc；
//!   GUI 未运行时自动拉起主程序。
//! - 安全：localhost 绑定、随机 token（stdio 从 mcp.json 读取，不进 harness 配置）、
//!   首次接入批准、危险操作可选拦截（前端弹窗）、全量审计（内存 ring）。
//! - 连接：复用 GUI 会话池；connect 工具按已存 profile 由本进程代连（凭据不出 keyring）。

pub mod audit;
pub mod config;
pub mod hub;
pub mod profiles;
pub mod shim;
pub mod tools;
