import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { platform } from "@tauri-apps/plugin-os";
import { SetupScreen } from "./pages/SetupScreen";
import { DockerInstall } from "./pages/DockerInstall";
import { Dashboard } from "./pages/Dashboard";
import { Onboarding } from "./pages/Onboarding";
import { SignIn } from "./pages/SignIn";
import { isOnboardingComplete } from "./lib/profile";
import { AuthProvider, useAuth } from "./contexts/AuthContext";

type RuntimeStatus = {
  colima_installed: boolean;
  docker_installed: boolean;
  vm_running: boolean;
  docker_ready: boolean;
};

type AppState = "loading" | "signin" | "onboarding" | "docker-install" | "setup" | "ready";

function AppContent() {
  const { isLoading: authLoading, isAuthenticated, isAuthConfigured } = useAuth();
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [appState, setAppState] = useState<AppState>("loading");
  const [_os, setOs] = useState<string>("");

  useEffect(() => {
    // Wait for auth to finish loading before determining app state
    if (!authLoading) {
      init();
    }
  }, [authLoading, isAuthenticated, isAuthConfigured]);

  async function init() {
    // If auth is configured but not authenticated, show sign in
    if (isAuthConfigured && !isAuthenticated) {
      setAppState("signin");
      return;
    }

    // Check if onboarding is complete first
    try {
      const onboarded = await isOnboardingComplete();
      console.log("Onboarding complete:", onboarded);
      if (!onboarded) {
        setAppState("onboarding");
        return;
      }
    } catch (error) {
      console.error("Failed to check onboarding:", error);
      setAppState("onboarding");
      return;
    }

    // Onboarding is complete, check runtime status
    try {
      const currentPlatform = await platform();
      setOs(currentPlatform);

      const result = await invoke<RuntimeStatus>("check_runtime_status");
      setStatus(result);

      if (result.docker_ready) {
        setAppState("ready");
      } else if (currentPlatform === "linux" && !result.docker_ready) {
        setAppState("docker-install");
      } else if (currentPlatform === "macos") {
        setAppState("setup");
      } else {
        setAppState("setup");
      }
    } catch (error) {
      console.error("Failed to check runtime:", error);
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

  // Loading state
  if (authLoading || appState === "loading") {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-[var(--bg-primary)]">
        <div className="text-center p-8 rounded-2xl animate-fade-in glass-card">
          <div className="w-12 h-12 rounded-xl mx-auto mb-4 bg-[var(--purple-accent)] animate-pulse-subtle" />
          <div className="animate-pulse text-[var(--text-secondary)]">
            loading...
          </div>
        </div>
      </div>
    );
  }

  // Sign in state
  if (appState === "signin") {
    return (
      <SignIn
        onSignInStarted={() => {
          // User clicked sign in, browser opened
          // We'll wait for the deep link callback
        }}
        onSkipAuth={() => {
          // User chose to skip auth and use their own API keys
          // Go directly to onboarding/setup
          setAppState("onboarding");
        }}
      />
    );
  }

  // Onboarding state
  if (appState === "onboarding") {
    return (
      <Onboarding
        onComplete={() => {
          init();
        }}
      />
    );
  }

  // Docker install state (Linux)
  if (appState === "docker-install") {
    return (
      <DockerInstall
        onDockerReady={() => {
          checkStatus();
        }}
      />
    );
  }

  // Setup state (macOS Colima)
  if (appState === "setup") {
    return (
      <SetupScreen
        onComplete={() => {
          checkStatus();
        }}
      />
    );
  }

  // Main dashboard
  return <Dashboard status={status} onRefresh={checkStatus} />;
}

function App() {
  return (
    <AuthProvider>
      <AppContent />
    </AuthProvider>
  );
}

export default App;
