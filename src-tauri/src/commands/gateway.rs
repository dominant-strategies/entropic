use super::*;

#[tauri::command]
pub async fn start_gateway(
    app: AppHandle,
    _state: State<'_, AppState>,
    model: Option<String>,
) -> Result<(), String> {
    let desired = watchdog::desired_state_with_mode("local", model.clone(), None, None, None);
    set_desired_gateway_state(&app, desired)?;
    watchdog::mark_expected_restart(WATCHDOG_EXPECTED_RESTART_WINDOW_MS);
    if let Err(error) = start_gateway_internal(&app, model, "start_requested").await {
        watchdog::clear_expected_restart();
        return Err(error);
    }
    Ok(())
}

#[tauri::command]
pub async fn stop_gateway(app: AppHandle) -> Result<(), String> {
    clear_desired_gateway_state(&app)?;
    operational::record_incident(
        &app,
        "info",
        "gateway",
        "stop_requested",
        "Stopping gateway containers",
        None,
    );
    stop_scanner_sidecar();

    for name in [OPENCLAW_CONTAINER, LEGACY_OPENCLAW_CONTAINER] {
        let stop = docker_command()
            .args(["stop", name])
            .output()
            .map_err(|e| format!("Failed to stop container: {}", e))?;

        if !stop.status.success() {
            // Container might not be running, that's OK
            let stderr = String::from_utf8_lossy(&stop.stderr);
            if !stderr.contains("No such container") {
                return Err(format!("Failed to stop container {}: {}", name, stderr));
            }
        }
    }

    operational::record_incident(
        &app,
        "info",
        "gateway",
        "stop_succeeded",
        "Gateway containers stopped",
        None,
    );
    Ok(())
}

#[tauri::command]
pub async fn start_gateway_with_proxy(
    app: AppHandle,
    _state: State<'_, AppState>,
    gateway_token: String,
    proxy_url: String,
    model: String,
    image_model: Option<String>,
) -> Result<(), String> {
    let desired = watchdog::desired_state_with_mode(
        "proxy",
        Some(model.clone()),
        image_model.clone(),
        Some(gateway_token.clone()),
        Some(proxy_url.clone()),
    );
    set_desired_gateway_state(&app, desired)?;
    watchdog::mark_expected_restart(WATCHDOG_EXPECTED_RESTART_WINDOW_MS);
    if let Err(error) = start_gateway_with_proxy_internal(
        &app,
        gateway_token,
        proxy_url,
        model,
        image_model,
        "proxy_start_requested",
    )
    .await
    {
        watchdog::clear_expected_restart();
        return Err(error);
    }
    Ok(())
}

#[tauri::command]
pub fn update_gateway_model(model: String) -> Result<(), String> {
    let base_model = model.split(':').next().unwrap_or(&model);
    let thinking_enabled = model.contains(":thinking");
    let reasoning_effort = model
        .split(':')
        .find_map(|s| s.strip_prefix("reasoning="))
        .unwrap_or("");

    let thinking_level = if thinking_enabled {
        "high"
    } else if !reasoning_effort.is_empty() {
        reasoning_effort
    } else {
        "off"
    };

    let mut cfg = read_openclaw_config();
    normalize_openclaw_config(&mut cfg);
    set_openclaw_config_value(
        &mut cfg,
        &["agents", "defaults", "model", "primary"],
        serde_json::json!(base_model),
    );

    if thinking_level != "off" {
        set_openclaw_config_value(
            &mut cfg,
            &["agents", "defaults", "thinkingDefault"],
            serde_json::json!(thinking_level),
        );
    } else {
        set_openclaw_config_value(
            &mut cfg,
            &["agents", "defaults", "thinkingDefault"],
            serde_json::json!("off"),
        );
    }

    println!(
        "[Entropic] update_gateway_model: hot-swapping model to {} (thinking={})",
        base_model, thinking_level
    );
    write_openclaw_config(&cfg)
}

#[tauri::command]
pub async fn restart_gateway(
    app: AppHandle,
    _state: State<'_, AppState>,
    model: Option<String>,
) -> Result<(), String> {
    let desired = watchdog::desired_state_with_mode("local", model.clone(), None, None, None);
    set_desired_gateway_state(&app, desired)?;
    watchdog::mark_expected_restart(WATCHDOG_EXPECTED_RESTART_WINDOW_MS);
    // Stop and remove existing container (to pick up new env vars)
    for name in [OPENCLAW_CONTAINER, LEGACY_OPENCLAW_CONTAINER] {
        let _ = docker_command().args(["stop", name]).output();
        let _ = docker_command().args(["rm", "-f", name]).output();
    }

    // Start with current API keys
    if let Err(error) = start_gateway_internal(&app, model, "restart_requested").await {
        watchdog::clear_expected_restart();
        return Err(error);
    }
    Ok(())
}

#[tauri::command]
pub async fn get_gateway_status(app: AppHandle) -> Result<bool, String> {
    get_gateway_status_internal(&app).await
}

#[tauri::command]
pub async fn get_gateway_ws_url() -> Result<String, String> {
    Ok(gateway_ws_url())
}

#[tauri::command]
pub async fn get_gateway_auth(app: AppHandle) -> Result<GatewayAuthPayload, String> {
    Ok(GatewayAuthPayload {
        ws_url: gateway_ws_url(),
        token: effective_gateway_token(&app)?,
    })
}

#[tauri::command]
pub async fn restart_gateway_in_place(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let container = if named_gateway_container_exists(OPENCLAW_CONTAINER, false) {
        OPENCLAW_CONTAINER
    } else if named_gateway_container_exists(LEGACY_OPENCLAW_CONTAINER, false) {
        LEGACY_OPENCLAW_CONTAINER
    } else {
        return Err("Gateway container is not available. Start runtime first.".to_string());
    };

    let restart = docker_command()
        .args(["restart", container])
        .output()
        .map_err(|e| append_colima_runtime_hint(format!("Failed to restart gateway: {}", e)))?;

    if !restart.status.success() {
        let stderr = String::from_utf8_lossy(&restart.stderr);
        return Err(append_colima_runtime_hint(format!(
            "Failed to restart gateway: {}",
            stderr.trim()
        )));
    }

    // The config directory (/home/node/.openclaw) is a tmpfs mount that gets
    // wiped on every container restart.  Re-apply persisted agent settings
    // (including Telegram channel config) so the gateway starts with the
    // correct configuration.
    clear_applied_agent_settings_fingerprint()?;
    apply_agent_settings(&app, &state)?;
    // Ensure the gateway picks up the config even if the file watcher missed
    // the write (it may not be active yet right after a container restart).
    signal_gateway_config_reload();

    // The config written by apply_agent_settings differs from the entrypoint's
    // initial config (it adds channels, telegram, allowedOrigins, etc.), which
    // triggers the gateway's file watcher → SIGUSR1 → brief internal restart.
    // Wait for the gateway to come back healthy so callers (and the frontend)
    // don't see a jarring disconnect/error when navigating back to chat.
    if let Ok(token) = effective_gateway_token(&app) {
        eprintln!(
            "[Entropic] restart_gateway_in_place: waiting for gateway health after config apply..."
        );
        tokio::time::sleep(std::time::Duration::from_millis(2000)).await;
        match wait_for_gateway_health_strict(&token, 20).await {
            Ok(()) => eprintln!("[Entropic] restart_gateway_in_place: gateway healthy"),
            Err(e) => eprintln!(
                "[Entropic] restart_gateway_in_place: health wait timed out (non-fatal): {}",
                e
            ),
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn heal_gateway_config() -> Result<GatewayHealResult, String> {
    let (doctor_output, container_used) = run_gateway_doctor_with_fallback(true)?;
    if !doctor_output.status.success() {
        return Err(format!(
            "Doctor fix failed: {}",
            command_output_error(&doctor_output).trim()
        ));
    }

    let restarted = if let Some(container) = container_used {
        let restart = docker_command()
            .args(["restart", container])
            .output()
            .map_err(|e| append_colima_runtime_hint(format!("Failed to restart gateway: {}", e)))?;

        if !restart.status.success() {
            let stderr = String::from_utf8_lossy(&restart.stderr);
            return Err(append_colima_runtime_hint(format!(
                "Failed to restart gateway after heal: {}",
                stderr.trim()
            )));
        }
        true
    } else {
        false
    };

    let container = if let Some(name) = container_used {
        name.to_string()
    } else if let Some(name) = existing_gateway_container_name() {
        name.to_string()
    } else {
        "none".to_string()
    };

    let message = if restarted {
        "Gateway config healed via doctor --fix and container restart.".to_string()
    } else {
        "Gateway config healed via doctor --fix. Start gateway to apply healed config.".to_string()
    };

    Ok(GatewayHealResult {
        container,
        restarted,
        message,
    })
}

#[tauri::command]
pub async fn get_gateway_config_health() -> Result<GatewayConfigHealth, String> {
    let (output, container_used) = match run_gateway_doctor_with_fallback(false) {
        Ok(result) => result,
        Err(err) => {
            return Ok(GatewayConfigHealth {
                status: "offline".to_string(),
                summary: err,
                issues: Vec::new(),
            });
        }
    };

    let checked_offline = container_used.is_none();
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let combined = format!("{}\n{}", stdout, stderr);
    let combined_trimmed = combined.trim();

    let has_invalid_config =
        combined.contains("Invalid config at") || combined.contains("Config invalid");
    if has_invalid_config {
        let issues = extract_doctor_problem_lines(combined_trimmed);
        let summary = if issues.is_empty() {
            if checked_offline {
                "Gateway config is invalid (offline check).".to_string()
            } else {
                "Gateway config is invalid.".to_string()
            }
        } else if checked_offline {
            format!(
                "Gateway config is invalid (offline check, {} issue(s)).",
                issues.len()
            )
        } else {
            format!("Gateway config is invalid ({} issue(s)).", issues.len())
        };
        return Ok(GatewayConfigHealth {
            status: "invalid".to_string(),
            summary,
            issues,
        });
    }

    if !output.status.success() {
        let mut message = if !stderr.trim().is_empty() {
            stderr.trim().to_string()
        } else if !stdout.trim().is_empty() {
            stdout.trim().to_string()
        } else {
            "Gateway config check failed.".to_string()
        };
        if checked_offline {
            message = format!("Offline config check failed: {}", message);
        }
        return Ok(GatewayConfigHealth {
            status: "error".to_string(),
            summary: message,
            issues: Vec::new(),
        });
    }

    let summary = if checked_offline {
        "Gateway config is valid (checked from data volume while gateway is stopped).".to_string()
    } else {
        "Gateway config is valid.".to_string()
    };
    Ok(GatewayConfigHealth {
        status: "ok".to_string(),
        summary,
        issues: Vec::new(),
    })
}

#[tauri::command]
pub async fn run_operational_doctor(app: AppHandle) -> Result<OperationalDoctorReport, String> {
    let health = build_operational_health_snapshot(&app)?;
    let config_health = get_gateway_config_health().await?;
    let mut findings = Vec::<OperationalDoctorFinding>::new();

    if !health.bundle.bin_dir_exists || !health.bundle.share_dir_exists {
        findings.push(OperationalDoctorFinding {
            severity: "error".to_string(),
            title: "Bundled runtime assets are missing".to_string(),
            detail: format!(
                "Tauri resource directories are incomplete under {}.",
                health.bundle.resources_dir
            ),
            recommendation: Some(
                "Run the runtime bundle scripts before packaging, or provide the Colima/Lima assets expected by src-tauri/resources.".to_string(),
            ),
        });
    } else {
        let missing_bins = [
            (!health.bundle.colima_binary, "colima"),
            (!health.bundle.limactl_binary, "limactl"),
            (!health.bundle.docker_binary, "docker"),
        ]
        .into_iter()
        .filter_map(|(missing, name)| if missing { Some(name) } else { None })
        .collect::<Vec<_>>();
        if !missing_bins.is_empty() {
            findings.push(OperationalDoctorFinding {
                severity: "error".to_string(),
                title: "Bundled runtime binaries are incomplete".to_string(),
                detail: format!("Missing binaries: {}", missing_bins.join(", ")),
                recommendation: Some(
                    "Bundle the missing runtime binaries into src-tauri/resources/bin for packaged builds."
                        .to_string(),
                ),
            });
        }
    }

    if !health.runtime.docker_ready {
        let detail = if !health.runtime.docker_installed {
            "Docker is not installed or not visible to Entropic.".to_string()
        } else if !health.runtime.vm_running {
            "Colima is installed but the VM is not running.".to_string()
        } else {
            "Docker is installed, but the daemon is not ready.".to_string()
        };
        findings.push(OperationalDoctorFinding {
            severity: "error".to_string(),
            title: "Runtime is not ready".to_string(),
            detail,
            recommendation: Some(
                "Start the runtime from Setup or Settings before launching the gateway."
                    .to_string(),
            ),
        });
    }

    let desired_gateway_running = watchdog::desired_gateway_running(&health.watchdog.desired_mode);
    if desired_gateway_running && !health.gateway_running {
        findings.push(OperationalDoctorFinding {
            severity: "warn".to_string(),
            title: "Gateway is below its desired state".to_string(),
            detail: format!(
                "Desired mode is `{}`, but the OpenClaw gateway container is currently stopped.",
                health.watchdog.desired_mode
            ),
            recommendation: Some(
                "Leave the watchdog running to reconcile automatically, or review the watchdog status for the current block."
                    .to_string(),
            ),
        });
    } else if let Some(container_health) = health.gateway_container_health.as_deref() {
        if container_health != "healthy" {
            findings.push(OperationalDoctorFinding {
                severity: "warn".to_string(),
                title: "Gateway container is not healthy".to_string(),
                detail: format!("Docker health status is `{}`.", container_health),
                recommendation: Some(
                    "Inspect local runtime logs and restart the gateway if the health status does not recover."
                        .to_string(),
                ),
            });
        }
    }

    match health.watchdog.state.as_str() {
        "waiting_for_local_secrets" => findings.push(OperationalDoctorFinding {
            severity: "warn".to_string(),
            title: "Watchdog is waiting for local provider secrets".to_string(),
            detail: health
                .watchdog
                .last_error
                .clone()
                .unwrap_or_else(|| "Local-key desired state cannot be restored until provider secrets are hydrated into the backend.".to_string()),
            recommendation: Some(
                "Open the app UI so provider secrets can hydrate from Stronghold, then let the watchdog retry."
                    .to_string(),
            ),
        }),
        "missing_proxy_config" => findings.push(OperationalDoctorFinding {
            severity: "error".to_string(),
            title: "Watchdog is missing proxy restart configuration".to_string(),
            detail: health
                .watchdog
                .last_error
                .clone()
                .unwrap_or_else(|| "Proxy desired state is missing the token or proxy URL needed for restart.".to_string()),
            recommendation: Some(
                "Start the proxy gateway from the app again so the desired state can be refreshed."
                    .to_string(),
            ),
        }),
        "cooldown" => findings.push(OperationalDoctorFinding {
            severity: "warn".to_string(),
            title: "Watchdog restart backoff is active".to_string(),
            detail: health
                .watchdog
                .last_error
                .clone()
                .unwrap_or_else(|| "Recent restart attempts failed, so the watchdog entered cooldown.".to_string()),
            recommendation: Some(
                "Inspect the most recent incidents and fix the startup error before the next retry window."
                    .to_string(),
            ),
        }),
        _ => {}
    }

    if config_health.status == "invalid" {
        findings.push(OperationalDoctorFinding {
            severity: "error".to_string(),
            title: "Gateway config is invalid".to_string(),
            detail: config_health.summary.clone(),
            recommendation: Some(
                "Use Heal Config in Settings to run the OpenClaw doctor and restart the gateway."
                    .to_string(),
            ),
        });
    } else if config_health.status == "offline" && health.gateway_running {
        findings.push(OperationalDoctorFinding {
            severity: "warn".to_string(),
            title: "Gateway config check ran offline".to_string(),
            detail: config_health.summary.clone(),
            recommendation: Some(
                "If this persists while the gateway is running, inspect local runtime logs and container health."
                    .to_string(),
            ),
        });
    }

    if health.recent_error_count > 0 {
        findings.push(OperationalDoctorFinding {
            severity: if health.recent_error_count >= 3 {
                "error".to_string()
            } else {
                "warn".to_string()
            },
            title: "Recent operational incidents were recorded".to_string(),
            detail: format!(
                "{} error incident(s), {} warning incident(s) in the recent operational log.",
                health.recent_error_count, health.recent_warn_count
            ),
            recommendation: Some(
                "Review the incident log below to identify recurring runtime or gateway failures."
                    .to_string(),
            ),
        });
    }

    let status = if findings.iter().any(|finding| finding.severity == "error") {
        "critical"
    } else if findings.is_empty() {
        "healthy"
    } else {
        "degraded"
    };
    let summary = match status {
        "healthy" => "Operational doctor found no blocking issues.".to_string(),
        "critical" => format!(
            "Operational doctor found {} issue(s) that need attention.",
            findings.len()
        ),
        _ => format!(
            "Operational doctor found {} issue(s), but the system is still partially functional.",
            findings.len()
        ),
    };

    Ok(OperationalDoctorReport {
        status: status.to_string(),
        summary,
        findings,
    })
}

pub(super) fn gateway_ws_url() -> String {
    if std::path::Path::new("/.dockerenv").exists() {
        format!("ws://{}:18789", OPENCLAW_CONTAINER)
    } else {
        "ws://localhost:19789".to_string()
    }
}

fn finish_health_wait_or_tolerate_starting(err: String, context: &str) -> Result<(), String> {
    if err.contains("container health=starting")
        || err.contains("Handshake not finished")
        || err.contains("WebSocket connect failed")
        || err.contains("WebSocket protocol error")
    {
        println!(
            "[Entropic] {}: {} (continuing; container still warming up)",
            context, err
        );
        return Ok(());
    }
    Err(append_colima_runtime_hint(format!("{}: {}", context, err)))
}

async fn recover_gateway_health(
    token: &str,
    docker_args: &[String],
    label: &str,
    app: &AppHandle,
) -> Result<(), String> {
    if let Err(initial) = wait_for_gateway_health_strict(token, 12).await {
        let mut initial_error = initial;

        if gateway_health_error_suggests_control_ui_auth(&initial_error) {
            println!(
                "[Entropic] {} health check suggests control UI auth mismatch; forcing config self-heal: {}",
                label, initial_error
            );
            clear_applied_agent_settings_fingerprint()?;
            let state = app.state::<AppState>();
            if let Err(apply_err) = apply_agent_settings(app, &state) {
                println!(
                    "[Entropic] {} config self-heal write failed: {}",
                    label, apply_err
                );
            } else {
                match wait_for_gateway_health_strict(token, 8).await {
                    Ok(()) => return Ok(()),
                    Err(err) => {
                        println!(
                            "[Entropic] {} config self-heal retry still failing: {}",
                            label, err
                        );
                        let restart = docker_command()
                            .args(["restart", OPENCLAW_CONTAINER])
                            .output();
                        if let Err(restart_err) = restart {
                            println!(
                                "[Entropic] {} config self-heal restart attempt failed: {}",
                                label, restart_err
                            );
                        }
                        initial_error = err;
                    }
                }
            }
        }

        let health_status = container_health_status();
        if matches!(health_status.as_deref(), Some("starting")) {
            println!(
                "[Entropic] {} health check failed while health=starting; extending wait: {}",
                label, initial_error
            );
            if let Err(e) = wait_for_gateway_health_strict(token, 16).await {
                finish_health_wait_or_tolerate_starting(
                    e,
                    &format!("{} failed strict health check after extended wait", label),
                )?;
            }
        } else if matches!(health_status.as_deref(), Some("healthy")) {
            println!(
                "[Entropic] {} health check failed but container health=healthy; extending wait without restart: {}",
                label, initial_error
            );
            if let Err(e) = wait_for_gateway_health_strict(token, 16).await {
                finish_health_wait_or_tolerate_starting(
                    e,
                    &format!("{} failed strict health check after extended wait", label),
                )?;
            }
        } else if matches!(health_status.as_deref(), Some("unhealthy")) || !container_running() {
            println!(
                "[Entropic] {} health check failed with container state {:?}; attempting restart: {}",
                label, health_status, initial_error
            );
            let restart = docker_command()
                .args(["restart", OPENCLAW_CONTAINER])
                .output()
                .map_err(|e| {
                    append_colima_runtime_hint(format!("Failed to restart container: {}", e))
                })?;
            if !restart.status.success() {
                let stderr = String::from_utf8_lossy(&restart.stderr);
                if stderr.contains("is not running") || stderr.contains("no such container") {
                    println!(
                        "[Entropic] {} container is not running; removing and recreating...",
                        label
                    );
                    let cleanup = docker_command()
                        .args(["rm", "-f", OPENCLAW_CONTAINER])
                        .output()
                        .map_err(|e| format!("Failed to cleanup stale container: {}", e))?;
                    if !cleanup.status.success() {
                        println!(
                            "[Entropic] Container cleanup warning after restart failure: {}",
                            String::from_utf8_lossy(&cleanup.stderr)
                        );
                    }
                    let rerun = docker_command().args(docker_args).output().map_err(|e| {
                        append_colima_runtime_hint(format!("Failed to rerun container: {}", e))
                    })?;
                    if !rerun.status.success() {
                        let rerun_stderr = String::from_utf8_lossy(&rerun.stderr);
                        return Err(append_colima_runtime_hint(format!(
                            "{} failed health check ({}) and recreate failed: {}",
                            label,
                            initial_error,
                            rerun_stderr.trim()
                        )));
                    }
                } else {
                    return Err(append_colima_runtime_hint(format!(
                        "{} failed health check ({}) and restart failed: {}",
                        label,
                        initial_error,
                        stderr.trim()
                    )));
                }
            }
            let state = app.state::<AppState>();
            apply_agent_settings(app, &state)?;
            if let Err(e) = wait_for_gateway_health_strict(token, 16).await {
                finish_health_wait_or_tolerate_starting(
                    e,
                    &format!("{} failed strict health check after recovery", label),
                )?;
            }
        } else {
            println!(
                "[Entropic] {} health check failed with container state {:?}; extending wait without restart: {}",
                label, health_status, initial_error
            );
            if let Err(e) = wait_for_gateway_health_strict(token, 16).await {
                finish_health_wait_or_tolerate_starting(
                    e,
                    &format!("{} failed strict health check after extended wait", label),
                )?;
            }
        }
    }
    Ok(())
}

pub(super) async fn start_gateway_internal(
    app: &AppHandle,
    model: Option<String>,
    incident_action: &str,
) -> Result<(), String> {
    let startup_started = Instant::now();
    let _start_guard = gateway_start_lock().lock().await;
    operational::record_incident(
        app,
        "info",
        "gateway",
        incident_action,
        "Starting local gateway",
        model.as_deref(),
    );
    let state = app.state::<AppState>();
    let api_keys = state.api_keys.lock().map_err(|e| e.to_string())?.clone();
    let active_provider = state
        .active_provider
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    drop(state);
    let settings = load_agent_settings(app);
    if settings.bridge_enabled && has_paired_bridge_devices(&settings) {
        println!(
            "[Entropic] Bridge mode requested in settings but disabled for security; binding gateway to localhost only.",
        );
    }
    let gateway_bind = "127.0.0.1:19789:18789";
    let mut memory_slot = if !settings.memory_enabled {
        "none"
    } else if settings.memory_long_term {
        "memory-lancedb"
    } else {
        "memory-core"
    };
    if memory_slot == "memory-lancedb" && !api_keys.contains_key("openai") {
        memory_slot = "memory-core";
    }

    RuntimeSupervisor::new(app)
        .ensure_ready()
        .map_err(append_colima_runtime_hint)?;
    println!(
        "[Entropic] Startup timing: runtime_ready={}ms",
        startup_started.elapsed().as_millis()
    );

    let gateway_token = expected_gateway_token(app)?;

    let has_any_local_api_key = api_keys.contains_key("anthropic")
        || api_keys.contains_key("openai")
        || api_keys.contains_key("google");
    if !has_any_local_api_key {
        return Err(
            "No local API key configured. Add an Anthropic/OpenAI/Google key in Settings, or sign in and disable 'Use Local Keys'."
                .to_string(),
        );
    }

    let model_full: String = if let Some(ref m) = model {
        if !m.is_empty() {
            m.clone()
        } else {
            "anthropic/claude-opus-4-6:thinking".to_string()
        }
    } else {
        match active_provider.as_deref() {
            Some("anthropic") if api_keys.contains_key("anthropic") => {
                "anthropic/claude-opus-4-6:thinking".to_string()
            }
            Some("openai") if api_keys.contains_key("openai") => {
                "openai-codex/gpt-5.3-codex".to_string()
            }
            Some("google") if api_keys.contains_key("google") => {
                "google/gemini-2.5-pro".to_string()
            }
            _ if api_keys.contains_key("anthropic") => {
                "anthropic/claude-opus-4-6:thinking".to_string()
            }
            _ if api_keys.contains_key("openai") => "openai-codex/gpt-5.3-codex".to_string(),
            _ if api_keys.contains_key("google") => "google/gemini-2.5-pro".to_string(),
            _ => "anthropic/claude-opus-4-6:thinking".to_string(),
        }
    };

    let (base_model, model_params) = if let Some(colon_pos) = model_full.find(':') {
        (&model_full[..colon_pos], Some(&model_full[colon_pos + 1..]))
    } else {
        (model_full.as_str(), None)
    };

    let thinking_enabled = model_params == Some("thinking");
    let reasoning_effort = model_params
        .and_then(|p| p.strip_prefix("reasoning="))
        .unwrap_or("");

    cleanup_legacy_gateway_artifacts();

    if named_gateway_container_exists(OPENCLAW_CONTAINER, true) {
        let current_gateway_token = read_container_env("OPENCLAW_GATEWAY_TOKEN");
        let current_schema = read_container_env("ENTROPIC_GATEWAY_SCHEMA_VERSION");
        let current_model = read_container_env("OPENCLAW_MODEL");
        let current_proxy_mode = read_container_env("ENTROPIC_PROXY_MODE");
        let legacy_proxy_mode = read_container_env("NOVA_PROXY_MODE");
        let has_oauth_token = read_container_env("ANTHROPIC_OAUTH_TOKEN").is_some();
        let wants_oauth_token = api_keys
            .get("anthropic")
            .is_some_and(|k| k.starts_with("sk-ant-oat01-"));
        let auth_type_matches = has_oauth_token == wants_oauth_token;
        let is_proxy_container =
            current_proxy_mode.as_deref() == Some("1") || legacy_proxy_mode.as_deref() == Some("1");
        if !is_proxy_container
            && auth_type_matches
            && current_gateway_token.as_deref() == Some(gateway_token.as_str())
            && current_schema.as_deref() == Some(ENTROPIC_GATEWAY_SCHEMA_VERSION)
            && current_model.as_deref() == Some(base_model)
        {
            let state = app.state::<AppState>();
            apply_agent_settings(app, &state)?;
            match wait_for_gateway_health_strict(&gateway_token, 6).await {
                Ok(()) => return Ok(()),
                Err(err) => {
                    println!(
                        "[Entropic] Matching gateway container failed health check; recreating: {}",
                        err
                    );
                }
            }
        }

        let _ = docker_command()
            .args(["rm", "-f", OPENCLAW_CONTAINER])
            .output();
    }

    let any_filter = format!("name={}", OPENCLAW_CONTAINER);
    let check_all = docker_command()
        .args(["ps", "-aq", "-f", any_filter.as_str()])
        .output()
        .map_err(|e| format!("Failed to check container: {}", e))?;

    if !check_all.stdout.is_empty() {
        let _ = docker_command()
            .args(["rm", "-f", OPENCLAW_CONTAINER])
            .output();
    }

    let _ = docker_command()
        .args(["network", "create", OPENCLAW_NETWORK])
        .output();

    let image_started = Instant::now();
    ensure_runtime_image()?;
    println!(
        "[Entropic] Startup timing: runtime_image_ready={}ms",
        image_started.elapsed().as_millis()
    );

    let thinking_level = if thinking_enabled {
        "high"
    } else if !reasoning_effort.is_empty() {
        reasoning_effort
    } else {
        "off"
    };

    let mut env_entries: Vec<(&str, &str)> = vec![
        ("OPENCLAW_GATEWAY_TOKEN", gateway_token.as_str()),
        (
            "ENTROPIC_GATEWAY_SCHEMA_VERSION",
            ENTROPIC_GATEWAY_SCHEMA_VERSION,
        ),
        ("OPENCLAW_MODEL", base_model),
        ("OPENCLAW_MEMORY_SLOT", memory_slot),
        ("ENTROPIC_THINKING_LEVEL", thinking_level),
        ("ENTROPIC_WORKSPACE_PATH", WORKSPACE_ROOT),
        ("ENTROPIC_SKILLS_PATH", SKILLS_ROOT),
        ("ENTROPIC_SKILL_MANIFESTS_PATH", SKILL_MANIFESTS_ROOT),
        ("HOME", "/data"),
        ("TMPDIR", "/data/tmp"),
        ("XDG_CONFIG_HOME", "/data/.config"),
        ("XDG_CACHE_HOME", "/data/.cache"),
        ("npm_config_cache", "/data/.npm"),
        ("PLAYWRIGHT_BROWSERS_PATH", "/data/playwright"),
        ("ENTROPIC_BROWSER_PROFILE", "/data/browser/profile"),
        ("ENTROPIC_TOOLS_PATH", "/data/tools"),
    ];

    if let Some(key) = api_keys.get("anthropic") {
        if key.starts_with("sk-ant-oat01-") {
            env_entries.push(("ANTHROPIC_OAUTH_TOKEN", key.as_str()));
        } else {
            env_entries.push(("ANTHROPIC_API_KEY", key.as_str()));
        }
    }
    if let Some(key) = api_keys.get("openai") {
        if key.starts_with("sk-") {
            env_entries.push(("OPENAI_API_KEY", key.as_str()));
        }
    }
    if let Some(key) = api_keys.get("google") {
        env_entries.push(("GEMINI_API_KEY", key.as_str()));
    }
    let mut web_base_url = None;
    if let Ok(base) = std::env::var("ENTROPIC_WEB_BASE_URL") {
        if !base.trim().is_empty() {
            web_base_url = Some(base);
        }
    }
    if let Some(base) = web_base_url.as_deref() {
        env_entries.push(("ENTROPIC_WEB_BASE_URL", base));
    }

    let env_file = gateway_env_file(&env_entries)?;
    let env_file_path = env_file.path.to_string_lossy().to_string();

    let mut docker_args = vec![
        "run".to_string(),
        "-d".to_string(),
        "--name".to_string(),
        OPENCLAW_CONTAINER.to_string(),
        "--restart".to_string(),
        "unless-stopped".to_string(),
        "--user".to_string(),
        "1000:1000".to_string(),
        "--add-host".to_string(),
        "host.docker.internal:host-gateway".to_string(),
        "--cap-drop=ALL".to_string(),
        "--security-opt".to_string(),
        "no-new-privileges".to_string(),
        "--read-only".to_string(),
        "--tmpfs".to_string(),
        "/tmp:rw,noexec,nosuid,nodev,size=100m".to_string(),
        "--tmpfs".to_string(),
        "/run:rw,noexec,nosuid,nodev,size=10m".to_string(),
        "--tmpfs".to_string(),
        "/home/node/.openclaw:rw,noexec,nosuid,nodev,size=50m,uid=1000,gid=1000".to_string(),
        "--env-file".to_string(),
        env_file_path,
    ];

    append_entropic_skills_mount(&mut docker_args);

    docker_args.extend([
        "-v".to_string(),
        openclaw_data_volume_mount(),
        "--network".to_string(),
        OPENCLAW_NETWORK.to_string(),
        "-p".to_string(),
        gateway_bind.to_string(),
        "openclaw-runtime:latest".to_string(),
    ]);

    if let Ok(source) = std::env::var("ENTROPIC_DEV_OPENCLAW_SOURCE") {
        if !source.trim().is_empty() {
            docker_args.push("-v".to_string());
            docker_args.push(format!("{}/dist:/app/dist:ro", source));
            docker_args.push("-v".to_string());
            docker_args.push(format!("{}/extensions:/app/extensions:ro", source));
        }
    }

    println!(
        "[Entropic] Starting gateway container with model: {}",
        model_full
    );
    println!(
        "[Entropic] Docker command: docker {}",
        docker_args_for_log(&docker_args)
    );

    let container_launch_started = Instant::now();
    let run = docker_command()
        .args(&docker_args)
        .output()
        .map_err(|e| append_colima_runtime_hint(format!("Failed to run container: {}", e)))?;

    if !run.status.success() {
        let stderr = String::from_utf8_lossy(&run.stderr);
        println!("[Entropic] Failed to start container: {}", stderr);
        return Err(append_colima_runtime_hint(format!(
            "Failed to start container: {}",
            stderr
        )));
    }

    println!("[Entropic] Container started successfully");
    println!(
        "[Entropic] Startup timing: container_launch={}ms",
        container_launch_started.elapsed().as_millis()
    );

    let settings_started = Instant::now();
    let state = app.state::<AppState>();
    apply_agent_settings(app, &state)?;
    println!(
        "[Entropic] Startup timing: post_launch_config={}ms",
        settings_started.elapsed().as_millis()
    );

    let health_started = Instant::now();
    recover_gateway_health(&gateway_token, &docker_args, "Gateway", app).await?;
    clear_applied_agent_settings_fingerprint()?;
    let state = app.state::<AppState>();
    apply_agent_settings(app, &state)?;
    signal_gateway_config_reload();
    println!("[Entropic] Startup timing: post_health_config applied");
    println!(
        "[Entropic] Startup timing: health={}ms total={}ms",
        health_started.elapsed().as_millis(),
        startup_started.elapsed().as_millis()
    );
    operational::record_incident(
        app,
        "info",
        "gateway",
        "start_succeeded",
        "Local gateway started successfully",
        model.as_deref(),
    );

    Ok(())
}

pub(super) async fn start_gateway_with_proxy_internal(
    app: &AppHandle,
    gateway_token: String,
    proxy_url: String,
    model: String,
    image_model: Option<String>,
    incident_action: &str,
) -> Result<(), String> {
    let startup_started = Instant::now();
    let _start_guard = gateway_start_lock().lock().await;
    operational::record_incident(
        app,
        "info",
        "gateway",
        incident_action,
        "Starting proxy gateway",
        Some(model.as_str()),
    );
    cleanup_legacy_gateway_artifacts();
    let settings = load_agent_settings(app);
    if settings.bridge_enabled && has_paired_bridge_devices(&settings) {
        println!(
            "[Entropic] Bridge mode requested in settings but disabled for security; binding proxy gateway to localhost only.",
        );
    }
    let gateway_bind = "127.0.0.1:19789:18789";
    let resolved_proxy_url = resolve_container_proxy_base(&proxy_url)?;
    let docker_proxy_api_url = resolve_container_openai_base(&resolved_proxy_url);
    RuntimeSupervisor::new(app)
        .ensure_ready()
        .map_err(append_colima_runtime_hint)?;
    println!(
        "[Entropic] Startup timing (proxy): runtime_ready={}ms",
        startup_started.elapsed().as_millis()
    );
    let local_gateway_token = expected_gateway_token(app)?;
    let build_proxy_docker_args = || -> Result<(Vec<String>, GatewayEnvFile), String> {
        let mut env_entries: Vec<(&str, &str)> = vec![
            ("OPENCLAW_GATEWAY_TOKEN", local_gateway_token.as_str()),
            (
                "ENTROPIC_GATEWAY_SCHEMA_VERSION",
                ENTROPIC_GATEWAY_SCHEMA_VERSION,
            ),
            ("OPENCLAW_MODEL", model.as_str()),
            ("OPENCLAW_MEMORY_SLOT", "memory-core"),
            ("ENTROPIC_PROXY_MODE", "1"),
            ("OPENROUTER_API_KEY", gateway_token.as_str()),
            ("ENTROPIC_PROXY_BASE_URL", docker_proxy_api_url.as_str()),
            ("ENTROPIC_WEB_BASE_URL", resolved_proxy_url.as_str()),
            ("ENTROPIC_WORKSPACE_PATH", WORKSPACE_ROOT),
            ("ENTROPIC_SKILLS_PATH", SKILLS_ROOT),
            ("ENTROPIC_SKILL_MANIFESTS_PATH", SKILL_MANIFESTS_ROOT),
            ("HOME", "/data"),
            ("TMPDIR", "/data/tmp"),
            ("XDG_CONFIG_HOME", "/data/.config"),
            ("XDG_CACHE_HOME", "/data/.cache"),
            ("npm_config_cache", "/data/.npm"),
            ("PLAYWRIGHT_BROWSERS_PATH", "/data/playwright"),
            ("ENTROPIC_BROWSER_PROFILE", "/data/browser/profile"),
            ("ENTROPIC_TOOLS_PATH", "/data/tools"),
        ];
        if let Some(image_model) = image_model.as_deref() {
            if !image_model.trim().is_empty() {
                env_entries.push(("OPENCLAW_IMAGE_MODEL", image_model));
            }
        }
        let env_file = gateway_env_file(&env_entries)?;
        let env_file_path = env_file.path.to_string_lossy().to_string();

        let mut docker_args = vec![
            "run".to_string(),
            "-d".to_string(),
            "--name".to_string(),
            OPENCLAW_CONTAINER.to_string(),
            "--restart".to_string(),
            "unless-stopped".to_string(),
            "--user".to_string(),
            "1000:1000".to_string(),
            "--add-host".to_string(),
            "host.docker.internal:host-gateway".to_string(),
            "--cap-drop=ALL".to_string(),
            "--security-opt".to_string(),
            "no-new-privileges".to_string(),
            "--read-only".to_string(),
            "--tmpfs".to_string(),
            "/tmp:rw,noexec,nosuid,nodev,size=100m".to_string(),
            "--tmpfs".to_string(),
            "/run:rw,noexec,nosuid,nodev,size=10m".to_string(),
            "--tmpfs".to_string(),
            "/home/node/.openclaw:rw,noexec,nosuid,nodev,size=50m,uid=1000,gid=1000".to_string(),
            "--env-file".to_string(),
            env_file_path,
        ];

        append_entropic_skills_mount(&mut docker_args);

        docker_args.extend([
            "-v".to_string(),
            openclaw_data_volume_mount(),
            "--network".to_string(),
            OPENCLAW_NETWORK.to_string(),
            "-p".to_string(),
            gateway_bind.to_string(),
            "openclaw-runtime:latest".to_string(),
        ]);

        if let Ok(source) = std::env::var("ENTROPIC_DEV_OPENCLAW_SOURCE") {
            if !source.trim().is_empty() {
                docker_args.insert(docker_args.len() - 1, "-v".to_string());
                docker_args.insert(
                    docker_args.len() - 1,
                    format!("{}/dist:/app/dist:ro", source),
                );
                docker_args.insert(docker_args.len() - 1, "-v".to_string());
                docker_args.insert(
                    docker_args.len() - 1,
                    format!("{}/extensions:/app/extensions:ro", source),
                );
            }
        }

        Ok((docker_args, env_file))
    };

    if named_gateway_container_exists(OPENCLAW_CONTAINER, true) {
        let expected_proxy_env = docker_proxy_api_url.clone();
        let current_proxy = read_container_env("ENTROPIC_PROXY_BASE_URL");
        let current_token = read_container_env("OPENROUTER_API_KEY");
        let current_gateway_token = read_container_env("OPENCLAW_GATEWAY_TOKEN");
        let current_schema = read_container_env("ENTROPIC_GATEWAY_SCHEMA_VERSION");
        let current_model = read_container_env("OPENCLAW_MODEL");
        let current_image = read_container_env("OPENCLAW_IMAGE_MODEL");
        let expected_image = image_model.clone().unwrap_or_default();

        let proxy_matches = current_proxy.as_deref() == Some(expected_proxy_env.as_str());
        let gateway_token_matches =
            current_gateway_token.as_deref() == Some(local_gateway_token.as_str());
        let schema_matches = current_schema.as_deref() == Some(ENTROPIC_GATEWAY_SCHEMA_VERSION);
        let model_matches = current_model.as_deref() == Some(model.as_str());
        let image_matches =
            expected_image.is_empty() || current_image.as_deref() == Some(expected_image.as_str());
        let token_matches = current_token.as_deref() == Some(gateway_token.as_str());

        if proxy_matches
            && gateway_token_matches
            && schema_matches
            && model_matches
            && image_matches
            && token_matches
        {
            println!("[Entropic] Proxy container already running with matching config. Reusing.");
            let reuse_prepare_started = Instant::now();
            let state = app.state::<AppState>();
            apply_agent_settings(app, &state)?;
            println!(
                "[Entropic] Startup timing (proxy): reused_container_prepare={}ms",
                reuse_prepare_started.elapsed().as_millis()
            );
            let health_started = Instant::now();
            let (reuse_docker_args, _reuse_env_file) = build_proxy_docker_args()?;
            recover_gateway_health(
                &local_gateway_token,
                &reuse_docker_args,
                "Proxy gateway",
                app,
            )
            .await?;
            println!(
                "[Entropic] Startup timing (proxy): health={}ms total={}ms",
                health_started.elapsed().as_millis(),
                startup_started.elapsed().as_millis()
            );
            return Ok(());
        }

        if !token_matches {
            println!(
                "[Entropic] OPENROUTER_API_KEY changed; tearing down proxy container to apply new credentials."
            );
        }
        let _ = docker_command()
            .args(["rm", "-f", OPENCLAW_CONTAINER])
            .output();
    }

    let any_filter = format!("name={}", OPENCLAW_CONTAINER);
    let check_all = docker_command()
        .args(["ps", "-aq", "-f", any_filter.as_str()])
        .output()
        .map_err(|e| format!("Failed to check container: {}", e))?;

    if !check_all.stdout.is_empty() {
        let _ = docker_command()
            .args(["rm", "-f", OPENCLAW_CONTAINER])
            .output();
    }

    let _ = docker_command()
        .args(["network", "create", OPENCLAW_NETWORK])
        .output();

    let image_started = Instant::now();
    ensure_runtime_image()?;
    println!(
        "[Entropic] Startup timing (proxy): runtime_image_ready={}ms",
        image_started.elapsed().as_millis()
    );
    let (docker_args, _proxy_env_file) = build_proxy_docker_args()?;

    println!("[Entropic] Starting proxy gateway with model: {}", model);
    println!("[Entropic] Proxy URL: {}", resolved_proxy_url);
    println!("[Entropic] Proxy API URL: {}", docker_proxy_api_url);
    println!(
        "[Entropic] Docker command: docker {}",
        docker_args_for_log(&docker_args)
    );

    let container_launch_started = Instant::now();
    let run = docker_command()
        .args(&docker_args)
        .output()
        .map_err(|e| append_colima_runtime_hint(format!("Failed to run container: {}", e)))?;

    if !run.status.success() {
        let stderr = String::from_utf8_lossy(&run.stderr);
        println!("[Entropic] Failed to start proxy container: {}", stderr);
        if stderr.contains("Conflict. The container name") {
            println!(
                "[Entropic] Existing container conflict detected; attempting cleanup and retry."
            );
            let cleanup = docker_command()
                .args(["rm", "-f", OPENCLAW_CONTAINER])
                .output()
                .map_err(|e| {
                    append_colima_runtime_hint(format!(
                        "Failed to cleanup conflicting container: {}",
                        e
                    ))
                })?;
            if !cleanup.status.success() {
                let cleanup_stderr = String::from_utf8_lossy(&cleanup.stderr);
                return Err(append_colima_runtime_hint(format!(
                    "Failed to start container: {} (conflict cleanup failed: {})",
                    stderr.trim(),
                    cleanup_stderr.trim()
                )));
            }
            let rerun = docker_command().args(&docker_args).output().map_err(|e| {
                append_colima_runtime_hint(format!("Failed to rerun container: {}", e))
            })?;
            if !rerun.status.success() {
                let rerun_stderr = String::from_utf8_lossy(&rerun.stderr);
                return Err(append_colima_runtime_hint(format!(
                    "Failed to start container: {}",
                    rerun_stderr
                )));
            }
        } else {
            return Err(append_colima_runtime_hint(format!(
                "Failed to start container: {}",
                stderr
            )));
        }
    }

    println!("[Entropic] Proxy container started successfully");
    println!(
        "[Entropic] Startup timing (proxy): container_launch={}ms",
        container_launch_started.elapsed().as_millis()
    );

    let settings_started = Instant::now();
    let state = app.state::<AppState>();
    apply_agent_settings(app, &state)?;
    println!(
        "[Entropic] Startup timing (proxy): post_launch_config={}ms",
        settings_started.elapsed().as_millis()
    );

    let health_started = Instant::now();
    recover_gateway_health(&local_gateway_token, &docker_args, "Proxy gateway", app).await?;
    clear_applied_agent_settings_fingerprint()?;
    let state = app.state::<AppState>();
    apply_agent_settings(app, &state)?;
    signal_gateway_config_reload();
    println!("[Entropic] Startup timing (proxy): post_health_config applied");
    println!(
        "[Entropic] Startup timing (proxy): health={}ms total={}ms",
        health_started.elapsed().as_millis(),
        startup_started.elapsed().as_millis()
    );
    operational::record_incident(
        app,
        "info",
        "gateway",
        "proxy_start_succeeded",
        "Proxy gateway started successfully",
        Some(model.as_str()),
    );

    Ok(())
}

pub(super) async fn get_gateway_status_internal(app: &AppHandle) -> Result<bool, String> {
    if !gateway_container_exists(true) {
        println!("[Entropic] Container not running");
        return Ok(false);
    }

    let ws_url = gateway_ws_url();
    let token = effective_gateway_token(app)?;

    println!("[Entropic] Checking gateway health via WS at: {}", ws_url);
    let mut last_error: Option<String> = None;
    for attempt in 1..=2 {
        match check_gateway_ws_health(&ws_url, &token).await {
            Ok(true) => {
                println!("[Entropic] Gateway health check passed");
                return Ok(true);
            }
            Ok(false) => {
                last_error = Some("health rpc rejected".to_string());
            }
            Err(e) => {
                last_error = Some(e);
            }
        }

        if attempt < 2 {
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    }

    if !container_running() {
        println!("[Entropic] Container stopped while checking gateway health");
        return Ok(false);
    }

    if let Some(health_status) = container_health_status() {
        println!("[Entropic] Container health status: {}", health_status);
        if health_status == "healthy" {
            println!(
                "[Entropic] Gateway WS probe failed but container health is healthy; treating as running.",
            );
            return Ok(true);
        }
        if health_status == "starting" {
            println!(
                "[Entropic] Gateway WS probe failed while container health is starting; reporting not running until WS recovers.",
            );
        }
    }

    println!(
        "[Entropic] Gateway health check failed after retries: {}",
        last_error.unwrap_or_else(|| "unknown health failure".to_string())
    );
    if let Some(hint) = colima_daemon_killed_hint() {
        println!("[Entropic] {}", hint);
    }
    Ok(false)
}

fn run_gateway_doctor_in_container(container: &str, fix: bool) -> Result<Output, String> {
    let mut args = vec!["exec", container, "node", "/app/dist/index.js", "doctor"];
    if fix {
        args.push("--fix");
    }
    docker_command()
        .args(args)
        .output()
        .map_err(|e| format!("Failed to run doctor in gateway container: {}", e))
}

fn run_gateway_doctor_with_data_volume(fix: bool) -> Result<Output, String> {
    let volume = existing_openclaw_data_volume_name().ok_or_else(|| {
        "Gateway data volume not found. Start gateway once before running config check/heal."
            .to_string()
    })?;

    ensure_runtime_image()?;

    let mut args = vec![
        "run".to_string(),
        "--rm".to_string(),
        "--user".to_string(),
        "1000:1000".to_string(),
        "--cap-drop=ALL".to_string(),
        "--security-opt".to_string(),
        "no-new-privileges".to_string(),
        "-e".to_string(),
        "HOME=/data".to_string(),
        "-e".to_string(),
        "TMPDIR=/data/tmp".to_string(),
        "-e".to_string(),
        "XDG_CONFIG_HOME=/data/.config".to_string(),
        "-e".to_string(),
        "XDG_CACHE_HOME=/data/.cache".to_string(),
        "-e".to_string(),
        "npm_config_cache=/data/.npm".to_string(),
        "-v".to_string(),
        format!("{}:/data", volume),
        RUNTIME_IMAGE.to_string(),
        "node".to_string(),
        "/app/dist/index.js".to_string(),
        "doctor".to_string(),
    ];
    if fix {
        args.push("--fix".to_string());
    }

    docker_command()
        .args(&args)
        .output()
        .map_err(|e| format!("Failed to run offline doctor check: {}", e))
}

fn run_gateway_doctor_with_fallback(fix: bool) -> Result<(Output, Option<&'static str>), String> {
    if let Some(container) = running_gateway_container_name() {
        return run_gateway_doctor_in_container(container, fix)
            .map(|output| (output, Some(container)));
    }

    run_gateway_doctor_with_data_volume(fix).map(|output| (output, None))
}

fn extract_doctor_problem_lines(output: &str) -> Vec<String> {
    let mut issues = Vec::new();
    let mut in_problem_block = false;

    for raw_line in output.lines() {
        let trimmed = raw_line.trim();
        let normalized = trimmed.trim_start_matches('│').trim();

        if normalized.eq_ignore_ascii_case("Problem:") {
            in_problem_block = true;
            continue;
        }

        if in_problem_block {
            if normalized.starts_with("Run:") {
                break;
            }
            if normalized.is_empty() || normalized.starts_with("File:") {
                continue;
            }
            if let Some(issue) = normalized.strip_prefix("- ") {
                let value = issue.trim();
                if !value.is_empty() {
                    issues.push(value.to_string());
                }
            }
        }
    }

    if issues.is_empty() {
        for raw_line in output.lines() {
            let trimmed = raw_line.trim();
            let normalized = trimmed.trim_start_matches('│').trim();
            if let Some(issue) = normalized.strip_prefix("- ") {
                let value = issue.trim();
                if !value.is_empty() && value.contains(':') {
                    issues.push(value.to_string());
                }
            }
        }
    }

    issues.sort();
    issues.dedup();
    issues
}
