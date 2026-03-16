use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::PathBuf;
use std::process::Command;
use thiserror::Error;

/// Global debug logger for runtime diagnostics
fn debug_log(msg: &str) {
    use std::io::Write;
    let log_path = dirs::home_dir()
        .map(|h| h.join("entropic-runtime.log"))
        .unwrap_or_else(|| std::path::PathBuf::from("/tmp/entropic-runtime.log"));

    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
    {
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let _ = writeln!(f, "[{}] {}", timestamp, msg);
    }
}

fn apply_windows_no_window(cmd: &mut Command) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
}

#[cfg(target_os = "windows")]
#[link(name = "kernel32")]
extern "system" {
    fn GetACP() -> u32;
    fn GetOEMCP() -> u32;
    fn MultiByteToWideChar(
        code_page: u32,
        flags: u32,
        multi_byte_str: *const u8,
        multi_byte_len: i32,
        wide_char_str: *mut u16,
        wide_char_len: i32,
    ) -> i32;
}

#[cfg(target_os = "windows")]
fn decode_multibyte_with_code_page(bytes: &[u8], code_page: u32) -> Option<String> {
    if bytes.is_empty() {
        return Some(String::new());
    }

    let input_len = i32::try_from(bytes.len()).ok()?;
    let wide_len = unsafe {
        MultiByteToWideChar(
            code_page,
            0,
            bytes.as_ptr(),
            input_len,
            std::ptr::null_mut(),
            0,
        )
    };
    if wide_len <= 0 {
        return None;
    }

    let mut wide = vec![0u16; wide_len as usize];
    let written = unsafe {
        MultiByteToWideChar(
            code_page,
            0,
            bytes.as_ptr(),
            input_len,
            wide.as_mut_ptr(),
            wide_len,
        )
    };
    if written <= 0 {
        return None;
    }

    Some(String::from_utf16_lossy(&wide[..written as usize]))
}

fn decode_command_output(bytes: &[u8]) -> String {
    #[cfg(target_os = "windows")]
    {
        if let Ok(text) = std::str::from_utf8(bytes) {
            return text.to_string();
        }

        let oem = unsafe { GetOEMCP() };
        if let Some(text) = decode_multibyte_with_code_page(bytes, oem) {
            return text;
        }

        let acp = unsafe { GetACP() };
        if acp != oem {
            if let Some(text) = decode_multibyte_with_code_page(bytes, acp) {
                return text;
            }
        }
    }

    String::from_utf8_lossy(bytes).to_string()
}

#[derive(Error, Debug)]
pub enum RuntimeError {
    #[error("Colima not found in resources")]
    ColimaNotFound,
    #[error("Docker CLI not found")]
    DockerNotFound,
    #[error("Failed to start Colima: {0}")]
    ColimaStartFailed(String),
    #[error("Failed to stop Colima: {0}")]
    ColimaStopFailed(String),
    #[error("VM not running")]
    VmNotRunning,
    #[error("Docker not installed on system")]
    DockerNotInstalled,
    #[error("Docker daemon not running")]
    DockerNotRunning,
    #[error("Command failed: {0}")]
    CommandFailed(String),
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct RuntimeStatus {
    pub colima_installed: bool,
    pub docker_installed: bool,
    pub vm_running: bool,
    pub docker_ready: bool,
}

#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize)]
pub struct RuntimeVmConfig {
    pub cpu: u8,
    pub memory_gb: u16,
    pub disk_gb: u16,
}

pub const DEFAULT_RUNTIME_VM_CPU: u8 = 2;
pub const DEFAULT_RUNTIME_VM_MEMORY_GB: u16 = 4;
pub const DEFAULT_RUNTIME_VM_DISK_GB: u16 = 20;

impl Default for RuntimeVmConfig {
    fn default() -> Self {
        Self {
            cpu: DEFAULT_RUNTIME_VM_CPU,
            memory_gb: DEFAULT_RUNTIME_VM_MEMORY_GB,
            disk_gb: DEFAULT_RUNTIME_VM_DISK_GB,
        }
    }
}

pub struct Runtime {
    resources_dir: PathBuf,
    #[allow(dead_code)]
    platform: Platform,
    vm_config: RuntimeVmConfig,
}

/// Isolated Colima home directory used by Entropic to avoid conflicts with
/// any user-managed global Colima configuration under `~/.colima`.
#[cfg(debug_assertions)]
pub(crate) const ENTROPIC_COLIMA_HOME_DIR: &str = ".entropic/colima-dev";
#[cfg(not(debug_assertions))]
pub(crate) const ENTROPIC_COLIMA_HOME_DIR: &str = ".entropic/colima";
#[cfg(debug_assertions)]
pub(crate) const LEGACY_NOVA_COLIMA_HOME_DIR: &str = ".nova/colima-dev";
#[cfg(not(debug_assertions))]
pub(crate) const LEGACY_NOVA_COLIMA_HOME_DIR: &str = ".nova/colima";
/// Colima profile name used for Apple Virtualization.framework (`vz`) backend.
pub(crate) const ENTROPIC_VZ_PROFILE: &str = "entropic-vz";
/// Colima profile name used for QEMU backend fallback.
pub(crate) const ENTROPIC_QEMU_PROFILE: &str = "entropic-qemu";
pub(crate) const LEGACY_NOVA_VZ_PROFILE: &str = "nova-vz";
pub(crate) const LEGACY_NOVA_QEMU_PROFILE: &str = "nova-qemu";
pub(crate) const ENTROPIC_WSL_DEV_DISTRO: &str = "entropic-dev";
pub(crate) const ENTROPIC_WSL_PROD_DISTRO: &str = "entropic-prod";
const COLIMA_RETRY_DELAY_SECS: u64 = 2;
const WINDOWS_BOOTSTRAP_STATE_FILE: &str = "bootstrap-state.json";
const WINDOWS_RUNTIME_RELEASE_REPO: &str = "dominant-strategies/entropic-releases";
const WINDOWS_RUNTIME_RELEASE_TAG: &str = "runtime-latest";
const WINDOWS_RUNTIME_MANIFEST_NAME: &str = "runtime-manifest.json";
const WINDOWS_RUNTIME_ROOTFS_ASSET_NAME: &str = "entropic-runtime-windows-x86_64.tar";
const WINDOWS_BOOTSTRAP_STAGE_PREFLIGHT: &str = "preflight";
const WINDOWS_BOOTSTRAP_STAGE_WSL_INSTALL: &str = "wsl-install";
const WINDOWS_BOOTSTRAP_STAGE_WSL_DEFAULT_VERSION: &str = "wsl-default-version";
const WINDOWS_BOOTSTRAP_STAGE_IMPORT_DEV: &str = "import-dev";
const WINDOWS_BOOTSTRAP_STAGE_IMPORT_PROD: &str = "import-prod";
const WINDOWS_BOOTSTRAP_STAGE_DOCKER_DEV: &str = "docker-dev";
const WINDOWS_BOOTSTRAP_STAGE_DOCKER_PROD: &str = "docker-prod";
const WINDOWS_BOOTSTRAP_STAGE_READY: &str = "ready";
const WINDOWS_WSL_AVAILABILITY_POLL_ATTEMPTS: usize = 20;
const WINDOWS_WSL_AVAILABILITY_POLL_MILLIS: u64 = 500;
const WINDOWS_WSL_FEATURE_NAME: &str = "Microsoft-Windows-Subsystem-Linux";
const WINDOWS_VM_PLATFORM_FEATURE_NAME: &str = "VirtualMachinePlatform";

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct WindowsBootstrapState {
    stage: String,
    pending_reboot: bool,
    #[serde(default)]
    error: Option<String>,
    updated_at_unix: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum WindowsOptionalFeatureState {
    Enabled,
    Disabled,
    EnablePending,
    DisablePending,
    DisabledWithPayloadRemoved,
    Unknown(String),
}

impl WindowsOptionalFeatureState {
    fn parse(value: &str) -> Self {
        match value.trim().to_ascii_lowercase().as_str() {
            "enabled" => Self::Enabled,
            "disabled" => Self::Disabled,
            "enablepending" => Self::EnablePending,
            "disablepending" => Self::DisablePending,
            "disabledwithpayloadremoved" => Self::DisabledWithPayloadRemoved,
            other => Self::Unknown(other.to_string()),
        }
    }

    fn is_disabled(&self) -> bool {
        matches!(self, Self::Disabled | Self::DisabledWithPayloadRemoved)
    }

    fn pending_reboot(&self) -> bool {
        matches!(self, Self::EnablePending | Self::DisablePending)
    }
}

#[derive(Debug, Clone, Default)]
struct WindowsWslFeatureStates {
    wsl: Option<WindowsOptionalFeatureState>,
    virtual_machine_platform: Option<WindowsOptionalFeatureState>,
}

impl WindowsWslFeatureStates {
    fn set(&mut self, feature_name: &str, state: WindowsOptionalFeatureState) {
        match feature_name {
            WINDOWS_WSL_FEATURE_NAME => self.wsl = Some(state),
            WINDOWS_VM_PLATFORM_FEATURE_NAME => self.virtual_machine_platform = Some(state),
            _ => {}
        }
    }

    fn any_known(&self) -> bool {
        self.wsl.is_some() || self.virtual_machine_platform.is_some()
    }

    fn any_required_disabled(&self) -> bool {
        self.wsl
            .as_ref()
            .map(WindowsOptionalFeatureState::is_disabled)
            .unwrap_or(false)
            || self
                .virtual_machine_platform
                .as_ref()
                .map(WindowsOptionalFeatureState::is_disabled)
                .unwrap_or(false)
    }

    fn pending_reboot(&self) -> bool {
        self.wsl
            .as_ref()
            .map(WindowsOptionalFeatureState::pending_reboot)
            .unwrap_or(false)
            || self
                .virtual_machine_platform
                .as_ref()
                .map(WindowsOptionalFeatureState::pending_reboot)
                .unwrap_or(false)
    }
}

#[derive(Debug, Clone, serde::Deserialize)]
struct WindowsOptionalFeatureRecord {
    #[serde(rename = "FeatureName")]
    feature_name: String,
    #[serde(rename = "State")]
    state: String,
}

#[derive(Debug, Clone, serde::Deserialize)]
struct WindowsRuntimeReleaseManifest {
    #[allow(dead_code)]
    version: String,
    #[serde(default)]
    windows_wsl_rootfs_url: Option<String>,
    #[serde(default)]
    windows_wsl_rootfs_sha256: Option<String>,
}

fn fallback_colima_home_path() -> PathBuf {
    let shared_base = PathBuf::from("/Users/Shared/entropic");
    if std::fs::create_dir_all(&shared_base).is_ok() {
        #[cfg(unix)]
        {
            // SAFETY: geteuid has no preconditions and does not dereference pointers.
            let uid = unsafe { libc::geteuid() };
            return shared_base.join(format!("entropic-colima-{}", uid));
        }

        #[cfg(not(unix))]
        {
            return shared_base.join("colima");
        }
    }

    // Last-resort fallback if /Users/Shared is unavailable.
    let base = std::env::temp_dir();

    #[cfg(unix)]
    {
        // SAFETY: geteuid has no preconditions and does not dereference pointers.
        let uid = unsafe { libc::geteuid() };
        return base.join(format!("entropic-colima-{}", uid));
    }

    #[cfg(not(unix))]
    {
        base.join("entropic-colima")
    }
}

fn fallback_runtime_home_path() -> PathBuf {
    let shared_base = PathBuf::from("/Users/Shared/entropic");
    if std::fs::create_dir_all(&shared_base).is_ok() {
        #[cfg(unix)]
        {
            // SAFETY: geteuid has no preconditions and does not dereference pointers.
            let uid = unsafe { libc::geteuid() };
            return shared_base.join(format!("entropic-home-{}", uid));
        }

        #[cfg(not(unix))]
        {
            return shared_base.join("home");
        }
    }

    let base = std::env::temp_dir();

    #[cfg(unix)]
    {
        // SAFETY: geteuid has no preconditions and does not dereference pointers.
        let uid = unsafe { libc::geteuid() };
        return base.join(format!("entropic-home-{}", uid));
    }

    #[cfg(not(unix))]
    {
        base.join("entropic-home")
    }
}

fn path_contains_whitespace(path: &std::path::Path) -> bool {
    path.to_string_lossy().chars().any(char::is_whitespace)
}

fn entropic_runtime_home_path() -> PathBuf {
    if let Ok(home) = std::env::var("ENTROPIC_RUNTIME_HOME") {
        if !home.trim().is_empty() {
            return PathBuf::from(home);
        }
    }

    if let Some(home) = dirs::home_dir() {
        if path_contains_whitespace(&home) {
            let fallback = fallback_runtime_home_path();
            debug_log(&format!(
                "HOME contains whitespace ({}); using runtime HOME {}",
                home.display(),
                fallback.display()
            ));
            return fallback;
        }
        return home;
    }

    fallback_runtime_home_path()
}

pub(crate) fn entropic_colima_home_path() -> PathBuf {
    if let Ok(home) = std::env::var("ENTROPIC_COLIMA_HOME") {
        if !home.trim().is_empty() {
            return PathBuf::from(home);
        }
    }

    if let Some(home) = dirs::home_dir() {
        let candidate = home.join(ENTROPIC_COLIMA_HOME_DIR);
        if path_contains_whitespace(&candidate) {
            let fallback = fallback_colima_home_path();
            debug_log(&format!(
                "ENTROPIC_COLIMA_HOME contains whitespace ({}); using fallback {}",
                candidate.display(),
                fallback.display()
            ));
            return fallback;
        }
        if candidate.exists() {
            return candidate;
        }
        let legacy = home.join(LEGACY_NOVA_COLIMA_HOME_DIR);
        if legacy.exists() {
            debug_log(&format!(
                "Using legacy Colima home for compatibility: {}",
                legacy.display()
            ));
            return legacy;
        }
        return candidate;
    }

    fallback_colima_home_path()
}

pub(crate) fn entropic_colima_socket_candidates() -> Vec<PathBuf> {
    let mut homes = vec![entropic_colima_home_path()];
    if let Some(home) = dirs::home_dir() {
        let entropic = home.join(ENTROPIC_COLIMA_HOME_DIR);
        if !homes.contains(&entropic) {
            homes.push(entropic);
        }
        // Always check both dev and production colima homes so the dev app
        // can discover a VM started by the build script (production profile)
        // and vice-versa.
        for dir in [".entropic/colima", ".entropic/colima-dev"] {
            let candidate = home.join(dir);
            if !homes.contains(&candidate) {
                homes.push(candidate);
            }
        }
        let legacy = home.join(LEGACY_NOVA_COLIMA_HOME_DIR);
        if !homes.contains(&legacy) {
            homes.push(legacy);
        }
    }

    let mut sockets = Vec::new();
    for home in homes {
        for profile in [
            ENTROPIC_VZ_PROFILE,
            ENTROPIC_QEMU_PROFILE,
            LEGACY_NOVA_VZ_PROFILE,
            LEGACY_NOVA_QEMU_PROFILE,
        ] {
            sockets.push(home.join(profile).join("docker.sock"));
        }
    }
    sockets
}

fn env_var_truthy(name: &str) -> bool {
    std::env::var(name)
        .ok()
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

fn env_var_bool(name: &str) -> Option<bool> {
    std::env::var(name).ok().and_then(|value| {
        match value.trim().to_ascii_lowercase().as_str() {
            "1" | "true" | "yes" | "on" => Some(true),
            "0" | "false" | "no" | "off" => Some(false),
            _ => None,
        }
    })
}

fn windows_managed_wsl_runtime_enabled() -> bool {
    matches!(Platform::detect(), Platform::Windows)
        && env_var_bool("ENTROPIC_WINDOWS_MANAGED_WSL").unwrap_or(true)
}

fn windows_shared_docker_fallback_allowed() -> bool {
    env_var_truthy("ENTROPIC_RUNTIME_ALLOW_SHARED_DOCKER")
}

fn windows_runtime_mode() -> &'static str {
    if let Ok(mode) = std::env::var("ENTROPIC_RUNTIME_MODE") {
        let lowered = mode.trim().to_ascii_lowercase();
        if lowered == "dev" {
            return "dev";
        }
        if lowered == "prod" {
            return "prod";
        }
    }

    if cfg!(debug_assertions) {
        "dev"
    } else {
        "prod"
    }
}

fn windows_active_distro_name() -> &'static str {
    if windows_runtime_mode() == "dev" {
        ENTROPIC_WSL_DEV_DISTRO
    } else {
        ENTROPIC_WSL_PROD_DISTRO
    }
}

fn unix_now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn normalize_sha256_hex(value: &str) -> Option<String> {
    let lowered = value.trim().to_ascii_lowercase();
    if lowered.len() != 64 {
        return None;
    }
    if lowered.chars().all(|c| c.is_ascii_hexdigit()) {
        Some(lowered)
    } else {
        None
    }
}

fn parse_sha256_text(value: &str) -> Option<String> {
    for token in value.split_whitespace() {
        if let Some(hash) = normalize_sha256_hex(token) {
            return Some(hash);
        }
    }
    normalize_sha256_hex(value)
}

/// Emergency-only escape hatch for local debugging.
/// By default Entropic uses isolated Colima sockets on macOS.
fn macos_docker_desktop_fallback_allowed() -> bool {
    env_var_truthy("ENTROPIC_RUNTIME_ALLOW_DOCKER_DESKTOP")
}

pub(crate) fn macos_docker_socket_candidates() -> Vec<PathBuf> {
    let mut candidates = entropic_colima_socket_candidates();
    if macos_docker_desktop_fallback_allowed() {
        if let Some(home) = dirs::home_dir() {
            candidates.push(home.join(".docker/run/docker.sock"));
            candidates.push(home.join(".docker/desktop/docker.sock"));
        }
        candidates.push(PathBuf::from("/var/run/docker.sock"));
    }
    candidates
}

#[derive(Debug, Clone, Copy)]
pub enum Platform {
    MacOS,
    Linux,
    Windows,
}

impl Platform {
    pub fn detect() -> Self {
        #[cfg(target_os = "macos")]
        return Platform::MacOS;
        #[cfg(target_os = "linux")]
        return Platform::Linux;
        #[cfg(target_os = "windows")]
        return Platform::Windows;
        #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
        return Platform::Linux; // fallback
    }
}

impl Runtime {
    pub fn new(resources_dir: PathBuf, vm_config: RuntimeVmConfig) -> Self {
        debug_log("=== Runtime::new() called ===");
        debug_log(&format!("resources_dir: {:?}", resources_dir));
        debug_log(&format!("resources_dir exists: {}", resources_dir.exists()));
        let platform = Platform::detect();
        debug_log(&format!("Platform detected: {:?}", platform));
        debug_log(&format!(
            "Colima config cpu={} memory_gb={} disk_gb={}",
            vm_config.cpu, vm_config.memory_gb, vm_config.disk_gb
        ));
        Self {
            resources_dir,
            platform,
            vm_config,
        }
    }

    fn colima_path(&self) -> PathBuf {
        // Tauri bundles "resources/bin/*" to "Contents/Resources/resources/bin/*"
        self.resources_dir
            .join("resources")
            .join("bin")
            .join("colima")
    }

    fn limactl_path(&self) -> PathBuf {
        self.resources_dir
            .join("resources")
            .join("bin")
            .join("limactl")
    }

    fn bundled_docker_path(&self) -> PathBuf {
        self.resources_dir
            .join("resources")
            .join("bin")
            .join("docker")
    }

    /// Find docker - prefer system on Linux, bundled on macOS
    fn docker_path(&self) -> Option<PathBuf> {
        match Platform::detect() {
            Platform::Linux => {
                if let Ok(system) = which::which("docker") {
                    return Some(system);
                }
                let bundled = self.bundled_docker_path();
                if bundled.exists() {
                    return Some(bundled);
                }
                None
            }
            _ => {
                let bundled = self.bundled_docker_path();
                if bundled.exists() {
                    return Some(bundled);
                }
                which::which("docker").ok()
            }
        }
    }

    fn colima_home(&self) -> PathBuf {
        entropic_colima_home_path()
    }

    fn runtime_home(&self) -> PathBuf {
        entropic_runtime_home_path()
    }

    fn runtime_tmp_dir(&self) -> PathBuf {
        self.runtime_home().join(".tmp")
    }

    fn colima_profiles(&self) -> [(&'static str, &'static str); 2] {
        [(ENTROPIC_VZ_PROFILE, "vz"), (ENTROPIC_QEMU_PROFILE, "qemu")]
    }

    fn colima_socket_for_profile(&self, profile: &str) -> PathBuf {
        self.colima_home().join(profile).join("docker.sock")
    }

    fn colima_profile_socket_candidates(&self) -> Vec<(&'static str, PathBuf)> {
        self.colima_profiles()
            .iter()
            .map(|(profile, _)| (*profile, self.colima_socket_for_profile(profile)))
            .collect()
    }

    fn preferred_colima_socket(&self) -> Option<PathBuf> {
        // First check our own profile sockets (dev or prod depending on build)
        for (profile, socket) in self.colima_profile_socket_candidates() {
            debug_log(&format!(
                "Checking socket for profile {} at {:?}",
                profile, socket
            ));
            if socket.exists() {
                return Some(socket);
            }
        }
        // Fall back to all known Colima socket locations (cross-profile discovery:
        // e.g. dev app finding a VM started by the build script in the prod profile)
        for socket in entropic_colima_socket_candidates() {
            if socket.exists() {
                debug_log(&format!(
                    "Found cross-profile Colima socket at {:?}",
                    socket
                ));
                return Some(socket);
            }
        }
        None
    }

    fn colima_command(&self) -> Command {
        let colima_path = self.colima_path();
        let mut cmd = self.bundled_command(&colima_path);
        cmd.env("COLIMA_HOME", self.colima_home().display().to_string());
        cmd
    }

    fn run_colima(
        &self,
        profile: &str,
        args: &[&str],
    ) -> Result<std::process::Output, std::io::Error> {
        let mut cmd = self.colima_command();
        cmd.arg("--profile").arg(profile);
        cmd.args(args);
        cmd.output()
    }

    fn run_colima_start(
        &self,
        profile: &str,
        vm_type: &str,
    ) -> Result<std::process::Output, std::io::Error> {
        let mut cmd = self.colima_command();
        cmd.arg("--profile").arg(profile);
        cmd.arg("start");
        cmd.arg("--vm-type").arg(vm_type);
        cmd.arg("--cpu").arg(self.vm_config.cpu.to_string());
        cmd.arg("--memory")
            .arg(self.vm_config.memory_gb.to_string());
        cmd.arg("--disk").arg(self.vm_config.disk_gb.to_string());
        cmd.output()
    }

    fn run_limactl(&self, args: &[&str]) -> Result<std::process::Output, std::io::Error> {
        let limactl_path = self.limactl_path();
        let mut cmd = self.bundled_command(&limactl_path);
        cmd.env(
            "LIMA_HOME",
            self.colima_home().join("_lima").display().to_string(),
        );
        cmd.args(args);
        cmd.output()
    }

    fn is_vz_unavailable_error(&self, output: &str) -> bool {
        let combined = output.to_lowercase();
        combined.contains("virtualization.framework")
            || combined.contains("vm type vz")
            || combined.contains("vm-type vz")
            || combined.contains("vz is not supported")
            || combined.contains("failed to validate vm type")
    }

    fn is_vz_guest_agent_error(&self, output: &str) -> bool {
        let combined = output.to_lowercase();
        combined.contains("guest agent does not seem to be running")
            || combined.contains("guest agent events closed unexpectedly")
            || combined.contains("degraded, status={running:true degraded:true")
            || combined.contains("connection reset by peer")
    }

    fn profile_is_degraded(&self, profile: &str) -> bool {
        let output = match self.run_colima(profile, &["status", "--json"]) {
            Ok(out) => out,
            Err(e) => {
                debug_log(&format!(
                    "Unable to inspect profile status ({}): {}",
                    profile, e
                ));
                return false;
            }
        };
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        debug_log(&format!(
            "colima status --json exit code ({}): {:?}",
            profile,
            output.status.code()
        ));
        debug_log(&format!(
            "colima status --json stdout ({}): {}",
            profile, stdout
        ));
        debug_log(&format!(
            "colima status --json stderr ({}): {}",
            profile, stderr
        ));

        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&stdout) {
            if let Some(degraded) = value.get("degraded").and_then(|v| v.as_bool()) {
                return degraded;
            }
            if let Some(status) = value.get("status").and_then(|v| v.as_str()) {
                if status.eq_ignore_ascii_case("degraded") {
                    return true;
                }
                if status.eq_ignore_ascii_case("running") {
                    return false;
                }
            }
        }

        let lower = format!("{}\n{}", stdout, stderr).to_lowercase();
        lower.contains("\"degraded\":true")
            || lower.contains("\"status\":\"degraded\"")
            || lower.contains("degraded, status={running:true")
    }

    fn stop_colima_profile_force(&self, profile: &str) {
        match self.run_colima(profile, &["stop", "--force"]) {
            Ok(stop_output) => {
                debug_log(&format!(
                    "colima stop --force exit code ({}): {:?}",
                    profile,
                    stop_output.status.code()
                ));
                debug_log(&format!(
                    "colima stop --force stderr ({}): {}",
                    profile,
                    String::from_utf8_lossy(&stop_output.stderr)
                ));
            }
            Err(e) => {
                debug_log(&format!("colima stop --force failed ({}): {}", profile, e));
            }
        }
    }

    fn try_repair_vz_profile(&self, profile: &str) -> Result<(), RuntimeError> {
        debug_log(&format!(
            "Attempting VZ in-place repair for profile {} via colima stop/start",
            profile
        ));
        self.stop_colima_profile_force(profile);
        std::thread::sleep(std::time::Duration::from_secs(COLIMA_RETRY_DELAY_SECS));

        let restart = self.run_colima_start(profile, "vz").map_err(|e| {
            RuntimeError::ColimaStartFailed(format!("VZ repair start failed: {}", e))
        })?;
        let restart_stdout = String::from_utf8_lossy(&restart.stdout);
        let restart_stderr = String::from_utf8_lossy(&restart.stderr);
        debug_log(&format!(
            "VZ repair start exit code ({}): {:?}",
            profile,
            restart.status.code()
        ));
        debug_log(&format!(
            "VZ repair start stdout ({}): {}",
            profile, restart_stdout
        ));
        debug_log(&format!(
            "VZ repair start stderr ({}): {}",
            profile, restart_stderr
        ));

        if restart.status.success() && !self.profile_is_degraded(profile) {
            debug_log("VZ in-place repair succeeded");
            return Ok(());
        }

        debug_log("VZ in-place repair did not clear degraded state, trying limactl stop/start");
        let instance = format!("colima-{}", profile);

        match self.run_limactl(&["stop", &instance]) {
            Ok(out) => {
                debug_log(&format!(
                    "limactl stop exit code ({}): {:?}",
                    instance,
                    out.status.code()
                ));
                debug_log(&format!(
                    "limactl stop stderr ({}): {}",
                    instance,
                    String::from_utf8_lossy(&out.stderr)
                ));
            }
            Err(e) => {
                debug_log(&format!("limactl stop failed ({}): {}", instance, e));
            }
        }

        std::thread::sleep(std::time::Duration::from_secs(COLIMA_RETRY_DELAY_SECS));

        let limactl_start = self
            .run_limactl(&["start", &instance])
            .map_err(|e| RuntimeError::ColimaStartFailed(format!("limactl start failed: {}", e)))?;
        debug_log(&format!(
            "limactl start exit code ({}): {:?}",
            instance,
            limactl_start.status.code()
        ));
        debug_log(&format!(
            "limactl start stdout ({}): {}",
            instance,
            String::from_utf8_lossy(&limactl_start.stdout)
        ));
        debug_log(&format!(
            "limactl start stderr ({}): {}",
            instance,
            String::from_utf8_lossy(&limactl_start.stderr)
        ));

        if !limactl_start.status.success() {
            return Err(RuntimeError::ColimaStartFailed(format!(
                "limactl start failed for {}: {}",
                instance,
                String::from_utf8_lossy(&limactl_start.stderr).trim()
            )));
        }

        let final_start = self.run_colima_start(profile, "vz").map_err(|e| {
            RuntimeError::ColimaStartFailed(format!("final VZ start failed: {}", e))
        })?;
        debug_log(&format!(
            "final VZ start exit code ({}): {:?}",
            profile,
            final_start.status.code()
        ));
        debug_log(&format!(
            "final VZ start stdout ({}): {}",
            profile,
            String::from_utf8_lossy(&final_start.stdout)
        ));
        debug_log(&format!(
            "final VZ start stderr ({}): {}",
            profile,
            String::from_utf8_lossy(&final_start.stderr)
        ));

        if final_start.status.success() && !self.profile_is_degraded(profile) {
            debug_log("VZ repair via limactl succeeded");
            return Ok(());
        }

        Err(RuntimeError::ColimaStartFailed(
            "VZ repair attempts did not clear degraded state".to_string(),
        ))
    }

    fn shell_escape_arg(arg: &str) -> String {
        // POSIX-safe single-quoted argument escaping.
        let mut escaped = String::from("'");
        for ch in arg.chars() {
            if ch == '\'' {
                escaped.push_str("'\\''");
            } else {
                escaped.push(ch);
            }
        }
        escaped.push('\'');
        escaped
    }

    fn manual_reset_commands(
        &self,
        colima_path: &std::path::Path,
        profiles: &[&str],
    ) -> Vec<String> {
        let colima_home = self.colima_home();
        let colima_home_str = Self::shell_escape_arg(&colima_home.to_string_lossy());
        let runtime_home = self.runtime_home();
        let runtime_home_str = Self::shell_escape_arg(&runtime_home.to_string_lossy());
        let colima_path_str = Self::shell_escape_arg(&colima_path.to_string_lossy());
        profiles
            .iter()
            .map(|profile| {
                let profile_str = Self::shell_escape_arg(profile);
                format!(
                    "HOME={} COLIMA_HOME={} {} --profile {} delete --force",
                    runtime_home_str, colima_home_str, colima_path_str, profile_str
                )
            })
            .collect()
    }

    fn should_auto_reset_isolated_runtime(&self, message: &str) -> bool {
        if Self::is_whitespace_path_error(message) {
            return false;
        }

        let lower = message.to_lowercase();
        lower.contains("error validating sha sum") || lower.contains("error getting qcow image")
    }

    fn is_whitespace_path_error(message: &str) -> bool {
        let lower = message.to_lowercase();
        lower.contains("cd: /users/") && lower.contains("no such file or directory")
    }

    fn reset_isolated_colima_runtime(&self) -> Result<(), RuntimeError> {
        debug_log("Attempting automatic reset of Entropic isolated Colima runtime");
        for (profile, _) in self.colima_profiles() {
            let _ = self.run_colima(profile, &["stop", "--force"]);
            let _ = self.run_colima(profile, &["delete", "--force"]);
        }

        let colima_home = self.colima_home();
        if colima_home.exists() {
            std::fs::remove_dir_all(&colima_home).map_err(|e| {
                RuntimeError::ColimaStartFailed(format!(
                    "Failed to remove isolated Colima runtime at {}: {}",
                    colima_home.display(),
                    e
                ))
            })?;
        }

        std::fs::create_dir_all(&colima_home).map_err(|e| {
            RuntimeError::ColimaStartFailed(format!(
                "Failed to recreate isolated Colima runtime at {}: {}",
                colima_home.display(),
                e
            ))
        })?;
        self.secure_colima_home_permissions(&colima_home)?;
        debug_log("Automatic isolated Colima runtime reset complete");
        Ok(())
    }

    pub fn reset_isolated_runtime_state(&self) -> Result<(), RuntimeError> {
        match Platform::detect() {
            Platform::Windows => self.reset_windows_runtime_state(),
            _ => self.reset_isolated_colima_runtime(),
        }
    }

    fn is_docker_ready_on_socket(&self, socket_path: &std::path::Path) -> bool {
        if !socket_path.exists() {
            debug_log(&format!(
                "Socket missing for readiness check: {:?}",
                socket_path
            ));
            return false;
        }

        let docker = self
            .docker_path()
            .unwrap_or_else(|| std::path::PathBuf::from("docker"));
        let _ = self.ensure_executable();

        let docker_host = format!("unix://{}", socket_path.display());
        debug_log(&format!("Trying DOCKER_HOST: {}", docker_host));

        let output = Command::new(&docker)
            .args(["info"])
            .env("DOCKER_HOST", &docker_host)
            .output();

        match output {
            Ok(out) if out.status.success() => {
                debug_log("Docker info succeeded");
                true
            }
            Ok(out) => {
                debug_log(&format!("Docker info exit code: {:?}", out.status.code()));
                debug_log(&format!("stderr: {}", String::from_utf8_lossy(&out.stderr)));
                false
            }
            Err(e) => {
                debug_log(&format!("Docker command error: {}", e));
                false
            }
        }
    }

    fn start_colima_profile(&self, profile: &str, vm_type: &str) -> Result<(), RuntimeError> {
        for attempt in 1..=2 {
            debug_log(&format!(
                "Colima start attempt {}/2 (profile={}, vm_type={})",
                attempt, profile, vm_type
            ));

            let output = self
                .run_colima_start(profile, vm_type)
                .map_err(|e| RuntimeError::ColimaStartFailed(e.to_string()))?;

            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            debug_log(&format!(
                "colima start exit code: {:?}",
                output.status.code()
            ));
            debug_log(&format!("colima start stdout: {}", stdout));
            debug_log(&format!("colima start stderr: {}", stderr));

            if output.status.success() {
                if vm_type == "vz" && self.profile_is_degraded(profile) {
                    debug_log(
                        "colima start returned success but profile is still DEGRADED; forcing retry",
                    );
                    if attempt == 1 {
                        self.stop_colima_profile_force(profile);
                        std::thread::sleep(std::time::Duration::from_secs(COLIMA_RETRY_DELAY_SECS));
                        continue;
                    }
                    return Err(RuntimeError::ColimaStartFailed(
                        "colima start returned success but profile remained DEGRADED".to_string(),
                    ));
                }
                debug_log("Colima started successfully");
                return Ok(());
            }

            // Colima may exit non-zero in DEGRADED state (guest agent not running)
            // while Docker is still usable via sockets. We still treat this as
            // failure because guest-agent degradation breaks host port forwarding.
            let is_degraded = stderr.contains("DEGRADED")
                || stderr.contains("degraded")
                || stdout.contains("DEGRADED")
                || stdout.contains("degraded");
            if is_degraded {
                debug_log("Colima reported DEGRADED state; treating as startup failure");
                std::thread::sleep(std::time::Duration::from_secs(2));
                let profile_socket = self.colima_socket_for_profile(profile);
                if self.is_docker_ready_on_socket(&profile_socket) {
                    debug_log(
                        "Docker socket is reachable despite DEGRADED state, but host networking is unreliable",
                    );
                }
            }

            if attempt == 1 {
                debug_log("First attempt failed, trying non-destructive recovery via stop --force");
                self.stop_colima_profile_force(profile);
                // Give Colima time to release locks/sockets before retrying.
                std::thread::sleep(std::time::Duration::from_secs(COLIMA_RETRY_DELAY_SECS));
                continue;
            }

            return Err(RuntimeError::ColimaStartFailed(format!(
                "{}\n{}",
                stderr.trim(),
                stdout.trim()
            )));
        }

        unreachable!()
    }

    fn command_output_summary(output: &std::process::Output) -> String {
        let stdout = Self::sanitize_command_output(&output.stdout);
        let stderr = Self::sanitize_command_output(&output.stderr);
        match (stdout.is_empty(), stderr.is_empty()) {
            (true, true) => "<no output>".to_string(),
            (false, true) => format!("stdout: {}", stdout),
            (true, false) => format!("stderr: {}", stderr),
            (false, false) => format!("stdout: {} | stderr: {}", stdout, stderr),
        }
    }

    fn sanitize_command_output(bytes: &[u8]) -> String {
        decode_command_output(bytes)
            .replace('\0', "")
            .trim()
            .to_string()
    }

    fn wsl_command(&self) -> Command {
        if let Ok(script) = std::env::var("ENTROPIC_WSL_POWERSHELL_SCRIPT") {
            let trimmed = script.trim();
            if !trimmed.is_empty() {
                let mut cmd = Command::new("powershell");
                cmd.args([
                    "-NoProfile",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                    trimmed,
                ]);
                apply_windows_no_window(&mut cmd);
                return cmd;
            }
        }

        let program = std::env::var("ENTROPIC_WSL_EXE")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "wsl.exe".to_string());
        let mut cmd = Command::new(program);
        apply_windows_no_window(&mut cmd);
        cmd
    }

    fn run_wsl(&self, args: &[&str]) -> Result<std::process::Output, std::io::Error> {
        let mut cmd = self.wsl_command();
        cmd.args(args);
        let output = cmd.output()?;
        debug_log(&format!(
            "wsl.exe {} => code {:?} ({})",
            args.join(" "),
            output.status.code(),
            Self::command_output_summary(&output)
        ));
        Ok(output)
    }

    fn run_windows_powershell(&self, script: &str) -> Result<std::process::Output, std::io::Error> {
        let mut cmd = Command::new("powershell");
        apply_windows_no_window(&mut cmd);
        cmd.args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            script,
        ]);
        let output = cmd.output()?;
        debug_log(&format!(
            "powershell {} => code {:?} ({})",
            script,
            output.status.code(),
            Self::command_output_summary(&output)
        ));
        Ok(output)
    }

    fn windows_runtime_root(&self) -> PathBuf {
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            let trimmed = local.trim();
            if !trimmed.is_empty() {
                return PathBuf::from(trimmed).join("Entropic").join("runtime");
            }
        }
        self.runtime_home()
            .join(".entropic")
            .join("windows-runtime")
    }

    fn windows_bootstrap_state_path(&self) -> PathBuf {
        self.windows_runtime_root()
            .join(WINDOWS_BOOTSTRAP_STATE_FILE)
    }

    fn load_windows_bootstrap_state(&self) -> Option<WindowsBootstrapState> {
        let path = self.windows_bootstrap_state_path();
        let raw = std::fs::read_to_string(path).ok()?;
        serde_json::from_str::<WindowsBootstrapState>(&raw).ok()
    }

    fn save_windows_bootstrap_state(
        &self,
        stage: &str,
        pending_reboot: bool,
        error: Option<String>,
    ) {
        let path = self.windows_bootstrap_state_path();
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let payload = WindowsBootstrapState {
            stage: stage.to_string(),
            pending_reboot,
            error,
            updated_at_unix: unix_now_secs(),
        };
        if let Ok(json) = serde_json::to_string_pretty(&payload) {
            let _ = std::fs::write(path, json);
        }
    }

    fn clear_windows_bootstrap_state(&self) {
        let path = self.windows_bootstrap_state_path();
        let _ = std::fs::remove_file(path);
    }

    fn windows_runtime_cache_root(&self) -> Option<PathBuf> {
        let home = std::env::var_os("ENTROPIC_TEST_HOME_DIR")
            .map(PathBuf::from)
            .or_else(dirs::home_dir)?;
        Some(home.join(".entropic").join("cache"))
    }

    fn save_windows_bootstrap_error(&self, stage: &str, err: &RuntimeError) {
        self.save_windows_bootstrap_state(stage, false, Some(err.to_string()));
    }

    fn windows_distro_location(&self, distro: &str) -> PathBuf {
        self.windows_runtime_root().join("wsl").join(distro)
    }

    fn windows_distro_artifact_candidates(&self, distro: &str) -> Vec<PathBuf> {
        let mode = if distro == ENTROPIC_WSL_DEV_DISTRO {
            "dev"
        } else {
            "prod"
        };
        let mut candidates: Vec<PathBuf> = Vec::new();

        let mode_key = format!("ENTROPIC_WSL_{}_DISTRO_ARTIFACT", mode.to_ascii_uppercase());
        if let Ok(value) = std::env::var(&mode_key) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                candidates.push(PathBuf::from(trimmed));
            }
        }
        if let Ok(value) = std::env::var("ENTROPIC_WSL_DISTRO_ARTIFACT") {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                candidates.push(PathBuf::from(trimmed));
            }
        }

        let resources_runtime = self.resources_dir.join("resources").join("runtime");
        let resources_root = self.resources_dir.join("resources");
        for base in [resources_runtime, resources_root] {
            candidates.push(base.join(format!("entropic-runtime-{}.wsl", mode)));
            candidates.push(base.join(format!("entropic-runtime-{}.tar", mode)));
            candidates.push(base.join("entropic-runtime.wsl"));
            candidates.push(base.join("entropic-runtime.tar"));
        }

        candidates.push(self.windows_cached_distro_artifact_path(distro));

        candidates
    }

    fn windows_find_distro_artifact(&self, distro: &str) -> Option<PathBuf> {
        self.windows_distro_artifact_candidates(distro)
            .into_iter()
            .find(|path| path.exists())
    }

    fn windows_runtime_release_repo(&self) -> String {
        std::env::var("OPENCLAW_RUNTIME_RELEASE_REPO")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| WINDOWS_RUNTIME_RELEASE_REPO.to_string())
    }

    fn windows_runtime_release_tag(&self) -> String {
        std::env::var("OPENCLAW_RUNTIME_RELEASE_TAG")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| WINDOWS_RUNTIME_RELEASE_TAG.to_string())
    }

    fn windows_runtime_cache_dir(&self) -> PathBuf {
        self.windows_runtime_root().join("cache")
    }

    fn windows_cached_distro_artifact_path(&self, distro: &str) -> PathBuf {
        let mode = if distro == ENTROPIC_WSL_DEV_DISTRO {
            "dev"
        } else {
            "prod"
        };
        self.windows_runtime_cache_dir()
            .join(format!("entropic-runtime-{}.tar", mode))
    }

    fn windows_cached_runtime_manifest_path(&self) -> PathBuf {
        self.windows_runtime_cache_dir()
            .join(WINDOWS_RUNTIME_MANIFEST_NAME)
    }

    fn windows_runtime_manifest_url(&self) -> String {
        format!(
            "https://github.com/{}/releases/download/{}/{}",
            self.windows_runtime_release_repo(),
            self.windows_runtime_release_tag(),
            WINDOWS_RUNTIME_MANIFEST_NAME
        )
    }

    fn windows_default_distro_artifact_url(&self) -> String {
        format!(
            "https://github.com/{}/releases/download/{}/{}",
            self.windows_runtime_release_repo(),
            self.windows_runtime_release_tag(),
            WINDOWS_RUNTIME_ROOTFS_ASSET_NAME
        )
    }

    fn windows_download_url_to_path(
        &self,
        url: &str,
        output_path: &std::path::Path,
    ) -> Result<(), RuntimeError> {
        let parent = output_path.parent().ok_or_else(|| {
            RuntimeError::CommandFailed(format!(
                "Invalid download destination without parent: {}",
                output_path.display()
            ))
        })?;
        std::fs::create_dir_all(parent).map_err(|e| {
            RuntimeError::CommandFailed(format!(
                "Failed to create runtime cache directory {}: {}",
                parent.display(),
                e
            ))
        })?;

        let partial_path = output_path.with_extension("partial");
        let _ = std::fs::remove_file(&partial_path);

        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(600))
            .build()
            .map_err(|e| RuntimeError::CommandFailed(format!("Failed to build HTTP client: {}", e)))?;
        let mut response = client
            .get(url)
            .send()
            .map_err(|e| RuntimeError::CommandFailed(format!("Failed downloading {}: {}", url, e)))?;

        if !response.status().is_success() {
            return Err(RuntimeError::CommandFailed(format!(
                "Failed downloading {}: HTTP {}",
                url,
                response.status()
            )));
        }

        let mut file = std::fs::File::create(&partial_path).map_err(|e| {
            RuntimeError::CommandFailed(format!(
                "Failed creating {}: {}",
                partial_path.display(),
                e
            ))
        })?;
        std::io::copy(&mut response, &mut file).map_err(|e| {
            RuntimeError::CommandFailed(format!(
                "Failed writing {}: {}",
                partial_path.display(),
                e
            ))
        })?;
        std::fs::rename(&partial_path, output_path).map_err(|e| {
            RuntimeError::CommandFailed(format!(
                "Failed moving {} to {}: {}",
                partial_path.display(),
                output_path.display(),
                e
            ))
        })?;
        Ok(())
    }

    fn windows_fetch_runtime_manifest(&self) -> Result<WindowsRuntimeReleaseManifest, RuntimeError> {
        let manifest_url = self.windows_runtime_manifest_url();
        let manifest_path = self.windows_cached_runtime_manifest_path();
        self.windows_download_url_to_path(&manifest_url, &manifest_path)?;
        let raw = std::fs::read_to_string(&manifest_path).map_err(|e| {
            RuntimeError::CommandFailed(format!(
                "Failed reading runtime manifest {}: {}",
                manifest_path.display(),
                e
            ))
        })?;
        serde_json::from_str::<WindowsRuntimeReleaseManifest>(&raw).map_err(|e| {
            RuntimeError::CommandFailed(format!(
                "Invalid runtime manifest at {}: {}",
                manifest_url, e
            ))
        })
    }

    fn windows_download_distro_artifact_to_cache(
        &self,
        distro: &str,
    ) -> Result<PathBuf, RuntimeError> {
        let cache_dir = self.windows_runtime_cache_dir();
        std::fs::create_dir_all(&cache_dir).map_err(|e| {
            RuntimeError::CommandFailed(format!(
                "Failed to create Windows runtime cache directory {}: {}",
                cache_dir.display(),
                e
            ))
        })?;

        let artifact_path = self.windows_cached_distro_artifact_path(distro);
        let manifest = self.windows_fetch_runtime_manifest()?;
        let artifact_url = manifest
            .windows_wsl_rootfs_url
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| value.to_string())
            .unwrap_or_else(|| self.windows_default_distro_artifact_url());
        let expected_hash = manifest
            .windows_wsl_rootfs_sha256
            .as_deref()
            .and_then(parse_sha256_text)
            .ok_or_else(|| {
                RuntimeError::CommandFailed(format!(
                    "Runtime manifest is missing windows_wsl_rootfs_sha256: {}",
                    self.windows_runtime_manifest_url()
                ))
            })?;

        debug_log(&format!(
            "downloading Windows WSL rootfs for {} from {}",
            distro, artifact_url
        ));
        self.windows_download_url_to_path(&artifact_url, &artifact_path)?;
        let actual_hash = Self::sha256_for_file(&artifact_path)?;
        if actual_hash != expected_hash {
            return Err(RuntimeError::CommandFailed(format!(
                "Downloaded Windows rootfs hash mismatch for {}: expected {}, got {}",
                distro, expected_hash, actual_hash
            )));
        }

        let sidecar = artifact_path.with_extension("tar.sha256");
        std::fs::write(&sidecar, format!("{}\n", expected_hash)).map_err(|e| {
            RuntimeError::CommandFailed(format!(
                "Failed writing SHA-256 sidecar {}: {}",
                sidecar.display(),
                e
            ))
        })?;

        Ok(artifact_path)
    }

    fn windows_expected_distro_sha256(
        &self,
        distro: &str,
        artifact: &std::path::Path,
    ) -> Option<String> {
        let mode = if distro == ENTROPIC_WSL_DEV_DISTRO {
            "DEV"
        } else {
            "PROD"
        };
        let env_keys = [
            format!("ENTROPIC_WSL_{}_DISTRO_SHA256", mode),
            "ENTROPIC_WSL_DISTRO_SHA256".to_string(),
        ];
        for key in env_keys {
            if let Ok(value) = std::env::var(&key) {
                if let Some(hash) = parse_sha256_text(&value) {
                    return Some(hash);
                }
            }
        }

        let mut sidecars = vec![PathBuf::from(format!("{}.sha256", artifact.display()))];
        let resources_runtime = self.resources_dir.join("resources").join("runtime");
        if distro == ENTROPIC_WSL_DEV_DISTRO {
            sidecars.push(resources_runtime.join("entropic-runtime-dev.sha256"));
        } else {
            sidecars.push(resources_runtime.join("entropic-runtime-prod.sha256"));
        }
        sidecars.push(resources_runtime.join("entropic-runtime.sha256"));

        for sidecar in sidecars {
            let Ok(contents) = std::fs::read_to_string(&sidecar) else {
                continue;
            };
            if let Some(hash) = parse_sha256_text(&contents) {
                return Some(hash);
            }
        }

        None
    }

    fn sha256_for_file(path: &std::path::Path) -> Result<String, RuntimeError> {
        let mut file = std::fs::File::open(path).map_err(|e| {
            RuntimeError::CommandFailed(format!(
                "Failed to open artifact {} for SHA-256 verification: {}",
                path.display(),
                e
            ))
        })?;
        let mut hasher = Sha256::new();
        let mut buf = [0u8; 64 * 1024];
        loop {
            let read = file.read(&mut buf).map_err(|e| {
                RuntimeError::CommandFailed(format!(
                    "Failed while reading artifact {}: {}",
                    path.display(),
                    e
                ))
            })?;
            if read == 0 {
                break;
            }
            hasher.update(&buf[..read]);
        }
        Ok(format!("{:x}", hasher.finalize()))
    }

    fn verify_windows_distro_artifact_hash(
        &self,
        distro: &str,
        artifact: &std::path::Path,
    ) -> Result<(), RuntimeError> {
        let expected = self.windows_expected_distro_sha256(distro, artifact);
        if expected.is_none() {
            if cfg!(debug_assertions) {
                debug_log(&format!(
                    "Skipping WSL artifact hash verification for {} in debug mode (no expected hash configured)",
                    artifact.display()
                ));
                return Ok(());
            }
            return Err(RuntimeError::CommandFailed(format!(
                "Missing required SHA-256 for WSL artifact {} (mode {}).",
                artifact.display(),
                if distro == ENTROPIC_WSL_DEV_DISTRO {
                    "dev"
                } else {
                    "prod"
                }
            )));
        }

        let expected = expected.expect("checked is_some");
        let actual = Self::sha256_for_file(artifact)?;
        if actual != expected {
            return Err(RuntimeError::CommandFailed(format!(
                "WSL artifact hash mismatch for {}. expected={} actual={}",
                artifact.display(),
                expected,
                actual
            )));
        }

        Ok(())
    }

    fn windows_wsl_feature_states_from_test_file() -> Option<WindowsWslFeatureStates> {
        let state_file = std::env::var("ENTROPIC_TEST_WSL_STATE_FILE").ok()?;
        let raw = std::fs::read_to_string(state_file).ok()?;
        let mut states = WindowsWslFeatureStates::default();

        for line in raw.lines() {
            if let Some(value) = line.strip_prefix("feature_wsl=") {
                states.set(
                    WINDOWS_WSL_FEATURE_NAME,
                    WindowsOptionalFeatureState::parse(value),
                );
            } else if let Some(value) = line.strip_prefix("feature_vmp=") {
                states.set(
                    WINDOWS_VM_PLATFORM_FEATURE_NAME,
                    WindowsOptionalFeatureState::parse(value),
                );
            }
        }

        states.any_known().then_some(states)
    }

    fn windows_wsl_feature_states_from_system(&self) -> Option<WindowsWslFeatureStates> {
        let script = format!(
            "$ErrorActionPreference = 'Stop'; Get-WindowsOptionalFeature -Online -FeatureName '{wsl}','{vmp}' | Select-Object FeatureName,@{{Name='State';Expression={{ $_.State.ToString() }}}} | ConvertTo-Json -Compress",
            wsl = WINDOWS_WSL_FEATURE_NAME,
            vmp = WINDOWS_VM_PLATFORM_FEATURE_NAME,
        );
        let output = match self.run_windows_powershell(&script) {
            Ok(out) => out,
            Err(err) => {
                debug_log(&format!(
                    "Failed to query Windows optional feature state for WSL bootstrap: {}",
                    err
                ));
                return None;
            }
        };
        if !output.status.success() {
            debug_log(&format!(
                "Windows optional feature query failed: {}",
                Self::command_output_summary(&output)
            ));
            return None;
        }

        let raw = Self::sanitize_command_output(&output.stdout);
        if raw.is_empty() {
            debug_log("Windows optional feature query returned empty stdout");
            return None;
        }

        let parsed = match serde_json::from_str::<serde_json::Value>(&raw) {
            Ok(value) => value,
            Err(err) => {
                debug_log(&format!(
                    "Failed to parse Windows optional feature JSON '{}': {}",
                    raw, err
                ));
                return None;
            }
        };

        let mut states = WindowsWslFeatureStates::default();
        match parsed {
            serde_json::Value::Array(items) => {
                for item in items {
                    match serde_json::from_value::<WindowsOptionalFeatureRecord>(item) {
                        Ok(record) => states.set(
                            &record.feature_name,
                            WindowsOptionalFeatureState::parse(&record.state),
                        ),
                        Err(err) => debug_log(&format!(
                            "Failed to parse Windows optional feature record: {}",
                            err
                        )),
                    }
                }
            }
            serde_json::Value::Object(object) => {
                match serde_json::from_value::<WindowsOptionalFeatureRecord>(
                    serde_json::Value::Object(object),
                ) {
                    Ok(record) => states.set(
                        &record.feature_name,
                        WindowsOptionalFeatureState::parse(&record.state),
                    ),
                    Err(err) => {
                        debug_log(&format!(
                            "Failed to parse Windows optional feature object: {}",
                            err
                        ));
                        return None;
                    }
                }
            }
            other => {
                debug_log(&format!(
                    "Unexpected Windows optional feature JSON payload: {}",
                    other
                ));
                return None;
            }
        }

        states.any_known().then_some(states)
    }

    fn windows_wsl_feature_states(&self) -> Option<WindowsWslFeatureStates> {
        if let Some(states) = Self::windows_wsl_feature_states_from_test_file() {
            return Some(states);
        }

        #[cfg(target_os = "windows")]
        {
            return self.windows_wsl_feature_states_from_system();
        }

        #[cfg(not(target_os = "windows"))]
        {
            None
        }
    }

    fn windows_wsl_features_pending_reboot(&self) -> bool {
        self.windows_wsl_feature_states()
            .map(|states| states.pending_reboot())
            .unwrap_or(false)
    }

    fn windows_wsl_features_need_enable(&self) -> bool {
        self.windows_wsl_feature_states()
            .map(|states| states.any_required_disabled())
            .unwrap_or(false)
    }

    fn windows_wsl_install_requires_reboot(&self, output: &std::process::Output) -> bool {
        self.windows_wsl_features_pending_reboot() || Self::output_mentions_reboot(output)
    }

    fn windows_wsl_reboot_message() -> String {
        "WSL platform installed. Restart Windows to finish setup, then reopen Entropic."
            .to_string()
    }

    fn legacy_windows_wsl_cli_message() -> String {
        "The installed WSL command is too old for Entropic's automatic setup. Update WSL or enable Windows Subsystem for Linux and Virtual Machine Platform, restart Windows, then reopen Entropic.".to_string()
    }

    fn manual_windows_wsl_feature_enable_message() -> String {
        "Entropic could not enable the required Windows features automatically. Enable Windows Subsystem for Linux and Virtual Machine Platform, restart Windows if prompted, then reopen Entropic.".to_string()
    }

    fn windows_wsl_available(&self) -> bool {
        for args in [
            &["--version"][..],
            &["--status"][..],
            &["--list", "--quiet"][..],
            &["-l", "-q"][..],
        ] {
            if let Ok(out) = self.run_wsl(args) {
                if out.status.success() {
                    return true;
                }
            }
        }
        false
    }

    fn windows_wait_for_wsl_available(&self) -> bool {
        if self.windows_wsl_available() {
            return true;
        }

        for _ in 0..WINDOWS_WSL_AVAILABILITY_POLL_ATTEMPTS {
            std::thread::sleep(std::time::Duration::from_millis(
                WINDOWS_WSL_AVAILABILITY_POLL_MILLIS,
            ));
            if self.windows_wsl_available() {
                return true;
            }
        }

        false
    }

    fn windows_distro_registered(&self, distro: &str) -> bool {
        let output = match self.run_wsl(&["--list", "--quiet"]) {
            Ok(out) => out,
            Err(err) => {
                debug_log(&format!(
                    "Failed to list WSL distros while checking {}: {}",
                    distro, err
                ));
                return false;
            }
        };
        if !output.status.success() {
            debug_log(&format!(
                "Failed to list WSL distros while checking {}: {}",
                distro,
                Self::command_output_summary(&output)
            ));
            return false;
        }
        let listing = Self::sanitize_command_output(&output.stdout);
        listing.lines().any(|line| line.trim() == distro)
    }

    fn output_mentions_reboot(output: &std::process::Output) -> bool {
        let combined = format!(
            "{}\n{}",
            Self::sanitize_command_output(&output.stdout),
            Self::sanitize_command_output(&output.stderr)
        )
        .to_ascii_lowercase();
        combined.contains("restart")
            || combined.contains("reboot")
            || combined.contains("required reboot")
    }

    fn output_mentions_unsupported_wsl_install(output: &std::process::Output) -> bool {
        let combined = format!(
            "{}\n{}",
            Self::sanitize_command_output(&output.stdout),
            Self::sanitize_command_output(&output.stderr)
        )
        .to_ascii_lowercase();
        (combined.contains("invalid command line option")
            || combined.contains("unrecognized option")
            || combined.contains("unknown option")
            || combined.contains("unknown argument"))
            && combined.contains("--install")
    }

    fn output_contains_manual_wsl_install_guidance(text: &str) -> bool {
        let lower = text.to_ascii_lowercase();
        lower.contains("wsl.exe --install") || lower.contains("aka.ms/wslinstall")
    }

    fn output_mentions_manual_wsl_install_guidance(output: &std::process::Output) -> bool {
        let combined = format!(
            "{}\n{}",
            Self::sanitize_command_output(&output.stdout),
            Self::sanitize_command_output(&output.stderr)
        );
        Self::output_contains_manual_wsl_install_guidance(&combined)
    }

    fn manual_windows_wsl_install_message() -> String {
        "WSL is not installed on this Windows machine yet, and Entropic could not enable it automatically. Run \"wsl.exe --install\" from an elevated PowerShell or Command Prompt, restart Windows if prompted, then reopen Entropic.".to_string()
    }

    fn run_elevated_windows_wsl_install(&self) -> Result<std::process::Output, RuntimeError> {
        if std::env::var("ENTROPIC_TEST_WSL_STATE_FILE").is_ok() {
            return self
                .run_wsl(&["--install", "--no-distribution"])
                .map_err(|e| {
                    RuntimeError::CommandFailed(format!(
                        "Failed to invoke test WSL install shim: {}",
                        e
                    ))
                });
        }

        self.run_windows_powershell(
            "$p = Start-Process -FilePath wsl.exe -ArgumentList '--install','--no-distribution' -Verb RunAs -Wait -PassThru; exit $p.ExitCode",
        )
        .map_err(|e| RuntimeError::CommandFailed(format!("Failed to request elevated WSL install: {}", e)))
    }

    fn ensure_windows_wsl_platform(&self) -> Result<(), RuntimeError> {
        if self.windows_wsl_available() {
            return Ok(());
        }

        self.save_windows_bootstrap_state(WINDOWS_BOOTSTRAP_STAGE_WSL_INSTALL, false, None);

        let direct = self
            .run_wsl(&["--install", "--no-distribution"])
            .map_err(|e| {
                RuntimeError::CommandFailed(format!("Failed to invoke wsl --install: {}", e))
            })?;
        let direct_summary = Self::command_output_summary(&direct);
        let direct_lower = direct_summary.to_ascii_lowercase();
        let direct_install_guidance = Self::output_mentions_manual_wsl_install_guidance(&direct);
        let direct_unsupported = Self::output_mentions_unsupported_wsl_install(&direct);
        let direct_needs_elevation = direct_lower.contains("elevation")
            || direct_lower.contains("administrator")
            || direct_lower.contains("access is denied")
            || direct_lower.contains("requested operation requires elevation");

        if direct.status.success() || self.windows_wsl_available() {
            if self.windows_wait_for_wsl_available() {
                return Ok(());
            }
            if self.windows_wsl_install_requires_reboot(&direct) {
                let message = Self::windows_wsl_reboot_message();
                self.save_windows_bootstrap_state(
                    WINDOWS_BOOTSTRAP_STAGE_WSL_INSTALL,
                    true,
                    Some(message.clone()),
                );
                return Err(RuntimeError::CommandFailed(message));
            }

            let err = RuntimeError::CommandFailed(format!(
                "WSL install completed but WSL is still unavailable: {}",
                direct_summary
            ));
            self.save_windows_bootstrap_error(WINDOWS_BOOTSTRAP_STAGE_WSL_INSTALL, &err);
            return Err(err);
        }

        if self.windows_wsl_install_requires_reboot(&direct) {
            let message = Self::windows_wsl_reboot_message();
            self.save_windows_bootstrap_state(
                WINDOWS_BOOTSTRAP_STAGE_WSL_INSTALL,
                true,
                Some(message.clone()),
            );
            return Err(RuntimeError::CommandFailed(message));
        }

        let should_try_elevated =
            self.windows_wsl_features_need_enable() || direct_install_guidance || direct_needs_elevation;

        if should_try_elevated {
            let elevated = self.run_elevated_windows_wsl_install()?;
            let elevated_summary = Self::command_output_summary(&elevated);
            let elevated_install_guidance =
                Self::output_mentions_manual_wsl_install_guidance(&elevated);
            let elevated_unsupported = Self::output_mentions_unsupported_wsl_install(&elevated);

            if elevated.status.success() || self.windows_wsl_available() {
                if self.windows_wait_for_wsl_available() {
                    return Ok(());
                }
                if self.windows_wsl_install_requires_reboot(&elevated) {
                    let message = Self::windows_wsl_reboot_message();
                    self.save_windows_bootstrap_state(
                        WINDOWS_BOOTSTRAP_STAGE_WSL_INSTALL,
                        true,
                        Some(message.clone()),
                    );
                    return Err(RuntimeError::CommandFailed(message));
                }

                let err = RuntimeError::CommandFailed(format!(
                    "Elevated WSL install completed but WSL is still unavailable: {}",
                    elevated_summary
                ));
                self.save_windows_bootstrap_error(WINDOWS_BOOTSTRAP_STAGE_WSL_INSTALL, &err);
                return Err(err);
            }

            if self.windows_wsl_install_requires_reboot(&elevated) {
                let message = Self::windows_wsl_reboot_message();
                self.save_windows_bootstrap_state(
                    WINDOWS_BOOTSTRAP_STAGE_WSL_INSTALL,
                    true,
                    Some(message.clone()),
                );
                return Err(RuntimeError::CommandFailed(message));
            }

            if direct_unsupported || elevated_unsupported {
                let err = RuntimeError::CommandFailed(Self::legacy_windows_wsl_cli_message());
                self.save_windows_bootstrap_error(WINDOWS_BOOTSTRAP_STAGE_WSL_INSTALL, &err);
                return Err(err);
            }

            if self.windows_wsl_features_need_enable() {
                let err = RuntimeError::CommandFailed(
                    Self::manual_windows_wsl_feature_enable_message(),
                );
                self.save_windows_bootstrap_error(WINDOWS_BOOTSTRAP_STAGE_WSL_INSTALL, &err);
                return Err(err);
            }

            if direct_install_guidance || elevated_install_guidance {
                let err =
                    RuntimeError::CommandFailed(Self::manual_windows_wsl_install_message());
                self.save_windows_bootstrap_error(WINDOWS_BOOTSTRAP_STAGE_WSL_INSTALL, &err);
                return Err(err);
            }

            let err = RuntimeError::CommandFailed(format!(
                "WSL install failed after elevation attempt: {}",
                elevated_summary
            ));
            self.save_windows_bootstrap_error(WINDOWS_BOOTSTRAP_STAGE_WSL_INSTALL, &err);
            return Err(err);
        }

        if direct_unsupported {
            let err = RuntimeError::CommandFailed(Self::legacy_windows_wsl_cli_message());
            self.save_windows_bootstrap_error(WINDOWS_BOOTSTRAP_STAGE_WSL_INSTALL, &err);
            return Err(err);
        }

        if self.windows_wsl_features_need_enable() {
            let err =
                RuntimeError::CommandFailed(Self::manual_windows_wsl_feature_enable_message());
            self.save_windows_bootstrap_error(WINDOWS_BOOTSTRAP_STAGE_WSL_INSTALL, &err);
            return Err(err);
        }

        if direct_install_guidance {
            let err = RuntimeError::CommandFailed(Self::manual_windows_wsl_install_message());
            self.save_windows_bootstrap_error(WINDOWS_BOOTSTRAP_STAGE_WSL_INSTALL, &err);
            return Err(err);
        }

        let err = RuntimeError::CommandFailed(format!("WSL install failed: {}", direct_summary));
        self.save_windows_bootstrap_error(WINDOWS_BOOTSTRAP_STAGE_WSL_INSTALL, &err);
        Err(err)
    }

    fn ensure_windows_wsl_default_version(&self) -> Result<(), RuntimeError> {
        let output = self.run_wsl(&["--set-default-version", "2"]).map_err(|e| {
            RuntimeError::CommandFailed(format!("Failed to set WSL2 default: {}", e))
        })?;
        if output.status.success() {
            return Ok(());
        }
        Err(RuntimeError::CommandFailed(format!(
            "Failed to set WSL default version to 2: {}",
            Self::command_output_summary(&output)
        )))
    }

    fn ensure_windows_distro_imported(&self, distro: &str) -> Result<(), RuntimeError> {
        if self.windows_distro_registered(distro) {
            return Ok(());
        }

        let location = self.windows_distro_location(distro);
        if location.exists() {
            let _ = std::fs::remove_dir_all(&location);
        }
        std::fs::create_dir_all(
            location
                .parent()
                .unwrap_or_else(|| std::path::Path::new(".")),
        )
        .map_err(|e| {
            RuntimeError::CommandFailed(format!(
                "Failed to prepare runtime directory {}: {}",
                location.display(),
                e
            ))
        })?;

        let artifact = match self.windows_find_distro_artifact(distro) {
            Some(path) => path,
            None => self.windows_download_distro_artifact_to_cache(distro).map_err(|err| {
                RuntimeError::CommandFailed(format!(
                    "Missing bundled WSL rootfs for {} and failed downloading runtime release artifact: {}",
                    distro, err
                ))
            })?,
        };
        self.verify_windows_distro_artifact_hash(distro, &artifact)?;
        debug_log(&format!(
            "verified SHA-256 for {} artifact {}",
            distro,
            artifact.display()
        ));

        let ext = artifact
            .extension()
            .and_then(|v| v.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();

        if ext == "wsl" {
            let install = self
                .wsl_command()
                .arg("--install")
                .arg("--from-file")
                .arg(&artifact)
                .arg("--name")
                .arg(distro)
                .arg("--location")
                .arg(&location)
                .output()
                .map_err(|e| {
                    RuntimeError::CommandFailed(format!(
                        "Failed to import {} from .wsl artifact: {}",
                        distro, e
                    ))
                })?;
            debug_log(&format!(
                "wsl --install --from-file ({}) => code {:?} ({})",
                distro,
                install.status.code(),
                Self::command_output_summary(&install)
            ));
            if install.status.success() && self.windows_distro_registered(distro) {
                return Ok(());
            }
        }

        let import = self
            .wsl_command()
            .arg("--import")
            .arg(distro)
            .arg(&location)
            .arg(&artifact)
            .arg("--version")
            .arg("2")
            .output()
            .map_err(|e| {
                RuntimeError::CommandFailed(format!(
                    "Failed to import {} from {}: {}",
                    distro,
                    artifact.display(),
                    e
                ))
            })?;

        if !import.status.success() {
            return Err(RuntimeError::CommandFailed(format!(
                "Failed to import {} distro: {}",
                distro,
                Self::command_output_summary(&import)
            )));
        }

        if !self.windows_distro_registered(distro) {
            return Err(RuntimeError::CommandFailed(format!(
                "WSL reported successful import for {}, but distro is still unavailable.",
                distro
            )));
        }

        Ok(())
    }

    fn ensure_windows_distro_docker_ready(&self, distro: &str) -> Result<(), RuntimeError> {
        let script = r#"set -eu
docker_bin() {
  if [ -x /usr/bin/docker ]; then
    printf '%s\n' /usr/bin/docker
    return 0
  fi
  command -v docker 2>/dev/null || return 1
}

dockerd_bin() {
  if [ -x /usr/bin/dockerd ]; then
    printf '%s\n' /usr/bin/dockerd
    return 0
  fi
  command -v dockerd 2>/dev/null || return 1
}

docker_local() {
  local docker_path
  docker_path="$(docker_bin)"
  env -u DOCKER_CONTEXT DOCKER_HOST=unix:///var/run/docker.sock "$docker_path" "$@"
}

write_runtime_config() {
  mkdir -p /etc/docker /var/lib/docker /var/run
  cat >/etc/docker/daemon.json <<'JSON'
{
  "features": {
    "buildkit": true
  },
  "hosts": [
    "unix:///var/run/docker.sock"
  ]
}
JSON
  cat >/etc/wsl.conf <<'CONF'
[interop]
enabled=false
appendWindowsPath=false

[network]
generateResolvConf=true
CONF
}

missing_native_docker() {
  echo "Managed WSL rootfs is missing native Docker engine binaries." >&2
  echo "Expected /usr/bin/docker and /usr/bin/dockerd inside the imported distro." >&2
  echo "Republish the Windows WSL rootfs artifact with Docker preinstalled, then retry setup." >&2
  exit 32
}

write_runtime_config

if ! docker_bin >/dev/null 2>&1 || ! dockerd_bin >/dev/null 2>&1; then
  missing_native_docker
fi

if command -v systemctl >/dev/null 2>&1; then
  systemctl enable docker >/dev/null 2>&1 || true
  systemctl start docker >/dev/null 2>&1 || true
fi

if command -v service >/dev/null 2>&1; then
  service docker start >/dev/null 2>&1 || true
fi

if ! docker_local info >/dev/null 2>&1; then
  if dockerd_bin >/dev/null 2>&1; then
    nohup "$(dockerd_bin)" >/var/log/dockerd.log 2>&1 &
    sleep 5
  fi
fi

if ! docker_local info >/dev/null 2>&1; then
  echo "docker info probe failed" >&2
  docker_local info >&2 || true
  if command -v systemctl >/dev/null 2>&1; then
    systemctl status docker --no-pager -l >&2 || true
  fi
  if [ -f /var/log/dockerd.log ]; then
    tail -n 120 /var/log/dockerd.log >&2 || true
  fi
  exit 1
fi
"#;

        let mut output = self
            .wsl_command()
            .arg("--distribution")
            .arg(distro)
            .arg("--user")
            .arg("root")
            .arg("--exec")
            .arg("sh")
            .arg("-lc")
            .arg(script)
            .output()
            .map_err(|e| {
                RuntimeError::CommandFailed(format!(
                    "Failed to initialize Docker in {}: {}",
                    distro, e
                ))
            })?;

        if output.status.success() {
            return Ok(());
        }

        debug_log(&format!(
            "Docker bootstrap in {} failed on first attempt; restarting distro and retrying: {}",
            distro,
            Self::command_output_summary(&output)
        ));
        self.windows_restart_distro(distro)?;
        output = self
            .wsl_command()
            .arg("--distribution")
            .arg(distro)
            .arg("--user")
            .arg("root")
            .arg("--exec")
            .arg("sh")
            .arg("-lc")
            .arg(script)
            .output()
            .map_err(|e| {
                RuntimeError::CommandFailed(format!(
                    "Failed to re-initialize Docker in {} after distro restart: {}",
                    distro, e
                ))
            })?;

        if output.status.success() {
            debug_log(&format!(
                "Docker bootstrap in {} recovered after distro restart",
                distro
            ));
            return Ok(());
        }

        Err(RuntimeError::CommandFailed(format!(
            "Docker engine is not ready in {}: {}",
            distro,
            Self::command_output_summary(&output)
        )))
    }

    fn windows_docker_ready_for_distro(&self, distro: &str) -> bool {
        let output = self
            .wsl_command()
            .arg("--distribution")
            .arg(distro)
            .arg("--user")
            .arg("root")
            .arg("--exec")
            .arg("sh")
            .arg("-lc")
            .arg("env -u DOCKER_CONTEXT DOCKER_HOST=unix:///var/run/docker.sock docker info >/dev/null 2>&1")
            .output();

        match output {
            Ok(out) if out.status.success() => true,
            Ok(out) => {
                debug_log(&format!(
                    "docker info in {} failed: {}",
                    distro,
                    Self::command_output_summary(&out)
                ));
                false
            }
            Err(err) => {
                debug_log(&format!(
                    "docker info probe in {} failed to execute: {}",
                    distro, err
                ));
                false
            }
        }
    }

    fn windows_start_distro(&self, distro: &str) -> Result<(), RuntimeError> {
        let output = self
            .run_wsl(&["-d", distro, "--user", "root", "--exec", "sh", "-lc", "true"])
            .map_err(|e| {
                RuntimeError::CommandFailed(format!("Failed to start {}: {}", distro, e))
            })?;
        if output.status.success() {
            return Ok(());
        }
        Err(RuntimeError::CommandFailed(format!(
            "Failed to start {}: {}",
            distro,
            Self::command_output_summary(&output)
        )))
    }

    fn windows_terminate_distro(&self, distro: &str) -> Result<(), RuntimeError> {
        match self.run_wsl(&["--terminate", distro]) {
            Ok(out) if out.status.success() => Ok(()),
            Ok(out) => {
                let summary = Self::command_output_summary(&out);
                if summary
                    .to_ascii_lowercase()
                    .contains("there is no running instance")
                {
                    Ok(())
                } else {
                    Err(RuntimeError::CommandFailed(format!(
                        "Failed to terminate {}: {}",
                        distro, summary
                    )))
                }
            }
            Err(err) => Err(RuntimeError::CommandFailed(format!(
                "Failed to terminate {}: {}",
                distro, err
            ))),
        }
    }

    fn windows_restart_distro(&self, distro: &str) -> Result<(), RuntimeError> {
        self.windows_terminate_distro(distro)?;
        std::thread::sleep(std::time::Duration::from_secs(1));
        self.windows_start_distro(distro)
    }

    fn windows_unregister_distro(&self, distro: &str) -> Result<(), RuntimeError> {
        match self.run_wsl(&["--unregister", distro]) {
            Ok(out) if out.status.success() => Ok(()),
            Ok(out) => {
                if !self.windows_distro_registered(distro) {
                    return Ok(());
                }
                let summary = Self::command_output_summary(&out);
                let lower = summary.to_ascii_lowercase();
                if lower.contains("there is no distribution with the supplied name")
                    || lower.contains("distribution was not found")
                    || lower.contains("no installed distributions")
                {
                    Ok(())
                } else {
                    Err(RuntimeError::CommandFailed(format!(
                        "Failed to unregister {}: {}",
                        distro, summary
                    )))
                }
            }
            Err(err) => Err(RuntimeError::CommandFailed(format!(
                "Failed to unregister {}: {}",
                distro, err
            ))),
        }
    }

    fn reset_windows_runtime_state(&self) -> Result<(), RuntimeError> {
        debug_log("Resetting Entropic managed Windows runtime state");
        self.clear_windows_bootstrap_state();

        let mut failures: Vec<String> = Vec::new();
        for distro in [ENTROPIC_WSL_DEV_DISTRO, ENTROPIC_WSL_PROD_DISTRO] {
            if !self.windows_distro_registered(distro) {
                continue;
            }

            if let Err(err) = self.windows_terminate_distro(distro) {
                failures.push(err.to_string());
            }
            if let Err(err) = self.windows_unregister_distro(distro) {
                failures.push(err.to_string());
            }
        }

        let runtime_root = self.windows_runtime_root();
        if runtime_root.exists() {
            if let Err(err) = std::fs::remove_dir_all(&runtime_root) {
                failures.push(format!(
                    "Failed to remove Windows runtime root {}: {}",
                    runtime_root.display(),
                    err
                ));
            }
        }

        if let Some(cache_root) = self.windows_runtime_cache_root() {
            if cache_root.exists() {
                if let Err(err) = std::fs::remove_dir_all(&cache_root) {
                    failures.push(format!(
                        "Failed to remove Windows runtime cache {}: {}",
                        cache_root.display(),
                        err
                    ));
                }
            }
        }

        if failures.is_empty() {
            Ok(())
        } else {
            Err(RuntimeError::CommandFailed(failures.join(" | ")))
        }
    }

    fn ensure_windows_runtime_internal(&self, force_windows: bool) -> Result<(), RuntimeError> {
        if !force_windows && !matches!(Platform::detect(), Platform::Windows) {
            return Ok(());
        }
        if !windows_managed_wsl_runtime_enabled() || windows_shared_docker_fallback_allowed() {
            return Ok(());
        }

        let prior_state = self.load_windows_bootstrap_state();
        if let Some(state) = prior_state.as_ref() {
            debug_log(&format!(
                "resuming persisted Windows bootstrap stage={} pending_reboot={} updated_at={}",
                state.stage, state.pending_reboot, state.updated_at_unix
            ));
            if state.pending_reboot && !self.windows_wsl_available() {
                let message = format!(
                    "WSL platform installation is waiting for Windows restart (stage: {}). Restart Windows and reopen Entropic.",
                    state.stage
                );
                self.save_windows_bootstrap_state(&state.stage, true, Some(message.clone()));
                return Err(RuntimeError::CommandFailed(message));
            }
        }

        self.save_windows_bootstrap_state(WINDOWS_BOOTSTRAP_STAGE_PREFLIGHT, false, None);

        self.ensure_windows_wsl_platform().map_err(|err| {
            if self
                .load_windows_bootstrap_state()
                .map(|state| state.pending_reboot)
                .unwrap_or(false)
            {
                return err;
            }
            self.save_windows_bootstrap_error(WINDOWS_BOOTSTRAP_STAGE_WSL_INSTALL, &err);
            err
        })?;

        self.save_windows_bootstrap_state(WINDOWS_BOOTSTRAP_STAGE_WSL_DEFAULT_VERSION, false, None);
        self.ensure_windows_wsl_default_version().map_err(|err| {
            self.save_windows_bootstrap_error(WINDOWS_BOOTSTRAP_STAGE_WSL_DEFAULT_VERSION, &err);
            err
        })?;

        let runtime_root = self.windows_runtime_root();
        std::fs::create_dir_all(runtime_root.join("dev")).map_err(|e| {
            RuntimeError::CommandFailed(format!("Failed to prepare dev runtime root: {}", e))
        })?;
        std::fs::create_dir_all(runtime_root.join("prod")).map_err(|e| {
            RuntimeError::CommandFailed(format!("Failed to prepare prod runtime root: {}", e))
        })?;

        self.save_windows_bootstrap_state(WINDOWS_BOOTSTRAP_STAGE_IMPORT_DEV, false, None);
        self.ensure_windows_distro_imported(ENTROPIC_WSL_DEV_DISTRO)
            .map_err(|err| {
                self.save_windows_bootstrap_error(WINDOWS_BOOTSTRAP_STAGE_IMPORT_DEV, &err);
                err
            })?;
        self.save_windows_bootstrap_state(WINDOWS_BOOTSTRAP_STAGE_IMPORT_PROD, false, None);
        self.ensure_windows_distro_imported(ENTROPIC_WSL_PROD_DISTRO)
            .map_err(|err| {
                self.save_windows_bootstrap_error(WINDOWS_BOOTSTRAP_STAGE_IMPORT_PROD, &err);
                err
            })?;

        let active = windows_active_distro_name();
        let docker_stage = if active == ENTROPIC_WSL_DEV_DISTRO {
            WINDOWS_BOOTSTRAP_STAGE_DOCKER_DEV
        } else {
            WINDOWS_BOOTSTRAP_STAGE_DOCKER_PROD
        };
        self.save_windows_bootstrap_state(docker_stage, false, None);
        self.ensure_windows_distro_docker_ready(active)
            .map_err(|err| {
                self.save_windows_bootstrap_error(docker_stage, &err);
                err
            })?;

        if !self.windows_docker_ready_for_distro(active) {
            let err = RuntimeError::CommandFailed(format!(
                "Docker daemon is still not reachable inside {} after bootstrap.",
                active
            ));
            self.save_windows_bootstrap_error(docker_stage, &err);
            return Err(err);
        }

        self.save_windows_bootstrap_state(WINDOWS_BOOTSTRAP_STAGE_READY, false, None);
        self.clear_windows_bootstrap_state();
        Ok(())
    }

    pub fn ensure_windows_runtime(&self) -> Result<(), RuntimeError> {
        self.ensure_windows_runtime_internal(false)
    }

    #[cfg(test)]
    fn ensure_windows_runtime_for_tests(&self) -> Result<(), RuntimeError> {
        self.ensure_windows_runtime_internal(true)
    }

    fn stop_windows_runtime(&self) -> Result<(), RuntimeError> {
        let mut failures: Vec<String> = Vec::new();
        for distro in [ENTROPIC_WSL_DEV_DISTRO, ENTROPIC_WSL_PROD_DISTRO] {
            if !self.windows_distro_registered(distro) {
                continue;
            }
            match self.run_wsl(&["--terminate", distro]) {
                Ok(out) if out.status.success() => {}
                Ok(out) => {
                    let summary = Self::command_output_summary(&out);
                    let lower = summary.to_ascii_lowercase();
                    if !lower.contains("there is no running instance") {
                        failures.push(format!("{}: {}", distro, summary));
                    }
                }
                Err(err) => failures.push(format!("{}: {}", distro, err)),
            }
        }

        if failures.is_empty() {
            Ok(())
        } else {
            Err(RuntimeError::CommandFailed(failures.join(" | ")))
        }
    }

    pub fn check_status(&self) -> RuntimeStatus {
        let platform = Platform::detect();
        debug_log(&format!(
            "=== check_status() called, platform: {:?} ===",
            platform
        ));
        match platform {
            Platform::MacOS => self.check_status_macos(),
            Platform::Linux => self.check_status_linux(),
            Platform::Windows => self.check_status_windows(),
        }
    }

    fn check_status_linux(&self) -> RuntimeStatus {
        // On Linux, Docker runs natively - no VM needed
        let docker_installed = self.docker_path().is_some();
        let docker_ready = if docker_installed {
            self.is_docker_ready_native()
        } else {
            false
        };

        RuntimeStatus {
            colima_installed: false, // Not used on Linux
            docker_installed,
            vm_running: true, // No VM needed on Linux
            docker_ready,
        }
    }

    fn check_status_macos(&self) -> RuntimeStatus {
        debug_log("=== check_status_macos() called ===");

        let colima_path = self.colima_path();
        debug_log(&format!("colima_path: {:?}", colima_path));
        let colima_installed = colima_path.exists();
        debug_log(&format!("colima_installed: {}", colima_installed));

        // Check whether any Docker CLI is available (bundled or system).
        let system_docker = which::which("docker").is_ok();
        debug_log(&format!("system_docker available: {}", system_docker));

        let docker_path = self.docker_path();
        debug_log(&format!("docker_path: {:?}", docker_path));
        let docker_installed = docker_path.is_some() || system_docker;
        debug_log(&format!("docker_installed: {}", docker_installed));

        // Check Entropic-managed Colima sockets first.
        // We skip relying only on `colima status` because it can fail with version mismatches.
        let colima_socket_exists = self.preferred_colima_socket().is_some();
        debug_log(&format!("Colima socket exists: {}", colima_socket_exists));

        let socket_exists = macos_docker_socket_candidates()
            .iter()
            .any(|socket| socket.exists());
        debug_log(&format!("Any socket exists: {}", socket_exists));

        // If socket exists, try Docker directly - that's the real test
        let (vm_running, docker_ready) = if docker_installed && socket_exists {
            debug_log("Socket exists, checking Docker connectivity...");
            let ready = self.is_docker_ready_colima();
            debug_log(&format!("docker_ready: {}", ready));
            // If Docker is ready, VM must be running
            (ready, ready)
        } else if colima_installed && !socket_exists {
            // Socket doesn't exist, check colima status as fallback
            debug_log("Socket doesn't exist, checking colima status...");
            let running = self.is_colima_running();
            debug_log(&format!("colima status says running: {}", running));
            (running, false)
        } else {
            debug_log("Colima not installed or Docker not installed");
            (false, false)
        };

        let status = RuntimeStatus {
            colima_installed,
            docker_installed,
            vm_running,
            docker_ready,
        };
        debug_log(&format!("Final status: {:?}", status));
        status
    }

    fn check_status_windows(&self) -> RuntimeStatus {
        if windows_managed_wsl_runtime_enabled() && !windows_shared_docker_fallback_allowed() {
            let wsl_available = self.windows_wsl_available();
            let active_distro = windows_active_distro_name();
            let distro_ready = wsl_available && self.windows_distro_registered(active_distro);
            let docker_ready = distro_ready && self.windows_docker_ready_for_distro(active_distro);

            return RuntimeStatus {
                colima_installed: wsl_available,
                docker_installed: distro_ready,
                vm_running: distro_ready,
                docker_ready,
            };
        }

        // Fallback path: use native Docker Desktop state.
        let docker_installed = self.docker_path().is_some();
        let docker_ready = if docker_installed {
            self.is_docker_ready_native()
        } else {
            false
        };

        RuntimeStatus {
            colima_installed: false,
            docker_installed,
            vm_running: docker_ready,
            docker_ready,
        }
    }

    fn is_colima_running(&self) -> bool {
        debug_log("=== is_colima_running() called ===");
        for (profile, _) in self.colima_profiles() {
            debug_log(&format!("Checking status for profile {}", profile));
            match self.run_colima(profile, &["status", "--json"]) {
                Ok(out) => {
                    let stdout = String::from_utf8_lossy(&out.stdout);
                    let stderr = String::from_utf8_lossy(&out.stderr);
                    debug_log(&format!("colima status stdout ({}): {}", profile, stdout));
                    debug_log(&format!("colima status stderr ({}): {}", profile, stderr));
                    debug_log(&format!(
                        "colima status exit code ({}): {:?}",
                        profile,
                        out.status.code()
                    ));
                    let running = stdout.contains("\"status\":\"Running\"");
                    if running {
                        return true;
                    }
                }
                Err(e) => {
                    debug_log(&format!("colima status error ({}): {}", profile, e));
                }
            }
        }

        false
    }

    /// Check Docker on Linux/Windows (native daemon)
    fn is_docker_ready_native(&self) -> bool {
        let docker = match self.docker_path() {
            Some(p) => p,
            None => return false,
        };
        debug_log(&format!("Linux docker path: {:?}", docker));

        // If DOCKER_HOST is set, try it first.
        if let Ok(host) = std::env::var("DOCKER_HOST") {
            if !host.trim().is_empty() {
                debug_log(&format!("Trying DOCKER_HOST={}", host));
                let mut cmd = Command::new(&docker);
                apply_windows_no_window(&mut cmd);
                let output = cmd.args(["info"]).env("DOCKER_HOST", host).output();
                match output {
                    Ok(out) if out.status.success() => {
                        debug_log("Docker info succeeded with DOCKER_HOST");
                        return true;
                    }
                    Ok(out) => {
                        debug_log(&format!(
                            "Docker info failed with DOCKER_HOST: {}",
                            String::from_utf8_lossy(&out.stderr)
                        ));
                    }
                    Err(err) => {
                        debug_log(&format!("Docker info error with DOCKER_HOST: {}", err));
                    }
                }
            }
        }

        // Try common socket locations (rootless + desktop).
        let mut candidates: Vec<PathBuf> = Vec::new();
        if let Ok(runtime_dir) = std::env::var("XDG_RUNTIME_DIR") {
            debug_log(&format!("XDG_RUNTIME_DIR={}", runtime_dir));
            candidates.push(PathBuf::from(runtime_dir).join("docker.sock"));
        } else {
            debug_log("XDG_RUNTIME_DIR not set");
        }
        if let Some(home) = dirs::home_dir() {
            candidates.push(home.join(".docker/desktop/docker.sock"));
            candidates.push(home.join(".docker/run/docker.sock"));
        }
        candidates.push(PathBuf::from("/var/run/docker.sock"));

        for socket in candidates {
            if !socket.exists() {
                debug_log(&format!("Socket missing: {:?}", socket));
                continue;
            }
            let host = format!("unix://{}", socket.display());
            debug_log(&format!("Trying socket: {}", host));
            let mut cmd = Command::new(&docker);
            apply_windows_no_window(&mut cmd);
            let output = cmd.args(["info"]).env("DOCKER_HOST", host).output();
            match output {
                Ok(out) if out.status.success() => {
                    debug_log("Docker info succeeded with socket");
                    return true;
                }
                Ok(out) => {
                    debug_log(&format!(
                        "Docker info failed with socket: {}",
                        String::from_utf8_lossy(&out.stderr)
                    ));
                }
                Err(err) => {
                    debug_log(&format!("Docker info error with socket: {}", err));
                }
            }
        }

        // Fall back to default docker context.
        debug_log("Trying default docker info");
        let mut cmd = Command::new(&docker);
        apply_windows_no_window(&mut cmd);
        let output = cmd.args(["info"]).output();
        match output {
            Ok(out) if out.status.success() => {
                debug_log("Docker info succeeded (default)");
                true
            }
            Ok(out) => {
                debug_log(&format!(
                    "Docker info failed (default): {}",
                    String::from_utf8_lossy(&out.stderr)
                ));
                false
            }
            Err(err) => {
                debug_log(&format!("Docker info error (default): {}", err));
                false
            }
        }
    }

    /// Check Docker on macOS (via Entropic-managed Colima socket by default).
    fn is_docker_ready_colima(&self) -> bool {
        debug_log("=== is_docker_ready_colima() called ===");
        let docker = self
            .docker_path()
            .unwrap_or_else(|| std::path::PathBuf::from("docker"));
        debug_log(&format!("Docker path: {:?}", docker));
        debug_log(&format!("Docker exists: {}", docker.exists()));

        let socket_candidates = macos_docker_socket_candidates();

        for socket_path in socket_candidates {
            if self.is_docker_ready_on_socket(&socket_path) {
                return true;
            }
        }

        false
    }

    fn docker_socket_colima(&self) -> String {
        if let Some(socket) = self.preferred_colima_socket() {
            return format!("unix://{}", socket.display());
        }

        format!(
            "unix://{}",
            self.colima_socket_for_profile(ENTROPIC_VZ_PROFILE)
                .display()
        )
    }

    /// Get the bin directory containing our bundled binaries
    fn bin_dir(&self) -> PathBuf {
        self.resources_dir.join("resources").join("bin")
    }

    /// Get the share directory containing Lima templates
    fn share_dir(&self) -> PathBuf {
        self.resources_dir.join("resources").join("share")
    }

    /// Ensure bundled binaries are executable (Tauri bundle may lose +x)
    fn ensure_executable(&self) -> Result<(), RuntimeError> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            for binary in ["colima", "limactl", "lima", "docker"] {
                let path = self.bin_dir().join(binary);
                if path.exists() {
                    if let Ok(metadata) = std::fs::metadata(&path) {
                        let mut perms = metadata.permissions();
                        // Set executable bit (0o755)
                        perms.set_mode(0o755);
                        let _ = std::fs::set_permissions(&path, perms);
                    }
                }
            }
        }
        Ok(())
    }

    fn secure_colima_home_permissions(&self, path: &std::path::Path) -> Result<(), RuntimeError> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let metadata = std::fs::metadata(path).map_err(|e| {
                RuntimeError::ColimaStartFailed(format!(
                    "Failed to read Colima home metadata at {}: {}",
                    path.display(),
                    e
                ))
            })?;
            let mut perms = metadata.permissions();
            perms.set_mode(0o700);
            std::fs::set_permissions(path, perms).map_err(|e| {
                RuntimeError::ColimaStartFailed(format!(
                    "Failed to secure Colima home permissions at {}: {}",
                    path.display(),
                    e
                ))
            })?;
        }

        #[cfg(not(unix))]
        {
            let _ = path;
        }

        Ok(())
    }

    fn try_prepare_private_dir(&self, path: &std::path::Path, label: &str) {
        if let Err(e) = std::fs::create_dir_all(path) {
            debug_log(&format!(
                "Failed to create runtime {} at {}: {}",
                label,
                path.display(),
                e
            ));
            return;
        }

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            match std::fs::metadata(path) {
                Ok(metadata) => {
                    let mut perms = metadata.permissions();
                    perms.set_mode(0o700);
                    if let Err(e) = std::fs::set_permissions(path, perms) {
                        debug_log(&format!(
                            "Failed to set permissions for runtime {} at {}: {}",
                            label,
                            path.display(),
                            e
                        ));
                    }
                }
                Err(e) => {
                    debug_log(&format!(
                        "Failed to read metadata for runtime {} at {}: {}",
                        label,
                        path.display(),
                        e
                    ));
                }
            }
        }
    }

    /// Create a command with environment set up for bundled binaries
    fn bundled_command(&self, program: &std::path::Path) -> Command {
        let mut cmd = Command::new(program);

        let bin_dir = self.bin_dir();
        let share_dir = self.share_dir();
        let runtime_home = self.runtime_home();
        let runtime_tmp = self.runtime_tmp_dir();
        let xdg_config_home = runtime_home.join(".config");
        let xdg_cache_home = runtime_home.join(".cache");

        self.try_prepare_private_dir(&runtime_home, "home");
        self.try_prepare_private_dir(&runtime_tmp, "temp dir");
        self.try_prepare_private_dir(&xdg_config_home, "config dir");
        self.try_prepare_private_dir(&xdg_cache_home, "cache dir");

        // Force a whitespace-safe working directory for bundled commands.
        // Some nested shell invocations in Lima/Colima can be sensitive to cwd.
        cmd.current_dir(&runtime_home);

        // Add our bin directory to PATH so colima can find limactl
        if let Ok(current_path) = std::env::var("PATH") {
            cmd.env("PATH", format!("{}:{}", bin_dir.display(), current_path));
        } else {
            cmd.env("PATH", bin_dir.display().to_string());
        }
        cmd.env("HOME", runtime_home.display().to_string());
        cmd.env("PWD", runtime_home.display().to_string());
        cmd.env("TMPDIR", runtime_tmp.display().to_string());
        cmd.env("XDG_CONFIG_HOME", xdg_config_home.display().to_string());
        cmd.env("XDG_CACHE_HOME", xdg_cache_home.display().to_string());

        // Tell Lima where to find its share directory (templates, etc.)
        // Lima looks for templates at $LIMA_SHARE_DIR or relative to the binary
        cmd.env(
            "LIMA_SHARE_DIR",
            share_dir.join("lima").display().to_string(),
        );

        cmd
    }

    fn start_colima_internal(&self, allow_auto_reset: bool) -> Result<(), RuntimeError> {
        debug_log("=== start_colima() called ===");

        let colima_path = self.colima_path();
        debug_log(&format!("colima_path: {:?}", colima_path));
        debug_log(&format!("colima_path exists: {}", colima_path.exists()));

        if !colima_path.exists() {
            debug_log("ERROR: Colima not found");
            return Err(RuntimeError::ColimaNotFound);
        }

        // Ensure binaries are executable
        debug_log("Ensuring binaries are executable...");
        self.ensure_executable()?;

        let colima_home = self.colima_home();
        if let Err(e) = std::fs::create_dir_all(&colima_home) {
            return Err(RuntimeError::ColimaStartFailed(format!(
                "Failed to initialize isolated Colima home at {}: {}",
                colima_home.display(),
                e
            )));
        }
        self.secure_colima_home_permissions(&colima_home)?;

        debug_log(&format!("colima_home: {:?}", colima_home));

        // List bin directory contents
        if let Ok(entries) = std::fs::read_dir(self.bin_dir()) {
            debug_log("bin_dir contents:");
            for entry in entries.flatten() {
                debug_log(&format!("  {:?}", entry.path()));
            }
        }

        let mut last_error: Option<String> = None;
        let mut last_failed_profile: Option<&'static str> = None;
        let mut fell_back_from_vz = false;

        for (profile, vm_type) in self.colima_profiles() {
            debug_log(&format!(
                "Starting Colima profile {} with vm-type {}",
                profile, vm_type
            ));
            match self.start_colima_profile(profile, vm_type) {
                Ok(()) => return Ok(()),
                Err(e) => {
                    let msg = e.to_string();
                    last_error = Some(msg.clone());
                    last_failed_profile = Some(profile);
                    debug_log(&format!(
                        "Colima start failed for profile {}: {}",
                        profile, msg
                    ));
                    if vm_type == "vz" {
                        if self.is_vz_guest_agent_error(&msg) {
                            debug_log(
                                "VZ failed with guest-agent/degraded signal; attempting in-place repair ladder",
                            );
                            match self.try_repair_vz_profile(profile) {
                                Ok(()) => return Ok(()),
                                Err(repair_err) => {
                                    let repair_msg = repair_err.to_string();
                                    debug_log(&format!("VZ repair ladder failed: {}", repair_msg));
                                    last_error = Some(format!(
                                        "{}\n\nVZ repair attempt failed: {}",
                                        msg, repair_msg
                                    ));
                                    fell_back_from_vz = true;
                                    debug_log(
                                        "Falling back to qemu profile after VZ repair failure",
                                    );
                                    continue;
                                }
                            }
                        }
                        if self.is_vz_unavailable_error(&msg) {
                            fell_back_from_vz = true;
                            debug_log("VZ unavailable, falling back to qemu profile");
                            continue;
                        }
                    }
                    break;
                }
            }
        }

        let mut reason = last_error.unwrap_or_else(|| "Failed to start Colima".to_string());
        if Self::is_whitespace_path_error(&reason) {
            let home_hint = dirs::home_dir()
                .map(|p| format!("\"{}\"", p.display()))
                .unwrap_or_else(|| "\"(unknown)\"".to_string());
            return Err(RuntimeError::ColimaStartFailed(format!(
                "{}\n\nEntropic's container runtime (lima) does not support macOS usernames that contain spaces. Your home directory {} causes internal path handling to fail.\n\nWorkaround: create a new macOS administrator account with a username that has no spaces, then run Entropic from that account.",
                reason, home_hint
            )));
        }

        let mut auto_reset_attempted = false;
        if allow_auto_reset && self.should_auto_reset_isolated_runtime(&reason) {
            auto_reset_attempted = true;
            debug_log(
                "Detected Colima state likely recoverable via isolated runtime reset; attempting one-time auto-reset",
            );
            match self.reset_isolated_colima_runtime() {
                Ok(()) => {
                    debug_log("Auto-reset succeeded; retrying Colima startup once");
                    return self.start_colima_internal(false);
                }
                Err(e) => {
                    reason = format!(
                        "{}\n\nEntropic attempted an automatic isolated runtime reset, but it failed: {}",
                        reason, e
                    );
                }
            }
        }

        let heading = if fell_back_from_vz && last_failed_profile == Some(ENTROPIC_QEMU_PROFILE) {
            "VZ was unavailable and qemu startup failed. To reset Entropic's isolated runtime:"
        } else if auto_reset_attempted {
            "Entropic attempted an automatic isolated runtime reset. If this keeps happening, run a manual reset for Entropic's isolated runtime:"
        } else {
            "If this keeps happening, run a manual reset for Entropic's isolated runtime:"
        };
        let profile_to_reset = last_failed_profile.unwrap_or(ENTROPIC_VZ_PROFILE);
        let reset_commands = self
            .manual_reset_commands(&colima_path, &[profile_to_reset])
            .join("\n");

        Err(RuntimeError::ColimaStartFailed(format!(
            "{}\n\n{}\n{}",
            reason, heading, reset_commands
        )))
    }

    pub fn start_colima(&self) -> Result<(), RuntimeError> {
        match Platform::detect() {
            Platform::Windows => self.ensure_windows_runtime(),
            _ => self.start_colima_internal(true),
        }
    }

    pub fn stop_colima(&self) -> Result<(), RuntimeError> {
        if matches!(Platform::detect(), Platform::Windows) {
            return self.stop_windows_runtime();
        }

        let mut failures: Vec<String> = Vec::new();

        for (profile, _) in self.colima_profiles() {
            match self.run_colima(profile, &["stop", "--force"]) {
                Ok(output) => {
                    if !output.status.success() {
                        let stderr = String::from_utf8_lossy(&output.stderr);
                        let stderr_lc = stderr.to_lowercase();
                        // Ignore "not running" errors when shutting down.
                        if !stderr_lc.contains("not running") {
                            failures.push(format!("{}: {}", profile, stderr.trim()));
                        }
                    }
                }
                Err(e) => failures.push(format!("{}: {}", profile, e)),
            }
        }

        if !failures.is_empty() {
            return Err(RuntimeError::ColimaStopFailed(failures.join(" | ")));
        }

        Ok(())
    }

    pub fn docker_socket_path(&self) -> String {
        match Platform::detect() {
            Platform::MacOS => self.docker_socket_colima(),
            Platform::Linux => {
                if let Ok(runtime_dir) = std::env::var("XDG_RUNTIME_DIR") {
                    let socket = PathBuf::from(runtime_dir).join("docker.sock");
                    if socket.exists() {
                        return format!("unix://{}", socket.display());
                    }
                }
                if let Some(home) = dirs::home_dir() {
                    let desktop = home.join(".docker/desktop/docker.sock");
                    if desktop.exists() {
                        return format!("unix://{}", desktop.display());
                    }
                    let run_socket = home.join(".docker/run/docker.sock");
                    if run_socket.exists() {
                        return format!("unix://{}", run_socket.display());
                    }
                }
                "unix:///var/run/docker.sock".to_string()
            }
            Platform::Windows => "npipe:////./pipe/docker_engine".to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::collections::HashMap;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::{Mutex, OnceLock};
    use std::time::{SystemTime, UNIX_EPOCH};

    static TEST_ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

    fn env_lock() -> &'static Mutex<()> {
        TEST_ENV_LOCK.get_or_init(|| Mutex::new(()))
    }

    fn unique_test_dir(label: &str) -> PathBuf {
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        std::env::temp_dir().join(format!(
            "entropic-windows-bootstrap-test-{}-{}-{}",
            label,
            std::process::id(),
            ts
        ))
    }

    fn write_executable(path: &Path, contents: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("failed to create executable parent dir");
        }
        fs::write(path, contents).expect("failed to write executable file");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = fs::metadata(path)
                .expect("failed to stat executable")
                .permissions();
            perms.set_mode(0o755);
            fs::set_permissions(path, perms).expect("failed to chmod executable");
        }
    }

    fn fake_wsl_script() -> &'static str {
        r#"#!/bin/sh
set -eu

STATE_FILE="${ENTROPIC_TEST_WSL_STATE_FILE:-}"
if [ -z "$STATE_FILE" ]; then
  echo "missing ENTROPIC_TEST_WSL_STATE_FILE" >&2
  exit 98
fi

installed=0
reboot_pending=0
distros=""
feature_wsl=Disabled
feature_vmp=Disabled
if [ -f "$STATE_FILE" ]; then
  # shellcheck disable=SC1090
  . "$STATE_FILE"
fi

save_state() {
  mkdir -p "$(dirname "$STATE_FILE")"
  {
    echo "installed=$installed"
    echo "reboot_pending=$reboot_pending"
    echo "distros=\"$distros\""
    echo "feature_wsl=$feature_wsl"
    echo "feature_vmp=$feature_vmp"
  } > "$STATE_FILE"
}

has_distro() {
  case ",$distros," in
    *,"$1",*) return 0 ;;
    *) return 1 ;;
  esac
}

add_distro() {
  if has_distro "$1"; then
    return 0
  fi
  if [ -z "$distros" ]; then
    distros="$1"
  else
    distros="$distros,$1"
  fi
}

if [ "$#" -ge 1 ] && { [ "$1" = "--version" ] || [ "$1" = "--status" ]; }; then
  if [ "${ENTROPIC_TEST_WSL_LEGACY_CLI:-0}" = "1" ]; then
    echo "Invalid command line option: $1" >&2
    exit 1
  fi
  if [ "$installed" = "1" ] && [ "$reboot_pending" = "0" ]; then
    echo "WSL version 2.1.0"
    exit 0
  fi
  echo "WSL not ready" >&2
  exit 1
fi

if [ "$#" -ge 2 ] && [ "$1" = "--install" ] && [ "$2" = "--no-distribution" ]; then
  if [ "${ENTROPIC_TEST_WSL_LEGACY_CLI:-0}" = "1" ]; then
    echo "Invalid command line option: --install" >&2
    exit 1
  fi
  installed=1
  if [ "${ENTROPIC_TEST_WSL_INSTALL_REBOOT:-0}" = "1" ]; then
    reboot_pending=1
    feature_wsl=EnablePending
    feature_vmp=EnablePending
    save_state
    if [ -n "${ENTROPIC_TEST_WSL_INSTALL_REBOOT_MESSAGE:-}" ]; then
      echo "$ENTROPIC_TEST_WSL_INSTALL_REBOOT_MESSAGE"
    else
      echo "Restart required to complete installation"
    fi
    exit 0
  fi
  reboot_pending=0
  feature_wsl=Enabled
  feature_vmp=Enabled
  save_state
  echo "Installed WSL"
  exit 0
fi

if [ "$#" -ge 2 ] && [ "$1" = "--set-default-version" ] && [ "$2" = "2" ]; then
  if [ "$installed" = "1" ] && [ "$reboot_pending" = "0" ]; then
    exit 0
  fi
  echo "WSL not available" >&2
  exit 1
fi

if [ "$#" -ge 2 ] && [ "$1" = "--list" ] && [ "$2" = "--quiet" ]; then
  if [ "$installed" != "1" ] || [ "$reboot_pending" != "0" ]; then
    echo "WSL not available" >&2
    exit 1
  fi
  OLDIFS=$IFS
  IFS=','
  for entry in $distros; do
    if [ -n "$entry" ]; then
      echo "$entry"
    fi
  done
  IFS=$OLDIFS
  exit 0
fi

if [ "$#" -ge 2 ] && [ "$1" = "-l" ] && [ "$2" = "-q" ]; then
  if [ "$installed" != "1" ] || [ "$reboot_pending" != "0" ]; then
    echo "WSL not available" >&2
    exit 1
  fi
  OLDIFS=$IFS
  IFS=','
  for entry in $distros; do
    if [ -n "$entry" ]; then
      echo "$entry"
    fi
  done
  IFS=$OLDIFS
  exit 0
fi

if [ "$#" -ge 1 ] && [ "$1" = "--install" ]; then
  if [ "${ENTROPIC_TEST_WSL_LEGACY_CLI:-0}" = "1" ]; then
    echo "Invalid command line option: --install" >&2
    exit 1
  fi
  name=""
  location=""
  shift
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --name)
        name="${2:-}"
        shift 2
        ;;
      --location)
        location="${2:-}"
        shift 2
        ;;
      *)
        shift
        ;;
    esac
  done
  if [ -z "$name" ]; then
    echo "missing distro name" >&2
    exit 1
  fi
  add_distro "$name"
  if [ -n "$location" ]; then
    mkdir -p "$location"
  fi
  save_state
  exit 0
fi

if [ "$#" -ge 1 ] && [ "$1" = "--import" ]; then
  name="${2:-}"
  location="${3:-}"
  if [ -z "$name" ]; then
    echo "missing distro name" >&2
    exit 1
  fi
  add_distro "$name"
  if [ -n "$location" ]; then
    mkdir -p "$location"
  fi
  save_state
  exit 0
fi

if [ "$#" -ge 1 ] && [ "$1" = "--distribution" ]; then
  distro="${2:-}"
  if ! has_distro "$distro"; then
    echo "distro not found: $distro" >&2
    exit 1
  fi
  if [ "${ENTROPIC_TEST_WSL_DOCKER_FAIL:-0}" = "1" ]; then
    echo "docker failed" >&2
    exit 1
  fi
  exit 0
fi

if [ "$#" -ge 1 ] && [ "$1" = "-d" ]; then
  distro="${2:-}"
  if ! has_distro "$distro"; then
    echo "distro not found: $distro" >&2
    exit 1
  fi
  exit 0
fi

if [ "$#" -ge 1 ] && [ "$1" = "--terminate" ]; then
  exit 0
fi

if [ "$#" -ge 1 ] && [ "$1" = "--unregister" ]; then
  name="${2:-}"
  if ! has_distro "$name"; then
    echo "There is no distribution with the supplied name." >&2
    exit 1
  fi
  OLDIFS=$IFS
  IFS=','
  next_distros=""
  for entry in $distros; do
    [ "$entry" = "$name" ] && continue
    if [ -z "$next_distros" ]; then
      next_distros="$entry"
    else
      next_distros="$next_distros,$entry"
    fi
  done
  IFS=$OLDIFS
  distros="$next_distros"
  save_state
  exit 0
fi

echo "unsupported fake wsl args: $*" >&2
exit 1
"#
    }

    fn fake_wsl_windows_script() -> &'static str {
        r#"$ErrorActionPreference = "Stop"

$stateFile = $env:ENTROPIC_TEST_WSL_STATE_FILE
if ([string]::IsNullOrWhiteSpace($stateFile)) {
  Write-Error "missing ENTROPIC_TEST_WSL_STATE_FILE"
  exit 98
}

$installed = 0
$reboot_pending = 0
$distros = @()
$feature_wsl = "Disabled"
$feature_vmp = "Disabled"

if (Test-Path $stateFile) {
  foreach ($line in Get-Content $stateFile) {
    if ($line -match '^installed=(\d+)$') {
      $installed = [int]$Matches[1]
    } elseif ($line -match '^reboot_pending=(\d+)$') {
      $reboot_pending = [int]$Matches[1]
    } elseif ($line -match '^distros="(.*)"$') {
      $value = $Matches[1]
      if (-not [string]::IsNullOrWhiteSpace($value)) {
        $distros = @($value.Split(',', [System.StringSplitOptions]::RemoveEmptyEntries))
      }
    } elseif ($line -match '^feature_wsl=(.+)$') {
      $feature_wsl = $Matches[1]
    } elseif ($line -match '^feature_vmp=(.+)$') {
      $feature_vmp = $Matches[1]
    }
  }
}

function Save-State {
  $parent = Split-Path -Parent $stateFile
  if (-not [string]::IsNullOrWhiteSpace($parent)) {
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
  }
  @(
    "installed=$installed"
    "reboot_pending=$reboot_pending"
    ('distros="' + ($distros -join ',') + '"')
    "feature_wsl=$feature_wsl"
    "feature_vmp=$feature_vmp"
  ) | Set-Content -Path $stateFile -Encoding ascii
}

function Has-Distro([string]$Name) {
  return $distros -contains $Name
}

function Add-Distro([string]$Name) {
  if (-not (Has-Distro $Name)) {
    $script:distros += $Name
  }
}

if ($args.Count -ge 1 -and ($args[0] -eq "--version" -or $args[0] -eq "--status")) {
  if ($env:ENTROPIC_TEST_WSL_LEGACY_CLI -eq "1") {
    Write-Error ("Invalid command line option: " + $args[0])
    exit 1
  }
  if ($installed -eq 1 -and $reboot_pending -eq 0) {
    Write-Output "WSL version 2.1.0"
    exit 0
  }
  Write-Error "WSL not ready"
  exit 1
}

if ($args.Count -ge 2 -and $args[0] -eq "--install" -and $args[1] -eq "--no-distribution") {
  if ($env:ENTROPIC_TEST_WSL_LEGACY_CLI -eq "1") {
    Write-Error "Invalid command line option: --install"
    exit 1
  }
  $installed = 1
  if ($env:ENTROPIC_TEST_WSL_INSTALL_REBOOT -eq "1") {
    $reboot_pending = 1
    $feature_wsl = "EnablePending"
    $feature_vmp = "EnablePending"
    Save-State
    if (-not [string]::IsNullOrWhiteSpace($env:ENTROPIC_TEST_WSL_INSTALL_REBOOT_MESSAGE)) {
      Write-Output $env:ENTROPIC_TEST_WSL_INSTALL_REBOOT_MESSAGE
    } else {
      Write-Output "Restart required to complete installation"
    }
    exit 0
  }
  $reboot_pending = 0
  $feature_wsl = "Enabled"
  $feature_vmp = "Enabled"
  Save-State
  Write-Output "Installed WSL"
  exit 0
}

if ($args.Count -ge 2 -and $args[0] -eq "--set-default-version" -and $args[1] -eq "2") {
  if ($installed -eq 1 -and $reboot_pending -eq 0) {
    exit 0
  }
  Write-Error "WSL not available"
  exit 1
}

if ($args.Count -ge 2 -and $args[0] -eq "--list" -and $args[1] -eq "--quiet") {
  if ($installed -ne 1 -or $reboot_pending -ne 0) {
    Write-Error "WSL not available"
    exit 1
  }
  foreach ($entry in $distros) {
    if (-not [string]::IsNullOrWhiteSpace($entry)) {
      Write-Output $entry
    }
  }
  exit 0
}

if ($args.Count -ge 2 -and $args[0] -eq "-l" -and $args[1] -eq "-q") {
  if ($installed -ne 1 -or $reboot_pending -ne 0) {
    Write-Error "WSL not available"
    exit 1
  }
  foreach ($entry in $distros) {
    if (-not [string]::IsNullOrWhiteSpace($entry)) {
      Write-Output $entry
    }
  }
  exit 0
}

if ($args.Count -ge 1 -and $args[0] -eq "--install") {
  if ($env:ENTROPIC_TEST_WSL_LEGACY_CLI -eq "1") {
    Write-Error "Invalid command line option: --install"
    exit 1
  }
  $name = ""
  $location = ""
  for ($i = 1; $i -lt $args.Count; $i++) {
    switch ($args[$i]) {
      "--name" {
        if ($i + 1 -lt $args.Count) {
          $name = $args[$i + 1]
          $i++
        }
      }
      "--location" {
        if ($i + 1 -lt $args.Count) {
          $location = $args[$i + 1]
          $i++
        }
      }
    }
  }
  if ([string]::IsNullOrWhiteSpace($name)) {
    Write-Error "missing distro name"
    exit 1
  }
  Add-Distro $name
  if (-not [string]::IsNullOrWhiteSpace($location)) {
    New-Item -ItemType Directory -Force -Path $location | Out-Null
  }
  Save-State
  exit 0
}

if ($args.Count -ge 1 -and $args[0] -eq "--import") {
  $name = if ($args.Count -ge 2) { $args[1] } else { "" }
  $location = if ($args.Count -ge 3) { $args[2] } else { "" }
  if ([string]::IsNullOrWhiteSpace($name)) {
    Write-Error "missing distro name"
    exit 1
  }
  Add-Distro $name
  if (-not [string]::IsNullOrWhiteSpace($location)) {
    New-Item -ItemType Directory -Force -Path $location | Out-Null
  }
  Save-State
  exit 0
}

if ($args.Count -ge 1 -and $args[0] -eq "--distribution") {
  $distro = if ($args.Count -ge 2) { $args[1] } else { "" }
  if (-not (Has-Distro $distro)) {
    Write-Error "distro not found: $distro"
    exit 1
  }
  if ($env:ENTROPIC_TEST_WSL_DOCKER_FAIL -eq "1") {
    Write-Error "docker failed"
    exit 1
  }
  exit 0
}

if ($args.Count -ge 1 -and $args[0] -eq "-d") {
  $distro = if ($args.Count -ge 2) { $args[1] } else { "" }
  if (-not (Has-Distro $distro)) {
    Write-Error "distro not found: $distro"
    exit 1
  }
  exit 0
}

if ($args.Count -ge 1 -and $args[0] -eq "--terminate") {
  exit 0
}

if ($args.Count -ge 1 -and $args[0] -eq "--unregister") {
  $name = if ($args.Count -ge 2) { $args[1] } else { "" }
  if (-not (Has-Distro $name)) {
    Write-Error "There is no distribution with the supplied name."
    exit 1
  }
  $script:distros = @($distros | Where-Object { $_ -ne $name })
  Save-State
  exit 0
}

Write-Error ("unsupported fake wsl args: " + ($args -join " "))
exit 1
"#
    }

    fn sha256_hex(bytes: &[u8]) -> String {
        let mut hasher = Sha256::new();
        hasher.update(bytes);
        format!("{:x}", hasher.finalize())
    }

    struct EnvGuard {
        previous: HashMap<String, Option<String>>,
    }

    impl EnvGuard {
        fn new(keys: &[&str]) -> Self {
            let mut previous = HashMap::new();
            for key in keys {
                previous.insert((*key).to_string(), std::env::var(key).ok());
            }
            Self { previous }
        }

        fn set<K: AsRef<str>, V: AsRef<str>>(&self, key: K, value: V) {
            std::env::set_var(key.as_ref(), value.as_ref());
        }

        fn remove<K: AsRef<str>>(&self, key: K) {
            std::env::remove_var(key.as_ref());
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            for (key, value) in self.previous.iter() {
                if let Some(v) = value {
                    std::env::set_var(key, v);
                } else {
                    std::env::remove_var(key);
                }
            }
        }
    }

    struct WindowsBootstrapFixture {
        root_dir: PathBuf,
        home_dir: PathBuf,
        local_app_data: PathBuf,
        wsl_state_file: PathBuf,
        bootstrap_state_file: PathBuf,
        runtime: Runtime,
        _env_guard: EnvGuard,
    }

    impl Drop for WindowsBootstrapFixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root_dir);
        }
    }

    impl WindowsBootstrapFixture {
        fn new(label: &str, install_requires_reboot: bool) -> Self {
            let root_dir = unique_test_dir(label);
            let fake_bin_dir = root_dir.join("fake-bin");
            let home_dir = root_dir.join("home");
            let local_app_data = root_dir.join("localappdata");
            let resources_root = root_dir.join("resources-root");
            let runtime_resources = resources_root.join("resources").join("runtime");
            fs::create_dir_all(&fake_bin_dir).expect("failed to create fake bin dir");
            fs::create_dir_all(&home_dir).expect("failed to create fake home dir");
            fs::create_dir_all(&runtime_resources).expect("failed to create runtime resources");

            let dev_artifact = runtime_resources.join("entropic-runtime-dev.wsl");
            let prod_artifact = runtime_resources.join("entropic-runtime-prod.wsl");
            let dev_contents = b"dev-artifact-bytes";
            let prod_contents = b"prod-artifact-bytes";
            fs::write(&dev_artifact, dev_contents).expect("failed to write dev artifact");
            fs::write(&prod_artifact, prod_contents).expect("failed to write prod artifact");

            let fake_wsl = if cfg!(windows) {
                let fake_script = fake_bin_dir.join("fake-wsl.ps1");
                fs::write(&fake_script, fake_wsl_windows_script())
                    .expect("failed to write fake wsl powershell script");
                fake_script
            } else {
                let fake_binary = fake_bin_dir.join("wsl.exe");
                write_executable(&fake_binary, fake_wsl_script());
                fake_binary
            };
            let wsl_state_file = root_dir.join("fake-wsl-state.env");
            fs::write(
                &wsl_state_file,
                "installed=0\nreboot_pending=0\ndistros=\"\"\nfeature_wsl=Disabled\nfeature_vmp=Disabled\n",
            )
            .expect("failed to seed fake wsl state");

            let env_guard = EnvGuard::new(&[
                "PATH",
                "ENTROPIC_TEST_HOME_DIR",
                "HOME",
                "LOCALAPPDATA",
                "USERPROFILE",
                "ENTROPIC_WINDOWS_MANAGED_WSL",
                "ENTROPIC_RUNTIME_ALLOW_SHARED_DOCKER",
                "ENTROPIC_RUNTIME_MODE",
                "ENTROPIC_WSL_DEV_DISTRO_SHA256",
                "ENTROPIC_WSL_PROD_DISTRO_SHA256",
                "ENTROPIC_WSL_DISTRO_SHA256",
                "ENTROPIC_WSL_EXE",
                "ENTROPIC_WSL_POWERSHELL_SCRIPT",
                "ENTROPIC_TEST_WSL_STATE_FILE",
                "ENTROPIC_TEST_WSL_INSTALL_REBOOT",
                "ENTROPIC_TEST_WSL_INSTALL_REBOOT_MESSAGE",
                "ENTROPIC_TEST_WSL_DOCKER_FAIL",
                "ENTROPIC_TEST_WSL_LEGACY_CLI",
            ]);

            let path_sep = if cfg!(windows) { ";" } else { ":" };
            let previous_path = std::env::var("PATH").unwrap_or_default();
            let merged_path = if previous_path.trim().is_empty() {
                fake_bin_dir.display().to_string()
            } else {
                format!("{}{}{}", fake_bin_dir.display(), path_sep, previous_path)
            };
            env_guard.set("PATH", merged_path);
            env_guard.set("ENTROPIC_TEST_HOME_DIR", home_dir.display().to_string());
            env_guard.set("HOME", home_dir.display().to_string());
            env_guard.set("USERPROFILE", home_dir.display().to_string());
            if cfg!(windows) {
                env_guard.set("ENTROPIC_WSL_POWERSHELL_SCRIPT", fake_wsl.display().to_string());
                env_guard.remove("ENTROPIC_WSL_EXE");
            } else {
                env_guard.set("ENTROPIC_WSL_EXE", fake_wsl.display().to_string());
                env_guard.remove("ENTROPIC_WSL_POWERSHELL_SCRIPT");
            }
            env_guard.set("LOCALAPPDATA", local_app_data.display().to_string());
            env_guard.set("ENTROPIC_WINDOWS_MANAGED_WSL", "1");
            env_guard.set("ENTROPIC_RUNTIME_ALLOW_SHARED_DOCKER", "0");
            env_guard.set("ENTROPIC_RUNTIME_MODE", "dev");
            env_guard.set(
                "ENTROPIC_TEST_WSL_STATE_FILE",
                wsl_state_file.display().to_string(),
            );
            env_guard.set(
                "ENTROPIC_TEST_WSL_INSTALL_REBOOT",
                if install_requires_reboot { "1" } else { "0" },
            );
            env_guard.remove("ENTROPIC_TEST_WSL_INSTALL_REBOOT_MESSAGE");
            env_guard.remove("ENTROPIC_TEST_WSL_DOCKER_FAIL");
            env_guard.remove("ENTROPIC_TEST_WSL_LEGACY_CLI");
            env_guard.set("ENTROPIC_WSL_DEV_DISTRO_SHA256", sha256_hex(dev_contents));
            env_guard.set("ENTROPIC_WSL_PROD_DISTRO_SHA256", sha256_hex(prod_contents));
            env_guard.remove("ENTROPIC_WSL_DISTRO_SHA256");

            let bootstrap_state_file = local_app_data
                .join("Entropic")
                .join("runtime")
                .join(WINDOWS_BOOTSTRAP_STATE_FILE);
            let runtime = Runtime::new(resources_root.clone(), RuntimeVmConfig::default());

            Self {
                root_dir,
                home_dir,
                local_app_data,
                wsl_state_file,
                bootstrap_state_file,
                runtime,
                _env_guard: env_guard,
            }
        }

        fn read_wsl_state(&self) -> String {
            fs::read_to_string(&self.wsl_state_file).unwrap_or_default()
        }

        fn read_bootstrap_state(&self) -> WindowsBootstrapState {
            let raw = fs::read_to_string(&self.bootstrap_state_file)
                .expect("bootstrap state file should exist");
            serde_json::from_str(&raw).expect("bootstrap state should be valid json")
        }

        fn mark_reboot_complete(&self) {
            let raw = self.read_wsl_state();
            let updated = raw
                .replace("reboot_pending=1", "reboot_pending=0")
                .replace("feature_wsl=EnablePending", "feature_wsl=Enabled")
                .replace("feature_vmp=EnablePending", "feature_vmp=Enabled");
            fs::write(&self.wsl_state_file, updated).expect("failed to update fake wsl state");
        }

        fn runtime_cache_dir(&self) -> PathBuf {
            self.home_dir.join(".entropic").join("cache")
        }
    }

    #[test]
    fn windows_bootstrap_clean_machine_flow_succeeds() {
        let _guard = env_lock().lock().expect("env lock poisoned");
        let fixture = WindowsBootstrapFixture::new("clean-machine", false);

        fixture
            .runtime
            .ensure_windows_runtime_for_tests()
            .expect("bootstrap should succeed");

        assert!(
            !fixture.bootstrap_state_file.exists(),
            "bootstrap-state.json should be cleared after successful setup"
        );
        let wsl_state = fixture.read_wsl_state();
        assert!(
            wsl_state.contains("entropic-dev"),
            "dev distro should be imported"
        );
        assert!(
            wsl_state.contains("entropic-prod"),
            "prod distro should be imported"
        );
        assert!(
            fixture
                .local_app_data
                .join("Entropic")
                .join("runtime")
                .join("dev")
                .exists(),
            "managed runtime dev root should exist"
        );
        assert!(
            fixture
                .local_app_data
                .join("Entropic")
                .join("runtime")
                .join("prod")
                .exists(),
            "managed runtime prod root should exist"
        );
    }

    #[test]
    fn windows_bootstrap_reboot_resume_flow_persists_and_recovers() {
        let _guard = env_lock().lock().expect("env lock poisoned");
        let fixture = WindowsBootstrapFixture::new("reboot-resume", true);
        std::env::set_var(
            "ENTROPIC_TEST_WSL_INSTALL_REBOOT_MESSAGE",
            "Redemarrage requis pour terminer l installation",
        );

        let first_err = fixture
            .runtime
            .ensure_windows_runtime_for_tests()
            .expect_err("first bootstrap should require reboot");
        let first_err_text = first_err.to_string();
        assert!(
            first_err_text.contains("Restart Windows"),
            "expected reboot-required error, got: {}",
            first_err_text
        );
        assert!(
            fixture.bootstrap_state_file.exists(),
            "bootstrap state should persist across reboot-required boundary"
        );
        let state = fixture.read_bootstrap_state();
        assert!(
            state.pending_reboot,
            "bootstrap state should record pending_reboot=true"
        );
        assert_eq!(state.stage, WINDOWS_BOOTSTRAP_STAGE_WSL_INSTALL);

        fixture.mark_reboot_complete();
        std::env::set_var("ENTROPIC_TEST_WSL_INSTALL_REBOOT", "0");
        std::env::remove_var("ENTROPIC_TEST_WSL_INSTALL_REBOOT_MESSAGE");

        fixture
            .runtime
            .ensure_windows_runtime_for_tests()
            .expect("bootstrap should resume successfully after reboot");
        assert!(
            !fixture.bootstrap_state_file.exists(),
            "bootstrap-state.json should be cleared once resumed flow completes"
        );
        let wsl_state = fixture.read_wsl_state();
        assert!(
            wsl_state.contains("entropic-dev"),
            "dev distro should be present after resumed setup"
        );
        assert!(
            wsl_state.contains("entropic-prod"),
            "prod distro should be present after resumed setup"
        );
    }

    #[test]
    fn windows_bootstrap_legacy_wsl_cli_already_available_succeeds() {
        let _guard = env_lock().lock().expect("env lock poisoned");
        let fixture = WindowsBootstrapFixture::new("legacy-cli-available", false);
        std::env::set_var("ENTROPIC_TEST_WSL_LEGACY_CLI", "1");
        fs::write(
            &fixture.wsl_state_file,
            "installed=1\nreboot_pending=0\ndistros=\"\"\nfeature_wsl=Enabled\nfeature_vmp=Enabled\n",
        )
        .expect("failed to seed fake wsl state");

        fixture
            .runtime
            .ensure_windows_runtime_for_tests()
            .expect("bootstrap should succeed with legacy WSL CLI");

        assert!(
            !fixture.bootstrap_state_file.exists(),
            "bootstrap-state.json should be cleared after successful setup"
        );
        let wsl_state = fixture.read_wsl_state();
        assert!(
            wsl_state.contains("entropic-dev"),
            "dev distro should be imported"
        );
        assert!(
            wsl_state.contains("entropic-prod"),
            "prod distro should be imported"
        );
    }

    #[test]
    fn windows_manual_install_guidance_detection_handles_localized_output() {
        let sample = "Le Sous-syst�me Windows pour Linux n est pas install�. Vous pouvez effectuer l installation en ex�cutant \"wsl.exe --install\".\nPour plus d informations, visitez https://aka.ms/wslinstall";
        assert!(
            Runtime::output_contains_manual_wsl_install_guidance(sample),
            "expected localized install guidance to be detected"
        );
    }

    #[test]
    fn windows_bootstrap_legacy_wsl_cli_without_platform_surfaces_upgrade_guidance() {
        let _guard = env_lock().lock().expect("env lock poisoned");
        let fixture = WindowsBootstrapFixture::new("legacy-cli-missing", false);
        std::env::set_var("ENTROPIC_TEST_WSL_LEGACY_CLI", "1");

        let err = fixture
            .runtime
            .ensure_windows_runtime_for_tests()
            .expect_err("legacy WSL CLI without platform should fail");

        assert!(
            err.to_string()
                .contains("installed WSL command is too old for Entropic's automatic setup"),
            "expected legacy-WSL guidance, got: {}",
            err
        );
        let state = fixture.read_bootstrap_state();
        assert_eq!(state.stage, WINDOWS_BOOTSTRAP_STAGE_WSL_INSTALL);
        assert!(
            state.error
                .unwrap_or_default()
                .contains("installed WSL command is too old"),
            "bootstrap state should persist the legacy-WSL guidance"
        );
    }

    #[test]
    fn windows_bootstrap_rejects_mismatched_artifact_hash() {
        let _guard = env_lock().lock().expect("env lock poisoned");
        let fixture = WindowsBootstrapFixture::new("hash-mismatch", false);
        std::env::set_var(
            "ENTROPIC_WSL_DEV_DISTRO_SHA256",
            "0000000000000000000000000000000000000000000000000000000000000000",
        );

        let err = fixture
            .runtime
            .ensure_windows_runtime_for_tests()
            .expect_err("bootstrap should fail when artifact hash mismatches");
        let text = err.to_string();
        assert!(
            text.contains("hash mismatch"),
            "expected hash mismatch error, got: {}",
            text
        );
        let state = fixture.read_bootstrap_state();
        assert_eq!(state.stage, WINDOWS_BOOTSTRAP_STAGE_IMPORT_DEV);
        assert!(
            !state.pending_reboot,
            "hash mismatch should fail closed without pending reboot state"
        );
    }

    #[test]
    fn windows_bootstrap_surfaces_docker_bootstrap_failure() {
        let _guard = env_lock().lock().expect("env lock poisoned");
        let fixture = WindowsBootstrapFixture::new("docker-failure", false);
        std::env::set_var("ENTROPIC_TEST_WSL_DOCKER_FAIL", "1");

        let err = fixture
            .runtime
            .ensure_windows_runtime_for_tests()
            .expect_err("bootstrap should fail when docker bootstrap fails");
        let text = err.to_string();
        assert!(
            text.contains("Docker engine is not ready"),
            "expected docker bootstrap error, got: {}",
            text
        );

        let state = fixture.read_bootstrap_state();
        assert_eq!(state.stage, WINDOWS_BOOTSTRAP_STAGE_DOCKER_DEV);
        assert!(
            !state.pending_reboot,
            "docker bootstrap failures should not masquerade as reboot-required"
        );
    }

    #[test]
    fn windows_runtime_reset_unregisters_managed_distros() {
        let _guard = env_lock().lock().expect("env lock poisoned");
        let fixture = WindowsBootstrapFixture::new("windows-reset", false);
        let cache_dir = fixture.runtime_cache_dir();
        fs::create_dir_all(&cache_dir).expect("failed to create fake runtime cache");
        fs::write(cache_dir.join("runtime-manifest.json"), "{}")
            .expect("failed to seed fake runtime manifest cache");
        fs::write(cache_dir.join("openclaw-runtime.tar.gz"), "stale-runtime")
            .expect("failed to seed fake runtime tar cache");

        fixture
            .runtime
            .ensure_windows_runtime_for_tests()
            .expect("bootstrap should succeed before reset");
        assert!(
            fixture.read_wsl_state().contains("entropic-prod"),
            "expected prod distro to exist before reset"
        );

        fixture
            .runtime
            .reset_isolated_runtime_state()
            .expect("reset should succeed");

        let wsl_state = fixture.read_wsl_state();
        assert!(
            !wsl_state.contains("entropic-dev"),
            "dev distro should be removed by reset"
        );
        assert!(
            !wsl_state.contains("entropic-prod"),
            "prod distro should be removed by reset"
        );
        assert!(
            !fixture.local_app_data.join("Entropic").join("runtime").exists(),
            "managed runtime root should be removed by reset"
        );
        assert!(
            !fixture.runtime_cache_dir().exists(),
            "runtime cache should be removed by reset"
        );
    }
}
