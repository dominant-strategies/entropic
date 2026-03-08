use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

const INCIDENT_LOG_FILE: &str = "operational-incidents.jsonl";
const INCIDENT_LOG_MAX_BYTES: u64 = 512 * 1024;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct IncidentRecord {
    pub ts_ms: u64,
    pub level: String,
    pub component: String,
    pub action: String,
    pub message: String,
    pub detail: Option<String>,
}

fn incident_log_path(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| {
            dirs::home_dir()
                .map(|home| home.join(".entropic"))
                .unwrap_or_else(|| PathBuf::from("/tmp"))
        })
        .join(INCIDENT_LOG_FILE)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

pub fn record_incident(
    app: &AppHandle,
    level: &str,
    component: &str,
    action: &str,
    message: &str,
    detail: Option<&str>,
) {
    let path = incident_log_path(app);
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }

    if let Ok(meta) = fs::metadata(&path) {
        if meta.len() > INCIDENT_LOG_MAX_BYTES {
            let _ = fs::write(&path, "");
        }
    }

    let record = IncidentRecord {
        ts_ms: now_ms(),
        level: level.to_string(),
        component: component.to_string(),
        action: action.to_string(),
        message: message.to_string(),
        detail: detail.map(ToOwned::to_owned),
    };

    if let Ok(serialized) = serde_json::to_string(&record) {
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&path) {
            let _ = writeln!(file, "{}", serialized);
        }
    }
}

pub fn read_recent_incidents(
    app: &AppHandle,
    limit: Option<usize>,
) -> Result<Vec<IncidentRecord>, String> {
    let path = incident_log_path(app);
    if !path.exists() {
        return Ok(Vec::new());
    }

    let raw = fs::read_to_string(&path)
        .map_err(|error| format!("Failed to read operational incidents: {}", error))?;
    let max = limit.unwrap_or(200).max(1);
    let mut records = raw
        .lines()
        .filter_map(|line| serde_json::from_str::<IncidentRecord>(line).ok())
        .collect::<Vec<_>>();
    if records.len() > max {
        records.drain(0..records.len().saturating_sub(max));
    }
    Ok(records)
}

pub fn clear_incidents(app: &AppHandle) -> Result<(), String> {
    let path = incident_log_path(app);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to prepare incident log directory: {}", error))?;
    }
    fs::write(path, "").map_err(|error| format!("Failed to clear operational incidents: {}", error))
}
