use std::path::PathBuf;
use std::process::Command;
use thiserror::Error;

/// Global debug logger for runtime diagnostics
fn debug_log(msg: &str) {
    use std::io::Write;
    let log_path = dirs::home_dir()
        .map(|h| h.join("zara-runtime.log"))
        .unwrap_or_else(|| std::path::PathBuf::from("/tmp/zara-runtime.log"));

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
        self.resources_dir.join("resources").join("bin").join("colima")
    }

    fn limactl_path(&self) -> PathBuf {
        self.resources_dir.join("resources").join("bin").join("limactl")
    }

    fn bundled_docker_path(&self) -> PathBuf {
        self.resources_dir.join("resources").join("bin").join("docker")
    }

    /// Find docker - prefer bundled, fall back to system
    fn docker_path(&self) -> Option<PathBuf> {
        let bundled = self.bundled_docker_path();
        if bundled.exists() {
            return Some(bundled);
        }
        // Check system docker
        which::which("docker").ok()
    }

    pub fn check_status(&self) -> RuntimeStatus {
        let platform = Platform::detect();
        debug_log(&format!("=== check_status() called, platform: {:?} ===", platform));
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

        let docker_path = self.docker_path();
        debug_log(&format!("docker_path: {:?}", docker_path));
        let docker_installed = docker_path.is_some();
        debug_log(&format!("docker_installed: {}", docker_installed));

        // Check if Docker socket exists - this is the real test of whether Colima/Docker is running
        // We skip `colima status` because it can fail with version mismatches
        let socket_path = dirs::home_dir()
            .map(|h| h.join(".colima").join("default").join("docker.sock"))
            .unwrap_or_default();
        debug_log(&format!("Checking socket at: {:?}", socket_path));
        let socket_exists = socket_path.exists();
        debug_log(&format!("Socket exists: {}", socket_exists));

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
        let bin_dir = self.bin_dir();
        let colima_path = self.colima_path();

        debug_log(&format!("bin_dir: {:?}", bin_dir));
        debug_log(&format!("bin_dir exists: {}", bin_dir.exists()));

        let shell_cmd = format!(
            "export PATH=\"{}:$PATH\" && \"{}\" status --json",
            bin_dir.display(),
            colima_path.display()
        );
        debug_log(&format!("shell_cmd: {}", shell_cmd));

        let output = Command::new("/bin/sh")
            .args(["-c", &shell_cmd])
            .output();

        match output {
            Ok(out) => {
                let stdout = String::from_utf8_lossy(&out.stdout);
                let stderr = String::from_utf8_lossy(&out.stderr);
                debug_log(&format!("colima status stdout: {}", stdout));
                debug_log(&format!("colima status stderr: {}", stderr));
                debug_log(&format!("colima status exit code: {:?}", out.status.code()));
                let running = stdout.contains("\"status\":\"Running\"");
                debug_log(&format!("contains Running: {}", running));
                running
            }
            Err(e) => {
                debug_log(&format!("colima status error: {}", e));
                false
            }
        }
    }

    /// Check Docker on Linux/Windows (native daemon)
    fn is_docker_ready_native(&self) -> bool {
        let docker = match self.docker_path() {
            Some(p) => p,
            None => return false,
        };

        let output = Command::new(&docker)
            .args(["info"])
            .output();

        match output {
            Ok(out) => out.status.success(),
            Err(_) => false,
        }
    }

    /// Check Docker on macOS (via Colima socket)
    fn is_docker_ready_colima(&self) -> bool {
        debug_log("=== is_docker_ready_colima() called ===");

        // First check if the socket exists
        let home = match dirs::home_dir() {
            Some(h) => {
                debug_log(&format!("Home dir: {:?}", h));
                h
            }
            None => {
                debug_log("ERROR: No home dir");
                return false;
            }
        };
        let socket_path = home.join(".colima").join("default").join("docker.sock");
        debug_log(&format!("Socket path: {:?}", socket_path));
        debug_log(&format!("Socket exists: {}", socket_path.exists()));

        if !socket_path.exists() {
            debug_log("ERROR: Socket does not exist");
            return false;
        }

        // Try bundled docker first, fall back to system docker
        let docker = self.docker_path().unwrap_or_else(|| std::path::PathBuf::from("docker"));
        debug_log(&format!("Docker path: {:?}", docker));
        debug_log(&format!("Docker exists: {}", docker.exists()));

        // Ensure binaries are executable
        let _ = self.ensure_executable();

        let docker_host = format!("unix://{}", socket_path.display());
        debug_log(&format!("DOCKER_HOST: {}", docker_host));

        // Run docker info to verify connection
        debug_log("Running docker info...");
        let output = Command::new(&docker)
            .args(["info"])
            .env("DOCKER_HOST", &docker_host)
            .output();

        match output {
            Ok(out) => {
                let success = out.status.success();
                debug_log(&format!("Docker info exit code: {:?}", out.status.code()));
                debug_log(&format!("Docker info success: {}", success));
                if !success {
                    debug_log(&format!("stderr: {}", String::from_utf8_lossy(&out.stderr)));
                    debug_log(&format!("stdout: {}", String::from_utf8_lossy(&out.stdout)));
                }
                success
            }
            Err(e) => {
                debug_log(&format!("Docker command error: {}", e));
                // Try with shell wrapper as fallback
                let shell_cmd = format!(
                    "DOCKER_HOST='{}' '{}' info >/dev/null 2>&1",
                    docker_host,
                    docker.display()
                );
                debug_log(&format!("Trying shell fallback: {}", shell_cmd));
                let result = Command::new("/bin/sh")
                    .args(["-c", &shell_cmd])
                    .status()
                    .map(|s| s.success())
                    .unwrap_or(false);
                debug_log(&format!("Shell fallback result: {}", result));
                result
            }
        }
    }

    fn docker_socket_colima(&self) -> String {
        let home = dirs::home_dir().unwrap_or_default();
        format!("unix://{}/.colima/default/docker.sock", home.display())
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
        cmd.env("LIMA_SHARE_DIR", share_dir.join("lima").display().to_string());

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

        let bin_dir = self.bin_dir();
        let share_dir = self.share_dir();

        debug_log(&format!("bin_dir: {:?}", bin_dir));
        debug_log(&format!("share_dir: {:?}", share_dir));

        // List bin directory contents
        if let Ok(entries) = std::fs::read_dir(&bin_dir) {
            debug_log("bin_dir contents:");
            for entry in entries.flatten() {
                debug_log(&format!("  {:?}", entry.path()));
            }
        }

        // Build a shell command that sets up environment before running colima
        // This ensures PATH is set BEFORE colima does its dependency check
        // VZ (Virtualization.framework) is used for better performance on macOS 13+
        // The app requires com.apple.security.virtualization entitlement (see entitlements.plist)
        let shell_cmd = format!(
            "export PATH=\"{}:$PATH\" && export LIMA_SHARE_DIR=\"{}\" && \"{}\" start --vm-type vz --cpu 2 --memory 4 --disk 20",
            bin_dir.display(),
            share_dir.join("lima").display(),
            colima_path.display()
        );
        debug_log(&format!("shell_cmd: {}", shell_cmd));

        // Run through shell to ensure environment is set before colima starts
        debug_log("Executing colima start...");
        let output = Command::new("/bin/sh")
            .args(["-c", &shell_cmd])
            .output()
            .map_err(|e| {
                debug_log(&format!("Command execution error: {}", e));
                RuntimeError::ColimaStartFailed(e.to_string())
            })?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        debug_log(&format!("colima start exit code: {:?}", output.status.code()));
        debug_log(&format!("colima start stdout: {}", stdout));
        debug_log(&format!("colima start stderr: {}", stderr));

        if !output.status.success() {
            debug_log("ERROR: Colima start failed");
            return Err(RuntimeError::ColimaStartFailed(format!(
                "{}\n{}",
                stderr.trim(),
                stdout.trim()
            )));
        }

        debug_log("Colima started successfully");
        Ok(())
    }

    pub fn stop_colima(&self) -> Result<(), RuntimeError> {
        let bin_dir = self.bin_dir();
        let colima_path = self.colima_path();

        let shell_cmd = format!(
            "export PATH=\"{}:$PATH\" && \"{}\" stop",
            bin_dir.display(),
            colima_path.display()
        );

        let output = Command::new("/bin/sh")
            .args(["-c", &shell_cmd])
            .output()
            .map_err(|e| RuntimeError::ColimaStopFailed(e.to_string()))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(RuntimeError::ColimaStopFailed(stderr.to_string()));
        }

        Ok(())
    }

    pub fn docker_socket_path(&self) -> String {
        match Platform::detect() {
            Platform::MacOS => self.docker_socket_colima(),
            Platform::Linux => "unix:///var/run/docker.sock".to_string(),
            Platform::Windows => "npipe:////./pipe/docker_engine".to_string(),
        }
    }
}
