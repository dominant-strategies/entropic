mod runtime;
mod commands;

use tauri::{Emitter, Manager};

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            let urls: Vec<String> = args
                .into_iter()
                .filter(|arg| arg.starts_with("nova://"))
                .collect();

            if urls.is_empty() {
                return;
            }

            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }

            let _ = app.emit("deep-link-open", urls);
        }))
        .setup(|app| {
            let state = commands::init_state(&app.handle());
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::check_runtime_status,
            commands::start_runtime,
            commands::stop_runtime,
            commands::ensure_runtime,
            commands::start_gateway,
            commands::start_gateway_with_proxy,
            commands::stop_gateway,
            commands::restart_gateway,
            commands::get_gateway_status,
            commands::get_gateway_ws_url,
            commands::get_setup_progress,
            commands::run_first_time_setup,
            commands::set_api_key,
            commands::set_active_provider,
            commands::get_auth_state,
            commands::get_agent_profile_state,
            commands::set_personality,
            commands::sync_onboarding_to_settings,
            commands::set_heartbeat,
            commands::set_memory,
            commands::set_capabilities,
            commands::set_identity,
            commands::set_imessage_config,
            commands::set_channels_config,
            commands::start_whatsapp_login,
            commands::wait_whatsapp_login,
            commands::get_whatsapp_login,
            commands::approve_pairing,
            commands::upload_attachment,
            commands::save_attachment,
            commands::delete_attachment,
            commands::get_plugin_store,
            commands::set_plugin_enabled,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
