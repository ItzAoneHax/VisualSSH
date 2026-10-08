mod clipboard_image;
mod clipboard_vfile;
mod commands;
mod error;
mod search;
mod ssh;
mod state;
mod stats;
mod terminal;
mod transfer;
mod walk;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(state::AppState::default())
        .manage(transfer::TransferManager::default())
        .manage(std::sync::Arc::new(terminal::TerminalManager::default()))
        .manage(std::sync::Arc::new(stats::StatsManager::default()))
        .manage(std::sync::Arc::new(search::SearchManager::default()))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
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
        ])
        .run(tauri::generate_context!())
        .expect("VisualSSH 启动失败");
}
