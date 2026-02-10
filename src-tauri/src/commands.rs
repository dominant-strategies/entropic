use crate::runtime::{Platform, Runtime, RuntimeStatus};
use base64::{engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD}, Engine as _};
use futures_util::{SinkExt, StreamExt};
use rand::RngCore;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_shell::ShellExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::time::timeout;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use url::Url;

/// Get the Docker socket path for the current platform.
/// On macOS, uses Colima socket. On Linux/Windows, uses default.
fn get_docker_host() -> Option<String> {
    match Platform::detect() {
        Platform::MacOS => {
            let home = dirs::home_dir()?;

            // Try Colima first
            let colima_socket = format!("{}/.colima/default/docker.sock", home.display());
            if std::path::Path::new(&colima_socket).exists() {
                return Some(format!("unix://{}", colima_socket));
            }

            // Fall back to Docker Desktop
            let docker_desktop_socket = format!("{}/.docker/run/docker.sock", home.display());
            if std::path::Path::new(&docker_desktop_socket).exists() {
                return Some(format!("unix://{}", docker_desktop_socket));
            }

            // Default fallback (use environment or system default)
            None
        }
        Platform::Linux => {
            if let Ok(host) = std::env::var("DOCKER_HOST") {
                if !host.trim().is_empty() {
                    return Some(host);
                }
            }

            if let Ok(runtime_dir) = std::env::var("XDG_RUNTIME_DIR") {
                let socket = format!("{}/docker.sock", runtime_dir);
                if std::path::Path::new(&socket).exists() {
                    return Some(format!("unix://{}", socket));
                }
            }

            if let Some(home) = dirs::home_dir() {
                let desktop_socket = home.join(".docker/desktop/docker.sock");
                if desktop_socket.exists() {
                    return Some(format!("unix://{}", desktop_socket.display()));
                }
                let run_socket = home.join(".docker/run/docker.sock");
                if run_socket.exists() {
                    return Some(format!("unix://{}", run_socket.display()));
                }
            }

            // Fall back to system default (/var/run/docker.sock)
            None
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

async fn check_gateway_ws_health(ws_url: &str, token: &str) -> Result<bool, String> {
    let (mut ws, _) = connect_async(ws_url)
        .await
        .map_err(|e| format!("WebSocket connect failed: {}", e))?;

    let result = timeout(Duration::from_secs(3), async {
        let mut sent_connect = false;
        let mut sent_health = false;
        loop {
            let msg = ws
                .next()
                .await
                .ok_or_else(|| "gateway closed before response".to_string())?
                .map_err(|e| format!("WebSocket error: {}", e))?;
            if let Message::Text(text) = msg {
                let frame: serde_json::Value =
                    serde_json::from_str(&text).map_err(|e| format!("Bad frame: {}", e))?;
                let frame_type = frame.get("type").and_then(|v| v.as_str()).unwrap_or("");
                if frame_type == "event" {
                    let event = frame.get("event").and_then(|v| v.as_str()).unwrap_or("");
                    if event == "connect.challenge" && !sent_connect {
                        sent_connect = true;
                        let connect = serde_json::json!({
                            "type": "req",
                            "id": "1",
                            "method": "connect",
                            "params": {
                                "minProtocol": 3,
                                "maxProtocol": 3,
                                "client": {
                                    "id": "openclaw-probe",
                                    "displayName": "Nova Health",
                                    "version": "0.1.0",
                                    "platform": "desktop",
                                    "mode": "probe"
                                },
                                "role": "operator",
                                "auth": { "token": token }
                            }
                        });
                        ws.send(Message::Text(connect.to_string()))
                            .await
                            .map_err(|e| format!("WebSocket send failed: {}", e))?;
                    }
                } else if frame_type == "res" {
                    let id = frame.get("id").and_then(|v| v.as_str()).unwrap_or("");
                    let ok = frame.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
                    if id == "1" {
                        if !ok {
                            let msg = frame
                                .get("error")
                                .and_then(|v| v.get("message"))
                                .and_then(|v| v.as_str())
                                .unwrap_or("gateway connect rejected");
                            return Err(msg.to_string());
                        }
                        if !sent_health {
                            sent_health = true;
                            let health = serde_json::json!({
                                "type": "req",
                                "id": "2",
                                "method": "health"
                            });
                            ws.send(Message::Text(health.to_string()))
                                .await
                                .map_err(|e| format!("WebSocket send failed: {}", e))?;
                        }
                    } else if id == "2" {
                        return Ok(ok);
                    }
                }
            }
        }
    })
    .await
    .map_err(|_| "gateway health timeout".to_string())?;

    let _ = ws.close(None).await;
    result
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
pub struct ScanFinding {
    pub analyzer: Option<String>,
    pub category: Option<String>,
    pub severity: String,
    pub title: String,
    pub description: String,
    pub file_path: Option<String>,
    pub line_number: Option<u32>,
    pub snippet: Option<String>,
    pub remediation: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PluginScanResult {
    pub scan_id: Option<String>,
    pub is_safe: bool,
    pub max_severity: String,
    pub findings_count: u32,
    pub findings: Vec<ScanFinding>,
    pub scanner_available: bool,
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
const SCANNER_CONTAINER: &str = "nova-skill-scanner";
const MANAGED_PLUGIN_IDS: &[&str] = &["nova-integrations", "nova-x"];

fn start_scanner_sidecar() {
    // Check if scanner container is already running
    let check = docker_command()
        .args(["ps", "-q", "-f", &format!("name={}", SCANNER_CONTAINER)])
        .output();
    if let Ok(out) = &check {
        if !out.stdout.is_empty() {
            return; // Already running
        }
    }

    // Check if container exists but stopped
    let check_all = docker_command()
        .args(["ps", "-aq", "-f", &format!("name={}", SCANNER_CONTAINER)])
        .output();
    if let Ok(out) = &check_all {
        if !out.stdout.is_empty() {
            let start = docker_command()
                .args(["start", SCANNER_CONTAINER])
                .output();
            if let Ok(s) = &start {
                if s.status.success() {
                    return;
                }
            }
            // Start failed, remove and recreate
            let _ = docker_command().args(["rm", "-f", SCANNER_CONTAINER]).output();
        }
    }

    // Check if scanner image exists
    let image_check = docker_command()
        .args(["image", "inspect", "nova-skill-scanner:latest"])
        .output();
    match &image_check {
        Ok(out) if out.status.success() => {}
        _ => {
            eprintln!("[scanner] Image nova-skill-scanner:latest not found, skipping scanner sidecar");
            return;
        }
    }

    // Create and start scanner container
    let run = docker_command()
        .args([
            "run", "-d",
            "--name", SCANNER_CONTAINER,
            "--user", "1000:1000",
            "--cap-drop=ALL",
            "--security-opt", "no-new-privileges",
            "--read-only",
            "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=200m",
            "--volumes-from", &format!("{}:ro", OPENCLAW_CONTAINER),
            "--network", "nova-net",
            "-p", "127.0.0.1:19790:8000",
            "--restart", "unless-stopped",
            "nova-skill-scanner:latest",
        ])
        .output();

    match &run {
        Ok(out) if !out.status.success() => {
            let stderr = String::from_utf8_lossy(&out.stderr);
            eprintln!("[scanner] Failed to start scanner sidecar: {}", stderr);
        }
        Err(e) => eprintln!("[scanner] Failed to start scanner sidecar: {}", e),
        _ => {}
    }
}

fn stop_scanner_sidecar() {
    let _ = docker_command()
        .args(["stop", SCANNER_CONTAINER])
        .output();
}

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

fn decode_base64_payload(payload: &str) -> Result<Vec<u8>, String> {
    STANDARD
        .decode(payload.as_bytes())
        .map_err(|_| "Invalid base64 payload".to_string())
}

fn read_container_file(path: &str) -> Option<String> {
    let args = ["exec", OPENCLAW_CONTAINER, "cat", "--", path];
    match docker_exec_output(&args) {
        Ok(s) => Some(s),
        Err(_) => None,
    }
}

fn write_container_file(path: &str, content: &str) -> Result<(), String> {
    let dir = Path::new(path)
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| "/".to_string());
    docker_exec_output(&["exec", OPENCLAW_CONTAINER, "mkdir", "-p", "--", &dir])?;
    let mut child = docker_command()
        .args(["exec", "-i", OPENCLAW_CONTAINER, "tee", "--", path])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
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

fn container_path_exists(path: &str) -> bool {
    docker_command()
        .args(["exec", OPENCLAW_CONTAINER, "sh", "-c", &format!("test -d \"{}\"", path)])
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn write_openclaw_config(value: &serde_json::Value) -> Result<(), String> {
    let payload = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    write_container_file("/home/node/.openclaw/openclaw.json", &payload)
}

fn append_nova_skills_mount(docker_args: &mut Vec<String>) {
    let path = std::env::var("NOVA_SKILLS_PATH")
        .ok()
        .and_then(|p| {
            let trimmed = p.trim().to_string();
            if trimmed.is_empty() { None } else { Some(trimmed) }
        });

    if let Some(host_path) = path {
        docker_args.push("-v".to_string());
        docker_args.push(format!("{}:/data/nova-skills:ro", host_path));
        docker_args.push("-e".to_string());
        docker_args.push("NOVA_SKILLS_PATH=/data/nova-skills".to_string());
    }
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

fn sanitize_workspace_path(path: &str) -> Result<String, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Ok(String::new());
    }
    let mut parts = Vec::new();
    for component in Path::new(trimmed).components() {
        match component {
            Component::Normal(os) => {
                let part = os.to_string_lossy();
                if !part.is_empty() {
                    parts.push(part.to_string());
                }
            }
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err("Invalid path".to_string());
            }
        }
    }
    Ok(parts.join("/"))
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
    // Stream assistant blocks by default for faster first-token feedback.
    cfg["agents"]["defaults"]["blockStreamingDefault"] = serde_json::json!("on");
    cfg["agents"]["defaults"]["blockStreamingBreak"] = serde_json::json!("text_end");
    // Persist cron jobs across container restarts.
    cfg["cron"]["store"] = serde_json::json!("/data/cron/jobs.json");

    let slot = if !settings.memory_enabled {
        "none"
    } else if settings.memory_long_term {
        "memory-lancedb"
    } else {
        "memory-core"
    };
    cfg["plugins"]["slots"]["memory"] = serde_json::json!(slot);

    // Ensure Nova integrations plugin is enabled (OAuth bridge tools).
    cfg["plugins"]["entries"]["nova-integrations"]["enabled"] = serde_json::json!(true);

    // Ensure optional plugin tools are allowed without restricting core tools.
    const NOVA_INTEGRATION_TOOLS: [&str; 5] = [
        "calendar_list",
        "calendar_create",
        "gmail_search",
        "gmail_get",
        "gmail_send",
    ];
    const NOVA_X_TOOLS: [&str; 4] = [
        "x_search",
        "x_profile",
        "x_thread",
        "x_user_tweets",
    ];
    const NOVA_CORE_TOOLS: [&str; 1] = ["image"];

    // Enable nova-x plugin if it exists (bundled or mounted).
    let mut has_nova_x = container_path_exists("/app/extensions/nova-x");
    let mut nova_x_path: Option<String> = None;
    if let Some(skills_root) = read_container_env("NOVA_SKILLS_PATH") {
        let candidate = format!("{}/nova-x", skills_root.trim_end_matches('/'));
        if container_path_exists(&candidate) {
            has_nova_x = true;
            nova_x_path = Some(candidate);
        }
    }
    if has_nova_x {
        cfg["plugins"]["entries"]["nova-x"]["enabled"] = serde_json::json!(true);
        if let Some(path) = nova_x_path {
            let load_paths = cfg
                .pointer_mut("/plugins/load/paths")
                .and_then(|v| v.as_array_mut());
            if let Some(list) = load_paths {
                let exists = list.iter().any(|v| v.as_str() == Some(&path));
                if !exists {
                    list.push(serde_json::json!(path));
                }
            } else {
                cfg["plugins"]["load"]["paths"] = serde_json::json!([path]);
            }
        }
    }
    if cfg.get("tools").is_none() || !cfg["tools"].is_object() {
        cfg["tools"] = serde_json::json!({});
    }
    if let Some(tools) = cfg["tools"].as_object_mut() {
        let allow_entry = tools.entry("alsoAllow").or_insert(serde_json::json!([]));
        if !allow_entry.is_array() {
            *allow_entry = serde_json::json!([]);
        }
        if let Some(list) = allow_entry.as_array_mut() {
            list.retain(|v| v.as_str().map(|s| s != "nova-integrations").unwrap_or(true));
            for tool in NOVA_INTEGRATION_TOOLS {
                let exists = list.iter().any(|v| v.as_str() == Some(tool));
                if !exists {
                    list.push(serde_json::json!(tool));
                }
            }
            if has_nova_x {
                for tool in NOVA_X_TOOLS {
                    let exists = list.iter().any(|v| v.as_str() == Some(tool));
                    if !exists {
                        list.push(serde_json::json!(tool));
                    }
                }
            }
            for tool in NOVA_CORE_TOOLS {
                let exists = list.iter().any(|v| v.as_str() == Some(tool));
                if !exists {
                    list.push(serde_json::json!(tool));
                }
            }
        }
    }

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

    // Enable web search via Perplexity when in proxy mode (only if not already configured)
    if cfg.pointer("/tools/web/search/provider").is_none() {
        if let Some(proxy_base) = read_container_env("NOVA_PROXY_BASE_URL") {
            if read_container_env("NOVA_PROXY_MODE").is_some() {
                cfg["tools"]["web"]["search"]["provider"] = serde_json::json!("perplexity");
                cfg["tools"]["web"]["search"]["perplexity"]["baseUrl"] =
                    serde_json::json!(proxy_base);
            }
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
            let install_msg = match Platform::detect() {
                Platform::Linux => "Docker is not installed. Please install Docker Engine: sudo apt install docker.io",
                Platform::MacOS => "Docker is not installed. Please install Docker Desktop for development.",
                Platform::Windows => "Docker is not installed. Please install Docker Desktop for Windows.",
            };
            return Err(install_msg.to_string());
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
        start_scanner_sidecar();
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

    if let Ok(base) = std::env::var("NOVA_WEB_BASE_URL") {
        if !base.trim().is_empty() {
            docker_args.push("-e".to_string());
            docker_args.push(format!("NOVA_WEB_BASE_URL={}", base.trim()));
        }
    }

    append_nova_skills_mount(&mut docker_args);

    // Add remaining args (always use bridge networking)
    docker_args.extend([
        "-v".to_string(), "nova-openclaw-data:/data".to_string(),
        "--network".to_string(), "nova-net".to_string(),
        "-p".to_string(), "127.0.0.1:19789:18789".to_string(),
        "--restart".to_string(), "unless-stopped".to_string(),
        "openclaw-runtime:latest".to_string(),
    ]);

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
    println!("[Nova] Starting gateway container with model: {}", model);
    println!("[Nova] Docker command: docker {}", docker_args.join(" "));

    let run = docker_command()
        .args(&docker_args)
        .output()
        .map_err(|e| format!("Failed to run container: {}", e))?;

    if !run.status.success() {
        let stderr = String::from_utf8_lossy(&run.stderr);
        println!("[Nova] Failed to start container: {}", stderr);
        return Err(format!("Failed to start container: {}", stderr));
    }

    println!("[Nova] Container started successfully");

    // Apply persisted settings to the fresh container
    apply_agent_settings(&app, &state)?;

    // Start skill scanner sidecar
    start_scanner_sidecar();

    Ok(())
}

#[tauri::command]
pub async fn stop_gateway() -> Result<(), String> {
    stop_scanner_sidecar();

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
    // Convert localhost URLs to host.docker.internal for Docker container access
    let docker_proxy_url = if proxy_url.contains("localhost") || proxy_url.contains("127.0.0.1") {
        proxy_url
            .replace("localhost", "host.docker.internal")
            .replace("127.0.0.1", "host.docker.internal")
    } else {
        proxy_url.clone()
    };
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
        let expected_proxy_env = format!("{}/v1", docker_proxy_url);
        let current_proxy = read_container_env("NOVA_PROXY_BASE_URL");
        let current_token = read_container_env("OPENROUTER_API_KEY");
        let current_model = read_container_env("OPENCLAW_MODEL");
        let current_image = read_container_env("OPENCLAW_IMAGE_MODEL");
        let expected_image = image_model.clone().unwrap_or_default();

        let proxy_matches = current_proxy.as_deref() == Some(expected_proxy_env.as_str());
        let token_matches = current_token.as_deref() == Some(gateway_token.as_str());
        let model_matches = current_model.as_deref() == Some(model.as_str());
        let image_matches = expected_image.is_empty()
            || current_image.as_deref() == Some(expected_image.as_str());

        if proxy_matches && token_matches && model_matches && image_matches {
            println!("[Nova] Proxy container already running with matching config. Reusing.");
            apply_agent_settings(&app, &state)?;
            start_scanner_sidecar();
            return Ok(());
        }

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
        "-e".to_string(), format!("NOVA_PROXY_BASE_URL={}/v1", docker_proxy_url),
    ];

    if let Some(image_model) = image_model {
        if !image_model.trim().is_empty() {
            docker_args.push("-e".to_string());
            docker_args.push(format!("OPENCLAW_IMAGE_MODEL={}", image_model));
        }
    }

    // Nova web base URL for plugin tools (billing + proxy endpoints)
    docker_args.push("-e".to_string());
    docker_args.push(format!("NOVA_WEB_BASE_URL={}", docker_proxy_url));

    append_nova_skills_mount(&mut docker_args);

    // Add remaining args (always use bridge networking)
    docker_args.extend([
        "-v".to_string(), "nova-openclaw-data:/data".to_string(),
        "--network".to_string(), "nova-net".to_string(),
        "-p".to_string(), "127.0.0.1:19789:18789".to_string(),
        "--restart".to_string(), "unless-stopped".to_string(),
        "openclaw-runtime:latest".to_string(),
    ]);

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
    println!("[Nova] Starting proxy gateway with model: {}", model);
    println!("[Nova] Proxy URL: {}", docker_proxy_url);
    println!("[Nova] Docker command: docker {}", docker_args.join(" "));

    let run = docker_command()
        .args(&docker_args)
        .output()
        .map_err(|e| format!("Failed to run container: {}", e))?;

    if !run.status.success() {
        let stderr = String::from_utf8_lossy(&run.stderr);
        println!("[Nova] Failed to start proxy container: {}", stderr);
        return Err(format!("Failed to start container: {}", stderr));
    }

    println!("[Nova] Proxy container started successfully");

    // Apply persisted settings
    apply_agent_settings(&app, &state)?;

    // Start skill scanner sidecar
    start_scanner_sidecar();

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
        println!("[Nova] Container not running");
        return Ok(false);
    }

    let ws_url = if std::path::Path::new("/.dockerenv").exists() {
        "ws://nova-openclaw:18789"
    } else {
        "ws://127.0.0.1:19789"
    };

    println!("[Nova] Checking gateway health via WS at: {}", ws_url);
    match check_gateway_ws_health(ws_url, "nova-local-gateway").await {
        Ok(true) => {
            println!("[Nova] Gateway health check passed");
            Ok(true)
        }
        Ok(false) => {
            println!("[Nova] Gateway health check failed");
            Ok(false)
        }
        Err(e) => {
            println!("[Nova] Gateway health check failed: {}", e);
            // Check if container is actually healthy
            let inspect = docker_command()
                .args(["inspect", "--format", "{{.State.Health.Status}}", "nova-openclaw"])
                .output();

            if let Ok(output) = inspect {
                let health_status = String::from_utf8_lossy(&output.stdout).trim().to_string();
                println!("[Nova] Container health status: {}", health_status);
            }
            Ok(false)
        }
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
    docker_exec_output(&args)
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
    let size_estimate = (base64.len() as u64 * 3) / 4;
    if size_estimate > 25 * 1024 * 1024 {
        return Err("Attachment too large (max 25MB)".to_string());
    }
    let mk = "/home/node/.openclaw/uploads/tmp";
    docker_exec_output(&["exec", OPENCLAW_CONTAINER, "mkdir", "-p", "--", mk])?;
    let decoded = decode_base64_payload(&base64)?;
    let size_bytes = decoded.len() as u64;
    if size_bytes > 25 * 1024 * 1024 {
        return Err("Attachment too large (max 25MB)".to_string());
    }
    let mut child = docker_command()
        .args(["exec", "-i", OPENCLAW_CONTAINER, "tee", "--", &temp_path])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .spawn()
        .map_err(|e| format!("Failed to upload file: {}", e))?;
    if let Some(stdin) = child.stdin.as_mut() {
        use std::io::Write;
        stdin
            .write_all(&decoded)
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
    docker_exec_output(&["exec", OPENCLAW_CONTAINER, "mkdir", "-p", "--", dest_dir])?;
    // Avoid overwrite: add suffix if exists
    if docker_exec_output(&["exec", OPENCLAW_CONTAINER, "test", "-e", &dest_path]).is_ok() {
        let ts = unique_id();
        dest_path = format!("{}/{}_{}", dest_dir, ts, file_name);
    }
    docker_exec_output(&[
        "exec",
        OPENCLAW_CONTAINER,
        "mv",
        "--",
        &temp_path,
        &dest_path,
    ])?;
    Ok(dest_path)
}

#[tauri::command]
pub async fn delete_attachment(temp_path: String) -> Result<(), String> {
    docker_exec_output(&["exec", OPENCLAW_CONTAINER, "rm", "-f", "--", &temp_path])?;
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

        let managed = kind.as_deref() == Some("memory") || MANAGED_PLUGIN_IDS.contains(&id.as_str());

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
    if MANAGED_PLUGIN_IDS.contains(&id.as_str()) {
        return Err("Plugin is managed by Nova".to_string());
    }
    let mut cfg = read_openclaw_config();
    cfg["plugins"]["entries"][&id]["enabled"] = serde_json::json!(enabled);
    write_openclaw_config(&cfg)
}

#[tauri::command]
pub async fn scan_plugin(id: String) -> Result<PluginScanResult, String> {
    // Check if scanner is running
    let check = docker_command()
        .args(["ps", "-q", "-f", &format!("name={}", SCANNER_CONTAINER), "-f", "status=running"])
        .output()
        .map_err(|e| format!("Failed to check scanner: {}", e))?;

    if check.stdout.is_empty() {
        return Ok(PluginScanResult {
            scan_id: None,
            is_safe: true,
            max_severity: "UNKNOWN".to_string(),
            findings_count: 0,
            findings: vec![],
            scanner_available: false,
        });
    }

    let skill_dir = format!("/app/extensions/{}", id);
    let body = serde_json::json!({
        "skill_directory": skill_dir,
        "use_behavioral": true,
        "use_llm": false,
    });

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let scan_url = if std::path::Path::new("/.dockerenv").exists() {
        format!("http://{}:8000/scan", SCANNER_CONTAINER)
    } else {
        "http://127.0.0.1:19790/scan".to_string()
    };

    let res = client
        .post(&scan_url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Scan request failed: {}", e))?;

    if !res.status().is_success() {
        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        return Err(format!("Scanner returned {}: {}", status, text));
    }

    let scan_response: serde_json::Value = res
        .json()
        .await
        .map_err(|e| format!("Failed to parse scan response: {}", e))?;

    let findings: Vec<ScanFinding> = scan_response
        .get("findings")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .map(|f| ScanFinding {
                    analyzer: f.get("analyzer").and_then(|v| v.as_str()).map(|s| s.to_string()),
                    category: f.get("category").and_then(|v| v.as_str()).map(|s| s.to_string()),
                    severity: f.get("severity").and_then(|v| v.as_str()).unwrap_or("UNKNOWN").to_string(),
                    title: f.get("title").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    description: f.get("description").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    file_path: f.get("file_path").and_then(|v| v.as_str()).map(|s| s.to_string()),
                    line_number: f.get("line_number").and_then(|v| v.as_u64()).map(|n| n as u32),
                    snippet: f.get("snippet").and_then(|v| v.as_str()).map(|s| s.to_string()),
                    remediation: f.get("remediation").and_then(|v| v.as_str()).map(|s| s.to_string()),
                })
                .collect()
        })
        .unwrap_or_default();

    Ok(PluginScanResult {
        scan_id: scan_response.get("scan_id").and_then(|v| v.as_str()).map(|s| s.to_string()),
        is_safe: scan_response.get("is_safe").and_then(|v| v.as_bool()).unwrap_or(false),
        max_severity: scan_response
            .get("max_severity")
            .and_then(|v| v.as_str())
            .unwrap_or("UNKNOWN")
            .to_string(),
        findings_count: findings.len() as u32,
        findings,
        scanner_available: true,
    })
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

// ── Workspace File Commands ──────────────────────────────────────────

const WORKSPACE_ROOT: &str = "/home/node/.openclaw/workspace";

#[derive(Debug, Clone, serde::Serialize)]
pub struct WorkspaceFileEntry {
    pub name: String,
    pub path: String,
    pub is_directory: bool,
    pub size: u64,
    pub modified_at: u64,
}

#[tauri::command]
pub async fn list_workspace_files(path: String) -> Result<Vec<WorkspaceFileEntry>, String> {
    let sanitized = sanitize_workspace_path(&path)?;
    let full_path = if sanitized.is_empty() {
        WORKSPACE_ROOT.to_string()
    } else {
        format!("{}/{}", WORKSPACE_ROOT, sanitized)
    };

    // Ensure the directory exists
    docker_exec_output(&["exec", OPENCLAW_CONTAINER, "mkdir", "-p", "--", &full_path])?;

    let output = docker_exec_output(&[
        "exec",
        OPENCLAW_CONTAINER,
        "ls",
        "-la",
        "--time-style=+%s",
        "--",
        &full_path,
    ])
    .unwrap_or_default();

    let mut entries = Vec::new();
    for line in output.lines().skip(1) {
        // skip the "total N" line
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 7 {
            continue;
        }
        let name = parts[6..].join(" ");
        if name == "." || name == ".." {
            continue;
        }
        let is_directory = parts[0].starts_with('d');
        let size: u64 = parts[4].parse().unwrap_or(0);
        let modified_at: u64 = parts[5].parse().unwrap_or(0);
        let entry_path = if sanitized.is_empty() {
            name.clone()
        } else {
            format!("{}/{}", sanitized, name)
        };
        entries.push(WorkspaceFileEntry {
            name,
            path: entry_path,
            is_directory,
            size,
            modified_at,
        });
    }
    Ok(entries)
}

#[tauri::command]
pub async fn read_workspace_file(path: String) -> Result<String, String> {
    let sanitized = sanitize_workspace_path(&path)?;
    if sanitized.is_empty() {
        return Err("Invalid path".to_string());
    }
    let full_path = format!("{}/{}", WORKSPACE_ROOT, sanitized);
    read_container_file(&full_path).ok_or_else(|| "File not found or unreadable".to_string())
}

#[tauri::command]
pub async fn read_workspace_file_base64(path: String) -> Result<String, String> {
    let sanitized = sanitize_workspace_path(&path)?;
    if sanitized.is_empty() {
        return Err("Invalid path".to_string());
    }
    let full_path = format!("{}/{}", WORKSPACE_ROOT, sanitized);
    let raw = docker_exec_output(&["exec", OPENCLAW_CONTAINER, "base64", "--", &full_path])
        .map_err(|_| "File not found or unreadable".to_string())?;
    Ok(raw.chars().filter(|c| *c != '\n' && *c != '\r').collect())
}

#[tauri::command]
pub async fn delete_workspace_file(path: String) -> Result<(), String> {
    let sanitized = sanitize_workspace_path(&path)?;
    if sanitized.is_empty() {
        return Err("Cannot delete workspace root".to_string());
    }
    let full_path = format!("{}/{}", WORKSPACE_ROOT, sanitized);
    docker_exec_output(&["exec", OPENCLAW_CONTAINER, "rm", "-rf", "--", &full_path])?;
    Ok(())
}

#[tauri::command]
pub async fn upload_workspace_file(
    file_name: String,
    base64: String,
    dest_path: String,
) -> Result<(), String> {
    let sanitized_name = sanitize_filename(&file_name);
    let sanitized_dest = sanitize_workspace_path(&dest_path)?;
    let dir = if sanitized_dest.is_empty() {
        WORKSPACE_ROOT.to_string()
    } else {
        format!("{}/{}", WORKSPACE_ROOT, sanitized_dest)
    };
    let full_path = format!("{}/{}", dir, sanitized_name);

    docker_exec_output(&["exec", OPENCLAW_CONTAINER, "mkdir", "-p", "--", &dir])?;
    let decoded = decode_base64_payload(&base64)?;

    let mut child = docker_command()
        .args(["exec", "-i", OPENCLAW_CONTAINER, "tee", "--", &full_path])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .spawn()
        .map_err(|e| format!("Failed to upload file: {}", e))?;
    if let Some(stdin) = child.stdin.as_mut() {
        use std::io::Write;
        stdin
            .write_all(&decoded)
            .map_err(|e| format!("Failed to write file data: {}", e))?;
    }
    let status = child
        .wait()
        .map_err(|e| format!("Failed to finalize upload: {}", e))?;
    if !status.success() {
        return Err("Failed to upload file to container".to_string());
    }
    Ok(())
}

// =============================================================================
// Local OAuth (Google integrations)
// =============================================================================

const AUTH_LOCALHOST_PORT_ENV: &str = "NOVA_AUTH_LOCALHOST_PORT";
const AUTH_LOCALHOST_DEFAULT_PORT: u16 = 27100;

const GOOGLE_AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL: &str = "https://www.googleapis.com/oauth2/v2/userinfo";

#[derive(Debug, Clone, serde::Serialize)]
pub struct LocalhostAuthStart {
    pub redirect_url: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct OAuthTokenBundle {
    pub access_token: String,
    pub refresh_token: String,
    pub token_type: Option<String>,
    pub expires_at: u64,
    pub scopes: Vec<String>,
    pub email: Option<String>,
    pub provider_user_id: Option<String>,
    pub metadata: serde_json::Value,
}

#[derive(Debug, serde::Deserialize)]
struct OAuthTokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    token_type: Option<String>,
    expires_in: Option<u64>,
    scope: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
struct GoogleUserInfo {
    email: Option<String>,
    id: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct RefreshTokenResponse {
    pub access_token: String,
    pub token_type: Option<String>,
    pub expires_at: u64,
}

fn google_client_id() -> Result<String, String> {
    if let Some(val) = option_env!("NOVA_GOOGLE_CLIENT_ID") {
        return Ok(val.to_string());
    }
    if let Ok(val) = std::env::var("NOVA_GOOGLE_CLIENT_ID") {
        return Ok(val);
    }
    Err("Google OAuth client ID not configured (NOVA_GOOGLE_CLIENT_ID)".to_string())
}

fn google_client_secret() -> Option<String> {
    if let Some(val) = option_env!("NOVA_GOOGLE_CLIENT_SECRET") {
        return Some(val.to_string());
    }
    if let Ok(val) = std::env::var("NOVA_GOOGLE_CLIENT_SECRET") {
        return Some(val);
    }
    None
}

fn oauth_scopes(provider: &str) -> Result<Vec<&'static str>, String> {
    let scopes = match provider {
        "google_calendar" => vec![
            "https://www.googleapis.com/auth/calendar.events",
            "https://www.googleapis.com/auth/calendar.readonly",
            "openid",
            "email",
            "profile",
        ],
        "google_email" => vec![
            "https://www.googleapis.com/auth/gmail.readonly",
            "https://www.googleapis.com/auth/gmail.send",
            "openid",
            "email",
            "profile",
        ],
        _ => {
            return Err(format!(
                "Unsupported provider: {} (expected google_calendar or google_email)",
                provider
            ))
        }
    };
    Ok(scopes)
}

fn generate_pkce() -> (String, String) {
    let mut verifier_bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut verifier_bytes);
    let verifier = URL_SAFE_NO_PAD.encode(verifier_bytes);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    (verifier, challenge)
}

async fn wait_for_oauth_callback(
    listener: TcpListener,
    expected_state: &str,
) -> Result<String, String> {
    let (mut socket, _) = timeout(Duration::from_secs(300), listener.accept())
        .await
        .map_err(|_| "Timed out waiting for OAuth callback".to_string())?
        .map_err(|e| format!("Failed to accept OAuth callback: {}", e))?;

    let mut buffer = vec![0u8; 8192];
    let size = socket
        .read(&mut buffer)
        .await
        .map_err(|e| format!("Failed to read OAuth callback: {}", e))?;
    let request = String::from_utf8_lossy(&buffer[..size]);
    let first_line = request.lines().next().unwrap_or("");
    let path = first_line.split_whitespace().nth(1).unwrap_or("/");
    let url = Url::parse(&format!("http://127.0.0.1{}", path))
        .map_err(|_| "Invalid OAuth callback URL".to_string())?;

    let code = url
        .query_pairs()
        .find(|(k, _)| k == "code")
        .map(|(_, v)| v.to_string())
        .ok_or_else(|| "OAuth callback missing code".to_string())?;
    let state = url
        .query_pairs()
        .find(|(k, _)| k == "state")
        .map(|(_, v)| v.to_string())
        .unwrap_or_default();
    if state != expected_state {
        return Err("OAuth state mismatch".to_string());
    }

    let response = [
        "HTTP/1.1 200 OK",
        "Content-Type: text/html; charset=utf-8",
        "Connection: close",
        "",
        "<!DOCTYPE html><html><head><meta charset=\"utf-8\"/>",
        "<title>Nova OAuth</title></head><body>",
        "<h1>Authentication complete</h1>",
        "<p>You can return to the app.</p>",
        "</body></html>",
    ]
    .join("\r\n");
    let _ = socket.write_all(response.as_bytes()).await;

    Ok(code)
}

async fn wait_for_localhost_auth_callback(
    listener: TcpListener,
    app: AppHandle,
    port: u16,
) -> Result<(), String> {
    let (mut socket, _) = timeout(Duration::from_secs(300), listener.accept())
        .await
        .map_err(|_| "Timed out waiting for localhost OAuth callback".to_string())?
        .map_err(|e| format!("Failed to accept localhost OAuth callback: {}", e))?;

    let mut buffer = vec![0u8; 8192];
    let size = socket
        .read(&mut buffer)
        .await
        .map_err(|e| format!("Failed to read localhost OAuth callback: {}", e))?;
    let request = String::from_utf8_lossy(&buffer[..size]);
    let first_line = request.lines().next().unwrap_or("");
    let path = first_line.split_whitespace().nth(1).unwrap_or("/");
    let url = Url::parse(&format!("http://127.0.0.1:{}{}", port, path))
        .map_err(|_| "Invalid localhost OAuth callback URL".to_string())?;

    let has_code = url
        .query_pairs()
        .any(|(k, _)| k == "code");

    let response = [
        "HTTP/1.1 200 OK",
        "Content-Type: text/html; charset=utf-8",
        "Connection: close",
        "",
        "<!DOCTYPE html><html><head><meta charset=\"utf-8\"/>",
        "<title>Nova Sign-in</title></head><body>",
        "<h1>Authentication complete</h1>",
        "<p>You can return to the app.</p>",
        "</body></html>",
    ]
    .join("\r\n");
    let _ = socket.write_all(response.as_bytes()).await;

    if has_code {
        let _ = app.emit("auth-localhost-callback", url.to_string());
    } else {
        return Err("Localhost OAuth callback missing code".to_string());
    }

    Ok(())
}

#[tauri::command]
pub async fn start_auth_localhost(app: AppHandle) -> Result<LocalhostAuthStart, String> {
    if !cfg!(debug_assertions) {
        return Err("Localhost OAuth is only available in dev builds".to_string());
    }

    let port = std::env::var(AUTH_LOCALHOST_PORT_ENV)
        .ok()
        .and_then(|v| v.parse::<u16>().ok())
        .unwrap_or(AUTH_LOCALHOST_DEFAULT_PORT);
    let addr = format!("127.0.0.1:{}", port);
    let listener = TcpListener::bind(&addr)
        .await
        .map_err(|e| format!("Failed to bind localhost OAuth server on {}: {}", addr, e))?;

    let redirect_url = format!("http://{}/auth/callback", addr);
    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(err) = wait_for_localhost_auth_callback(listener, app_handle, port).await {
            eprintln!("[Nova] Localhost OAuth error: {}", err);
        }
    });

    Ok(LocalhostAuthStart { redirect_url })
}

async fn exchange_code_for_tokens(
    code: String,
    verifier: String,
    redirect_uri: String,
) -> Result<OAuthTokenResponse, String> {
    let client_id = google_client_id()?;
    let client = reqwest::Client::new();
    let mut params = vec![
        ("client_id", client_id),
        ("code", code),
        ("grant_type", "authorization_code".to_string()),
        ("redirect_uri", redirect_uri),
        ("code_verifier", verifier),
    ];
    if let Some(secret) = google_client_secret() {
        params.push(("client_secret", secret));
    }
    let resp = client
        .post(GOOGLE_TOKEN_URL)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .form(&params)
        .send()
        .await
        .map_err(|e| format!("Token exchange failed: {}", e))?;

    if !resp.status().is_success() {
        let text = resp
            .text()
            .await
            .unwrap_or_else(|_| "unknown error".to_string());
        return Err(format!("Token exchange failed: {}", text));
    }

    resp.json::<OAuthTokenResponse>()
        .await
        .map_err(|e| format!("Failed to parse token response: {}", e))
}

async fn fetch_google_user(access_token: &str) -> Result<GoogleUserInfo, String> {
    let client = reqwest::Client::new();
    let resp = client
        .get(GOOGLE_USERINFO_URL)
        .header("Authorization", format!("Bearer {}", access_token))
        .send()
        .await
        .map_err(|e| format!("Failed to fetch user info: {}", e))?;
    if !resp.status().is_success() {
        return Ok(GoogleUserInfo { email: None, id: None });
    }
    resp.json::<GoogleUserInfo>()
        .await
        .map_err(|e| format!("Failed to parse user info: {}", e))
}

#[tauri::command]
pub async fn start_google_oauth(app: AppHandle, provider: String) -> Result<OAuthTokenBundle, String> {
    let scopes = oauth_scopes(&provider)?;
    let (verifier, challenge) = generate_pkce();
    let state = URL_SAFE_NO_PAD.encode({
        let mut bytes = [0u8; 16];
        rand::thread_rng().fill_bytes(&mut bytes);
        bytes
    });

    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("Failed to bind OAuth callback server: {}", e))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("Failed to read OAuth callback port: {}", e))?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{}/oauth/callback", port);

    let mut auth_url = Url::parse(GOOGLE_AUTH_URL)
        .map_err(|_| "Failed to build OAuth URL".to_string())?;
    auth_url.query_pairs_mut()
        .append_pair("client_id", &google_client_id()?)
        .append_pair("response_type", "code")
        .append_pair("redirect_uri", &redirect_uri)
        .append_pair("scope", &scopes.join(" "))
        .append_pair("code_challenge", &challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", &state)
        .append_pair("access_type", "offline")
        .append_pair("prompt", "consent");

    app.shell()
        .open(auth_url.as_str(), None)
        .map_err(|e| format!("Failed to open browser: {}", e))?;

    let code = wait_for_oauth_callback(listener, &state).await?;
    let token_response = exchange_code_for_tokens(code, verifier, redirect_uri).await?;
    let refresh_token = token_response
        .refresh_token
        .ok_or_else(|| "OAuth did not return a refresh token. Re-consent required.".to_string())?;
    let expires_in = token_response.expires_in.unwrap_or(3600);
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "Clock error".to_string())?
        .as_millis() as u64;
    let expires_at = now_ms.saturating_add(expires_in * 1000);
    let user_info = fetch_google_user(&token_response.access_token).await.unwrap_or(GoogleUserInfo {
        email: None,
        id: None,
    });

    let scopes_list = token_response
        .scope
        .map(|s| s.split_whitespace().map(|v| v.to_string()).collect())
        .unwrap_or_else(|| scopes.iter().map(|s| s.to_string()).collect());

    Ok(OAuthTokenBundle {
        access_token: token_response.access_token,
        refresh_token,
        token_type: token_response.token_type,
        expires_at,
        scopes: scopes_list,
        email: user_info.email,
        provider_user_id: user_info.id,
        metadata: serde_json::json!({}),
    })
}

#[tauri::command]
pub async fn refresh_google_token(provider: String, refresh_token: String) -> Result<RefreshTokenResponse, String> {
    oauth_scopes(&provider)?;
    let client_id = google_client_id()?;
    let client = reqwest::Client::new();
    let mut params = vec![
        ("client_id", client_id),
        ("refresh_token", refresh_token),
        ("grant_type", "refresh_token".to_string()),
    ];
    if let Some(secret) = google_client_secret() {
        params.push(("client_secret", secret));
    }
    let resp = client
        .post(GOOGLE_TOKEN_URL)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .form(&params)
        .send()
        .await
        .map_err(|e| format!("Token refresh failed: {}", e))?;

    if !resp.status().is_success() {
        let text = resp
            .text()
            .await
            .unwrap_or_else(|_| "unknown error".to_string());
        return Err(format!("Token refresh failed: {}", text));
    }

    let data = resp
        .json::<OAuthTokenResponse>()
        .await
        .map_err(|e| format!("Failed to parse refresh response: {}", e))?;

    let expires_in = data.expires_in.unwrap_or(3600);
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "Clock error".to_string())?
        .as_millis() as u64;
    let expires_at = now_ms.saturating_add(expires_in * 1000);

    Ok(RefreshTokenResponse {
        access_token: data.access_token,
        token_type: data.token_type,
        expires_at,
    })
}
