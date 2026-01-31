use std::path::PathBuf;
use std::process::Command;
use thiserror::Error;

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
        Self {
            resources_dir,
            platform: Platform::detect(),
        }
    }

    fn colima_path(&self) -> PathBuf {
        self.resources_dir.join("bin").join("colima")
    }

    fn bundled_docker_path(&self) -> PathBuf {
        self.resources_dir.join("bin").join("docker")
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
        match Platform::detect() {
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
        let colima_installed = self.colima_path().exists();
        let docker_installed = self.docker_path().is_some();

        let vm_running = if colima_installed {
            self.is_colima_running()
        } else {
            false
        };

        let docker_ready = if docker_installed && vm_running {
            self.is_docker_ready_colima()
        } else {
            false
        };

        RuntimeStatus {
            colima_installed,
            docker_installed,
            vm_running,
            docker_ready,
        }
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
        let output = Command::new(&self.colima_path())
            .args(["status", "--json"])
            .output();

        match output {
            Ok(out) => {
                let stdout = String::from_utf8_lossy(&out.stdout);
                stdout.contains("\"status\":\"Running\"")
            }
            Err(_) => false,
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
        let docker = match self.docker_path() {
            Some(p) => p,
            None => return false,
        };

        let output = Command::new(&docker)
            .args(["info"])
            .env("DOCKER_HOST", self.docker_socket_colima())
            .output();

        match output {
            Ok(out) => out.status.success(),
            Err(_) => false,
        }
    }

    fn docker_socket_colima(&self) -> String {
        let home = dirs::home_dir().unwrap_or_default();
        format!("unix://{}/.colima/default/docker.sock", home.display())
    }

    pub fn start_colima(&self) -> Result<(), RuntimeError> {
        if !self.colima_path().exists() {
            return Err(RuntimeError::ColimaNotFound);
        }

        // Start Colima with optimized settings for Apple Silicon
        let output = Command::new(&self.colima_path())
            .args([
                "start",
                "--arch", "aarch64",
                "--vm-type", "vz",           // Use Virtualization.framework
                "--mount-type", "virtiofs",  // Fast file sharing
                "--cpu", "2",
                "--memory", "4",
                "--disk", "20",
            ])
            .output()
            .map_err(|e| RuntimeError::ColimaStartFailed(e.to_string()))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(RuntimeError::ColimaStartFailed(stderr.to_string()));
        }

        Ok(())
    }

    pub fn stop_colima(&self) -> Result<(), RuntimeError> {
        let output = Command::new(&self.colima_path())
            .args(["stop"])
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
