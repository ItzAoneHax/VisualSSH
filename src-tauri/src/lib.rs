mod commands;
mod error;
mod ssh;
mod state;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(state::AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::ssh_connect,
            commands::ssh_test,
            commands::ssh_list_dir,
            commands::ssh_mkdir,
            commands::ssh_touch,
            commands::ssh_rename,
            commands::ssh_delete,
            commands::ssh_chmod,
            commands::ssh_disconnect,
            commands::ssh_trust_host,
        ])
        .run(tauri::generate_context!())
        .expect("VisualSSH 启动失败");
}
