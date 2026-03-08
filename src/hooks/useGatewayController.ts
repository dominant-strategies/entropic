import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Store as TauriStore } from "@tauri-apps/plugin-store";
import { ApiRequestError, createGatewayToken, getBalance, getProxyUrl } from "../lib/auth";
import { getLocalCreditBalance } from "../lib/localCredits";
import {
  getCachedIntegrationProviders,
  hasPendingIntegrationImports,
  startIntegrationRefreshLoop,
  stopIntegrationRefreshLoop,
  syncAllIntegrationsToGateway,
  syncPendingIntegrationImports,
} from "../lib/integrations";
import { getGatewayStatusCached } from "../lib/gateway-status";
import { LOCAL_MODEL_IDS, PROXY_MODEL_IDS } from "../components/ModelSelector";
import type { Page } from "../components/Layout";

const DEFAULT_PROXY_MODEL = "openai/gpt-5.4";
const DEFAULT_LOCAL_MODEL = "anthropic/claude-opus-4-6:thinking";
const GATEWAY_FAILURE_THRESHOLD = 3;
const SANDBOX_STARTUP_FACTS = [
  "Secure Execution: Entropic runs all shell commands in an isolated sandbox to protect your local system.",
  "Custom Providers: Add your own API keys in Settings for direct access to the latest models.",
  "Deep Context: Stage logs or documentation in Files so Entropic can analyze them with full technical detail.",
  "Tasks + Jobs: Plan and track work in Tasks, then automate routines from Jobs.",
  "Codebase Awareness: Ask Entropic to read the repo to generate precise implementation roadmaps.",
  "Seamless Integrations: Connect GitHub, Slack, or Linear via Integrations to extend Entropic's capabilities.",
  "One-click Workflow: Quickly initialize projects or deploy environments with a single command.",
];

export type GatewayStartupStage = "idle" | "credits" | "token" | "launch" | "health";

export type GatewayStartupError = {
  message: string;
  actions?: Array<{ label: string; onClick: () => void }>;
} | null;

export type ProviderSwitchConfirm = {
  oldProvider: string;
  newProvider: string;
  newModel: string;
} | null;

type UseGatewayControllerArgs = {
  isAuthenticated: boolean;
  isAuthConfigured: boolean;
  refreshBalance: () => void | Promise<void>;
  onNavigate: (page: Page) => void;
  onRequestSignIn: () => void;
};

async function saveSetting(key: string, value: unknown): Promise<void> {
  const store = await TauriStore.load("entropic-settings.json");
  await store.set(key, value);
  await store.save();
}

export function useGatewayController({
  isAuthenticated,
  isAuthConfigured,
  refreshBalance,
  onNavigate,
  onRequestSignIn,
}: UseGatewayControllerArgs) {
  const [useLocalKeys, setUseLocalKeys] = useState(false);
  const [gatewayRunning, setGatewayRunning] = useState(false);
  const [isTogglingGateway, setIsTogglingGateway] = useState(false);
  const [showGatewayStartup, setShowGatewayStartup] = useState(false);
  const [gatewayStartupStage, setGatewayStartupStage] =
    useState<GatewayStartupStage>("idle");
  const [startupError, setStartupError] = useState<GatewayStartupError>(null);
  const [gatewayRetryIn, setGatewayRetryIn] = useState<number | null>(null);
  const [startupFactIndex, setStartupFactIndex] = useState(0);
  const [integrationsSyncing, setIntegrationsSyncing] = useState(false);
  const [integrationsMissing, setIntegrationsMissing] = useState(false);
  const [prefsLoaded, setPrefsLoaded] = useState(false);
  const [selectedModel, setSelectedModel] = useState(DEFAULT_PROXY_MODEL);
  const [codeModel, setCodeModel] = useState("openai/gpt-5.3-codex");
  const [imageModel, setImageModel] = useState("google/gemini-3.1-flash-image-preview");
  const [experimentalDesktop, setExperimentalDesktop] = useState(false);
  const [localCreditBalanceCents, setLocalCreditBalanceCents] = useState<number | null>(null);
  const [providerSwitchConfirm, setProviderSwitchConfirm] =
    useState<ProviderSwitchConfirm>(null);

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
  const gatewayHealthFailureStreakRef = useRef(0);

  function buildOutOfCreditsStartupError() {
    if (isAuthenticated) {
      return {
        message: "You’re out of credits. Add credits to continue using Entropic in proxy mode.",
        actions: [{ label: "Add Credits", onClick: () => onNavigate("billing") }],
      };
    }
    return {
      message: "You’ve used all free trial credits. Sign in to continue and add paid credits.",
      actions: [
        { label: "Sign In", onClick: onRequestSignIn },
        { label: "Billing", onClick: () => onNavigate("billing") },
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

  useEffect(() => {
    async function loadPrefs() {
      try {
        const store = await TauriStore.load("entropic-settings.json");
        const storedUseLocal = (await store.get("useLocalKeys")) as boolean | null;
        if (typeof storedUseLocal === "boolean") setUseLocalKeys(storedUseLocal);
        const isLocal = storedUseLocal === true;

        const saved = (await store.get("selectedModel")) as string | null;
        if (saved) {
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

        const savedCode = (await store.get("codeModel")) as string | null;
        if (savedCode) setCodeModel(savedCode);
        const savedImage = (await store.get("imageModel")) as string | null;
        if (savedImage) setImageModel(savedImage);
        const savedExperimentalDesktop = (await store.get("experimentalDesktop")) as boolean | null;
        if (typeof savedExperimentalDesktop === "boolean") {
          setExperimentalDesktop(savedExperimentalDesktop);
        }
      } catch (error) {
        console.error("[Entropic] Failed to load gateway preferences:", error);
      } finally {
        setPrefsLoaded(true);
      }
    }

    void loadPrefs();
  }, []);

  useEffect(() => {
    if (isAuthenticated || !isAuthConfigured) {
      setLocalCreditBalanceCents(null);
      return;
    }

    void refreshLocalCredits();
    const onLocalCreditsChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ balanceCents?: number }>).detail;
      if (detail && typeof detail.balanceCents === "number") {
        setLocalCreditBalanceCents(detail.balanceCents);
      } else {
        void refreshLocalCredits();
      }
      if (isAuthenticated) {
        void refreshBalance();
      }
    };

    window.addEventListener(
      "entropic-local-credits-changed",
      onLocalCreditsChanged as EventListener,
    );
    const pollInterval = window.setInterval(() => {
      void refreshLocalCredits();
    }, 30 * 60 * 1000);

    return () => {
      window.removeEventListener(
        "entropic-local-credits-changed",
        onLocalCreditsChanged as EventListener,
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
    void checkGateway();
    const interval = window.setInterval(() => {
      void checkGateway();
    }, intervalMs);
    return () => window.clearInterval(interval);
  }, [gatewayRunning, showGatewayStartup, isTogglingGateway]);

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
      } catch (error) {
        console.warn("[Entropic] Failed to sync integration tokens:", error);
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

    void syncOnce();
    intervalId = window.setInterval(() => {
      void syncOnce();
    }, 10_000);
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
    const delayMs = Math.min(30_000, 1000 * 2 ** attempt);
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
    if (error instanceof Error) return error.message || "Failed to start gateway";
    if (typeof error === "string") return error;

    const candidate =
      error &&
      typeof error === "object" &&
      ("message" in error || "error" in error)
        ? (error as Record<string, unknown>)
        : null;
    if (candidate) {
      const message = candidate.message;
      const nestedError = candidate.error;
      if (typeof message === "string" && message.trim()) return message.trim();
      if (typeof nestedError === "string" && nestedError.trim()) return nestedError.trim();
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

  async function persistExperimentalDesktop(value: boolean) {
    setExperimentalDesktop(value);
    try {
      await saveSetting("experimentalDesktop", value);
    } catch (error) {
      console.error("[Entropic] Failed to save experimentalDesktop:", error);
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
    if (!isAuthConfigured || useLocalKeys) {
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
      while (startGatewayInFlightRef.current) {
        await new Promise((resolve) => setTimeout(resolve, 120));
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
        } else if (anonymousBalanceCents <= 0) {
          setStartupError(buildOutOfCreditsStartupError());
          setShowGatewayStartup(false);
          return false;
        }
      } catch (error) {
        console.warn("[Entropic] Balance check failed:", error);
      }

      setGatewayStartupStage("token");
      const { token } = await createGatewayToken({
        allowAnonymous: !isAuthenticated,
      });
      gatewayTokenRef.current = token;

      setGatewayStartupStage("launch");
      await invoke("start_gateway_with_proxy", {
        gatewayToken: token,
        proxyUrl: getProxyUrl(),
        model: normalizeProxyModel(model),
        imageModel: normalizeProxyModel(image),
      });

      setGatewayStartupStage("health");
      if (startGatewayAttemptRef.current !== attemptId) {
        return false;
      }

      const healthStart = Date.now();
      let wsReady = false;
      while (Date.now() - healthStart < 90_000) {
        if (startGatewayAttemptRef.current !== attemptId) {
          return false;
        }
        const ok = await getGatewayStatusCached({ force: true });
        if (ok) {
          wsReady = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }

      if (!wsReady) {
        throw new Error(
          "Gateway started but did not become healthy within 90 s. Please try again.",
        );
      }

      gatewayHealthFailureStreakRef.current = 0;
      setGatewayRunning(true);
      runtimeAutoRefreshAttemptedRef.current = false;
      clearGatewayRetry();
      setStartupError(null);
      setGatewayStartupStage("idle");
      setShowGatewayStartup(false);
      return true;
    } catch (error) {
      if (startGatewayAttemptRef.current !== attemptId) {
        return false;
      }

      const isApiError = error instanceof ApiRequestError;
      const status = isApiError ? error.status : undefined;
      const message = extractGatewayStartError(error);
      const isNetwork =
        (isApiError && error.kind === "network") ||
        /load failed|failed to fetch|network/i.test(message);

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
                actions: [{ label: "Open Settings", onClick: () => onNavigate("settings") }],
              }
            : {
                message: "Trial session expired. Sign in to continue.",
                actions: [{ label: "Sign In", onClick: onRequestSignIn }],
              },
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
            {
              label: "Retry",
              onClick: () => {
                void startGatewayProxyFlow({
                  model,
                  image,
                  stopFirst,
                  allowRetry: false,
                });
              },
            },
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
            { label: "Open Settings", onClick: () => onNavigate("settings") },
            {
              label: "Retry",
              onClick: () => {
                void startGatewayProxyFlow({
                  model,
                  image,
                  stopFirst: false,
                  allowRetry: false,
                });
              },
            },
          ],
        });
        clearGatewayRetry();
        setGatewayStartupStage("idle");
        setShowGatewayStartup(false);
        return false;
      }

      setStartupError({ message });
      const refreshedRuntime = allowRetry ? await tryAutoRefreshRuntime(message) : false;
      if (allowRetry) {
        scheduleGatewayRetry(() => {
          void startGatewayProxyFlow({
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

  useEffect(() => {
    if (!prefsLoaded) return;
    if (!isAuthenticated && isAuthConfigured && !useLocalKeys && localCreditBalanceCents === null) {
      return;
    }

    async function autoStartGateway() {
      const proxyEnabled =
        isAuthConfigured &&
        !useLocalKeys &&
        (isAuthenticated || (localCreditBalanceCents ?? 0) > 0);

      if (
        autoStartAttemptedRef.current ||
        gatewayRunning ||
        isTogglingGateway ||
        gatewayRetryIn !== null
      ) {
        return;
      }

      const alreadyRunning = await getGatewayStatusCached({ force: true });
      if (alreadyRunning) {
        autoStartAttemptedRef.current = true;
        gatewayHealthFailureStreakRef.current = 0;
        clearGatewayRetry();
        setStartupError(null);
        setGatewayStartupStage("idle");
        setShowGatewayStartup(false);

        if (proxyEnabled) {
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
          setShowGatewayStartup(true);
          setGatewayStartupStage("launch");
          setIsTogglingGateway(true);
          try {
            await invoke("stop_gateway");
            await invoke("start_gateway", { model: selectedModel });
            setGatewayStartupStage("health");
            await new Promise((resolve) => setTimeout(resolve, 2000));
            await checkGateway();
          } catch (error) {
            console.error("[Entropic] Auto-start local restart failed:", error);
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
        setIsTogglingGateway(true);
        try {
          await startGatewayProxyFlow({
            model: selectedModel,
            image: imageModel,
            stopFirst: false,
            allowRetry: true,
          });
        } catch (error) {
          console.error("[Entropic] Auto-start proxy error:", error);
        } finally {
          setIsTogglingGateway(false);
        }
      } else if (useLocalKeys) {
        setShowGatewayStartup(true);
        setGatewayStartupStage("launch");
        setIsTogglingGateway(true);
        try {
          await invoke("start_gateway", { model: selectedModel });
          setGatewayStartupStage("health");
          await new Promise((resolve) => setTimeout(resolve, 2000));
          await checkGateway();
        } catch (error) {
          console.error("[Entropic] Auto-start local mode error:", error);
        } finally {
          setIsTogglingGateway(false);
          setShowGatewayStartup(false);
        }
      }
    }

    void autoStartGateway();
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
        setGatewayStartupStage("idle");
        setShowGatewayStartup(false);
        clearGatewayRetry();
        return true;
      }

      gatewayHealthFailureStreakRef.current += 1;
      const failureStreak = gatewayHealthFailureStreakRef.current;
      if (gatewayRunning && failureStreak < GATEWAY_FAILURE_THRESHOLD) {
        return true;
      }

      setGatewayRunning(false);
      return false;
    } catch (error) {
      console.error("[Entropic] Gateway check failed:", error);
      gatewayHealthFailureStreakRef.current += 1;
      const failureStreak = gatewayHealthFailureStreakRef.current;
      if (gatewayRunning && failureStreak < GATEWAY_FAILURE_THRESHOLD) {
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
        await invoke("stop_gateway");
        gatewayHealthFailureStreakRef.current = 0;
        autoStartAttemptedRef.current = false;
        setGatewayRunning(false);
      } else {
        gatewayHealthFailureStreakRef.current = 0;
        setGatewayRunning(false);
        const proxyEnabled =
          isAuthConfigured &&
          !useLocalKeys &&
          (isAuthenticated || (localCreditBalanceCents ?? 0) > 0);

        if (proxyEnabled) {
          const started = await startGatewayProxyFlow({
            model: selectedModel,
            image: imageModel,
            stopFirst: false,
            allowRetry: false,
          });
          if (!started) {
            return;
          }
        } else if (isAuthConfigured && !useLocalKeys) {
          setStartupError(buildOutOfCreditsStartupError());
          return;
        } else {
          await invoke("start_gateway", { model: selectedModel });
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 2000));
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
      (!isAuthenticated && (localCreditBalanceCents ?? 0) <= 0) ||
      isTogglingGateway
    ) {
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
      await new Promise((resolve) => setTimeout(resolve, 1200));
      await checkGateway();
      return started;
    } catch (error) {
      console.error("[Entropic] Proxy auth recovery failed:", error);
      return false;
    } finally {
      setIsTogglingGateway(false);
    }
  }

  function handleModelChange(newModel: string) {
    if (useLocalKeys && gatewayRunning) {
      const oldProvider = selectedModel.split("/")[0];
      const newProvider = newModel.split("/")[0];
      if (oldProvider !== newProvider) {
        setProviderSwitchConfirm({ oldProvider, newProvider, newModel });
        return;
      }
    }
    void executeModelChange(newModel);
  }

  async function executeModelChange(newModel: string) {
    setProviderSwitchConfirm(null);
    setSelectedModel(newModel);

    try {
      await saveSetting("selectedModel", newModel);
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
        setShowGatewayStartup(true);
        setGatewayStartupStage("launch");
        setIsTogglingGateway(true);
        try {
          await invoke("restart_gateway", { model: newModel });
          setGatewayStartupStage("health");
          await new Promise((resolve) => setTimeout(resolve, 2000));
          await checkGateway();
        } catch (error) {
          console.error("[Entropic] Failed to restart gateway with new model:", error);
        } finally {
          setIsTogglingGateway(false);
          setShowGatewayStartup(false);
        }
      } else {
        try {
          await invoke("update_gateway_model", { model: newModel });
        } catch (error) {
          console.error("[Entropic] Failed to hot-swap model:", error);
        }
      }
    }
  }

  async function confirmProviderSwitch() {
    if (!providerSwitchConfirm) return;
    await executeModelChange(providerSwitchConfirm.newModel);
  }

  function cancelProviderSwitch() {
    setProviderSwitchConfirm(null);
  }

  async function onUseLocalKeysChange(value: boolean) {
    autoStartAttemptedRef.current = false;
    setIsTogglingGateway(true);
    setUseLocalKeys(value);

    const validIds = value ? LOCAL_MODEL_IDS : PROXY_MODEL_IDS;
    const newModel = validIds.has(selectedModel)
      ? selectedModel
      : value
        ? DEFAULT_LOCAL_MODEL
        : DEFAULT_PROXY_MODEL;
    if (newModel !== selectedModel) {
      setSelectedModel(newModel);
    }

    try {
      await saveSetting("useLocalKeys", value);
      await saveSetting("selectedModel", newModel);
    } catch (error) {
      console.error("[Entropic] Failed to save useLocalKeys:", error);
    }

    if (gatewayRunning) {
      try {
        await invoke("stop_gateway");
      } catch (error) {
        console.error("[Entropic] Failed to stop gateway:", error);
      }
      setGatewayRunning(false);
    }

    setIsTogglingGateway(false);
  }

  async function onCodeModelChange(value: string) {
    setCodeModel(value);
    try {
      await saveSetting("codeModel", value);
    } catch (error) {
      console.error("[Entropic] Failed to save codeModel:", error);
    }
  }

  async function onImageModelChange(value: string) {
    setImageModel(value);
    try {
      await saveSetting("imageModel", value);
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
  }

  return {
    codeModel,
    experimentalDesktop,
    gatewayRetryIn,
    gatewayRunning,
    gatewayStarting:
      showGatewayStartup || (isTogglingGateway && !gatewayRunning) || gatewayRetryIn !== null,
    gatewayStartupStage,
    handleModelChange,
    imageModel,
    integrationsMissing,
    integrationsSyncing,
    isTogglingGateway,
    onCodeModelChange,
    onExperimentalDesktopChange: persistExperimentalDesktop,
    onImageModelChange,
    onUseLocalKeysChange,
    providerSwitchConfirm,
    recoverProxyAuthFromChat,
    selectedModel,
    showGatewayStartup,
    startGatewayFromChat,
    startupError,
    startupFact: SANDBOX_STARTUP_FACTS[startupFactIndex],
    toggleGateway,
    useLocalKeys,
    clearStartupError: () => setStartupError(null),
    confirmProviderSwitch,
    cancelProviderSwitch,
  };
}
