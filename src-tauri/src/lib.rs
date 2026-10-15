mod archive;
mod clipboard_image;
mod clipboard_vfile;
mod commands;
mod error;
pub mod mcp;
mod search;
mod ssh;
mod state;
mod stats;
mod terminal;
mod transfer;
mod walk;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use tauri::Manager;

    tauri::Builder::default()
        .manage(state::AppState::default())
        .manage(transfer::TransferManager::default())
        .manage(std::sync::Arc::new(terminal::TerminalManager::default()))
        .manage(std::sync::Arc::new(stats::StatsManager::default()))
        .manage(std::sync::Arc::new(search::SearchManager::default()))
        .manage(std::sync::Arc::new(archive::ArchiveManager::default()))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // 换版残留清理：npm run exe 在应用运行中交付时把旧 exe 改名为
            // <exe>.old[N] 腾位（Windows 运行中的 exe 不能覆盖但可改名）。
            // 启动时尽力删除同目录残留——仍被旧进程占用的会失败，静默留给下次。
            if let Ok(exe) = std::env::current_exe() {
                let prefix = exe
                    .file_name()
                    .map(|n| format!("{}.old", n.to_string_lossy()));
                if let (Some(prefix), Some(dir)) = (prefix, exe.parent()) {
                    if let Ok(entries) = std::fs::read_dir(dir) {
                        for entry in entries.flatten() {
                            if entry.file_name().to_string_lossy().starts_with(&prefix) {
                                let _ = std::fs::remove_file(entry.path());
                            }
                        }
                    }
                }
            }
            // MCP hub：与前端启动解耦（stdio shim 可能只等这个端口）
            let (_ctx, hub) = commands::mcp::build_ctx(app.handle().clone());
            let hub_enabled = hub.ctx.config.read().unwrap().enabled;
            app.manage(hub.clone());
            app.manage(hub.ctx.profiles.clone());
            app.manage(hub.ctx.confirms.clone());
            if hub_enabled {
                let hub = std::sync::Arc::clone(&hub);
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = hub.start().await {
                        eprintln!("[mcp] hub 启动失败: {e}");
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::ssh_connect,
            commands::ssh_test,
            commands::ssh_list_dir,
            commands::ssh_mkdir,
            commands::ssh_stat,
            commands::ssh_touch,
            commands::ssh_rename,
            commands::ssh_delete,
            commands::ssh_chmod,
            commands::ssh_read_file,
            commands::ssh_read_file_base64,
            commands::archive::ssh_archive_start,
            commands::archive::ssh_archive_cancel,
            commands::ssh_write_file,
            commands::ssh_read_link,
            commands::ssh_exec,
            commands::ssh_search_start,
            commands::ssh_search_cancel,
            commands::ssh_fs_info,
            commands::ssh_disconnect,
            commands::ssh_trust_host,
            commands::ssh_known_hosts_list,
            commands::ssh_known_hosts_remove,
            commands::clipboard::clipboard_read_files,
            commands::clipboard::clipboard_write_files,
            commands::clipboard::clipboard_read_image,
            commands::clipboard::clipboard_save_image,
            commands::clipboard::ssh_clipboard_copy_virtual,
            commands::credentials::credential_get,
            commands::credentials::credential_put,
            commands::credentials::credential_delete,
            commands::transfer::ssh_upload,
            commands::transfer::ssh_download,
            commands::transfer::ssh_transfer_list,
            commands::transfer::ssh_transfer_cancel,
            commands::transfer::ssh_transfer_remove,
            commands::transfer::local_file_meta,
            commands::stats::ssh_dir_stats,
            commands::stats::ssh_dir_stats_cancel,
            commands::walk::ssh_walk_remote,
            commands::walk::ssh_walk_cancel,
            commands::walk::walk_local,
            commands::walk::local_mkdir_p,
            commands::terminal::ssh_open_terminal,
            commands::terminal::ssh_terminal_write,
            commands::terminal::ssh_terminal_resize,
            commands::terminal::ssh_terminal_close,
            commands::mcp::mcp_status,
            commands::mcp::mcp_get_config,
            commands::mcp::mcp_set_config,
            commands::mcp::mcp_reset_token,
            commands::mcp::mcp_reset_approval,
            commands::mcp::mcp_audit_list,
            commands::mcp::mcp_audit_stats,
            commands::mcp::mcp_audit_export,
            commands::mcp::mcp_audit_clear,
            commands::mcp::mcp_confirm_resolve,
            commands::mcp::mcp_pending_confirms,
            commands::mcp::mcp_sync_profiles,
            commands::mcp::mcp_snippets,
        ])
        .build(tauri::generate_context!())
        .expect("VisualSSH 初始化失败")
        .run(|app, event| {
            // 退出时把审计缓冲压块落盘（崩溃窗口 ≤ 一块）
            if let tauri::RunEvent::Exit = event {
                use tauri::Manager;
                if let Some(hub) = app.try_state::<std::sync::Arc<crate::mcp::hub::McpHub>>() {
                    hub.ctx.audit.flush();
                }
            }
        });
}
