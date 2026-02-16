mod commands;
mod runtime;

use rand::RngCore;
use std::fs;
use std::fs::OpenOptions;
use std::io::Write;
use std::panic::{self, PanicHookInfo};
use std::process;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{Emitter, Manager, RunEvent, WindowEvent};

const STARTUP_LOG_MAX_BYTES: u64 = 2 * 1024 * 1024;

fn startup_error_log_path() -> std::path::PathBuf {
    dirs::home_dir()
        .map(|home| home.join("nova-runtime.log"))
        .unwrap_or_else(|| std::path::PathBuf::from("/tmp/nova-runtime.log"))
}

fn append_startup_log(message: &str) {
    let log_path = startup_error_log_path();
    if let Ok(meta) = fs::metadata(&log_path) {
        if meta.len() > STARTUP_LOG_MAX_BYTES {
            let _ = fs::write(&log_path, "");
        }
    }
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&log_path) {
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let _ = writeln!(file, "[{}] [startup] {}", ts, message);
    }
}

fn panic_payload_to_string(info: &PanicHookInfo) -> String {
    if let Some(s) = info.payload().downcast_ref::<&str>() {
        return s.to_string();
    }
    if let Some(s) = info.payload().downcast_ref::<String>() {
        return s.clone();
    }
    if let Some(location) = info.location() {
        return format!("panic at {}:{}", location.file(), location.line());
    }
    "panic payload unavailable".to_string()
}

fn install_startup_panic_logger() {
    let previous = panic::take_hook();
    panic::set_hook(Box::new(move |info| {
        let payload = panic_payload_to_string(info);
        let location = info.location().map_or_else(
            || "unknown location".to_string(),
            |l| format!("{}:{}", l.file(), l.line()),
        );
        let backtrace = std::backtrace::Backtrace::capture();
        let msg = format!(
            "PANIC: payload={payload} location={location} backtrace={:?}",
            backtrace
        );
        append_startup_log(&msg);
        previous(info);
    }));
}

pub fn run() {
    install_startup_panic_logger();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            let urls: Vec<String> = args
                .into_iter()
                .filter(|arg| arg.starts_with("nova://") || arg.starts_with("nova-dev://"))
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
            let data_dir = app
                .path()
                .app_data_dir()
                .map_err(|_| "Failed to resolve app data dir".to_string())?;
            fs::create_dir_all(&data_dir)
                .map_err(|e| format!("Failed to create app data dir: {}", e))?;
            let salt_path = data_dir.join("stronghold.salt");
            if !salt_path.exists() {
                let mut salt = [0u8; 32];
                rand::thread_rng().fill_bytes(&mut salt);
                fs::write(&salt_path, &salt)
                    .map_err(|e| format!("Failed to write stronghold salt: {}", e))?;
            }

            app.handle()
                .plugin(tauri_plugin_stronghold::Builder::with_argon2(&salt_path).build())
                .map_err(|e| format!("Failed to init stronghold: {}", e))?;

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
            commands::get_gateway_auth,
            commands::get_setup_progress,
            commands::run_first_time_setup,
            commands::run_first_time_setup_with_cleanup,
            commands::set_api_key,
            commands::set_active_provider,
            commands::get_auth_state,
            commands::get_agent_profile_state,
            commands::set_personality,
            commands::sync_onboarding_to_settings,
            commands::set_heartbeat,
            commands::set_memory,
            commands::set_memory_session_indexing,
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
            commands::get_skill_store,
            commands::get_clawhub_catalog,
            commands::get_clawhub_skill_details,
            commands::remove_workspace_skill,
            commands::set_plugin_enabled,
            commands::scan_plugin,
            commands::scan_workspace_skill,
            commands::scan_and_install_clawhub_skill,
            commands::start_auth_localhost,
            commands::start_google_oauth,
            commands::refresh_google_token,
            commands::list_workspace_files,
            commands::read_workspace_file,
            commands::read_workspace_file_base64,
            commands::delete_workspace_file,
            commands::upload_workspace_file,
        ])
        .build(tauri::generate_context!())
        .unwrap_or_else(|error| {
            let msg = format!("error while building tauri application: {error}");
            append_startup_log(&msg);
            eprintln!("[Nova] Startup build failed: {error}");
            process::exit(1);
        })
        .run(|app_handle, event| match event {
            RunEvent::WindowEvent {
                label,
                event: WindowEvent::CloseRequested { api, .. },
                ..
            } => {
                // On macOS, closing window should just hide it (keep app running in dock)
                // Only stop containers on actual app quit (Cmd+Q)
                #[cfg(target_os = "macos")]
                {
                    println!(
                        "[Nova] Window close requested — hiding window (containers stay running)"
                    );
                    if let Some(window) = app_handle.get_webview_window(&label) {
                        let _ = window.hide();
                    }
                    api.prevent_close();
                }

                // On other platforms, closing window exits the app
                #[cfg(not(target_os = "macos"))]
                {
                    println!("[Nova] Window close requested — preserving containers...");
                    commands::cleanup_on_exit();
                }
            }
            RunEvent::Exit => {
                println!("[Nova] App exiting — preserving containers...");
                commands::cleanup_on_exit();
            }
            _ => {}
        });
}
