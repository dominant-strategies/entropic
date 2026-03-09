use crate::operational::{self, IncidentRecord};
use crate::runtime::{
    entropic_colima_home_path, macos_docker_socket_candidates, Platform, Runtime, RuntimeStatus,
    ENTROPIC_QEMU_PROFILE, ENTROPIC_VZ_PROFILE, LEGACY_NOVA_QEMU_PROFILE, LEGACY_NOVA_VZ_PROFILE,
};
use crate::runtime_supervisor::RuntimeSupervisor;
use crate::watchdog::{self, DesiredGatewayState, WatchdogStatusSnapshot};
use crate::workspace_service::{
    sanitize_filename, WorkspaceFileEntry, WorkspaceRunner, WorkspaceService,
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
use std::io::Read;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
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

mod attachments;
mod auth;
mod gateway;
mod oauth;
mod runtime_ops;
mod settings;
mod skills;
mod workspace;

pub use attachments::*;
pub use auth::*;
pub use gateway::*;
pub use oauth::*;
pub use runtime_ops::*;
pub use settings::*;
pub use skills::*;
pub use workspace::*;

const ENTROPIC_PROXY_DEV_ORIGIN: &str = "http://host.docker.internal:5174";
const ENTROPIC_PROXY_ALLOWED_HOSTS: &[&str] = &[
    "entropic.qu.ai",
    "host.docker.internal",
    "localhost",
    "127.0.0.1",
];
const MAX_BRIDGE_DEVICES: usize = 10;

/// Get the Docker socket path for the current platform.
/// On macOS, uses Colima socket. On Linux/Windows, uses default.
fn get_docker_host() -> Option<String> {
    match Platform::detect() {
        Platform::MacOS => {
            // Colima-first on macOS. Desktop/system sockets are only included when
            // ENTROPIC_RUNTIME_ALLOW_DOCKER_DESKTOP is truthy.
            for socket in macos_docker_socket_candidates() {
                if socket.exists() {
                    return Some(format!("unix://{}", socket.display()));
                }
            }

            // Do not silently fall back to the current Docker context on macOS.
            // Keep commands pinned to Entropic's isolated Colima path.
            let fallback = entropic_colima_home_path()
                .join(ENTROPIC_VZ_PROFILE)
                .join("docker.sock");
            Some(format!("unix://{}", fallback.display()))
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

fn find_colima_binary() -> String {
    if matches!(Platform::detect(), Platform::MacOS) {
        if let Ok(exe) = std::env::current_exe() {
            if let Some(exe_dir) = exe.parent() {
                let bundled_release = exe_dir.parent().map(|c| {
                    c.join("Resources")
                        .join("resources")
                        .join("bin")
                        .join("colima")
                });
                if let Some(ref p) = bundled_release {
                    if p.exists() {
                        return p.display().to_string();
                    }
                }

                let bundled_dev = exe_dir.join("resources").join("bin").join("colima");
                if bundled_dev.exists() {
                    return bundled_dev.display().to_string();
                }
            }
        }
    }

    for candidate in &[
        "/usr/local/bin/colima",
        "/opt/homebrew/bin/colima",
        "/usr/bin/colima",
    ] {
        if std::path::Path::new(candidate).exists() {
            return candidate.to_string();
        }
    }

    "colima".to_string()
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
            format!(
                "{}/{}",
                ENTROPIC_PROXY_DEV_ORIGIN.trim_end_matches('/'),
                path
            )
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
const SCANNER_IMAGE_REPO: &str = "entropic-skill-scanner";
const DEFAULT_SCANNER_GIT_REPO: &str = "https://github.com/cisco-ai-defense/skill-scanner.git";
const DEFAULT_SCANNER_GIT_COMMIT: &str = "dff88dc5fa0fff6382ddb6eff19d245745b93f7a";
const DEFAULT_RUNTIME_RELEASE_REPO: &str = "dominant-strategies/entropic-releases";
const DEFAULT_RUNTIME_RELEASE_TAG: &str = "runtime-latest";
const DEFAULT_APP_MANIFEST_URL: &str =
    "https://github.com/dominant-strategies/entropic-releases/releases/latest/download/latest.json";
const QMD_COMMAND_PATH: &str = "/data/.bun/bin/qmd";

/// Optional registry image to pull the runtime from when not available locally.
/// Only used as an explicit fallback when OPENCLAW_RUNTIME_REGISTRY is set.
fn runtime_registry_image() -> Option<String> {
    // Build-time override
    if let Some(val) = option_env!("OPENCLAW_RUNTIME_REGISTRY") {
        let trimmed = val.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    // Runtime override
    if let Ok(val) = std::env::var("OPENCLAW_RUNTIME_REGISTRY") {
        let trimmed = val.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    None
}

fn runtime_release_repo() -> String {
    if let Some(val) = option_env!("OPENCLAW_RUNTIME_RELEASE_REPO") {
        let trimmed = val.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    if let Ok(val) = std::env::var("OPENCLAW_RUNTIME_RELEASE_REPO") {
        let trimmed = val.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    DEFAULT_RUNTIME_RELEASE_REPO.to_string()
}

const DEFAULT_RUNTIME_MANIFEST_NAME: &str = "runtime-manifest.json";
const RUNTIME_MANIFEST_MAX_AGE_SECS: u64 = 60 * 60; // 1 hour
const RUNTIME_TAR_MAX_TIME_SECS: u16 = 600; // 10 minutes
const RUNTIME_TAR_SETUP_MAX_TIME_SECS: u16 = 180; // 3 minutes
const APP_MANIFEST_CACHE_NAME: &str = "entropic-app-latest.json";
const APP_MANIFEST_MAX_AGE_SECS: u64 = 60 * 60; // 1 hour

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
struct RuntimeReleaseManifest {
    version: String,
    url: String,
    sha256: String,
    #[serde(default)]
    openclaw_commit: Option<String>,
    #[serde(default)]
    entropic_skills_commit: Option<String>,
}

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
struct AppReleaseManifest {
    version: String,
    #[serde(default)]
    pub_date: Option<String>,
}

fn runtime_release_tag() -> String {
    if let Some(val) = option_env!("OPENCLAW_RUNTIME_RELEASE_TAG") {
        let trimmed = val.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    if let Ok(val) = std::env::var("OPENCLAW_RUNTIME_RELEASE_TAG") {
        let trimmed = val.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    DEFAULT_RUNTIME_RELEASE_TAG.to_string()
}

fn app_manifest_url() -> String {
    if let Some(val) = option_env!("OPENCLAW_APP_MANIFEST_URL") {
        let trimmed = val.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    if let Ok(val) = std::env::var("OPENCLAW_APP_MANIFEST_URL") {
        let trimmed = val.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    DEFAULT_APP_MANIFEST_URL.to_string()
}

fn app_manifest_fetch_enabled() -> bool {
    if let Some(val) = option_env!("OPENCLAW_APP_MANIFEST_URL") {
        if !val.trim().is_empty() {
            return true;
        }
    }
    if let Ok(val) = std::env::var("OPENCLAW_APP_MANIFEST_URL") {
        if !val.trim().is_empty() {
            return true;
        }
    }
    !cfg!(debug_assertions)
}

fn runtime_manifest_url() -> String {
    if let Some(val) = option_env!("OPENCLAW_RUNTIME_MANIFEST_URL") {
        let trimmed = val.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    if let Ok(val) = std::env::var("OPENCLAW_RUNTIME_MANIFEST_URL") {
        let trimmed = val.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    format!(
        "https://github.com/{}/releases/download/{}/{}",
        runtime_release_repo(),
        runtime_release_tag(),
        DEFAULT_RUNTIME_MANIFEST_NAME
    )
}

fn runtime_release_tar_url() -> String {
    if let Some(val) = option_env!("OPENCLAW_RUNTIME_TAR_URL") {
        let trimmed = val.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    if let Ok(val) = std::env::var("OPENCLAW_RUNTIME_TAR_URL") {
        let trimmed = val.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    format!(
        "https://github.com/{}/releases/download/{}/openclaw-runtime.tar.gz",
        runtime_release_repo(),
        runtime_release_tag()
    )
}

fn scanner_release_tar_url() -> String {
    if let Some(val) = option_env!("ENTROPIC_SCANNER_TAR_URL") {
        let trimmed = val.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    if let Ok(val) = std::env::var("ENTROPIC_SCANNER_TAR_URL") {
        let trimmed = val.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    format!(
        "https://github.com/{}/releases/download/{}/entropic-skill-scanner.tar.gz",
        runtime_release_repo(),
        runtime_release_tag()
    )
}

fn runtime_cache_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".entropic").join("cache"))
}

fn runtime_cached_tar_path() -> Option<PathBuf> {
    runtime_cache_dir().map(|dir| dir.join("openclaw-runtime.tar.gz"))
}

fn runtime_cached_tar_partial_path() -> Option<PathBuf> {
    runtime_cache_dir().map(|dir| dir.join("openclaw-runtime.tar.gz.partial"))
}

fn runtime_cached_tar_checksum_path() -> Option<PathBuf> {
    runtime_cache_dir().map(|dir| dir.join("openclaw-runtime.tar.gz.sha256"))
}

fn runtime_cached_manifest_path() -> Option<PathBuf> {
    runtime_cache_dir().map(|dir| dir.join(DEFAULT_RUNTIME_MANIFEST_NAME))
}

fn runtime_cached_manifest_partial_path() -> Option<PathBuf> {
    runtime_cache_dir().map(|dir| dir.join("runtime-manifest.json.partial"))
}

fn app_cached_manifest_path() -> Option<PathBuf> {
    runtime_cache_dir().map(|dir| dir.join(APP_MANIFEST_CACHE_NAME))
}

fn app_cached_manifest_partial_path() -> Option<PathBuf> {
    runtime_cache_dir().map(|dir| dir.join("entropic-app-latest.json.partial"))
}

fn runtime_cached_tar_valid() -> bool {
    let Some(path) = runtime_cached_tar_path() else {
        return false;
    };
    path.metadata()
        .map(|m| m.is_file() && m.len() > 0)
        .unwrap_or(false)
}

fn runtime_manifest_cache_fresh() -> bool {
    let Some(path) = runtime_cached_manifest_path() else {
        return false;
    };
    let Ok(meta) = path.metadata() else {
        return false;
    };
    let Ok(modified) = meta.modified() else {
        return false;
    };
    modified
        .elapsed()
        .map(|elapsed| elapsed <= Duration::from_secs(RUNTIME_MANIFEST_MAX_AGE_SECS))
        .unwrap_or(false)
}

fn app_manifest_cache_fresh() -> bool {
    let Some(path) = app_cached_manifest_path() else {
        return false;
    };
    let Ok(meta) = path.metadata() else {
        return false;
    };
    let Ok(modified) = meta.modified() else {
        return false;
    };
    modified
        .elapsed()
        .map(|elapsed| elapsed <= Duration::from_secs(APP_MANIFEST_MAX_AGE_SECS))
        .unwrap_or(false)
}

fn download_url_to_path(
    url: &str,
    output_path: &Path,
    retries: u8,
    connect_timeout_secs: u16,
    max_time_secs: u16,
) -> Result<(), String> {
    let retries_str = retries.to_string();
    let connect_timeout_str = connect_timeout_secs.to_string();
    let max_time_str = max_time_secs.to_string();
    let curl = Command::new("curl")
        .arg("-fL")
        .arg("--retry")
        .arg(&retries_str)
        .arg("--retry-delay")
        .arg("2")
        .arg("--connect-timeout")
        .arg(&connect_timeout_str)
        .arg("--max-time")
        .arg(&max_time_str)
        .arg("-o")
        .arg(output_path)
        .arg(url)
        .output();

    match curl {
        Ok(out) if out.status.success() => Ok(()),
        Ok(out) => {
            let curl_stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            let wget_tries = format!("--tries={}", retries.max(1));
            let wget_timeout = format!("--timeout={}", max_time_secs);
            let wget = Command::new("wget")
                .arg("-O")
                .arg(output_path)
                .arg(&wget_tries)
                .arg(&wget_timeout)
                .arg(url)
                .output();
            match wget {
                Ok(wout) if wout.status.success() => Ok(()),
                Ok(wout) => {
                    let wget_stderr = String::from_utf8_lossy(&wout.stderr).trim().to_string();
                    Err(format!("curl: {}\nwget: {}", curl_stderr, wget_stderr))
                }
                Err(werr) => Err(format!(
                    "curl: {}\nwget invocation error: {}",
                    curl_stderr, werr
                )),
            }
        }
        Err(cerr) => {
            let wget_tries = format!("--tries={}", retries.max(1));
            let wget_timeout = format!("--timeout={}", max_time_secs);
            let wget = Command::new("wget")
                .arg("-O")
                .arg(output_path)
                .arg(&wget_tries)
                .arg(&wget_timeout)
                .arg(url)
                .output();
            match wget {
                Ok(wout) if wout.status.success() => Ok(()),
                Ok(wout) => {
                    let wget_stderr = String::from_utf8_lossy(&wout.stderr).trim().to_string();
                    Err(format!(
                        "curl invocation error: {}\nwget: {}",
                        cerr, wget_stderr
                    ))
                }
                Err(werr) => Err(format!(
                    "curl invocation error: {}\nwget invocation error: {}",
                    cerr, werr
                )),
            }
        }
    }
}

fn normalize_runtime_manifest(
    mut manifest: RuntimeReleaseManifest,
) -> Result<RuntimeReleaseManifest, String> {
    let version = manifest.version.trim();
    if version.is_empty() {
        return Err("manifest.version is empty".to_string());
    }

    let url = manifest.url.trim();
    if url.is_empty() {
        return Err("manifest.url is empty".to_string());
    }
    let parsed_url = Url::parse(url).map_err(|e| format!("manifest.url is invalid: {}", e))?;
    if parsed_url.scheme() != "https" {
        return Err("manifest.url must use https".to_string());
    }

    let sha = manifest.sha256.trim().to_ascii_lowercase();
    if sha.len() != 64 || !sha.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return Err("manifest.sha256 must be a 64-character hex digest".to_string());
    }

    manifest.version = version.to_string();
    manifest.url = url.to_string();
    manifest.sha256 = sha;
    Ok(manifest)
}

fn parse_runtime_manifest(raw: &str) -> Result<RuntimeReleaseManifest, String> {
    let manifest: RuntimeReleaseManifest =
        serde_json::from_str(raw).map_err(|e| format!("JSON parse error: {}", e))?;
    normalize_runtime_manifest(manifest)
}

fn read_cached_runtime_manifest() -> Option<RuntimeReleaseManifest> {
    let path = runtime_cached_manifest_path()?;
    let raw = fs::read_to_string(path).ok()?;
    parse_runtime_manifest(&raw).ok()
}

fn fetch_runtime_manifest_to_cache() -> Result<RuntimeReleaseManifest, String> {
    let manifest_url = runtime_manifest_url();
    let cache_dir = runtime_cache_dir()
        .ok_or_else(|| "Could not resolve home directory for runtime cache".to_string())?;
    fs::create_dir_all(&cache_dir).map_err(|e| {
        format!(
            "Failed to create runtime cache directory {}: {}",
            cache_dir.display(),
            e
        )
    })?;

    let final_path = runtime_cached_manifest_path()
        .ok_or_else(|| "Could not resolve runtime manifest cache path".to_string())?;
    let partial_path = runtime_cached_manifest_partial_path()
        .ok_or_else(|| "Could not resolve runtime manifest partial path".to_string())?;
    let _ = fs::remove_file(&partial_path);

    download_url_to_path(&manifest_url, &partial_path, 1, 3, 10).map_err(|e| {
        format!(
            "Runtime manifest download failed.\n\
             • URL: {}\n\
             • {}",
            manifest_url, e
        )
    })?;

    let raw = fs::read_to_string(&partial_path).map_err(|e| {
        format!(
            "Failed to read downloaded runtime manifest ({}): {}",
            partial_path.display(),
            e
        )
    })?;
    let manifest = parse_runtime_manifest(&raw)
        .map_err(|e| format!("Invalid runtime manifest from {}: {}", manifest_url, e))?;

    fs::rename(&partial_path, &final_path).map_err(|e| {
        format!(
            "Failed to store runtime manifest cache ({} -> {}): {}",
            partial_path.display(),
            final_path.display(),
            e
        )
    })?;

    Ok(manifest)
}

fn resolve_runtime_manifest() -> Result<RuntimeReleaseManifest, String> {
    if runtime_manifest_cache_fresh() {
        if let Some(manifest) = read_cached_runtime_manifest() {
            return Ok(manifest);
        }
    }

    match fetch_runtime_manifest_to_cache() {
        Ok(manifest) => Ok(manifest),
        Err(download_err) => {
            if let Some(cached_manifest) = read_cached_runtime_manifest() {
                println!(
                    "[Entropic] Runtime manifest refresh failed; using cached manifest: {}",
                    download_err
                );
                return Ok(cached_manifest);
            }
            Err(download_err)
        }
    }
}

fn parse_app_manifest(raw: &str) -> Result<AppReleaseManifest, String> {
    let mut manifest: AppReleaseManifest =
        serde_json::from_str(raw).map_err(|e| format!("JSON parse error: {}", e))?;
    let version = manifest.version.trim();
    if version.is_empty() {
        return Err("manifest.version is empty".to_string());
    }
    manifest.version = version.to_string();
    manifest.pub_date = manifest
        .pub_date
        .map(|raw| raw.trim().to_string())
        .filter(|raw| !raw.is_empty());
    Ok(manifest)
}

fn read_cached_app_manifest() -> Option<AppReleaseManifest> {
    let path = app_cached_manifest_path()?;
    let raw = fs::read_to_string(path).ok()?;
    parse_app_manifest(&raw).ok()
}

fn fetch_app_manifest_to_cache() -> Result<AppReleaseManifest, String> {
    let manifest_url = app_manifest_url();
    let cache_dir = runtime_cache_dir()
        .ok_or_else(|| "Could not resolve home directory for app manifest cache".to_string())?;
    fs::create_dir_all(&cache_dir).map_err(|e| {
        format!(
            "Failed to create app manifest cache directory {}: {}",
            cache_dir.display(),
            e
        )
    })?;

    let final_path = app_cached_manifest_path()
        .ok_or_else(|| "Could not resolve app manifest cache path".to_string())?;
    let partial_path = app_cached_manifest_partial_path()
        .ok_or_else(|| "Could not resolve app manifest partial path".to_string())?;
    let _ = fs::remove_file(&partial_path);

    download_url_to_path(&manifest_url, &partial_path, 1, 3, 10).map_err(|e| {
        format!(
            "App manifest download failed.\n\
             • URL: {}\n\
             • {}",
            manifest_url, e
        )
    })?;

    let raw = fs::read_to_string(&partial_path).map_err(|e| {
        format!(
            "Failed to read downloaded app manifest ({}): {}",
            partial_path.display(),
            e
        )
    })?;
    let manifest = parse_app_manifest(&raw)
        .map_err(|e| format!("Invalid app manifest from {}: {}", manifest_url, e))?;

    fs::rename(&partial_path, &final_path).map_err(|e| {
        format!(
            "Failed to store app manifest cache ({} -> {}): {}",
            partial_path.display(),
            final_path.display(),
            e
        )
    })?;

    Ok(manifest)
}

fn resolve_app_manifest() -> Result<AppReleaseManifest, String> {
    if app_manifest_cache_fresh() {
        if let Some(manifest) = read_cached_app_manifest() {
            return Ok(manifest);
        }
    }

    match fetch_app_manifest_to_cache() {
        Ok(manifest) => Ok(manifest),
        Err(download_err) => {
            if let Some(cached_manifest) = read_cached_app_manifest() {
                println!(
                    "[Entropic] App manifest refresh failed; using cached manifest: {}",
                    download_err
                );
                return Ok(cached_manifest);
            }
            Err(download_err)
        }
    }
}

fn sha256_for_file(path: &Path) -> Result<String, String> {
    let mut file =
        fs::File::open(path).map_err(|e| format!("Failed to open {}: {}", path.display(), e))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 8192];
    loop {
        let read = file
            .read(&mut buf)
            .map_err(|e| format!("Failed reading {}: {}", path.display(), e))?;
        if read == 0 {
            break;
        }
        hasher.update(&buf[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn cached_runtime_tar_checksum_marker_valid(expected_sha: &str, tar_path: &Path) -> bool {
    let Some(checksum_path) = runtime_cached_tar_checksum_path() else {
        return false;
    };

    let checksum_mtime = checksum_path
        .metadata()
        .ok()
        .and_then(|m| m.modified().ok());
    let tar_mtime = tar_path.metadata().ok().and_then(|m| m.modified().ok());
    let fresh_marker = match (checksum_mtime, tar_mtime) {
        (Some(checksum_mtime), Some(tar_mtime)) => checksum_mtime >= tar_mtime,
        _ => false,
    };
    if !fresh_marker {
        return false;
    }

    let raw = match fs::read_to_string(&checksum_path) {
        Ok(raw) => raw,
        Err(_) => return false,
    };
    let cached = raw
        .split_whitespace()
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    !cached.is_empty() && cached == expected_sha
}

fn runtime_cached_tar_matches_sha(tar_path: &Path, expected_sha: &str) -> Result<bool, String> {
    let tar_exists = tar_path
        .metadata()
        .map(|m| m.is_file() && m.len() > 0)
        .unwrap_or(false);
    if !tar_exists {
        return Ok(false);
    }

    let expected = expected_sha.trim().to_ascii_lowercase();
    if cached_runtime_tar_checksum_marker_valid(&expected, tar_path) {
        return Ok(true);
    }

    let actual = sha256_for_file(tar_path)?;
    if actual == expected {
        if let Some(checksum_path) = runtime_cached_tar_checksum_path() {
            let _ = fs::write(checksum_path, format!("{}\n", expected));
        }
        return Ok(true);
    }
    Ok(false)
}

fn download_runtime_tar_to_cache_from_url(
    url: &str,
    max_time_secs: u16,
) -> Result<PathBuf, String> {
    let cache_dir = runtime_cache_dir()
        .ok_or_else(|| "Could not resolve home directory for runtime cache".to_string())?;
    fs::create_dir_all(&cache_dir).map_err(|e| {
        format!(
            "Failed to create runtime cache directory {}: {}",
            cache_dir.display(),
            e
        )
    })?;

    let final_path = runtime_cached_tar_path()
        .ok_or_else(|| "Could not resolve runtime cache tar path".to_string())?;

    let partial_path = runtime_cached_tar_partial_path()
        .ok_or_else(|| "Could not resolve runtime cache partial path".to_string())?;
    let _ = fs::remove_file(&partial_path);

    download_url_to_path(url, &partial_path, 2, 10, max_time_secs).map_err(|e| {
        format!(
            "Runtime tar download failed.\n\
             • URL: {}\n\
             • {}",
            url, e
        )
    })?;

    let partial_meta = partial_path.metadata().map_err(|e| {
        format!(
            "Downloaded runtime tar missing at {}: {}",
            partial_path.display(),
            e
        )
    })?;
    if partial_meta.len() == 0 {
        let _ = fs::remove_file(&partial_path);
        return Err(format!(
            "Downloaded runtime tar is empty: {}",
            partial_path.display()
        ));
    }

    fs::rename(&partial_path, &final_path).map_err(|e| {
        format!(
            "Failed to move runtime tar into cache ({} -> {}): {}",
            partial_path.display(),
            final_path.display(),
            e
        )
    })?;

    Ok(final_path)
}

fn download_runtime_tar_from_manifest_to_cache(max_time_secs: u16) -> Result<PathBuf, String> {
    let manifest = resolve_runtime_manifest()?;
    let cache_dir = runtime_cache_dir()
        .ok_or_else(|| "Could not resolve home directory for runtime cache".to_string())?;
    fs::create_dir_all(&cache_dir).map_err(|e| {
        format!(
            "Failed to create runtime cache directory {}: {}",
            cache_dir.display(),
            e
        )
    })?;

    let final_path = runtime_cached_tar_path()
        .ok_or_else(|| "Could not resolve runtime cache tar path".to_string())?;
    if runtime_cached_tar_matches_sha(&final_path, &manifest.sha256)? {
        return Ok(final_path);
    }

    let partial_path = runtime_cached_tar_partial_path()
        .ok_or_else(|| "Could not resolve runtime cache partial path".to_string())?;
    let _ = fs::remove_file(&partial_path);

    download_url_to_path(&manifest.url, &partial_path, 2, 10, max_time_secs).map_err(|e| {
        format!(
            "Runtime tar download failed for manifest version {}.\n\
             • URL: {}\n\
             • {}",
            manifest.version, manifest.url, e
        )
    })?;

    let partial_meta = partial_path.metadata().map_err(|e| {
        format!(
            "Downloaded runtime tar missing at {}: {}",
            partial_path.display(),
            e
        )
    })?;
    if partial_meta.len() == 0 {
        let _ = fs::remove_file(&partial_path);
        return Err(format!(
            "Downloaded runtime tar is empty: {}",
            partial_path.display()
        ));
    }

    let actual_sha = sha256_for_file(&partial_path)?;
    if actual_sha != manifest.sha256 {
        let _ = fs::remove_file(&partial_path);
        return Err(format!(
            "Runtime tar sha256 mismatch for manifest version {}.\n\
             • URL: {}\n\
             • expected: {}\n\
             • actual: {}",
            manifest.version, manifest.url, manifest.sha256, actual_sha
        ));
    }

    fs::rename(&partial_path, &final_path).map_err(|e| {
        format!(
            "Failed to move runtime tar into cache ({} -> {}): {}",
            partial_path.display(),
            final_path.display(),
            e
        )
    })?;

    if let Some(checksum_path) = runtime_cached_tar_checksum_path() {
        let _ = fs::write(checksum_path, format!("{}\n", manifest.sha256));
    }

    Ok(final_path)
}

fn download_runtime_tar_to_cache(
    allow_direct_url_fallback: bool,
    tar_max_time_secs: u16,
) -> Result<PathBuf, String> {
    match download_runtime_tar_from_manifest_to_cache(tar_max_time_secs) {
        Ok(path) => Ok(path),
        Err(manifest_err) => {
            println!("[Entropic] Runtime manifest sync failed: {}", manifest_err);

            if allow_direct_url_fallback {
                println!("[Entropic] Trying direct runtime tar URL fallback...");
                let fallback_url = runtime_release_tar_url();
                match download_runtime_tar_to_cache_from_url(&fallback_url, tar_max_time_secs) {
                    Ok(path) => return Ok(path),
                    Err(url_err) => {
                        if runtime_cached_tar_valid() {
                            if let Some(path) = runtime_cached_tar_path() {
                                println!(
                                    "[Entropic] Runtime tar URL fallback failed; using stale cached runtime tar: {}",
                                    url_err
                                );
                                return Ok(path);
                            }
                        }
                        return Err(format!(
                            "Runtime manifest sync failed: {}\n\
                             Runtime tar fallback failed from {}: {}",
                            manifest_err, fallback_url, url_err
                        ));
                    }
                }
            }

            if runtime_cached_tar_valid() {
                if let Some(path) = runtime_cached_tar_path() {
                    return Ok(path);
                }
            }

            Err(manifest_err)
        }
    }
}

/// Registry to pull the scanner image from when not available locally.
/// Only used as an explicit fallback when ENTROPIC_SCANNER_REGISTRY is set.
fn scanner_registry_image() -> Option<String> {
    // Build-time override
    if let Some(val) = option_env!("ENTROPIC_SCANNER_REGISTRY") {
        let trimmed = val.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    // Runtime override
    if let Ok(val) = std::env::var("ENTROPIC_SCANNER_REGISTRY") {
        let trimmed = val.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    None
}

/// Scanner source repo pin.
/// Override with ENTROPIC_SCANNER_GIT_REPO.
fn scanner_git_repo() -> String {
    if let Some(val) = option_env!("ENTROPIC_SCANNER_GIT_REPO") {
        let trimmed = val.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    if let Ok(val) = std::env::var("ENTROPIC_SCANNER_GIT_REPO") {
        let trimmed = val.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    DEFAULT_SCANNER_GIT_REPO.to_string()
}

/// Scanner source commit pin.
/// Override with ENTROPIC_SCANNER_GIT_COMMIT.
fn scanner_git_commit() -> String {
    if let Some(val) = option_env!("ENTROPIC_SCANNER_GIT_COMMIT") {
        let trimmed = val.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    if let Ok(val) = std::env::var("ENTROPIC_SCANNER_GIT_COMMIT") {
        let trimmed = val.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    DEFAULT_SCANNER_GIT_COMMIT.to_string()
}

/// Python base image used for the scanner template build.
/// Override with ENTROPIC_SCANNER_BASE_IMAGE.
fn scanner_base_image() -> String {
    if let Some(val) = option_env!("ENTROPIC_SCANNER_BASE_IMAGE") {
        let trimmed = val.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    if let Ok(val) = std::env::var("ENTROPIC_SCANNER_BASE_IMAGE") {
        let trimmed = val.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    "python:3.11-slim".to_string()
}

/// Pip install spec for scanner template build.
/// Override with ENTROPIC_SCANNER_PIP_SPEC (for example:
/// git+https://github.com/cisco-ai-defense/skill-scanner.git@<commit>).
fn scanner_pip_spec() -> String {
    if let Some(val) = option_env!("ENTROPIC_SCANNER_PIP_SPEC") {
        let trimmed = val.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    if let Ok(val) = std::env::var("ENTROPIC_SCANNER_PIP_SPEC") {
        let trimmed = val.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    format!("git+{}@{}", scanner_git_repo(), scanner_git_commit())
}

/// Image tag key for scanner cache invalidation.
/// Changing the scanner source pin or base image yields a new image tag,
/// so scanner updates happen automatically after commit-hash bumps.
fn scanner_image_name_for(base_image: &str, pip_spec: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(base_image.as_bytes());
    hasher.update(b"|");
    hasher.update(pip_spec.as_bytes());
    let digest = hasher.finalize();
    let tag = digest[..6]
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect::<String>();
    format!("{}:{}", SCANNER_IMAGE_REPO, tag)
}

fn scanner_image_name() -> String {
    scanner_image_name_for(&scanner_base_image(), &scanner_pip_spec())
}

fn validate_scanner_build_arg(name: &str, value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(format!("{} is empty", name));
    }
    if trimmed.contains('\n') || trimmed.contains('\r') {
        return Err(format!("{} contains a newline, which is not allowed", name));
    }
    Ok(trimmed.to_string())
}

fn build_scanner_image_from_template() -> Result<(), String> {
    let base_image =
        validate_scanner_build_arg("ENTROPIC_SCANNER_BASE_IMAGE", &scanner_base_image())?;
    let pip_spec = validate_scanner_build_arg("ENTROPIC_SCANNER_PIP_SPEC", &scanner_pip_spec())?;
    let scanner_image = scanner_image_name_for(&base_image, &pip_spec);

    let build_root = std::env::temp_dir().join("entropic-skill-scanner-build");
    fs::create_dir_all(&build_root)
        .map_err(|e| format!("Failed to create scanner build directory: {}", e))?;

    let dockerfile = build_root.join("Dockerfile");
    let dockerfile_contents = r#"# syntax=docker/dockerfile:1
ARG SCANNER_BASE_IMAGE=python:3.11-slim
FROM ${SCANNER_BASE_IMAGE}

ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

ARG SCANNER_PIP_SPEC=git+https://github.com/cisco-ai-defense/skill-scanner.git@dff88dc5fa0fff6382ddb6eff19d245745b93f7a
RUN python -m pip install --no-cache-dir --upgrade pip && \
    python -m pip install --no-cache-dir "$SCANNER_PIP_SPEC"

EXPOSE 8000
CMD ["skill-scanner-api", "--host", "0.0.0.0", "--port", "8000"]
"#;
    fs::write(&dockerfile, dockerfile_contents)
        .map_err(|e| format!("Failed to write scanner Dockerfile: {}", e))?;

    println!(
        "[Entropic] Building scanner image from template (image={}, base={}, pip={})...",
        scanner_image, base_image, pip_spec
    );
    let build = docker_command()
        .args([
            "build",
            "--pull",
            "--build-arg",
            &format!("SCANNER_BASE_IMAGE={}", base_image),
            "--build-arg",
            &format!("SCANNER_PIP_SPEC={}", pip_spec),
            "-t",
            &scanner_image,
            "-f",
        ])
        .arg(&dockerfile)
        .arg(&build_root)
        .output()
        .map_err(|e| format!("Failed to build scanner image: {}", e))?;

    if !build.status.success() {
        let stderr = String::from_utf8_lossy(&build.stderr);
        let stdout = String::from_utf8_lossy(&build.stdout);
        return Err(format!(
            "Scanner image build failed: {}{}{}",
            stderr.trim(),
            if stderr.trim().is_empty() || stdout.trim().is_empty() {
                ""
            } else {
                " | "
            },
            stdout.trim()
        ));
    }

    println!("[Entropic] Scanner image built successfully from template");
    Ok(())
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

    Ok(RuntimeImageInspectState::Unavailable(
        if stderr.is_empty() {
            "unknown docker inspect failure".to_string()
        } else {
            stderr
        },
    ))
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

fn normalize_runtime_image_digest(value: &str) -> String {
    value
        .trim()
        .trim_start_matches("sha256:")
        .trim()
        .to_ascii_lowercase()
}

fn runtime_image_matches_tar(image_id: &str, tar_path: &Path) -> bool {
    let Ok(signature) = bundled_runtime_signature_from_manifest(tar_path) else {
        return false;
    };
    normalize_runtime_image_digest(image_id) == normalize_runtime_image_digest(&signature)
}

fn resolve_applied_runtime_from_cache(image_id: &str) -> Option<(String, Option<String>)> {
    let cached_tar = runtime_cached_tar_path()?;
    if !cached_tar.is_file() {
        return None;
    }
    if !runtime_image_matches_tar(image_id, &cached_tar) {
        return None;
    }
    let manifest = read_cached_runtime_manifest()?;
    let commit = manifest
        .openclaw_commit
        .map(|raw| raw.trim().to_string())
        .filter(|value| !value.is_empty());
    Some((manifest.version, commit))
}

fn find_local_runtime_tar() -> Option<PathBuf> {
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
            if tar_path.is_file() {
                return Some(tar_path);
            }
        }
    }

    None
}

fn should_prefer_cached_runtime_tar() -> bool {
    if cfg!(debug_assertions) || !runtime_cached_tar_valid() {
        return false;
    }

    let Some(manifest) = read_cached_runtime_manifest() else {
        return false;
    };

    let cached_version = manifest.version.trim();
    !cached_version.is_empty() && cached_version != runtime_release_tag()
}

fn find_runtime_tar() -> Option<PathBuf> {
    if should_prefer_cached_runtime_tar() {
        if let Some(cached_path) = runtime_cached_tar_path() {
            if cached_path.is_file() {
                return Some(cached_path);
            }
        }
    }
    if let Some(local_path) = find_local_runtime_tar() {
        return Some(local_path);
    }
    if let Some(cached_path) = runtime_cached_tar_path() {
        if cached_path.is_file() {
            return Some(cached_path);
        }
    }
    None
}

fn find_scanner_tar() -> Option<PathBuf> {
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
        for name in &[
            "entropic-skill-scanner.tar.gz",
            "entropic-skill-scanner.tar",
            "skill-scanner.tar.gz",
            "skill-scanner.tar",
        ] {
            let tar_path = dir.join(name);
            if tar_path.exists() {
                return Some(tar_path);
            }
        }
    }

    None
}

fn load_runtime_from_tar(tar_path: &Path) -> Result<bool, String> {
    println!(
        "[Entropic] Loading runtime image from {}",
        tar_path.display()
    );
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

fn load_scanner_from_tar(tar_path: &Path) -> Result<bool, String> {
    println!(
        "[Entropic] Loading scanner image from {}",
        tar_path.display()
    );
    let load = docker_command()
        .args(["load", "-i"])
        .arg(tar_path)
        .output()
        .map_err(|e| format!("docker load failed: {}", e))?;
    if load.status.success() {
        println!("[Entropic] Scanner image loaded from bundled tar");
        return Ok(true);
    }
    let stderr = String::from_utf8_lossy(&load.stderr);
    println!("[Entropic] Scanner docker load failed: {}", stderr);
    Ok(false)
}

fn download_scanner_tar_from_release(scanner_image: &str) -> Result<(), String> {
    let url = scanner_release_tar_url();
    println!("[Entropic] Downloading scanner image from {}...", url);

    let temp_dir = std::env::temp_dir().join("entropic-scanner-download");
    fs::create_dir_all(&temp_dir).map_err(|e| format!("Failed to create temp directory: {}", e))?;

    let temp_tar = temp_dir.join("scanner.tar.gz");

    let download = std::process::Command::new("curl")
        .args(["-fSL", "--max-time", "300", "-o"])
        .arg(&temp_tar)
        .arg(&url)
        .output()
        .map_err(|e| format!("curl failed: {}", e))?;

    if !download.status.success() {
        let stderr = String::from_utf8_lossy(&download.stderr);
        return Err(format!(
            "Failed to download scanner tar from {}: {}",
            url, stderr
        ));
    }

    println!("[Entropic] Loading scanner image from downloaded tar...");
    let load = docker_command()
        .args(["load", "-i"])
        .arg(&temp_tar)
        .output()
        .map_err(|e| format!("docker load failed: {}", e))?;

    let _ = fs::remove_file(&temp_tar);
    let _ = fs::remove_dir(&temp_dir);

    if !load.status.success() {
        let stderr = String::from_utf8_lossy(&load.stderr);
        return Err(format!("Failed to load scanner image: {}", stderr));
    }

    // Check if the expected image is now present
    let check = docker_command()
        .args(["image", "inspect", scanner_image])
        .output()
        .map_err(|e| format!("Failed to check scanner image: {}", e))?;

    if check.status.success() {
        println!("[Entropic] Scanner image downloaded and loaded successfully");
        return Ok(());
    }

    // Try tagging from legacy :latest if needed
    let legacy_latest = format!("{}:latest", SCANNER_IMAGE_REPO);
    let legacy_check = docker_command()
        .args(["image", "inspect", &legacy_latest])
        .output()
        .map(|out| out.status.success())
        .unwrap_or(false);

    if legacy_check {
        let _ = docker_command()
            .args(["tag", &legacy_latest, scanner_image])
            .output();

        let recheck = docker_command()
            .args(["image", "inspect", scanner_image])
            .output()
            .map(|out| out.status.success())
            .unwrap_or(false);

        if recheck {
            println!("[Entropic] Scanner image tagged from legacy :latest");
            return Ok(());
        }
    }

    Err("Scanner image not found after download and load".to_string())
}

fn ensure_runtime_image() -> Result<(), String> {
    let local_runtime_tar = find_local_runtime_tar();
    let local_image_present = runtime_image_id()?.is_some();
    if local_runtime_tar.is_none() {
        if let Err(sync_err) =
            download_runtime_tar_to_cache(!local_image_present, RUNTIME_TAR_MAX_TIME_SECS)
        {
            println!(
                "[Entropic] Runtime tar cache refresh skipped/failed: {}",
                sync_err
            );
        }
    }

    let mut runtime_tar_path = local_runtime_tar;
    if runtime_tar_path.is_none() {
        runtime_tar_path = find_runtime_tar();
    }

    let mut require_local_reload = false;

    if let Some(tar_path) = runtime_tar_path.as_ref() {
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

    println!("[Entropic] Runtime image not found locally, attempting to load...");

    if let Some(tar_path) = runtime_tar_path.as_ref() {
        match load_runtime_from_tar(&tar_path) {
            Ok(true) => return Ok(()),
            Ok(false) => {} // no tar found or load failed, continue
            Err(e) => println!("[Entropic] Bundled tar check failed: {}", e),
        }
    }

    // 3. Pull from registry fallback (if configured)
    if let Some(registry_image) = runtime_registry_image() {
        println!(
            "[Entropic] Pulling runtime image from {}...",
            registry_image
        );
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
        return Err(format!(
            "OpenClaw runtime image not available.\n\
             • Pull failed from {}: {}\n\
             • No cached or bundled runtime image tar found.\n\
             • To build locally: ./scripts/build-openclaw-runtime.sh",
            registry_image,
            stderr.trim()
        ));
    }

    Err("OpenClaw runtime image not available.\n\
         • No cached or bundled runtime image tar found.\n\
         • Registry pull fallback is disabled (set OPENCLAW_RUNTIME_REGISTRY to enable).\n\
         • To build locally: ./scripts/build-openclaw-runtime.sh"
        .to_string())
}

/// Ensure the scanner image is available locally.
/// 1. If already present → return Ok immediately.
/// 2. Try loading a bundled tar (resources/entropic-skill-scanner.tar.gz or .tar).
/// 3. Build from lightweight template + pip install (cached in Docker).
/// 4. If configured, pull from registry as explicit fallback.
/// 5. Return an error if the image is still missing.
fn ensure_scanner_image() -> Result<(), String> {
    let scanner_image = scanner_image_name();
    let check = docker_command()
        .args(["image", "inspect", scanner_image.as_str()])
        .output()
        .map_err(|e| format!("Failed to check scanner image: {}", e))?;
    if check.status.success() {
        return Ok(());
    }

    if let Some(tar_path) = find_scanner_tar() {
        match load_scanner_from_tar(&tar_path) {
            Ok(true) => {
                let expected_present = docker_command()
                    .args(["image", "inspect", scanner_image.as_str()])
                    .output()
                    .map(|out| out.status.success())
                    .unwrap_or(false);
                if expected_present {
                    return Ok(());
                }

                // Compatibility path for legacy bundled tars tagged as :latest.
                let legacy_latest = format!("{}:latest", SCANNER_IMAGE_REPO);
                let legacy_present = docker_command()
                    .args(["image", "inspect", legacy_latest.as_str()])
                    .output()
                    .map(|out| out.status.success())
                    .unwrap_or(false);
                if legacy_present {
                    let _ = docker_command()
                        .args(["tag", legacy_latest.as_str(), scanner_image.as_str()])
                        .output();
                    let retagged_present = docker_command()
                        .args(["image", "inspect", scanner_image.as_str()])
                        .output()
                        .map(|out| out.status.success())
                        .unwrap_or(false);
                    if retagged_present {
                        return Ok(());
                    }
                }
            }
            Ok(false) => {} // continue to fallback
            Err(e) => println!("[Entropic] Bundled scanner tar check failed: {}", e),
        }
    }

    // Try downloading from runtime release before building from template.
    println!("[Entropic] Scanner image not bundled; trying runtime release download...");
    match download_scanner_tar_from_release(scanner_image.as_str()) {
        Ok(()) => {
            println!("[Entropic] Scanner image downloaded from runtime release");
            return Ok(());
        }
        Err(e) => {
            println!(
                "[Entropic] Scanner download from runtime release failed: {}",
                e
            );
        }
    }

    // Build from template (first-run only) and rely on Docker image cache afterwards.
    println!("[Entropic] Building scanner image from template...");
    let build_result = build_scanner_image_from_template();
    if build_result.is_ok() {
        return Ok(());
    }
    let build_err = match build_result {
        Ok(_) => String::new(),
        Err(err) => err,
    };

    // Optional registry fallback (only when explicitly configured).
    if let Some(registry_image) = scanner_registry_image() {
        println!(
            "[Entropic] Scanner template build failed; pulling fallback image from {}...",
            registry_image
        );
        let pull = docker_command()
            .args(["pull", &registry_image])
            .output()
            .map_err(|e| format!("docker pull failed: {}", e))?;

        if pull.status.success() {
            if registry_image != scanner_image {
                let _ = docker_command()
                    .args(["tag", &registry_image, scanner_image.as_str()])
                    .output();
            }
            println!("[Entropic] Scanner image pulled successfully");
            return Ok(());
        }

        let stderr = String::from_utf8_lossy(&pull.stderr);
        println!("[Entropic] Scanner pull failed: {}", stderr);
        return Err(format!(
            "Skill scanner image not available.\n\
             • Template build failed: {}\n\
             • Pull failed from {}: {}\n\
             • Scanner-based skill checks will stay unavailable until scanner dependencies are reachable.",
            build_err,
            registry_image,
            stderr.trim()
        ));
    }

    Err(format!(
        "Skill scanner image not available.\n\
         • Template build failed: {}\n\
         • No bundled scanner tar or registry fallback was configured.\n\
         • Scanner source pin: {}\n\
         • Scanner-based skill checks will stay unavailable until scanner dependencies are reachable.",
        build_err,
        scanner_pip_spec()
    ))
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
        .header(
            "Sec-WebSocket-Key",
            tokio_tungstenite::tungstenite::handshake::client::generate_key(),
        )
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
    /// Opaque attachment IDs mapped to container temp upload paths.
    pending_attachments: Mutex<HashMap<String, PendingAttachmentRecord>>,
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
            pending_attachments: Mutex::new(HashMap::new()),
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
pub struct OperationalBundleStatus {
    pub resources_dir: String,
    pub bin_dir_exists: bool,
    pub share_dir_exists: bool,
    pub colima_binary: bool,
    pub limactl_binary: bool,
    pub docker_binary: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct OperationalHealthSnapshot {
    pub runtime: RuntimeStatus,
    pub gateway_running: bool,
    pub gateway_container_health: Option<String>,
    pub gateway_instance_id: Option<String>,
    pub watchdog: WatchdogStatusSnapshot,
    pub bundle: OperationalBundleStatus,
    pub recent_incidents: Vec<IncidentRecord>,
    pub recent_warn_count: usize,
    pub recent_error_count: usize,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct OperationalDoctorFinding {
    pub severity: String,
    pub title: String,
    pub detail: String,
    pub recommendation: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct OperationalDoctorReport {
    pub status: String,
    pub summary: String,
    pub findings: Vec<OperationalDoctorFinding>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct AgentProfileState {
    pub soul: String,
    pub identity_name: String,
    pub identity_avatar: Option<String>,
    pub heartbeat_every: String,
    pub heartbeat_tasks: Vec<String>,
    pub memory_enabled: bool,
    pub memory_long_term: bool,
    pub memory_qmd_enabled: bool,
    pub memory_sessions_enabled: bool,
    pub capabilities: Vec<CapabilityState>,
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
    pub size_bytes: u64,
    pub is_image: bool,
}

#[derive(Debug, Clone)]
struct PendingAttachmentRecord {
    file_name: String,
    temp_path: String,
    created_at_ms: u64,
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
    memory_qmd_enabled: bool,
    memory_sessions_enabled: bool,
    capabilities: Vec<CapabilityState>,
    identity_name: String,
    identity_avatar: Option<String>,
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
            memory_qmd_enabled: false,
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

fn operational_bundle_status(app: &AppHandle) -> OperationalBundleStatus {
    let resources_dir = app.path().resource_dir().unwrap_or_default();
    let bundle_root = resources_dir.join("resources");
    let bin_dir = bundle_root.join("bin");
    let share_dir = bundle_root.join("share");
    OperationalBundleStatus {
        resources_dir: resources_dir.display().to_string(),
        bin_dir_exists: bin_dir.exists(),
        share_dir_exists: share_dir.exists(),
        colima_binary: bin_dir.join("colima").exists(),
        limactl_binary: bin_dir.join("limactl").exists(),
        docker_binary: bin_dir.join("docker").exists(),
    }
}

fn build_operational_health_snapshot(app: &AppHandle) -> Result<OperationalHealthSnapshot, String> {
    let runtime = RuntimeSupervisor::new(app).check_status();
    let desired = watchdog::load_desired_state(app)?;
    watchdog::sync_status_with_desired(&desired);
    let gateway_running = gateway_container_exists(true);
    let gateway_container_health = if gateway_running {
        container_health_status()
    } else {
        None
    };
    let gateway_instance_id = if gateway_running {
        container_instance_id()
    } else {
        None
    };
    let recent_incidents = operational::read_recent_incidents(app, Some(25))?;
    let recent_warn_count = recent_incidents
        .iter()
        .filter(|entry| entry.level == "warn")
        .count();
    let recent_error_count = recent_incidents
        .iter()
        .filter(|entry| entry.level == "error")
        .count();

    Ok(OperationalHealthSnapshot {
        runtime,
        gateway_running,
        gateway_container_health,
        gateway_instance_id,
        watchdog: watchdog::current_status(),
        bundle: operational_bundle_status(app),
        recent_incidents,
        recent_warn_count,
        recent_error_count,
    })
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
const WATCHDOG_RECONCILE_INTERVAL_MS: u64 = 5_000;
const WATCHDOG_EXPECTED_RESTART_WINDOW_MS: u64 = 30_000;
const WATCHDOG_BASE_BACKOFF_MS: u64 = 5_000;
const WATCHDOG_MAX_BACKOFF_MS: u64 = 60_000;
const ATTACHMENT_TMP_ROOT: &str = "/home/node/.openclaw/uploads/tmp";
const ATTACHMENT_SAVE_ROOT: &str = "/data/uploads";
const ATTACHMENT_ID_RANDOM_BYTES: usize = 18;
const ATTACHMENT_MAX_PENDING: usize = 256;
const ATTACHMENT_PENDING_TTL_MS: u64 = 60 * 60 * 1000;
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

fn clear_applied_agent_settings_fingerprint() -> Result<(), String> {
    let mut cache = applied_agent_settings_fingerprint()
        .lock()
        .map_err(|e| e.to_string())?;
    *cache = None;
    Ok(())
}

fn watchdog_backoff_ms(failures: u32) -> u64 {
    let exponent = failures.saturating_sub(1).min(4);
    let factor = 1u64 << exponent;
    (WATCHDOG_BASE_BACKOFF_MS.saturating_mul(factor)).min(WATCHDOG_MAX_BACKOFF_MS)
}

fn set_desired_gateway_state(app: &AppHandle, desired: DesiredGatewayState) -> Result<(), String> {
    watchdog::save_desired_state(app, &desired)?;
    watchdog::sync_status_with_desired(&desired);
    Ok(())
}

fn clear_desired_gateway_state(app: &AppHandle) -> Result<(), String> {
    set_desired_gateway_state(
        app,
        watchdog::desired_state_with_mode("stopped", None, None, None, None),
    )?;
    watchdog::clear_expected_restart();
    Ok(())
}

fn desired_state_requires_proxy_fields(desired: &DesiredGatewayState) -> bool {
    desired.mode == "proxy"
        && desired
            .proxy_token
            .as_deref()
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false)
        && desired
            .proxy_url
            .as_deref()
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false)
}

fn desired_base_model(desired: &DesiredGatewayState) -> Option<String> {
    desired.model.as_ref().map(|model| {
        model
            .split_once(':')
            .map(|(base, _)| base.to_string())
            .unwrap_or_else(|| model.to_string())
    })
}

fn gateway_matches_desired_state(app: &AppHandle, desired: &DesiredGatewayState) -> bool {
    if !gateway_container_exists(true) {
        return false;
    }

    let current_gateway_token = read_container_env("OPENCLAW_GATEWAY_TOKEN");
    let expected_gateway_token = effective_gateway_token(app).ok();
    if current_gateway_token != expected_gateway_token {
        return false;
    }

    let current_model = read_container_env("OPENCLAW_MODEL");
    if let Some(expected_model) = desired_base_model(desired) {
        if current_model.as_deref() != Some(expected_model.as_str()) {
            return false;
        }
    }

    match desired.mode.as_str() {
        "local" => {
            let current_proxy_mode = read_container_env("ENTROPIC_PROXY_MODE");
            let legacy_proxy_mode = read_container_env("NOVA_PROXY_MODE");
            current_proxy_mode.as_deref() != Some("1") && legacy_proxy_mode.as_deref() != Some("1")
        }
        "proxy" => {
            let current_proxy_mode = read_container_env("ENTROPIC_PROXY_MODE");
            if current_proxy_mode.as_deref() != Some("1") {
                return false;
            }

            let expected_proxy_url = desired
                .proxy_url
                .as_deref()
                .and_then(|url| resolve_container_proxy_base(url).ok())
                .map(|resolved| resolve_container_openai_base(&resolved));
            if let Some(expected_proxy_url) = expected_proxy_url {
                if read_container_env("ENTROPIC_PROXY_BASE_URL").as_deref()
                    != Some(expected_proxy_url.as_str())
                {
                    return false;
                }
            }

            if let Some(expected_proxy_token) = desired.proxy_token.as_deref() {
                if read_container_env("OPENROUTER_API_KEY").as_deref() != Some(expected_proxy_token)
                {
                    return false;
                }
            }

            if let Some(expected_image_model) = desired.image_model.as_deref() {
                if !expected_image_model.trim().is_empty()
                    && read_container_env("OPENCLAW_IMAGE_MODEL").as_deref()
                        != Some(expected_image_model)
                {
                    return false;
                }
            }

            true
        }
        _ => false,
    }
}

fn has_any_local_provider_key(app: &AppHandle) -> Result<bool, String> {
    let state = app.state::<AppState>();
    let keys = state.api_keys.lock().map_err(|e| e.to_string())?;
    Ok(
        keys.contains_key("anthropic")
            || keys.contains_key("openai")
            || keys.contains_key("google"),
    )
}

async fn reconcile_watchdog(app: &AppHandle) -> Result<(), String> {
    let desired = match watchdog::load_desired_state(app) {
        Ok(desired) => desired,
        Err(error) => {
            watchdog::update_status(|status| {
                status.state = "error".to_string();
                status.last_error = Some(error.clone());
                status.last_check_at_ms = now_ms_u64();
            });
            operational::record_incident(
                app,
                "error",
                "watchdog",
                "state_load_failed",
                "Failed to load watchdog desired state",
                Some(&error),
            );
            return Ok(());
        }
    };
    watchdog::sync_status_with_desired(&desired);

    let now = now_ms_u64();
    let gateway_running = gateway_container_exists(true);
    let gateway_health = if gateway_running {
        container_health_status()
    } else {
        None
    };
    watchdog::update_status(|status| {
        status.last_check_at_ms = now;
        status.actual_gateway_running = gateway_running;
        status.actual_gateway_health = gateway_health.clone();
    });

    if !watchdog::desired_gateway_running(&desired.mode) {
        return Ok(());
    }

    let snapshot = watchdog::current_status();
    if snapshot.expected_restart_until_ms > now {
        watchdog::update_status(|status| {
            status.state = "expected_restart".to_string();
        });
        return Ok(());
    }

    if snapshot.cooldown_until_ms > now {
        watchdog::update_status(|status| {
            status.state = "cooldown".to_string();
        });
        return Ok(());
    }

    if desired.mode == "local" && !has_any_local_provider_key(app)? {
        watchdog::update_status(|status| {
            status.state = "waiting_for_local_secrets".to_string();
            status.last_error = Some(
                "Desired state expects local-key mode, but provider keys have not been hydrated into the backend yet."
                    .to_string(),
            );
            status.last_reason = Some("local_keys_missing".to_string());
        });
        return Ok(());
    }

    if desired.mode == "proxy" && !desired_state_requires_proxy_fields(&desired) {
        watchdog::update_status(|status| {
            status.state = "missing_proxy_config".to_string();
            status.last_error = Some(
                "Desired proxy mode is missing its restart token or proxy base URL.".to_string(),
            );
            status.last_reason = Some("proxy_config_missing".to_string());
        });
        return Ok(());
    }

    let gateway_healthy = gateway_running
        && gateway_matches_desired_state(app, &desired)
        && gateway::get_gateway_status_internal(app)
            .await
            .unwrap_or(false);
    if gateway_healthy {
        watchdog::update_status(|status| {
            status.state = "monitoring".to_string();
            status.consecutive_failures = 0;
            status.cooldown_until_ms = 0;
            status.expected_restart_until_ms = 0;
            status.last_error = None;
            status.last_reason = None;
        });
        return Ok(());
    }

    let reason = if !gateway_running {
        "gateway_missing".to_string()
    } else if !gateway_matches_desired_state(app, &desired) {
        "gateway_drifted_from_desired_state".to_string()
    } else {
        gateway_health
            .clone()
            .map(|value| format!("gateway_unhealthy:{value}"))
            .unwrap_or_else(|| "gateway_unhealthy".to_string())
    };

    operational::record_incident(
        app,
        "warn",
        "watchdog",
        "reconcile_requested",
        "Watchdog is reconciling the desired gateway state",
        Some(&reason),
    );
    watchdog::mark_expected_restart(WATCHDOG_EXPECTED_RESTART_WINDOW_MS);
    watchdog::update_status(|status| {
        status.state = "reconciling".to_string();
        status.last_reason = Some(reason.clone());
        status.last_action_at_ms = now;
    });

    let result = match desired.mode.as_str() {
        "local" => {
            gateway::start_gateway_internal(app, desired.model.clone(), "watchdog_start_requested")
                .await
        }
        "proxy" => {
            gateway::start_gateway_with_proxy_internal(
                app,
                desired.proxy_token.clone().unwrap_or_default(),
                desired.proxy_url.clone().unwrap_or_default(),
                desired
                    .model
                    .clone()
                    .unwrap_or_else(|| "openai/gpt-5.1".to_string()),
                desired.image_model.clone(),
                "watchdog_proxy_start_requested",
            )
            .await
        }
        _ => Ok(()),
    };

    match result {
        Ok(()) => {
            operational::record_incident(
                app,
                "info",
                "watchdog",
                "reconcile_succeeded",
                "Watchdog restored the desired gateway state",
                Some(&desired.mode),
            );
            watchdog::update_status(|status| {
                status.state = "monitoring".to_string();
                status.consecutive_failures = 0;
                status.cooldown_until_ms = 0;
                status.expected_restart_until_ms = 0;
                status.last_error = None;
            });
        }
        Err(error) => {
            watchdog::clear_expected_restart();
            let failures = snapshot.consecutive_failures.saturating_add(1);
            let backoff_ms = watchdog_backoff_ms(failures);
            let cooldown_until = now.saturating_add(backoff_ms);
            operational::record_incident(
                app,
                "error",
                "watchdog",
                "reconcile_failed",
                "Watchdog failed to restore the desired gateway state",
                Some(&error),
            );
            watchdog::update_status(|status| {
                status.state = "cooldown".to_string();
                status.consecutive_failures = failures;
                status.cooldown_until_ms = cooldown_until;
                status.last_error = Some(error);
                status.last_action_at_ms = now;
            });
        }
    }

    Ok(())
}

pub fn start_watchdog_loop(app: AppHandle) {
    static STARTED: OnceLock<()> = OnceLock::new();
    if STARTED.set(()).is_err() {
        return;
    }

    let desired = watchdog::current_desired_state(&app);
    watchdog::sync_status_with_desired(&desired);

    tokio::spawn(async move {
        loop {
            if let Err(error) = reconcile_watchdog(&app).await {
                watchdog::update_status(|status| {
                    status.state = "error".to_string();
                    status.last_error = Some(error.clone());
                    status.last_check_at_ms = now_ms_u64();
                });
                operational::record_incident(
                    &app,
                    "error",
                    "watchdog",
                    "loop_failed",
                    "Watchdog reconcile loop failed",
                    Some(&error),
                );
            }
            tokio::time::sleep(Duration::from_millis(WATCHDOG_RECONCILE_INTERVAL_MS)).await;
        }
    });
}

fn gateway_health_error_suggests_control_ui_auth(error: &str) -> bool {
    let lowered = error.to_ascii_lowercase();
    lowered.contains("secure context")
        || lowered.contains("control ui requires")
        || lowered.contains("pairing required")
        || lowered.contains("not-paired")
        || (lowered.contains("origin") && lowered.contains("allow"))
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
        .args([
            "ps",
            "-aq",
            "-f",
            &format!("name={}", LEGACY_OPENCLAW_CONTAINER),
        ])
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

fn normalize_markdown_field_label(raw: &str) -> String {
    let mut value = raw.trim();
    if let Some(inner) = value.strip_prefix("**").and_then(|s| s.strip_suffix("**")) {
        value = inner.trim();
    }
    value.trim_matches('*').trim().to_ascii_lowercase()
}

fn parse_inline_markdown_field_value(line: &str, field: &str) -> Option<String> {
    let stripped = line
        .strip_prefix("- ")
        .or_else(|| line.strip_prefix("* "))
        .or_else(|| line.strip_prefix("+ "))
        .unwrap_or(line)
        .trim();
    if stripped.is_empty() {
        return None;
    }
    if let Some((label, value)) = stripped.split_once(':') {
        if normalize_markdown_field_label(label).eq_ignore_ascii_case(field) {
            let parsed = value.trim();
            if !parsed.is_empty() {
                return Some(parsed.to_string());
            }
        }
    }
    if let Some((label, value)) = stripped.split_once(" - ") {
        if normalize_markdown_field_label(label).eq_ignore_ascii_case(field) {
            let parsed = value.trim();
            if !parsed.is_empty() {
                return Some(parsed.to_string());
            }
        }
    }
    None
}

fn is_identity_field_name(label: &str) -> bool {
    matches!(
        normalize_markdown_field_label(label).as_str(),
        "name" | "creature" | "vibe" | "emoji" | "avatar"
    )
}

fn parse_markdown_bold_field(content: &str, field: &str) -> Option<String> {
    let lines: Vec<&str> = content.lines().collect();
    let target = field.trim().to_ascii_lowercase();

    for (idx, line) in lines.iter().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        if let Some(value) = parse_inline_markdown_field_value(trimmed, &target) {
            return Some(value);
        }

        let heading_label = trimmed.trim_start_matches('#').trim();
        let list_label = trimmed
            .strip_prefix("- ")
            .or_else(|| trimmed.strip_prefix("* "))
            .or_else(|| trimmed.strip_prefix("+ "))
            .unwrap_or(trimmed)
            .trim();
        let heading_matches =
            !heading_label.is_empty() && normalize_markdown_field_label(heading_label) == target;
        let list_matches =
            !list_label.is_empty() && normalize_markdown_field_label(list_label) == target;
        if !heading_matches && !list_matches {
            continue;
        }

        for next in lines.iter().skip(idx + 1) {
            let next_trimmed = next.trim();
            if next_trimmed.is_empty() {
                continue;
            }
            if next_trimmed.starts_with('#') {
                break;
            }
            if let Some((label, _)) = next_trimmed
                .strip_prefix("- ")
                .or_else(|| next_trimmed.strip_prefix("* "))
                .or_else(|| next_trimmed.strip_prefix("+ "))
                .unwrap_or(next_trimmed)
                .split_once(':')
            {
                if is_identity_field_name(label) {
                    break;
                }
            }

            let candidate = next_trimmed
                .strip_prefix("- ")
                .or_else(|| next_trimmed.strip_prefix("* "))
                .or_else(|| next_trimmed.strip_prefix("+ "))
                .unwrap_or(next_trimmed)
                .trim();
            if !candidate.is_empty() {
                return Some(candidate.to_string());
            }
        }
    }

    None
}

fn sanitize_identity_name(raw: &str) -> Option<String> {
    let mut value = raw.trim().to_string();
    if value.is_empty() {
        return None;
    }

    // Peel common markdown wrappers repeatedly (e.g. "**Nova**", "`Nova`").
    for _ in 0..4 {
        let trimmed = value.trim();
        let unwrapped = trimmed
            .strip_prefix("**")
            .and_then(|s| s.strip_suffix("**"))
            .or_else(|| {
                trimmed
                    .strip_prefix("__")
                    .and_then(|s| s.strip_suffix("__"))
            })
            .or_else(|| trimmed.strip_prefix('*').and_then(|s| s.strip_suffix('*')))
            .or_else(|| trimmed.strip_prefix('_').and_then(|s| s.strip_suffix('_')))
            .or_else(|| trimmed.strip_prefix('`').and_then(|s| s.strip_suffix('`')));
        if let Some(inner) = unwrapped {
            value = inner.trim().to_string();
        } else {
            break;
        }
    }

    let trimmed = value
        .trim()
        .trim_start_matches(|c: char| {
            c.is_whitespace()
                || c == '-'
                || c == '+'
                || c == ':'
                || c == '*'
                || c == '_'
                || c == '`'
                || c == '~'
        })
        .trim_end_matches(|c: char| {
            c.is_whitespace()
                || c == '-'
                || c == '+'
                || c == ':'
                || c == '*'
                || c == '_'
                || c == '`'
                || c == '~'
        });

    if trimmed.is_empty() {
        return None;
    }

    let collapsed = trimmed
        .split_whitespace()
        .filter(|token| {
            !token
                .chars()
                .all(|ch| ch == '*' || ch == '_' || ch == '`' || ch == '~')
        })
        .collect::<Vec<_>>()
        .join(" ");
    if collapsed.is_empty() {
        None
    } else {
        Some(collapsed)
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

fn scanner_container_image() -> Option<String> {
    let output = docker_command()
        .args([
            "container",
            "inspect",
            SCANNER_CONTAINER,
            "--format",
            "{{.Config.Image}}",
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let image = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if image.is_empty() {
        None
    } else {
        Some(image)
    }
}

fn start_scanner_sidecar() {
    let expected_image = scanner_image_name();

    // Check if scanner container is already running
    let check = docker_command()
        .args(["ps", "-q", "-f", &format!("name={}", SCANNER_CONTAINER)])
        .output();
    if let Ok(out) = &check {
        if !out.stdout.is_empty() {
            if scanner_container_image().as_deref() == Some(expected_image.as_str()) {
                return; // Already running with the expected pinned image.
            }
            // Running container uses a stale scanner image pin; recreate it.
            let _ = docker_command()
                .args(["rm", "-f", SCANNER_CONTAINER])
                .output();
        }
    }

    // Check if container exists but stopped
    let check_all = docker_command()
        .args(["ps", "-aq", "-f", &format!("name={}", SCANNER_CONTAINER)])
        .output();
    if let Ok(out) = &check_all {
        if !out.stdout.is_empty() {
            if scanner_container_image().as_deref() == Some(expected_image.as_str()) {
                let start = docker_command().args(["start", SCANNER_CONTAINER]).output();
                if let Ok(s) = &start {
                    if s.status.success() {
                        return;
                    }
                }
            }
            // Start failed, remove and recreate
            let _ = docker_command()
                .args(["rm", "-f", SCANNER_CONTAINER])
                .output();
        }
    }

    // Ensure scanner image is available (local cache, bundled tar fallback, or registry pull).
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
            "--pids-limit",
            "128",
            "--memory",
            "512m",
            "--cpus",
            "1.0",
            "--tmpfs",
            "/tmp:rw,noexec,nosuid,nodev,size=200m",
            "-p",
            &format!("127.0.0.1:{}:8000", SCANNER_HOST_PORT),
            expected_image.as_str(),
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

struct DockerWorkspaceRunner;

impl WorkspaceRunner for DockerWorkspaceRunner {
    fn exec_output(&self, args: &[&str]) -> Result<String, String> {
        docker_exec_output(args)
    }

    fn write_file(&self, path: &str, bytes: &[u8]) -> Result<(), String> {
        let mut child = docker_command()
            .args(["exec", "-i", OPENCLAW_CONTAINER, "tee", "--", path])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .map_err(|e| format!("Failed to write file: {}", e))?;
        if let Some(stdin) = child.stdin.as_mut() {
            use std::io::Write;
            stdin
                .write_all(bytes)
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
}

fn workspace_service() -> WorkspaceService<DockerWorkspaceRunner> {
    WorkspaceService::new(DockerWorkspaceRunner, OPENCLAW_CONTAINER, WORKSPACE_ROOT)
}

fn ensure_qmd_runtime_dependencies() -> Result<(), String> {
    if !named_gateway_container_exists(OPENCLAW_CONTAINER, true) {
        return Err(
            "Gateway container is not running. Start gateway first, then enable QMD.".to_string(),
        );
    }

    // Install QMD + tsx into persistent /data/.bun when missing.
    let install_script = r#"
set -e
export HOME=/data
export BUN_INSTALL=/data/.bun
export PATH="/data/.bun/bin:$PATH"
mkdir -p /data/.bun /data/workspace/node_modules

if [ -x /data/.bun/bin/qmd ] || command -v qmd >/dev/null 2>&1; then
  if [ -d /data/.bun/install/global/node_modules/tsx ]; then
    ln -sfn /data/.bun/install/global/node_modules/tsx /data/workspace/node_modules/tsx
  fi
  exit 0
fi

if ! command -v bun >/dev/null 2>&1; then
  curl -fsSL https://bun.sh/install | bash
fi

bun install -g https://github.com/tobi/qmd tsx
ln -sfn /data/.bun/install/global/node_modules/tsx /data/workspace/node_modules/tsx

if [ ! -x /data/.bun/bin/qmd ]; then
  echo "qmd binary not found after install" >&2
  exit 1
fi
"#;

    let output = docker_command()
        .args(["exec", OPENCLAW_CONTAINER, "sh", "-lc", install_script])
        .output()
        .map_err(|e| format!("Failed to run QMD bootstrap in gateway container: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(format!(
            "Failed to install/prepare QMD runtime dependencies: {}{}{}",
            stderr.trim(),
            if stderr.trim().is_empty() || stdout.trim().is_empty() {
                ""
            } else {
                " | "
            },
            stdout.trim()
        ));
    }

    Ok(())
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
    // Build a shell command that ensures clawhub is installed globally in
    // the persistent /data/.local prefix (already in PATH) before running it.
    // This avoids the fragile `npx -y` approach which re-downloads every time
    // and is prone to npm cache corruption (ENOTEMPTY errors).
    let mut shell_cmd = String::from(
        "command -v clawhub >/dev/null 2>&1 || npm install -g --prefix /data/.local clawhub@0.7.0 >/dev/null 2>&1; exec clawhub",
    );
    for arg in args {
        shell_cmd.push(' ');
        shell_cmd.push('\'');
        shell_cmd.push_str(&arg.replace('\'', "'\\''"));
        shell_cmd.push('\'');
    }

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
        "sh",
        "-c",
        &shell_cmd,
    ]);
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

    // Retry with backoff when the scanner container is still starting up.
    let mut last_err = String::new();
    let mut res_ok = None;
    for attempt in 0u32..6 {
        if attempt > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(500 * u64::from(attempt))).await;
        }
        match client.post(&scan_url).json(&body).send().await {
            Ok(r) => {
                res_ok = Some(r);
                break;
            }
            Err(e) => {
                last_err = format!("{}", e);
                let is_connect = e.is_connect()
                    || e.is_request()
                    || last_err.contains("connection closed")
                    || last_err.contains("Connection refused");
                if !is_connect {
                    return Err(format!("Scan request failed: {}", e));
                }
            }
        }
    }
    let res = res_ok.ok_or_else(|| {
        format!(
            "Scan request failed after retries (scanner may not be ready): {}",
            last_err
        )
    })?;

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
    let config_path = state_file("openclaw.json");
    // Only write if the content actually changed to avoid triggering the
    // gateway's config file watcher and causing unnecessary SIGUSR1 restarts.
    if let Some(existing) = read_container_file(&config_path) {
        if existing.trim() == payload.trim() {
            return Ok(());
        }
    }
    write_container_file(&config_path, &payload)
}

/// Send SIGUSR1 to the gateway process to force a config reload.
/// The gateway watches openclaw.json for changes but may miss writes that
/// happen before the file watcher is initialised (e.g. during startup).
/// This is a no-op if the container isn't running.
fn signal_gateway_config_reload() {
    let _ = docker_command()
        .args(["exec", OPENCLAW_CONTAINER, "kill", "-USR1", "1"])
        .output();
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
    qmd_enabled: bool,
) {
    if !cfg.is_object() {
        *cfg = serde_json::json!({});
    }
    let cfg_obj = cfg.as_object_mut().expect("config root must be an object");
    let memory_enabled = slot != "none";
    let using_qmd = memory_enabled && qmd_enabled;

    if using_qmd {
        let memory = ensure_object_entry(cfg_obj, "memory");
        memory.insert("backend".to_string(), serde_json::json!("qmd"));

        if !memory.contains_key("citations") {
            memory.insert("citations".to_string(), serde_json::json!("auto"));
        }

        let qmd = ensure_object_entry(memory, "qmd");
        let command_missing = qmd
            .get("command")
            .and_then(|v| v.as_str())
            .map(|s| s.trim().is_empty())
            .unwrap_or(true);
        if command_missing {
            qmd.insert("command".to_string(), serde_json::json!(QMD_COMMAND_PATH));
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
    } else {
        cfg_obj.remove("memory");
    }

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

    // Keep memory search sources aligned with session-memory setting.
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

fn generate_attachment_id() -> String {
    let mut bytes = [0u8; ATTACHMENT_ID_RANDOM_BYTES];
    rand::thread_rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn normalize_attachment_id(raw: &str) -> Result<String, String> {
    let id = raw.trim();
    if id.is_empty() {
        return Err("Attachment id required".to_string());
    }
    if id.len() > 128 || id.len() < 8 {
        return Err("Invalid attachment id".to_string());
    }
    if !id
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
    {
        return Err("Invalid attachment id".to_string());
    }
    Ok(id.to_string())
}

fn validate_attachment_temp_path(attachment_id: &str, temp_path: &str) -> Result<(), String> {
    let trimmed = temp_path.trim();
    if trimmed.is_empty() {
        return Err("Attachment path is empty".to_string());
    }
    let allowed_prefix = format!("{}/", ATTACHMENT_TMP_ROOT);
    if !trimmed.starts_with(&allowed_prefix) {
        return Err("Attachment path is outside allowed temp directory".to_string());
    }
    let file_name = Path::new(trimmed)
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Attachment path is invalid".to_string())?;
    if file_name.contains('/') || file_name.contains('\\') || file_name.contains("..") {
        return Err("Attachment path is invalid".to_string());
    }
    let expected_prefix = format!("{}_", attachment_id);
    if !file_name.starts_with(&expected_prefix) {
        return Err("Attachment path does not match attachment id".to_string());
    }
    Ok(())
}

fn prune_pending_attachments(pending: &mut HashMap<String, PendingAttachmentRecord>) {
    let now = now_ms_u64();
    pending
        .retain(|_, record| now.saturating_sub(record.created_at_ms) <= ATTACHMENT_PENDING_TTL_MS);
    if pending.len() <= ATTACHMENT_MAX_PENDING {
        return;
    }
    let mut oldest: Vec<(String, u64)> = pending
        .iter()
        .map(|(id, record)| (id.clone(), record.created_at_ms))
        .collect();
    oldest.sort_by_key(|(_, created_at_ms)| *created_at_ms);
    let remove_count = pending.len().saturating_sub(ATTACHMENT_MAX_PENDING);
    for (id, _) in oldest.into_iter().take(remove_count) {
        pending.remove(&id);
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
            only_if_missing: true,
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
                models.push(serde_json::json!({
                    "id": model_id,
                    "name": model_id,
                    "input": ["text", "image"],
                    "reasoning": false,
                    "contextWindow": 200000,
                    "maxTokens": 8192,
                    "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
                }));
            }
            if !image_model_id.is_empty() && image_model_id != model_id {
                models.push(serde_json::json!({
                    "id": image_model_id,
                    "name": image_model_id,
                    "input": ["text", "image"],
                    "reasoning": false,
                    "contextWindow": 200000,
                    "maxTokens": 8192,
                    "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
                }));
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
    apply_default_qmd_memory_config(
        &mut cfg,
        memory_slot,
        memory_sessions_enabled,
        settings.memory_qmd_enabled,
    );
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
    apply_default_qmd_memory_config(
        &mut cfg,
        &effective_slot,
        memory_sessions_enabled,
        settings.memory_qmd_enabled,
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
    // Add Telegram plugin path to plugins.load.paths so the gateway can find it.
    // This mirrors the X plugin block above.
    if settings.telegram_enabled {
        let telegram_plugin_id = "telegram";
        let mut telegram_plugin_path: Option<String> = None;
        if let Some(skills_root) = read_container_env("ENTROPIC_SKILLS_PATH") {
            let base = format!(
                "{}/{}",
                skills_root.trim_end_matches('/'),
                telegram_plugin_id
            );
            let current = format!("{}/current", base);
            let candidate = if container_path_exists(&current) {
                current
            } else {
                base
            };
            if container_path_exists(&candidate) {
                telegram_plugin_path = Some(candidate);
            }
        }
        if let Some(path) = telegram_plugin_path {
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

    // Only suppress Telegram once bridge has at least one paired device.
    // A stale bridge_enabled flag alone should not disable Telegram on gateway restarts.
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
        println!(
            "[Entropic] apply_agent_settings: ENTROPIC_THINKING_LEVEL not set in container env"
        );
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
                let payload =
                    serde_json::to_string_pretty(&auth_profiles).map_err(|e| e.to_string())?;
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
            let payload =
                serde_json::to_string_pretty(&auth_profiles).map_err(|e| e.to_string())?;
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

    if current
        .active_provider
        .as_deref()
        .unwrap_or("")
        .trim()
        .is_empty()
    {
        current.active_provider = legacy.active_provider;
    }
    if current
        .gateway_token
        .as_deref()
        .unwrap_or("")
        .trim()
        .is_empty()
    {
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
    fs::create_dir_all(&current_dir).map_err(|e| {
        format!(
            "Failed to create app data dir {}: {}",
            current_dir.display(),
            e
        )
    })?;

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
        &["gateway", "controlUi"],
        &["plugins", "slots"],
        &["plugins", "load", "paths"],
        &["plugins", "entries", "memory-lancedb"],
        &["plugins", "entries", "telegram"],
        &["channels", "telegram", "groups", "*"],
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

    // Docker bridge requests can present a non-loopback source IP.
    // Allow token-authenticated Control UI access in local desktop mode.
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
    // In the local Docker desktop setup, connections arrive from the Docker bridge
    // IP (172.17.x.x), not loopback, so isLocalClient is always false even though
    // allowInsecureAuth is true. dangerouslyDisableDeviceAuth bypasses the
    // device-identity requirement for Control UI, which is safe here because
    // the gateway is only reachable via 127.0.0.1:19789 on the host machine
    // and is protected by the gateway token.
    set_openclaw_config_value(
        cfg,
        &["gateway", "controlUi", "dangerouslyDisableDeviceAuth"],
        serde_json::json!(true),
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
}

fn clear_legacy_messaging_settings(settings: &mut StoredAgentSettings) {
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
                                normalize_openclaw_config(&mut cfg);
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
    let ws_url = gateway::gateway_ws_url();
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
    let mut message = format!(
        "Gateway failed strict health check at {}: {}",
        ws_url, last_error
    );
    if let Some(conflict_hint) = gateway_port_conflict_hint(&last_error) {
        message = format!("{}\n\n{}", message, conflict_hint);
    }
    Err(message)
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

fn listener_pids_for_port(port: u16) -> Vec<u32> {
    let port_selector = format!("-tiTCP:{}", port);
    let output = match Command::new("lsof")
        .args(["-nP", port_selector.as_str(), "-sTCP:LISTEN"])
        .output()
    {
        Ok(output) if output.status.success() => output,
        _ => return Vec::new(),
    };

    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .filter_map(|line| {
            if line.chars().all(|c| c.is_ascii_digit()) {
                line.parse::<u32>().ok()
            } else {
                None
            }
        })
        .collect()
}

fn process_command_line(pid: u32) -> Option<String> {
    let pid_text = pid.to_string();
    let output = Command::new("ps")
        .args(["-p", pid_text.as_str(), "-o", "command="])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let command = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if command.is_empty() {
        None
    } else {
        Some(command)
    }
}

fn process_display_name(command: &str) -> String {
    let first = command.split_whitespace().next().unwrap_or(command);
    let base = Path::new(first)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(first);
    if base.is_empty() {
        "unknown".to_string()
    } else {
        base.to_string()
    }
}

fn collect_legacy_nova_runtime_pids() -> Vec<u32> {
    if !matches!(Platform::detect(), Platform::MacOS) {
        return Vec::new();
    }
    let output = match Command::new("ps").args(["-axo", "pid=,command="]).output() {
        Ok(output) if output.status.success() => output,
        _ => return Vec::new(),
    };

    let mut pids = Vec::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let mut parts = trimmed.splitn(2, char::is_whitespace);
        let Some(pid_text) = parts.next() else {
            continue;
        };
        let Some(command) = parts.next() else {
            continue;
        };
        let Ok(pid) = pid_text.parse::<u32>() else {
            continue;
        };
        let command = command.trim();
        if command.is_empty() {
            continue;
        }
        if command.contains("/.nova/colima/")
            || command.contains("/.nova/colima-dev/")
            || command.contains("colima-nova-vz")
            || command.contains("colima-nova-qemu")
            || command.contains("colima daemon start nova-vz")
            || command.contains("colima daemon start nova-qemu")
        {
            pids.push(pid);
        }
    }

    pids.sort_unstable();
    pids.dedup();
    pids
}

fn send_kill_signal(pids: &[u32], signal: &str) -> Result<(), String> {
    if pids.is_empty() {
        return Ok(());
    }
    let mut cmd = Command::new("kill");
    cmd.arg(signal);
    for pid in pids {
        cmd.arg(pid.to_string());
    }
    let output = cmd
        .output()
        .map_err(|e| format!("failed to run kill {}: {}", signal, e))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    if stderr.to_lowercase().contains("no such process") {
        return Ok(());
    }
    Err(format!("kill {} failed: {}", signal, stderr.trim()))
}

fn stop_legacy_nova_runtime_processes(cleanup_log: &mut Vec<String>) {
    let pids = collect_legacy_nova_runtime_pids();
    if pids.is_empty() {
        cleanup_log.push("No legacy Nova runtime processes detected.".to_string());
        return;
    }

    cleanup_log.push(format!(
        "Stopping legacy Nova runtime processes (PIDs: {})...",
        pids.iter()
            .map(|p| p.to_string())
            .collect::<Vec<_>>()
            .join(", ")
    ));
    if let Err(err) = send_kill_signal(&pids, "-TERM") {
        cleanup_log.push(format!("Warning: {}", err));
    }
    std::thread::sleep(Duration::from_millis(400));

    let still_running: Vec<u32> = pids
        .iter()
        .copied()
        .filter(|pid| process_command_line(*pid).is_some())
        .collect();
    if still_running.is_empty() {
        cleanup_log.push("Legacy Nova runtime processes stopped.".to_string());
        return;
    }

    cleanup_log.push(format!(
        "Force-stopping remaining legacy Nova processes (PIDs: {})...",
        still_running
            .iter()
            .map(|p| p.to_string())
            .collect::<Vec<_>>()
            .join(", ")
    ));
    if let Err(err) = send_kill_signal(&still_running, "-KILL") {
        cleanup_log.push(format!("Warning: {}", err));
    }
    std::thread::sleep(Duration::from_millis(250));

    let stubborn: Vec<u32> = still_running
        .iter()
        .copied()
        .filter(|pid| process_command_line(*pid).is_some())
        .collect();
    if stubborn.is_empty() {
        cleanup_log.push("Legacy Nova runtime processes force-stopped.".to_string());
    } else {
        cleanup_log.push(format!(
            "Warning: Some legacy Nova runtime processes are still running (PIDs: {}).",
            stubborn
                .iter()
                .map(|p| p.to_string())
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
}

fn gateway_port_conflict_hint(last_error: &str) -> Option<String> {
    if !matches!(Platform::detect(), Platform::MacOS) {
        return None;
    }

    let text = last_error.to_lowercase();
    let looks_auth_conflict = text.contains("unauthorized")
        || text.contains("token mismatch")
        || text.contains("invalid gateway token")
        || text.contains("gateway token");
    if !looks_auth_conflict {
        return None;
    }

    for pid in listener_pids_for_port(19789) {
        let command = match process_command_line(pid) {
            Some(cmd) => cmd,
            None => continue,
        };
        if command.contains("/.entropic/colima/") || command.contains("/.entropic/colima-dev/") {
            continue;
        }
        if command.contains("/.nova/colima/")
            || command.contains("/.nova/colima-dev/")
            || command.contains("colima-nova-vz")
            || command.contains("colima-nova-qemu")
        {
            return Some(format!(
                "Detected legacy Nova runtime process (PID {}) owning localhost:19789. \
Entropic is connecting to the wrong gateway instance, which causes gateway token mismatch. \
Use Entropic Settings > Reset Application to clean up legacy runtime state, then retry Gateway start. \
If needed, quit Nova.app (or run `kill {}`).",
                pid, pid
            ));
        }
        let display = process_display_name(&command);
        return Some(format!(
            "Port conflict detected: localhost:19789 is owned by PID {} ({}), not Entropic runtime. \
Open Entropic Settings > Reset Application (or stop the conflicting process) and retry Gateway start.",
            pid, display
        ));
    }

    None
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
        pending_attachments: Mutex::new(HashMap::new()),
    }
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

/// Parse a "code#state" string (or a full callback URL) into (code, state).
fn parse_anthropic_code_state(input: &str) -> Result<(String, String), String> {
    let text = input.trim().trim_matches('`');

    // Try as URL first (user may paste the full callback URL)
    if let Ok(url) = Url::parse(text) {
        let code = url
            .query_pairs()
            .find(|(k, _)| k == "code")
            .map(|(_, v)| v.to_string());
        let state = url
            .query_pairs()
            .find(|(k, _)| k == "state")
            .map(|(_, v)| v.to_string());
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

// =============================================================================
// OpenAI OAuth — localhost callback flow (matches Codex CLI)
// =============================================================================

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

    let code = match url
        .query_pairs()
        .find(|(k, _)| k == "code")
        .map(|(_, v)| v.to_string())
    {
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
