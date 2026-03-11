import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { platform } from "@tauri-apps/plugin-os";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";
import { SetupScreen } from "./pages/SetupScreen";
import { DockerInstall } from "./pages/DockerInstall";
import { Dashboard } from "./pages/Dashboard";
import { Onboarding } from "./pages/Onboarding";
import { SignIn } from "./pages/SignIn";
import { DevScreenPreview } from "./components/DevScreenPreview";
import {
  isOnboardingComplete,
  saveOnboardingData,
  saveProfile,
  setOnboardingComplete,
} from "./lib/profile";
import { clientLog } from "./lib/clientLog";
import { AuthProvider, useAuth } from "./contexts/AuthContext";
import { getLocalCreditBalance } from "./lib/localCredits";

type RuntimeStatus = {
  colima_installed: boolean;
  docker_installed: boolean;
  vm_running: boolean;
  docker_ready: boolean;
};

type AppState = "loading" | "signin" | "onboarding" | "docker-install" | "setup" | "ready";

const DEFAULT_AGENT_NAME = "Joulie";
const DEFAULT_SOUL = `# About Joulie

You are Joulie, a helpful AI assistant for coding, research, and execution tasks.
Be concise, practical, and action-oriented.
`;

function AppContent() {
  const { isLoading: authLoading, isAuthenticated, isAuthConfigured } = useAuth();
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [appState, setAppState] = useState<AppState>("loading");
  const [_os, setOs] = useState<string>("");
  const appStateBeforeSignInRef = useRef<AppState>("ready");

  useEffect(() => {
    if (import.meta.env.DEV) {
      return;
    }
    let cancelled = false;
    const runUpdate = async () => {
      try {
        const currentVersion = await getVersion();
        console.log(`[Updater] Current version: ${currentVersion}`);
        clientLog("app.updater.check", { currentVersion });

        const update = await check();
        if (!update) {
          console.log("[Updater] No updates available");
          clientLog("app.updater.no_update", { currentVersion });
          return;
        }

        if (cancelled) return;

        const targetVersion = update.version;
        console.log(`[Updater] Update available: ${currentVersion} -> ${targetVersion}`);
        clientLog("app.updater.available", { currentVersion, targetVersion });

        // Loop prevention: Ensure target version is actually different
        if (currentVersion === targetVersion) {
          console.warn("[Updater] Target version matches current version, skipping update to prevent loop");
          clientLog("app.updater.loop_prevented", { currentVersion, targetVersion });
          return;
        }

        console.log("[Updater] Downloading and installing update...");
        clientLog("app.updater.installing", { currentVersion, targetVersion });

        await update.downloadAndInstall();

        if (!cancelled) {
          console.log("[Updater] Update installed, relaunching...");
          clientLog("app.updater.relaunch", { targetVersion });
          await relaunch();
        }
      } catch (error) {
        console.warn("[Updater] Check failed:", error);
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

  useEffect(() => {
    const onRequireSignIn = () => {
      setAppState((current) => {
        if (current !== "signin") {
          appStateBeforeSignInRef.current = current;
        }
        return "signin";
      });
    };
    window.addEventListener("entropic-require-signin", onRequireSignIn);
    return () => window.removeEventListener("entropic-require-signin", onRequireSignIn);
  }, []);

  async function init() {
    clientLog("app.init.start", { isAuthenticated, isAuthConfigured });

    // Check if onboarding is complete first
    try {
      const onboarded = await isOnboardingComplete();
      console.log("Onboarding complete:", onboarded);
      if (!onboarded) {
        clientLog("app.onboarding.bootstrap.start");
        await saveOnboardingData({
          soul: DEFAULT_SOUL,
          agentName: DEFAULT_AGENT_NAME,
          completedAt: new Date().toISOString(),
        });
        try {
          await invoke("sync_onboarding_to_settings", {
            soul: DEFAULT_SOUL,
            agentName: DEFAULT_AGENT_NAME,
          });
        } catch (error) {
          console.warn("Onboarding sync warning:", error);
        }
        try {
          await saveProfile({ name: DEFAULT_AGENT_NAME });
        } catch (error) {
          console.warn("Profile save warning:", error);
        }
        await setOnboardingComplete(true);
        window.dispatchEvent(new Event("entropic-profile-updated"));
        clientLog("app.onboarding.bootstrap.success");
      }
    } catch (error) {
      console.error("Failed to check onboarding:", error);
      setAppState("onboarding");
      clientLog("app.onboarding.check.failed", { error: String(error) });
      return;
    }

    // Pre-load local trial credits for unauthenticated users
    // This ensures backend session is initialized before features are used
    if (!isAuthenticated && isAuthConfigured) {
      try {
        const balance = await getLocalCreditBalance();
        console.log("[App] Local trial balance pre-loaded:", balance.balance_cents, "cents");
        clientLog("app.trial_credits.preload.success", { balance_cents: balance.balance_cents });
      } catch (error) {
        console.warn("[App] Failed to pre-load trial credits:", error);
        clientLog("app.trial_credits.preload.failed", { error: String(error) });
        // Continue anyway - non-blocking
      }
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
          // Return to previous flow state when user exits sign-in.
          const resume = appStateBeforeSignInRef.current;
          if (resume === "loading" || resume === "signin") {
            init();
            return;
          }
          setAppState(resume);
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
  const devScreen = import.meta.env.DEV
    ? new URLSearchParams(window.location.search).get("devScreen")
    : null;

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

  if (devScreen) {
    return <DevScreenPreview />;
  }

  return (
    <AuthProvider>
      <AppContent />
    </AuthProvider>
  );
}

export default App;
