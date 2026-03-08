use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

const WATCHDOG_STATE_FILE: &str = "watchdog-state.json";

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct DesiredGatewayState {
    pub mode: String,
    pub model: Option<String>,
    pub image_model: Option<String>,
    pub proxy_token: Option<String>,
    pub proxy_url: Option<String>,
    pub updated_at_ms: u64,
}

impl Default for DesiredGatewayState {
    fn default() -> Self {
        Self {
            mode: "stopped".to_string(),
            model: None,
            image_model: None,
            proxy_token: None,
            proxy_url: None,
            updated_at_ms: 0,
        }
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct WatchdogStatusSnapshot {
    pub state: String,
    pub desired_mode: String,
    pub desired_model: Option<String>,
    pub desired_image_model: Option<String>,
    pub desired_updated_at_ms: u64,
    pub last_check_at_ms: u64,
    pub last_action_at_ms: u64,
    pub expected_restart_until_ms: u64,
    pub cooldown_until_ms: u64,
    pub consecutive_failures: u32,
    pub last_error: Option<String>,
    pub last_reason: Option<String>,
    pub actual_gateway_running: bool,
    pub actual_gateway_health: Option<String>,
}

impl Default for WatchdogStatusSnapshot {
    fn default() -> Self {
        Self {
            state: "idle".to_string(),
            desired_mode: "stopped".to_string(),
            desired_model: None,
            desired_image_model: None,
            desired_updated_at_ms: 0,
            last_check_at_ms: 0,
            last_action_at_ms: 0,
            expected_restart_until_ms: 0,
            cooldown_until_ms: 0,
            consecutive_failures: 0,
            last_error: None,
            last_reason: None,
            actual_gateway_running: false,
            actual_gateway_health: None,
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn watchdog_state_path(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| {
            dirs::home_dir()
                .map(|home| home.join(".entropic"))
                .unwrap_or_else(|| PathBuf::from("/tmp"))
        })
        .join(WATCHDOG_STATE_FILE)
}

fn status_store() -> &'static Mutex<WatchdogStatusSnapshot> {
    static STORE: OnceLock<Mutex<WatchdogStatusSnapshot>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(WatchdogStatusSnapshot::default()))
}

pub fn desired_gateway_running(mode: &str) -> bool {
    matches!(mode.trim(), "local" | "proxy")
}

pub fn load_desired_state(app: &AppHandle) -> Result<DesiredGatewayState, String> {
    let path = watchdog_state_path(app);
    if !path.exists() {
        return Ok(DesiredGatewayState::default());
    }
    let raw = fs::read_to_string(&path)
        .map_err(|error| format!("Failed to read watchdog state: {}", error))?;
    serde_json::from_str::<DesiredGatewayState>(&raw)
        .map_err(|error| format!("Failed to parse watchdog state: {}", error))
}

pub fn save_desired_state(app: &AppHandle, desired: &DesiredGatewayState) -> Result<(), String> {
    let path = watchdog_state_path(app);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to prepare watchdog state directory: {}", error))?;
    }
    let payload = serde_json::to_string_pretty(desired)
        .map_err(|error| format!("Failed to serialize watchdog state: {}", error))?;
    fs::write(path, payload).map_err(|error| format!("Failed to write watchdog state: {}", error))
}

pub fn current_desired_state(app: &AppHandle) -> DesiredGatewayState {
    load_desired_state(app).unwrap_or_default()
}

pub fn current_status() -> WatchdogStatusSnapshot {
    status_store()
        .lock()
        .map(|status| status.clone())
        .unwrap_or_default()
}

pub fn update_status<F>(mutator: F)
where
    F: FnOnce(&mut WatchdogStatusSnapshot),
{
    if let Ok(mut status) = status_store().lock() {
        mutator(&mut status);
    }
}

pub fn sync_status_with_desired(desired: &DesiredGatewayState) {
    update_status(|status| {
        status.desired_mode = desired.mode.clone();
        status.desired_model = desired.model.clone();
        status.desired_image_model = desired.image_model.clone();
        status.desired_updated_at_ms = desired.updated_at_ms;
        if !desired_gateway_running(&desired.mode) {
            status.state = "idle".to_string();
            status.expected_restart_until_ms = 0;
            status.cooldown_until_ms = 0;
            status.consecutive_failures = 0;
            status.last_error = None;
            status.last_reason = None;
        }
    });
}

pub fn mark_expected_restart(duration_ms: u64) {
    let until = now_ms().saturating_add(duration_ms.max(1));
    update_status(|status| {
        status.expected_restart_until_ms = until;
        status.last_action_at_ms = now_ms();
        if desired_gateway_running(&status.desired_mode) {
            status.state = "expected_restart".to_string();
        }
    });
}

pub fn clear_expected_restart() {
    update_status(|status| {
        status.expected_restart_until_ms = 0;
    });
}

pub fn desired_state_with_mode(
    mode: &str,
    model: Option<String>,
    image_model: Option<String>,
    proxy_token: Option<String>,
    proxy_url: Option<String>,
) -> DesiredGatewayState {
    DesiredGatewayState {
        mode: mode.to_string(),
        model,
        image_model,
        proxy_token,
        proxy_url,
        updated_at_ms: now_ms(),
    }
}
