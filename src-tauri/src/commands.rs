use crate::runtime::{Runtime, RuntimeStatus};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::process::Command;
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

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct StoredAuth {
    version: u8,
    keys: HashMap<String, String>,
    active_provider: Option<String>,
}

impl Default for StoredAuth {
    fn default() -> Self {
        Self {
            version: 1,
            keys: HashMap::new(),
            active_provider: None,
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
    let stored = StoredAuth {
        version: 1,
        keys: keys.clone(),
        active_provider: active.clone(),
    };
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
    let stored = StoredAuth {
        version: 1,
        keys,
        active_provider: active.clone(),
    };
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
pub async fn start_gateway(state: State<'_, AppState>) -> Result<(), String> {
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
pub async fn restart_gateway(state: State<'_, AppState>) -> Result<(), String> {
    // Stop and remove existing container (to pick up new env vars)
    let _ = Command::new("docker")
        .args(["stop", "zara-openclaw"])
        .output();
    let _ = Command::new("docker")
        .args(["rm", "-f", "zara-openclaw"])
        .output();

    // Start with current API keys
    start_gateway(state).await
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
