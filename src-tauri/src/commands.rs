use crate::runtime::{
    macos_docker_socket_candidates, entropic_colima_home_path, Platform, Runtime, RuntimeStatus,
    ENTROPIC_QEMU_PROFILE, ENTROPIC_VZ_PROFILE, LEGACY_NOVA_QEMU_PROFILE,
    LEGACY_NOVA_VZ_PROFILE,
};
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine as _,
};
use futures_util::{SinkExt, StreamExt};
use http;
use rand::RngCore;
use serde::de::DeserializeOwned;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::Mutex as AsyncMutex;
use tokio::time::timeout;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use url::Url;

const ENTROPIC_PROXY_DEV_ORIGIN: &str = "http://host.docker.internal:5174";
const ENTROPIC_PROXY_ALLOWED_HOSTS: &[&str] = &[
    "entropic.qu.ai",
    "host.docker.internal",
    "localhost",
    "127.0.0.1",
];
const MAX_BRIDGE_DEVICES: usize = 10;
const CLIENT_LOG_MAX_BYTES: u64 = 2 * 1024 * 1024;

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

/// Get the Docker socket path for the current platform.
/// On macOS, uses Colima socket. On Linux/Windows, uses default.
fn get_docker_host() -> Option<String> {
    match Platform::detect() {
        Platform::MacOS => {
            // Prefer Entropic-managed Colima sockets, then Docker Desktop sockets.
            for socket in macos_docker_socket_candidates() {
                if socket.exists() {
                    return Some(format!("unix://{}", socket.display()));
                }
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

fn docker_binary_usable(candidate: &str) -> bool {
    Command::new(candidate)
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn resolve_container_proxy_base(proxy_url: &str) -> Result<String, String> {
    let trimmed = proxy_url.trim();
    if trimmed.is_empty() {
        return Ok(ENTROPIC_PROXY_DEV_ORIGIN.to_string());
    }

    if trimmed.starts_with('/') {
        let path = trimmed.trim_start_matches('/');
        return Ok(if path.is_empty() {
            ENTROPIC_PROXY_DEV_ORIGIN.trim_end_matches('/').to_string()
        } else {
            format!("{}/{}", ENTROPIC_PROXY_DEV_ORIGIN.trim_end_matches('/'), path)
        });
    }

    let mut url = Url::parse(trimmed)
        .map_err(|_| "Invalid proxy URL. Enter /path or a valid http/https URL.".to_string())?;

    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(format!(
            "Invalid proxy URL scheme '{}'. Only http/https are supported.",
            url.scheme()
        ));
    }

    let host = url
        .host_str()
        .ok_or_else(|| "Invalid proxy URL: missing host.".to_string())?;
    if !ENTROPIC_PROXY_ALLOWED_HOSTS.contains(&host) {
        return Err(format!(
            "Proxy host '{}' is not allowed. Configure ENTROPIC_PROXY_BASE_URL with an allowed host.",
            host
        ));
    }

    if matches!(host, "localhost" | "127.0.0.1") {
        let had_port = url.port().is_some();
        if let Some(host) = Url::parse("http://host.docker.internal:5174")
            .ok()
            .and_then(|proxy_host| proxy_host.host_str().map(ToString::to_string))
        {
            let _ = url.set_host(Some(&host));
        }
        if !had_port {
            let _ = url.set_port(Some(5174));
        }
    }

    Ok(url.to_string().trim_end_matches('/').to_string())
}

fn resolve_container_openai_base(proxy_base: &str) -> String {
    let trimmed = proxy_base.trim_end_matches('/');
    if trimmed.ends_with("/v1") {
        return trimmed.to_string();
    }
    if trimmed.is_empty() {
        return ENTROPIC_PROXY_DEV_ORIGIN.to_string();
    }
    format!("{}/v1", trimmed)
}

/// Find the docker binary.
/// On macOS, prefer bundled docker but only if it can execute.
/// On Linux/Windows, prefer system docker to avoid packaged binaries from other platforms.
fn find_docker_binary() -> String {
    // 1. macOS bundled docker candidates (release + dev)
    if matches!(Platform::detect(), Platform::MacOS) {
        if let Ok(exe) = std::env::current_exe() {
            if let Some(exe_dir) = exe.parent() {
                let bundled_release = exe_dir.parent().map(|c| {
                    c.join("Resources")
                        .join("resources")
                        .join("bin")
                        .join("docker")
                });
                if let Some(ref p) = bundled_release {
                    let candidate = p.display().to_string();
                    if p.exists() && docker_binary_usable(&candidate) {
                        return candidate;
                    }
                }

                let bundled_dev = exe_dir.join("resources").join("bin").join("docker");
                let candidate = bundled_dev.display().to_string();
                if bundled_dev.exists() && docker_binary_usable(&candidate) {
                    return candidate;
                }
            }
        }
    }

    // 2. Well-known system locations
    for candidate in &[
        "/usr/local/bin/docker",
        "/opt/homebrew/bin/docker",
        "/usr/bin/docker",
    ] {
        if std::path::Path::new(candidate).exists() && docker_binary_usable(candidate) {
            return candidate.to_string();
        }
    }

    // 3. Fall back to bare name (relies on PATH)
    "docker".to_string()
}

/// Create a Docker command with the correct DOCKER_HOST set
fn docker_command() -> Command {
    let docker = find_docker_binary();
    let mut cmd = Command::new(docker);
    if let Some(host) = get_docker_host() {
        cmd.env("DOCKER_HOST", host);
    }
    cmd
}

/// The Docker image used for the gateway container.
const RUNTIME_IMAGE: &str = "openclaw-runtime:latest";

/// Registry to pull the runtime image from when not available locally.
/// Override at build time with ENTROPIC_RUNTIME_REGISTRY env var.
fn runtime_registry_image() -> String {
    // Build-time override
    if let Some(val) = option_env!("ENTROPIC_RUNTIME_REGISTRY") {
        return val.to_string();
    }
    // Runtime override
    if let Ok(val) = std::env::var("ENTROPIC_RUNTIME_REGISTRY") {
        if !val.trim().is_empty() {
            return val;
        }
    }
    // Default: GitHub Container Registry
    "ghcr.io/nickthecook/openclaw-runtime:latest".to_string()
}

/// Ensure the openclaw-runtime image is available locally.
/// 1. Try loading a bundled tar (resources/openclaw-runtime.tar.gz or .tar).
///    If a bundled image matches the local image signature, skip reload.
/// 2. Fallback to local image check for existing image.
/// 3. Try pulling from the configured registry.
/// 4. Return a descriptive Err if nothing works.
fn bundled_runtime_signature_from_manifest(tar_path: &Path) -> Result<String, String> {
    let tar_path = tar_path.to_string_lossy();
    let output = Command::new("tar")
        .args(["-xOf", tar_path.as_ref(), "manifest.json"])
        .output()
        .map_err(|e| format!("failed to read manifest from {}: {}", tar_path, e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "failed to read manifest.json from {}: {}",
            tar_path,
            stderr.trim()
        ));
    }

    let manifest: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("invalid manifest.json in {}: {}", tar_path, e))?;
    let first_entry = manifest
        .as_array()
        .and_then(|items| items.first())
        .ok_or_else(|| format!("manifest.json in {} has no entries", tar_path))?;
    let config = first_entry
        .get("Config")
        .and_then(|value| value.as_str())
        .ok_or_else(|| format!("manifest.json in {} missing Config field", tar_path))?;

    let normalized = config
        .strip_prefix("blobs/sha256/")
        .or_else(|| config.strip_prefix("sha256:"))
        .unwrap_or(config)
        .trim()
        .to_string();

    if normalized.is_empty() {
        return Err(format!("empty Config field in {}", tar_path));
    }
    Ok(normalized)
}

enum RuntimeImageInspectState {
    Present(String),
    Missing,
    Unavailable(String),
}

fn runtime_image_inspect_once() -> Result<RuntimeImageInspectState, String> {
    let output = docker_command()
        .args(["image", "inspect", RUNTIME_IMAGE, "--format", "{{.Id}}"])
        .output()
        .map_err(|e| format!("Failed to check image id: {}", e))?;
    if output.status.success() {
        let id = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if id.is_empty() {
            return Ok(RuntimeImageInspectState::Missing);
        }
        return Ok(RuntimeImageInspectState::Present(id));
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let lower = stderr.to_ascii_lowercase();
    if lower.contains("no such image")
        || lower.contains("no such object")
        || lower.contains("not found")
    {
        return Ok(RuntimeImageInspectState::Missing);
    }

    Ok(RuntimeImageInspectState::Unavailable(if stderr.is_empty() {
        "unknown docker inspect failure".to_string()
    } else {
        stderr
    }))
}

fn runtime_image_id() -> Result<Option<String>, String> {
    const MAX_ATTEMPTS: usize = 4;
    for attempt in 1..=MAX_ATTEMPTS {
        match runtime_image_inspect_once()? {
            RuntimeImageInspectState::Present(id) => return Ok(Some(id)),
            RuntimeImageInspectState::Missing => return Ok(None),
            RuntimeImageInspectState::Unavailable(err) => {
                if attempt < MAX_ATTEMPTS {
                    println!(
                        "[Entropic] Runtime image inspect unavailable (attempt {}/{}): {}. Retrying...",
                        attempt, MAX_ATTEMPTS, err
                    );
                    std::thread::sleep(Duration::from_millis(300));
                } else {
                    println!(
                        "[Entropic] Runtime image inspect unavailable after {} attempts: {}. Proceeding with bundled runtime fallback.",
                        MAX_ATTEMPTS, err
                    );
                }
            }
        }
    }
    Ok(None)
}

fn find_runtime_tar() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let exe_dir = exe.parent()?;

    let mut search_dirs = Vec::new();

    // Release bundle: .../Contents/MacOS/Entropic → .../Contents/Resources/
    if let Some(contents_dir) = exe_dir.parent() {
        let resources = contents_dir.join("Resources");
        search_dirs.push(resources.clone());
        search_dirs.push(resources.join("resources"));
    }

    // Dev mode: .../target/debug/entropic → .../target/debug/resources/
    search_dirs.push(exe_dir.join("resources"));
    // Also check src-tauri/resources/ (when running from project root)
    search_dirs.push(exe_dir.join("..").join("..").join("resources"));

    for dir in search_dirs {
        for name in &["openclaw-runtime.tar.gz", "openclaw-runtime.tar"] {
            let tar_path = dir.join(name);
            if tar_path.exists() {
                return Some(tar_path);
            }
        }
    }

    None
}

fn load_runtime_from_tar(tar_path: &Path) -> Result<bool, String> {
    println!("[Entropic] Loading runtime image from {}", tar_path.display());
    let load = docker_command()
        .args(["load", "-i"])
        .arg(tar_path)
        .output()
        .map_err(|e| format!("docker load failed: {}", e))?;
    if load.status.success() {
        println!("[Entropic] Runtime image loaded from bundled tar");
        return Ok(true);
    }
    let stderr = String::from_utf8_lossy(&load.stderr);
    println!("[Entropic] docker load failed: {}", stderr);
    Ok(false)
}

fn ensure_runtime_image() -> Result<(), String> {
    let mut require_local_reload = false;

    if let Some(tar_path) = find_runtime_tar() {
        let tar_signature = bundled_runtime_signature_from_manifest(&tar_path).map_err(|e| {
            println!("[Entropic] Failed to read bundled runtime signature: {}", e);
            e
        });

        if let Ok(tar_signature) = tar_signature {
            let local_image_id = runtime_image_id()?;
            if let Some(local_image_id) = local_image_id {
                let local_signature = local_image_id
                    .trim()
                    .trim_start_matches("sha256:")
                    .to_string();
                if local_signature == tar_signature {
                    return Ok(());
                }
                require_local_reload = true;
                println!(
                    "[Entropic] Runtime image signature changed (local: {}, bundled: {}). Reloading bundled runtime image.",
                    local_signature, tar_signature
                );
            }

            if load_runtime_from_tar(&tar_path)? {
                return Ok(());
            }
        }

        println!("[Entropic] Falling back to docker image lookup/pull flow for runtime image.");
    }

    // 2. Already present?
    let check = docker_command()
        .args(["image", "inspect", RUNTIME_IMAGE])
        .output()
        .map_err(|e| format!("Failed to check image: {}", e))?;
    if !require_local_reload && check.status.success() {
        return Ok(());
    }

    println!("[Entropic] Runtime image not found locally, attempting to load/pull...");

    if let Some(tar_path) = find_runtime_tar() {
        match load_runtime_from_tar(&tar_path) {
            Ok(true) => return Ok(()),
            Ok(false) => {} // no tar found or load failed, continue
            Err(e) => println!("[Entropic] Bundled tar check failed: {}", e),
        }
    }

    // 3. Pull from registry
    let registry_image = runtime_registry_image();
    println!("[Entropic] Pulling runtime image from {}...", registry_image);
    let pull = docker_command()
        .args(["pull", &registry_image])
        .output()
        .map_err(|e| format!("docker pull failed: {}", e))?;

    if pull.status.success() {
        // Tag as the expected local name if the registry image differs
        if registry_image != RUNTIME_IMAGE {
            let _ = docker_command()
                .args(["tag", &registry_image, RUNTIME_IMAGE])
                .output();
        }
        println!("[Entropic] Runtime image pulled successfully");
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&pull.stderr);
    println!("[Entropic] Pull failed: {}", stderr);

    Err(format!(
        "OpenClaw runtime image not available.\n\
         • Pull failed from {}: {}\n\
         • No bundled image tar found in app resources.\n\
         • To build locally: ./scripts/build-openclaw-runtime.sh",
        registry_image,
        stderr.trim()
    ))
}

/// Ensure the scanner image is available locally.
/// 1. If already present → return Ok immediately.
/// 2. Try loading a bundled tar (resources/entropic-skill-scanner.tar.gz or .tar).
/// 3. Return an error if the image is still missing.
fn ensure_scanner_image() -> Result<(), String> {
    let check = docker_command()
        .args(["image", "inspect", "entropic-skill-scanner:latest"])
        .output()
        .map_err(|e| format!("Failed to check scanner image: {}", e))?;
    if check.status.success() {
        return Ok(());
    }

    println!("[Entropic] Scanner image not found locally, attempting to load bundled tar...");

    let tar_loaded = (|| -> Result<bool, String> {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let exe_dir = exe.parent().ok_or("Cannot resolve exe dir")?;

        let mut search_dirs = Vec::new();

        // Release bundle: .../Contents/MacOS/Entropic → .../Contents/Resources/
        if let Some(contents_dir) = exe_dir.parent() {
            let resources = contents_dir.join("Resources");
            search_dirs.push(resources.clone());
            search_dirs.push(resources.join("resources"));
        }

        // Dev mode: .../target/debug/entropic → .../target/debug/resources/
        search_dirs.push(exe_dir.join("resources"));
        // Also check src-tauri/resources/ (when running from project root)
        search_dirs.push(exe_dir.join("..").join("..").join("resources"));

        for dir in &search_dirs {
            for name in &[
                "entropic-skill-scanner.tar.gz",
                "entropic-skill-scanner.tar",
                "skill-scanner.tar.gz",
                "skill-scanner.tar",
            ] {
                let tar_path = dir.join(name);
                if tar_path.exists() {
                    println!("[Entropic] Loading scanner image from {}", tar_path.display());
                    let load = docker_command()
                        .args(["load", "-i"])
                        .arg(&tar_path)
                        .output()
                        .map_err(|e| format!("docker load failed: {}", e))?;
                    if load.status.success() {
                        println!("[Entropic] Scanner image loaded from bundled tar");
                        return Ok(true);
                    }
                    let stderr = String::from_utf8_lossy(&load.stderr);
                    println!("[Entropic] Scanner docker load failed: {}", stderr);
                }
            }
        }
        Ok(false)
    })();

    match tar_loaded {
        Ok(true) => Ok(()),
        Ok(false) => Err(
            "Skill scanner image not available and no bundled scanner tar was found in app resources."
                .to_string(),
        ),
        Err(e) => Err(format!("Failed to load scanner image from bundle: {}", e)),
    }
}

async fn check_gateway_ws_health(ws_url: &str, token: &str) -> Result<bool, String> {
    // Create WebSocket request with Origin header for gateway origin check
    let uri: http::Uri = ws_url.parse().map_err(|e| format!("Invalid URL: {}", e))?;
    let host = uri.host().unwrap_or("localhost").to_string();
    let request = http::Request::builder()
        .uri(uri)
        .header("Host", host)
        .header("Origin", "http://localhost")
        .header("Connection", "Upgrade")
        .header("Upgrade", "websocket")
        .header("Sec-WebSocket-Version", "13")
        .header("Sec-WebSocket-Key", tokio_tungstenite::tungstenite::handshake::client::generate_key())
        .body(())
        .map_err(|e| format!("Failed to build request: {}", e))?;

    let connect = timeout(Duration::from_millis(1200), connect_async(request))
        .await
        .map_err(|_| "WebSocket connect timeout".to_string())?;
    let (mut ws, _) = connect.map_err(|e| format!("WebSocket connect failed: {}", e))?;

    let result = timeout(Duration::from_millis(1800), async {
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
                                    "id": "openclaw-control-ui",
                                    "displayName": "Entropic Desktop",
                                    "version": "0.1.0",
                                    "platform": "desktop",
                                    "mode": "probe"
                                },
                                "role": "operator",
                                "scopes": ["operator.read", "operator.write", "operator.admin"],
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
                        if !ok {
                            let msg = frame
                                .get("error")
                                .and_then(|v| v.get("message"))
                                .and_then(|v| v.as_str())
                                .unwrap_or("gateway health rejected");
                            return Err(msg.to_string());
                        }
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
    pub bridge_server_started: Mutex<bool>,
    /// Stores the PKCE verifier for the in-flight Anthropic OAuth flow
    pub anthropic_oauth_verifier: Mutex<Option<String>>,
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
            bridge_server_started: Mutex::new(false),
            anthropic_oauth_verifier: Mutex::new(None),
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
pub struct GatewayAuthPayload {
    pub ws_url: String,
    pub token: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct TelegramTokenValidationResult {
    pub valid: bool,
    pub bot_id: Option<i64>,
    pub username: Option<String>,
    pub display_name: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct GatewayHealResult {
    pub container: String,
    pub restarted: bool,
    pub message: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct GatewayConfigHealth {
    pub status: String,
    pub summary: String,
    pub issues: Vec<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct AgentProfileState {
    pub soul: String,
    pub heartbeat_every: String,
    pub heartbeat_tasks: Vec<String>,
    pub memory_enabled: bool,
    pub memory_long_term: bool,
    pub memory_sessions_enabled: bool,
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
    pub telegram_dm_policy: String,
    pub telegram_group_policy: String,
    pub telegram_config_writes: bool,
    pub telegram_require_mention: bool,
    pub telegram_reply_to_mode: String,
    pub telegram_link_preview: bool,
    pub slack_enabled: bool,
    pub slack_bot_token: String,
    pub slack_app_token: String,
    pub googlechat_enabled: bool,
    pub googlechat_service_account: String,
    pub googlechat_audience_type: String,
    pub googlechat_audience: String,
    pub whatsapp_enabled: bool,
    pub whatsapp_allow_from: String,
    pub bridge_enabled: bool,
    pub bridge_tailnet_ip: String,
    pub bridge_port: u16,
    pub bridge_pairing_expires_at_ms: u64,
    pub bridge_device_id: String,
    pub bridge_device_name: String,
    pub bridge_devices: Vec<BridgeDeviceSummary>,
    pub bridge_device_count: usize,
    pub bridge_online_count: usize,
    pub bridge_paired: bool,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CapabilityState {
    pub id: String,
    pub label: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct BridgeState {
    pub enabled: bool,
    pub tailnet_ip: String,
    pub port: u16,
    pub pairing_expires_at_ms: u64,
    pub device_id: String,
    pub device_name: String,
    pub last_seen_at_ms: u64,
    pub paired: bool,
    pub devices: Vec<BridgeDeviceSummary>,
    pub device_count: usize,
    pub online_count: usize,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct BridgeDeviceSummary {
    pub id: String,
    pub name: String,
    pub owner_name: String,
    pub created_at_ms: u64,
    pub last_seen_at_ms: u64,
    pub scopes: Vec<String>,
    pub is_online: bool,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct BridgePairingPayload {
    pub status: BridgeState,
    pub token: String,
    pub pair_uri: String,
    pub qr_data_url: String,
    pub expires_at_ms: u64,
}

#[derive(Debug, Clone, serde::Deserialize)]
struct BridgePairRequest {
    token: String,
    device_id: String,
    device_name: Option<String>,
    owner_name: Option<String>,
    device_public_key: Option<String>,
}

#[derive(Debug, Clone, serde::Deserialize)]
struct BridgeHeartbeatRequest {
    device_id: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(default)]
struct BridgeDeviceRecord {
    id: String,
    name: String,
    owner_name: String,
    public_key: String,
    created_at_ms: u64,
    last_seen_at_ms: u64,
    scopes: Vec<String>,
}

impl Default for BridgeDeviceRecord {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            owner_name: String::new(),
            public_key: String::new(),
            created_at_ms: 0,
            last_seen_at_ms: 0,
            scopes: vec!["chat".to_string()],
        }
    }
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

#[derive(Debug, Clone, serde::Serialize)]
pub struct SkillInfo {
    pub id: String,
    pub name: String,
    pub description: String,
    pub path: String,
    pub source: String,
    pub scan: Option<PluginScanResult>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ClawhubInstallResult {
    pub scan: PluginScanResult,
    pub installed: bool,
    pub blocked: bool,
    pub message: Option<String>,
    pub installed_skill_id: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ClawhubCatalogSkill {
    pub slug: String,
    pub display_name: String,
    pub summary: String,
    pub latest_version: Option<String>,
    pub downloads: u64,
    pub installs_all_time: u64,
    pub stars: u64,
    pub updated_at: Option<u64>,
    pub is_fallback: bool,
}

const FEATURED_CLAWHUB_SKILLS: &[(&str, &str, &str)] = &[
    (
        "github",
        "GitHub",
        "Interact with GitHub repos, issues, PRs, and commits.",
    ),
    (
        "ontology",
        "Ontology",
        "Knowledge graph and ontology management for structured reasoning.",
    ),
    (
        "summarize",
        "Summarize",
        "Intelligent text summarization for long documents and content.",
    ),
    (
        "slack",
        "Slack",
        "Send and manage Slack messages and channels.",
    ),
];

static CLAWHUB_CATALOG_CACHE: OnceLock<Mutex<Option<(Vec<ClawhubCatalogSkill>, Instant)>>> =
    OnceLock::new();

fn featured_clawhub_skills() -> Vec<ClawhubCatalogSkill> {
    FEATURED_CLAWHUB_SKILLS
        .iter()
        .map(|(slug, name, summary)| ClawhubCatalogSkill {
            slug: slug.to_string(),
            display_name: name.to_string(),
            summary: summary.to_string(),
            latest_version: None,
            downloads: 0,
            installs_all_time: 0,
            stars: 0,
            updated_at: None,
            is_fallback: true,
        })
        .collect()
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ClawhubSkillDetails {
    pub slug: String,
    pub display_name: String,
    pub summary: String,
    pub latest_version: Option<String>,
    pub changelog: Option<String>,
    pub owner_handle: Option<String>,
    pub owner_display_name: Option<String>,
    pub downloads: u64,
    pub installs_all_time: u64,
    pub stars: u64,
    pub updated_at: Option<u64>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct OAuthKeyMeta {
    refresh_token: String,
    expires_at: u64,
    source: String, // "claude_code" or "openai_codex"
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct StoredAuth {
    version: u8,
    keys: HashMap<String, String>,
    active_provider: Option<String>,
    gateway_token: Option<String>,
    agent_settings: Option<StoredAgentSettings>,
    #[serde(default)]
    oauth_metadata: HashMap<String, OAuthKeyMeta>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(default)]
struct StoredAgentSettings {
    soul: String,
    heartbeat_every: String,
    heartbeat_tasks: Vec<String>,
    memory_enabled: bool,
    memory_long_term: bool,
    memory_sessions_enabled: bool,
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
    bridge_enabled: bool,
    bridge_tailnet_ip: String,
    bridge_port: u16,
    bridge_pairing_token: String,
    bridge_pairing_expires_at_ms: u64,
    bridge_device_id: String,
    bridge_device_name: String,
    bridge_device_public_key: String,
    bridge_last_seen_at_ms: u64,
    bridge_devices: Vec<BridgeDeviceRecord>,
}

impl Default for StoredAgentSettings {
    fn default() -> Self {
        Self {
            soul: String::new(),
            heartbeat_every: "30m".to_string(),
            heartbeat_tasks: Vec::new(),
            memory_enabled: true,
            memory_long_term: false,
            memory_sessions_enabled: true,
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
            identity_name: "Entropic".to_string(),
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
            telegram_dm_policy: "pairing".to_string(),
            telegram_group_policy: "allowlist".to_string(),
            telegram_config_writes: false,
            telegram_require_mention: true,
            telegram_reply_to_mode: "off".to_string(),
            telegram_link_preview: true,
            slack_enabled: false,
            slack_bot_token: String::new(),
            slack_app_token: String::new(),
            googlechat_enabled: false,
            googlechat_service_account: String::new(),
            googlechat_audience_type: "app-url".to_string(),
            googlechat_audience: String::new(),
            whatsapp_enabled: false,
            whatsapp_allow_from: String::new(),
            bridge_enabled: false,
            bridge_tailnet_ip: String::new(),
            bridge_port: 19789,
            bridge_pairing_token: String::new(),
            bridge_pairing_expires_at_ms: 0,
            bridge_device_id: String::new(),
            bridge_device_name: String::new(),
            bridge_device_public_key: String::new(),
            bridge_last_seen_at_ms: 0,
            bridge_devices: Vec::new(),
        }
    }
}

impl Default for StoredAuth {
    fn default() -> Self {
        Self {
            version: 1,
            keys: HashMap::new(),
            active_provider: None,
            gateway_token: None,
            agent_settings: None,
            oauth_metadata: HashMap::new(),
        }
    }
}

fn get_runtime(app: &AppHandle) -> Runtime {
    let resource_dir = app.path().resource_dir().unwrap_or_default();
    Runtime::new(resource_dir)
}

const OPENCLAW_CONTAINER: &str = "entropic-openclaw";
const LEGACY_OPENCLAW_CONTAINER: &str = "nova-openclaw";
const OPENCLAW_NETWORK: &str = "entropic-net";
const LEGACY_OPENCLAW_NETWORK: &str = "nova-net";
const OPENCLAW_DATA_VOLUME: &str = "entropic-openclaw-data";
const LEGACY_OPENCLAW_DATA_VOLUME: &str = "nova-openclaw-data";
const SCANNER_CONTAINER: &str = "entropic-skill-scanner";
const SCANNER_HOST_PORT: &str = "19791";
const ENTROPIC_GATEWAY_SCHEMA_VERSION: &str = "2026-02-13";
const OPENCLAW_STATE_ROOT: &str = "/home/node/.openclaw";
const WORKSPACE_ROOT: &str = "/data/workspace";
const SKILLS_ROOT: &str = "/data/skills";
const SKILL_MANIFESTS_ROOT: &str = "/data/skill-manifests";
const LEGACY_SKILLS_ROOTS: &[&str] = &[
    "/data/workspace/skills",
    "/home/node/.openclaw/workspace/skills",
];
const MANAGED_PLUGIN_IDS: &[&str] = &[
    "entropic-integrations",
    "nova-integrations",
    "entropic-x",
    "nova-x",
];
static GATEWAY_START_LOCK: OnceLock<AsyncMutex<()>> = OnceLock::new();
static APPLIED_AGENT_SETTINGS_FINGERPRINT: OnceLock<Mutex<Option<String>>> = OnceLock::new();

fn gateway_start_lock() -> &'static AsyncMutex<()> {
    GATEWAY_START_LOCK.get_or_init(|| AsyncMutex::new(()))
}

fn applied_agent_settings_fingerprint() -> &'static Mutex<Option<String>> {
    APPLIED_AGENT_SETTINGS_FINGERPRINT.get_or_init(|| Mutex::new(None))
}

fn named_gateway_container_exists(name: &str, running_only: bool) -> bool {
    let name_filter = format!("name={}", name);
    let mut args = vec!["ps"];
    if !running_only {
        args.push("-a");
    }
    args.extend(["-q", "-f", name_filter.as_str()]);
    if running_only {
        args.extend(["-f", "status=running"]);
    }
    let output = docker_command().args(args).output().ok();
    match output {
        Some(out) if out.status.success() => !out.stdout.is_empty(),
        _ => false,
    }
}

fn gateway_container_exists(running_only: bool) -> bool {
    [OPENCLAW_CONTAINER, LEGACY_OPENCLAW_CONTAINER]
        .into_iter()
        .any(|name| named_gateway_container_exists(name, running_only))
}

fn running_gateway_container_name() -> Option<&'static str> {
    if named_gateway_container_exists(OPENCLAW_CONTAINER, true) {
        Some(OPENCLAW_CONTAINER)
    } else if named_gateway_container_exists(LEGACY_OPENCLAW_CONTAINER, true) {
        Some(LEGACY_OPENCLAW_CONTAINER)
    } else {
        None
    }
}

fn existing_gateway_container_name() -> Option<&'static str> {
    if named_gateway_container_exists(OPENCLAW_CONTAINER, false) {
        Some(OPENCLAW_CONTAINER)
    } else if named_gateway_container_exists(LEGACY_OPENCLAW_CONTAINER, false) {
        Some(LEGACY_OPENCLAW_CONTAINER)
    } else {
        None
    }
}

fn cleanup_legacy_gateway_artifacts() {
    let check = docker_command()
        .args(["ps", "-aq", "-f", &format!("name={}", LEGACY_OPENCLAW_CONTAINER)])
        .output();
    if let Ok(out) = check {
        if !out.stdout.is_empty() {
            println!(
                "[Entropic] Removing legacy gateway container: {}",
                LEGACY_OPENCLAW_CONTAINER
            );
            let _ = docker_command()
                .args(["rm", "-f", LEGACY_OPENCLAW_CONTAINER])
                .output();
        }
    }

    let _ = docker_command()
        .args(["network", "rm", LEGACY_OPENCLAW_NETWORK])
        .output();
}

fn docker_volume_exists(name: &str) -> bool {
    docker_command()
        .args(["volume", "inspect", name])
        .output()
        .map(|out| out.status.success())
        .unwrap_or(false)
}

fn existing_openclaw_data_volume_name() -> Option<&'static str> {
    if docker_volume_exists(OPENCLAW_DATA_VOLUME) {
        Some(OPENCLAW_DATA_VOLUME)
    } else if docker_volume_exists(LEGACY_OPENCLAW_DATA_VOLUME) {
        Some(LEGACY_OPENCLAW_DATA_VOLUME)
    } else {
        None
    }
}

fn openclaw_data_volume_mount() -> String {
    let volume_name = if let Some(existing) = existing_openclaw_data_volume_name() {
        if existing == LEGACY_OPENCLAW_DATA_VOLUME {
            println!(
                "[Entropic] Reusing legacy gateway data volume: {}",
                LEGACY_OPENCLAW_DATA_VOLUME
            );
        }
        existing
    } else {
        OPENCLAW_DATA_VOLUME
    };
    format!("{}:/data", volume_name)
}

fn workspace_file(path: &str) -> String {
    let trimmed = path.trim_start_matches('/');
    if trimmed.is_empty() {
        WORKSPACE_ROOT.to_string()
    } else {
        format!("{}/{}", WORKSPACE_ROOT, trimmed)
    }
}

fn state_file(path: &str) -> String {
    let trimmed = path.trim_start_matches('/');
    if trimmed.is_empty() {
        OPENCLAW_STATE_ROOT.to_string()
    } else {
        format!("{}/{}", OPENCLAW_STATE_ROOT, trimmed)
    }
}

fn container_dir_exists(path: &str) -> Result<bool, String> {
    Ok(docker_command()
        .args(["exec", OPENCLAW_CONTAINER, "test", "-d", path])
        .output()
        .map_err(|e| format!("Failed to inspect container path: {}", e))?
        .status
        .success())
}

fn container_path_exists_checked(path: &str) -> Result<bool, String> {
    Ok(docker_command()
        .args(["exec", OPENCLAW_CONTAINER, "test", "-e", "--", path])
        .output()
        .map_err(|e| format!("Failed to inspect container path: {}", e))?
        .status
        .success())
}

fn resolve_skill_root_in_container(
    container: &str,
    root: &str,
    expected_id: Option<&str>,
) -> Result<Option<String>, String> {
    let normalized_root = root.trim_end_matches('/').to_string();
    if normalized_root.is_empty() {
        return Ok(None);
    }

    let direct_skill_md = format!("{}/SKILL.md", normalized_root);
    let has_direct = docker_command()
        .args(["exec", container, "test", "-f", "--", &direct_skill_md])
        .output()
        .map_err(|e| format!("Failed to inspect skill directory: {}", e))?
        .status
        .success();
    if has_direct {
        return Ok(Some(normalized_root));
    }

    let search_cmd = docker_command()
        .args([
            "exec",
            container,
            "find",
            &normalized_root,
            "-name",
            "SKILL.md",
            "-type",
            "f",
        ])
        .output()
        .map_err(|e| format!("Failed to locate skill metadata files: {}", e))?;
    if !search_cmd.status.success() {
        return Ok(None);
    }

    let mut candidates = Vec::<String>::new();
    for line in String::from_utf8_lossy(&search_cmd.stdout).lines() {
        let candidate = line.trim();
        if candidate.is_empty() {
            continue;
        }
        if !candidate.starts_with(&normalized_root) {
            continue;
        }
        if !candidate.ends_with("/SKILL.md") {
            continue;
        }
        let parent = candidate.trim_end_matches("/SKILL.md").to_string();
        if !parent.is_empty() {
            candidates.push(parent);
        }
    }

    if candidates.is_empty() {
        return Ok(None);
    }

    candidates.sort_by_key(|path| path.matches('/').count());
    candidates.dedup();

    if let Some(id) = expected_id {
        if let Some(path) = candidates
            .iter()
            .find(|path| path.ends_with(&format!("/{}", id)))
        {
            return Ok(Some(path.clone()));
        }
    }

    Ok(candidates.into_iter().next())
}

fn list_container_subdirs(path: &str) -> Result<Vec<String>, String> {
    if !container_dir_exists(path)? {
        return Ok(vec![]);
    }

    let listing = docker_exec_output(&["exec", OPENCLAW_CONTAINER, "ls", "-1", "--", path])?;
    let mut out = Vec::new();
    for line in listing.lines() {
        let id = line.trim();
        if !is_safe_component(id) {
            continue;
        }
        let full_path = format!("{}/{}", path.trim_end_matches('/'), id);
        if container_dir_exists(&full_path)? {
            out.push(id.to_string());
        }
    }
    Ok(out)
}

fn resolve_versioned_skill_dir(skill_id: &str) -> Result<Option<String>, String> {
    let skill_root = format!("{}/{}", SKILLS_ROOT, skill_id);
    if !container_dir_exists(&skill_root)? {
        return Ok(None);
    }

    let current = format!("{}/current", skill_root);
    if container_path_exists(&current) {
        if let Some(path) =
            resolve_skill_root_in_container(OPENCLAW_CONTAINER, &current, Some(skill_id))?
        {
            return Ok(Some(path));
        }
        return Ok(Some(current));
    }

    let mut versions = list_container_subdirs(&skill_root)?;
    if versions.is_empty() {
        return Ok(None);
    }
    versions.sort();
    let version = versions.pop().unwrap_or_else(|| "latest".to_string());
    let version_root = format!("{}/{}", skill_root, version);
    if let Some(path) =
        resolve_skill_root_in_container(OPENCLAW_CONTAINER, &version_root, Some(skill_id))?
    {
        return Ok(Some(path));
    }
    Ok(Some(version_root))
}

fn resolve_installed_skill_dir(skill_id: &str) -> Result<Option<String>, String> {
    if let Some(dir) = resolve_versioned_skill_dir(skill_id)? {
        return Ok(Some(dir));
    }

    for legacy_root in LEGACY_SKILLS_ROOTS {
        let legacy_path = format!("{}/{}", legacy_root.trim_end_matches('/'), skill_id);
        if container_dir_exists(&legacy_path)? {
            return Ok(Some(legacy_path));
        }
    }
    Ok(None)
}

fn collect_skill_ids() -> Result<Vec<String>, String> {
    let mut ids = list_container_subdirs(SKILLS_ROOT)?;
    for legacy_root in LEGACY_SKILLS_ROOTS {
        ids.extend(list_container_subdirs(legacy_root)?);
    }
    ids.sort();
    ids.dedup();
    Ok(ids)
}

fn collect_workspace_skill_paths() -> Result<Vec<(String, String)>, String> {
    let mut out = Vec::new();
    for skill_id in collect_skill_ids()? {
        if MANAGED_PLUGIN_IDS.contains(&skill_id.as_str()) {
            continue;
        }

        if let Some(path) = resolve_installed_skill_dir(&skill_id)? {
            out.push((skill_id, path));
        }
    }
    Ok(out)
}

fn sanitize_skill_version_component(version: &str) -> String {
    let trimmed = version.trim();
    if trimmed.is_empty() {
        return "latest".to_string();
    }
    let mut out = String::with_capacity(trimmed.len());
    for ch in trimmed.chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.' {
            out.push(ch);
        } else {
            out.push('_');
        }
    }
    if out.is_empty() {
        "latest".to_string()
    } else {
        out
    }
}

fn clawhub_latest_version(slug: &str) -> Result<Option<String>, String> {
    let output = clawhub_exec_with_retry(&["inspect", slug, "--json"], 2)?;
    if !output.status.success() {
        return Err(command_output_error(&output));
    }
    let raw = String::from_utf8_lossy(&output.stdout).to_string();
    let payload: serde_json::Value = parse_clawhub_json(&raw)?;
    let version = payload
        .get("latestVersion")
        .and_then(|v| v.get("version"))
        .and_then(|v| v.as_str())
        .or_else(|| {
            payload
                .get("skill")
                .and_then(|v| v.get("tags"))
                .and_then(|v| v.get("latest"))
                .and_then(|v| v.as_str())
        })
        .map(sanitize_skill_version_component);
    Ok(version)
}

/// Best-effort heuristic that infers scope flags from SKILL.md content for
/// manifest metadata. Uses substring matching so it can produce false positives
/// (e.g. docs mentioning URLs) and false negatives (skills that access the
/// network without documenting it). Not a security gate — downstream consumers
/// should check the `"heuristic"` field to distinguish authoritative vs.
/// inferred scopes.
fn infer_skill_scope_flags(skill_md: &str) -> serde_json::Value {
    let lower = skill_md.to_lowercase();
    let needs_network = lower.contains("http://")
        || lower.contains("https://")
        || lower.contains(" api ")
        || lower.contains("fetch(")
        || lower.contains("web search")
        || lower.contains("web-search");
    let needs_browser =
        lower.contains("browser") || lower.contains("playwright") || lower.contains("chromium");
    serde_json::json!({
        "filesystem": true,
        "network": needs_network,
        "browser": needs_browser,
        "heuristic": true
    })
}

fn compute_skill_tree_hash(path: &str) -> Option<String> {
    let quoted = sh_single_quote(path);
    let script = format!(
        "set -e; cd {path}; if command -v sha256sum >/dev/null 2>&1; then find . -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | awk '{{print $1}}'; elif command -v shasum >/dev/null 2>&1; then find . -type f -print0 | sort -z | xargs -0 shasum -a 256 | shasum -a 256 | awk '{{print $1}}'; else exit 1; fi",
        path = quoted
    );
    let output = docker_command()
        .args(["exec", OPENCLAW_CONTAINER, "sh", "-c", &script])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let hash = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if hash.is_empty() {
        None
    } else {
        Some(hash)
    }
}

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
            let start = docker_command().args(["start", SCANNER_CONTAINER]).output();
            if let Ok(s) = &start {
                if s.status.success() {
                    return;
                }
            }
            // Start failed, remove and recreate
            let _ = docker_command()
                .args(["rm", "-f", SCANNER_CONTAINER])
                .output();
        }
    }

    // Ensure scanner image is available (bundled tar in releases).
    if let Err(err) = ensure_scanner_image() {
        eprintln!("[scanner] {}", err);
        return;
    }

    // Create and start scanner container
    let run = docker_command()
        .args([
            "run",
            "-d",
            "--name",
            SCANNER_CONTAINER,
            "--user",
            "1000:1000",
            "--cap-drop=ALL",
            "--security-opt",
            "no-new-privileges",
            "--read-only",
            "--tmpfs",
            "/tmp:rw,noexec,nosuid,nodev,size=200m",
            "--volumes-from",
            &format!("{}:ro", OPENCLAW_CONTAINER),
            "--network",
            OPENCLAW_NETWORK,
            "-p",
            &format!("127.0.0.1:{}:8000", SCANNER_HOST_PORT),
            "entropic-skill-scanner:latest",
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

fn start_scanner_sidecar_background() {
    tauri::async_runtime::spawn(async {
        let _ = tokio::task::spawn_blocking(start_scanner_sidecar).await;
    });
}

fn stop_scanner_sidecar() {
    let _ = docker_command().args(["stop", SCANNER_CONTAINER]).output();
}

/// Preserve Entropic containers on app exit; keep state for faster resume.
/// Called from the Tauri RunEvent::Exit handler.
pub fn cleanup_on_exit() {
    println!("[Entropic] App exit requested — preserving running Entropic containers.");
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

fn command_output_error(output: &Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !stderr.is_empty() && !stdout.is_empty() {
        format!("{}\n{}", stderr, stdout)
    } else if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else {
        "Unknown command failure".to_string()
    }
}

fn clawhub_exec(args: &[&str]) -> Result<Output, String> {
    let mut cmd = docker_command();
    cmd.args([
        "exec",
        OPENCLAW_CONTAINER,
        "env",
        "HOME=/data",
        "TMPDIR=/data/tmp",
        "XDG_CONFIG_HOME=/data/.config",
        "XDG_CACHE_HOME=/data/.cache",
        "npm_config_cache=/data/.npm",
        "PLAYWRIGHT_BROWSERS_PATH=/data/playwright",
        "npx",
        "-y",
        "clawhub@0.7.0",
    ]);
    cmd.args(args);
    cmd.output()
        .map_err(|e| format!("Failed to run ClawHub command: {}", e))
}

/// Run a ClawHub command with automatic retry on rate-limit errors.
/// Retries up to `max_retries` times with exponential backoff (2s, 4s, 8s, …).
fn clawhub_exec_with_retry(args: &[&str], max_retries: u32) -> Result<Output, String> {
    let mut attempts = 0u32;
    loop {
        let output = clawhub_exec(args)?;
        let combined = format!(
            "{} {}",
            String::from_utf8_lossy(&output.stderr),
            String::from_utf8_lossy(&output.stdout)
        )
        .to_lowercase();
        let is_rate_limited = !output.status.success() && combined.contains("rate limit");
        if !is_rate_limited || attempts >= max_retries {
            return Ok(output);
        }
        attempts += 1;
        let delay_secs = 2u64.pow(attempts); // 2, 4, 8 …
        eprintln!(
            "[Entropic] ClawHub rate-limited (attempt {}/{}), retrying in {}s…",
            attempts,
            max_retries + 1,
            delay_secs
        );
        std::thread::sleep(std::time::Duration::from_secs(delay_secs));
    }
}

fn clawhub_exec_output(args: &[&str]) -> Result<String, String> {
    let output = clawhub_exec(args)?;
    if !output.status.success() {
        return Err(command_output_error(&output));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn parse_clawhub_json<T: DeserializeOwned>(output: &str) -> Result<T, String> {
    let trimmed = output.trim();
    if trimmed.is_empty() {
        return Err("Empty ClawHub response".to_string());
    }

    if let Ok(parsed) = serde_json::from_str::<T>(trimmed) {
        return Ok(parsed);
    }

    let start = trimmed
        .find('{')
        .or_else(|| trimmed.find('['))
        .ok_or_else(|| "Failed to locate JSON payload in ClawHub response".to_string())?;
    let open = trimmed
        .as_bytes()
        .get(start)
        .copied()
        .ok_or_else(|| "Failed to parse ClawHub response".to_string())?;
    let close = if open == b'{' { '}' } else { ']' };
    let end = trimmed
        .rfind(close)
        .ok_or_else(|| "Failed to locate end of JSON payload in ClawHub response".to_string())?;
    if end < start {
        return Err("Invalid JSON payload boundaries in ClawHub response".to_string());
    }

    let payload = &trimmed[start..=end];
    serde_json::from_str::<T>(payload)
        .map_err(|e| format!("Failed to parse ClawHub JSON payload: {}", e))
}

fn scanner_running() -> Result<bool, String> {
    let check = docker_command()
        .args([
            "ps",
            "-q",
            "-f",
            &format!("name={}", SCANNER_CONTAINER),
            "-f",
            "status=running",
        ])
        .output()
        .map_err(|e| format!("Failed to check scanner: {}", e))?;
    Ok(!check.stdout.is_empty())
}

fn is_safe_component(value: &str) -> bool {
    let trimmed = value.trim();
    !trimmed.is_empty()
        && trimmed
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.')
}

fn is_safe_slug(value: &str) -> bool {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return false;
    }
    for part in trimmed.split('/') {
        if !is_safe_component(part) {
            return false;
        }
    }
    true
}

fn clone_dir_from_openclaw_to_scanner(source_dir: &str, scanner_dir: &str) -> Result<(), String> {
    docker_exec_output(&["exec", SCANNER_CONTAINER, "rm", "-rf", "--", scanner_dir])?;
    docker_exec_output(&["exec", SCANNER_CONTAINER, "mkdir", "-p", "--", scanner_dir])?;

    let archive = docker_command()
        .args([
            "exec",
            OPENCLAW_CONTAINER,
            "tar",
            "-C",
            source_dir,
            "-cf",
            "-",
            ".",
        ])
        .output()
        .map_err(|e| format!("Failed to stream source directory: {}", e))?;
    if !archive.status.success() {
        let stderr = String::from_utf8_lossy(&archive.stderr);
        return Err(format!("Failed to archive source directory: {}", stderr));
    }

    let mut child = docker_command()
        .args([
            "exec",
            "-i",
            SCANNER_CONTAINER,
            "tar",
            "-C",
            scanner_dir,
            "-xf",
            "-",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to copy directory to scanner: {}", e))?;

    if let Some(stdin) = child.stdin.as_mut() {
        use std::io::Write;
        stdin
            .write_all(&archive.stdout)
            .map_err(|e| format!("Failed to copy directory to scanner: {}", e))?;
    }

    let output = child
        .wait_with_output()
        .map_err(|e| format!("Failed to finalize scanner copy: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Failed to unpack scanner copy: {}", stderr));
    }

    Ok(())
}

fn parse_scan_findings(scan_response: &serde_json::Value) -> Vec<ScanFinding> {
    scan_response
        .get("findings")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .map(|f| ScanFinding {
                    analyzer: f
                        .get("analyzer")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string()),
                    category: f
                        .get("category")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string()),
                    severity: f
                        .get("severity")
                        .and_then(|v| v.as_str())
                        .unwrap_or("UNKNOWN")
                        .to_string(),
                    title: f
                        .get("title")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    description: f
                        .get("description")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    file_path: f
                        .get("file_path")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string()),
                    line_number: f
                        .get("line_number")
                        .and_then(|v| v.as_u64())
                        .map(|n| n as u32),
                    snippet: f
                        .get("snippet")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string()),
                    remediation: f
                        .get("remediation")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string()),
                })
                .collect()
        })
        .unwrap_or_default()
}

fn parse_skill_frontmatter(raw: &str) -> (Option<String>, Option<String>) {
    let mut lines = raw.lines();
    if lines.next().map(|v| v.trim()) != Some("---") {
        return (None, None);
    }
    let mut name: Option<String> = None;
    let mut description: Option<String> = None;
    for line in lines {
        let trimmed = line.trim();
        if trimmed == "---" {
            break;
        }
        if let Some(rest) = trimmed.strip_prefix("name:") {
            let value = rest.trim().trim_matches('"').trim_matches('\'').to_string();
            if !value.is_empty() {
                name = Some(value);
            }
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix("description:") {
            let value = rest.trim().trim_matches('"').trim_matches('\'').to_string();
            if !value.is_empty() {
                description = Some(value);
            }
        }
    }
    (name, description)
}

fn parse_skill_scan_from_manifest(raw: &str) -> Option<(Option<String>, PluginScanResult, u64)> {
    let value: serde_json::Value = serde_json::from_str(raw).ok()?;
    let scan = value.get("scan")?.as_object()?;
    let scan_id = scan
        .get("scan_id")
        .and_then(|v| v.as_str())
        .map(|v| v.to_string());
    let scan_id_for_result = scan_id.clone();
    let is_safe = scan
        .get("is_safe")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let max_severity = scan
        .get("max_severity")
        .and_then(|v| v.as_str())
        .unwrap_or("UNKNOWN")
        .to_string();
    let findings_count = scan
        .get("findings_count")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let installed_at = value
        .get("installed_at_ms")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);

    Some((
        scan_id,
        PluginScanResult {
            scan_id: scan_id_for_result,
            is_safe,
            max_severity,
            findings_count: findings_count.min(u32::MAX as u64) as u32,
            findings: vec![],
            scanner_available: true,
        },
        installed_at,
    ))
}

fn read_skill_scan_from_manifest(skill_id: &str) -> Option<PluginScanResult> {
    let manifest_root = format!("{}/{}/", SKILL_MANIFESTS_ROOT, skill_id);
    if !container_dir_exists(&manifest_root).ok()? {
        return None;
    }

    let listing =
        docker_exec_output(&["exec", OPENCLAW_CONTAINER, "ls", "-1", "--", &manifest_root]).ok()?;

    let mut best: Option<(u64, PluginScanResult)> = None;
    for line in listing.lines() {
        let file = line.trim();
        if !file.ends_with(".json") {
            continue;
        }
        if !is_safe_component(file.trim_end_matches(".json")) {
            continue;
        }
        let path = format!("{}{}", manifest_root, file);
        let raw = match read_container_file(&path) {
            Some(value) => value,
            None => continue,
        };
        let (_, scan, installed_at) = match parse_skill_scan_from_manifest(&raw) {
            Some(value) => value,
            None => continue,
        };
        match best {
            Some((seen, _)) if seen >= installed_at => {}
            _ => best = Some((installed_at, scan)),
        }
    }

    best.map(|(_, scan)| scan)
}

fn resolve_scannable_skill_root(scanner_root: &str) -> Result<String, String> {
    let direct_skill_md = format!("{}/SKILL.md", scanner_root);
    let has_direct = docker_command()
        .args([
            "exec",
            SCANNER_CONTAINER,
            "test",
            "-f",
            "--",
            &direct_skill_md,
        ])
        .output()
        .map_err(|e| format!("Failed to inspect skill directory: {}", e))?
        .status
        .success();
    if has_direct {
        return Ok(scanner_root.to_string());
    }

    let search_cmd = docker_command()
        .args([
            "exec",
            SCANNER_CONTAINER,
            "find",
            scanner_root,
            "-name",
            "SKILL.md",
            "-type",
            "f",
        ])
        .output()
        .map_err(|e| format!("Failed to locate skill metadata files: {}", e))?;
    if !search_cmd.status.success() {
        return Err(format!(
            "Failed to locate SKILL.md in scanner directory {}",
            scanner_root
        ));
    }

    let mut candidates = Vec::<String>::new();
    for line in String::from_utf8_lossy(&search_cmd.stdout).lines() {
        let candidate = line.trim();
        if candidate.is_empty() {
            continue;
        }
        if !candidate.starts_with(scanner_root) {
            continue;
        }
        if !candidate.ends_with("/SKILL.md") {
            continue;
        }
        let parent = candidate.trim_end_matches("/SKILL.md").to_string();
        if !parent.is_empty() {
            candidates.push(parent);
        }
    }

    if candidates.is_empty() {
        return Err(format!(
            "SKILL.md not found in scanner directory {}",
            scanner_root
        ));
    }

    candidates.sort_by_key(|path| path.matches('/').count());
    Ok(candidates[0].clone())
}

async fn scan_directory_with_scanner(scanner_dir: &str) -> Result<PluginScanResult, String> {
    let scan_target = resolve_scannable_skill_root(scanner_dir)?;
    let body = serde_json::json!({
        "skill_directory": scan_target,
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
        format!("http://127.0.0.1:{}/scan", SCANNER_HOST_PORT)
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
        let detail = serde_json::from_str::<serde_json::Value>(&text)
            .ok()
            .and_then(|value| {
                value
                    .get("detail")
                    .and_then(|v| v.as_str())
                    .map(|v| v.to_string())
            })
            .unwrap_or_else(|| text);
        return Err(format!(
            "Scanner returned {} for {}: {}",
            status, scanner_dir, detail
        ));
    }

    let scan_response: serde_json::Value = res
        .json()
        .await
        .map_err(|e| format!("Failed to parse scan response: {}", e))?;

    let findings = parse_scan_findings(&scan_response);

    Ok(PluginScanResult {
        scan_id: scan_response
            .get("scan_id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        is_safe: scan_response
            .get("is_safe")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
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

fn write_container_file_if_missing(path: &str, content: &str) -> Result<(), String> {
    if let Some(existing) = read_container_file(path) {
        if !existing.trim().is_empty() {
            return Ok(());
        }
    }
    write_container_file(path, content)
}

struct ContainerFileWrite<'a> {
    path: &'a str,
    content: &'a str,
    only_if_missing: bool,
}

fn sh_single_quote(input: &str) -> String {
    if input.is_empty() {
        return "''".to_string();
    }
    format!("'{}'", input.replace('\'', "'\"'\"'"))
}

fn write_container_files_batch(files: &[ContainerFileWrite<'_>]) -> Result<(), String> {
    if files.is_empty() {
        return Ok(());
    }

    let mut script = String::from("set -eu\n");
    for file in files {
        let dir = Path::new(file.path)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| "/".to_string());
        let encoded = STANDARD.encode(file.content.as_bytes());
        let dir_q = sh_single_quote(&dir);
        let path_q = sh_single_quote(file.path);
        let encoded_q = sh_single_quote(&encoded);

        script.push_str(&format!("mkdir -p -- {}\n", dir_q));
        if file.only_if_missing {
            script.push_str(&format!(
                "if [ ! -s {} ]; then printf %s {} | base64 -d > {}; fi\n",
                path_q, encoded_q, path_q
            ));
        } else {
            script.push_str(&format!(
                "printf %s {} | base64 -d > {}\n",
                encoded_q, path_q
            ));
        }
    }

    let mut child = docker_command()
        .args(["exec", "-i", OPENCLAW_CONTAINER, "sh", "-se"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to batch write files: {}", e))?;

    if let Some(stdin) = child.stdin.as_mut() {
        use std::io::Write;
        stdin
            .write_all(script.as_bytes())
            .map_err(|e| format!("Failed to stream file batch script: {}", e))?;
    }

    let output = child
        .wait_with_output()
        .map_err(|e| format!("Failed to finalize file batch write: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "Failed to write files in container: {}",
            stderr.trim()
        ));
    }
    Ok(())
}

fn current_local_date() -> String {
    let days_since_epoch = match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(elapsed) => elapsed.as_secs() / 86_400,
        Err(_) => return "unknown-date".to_string(),
    };

    let mut year: i32 = 1970;
    let mut remaining_days = days_since_epoch as i64;

    fn leap_year(y: i32) -> bool {
        (y % 4 == 0 && y % 100 != 0) || (y % 400 == 0)
    }

    fn days_in_year(y: i32) -> i64 {
        if leap_year(y) {
            366
        } else {
            365
        }
    }

    while remaining_days >= days_in_year(year) {
        remaining_days -= days_in_year(year);
        year += 1;
    }

    let month_lengths = [31u32, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let mut month = 1u32;
    for (idx, days) in month_lengths.iter().enumerate() {
        let mut day_count = *days as i64;
        if idx == 1 && leap_year(year) {
            day_count += 1;
        }
        if remaining_days >= day_count {
            remaining_days -= day_count;
            month += 1;
        } else {
            break;
        }
    }

    let day = remaining_days + 1;
    format!("{:04}-{:02}-{:02}", year, month, day)
}

fn read_openclaw_config() -> serde_json::Value {
    let mut cfg = if let Some(raw) = read_container_file(&state_file("openclaw.json")) {
        match serde_json::from_str(&raw) {
            Ok(val) => val,
            Err(_) => serde_json::json!({}),
        }
    } else {
        serde_json::json!({})
    };

    normalize_openclaw_config(&mut cfg);
    cfg
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
        .args([
            "exec",
            OPENCLAW_CONTAINER,
            "sh",
            "-c",
            &format!("test -d \"{}\"", path),
        ])
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn container_plugin_exists(plugin_id: &str) -> bool {
    if container_path_exists(&format!("/app/extensions/{}", plugin_id)) {
        return true;
    }
    if let Some(skills_root) = read_container_env("ENTROPIC_SKILLS_PATH") {
        let base = format!("{}/{}", skills_root.trim_end_matches('/'), plugin_id);
        let current = format!("{}/current", base);
        if container_path_exists(&current) || container_path_exists(&base) {
            return true;
        }
    }
    false
}

fn resolve_managed_plugin_id(primary: &'static str, legacy: &'static str) -> Option<&'static str> {
    if container_plugin_exists(primary) {
        Some(primary)
    } else if container_plugin_exists(legacy) {
        Some(legacy)
    } else {
        None
    }
}

fn write_openclaw_config(value: &serde_json::Value) -> Result<(), String> {
    let payload = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    write_container_file(&state_file("openclaw.json"), &payload)
}

fn set_openclaw_config_value(cfg: &mut serde_json::Value, path: &[&str], value: serde_json::Value) {
    if path.is_empty() {
        return;
    }

    if !cfg.is_object() {
        *cfg = serde_json::json!({});
    }

    let mut current = cfg;
    for (index, key) in path.iter().enumerate() {
        let is_last = index + 1 == path.len();

        if is_last {
            if let Some(obj) = current.as_object_mut() {
                obj.insert((*key).to_string(), value);
            } else {
                *current = serde_json::json!({});
                current
                    .as_object_mut()
                    .expect("failed to initialize safe config path")
                    .insert((*key).to_string(), value);
            }
            return;
        }

        let next = {
            let obj = current
                .as_object_mut()
                .expect("config root must be an object when setting nested path");
            obj.entry((*key).to_string())
                .or_insert_with(|| serde_json::json!({}))
        };

        if !next.is_object() {
            *next = serde_json::json!({});
        }
        current = next;
    }
}

fn remove_openclaw_config_value(cfg: &mut serde_json::Value, path: &[&str]) {
    if path.is_empty() {
        return;
    }

    let mut current = cfg;
    for key in path.iter().take(path.len() - 1) {
        let next = match current.as_object_mut() {
            Some(obj) => obj.get_mut(*key),
            None => None,
        };
        match next {
            Some(value) => current = value,
            None => return,
        }
    }

    if let Some(last_parent) = current.as_object_mut() {
        last_parent.remove(path[path.len() - 1]);
    }
}

fn normalize_telegram_allow_from_for_dm_policy(cfg: &mut serde_json::Value, dm_policy: &str) {
    let existing_allow_from: Vec<String> = cfg
        .get("channels")
        .and_then(|v| v.get("telegram"))
        .and_then(|v| v.get("allowFrom"))
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str())
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .map(ToOwned::to_owned)
                .collect()
        })
        .unwrap_or_default();

    if dm_policy == "open" {
        let mut allow_from = existing_allow_from;
        if !allow_from.iter().any(|entry| entry == "*") {
            allow_from.push("*".to_string());
        }
        allow_from.sort();
        allow_from.dedup();
        set_openclaw_config_value(
            cfg,
            &["channels", "telegram", "allowFrom"],
            serde_json::json!(allow_from),
        );
        return;
    }

    let mut preserve = existing_allow_from
        .into_iter()
        .filter(|entry| entry != "*")
        .collect::<Vec<String>>();
    preserve.sort();
    preserve.dedup();

    if preserve.is_empty() {
        remove_openclaw_config_value(cfg, &["channels", "telegram", "allowFrom"]);
    } else {
        set_openclaw_config_value(
            cfg,
            &["channels", "telegram", "allowFrom"],
            serde_json::json!(preserve),
        );
    }
}

fn apply_default_qmd_memory_config(
    cfg: &mut serde_json::Value,
    slot: &str,
    sessions_enabled: bool,
) {
    if !cfg.is_object() {
        *cfg = serde_json::json!({});
    }
    let cfg_obj = cfg.as_object_mut().expect("config root must be an object");
    let memory_enabled = slot != "none";

    // DISABLED: QMD memory config not supported by current runtime
    // The top-level "memory" key causes validation errors in openclaw.json
    // TODO: Re-enable when runtime supports QMD
    /*
    let memory_backend = cfg_obj
        .get("memory")
        .and_then(|memory| memory.get("backend"))
        .and_then(|backend| backend.as_str());

    let using_qmd = memory_enabled && !matches!(memory_backend, Some("builtin"));

    if using_qmd {
        let memory = ensure_object_entry(cfg_obj, "memory");

        memory.insert("backend".to_string(), serde_json::json!("qmd"));

        if !memory.contains_key("citations") {
            memory.insert("citations".to_string(), serde_json::json!("auto"));
        }

        let qmd = ensure_object_entry(memory, "qmd");

        if qmd.get("command").and_then(|v| v.as_str()) == Some("/data/qmd-wrapper")
            || !qmd.contains_key("command")
        {
            // `qmd` is now the native OpenClaw-backed command; this avoids
            // the previous wrapper path, but still requires the qmd runtime deps
            // from the container image (including the tsx resolver shim).
            qmd.insert("command".to_string(), serde_json::json!("qmd"));
        }

        if !qmd.contains_key("includeDefaultMemory") {
            qmd.insert("includeDefaultMemory".to_string(), serde_json::json!(true));
        }

        let sessions = ensure_object_entry(qmd, "sessions");
        sessions.insert("enabled".to_string(), serde_json::json!(sessions_enabled));

        let update = ensure_object_entry(qmd, "update");
        if !update.contains_key("interval") {
            update.insert("interval".to_string(), serde_json::json!("5m"));
        }
        if !update.contains_key("debounceMs") {
            update.insert("debounceMs".to_string(), serde_json::json!(15_000));
        }
        if !update.contains_key("waitForBootSync") {
            update.insert("waitForBootSync".to_string(), serde_json::json!(false));
        }

        let limits = ensure_object_entry(qmd, "limits");
        if !limits.contains_key("maxResults") {
            limits.insert("maxResults".to_string(), serde_json::json!(6));
        }
        if !limits.contains_key("maxSnippetChars") {
            limits.insert("maxSnippetChars".to_string(), serde_json::json!(700));
        }
        if !limits.contains_key("maxInjectedChars") {
            limits.insert("maxInjectedChars".to_string(), serde_json::json!(700));
        }
        if !limits.contains_key("timeoutMs") {
            limits.insert("timeoutMs".to_string(), serde_json::json!(4000));
        }
    } else if let Some(memory) = cfg_obj
        .get_mut("memory")
        .and_then(|memory| memory.as_object_mut())
    {
        if let Some(qmd) = memory.get_mut("qmd").and_then(|qmd| qmd.as_object_mut()) {
            if qmd.get("command").and_then(|value| value.as_str()) == Some("/data/qmd-wrapper") {
                qmd.remove("command");
            }
        }
    }
    */

    // Remove any existing "memory" key to prevent validation errors
    cfg_obj.remove("memory");

    // Configure agents.defaults.memorySearch (this IS supported by current runtime)
    let agents = ensure_object_entry(cfg_obj, "agents");
    let defaults = ensure_object_entry(agents, "defaults");
    let memory_search = defaults
        .entry("memorySearch".to_string())
        .or_insert_with(|| serde_json::json!({"enabled": memory_enabled}));

    if !memory_search.is_object() {
        *memory_search = serde_json::json!({"enabled": memory_enabled});
    }

    let memory_search_obj = memory_search
        .as_object_mut()
        .expect("memorySearch must be an object");

    memory_search_obj.insert("enabled".to_string(), serde_json::json!(memory_enabled));

    // Set memory sources (since QMD is disabled, always use builtin memory)
    if !memory_search_obj.contains_key("sources") {
        if sessions_enabled {
            memory_search_obj.insert(
                "sources".to_string(),
                serde_json::json!(["memory", "sessions"]),
            );
        } else {
            memory_search_obj.insert("sources".to_string(), serde_json::json!(["memory"]));
        }
    } else if let Some(sources) = memory_search_obj
        .get_mut("sources")
        .and_then(|v| v.as_array_mut())
    {
        if !sources.iter().any(|v| v.as_str() == Some("memory")) {
            sources.push(serde_json::json!("memory"));
        }
        if sessions_enabled && !sources.iter().any(|v| v.as_str() == Some("sessions")) {
            sources.push(serde_json::json!("sessions"));
        }
    }

    if sessions_enabled {
        let experimental = ensure_object_entry(memory_search_obj, "experimental");
        if !experimental.contains_key("sessionMemory") {
            experimental.insert("sessionMemory".to_string(), serde_json::json!(true));
        }
    }
}

fn append_entropic_skills_mount(docker_args: &mut Vec<String>) {
    let path = std::env::var("ENTROPIC_SKILLS_PATH").ok().and_then(|p| {
        let trimmed = p.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    });

    if let Some(host_path) = path {
        println!("[Entropic] Mounting entropic-skills from: {}", host_path);
        docker_args.push("-v".to_string());
        docker_args.push(format!("{}:/data/entropic-skills:ro", host_path));
        docker_args.push("-e".to_string());
        docker_args.push("ENTROPIC_SKILLS_PATH=/data/entropic-skills".to_string());
    }
}

async fn call_whatsapp_qr_endpoint(
    action: &str,
    force: bool,
    token: &str,
) -> Result<WhatsAppLoginState, String> {
    let base = if std::path::Path::new("/.dockerenv").exists() {
        format!("http://{}:18789", OPENCLAW_CONTAINER)
    } else {
        "http://127.0.0.1:19789".to_string()
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
        .bearer_auth(token)
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
    eprintln!(
        "[WA-DEBUG] [{:.1}s] Checking docker accessibility...",
        start.elapsed().as_secs_f64()
    );
    let docker_check = docker_command().args(["--version"]).output();
    match &docker_check {
        Ok(out) => eprintln!(
            "[WA-DEBUG] [{:.1}s] Docker found: {}",
            start.elapsed().as_secs_f64(),
            String::from_utf8_lossy(&out.stdout).trim()
        ),
        Err(e) => eprintln!(
            "[WA-DEBUG] [{:.1}s] Docker NOT found: {}",
            start.elapsed().as_secs_f64(),
            e
        ),
    }

    eprintln!(
        "[WA-DEBUG] [{:.1}s] About to spawn_blocking for docker exec...",
        start.elapsed().as_secs_f64()
    );
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

    eprintln!(
        "[WA-DEBUG] [{:.1}s] Docker exec completed",
        start.elapsed().as_secs_f64()
    );

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
                eprintln!(
                    "[WA-DEBUG] Successfully parsed JSON, total time: {:?}",
                    start.elapsed()
                );
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
    let mut manifests_by_id: HashMap<String, serde_json::Value> = HashMap::new();

    let add_manifest = |path: &str, bucket: &mut HashMap<String, serde_json::Value>| {
        if let Some(raw) = read_container_file(path) {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) {
                let id = value
                    .get("id")
                    .and_then(|value| value.as_str())
                    .unwrap_or("")
                    .trim();
                if !id.is_empty() && !bucket.contains_key(id) {
                    bucket.insert(id.to_string(), value);
                }
            }
        }
    };

    let list = docker_exec_output(&[
        "exec",
        OPENCLAW_CONTAINER,
        "sh",
        "-c",
        "ls -1 /app/extensions 2>/dev/null || true",
    ])?;
    for line in list.lines() {
        let dir = line.trim();
        if dir.is_empty() {
            continue;
        }
        let path = format!("/app/extensions/{}/openclaw.plugin.json", dir);
        add_manifest(&path, &mut manifests_by_id);
    }

    if let Some(skills_root) = read_container_env("ENTROPIC_SKILLS_PATH") {
        let normalized_root = skills_root.trim_end_matches('/');
        for skill_id in collect_skill_ids()? {
            let candidate = resolve_installed_skill_dir(&skill_id)?;
            let skill_dir = if let Some(path) = candidate {
                if path.starts_with(normalized_root) {
                    Some(path)
                } else {
                    let fallback = format!("{}/{}", normalized_root, skill_id);
                    if container_dir_exists(&fallback)? {
                        Some(fallback)
                    } else {
                        None
                    }
                }
            } else {
                let fallback = format!("{}/{}", normalized_root, skill_id);
                if container_dir_exists(&fallback)? {
                    Some(fallback)
                } else {
                    None
                }
            };

            if let Some(path) = skill_dir {
                add_manifest(
                    &format!("{}/openclaw.plugin.json", path),
                    &mut manifests_by_id,
                );
            }
        }
    }

    Ok(manifests_by_id.into_values().collect())
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
    let installed_skill_paths = collect_workspace_skill_paths().unwrap_or_default();
    let installed_workspace_skill_ids: Vec<String> = installed_skill_paths
        .iter()
        .map(|(id, _)| id.to_string())
        .collect();
    let installed_workspace_skill_paths: Vec<String> = installed_skill_paths
        .iter()
        .map(|(_, path)| path.to_string())
        .collect();
    let proxy_mode = read_container_env("ENTROPIC_PROXY_MODE").is_some();
    let base_url = read_container_env("ENTROPIC_PROXY_BASE_URL");
    let model = read_container_env("OPENCLAW_MODEL");
    let image_model = read_container_env("OPENCLAW_IMAGE_MODEL");
    let web_base_url = read_container_env("ENTROPIC_WEB_BASE_URL");
    let container_id = container_instance_id();
    let openai_key_for_lancedb = {
        let keys = state.api_keys.lock().map_err(|e| e.to_string())?;
        keys.get("openai").cloned()
    };

    let mut hb_body = String::from("# HEARTBEAT.md\n\n");
    if settings.heartbeat_tasks.is_empty() {
        hb_body.push_str(
            "# Keep this file empty (or with only comments) to skip heartbeat API calls.\n",
        );
    } else {
        for task in &settings.heartbeat_tasks {
            if !task.trim().is_empty() {
                hb_body.push_str(&format!("- {}\n", task.trim()));
            }
        }
    }
    let mut tools_body = String::from("# TOOLS.md - Local Notes\n\n## Capabilities\n");
    for cap in &settings.capabilities {
        let mark = if cap.enabled { "x" } else { " " };
        tools_body.push_str(&format!("- [{}] {}\n", mark, cap.label));
    }

    let mut id_body = String::from("# IDENTITY.md - Who Am I?\n\n");
    id_body.push_str(&format!("- **Name:** {}\n", settings.identity_name.trim()));
    id_body.push_str("- **Creature:**\n- **Vibe:**\n- **Emoji:**\n");
    if let Some(url) = &settings.identity_avatar {
        id_body.push_str(&format!("- **Avatar:** {}\n", url));
    } else {
        id_body.push_str("- **Avatar:**\n");
    }

    let memory_bootstrap = r#"# MEMORY.md - Long-Term Workspace Memory

This file is the high-signal memory for this workspace.
Use it for durable decisions, preferences, and facts that should persist across sessions.

## Principles

- Keep this file curated and concise.
- Prefer short, durable notes over transient logs.
- Move recurring context into this file as it becomes stable.
"#;

    let today = current_local_date();
    let daily_path = workspace_file(&format!("memory/{}.md", today));
    let daily_note = format!(
        "# {date}\n\n- [ ] Add raw notes from this session here while they are still fresh.\n",
        date = today
    );
    let heartbeat_path = workspace_file("HEARTBEAT.md");
    let tools_path = workspace_file("TOOLS.md");
    let identity_path = workspace_file("IDENTITY.md");
    let memory_path = workspace_file("MEMORY.md");
    let soul_path = workspace_file("SOUL.md");
    let thinking_level_env = read_container_env("ENTROPIC_THINKING_LEVEL");
    let fingerprint_payload = serde_json::json!({
        "container_id": container_id,
        "proxy_mode": proxy_mode,
        "base_url": &base_url,
        "model": &model,
        "image_model": &image_model,
        "web_base_url": &web_base_url,
        "openai_key_for_lancedb": &openai_key_for_lancedb,
        "thinking_level": &thinking_level_env,
        "installed_workspace_skills": &installed_workspace_skill_ids,
        "installed_workspace_skill_paths": &installed_workspace_skill_paths,
        "settings": &settings,
        "heartbeat_body": &hb_body,
        "tools_body": &tools_body,
        "identity_body": &id_body,
        "memory_daily_path": &daily_path,
        "memory_daily_note": &daily_note,
    });
    let mut fingerprint_hasher = Sha256::new();
    let fingerprint_bytes = serde_json::to_vec(&fingerprint_payload)
        .map_err(|e| format!("Failed to serialize settings fingerprint: {}", e))?;
    fingerprint_hasher.update(fingerprint_bytes);
    let settings_fingerprint = format!("{:x}", fingerprint_hasher.finalize());
    {
        let cache = applied_agent_settings_fingerprint()
            .lock()
            .map_err(|e| e.to_string())?;
        if cache.as_deref() == Some(settings_fingerprint.as_str()) {
            return Ok(());
        }
    }

    let mut writes: Vec<ContainerFileWrite<'_>> = vec![
        ContainerFileWrite {
            path: &heartbeat_path,
            content: &hb_body,
            only_if_missing: false,
        },
        ContainerFileWrite {
            path: &tools_path,
            content: &tools_body,
            only_if_missing: false,
        },
        ContainerFileWrite {
            path: &identity_path,
            content: &id_body,
            only_if_missing: false,
        },
        ContainerFileWrite {
            path: &memory_path,
            content: memory_bootstrap,
            only_if_missing: true,
        },
        ContainerFileWrite {
            path: &daily_path,
            content: &daily_note,
            only_if_missing: true,
        },
    ];
    if !settings.soul.trim().is_empty() {
        writes.insert(
            0,
            ContainerFileWrite {
                path: &soul_path,
                content: &settings.soul,
                only_if_missing: false,
            },
        );
    }
    write_container_files_batch(&writes)?;

    let mut cfg = read_openclaw_config();
    normalize_openclaw_config(&mut cfg);

    if let Some(model) = &model {
        set_openclaw_config_value(
            &mut cfg,
            &["agents", "defaults", "model"],
            serde_json::json!({ "primary": model }),
        );
    }
    if let Some(image_model) = &image_model {
        set_openclaw_config_value(
            &mut cfg,
            &["agents", "defaults", "imageModel"],
            serde_json::json!({ "primary": image_model }),
        );
    }
    if proxy_mode {
        if let Some(base_url) = &base_url {
            let model_id = model
                .as_ref()
                .map(|m| {
                    let stripped = m.trim_start_matches("openrouter/").to_string();
                    if stripped == "free" || stripped == "auto" {
                        m.to_string()
                    } else {
                        stripped
                    }
                })
                .unwrap_or_default();
            let image_model_id = image_model
                .as_ref()
                .map(|m| {
                    let stripped = m.trim_start_matches("openrouter/").to_string();
                    if stripped == "free" || stripped == "auto" {
                        m.to_string()
                    } else {
                        stripped
                    }
                })
                .unwrap_or_default();
            let mut models = Vec::new();

            if !model_id.is_empty() {
                models.push(serde_json::json!({ "id": model_id, "name": model_id }));
            }
            if !image_model_id.is_empty() && image_model_id != model_id {
                models.push(serde_json::json!({ "id": image_model_id, "name": image_model_id }));
            }
            set_openclaw_config_value(
                &mut cfg,
                &["models", "providers", "openrouter"],
                serde_json::json!({
                    "baseUrl": base_url,
                    "api": "openai-completions",
                    "models": models
                }),
            );
            set_openclaw_config_value(
                &mut cfg,
                &["tools", "web", "search", "provider"],
                serde_json::json!("perplexity"),
            );
            if let Some(web_base_url) = &web_base_url {
                set_openclaw_config_value(
                    &mut cfg,
                    &["tools", "web", "search", "perplexity", "baseUrl"],
                    serde_json::json!(web_base_url),
                );
            } else {
                set_openclaw_config_value(
                    &mut cfg,
                    &["tools", "web", "search", "perplexity", "baseUrl"],
                    serde_json::json!(base_url),
                );
            }
        }
    } else {
        // Non-proxy mode: remove openrouter config to avoid validation errors
        // (an empty models.providers.openrouter object causes "baseUrl required" validation failure)
        remove_openclaw_config_value(&mut cfg, &["models", "providers", "openrouter"]);
    }
    let memory_enabled = settings.memory_enabled;
    let memory_slot = if !memory_enabled {
        "none"
    } else if settings.memory_long_term {
        "memory-lancedb"
    } else {
        "memory-core"
    };
    let memory_sessions_enabled = settings.memory_sessions_enabled;
    set_openclaw_config_value(
        &mut cfg,
        &["plugins", "slots", "memory"],
        serde_json::json!(memory_slot),
    );
    apply_default_qmd_memory_config(&mut cfg, memory_slot, memory_sessions_enabled);
    set_openclaw_config_value(
        &mut cfg,
        &["agents", "defaults", "heartbeat"],
        serde_json::json!({
            "every": settings.heartbeat_every
        }),
    );
    // Stream assistant blocks by default for faster first-token feedback.
    set_openclaw_config_value(
        &mut cfg,
        &["agents", "defaults", "blockStreamingDefault"],
        serde_json::json!("on"),
    );
    set_openclaw_config_value(
        &mut cfg,
        &["agents", "defaults", "blockStreamingBreak"],
        serde_json::json!("text_end"),
    );
    // Persist cron jobs across container restarts.
    set_openclaw_config_value(
        &mut cfg,
        &["cron", "store"],
        serde_json::json!("/data/cron/jobs.json"),
    );

    // Ensure integrations plugin is enabled (Entropic or legacy Nova id, depending on runtime image).
    let integrations_plugin_id =
        resolve_managed_plugin_id("entropic-integrations", "nova-integrations");
    remove_openclaw_config_value(&mut cfg, &["plugins", "entries", "entropic-integrations"]);
    remove_openclaw_config_value(&mut cfg, &["plugins", "entries", "nova-integrations"]);
    if let Some(plugin_id) = integrations_plugin_id {
        set_openclaw_config_value(
            &mut cfg,
            &["plugins", "entries", plugin_id, "enabled"],
            serde_json::json!(true),
        );
    }

    // Ensure optional plugin tools are allowed without restricting core tools.
    const ENTROPIC_INTEGRATION_TOOLS: [&str; 5] = [
        "calendar_list",
        "calendar_create",
        "gmail_search",
        "gmail_get",
        "gmail_send",
    ];
    const ENTROPIC_X_TOOLS: [&str; 4] = ["x_search", "x_profile", "x_thread", "x_user_tweets"];
    const ENTROPIC_CORE_TOOLS: [&str; 1] = ["image"];

    let mut workspace_skill_ids: Vec<String> = installed_skill_paths
        .iter()
        .map(|(id, _)| id.to_string())
        .filter(|id| !MANAGED_PLUGIN_IDS.contains(&id.as_str()))
        .collect();
    workspace_skill_ids.sort();
    workspace_skill_ids.dedup();

    let mut workspace_skill_path_prefixes: Vec<String> = Vec::new();
    for (skill_id, skill_path) in &installed_skill_paths {
        if MANAGED_PLUGIN_IDS.contains(&skill_id.as_str()) {
            continue;
        }
        workspace_skill_path_prefixes.push(skill_path.to_string());
        workspace_skill_path_prefixes.push(format!("{}/{}", SKILLS_ROOT, skill_id));
        for legacy_root in LEGACY_SKILLS_ROOTS {
            workspace_skill_path_prefixes.push(format!(
                "{}/{}",
                legacy_root.trim_end_matches('/'),
                skill_id
            ));
        }
    }
    workspace_skill_path_prefixes.sort();
    workspace_skill_path_prefixes.dedup();

    // OpenClaw `skills` are SKILL.md prompt assets, not plugin ids. Avoid writing
    // these ids under plugins.entries to keep config validation clean.
    if let Some(entries) = cfg
        .pointer_mut("/plugins/entries")
        .and_then(|v| v.as_object_mut())
    {
        for skill_id in &workspace_skill_ids {
            entries.remove(skill_id);
        }
    }

    // Enable x plugin if it exists (entropic-x or legacy nova-x).
    let x_plugin_id = resolve_managed_plugin_id("entropic-x", "nova-x");
    remove_openclaw_config_value(&mut cfg, &["plugins", "entries", "entropic-x"]);
    remove_openclaw_config_value(&mut cfg, &["plugins", "entries", "nova-x"]);
    let mut has_x_plugin = false;
    let mut x_plugin_path: Option<String> = None;
    if let Some(plugin_id) = x_plugin_id {
        has_x_plugin = true;
        if let Some(skills_root) = read_container_env("ENTROPIC_SKILLS_PATH") {
            let base = format!("{}/{}", skills_root.trim_end_matches('/'), plugin_id);
            let current = format!("{}/current", base);
            let candidate = if container_path_exists(&current) {
                current
            } else {
                base
            };
            if container_path_exists(&candidate) {
                x_plugin_path = Some(candidate);
            }
        }
        set_openclaw_config_value(
            &mut cfg,
            &["plugins", "entries", plugin_id, "enabled"],
            serde_json::json!(true),
        );
        if let Some(path) = x_plugin_path {
            let load_paths = cfg
                .pointer_mut("/plugins/load/paths")
                .and_then(|v| v.as_array_mut());
            if let Some(list) = load_paths {
                let exists = list.iter().any(|v| v.as_str() == Some(&path));
                if !exists {
                    list.push(serde_json::json!(path));
                }
            } else {
                set_openclaw_config_value(
                    &mut cfg,
                    &["plugins", "load", "paths"],
                    serde_json::json!([path]),
                );
            }
        }
    }

    if let Some(list) = cfg
        .pointer_mut("/plugins/load/paths")
        .and_then(|v| v.as_array_mut())
    {
        list.retain(|path| {
            let path_value = path.as_str().unwrap_or("");
            if path_value.is_empty() {
                return true;
            }
            !workspace_skill_path_prefixes.iter().any(|prefix| {
                let normalized_prefix = prefix.trim_end_matches('/');
                path_value == normalized_prefix
                    || path_value.starts_with(&format!("{}/", normalized_prefix))
            })
        });
    }

    if let Some(tools) = cfg["tools"].as_object_mut() {
        let allow_entry = tools.entry("alsoAllow").or_insert(serde_json::json!([]));
        if !allow_entry.is_array() {
            *allow_entry = serde_json::json!([]);
        }
        if let Some(list) = allow_entry.as_array_mut() {
            list.retain(|v| {
                v.as_str()
                    .map(|s| s != "entropic-integrations" && s != "nova-integrations")
                    .unwrap_or(true)
            });
            for tool in ENTROPIC_INTEGRATION_TOOLS {
                let exists = list.iter().any(|v| v.as_str() == Some(tool));
                if !exists {
                    list.push(serde_json::json!(tool));
                }
            }
            if has_x_plugin {
                for tool in ENTROPIC_X_TOOLS {
                    let exists = list.iter().any(|v| v.as_str() == Some(tool));
                    if !exists {
                        list.push(serde_json::json!(tool));
                    }
                }
            }
            for tool in ENTROPIC_CORE_TOOLS {
                let exists = list.iter().any(|v| v.as_str() == Some(tool));
                if !exists {
                    list.push(serde_json::json!(tool));
                }
            }
        }
    }

    if memory_slot == "memory-lancedb" {
        if let Some(openai_key) = openai_key_for_lancedb.as_deref() {
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
            set_openclaw_config_value(
                &mut cfg,
                &["plugins", "slots", "memory"],
                serde_json::json!("memory-core"),
            );
        }
    } else {
        remove_openclaw_config_value(&mut cfg, &["plugins", "entries", "memory-lancedb"]);
    }

    let effective_slot = cfg
        .pointer("/plugins/slots/memory")
        .and_then(|v| v.as_str())
        .unwrap_or("none")
        .to_string();
    let memory_sessions_enabled = settings.memory_sessions_enabled;
    apply_default_qmd_memory_config(&mut cfg, &effective_slot, memory_sessions_enabled);

    set_openclaw_config_value(
        &mut cfg,
        &["channels", "discord", "enabled"],
        serde_json::json!(settings.discord_enabled),
    );
    set_openclaw_config_value(
        &mut cfg,
        &["channels", "discord", "token"],
        serde_json::json!(settings.discord_token.clone()),
    );
    set_openclaw_config_value(
        &mut cfg,
        &["channels", "discord", "groupPolicy"],
        serde_json::json!("allowlist"),
    );
    set_openclaw_config_value(
        &mut cfg,
        &["channels", "discord", "configWrites"],
        serde_json::json!(false),
    );
    set_openclaw_config_value(
        &mut cfg,
        &["plugins", "entries", "discord", "enabled"],
        serde_json::json!(settings.discord_enabled),
    );

    set_openclaw_config_value(
        &mut cfg,
        &["channels", "telegram", "enabled"],
        serde_json::json!(settings.telegram_enabled),
    );
    set_openclaw_config_value(
        &mut cfg,
        &["channels", "telegram", "botToken"],
        serde_json::json!(settings.telegram_token.clone()),
    );
    let telegram_dm_policy = match settings.telegram_dm_policy.trim() {
        "allowlist" => "allowlist",
        "open" => "open",
        "disabled" => "disabled",
        _ => "pairing",
    };
    set_openclaw_config_value(
        &mut cfg,
        &["channels", "telegram", "dmPolicy"],
        serde_json::json!(telegram_dm_policy),
    );
    normalize_telegram_allow_from_for_dm_policy(&mut cfg, telegram_dm_policy);
    set_openclaw_config_value(
        &mut cfg,
        &["channels", "telegram", "groupPolicy"],
        serde_json::json!(settings.telegram_group_policy.clone()),
    );
    set_openclaw_config_value(
        &mut cfg,
        &["channels", "telegram", "configWrites"],
        serde_json::json!(settings.telegram_config_writes),
    );
    set_openclaw_config_value(
        &mut cfg,
        &["channels", "telegram", "groups", "*", "requireMention"],
        serde_json::json!(settings.telegram_require_mention),
    );
    set_openclaw_config_value(
        &mut cfg,
        &["channels", "telegram", "replyToMode"],
        serde_json::json!(settings.telegram_reply_to_mode.clone()),
    );
    set_openclaw_config_value(
        &mut cfg,
        &["channels", "telegram", "linkPreview"],
        serde_json::json!(settings.telegram_link_preview),
    );
    set_openclaw_config_value(
        &mut cfg,
        &["plugins", "entries", "telegram", "enabled"],
        serde_json::json!(settings.telegram_enabled),
    );

    set_openclaw_config_value(
        &mut cfg,
        &["channels", "slack", "enabled"],
        serde_json::json!(settings.slack_enabled),
    );
    set_openclaw_config_value(
        &mut cfg,
        &["channels", "slack", "botToken"],
        serde_json::json!(settings.slack_bot_token.clone()),
    );
    set_openclaw_config_value(
        &mut cfg,
        &["channels", "slack", "appToken"],
        serde_json::json!(settings.slack_app_token.clone()),
    );
    set_openclaw_config_value(
        &mut cfg,
        &["channels", "slack", "dm", "policy"],
        serde_json::json!("pairing"),
    );
    set_openclaw_config_value(
        &mut cfg,
        &["channels", "slack", "groupPolicy"],
        serde_json::json!("allowlist"),
    );
    set_openclaw_config_value(
        &mut cfg,
        &["channels", "slack", "configWrites"],
        serde_json::json!(false),
    );
    remove_openclaw_config_value(&mut cfg, &["channels", "slack", "dmPolicy"]);
    set_openclaw_config_value(
        &mut cfg,
        &["plugins", "entries", "slack", "enabled"],
        serde_json::json!(settings.slack_enabled),
    );

    set_openclaw_config_value(
        &mut cfg,
        &["channels", "googlechat", "enabled"],
        serde_json::json!(settings.googlechat_enabled),
    );
    set_openclaw_config_value(
        &mut cfg,
        &["channels", "googlechat", "audienceType"],
        serde_json::json!(if settings.googlechat_audience_type.trim().is_empty() {
            "app-url"
        } else {
            settings.googlechat_audience_type.trim()
        }),
    );
    set_openclaw_config_value(
        &mut cfg,
        &["channels", "googlechat", "webhookPath"],
        serde_json::json!("/googlechat"),
    );
    set_openclaw_config_value(
        &mut cfg,
        &["channels", "googlechat", "dm", "policy"],
        serde_json::json!("pairing"),
    );
    set_openclaw_config_value(
        &mut cfg,
        &["channels", "googlechat", "groupPolicy"],
        serde_json::json!("allowlist"),
    );
    if settings.googlechat_service_account.trim().is_empty() {
        remove_openclaw_config_value(&mut cfg, &["channels", "googlechat", "serviceAccount"]);
    } else {
        set_openclaw_config_value(
            &mut cfg,
            &["channels", "googlechat", "serviceAccount"],
            serde_json::json!(settings.googlechat_service_account.clone()),
        );
    }
    if settings.googlechat_audience.trim().is_empty() {
        remove_openclaw_config_value(&mut cfg, &["channels", "googlechat", "audience"]);
    } else {
        set_openclaw_config_value(
            &mut cfg,
            &["channels", "googlechat", "audience"],
            serde_json::json!(settings.googlechat_audience.trim()),
        );
    }
    set_openclaw_config_value(
        &mut cfg,
        &["plugins", "entries", "googlechat", "enabled"],
        serde_json::json!(settings.googlechat_enabled),
    );

    set_openclaw_config_value(
        &mut cfg,
        &["channels", "whatsapp", "configWrites"],
        serde_json::json!(false),
    );
    set_openclaw_config_value(
        &mut cfg,
        &["channels", "whatsapp", "groupPolicy"],
        serde_json::json!("allowlist"),
    );
    remove_openclaw_config_value(&mut cfg, &["channels", "whatsapp", "enabled"]);
    if settings.whatsapp_allow_from.trim().is_empty() {
        set_openclaw_config_value(
            &mut cfg,
            &["channels", "whatsapp", "dmPolicy"],
            serde_json::json!("pairing"),
        );
        remove_openclaw_config_value(&mut cfg, &["channels", "whatsapp", "allowFrom"]);
    } else {
        set_openclaw_config_value(
            &mut cfg,
            &["channels", "whatsapp", "dmPolicy"],
            serde_json::json!("allowlist"),
        );
        set_openclaw_config_value(
            &mut cfg,
            &["channels", "whatsapp", "allowFrom"],
            serde_json::json!([settings.whatsapp_allow_from.trim()]),
        );
    }
    set_openclaw_config_value(
        &mut cfg,
        &["plugins", "entries", "whatsapp", "enabled"],
        serde_json::json!(settings.whatsapp_enabled),
    );

    set_openclaw_config_value(
        &mut cfg,
        &["channels", "imessage", "enabled"],
        serde_json::json!(settings.imessage_enabled),
    );
    set_openclaw_config_value(
        &mut cfg,
        &["channels", "imessage", "cliPath"],
        serde_json::json!(settings.imessage_cli_path.clone()),
    );
    set_openclaw_config_value(
        &mut cfg,
        &["channels", "imessage", "dbPath"],
        serde_json::json!(settings.imessage_db_path.clone()),
    );
    set_openclaw_config_value(
        &mut cfg,
        &["channels", "imessage", "includeAttachments"],
        serde_json::json!(settings.imessage_include_attachments),
    );
    set_openclaw_config_value(
        &mut cfg,
        &["channels", "imessage", "dmPolicy"],
        serde_json::json!("pairing"),
    );
    set_openclaw_config_value(
        &mut cfg,
        &["channels", "imessage", "groupPolicy"],
        serde_json::json!("allowlist"),
    );
    set_openclaw_config_value(
        &mut cfg,
        &["channels", "imessage", "configWrites"],
        serde_json::json!(false),
    );
    if settings.imessage_remote_host.trim().is_empty() {
        remove_openclaw_config_value(&mut cfg, &["channels", "imessage", "remoteHost"]);
    } else {
        set_openclaw_config_value(
            &mut cfg,
            &["channels", "imessage", "remoteHost"],
            serde_json::json!(settings.imessage_remote_host.clone()),
        );
    }
    set_openclaw_config_value(
        &mut cfg,
        &["plugins", "entries", "imessage", "enabled"],
        serde_json::json!(settings.imessage_enabled),
    );

    // Only suppress legacy messaging channels once bridge has at least one
    // paired device. A stale bridge_enabled flag alone should not disable
    // Telegram/Discord/Slack on gateway restarts.
    if settings.bridge_enabled && has_paired_bridge_devices(&settings) {
        disable_legacy_messaging_config(&mut cfg);
    }

    // Set thinking level from ENTROPIC_THINKING_LEVEL env var (set by start_gateway from model suffix)
    // Use the value already read for the fingerprint to avoid a second docker exec
    if let Some(ref thinking_level) = thinking_level_env {
        let level = thinking_level.trim();
        println!(
            "[Entropic] apply_agent_settings: ENTROPIC_THINKING_LEVEL={:?}, setting thinkingDefault={}",
            thinking_level,
            if !level.is_empty() && level != "off" { level } else { "off" }
        );
        if !level.is_empty() && level != "off" {
            set_openclaw_config_value(
                &mut cfg,
                &["agents", "defaults", "thinkingDefault"],
                serde_json::json!(level),
            );
        } else {
            set_openclaw_config_value(
                &mut cfg,
                &["agents", "defaults", "thinkingDefault"],
                serde_json::json!("off"),
            );
        }
    } else {
        println!("[Entropic] apply_agent_settings: ENTROPIC_THINKING_LEVEL not set in container env");
    }

    println!(
        "[Entropic] apply_agent_settings: writing openclaw.json with model={:?}",
        cfg.get("agents")
            .and_then(|a| a.get("defaults"))
            .and_then(|d| d.get("model"))
    );
    write_openclaw_config(&cfg)?;

    // Write OpenAI Codex OAuth credentials to auth-profiles.json if available
    // (env vars don't work for Codex OAuth — OpenClaw needs auth-profiles.json)
    // OpenClaw reads auth-profiles.json from: $STATE_DIR/agents/main/agent/auth-profiles.json
    {
        let stored = load_auth(app);
        let openai_meta = stored.oauth_metadata.get("openai");
        let openai_key = stored.keys.get("openai");
        if let (Some(meta), Some(access_token)) = (openai_meta, openai_key) {
            if meta.source == "openai_codex" && !access_token.is_empty() {
                println!(
                    "[Entropic] Writing OpenAI Codex OAuth credentials to auth-profiles.json (token len={})",
                    access_token.len()
                );
                let auth_profiles = serde_json::json!({
                    "version": 1,
                    "profiles": {
                        "openai-codex:entropic": {
                            "type": "oauth",
                            "provider": "openai-codex",
                            "access": access_token,
                            "refresh": meta.refresh_token,
                            "expires": meta.expires_at / 1000 // Convert ms to seconds
                        }
                    }
                });
                let payload = serde_json::to_string_pretty(&auth_profiles)
                    .map_err(|e| e.to_string())?;
                if let Err(e) = write_container_file(
                    "/home/node/.openclaw/agents/main/agent/auth-profiles.json",
                    &payload,
                ) {
                    println!("[Entropic] Failed to write auth-profiles.json: {}", e);
                }
            }
        } else {
            println!(
                "[Entropic] No OpenAI Codex OAuth credentials found (meta={}, key={})",
                stored.oauth_metadata.contains_key("openai"),
                stored.keys.contains_key("openai"),
            );
        }
    }

    // Write OpenRouter proxy credentials to auth-profiles.json if in proxy mode
    // OpenClaw runtime expects auth-profiles.json even when OPENROUTER_API_KEY env is set
    {
        let openrouter_key = read_container_env("OPENROUTER_API_KEY");
        let proxy_mode = read_container_env("ENTROPIC_PROXY_MODE");

        if proxy_mode.as_deref() == Some("1") && openrouter_key.is_some() {
            let key = openrouter_key.unwrap();
            println!(
                "[Entropic] Writing OpenRouter proxy credentials to auth-profiles.json (key len={})",
                key.len()
            );
            // Include placeholder Anthropic key to satisfy diagnostic checks
            // Actual requests will use the proxy, so this key is never used
            let auth_profiles = serde_json::json!({
                "version": 1,
                "profiles": {
                    "openrouter:default": {
                        "type": "api_key",
                        "provider": "openrouter",
                        "key": key
                    },
                    "anthropic:default": {
                        "type": "api_key",
                        "provider": "anthropic",
                        "key": "proxy-placeholder"
                    }
                }
            });
            let payload = serde_json::to_string_pretty(&auth_profiles)
                .map_err(|e| e.to_string())?;
            if let Err(e) = write_container_file(
                "/home/node/.openclaw/agents/main/agent/auth-profiles.json",
                &payload,
            ) {
                println!("[Entropic] Failed to write proxy auth-profiles.json: {}", e);
            }
        }
    }

    {
        let mut cache = applied_agent_settings_fingerprint()
            .lock()
            .map_err(|e| e.to_string())?;
        *cache = Some(settings_fingerprint);
    }
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

const LEGACY_NOVA_APP_IDENTIFIER: &str = "ai.openclaw.nova";
const LEGACY_NOVA_STORE_FILE_MAPPINGS: &[(&str, &str)] = &[
    ("nova-auth.json", "entropic-auth.json"),
    ("nova-profile.json", "entropic-profile.json"),
    ("nova-settings.json", "entropic-settings.json"),
    ("nova-chat-history.json", "entropic-chat-history.json"),
    ("nova-integrations.json", "entropic-integrations.json"),
    ("nova-integrations.hold", "entropic-integrations.hold"),
];

fn legacy_nova_app_data_dir_candidates() -> Vec<PathBuf> {
    let mut dirs = Vec::new();

    if let Some(home) = dirs::home_dir() {
        dirs.push(
            home.join("Library")
                .join("Application Support")
                .join(LEGACY_NOVA_APP_IDENTIFIER),
        );
        dirs.push(home.join(".local/share").join(LEGACY_NOVA_APP_IDENTIFIER));
        dirs.push(
            home.join("AppData")
                .join("Roaming")
                .join(LEGACY_NOVA_APP_IDENTIFIER),
        );
        dirs.push(
            home.join("AppData")
                .join("Local")
                .join(LEGACY_NOVA_APP_IDENTIFIER),
        );
    }

    if let Some(data_local) = dirs::data_local_dir() {
        dirs.push(data_local.join(LEGACY_NOVA_APP_IDENTIFIER));
    }
    if let Some(data_dir) = dirs::data_dir() {
        dirs.push(data_dir.join(LEGACY_NOVA_APP_IDENTIFIER));
    }

    dirs.sort();
    dirs.dedup();
    dirs
}

fn find_legacy_nova_app_data_dir(current_data_dir: &Path) -> Option<PathBuf> {
    legacy_nova_app_data_dir_candidates()
        .into_iter()
        .find(|path| path != current_data_dir && path.is_dir())
}

fn merge_auth_with_legacy(mut current: StoredAuth, legacy: StoredAuth) -> StoredAuth {
    for (provider, key) in legacy.keys {
        current.keys.entry(provider).or_insert(key);
    }

    if current.active_provider.as_deref().unwrap_or("").trim().is_empty() {
        current.active_provider = legacy.active_provider;
    }
    if current.gateway_token.as_deref().unwrap_or("").trim().is_empty() {
        current.gateway_token = legacy.gateway_token;
    }
    if current.agent_settings.is_none() {
        current.agent_settings = legacy.agent_settings;
    }
    for (provider, meta) in legacy.oauth_metadata {
        current.oauth_metadata.entry(provider).or_insert(meta);
    }

    current.version = current.version.max(legacy.version);
    current
}

fn migrate_legacy_nova_store_files(app: &AppHandle) -> Result<Vec<String>, String> {
    let mut log = Vec::new();
    let current_dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "Failed to resolve app data dir".to_string())?;
    fs::create_dir_all(&current_dir)
        .map_err(|e| format!("Failed to create app data dir {}: {}", current_dir.display(), e))?;

    let Some(legacy_dir) = find_legacy_nova_app_data_dir(&current_dir) else {
        log.push("No legacy Nova app data directory found.".to_string());
        return Ok(log);
    };

    log.push(format!(
        "Found legacy Nova app data at {}",
        legacy_dir.display()
    ));

    let mut migrated_any = false;

    let legacy_auth_path = legacy_dir.join("auth.json");
    if legacy_auth_path.exists() {
        match fs::read_to_string(&legacy_auth_path)
            .ok()
            .and_then(|raw| serde_json::from_str::<StoredAuth>(&raw).ok())
        {
            Some(legacy_auth) => {
                let current_auth_path = current_dir.join("auth.json");
                let current_auth = fs::read_to_string(&current_auth_path)
                    .ok()
                    .and_then(|raw| serde_json::from_str::<StoredAuth>(&raw).ok())
                    .unwrap_or_default();
                let merged = merge_auth_with_legacy(current_auth, legacy_auth);
                let payload = serde_json::to_string_pretty(&merged)
                    .map_err(|e| format!("Failed to serialize merged auth store: {}", e))?;
                fs::write(&current_auth_path, payload).map_err(|e| {
                    format!(
                        "Failed to write migrated auth store {}: {}",
                        current_auth_path.display(),
                        e
                    )
                })?;
                log.push("Merged legacy auth.json into current app data.".to_string());
                migrated_any = true;
            }
            None => {
                log.push(format!(
                    "Warning: Could not parse legacy auth store at {}",
                    legacy_auth_path.display()
                ));
            }
        }
    }

    for (legacy_name, current_name) in LEGACY_NOVA_STORE_FILE_MAPPINGS {
        let source = legacy_dir.join(legacy_name);
        if !source.exists() {
            continue;
        }
        let dest = current_dir.join(current_name);
        if dest.exists() {
            continue;
        }
        fs::copy(&source, &dest).map_err(|e| {
            format!(
                "Failed to copy legacy file {} -> {}: {}",
                source.display(),
                dest.display(),
                e
            )
        })?;
        log.push(format!("Copied {} -> {}", legacy_name, current_name));
        migrated_any = true;
    }

    if !migrated_any {
        log.push(
            "Legacy Nova directory exists, but no migration was needed (current files already present)."
                .to_string(),
        );
    }

    Ok(log)
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

fn load_auth(app: &AppHandle) -> StoredAuth {
    let path = match auth_store_path(app) {
        Ok(p) => p,
        Err(_) => return StoredAuth::default(),
    };
    if let Ok(raw) = fs::read_to_string(&path) {
        return serde_json::from_str(&raw).unwrap_or_default();
    }

    // Compatibility fallback for upgrades from Nova's old app identifier path.
    let current_dir = match path.parent() {
        Some(dir) => dir,
        None => return StoredAuth::default(),
    };
    if let Some(legacy_dir) = find_legacy_nova_app_data_dir(current_dir) {
        let legacy_auth_path = legacy_dir.join("auth.json");
        if let Ok(raw) = fs::read_to_string(&legacy_auth_path) {
            if let Ok(legacy_auth) = serde_json::from_str::<StoredAuth>(&raw) {
                // Best-effort hydrate current path so future loads are direct.
                let _ = save_auth(app, &legacy_auth);
                return legacy_auth;
            }
        }
    }

    StoredAuth::default()
}

fn save_auth(app: &AppHandle, data: &StoredAuth) -> Result<(), String> {
    let path = auth_store_path(app)?;
    let payload = serde_json::to_string_pretty(data).map_err(|e| e.to_string())?;
    fs::write(&path, payload).map_err(|e| format!("Failed to write auth store: {}", e))?;
    Ok(())
}

fn gateway_ws_url() -> String {
    if std::path::Path::new("/.dockerenv").exists() {
        format!("ws://{}:18789", OPENCLAW_CONTAINER)
    } else {
        "ws://localhost:19789".to_string()
    }
}

fn generate_gateway_token() -> String {
    let mut token_bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut token_bytes);
    URL_SAFE_NO_PAD.encode(token_bytes)
}

static SESSION_GATEWAY_TOKEN: OnceLock<String> = OnceLock::new();

fn normalize_token(value: Option<String>) -> Option<String> {
    value.and_then(|token| {
        let trimmed = token.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn container_gateway_token() -> Option<String> {
    normalize_token(read_container_env("OPENCLAW_GATEWAY_TOKEN"))
}

fn expected_gateway_token(_app: &AppHandle) -> Result<String, String> {
    if let Some(from_env) = normalize_token(std::env::var("ENTROPIC_GATEWAY_TOKEN").ok()) {
        return Ok(from_env);
    }

    Ok(SESSION_GATEWAY_TOKEN
        .get_or_init(generate_gateway_token)
        .clone())
}

fn effective_gateway_token(app: &AppHandle) -> Result<String, String> {
    if let Some(token) = container_gateway_token() {
        return Ok(token);
    }
    expected_gateway_token(app)
}
fn now_ms_u64() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn resolve_tailscale_ipv4() -> Option<String> {
    let output = Command::new("tailscale").args(["ip", "-4"]).output().ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(ToOwned::to_owned)
}

fn bridge_device_summaries(settings: &StoredAgentSettings) -> Vec<BridgeDeviceSummary> {
    let now = now_ms_u64();
    let mut devices = settings
        .bridge_devices
        .iter()
        .filter(|device| !device.id.trim().is_empty())
        .map(|device| BridgeDeviceSummary {
            id: device.id.clone(),
            name: if device.name.trim().is_empty() {
                "Entropic Mobile".to_string()
            } else {
                device.name.clone()
            },
            owner_name: if device.owner_name.trim().is_empty() {
                "Unassigned".to_string()
            } else {
                device.owner_name.clone()
            },
            created_at_ms: device.created_at_ms,
            last_seen_at_ms: device.last_seen_at_ms,
            scopes: if device.scopes.is_empty() {
                vec!["chat".to_string()]
            } else {
                device.scopes.clone()
            },
            is_online: device.last_seen_at_ms > 0
                && now.saturating_sub(device.last_seen_at_ms) <= 120_000,
        })
        .collect::<Vec<_>>();
    devices.sort_by(|a, b| {
        b.last_seen_at_ms
            .cmp(&a.last_seen_at_ms)
            .then_with(|| b.created_at_ms.cmp(&a.created_at_ms))
    });
    devices
}

fn has_paired_bridge_devices(settings: &StoredAgentSettings) -> bool {
    settings
        .bridge_devices
        .iter()
        .any(|device| !device.id.trim().is_empty())
        || !settings.bridge_device_id.trim().is_empty()
}

fn sync_legacy_bridge_fields_from_devices(settings: &mut StoredAgentSettings) {
    let primary = settings
        .bridge_devices
        .iter()
        .filter(|device| !device.id.trim().is_empty())
        .max_by(|a, b| {
            a.last_seen_at_ms
                .cmp(&b.last_seen_at_ms)
                .then_with(|| a.created_at_ms.cmp(&b.created_at_ms))
        });

    if let Some(primary_device) = primary {
        settings.bridge_device_id = primary_device.id.clone();
        settings.bridge_device_name = primary_device.name.clone();
        settings.bridge_device_public_key = primary_device.public_key.clone();
        settings.bridge_last_seen_at_ms = primary_device.last_seen_at_ms;
    } else {
        settings.bridge_device_id.clear();
        settings.bridge_device_name.clear();
        settings.bridge_device_public_key.clear();
        settings.bridge_last_seen_at_ms = 0;
    }
}

fn migrate_bridge_devices(settings: &mut StoredAgentSettings) -> bool {
    let mut changed = false;

    let mut normalized: Vec<BridgeDeviceRecord> = Vec::new();
    for mut device in settings.bridge_devices.drain(..) {
        let id = device.id.trim().to_string();
        if id.is_empty() {
            changed = true;
            continue;
        }
        device.id = id;
        if device.name.trim().is_empty() {
            device.name = "Entropic Mobile".to_string();
            changed = true;
        }
        if device.owner_name.trim().is_empty() {
            device.owner_name = "Unassigned".to_string();
            changed = true;
        }
        if device.scopes.is_empty() {
            device.scopes = vec!["chat".to_string()];
            changed = true;
        }
        if device.created_at_ms == 0 {
            device.created_at_ms = if device.last_seen_at_ms > 0 {
                device.last_seen_at_ms
            } else {
                now_ms_u64()
            };
            changed = true;
        }
        if let Some(existing) = normalized.iter_mut().find(|entry| entry.id == device.id) {
            if device.last_seen_at_ms >= existing.last_seen_at_ms {
                *existing = device;
            }
            changed = true;
        } else {
            normalized.push(device);
        }
    }

    if normalized.is_empty() && !settings.bridge_device_id.trim().is_empty() {
        normalized.push(BridgeDeviceRecord {
            id: settings.bridge_device_id.trim().to_string(),
            name: if settings.bridge_device_name.trim().is_empty() {
                "Entropic Mobile".to_string()
            } else {
                settings.bridge_device_name.trim().to_string()
            },
            owner_name: "Legacy Pairing".to_string(),
            public_key: settings.bridge_device_public_key.clone(),
            created_at_ms: if settings.bridge_last_seen_at_ms > 0 {
                settings.bridge_last_seen_at_ms
            } else {
                now_ms_u64()
            },
            last_seen_at_ms: settings.bridge_last_seen_at_ms,
            scopes: vec!["chat".to_string()],
        });
        changed = true;
    }

    if settings.bridge_devices.len() != normalized.len() {
        changed = true;
    }
    settings.bridge_devices = normalized;

    let before = (
        settings.bridge_device_id.clone(),
        settings.bridge_device_name.clone(),
        settings.bridge_device_public_key.clone(),
        settings.bridge_last_seen_at_ms,
    );
    sync_legacy_bridge_fields_from_devices(settings);
    let after = (
        settings.bridge_device_id.clone(),
        settings.bridge_device_name.clone(),
        settings.bridge_device_public_key.clone(),
        settings.bridge_last_seen_at_ms,
    );
    if before != after {
        changed = true;
    }

    changed
}

fn bridge_status_from_settings(settings: &StoredAgentSettings) -> BridgeState {
    let devices = bridge_device_summaries(settings);
    let online_count = devices.iter().filter(|device| device.is_online).count();
    BridgeState {
        enabled: settings.bridge_enabled,
        tailnet_ip: settings.bridge_tailnet_ip.clone(),
        port: settings.bridge_port,
        pairing_expires_at_ms: settings.bridge_pairing_expires_at_ms,
        device_id: settings.bridge_device_id.clone(),
        device_name: settings.bridge_device_name.clone(),
        last_seen_at_ms: settings.bridge_last_seen_at_ms,
        paired: settings.bridge_enabled && has_paired_bridge_devices(settings),
        device_count: devices.len(),
        online_count,
        devices,
    }
}

fn refresh_bridge_tailnet_ip(settings: &mut StoredAgentSettings) {
    if settings.bridge_tailnet_ip.trim().is_empty() {
        if let Some(ip) = resolve_tailscale_ipv4() {
            settings.bridge_tailnet_ip = ip;
        }
    }
}

fn build_bridge_pair_uri(settings: &StoredAgentSettings, token: &str) -> String {
    let host = if settings.bridge_tailnet_ip.trim().is_empty() {
        "127.0.0.1".to_string()
    } else {
        settings.bridge_tailnet_ip.trim().to_string()
    };
    let mut url = match Url::parse("entropic-bridge://pair") {
        Ok(url) => url,
        Err(_) => return String::new(),
    };
    url.query_pairs_mut()
        .append_pair("host", &host)
        .append_pair("port", &settings.bridge_port.to_string())
        .append_pair("token", token)
        .append_pair("v", "1");
    url.to_string()
}

fn build_bridge_qr_data_url(pair_uri: &str) -> Result<String, String> {
    let qr = qrcode::QrCode::new(pair_uri.as_bytes())
        .map_err(|e: qrcode::types::QrError| e.to_string())?;
    let svg = qr
        .render::<qrcode::render::svg::Color>()
        .min_dimensions(512, 512)
        .build();
    Ok(format!(
        "data:image/svg+xml;base64,{}",
        STANDARD.encode(svg.as_bytes())
    ))
}

fn ensure_object_entry<'a>(
    parent: &'a mut serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> &'a mut serde_json::Map<String, serde_json::Value> {
    let entry = parent
        .entry(key.to_string())
        .or_insert_with(|| serde_json::json!({}));
    if !entry.is_object() {
        *entry = serde_json::json!({});
    }
    entry
        .as_object_mut()
        .expect("value must be an object after normalization")
}

fn ensure_config_path(cfg: &mut serde_json::Value, path: &[&str]) {
    if path.is_empty() {
        return;
    }

    if !cfg.is_object() {
        *cfg = serde_json::json!({});
    }

    let mut current = cfg
        .as_object_mut()
        .expect("config root must be an object before path normalization");

    for key in path {
        let entry = current
            .entry((*key).to_string())
            .or_insert_with(|| serde_json::json!({}));
        if !entry.is_object() {
            *entry = serde_json::json!({});
        }
        current = entry
            .as_object_mut()
            .expect("normalized config path must remain an object");
    }
}

fn normalize_openclaw_config(cfg: &mut serde_json::Value) {
    let paths: &[&[&str]] = &[
        &["agents", "defaults"],
        &["tools", "web", "search", "perplexity"],
        &["plugins", "slots"],
        &["plugins", "load", "paths"],
        &["plugins", "entries", "memory-lancedb"],
        &["plugins", "entries", "discord"],
        &["plugins", "entries", "telegram"],
        &["plugins", "entries", "slack"],
        &["plugins", "entries", "googlechat"],
        &["plugins", "entries", "whatsapp"],
        &["plugins", "entries", "imessage"],
        &["channels", "discord"],
        &["channels", "telegram", "groups", "*"],
        &["channels", "slack"],
        &["channels", "slack", "dm"],
        &["channels", "googlechat", "dm"],
        &["channels", "whatsapp"],
        &["channels", "imessage"],
        &["cron"],
    ];

    for path in paths {
        ensure_config_path(cfg, path);
    }

    // `plugins.load.paths` must be an array. Some legacy or normalized state
    // may create this key as an object, which causes startup validation failure.
    if !cfg
        .pointer("/plugins/load/paths")
        .is_some_and(|v| v.is_array())
    {
        set_openclaw_config_value(cfg, &["plugins", "load", "paths"], serde_json::json!([]));
    }

    // Enable control UI access from localhost without device pairing.
    // This allows the desktop app's health checks and local connections to work
    // with operator scopes, while still requiring device pairing for remote connections.
    set_openclaw_config_value(
        cfg,
        &["gateway", "controlUi", "allowInsecureAuth"],
        serde_json::json!(true),
    );

    // Allow origins for localhost control UI connections.
    // Includes:
    // - "null" for native WebSocket clients (Rust health checks)
    // - http/https localhost for direct browser access
    // - tauri://localhost for Tauri webview (production builds)
    // - http://localhost:5174 for Vite dev server
    set_openclaw_config_value(
        cfg,
        &["gateway", "controlUi", "allowedOrigins"],
        serde_json::json!([
            "null",
            "http://localhost",
            "http://127.0.0.1",
            "https://localhost",
            "https://127.0.0.1",
            "tauri://localhost",
            "http://localhost:5174"
        ]),
    );

    let telegram_dm_policy = cfg
        .get("channels")
        .and_then(|v| v.get("telegram"))
        .and_then(|v| v.get("dmPolicy"))
        .and_then(|v| v.as_str())
        .unwrap_or("pairing")
        .to_string();
    normalize_telegram_allow_from_for_dm_policy(cfg, &telegram_dm_policy);
}

fn disable_legacy_messaging_config(cfg: &mut serde_json::Value) {
    normalize_openclaw_config(cfg);

    set_openclaw_config_value(
        cfg,
        &["channels", "discord", "enabled"],
        serde_json::json!(false),
    );
    set_openclaw_config_value(
        cfg,
        &["channels", "discord", "token"],
        serde_json::json!(""),
    );
    set_openclaw_config_value(
        cfg,
        &["plugins", "entries", "discord", "enabled"],
        serde_json::json!(false),
    );

    set_openclaw_config_value(
        cfg,
        &["channels", "telegram", "enabled"],
        serde_json::json!(false),
    );
    set_openclaw_config_value(
        cfg,
        &["channels", "telegram", "botToken"],
        serde_json::json!(""),
    );
    set_openclaw_config_value(
        cfg,
        &["plugins", "entries", "telegram", "enabled"],
        serde_json::json!(false),
    );

    set_openclaw_config_value(
        cfg,
        &["channels", "slack", "enabled"],
        serde_json::json!(false),
    );
    set_openclaw_config_value(
        cfg,
        &["channels", "slack", "botToken"],
        serde_json::json!(""),
    );
    set_openclaw_config_value(
        cfg,
        &["channels", "slack", "appToken"],
        serde_json::json!(""),
    );
    set_openclaw_config_value(
        cfg,
        &["plugins", "entries", "slack", "enabled"],
        serde_json::json!(false),
    );

    set_openclaw_config_value(
        cfg,
        &["channels", "googlechat", "enabled"],
        serde_json::json!(false),
    );
    remove_openclaw_config_value(cfg, &["channels", "googlechat", "serviceAccount"]);
    remove_openclaw_config_value(cfg, &["channels", "googlechat", "audience"]);
    set_openclaw_config_value(
        cfg,
        &["plugins", "entries", "googlechat", "enabled"],
        serde_json::json!(false),
    );

    set_openclaw_config_value(
        cfg,
        &["plugins", "entries", "whatsapp", "enabled"],
        serde_json::json!(false),
    );
    remove_openclaw_config_value(cfg, &["channels", "whatsapp", "allowFrom"]);

    set_openclaw_config_value(
        cfg,
        &["channels", "imessage", "enabled"],
        serde_json::json!(false),
    );
    remove_openclaw_config_value(cfg, &["channels", "imessage", "remoteHost"]);
    set_openclaw_config_value(
        cfg,
        &["plugins", "entries", "imessage", "enabled"],
        serde_json::json!(false),
    );
}

fn clear_legacy_messaging_settings(settings: &mut StoredAgentSettings) {
    settings.imessage_enabled = false;
    settings.discord_enabled = false;
    settings.discord_token.clear();
    settings.telegram_enabled = false;
    settings.telegram_token.clear();
    settings.telegram_dm_policy = "pairing".to_string();
    settings.telegram_group_policy = "allowlist".to_string();
    settings.telegram_config_writes = false;
    settings.telegram_require_mention = true;
    settings.telegram_reply_to_mode = "off".to_string();
    settings.telegram_link_preview = true;
    settings.slack_enabled = false;
    settings.slack_bot_token.clear();
    settings.slack_app_token.clear();
    settings.googlechat_enabled = false;
    settings.googlechat_service_account.clear();
    settings.googlechat_audience.clear();
    settings.whatsapp_enabled = false;
    settings.whatsapp_allow_from.clear();
}

async fn read_http_request(
    socket: &mut tokio::net::TcpStream,
) -> Result<(String, String, Vec<u8>), String> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 2048];

    loop {
        let read = timeout(Duration::from_secs(10), socket.read(&mut chunk))
            .await
            .map_err(|_| "Request timeout".to_string())?
            .map_err(|e| format!("Failed to read request: {}", e))?;
        if read == 0 {
            break;
        }
        buffer.extend_from_slice(&chunk[..read]);
        if buffer.windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
        if buffer.len() > 64 * 1024 {
            return Err("Request headers too large".to_string());
        }
    }

    let header_end = buffer
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .ok_or_else(|| "Malformed HTTP request".to_string())?;
    let headers_raw = String::from_utf8_lossy(&buffer[..header_end]);
    let mut lines = headers_raw.lines();
    let request_line = lines
        .next()
        .ok_or_else(|| "Missing HTTP request line".to_string())?;
    let mut parts = request_line.split_whitespace();
    let method = parts
        .next()
        .ok_or_else(|| "Missing HTTP method".to_string())?
        .to_string();
    let path = parts
        .next()
        .ok_or_else(|| "Missing HTTP path".to_string())?
        .to_string();

    let content_length = headers_raw
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            if name.trim().eq_ignore_ascii_case("content-length") {
                value.trim().parse::<usize>().ok()
            } else {
                None
            }
        })
        .unwrap_or(0);

    let mut body = buffer[(header_end + 4)..].to_vec();
    while body.len() < content_length {
        let read = timeout(Duration::from_secs(10), socket.read(&mut chunk))
            .await
            .map_err(|_| "Request body timeout".to_string())?
            .map_err(|e| format!("Failed to read request body: {}", e))?;
        if read == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..read]);
    }
    if body.len() > content_length {
        body.truncate(content_length);
    }

    Ok((method, path, body))
}

fn http_json_response(status: u16, status_text: &str, payload: serde_json::Value) -> String {
    let body = payload.to_string();
    format!(
        "HTTP/1.1 {} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        status,
        status_text,
        body.as_bytes().len(),
        body
    )
}

async fn handle_bridge_http_connection(mut socket: tokio::net::TcpStream, app: AppHandle) {
    let request = read_http_request(&mut socket).await;
    let response = match request {
        Ok((method, path, body)) => {
            if method == "GET" && path == "/bridge/health" {
                let mut settings = load_agent_settings(&app);
                refresh_bridge_tailnet_ip(&mut settings);
                let _ = save_agent_settings(&app, settings.clone());
                http_json_response(
                    200,
                    "OK",
                    serde_json::json!({ "ok": true, "status": bridge_status_from_settings(&settings) }),
                )
            } else if method == "POST" && path == "/bridge/pair" {
                let parsed = serde_json::from_slice::<BridgePairRequest>(&body);
                match parsed {
                    Ok(req) => {
                        let mut settings = load_agent_settings(&app);
                        let now = now_ms_u64();
                        let token_matches =
                            settings.bridge_pairing_token.trim() == req.token.trim();
                        let token_fresh = settings.bridge_pairing_expires_at_ms > now;
                        let device_id = req.device_id.trim().to_string();
                        if !settings.bridge_enabled {
                            http_json_response(
                                400,
                                "Bad Request",
                                serde_json::json!({ "ok": false, "error": "Bridge is disabled in Entropic desktop." }),
                            )
                        } else if device_id.is_empty() {
                            http_json_response(
                                400,
                                "Bad Request",
                                serde_json::json!({ "ok": false, "error": "Device id is required." }),
                            )
                        } else if !token_matches || !token_fresh {
                            http_json_response(
                                401,
                                "Unauthorized",
                                serde_json::json!({ "ok": false, "error": "Pairing token is invalid or expired." }),
                            )
                        } else {
                            let device_name = req
                                .device_name
                                .as_deref()
                                .unwrap_or("Entropic Mobile")
                                .trim()
                                .to_string();
                            let owner_name = req
                                .owner_name
                                .as_deref()
                                .unwrap_or("Unassigned")
                                .trim()
                                .to_string();
                            let device_public_key =
                                req.device_public_key.as_deref().unwrap_or("").to_string();
                            let existing_index = settings
                                .bridge_devices
                                .iter()
                                .position(|device| device.id == device_id);

                            if existing_index.is_none()
                                && settings.bridge_devices.len() >= MAX_BRIDGE_DEVICES
                            {
                                http_json_response(
                                    429,
                                    "Too Many Requests",
                                    serde_json::json!({
                                        "ok": false,
                                        "error": format!("Maximum paired device limit reached ({}). Remove a device in Entropic Desktop and retry pairing.", MAX_BRIDGE_DEVICES)
                                    }),
                                )
                            } else {
                                if let Some(index) = existing_index {
                                    let existing = &mut settings.bridge_devices[index];
                                    existing.name = if device_name.is_empty() {
                                        existing.name.clone()
                                    } else {
                                        device_name.clone()
                                    };
                                    existing.owner_name = if owner_name.is_empty() {
                                        existing.owner_name.clone()
                                    } else {
                                        owner_name.clone()
                                    };
                                    if !device_public_key.trim().is_empty() {
                                        existing.public_key = device_public_key.clone();
                                    }
                                    existing.last_seen_at_ms = now;
                                    if existing.created_at_ms == 0 {
                                        existing.created_at_ms = now;
                                    }
                                    if existing.scopes.is_empty() {
                                        existing.scopes = vec!["chat".to_string()];
                                    }
                                } else {
                                    settings.bridge_devices.push(BridgeDeviceRecord {
                                        id: device_id.clone(),
                                        name: if device_name.is_empty() {
                                            "Entropic Mobile".to_string()
                                        } else {
                                            device_name
                                        },
                                        owner_name,
                                        public_key: device_public_key,
                                        created_at_ms: now,
                                        last_seen_at_ms: now,
                                        scopes: vec!["chat".to_string()],
                                    });
                                }

                                sync_legacy_bridge_fields_from_devices(&mut settings);
                                settings.bridge_pairing_token.clear();
                                settings.bridge_pairing_expires_at_ms = 0;
                                clear_legacy_messaging_settings(&mut settings);
                                let _ = save_agent_settings(&app, settings.clone());
                                let mut cfg = read_openclaw_config();
                                disable_legacy_messaging_config(&mut cfg);
                                let _ = write_openclaw_config(&cfg);
                                let ws_host = if settings.bridge_tailnet_ip.trim().is_empty() {
                                    "127.0.0.1".to_string()
                                } else {
                                    settings.bridge_tailnet_ip.trim().to_string()
                                };
                                http_json_response(
                                    200,
                                    "OK",
                                    serde_json::json!({
                                        "ok": true,
                                        "status": bridge_status_from_settings(&settings),
                                        "gateway": {
                                            "wsUrl": format!("ws://{}:19789", ws_host),
                                            "token": effective_gateway_token(&app).unwrap_or_default()
                                        }
                                    }),
                                )
                            }
                        }
                    }
                    Err(_) => http_json_response(
                        400,
                        "Bad Request",
                        serde_json::json!({ "ok": false, "error": "Invalid JSON body." }),
                    ),
                }
            } else if method == "POST" && path == "/bridge/heartbeat" {
                let parsed = serde_json::from_slice::<BridgeHeartbeatRequest>(&body);
                match parsed {
                    Ok(req) => {
                        let mut settings = load_agent_settings(&app);
                        let device_id = req.device_id.trim();
                        if device_id.is_empty() {
                            http_json_response(
                                401,
                                "Unauthorized",
                                serde_json::json!({ "ok": false, "error": "Unknown device id." }),
                            )
                        } else if let Some(device) = settings
                            .bridge_devices
                            .iter_mut()
                            .find(|entry| entry.id == device_id)
                        {
                            device.last_seen_at_ms = now_ms_u64();
                            if device.scopes.is_empty() {
                                device.scopes = vec!["chat".to_string()];
                            }
                            sync_legacy_bridge_fields_from_devices(&mut settings);
                            let _ = save_agent_settings(&app, settings.clone());
                            http_json_response(
                                200,
                                "OK",
                                serde_json::json!({ "ok": true, "status": bridge_status_from_settings(&settings) }),
                            )
                        } else {
                            http_json_response(
                                401,
                                "Unauthorized",
                                serde_json::json!({ "ok": false, "error": "Unknown device id." }),
                            )
                        }
                    }
                    Err(_) => http_json_response(
                        400,
                        "Bad Request",
                        serde_json::json!({ "ok": false, "error": "Invalid JSON body." }),
                    ),
                }
            } else {
                http_json_response(
                    404,
                    "Not Found",
                    serde_json::json!({ "ok": false, "error": "Unknown endpoint." }),
                )
            }
        }
        Err(err) => http_json_response(
            400,
            "Bad Request",
            serde_json::json!({ "ok": false, "error": err }),
        ),
    };
    let _ = socket.write_all(response.as_bytes()).await;
}

async fn run_bridge_server(app: AppHandle, port: u16) -> Result<(), String> {
    let listener = TcpListener::bind(("0.0.0.0", port))
        .await
        .map_err(|e| format!("Failed to bind bridge server on {}: {}", port, e))?;
    println!("[Entropic] Bridge server listening on 0.0.0.0:{}", port);
    loop {
        let (socket, _) = listener
            .accept()
            .await
            .map_err(|e| format!("Bridge server accept failed: {}", e))?;
        let app_handle = app.clone();
        tauri::async_runtime::spawn(async move {
            handle_bridge_http_connection(socket, app_handle).await;
        });
    }
}

fn ensure_bridge_server_running(
    app: &AppHandle,
    state: &State<'_, AppState>,
    port: u16,
) -> Result<(), String> {
    let mut started = state
        .bridge_server_started
        .lock()
        .map_err(|e| format!("Bridge server lock failed: {}", e))?;
    if *started {
        return Ok(());
    }
    *started = true;
    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(err) = run_bridge_server(app_handle, port).await {
            eprintln!("[Entropic] Bridge server stopped: {}", err);
        }
    });
    Ok(())
}
fn redact_env_value(env: &str) -> String {
    const SECRET_ENV_PREFIXES: &[&str] = &[
        "OPENCLAW_GATEWAY_TOKEN=",
        "ANTHROPIC_API_KEY=",
        "OPENAI_API_KEY=",
        "GEMINI_API_KEY=",
        "OPENROUTER_API_KEY=",
        "ENTROPIC_PROXY_BASE_URL=",
    ];
    for prefix in SECRET_ENV_PREFIXES {
        if env.starts_with(prefix) {
            return format!("{}[REDACTED]", prefix);
        }
    }
    env.to_string()
}

fn docker_args_for_log(args: &[String]) -> String {
    let mut redacted = Vec::with_capacity(args.len());
    let mut expect_env = false;
    for arg in args {
        if expect_env {
            redacted.push(redact_env_value(arg));
            expect_env = false;
            continue;
        }
        redacted.push(arg.clone());
        if arg == "-e" {
            expect_env = true;
        }
    }
    redacted.join(" ")
}

struct GatewayEnvFile {
    path: PathBuf,
}

impl Drop for GatewayEnvFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

fn gateway_env_file(entries: &[(&str, &str)]) -> Result<GatewayEnvFile, String> {
    let mut lines = String::new();
    for &(key, value) in entries {
        if value.is_empty() {
            continue;
        }

        if key.contains('\n') || key.contains('\r') || key.is_empty() || key.contains('=') {
            return Err(format!("Invalid gateway env key: {}", key));
        }
        if value.contains('\n') || value.contains('\r') || value.contains('\0') {
            return Err(format!("Invalid gateway env value for key: {}", key));
        }

        lines.push_str(key);
        lines.push('=');
        lines.push_str(value);
        lines.push('\n');
    }

    if lines.is_empty() {
        return Err("Missing gateway environment values".to_string());
    }

    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let file_name = format!("entropic-openclaw-env-{}-{}.env", std::process::id(), nanos);
    let path = std::env::temp_dir().join(file_name);
    fs::write(&path, lines).map_err(|e| format!("Failed to create gateway env file: {}", e))?;

    #[cfg(unix)]
    {
        let mut perms = fs::metadata(&path)
            .map_err(|e| format!("Failed to read gateway env file metadata: {}", e))?
            .permissions();
        perms.set_mode(0o600);
        fs::set_permissions(&path, perms)
            .map_err(|e| format!("Failed to secure gateway env file: {}", e))?;
    }

    Ok(GatewayEnvFile { path })
}

async fn wait_for_gateway_health_strict(token: &str, attempts: usize) -> Result<(), String> {
    let ws_url = gateway_ws_url();
    let mut last_error = String::new();
    for attempt in 1..=attempts {
        let mut should_probe_ws = true;
        if let Some(status) = container_health_status() {
            match status.as_str() {
                "starting" => {
                    last_error = "container health=starting".to_string();
                    // While Docker reports "starting", still probe WS after the first
                    // couple of cycles so we don't wait the full health grace period.
                    should_probe_ws = attempt > 2;
                }
                "unhealthy" => {
                    last_error = "container health=unhealthy".to_string();
                    should_probe_ws = false;
                }
                _ => {}
            }
        }

        if should_probe_ws {
            match check_gateway_ws_health(&ws_url, token).await {
                Ok(true) => return Ok(()),
                Ok(false) => {
                    last_error = "health rpc rejected".to_string();
                }
                Err(err) => {
                    last_error = err;
                }
            }
        }

        if attempt < attempts {
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }

    if last_error.is_empty() {
        last_error = "unknown health failure".to_string();
    }
    Err(format!(
        "Gateway failed strict health check at {}: {}",
        ws_url, last_error
    ))
}

fn container_health_status() -> Option<String> {
    let output = docker_command()
        .args([
            "inspect",
            "--format",
            "{{.State.Health.Status}}",
            OPENCLAW_CONTAINER,
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let status = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if status.is_empty() {
        None
    } else {
        Some(status)
    }
}

fn container_instance_id() -> Option<String> {
    let output = docker_command()
        .args(["inspect", "--format", "{{.Id}}", OPENCLAW_CONTAINER])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let id = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if id.is_empty() {
        None
    } else {
        Some(id)
    }
}

fn container_running() -> bool {
    gateway_container_exists(true)
}

fn colima_daemon_killed_hint() -> Option<String> {
    if !matches!(Platform::detect(), Platform::MacOS) {
        return None;
    }

    let colima_home = entropic_colima_home_path();
    for profile in [ENTROPIC_VZ_PROFILE, ENTROPIC_QEMU_PROFILE] {
        let daemon_log = colima_home.join(profile).join("daemon").join("daemon.log");
        let content = match fs::read_to_string(&daemon_log) {
            Ok(raw) => raw,
            Err(_) => continue,
        };
        if let Some(line) = content
            .lines()
            .rev()
            .take(300)
            .find(|line| line.contains("signal: killed"))
        {
            println!(
                "[Entropic] Colima daemon crash marker in {} ({}): {}",
                profile,
                daemon_log.display(),
                line.trim()
            );
            return Some(format!(
                "Detected Colima {} daemon crash marker (`signal: killed`) in {}. This usually means the VM was killed by host resource pressure; increase Entropic runtime memory and keep Colima running.",
                profile,
                daemon_log.display()
            ));
        }
    }

    None
}

fn append_colima_runtime_hint(message: String) -> String {
    if let Some(hint) = colima_daemon_killed_hint() {
        format!("{}\n\n{}", message, hint)
    } else {
        message
    }
}

fn finish_health_wait_or_tolerate_starting(err: String, context: &str) -> Result<(), String> {
    // Tolerate normal startup transients: container still warming up, or WS not ready yet
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
    state: &AppState,
) -> Result<(), String> {
    if let Err(initial) = wait_for_gateway_health_strict(token, 12).await {
        let health_status = container_health_status();
        if matches!(health_status.as_deref(), Some("starting")) {
            println!(
                "[Entropic] {} health check failed while health=starting; extending wait: {}",
                label, initial
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
                label, initial
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
                label, health_status, initial
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
                            initial,
                            rerun_stderr.trim()
                        )));
                    }
                } else {
                    return Err(append_colima_runtime_hint(format!(
                        "{} failed health check ({}) and restart failed: {}",
                        label,
                        initial,
                        stderr.trim()
                    )));
                }
            }
            apply_agent_settings(app, state)?;
            if let Err(e) = wait_for_gateway_health_strict(token, 16).await {
                finish_health_wait_or_tolerate_starting(
                    e,
                    &format!("{} failed strict health check after recovery", label),
                )?;
            }
        } else {
            println!(
                "[Entropic] {} health check failed with container state {:?}; extending wait without restart: {}",
                label, health_status, initial
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
        bridge_server_started: Mutex::new(false),
        anthropic_oauth_verifier: Mutex::new(None),
    }
}

#[tauri::command]
pub async fn check_runtime_status(app: AppHandle) -> Result<RuntimeStatus, String> {
    let runtime = get_runtime(&app);
    Ok(runtime.check_status())
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
pub async fn start_runtime(app: AppHandle) -> Result<(), String> {
    let runtime = get_runtime(&app);
    runtime
        .start_colima()
        .map_err(|e| append_colima_runtime_hint(e.to_string()))
}

#[tauri::command]
pub async fn stop_runtime(app: AppHandle) -> Result<(), String> {
    let runtime = get_runtime(&app);
    runtime.stop_colima().map_err(|e| e.to_string())
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

        let home_dir = dirs::home_dir().ok_or("Could not find home directory")?;

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
                    let _ = std::process::Command::new("docker")
                        .args(&["ps", "-aq"])
                        .env("DOCKER_HOST", &host)
                        .output()
                        .and_then(|out| {
                            let containers = String::from_utf8_lossy(&out.stdout);
                            for container_id in containers.lines().filter(|l| !l.trim().is_empty()) {
                                let _ = std::process::Command::new("docker")
                                    .args(&["rm", "-f", container_id])
                                    .env("DOCKER_HOST", &host)
                                    .output();
                            }
                            Ok(())
                        });

                    // System prune
                    let _ = std::process::Command::new("docker")
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
            let prefix = if colima_home
                .to_string_lossy()
                .contains(&format!("{}{}", std::path::MAIN_SEPARATOR, ".nova"))
            {
                "Removing legacy"
            } else {
                "Removing runtime"
            };
            cleanup_log.push(format!("{} {}...", prefix, colima_home.display()));
            for profile in &profiles {
                let _ = std::process::Command::new("colima")
                    .args(&["delete", "-f", "-p", profile])
                    .env("COLIMA_HOME", colima_home)
                    .env("LIMA_HOME", colima_home.join("_lima"))
                    .output();
            }
        }
        cleanup_log.push("Colima VMs deleted".to_string());

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

    // Clear app data (but keep auth.json with user's preferences)
    cleanup_log.push("Cleaning up app cache...".to_string());
    if let Some(app_data_dir) = app.path().app_data_dir().ok() {
        // Remove specific files/dirs but keep auth.json
        let items_to_remove = vec!["logs", "cache", "tmp"];
        for item in items_to_remove {
            let path = app_data_dir.join(item);
            if path.exists() {
                let _ = if path.is_dir() {
                    fs::remove_dir_all(&path)
                } else {
                    fs::remove_file(&path)
                };
            }
        }
        cleanup_log.push("App cache cleared".to_string());
    }

    cleanup_log.push("Cleanup completed successfully!".to_string());
    Ok(cleanup_log.join("\n"))
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
                return Err(append_colima_runtime_hint(format!(
                    "Failed to start Colima: {}",
                    e
                )));
            }
            // Re-check status after starting
            status = runtime.check_status();
        }
    }

    if !status.docker_ready {
        if !status.docker_installed {
            return Err("Docker is not installed. Please install Docker to continue.".to_string());
        }
        return Err(append_colima_runtime_hint(
            "Docker is not running. Please ensure Docker is started.".to_string(),
        ));
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
    let is_empty = key.is_empty();
    let mut keys = state.api_keys.lock().map_err(|e| e.to_string())?;
    if is_empty {
        keys.remove(&provider);
    } else {
        keys.insert(provider.clone(), key);
    }
    let mut active = state.active_provider.lock().map_err(|e| e.to_string())?;
    if !is_empty {
        *active = Some(provider.clone());
    }
    let mut stored = load_auth(&app);
    stored.keys = keys.clone();
    stored.active_provider = active.clone();
    if is_empty {
        stored.oauth_metadata.remove(&provider);
    }
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
pub async fn start_gateway(app: AppHandle, state: State<'_, AppState>, model: Option<String>) -> Result<(), String> {
    let startup_started = Instant::now();
    let _start_guard = gateway_start_lock().lock().await;
    // Get API keys from state
    let api_keys = state.api_keys.lock().map_err(|e| e.to_string())?.clone();
    let active_provider = state
        .active_provider
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    let settings = load_agent_settings(&app);
    let bridge_mode_active = settings.bridge_enabled && has_paired_bridge_devices(&settings);
    let gateway_bind = if bridge_mode_active {
        "0.0.0.0:19789:18789"
    } else {
        "127.0.0.1:19789:18789"
    };
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
        if matches!(Platform::detect(), Platform::MacOS)
            && status.colima_installed
            && !status.vm_running
        {
            // Auto-start Colima on macOS if installed
            runtime.start_colima().map_err(|e| {
                append_colima_runtime_hint(format!("Failed to start Colima: {}", e))
            })?;
        } else if !status.docker_installed {
            let install_msg = match Platform::detect() {
                Platform::Linux => "Docker is not installed. Please install Docker Engine: sudo apt install docker.io",
                Platform::MacOS => "Docker is not installed. Please install Docker Desktop for development.",
                Platform::Windows => "Docker is not installed. Please install Docker Desktop for Windows.",
            };
            return Err(install_msg.to_string());
        } else {
            return Err(append_colima_runtime_hint(
                "Docker is not running. Please start Docker and try again.".to_string(),
            ));
        }
    }
    println!(
        "[Entropic] Startup timing: runtime_ready={}ms",
        startup_started.elapsed().as_millis()
    );

    let gateway_token = expected_gateway_token(&app)?;

    let has_any_local_api_key = api_keys.contains_key("anthropic")
        || api_keys.contains_key("openai")
        || api_keys.contains_key("google");
    if !has_any_local_api_key {
        return Err(
            "No local API key configured. Add an Anthropic/OpenAI/Google key in Settings, or sign in and disable 'Use Local Keys'."
                .to_string(),
        );
    }

    // Resolve model early so we can compare against the running container.
    // Use the model passed from frontend if provided, otherwise fall back based on active provider
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

    // Parse model string: "provider/model-id:param" -> base model + optional params
    // Supported suffixes: ":thinking" (Anthropic), ":reasoning=level" (OpenAI)
    let (base_model, model_params) = if let Some(colon_pos) = model_full.find(':') {
        (&model_full[..colon_pos], Some(&model_full[colon_pos + 1..]))
    } else {
        (model_full.as_str(), None)
    };

    // Derive thinking / reasoning env vars from suffix
    let thinking_enabled = model_params == Some("thinking");
    let reasoning_effort = model_params
        .and_then(|p| p.strip_prefix("reasoning="))
        .unwrap_or("");

    cleanup_legacy_gateway_artifacts();

    // Check if gateway container is already running with matching config
    if named_gateway_container_exists(OPENCLAW_CONTAINER, true) {
        let current_gateway_token = read_container_env("OPENCLAW_GATEWAY_TOKEN");
        let current_schema = read_container_env("ENTROPIC_GATEWAY_SCHEMA_VERSION");
        let current_model = read_container_env("OPENCLAW_MODEL");
        let current_proxy_mode = read_container_env("ENTROPIC_PROXY_MODE");
        // Check legacy environment variable for backward compatibility during migration
        let legacy_proxy_mode = read_container_env("NOVA_PROXY_MODE");
        // Check if the Anthropic auth type matches (OAuth token vs API key)
        let has_oauth_token = read_container_env("ANTHROPIC_OAUTH_TOKEN").is_some();
        let wants_oauth_token = api_keys.get("anthropic").map_or(false, |k| k.starts_with("sk-ant-oat01-"));
        let auth_type_matches = has_oauth_token == wants_oauth_token;
        // Only reuse the running container if token, schema, model, and auth type all match
        // AND the container isn't a stale proxy-mode instance (start_gateway = local keys).
        // Check both new and legacy proxy mode env vars to properly detect old containers
        let is_proxy_container = current_proxy_mode.as_deref() == Some("1")
            || legacy_proxy_mode.as_deref() == Some("1");
        if !is_proxy_container
            && auth_type_matches
            && current_gateway_token.as_deref() == Some(gateway_token.as_str())
            && current_schema.as_deref() == Some(ENTROPIC_GATEWAY_SCHEMA_VERSION)
            && current_model.as_deref() == Some(base_model)
        {
            apply_agent_settings(&app, &state)?;
            start_scanner_sidecar_background();
            return Ok(());
        }

        // Container config doesn't match — recreate it.
        let _ = docker_command()
            .args(["rm", "-f", OPENCLAW_CONTAINER])
            .output();
    }

    // Check if container exists but stopped
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

    // Create network if it doesn't exist
    let _ = docker_command()
        .args(["network", "create", OPENCLAW_NETWORK])
        .output();

    // Ensure runtime image is available
    let image_started = Instant::now();
    ensure_runtime_image()?;
    println!(
        "[Entropic] Startup timing: runtime_image_ready={}ms",
        image_started.elapsed().as_millis()
    );

    // Resolve thinking level from model suffix for openclaw.json thinkingDefault
    let thinking_level = if thinking_enabled {
        "high"
    } else if !reasoning_effort.is_empty() {
        reasoning_effort // "low", "medium", "high", "xhigh"
    } else {
        "off"
    };

    // Build docker run command - pass API keys as env vars
    let mut env_entries: Vec<(&str, &str)> = vec![
        ("OPENCLAW_GATEWAY_TOKEN", gateway_token.as_str()),
        ("ENTROPIC_GATEWAY_SCHEMA_VERSION", ENTROPIC_GATEWAY_SCHEMA_VERSION),
        // OPENCLAW_MODEL is read by apply_agent_settings to write openclaw.json config.
        // Keep base model and pass reasoning/thinking separately.
        ("OPENCLAW_MODEL", base_model),
        ("OPENCLAW_MEMORY_SLOT", memory_slot),
        // ENTROPIC_THINKING_LEVEL is read by apply_agent_settings to set thinkingDefault in config
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

    // Anthropic: use ANTHROPIC_OAUTH_TOKEN for OAuth tokens (sk-ant-oat01-...), ANTHROPIC_API_KEY for regular keys
    if let Some(key) = api_keys.get("anthropic") {
        if key.starts_with("sk-ant-oat01-") {
            env_entries.push(("ANTHROPIC_OAUTH_TOKEN", key.as_str()));
        } else {
            env_entries.push(("ANTHROPIC_API_KEY", key.as_str()));
        }
    }
    // OpenAI: regular API key (Codex OAuth handled via auth-profiles.json in apply_agent_settings)
    if let Some(key) = api_keys.get("openai") {
        // JWT tokens from Codex OAuth are NOT valid as OPENAI_API_KEY;
        // they need to be in auth-profiles.json as openai-codex credentials.
        // Only set OPENAI_API_KEY for regular sk- keys.
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

    // Add remaining args (always use bridge networking)
    docker_args.extend([
        "-v".to_string(),
        openclaw_data_volume_mount(),
        "--network".to_string(),
        OPENCLAW_NETWORK.to_string(),
        "-p".to_string(),
        gateway_bind.to_string(),
        "openclaw-runtime:latest".to_string(),
    ]);

    // Dev-only: bind-mount local OpenClaw dist/extensions to avoid image rebuilds
    if let Ok(source) = std::env::var("ENTROPIC_DEV_OPENCLAW_SOURCE") {
        if !source.trim().is_empty() {
            docker_args.push("-v".to_string());
            docker_args.push(format!("{}/dist:/app/dist:ro", source));
            docker_args.push("-v".to_string());
            docker_args.push(format!("{}/extensions:/app/extensions:ro", source));
        }
    }

    // Create and start container with hardened settings
    println!("[Entropic] Starting gateway container with model: {}", model_full);
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

    // Apply persisted settings to the fresh container
    let settings_started = Instant::now();
    apply_agent_settings(&app, &state)?;
    println!(
        "[Entropic] Startup timing: post_launch_config={}ms",
        settings_started.elapsed().as_millis()
    );

    let health_started = Instant::now();
    recover_gateway_health(&gateway_token, &docker_args, "Gateway", &app, &state).await?;
    // Re-apply settings AFTER health check passes.
    // OpenClaw's initialization may overwrite files we wrote earlier (e.g., auth-profiles.json
    // and config fields like thinkingDefault). Re-applying now ensures our settings stick.
    {
        let mut cache = applied_agent_settings_fingerprint()
            .lock()
            .map_err(|e| e.to_string())?;
        *cache = None;
    }
    apply_agent_settings(&app, &state)?;
    println!("[Entropic] Startup timing: post_health_config applied");
    start_scanner_sidecar_background();
    println!(
        "[Entropic] Startup timing: health={}ms total={}ms",
        health_started.elapsed().as_millis(),
        startup_started.elapsed().as_millis()
    );

    Ok(())
}

#[tauri::command]
pub async fn stop_gateway() -> Result<(), String> {
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

    Ok(())
}

/// Start gateway using the Entropic proxy (for users without their own API keys)
#[tauri::command]
pub async fn start_gateway_with_proxy(
    app: AppHandle,
    state: State<'_, AppState>,
    gateway_token: String,
    proxy_url: String,
    model: String,
    image_model: Option<String>,
) -> Result<(), String> {
    let startup_started = Instant::now();
    let _start_guard = gateway_start_lock().lock().await;
    cleanup_legacy_gateway_artifacts();
    let settings = load_agent_settings(&app);
    let bridge_mode_active = settings.bridge_enabled && has_paired_bridge_devices(&settings);
    let gateway_bind = if bridge_mode_active {
        "0.0.0.0:19789:18789"
    } else {
        "127.0.0.1:19789:18789"
    };
    let resolved_proxy_url = resolve_container_proxy_base(&proxy_url)?;
    let docker_proxy_api_url = resolve_container_openai_base(&resolved_proxy_url);
    // Ensure runtime (Colima) is running on macOS
    let runtime = get_runtime(&app);
    let status = runtime.check_status();
    if !status.docker_ready {
        if matches!(Platform::detect(), Platform::MacOS)
            && status.colima_installed
            && !status.vm_running
        {
            runtime.start_colima().map_err(|e| {
                append_colima_runtime_hint(format!("Failed to start Colima: {}", e))
            })?;
        } else if !status.docker_installed {
            return Err("Docker is not installed. Please install Docker to continue.".to_string());
        } else {
            return Err(append_colima_runtime_hint(
                "Docker is not running. Please start Docker and try again.".to_string(),
            ));
        }
    }
    println!(
        "[Entropic] Startup timing (proxy): runtime_ready={}ms",
        startup_started.elapsed().as_millis()
    );
    let local_gateway_token = expected_gateway_token(&app)?;
    let build_proxy_docker_args = || -> Result<(Vec<String>, GatewayEnvFile), String> {
        let mut env_entries: Vec<(&str, &str)> = vec![
            ("OPENCLAW_GATEWAY_TOKEN", local_gateway_token.as_str()),
            ("ENTROPIC_GATEWAY_SCHEMA_VERSION", ENTROPIC_GATEWAY_SCHEMA_VERSION),
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

    // Check if container is already running
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
            apply_agent_settings(&app, &state)?;
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
                &app,
                &state,
            )
            .await?;
            println!(
                "[Entropic] Startup timing (proxy): health={}ms total={}ms",
                health_started.elapsed().as_millis(),
                startup_started.elapsed().as_millis()
            );
            start_scanner_sidecar_background();
            return Ok(());
        }

        if !token_matches {
            println!("[Entropic] OPENROUTER_API_KEY changed; tearing down proxy container to apply new credentials.");
        }
        // Remove running container to ensure proxy config/model updates take effect
        let _ = docker_command()
            .args(["rm", "-f", OPENCLAW_CONTAINER])
            .output();
    }

    // Check if container exists but stopped - remove it to recreate with new config
    let any_filter = format!("name={}", OPENCLAW_CONTAINER);
    let check_all = docker_command()
        .args(["ps", "-aq", "-f", any_filter.as_str()])
        .output()
        .map_err(|e| format!("Failed to check container: {}", e))?;

    if !check_all.stdout.is_empty() {
        // Remove existing container to recreate with new proxy config
        let _ = docker_command()
            .args(["rm", "-f", OPENCLAW_CONTAINER])
            .output();
    }

    // Create network if it doesn't exist
    let _ = docker_command()
        .args(["network", "create", OPENCLAW_NETWORK])
        .output();

    // Ensure runtime image is available (load from bundle or pull from registry)
    let image_started = Instant::now();
    ensure_runtime_image()?;
    println!(
        "[Entropic] Startup timing (proxy): runtime_image_ready={}ms",
        image_started.elapsed().as_millis()
    );
    let (docker_args, _proxy_env_file) = build_proxy_docker_args()?;

    // Create and start container
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
            println!("[Entropic] Existing container conflict detected; attempting cleanup and retry.");
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

    // Apply persisted settings
    let settings_started = Instant::now();
    apply_agent_settings(&app, &state)?;
    println!(
        "[Entropic] Startup timing (proxy): post_launch_config={}ms",
        settings_started.elapsed().as_millis()
    );

    let health_started = Instant::now();
    recover_gateway_health(
        &local_gateway_token,
        &docker_args,
        "Proxy gateway",
        &app,
        &state,
    )
    .await?;
    // Re-apply settings AFTER health check passes.
    // OpenClaw initialization can overwrite files written during startup
    // (including openclaw.json provider baseUrl), so apply again once healthy.
    {
        let mut cache = applied_agent_settings_fingerprint()
            .lock()
            .map_err(|e| e.to_string())?;
        *cache = None;
    }
    apply_agent_settings(&app, &state)?;
    println!("[Entropic] Startup timing (proxy): post_health_config applied");
    start_scanner_sidecar_background();
    println!(
        "[Entropic] Startup timing (proxy): health={}ms total={}ms",
        health_started.elapsed().as_millis(),
        startup_started.elapsed().as_millis()
    );

    Ok(())
}

/// Hot-swap the model in openclaw.json without restarting the container.
/// Only works for same-provider changes (API keys stay the same).
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
pub async fn restart_gateway(app: AppHandle, state: State<'_, AppState>, model: Option<String>) -> Result<(), String> {
    // Stop and remove existing container (to pick up new env vars)
    for name in [OPENCLAW_CONTAINER, LEGACY_OPENCLAW_CONTAINER] {
        let _ = docker_command().args(["stop", name]).output();
        let _ = docker_command().args(["rm", "-f", name]).output();
    }

    // Start with current API keys
    start_gateway(app, state, model).await
}

#[tauri::command]
pub async fn get_gateway_status(app: AppHandle) -> Result<bool, String> {
    // Check if container is running
    if !gateway_container_exists(true) {
        println!("[Entropic] Container not running");
        return Ok(false);
    }

    let ws_url = gateway_ws_url();
    let token = effective_gateway_token(&app)?;

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

    if let Some(health_status) = container_health_status() {
        println!("[Entropic] Container health status: {}", health_status);
        if health_status == "healthy" || health_status == "starting" {
            println!(
                "[Entropic] Gateway WS probe failed after retries while container health is {}; reporting not running until WS recovers.",
                health_status
            );
        }
    }

    if !container_running() {
        println!("[Entropic] Container stopped while checking gateway health");
        return Ok(false);
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
pub async fn get_agent_profile_state(app: AppHandle) -> Result<AgentProfileState, String> {
    let stored = load_agent_settings(&app);
    let soul = read_container_file(&workspace_file("SOUL.md")).unwrap_or_default();
    let heartbeat_raw = read_container_file(&workspace_file("HEARTBEAT.md")).unwrap_or_default();
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
    let memory_sessions_enabled = stored.memory_sessions_enabled;

    let imessage_cfg = cfg.get("channels").and_then(|v| v.get("imessage"));
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
    let telegram_dm_policy = telegram_cfg
        .and_then(|v| v.get("dmPolicy"))
        .and_then(|v| v.as_str())
        .unwrap_or(&stored.telegram_dm_policy);
    let telegram_dm_policy = match telegram_dm_policy {
        "pairing" | "allowlist" | "open" | "disabled" => telegram_dm_policy.to_string(),
        _ => "pairing".to_string(),
    };
    let telegram_group_policy = telegram_cfg
        .and_then(|v| v.get("groupPolicy"))
        .and_then(|v| v.as_str())
        .unwrap_or(&stored.telegram_group_policy);
    let telegram_group_policy = match telegram_group_policy {
        "allowlist" | "open" | "disabled" => telegram_group_policy.to_string(),
        _ => "allowlist".to_string(),
    };
    let telegram_config_writes = telegram_cfg
        .and_then(|v| v.get("configWrites"))
        .and_then(|v| v.as_bool())
        .unwrap_or(stored.telegram_config_writes);
    let telegram_require_mention = telegram_cfg
        .and_then(|v| v.get("groups"))
        .and_then(|v| v.get("*"))
        .and_then(|v| v.get("requireMention"))
        .and_then(|v| v.as_bool())
        .unwrap_or(stored.telegram_require_mention);
    let telegram_reply_to_mode = telegram_cfg
        .and_then(|v| v.get("replyToMode"))
        .and_then(|v| v.as_str())
        .unwrap_or(&stored.telegram_reply_to_mode);
    let telegram_reply_to_mode = match telegram_reply_to_mode {
        "off" | "first" | "all" => telegram_reply_to_mode.to_string(),
        _ => "off".to_string(),
    };
    let telegram_link_preview = telegram_cfg
        .and_then(|v| v.get("linkPreview"))
        .and_then(|v| v.as_bool())
        .unwrap_or(stored.telegram_link_preview);

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
    let bridge_enabled = stored.bridge_enabled;
    let bridge_tailnet_ip = stored.bridge_tailnet_ip.clone();
    let bridge_port = stored.bridge_port;
    let bridge_pairing_expires_at_ms = stored.bridge_pairing_expires_at_ms;
    let bridge_device_id = stored.bridge_device_id.clone();
    let bridge_device_name = stored.bridge_device_name.clone();
    let bridge_devices = bridge_device_summaries(&stored);
    let bridge_device_count = bridge_devices.len();
    let bridge_online_count = bridge_devices
        .iter()
        .filter(|device| device.is_online)
        .count();
    let bridge_paired = bridge_enabled && bridge_device_count > 0;
    let tools = read_container_file(&workspace_file("TOOLS.md")).unwrap_or_default();
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
        heartbeat_every,
        heartbeat_tasks: final_tasks,
        memory_enabled,
        memory_long_term: if memory_slot == "none" {
            false
        } else {
            memory_long_term
        },
        memory_sessions_enabled,
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
pub async fn set_heartbeat(
    app: AppHandle,
    every: String,
    tasks: Vec<String>,
) -> Result<(), String> {
    let mut cfg = read_openclaw_config();
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
    apply_default_qmd_memory_config(&mut cfg, slot, memory_sessions_enabled);

    write_openclaw_config(&cfg)?;
    settings.memory_enabled = memory_enabled;
    settings.memory_long_term = long_term;
    save_agent_settings(&app, settings)?;
    Ok(())
}

#[tauri::command]
pub async fn set_memory_session_indexing(app: AppHandle, enabled: bool) -> Result<(), String> {
    let mut settings = load_agent_settings(&app);
    let mut cfg = read_openclaw_config();
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
    apply_default_qmd_memory_config(&mut cfg, &slot, enabled);
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
    let mut body = String::from("# IDENTITY.md - Who Am I?\n\n");
    body.push_str(&format!("- **Name:** {}\n", name.trim()));
    body.push_str("- **Creature:**\n- **Vibe:**\n- **Emoji:**\n");
    if let Some(ref url) = avatar_data_url {
        body.push_str(&format!("- **Avatar:** {}\n", url));
    } else {
        body.push_str("- **Avatar:**\n");
    }
    write_container_file(&workspace_file("IDENTITY.md"), &body)?;
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

    set_openclaw_config_value(
        &mut cfg,
        &["channels", "imessage", "enabled"],
        serde_json::json!(enabled),
    );
    set_openclaw_config_value(
        &mut cfg,
        &["channels", "imessage", "cliPath"],
        serde_json::json!(cli),
    );
    set_openclaw_config_value(
        &mut cfg,
        &["channels", "imessage", "dbPath"],
        serde_json::json!(db),
    );
    set_openclaw_config_value(
        &mut cfg,
        &["channels", "imessage", "includeAttachments"],
        serde_json::json!(include_attachments),
    );
    set_openclaw_config_value(
        &mut cfg,
        &["channels", "imessage", "dmPolicy"],
        serde_json::json!("pairing"),
    );
    set_openclaw_config_value(
        &mut cfg,
        &["channels", "imessage", "groupPolicy"],
        serde_json::json!("allowlist"),
    );
    set_openclaw_config_value(
        &mut cfg,
        &["channels", "imessage", "configWrites"],
        serde_json::json!(false),
    );
    if remote.is_empty() {
        remove_openclaw_config_value(&mut cfg, &["channels", "imessage", "remoteHost"]);
    } else {
        set_openclaw_config_value(
            &mut cfg,
            &["channels", "imessage", "remoteHost"],
            serde_json::json!(remote),
        );
    }
    set_openclaw_config_value(
        &mut cfg,
        &["plugins", "entries", "imessage", "enabled"],
        serde_json::json!(enabled),
    );

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
    eprintln!("[set_channels_config] OpenClaw config read successfully");

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
        &["channels", "discord", "enabled"],
        serde_json::json!(discord_enabled),
    );
    set_openclaw_config_value(
        &mut cfg,
        &["channels", "discord", "token"],
        serde_json::json!(discord_token),
    );
    set_openclaw_config_value(
        &mut cfg,
        &["channels", "discord", "groupPolicy"],
        serde_json::json!("allowlist"),
    );
    set_openclaw_config_value(
        &mut cfg,
        &["channels", "discord", "configWrites"],
        serde_json::json!(false),
    );
    set_openclaw_config_value(
        &mut cfg,
        &["plugins", "entries", "discord", "enabled"],
        serde_json::json!(discord_enabled),
    );

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

    set_openclaw_config_value(
        &mut cfg,
        &["channels", "slack", "enabled"],
        serde_json::json!(slack_enabled),
    );
    set_openclaw_config_value(
        &mut cfg,
        &["channels", "slack", "botToken"],
        serde_json::json!(slack_bot_token),
    );
    set_openclaw_config_value(
        &mut cfg,
        &["channels", "slack", "appToken"],
        serde_json::json!(slack_app_token),
    );
    set_openclaw_config_value(
        &mut cfg,
        &["channels", "slack", "dm", "policy"],
        serde_json::json!("pairing"),
    );
    set_openclaw_config_value(
        &mut cfg,
        &["channels", "slack", "groupPolicy"],
        serde_json::json!("allowlist"),
    );
    set_openclaw_config_value(
        &mut cfg,
        &["channels", "slack", "configWrites"],
        serde_json::json!(false),
    );
    remove_openclaw_config_value(&mut cfg, &["channels", "slack", "dmPolicy"]);
    set_openclaw_config_value(
        &mut cfg,
        &["plugins", "entries", "slack", "enabled"],
        serde_json::json!(slack_enabled),
    );

    set_openclaw_config_value(
        &mut cfg,
        &["channels", "googlechat", "enabled"],
        serde_json::json!(googlechat_enabled),
    );
    set_openclaw_config_value(
        &mut cfg,
        &["channels", "googlechat", "audienceType"],
        serde_json::json!(googlechat_audience_type),
    );
    set_openclaw_config_value(
        &mut cfg,
        &["channels", "googlechat", "webhookPath"],
        serde_json::json!("/googlechat"),
    );
    set_openclaw_config_value(
        &mut cfg,
        &["channels", "googlechat", "dm", "policy"],
        serde_json::json!("pairing"),
    );
    set_openclaw_config_value(
        &mut cfg,
        &["channels", "googlechat", "groupPolicy"],
        serde_json::json!("allowlist"),
    );
    if googlechat_service_account.is_empty() {
        remove_openclaw_config_value(&mut cfg, &["channels", "googlechat", "serviceAccount"]);
    } else {
        set_openclaw_config_value(
            &mut cfg,
            &["channels", "googlechat", "serviceAccount"],
            serde_json::json!(googlechat_service_account),
        );
    }
    if googlechat_audience.is_empty() {
        remove_openclaw_config_value(&mut cfg, &["channels", "googlechat", "audience"]);
    } else {
        set_openclaw_config_value(
            &mut cfg,
            &["channels", "googlechat", "audience"],
            serde_json::json!(googlechat_audience),
        );
    }
    set_openclaw_config_value(
        &mut cfg,
        &["plugins", "entries", "googlechat", "enabled"],
        serde_json::json!(googlechat_enabled),
    );

    set_openclaw_config_value(
        &mut cfg,
        &["channels", "whatsapp", "configWrites"],
        serde_json::json!(false),
    );
    set_openclaw_config_value(
        &mut cfg,
        &["channels", "whatsapp", "groupPolicy"],
        serde_json::json!("allowlist"),
    );
    remove_openclaw_config_value(&mut cfg, &["channels", "whatsapp", "enabled"]);
    if whatsapp_allow_from.is_empty() {
        set_openclaw_config_value(
            &mut cfg,
            &["channels", "whatsapp", "dmPolicy"],
            serde_json::json!("pairing"),
        );
        remove_openclaw_config_value(&mut cfg, &["channels", "whatsapp", "allowFrom"]);
    } else {
        set_openclaw_config_value(
            &mut cfg,
            &["channels", "whatsapp", "dmPolicy"],
            serde_json::json!("allowlist"),
        );
        set_openclaw_config_value(
            &mut cfg,
            &["channels", "whatsapp", "allowFrom"],
            serde_json::json!([whatsapp_allow_from.clone()]),
        );
    }
    set_openclaw_config_value(
        &mut cfg,
        &["plugins", "entries", "whatsapp", "enabled"],
        serde_json::json!(whatsapp_enabled),
    );

    eprintln!("[set_channels_config] Writing OpenClaw config...");
    write_openclaw_config(&cfg)?;
    eprintln!("[set_channels_config] OpenClaw config written successfully");

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

    // Config is written to container. Changes will take effect on next gateway restart.
    // We don't auto-restart here because:
    // - In proxy mode, restart_gateway requires local keys which won't exist
    // - The user can manually restart via Dashboard or the app will auto-restart on next launch
    eprintln!("[set_channels_config] Channel config saved. Restart gateway to apply changes.");

    eprintln!("[set_channels_config] Completed successfully");
    Ok(())
}

#[tauri::command]
pub async fn approve_pairing(channel: String, code: String) -> Result<String, String> {
    eprintln!("[approve_pairing] Called with channel='{}', code length={}", channel, code.len());

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

    let bot = payload.get("result").cloned().unwrap_or_else(|| serde_json::json!({}));
    let bot_id = bot.get("id").and_then(|value| value.as_i64());
    let username = bot
        .get("username")
        .and_then(|value| value.as_str())
        .map(ToOwned::to_owned);
    let first_name = bot.get("first_name").and_then(|value| value.as_str()).unwrap_or("");
    let last_name = bot.get("last_name").and_then(|value| value.as_str()).unwrap_or("");
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
pub async fn restart_gateway_in_place() -> Result<(), String> {
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

    Ok(())
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
        return run_gateway_doctor_in_container(container, fix).map(|output| (output, Some(container)));
    }

    run_gateway_doctor_with_data_volume(fix).map(|output| (output, None))
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

    let has_invalid_config = combined.contains("Invalid config at") || combined.contains("Config invalid");
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
pub async fn start_whatsapp_login(
    force: bool,
    timeout_ms: Option<u64>,
    app: AppHandle,
) -> Result<WhatsAppLoginState, String> {
    let _ = timeout_ms;
    let token = effective_gateway_token(&app)?;
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
    let token = effective_gateway_token(&app)?;
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
    let file_name = temp_path.split('/').last().unwrap_or("file").to_string();
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
        let id = m
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if id.is_empty() {
            continue;
        }
        if !config_allows_plugin(&cfg, &id) {
            continue;
        }
        let kind = m
            .get("kind")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
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

        let managed =
            kind.as_deref() == Some("memory") || MANAGED_PLUGIN_IDS.contains(&id.as_str());

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
        return Err("Plugin is managed by Entropic".to_string());
    }
    let mut cfg = read_openclaw_config();
    set_openclaw_config_value(
        &mut cfg,
        &["plugins", "entries", &id, "enabled"],
        serde_json::json!(enabled),
    );
    write_openclaw_config(&cfg)
}

#[tauri::command]
pub async fn get_skill_store() -> Result<Vec<SkillInfo>, String> {
    let listing = collect_skill_ids()?;
    let mut out = Vec::new();

    for id in listing {
        let full_path = match resolve_installed_skill_dir(&id)? {
            Some(path) => path,
            None => continue,
        };
        let skill_md_path = format!("{}/SKILL.md", full_path);
        let raw = read_container_file(&skill_md_path).unwrap_or_default();
        let (name, description) = parse_skill_frontmatter(&raw);

        out.push(SkillInfo {
            id: id.clone(),
            name: name.unwrap_or_else(|| id.clone()),
            description: description.unwrap_or_else(|| "Workspace skill".to_string()),
            path: full_path,
            source: "User Skills".to_string(),
            scan: read_skill_scan_from_manifest(&id),
        });
    }

    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

#[tauri::command]
pub async fn remove_workspace_skill(id: String) -> Result<(), String> {
    let skill_id = id.trim().to_string();
    if !is_safe_component(&skill_id) {
        return Err("Invalid skill id".to_string());
    }
    if skill_id == "entropic-x" {
        return Err("Entropic-managed skills cannot be removed".to_string());
    }

    let mut config_removal_paths: Vec<String> = Vec::new();
    if let Ok(Some(path)) = resolve_installed_skill_dir(&skill_id) {
        config_removal_paths.push(path);
    }

    let observed_skill = collect_skill_ids()?.iter().any(|value| value == &skill_id)
        || container_dir_exists(&format!("{}/{}", SKILL_MANIFESTS_ROOT, skill_id)).unwrap_or(false)
        || container_path_exists_checked(&format!("{}/{}.json", SKILL_MANIFESTS_ROOT, skill_id))
            .unwrap_or(false);

    let mut remove_paths = vec![format!("{}/{}", SKILLS_ROOT, skill_id)];
    for legacy_root in LEGACY_SKILLS_ROOTS {
        remove_paths.push(format!(
            "{}/{}",
            legacy_root.trim_end_matches('/'),
            skill_id
        ));
    }
    remove_paths.push(format!("{}/{}", SKILL_MANIFESTS_ROOT, skill_id));
    remove_paths.push(format!("{}/{}.json", SKILL_MANIFESTS_ROOT, skill_id));

    let mut removed_any = false;
    for full_path in remove_paths {
        if container_path_exists_checked(&full_path).unwrap_or(false) {
            removed_any = true;
        }
        docker_exec_output(&["exec", OPENCLAW_CONTAINER, "rm", "-rf", "--", &full_path])?;
        if !config_removal_paths.contains(&full_path) {
            config_removal_paths.push(full_path);
        }
    }

    let mut cfg = read_openclaw_config();
    let mut config_updated = false;
    if cfg
        .pointer(&format!("/plugins/entries/{}", skill_id))
        .is_some()
    {
        remove_openclaw_config_value(&mut cfg, &["plugins", "entries", &skill_id]);
        config_updated = true;
    }
    if let Some(load_paths) = cfg
        .pointer_mut("/plugins/load/paths")
        .and_then(|v| v.as_array_mut())
    {
        let before_len = load_paths.len();
        load_paths.retain(|path| {
            let path_value = path.as_str().unwrap_or("");
            if path_value.is_empty() {
                return true;
            }

            !config_removal_paths.iter().any(|prefix| {
                let normalized_prefix = prefix.trim_end_matches('/');
                path_value == normalized_prefix
                    || path_value.starts_with(&format!("{}/", normalized_prefix))
            })
        });
        if load_paths.len() != before_len {
            config_updated = true;
        }
    }
    if config_updated {
        write_openclaw_config(&cfg)?;
    }

    if !observed_skill && !removed_any && !config_updated {
        return Err("Skill not found".to_string());
    }

    Ok(())
}

#[tauri::command]
pub async fn get_clawhub_catalog(
    query: Option<String>,
    limit: Option<u32>,
    sort: Option<String>,
) -> Result<Vec<ClawhubCatalogSkill>, String> {
    let query = query.unwrap_or_default().trim().to_string();
    let query_lower = query.to_lowercase();
    let max_results = limit.unwrap_or(40).clamp(1, 200);
    let fetch_limit = if query_lower.is_empty() {
        max_results
    } else {
        200
    };
    let fetch_limit_str = fetch_limit.to_string();
    let normalized_sort = match sort.as_deref().map(|v| v.trim()).unwrap_or("trending") {
        "newest" => "newest".to_string(),
        "downloads" => "downloads".to_string(),
        "rating" => "rating".to_string(),
        "installs" => "installs".to_string(),
        "installsAllTime" => "installsAllTime".to_string(),
        _ => "trending".to_string(),
    };

    let raw = match clawhub_exec_output(&[
        "explore",
        "--json",
        "--limit",
        fetch_limit_str.as_str(),
        "--sort",
        normalized_sort.as_str(),
    ]) {
        Ok(r) => r,
        Err(e) => {
            if e.to_lowercase().contains("rate limit") {
                let cache = CLAWHUB_CATALOG_CACHE
                    .get_or_init(|| Mutex::new(None))
                    .lock()
                    .unwrap();
                if let Some((cached, ts)) = cache.as_ref() {
                    if ts.elapsed() < Duration::from_secs(300) {
                        return Ok(cached.clone());
                    }
                }
                return Ok(featured_clawhub_skills());
            }
            return Err(e);
        }
    };
    let payload: serde_json::Value = parse_clawhub_json(&raw)?;
    let items = payload
        .get("items")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let mut out = Vec::new();
    for item in items {
        let slug = item
            .get("slug")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if !is_safe_slug(&slug) {
            continue;
        }
        let display_name = item
            .get("displayName")
            .and_then(|v| v.as_str())
            .unwrap_or(&slug)
            .trim()
            .to_string();
        let summary = item
            .get("summary")
            .and_then(|v| v.as_str())
            .unwrap_or("ClawHub skill")
            .trim()
            .to_string();
        let latest_version = item
            .get("latestVersion")
            .and_then(|v| v.get("version"))
            .and_then(|v| v.as_str())
            .or_else(|| {
                item.get("tags")
                    .and_then(|v| v.get("latest"))
                    .and_then(|v| v.as_str())
            })
            .map(|v| v.to_string());
        let downloads = item
            .get("stats")
            .and_then(|v| v.get("downloads"))
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        let installs_all_time = item
            .get("stats")
            .and_then(|v| v.get("installsAllTime"))
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        let stars = item
            .get("stats")
            .and_then(|v| v.get("stars"))
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        let updated_at = item.get("updatedAt").and_then(|v| v.as_u64());

        if !query_lower.is_empty() {
            let haystack = format!("{} {} {}", slug, display_name, summary).to_lowercase();
            if !haystack.contains(&query_lower) {
                continue;
            }
        }

        out.push(ClawhubCatalogSkill {
            slug,
            display_name,
            summary,
            latest_version,
            downloads,
            installs_all_time,
            stars,
            updated_at,
            is_fallback: false,
        });
    }

    if out.len() > max_results as usize {
        out.truncate(max_results as usize);
    }

    // Cache successful results for rate-limit fallback
    {
        let mut cache = CLAWHUB_CATALOG_CACHE
            .get_or_init(|| Mutex::new(None))
            .lock()
            .unwrap();
        *cache = Some((out.clone(), Instant::now()));
    }

    Ok(out)
}

#[tauri::command]
pub async fn get_clawhub_skill_details(slug: String) -> Result<ClawhubSkillDetails, String> {
    let skill_slug = slug.trim().to_string();
    if !is_safe_slug(&skill_slug) {
        return Err("Invalid skill slug".to_string());
    }

    let raw = clawhub_exec_output(&["inspect", skill_slug.as_str(), "--json"])?;
    let payload: serde_json::Value = parse_clawhub_json(&raw)?;
    let skill = payload
        .get("skill")
        .ok_or_else(|| "Malformed ClawHub inspect response: missing skill".to_string())?;

    let display_name = skill
        .get("displayName")
        .and_then(|v| v.as_str())
        .unwrap_or(skill_slug.as_str())
        .trim()
        .to_string();
    let summary = skill
        .get("summary")
        .and_then(|v| v.as_str())
        .unwrap_or("ClawHub skill")
        .trim()
        .to_string();
    let latest_version = payload
        .get("latestVersion")
        .and_then(|v| v.get("version"))
        .and_then(|v| v.as_str())
        .or_else(|| {
            skill
                .get("tags")
                .and_then(|v| v.get("latest"))
                .and_then(|v| v.as_str())
        })
        .map(|v| v.to_string());
    let changelog = payload
        .get("latestVersion")
        .and_then(|v| v.get("changelog"))
        .and_then(|v| v.as_str())
        .map(|v| v.to_string());
    let owner_handle = payload
        .get("owner")
        .and_then(|v| v.get("handle"))
        .and_then(|v| v.as_str())
        .map(|v| v.to_string());
    let owner_display_name = payload
        .get("owner")
        .and_then(|v| v.get("displayName"))
        .and_then(|v| v.as_str())
        .map(|v| v.to_string());
    let downloads = skill
        .get("stats")
        .and_then(|v| v.get("downloads"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let installs_all_time = skill
        .get("stats")
        .and_then(|v| v.get("installsAllTime"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let stars = skill
        .get("stats")
        .and_then(|v| v.get("stars"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let updated_at = skill.get("updatedAt").and_then(|v| v.as_u64());

    Ok(ClawhubSkillDetails {
        slug: skill_slug,
        display_name,
        summary,
        latest_version,
        changelog,
        owner_handle,
        owner_display_name,
        downloads,
        installs_all_time,
        stars,
        updated_at,
    })
}

fn scanner_unavailable_result() -> PluginScanResult {
    PluginScanResult {
        scan_id: None,
        is_safe: true,
        max_severity: "UNKNOWN".to_string(),
        findings_count: 0,
        findings: vec![],
        scanner_available: false,
    }
}

#[tauri::command]
pub async fn scan_plugin(id: String) -> Result<PluginScanResult, String> {
    let plugin_id = id.trim().to_string();
    if !is_safe_component(&plugin_id) {
        return Err("Invalid plugin id".to_string());
    }

    start_scanner_sidecar();
    if !scanner_running()? {
        return Ok(scanner_unavailable_result());
    }

    let mut source_dir = format!("/app/extensions/{}", plugin_id);
    let mut exists = docker_command()
        .args(["exec", OPENCLAW_CONTAINER, "test", "-d", &source_dir])
        .output()
        .map_err(|e| format!("Failed to inspect plugin directory: {}", e))?
        .status
        .success();

    if !exists {
        if let Some(skills_root) = read_container_env("ENTROPIC_SKILLS_PATH") {
            let base = format!("{}/{}", skills_root.trim_end_matches('/'), plugin_id);
            let current = format!("{}/current", base);
            let candidate = if container_path_exists(&current) {
                current
            } else {
                base
            };
            let candidate_exists = docker_command()
                .args(["exec", OPENCLAW_CONTAINER, "test", "-d", &candidate])
                .output()
                .map_err(|e| format!("Failed to inspect plugin directory: {}", e))?
                .status
                .success();
            if candidate_exists {
                source_dir = candidate;
                exists = true;
            }
        }
    }

    if !exists {
        return Err("Plugin directory not found".to_string());
    }

    let scanner_dir = format!("/tmp/entropic-scan/plugins/{}", plugin_id);
    clone_dir_from_openclaw_to_scanner(&source_dir, &scanner_dir)?;
    scan_directory_with_scanner(&scanner_dir).await
}

#[tauri::command]
pub async fn scan_workspace_skill(id: String) -> Result<PluginScanResult, String> {
    let skill_id = id.trim().to_string();
    if !is_safe_component(&skill_id) {
        return Err("Invalid skill id".to_string());
    }

    start_scanner_sidecar();
    if !scanner_running()? {
        return Ok(scanner_unavailable_result());
    }

    let source_dir = resolve_installed_skill_dir(&skill_id)?
        .ok_or_else(|| "Skill directory not found".to_string())?;

    let scanner_dir = format!("/tmp/entropic-scan/workspace-skills/{}", skill_id);
    clone_dir_from_openclaw_to_scanner(&source_dir, &scanner_dir)?;
    scan_directory_with_scanner(&scanner_dir).await
}

fn resolve_downloaded_skill_path(temp_root: &str, slug: &str) -> Result<(String, String), String> {
    let slug_tail = slug
        .split('/')
        .last()
        .map(|v| v.trim())
        .filter(|v| !v.is_empty())
        .ok_or_else(|| "Invalid skill slug".to_string())?;
    if !is_safe_component(slug_tail) {
        return Err("Invalid skill slug".to_string());
    }

    let candidate = format!("{}/skills/{}", temp_root, slug_tail);
    let candidate_exists = docker_command()
        .args(["exec", OPENCLAW_CONTAINER, "test", "-d", &candidate])
        .output()
        .map_err(|e| format!("Failed to inspect downloaded skill: {}", e))?
        .status
        .success();
    if candidate_exists {
        return Ok((candidate, slug_tail.to_string()));
    }

    let listing = docker_exec_output(&[
        "exec",
        OPENCLAW_CONTAINER,
        "ls",
        "-1",
        "--",
        &format!("{}/skills", temp_root),
    ])?;
    for line in listing.lines() {
        let id = line.trim();
        if !is_safe_component(id) {
            continue;
        }
        let path = format!("{}/skills/{}", temp_root, id);
        let exists = docker_command()
            .args(["exec", OPENCLAW_CONTAINER, "test", "-d", &path])
            .output()
            .map_err(|e| format!("Failed to inspect downloaded skill: {}", e))?
            .status
            .success();
        if exists {
            return Ok((path, id.to_string()));
        }
    }

    Err("Downloaded skill directory not found".to_string())
}

#[tauri::command]
pub async fn scan_and_install_clawhub_skill(
    app: AppHandle,
    state: State<'_, AppState>,
    slug: String,
    allow_unsafe: bool,
) -> Result<ClawhubInstallResult, String> {
    let trimmed_slug = slug.trim().to_string();
    if !is_safe_slug(&trimmed_slug) {
        return Err("Invalid skill slug".to_string());
    }

    start_scanner_sidecar();
    if !scanner_running()? {
        return Ok(ClawhubInstallResult {
            scan: scanner_unavailable_result(),
            installed: false,
            blocked: false,
            message: Some("Scanner unavailable".to_string()),
            installed_skill_id: None,
        });
    }

    let temp_root = format!("/tmp/entropic-clawhub-scan-{}", unique_id());
    docker_exec_output(&[
        "exec",
        OPENCLAW_CONTAINER,
        "mkdir",
        "-p",
        "--",
        &format!("{}/skills", temp_root),
    ])?;

    let cleanup = |root: &str| {
        let _ = docker_exec_output(&["exec", OPENCLAW_CONTAINER, "rm", "-rf", "--", root]);
    };

    let fetch_result = clawhub_exec_with_retry(&[
        "install",
        &trimmed_slug,
        "--workdir",
        &temp_root,
        "--dir",
        "skills",
        "--no-input",
        "--force",
    ], 3)
    .map_err(|e| format!("Failed to run ClawHub install: {}", e))?;

    if !fetch_result.status.success() {
        cleanup(&temp_root);
        return Err(format!(
            "ClawHub install failed: {}",
            command_output_error(&fetch_result)
        ));
    }

    let (downloaded_path, detected_skill_id) =
        match resolve_downloaded_skill_path(&temp_root, &trimmed_slug) {
            Ok(value) => value,
            Err(err) => {
                cleanup(&temp_root);
                return Err(err);
            }
        };
    let scanner_dir = format!("/tmp/entropic-scan/clawhub/{}", detected_skill_id);
    if let Err(err) = clone_dir_from_openclaw_to_scanner(&downloaded_path, &scanner_dir) {
        cleanup(&temp_root);
        return Err(err);
    }
    let scan = match scan_directory_with_scanner(&scanner_dir).await {
        Ok(value) => value,
        Err(err) => {
            cleanup(&temp_root);
            return Err(err);
        }
    };

    if !scan.is_safe
        && scan.scanner_available
        && (scan.max_severity == "CRITICAL" || scan.max_severity == "HIGH")
        && !allow_unsafe
    {
        cleanup(&temp_root);
        return Ok(ClawhubInstallResult {
            scan,
            installed: false,
            blocked: true,
            message: Some("Installation blocked due to high-severity findings".to_string()),
            installed_skill_id: Some(detected_skill_id),
        });
    }

    // Resolve version — try the API but fall back to "latest" on rate-limit.
    let skill_version = clawhub_latest_version(&trimmed_slug)
        .ok()
        .flatten()
        .unwrap_or_else(|| "latest".to_string());

    // Copy the already-downloaded skill from the temp scan dir to the final
    // location instead of re-downloading from ClawHub (avoids a second API
    // call and the rate-limit that comes with it).
    let final_skill_dir = format!("{}/{}/{}", SKILLS_ROOT, detected_skill_id, skill_version);
    let copy_script = format!(
        "mkdir -p {} && cp -a {}/. {}",
        sh_single_quote(&final_skill_dir),
        sh_single_quote(downloaded_path.trim_end_matches('/')),
        sh_single_quote(&final_skill_dir),
    );
    if let Err(err) = docker_exec_output(&[
        "exec",
        OPENCLAW_CONTAINER,
        "sh",
        "-c",
        &copy_script,
    ]) {
        cleanup(&temp_root);
        return Err(format!("Failed to install skill from scan cache: {}", err));
    }

    cleanup(&temp_root);

    let skill_family_root = format!("{}/{}", SKILLS_ROOT, detected_skill_id);
    let current_link = format!("{}/current", skill_family_root);
    let _ = docker_exec_output(&[
        "exec",
        OPENCLAW_CONTAINER,
        "sh",
        "-c",
        &format!(
            "mkdir -p -- {} && ln -sfn {} {}",
            sh_single_quote(&skill_family_root),
            sh_single_quote(&skill_version),
            sh_single_quote(&current_link)
        ),
    ]);

    let installed_version_root = format!("{}/{}/{}", SKILLS_ROOT, detected_skill_id, skill_version);
    let installed_skill_path = match resolve_skill_root_in_container(
        OPENCLAW_CONTAINER,
        &installed_version_root,
        Some(&detected_skill_id),
    ) {
        Ok(Some(path)) => path,
        Ok(None) => installed_version_root.clone(),
        Err(err) => {
            eprintln!(
                "[Entropic] Failed to resolve installed skill root for {}: {}",
                detected_skill_id, err
            );
            installed_version_root.clone()
        }
    };
    let installed_skill_md =
        read_container_file(&format!("{}/SKILL.md", installed_skill_path)).unwrap_or_default();

    // Mirror the active skill into workspace/skills so OpenClaw's native skills
    // loader can discover it for chat runs.
    let workspace_skills_root = format!("{}/skills", WORKSPACE_ROOT);
    let workspace_skill_path = format!("{}/{}", workspace_skills_root, detected_skill_id);
    let source_contents = format!("{}/.", installed_skill_path.trim_end_matches('/'));
    docker_exec_output(&[
        "exec",
        OPENCLAW_CONTAINER,
        "mkdir",
        "-p",
        "--",
        &workspace_skills_root,
    ])
    .map_err(|e| format!("Failed to prepare workspace skills directory: {}", e))?;
    docker_exec_output(&[
        "exec",
        OPENCLAW_CONTAINER,
        "rm",
        "-rf",
        "--",
        &workspace_skill_path,
    ])
    .map_err(|e| format!("Failed to remove previous workspace skill copy: {}", e))?;
    docker_exec_output(&[
        "exec",
        OPENCLAW_CONTAINER,
        "mkdir",
        "-p",
        "--",
        &workspace_skill_path,
    ])
    .map_err(|e| format!("Failed to create workspace skill directory: {}", e))?;
    docker_exec_output(&[
        "exec",
        OPENCLAW_CONTAINER,
        "cp",
        "-a",
        "--",
        &source_contents,
        &workspace_skill_path,
    ])
    .map_err(|e| format!("Failed to sync installed skill into workspace: {}", e))?;

    let manifest_path = format!(
        "{}/{}/{}.json",
        SKILL_MANIFESTS_ROOT, detected_skill_id, skill_version
    );
    let tree_hash = compute_skill_tree_hash(&installed_skill_path);
    let scope_flags = infer_skill_scope_flags(&installed_skill_md);
    let manifest_skill_id = detected_skill_id.clone();
    let manifest_source_slug = trimmed_slug.clone();
    let manifest_version = skill_version.clone();
    let manifest_path_value = installed_skill_path.clone();
    let manifest = serde_json::json!({
        "schema": "entropic-skill-manifest/v1",
        "skill_id": manifest_skill_id,
        "source_slug": manifest_source_slug,
        "version": manifest_version,
        "installed_at_ms": current_millis(),
        "path": manifest_path_value,
        "scan_id": scan.scan_id,
        "integrity": {
            "sha256_tree": tree_hash,
            "signature": serde_json::Value::Null
        },
        "scopes": scope_flags,
        "scan": {
            "is_safe": scan.is_safe,
            "max_severity": scan.max_severity,
            "findings_count": scan.findings_count,
        }
    });
    write_container_file(
        &manifest_path,
        &serde_json::to_string_pretty(&manifest)
            .map_err(|e| format!("Failed to serialize skill manifest: {}", e))?,
    )?;

    // Hot-register the new skill in the runtime config so the chat agent
    // can discover it immediately without a full gateway restart.
    if let Err(e) = apply_agent_settings(&app, &state) {
        eprintln!(
            "[Entropic] Failed to apply agent settings after skill install: {}",
            e
        );
    }
    // OpenClaw can cache plugin/tool registry at process start. If the
    // gateway is running in local-keys mode, recreate it so newly installed
    // skills are loaded. Proxy-mode containers cannot be restarted this way
    // (no local keys available); apply_agent_settings above already
    // hot-registered the skill into the workspace config.
    let is_proxy_mode = read_container_env("ENTROPIC_PROXY_MODE").is_some();
    if container_running() && !is_proxy_mode {
        println!("[Entropic] Restarting gateway to load newly installed skill...");
        let _ = app.emit("gateway-restarting", ());
        if let Err(e) = restart_gateway(app.clone(), state, None).await {
            eprintln!(
                "[Entropic] Failed to restart gateway after skill install: {}",
                e
            );
        }
    }

    Ok(ClawhubInstallResult {
        scan,
        installed: true,
        blocked: false,
        message: None,
        installed_skill_id: Some(detected_skill_id),
    })
}

#[tauri::command]
pub async fn get_setup_progress(state: State<'_, AppState>) -> Result<SetupProgress, String> {
    let progress = state.setup_progress.lock().map_err(|e| e.to_string())?;
    Ok(progress.clone())
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
                    message: "Starting container runtime..."
                        .to_string(),
                    percent: 10,
                    complete: false,
                    error: None,
                };
            }

            // Start Colima in a background thread so we can monitor download progress
            let resources_dir = app.path().resource_dir().unwrap_or_default();
            let colima_result = std::sync::Arc::new(std::sync::Mutex::new(None::<Result<(), String>>));
            let colima_result_writer = colima_result.clone();
            let colima_thread = std::thread::spawn(move || {
                let rt = Runtime::new(resources_dir);
                let result = rt.start_colima().map_err(|e| format!("{}", e));
                *colima_result_writer.lock().unwrap() = Some(result);
            });

            // Monitor download progress while colima starts
            // Colima downloads VM image to ~/.cache/colima/caches/*.downloading
            let cache_dir = dirs::home_dir()
                .unwrap_or_default()
                .join(".cache/colima/caches");
            const EXPECTED_DOWNLOAD_SIZE: u64 = 280 * 1024 * 1024; // ~280MB qcow2

            loop {
                std::thread::sleep(std::time::Duration::from_millis(500));

                // Check if colima finished
                if colima_result.lock().unwrap().is_some() {
                    break;
                }

                // Check for .downloading files and report progress
                let download_size = std::fs::read_dir(&cache_dir)
                    .ok()
                    .map(|entries| {
                        entries
                            .filter_map(|e| e.ok())
                            .filter(|e| e.path().extension().map_or(false, |ext| ext == "downloading"))
                            .filter_map(|e| e.metadata().ok().map(|m| m.len()))
                            .max()
                            .unwrap_or(0)
                    })
                    .unwrap_or(0);

                let (message, percent) = if download_size > 0 {
                    let mb = download_size / (1024 * 1024);
                    let pct = std::cmp::min(
                        35,
                        10 + (download_size * 25 / EXPECTED_DOWNLOAD_SIZE) as u8,
                    );
                    (format!("Downloading VM image... ({} MB)", mb), pct)
                } else {
                    // No download file — either hasn't started or already finished
                    ("Starting container runtime...".to_string(), 10)
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

            // Collect the result
            let _ = colima_thread.join();
            let result = colima_result
                .lock()
                .unwrap()
                .take()
                .unwrap_or_else(|| Err("Colima thread did not produce a result".to_string()));

            if let Err(e) = result {
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
                        message: format!(
                            "Waiting for Docker to start ({}/{}s)...",
                            (i + 1) * 2,
                            max_retries * 2
                        ),
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

    // Defer runtime image check/pull to first launch so setup is fast.
    {
        let mut progress = state.setup_progress.lock().map_err(|e| e.to_string())?;
        *progress = SetupProgress {
            stage: "image".to_string(),
            message: "Deferring OpenClaw runtime check to first sandbox start...".to_string(),
            percent: 70,
            complete: false,
            error: None,
        };
    }

    tauri::async_runtime::spawn(async move {
        let preload_started = Instant::now();
        let preload = tokio::task::spawn_blocking(ensure_runtime_image).await;
        match preload {
            Ok(Ok(())) => {
                println!(
                    "[Entropic] Runtime image preload finished in {}ms",
                    preload_started.elapsed().as_millis()
                );
            }
            Ok(Err(e)) => {
                println!("[Entropic] Runtime image preload deferred/failed: {}", e);
            }
            Err(e) => {
                println!("[Entropic] Runtime image preload task error: {}", e);
            }
        }
    });

    {
        let mut progress = state.setup_progress.lock().map_err(|e| e.to_string())?;
        *progress = SetupProgress {
            stage: "image".to_string(),
            message: "Runtime image will be prepared on first secure sandbox start.".to_string(),
            percent: 90,
            complete: false,
            error: None,
        };
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

// ── Workspace File Commands ──────────────────────────────────────────

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

const AUTH_LOCALHOST_PORT_ENV: &str = "ENTROPIC_AUTH_LOCALHOST_PORT";
const AUTH_LOCALHOST_DEFAULT_PORT: u16 = 27100;

const GOOGLE_AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL: &str = "https://www.googleapis.com/oauth2/v2/userinfo";
const GOOGLE_TOKENINFO_URL: &str = "https://oauth2.googleapis.com/tokeninfo";

// Anthropic (Claude Code) OAuth — two-phase flow: user copies code from Anthropic's page
const ANTHROPIC_AUTH_URL: &str = "https://claude.ai/oauth/authorize";
const ANTHROPIC_TOKEN_URL: &str = "https://console.anthropic.com/v1/oauth/token";
const ANTHROPIC_OAUTH_CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const ANTHROPIC_OAUTH_SCOPES: &str = "org:create_api_key user:profile user:inference";
const ANTHROPIC_OAUTH_REDIRECT_URI: &str = "https://console.anthropic.com/oauth/code/callback";

// OpenAI (Codex) OAuth — localhost callback flow
const OPENAI_AUTH_URL: &str = "https://auth.openai.com/oauth/authorize";
const OPENAI_TOKEN_URL: &str = "https://auth.openai.com/oauth/token";
const OPENAI_OAUTH_CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_OAUTH_SCOPES: &str = "openid profile email offline_access";

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

#[derive(Debug, serde::Deserialize)]
struct GoogleTokenInfoResponse {
    scope: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct RefreshTokenResponse {
    pub access_token: String,
    pub token_type: Option<String>,
    pub expires_at: u64,
}

fn google_client_id() -> Result<String, String> {
    if let Some(val) = option_env!("ENTROPIC_GOOGLE_CLIENT_ID") {
        return Ok(val.to_string());
    }
    if let Ok(val) = std::env::var("ENTROPIC_GOOGLE_CLIENT_ID") {
        return Ok(val);
    }
    Err("Google OAuth client ID not configured (ENTROPIC_GOOGLE_CLIENT_ID)".to_string())
}

fn google_client_secret() -> Option<String> {
    if let Some(val) = option_env!("ENTROPIC_GOOGLE_CLIENT_SECRET") {
        return Some(val.to_string());
    }
    if let Ok(val) = std::env::var("ENTROPIC_GOOGLE_CLIENT_SECRET") {
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

fn required_google_api_scopes(provider: &str) -> Result<Vec<&'static str>, String> {
    let scopes = match provider {
        "google_calendar" => vec![
            "https://www.googleapis.com/auth/calendar.events",
            "https://www.googleapis.com/auth/calendar.readonly",
        ],
        "google_email" => vec![
            "https://www.googleapis.com/auth/gmail.readonly",
            "https://www.googleapis.com/auth/gmail.send",
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

fn parse_scope_list(raw: &str) -> Vec<String> {
    raw.split_whitespace()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect()
}

fn generate_pkce() -> (String, String) {
    let mut verifier_bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut verifier_bytes);
    let verifier = URL_SAFE_NO_PAD.encode(verifier_bytes);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    (verifier, challenge)
}

fn oauth_callback_html(page_title: &str, title: &str, message: &str, success: bool) -> String {
    let (badge_text, badge_bg, badge_fg) = if success {
        ("Connected", "rgba(22, 163, 74, 0.12)", "#166534")
    } else {
        ("Action needed", "rgba(239, 68, 68, 0.12)", "#991b1b")
    };

    let template = r#"<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>{{PAGE_TITLE}}</title>
  <style>
    :root {
      --background: #fafafa;
      --card: #ffffff;
      --text: #111827;
      --muted: #4b5563;
      --border: rgba(0, 0, 0, 0.08);
      --purple: #7c3aed;
      --blue: #3b82f6;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: var(--background);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      overflow: hidden;
    }
    .bg { position: fixed; inset: 0; pointer-events: none; }
    .blob {
      position: absolute;
      border-radius: 9999px;
      filter: blur(90px);
      opacity: 0.45;
      animation: float 7s ease-in-out infinite;
    }
    .blob.one {
      width: 380px;
      height: 380px;
      background: #d8b4fe;
      top: -110px;
      left: -70px;
    }
    .blob.two {
      width: 340px;
      height: 340px;
      background: #bfdbfe;
      right: -90px;
      bottom: -100px;
      animation-delay: 1.5s;
    }
    .card {
      position: relative;
      z-index: 1;
      width: min(520px, 100%);
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 28px;
      box-shadow: 0 24px 44px rgba(17, 24, 39, 0.12);
      padding: 34px 28px 28px;
      text-align: center;
    }
    .brand {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 18px;
      font-weight: 700;
      font-size: 20px;
      letter-spacing: -0.02em;
      color: #111827;
    }
    .logo {
      width: 36px;
      height: 36px;
      border-radius: 12px;
      background: linear-gradient(135deg, var(--purple), var(--blue));
      color: white;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-weight: 800;
      box-shadow: 0 12px 24px rgba(124, 58, 237, 0.28);
    }
    .badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      margin-bottom: 14px;
      padding: 6px 12px;
      border-radius: 9999px;
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.02em;
      background: {{BADGE_BG}};
      color: {{BADGE_FG}};
    }
    h1 {
      margin: 0;
      font-size: clamp(26px, 4.8vw, 38px);
      line-height: 1.12;
      letter-spacing: -0.03em;
      color: #111827;
    }
    p {
      margin: 14px auto 0;
      max-width: 36ch;
      font-size: 16px;
      line-height: 1.6;
      color: var(--muted);
    }
    .hint {
      margin-top: 16px;
      font-size: 14px;
      color: #6b7280;
    }
    @keyframes float {
      0% { transform: translateY(0px); }
      50% { transform: translateY(-10px); }
      100% { transform: translateY(0px); }
    }
  </style>
</head>
<body>
  <div class="bg">
    <div class="blob one"></div>
    <div class="blob two"></div>
  </div>
  <main class="card">
    <div class="brand"><span class="logo">N</span><span>Entropic</span></div>
    <span class="badge">{{BADGE_TEXT}}</span>
    <h1>{{TITLE}}</h1>
    <p>{{MESSAGE}}</p>
    <p class="hint">You can return to Entropic now. This tab will close automatically.</p>
  </main>
  <script>
    setTimeout(function () {
      window.close();
    }, 1400);
  </script>
</body>
</html>"#;

    template
        .replace("{{PAGE_TITLE}}", page_title)
        .replace("{{BADGE_TEXT}}", badge_text)
        .replace("{{BADGE_BG}}", badge_bg)
        .replace("{{BADGE_FG}}", badge_fg)
        .replace("{{TITLE}}", title)
        .replace("{{MESSAGE}}", message)
}

fn oauth_html_response(html: String) -> String {
    format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        html.as_bytes().len(),
        html
    )
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

    if let Some(error) = url
        .query_pairs()
        .find(|(k, _)| k == "error")
        .map(|(_, v)| v.to_string())
    {
        let html = oauth_callback_html(
            "Entropic OAuth",
            "Connection failed",
            "Google returned an OAuth error. Close this tab and try again from Entropic.",
            false,
        );
        let _ = socket.write_all(oauth_html_response(html).as_bytes()).await;
        return Err(format!("OAuth callback returned error: {}", error));
    }

    let code = if let Some(code) = url
        .query_pairs()
        .find(|(k, _)| k == "code")
        .map(|(_, v)| v.to_string())
    {
        code
    } else {
        let html = oauth_callback_html(
            "Entropic OAuth",
            "Missing authorization code",
            "Google did not provide an authorization code. Close this tab and retry.",
            false,
        );
        let _ = socket.write_all(oauth_html_response(html).as_bytes()).await;
        return Err("OAuth callback missing code".to_string());
    };
    let state = url
        .query_pairs()
        .find(|(k, _)| k == "state")
        .map(|(_, v)| v.to_string())
        .unwrap_or_default();
    if state != expected_state {
        let html = oauth_callback_html(
            "Entropic OAuth",
            "Security check failed",
            "The OAuth state did not match. Please close this tab and retry from Entropic.",
            false,
        );
        let _ = socket.write_all(oauth_html_response(html).as_bytes()).await;
        return Err("OAuth state mismatch".to_string());
    }

    let html = oauth_callback_html(
        "Entropic OAuth",
        "Google connected",
        "Authentication is complete and your integration is now connected.",
        true,
    );
    let _ = socket.write_all(oauth_html_response(html).as_bytes()).await;

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

    let oauth_error = url
        .query_pairs()
        .find(|(k, _)| k == "error")
        .map(|(_, v)| v.to_string());
    let has_code = url.query_pairs().any(|(k, _)| k == "code");

    let (html, result) = if oauth_error.is_some() {
        (
            oauth_callback_html(
                "Entropic Sign-in",
                "Sign-in failed",
                "Google returned an OAuth error. Close this tab and try signing in again.",
                false,
            ),
            Err("Localhost OAuth callback returned error".to_string()),
        )
    } else if has_code {
        (
            oauth_callback_html(
                "Entropic Sign-in",
                "You're signed in",
                "Authentication completed successfully. You can jump back into Entropic.",
                true,
            ),
            Ok(()),
        )
    } else {
        (
            oauth_callback_html(
                "Entropic Sign-in",
                "Missing authorization code",
                "No authorization code was returned. Please close this tab and retry sign-in.",
                false,
            ),
            Err("Localhost OAuth callback missing code".to_string()),
        )
    };

    let _ = socket.write_all(oauth_html_response(html).as_bytes()).await;

    if result.is_ok() {
        let _ = app.emit("auth-localhost-callback", url.to_string());
    }

    result
}

#[tauri::command]
pub async fn start_auth_localhost(app: AppHandle) -> Result<LocalhostAuthStart, String> {
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
            eprintln!("[Entropic] Localhost OAuth error: {}", err);
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
        return Ok(GoogleUserInfo {
            email: None,
            id: None,
        });
    }
    resp.json::<GoogleUserInfo>()
        .await
        .map_err(|e| format!("Failed to parse user info: {}", e))
}

async fn fetch_google_token_scopes(access_token: &str) -> Result<Vec<String>, String> {
    let client = reqwest::Client::new();
    let resp = client
        .get(GOOGLE_TOKENINFO_URL)
        .query(&[("access_token", access_token)])
        .send()
        .await
        .map_err(|e| format!("Failed to fetch token info: {}", e))?;

    if !resp.status().is_success() {
        let text = resp
            .text()
            .await
            .unwrap_or_else(|_| "unknown error".to_string());
        return Err(format!("Failed to fetch token info: {}", text));
    }

    let info = resp
        .json::<GoogleTokenInfoResponse>()
        .await
        .map_err(|e| format!("Failed to parse token info response: {}", e))?;
    Ok(info
        .scope
        .as_deref()
        .map(parse_scope_list)
        .unwrap_or_default())
}

fn validate_granted_scopes(provider: &str, granted: &[String]) -> Result<(), String> {
    let required = required_google_api_scopes(provider)?;
    let missing: Vec<String> = required
        .into_iter()
        .filter(|required_scope| !granted.iter().any(|s| s == required_scope))
        .map(|s| s.to_string())
        .collect();

    if missing.is_empty() {
        return Ok(());
    }

    Err(format!(
        "Google OAuth missing required scopes for {}: {}. Disconnect and reconnect this integration. If it still fails, ensure Calendar/Gmail APIs and these scopes are enabled in your Google Cloud OAuth consent screen.",
        provider,
        missing.join(", ")
    ))
}

#[tauri::command]
pub async fn start_google_oauth(
    app: AppHandle,
    provider: String,
) -> Result<OAuthTokenBundle, String> {
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

    let mut auth_url =
        Url::parse(GOOGLE_AUTH_URL).map_err(|_| "Failed to build OAuth URL".to_string())?;
    auth_url
        .query_pairs_mut()
        .append_pair("client_id", &google_client_id()?)
        .append_pair("response_type", "code")
        .append_pair("redirect_uri", &redirect_uri)
        .append_pair("scope", &scopes.join(" "))
        .append_pair("code_challenge", &challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", &state)
        .append_pair("access_type", "offline")
        .append_pair("include_granted_scopes", "true")
        .append_pair("prompt", "consent");

    app.opener()
        .open_url(auth_url.as_str(), None::<&str>)
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
    let user_info = fetch_google_user(&token_response.access_token)
        .await
        .unwrap_or(GoogleUserInfo {
            email: None,
            id: None,
        });

    let mut scopes_list = token_response
        .scope
        .as_deref()
        .map(parse_scope_list)
        .unwrap_or_default();
    if scopes_list.is_empty() {
        scopes_list = fetch_google_token_scopes(&token_response.access_token)
            .await
            .unwrap_or_default();
    }
    if scopes_list.is_empty() {
        return Err(
            "Google OAuth succeeded but no granted scopes were returned. Disconnect and reconnect the integration."
                .to_string(),
        );
    }
    validate_granted_scopes(&provider, &scopes_list)?;

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
pub async fn refresh_google_token(
    provider: String,
    refresh_token: String,
) -> Result<RefreshTokenResponse, String> {
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

// =============================================================================
// Provider OAuth (Claude Code / OpenAI Codex)
// =============================================================================

#[derive(Debug, Clone, serde::Serialize)]
pub struct ProviderOAuthResult {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: u64,
    pub provider: String,
}

// =============================================================================
// Anthropic OAuth — two-phase flow (user copies code from Anthropic's page)
// =============================================================================

#[tauri::command]
pub async fn start_anthropic_oauth(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let (verifier, challenge) = generate_pkce();

    // Store verifier for the completion step
    {
        let mut v = state.anthropic_oauth_verifier.lock().map_err(|e| e.to_string())?;
        *v = Some(verifier.clone());
    }

    // Build authorize URL — state IS the verifier (matches Claude Code / OpenClaw convention)
    let mut url = Url::parse(ANTHROPIC_AUTH_URL)
        .map_err(|_| "Failed to build OAuth URL".to_string())?;
    url.query_pairs_mut()
        .append_pair("code", "true")
        .append_pair("client_id", ANTHROPIC_OAUTH_CLIENT_ID)
        .append_pair("response_type", "code")
        .append_pair("redirect_uri", ANTHROPIC_OAUTH_REDIRECT_URI)
        .append_pair("scope", ANTHROPIC_OAUTH_SCOPES)
        .append_pair("code_challenge", &challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", &verifier);

    app.opener()
        .open_url(url.as_str(), None::<&str>)
        .map_err(|e| format!("Failed to open browser: {}", e))?;

    Ok(())
}

/// Parse a "code#state" string (or a full callback URL) into (code, state).
fn parse_anthropic_code_state(input: &str) -> Result<(String, String), String> {
    let text = input.trim().trim_matches('`');

    // Try as URL first (user may paste the full callback URL)
    if let Ok(url) = Url::parse(text) {
        let code = url.query_pairs().find(|(k, _)| k == "code").map(|(_, v)| v.to_string());
        let state = url.query_pairs().find(|(k, _)| k == "state").map(|(_, v)| v.to_string());
        if let (Some(c), Some(s)) = (code, state) {
            if !c.is_empty() && !s.is_empty() {
                return Ok((c, s));
            }
        }
    }

    // Try as "code#state" token
    if let Some(hash_pos) = text.find('#') {
        let code = &text[..hash_pos];
        let state = &text[hash_pos + 1..];
        if code.len() >= 8 && state.len() >= 8 {
            return Ok((code.to_string(), state.to_string()));
        }
    }

    Err("Could not parse authorization code. Expected format: code#state".to_string())
}

#[tauri::command]
pub async fn complete_anthropic_oauth(
    app: AppHandle,
    state: State<'_, AppState>,
    code_state: String,
) -> Result<ProviderOAuthResult, String> {
    let (code, returned_state) = parse_anthropic_code_state(&code_state)?;

    // Retrieve and consume the stored verifier
    let verifier = {
        let mut v = state.anthropic_oauth_verifier.lock().map_err(|e| e.to_string())?;
        v.take().ok_or("No pending Anthropic OAuth flow. Please click Sign In first.")?
    };

    // Validate state matches verifier (state == verifier in this flow)
    if returned_state != verifier {
        return Err("OAuth state mismatch — the code may have expired. Please try again.".to_string());
    }

    // Exchange code for tokens using JSON body (matching Claude Code / OpenClaw)
    let client = reqwest::Client::new();
    let payload = serde_json::json!({
        "grant_type": "authorization_code",
        "client_id": ANTHROPIC_OAUTH_CLIENT_ID,
        "code": code,
        "state": returned_state,
        "redirect_uri": ANTHROPIC_OAUTH_REDIRECT_URI,
        "code_verifier": verifier,
    });

    let resp = client
        .post(ANTHROPIC_TOKEN_URL)
        .header("Content-Type", "application/json")
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Token exchange failed: {}", e))?;

    if !resp.status().is_success() {
        let text = resp.text().await.unwrap_or_else(|_| "unknown error".to_string());
        return Err(format!("Token exchange failed: {}", text));
    }

    let token_data = resp
        .json::<OAuthTokenResponse>()
        .await
        .map_err(|e| format!("Failed to parse token response: {}", e))?;

    let refresh_token = token_data.refresh_token.unwrap_or_default();
    let expires_in = token_data.expires_in.unwrap_or(3600);
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "Clock error".to_string())?
        .as_millis() as u64;
    // Subtract 5 minutes as buffer (matches OpenClaw convention)
    let expires_at = now_ms.saturating_add(expires_in * 1000).saturating_sub(5 * 60 * 1000);

    let provider = "anthropic".to_string();

    // Store the token as an API key and save OAuth metadata
    {
        let mut keys = state.api_keys.lock().map_err(|e| e.to_string())?;
        keys.insert(provider.clone(), token_data.access_token.clone());
        let mut active = state.active_provider.lock().map_err(|e| e.to_string())?;
        *active = Some(provider.clone());
        let mut stored = load_auth(&app);
        stored.keys = keys.clone();
        stored.active_provider = active.clone();
        stored.oauth_metadata.insert(
            provider.clone(),
            OAuthKeyMeta {
                refresh_token: refresh_token.clone(),
                expires_at,
                source: "claude_code".to_string(),
            },
        );
        save_auth(&app, &stored)?;
    }

    Ok(ProviderOAuthResult {
        access_token: token_data.access_token,
        refresh_token,
        expires_at,
        provider,
    })
}

// =============================================================================
// OpenAI OAuth — localhost callback flow (matches Codex CLI)
// =============================================================================

#[tauri::command]
pub async fn start_openai_oauth(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ProviderOAuthResult, String> {
    let (verifier, challenge) = generate_pkce();
    let oauth_state = URL_SAFE_NO_PAD.encode({
        let mut bytes = [0u8; 16];
        rand::thread_rng().fill_bytes(&mut bytes);
        bytes
    });

    // OpenAI requires the exact registered redirect URI on port 1455
    let redirect_uri = "http://localhost:1455/auth/callback".to_string();
    let listener = TcpListener::bind("127.0.0.1:1455")
        .await
        .map_err(|e| format!("Failed to bind OAuth callback server on port 1455 (is another app using it?): {}", e))?;

    let mut url = Url::parse(OPENAI_AUTH_URL)
        .map_err(|_| "Failed to build OAuth URL".to_string())?;
    url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", OPENAI_OAUTH_CLIENT_ID)
        .append_pair("redirect_uri", &redirect_uri)
        .append_pair("scope", OPENAI_OAUTH_SCOPES)
        .append_pair("code_challenge", &challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", &oauth_state)
        .append_pair("id_token_add_organizations", "true")
        .append_pair("codex_cli_simplified_flow", "true")
        .append_pair("originator", "pi");

    app.opener()
        .open_url(url.as_str(), None::<&str>)
        .map_err(|e| format!("Failed to open browser: {}", e))?;

    let code = wait_for_openai_oauth_callback(listener, &oauth_state).await?;

    // Exchange code for tokens (form-encoded for OpenAI)
    let client = reqwest::Client::new();
    let params = vec![
        ("client_id", OPENAI_OAUTH_CLIENT_ID.to_string()),
        ("code", code),
        ("grant_type", "authorization_code".to_string()),
        ("redirect_uri", redirect_uri),
        ("code_verifier", verifier),
    ];
    let resp = client
        .post(OPENAI_TOKEN_URL)
        .form(&params)
        .send()
        .await
        .map_err(|e| format!("Token exchange failed: {}", e))?;

    if !resp.status().is_success() {
        let text = resp.text().await.unwrap_or_else(|_| "unknown error".to_string());
        return Err(format!("Token exchange failed: {}", text));
    }

    let token_data = resp
        .json::<OAuthTokenResponse>()
        .await
        .map_err(|e| format!("Failed to parse token response: {}", e))?;

    let refresh_token = token_data.refresh_token.unwrap_or_default();
    let expires_in = token_data.expires_in.unwrap_or(3600);
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "Clock error".to_string())?
        .as_millis() as u64;
    let expires_at = now_ms.saturating_add(expires_in * 1000);

    let provider = "openai".to_string();

    // Store the token as an API key and save OAuth metadata
    {
        let mut keys = state.api_keys.lock().map_err(|e| e.to_string())?;
        keys.insert(provider.clone(), token_data.access_token.clone());
        let mut active = state.active_provider.lock().map_err(|e| e.to_string())?;
        *active = Some(provider.clone());
        let mut stored = load_auth(&app);
        stored.keys = keys.clone();
        stored.active_provider = active.clone();
        stored.oauth_metadata.insert(
            provider.clone(),
            OAuthKeyMeta {
                refresh_token: refresh_token.clone(),
                expires_at,
                source: "openai_codex".to_string(),
            },
        );
        save_auth(&app, &stored)?;
    }

    Ok(ProviderOAuthResult {
        access_token: token_data.access_token,
        refresh_token,
        expires_at,
        provider,
    })
}

async fn wait_for_openai_oauth_callback(
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

    if let Some(error) = url
        .query_pairs()
        .find(|(k, _)| k == "error")
        .map(|(_, v)| v.to_string())
    {
        let html = oauth_callback_html(
            "Entropic OAuth",
            "Connection failed",
            "OpenAI returned an OAuth error. Close this tab and try again from Entropic.",
            false,
        );
        let _ = socket.write_all(oauth_html_response(html).as_bytes()).await;
        return Err(format!("OAuth callback returned error: {}", error));
    }

    let code = match url.query_pairs().find(|(k, _)| k == "code").map(|(_, v)| v.to_string()) {
        Some(c) => c,
        None => {
            let html = oauth_callback_html(
                "Entropic OAuth",
                "Missing authorization code",
                "No authorization code was returned. Close this tab and retry.",
                false,
            );
            let _ = socket.write_all(oauth_html_response(html).as_bytes()).await;
            return Err("OAuth callback missing code".to_string());
        }
    };

    let cb_state = url
        .query_pairs()
        .find(|(k, _)| k == "state")
        .map(|(_, v)| v.to_string())
        .unwrap_or_default();
    if cb_state != expected_state {
        let html = oauth_callback_html(
            "Entropic OAuth",
            "Security check failed",
            "The OAuth state did not match. Please close this tab and retry from Entropic.",
            false,
        );
        let _ = socket.write_all(oauth_html_response(html).as_bytes()).await;
        return Err("OAuth state mismatch".to_string());
    }

    let html = oauth_callback_html(
        "Entropic OAuth",
        "OpenAI connected",
        "Authentication is complete. You can return to Entropic now.",
        true,
    );
    let _ = socket.write_all(oauth_html_response(html).as_bytes()).await;

    Ok(code)
}

fn read_linux_machine_id() -> Option<String> {
    let candidates = ["/etc/machine-id", "/var/lib/dbus/machine-id"];
    for path in candidates {
        if let Ok(value) = fs::read_to_string(path) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_lowercase());
            }
        }
    }
    None
}

fn read_macos_platform_uuid() -> Option<String> {
    let output = Command::new("ioreg")
        .args(["-rd1", "-c", "IOPlatformExpertDevice"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        if !line.contains("IOPlatformUUID") {
            continue;
        }
        let first_quote = line.find('"')?;
        let tail = &line[first_quote + 1..];
        let second_quote = tail.find('"')?;
        let key = &tail[..second_quote];
        if key != "IOPlatformUUID" {
            continue;
        }
        let equals_idx = line.find('=')?;
        let value_part = line[equals_idx + 1..].trim();
        let value = value_part.trim_matches('"').trim();
        if !value.is_empty() {
            return Some(value.to_lowercase());
        }
    }
    None
}

fn read_hostname() -> Option<String> {
    if let Ok(value) = std::env::var("HOSTNAME") {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    let output = Command::new("hostname").output().ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

fn resolve_raw_device_identifier() -> String {
    match Platform::detect() {
        Platform::Linux => {
            if let Some(machine_id) = read_linux_machine_id() {
                return format!("linux:machine-id:{machine_id}");
            }
        }
        Platform::MacOS => {
            if let Some(uuid) = read_macos_platform_uuid() {
                return format!("macos:ioplatformuuid:{uuid}");
            }
        }
        Platform::Windows => {}
    }

    let mut fallback_parts: Vec<String> = Vec::new();
    if let Some(hostname) = read_hostname() {
        fallback_parts.push(format!("host={hostname}"));
    }
    if let Ok(user) = std::env::var("USER") {
        let trimmed = user.trim();
        if !trimmed.is_empty() {
            fallback_parts.push(format!("user={trimmed}"));
        }
    }
    if fallback_parts.is_empty() {
        fallback_parts.push("unknown".to_string());
    }
    format!(
        "fallback:{}:{}",
        match Platform::detect() {
            Platform::Linux => "linux",
            Platform::MacOS => "macos",
            Platform::Windows => "windows",
        },
        fallback_parts.join("|")
    )
}

#[tauri::command]
pub async fn get_device_fingerprint_hash() -> Result<String, String> {
    let raw = resolve_raw_device_identifier();
    let mut hasher = Sha256::new();
    hasher.update("entropic-device-fingerprint-v1:");
    hasher.update(raw.as_bytes());
    Ok(format!("{:x}", hasher.finalize()))
}

#[tauri::command]
pub async fn refresh_provider_token(
    app: AppHandle,
    state: State<'_, AppState>,
    provider: String,
) -> Result<ProviderOAuthResult, String> {
    let token_url = match provider.as_str() {
        "anthropic" => ANTHROPIC_TOKEN_URL,
        "openai" => OPENAI_TOKEN_URL,
        _ => return Err(format!("Unsupported OAuth provider: {}", provider)),
    };
    let client_id = match provider.as_str() {
        "anthropic" => ANTHROPIC_OAUTH_CLIENT_ID,
        "openai" => OPENAI_OAUTH_CLIENT_ID,
        _ => unreachable!(),
    };

    let stored = load_auth(&app);
    let meta = stored
        .oauth_metadata
        .get(&provider)
        .ok_or_else(|| format!("No OAuth metadata for provider: {}", provider))?;

    if meta.refresh_token.is_empty() {
        return Err("No refresh token available. Please sign in again.".to_string());
    }

    let client = reqwest::Client::new();

    // Anthropic uses JSON body; OpenAI uses form-encoded
    let resp = if provider == "anthropic" {
        let payload = serde_json::json!({
            "grant_type": "refresh_token",
            "client_id": client_id,
            "refresh_token": meta.refresh_token,
        });
        client
            .post(token_url)
            .header("Content-Type", "application/json")
            .json(&payload)
            .send()
            .await
            .map_err(|e| format!("Token refresh failed: {}", e))?
    } else {
        let params = vec![
            ("client_id", client_id.to_string()),
            ("refresh_token", meta.refresh_token.clone()),
            ("grant_type", "refresh_token".to_string()),
        ];
        client
            .post(token_url)
            .form(&params)
            .send()
            .await
            .map_err(|e| format!("Token refresh failed: {}", e))?
    };

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

    let new_refresh = data.refresh_token.unwrap_or_else(|| meta.refresh_token.clone());
    let expires_in = data.expires_in.unwrap_or(3600);
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "Clock error".to_string())?
        .as_millis() as u64;
    let expires_at = now_ms.saturating_add(expires_in * 1000);

    // Update stored key and metadata
    {
        let mut keys = state.api_keys.lock().map_err(|e| e.to_string())?;
        keys.insert(provider.clone(), data.access_token.clone());
        let mut stored = load_auth(&app);
        stored.keys = keys.clone();
        stored.oauth_metadata.insert(
            provider.clone(),
            OAuthKeyMeta {
                refresh_token: new_refresh.clone(),
                expires_at,
                source: meta.source.clone(),
            },
        );
        save_auth(&app, &stored)?;
    }

    Ok(ProviderOAuthResult {
        access_token: data.access_token,
        refresh_token: new_refresh,
        expires_at,
        provider,
    })
}

#[tauri::command]
pub async fn get_oauth_status(app: AppHandle) -> Result<HashMap<String, String>, String> {
    let stored = load_auth(&app);
    let mut result = HashMap::new();
    for (provider, meta) in &stored.oauth_metadata {
        result.insert(provider.clone(), meta.source.clone());
    }
    Ok(result)
}
