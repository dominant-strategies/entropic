use crate::runtime::{Runtime, RuntimeStatus};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

pub struct AppState {
    pub setup_progress: Mutex<SetupProgress>,
    pub api_keys: Mutex<HashMap<String, String>>,
    pub active_provider: Mutex<Option<String>>,
}

#[derive(Debug, Clone, serde::Serialize, Default)]
pub struct SetupProgress {
    pub stage: String,
    pub message: String,
    pub percent: u8,
    pub complete: bool,
    pub error: Option<String>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            setup_progress: Mutex::new(SetupProgress::default()),
            api_keys: Mutex::new(HashMap::new()),
            active_provider: Mutex::new(None),
        }
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct AuthState {
    pub active_provider: Option<String>,
    pub providers: Vec<AuthProviderStatus>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct AuthProviderStatus {
    pub id: String,
    pub has_key: bool,
    pub last4: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct AgentProfileState {
    pub soul: String,
    pub heartbeat_every: String,
    pub heartbeat_tasks: Vec<String>,
    pub memory_enabled: bool,
    pub memory_long_term: bool,
    pub capabilities: Vec<CapabilityState>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CapabilityState {
    pub id: String,
    pub label: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct StoredAuth {
    version: u8,
    keys: HashMap<String, String>,
    active_provider: Option<String>,
    agent_settings: Option<StoredAgentSettings>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct StoredAgentSettings {
    soul: String,
    heartbeat_every: String,
    heartbeat_tasks: Vec<String>,
    memory_enabled: bool,
    memory_long_term: bool,
    capabilities: Vec<CapabilityState>,
    identity_name: String,
    identity_avatar: Option<String>,
}

impl Default for StoredAuth {
    fn default() -> Self {
        Self {
            version: 1,
            keys: HashMap::new(),
            active_provider: None,
            agent_settings: None,
        }
    }
}

fn get_runtime(app: &AppHandle) -> Runtime {
    let resource_dir = app
        .path()
        .resource_dir()
        .unwrap_or_default();
    Runtime::new(resource_dir)
}

const OPENCLAW_CONTAINER: &str = "zara-openclaw";

fn docker_exec_output(args: &[&str]) -> Result<String, String> {
    let output = Command::new("docker")
        .args(args)
        .output()
        .map_err(|e| format!("Failed to run docker: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(stderr.to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn read_container_file(path: &str) -> Option<String> {
    let args = ["exec", OPENCLAW_CONTAINER, "sh", "-c", &format!("cat {}", path)];
    match docker_exec_output(&args) {
        Ok(s) => Some(s),
        Err(_) => None,
    }
}

fn write_container_file(path: &str, content: &str) -> Result<(), String> {
    let dir_cmd = format!("mkdir -p $(dirname {})", path);
    docker_exec_output(&["exec", OPENCLAW_CONTAINER, "sh", "-c", &dir_cmd])?;
    let mut child = Command::new("docker")
        .args(["exec", "-i", OPENCLAW_CONTAINER, "sh", "-c", &format!("cat > {}", path)])
        .stdin(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to write file: {}", e))?;
    if let Some(stdin) = child.stdin.as_mut() {
        use std::io::Write;
        stdin
            .write_all(content.as_bytes())
            .map_err(|e| format!("Failed to write file: {}", e))?;
    }
    let status = child
        .wait()
        .map_err(|e| format!("Failed to finalize write: {}", e))?;
    if !status.success() {
        return Err("Failed to write file in container".to_string());
    }
    Ok(())
}

fn read_openclaw_config() -> serde_json::Value {
    if let Some(raw) = read_container_file("/home/node/.openclaw/openclaw.json") {
        if let Ok(val) = serde_json::from_str(&raw) {
            return val;
        }
    }
    serde_json::json!({})
}

fn write_openclaw_config(value: &serde_json::Value) -> Result<(), String> {
    let payload = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    write_container_file("/home/node/.openclaw/openclaw.json", &payload)
}

fn apply_agent_settings(app: &AppHandle, state: &AppState) -> Result<(), String> {
    let settings = load_agent_settings(app);

    if !settings.soul.trim().is_empty() {
        write_container_file("/home/node/.openclaw/workspace/SOUL.md", &settings.soul)?;
    }

    let mut hb_body = String::from("# HEARTBEAT.md\n\n");
    if settings.heartbeat_tasks.is_empty() {
        hb_body.push_str("# Keep this file empty (or with only comments) to skip heartbeat API calls.\n");
    } else {
        for task in &settings.heartbeat_tasks {
            if !task.trim().is_empty() {
                hb_body.push_str(&format!("- {}\n", task.trim()));
            }
        }
    }
    write_container_file("/home/node/.openclaw/workspace/HEARTBEAT.md", &hb_body)?;

    let mut tools_body = String::from("# TOOLS.md - Local Notes\n\n## Capabilities\n");
    for cap in &settings.capabilities {
        let mark = if cap.enabled { "x" } else { " " };
        tools_body.push_str(&format!("- [{}] {}\n", mark, cap.label));
    }
    write_container_file("/home/node/.openclaw/workspace/TOOLS.md", &tools_body)?;

    let mut id_body = String::from("# IDENTITY.md - Who Am I?\n\n");
    id_body.push_str(&format!("- **Name:** {}\n", settings.identity_name.trim()));
    id_body.push_str("- **Creature:**\n- **Vibe:**\n- **Emoji:**\n");
    if let Some(url) = &settings.identity_avatar {
        id_body.push_str(&format!("- **Avatar:** {}\n", url));
    } else {
        id_body.push_str("- **Avatar:**\n");
    }
    write_container_file("/home/node/.openclaw/workspace/IDENTITY.md", &id_body)?;

    let mut cfg = read_openclaw_config();
    cfg["agents"]["defaults"]["heartbeat"] = serde_json::json!({
        "every": settings.heartbeat_every
    });

    let slot = if !settings.memory_enabled {
        "none"
    } else if settings.memory_long_term {
        "memory-lancedb"
    } else {
        "memory-core"
    };
    cfg["plugins"]["slots"]["memory"] = serde_json::json!(slot);

    if slot == "memory-lancedb" {
        let keys = state.api_keys.lock().map_err(|e| e.to_string())?;
        if let Some(openai_key) = keys.get("openai") {
            cfg["plugins"]["entries"]["memory-lancedb"]["enabled"] = serde_json::json!(true);
            cfg["plugins"]["entries"]["memory-lancedb"]["config"]["embedding"] = serde_json::json!({
                "apiKey": openai_key,
                "model": "text-embedding-3-small"
            });
        } else {
            cfg["plugins"]["slots"]["memory"] = serde_json::json!("memory-core");
        }
    }

    write_openclaw_config(&cfg)?;
    Ok(())
}

fn auth_store_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "Failed to resolve app data dir".to_string())?;
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create app data dir: {}", e))?;
    Ok(dir.join("auth.json"))
}

fn load_auth(app: &AppHandle) -> StoredAuth {
    let path = match auth_store_path(app) {
        Ok(p) => p,
        Err(_) => return StoredAuth::default(),
    };
    let raw = match fs::read_to_string(&path) {
        Ok(data) => data,
        Err(_) => return StoredAuth::default(),
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

fn save_auth(app: &AppHandle, data: &StoredAuth) -> Result<(), String> {
    let path = auth_store_path(app)?;
    let payload = serde_json::to_string_pretty(data).map_err(|e| e.to_string())?;
    fs::write(&path, payload).map_err(|e| format!("Failed to write auth store: {}", e))?;
    Ok(())
}

fn default_agent_settings() -> StoredAgentSettings {
    StoredAgentSettings {
        soul: String::new(),
        heartbeat_every: "30m".to_string(),
        heartbeat_tasks: Vec::new(),
        memory_enabled: true,
        memory_long_term: true,
        capabilities: vec![
            CapabilityState {
                id: "web".to_string(),
                label: "Web search".to_string(),
                enabled: true,
            },
            CapabilityState {
                id: "browser".to_string(),
                label: "Browser automation".to_string(),
                enabled: true,
            },
            CapabilityState {
                id: "files".to_string(),
                label: "Read/write files".to_string(),
                enabled: true,
            },
        ],
        identity_name: "Zara".to_string(),
        identity_avatar: None,
    }
}

fn load_agent_settings(app: &AppHandle) -> StoredAgentSettings {
    let stored = load_auth(app);
    stored.agent_settings.unwrap_or_else(default_agent_settings)
}

fn save_agent_settings(app: &AppHandle, settings: StoredAgentSettings) -> Result<(), String> {
    let mut stored = load_auth(app);
    stored.agent_settings = Some(settings);
    save_auth(app, &stored)
}

pub fn init_state(app: &AppHandle) -> AppState {
    let stored = load_auth(app);
    AppState {
        setup_progress: Mutex::new(SetupProgress::default()),
        api_keys: Mutex::new(stored.keys.clone()),
        active_provider: Mutex::new(stored.active_provider.clone()),
    }
}

#[tauri::command]
pub async fn check_runtime_status(app: AppHandle) -> Result<RuntimeStatus, String> {
    let runtime = get_runtime(&app);
    Ok(runtime.check_status())
}

#[tauri::command]
pub async fn start_runtime(app: AppHandle) -> Result<(), String> {
    let runtime = get_runtime(&app);
    runtime.start_colima().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn stop_runtime(app: AppHandle) -> Result<(), String> {
    let runtime = get_runtime(&app);
    runtime.stop_colima().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_api_key(
    app: AppHandle,
    state: State<'_, AppState>,
    provider: String,
    key: String,
) -> Result<(), String> {
    let mut keys = state.api_keys.lock().map_err(|e| e.to_string())?;
    keys.insert(provider.clone(), key);
    let mut active = state.active_provider.lock().map_err(|e| e.to_string())?;
    *active = Some(provider.clone());
    let mut stored = load_auth(&app);
    stored.keys = keys.clone();
    stored.active_provider = active.clone();
    save_auth(&app, &stored)?;
    Ok(())
}

#[tauri::command]
pub async fn set_active_provider(
    app: AppHandle,
    state: State<'_, AppState>,
    provider: String,
) -> Result<(), String> {
    let keys = state.api_keys.lock().map_err(|e| e.to_string())?;
    if !keys.contains_key(&provider) {
        return Err("No API key stored for selected provider".to_string());
    }
    drop(keys);
    let mut active = state.active_provider.lock().map_err(|e| e.to_string())?;
    *active = Some(provider.clone());
    let keys = state.api_keys.lock().map_err(|e| e.to_string())?.clone();
    let mut stored = load_auth(&app);
    stored.keys = keys;
    stored.active_provider = active.clone();
    save_auth(&app, &stored)?;
    Ok(())
}

#[tauri::command]
pub async fn get_auth_state(state: State<'_, AppState>) -> Result<AuthState, String> {
    let keys = state.api_keys.lock().map_err(|e| e.to_string())?;
    let active = state.active_provider.lock().map_err(|e| e.to_string())?;
    let providers = ["anthropic", "openai", "google"]
        .into_iter()
        .map(|id| {
            let last4 = keys.get(id).and_then(|k| {
                if k.len() >= 4 {
                    Some(k[k.len() - 4..].to_string())
                } else {
                    None
                }
            });
            AuthProviderStatus {
                id: id.to_string(),
                has_key: keys.contains_key(id),
                last4,
            }
        })
        .collect();
    Ok(AuthState {
        active_provider: active.clone(),
        providers,
    })
}

#[tauri::command]
pub async fn start_gateway(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    // Get API keys from state
    let api_keys = state.api_keys.lock().map_err(|e| e.to_string())?.clone();
    let active_provider = state
        .active_provider
        .lock()
        .map_err(|e| e.to_string())?
        .clone();

    // Check if zara-openclaw container exists
    let check = Command::new("docker")
        .args(["ps", "-q", "-f", "name=zara-openclaw"])
        .output()
        .map_err(|e| format!("Failed to check container: {}", e))?;

    if !check.stdout.is_empty() {
        // Container already running
        return Ok(());
    }

    // Check if container exists but stopped
    let check_all = Command::new("docker")
        .args(["ps", "-aq", "-f", "name=zara-openclaw"])
        .output()
        .map_err(|e| format!("Failed to check container: {}", e))?;

    if !check_all.stdout.is_empty() {
        // Start existing container
        let start = Command::new("docker")
            .args(["start", "zara-openclaw"])
            .output()
            .map_err(|e| format!("Failed to start container: {}", e))?;

        if !start.status.success() {
            let stderr = String::from_utf8_lossy(&start.stderr);
            return Err(format!("Failed to start container: {}", stderr));
        }
        // Re-apply persisted settings after a restart
        apply_agent_settings(&app, &state)?;
        return Ok(());
    }

    // Container doesn't exist - need to create it
    // Create network if it doesn't exist
    let _ = Command::new("docker")
        .args(["network", "create", "zara-net"])
        .output(); // Ignore error if already exists

    // Check if image exists
    let image_check = Command::new("docker")
        .args(["image", "inspect", "openclaw-runtime:latest"])
        .output()
        .map_err(|e| format!("Failed to check image: {}", e))?;

    if !image_check.status.success() {
        return Err("OpenClaw runtime image not found. Run: ./scripts/build-openclaw-runtime.sh".to_string());
    }

    // Determine which provider/model to use based on active provider, then fall back
    let model = match active_provider.as_deref() {
        Some("anthropic") if api_keys.contains_key("anthropic") => "anthropic/claude-sonnet-4-20250514",
        Some("openai") if api_keys.contains_key("openai") => "openai/gpt-4o",
        Some("google") if api_keys.contains_key("google") => "google/gemini-2.0-flash",
        _ if api_keys.contains_key("anthropic") => "anthropic/claude-sonnet-4-20250514",
        _ if api_keys.contains_key("openai") => "openai/gpt-4o",
        _ if api_keys.contains_key("google") => "google/gemini-2.0-flash",
        _ => "anthropic/claude-sonnet-4-20250514",
    };

    // Build docker run command - pass API keys as env vars
    // The entrypoint.sh script creates auth-profiles.json from these
    let mut docker_args = vec![
        "run".to_string(), "-d".to_string(),
        "--name".to_string(), "zara-openclaw".to_string(),
        "--user".to_string(), "1000:1000".to_string(),
        "--cap-drop=ALL".to_string(),
        "--security-opt".to_string(), "no-new-privileges".to_string(),
        "--read-only".to_string(),
        "--tmpfs".to_string(), "/tmp:rw,noexec,nosuid,nodev,size=100m".to_string(),
        "--tmpfs".to_string(), "/run:rw,noexec,nosuid,nodev,size=10m".to_string(),
        "--tmpfs".to_string(), "/home/node/.openclaw:rw,noexec,nosuid,nodev,size=50m,uid=1000,gid=1000".to_string(),
        "-e".to_string(), "OPENCLAW_GATEWAY_TOKEN=zara-local-gateway".to_string(),
        "-e".to_string(), format!("OPENCLAW_MODEL={}", model),
    ];

    // Add API keys as environment variables (entrypoint creates auth-profiles.json from these)
    if let Some(key) = api_keys.get("anthropic") {
        docker_args.push("-e".to_string());
        docker_args.push(format!("ANTHROPIC_API_KEY={}", key));
    }
    if let Some(key) = api_keys.get("openai") {
        docker_args.push("-e".to_string());
        docker_args.push(format!("OPENAI_API_KEY={}", key));
    }
    if let Some(key) = api_keys.get("google") {
        docker_args.push("-e".to_string());
        docker_args.push(format!("GEMINI_API_KEY={}", key));
    }

    // Add remaining args
    docker_args.extend([
        "-v".to_string(), "zara-openclaw-data:/data".to_string(),
        "--network".to_string(), "zara-net".to_string(),
        "-p".to_string(), "127.0.0.1:19789:18789".to_string(),
        "--restart".to_string(), "unless-stopped".to_string(),
        "openclaw-runtime:latest".to_string(),
    ]);

    // Dev-only: bind-mount local OpenClaw dist/extensions to avoid image rebuilds
    if let Ok(source) = std::env::var("ZARA_DEV_OPENCLAW_SOURCE") {
        if !source.trim().is_empty() {
            docker_args.push("-v".to_string());
            docker_args.push(format!("{}/dist:/app/dist:ro", source));
            docker_args.push("-v".to_string());
            docker_args.push(format!("{}/extensions:/app/extensions:ro", source));
        }
    }

    // Create and start container with hardened settings
    let run = Command::new("docker")
        .args(&docker_args)
        .output()
        .map_err(|e| format!("Failed to run container: {}", e))?;

    if !run.status.success() {
        let stderr = String::from_utf8_lossy(&run.stderr);
        return Err(format!("Failed to start container: {}", stderr));
    }

    // Apply persisted settings to the fresh container
    apply_agent_settings(&app, &state)?;

    Ok(())
}

#[tauri::command]
pub async fn stop_gateway() -> Result<(), String> {
    let stop = Command::new("docker")
        .args(["stop", "zara-openclaw"])
        .output()
        .map_err(|e| format!("Failed to stop container: {}", e))?;

    if !stop.status.success() {
        // Container might not be running, that's OK
        let stderr = String::from_utf8_lossy(&stop.stderr);
        if !stderr.contains("No such container") {
            return Err(format!("Failed to stop container: {}", stderr));
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn restart_gateway(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    // Stop and remove existing container (to pick up new env vars)
    let _ = Command::new("docker")
        .args(["stop", "zara-openclaw"])
        .output();
    let _ = Command::new("docker")
        .args(["rm", "-f", "zara-openclaw"])
        .output();

    // Start with current API keys
    start_gateway(app, state).await
}

#[tauri::command]
pub async fn get_gateway_status() -> Result<bool, String> {
    // Check if container is running
    let check = Command::new("docker")
        .args(["ps", "-q", "-f", "name=zara-openclaw", "-f", "status=running"])
        .output()
        .map_err(|e| format!("Failed to check container: {}", e))?;

    if check.stdout.is_empty() {
        return Ok(false);
    }

    // Container is running, check health endpoint
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
        .map_err(|e| e.to_string())?;

    // Use container name when in dev container (shared network), localhost otherwise
    let health_url = if std::path::Path::new("/.dockerenv").exists() {
        "http://zara-openclaw:18789/health"
    } else {
        "http://127.0.0.1:19789/health"
    };
    match client.get(health_url).send().await {
        Ok(_) => Ok(true), // Any HTTP response means gateway is up
        Err(_) => Ok(false), // No response - not running
    }
}

#[tauri::command]
pub async fn get_gateway_ws_url() -> Result<String, String> {
    let url = if std::path::Path::new("/.dockerenv").exists() {
        "ws://zara-openclaw:18789"
    } else {
        "ws://127.0.0.1:19789"
    };
    Ok(url.to_string())
}

#[tauri::command]
pub async fn get_agent_profile_state(app: AppHandle) -> Result<AgentProfileState, String> {
    let stored = load_agent_settings(&app);
    let soul = read_container_file("/home/node/.openclaw/workspace/SOUL.md").unwrap_or_default();
    let heartbeat_raw =
        read_container_file("/home/node/.openclaw/workspace/HEARTBEAT.md").unwrap_or_default();
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

    let cfg = read_openclaw_config();
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
            if stored.memory_long_term { "memory-lancedb" } else { "memory-core" }
        } else {
            "none"
        });

    let (memory_enabled, memory_long_term) = match memory_slot {
        "none" => (false, false),
        "memory-lancedb" => (true, true),
        _ => (true, false),
    };

    let tools = read_container_file("/home/node/.openclaw/workspace/TOOLS.md").unwrap_or_default();
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
        soul: if soul.trim().is_empty() { stored.soul } else { soul },
        heartbeat_every,
        heartbeat_tasks: final_tasks,
        memory_enabled,
        memory_long_term: if memory_slot == "none" { false } else { memory_long_term },
        capabilities,
    })
}

#[tauri::command]
pub async fn set_personality(app: AppHandle, soul: String) -> Result<(), String> {
    write_container_file("/home/node/.openclaw/workspace/SOUL.md", &soul)?;
    let mut settings = load_agent_settings(&app);
    settings.soul = soul;
    save_agent_settings(&app, settings)?;
    Ok(())
}

#[tauri::command]
pub async fn set_heartbeat(app: AppHandle, every: String, tasks: Vec<String>) -> Result<(), String> {
    let mut cfg = read_openclaw_config();
    let heartbeat = serde_json::json!({ "every": every });
    cfg["agents"]["defaults"]["heartbeat"] = heartbeat;
    write_openclaw_config(&cfg)?;

    let mut body = String::from("# HEARTBEAT.md\n\n");
    if tasks.is_empty() {
        body.push_str("# Keep this file empty (or with only comments) to skip heartbeat API calls.\n");
    } else {
        for task in &tasks {
            if !task.trim().is_empty() {
                body.push_str(&format!("- {}\n", task.trim()));
            }
        }
    }
    write_container_file("/home/node/.openclaw/workspace/HEARTBEAT.md", &body)?;
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
    let mut cfg = read_openclaw_config();
    let slot = if !memory_enabled {
        "none"
    } else if long_term {
        "memory-lancedb"
    } else {
        "memory-core"
    };

    cfg["plugins"]["slots"]["memory"] = serde_json::json!(slot);

    if slot == "memory-lancedb" {
        let keys = state.api_keys.lock().map_err(|e| e.to_string())?;
        let openai_key = keys
            .get("openai")
            .ok_or_else(|| "OpenAI key required for long-term memory".to_string())?;
        cfg["plugins"]["entries"]["memory-lancedb"]["enabled"] = serde_json::json!(true);
        cfg["plugins"]["entries"]["memory-lancedb"]["config"]["embedding"] = serde_json::json!({
            "apiKey": openai_key,
            "model": "text-embedding-3-small"
        });
    }

    write_openclaw_config(&cfg)?;
    let mut settings = load_agent_settings(&app);
    settings.memory_enabled = memory_enabled;
    settings.memory_long_term = long_term;
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
    write_container_file("/home/node/.openclaw/workspace/TOOLS.md", &body)?;
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
    let mut body = String::from("# IDENTITY.md - Who Am I?\n\n");
    body.push_str(&format!("- **Name:** {}\n", name.trim()));
    body.push_str("- **Creature:**\n- **Vibe:**\n- **Emoji:**\n");
    if let Some(ref url) = avatar_data_url {
        body.push_str(&format!("- **Avatar:** {}\n", url));
    } else {
        body.push_str("- **Avatar:**\n");
    }
    write_container_file("/home/node/.openclaw/workspace/IDENTITY.md", &body)?;
    let mut settings = load_agent_settings(&app);
    settings.identity_name = name.trim().to_string();
    settings.identity_avatar = avatar_data_url;
    save_agent_settings(&app, settings)?;
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
    // Update progress: Starting
    {
        let mut progress = state.setup_progress.lock().map_err(|e| e.to_string())?;
        *progress = SetupProgress {
            stage: "init".to_string(),
            message: "Checking Docker...".to_string(),
            percent: 10,
            complete: false,
            error: None,
        };
    }

    let runtime = get_runtime(&app);
    let status = runtime.check_status();

    if !status.docker_ready {
        let mut progress = state.setup_progress.lock().map_err(|e| e.to_string())?;
        *progress = SetupProgress {
            stage: "error".to_string(),
            message: "Docker is not available".to_string(),
            percent: 0,
            complete: false,
            error: Some("Please install Docker and ensure the daemon is running.".to_string()),
        };
        return Err("Docker not available".to_string());
    }

    // Check for OpenClaw runtime image
    {
        let mut progress = state.setup_progress.lock().map_err(|e| e.to_string())?;
        *progress = SetupProgress {
            stage: "image".to_string(),
            message: "Checking OpenClaw runtime...".to_string(),
            percent: 50,
            complete: false,
            error: None,
        };
    }

    let image_check = Command::new("docker")
        .args(["image", "inspect", "openclaw-runtime:latest"])
        .output()
        .map_err(|e| e.to_string())?;

    if !image_check.status.success() {
        let mut progress = state.setup_progress.lock().map_err(|e| e.to_string())?;
        *progress = SetupProgress {
            stage: "error".to_string(),
            message: "OpenClaw runtime not found".to_string(),
            percent: 0,
            complete: false,
            error: Some("Run ./scripts/build-openclaw-runtime.sh to build the runtime image.".to_string()),
        };
        return Err("OpenClaw runtime image not found".to_string());
    }

    // Complete
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
