mod commands;
mod error;
mod ssh;
mod state;
mod terminal;
mod transfer;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(state::AppState::default())
        .manage(transfer::TransferManager::default())
        .manage(std::sync::Arc::new(terminal::TerminalManager::default()))
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::ssh_connect,
            commands::ssh_test,
            commands::ssh_list_dir,
            commands::ssh_mkdir,
            commands::ssh_touch,
            commands::ssh_rename,
            commands::ssh_delete,
            commands::ssh_chmod,
            commands::ssh_read_file,
            commands::ssh_write_file,
            commands::ssh_disconnect,
            commands::ssh_trust_host,
            commands::ssh_known_hosts_list,
            commands::ssh_known_hosts_remove,
            commands::credentials::credential_get,
            commands::credentials::credential_put,
            commands::credentials::credential_delete,
            commands::transfer::ssh_upload,
            commands::transfer::ssh_download,
            commands::transfer::ssh_transfer_list,
            commands::transfer::ssh_transfer_cancel,
            commands::transfer::ssh_transfer_remove,
            commands::terminal::ssh_open_terminal,
            commands::terminal::ssh_terminal_write,
            commands::terminal::ssh_terminal_resize,
            commands::terminal::ssh_terminal_close,
        ])
        .run(tauri::generate_context!())
        .expect("VisualSSH 启动失败");
}
