import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { platform } from "@tauri-apps/plugin-os";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { SetupScreen } from "./pages/SetupScreen";
import { DockerInstall } from "./pages/DockerInstall";
import { Dashboard } from "./pages/Dashboard";
import { Onboarding } from "./pages/Onboarding";
import { SignIn } from "./pages/SignIn";
import { isOnboardingComplete } from "./lib/profile";
import { clientLog } from "./lib/clientLog";
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
    if (import.meta.env.DEV) {
      return;
    }
    let cancelled = false;
    const runUpdate = async () => {
      try {
        const update = await check();
        if (!update || cancelled) return;
        await update.downloadAndInstall();
        if (!cancelled) {
          await relaunch();
        }
      } catch (error) {
        console.warn("Updater check failed:", error);
        clientLog("app.updater.failed", { error: String(error) });
      }
    };
    runUpdate();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    // Wait for auth to finish loading before determining app state
    clientLog("app.auth.state", {
      authLoading,
      isAuthenticated,
      isAuthConfigured,
    });
    if (!authLoading) {
      init();
    }
  }, [authLoading, isAuthenticated, isAuthConfigured]);

  useEffect(() => {
    if (!(authLoading || appState === "loading")) {
      return;
    }
    const timer = setTimeout(() => {
      clientLog("app.loading.watchdog", {
        authLoading,
        appState,
        isAuthenticated,
        isAuthConfigured,
      });
    }, 20000);
    return () => clearTimeout(timer);
  }, [authLoading, appState, isAuthenticated, isAuthConfigured]);

  async function init() {
    clientLog("app.init.start", { isAuthenticated, isAuthConfigured });
    // If auth is configured but not authenticated, show sign in
    if (isAuthConfigured && !isAuthenticated) {
      setAppState("signin");
      clientLog("app.state.signin");
      return;
    }

    // Check if onboarding is complete first
    try {
      const onboarded = await isOnboardingComplete();
      console.log("Onboarding complete:", onboarded);
      if (!onboarded) {
        setAppState("onboarding");
        clientLog("app.state.onboarding");
        return;
      }
    } catch (error) {
      console.error("Failed to check onboarding:", error);
      setAppState("onboarding");
      clientLog("app.onboarding.check.failed", { error: String(error) });
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
        clientLog("app.state.ready");
      } else if (currentPlatform === "linux" && !result.docker_ready) {
        setAppState("docker-install");
        clientLog("app.state.docker_install");
      } else if (currentPlatform === "macos") {
        setAppState("setup");
        clientLog("app.state.setup", { platform: currentPlatform });
      } else {
        setAppState("setup");
        clientLog("app.state.setup", { platform: currentPlatform });
      }
    } catch (error) {
      console.error("Failed to check runtime:", error);
      setAppState("setup");
      clientLog("app.runtime.check.failed", { error: String(error) });
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
  useEffect(() => {
    try {
      const os = platform();
      const isMac = os === "macos";
      document.documentElement.classList.toggle("platform-macos", isMac);
      document.body.classList.toggle("platform-macos", isMac);
    } catch {
      // ignore platform detection failures
    }
    return () => {
      document.documentElement.classList.remove("platform-macos");
      document.body.classList.remove("platform-macos");
    };
  }, []);

  return (
    <AuthProvider>
      <AppContent />
    </AuthProvider>
  );
}

export default App;
