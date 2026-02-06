use crate::runtime::{Platform, Runtime, RuntimeStatus};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

/// Get the Docker socket path for the current platform.
/// On macOS, uses Colima socket. On Linux/Windows, uses default.
fn get_docker_host() -> Option<String> {
    match Platform::detect() {
        Platform::MacOS => {
            // Use Colima socket on macOS
            let home = dirs::home_dir()?;
            Some(format!("unix://{}/.colima/default/docker.sock", home.display()))
        }
        Platform::Linux => {
            // Check if we're in a container (dev environment)
            if std::path::Path::new("/.dockerenv").exists() {
                // In dev container, use host's Docker socket (mounted)
                None // Use default DOCKER_HOST or /var/run/docker.sock
            } else {
                None // Native Linux, use default
            }
        }
        Platform::Windows => None, // Use default named pipe
    }
}

/// Create a Docker command with the correct DOCKER_HOST set
fn docker_command() -> Command {
    let mut cmd = Command::new("docker");
    if let Some(host) = get_docker_host() {
        cmd.env("DOCKER_HOST", host);
    }
    cmd
}

pub struct AppState {
    pub setup_progress: Mutex<SetupProgress>,
    pub api_keys: Mutex<HashMap<String, String>>,
    pub active_provider: Mutex<Option<String>>,
    pub whatsapp_login: Mutex<WhatsAppLoginCache>,
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
            whatsapp_login: Mutex::new(WhatsAppLoginCache::default()),
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
    pub imessage_enabled: bool,
    pub imessage_cli_path: String,
    pub imessage_db_path: String,
    pub imessage_remote_host: String,
    pub imessage_include_attachments: bool,
    pub discord_enabled: bool,
    pub discord_token: String,
    pub telegram_enabled: bool,
    pub telegram_token: String,
    pub whatsapp_enabled: bool,
    pub whatsapp_allow_from: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CapabilityState {
    pub id: String,
    pub label: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct AttachmentInfo {
    pub id: String,
    pub file_name: String,
    pub mime_type: String,
    pub temp_path: String,
    pub size_bytes: u64,
    pub is_image: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct WhatsAppLoginState {
    pub status: String,
    pub message: String,
    pub qr_data_url: Option<String>,
    pub connected: Option<bool>,
    pub last_error: Option<String>,
    pub error_status: Option<i64>,
    pub updated_at_ms: u128,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(default)]
struct WhatsAppLoginCache {
    status: String,
    message: String,
    qr_data_url: Option<String>,
    connected: Option<bool>,
    last_error: Option<String>,
    error_status: Option<i64>,
    updated_at_ms: u128,
}

impl Default for WhatsAppLoginCache {
    fn default() -> Self {
        Self {
            status: "idle".to_string(),
            message: String::new(),
            qr_data_url: None,
            connected: None,
            last_error: None,
            error_status: None,
            updated_at_ms: 0,
        }
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct PluginInfo {
    pub id: String,
    pub kind: Option<String>,
    pub channels: Vec<String>,
    pub installed: bool,
    pub enabled: bool,
    pub managed: bool,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct StoredAuth {
    version: u8,
    keys: HashMap<String, String>,
    active_provider: Option<String>,
    agent_settings: Option<StoredAgentSettings>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(default)]
struct StoredAgentSettings {
    soul: String,
    heartbeat_every: String,
    heartbeat_tasks: Vec<String>,
    memory_enabled: bool,
    memory_long_term: bool,
    capabilities: Vec<CapabilityState>,
    identity_name: String,
    identity_avatar: Option<String>,
    imessage_enabled: bool,
    imessage_cli_path: String,
    imessage_db_path: String,
    imessage_remote_host: String,
    imessage_include_attachments: bool,
    discord_enabled: bool,
    discord_token: String,
    telegram_enabled: bool,
    telegram_token: String,
    whatsapp_enabled: bool,
    whatsapp_allow_from: String,
}

impl Default for StoredAgentSettings {
    fn default() -> Self {
        Self {
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
            identity_name: "Nova".to_string(),
            identity_avatar: None,
            imessage_enabled: false,
            imessage_cli_path: "/usr/local/bin/imsg".to_string(),
            imessage_db_path: String::new(),
            imessage_remote_host: String::new(),
            imessage_include_attachments: true,
            discord_enabled: false,
            discord_token: String::new(),
            telegram_enabled: false,
            telegram_token: String::new(),
            whatsapp_enabled: false,
            whatsapp_allow_from: String::new(),
        }
    }
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

const OPENCLAW_CONTAINER: &str = "nova-openclaw";

fn docker_exec_output(args: &[&str]) -> Result<String, String> {
    let output = docker_command()
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
    let mut child = docker_command()
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

fn read_container_env(key: &str) -> Option<String> {
    let cmd = format!("printf \"%s\" \"${}\"", key);
    let value = docker_exec_output(&["exec", OPENCLAW_CONTAINER, "sh", "-c", &cmd]).ok()?;
    if value.trim().is_empty() {
        None
    } else {
        Some(value)
    }
}

fn write_openclaw_config(value: &serde_json::Value) -> Result<(), String> {
    let payload = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    write_container_file("/home/node/.openclaw/openclaw.json", &payload)
}

async fn call_whatsapp_qr_endpoint(
    action: &str,
    force: bool,
) -> Result<WhatsAppLoginState, String> {
    let base = if std::path::Path::new("/.dockerenv").exists() {
        "http://nova-openclaw:18789"
    } else {
        "http://127.0.0.1:19789"
    };
    let url = format!(
        "{}/channels/whatsapp/qr?action={}&force={}",
        base,
        action,
        if force { 1 } else { 0 }
    );
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;
    let res = client
        .get(&url)
        .bearer_auth("nova-local-gateway")
        .send()
        .await
        .map_err(|e| format!("WhatsApp QR request failed: {}", e))?;
    if !res.status().is_success() {
        return Err(format!("WhatsApp QR request failed: {}", res.status()));
    }
    let value = res
        .json::<serde_json::Value>()
        .await
        .map_err(|e| format!("Failed to parse WhatsApp QR response: {}", e))?;
    Ok(WhatsAppLoginState {
        status: value
            .get("status")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string(),
        message: value
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("Waiting for QR.")
            .to_string(),
        qr_data_url: value
            .get("qrDataUrl")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        connected: value.get("connected").and_then(|v| v.as_bool()),
        last_error: value
            .get("error")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        error_status: value.get("errorStatus").and_then(|v| v.as_i64()),
        updated_at_ms: current_millis(),
    })
}

async fn run_whatsapp_login_script(script: &str) -> Result<serde_json::Value, String> {
    let start = std::time::Instant::now();
    eprintln!("[WA-DEBUG] [{:.1}s] Starting docker exec", 0.0);

    // Check if docker is accessible first
    eprintln!("[WA-DEBUG] [{:.1}s] Checking docker accessibility...", start.elapsed().as_secs_f64());
    let docker_check = docker_command()
        .args(["--version"])
        .output();
    match &docker_check {
        Ok(out) => eprintln!("[WA-DEBUG] [{:.1}s] Docker found: {}", start.elapsed().as_secs_f64(), String::from_utf8_lossy(&out.stdout).trim()),
        Err(e) => eprintln!("[WA-DEBUG] [{:.1}s] Docker NOT found: {}", start.elapsed().as_secs_f64(), e),
    }

    eprintln!("[WA-DEBUG] [{:.1}s] About to spawn_blocking for docker exec...", start.elapsed().as_secs_f64());
    let script = script.to_string();
    let docker_host = get_docker_host();
    let output = tokio::task::spawn_blocking(move || {
        eprintln!("[WA-DEBUG] [inside spawn_blocking] Running docker exec now...");
        let mut cmd = Command::new("docker");
        if let Some(host) = docker_host {
            cmd.env("DOCKER_HOST", host);
        }
        let result = cmd
            .args([
                "exec",
                OPENCLAW_CONTAINER,
                "node",
                "--input-type=module",
                "-e",
                &script,
            ])
            .output();
        eprintln!("[WA-DEBUG] [inside spawn_blocking] docker exec returned");
        result
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
    .map_err(|e| format!("Failed to run whatsapp login: {}", e))?;

    eprintln!("[WA-DEBUG] [{:.1}s] Docker exec completed", start.elapsed().as_secs_f64());

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        eprintln!("[WA-DEBUG] Docker exec failed: {}", stderr);
        return Err(stderr.to_string());
    }
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    eprintln!("[WA-DEBUG] Got stdout length: {} bytes", stdout.len());

    for line in stdout.lines().rev() {
        let trimmed = line.trim();
        if trimmed.starts_with('{') && trimmed.ends_with('}') {
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(trimmed) {
                eprintln!("[WA-DEBUG] Successfully parsed JSON, total time: {:?}", start.elapsed());
                return Ok(val);
            }
        }
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    Err(format!(
        "Failed to parse login response. stdout: {} stderr: {}",
        stdout, stderr
    ))
}

fn list_extension_manifests() -> Result<Vec<serde_json::Value>, String> {
    let list = docker_exec_output(&[
        "exec",
        OPENCLAW_CONTAINER,
        "sh",
        "-c",
        "ls -1 /app/extensions 2>/dev/null || true",
    ])?;
    let mut manifests = Vec::new();
    for line in list.lines() {
        let dir = line.trim();
        if dir.is_empty() {
            continue;
        }
        let path = format!("/app/extensions/{}/openclaw.plugin.json", dir);
        if let Some(raw) = read_container_file(&path) {
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&raw) {
                manifests.push(val);
            }
        }
    }
    Ok(manifests)
}

fn config_allows_plugin(cfg: &serde_json::Value, id: &str) -> bool {
    let allow = cfg
        .get("plugins")
        .and_then(|v| v.get("allow"))
        .and_then(|v| v.as_array());
    if let Some(list) = allow {
        return list.iter().any(|v| v.as_str() == Some(id));
    }
    let deny = cfg
        .get("plugins")
        .and_then(|v| v.get("deny"))
        .and_then(|v| v.as_array());
    if let Some(list) = deny {
        return !list.iter().any(|v| v.as_str() == Some(id));
    }
    true
}

fn sanitize_filename(name: &str) -> String {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return "file".to_string();
    }
    let mut out = String::with_capacity(trimmed.len());
    for ch in trimmed.chars() {
        if ch.is_ascii_alphanumeric() || ch == '.' || ch == '-' || ch == '_' {
            out.push(ch);
        } else if ch.is_whitespace() {
            out.push('_');
        }
    }
    if out.is_empty() {
        "file".to_string()
    } else {
        out
    }
}

fn unique_id() -> String {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!("{}", ts)
}

fn current_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
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

    // Ensure model config persists even if apply_agent_settings runs before entrypoint writes.
    if cfg.pointer("/agents/defaults/model").is_none() {
        if let Some(model) = read_container_env("OPENCLAW_MODEL") {
            cfg["agents"]["defaults"]["model"] = serde_json::json!({ "primary": model });
        }
    }
    if cfg.pointer("/agents/defaults/imageModel").is_none() {
        if let Some(image_model) = read_container_env("OPENCLAW_IMAGE_MODEL") {
            cfg["agents"]["defaults"]["imageModel"] = serde_json::json!({ "primary": image_model });
        }
    }
    if cfg.pointer("/models/providers/openrouter").is_none() {
        if let Some(base_url) = read_container_env("NOVA_PROXY_BASE_URL") {
            let model = read_container_env("OPENCLAW_MODEL")
                .map(|m| {
                    let stripped = m.trim_start_matches("openrouter/").to_string();
                    if stripped == "free" || stripped == "auto" { m } else { stripped }
                })
                .unwrap_or_default();
            let image_model = read_container_env("OPENCLAW_IMAGE_MODEL")
                .map(|m| {
                    let stripped = m.trim_start_matches("openrouter/").to_string();
                    if stripped == "free" || stripped == "auto" { m } else { stripped }
                })
                .unwrap_or_default();
            let mut models = Vec::new();
            if !model.is_empty() {
                models.push(serde_json::json!({ "id": model, "name": model }));
            }
            if !image_model.is_empty() && image_model != model {
                models.push(serde_json::json!({ "id": image_model, "name": image_model }));
            }
            cfg["models"]["providers"]["openrouter"] = serde_json::json!({
                "baseUrl": base_url,
                "api": "openai-completions",
                "models": models
            });
        }
    }
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
    } else if let Some(entries) = cfg["plugins"]["entries"].as_object_mut() {
        entries.remove("memory-lancedb");
    }

    cfg["channels"]["discord"]["enabled"] = serde_json::json!(settings.discord_enabled);
    cfg["channels"]["discord"]["token"] = serde_json::json!(settings.discord_token.clone());
    cfg["channels"]["discord"]["groupPolicy"] = serde_json::json!("allowlist");
    cfg["channels"]["discord"]["configWrites"] = serde_json::json!(false);
    cfg["plugins"]["entries"]["discord"]["enabled"] = serde_json::json!(settings.discord_enabled);

    cfg["channels"]["telegram"]["enabled"] = serde_json::json!(settings.telegram_enabled);
    cfg["channels"]["telegram"]["botToken"] = serde_json::json!(settings.telegram_token.clone());
    cfg["channels"]["telegram"]["dmPolicy"] = serde_json::json!("pairing");
    cfg["channels"]["telegram"]["groupPolicy"] = serde_json::json!("allowlist");
    cfg["channels"]["telegram"]["configWrites"] = serde_json::json!(false);
    cfg["channels"]["telegram"]["groups"]["*"]["requireMention"] = serde_json::json!(true);
    cfg["plugins"]["entries"]["telegram"]["enabled"] = serde_json::json!(settings.telegram_enabled);

    cfg["channels"]["whatsapp"]["configWrites"] = serde_json::json!(false);
    cfg["channels"]["whatsapp"]["groupPolicy"] = serde_json::json!("allowlist");
    if settings.whatsapp_allow_from.trim().is_empty() {
        cfg["channels"]["whatsapp"]["dmPolicy"] = serde_json::json!("pairing");
        // Remove allowFrom if present (cannot be null, must be array or absent)
        if let Some(obj) = cfg["channels"]["whatsapp"].as_object_mut() {
            obj.remove("allowFrom");
        }
    } else {
        cfg["channels"]["whatsapp"]["dmPolicy"] = serde_json::json!("allowlist");
        cfg["channels"]["whatsapp"]["allowFrom"] =
            serde_json::json!([settings.whatsapp_allow_from.trim()]);
    }
    cfg["plugins"]["entries"]["whatsapp"]["enabled"] = serde_json::json!(settings.whatsapp_enabled);

    cfg["channels"]["imessage"]["enabled"] = serde_json::json!(settings.imessage_enabled);
    cfg["channels"]["imessage"]["cliPath"] = serde_json::json!(settings.imessage_cli_path.clone());
    cfg["channels"]["imessage"]["dbPath"] = serde_json::json!(settings.imessage_db_path.clone());
    cfg["channels"]["imessage"]["includeAttachments"] =
        serde_json::json!(settings.imessage_include_attachments);
    cfg["channels"]["imessage"]["dmPolicy"] = serde_json::json!("pairing");
    cfg["channels"]["imessage"]["groupPolicy"] = serde_json::json!("allowlist");
    cfg["channels"]["imessage"]["configWrites"] = serde_json::json!(false);
    if settings.imessage_remote_host.trim().is_empty() {
        if let Some(obj) = cfg["channels"]["imessage"].as_object_mut() {
            obj.remove("remoteHost");
        }
    } else {
        cfg["channels"]["imessage"]["remoteHost"] =
            serde_json::json!(settings.imessage_remote_host.clone());
    }
    cfg["plugins"]["entries"]["imessage"]["enabled"] = serde_json::json!(settings.imessage_enabled);

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
    StoredAgentSettings::default()
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
        whatsapp_login: Mutex::new(WhatsAppLoginCache::default()),
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

/// Ensure runtime is ready for Docker operations.
/// On macOS: starts Colima if not running.
/// On Linux/Windows: checks Docker is available.
/// Returns the current status after any auto-start attempts.
#[tauri::command]
pub async fn ensure_runtime(app: AppHandle) -> Result<RuntimeStatus, String> {
    let runtime = get_runtime(&app);
    let mut status = runtime.check_status();

    // On macOS, auto-start Colima if it's installed but not running (skip if Docker Desktop is ready)
    if matches!(Platform::detect(), Platform::MacOS) {
        if status.colima_installed && !status.vm_running && !status.docker_ready {
            // Try to start Colima
            if let Err(e) = runtime.start_colima() {
                return Err(format!("Failed to start Colima: {}", e));
            }
            // Re-check status after starting
            status = runtime.check_status();
        }
    }

    if !status.docker_ready {
        if !status.docker_installed {
            return Err("Docker is not installed. Please install Docker to continue.".to_string());
        }
        return Err("Docker is not running. Please ensure Docker is started.".to_string());
    }

    Ok(status)
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
    let settings = load_agent_settings(&app);
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

    // Ensure runtime is running on macOS (Colima or Docker Desktop)
    let runtime = get_runtime(&app);
    let status = runtime.check_status();
    if !status.docker_ready {
        if matches!(Platform::detect(), Platform::MacOS) && status.colima_installed && !status.vm_running {
            // Auto-start Colima on macOS if installed
            runtime.start_colima().map_err(|e| format!("Failed to start Colima: {}", e))?;
        } else if !status.docker_installed {
            return Err("Docker is not installed. Please install Docker Desktop to continue.".to_string());
        } else {
            return Err("Docker is not running. Please start Docker and try again.".to_string());
        }
    }

    // Check if nova-openclaw container exists
    let check = docker_command()
        .args(["ps", "-q", "-f", "name=nova-openclaw"])
        .output()
        .map_err(|e| format!("Failed to check container: {}", e))?;

    if !check.stdout.is_empty() {
        // Container already running
        return Ok(());
    }

    // Check if container exists but stopped
    let check_all = docker_command()
        .args(["ps", "-aq", "-f", "name=nova-openclaw"])
        .output()
        .map_err(|e| format!("Failed to check container: {}", e))?;

    if !check_all.stdout.is_empty() {
        // Start existing container
        let start = docker_command()
            .args(["start", "nova-openclaw"])
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
    let _ = docker_command()
        .args(["network", "create", "nova-net"])
        .output(); // Ignore error if already exists

    // Check if image exists
    let image_check = docker_command()
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
    let use_host_network = std::env::var("NOVA_HOST_NETWORK")
        .map(|v| v == "1")
        .unwrap_or(false);

    let mut docker_args = vec![
        "run".to_string(), "-d".to_string(),
        "--name".to_string(), "nova-openclaw".to_string(),
        "--user".to_string(), "1000:1000".to_string(),
        "--add-host".to_string(), "host.docker.internal:host-gateway".to_string(),
        "--cap-drop=ALL".to_string(),
        "--security-opt".to_string(), "no-new-privileges".to_string(),
        "--read-only".to_string(),
        "--tmpfs".to_string(), "/tmp:rw,noexec,nosuid,nodev,size=100m".to_string(),
        "--tmpfs".to_string(), "/run:rw,noexec,nosuid,nodev,size=10m".to_string(),
        "--tmpfs".to_string(), "/home/node/.openclaw:rw,noexec,nosuid,nodev,size=50m,uid=1000,gid=1000".to_string(),
        "-e".to_string(), "OPENCLAW_GATEWAY_TOKEN=nova-local-gateway".to_string(),
        "-e".to_string(), format!("OPENCLAW_MODEL={}", model),
        "-e".to_string(), format!("OPENCLAW_MEMORY_SLOT={}", memory_slot),
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

    if use_host_network {
        docker_args.push("--network".to_string());
        docker_args.push("host".to_string());
        docker_args.push("-e".to_string());
        docker_args.push("OPENCLAW_GATEWAY_PORT=19789".to_string());
        docker_args.extend([
            "-v".to_string(), "nova-openclaw-data:/data".to_string(),
            "--restart".to_string(), "unless-stopped".to_string(),
            "openclaw-runtime:latest".to_string(),
        ]);
    } else {
        // Add remaining args
        docker_args.extend([
            "-v".to_string(), "nova-openclaw-data:/data".to_string(),
            "--network".to_string(), "nova-net".to_string(),
            "-p".to_string(), "127.0.0.1:19789:18789".to_string(),
            "--restart".to_string(), "unless-stopped".to_string(),
            "openclaw-runtime:latest".to_string(),
        ]);
    }

    // Dev-only: bind-mount local OpenClaw dist/extensions to avoid image rebuilds
    if let Ok(source) = std::env::var("NOVA_DEV_OPENCLAW_SOURCE") {
        if !source.trim().is_empty() {
            docker_args.push("-v".to_string());
            docker_args.push(format!("{}/dist:/app/dist:ro", source));
            docker_args.push("-v".to_string());
            docker_args.push(format!("{}/extensions:/app/extensions:ro", source));
        }
    }

    // Create and start container with hardened settings
    let run = docker_command()
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
    let stop = docker_command()
        .args(["stop", "nova-openclaw"])
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

/// Start gateway using the Nova proxy (for users without their own API keys)
#[tauri::command]
pub async fn start_gateway_with_proxy(
    app: AppHandle,
    state: State<'_, AppState>,
    gateway_token: String,
    proxy_url: String,
    model: String,
    image_model: Option<String>,
) -> Result<(), String> {
    // Ensure runtime (Colima) is running on macOS
    let runtime = get_runtime(&app);
    let status = runtime.check_status();
    if !status.docker_ready {
        if matches!(Platform::detect(), Platform::MacOS) && status.colima_installed && !status.vm_running {
            runtime.start_colima().map_err(|e| format!("Failed to start Colima: {}", e))?;
        } else if !status.docker_installed {
            return Err("Docker is not installed. Please install Docker to continue.".to_string());
        } else {
            return Err("Docker is not running. Please start Docker and try again.".to_string());
        }
    }

    // Check if container is already running
    let check = docker_command()
        .args(["ps", "-q", "-f", "name=nova-openclaw"])
        .output()
        .map_err(|e| format!("Failed to check container: {}", e))?;

    if !check.stdout.is_empty() {
        // Remove running container to ensure proxy config/model updates take effect
        let _ = docker_command()
            .args(["rm", "-f", "nova-openclaw"])
            .output();
    }

    // Check if container exists but stopped - remove it to recreate with new config
    let check_all = docker_command()
        .args(["ps", "-aq", "-f", "name=nova-openclaw"])
        .output()
        .map_err(|e| format!("Failed to check container: {}", e))?;

    if !check_all.stdout.is_empty() {
        // Remove existing container to recreate with new proxy config
        let _ = docker_command()
            .args(["rm", "-f", "nova-openclaw"])
            .output();
    }

    // Create network if it doesn't exist
    let _ = docker_command()
        .args(["network", "create", "nova-net"])
        .output();

    // Check if image exists
    let image_check = docker_command()
        .args(["image", "inspect", "openclaw-runtime:latest"])
        .output()
        .map_err(|e| format!("Failed to check image: {}", e))?;

    if !image_check.status.success() {
        return Err("OpenClaw runtime image not found. Run: ./scripts/build-openclaw-runtime.sh".to_string());
    }

    // Build docker run command with proxy configuration
    let use_host_network = std::env::var("NOVA_HOST_NETWORK")
        .map(|v| v == "1")
        .unwrap_or(false);

    let mut docker_args = vec![
        "run".to_string(), "-d".to_string(),
        "--name".to_string(), "nova-openclaw".to_string(),
        "--user".to_string(), "1000:1000".to_string(),
        "--add-host".to_string(), "host.docker.internal:host-gateway".to_string(),
        "--cap-drop=ALL".to_string(),
        "--security-opt".to_string(), "no-new-privileges".to_string(),
        "--read-only".to_string(),
        "--tmpfs".to_string(), "/tmp:rw,noexec,nosuid,nodev,size=100m".to_string(),
        "--tmpfs".to_string(), "/run:rw,noexec,nosuid,nodev,size=10m".to_string(),
        "--tmpfs".to_string(), "/home/node/.openclaw:rw,noexec,nosuid,nodev,size=50m,uid=1000,gid=1000".to_string(),
        "-e".to_string(), "OPENCLAW_GATEWAY_TOKEN=nova-local-gateway".to_string(),
        "-e".to_string(), format!("OPENCLAW_MODEL={}", model),
        "-e".to_string(), "OPENCLAW_MEMORY_SLOT=memory-core".to_string(),
        "-e".to_string(), "NOVA_PROXY_MODE=1".to_string(),
        // Nova proxy configuration - OpenClaw will use this as its AI backend (OpenRouter provider)
        "-e".to_string(), format!("OPENROUTER_API_KEY={}", gateway_token),
        "-e".to_string(), format!("NOVA_PROXY_BASE_URL={}/v1", proxy_url),
    ];

    if let Some(image_model) = image_model {
        if !image_model.trim().is_empty() {
            docker_args.push("-e".to_string());
            docker_args.push(format!("OPENCLAW_IMAGE_MODEL={}", image_model));
        }
    }

    if use_host_network {
        docker_args.push("--network".to_string());
        docker_args.push("host".to_string());
        docker_args.push("-e".to_string());
        docker_args.push("OPENCLAW_GATEWAY_PORT=19789".to_string());
        docker_args.extend([
            "-v".to_string(), "nova-openclaw-data:/data".to_string(),
            "--restart".to_string(), "unless-stopped".to_string(),
            "openclaw-runtime:latest".to_string(),
        ]);
    } else {
        // Add remaining args
        docker_args.extend([
            "-v".to_string(), "nova-openclaw-data:/data".to_string(),
            "--network".to_string(), "nova-net".to_string(),
            "-p".to_string(), "127.0.0.1:19789:18789".to_string(),
            "--restart".to_string(), "unless-stopped".to_string(),
            "openclaw-runtime:latest".to_string(),
        ]);
    }

    // Dev-only: bind-mount local OpenClaw dist/extensions
    if let Ok(source) = std::env::var("NOVA_DEV_OPENCLAW_SOURCE") {
        if !source.trim().is_empty() {
            docker_args.insert(docker_args.len() - 1, "-v".to_string());
            docker_args.insert(docker_args.len() - 1, format!("{}/dist:/app/dist:ro", source));
            docker_args.insert(docker_args.len() - 1, "-v".to_string());
            docker_args.insert(docker_args.len() - 1, format!("{}/extensions:/app/extensions:ro", source));
        }
    }

    // Create and start container
    let run = docker_command()
        .args(&docker_args)
        .output()
        .map_err(|e| format!("Failed to run container: {}", e))?;

    if !run.status.success() {
        let stderr = String::from_utf8_lossy(&run.stderr);
        return Err(format!("Failed to start container: {}", stderr));
    }

    // Apply persisted settings
    apply_agent_settings(&app, &state)?;

    Ok(())
}

#[tauri::command]
pub async fn restart_gateway(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    // Stop and remove existing container (to pick up new env vars)
    let _ = docker_command()
        .args(["stop", "nova-openclaw"])
        .output();
    let _ = docker_command()
        .args(["rm", "-f", "nova-openclaw"])
        .output();

    // Start with current API keys
    start_gateway(app, state).await
}

#[tauri::command]
pub async fn get_gateway_status() -> Result<bool, String> {
    // Check if container is running
    let check = docker_command()
        .args(["ps", "-q", "-f", "name=nova-openclaw", "-f", "status=running"])
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
        "http://nova-openclaw:18789/health"
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
        "ws://nova-openclaw:18789"
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

    let imessage_cfg = cfg
        .get("channels")
        .and_then(|v| v.get("imessage"));
    let imessage_enabled = imessage_cfg
        .and_then(|v| v.get("enabled"))
        .and_then(|v| v.as_bool())
        .unwrap_or(stored.imessage_enabled);
    let imessage_cli_path = imessage_cfg
        .and_then(|v| v.get("cliPath"))
        .and_then(|v| v.as_str())
        .unwrap_or(&stored.imessage_cli_path)
        .to_string();
    let imessage_db_path = imessage_cfg
        .and_then(|v| v.get("dbPath"))
        .and_then(|v| v.as_str())
        .unwrap_or(&stored.imessage_db_path)
        .to_string();
    let imessage_remote_host = imessage_cfg
        .and_then(|v| v.get("remoteHost"))
        .and_then(|v| v.as_str())
        .unwrap_or(&stored.imessage_remote_host)
        .to_string();
    let imessage_include_attachments = imessage_cfg
        .and_then(|v| v.get("includeAttachments"))
        .and_then(|v| v.as_bool())
        .unwrap_or(stored.imessage_include_attachments);

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
    let telegram_enabled = telegram_cfg
        .and_then(|v| v.get("enabled"))
        .and_then(|v| v.as_bool())
        .unwrap_or(stored.telegram_enabled);
    let telegram_token = telegram_cfg
        .and_then(|v| v.get("botToken"))
        .and_then(|v| v.as_str())
        .unwrap_or(&stored.telegram_token)
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
        imessage_enabled,
        imessage_cli_path,
        imessage_db_path,
        imessage_remote_host,
        imessage_include_attachments,
        discord_enabled,
        discord_token,
        telegram_enabled,
        telegram_token,
        whatsapp_enabled,
        whatsapp_allow_from,
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

/// Sync onboarding data from JS store to Rust store.
/// Called after onboarding completes so settings are ready when Docker starts.
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
    } else if let Some(entries) = cfg["plugins"]["entries"].as_object_mut() {
        entries.remove("memory-lancedb");
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
pub async fn set_imessage_config(
    app: AppHandle,
    enabled: bool,
    cli_path: String,
    db_path: String,
    remote_host: String,
    include_attachments: bool,
) -> Result<(), String> {
    let mut cfg = read_openclaw_config();
    let cli = cli_path.trim();
    let db = db_path.trim();
    let remote = remote_host.trim();

    cfg["channels"]["imessage"]["enabled"] = serde_json::json!(enabled);
    cfg["channels"]["imessage"]["cliPath"] = serde_json::json!(cli);
    cfg["channels"]["imessage"]["dbPath"] = serde_json::json!(db);
    cfg["channels"]["imessage"]["includeAttachments"] = serde_json::json!(include_attachments);
    cfg["channels"]["imessage"]["dmPolicy"] = serde_json::json!("pairing");
    cfg["channels"]["imessage"]["groupPolicy"] = serde_json::json!("allowlist");
    cfg["channels"]["imessage"]["configWrites"] = serde_json::json!(false);
    if remote.is_empty() {
        if let Some(obj) = cfg["channels"]["imessage"].as_object_mut() {
            obj.remove("remoteHost");
        }
    } else {
        cfg["channels"]["imessage"]["remoteHost"] = serde_json::json!(remote);
    }
    cfg["plugins"]["entries"]["imessage"]["enabled"] = serde_json::json!(enabled);

    write_openclaw_config(&cfg)?;

    let mut settings = load_agent_settings(&app);
    settings.imessage_enabled = enabled;
    settings.imessage_cli_path = cli.to_string();
    settings.imessage_db_path = db.to_string();
    settings.imessage_remote_host = remote.to_string();
    settings.imessage_include_attachments = include_attachments;
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
    whatsapp_enabled: bool,
    whatsapp_allow_from: String,
) -> Result<(), String> {
    let mut cfg = read_openclaw_config();
    let discord_token = discord_token.trim().to_string();
    let telegram_token = telegram_token.trim().to_string();
    let whatsapp_allow_from = whatsapp_allow_from.trim().to_string();

    cfg["channels"]["discord"]["enabled"] = serde_json::json!(discord_enabled);
    cfg["channels"]["discord"]["token"] = serde_json::json!(discord_token);
    cfg["channels"]["discord"]["groupPolicy"] = serde_json::json!("allowlist");
    cfg["channels"]["discord"]["configWrites"] = serde_json::json!(false);
    cfg["plugins"]["entries"]["discord"]["enabled"] = serde_json::json!(discord_enabled);

    cfg["channels"]["telegram"]["enabled"] = serde_json::json!(telegram_enabled);
    cfg["channels"]["telegram"]["botToken"] = serde_json::json!(telegram_token);
    cfg["channels"]["telegram"]["dmPolicy"] = serde_json::json!("pairing");
    cfg["channels"]["telegram"]["groupPolicy"] = serde_json::json!("allowlist");
    cfg["channels"]["telegram"]["configWrites"] = serde_json::json!(false);
    cfg["channels"]["telegram"]["groups"]["*"]["requireMention"] = serde_json::json!(true);
    cfg["plugins"]["entries"]["telegram"]["enabled"] = serde_json::json!(telegram_enabled);

    cfg["channels"]["whatsapp"]["configWrites"] = serde_json::json!(false);
    cfg["channels"]["whatsapp"]["groupPolicy"] = serde_json::json!("allowlist");
    if whatsapp_allow_from.is_empty() {
        cfg["channels"]["whatsapp"]["dmPolicy"] = serde_json::json!("pairing");
        // Remove allowFrom if present (cannot be null, must be array or absent)
        if let Some(obj) = cfg["channels"]["whatsapp"].as_object_mut() {
            obj.remove("allowFrom");
        }
    } else {
        cfg["channels"]["whatsapp"]["dmPolicy"] = serde_json::json!("allowlist");
        cfg["channels"]["whatsapp"]["allowFrom"] = serde_json::json!([whatsapp_allow_from.clone()]);
    }
    cfg["plugins"]["entries"]["whatsapp"]["enabled"] = serde_json::json!(whatsapp_enabled);

    write_openclaw_config(&cfg)?;

    let mut settings = load_agent_settings(&app);
    settings.discord_enabled = discord_enabled;
    settings.discord_token = discord_token;
    settings.telegram_enabled = telegram_enabled;
    settings.telegram_token = telegram_token;
    settings.whatsapp_enabled = whatsapp_enabled;
    settings.whatsapp_allow_from = whatsapp_allow_from;
    save_agent_settings(&app, settings)?;
    Ok(())
}

#[tauri::command]
pub async fn approve_pairing(channel: String, code: String) -> Result<String, String> {
    let channel = channel.trim();
    let code = code.trim();
    if channel.is_empty() || code.is_empty() {
        return Err("Channel and code are required".to_string());
    }
    let cmd = format!("node /app/dist/index.js pairing approve {} {}", channel, code);
    docker_exec_output(&["exec", OPENCLAW_CONTAINER, "sh", "-c", &cmd])
}

#[tauri::command]
pub async fn start_whatsapp_login(
    force: bool,
    timeout_ms: Option<u64>,
    app: AppHandle,
) -> Result<WhatsAppLoginState, String> {
    let _ = timeout_ms;
    let result = call_whatsapp_qr_endpoint("start", force).await?;
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
    let result = call_whatsapp_qr_endpoint("status", false).await?;
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
pub async fn upload_attachment(
    file_name: String,
    mime_type: String,
    base64: String,
) -> Result<AttachmentInfo, String> {
    let sanitized = sanitize_filename(&file_name);
    let id = unique_id();
    let temp_path = format!("/home/node/.openclaw/uploads/tmp/{}_{}", id, sanitized);
    let size_bytes = (base64.len() as u64 * 3) / 4;
    if size_bytes > 25 * 1024 * 1024 {
        return Err("Attachment too large (max 25MB)".to_string());
    }
    let mk = "mkdir -p /home/node/.openclaw/uploads/tmp";
    docker_exec_output(&["exec", OPENCLAW_CONTAINER, "sh", "-c", mk])?;
    let mut child = docker_command()
        .args([
            "exec",
            "-i",
            OPENCLAW_CONTAINER,
            "sh",
            "-c",
            &format!("base64 -d > {}", temp_path),
        ])
        .stdin(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to upload file: {}", e))?;
    if let Some(stdin) = child.stdin.as_mut() {
        use std::io::Write;
        stdin
            .write_all(base64.as_bytes())
            .map_err(|e| format!("Failed to upload file: {}", e))?;
    }
    let status = child
        .wait()
        .map_err(|e| format!("Failed to finalize upload: {}", e))?;
    if !status.success() {
        return Err("Failed to upload file in container".to_string());
    }
    let is_image = mime_type.starts_with("image/");
    Ok(AttachmentInfo {
        id,
        file_name: sanitized,
        mime_type,
        temp_path,
        size_bytes,
        is_image,
    })
}

#[tauri::command]
pub async fn save_attachment(temp_path: String) -> Result<String, String> {
    let file_name = temp_path
        .split('/')
        .last()
        .unwrap_or("file")
        .to_string();
    let dest_dir = "/data/uploads";
    let mut dest_path = format!("{}/{}", dest_dir, file_name);
    let mk = format!("mkdir -p {}", dest_dir);
    docker_exec_output(&["exec", OPENCLAW_CONTAINER, "sh", "-c", &mk])?;
    // Avoid overwrite: add suffix if exists
    let check = format!("test -e {}", dest_path);
    if docker_exec_output(&["exec", OPENCLAW_CONTAINER, "sh", "-c", &check]).is_ok() {
        let ts = unique_id();
        dest_path = format!("{}/{}_{}", dest_dir, ts, file_name);
    }
    let mv = format!("mv {} {}", temp_path, dest_path);
    docker_exec_output(&["exec", OPENCLAW_CONTAINER, "sh", "-c", &mv])?;
    Ok(dest_path)
}

#[tauri::command]
pub async fn delete_attachment(temp_path: String) -> Result<(), String> {
    let rm = format!("rm -f {}", temp_path);
    docker_exec_output(&["exec", OPENCLAW_CONTAINER, "sh", "-c", &rm])?;
    Ok(())
}

#[tauri::command]
pub async fn get_plugin_store() -> Result<Vec<PluginInfo>, String> {
    let cfg = read_openclaw_config();
    let manifests = list_extension_manifests()?;

    let slot_memory = cfg
        .get("plugins")
        .and_then(|v| v.get("slots"))
        .and_then(|v| v.get("memory"))
        .and_then(|v| v.as_str())
        .unwrap_or("memory-core");

    let mut out = Vec::new();
    for m in manifests {
        let id = m.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
        if id.is_empty() {
            continue;
        }
        if !config_allows_plugin(&cfg, &id) {
            continue;
        }
        let kind = m.get("kind").and_then(|v| v.as_str()).map(|s| s.to_string());
        let channels = m
            .get("channels")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        let entry_enabled = cfg
            .get("plugins")
            .and_then(|v| v.get("entries"))
            .and_then(|v| v.get(&id))
            .and_then(|v| v.get("enabled"))
            .and_then(|v| v.as_bool());

        let enabled = if id == slot_memory {
            true
        } else {
            entry_enabled.unwrap_or(false)
        };

        let managed = kind.as_deref() == Some("memory");

        out.push(PluginInfo {
            id,
            kind,
            channels,
            installed: true,
            enabled,
            managed,
        });
    }

    Ok(out)
}

#[tauri::command]
pub async fn set_plugin_enabled(id: String, enabled: bool) -> Result<(), String> {
    let mut cfg = read_openclaw_config();
    cfg["plugins"]["entries"][&id]["enabled"] = serde_json::json!(enabled);
    write_openclaw_config(&cfg)
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
    let runtime = get_runtime(&app);
    let mut status = runtime.check_status();

    // On macOS, we need to start Colima first
    if matches!(Platform::detect(), Platform::MacOS) {
        // Check if Colima is installed (bundled) OR Docker Desktop is available
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

        // Start Colima if installed and not running (skip if using Docker Desktop)
        if status.colima_installed && !status.vm_running && !status.docker_ready {
            {
                let mut progress = state.setup_progress.lock().map_err(|e| e.to_string())?;
                *progress = SetupProgress {
                    stage: "vm".to_string(),
                    message: "Starting container runtime (first time may download ~100MB)...".to_string(),
                    percent: 10,
                    complete: false,
                    error: None,
                };
            }

            // Start Colima - this can take 30-60 seconds on first run
            if let Err(e) = runtime.start_colima() {
                let mut progress = state.setup_progress.lock().map_err(|e| e.to_string())?;
                *progress = SetupProgress {
                    stage: "error".to_string(),
                    message: "Failed to start container runtime".to_string(),
                    percent: 0,
                    complete: false,
                    error: Some(format!("Failed to start Colima: {}", e)),
                };
                return Err(format!("Failed to start Colima: {}", e));
            }

            // Update progress
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

            // Wait for Docker to become ready (can take 10-30 seconds after VM starts)
            let max_retries = 30;
            for i in 0..max_retries {
                std::thread::sleep(std::time::Duration::from_secs(2));
                status = runtime.check_status();
                if status.docker_ready {
                    break;
                }
                // Update progress with retry count
                {
                    let mut progress = state.setup_progress.lock().map_err(|e| e.to_string())?;
                    *progress = SetupProgress {
                        stage: "docker".to_string(),
                        message: format!("Waiting for Docker to start ({}/{}s)...", (i + 1) * 2, max_retries * 2),
                        percent: 40 + ((i as u8) * 30 / max_retries as u8),
                        complete: false,
                        error: None,
                    };
                }
            }
        }
    }

    // Update progress: Checking Docker
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

    // Final status check
    status = runtime.check_status();

    if !status.docker_ready {
        let error_msg = if matches!(Platform::detect(), Platform::MacOS) {
            "Docker connection failed. The container runtime may still be starting - try again in a moment."
        } else {
            "Please install Docker and ensure the daemon is running."
        };
        let mut progress = state.setup_progress.lock().map_err(|e| e.to_string())?;
        *progress = SetupProgress {
            stage: "error".to_string(),
            message: "Docker is not available".to_string(),
            percent: 0,
            complete: false,
            error: Some(error_msg.to_string()),
        };
        return Err("Docker not available".to_string());
    }

    // Check for OpenClaw runtime image
    {
        let mut progress = state.setup_progress.lock().map_err(|e| e.to_string())?;
        *progress = SetupProgress {
            stage: "image".to_string(),
            message: "Checking OpenClaw runtime...".to_string(),
            percent: 70,
            complete: false,
            error: None,
        };
    }

    let image_check = docker_command()
        .args(["image", "inspect", "openclaw-runtime:latest"])
        .output()
        .map_err(|e| e.to_string())?;

    if !image_check.status.success() {
        // Image not found - this is expected on first run
        // For now, mark as complete and let the dashboard handle image loading
        {
            let mut progress = state.setup_progress.lock().map_err(|e| e.to_string())?;
            *progress = SetupProgress {
                stage: "image".to_string(),
                message: "OpenClaw runtime will be set up on first use...".to_string(),
                percent: 90,
                complete: false,
                error: None,
            };
        }
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
