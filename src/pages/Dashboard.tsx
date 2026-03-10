import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-shell";
import { Loader2, CheckCircle2 } from "lucide-react";
import { Layout, Page } from "../components/Layout";
import { Chat, type ChatSession, type ChatSessionActionRequest } from "./Chat";
import { Store } from "./Store";
import { Channels } from "./Channels";
import { Files } from "./Files";
import { Tasks } from "./Tasks";
import { Jobs } from "./Jobs";
import { BillingPage } from "./BillingPage";
import { Settings } from "./Settings";
import { useAuth } from "../contexts/AuthContext";
import { createGatewayToken, getProxyUrl, getBalance, ApiRequestError } from "../lib/auth";
import { getLocalCreditBalance } from "../lib/localCredits";
import {
  hasPendingIntegrationImports,
  syncPendingIntegrationImports,
  syncAllIntegrationsToGateway,
  getCachedIntegrationProviders,
  startIntegrationRefreshLoop,
  stopIntegrationRefreshLoop,
} from "../lib/integrations";
import { getGatewayStatusCached } from "../lib/gateway-status";
import { LOCAL_MODEL_IDS, PROXY_MODEL_IDS } from "../components/ModelSelector";
import { Store as TauriStore } from "@tauri-apps/plugin-store";

type RuntimeStatus = {
  colima_installed: boolean;
  docker_installed: boolean;
  vm_running: boolean;
  docker_ready: boolean;
};

type Props = {
  status: RuntimeStatus | null;
  onRefresh: () => void;
};

// Default models per mode
const DEFAULT_PROXY_MODEL = "openai/gpt-5.4";
const DEFAULT_LOCAL_MODEL = "anthropic/claude-opus-4-6:thinking";
const GATEWAY_FAILURE_THRESHOLD = 3;
const FEEDBACK_FORM_URL = "https://entropic.qu.ai/feedback";
const SANDBOX_STARTUP_FACTS = [
  "Secure Execution: Entropic runs all shell commands in an isolated sandbox to protect your local system.",
  "Custom Providers: Add your own API keys in Settings for direct access to the latest models.",
  "Deep Context: Stage logs or documentation in 'Files' so Entropic can analyze them with full technical detail.",
  "Tasks + Jobs: Plan and track work in Tasks, then automate routines from Jobs.",
  "Codebase Awareness: Ask Entropic to 'read the repo' to generate precise implementation roadmaps.",
  "Seamless Integrations: Connect GitHub, Slack, or Linear via Integrations to extend Entropic's capabilities.",
  "One-click Workflow: Quickly initialize projects or deploy environments with a single command.",
];

export function Dashboard({ status: _status, onRefresh: _onRefresh }: Props) {
  const { isAuthenticated, isAuthConfigured, refreshBalance } = useAuth();
  const [useLocalKeys, setUseLocalKeys] = useState(false);
  const [currentPage, setCurrentPage] = useState<Page>("chat");
  const [gatewayRunning, setGatewayRunning] = useState(false);
  const [isTogglingGateway, setIsTogglingGateway] = useState(false);
  const [showGatewayStartup, setShowGatewayStartup] = useState(false);
  const [gatewayStartupStage, setGatewayStartupStage] = useState<"idle" | "credits" | "token" | "launch" | "health">("idle");
  const [startupError, setStartupError] = useState<{
    message: string;
    actions?: Array<{ label: string; onClick: () => void }>;
  } | null>(null);
  const [gatewayRetryIn, setGatewayRetryIn] = useState<number | null>(null);
  const [startupFactIndex, setStartupFactIndex] = useState(0);
  const [integrationsSyncing, setIntegrationsSyncing] = useState(false);
  const [integrationsMissing, setIntegrationsMissing] = useState(false);
  const [prefsLoaded, setPrefsLoaded] = useState(false);
  const [selectedModel, setSelectedModel] = useState(DEFAULT_PROXY_MODEL);
  const [codeModel, setCodeModel] = useState("openai/gpt-5.3-codex");
  const [imageModel, setImageModel] = useState("google/gemini-3.1-flash-image-preview");
  const [chatSessions, setChatSessions] = useState<ChatSession[]>([]);
  const [currentChatSession, setCurrentChatSession] = useState<string | null>(null);
  const [pendingChatSession, setPendingChatSession] = useState<string | null>(null);
  const [pendingChatAction, setPendingChatAction] = useState<ChatSessionActionRequest | null>(null);
  const [localCreditBalanceCents, setLocalCreditBalanceCents] = useState<number | null>(null);
  const gatewayTokenRef = useRef<string | null>(null);
  const autoStartAttemptedRef = useRef(false);
  const lastAuthStateRef = useRef<boolean | null>(null);
  const startGatewayAttemptRef = useRef(0);
  const startGatewayInFlightRef = useRef(false);
  const retryAttemptRef = useRef(0);
  const retryTimeoutRef = useRef<number | null>(null);
  const retryIntervalRef = useRef<number | null>(null);
  const runtimeAutoRefreshAttemptedRef = useRef(false);
  const fullSyncRef = useRef(false);
  const [providerSwitchConfirm, setProviderSwitchConfirm] = useState<{
    oldProvider: string;
    newProvider: string;
    newModel: string;
  } | null>(null);
  const gatewayHealthFailureStreakRef = useRef(0);

  async function openFeedbackPage() {
    const url = new URL(FEEDBACK_FORM_URL);
    if (!url.searchParams.get("source")) {
      url.searchParams.set("source", "desktop_sidebar");
    }
    if (!url.searchParams.get("app")) {
      url.searchParams.set("app", "desktop");
    }
    await open(url.toString());
  }

  function requestSignIn() {
    window.dispatchEvent(
      new CustomEvent("entropic-require-signin", {
        detail: { source: "credits" },
      })
    );
  }

  function buildOutOfCreditsStartupError() {
    if (isAuthenticated) {
      return {
        message: "You’re out of credits. Add credits to continue using Entropic in proxy mode.",
        actions: [{ label: "Add Credits", onClick: () => setCurrentPage("billing") }],
      };
    }
    return {
      message:
        "You’ve used all free trial credits. Sign in to continue and add paid credits.",
      actions: [
        { label: "Sign In", onClick: requestSignIn },
        { label: "Billing", onClick: () => setCurrentPage("billing") },
      ],
    };
  }

  async function refreshLocalCredits() {
    try {
      const balance = await getLocalCreditBalance();
      setLocalCreditBalanceCents(balance.balance_cents);
    } catch (error) {
      console.warn("[Entropic] Failed to load local credits:", error);
      setLocalCreditBalanceCents(0);
    }
  }

  // Load saved model preference
  useEffect(() => {
    async function loadModel() {
      try {
        const store = await TauriStore.load("entropic-settings.json");
        const storedUseLocal = await store.get("useLocalKeys") as boolean | null;
        if (typeof storedUseLocal === "boolean") setUseLocalKeys(storedUseLocal);
        const isLocal = storedUseLocal === true;

        const saved = await store.get("selectedModel") as string | null;
        if (saved) {
          // If the saved model doesn't match the current mode, pick a sensible default
          if (isLocal && !LOCAL_MODEL_IDS.has(saved)) {
            setSelectedModel(DEFAULT_LOCAL_MODEL);
          } else if (!isLocal && !PROXY_MODEL_IDS.has(saved)) {
            setSelectedModel(DEFAULT_PROXY_MODEL);
          } else {
            setSelectedModel(saved);
          }
        } else {
          setSelectedModel(isLocal ? DEFAULT_LOCAL_MODEL : DEFAULT_PROXY_MODEL);
        }

        const savedCode = await store.get("codeModel") as string | null;
        if (savedCode) setCodeModel(savedCode);
        const savedImage = await store.get("imageModel") as string | null;
        if (savedImage) setImageModel(savedImage);
      } catch (error) {
        console.error("[Entropic] Failed to load model preference:", error);
      } finally {
        setPrefsLoaded(true);
      }
    }
    loadModel();
  }, []);

  useEffect(() => {
    if (isAuthenticated || !isAuthConfigured) {
      setLocalCreditBalanceCents(null);
      return;
    }

    refreshLocalCredits();
    const onLocalCreditsChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ balanceCents?: number }>).detail;
      if (detail && typeof detail.balanceCents === "number") {
        setLocalCreditBalanceCents(detail.balanceCents);
      } else {
        refreshLocalCredits();
      }
      // Also refresh authenticated balance so the UI stays in sync
      if (isAuthenticated) {
        refreshBalance();
      }
    };
    window.addEventListener("entropic-local-credits-changed", onLocalCreditsChanged as EventListener);

    // Poll credit balance every 30 minutes to catch any missed updates
    const pollInterval = window.setInterval(() => {
      refreshLocalCredits();
    }, 30 * 60 * 1000); // 30 minutes

    return () => {
      window.removeEventListener(
        "entropic-local-credits-changed",
        onLocalCreditsChanged as EventListener
      );
      window.clearInterval(pollInterval);
    };
  }, [isAuthenticated, isAuthConfigured, refreshBalance]);

  useEffect(() => {
    if (!showGatewayStartup) {
      setStartupFactIndex(0);
      return;
    }
    const interval = window.setInterval(() => {
      setStartupFactIndex((current) => (current + 1) % SANDBOX_STARTUP_FACTS.length);
    }, 4500);
    return () => window.clearInterval(interval);
  }, [showGatewayStartup]);

  useEffect(() => {
    const intervalMs =
      gatewayRunning && !showGatewayStartup && !isTogglingGateway ? 15_000 : 5_000;
    checkGateway();
    const interval = window.setInterval(checkGateway, intervalMs);
    return () => window.clearInterval(interval);
  }, [gatewayRunning, showGatewayStartup, isTogglingGateway]);

  useEffect(() => {
    const handleOpenPage = (event: Event) => {
      const detail = (event as CustomEvent<{ page?: string }>).detail;
      if (detail?.page === "billing") {
        setCurrentPage("billing");
      }
    };
    window.addEventListener("entropic-open-page", handleOpenPage as EventListener);
    return () => {
      window.removeEventListener("entropic-open-page", handleOpenPage as EventListener);
    };
  }, []);

  useEffect(() => {
    const handleStartGateway = () => {
      if (!gatewayRunning && !isTogglingGateway) {
        void toggleGateway();
      }
    };
    window.addEventListener("entropic-start-gateway", handleStartGateway);
    return () => {
      window.removeEventListener("entropic-start-gateway", handleStartGateway);
    };
  }, [gatewayRunning, isTogglingGateway]);

  useEffect(() => {
    if (!gatewayRunning) {
      stopIntegrationRefreshLoop();
      setIntegrationsSyncing(false);
      fullSyncRef.current = false;
      return;
    }
    let cancelled = false;
    let intervalId: number | null = null;
    const deadline = Date.now() + 5 * 60_000;

    const syncOnce = async () => {
      if (cancelled) return;
      let didWork = false;
      try {
        if (!fullSyncRef.current) {
          setIntegrationsSyncing(true);
          const synced = await syncAllIntegrationsToGateway();
          fullSyncRef.current = true;
          didWork = true;
          if (!cancelled) {
            const cached = await getCachedIntegrationProviders().catch(() => []);
            const missing = synced.length === 0 && cached.length > 0;
            setIntegrationsMissing(missing);
          }
        }
        await syncPendingIntegrationImports();
        didWork = true;
      } catch (err) {
        console.warn("[Entropic] Failed to sync integration tokens:", err);
      }
      try {
        const stillPending = await hasPendingIntegrationImports();
        if (!cancelled) {
          setIntegrationsSyncing(stillPending || (!fullSyncRef.current && didWork));
        }
        if ((!stillPending && fullSyncRef.current) || Date.now() > deadline) {
          if (intervalId !== null) {
            window.clearInterval(intervalId);
            intervalId = null;
          }
        }
      } catch {
        if (Date.now() > deadline && intervalId !== null) {
          window.clearInterval(intervalId);
          intervalId = null;
        }
      }
    };

    syncOnce();
    intervalId = window.setInterval(syncOnce, 10_000);
    startIntegrationRefreshLoop();
    return () => {
      cancelled = true;
      if (intervalId !== null) {
        window.clearInterval(intervalId);
      }
      stopIntegrationRefreshLoop();
    };
  }, [gatewayRunning]);

  useEffect(() => {
    return () => {
      if (retryTimeoutRef.current) {
        window.clearTimeout(retryTimeoutRef.current);
        retryTimeoutRef.current = null;
      }
      if (retryIntervalRef.current) {
        window.clearInterval(retryIntervalRef.current);
        retryIntervalRef.current = null;
      }
    };
  }, []);

  function clearGatewayRetry() {
    if (retryTimeoutRef.current) {
      window.clearTimeout(retryTimeoutRef.current);
      retryTimeoutRef.current = null;
    }
    if (retryIntervalRef.current) {
      window.clearInterval(retryIntervalRef.current);
      retryIntervalRef.current = null;
    }
    retryAttemptRef.current = 0;
    setGatewayRetryIn(null);
  }

  function scheduleGatewayRetry(action: () => void) {
    const attempt = Math.min(retryAttemptRef.current + 1, 5);
    retryAttemptRef.current = attempt;
    const delayMs = Math.min(30000, 1000 * Math.pow(2, attempt));
    const endAt = Date.now() + delayMs;
    setGatewayRetryIn(Math.ceil(delayMs / 1000));

    if (retryIntervalRef.current) {
      window.clearInterval(retryIntervalRef.current);
    }
    retryIntervalRef.current = window.setInterval(() => {
      const remainingMs = endAt - Date.now();
      if (remainingMs <= 0) {
        setGatewayRetryIn(null);
        return;
      }
      setGatewayRetryIn(Math.ceil(remainingMs / 1000));
    }, 1000);

    if (retryTimeoutRef.current) {
      window.clearTimeout(retryTimeoutRef.current);
    }
    retryTimeoutRef.current = window.setTimeout(() => {
      if (retryIntervalRef.current) {
        window.clearInterval(retryIntervalRef.current);
        retryIntervalRef.current = null;
      }
      setGatewayRetryIn(null);
      action();
    }, delayMs);
  }

  function normalizeProxyModel(model: string) {
    return model.startsWith("openrouter/") ? model : `openrouter/${model}`;
  }

  function extractGatewayStartError(error: unknown): string {
    if (error instanceof Error) {
      return error.message || "Failed to start gateway";
    }
    if (typeof error === "string") {
      return error;
    }
    const candidate =
      (error && typeof error === "object" && ("message" in error || "error" in error))
        ? (error as Record<string, unknown>)
        : null;
    if (candidate) {
      const message = candidate.message;
      const nestedError = candidate.error;
      if (typeof message === "string" && message.trim()) {
        return message.trim();
      }
      if (typeof nestedError === "string" && nestedError.trim()) {
        return nestedError.trim();
      }
    }
    return "Failed to start gateway";
  }

  function isGatewayPortConflictError(message: string): boolean {
    const text = message.toLowerCase();
    return (
      text.includes("localhost:19789") &&
      (text.includes("legacy nova runtime process") ||
        text.includes("port conflict detected") ||
        text.includes("wrong gateway instance"))
    );
  }

  function shouldAutoRefreshRuntime(message: string): boolean {
    const text = message.toLowerCase();
    return (
      text.includes("failed to write files in container") ||
      text.includes("failed to batch write files") ||
      text.includes("read-only file system") ||
      text.includes("no space left on device") ||
      (text.includes("container") && text.includes("permission denied"))
    );
  }

  async function tryAutoRefreshRuntime(message: string): Promise<boolean> {
    if (runtimeAutoRefreshAttemptedRef.current || !shouldAutoRefreshRuntime(message)) {
      return false;
    }

    runtimeAutoRefreshAttemptedRef.current = true;
    try {
      setStartupError({
        message: "Refreshing sandbox runtime before retrying startup...",
      });
      await invoke("fetch_latest_openclaw_runtime");
      return true;
    } catch (error) {
      console.warn("[Entropic] Runtime auto-refresh failed:", error);
      return false;
    }
  }

  async function startGatewayProxyFlow({
    model,
    image,
    stopFirst = false,
    allowRetry = true,
  }: {
    model: string;
    image: string;
    stopFirst?: boolean;
    allowRetry?: boolean;
  }): Promise<boolean> {
    console.log("[Entropic] startGatewayProxyFlow called with:", {
      model,
      image,
      stopFirst,
      allowRetry,
      isAuthConfigured,
      isAuthenticated,
      useLocalKeys,
      localCreditBalanceCents,
    });

    if (!isAuthConfigured || useLocalKeys) {
      console.log("[Entropic] Skipping proxy flow - proxy mode disabled");
      return false;
    }

    let anonymousBalanceCents = localCreditBalanceCents ?? 0;
    if (!isAuthenticated) {
      if (anonymousBalanceCents <= 0) {
        try {
          const localBalance = await getLocalCreditBalance();
          anonymousBalanceCents = localBalance.balance_cents;
          setLocalCreditBalanceCents(localBalance.balance_cents);
        } catch (error) {
          console.warn("[Entropic] Failed to read anonymous balance:", error);
          anonymousBalanceCents = 0;
        }
      }
      if (anonymousBalanceCents <= 0) {
        setStartupError(buildOutOfCreditsStartupError());
        setShowGatewayStartup(false);
        return false;
      }
    }

    if (startGatewayInFlightRef.current) {
      console.log("[Entropic] Waiting for in-flight gateway start attempt to finish");
      while (startGatewayInFlightRef.current) {
        await new Promise((r) => setTimeout(r, 120));
      }
      return checkGateway();
    }

    startGatewayInFlightRef.current = true;
    const attemptId = ++startGatewayAttemptRef.current;
    setStartupError(null);
    setShowGatewayStartup(true);
    setGatewayStartupStage("credits");
    gatewayHealthFailureStreakRef.current = 0;
    setGatewayRunning(false);
    try {
      if (stopFirst) {
        try {
          await invoke("stop_gateway");
        } catch (error) {
          console.error("[Entropic] Failed to stop gateway:", error);
        }
      }

      try {
        if (isAuthenticated) {
          const balance = await getBalance();
          if (balance.balance_cents <= 0) {
            setStartupError(buildOutOfCreditsStartupError());
            setShowGatewayStartup(false);
            return false;
          }
        } else {
          if (anonymousBalanceCents <= 0) {
            setStartupError(buildOutOfCreditsStartupError());
            setShowGatewayStartup(false);
            return false;
          }
        }
      } catch (error) {
        console.warn("[Entropic] Balance check failed:", error);
      }

      setGatewayStartupStage("token");
      console.log("[Entropic] Creating gateway token...");
      const { token } = await createGatewayToken({
        allowAnonymous: !isAuthenticated,
      });
      gatewayTokenRef.current = token;
      console.log("[Entropic] Gateway token created successfully");

      const proxyUrl = getProxyUrl();
      const proxyModel = normalizeProxyModel(model);
      const proxyImageModel = normalizeProxyModel(image);
      console.log("[Entropic] Proxy configuration:", {
        proxyUrl,
        proxyModel,
        proxyImageModel
      });

      setGatewayStartupStage("launch");
      console.log("[Entropic] Invoking start_gateway_with_proxy...");
      await invoke("start_gateway_with_proxy", {
        gatewayToken: token,
        proxyUrl,
        model: proxyModel,
        imageModel: proxyImageModel,
      });
      console.log("[Entropic] start_gateway_with_proxy completed");

      setGatewayStartupStage("health");
      if (startGatewayAttemptRef.current !== attemptId) {
        return false;
      }
      // The Rust side may return Ok while the container is still in the
      // "starting" Docker health state (WS not accepting connections yet).
      // Poll until the WS endpoint is actually ready before declaring success.
      {
        const HEALTH_POLL_MS = 2000;
        const HEALTH_TIMEOUT_MS = 90_000;
        const healthStart = Date.now();
        let wsReady = false;
        while (Date.now() - healthStart < HEALTH_TIMEOUT_MS) {
          if (startGatewayAttemptRef.current !== attemptId) {
            return false;
          }
          const ok = await getGatewayStatusCached({ force: true });
          if (ok) {
            wsReady = true;
            break;
          }
          await new Promise((r) => setTimeout(r, HEALTH_POLL_MS));
        }
        if (!wsReady) {
          throw new Error(
            "Gateway started but did not become healthy within 90 s. Please try again."
          );
        }
      }
      gatewayHealthFailureStreakRef.current = 0;
      setGatewayRunning(true);
      runtimeAutoRefreshAttemptedRef.current = false;
      clearGatewayRetry();
      setStartupError(null);
      setGatewayStartupStage("idle");
      setShowGatewayStartup(false);
      return true;
    } catch (error: any) {
      if (startGatewayAttemptRef.current !== attemptId) {
        return false;
      }
      console.error("[Entropic] Proxy start failed:", error);

      const isApiError = error instanceof ApiRequestError;
      const status = isApiError ? error.status : undefined;
      const message = extractGatewayStartError(error);
      const isNetwork =
        (isApiError && error.kind === "network") ||
        (typeof message === "string" &&
          /load failed|failed to fetch|network/i.test(message));

      if (status === 402) {
        setStartupError(buildOutOfCreditsStartupError());
        setGatewayStartupStage("idle");
        setShowGatewayStartup(false);
        return false;
      }

      if (status === 401) {
        setStartupError(
          isAuthenticated
            ? {
                message: "Your session expired. Please sign in again.",
                actions: [{ label: "Open Settings", onClick: () => setCurrentPage("settings") }],
              }
            : {
                message: "Trial session expired. Sign in to continue.",
                actions: [{ label: "Sign In", onClick: requestSignIn }],
              }
        );
        setGatewayStartupStage("idle");
        setShowGatewayStartup(false);
        return false;
      }

      if (isNetwork) {
        setStartupError({
          message:
            "Can’t reach the Entropic backend from the app (network/API error). Check backend availability and local proxy settings.",
          actions: [
            { label: "Retry", onClick: () => startGatewayProxyFlow({ model, image, stopFirst, allowRetry: false }) },
          ],
        });
        setGatewayStartupStage("idle");
        setShowGatewayStartup(false);
        return false;
      }

      if (isGatewayPortConflictError(message)) {
        setStartupError({
          message,
          actions: [
            {
              label: "Open Settings",
              onClick: () => setCurrentPage("settings"),
            },
            {
              label: "Retry",
              onClick: () => {
                void startGatewayProxyFlow({ model, image, stopFirst: false, allowRetry: false });
              },
            },
          ],
        });
        clearGatewayRetry();
        setGatewayStartupStage("idle");
        setShowGatewayStartup(false);
        return false;
      }

      setStartupError({
        message,
      });
      const refreshedRuntime = allowRetry
        ? await tryAutoRefreshRuntime(message)
        : false;
      if (allowRetry) {
        scheduleGatewayRetry(() => {
          startGatewayProxyFlow({
            model,
            image,
            stopFirst: refreshedRuntime ? true : stopFirst,
            allowRetry,
          });
        });
      } else {
        setGatewayStartupStage("idle");
        setShowGatewayStartup(false);
      }
      return false;
    } finally {
      startGatewayInFlightRef.current = false;
    }
  }

  // Auto-start gateway for proxy or local-key modes
  useEffect(() => {
    if (!prefsLoaded) return; // Wait for stored preferences before deciding proxy vs local
    if (!isAuthenticated && isAuthConfigured && !useLocalKeys && localCreditBalanceCents === null) {
      return;
    }

    async function autoStartGateway() {
      const proxyEnabled =
        isAuthConfigured &&
        !useLocalKeys &&
        (isAuthenticated || (localCreditBalanceCents ?? 0) > 0);
      console.log("[Entropic] Auto-start check:", {
        isAuthConfigured,
        isAuthenticated,
        localCreditBalanceCents,
        useLocalKeys,
        proxyEnabled,
        prefsLoaded,
        gatewayRunning,
        isTogglingGateway,
        gatewayRetryIn,
        autoStartAttempted: autoStartAttemptedRef.current
      });

      if (autoStartAttemptedRef.current || gatewayRunning || isTogglingGateway || gatewayRetryIn !== null) {
        return;
      }

      // Check if gateway is already running
      const alreadyRunning = await getGatewayStatusCached({ force: true });
      console.log("[Entropic] Auto-start: alreadyRunning =", alreadyRunning, "proxyEnabled =", proxyEnabled, "useLocalKeys =", useLocalKeys);

      if (alreadyRunning) {
        autoStartAttemptedRef.current = true;
        gatewayHealthFailureStreakRef.current = 0;
        clearGatewayRetry();
        setStartupError(null);
        setGatewayStartupStage("idle");
        setShowGatewayStartup(false);

        if (proxyEnabled) {
          // Proxy mode — refresh token/config so stale gateway tokens don't persist across app launches.
          console.log("[Entropic] Auto-start: existing container found, refreshing proxy config...");
          setGatewayRunning(true);
          setIsTogglingGateway(true);
          try {
            await startGatewayProxyFlow({
              model: selectedModel,
              image: imageModel,
              stopFirst: false,
              allowRetry: true,
            });
          } catch (error) {
            console.error("[Entropic] Proxy refresh for running gateway failed:", error);
          } finally {
            setIsTogglingGateway(false);
          }
        } else if (useLocalKeys) {
          // Local-keys mode but a (likely stale proxy) container is running — stop and restart with correct config.
          console.log("[Entropic] Auto-start: existing container found but we're in local-keys mode — restarting with local keys...");
          setShowGatewayStartup(true);
          setGatewayStartupStage("launch");
          setIsTogglingGateway(true);
          try {
            await invoke("stop_gateway");
            console.log("[Entropic] Auto-start: stopped stale container, starting with local keys...");
            await invoke("start_gateway", { model: selectedModel });
            setGatewayStartupStage("health");
            await new Promise((r) => setTimeout(r, 2000));
            await checkGateway();
            console.log("[Entropic] Auto-start: local-keys restart completed");
          } catch (error) {
            console.error("[Entropic] Auto-start: local-keys restart failed:", error);
          } finally {
            setIsTogglingGateway(false);
            setShowGatewayStartup(false);
          }
        } else {
          setGatewayRunning(true);
        }
        return;
      }

      autoStartAttemptedRef.current = true;

      if (proxyEnabled) {
        // Auto-start in proxy mode
        console.log("[Entropic] Auto-starting gateway in proxy mode...");
        setIsTogglingGateway(true);
        try {
          const result = await startGatewayProxyFlow({
            model: selectedModel,
            image: imageModel,
            stopFirst: false,
            allowRetry: true,
          });
          console.log("[Entropic] Auto-start proxy result:", result);
        } catch (error) {
          console.error("[Entropic] Auto-start proxy error:", error);
        } finally {
          setIsTogglingGateway(false);
        }
      } else if (useLocalKeys) {
        // Auto-start in local-keys mode
        console.log("[Entropic] Auto-starting gateway in local-keys mode (no existing container)...");
        setShowGatewayStartup(true);
        setGatewayStartupStage("launch");
        setIsTogglingGateway(true);
        try {
          await invoke("start_gateway", { model: selectedModel });
          setGatewayStartupStage("health");
          await new Promise((r) => setTimeout(r, 2000));
          await checkGateway();
          console.log("[Entropic] Auto-start (local keys) completed");
        } catch (error) {
          console.error("[Entropic] Auto-start (local keys) error:", error);
        } finally {
          setIsTogglingGateway(false);
          setShowGatewayStartup(false);
        }
      }
    }

    autoStartGateway();
  }, [
    prefsLoaded,
    isAuthenticated,
    isAuthConfigured,
    localCreditBalanceCents,
    useLocalKeys,
    gatewayRunning,
    isTogglingGateway,
    selectedModel,
    gatewayRetryIn,
    imageModel,
  ]);

  // When auth state changes (anonymous <-> signed-in), rotate gateway token so
  // the running container does not keep using a stale token from the prior mode.
  useEffect(() => {
    const previous = lastAuthStateRef.current;
    if (previous === null) {
      lastAuthStateRef.current = isAuthenticated;
      return;
    }

    if (previous === isAuthenticated) {
      return;
    }

    lastAuthStateRef.current = isAuthenticated;
    autoStartAttemptedRef.current = false;

    const proxyModeSelected = isAuthConfigured && !useLocalKeys;
    if (!proxyModeSelected || !gatewayRunning || isTogglingGateway) {
      return;
    }

    setIsTogglingGateway(true);
    void startGatewayProxyFlow({
      model: selectedModel,
      image: imageModel,
      stopFirst: false,
      allowRetry: true,
    }).finally(() => {
      setIsTogglingGateway(false);
    });
  }, [
    isAuthenticated,
    isAuthConfigured,
    useLocalKeys,
    gatewayRunning,
    isTogglingGateway,
    selectedModel,
    imageModel,
  ]);

  async function checkGateway(): Promise<boolean> {
    try {
      const running = await getGatewayStatusCached({ force: true });
      if (running) {
        gatewayHealthFailureStreakRef.current = 0;
        setGatewayRunning(true);
        console.log("[Entropic] Gateway health check: healthy");
        setGatewayStartupStage("idle");
        setShowGatewayStartup(false);
        clearGatewayRetry();
        return true;
      }

      gatewayHealthFailureStreakRef.current += 1;
      const failureStreak = gatewayHealthFailureStreakRef.current;
      if (gatewayRunning && failureStreak < GATEWAY_FAILURE_THRESHOLD) {
        console.warn(
          `[Entropic] Gateway health transient miss (${failureStreak}/${GATEWAY_FAILURE_THRESHOLD}); keeping running state`
        );
        return true;
      }

      setGatewayRunning(false);
      console.log("[Entropic] Gateway health check: not responding");
      return false;
    } catch (error) {
      console.error("[Entropic] Gateway check failed:", error);
      gatewayHealthFailureStreakRef.current += 1;
      const failureStreak = gatewayHealthFailureStreakRef.current;
      if (gatewayRunning && failureStreak < GATEWAY_FAILURE_THRESHOLD) {
        console.warn(
          `[Entropic] Gateway status check error treated as transient (${failureStreak}/${GATEWAY_FAILURE_THRESHOLD})`
        );
        return true;
      }
      setGatewayRunning(false);
      return false;
    }
  }

  async function toggleGateway() {
    setIsTogglingGateway(true);
    setStartupError(null);
    try {
      if (gatewayRunning) {
        console.log("[Entropic] Stopping gateway...");
        await invoke("stop_gateway");
        console.log("[Entropic] Gateway stopped successfully");
        gatewayHealthFailureStreakRef.current = 0;
        autoStartAttemptedRef.current = false;
        setGatewayRunning(false);
      } else {
        console.log("[Entropic] Starting gateway...");
        gatewayHealthFailureStreakRef.current = 0;
        setGatewayRunning(false);
        const proxyEnabled =
          isAuthConfigured &&
          !useLocalKeys &&
          (isAuthenticated || (localCreditBalanceCents ?? 0) > 0);

        if (proxyEnabled) {
          // If proxy mode is available, start with proxy flow.
          const started = await startGatewayProxyFlow({
            model: selectedModel,
            image: imageModel,
            stopFirst: false,
            allowRetry: false,
          });
          if (!started) {
            console.error("[Entropic] Proxy mode failed; not falling back to local mode.");
            return;
          }
        } else if (isAuthConfigured && !useLocalKeys) {
          // Auth-configured proxy mode is selected but currently unavailable (typically no credits).
          // Don't fall back to local-key startup unless the user explicitly enables local keys.
          setStartupError(buildOutOfCreditsStartupError());
          return;
        } else {
          // Local keys mode (or auth disabled), use direct API keys.
          await invoke("start_gateway", { model: selectedModel });
        }

        console.log("[Entropic] Gateway started successfully");
      }
      await new Promise((r) => setTimeout(r, 2000));
      await checkGateway();
    } catch (error) {
      console.error("[Entropic] Failed to toggle gateway:", error);
      setStartupError({ message: extractGatewayStartError(error) });
    } finally {
      setIsTogglingGateway(false);
    }
  }

  async function startGatewayFromChat() {
    if (gatewayRunning || isTogglingGateway) return;
    await toggleGateway();
  }

  async function recoverProxyAuthFromChat(): Promise<boolean> {
    if (
      !isAuthConfigured ||
      useLocalKeys ||
      (!isAuthenticated && (localCreditBalanceCents ?? 0) <= 0)
    ) {
      return false;
    }
    if (isTogglingGateway) {
      return false;
    }

    setIsTogglingGateway(true);
    try {
      const started = await startGatewayProxyFlow({
        model: selectedModel,
        image: imageModel,
        stopFirst: false,
        allowRetry: false,
      });
      await new Promise((r) => setTimeout(r, 1200));
      await checkGateway();
      return started;
    } catch (error) {
      console.error("[Entropic] Proxy auth recovery failed:", error);
      return false;
    } finally {
      setIsTogglingGateway(false);
    }
  }

  // Handle model change - restart gateway with new model
  function handleModelChange(newModel: string) {
    // In local-keys mode, warn if switching providers (container restart interrupts running tasks)
    if (useLocalKeys && gatewayRunning) {
      const oldProvider = selectedModel.split("/")[0];
      const newProvider = newModel.split("/")[0];
      if (oldProvider !== newProvider) {
        setProviderSwitchConfirm({ oldProvider, newProvider, newModel });
        return;
      }
    }
    executeModelChange(newModel);
  }

  // Handle confirmed provider switch (called from confirmation modal)
  async function executeModelChange(newModel: string) {
    setProviderSwitchConfirm(null);
    setSelectedModel(newModel);

    // Save preference
    try {
      const store = await TauriStore.load("entropic-settings.json");
      await store.set("selectedModel", newModel);
      await store.save();
    } catch (error) {
      console.error("[Entropic] Failed to save model preference:", error);
    }

    if (!gatewayRunning) return;

    if (
      isAuthConfigured &&
      !useLocalKeys &&
      gatewayTokenRef.current &&
      (isAuthenticated || (localCreditBalanceCents ?? 0) > 0)
    ) {
      // Proxy mode — restart with new model via proxy flow
      setIsTogglingGateway(true);
      try {
        await startGatewayProxyFlow({
          model: newModel,
          image: imageModel,
          stopFirst: true,
          allowRetry: true,
        });
      } catch (error) {
        console.error("[Entropic] Failed to restart gateway with new model:", error);
      } finally {
        setIsTogglingGateway(false);
      }
    } else if (useLocalKeys) {
      const oldProvider = selectedModel.split("/")[0];
      const newProvider = newModel.split("/")[0];
      if (oldProvider !== newProvider) {
        // Provider switch — full container restart needed (different API keys/env vars)
        console.log("[Entropic] Provider switch in local-keys mode, restarting gateway with:", newModel);
        setShowGatewayStartup(true);
        setGatewayStartupStage("launch");
        setIsTogglingGateway(true);
        try {
          await invoke("restart_gateway", { model: newModel });
          setGatewayStartupStage("health");
          await new Promise((r) => setTimeout(r, 2000));
          await checkGateway();
        } catch (error) {
          console.error("[Entropic] Failed to restart gateway with new model:", error);
        } finally {
          setIsTogglingGateway(false);
          setShowGatewayStartup(false);
        }
      } else {
        // Same provider — hot-swap model in config (no container restart)
        console.log("[Entropic] Same-provider model change, hot-swapping to:", newModel);
        try {
          await invoke("update_gateway_model", { model: newModel });
        } catch (error) {
          console.error("[Entropic] Failed to hot-swap model:", error);
        }
      }
    }
  }

  function renderChatPage() {
    const gatewayStarting =
      showGatewayStartup || (isTogglingGateway && !gatewayRunning) || gatewayRetryIn !== null;
    return (
      <Chat
        isVisible={currentPage === "chat"}
        gatewayRunning={gatewayRunning}
        gatewayStarting={gatewayStarting}
        gatewayRetryIn={gatewayRetryIn}
        onStartGateway={startGatewayFromChat}
        onRecoverProxyAuth={recoverProxyAuthFromChat}
        useLocalKeys={useLocalKeys}
        selectedModel={selectedModel}
        onModelChange={handleModelChange}
        imageModel={imageModel}
        integrationsSyncing={integrationsSyncing}
        integrationsMissing={integrationsMissing}
        onNavigate={setCurrentPage}
        onSessionsChange={(sessions, currentKey) => {
          setChatSessions((prev) => {
            // Guard against transient empty snapshots while chat state is still rehydrating.
            if (sessions.length === 0 && prev.length > 0 && currentPage !== "chat") {
              return prev;
            }
            return sessions;
          });
          setCurrentChatSession((prev) => currentKey ?? prev);
          setPendingChatSession((pending) => {
            if (!pending) return pending;
            if (pending === "__new__") {
              return currentKey ? null : pending;
            }
            return pending === currentKey ? null : pending;
          });
          setPendingChatAction(null);
        }}
        requestedSession={pendingChatSession}
        requestedSessionAction={pendingChatAction}
      />
    );
  }

  function renderPage() {
    switch (currentPage) {
      case "chat":
        return null;
      case "store":
      case "skills":
        return (
          <Store
            integrationsSyncing={integrationsSyncing}
            integrationsMissing={integrationsMissing}
            onNavigate={(page) => setCurrentPage(page)}
          />
        );
      case "channels":
        return <Channels />;
      case "files":
        return (
          <Files
            gatewayRunning={gatewayRunning}
            gatewayRetryIn={gatewayRetryIn}
            integrationsSyncing={integrationsSyncing}
            integrationsMissing={integrationsMissing}
            onGatewayToggle={toggleGateway}
            onRecoverProxyAuth={recoverProxyAuthFromChat}
            isTogglingGateway={isTogglingGateway}
            selectedModel={selectedModel}
            onModelChange={setSelectedModel}
            useLocalKeys={useLocalKeys}
            onUseLocalKeysChange={setUseLocalKeys}
            codeModel={codeModel}
            imageModel={imageModel}
            onCodeModelChange={setCodeModel}
            onImageModelChange={setImageModel}
          />
        );
      case "tasks":
        return <Tasks gatewayRunning={gatewayRunning} />;
      case "jobs":
        return <Jobs gatewayRunning={gatewayRunning} />;
      case "billing":
        return <BillingPage />;
      case "settings":
        return (
          <Settings
            gatewayRunning={gatewayRunning}
            onGatewayToggle={toggleGateway}
            isTogglingGateway={isTogglingGateway}
            selectedModel={selectedModel}
            onModelChange={handleModelChange}
            useLocalKeys={useLocalKeys}
            onUseLocalKeysChange={async (value) => {
              // Reset the auto-start guard and block the effect from running
              // until we're fully done stopping/saving. This must happen before
              // any awaits so the effect can't race ahead and see a stale guard.
              autoStartAttemptedRef.current = false;
              setIsTogglingGateway(true);
              setUseLocalKeys(value);

              // Reset model if current selection doesn't exist in the target mode
              const validIds = value ? LOCAL_MODEL_IDS : PROXY_MODEL_IDS;
              const newModel = validIds.has(selectedModel)
                ? selectedModel
                : value ? DEFAULT_LOCAL_MODEL : DEFAULT_PROXY_MODEL;
              if (newModel !== selectedModel) {
                setSelectedModel(newModel);
              }

              try {
                const store = await TauriStore.load("entropic-settings.json");
                await store.set("useLocalKeys", value);
                await store.set("selectedModel", newModel);
                await store.save();
              } catch (error) {
                console.error("[Entropic] Failed to save useLocalKeys:", error);
              }

              // Stop existing container — the auto-start effect will restart
              // in the correct mode once isTogglingGateway is cleared.
              if (gatewayRunning) {
                try {
                  await invoke("stop_gateway");
                } catch (error) {
                  console.error("[Entropic] Failed to stop gateway:", error);
                }
                setGatewayRunning(false);
              }

              // Unblock the auto-start effect — it will now re-run with the
              // new useLocalKeys value and autoStartAttemptedRef = false.
              setIsTogglingGateway(false);
            }}
            codeModel={codeModel}
            imageModel={imageModel}
            onCodeModelChange={async (value) => {
              setCodeModel(value);
              try {
                const store = await TauriStore.load("entropic-settings.json");
                await store.set("codeModel", value);
                await store.save();
              } catch (error) {
                console.error("[Entropic] Failed to save codeModel:", error);
              }
            }}
            onImageModelChange={async (value) => {
              setImageModel(value);
              try {
                const store = await TauriStore.load("entropic-settings.json");
                await store.set("imageModel", value);
                await store.save();
              } catch (error) {
                console.error("[Entropic] Failed to save imageModel:", error);
              }

              if (
                gatewayRunning &&
                isAuthConfigured &&
                !useLocalKeys &&
                gatewayTokenRef.current &&
                (isAuthenticated || (localCreditBalanceCents ?? 0) > 0)
              ) {
                try {
                  await startGatewayProxyFlow({
                    model: selectedModel,
                    image: value,
                    stopFirst: true,
                    allowRetry: true,
                  });
                } catch (error) {
                  console.error("[Entropic] Failed to restart gateway with new image model:", error);
                }
              }
            }}
          />
        );
      default:
        return null;
    }
  }

  return (
    <Layout
      currentPage={currentPage}
      onNavigate={setCurrentPage}
      onOpenFeedback={() => {
        void openFeedbackPage();
      }}
      gatewayRunning={gatewayRunning}
      integrationsSyncing={integrationsSyncing}
      chatSessions={chatSessions}
      currentChatSession={currentChatSession}
      onSelectChatSession={(key) => {
        setPendingChatSession(key);
        setCurrentChatSession(key);
        setCurrentPage("chat");
      }}
      onNewChat={() => {
        setPendingChatSession("__new__");
        setCurrentPage("chat");
      }}
      onChatSessionAction={(action) => {
        setPendingChatAction({ id: crypto.randomUUID(), ...action });
        setCurrentPage("chat");
      }}
    >
      {providerSwitchConfirm && (
        <div className="absolute inset-0 z-50 flex items-center justify-center">
          <div className="w-full max-w-sm mx-4 rounded-2xl bg-white border border-[var(--border-subtle)] shadow-xl p-6">
            <h2 className="text-sm font-semibold text-[var(--text-primary)]">Switch provider?</h2>
            <p className="text-xs text-[var(--text-secondary)] mt-2">
              Switching from <strong>{providerSwitchConfirm.oldProvider}</strong> to <strong>{providerSwitchConfirm.newProvider}</strong> will restart the sandbox container. Any running tasks will be interrupted.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                className="rounded-full border border-[var(--border-subtle)] bg-white px-4 py-1.5 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-muted)]"
                onClick={() => setProviderSwitchConfirm(null)}
              >
                Cancel
              </button>
              <button
                className="rounded-full bg-[var(--text-primary)] px-4 py-1.5 text-xs text-white hover:opacity-90"
                onClick={() => executeModelChange(providerSwitchConfirm.newModel)}
              >
                Switch Provider
              </button>
            </div>
          </div>
        </div>
      )}
      {showGatewayStartup && (
        <div className="absolute inset-0 z-50 flex items-center justify-center">
          <div className="w-full max-w-sm mx-4 rounded-2xl bg-white border border-[var(--border-subtle)] shadow-xl p-6">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 rounded-full bg-[var(--system-gray-6)] p-2">
                <Loader2 className="w-4 h-4 animate-spin text-[var(--text-primary)]" />
              </div>
              <div>
                <h2 className="text-sm font-semibold text-[var(--text-primary)]">
                  {gatewayRetryIn ? "Reconnecting Sandbox" : "Starting Secure Sandbox"}
                </h2>
                <p className="text-xs text-[var(--text-secondary)] mt-1 leading-relaxed">
                  {gatewayRetryIn
                    ? `Retrying in ${gatewayRetryIn}s. We’ll keep trying until the environment is ready.`
                    : "Entropic is initializing an isolated environment to safely run tools and plugins."}
                </p>
              </div>
            </div>

            <div className="mt-5 rounded-xl border border-violet-100 bg-violet-50/70 p-4">
              <div className="text-[10px] uppercase tracking-wider text-violet-700 font-bold mb-2">
                Did you know?
              </div>
              <div className="text-xs leading-relaxed text-violet-900 font-medium">
                {SANDBOX_STARTUP_FACTS[startupFactIndex]}
              </div>
            </div>

            <div className="mt-6 pt-4 border-t border-[var(--border-subtle)]">
              <div className="flex items-center justify-between text-[10px] text-[var(--text-tertiary)] uppercase tracking-widest font-semibold mb-3">
                System Status
                {gatewayStartupStage === "health" ? (
                  <span className="text-green-600">Ready</span>
                ) : (
                  <span className="animate-pulse">Initializing...</span>
                )}
              </div>
              <div className="space-y-2.5">
                <div className="flex items-center gap-2.5 text-[11px] text-[var(--text-secondary)]">
                  {gatewayStartupStage === "credits" || gatewayStartupStage === "token" ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-violet-500" />
                  ) : gatewayStartupStage === "launch" || gatewayStartupStage === "health" ? (
                    <CheckCircle2 className="w-3.5 h-3.5 text-green-600" />
                  ) : (
                    <div className="w-3.5 h-3.5 rounded-full border border-[var(--border-subtle)]" />
                  )}
                  <span className={gatewayStartupStage === "credits" || gatewayStartupStage === "token" ? "font-medium text-[var(--text-primary)]" : ""}>
                    Securing gateway credentials
                  </span>
                </div>
                <div className="flex items-center gap-2.5 text-[11px] text-[var(--text-secondary)]">
                  {gatewayStartupStage === "launch" ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-violet-500" />
                  ) : gatewayStartupStage === "health" ? (
                    <CheckCircle2 className="w-3.5 h-3.5 text-green-600" />
                  ) : (
                    <div className="w-3.5 h-3.5 rounded-full border border-[var(--border-subtle)]" />
                  )}
                  <span className={gatewayStartupStage === "launch" ? "font-medium text-[var(--text-primary)]" : ""}>
                    Provisioning isolated container
                  </span>
                </div>
                <div className="flex items-center gap-2.5 text-[11px] text-[var(--text-secondary)]">
                  {gatewayStartupStage === "health" ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-violet-500" />
                  ) : (
                    <div className="w-3.5 h-3.5 rounded-full border border-[var(--border-subtle)]" />
                  )}
                  <span className={gatewayStartupStage === "health" ? "font-medium text-[var(--text-primary)]" : ""}>
                    Verifying sandbox health
                  </span>
                </div>
              </div>
            </div>
            {!gatewayRetryIn && (
              <div className="mt-4 text-[10px] text-[var(--text-tertiary)] text-center italic">
                First-time setup may take a few seconds.
              </div>
            )}
            {startupError && (
              <div className="mt-3 text-xs text-red-600">
                {startupError.message}
                {startupError.actions && startupError.actions.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {startupError.actions.map((action) => (
                      <button
                        key={action.label}
                        className="rounded-full border border-[var(--border-subtle)] bg-white px-3 py-1 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-muted)]"
                        onClick={action.onClick}
                      >
                        {action.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
      {!showGatewayStartup && startupError && (
        <div className="absolute right-4 top-4 z-40 w-[min(28rem,calc(100%-2rem))] rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800 shadow-lg">
          <div className="font-medium">Gateway Start Failed</div>
          <div className="mt-1 text-xs">{startupError.message}</div>
          <div className="mt-3 flex flex-wrap gap-2">
            {startupError.actions && startupError.actions.length > 0 && startupError.actions.map((action) => (
              <button
                key={action.label}
                className="rounded-full border border-red-200 bg-white px-3 py-1 text-xs text-red-700 hover:bg-red-100"
                onClick={action.onClick}
              >
                {action.label}
              </button>
            ))}
            <button
              className="rounded-full border border-red-200 bg-white px-3 py-1 text-xs text-red-700 hover:bg-red-100"
              onClick={() => setStartupError(null)}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
      <div className={currentPage === "chat" ? "h-full" : "hidden"} aria-hidden={currentPage !== "chat"}>
        {renderChatPage()}
      </div>
      {renderPage()}
    </Layout>
  );
}
