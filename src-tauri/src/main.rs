// Prevents an additional console window on Windows in release builds
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `VisualSSH.exe mcp`：stdio MCP shim 模式（harness 以 stdio 拉起），
    // 不初始化 Tauri/WebView，转发工具调用到主进程 hub
    if std::env::args().nth(1).as_deref() == Some("mcp") {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("tokio runtime 初始化失败");
        let code = rt.block_on(visualssh_lib::mcp::shim::run());
        std::process::exit(code);
    }
    visualssh_lib::run()
}
