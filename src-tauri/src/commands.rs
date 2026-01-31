use crate::runtime::{Runtime, RuntimeStatus};
use std::process::Command;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

pub struct AppState {
    pub setup_progress: Mutex<SetupProgress>,
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
pub async fn start_gateway() -> Result<(), String> {
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

    // Create and start container with hardened settings
    let run = Command::new("docker")
        .args([
            "run", "-d",
            "--name", "zara-openclaw",
            "--user", "1000:1000",
            "--cap-drop=ALL",
            "--security-opt", "no-new-privileges",
            "--read-only",
            "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=100m",
            "--tmpfs", "/run:rw,noexec,nosuid,nodev,size=10m",
            "--tmpfs", "/home/node/.openclaw:rw,noexec,nosuid,nodev,size=50m,uid=1000,gid=1000",
            "-e", "OPENCLAW_GATEWAY_TOKEN=zara-local-gateway",
            "-v", "zara-openclaw-data:/data",
            "--network", "zara-net",
            "-p", "127.0.0.1:19789:18789",
            "--restart", "unless-stopped",
            "openclaw-runtime:latest",
        ])
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
