mod commands;
mod error;
mod ssh;
mod state;
mod transfer;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(state::AppState::default())
        .manage(transfer::TransferManager::default())
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
            commands::credentials::credential_get,
            commands::credentials::credential_put,
            commands::credentials::credential_delete,
            commands::transfer::ssh_upload,
            commands::transfer::ssh_download,
            commands::transfer::ssh_transfer_list,
            commands::transfer::ssh_transfer_cancel,
            commands::transfer::ssh_transfer_remove,
        ])
        .run(tauri::generate_context!())
        .expect("VisualSSH 启动失败");
}
