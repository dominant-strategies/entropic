use crate::operational;
use crate::runtime::{Platform, Runtime, RuntimeStatus};
use tauri::{AppHandle, Manager};

pub struct RuntimeSupervisor {
    app: AppHandle,
}

impl RuntimeSupervisor {
    pub fn new(app: &AppHandle) -> Self {
        Self { app: app.clone() }
    }

    fn runtime(&self) -> Runtime {
        let resource_dir = self.app.path().resource_dir().unwrap_or_default();
        Runtime::new(resource_dir)
    }

    pub fn check_status(&self) -> RuntimeStatus {
        self.runtime().check_status()
    }

    pub fn start(&self) -> Result<(), String> {
        operational::record_incident(
            &self.app,
            "info",
            "runtime",
            "start_requested",
            "Starting Colima runtime",
            None,
        );
        self.runtime().start_colima().map_err(|error| {
            let detail = error.to_string();
            operational::record_incident(
                &self.app,
                "error",
                "runtime",
                "start_failed",
                "Failed to start Colima runtime",
                Some(&detail),
            );
            detail
        })
    }

    pub fn stop(&self) -> Result<(), String> {
        operational::record_incident(
            &self.app,
            "info",
            "runtime",
            "stop_requested",
            "Stopping Colima runtime",
            None,
        );
        self.runtime().stop_colima().map_err(|error| {
            let detail = error.to_string();
            operational::record_incident(
                &self.app,
                "error",
                "runtime",
                "stop_failed",
                "Failed to stop Colima runtime",
                Some(&detail),
            );
            detail
        })
    }

    pub fn ensure_ready(&self) -> Result<RuntimeStatus, String> {
        let runtime = self.runtime();
        let mut status = runtime.check_status();
        if status.docker_ready {
            return Ok(status);
        }

        if matches!(Platform::detect(), Platform::MacOS)
            && status.colima_installed
            && !status.vm_running
        {
            operational::record_incident(
                &self.app,
                "warn",
                "runtime",
                "auto_start",
                "Docker was unavailable; attempting to start Colima automatically",
                None,
            );
            runtime.start_colima().map_err(|error| {
                let detail = error.to_string();
                operational::record_incident(
                    &self.app,
                    "error",
                    "runtime",
                    "auto_start_failed",
                    "Failed to auto-start Colima",
                    Some(&detail),
                );
                detail
            })?;
            status = runtime.check_status();
        }

        if !status.docker_ready {
            let message = if !status.docker_installed {
                match Platform::detect() {
                    Platform::Linux => {
                        "Docker is not installed. Please install Docker Engine: sudo apt install docker.io"
                            .to_string()
                    }
                    Platform::MacOS => {
                        "Docker is not installed. Please install Docker Desktop for development."
                            .to_string()
                    }
                    Platform::Windows => {
                        "Docker is not installed. Please install Docker Desktop for Windows."
                            .to_string()
                    }
                }
            } else {
                "Docker is not running. Please start Docker and try again.".to_string()
            };
            operational::record_incident(
                &self.app,
                "error",
                "runtime",
                "not_ready",
                "Runtime is not ready",
                Some(&message),
            );
            return Err(message);
        }

        Ok(status)
    }
}
