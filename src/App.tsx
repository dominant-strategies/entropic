import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { platform } from "@tauri-apps/plugin-os";
import { SetupScreen } from "./pages/SetupScreen";
import { DockerInstall } from "./pages/DockerInstall";
import { Dashboard } from "./pages/Dashboard";
import { Onboarding } from "./pages/Onboarding";
import { isOnboardingComplete } from "./lib/profile";

type RuntimeStatus = {
  colima_installed: boolean;
  docker_installed: boolean;
  vm_running: boolean;
  docker_ready: boolean;
};

type AppState = "loading" | "onboarding" | "docker-install" | "setup" | "ready";

function App() {
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [appState, setAppState] = useState<AppState>("loading");
  const [_os, setOs] = useState<string>("");

  useEffect(() => {
    init();
  }, []);

  async function init() {
    // Check if onboarding is complete first (separate try/catch so it doesn't skip onboarding on other errors)
    try {
      const onboarded = await isOnboardingComplete();
      console.log("Onboarding complete:", onboarded);
      if (!onboarded) {
        setAppState("onboarding");
        return;
      }
    } catch (error) {
      console.error("Failed to check onboarding:", error);
      // If we can't check, show onboarding to be safe
      setAppState("onboarding");
      return;
    }

    // Onboarding is complete, check runtime status
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
      console.error("Failed to check runtime:", error);
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
      <div 
        className="h-screen w-screen flex items-center justify-center bg-[var(--bg-primary)]"
      >
        <div 
          className="text-center p-8 rounded-2xl animate-fade-in glass-card"
        >
          <div 
            className="w-12 h-12 rounded-xl mx-auto mb-4 bg-[var(--purple-accent)] animate-pulse-subtle"
          />
          <div className="animate-pulse text-[var(--text-secondary)]">
            loading...
          </div>
        </div>
      </div>
    );
  }

  if (appState === "onboarding") {
    return (
      <Onboarding
        onComplete={() => {
          // After onboarding, re-run init to check Docker status
          init();
        }}
      />
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
