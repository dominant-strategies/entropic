mod runtime;
mod commands;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_os::init())
        .manage(commands::AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::check_runtime_status,
            commands::start_runtime,
            commands::stop_runtime,
            commands::start_gateway,
            commands::stop_gateway,
            commands::get_gateway_status,
            commands::get_setup_progress,
            commands::run_first_time_setup,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
