use super::*;

const CLIENT_LOG_MAX_BYTES: u64 = 2 * 1024 * 1024;
const CLIENT_LOG_READ_MAX_BYTES: usize = 512 * 1024;

#[derive(Debug, Clone, serde::Serialize)]
pub struct RuntimeVersionInfo {
    pub entropic_version: String,
    pub runtime_version: String,
    pub runtime_openclaw_commit: Option<String>,
    pub applied_runtime_version: Option<String>,
    pub applied_runtime_openclaw_commit: Option<String>,
    pub applied_runtime_image_id: Option<String>,
    pub app_manifest_version: Option<String>,
    pub app_manifest_pub_date: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct RuntimeFetchResult {
    pub runtime_version: String,
    pub runtime_openclaw_commit: Option<String>,
    pub runtime_sha256: String,
    pub cache_path: String,
}

fn client_log_path() -> PathBuf {
    dirs::home_dir()
        .map(|home| home.join("entropic-runtime.log"))
        .unwrap_or_else(|| PathBuf::from("/tmp/entropic-runtime.log"))
}

fn append_client_log_line(message: &str) -> Result<(), String> {
    let path = client_log_path();
    if let Ok(meta) = fs::metadata(&path) {
        if meta.len() > CLIENT_LOG_MAX_BYTES {
            let _ = fs::write(&path, "");
        }
    }
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("Failed to open client log: {}", e))?;
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    use std::io::Write;
    writeln!(file, "[{}] [client] {}", ts, message)
        .map_err(|e| format!("Failed to write client log: {}", e))?;
    Ok(())
}

fn read_client_log_text(max_bytes: Option<usize>) -> Result<String, String> {
    let path = client_log_path();
    if !path.exists() {
        return Ok(String::new());
    }
    let bytes = fs::read(&path).map_err(|e| format!("Failed to read client log: {}", e))?;
    if bytes.is_empty() {
        return Ok(String::new());
    }

    let requested_max = max_bytes.unwrap_or(CLIENT_LOG_READ_MAX_BYTES);
    let safe_max = requested_max.max(1024);
    let clipped = if bytes.len() > safe_max {
        &bytes[bytes.len() - safe_max..]
    } else {
        &bytes[..]
    };

    Ok(String::from_utf8_lossy(clipped).to_string())
}

fn default_client_log_export_path() -> Result<PathBuf, String> {
    let base_dir = dirs::download_dir()
        .or_else(dirs::desktop_dir)
        .or_else(dirs::home_dir)
        .ok_or_else(|| "Could not resolve a directory to export logs".to_string())?;
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    Ok(base_dir.join(format!("entropic-runtime-{}.log", ts)))
}

pub fn migrate_legacy_nova_data_on_startup(app: &AppHandle) -> Result<(), String> {
    let log = migrate_legacy_nova_store_files(app)?;
    for line in log {
        println!("[Entropic] {}", line);
    }
    Ok(())
}

#[tauri::command]
pub async fn migrate_legacy_nova_data(app: AppHandle) -> Result<String, String> {
    Ok(migrate_legacy_nova_store_files(&app)?.join("\n"))
}

#[tauri::command]
pub async fn migrate_legacy_nova_install(
    app: AppHandle,
    cleanup_runtime: bool,
) -> Result<String, String> {
    let mut log = migrate_legacy_nova_store_files(&app)?;
    if cleanup_runtime {
        log.push("Running runtime cleanup after legacy data import...".to_string());
        let cleanup = cleanup_app_data(app.clone(), true).await?;
        log.extend(cleanup.lines().map(|line| line.to_string()));
    }
    Ok(log.join("\n"))
}

#[tauri::command]
pub fn fetch_latest_openclaw_runtime() -> Result<RuntimeFetchResult, String> {
    let manifest = fetch_runtime_manifest_to_cache()
        .map_err(|e| format!("Failed to refresh runtime manifest: {}", e))?;
    let tar_path = download_runtime_tar_from_manifest_to_cache(RUNTIME_TAR_MAX_TIME_SECS)?;
    let runtime_openclaw_commit = manifest
        .openclaw_commit
        .as_ref()
        .map(|commit| commit.trim().to_string())
        .filter(|commit| !commit.is_empty());

    Ok(RuntimeFetchResult {
        runtime_version: manifest.version,
        runtime_openclaw_commit,
        runtime_sha256: manifest.sha256,
        cache_path: tar_path.display().to_string(),
    })
}

#[tauri::command]
pub fn get_runtime_version_info() -> Result<RuntimeVersionInfo, String> {
    let entropic_version = env!("CARGO_PKG_VERSION").to_string();
    let mut runtime_version = runtime_release_tag();
    let mut runtime_openclaw_commit = None;
    let mut applied_runtime_version = None;
    let mut applied_runtime_openclaw_commit = None;
    let mut applied_runtime_image_id = None;
    let mut app_manifest_version = Some(entropic_version.clone());
    let mut app_manifest_pub_date = None;

    if let Some(manifest) = read_cached_runtime_manifest() {
        runtime_version = manifest.version;
        runtime_openclaw_commit = manifest
            .openclaw_commit
            .map(|commit| commit.trim().to_string())
            .filter(|commit| !commit.is_empty());
    }

    match runtime_image_id() {
        Ok(Some(image_id)) => {
            applied_runtime_image_id = Some(image_id.clone());
            if let Some((version, commit)) = resolve_applied_runtime_from_cache(&image_id) {
                applied_runtime_version = Some(version);
                applied_runtime_openclaw_commit = commit;
            } else if let Some(local_tar) = find_local_runtime_tar() {
                if runtime_image_matches_tar(&image_id, &local_tar) {
                    applied_runtime_version = Some("local".to_string());
                }
            }
        }
        Ok(None) => {}
        Err(err) => {
            println!(
                "[Entropic] Failed to inspect runtime image for version info: {}",
                err
            );
        }
    }

    if let Some(cached_manifest) = read_cached_app_manifest() {
        app_manifest_version = Some(cached_manifest.version);
        app_manifest_pub_date = cached_manifest.pub_date;
    }

    if app_manifest_fetch_enabled() {
        match resolve_app_manifest() {
            Ok(manifest) => {
                app_manifest_version = Some(manifest.version);
                app_manifest_pub_date = manifest.pub_date;
            }
            Err(err) => {
                println!(
                    "[Entropic] Failed to resolve app manifest version info: {}",
                    err
                );
            }
        }
    }

    Ok(RuntimeVersionInfo {
        entropic_version,
        runtime_version,
        runtime_openclaw_commit,
        applied_runtime_version,
        applied_runtime_openclaw_commit,
        applied_runtime_image_id,
        app_manifest_version,
        app_manifest_pub_date,
    })
}

#[tauri::command]
pub async fn check_runtime_status(app: AppHandle) -> Result<RuntimeStatus, String> {
    Ok(RuntimeSupervisor::new(&app).check_status())
}

#[tauri::command]
pub async fn append_client_log(message: String) -> Result<(), String> {
    let compact = message
        .replace('\n', " ")
        .replace('\r', " ")
        .trim()
        .to_string();
    if compact.is_empty() {
        return Ok(());
    }

    let max_chars = 1200usize;
    let total_chars = compact.chars().count();
    let mut clipped: String = compact.chars().take(max_chars).collect();
    if total_chars > max_chars {
        clipped.push_str("...");
    }

    append_client_log_line(&clipped)
}

#[tauri::command]
pub async fn read_client_log(max_bytes: Option<usize>) -> Result<String, String> {
    read_client_log_text(max_bytes)
}

#[tauri::command]
pub async fn clear_client_log() -> Result<(), String> {
    let path = client_log_path();
    fs::write(path, "").map_err(|e| format!("Failed to clear client log: {}", e))
}

#[tauri::command]
pub async fn export_client_log() -> Result<String, String> {
    let log_text = read_client_log_text(None)?;
    let export_path = default_client_log_export_path()?;
    fs::write(&export_path, log_text).map_err(|e| {
        format!(
            "Failed to export client log to {}: {}",
            export_path.display(),
            e
        )
    })?;
    Ok(export_path.display().to_string())
}

#[tauri::command]
pub async fn list_operational_incidents(
    app: AppHandle,
    limit: Option<usize>,
) -> Result<Vec<IncidentRecord>, String> {
    operational::read_recent_incidents(&app, limit)
}

#[tauri::command]
pub async fn clear_operational_incidents(app: AppHandle) -> Result<(), String> {
    operational::clear_incidents(&app)
}

#[tauri::command]
pub async fn get_operational_health(app: AppHandle) -> Result<OperationalHealthSnapshot, String> {
    build_operational_health_snapshot(&app)
}

#[tauri::command]
pub async fn start_runtime(app: AppHandle) -> Result<(), String> {
    RuntimeSupervisor::new(&app)
        .start()
        .map_err(append_colima_runtime_hint)
}

#[tauri::command]
pub async fn stop_runtime(app: AppHandle) -> Result<(), String> {
    clear_desired_gateway_state(&app)?;
    RuntimeSupervisor::new(&app).stop()
}

#[tauri::command]
pub async fn cleanup_app_data(app: AppHandle, include_vms: bool) -> Result<String, String> {
    use std::fs;

    let runtime = get_runtime(&app);
    let mut cleanup_log = Vec::<String>::new();

    // Stop runtime first
    cleanup_log.push("Stopping runtime...".to_string());
    if let Err(e) = runtime.stop_colima() {
        cleanup_log.push(format!("Warning: Failed to stop runtime: {}", e));
    } else {
        cleanup_log.push("Runtime stopped successfully".to_string());
    }

    // Clean up Docker resources if requested
    if include_vms {
        cleanup_log.push("Cleaning up Docker resources...".to_string());
        stop_legacy_nova_runtime_processes(&mut cleanup_log);

        let home_dir = dirs::home_dir().ok_or("Could not find home directory")?;
        let docker_bin = find_docker_binary();
        let colima_bin = find_colima_binary();

        // Try to clean up Docker using shell commands
        let colima_homes = vec![
            home_dir.join(".nova").join("colima"),
            home_dir.join(".nova").join("colima-dev"),
            home_dir.join(".entropic").join("colima"),
            home_dir.join(".entropic").join("colima-dev"),
        ];
        let profiles = vec![
            ENTROPIC_VZ_PROFILE,
            ENTROPIC_QEMU_PROFILE,
            LEGACY_NOVA_VZ_PROFILE,
            LEGACY_NOVA_QEMU_PROFILE,
        ];

        for colima_home in &colima_homes {
            for profile in &profiles {
                let socket = colima_home.join(profile).join("docker.sock");
                if socket.exists() {
                    let host = format!("unix://{}", socket.display());

                    // Remove containers
                    let _ = std::process::Command::new(&docker_bin)
                        .args(&["ps", "-aq"])
                        .env("DOCKER_HOST", &host)
                        .output()
                        .and_then(|out| {
                            let containers = String::from_utf8_lossy(&out.stdout);
                            for container_id in containers.lines().filter(|l| !l.trim().is_empty())
                            {
                                let _ = std::process::Command::new(&docker_bin)
                                    .args(&["rm", "-f", container_id])
                                    .env("DOCKER_HOST", &host)
                                    .output();
                            }
                            Ok(())
                        });

                    // System prune
                    let _ = std::process::Command::new(&docker_bin)
                        .args(&["system", "prune", "-af", "--volumes"])
                        .env("DOCKER_HOST", &host)
                        .output();
                }
            }
        }

        cleanup_log.push("Docker cleanup completed".to_string());

        // Delete Colima VMs
        cleanup_log.push("Deleting Colima VMs...".to_string());
        for colima_home in &colima_homes {
            let prefix = if colima_home.to_string_lossy().contains(&format!(
                "{}{}",
                std::path::MAIN_SEPARATOR,
                ".nova"
            )) {
                "Removing legacy"
            } else {
                "Removing runtime"
            };
            cleanup_log.push(format!("{} {}...", prefix, colima_home.display()));
            for profile in &profiles {
                let _ = std::process::Command::new(&colima_bin)
                    .args(&["delete", "-f", "-p", profile])
                    .env("COLIMA_HOME", colima_home)
                    .env("LIMA_HOME", colima_home.join("_lima"))
                    .output();
            }
        }
        cleanup_log.push("Colima VMs deleted".to_string());

        // Remove Docker contexts left behind by old installs
        cleanup_log.push("Cleaning up Docker contexts...".to_string());
        for context in &[
            "colima-nova-vz",
            "colima-nova-qemu",
            "colima-entropic-vz",
            "colima-entropic-qemu",
        ] {
            let _ = std::process::Command::new(&docker_bin)
                .args(&["context", "rm", "-f", context])
                .output();
        }
        cleanup_log.push("Docker contexts cleaned".to_string());

        // Remove runtime state directories from both naming eras.
        for runtime_dir in [home_dir.join(".nova"), home_dir.join(".entropic")] {
            if runtime_dir.exists() {
                if let Err(e) = fs::remove_dir_all(&runtime_dir) {
                    cleanup_log.push(format!(
                        "Warning: Failed to remove {}: {}",
                        runtime_dir.display(),
                        e
                    ));
                } else {
                    cleanup_log.push(format!("Removed {}", runtime_dir.display()));
                }
            }
        }
    }

    // Full cleanup: remove ALL app data, caches, and stores (chat history, settings, etc.)
    // Mirrors: rm -rf ~/Library/Application Support/ai.openclaw.entropic{,.dev}
    //                  ~/Library/Caches/entropic{,-dev}
    //                  ~/.cache/entropic
    cleanup_log.push("Cleaning up all app data and caches...".to_string());
    let home_dir = dirs::home_dir().ok_or("Could not find home directory")?;
    // Kill any legacy Nova processes that may be holding open file handles
    // in the old app data directory, which would cause "permission denied" on removal.
    let _ = std::process::Command::new("pkill")
        .args(&["-9", "-f", "Nova.app"])
        .output();

    let dirs_to_remove = vec![
        // App data (Tauri stores: chat history, settings, auth)
        home_dir.join("Library/Application Support/ai.openclaw.entropic"),
        home_dir.join("Library/Application Support/ai.openclaw.entropic.dev"),
        // Legacy nova app data (older installs may have permission-locked files here)
        home_dir.join("Library/Application Support/ai.openclaw.nova"),
        // App caches
        home_dir.join("Library/Caches/entropic"),
        home_dir.join("Library/Caches/entropic-dev"),
        home_dir.join(".cache/entropic"),
    ];
    for dir in &dirs_to_remove {
        if dir.exists() {
            // Fix permissions before removal — older installs may have locked files
            let _ = std::process::Command::new("chmod")
                .args(&["-R", "u+w", &dir.to_string_lossy().to_string()])
                .output();
            if let Err(e) = fs::remove_dir_all(dir) {
                cleanup_log.push(format!(
                    "Warning: Failed to remove {}: {}",
                    dir.display(),
                    e
                ));
            } else {
                cleanup_log.push(format!("Removed {}", dir.display()));
            }
        }
    }

    cleanup_log.push("Cleanup completed successfully!".to_string());
    Ok(cleanup_log.join("\n"))
}

#[tauri::command]
pub async fn ensure_runtime(app: AppHandle) -> Result<RuntimeStatus, String> {
    RuntimeSupervisor::new(&app)
        .ensure_ready()
        .map_err(append_colima_runtime_hint)
}

async fn run_first_time_setup_internal(
    app: AppHandle,
    state: State<'_, AppState>,
    cleanup_before_start: bool,
) -> Result<(), String> {
    let runtime = get_runtime(&app);

    if cleanup_before_start && matches!(Platform::detect(), Platform::MacOS) {
        {
            let mut progress = state.setup_progress.lock().map_err(|e| e.to_string())?;
            *progress = SetupProgress {
                stage: "cleanup".to_string(),
                message: "Cleaning Entropic isolated container runtime state...".to_string(),
                percent: 5,
                complete: false,
                error: None,
            };
        }

        if let Err(e) = runtime.reset_isolated_runtime_state() {
            let mut progress = state.setup_progress.lock().map_err(|e| e.to_string())?;
            *progress = SetupProgress {
                stage: "error".to_string(),
                message: "Failed to clean isolated runtime".to_string(),
                percent: 0,
                complete: false,
                error: Some(format!(
                    "Entropic could not clean its isolated Colima runtime: {}",
                    e
                )),
            };
            return Err(format!("Failed to clean isolated runtime: {}", e));
        }
    }

    let mut status = runtime.check_status();

    if matches!(Platform::detect(), Platform::MacOS) {
        if !status.colima_installed && !status.docker_installed {
            let mut progress = state.setup_progress.lock().map_err(|e| e.to_string())?;
            *progress = SetupProgress {
                stage: "error".to_string(),
                message: "Docker not found".to_string(),
                percent: 0,
                complete: false,
                error: Some("Neither Colima runtime nor Docker Desktop found. Please install Docker Desktop for development.".to_string()),
            };
            return Err("Docker not found".to_string());
        }

        if status.colima_installed && !status.vm_running && !status.docker_ready {
            {
                let mut progress = state.setup_progress.lock().map_err(|e| e.to_string())?;
                *progress = SetupProgress {
                    stage: "vm".to_string(),
                    message: "Starting container runtime...".to_string(),
                    percent: 10,
                    complete: false,
                    error: None,
                };
            }

            let resources_dir = app.path().resource_dir().unwrap_or_default();
            let colima_result =
                std::sync::Arc::new(std::sync::Mutex::new(None::<Result<(), String>>));
            let colima_result_writer = colima_result.clone();
            let colima_thread = std::thread::spawn(move || {
                let rt = Runtime::new(resources_dir);
                let result = rt.start_colima().map_err(|e| format!("{}", e));
                *colima_result_writer.lock().unwrap() = Some(result);
            });

            let runtime_download_result =
                std::sync::Arc::new(std::sync::Mutex::new(None::<Result<PathBuf, String>>));
            let runtime_download_started =
                find_local_runtime_tar().is_none() && !runtime_cached_tar_valid();
            let runtime_download_thread = if runtime_download_started {
                let runtime_download_result_writer = runtime_download_result.clone();
                Some(std::thread::spawn(move || {
                    let result =
                        download_runtime_tar_to_cache(true, RUNTIME_TAR_SETUP_MAX_TIME_SECS);
                    *runtime_download_result_writer.lock().unwrap() = Some(result);
                }))
            } else {
                None
            };

            let cache_dir = dirs::home_dir()
                .unwrap_or_default()
                .join(".cache/colima/caches");
            const EXPECTED_DOWNLOAD_SIZE: u64 = 280 * 1024 * 1024;

            loop {
                std::thread::sleep(std::time::Duration::from_millis(500));

                if colima_result.lock().unwrap().is_some() {
                    break;
                }

                let download_size = std::fs::read_dir(&cache_dir)
                    .ok()
                    .map(|entries| {
                        entries
                            .filter_map(|e| e.ok())
                            .filter(|e| {
                                e.path().extension().is_some_and(|ext| ext == "downloading")
                            })
                            .filter_map(|e| e.metadata().ok().map(|m| m.len()))
                            .max()
                            .unwrap_or(0)
                    })
                    .unwrap_or(0);

                let runtime_partial_mb = runtime_cached_tar_partial_path()
                    .and_then(|path| path.metadata().ok().map(|m| m.len() / (1024 * 1024)))
                    .unwrap_or(0);
                let runtime_note = if runtime_download_started {
                    if runtime_download_result.lock().unwrap().is_some() {
                        " • Runtime image download complete".to_string()
                    } else if runtime_partial_mb > 0 {
                        format!(" • Runtime image {} MB", runtime_partial_mb)
                    } else {
                        " • Starting runtime image download...".to_string()
                    }
                } else {
                    " • Runtime image already cached".to_string()
                };

                let (message, percent) = if download_size > 0 {
                    let mb = download_size / (1024 * 1024);
                    let pct =
                        std::cmp::min(35, 10 + (download_size * 25 / EXPECTED_DOWNLOAD_SIZE) as u8);
                    (
                        format!("Downloading VM image... ({} MB){}", mb, runtime_note),
                        pct,
                    )
                } else {
                    (format!("Starting container runtime...{}", runtime_note), 10)
                };

                if let Ok(mut progress) = state.setup_progress.lock() {
                    *progress = SetupProgress {
                        stage: "vm".to_string(),
                        message,
                        percent,
                        complete: false,
                        error: None,
                    };
                }
            }

            let _ = colima_thread.join();
            let result = colima_result
                .lock()
                .unwrap()
                .take()
                .unwrap_or_else(|| Err("Colima thread did not produce a result".to_string()));

            if let Err(e) = result {
                if let Some(handle) = runtime_download_thread {
                    let _ = handle.join();
                }
                let mut progress = state.setup_progress.lock().map_err(|e| e.to_string())?;
                *progress = SetupProgress {
                    stage: "error".to_string(),
                    message: "Failed to start container runtime".to_string(),
                    percent: 0,
                    complete: false,
                    error: Some(append_colima_runtime_hint(format!(
                        "Failed to start Colima: {}",
                        e
                    ))),
                };
                return Err(append_colima_runtime_hint(format!(
                    "Failed to start Colima: {}",
                    e
                )));
            }

            {
                let mut progress = state.setup_progress.lock().map_err(|e| e.to_string())?;
                *progress = SetupProgress {
                    stage: "vm".to_string(),
                    message: "Container runtime started, waiting for Docker...".to_string(),
                    percent: 40,
                    complete: false,
                    error: None,
                };
            }

            let max_retries = 30;
            for i in 0..max_retries {
                std::thread::sleep(std::time::Duration::from_secs(2));
                status = runtime.check_status();
                if status.docker_ready {
                    break;
                }
                {
                    let runtime_partial_mb = runtime_cached_tar_partial_path()
                        .and_then(|path| path.metadata().ok().map(|m| m.len() / (1024 * 1024)))
                        .unwrap_or(0);
                    let runtime_note = if runtime_download_started {
                        if runtime_download_result.lock().unwrap().is_some() {
                            " • Runtime image download complete".to_string()
                        } else if runtime_partial_mb > 0 {
                            format!(" • Runtime image {} MB", runtime_partial_mb)
                        } else {
                            " • Starting runtime image download...".to_string()
                        }
                    } else {
                        " • Runtime image already cached".to_string()
                    };
                    let mut progress = state.setup_progress.lock().map_err(|e| e.to_string())?;
                    *progress = SetupProgress {
                        stage: "docker".to_string(),
                        message: format!(
                            "Waiting for Docker to start ({}/{}s)...{}",
                            (i + 1) * 2,
                            max_retries * 2,
                            runtime_note
                        ),
                        percent: 40 + ((i as u8) * 30 / max_retries as u8),
                        complete: false,
                        error: None,
                    };
                }
            }

            if let Some(download_thread) = runtime_download_thread {
                while runtime_download_result.lock().unwrap().is_none() {
                    std::thread::sleep(std::time::Duration::from_millis(500));
                    let runtime_partial_mb = runtime_cached_tar_partial_path()
                        .and_then(|path| path.metadata().ok().map(|m| m.len() / (1024 * 1024)))
                        .unwrap_or(0);
                    let mut progress = state.setup_progress.lock().map_err(|e| e.to_string())?;
                    *progress = SetupProgress {
                        stage: "image".to_string(),
                        message: format!(
                            "Downloading OpenClaw runtime image... ({} MB)",
                            runtime_partial_mb
                        ),
                        percent: 72,
                        complete: false,
                        error: None,
                    };
                }
                let _ = download_thread.join();
                if let Some(Err(err)) = runtime_download_result.lock().unwrap().take() {
                    println!(
                        "[Entropic] Runtime tar prefetch failed during setup: {}",
                        err
                    );
                }
            }
        }
    }

    {
        let mut progress = state.setup_progress.lock().map_err(|e| e.to_string())?;
        *progress = SetupProgress {
            stage: "docker".to_string(),
            message: "Verifying Docker connection...".to_string(),
            percent: 70,
            complete: false,
            error: None,
        };
    }

    status = runtime.check_status();

    if !status.docker_ready {
        let error_msg = if matches!(Platform::detect(), Platform::MacOS) {
            append_colima_runtime_hint(
                "Docker connection failed. The container runtime may still be starting - try again in a moment."
                    .to_string(),
            )
        } else {
            "Please install Docker and ensure the daemon is running.".to_string()
        };
        let mut progress = state.setup_progress.lock().map_err(|e| e.to_string())?;
        *progress = SetupProgress {
            stage: "error".to_string(),
            message: "Docker is not available".to_string(),
            percent: 0,
            complete: false,
            error: Some(error_msg),
        };
        return Err("Docker not available".to_string());
    }

    {
        let mut progress = state.setup_progress.lock().map_err(|e| e.to_string())?;
        *progress = SetupProgress {
            stage: "image".to_string(),
            message: "Preparing OpenClaw runtime image...".to_string(),
            percent: 75,
            complete: false,
            error: None,
        };
    }

    let preload_started = Instant::now();
    let preload = tokio::task::spawn_blocking(ensure_runtime_image).await;
    let preload_message = match preload {
        Ok(Ok(())) => {
            println!(
                "[Entropic] Runtime image preload finished in {}ms",
                preload_started.elapsed().as_millis()
            );
            "Runtime image ready.".to_string()
        }
        Ok(Err(e)) => {
            println!("[Entropic] Runtime image preload deferred/failed: {}", e);
            "Runtime image preload deferred; first sandbox start will retry.".to_string()
        }
        Err(e) => {
            println!("[Entropic] Runtime image preload task error: {}", e);
            "Runtime image preload deferred; first sandbox start will retry.".to_string()
        }
    };

    {
        let mut progress = state.setup_progress.lock().map_err(|e| e.to_string())?;
        *progress = SetupProgress {
            stage: "image".to_string(),
            message: preload_message,
            percent: 90,
            complete: false,
            error: None,
        };
    }

    {
        let mut progress = state.setup_progress.lock().map_err(|e| e.to_string())?;
        *progress = SetupProgress {
            stage: "complete".to_string(),
            message: "Setup complete!".to_string(),
            percent: 100,
            complete: true,
            error: None,
        };
    }

    Ok(())
}

#[tauri::command]
pub async fn get_setup_progress(state: State<'_, AppState>) -> Result<SetupProgress, String> {
    let progress = state.setup_progress.lock().map_err(|e| e.to_string())?;
    Ok(progress.clone())
}

#[tauri::command]
pub async fn run_first_time_setup(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    run_first_time_setup_internal(app, state, false).await
}

#[tauri::command]
pub async fn run_first_time_setup_with_cleanup(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    run_first_time_setup_internal(app, state, true).await
}
