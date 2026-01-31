import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { platform } from "@tauri-apps/plugin-os";
import { SetupScreen } from "./pages/SetupScreen";
import { DockerInstall } from "./pages/DockerInstall";
import { Dashboard } from "./pages/Dashboard";

type RuntimeStatus = {
  colima_installed: boolean;
  docker_installed: boolean;
  vm_running: boolean;
  docker_ready: boolean;
};

type AppState = "loading" | "docker-install" | "setup" | "ready";

function App() {
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [appState, setAppState] = useState<AppState>("loading");
  const [os, setOs] = useState<string>("");

  useEffect(() => {
    init();
  }, []);

  async function init() {
    try {
      // Detect OS
      const currentPlatform = await platform();
      setOs(currentPlatform);

      // Check runtime status
      const result = await invoke<RuntimeStatus>("check_runtime_status");
      setStatus(result);

      // Determine what screen to show
      if (result.docker_ready) {
        // Docker is ready, go to dashboard
        setAppState("ready");
      } else if (currentPlatform === "linux" && !result.docker_ready) {
        // Linux without Docker - show install instructions
        setAppState("docker-install");
      } else if (currentPlatform === "macos") {
        // macOS - run our setup (Colima)
        setAppState("setup");
      } else {
        // Windows or other - show setup
        setAppState("setup");
      }
    } catch (error) {
      console.error("Failed to initialize:", error);
      // If we can't check, assume we need setup
      setAppState("setup");
    }
  }

  async function checkStatus() {
    try {
      const result = await invoke<RuntimeStatus>("check_runtime_status");
      setStatus(result);
      if (result.docker_ready) {
        setAppState("ready");
      }
    } catch (error) {
      console.error("Failed to check status:", error);
    }
  }

  if (appState === "loading") {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-gray-50">
        <div className="animate-pulse text-gray-500">Loading...</div>
      </div>
    );
  }

  if (appState === "docker-install") {
    return (
      <DockerInstall
        onDockerReady={() => {
          checkStatus();
        }}
      />
    );
  }

  if (appState === "setup") {
    return (
      <SetupScreen
        onComplete={() => {
          checkStatus();
        }}
      />
    );
  }

  return <Dashboard status={status} onRefresh={checkStatus} />;
}

export default App;
