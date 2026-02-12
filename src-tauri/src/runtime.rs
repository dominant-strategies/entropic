use std::path::PathBuf;
use std::process::Command;
use thiserror::Error;

/// Global debug logger for runtime diagnostics
fn debug_log(msg: &str) {
    use std::io::Write;
    let log_path = dirs::home_dir()
        .map(|h| h.join("nova-runtime.log"))
        .unwrap_or_else(|| std::path::PathBuf::from("/tmp/nova-runtime.log"));

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

pub struct Runtime {
    resources_dir: PathBuf,
    #[allow(dead_code)]
    platform: Platform,
}

/// Isolated Colima home directory used by Nova to avoid conflicts with
/// any user-managed global Colima configuration under `~/.colima`.
pub(crate) const NOVA_COLIMA_HOME_DIR: &str = ".nova/colima";
/// Colima profile name used for Apple Virtualization.framework (`vz`) backend.
pub(crate) const NOVA_VZ_PROFILE: &str = "nova-vz";
/// Colima profile name used for QEMU backend fallback.
pub(crate) const NOVA_QEMU_PROFILE: &str = "nova-qemu";
const COLIMA_RETRY_DELAY_SECS: u64 = 2;

fn fallback_colima_home_path() -> PathBuf {
    let base = std::env::temp_dir();

    #[cfg(unix)]
    {
        // SAFETY: geteuid has no preconditions and does not dereference pointers.
        let uid = unsafe { libc::geteuid() };
        return base.join(format!("nova-colima-{}", uid));
    }

    #[cfg(not(unix))]
    {
        base.join("nova-colima")
    }
}

pub(crate) fn nova_colima_home_path() -> PathBuf {
    if let Ok(home) = std::env::var("NOVA_COLIMA_HOME") {
        if !home.trim().is_empty() {
            return PathBuf::from(home);
        }
    }

    dirs::home_dir()
        .map(|h| h.join(NOVA_COLIMA_HOME_DIR))
        .unwrap_or_else(fallback_colima_home_path)
}

pub(crate) fn nova_colima_socket_candidates() -> Vec<PathBuf> {
    let home = nova_colima_home_path();
    vec![
        home.join(NOVA_VZ_PROFILE).join("docker.sock"),
        home.join(NOVA_QEMU_PROFILE).join("docker.sock"),
    ]
}

pub(crate) fn macos_docker_socket_candidates() -> Vec<PathBuf> {
    let mut candidates = nova_colima_socket_candidates();
    if let Some(home) = dirs::home_dir() {
        candidates.push(home.join(".docker/run/docker.sock"));
        candidates.push(home.join(".docker/desktop/docker.sock"));
    }
    candidates.push(PathBuf::from("/var/run/docker.sock"));
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
    pub fn new(resources_dir: PathBuf) -> Self {
        debug_log("=== Runtime::new() called ===");
        debug_log(&format!("resources_dir: {:?}", resources_dir));
        debug_log(&format!("resources_dir exists: {}", resources_dir.exists()));
        let platform = Platform::detect();
        debug_log(&format!("Platform detected: {:?}", platform));
        Self {
            resources_dir,
            platform,
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
        nova_colima_home_path()
    }

    fn colima_profiles(&self) -> [(&'static str, &'static str); 2] {
        [(NOVA_VZ_PROFILE, "vz"), (NOVA_QEMU_PROFILE, "qemu")]
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
        for (profile, socket) in self.colima_profile_socket_candidates() {
            debug_log(&format!(
                "Checking socket for profile {} at {:?}",
                profile, socket
            ));
            if socket.exists() {
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

    fn is_vz_unavailable_error(&self, output: &str) -> bool {
        let combined = output.to_lowercase();
        combined.contains("virtualization.framework")
            || combined.contains("vm type vz")
            || combined.contains("vm-type vz")
            || combined.contains("vz is not supported")
            || combined.contains("failed to validate vm type")
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
        let colima_path_str = Self::shell_escape_arg(&colima_path.to_string_lossy());
        profiles
            .iter()
            .map(|profile| {
                let profile_str = Self::shell_escape_arg(profile);
                format!(
                    "COLIMA_HOME={} {} --profile {} delete --force",
                    colima_home_str, colima_path_str, profile_str
                )
            })
            .collect()
    }

    fn is_docker_ready_on_socket(&self, socket_path: &std::path::Path) -> bool {
        if !socket_path.exists() {
            debug_log(&format!("Socket missing for readiness check: {:?}", socket_path));
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
                .run_colima(
                    profile,
                    &[
                        "start",
                        "--vm-type",
                        vm_type,
                        "--cpu",
                        "2",
                        "--memory",
                        "4",
                        "--disk",
                        "20",
                    ],
                )
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
                debug_log("Colima started successfully");
                return Ok(());
            }

            // Colima may exit non-zero in DEGRADED state (guest agent not running)
            // while Docker is still usable via forwarded sockets.
            let is_degraded = stderr.contains("DEGRADED")
                || stderr.contains("degraded")
                || stdout.contains("DEGRADED")
                || stdout.contains("degraded");
            if is_degraded {
                debug_log("Colima reported DEGRADED state, checking Docker usability...");
                std::thread::sleep(std::time::Duration::from_secs(2));
                let profile_socket = self.colima_socket_for_profile(profile);
                if self.is_docker_ready_on_socket(&profile_socket) {
                    debug_log("Docker is functional despite DEGRADED state — treating as success");
                    return Ok(());
                }
                debug_log("Docker not ready despite DEGRADED state — treating as failure");
            }

            if attempt == 1 {
                debug_log("First attempt failed, trying non-destructive recovery via stop --force");
                match self.run_colima(profile, &["stop", "--force"]) {
                    Ok(stop_output) => {
                        debug_log(&format!(
                            "colima stop --force exit code: {:?}",
                            stop_output.status.code()
                        ));
                        debug_log(&format!(
                            "colima stop --force stderr: {}",
                            String::from_utf8_lossy(&stop_output.stderr)
                        ));
                    }
                    Err(e) => {
                        debug_log(&format!("colima stop --force failed: {}", e));
                    }
                }
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

        // In development mode, also check for system Docker (Docker Desktop)
        let system_docker = which::which("docker").is_ok();
        debug_log(&format!("system_docker available: {}", system_docker));

        let docker_path = self.docker_path();
        debug_log(&format!("docker_path: {:?}", docker_path));
        let docker_installed = docker_path.is_some() || system_docker;
        debug_log(&format!("docker_installed: {}", docker_installed));

        // Check Nova-managed Colima sockets first.
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
        // Windows uses Docker Desktop or WSL2
        let docker_installed = self.docker_path().is_some();
        let docker_ready = if docker_installed {
            self.is_docker_ready_native()
        } else {
            false
        };

        RuntimeStatus {
            colima_installed: false,
            docker_installed,
            vm_running: docker_ready, // Assume VM is running if Docker works
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
                let output = Command::new(&docker)
                    .args(["info"])
                    .env("DOCKER_HOST", host)
                    .output();
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
            let output = Command::new(&docker)
                .args(["info"])
                .env("DOCKER_HOST", host)
                .output();
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
        let output = Command::new(&docker).args(["info"]).output();
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

    /// Check Docker on macOS (via Colima or Docker Desktop socket)
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

        if std::path::Path::new("/var/run/docker.sock").exists() {
            return "unix:///var/run/docker.sock".to_string();
        }

        format!(
            "unix://{}",
            self.colima_socket_for_profile(NOVA_VZ_PROFILE).display()
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
        Ok(())
    }

    /// Create a command with environment set up for bundled binaries
    fn bundled_command(&self, program: &std::path::Path) -> Command {
        let mut cmd = Command::new(program);

        let bin_dir = self.bin_dir();
        let share_dir = self.share_dir();

        // Add our bin directory to PATH so colima can find limactl
        if let Ok(current_path) = std::env::var("PATH") {
            cmd.env("PATH", format!("{}:{}", bin_dir.display(), current_path));
        } else {
            cmd.env("PATH", bin_dir.display().to_string());
        }

        // Tell Lima where to find its share directory (templates, etc.)
        // Lima looks for templates at $LIMA_SHARE_DIR or relative to the binary
        cmd.env(
            "LIMA_SHARE_DIR",
            share_dir.join("lima").display().to_string(),
        );

        cmd
    }

    pub fn start_colima(&self) -> Result<(), RuntimeError> {
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

        let reason = last_error.unwrap_or_else(|| "Failed to start Colima".to_string());
        let heading = if fell_back_from_vz && last_failed_profile == Some(NOVA_QEMU_PROFILE) {
            "VZ was unavailable and qemu startup failed. To reset Nova's isolated runtime:"
        } else {
            "If this keeps happening, run a manual reset for Nova's isolated runtime:"
        };
        let profile_to_reset = last_failed_profile.unwrap_or(NOVA_VZ_PROFILE);
        let reset_commands = self
            .manual_reset_commands(&colima_path, &[profile_to_reset])
            .join("\n");

        Err(RuntimeError::ColimaStartFailed(format!(
            "{}\n\n{}\n{}",
            reason, heading, reset_commands
        )))
    }

    pub fn stop_colima(&self) -> Result<(), RuntimeError> {
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
