mod commands;
mod runtime;
mod windows_runtime_manager;

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
        .map(|home| home.join("entropic-runtime.log"))
        .unwrap_or_else(|| std::path::PathBuf::from("/tmp/entropic-runtime.log"))
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

fn managed_build_profile_enabled() -> bool {
    option_env!("ENTROPIC_BUILD_PROFILE")
        .map(|raw| raw.trim().eq_ignore_ascii_case("managed"))
        .unwrap_or(false)
}

pub fn maybe_handle_cli_mode() -> Option<i32> {
    windows_runtime_manager::maybe_handle_runtime_manager_cli()
}

pub fn run() {
    install_startup_panic_logger();

    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init());

    if managed_build_profile_enabled() {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

    builder
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            let urls: Vec<String> = args
                .into_iter()
                .filter(|arg| arg.starts_with("entropic://") || arg.starts_with("entropic-dev://"))
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
                fs::write(&salt_path, salt)
                    .map_err(|e| format!("Failed to write stronghold salt: {}", e))?;
            }

            app.handle()
                .plugin(tauri_plugin_stronghold::Builder::with_argon2(&salt_path).build())
                .map_err(|e| format!("Failed to init stronghold: {}", e))?;

            if let Err(err) = commands::migrate_legacy_nova_data_on_startup(app.handle()) {
                let msg = format!("legacy migration failed: {}", err);
                append_startup_log(&msg);
                eprintln!("[Entropic] {}", msg);
            }

            let state = commands::init_state(app.handle());
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::check_runtime_status,
            commands::get_runtime_version_info,
            commands::fetch_latest_openclaw_runtime,
            commands::append_client_log,
            commands::read_client_log,
            commands::clear_client_log,
            commands::export_client_log,
            commands::entropic_api_request_native,
            commands::start_runtime,
            commands::stop_runtime,
            commands::reset_isolated_runtime,
            commands::cleanup_app_data,
            commands::migrate_legacy_nova_data,
            commands::migrate_legacy_nova_install,
            commands::ensure_runtime,
            commands::start_gateway,
            commands::start_gateway_with_proxy,
            commands::stop_gateway,
            commands::restart_gateway,
            commands::update_gateway_model,
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
            commands::get_runtime_resource_usage,
            commands::get_apple_automation_status,
            commands::set_personality,
            commands::set_runtime_resources,
            commands::sync_onboarding_to_settings,
            commands::set_heartbeat,
            commands::set_memory,
            commands::set_memory_qmd_enabled,
            commands::set_memory_session_indexing,
            commands::set_capabilities,
            commands::set_identity,
            commands::set_channels_config,
            commands::start_whatsapp_login,
            commands::wait_whatsapp_login,
            commands::get_whatsapp_login,
            commands::approve_pairing,
            commands::get_telegram_connection_status,
            commands::validate_telegram_token,
            commands::send_telegram_welcome_message,
            commands::restart_gateway_in_place,
            commands::heal_gateway_config,
            commands::get_gateway_config_health,
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
            commands::should_use_localhost_oauth,
            commands::start_auth_localhost,
            commands::start_google_oauth,
            commands::refresh_google_token,
            commands::start_anthropic_oauth,
            commands::complete_anthropic_oauth,
            commands::start_openai_oauth,
            commands::get_device_fingerprint_hash,
            commands::get_gateway_device_identity,
            commands::sign_gateway_device_payload,
            commands::refresh_provider_token,
            commands::get_oauth_status,
            commands::browser_session_create,
            commands::browser_snapshot,
            commands::browser_navigate,
            commands::browser_reload,
            commands::browser_back,
            commands::browser_forward,
            commands::browser_click,
            commands::browser_session_close,
            commands::desktop_terminal_create,
            commands::desktop_terminal_snapshot,
            commands::desktop_terminal_write,
            commands::desktop_terminal_clear,
            commands::desktop_terminal_close,
            commands::run_chat_terminal_command,
            commands::generate_chat_image,
            commands::sync_embedded_preview_webview,
            commands::hide_embedded_preview_webview,
            commands::embedded_preview_reload,
            commands::embedded_preview_back,
            commands::embedded_preview_forward,
            commands::approve_gateway_device_pairing,
            commands::list_workspace_files,
            commands::create_workspace_directory,
            commands::read_workspace_file,
            commands::read_workspace_file_base64,
            commands::delete_workspace_file,
            commands::upload_workspace_file,
        ])
        .build(tauri::generate_context!())
        .unwrap_or_else(|error| {
            let msg = format!("error while building tauri application: {error}");
            append_startup_log(&msg);
            eprintln!("[Entropic] Startup build failed: {error}");
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
                        "[Entropic] Window close requested — hiding window (containers stay running)"
                    );
                    if let Some(window) = app_handle.get_webview_window(&label) {
                        let _ = window.hide();
                    }
                    api.prevent_close();
                }

                // On other platforms, closing window exits the app
                #[cfg(not(target_os = "macos"))]
                {
                    println!("[Entropic] Window close requested — preserving containers...");
                    let _ = (&app_handle, &label, &api);
                    commands::cleanup_on_exit();
                }
            }
            #[cfg(target_os = "macos")]
            RunEvent::Reopen { .. } => {
                if let Some(window) = app_handle.get_webview_window("main") {
                    let _ = window.unminimize();
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            RunEvent::Exit => {
                println!("[Entropic] App exiting — preserving containers...");
                commands::cleanup_on_exit();
            }
            _ => {}
        });
}
