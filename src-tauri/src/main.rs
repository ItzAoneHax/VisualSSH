// Prevents an additional console window on Windows in release builds
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    // `VisualSSH.exe mcp`：stdio MCP shim 模式（harness 以 stdio 拉起），
    // 不初始化 Tauri/WebView，转发工具调用到主进程 hub
    if args.first().map(String::as_str) == Some("mcp") {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("tokio runtime 初始化失败");
        let code = rt.block_on(visualssh_lib::mcp::shim::run());
        std::process::exit(code);
    }
    // --background：后台静默模式（shim 自动拉起 / 后台自动换版用）——
    // 不显示主窗口，托盘常驻，hub/会话照常服务
    let background = args.iter().any(|a| a == "--background");
    visualssh_lib::run(background);
}
