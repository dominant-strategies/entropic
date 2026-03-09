use super::*;

#[tauri::command]
pub async fn get_agent_profile_state(app: AppHandle) -> Result<AgentProfileState, String> {
    let stored = load_agent_settings(&app);
    let gateway_running = named_gateway_container_exists(OPENCLAW_CONTAINER, true)
        || named_gateway_container_exists(LEGACY_OPENCLAW_CONTAINER, true);
    let soul = if gateway_running {
        read_container_file(&workspace_file("SOUL.md")).unwrap_or_default()
    } else {
        String::new()
    };
    let identity_raw = if gateway_running {
        read_container_file(&workspace_file("IDENTITY.md")).unwrap_or_default()
    } else {
        String::new()
    };
    let identity_name = parse_markdown_bold_field(&identity_raw, "Name")
        .and_then(|value| sanitize_identity_name(&value))
        .or_else(|| sanitize_identity_name(&stored.identity_name))
        .unwrap_or_else(|| "Entropic".to_string());
    let identity_avatar = parse_markdown_bold_field(&identity_raw, "Avatar")
        .or_else(|| stored.identity_avatar.clone())
        .and_then(|value| {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        });
    let heartbeat_raw = if gateway_running {
        read_container_file(&workspace_file("HEARTBEAT.md")).unwrap_or_default()
    } else {
        String::new()
    };
    let heartbeat_tasks = heartbeat_raw
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            if trimmed.starts_with("- ") {
                Some(trimmed.trim_start_matches("- ").trim().to_string())
            } else if trimmed.starts_with("* ") {
                Some(trimmed.trim_start_matches("* ").trim().to_string())
            } else {
                None
            }
        })
        .filter(|t| !t.is_empty())
        .collect::<Vec<_>>();

    let cfg = if gateway_running {
        read_openclaw_config()
    } else {
        serde_json::json!({})
    };
    let heartbeat_every = cfg
        .get("agents")
        .and_then(|v| v.get("defaults"))
        .and_then(|v| v.get("heartbeat"))
        .and_then(|v| v.get("every"))
        .and_then(|v| v.as_str())
        .unwrap_or(&stored.heartbeat_every)
        .to_string();

    let memory_slot = cfg
        .get("plugins")
        .and_then(|v| v.get("slots"))
        .and_then(|v| v.get("memory"))
        .and_then(|v| v.as_str())
        .unwrap_or(if stored.memory_enabled {
            if stored.memory_long_term {
                "memory-lancedb"
            } else {
                "memory-core"
            }
        } else {
            "none"
        });

    let (memory_enabled, memory_long_term) = match memory_slot {
        "none" => (false, false),
        "memory-lancedb" => (true, true),
        _ => (true, false),
    };
    let memory_qmd_enabled = cfg
        .get("memory")
        .and_then(|memory| memory.get("backend"))
        .and_then(|backend| backend.as_str())
        .map(|backend| backend == "qmd")
        .unwrap_or(stored.memory_qmd_enabled);
    let memory_sessions_enabled = stored.memory_sessions_enabled;

    let discord_cfg = cfg.get("channels").and_then(|v| v.get("discord"));
    let discord_enabled = discord_cfg
        .and_then(|v| v.get("enabled"))
        .and_then(|v| v.as_bool())
        .unwrap_or(stored.discord_enabled);
    let discord_token = discord_cfg
        .and_then(|v| v.get("token"))
        .and_then(|v| v.as_str())
        .unwrap_or(&stored.discord_token)
        .to_string();

    let telegram_cfg = cfg.get("channels").and_then(|v| v.get("telegram"));
    let cfg_telegram_token = telegram_cfg
        .and_then(|v| v.get("botToken"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|v| !v.is_empty());
    let stored_telegram_token = stored.telegram_token.trim();
    // If runtime config lost Telegram token (common after a cold/reset bootstrap),
    // prefer persisted desktop settings so Messaging UI can hydrate and re-apply.
    let use_stored_telegram = cfg_telegram_token.is_none() && !stored_telegram_token.is_empty();

    let telegram_enabled = if use_stored_telegram {
        stored.telegram_enabled
    } else {
        telegram_cfg
            .and_then(|v| v.get("enabled"))
            .and_then(|v| v.as_bool())
            .unwrap_or(stored.telegram_enabled)
    };
    let telegram_token = if use_stored_telegram {
        stored.telegram_token.clone()
    } else {
        cfg_telegram_token
            .unwrap_or(stored_telegram_token)
            .to_string()
    };
    let telegram_dm_policy = if use_stored_telegram {
        stored.telegram_dm_policy.clone()
    } else {
        telegram_cfg
            .and_then(|v| v.get("dmPolicy"))
            .and_then(|v| v.as_str())
            .unwrap_or(&stored.telegram_dm_policy)
            .to_string()
    };
    let telegram_dm_policy = match telegram_dm_policy.as_str() {
        "pairing" | "allowlist" | "open" | "disabled" => telegram_dm_policy,
        _ => "pairing".to_string(),
    };
    let telegram_group_policy = if use_stored_telegram {
        stored.telegram_group_policy.clone()
    } else {
        telegram_cfg
            .and_then(|v| v.get("groupPolicy"))
            .and_then(|v| v.as_str())
            .unwrap_or(&stored.telegram_group_policy)
            .to_string()
    };
    let telegram_group_policy = match telegram_group_policy.as_str() {
        "allowlist" | "open" | "disabled" => telegram_group_policy,
        _ => "allowlist".to_string(),
    };
    let telegram_config_writes = if use_stored_telegram {
        stored.telegram_config_writes
    } else {
        telegram_cfg
            .and_then(|v| v.get("configWrites"))
            .and_then(|v| v.as_bool())
            .unwrap_or(stored.telegram_config_writes)
    };
    let telegram_require_mention = if use_stored_telegram {
        stored.telegram_require_mention
    } else {
        telegram_cfg
            .and_then(|v| v.get("groups"))
            .and_then(|v| v.get("*"))
            .and_then(|v| v.get("requireMention"))
            .and_then(|v| v.as_bool())
            .unwrap_or(stored.telegram_require_mention)
    };
    let telegram_reply_to_mode = if use_stored_telegram {
        stored.telegram_reply_to_mode.clone()
    } else {
        telegram_cfg
            .and_then(|v| v.get("replyToMode"))
            .and_then(|v| v.as_str())
            .unwrap_or(&stored.telegram_reply_to_mode)
            .to_string()
    };
    let telegram_reply_to_mode = match telegram_reply_to_mode.as_str() {
        "off" | "first" | "all" => telegram_reply_to_mode,
        _ => "off".to_string(),
    };
    let telegram_link_preview = if use_stored_telegram {
        stored.telegram_link_preview
    } else {
        telegram_cfg
            .and_then(|v| v.get("linkPreview"))
            .and_then(|v| v.as_bool())
            .unwrap_or(stored.telegram_link_preview)
    };

    let slack_cfg = cfg.get("channels").and_then(|v| v.get("slack"));
    let slack_enabled = slack_cfg
        .and_then(|v| v.get("enabled"))
        .and_then(|v| v.as_bool())
        .unwrap_or(stored.slack_enabled);
    let slack_bot_token = slack_cfg
        .and_then(|v| v.get("botToken"))
        .and_then(|v| v.as_str())
        .unwrap_or(&stored.slack_bot_token)
        .to_string();
    let slack_app_token = slack_cfg
        .and_then(|v| v.get("appToken"))
        .and_then(|v| v.as_str())
        .unwrap_or(&stored.slack_app_token)
        .to_string();

    let googlechat_cfg = cfg.get("channels").and_then(|v| v.get("googlechat"));
    let googlechat_enabled = googlechat_cfg
        .and_then(|v| v.get("enabled"))
        .and_then(|v| v.as_bool())
        .unwrap_or(stored.googlechat_enabled);
    let googlechat_service_account = googlechat_cfg
        .and_then(|v| v.get("serviceAccount"))
        .and_then(|v| v.as_str())
        .unwrap_or(&stored.googlechat_service_account)
        .to_string();
    let googlechat_audience_type = googlechat_cfg
        .and_then(|v| v.get("audienceType"))
        .and_then(|v| v.as_str())
        .unwrap_or(&stored.googlechat_audience_type)
        .to_string();
    let googlechat_audience = googlechat_cfg
        .and_then(|v| v.get("audience"))
        .and_then(|v| v.as_str())
        .unwrap_or(&stored.googlechat_audience)
        .to_string();

    let whatsapp_cfg = cfg.get("channels").and_then(|v| v.get("whatsapp"));
    let whatsapp_enabled = whatsapp_cfg
        .and_then(|v| v.get("enabled"))
        .and_then(|v| v.as_bool())
        .unwrap_or(stored.whatsapp_enabled);
    let whatsapp_allow_from = whatsapp_cfg
        .and_then(|v| v.get("allowFrom"))
        .and_then(|v| v.as_array())
        .and_then(|arr| arr.first())
        .and_then(|v| v.as_str())
        .unwrap_or(&stored.whatsapp_allow_from)
        .to_string();
    let bridge_enabled = false;
    let bridge_tailnet_ip = String::new();
    let bridge_port = 0;
    let bridge_pairing_expires_at_ms = 0;
    let bridge_device_id = String::new();
    let bridge_device_name = String::new();
    let bridge_devices: Vec<BridgeDeviceSummary> = Vec::new();
    let bridge_device_count = 0;
    let bridge_online_count = 0;
    let bridge_paired = false;
    let tools = if gateway_running {
        read_container_file(&workspace_file("TOOLS.md")).unwrap_or_default()
    } else {
        String::new()
    };
    let capabilities = if tools.trim().is_empty() {
        stored.capabilities.clone()
    } else {
        vec![
            CapabilityState {
                id: "web".to_string(),
                label: "Web search".to_string(),
                enabled: tools.contains("[x] Web search"),
            },
            CapabilityState {
                id: "browser".to_string(),
                label: "Browser automation".to_string(),
                enabled: tools.contains("[x] Browser automation"),
            },
            CapabilityState {
                id: "files".to_string(),
                label: "Read/write files".to_string(),
                enabled: tools.contains("[x] Read/write files"),
            },
        ]
    };

    let final_tasks = if heartbeat_tasks.is_empty() {
        stored.heartbeat_tasks.clone()
    } else {
        heartbeat_tasks
    };

    Ok(AgentProfileState {
        soul: if soul.trim().is_empty() {
            stored.soul
        } else {
            soul
        },
        identity_name,
        identity_avatar,
        heartbeat_every,
        heartbeat_tasks: final_tasks,
        memory_enabled,
        memory_long_term: if memory_slot == "none" {
            false
        } else {
            memory_long_term
        },
        memory_qmd_enabled,
        memory_sessions_enabled,
        capabilities,
        discord_enabled,
        discord_token,
        telegram_enabled,
        telegram_token,
        telegram_dm_policy,
        telegram_group_policy,
        telegram_config_writes,
        telegram_require_mention,
        telegram_reply_to_mode,
        telegram_link_preview,
        slack_enabled,
        slack_bot_token,
        slack_app_token,
        googlechat_enabled,
        googlechat_service_account,
        googlechat_audience_type,
        googlechat_audience,
        whatsapp_enabled,
        whatsapp_allow_from,
        bridge_enabled,
        bridge_tailnet_ip,
        bridge_port,
        bridge_pairing_expires_at_ms,
        bridge_device_id,
        bridge_device_name,
        bridge_devices: bridge_devices.clone(),
        bridge_device_count,
        bridge_online_count,
        bridge_paired,
    })
}

#[tauri::command]
pub async fn set_personality(app: AppHandle, soul: String) -> Result<(), String> {
    write_container_file(&workspace_file("SOUL.md"), &soul)?;
    let mut settings = load_agent_settings(&app);
    settings.soul = soul;
    save_agent_settings(&app, settings)?;
    Ok(())
}

#[tauri::command]
pub async fn sync_onboarding_to_settings(
    app: AppHandle,
    soul: String,
    agent_name: String,
) -> Result<(), String> {
    let mut settings = load_agent_settings(&app);
    settings.soul = soul;
    settings.identity_name = agent_name;
    save_agent_settings(&app, settings)?;
    Ok(())
}

#[tauri::command]
pub async fn set_heartbeat(
    app: AppHandle,
    every: String,
    tasks: Vec<String>,
) -> Result<(), String> {
    let mut cfg = read_openclaw_config();
    normalize_openclaw_config(&mut cfg);
    set_openclaw_config_value(
        &mut cfg,
        &["agents", "defaults", "heartbeat"],
        serde_json::json!({ "every": every }),
    );
    write_openclaw_config(&cfg)?;

    let mut body = String::from("# HEARTBEAT.md\n\n");
    if tasks.is_empty() {
        body.push_str(
            "# Keep this file empty (or with only comments) to skip heartbeat API calls.\n",
        );
    } else {
        for task in &tasks {
            if !task.trim().is_empty() {
                body.push_str(&format!("- {}\n", task.trim()));
            }
        }
    }
    write_container_file(&workspace_file("HEARTBEAT.md"), &body)?;
    let mut settings = load_agent_settings(&app);
    settings.heartbeat_every = every;
    settings.heartbeat_tasks = tasks;
    save_agent_settings(&app, settings)?;
    Ok(())
}

#[tauri::command]
pub async fn set_memory(
    app: AppHandle,
    memory_enabled: bool,
    long_term: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut settings = load_agent_settings(&app);
    let mut cfg = read_openclaw_config();
    normalize_openclaw_config(&mut cfg);
    let slot = if !memory_enabled {
        "none"
    } else if long_term {
        "memory-lancedb"
    } else {
        "memory-core"
    };

    set_openclaw_config_value(
        &mut cfg,
        &["plugins", "slots", "memory"],
        serde_json::json!(slot),
    );

    if slot == "memory-lancedb" {
        let keys = state.api_keys.lock().map_err(|e| e.to_string())?;
        let openai_key = keys
            .get("openai")
            .ok_or_else(|| "OpenAI key required for long-term memory".to_string())?;
        set_openclaw_config_value(
            &mut cfg,
            &["plugins", "entries", "memory-lancedb", "enabled"],
            serde_json::json!(true),
        );
        set_openclaw_config_value(
            &mut cfg,
            &[
                "plugins",
                "entries",
                "memory-lancedb",
                "config",
                "embedding",
            ],
            serde_json::json!({
                "apiKey": openai_key,
                "model": "text-embedding-3-small"
            }),
        );
    } else {
        remove_openclaw_config_value(&mut cfg, &["plugins", "entries", "memory-lancedb"]);
    }

    let memory_sessions_enabled = settings.memory_sessions_enabled;
    apply_default_qmd_memory_config(
        &mut cfg,
        slot,
        memory_sessions_enabled,
        settings.memory_qmd_enabled,
    );

    write_openclaw_config(&cfg)?;
    settings.memory_enabled = memory_enabled;
    settings.memory_long_term = long_term;
    save_agent_settings(&app, settings)?;
    Ok(())
}

#[tauri::command]
pub async fn set_memory_qmd_enabled(app: AppHandle, enabled: bool) -> Result<(), String> {
    let mut settings = load_agent_settings(&app);
    let mut cfg = read_openclaw_config();
    normalize_openclaw_config(&mut cfg);
    let slot = cfg
        .get("plugins")
        .and_then(|plugins| plugins.get("slots"))
        .and_then(|slots| slots.get("memory"))
        .and_then(|value| value.as_str())
        .unwrap_or(if settings.memory_enabled {
            if settings.memory_long_term {
                "memory-lancedb"
            } else {
                "memory-core"
            }
        } else {
            "none"
        })
        .to_string();

    if enabled {
        ensure_qmd_runtime_dependencies()?;
    }

    let memory_sessions_enabled = settings.memory_sessions_enabled;
    apply_default_qmd_memory_config(&mut cfg, &slot, memory_sessions_enabled, enabled);
    write_openclaw_config(&cfg)?;

    settings.memory_qmd_enabled = enabled;
    save_agent_settings(&app, settings)?;
    Ok(())
}

#[tauri::command]
pub async fn set_memory_session_indexing(app: AppHandle, enabled: bool) -> Result<(), String> {
    let mut settings = load_agent_settings(&app);
    let mut cfg = read_openclaw_config();
    normalize_openclaw_config(&mut cfg);
    let slot = cfg
        .get("plugins")
        .and_then(|plugins| plugins.get("slots"))
        .and_then(|slots| slots.get("memory"))
        .and_then(|value| value.as_str())
        .unwrap_or(if settings.memory_enabled {
            if settings.memory_long_term {
                "memory-lancedb"
            } else {
                "memory-core"
            }
        } else {
            "none"
        })
        .to_string();
    apply_default_qmd_memory_config(&mut cfg, &slot, enabled, settings.memory_qmd_enabled);
    write_openclaw_config(&cfg)?;
    settings.memory_sessions_enabled = enabled;
    save_agent_settings(&app, settings)?;
    Ok(())
}

#[tauri::command]
pub async fn set_capabilities(app: AppHandle, list: Vec<CapabilityState>) -> Result<(), String> {
    let mut body = String::from("# TOOLS.md - Local Notes\n\n## Capabilities\n");
    for cap in &list {
        let mark = if cap.enabled { "x" } else { " " };
        body.push_str(&format!("- [{}] {}\n", mark, cap.label));
    }
    write_container_file(&workspace_file("TOOLS.md"), &body)?;
    let mut settings = load_agent_settings(&app);
    settings.capabilities = list;
    save_agent_settings(&app, settings)?;
    Ok(())
}

#[tauri::command]
pub async fn set_identity(
    app: AppHandle,
    name: String,
    avatar_data_url: Option<String>,
) -> Result<(), String> {
    let existing = read_container_file(&workspace_file("IDENTITY.md")).unwrap_or_default();
    let stored = load_agent_settings(&app);
    let next_name = sanitize_identity_name(&name)
        .or_else(|| {
            parse_markdown_bold_field(&existing, "Name")
                .and_then(|value| sanitize_identity_name(&value))
        })
        .or_else(|| sanitize_identity_name(&stored.identity_name))
        .unwrap_or_else(|| "Entropic".to_string());
    let creature = parse_markdown_bold_field(&existing, "Creature").unwrap_or_default();
    let vibe = parse_markdown_bold_field(&existing, "Vibe").unwrap_or_default();
    let emoji = parse_markdown_bold_field(&existing, "Emoji").unwrap_or_default();
    let mut body = String::from("# IDENTITY.md - Who Am I?\n\n");
    body.push_str(&format!("- **Name:** {}\n", next_name));
    body.push_str(&format!("- **Creature:** {}\n", creature));
    body.push_str(&format!("- **Vibe:** {}\n", vibe));
    body.push_str(&format!("- **Emoji:** {}\n", emoji));
    if let Some(ref url) = avatar_data_url {
        body.push_str(&format!("- **Avatar:** {}\n", url));
    } else {
        body.push_str("- **Avatar:**\n");
    }
    write_container_file(&workspace_file("IDENTITY.md"), &body)?;
    let mut settings = stored;
    settings.identity_name = next_name;
    settings.identity_avatar = avatar_data_url;
    save_agent_settings(&app, settings)?;
    Ok(())
}

#[tauri::command]
pub async fn set_channels_config(
    app: AppHandle,
    discord_enabled: bool,
    discord_token: String,
    telegram_enabled: bool,
    telegram_token: String,
    telegram_dm_policy: String,
    telegram_group_policy: String,
    telegram_config_writes: bool,
    telegram_require_mention: bool,
    telegram_reply_to_mode: String,
    telegram_link_preview: bool,
    slack_enabled: bool,
    slack_bot_token: String,
    slack_app_token: String,
    googlechat_enabled: bool,
    googlechat_service_account: String,
    googlechat_audience_type: String,
    googlechat_audience: String,
    whatsapp_enabled: bool,
    whatsapp_allow_from: String,
) -> Result<(), String> {
    eprintln!(
        "[set_channels_config] Called with telegram_enabled={}, token_len={}, dm_policy={}, group_policy={}, require_mention={}, config_writes={}",
        telegram_enabled,
        telegram_token.len(),
        telegram_dm_policy,
        telegram_group_policy,
        telegram_require_mention,
        telegram_config_writes
    );

    let mut cfg = read_openclaw_config();
    normalize_openclaw_config(&mut cfg);
    eprintln!("[set_channels_config] OpenClaw config read and normalized successfully");

    let discord_token = discord_token.trim().to_string();
    let telegram_token = telegram_token.trim().to_string();
    let telegram_dm_policy = match telegram_dm_policy.trim() {
        "allowlist" => "allowlist".to_string(),
        "open" => "open".to_string(),
        "disabled" => "disabled".to_string(),
        _ => "pairing".to_string(),
    };
    let telegram_group_policy = match telegram_group_policy.trim() {
        "open" => "open".to_string(),
        "disabled" => "disabled".to_string(),
        _ => "allowlist".to_string(),
    };
    let telegram_reply_to_mode = match telegram_reply_to_mode.trim() {
        "first" => "first".to_string(),
        "all" => "all".to_string(),
        _ => "off".to_string(),
    };
    let slack_bot_token = slack_bot_token.trim().to_string();
    let slack_app_token = slack_app_token.trim().to_string();
    let googlechat_service_account = googlechat_service_account.trim().to_string();
    let googlechat_audience = googlechat_audience.trim().to_string();
    let googlechat_audience_type = match googlechat_audience_type.trim() {
        "project-number" => "project-number".to_string(),
        _ => "app-url".to_string(),
    };
    let whatsapp_allow_from = whatsapp_allow_from.trim().to_string();

    set_openclaw_config_value(
        &mut cfg,
        &["channels", "telegram", "enabled"],
        serde_json::json!(telegram_enabled),
    );
    set_openclaw_config_value(
        &mut cfg,
        &["channels", "telegram", "botToken"],
        serde_json::json!(telegram_token),
    );
    set_openclaw_config_value(
        &mut cfg,
        &["channels", "telegram", "dmPolicy"],
        serde_json::json!(telegram_dm_policy),
    );
    normalize_telegram_allow_from_for_dm_policy(&mut cfg, &telegram_dm_policy);
    set_openclaw_config_value(
        &mut cfg,
        &["channels", "telegram", "groupPolicy"],
        serde_json::json!(telegram_group_policy),
    );
    set_openclaw_config_value(
        &mut cfg,
        &["channels", "telegram", "configWrites"],
        serde_json::json!(telegram_config_writes),
    );
    set_openclaw_config_value(
        &mut cfg,
        &["channels", "telegram", "groups", "*", "requireMention"],
        serde_json::json!(telegram_require_mention),
    );
    set_openclaw_config_value(
        &mut cfg,
        &["channels", "telegram", "replyToMode"],
        serde_json::json!(telegram_reply_to_mode),
    );
    set_openclaw_config_value(
        &mut cfg,
        &["channels", "telegram", "linkPreview"],
        serde_json::json!(telegram_link_preview),
    );
    set_openclaw_config_value(
        &mut cfg,
        &["plugins", "entries", "telegram", "enabled"],
        serde_json::json!(telegram_enabled),
    );

    eprintln!("[set_channels_config] Writing OpenClaw config...");
    write_openclaw_config(&cfg)?;
    eprintln!("[set_channels_config] OpenClaw config written successfully");

    // When Telegram is being disabled/disconnected, clear the persistent pairing
    // allowFrom credential files from the container. Without this, the next
    // connection attempt skips the pairing code flow because the gateway still
    // sees authorised chat IDs from the previous session.
    if !telegram_enabled && telegram_token.is_empty() {
        let container = if named_gateway_container_exists(OPENCLAW_CONTAINER, true) {
            Some(OPENCLAW_CONTAINER)
        } else if named_gateway_container_exists(LEGACY_OPENCLAW_CONTAINER, true) {
            Some(LEGACY_OPENCLAW_CONTAINER)
        } else {
            None
        };
        if let Some(container) = container {
            let clear_script = r#"
const fs = require('fs');
const paths = [
  '/data/credentials/telegram-default-allowFrom.json',
  '/data/credentials/telegram-allowFrom.json',
];
for (const p of paths) {
  try { fs.unlinkSync(p); } catch {}
}
process.stdout.write('ok');
"#;
            let args = ["exec", container, "node", "-e", clear_script];
            match docker_exec_output(&args) {
                Ok(_) => eprintln!("[set_channels_config] Cleared Telegram allowFrom credential files"),
                Err(e) => eprintln!("[set_channels_config] Failed to clear Telegram allowFrom files (non-fatal): {}", e),
            }
        }
    }

    eprintln!("[set_channels_config] Loading agent settings...");
    let mut settings = load_agent_settings(&app);
    settings.discord_enabled = discord_enabled;
    settings.discord_token = discord_token;
    settings.telegram_enabled = telegram_enabled;
    settings.telegram_token = telegram_token.clone();
    settings.telegram_dm_policy = telegram_dm_policy;
    settings.telegram_group_policy = telegram_group_policy;
    settings.telegram_config_writes = telegram_config_writes;
    settings.telegram_require_mention = telegram_require_mention;
    settings.telegram_reply_to_mode = telegram_reply_to_mode;
    settings.telegram_link_preview = telegram_link_preview;
    settings.slack_enabled = slack_enabled;
    settings.slack_bot_token = slack_bot_token;
    settings.slack_app_token = slack_app_token;
    settings.googlechat_enabled = googlechat_enabled;
    settings.googlechat_service_account = googlechat_service_account;
    settings.googlechat_audience_type = googlechat_audience_type;
    settings.googlechat_audience = googlechat_audience;
    settings.whatsapp_enabled = whatsapp_enabled;
    settings.whatsapp_allow_from = whatsapp_allow_from;
    eprintln!("[set_channels_config] Saving agent settings...");
    save_agent_settings(&app, settings)?;
    eprintln!("[set_channels_config] Agent settings saved successfully");

    // The config write triggers the gateway's file watcher which sends SIGUSR1,
    // causing a brief internal restart. Wait for the gateway to come back healthy
    // so the frontend doesn't see a jarring disconnect/error cycle.
    if container_running() {
        let _ = app.emit("gateway-restarting", ());
        if let Ok(token) = effective_gateway_token(&app) {
            eprintln!("[set_channels_config] Waiting for gateway to recover after config write...");
            // Give the file watcher a moment to detect the change and trigger SIGUSR1
            tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
            match wait_for_gateway_health_strict(&token, 12).await {
                Ok(()) => eprintln!("[set_channels_config] Gateway healthy after config update"),
                Err(e) => eprintln!(
                    "[set_channels_config] Gateway health wait timed out (non-fatal): {}",
                    e
                ),
            }
        }
    }

    eprintln!("[set_channels_config] Completed successfully");
    Ok(())
}

#[tauri::command]
pub async fn approve_pairing(channel: String, code: String) -> Result<String, String> {
    eprintln!(
        "[approve_pairing] Called with channel='{}', code length={}",
        channel,
        code.len()
    );

    let channel = channel.trim();
    let code = code.trim();
    if channel.is_empty() || code.is_empty() {
        eprintln!("[approve_pairing] Error: channel or code is empty");
        return Err("Channel and code are required".to_string());
    }
    let args = [
        "exec",
        OPENCLAW_CONTAINER,
        "node",
        "/app/dist/index.js",
        "pairing",
        "approve",
        channel,
        code,
    ];
    eprintln!("[approve_pairing] Executing docker command...");
    let result = docker_exec_output(&args);
    eprintln!("[approve_pairing] Docker command result: {:?}", result);
    result
}

#[tauri::command]
pub async fn get_telegram_connection_status() -> Result<bool, String> {
    let container = if named_gateway_container_exists(OPENCLAW_CONTAINER, true) {
        OPENCLAW_CONTAINER
    } else if named_gateway_container_exists(LEGACY_OPENCLAW_CONTAINER, true) {
        LEGACY_OPENCLAW_CONTAINER
    } else {
        return Ok(false);
    };

    // Treat Telegram as "connected" once pairing allowFrom store has at least one entry.
    // This aligns with OpenClaw DM/group authorization flow backed by pairing store.
    let script = r#"const fs=require('fs');
const paths=['/data/credentials/telegram-default-allowFrom.json','/data/credentials/telegram-allowFrom.json'];
let connected=false;
for (const p of paths) {
  try {
    const parsed=JSON.parse(fs.readFileSync(p,'utf8'));
    if (Array.isArray(parsed.allowFrom) && parsed.allowFrom.some(v => String(v ?? '').trim().length > 0)) {
      connected=true;
      break;
    }
  } catch {}
}
process.stdout.write(connected ? '1' : '0');"#;

    let args = ["exec", container, "node", "-e", script];
    match docker_exec_output(&args) {
        Ok(output) => Ok(output.trim() == "1"),
        Err(_) => Ok(false),
    }
}

#[tauri::command]
pub async fn validate_telegram_token(
    token: String,
) -> Result<TelegramTokenValidationResult, String> {
    let token = token.trim();
    if token.is_empty() {
        return Err("Bot token is required".to_string());
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|e| format!("Failed to initialize Telegram validation client: {}", e))?;

    let url = format!("https://api.telegram.org/bot{}/getMe", token);
    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Telegram token validation request failed: {}", e))?;

    let status = response.status();
    let payload: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Invalid Telegram response: {}", e))?;

    let ok = payload
        .get("ok")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    if !status.is_success() || !ok {
        let message = payload
            .get("description")
            .and_then(|value| value.as_str())
            .unwrap_or("Telegram rejected the bot token.")
            .to_string();

        return Ok(TelegramTokenValidationResult {
            valid: false,
            bot_id: None,
            username: None,
            display_name: None,
            message,
        });
    }

    let bot = payload
        .get("result")
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    let bot_id = bot.get("id").and_then(|value| value.as_i64());
    let username = bot
        .get("username")
        .and_then(|value| value.as_str())
        .map(ToOwned::to_owned);
    let first_name = bot
        .get("first_name")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    let last_name = bot
        .get("last_name")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    let display_name = format!("{} {}", first_name.trim(), last_name.trim())
        .trim()
        .to_string();
    let display_name = if display_name.is_empty() {
        None
    } else {
        Some(display_name)
    };

    let message = if let Some(name) = username.as_deref() {
        format!("Valid token for @{}.", name)
    } else {
        "Valid bot token.".to_string()
    };

    Ok(TelegramTokenValidationResult {
        valid: true,
        bot_id,
        username,
        display_name,
        message,
    })
}

#[tauri::command]
pub async fn send_telegram_welcome_message() -> Result<(), String> {
    let container = if named_gateway_container_exists(OPENCLAW_CONTAINER, true) {
        OPENCLAW_CONTAINER
    } else if named_gateway_container_exists(LEGACY_OPENCLAW_CONTAINER, true) {
        LEGACY_OPENCLAW_CONTAINER
    } else {
        return Err("Gateway container not found".to_string());
    };

    // Read bot token and authorized chat IDs from gateway container
    let script = r#"const fs=require('fs');
const config=JSON.parse(fs.readFileSync('/data/config.json','utf8'));
const token=config.channels?.telegram?.token || '';
const paths=['/data/credentials/telegram-default-allowFrom.json','/data/credentials/telegram-allowFrom.json'];
let chatIds=[];
for (const p of paths) {
  try {
    const parsed=JSON.parse(fs.readFileSync(p,'utf8'));
    if (Array.isArray(parsed.allowFrom)) {
      chatIds=parsed.allowFrom.filter(v => String(v ?? '').trim().length > 0);
      break;
    }
  } catch {}
}
console.log(JSON.stringify({token,chatIds}));"#;

    let args = ["exec", container, "node", "-e", script];
    let output = docker_exec_output(&args)
        .map_err(|e| format!("Failed to read Telegram config from gateway: {}", e))?;

    let data: serde_json::Value = serde_json::from_str(&output.trim())
        .map_err(|e| format!("Failed to parse gateway Telegram config: {}", e))?;

    let token = data
        .get("token")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let chat_ids: Vec<i64> = data
        .get("chatIds")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|v| v.as_i64()).collect())
        .unwrap_or_default();

    if token.is_empty() {
        return Err("Bot token not configured".to_string());
    }

    if chat_ids.is_empty() {
        return Err("No authorized chats found".to_string());
    }

    // Send welcome message to each authorized chat
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let welcome_message = "✅ Bot connected! I'm ready to chat.";

    for chat_id in chat_ids {
        let url = format!("https://api.telegram.org/bot{}/sendMessage", token);
        let payload = serde_json::json!({
            "chat_id": chat_id,
            "text": welcome_message,
        });

        match client.post(&url).json(&payload).send().await {
            Ok(resp) => {
                if !resp.status().is_success() {
                    eprintln!(
                        "Failed to send welcome message to chat {}: HTTP {}",
                        chat_id,
                        resp.status()
                    );
                }
            }
            Err(e) => {
                eprintln!("Failed to send welcome message to chat {}: {}", chat_id, e);
            }
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn start_whatsapp_login(
    force: bool,
    timeout_ms: Option<u64>,
    app: AppHandle,
) -> Result<WhatsAppLoginState, String> {
    let _ = timeout_ms;
    let token = expected_gateway_token(&app)?;
    let result = call_whatsapp_qr_endpoint("start", force, &token).await?;
    let state = app.state::<AppState>();
    let mut cache = state.whatsapp_login.lock().map_err(|e| e.to_string())?;
    cache.status = result.status.clone();
    cache.message = result.message.clone();
    cache.qr_data_url = result.qr_data_url.clone();
    cache.connected = result.connected;
    cache.last_error = result.last_error.clone();
    cache.error_status = result.error_status;
    cache.updated_at_ms = current_millis();
    Ok(result)
}

#[tauri::command]
pub async fn wait_whatsapp_login(timeout_ms: Option<u64>) -> Result<WhatsAppLoginState, String> {
    let timeout = timeout_ms.unwrap_or(60000);
    let script = format!(
        "import('/app/dist/web/login-qr.js').then(m=>m.waitForWebLogin({{timeoutMs:{}}})).then(r=>{{console.log(JSON.stringify(r))}}).catch(err=>{{console.error(String(err));process.exit(1);}});",
        timeout
    );
    let value = run_whatsapp_login_script(&script).await?;
    Ok(WhatsAppLoginState {
        status: "waiting".to_string(),
        message: value
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("Waiting for scan.")
            .to_string(),
        qr_data_url: None,
        connected: value.get("connected").and_then(|v| v.as_bool()),
        last_error: None,
        error_status: None,
        updated_at_ms: current_millis(),
    })
}

#[tauri::command]
pub async fn get_whatsapp_login(app: AppHandle) -> Result<WhatsAppLoginState, String> {
    let token = expected_gateway_token(&app)?;
    let result = call_whatsapp_qr_endpoint("status", false, &token).await?;
    let state = app.state::<AppState>();
    let mut cache = state.whatsapp_login.lock().map_err(|e| e.to_string())?;
    cache.status = result.status.clone();
    cache.message = result.message.clone();
    cache.qr_data_url = result.qr_data_url.clone();
    cache.connected = result.connected;
    cache.last_error = result.last_error.clone();
    cache.error_status = result.error_status;
    cache.updated_at_ms = current_millis();
    Ok(result)
}
