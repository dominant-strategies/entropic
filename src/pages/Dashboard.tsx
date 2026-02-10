import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Loader2 } from "lucide-react";
import { Layout, Page } from "../components/Layout";
import { Chat, type ChatSession } from "./Chat";
import { Store } from "./Store";
import { Channels } from "./Channels";
import { Files } from "./Files";
import { Tasks } from "./Tasks";
import { Logs } from "./Logs";
import { BillingPage } from "./BillingPage";
import { Settings } from "./Settings";
import { useAuth } from "../contexts/AuthContext";
import { createGatewayToken, getProxyUrl } from "../lib/auth";
import {
  hasPendingIntegrationImports,
  syncPendingIntegrationImports,
  syncAllIntegrationsToGateway,
  getCachedIntegrationProviders,
  startIntegrationRefreshLoop,
  stopIntegrationRefreshLoop,
} from "../lib/integrations";
import { getGatewayStatusCached } from "../lib/gateway-status";
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

// Default model for proxy mode
const DEFAULT_MODEL = "openai/gpt-5.2";

export function Dashboard({ status: _status, onRefresh: _onRefresh }: Props) {
  const { isAuthenticated, isAuthConfigured } = useAuth();
  const [useLocalKeys, setUseLocalKeys] = useState(false);
  const [currentPage, setCurrentPage] = useState<Page>("files");
  const [gatewayRunning, setGatewayRunning] = useState(false);
  const [isTogglingGateway, setIsTogglingGateway] = useState(false);
  const [showGatewayStartup, setShowGatewayStartup] = useState(false);
  const [startupError, setStartupError] = useState<string | null>(null);
  const [gatewayRetryIn, setGatewayRetryIn] = useState<number | null>(null);
  const [integrationsSyncing, setIntegrationsSyncing] = useState(false);
  const [integrationsMissing, setIntegrationsMissing] = useState(false);
  const [selectedModel, setSelectedModel] = useState(DEFAULT_MODEL);
  const [codeModel, setCodeModel] = useState("openai/gpt-5.2-codex");
  const [imageModel, setImageModel] = useState("google/gemini-3-pro-image-preview");
  const [chatSessions, setChatSessions] = useState<ChatSession[]>([]);
  const [currentChatSession, setCurrentChatSession] = useState<string | null>(null);
  const [pendingChatSession, setPendingChatSession] = useState<string | null>(null);
  const gatewayTokenRef = useRef<string | null>(null);
  const autoStartAttemptedRef = useRef(false);
  const retryAttemptRef = useRef(0);
  const retryTimeoutRef = useRef<number | null>(null);
  const retryIntervalRef = useRef<number | null>(null);
  const fullSyncRef = useRef(false);

  // Load saved model preference
  useEffect(() => {
    async function loadModel() {
      try {
        const store = await TauriStore.load("nova-settings.json");
        const saved = await store.get("selectedModel") as string | null;
        if (saved) setSelectedModel(saved);
        const storedUseLocal = await store.get("useLocalKeys") as boolean | null;
        if (typeof storedUseLocal === "boolean") setUseLocalKeys(storedUseLocal);
        const savedCode = await store.get("codeModel") as string | null;
        if (savedCode) setCodeModel(savedCode);
        const savedImage = await store.get("imageModel") as string | null;
        if (savedImage) setImageModel(savedImage);
      } catch (error) {
        console.error("[Nova] Failed to load model preference:", error);
      }
    }
    loadModel();
  }, []);

  useEffect(() => {
    const intervalMs =
      gatewayRunning && !showGatewayStartup && !isTogglingGateway ? 15_000 : 5_000;
    checkGateway();
    const interval = window.setInterval(checkGateway, intervalMs);
    return () => window.clearInterval(interval);
  }, [gatewayRunning, showGatewayStartup, isTogglingGateway]);

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
        console.warn("[Nova] Failed to sync integration tokens:", err);
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
    console.log("[Nova] startGatewayProxyFlow called with:", {
      model,
      image,
      stopFirst,
      allowRetry,
      isAuthConfigured,
      isAuthenticated,
      useLocalKeys
    });

    if (!isAuthConfigured || !isAuthenticated || useLocalKeys) {
      console.log("[Nova] Skipping proxy flow - auth not ready or using local keys");
      return false;
    }

    setStartupError(null);
    setShowGatewayStartup(true);
    setGatewayRunning(false);
    try {
      if (stopFirst) {
        try {
          await invoke("stop_gateway");
        } catch (error) {
          console.error("[Nova] Failed to stop gateway:", error);
        }
      }

      console.log("[Nova] Creating gateway token...");
      const { token } = await createGatewayToken();
      gatewayTokenRef.current = token;
      console.log("[Nova] Gateway token created successfully");

      const proxyUrl = getProxyUrl();
      const proxyModel = normalizeProxyModel(model);
      const proxyImageModel = normalizeProxyModel(image);
      console.log("[Nova] Proxy configuration:", {
        proxyUrl,
        proxyModel,
        proxyImageModel
      });

      console.log("[Nova] Invoking start_gateway_with_proxy...");
      await invoke("start_gateway_with_proxy", {
        gatewayToken: token,
        proxyUrl,
        model: proxyModel,
        imageModel: proxyImageModel,
      });
      console.log("[Nova] start_gateway_with_proxy completed");

      await new Promise((r) => setTimeout(r, 2000));
      await checkGateway();
      clearGatewayRetry();
      return true;
    } catch (error) {
      console.error("[Nova] Proxy start failed:", error);
      setStartupError(error instanceof Error ? error.message : "Failed to start gateway");
      if (allowRetry) {
        scheduleGatewayRetry(() => {
          startGatewayProxyFlow({ model, image, stopFirst, allowRetry });
        });
      } else {
        setShowGatewayStartup(false);
      }
      return false;
    }
  }

  // Auto-start gateway for authenticated users
  useEffect(() => {
    async function autoStartGateway() {
      const proxyEnabled = isAuthConfigured && isAuthenticated && !useLocalKeys;
      console.log("[Nova] Auto-start check:", {
        isAuthConfigured,
        isAuthenticated,
        useLocalKeys,
        proxyEnabled,
        gatewayRunning,
        isTogglingGateway,
        gatewayRetryIn,
        autoStartAttempted: autoStartAttemptedRef.current
      });

      // Only attempt auto-start once, when authenticated via OAuth
      if (
        !autoStartAttemptedRef.current &&
        proxyEnabled &&
        !gatewayRunning &&
        !isTogglingGateway &&
        gatewayRetryIn === null
      ) {
        const alreadyRunning = await getGatewayStatusCached({ force: true });
        if (alreadyRunning) {
          setGatewayRunning(true);
          autoStartAttemptedRef.current = true;
          return;
        }
        autoStartAttemptedRef.current = true;
        console.log("[Nova] Auto-starting gateway for authenticated user...");

        setIsTogglingGateway(true);
        try {
          const result = await startGatewayProxyFlow({
            model: selectedModel,
            image: imageModel,
            stopFirst: false,
            allowRetry: true,
          });
          console.log("[Nova] Auto-start result:", result);
        } catch (error) {
          console.error("[Nova] Auto-start error:", error);
        } finally {
          setIsTogglingGateway(false);
        }
      }
    }

    autoStartGateway();
  }, [isAuthenticated, isAuthConfigured, gatewayRunning, isTogglingGateway, selectedModel, gatewayRetryIn, imageModel]);

  async function checkGateway() {
    try {
      const running = await getGatewayStatusCached({ force: true });
      setGatewayRunning(running);
      console.log("[Nova] Gateway health check:", running ? "healthy" : "not responding");
      if (running) {
        setShowGatewayStartup(false);
        clearGatewayRetry();
      }
    } catch (error) {
      console.error("[Nova] Gateway check failed:", error);
      setGatewayRunning(false);
    }
  }

  async function toggleGateway() {
    setIsTogglingGateway(true);
    try {
      if (gatewayRunning) {
        console.log("[Nova] Stopping gateway...");
        await invoke("stop_gateway");
        console.log("[Nova] Gateway stopped successfully");
        setGatewayRunning(false);
      } else {
        console.log("[Nova] Starting gateway...");
        setGatewayRunning(false);
        // If authenticated via OAuth, use proxy mode
        if (isAuthConfigured && isAuthenticated && !useLocalKeys) {
          const started = await startGatewayProxyFlow({
            model: selectedModel,
            image: imageModel,
            stopFirst: false,
            allowRetry: false,
          });
          if (!started) {
            console.error("[Nova] Proxy mode failed, falling back to direct.");
            await invoke("start_gateway");
          }
        } else {
          // Not authenticated, use direct API keys
          await invoke("start_gateway");
        }

        console.log("[Nova] Gateway started successfully");
      }
      await new Promise((r) => setTimeout(r, 2000));
      await checkGateway();
    } catch (error) {
      console.error("[Nova] Failed to toggle gateway:", error);
      setStartupError(error instanceof Error ? error.message : "Failed to toggle gateway");
    } finally {
      setIsTogglingGateway(false);
    }
  }

  async function startGatewayFromChat() {
    if (gatewayRunning || isTogglingGateway) return;
    await toggleGateway();
  }

  // Handle model change - restart gateway with new model
  async function handleModelChange(newModel: string) {
    setSelectedModel(newModel);

    // Save preference
    try {
      const store = await TauriStore.load("nova-settings.json");
      await store.set("selectedModel", newModel);
      await store.save();
    } catch (error) {
      console.error("[Nova] Failed to save model preference:", error);
    }

    // If gateway is running and we're in proxy mode, restart with new model
    if (gatewayRunning && isAuthConfigured && isAuthenticated && !useLocalKeys && gatewayTokenRef.current) {
      setIsTogglingGateway(true);
      try {
        await startGatewayProxyFlow({
          model: newModel,
          image: imageModel,
          stopFirst: true,
          allowRetry: true,
        });
      } catch (error) {
        console.error("[Nova] Failed to restart gateway with new model:", error);
      } finally {
        setIsTogglingGateway(false);
      }
    }
  }

  function renderPage() {
    switch (currentPage) {
      case "chat":
        {
          const gatewayStarting =
            showGatewayStartup || (isTogglingGateway && !gatewayRunning) || gatewayRetryIn !== null;
        return (
          <Chat
            gatewayRunning={gatewayRunning}
            gatewayStarting={gatewayStarting}
            gatewayRetryIn={gatewayRetryIn}
            onStartGateway={startGatewayFromChat}
            useLocalKeys={useLocalKeys}
            selectedModel={selectedModel}
            imageModel={imageModel}
            integrationsSyncing={integrationsSyncing}
            integrationsMissing={integrationsMissing}
            onNavigate={setCurrentPage}
            onSessionsChange={(sessions, currentKey) => {
              setChatSessions(sessions);
              setCurrentChatSession(currentKey);
              setPendingChatSession(null);
            }}
            requestedSession={pendingChatSession}
          />
        );
        }
      case "store":
        return <Store integrationsSyncing={integrationsSyncing} integrationsMissing={integrationsMissing} />;
      case "channels":
        return <Channels />;
      case "files":
        return (
          <Files
            gatewayRunning={gatewayRunning}
            integrationsSyncing={integrationsSyncing}
            integrationsMissing={integrationsMissing}
            onGatewayToggle={toggleGateway}
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
      case "logs":
        return <Logs />;
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
              setUseLocalKeys(value);
              try {
                const store = await TauriStore.load("nova-settings.json");
                await store.set("useLocalKeys", value);
                await store.save();
              } catch (error) {
                console.error("[Nova] Failed to save useLocalKeys:", error);
              }

              if (gatewayRunning) {
                try {
                  await invoke("stop_gateway");
                } catch (error) {
                  console.error("[Nova] Failed to stop gateway:", error);
                }
                await checkGateway();
              }
            }}
            codeModel={codeModel}
            imageModel={imageModel}
            onCodeModelChange={async (value) => {
              setCodeModel(value);
              try {
                const store = await TauriStore.load("nova-settings.json");
                await store.set("codeModel", value);
                await store.save();
              } catch (error) {
                console.error("[Nova] Failed to save codeModel:", error);
              }
            }}
            onImageModelChange={async (value) => {
              setImageModel(value);
              try {
                const store = await TauriStore.load("nova-settings.json");
                await store.set("imageModel", value);
                await store.save();
              } catch (error) {
                console.error("[Nova] Failed to save imageModel:", error);
              }

              if (gatewayRunning && isAuthConfigured && isAuthenticated && !useLocalKeys && gatewayTokenRef.current) {
                try {
                  await startGatewayProxyFlow({
                    model: selectedModel,
                    image: value,
                    stopFirst: true,
                    allowRetry: true,
                  });
                } catch (error) {
                  console.error("[Nova] Failed to restart gateway with new image model:", error);
                }
              }
            }}
          />
        );
    }
  }

  return (
    <Layout
      currentPage={currentPage}
      onNavigate={setCurrentPage}
      gatewayRunning={gatewayRunning}
      integrationsSyncing={integrationsSyncing}
      chatSessions={chatSessions}
      currentChatSession={currentChatSession}
      onSelectChatSession={(key) => {
        setPendingChatSession(key);
        setCurrentPage("chat");
      }}
      onNewChat={() => {
        setPendingChatSession("__new__");
        setCurrentPage("chat");
      }}
    >
      {showGatewayStartup && (
        <div className="absolute inset-0 z-50 flex items-center justify-center">
          <div className="w-full max-w-sm mx-4 rounded-2xl bg-white border border-[var(--border-subtle)] shadow-xl p-6">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 rounded-full bg-[var(--system-gray-6)] p-2">
                <Loader2 className="w-4 h-4 animate-spin text-[var(--text-primary)]" />
              </div>
              <div>
                <h2 className="text-sm font-semibold text-[var(--text-primary)]">
                  {gatewayRetryIn ? "Reconnecting secure sandbox" : "Starting secure sandbox"}
                </h2>
                <p className="text-xs text-[var(--text-secondary)] mt-1">
                  {gatewayRetryIn
                    ? `Retrying in ${gatewayRetryIn}s. We’ll keep trying until the sandbox is ready.`
                    : "Nova is preparing the secure sandbox so tools and plugins are available."}
                </p>
                <div className="mt-3 text-xs text-[var(--text-tertiary)]">
                  This can take a few seconds the first time.
                </div>
              </div>
            </div>
            <div className="mt-4 space-y-2 text-xs text-[var(--text-secondary)]">
              <div className="flex items-center gap-2">
                <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--text-tertiary)]" />
                <span>Launching gateway container</span>
              </div>
              <div className="flex items-center gap-2">
                <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--text-tertiary)]" />
                <span>Waiting for health check</span>
              </div>
            </div>
            {startupError && (
              <div className="mt-3 text-xs text-red-600">
                {startupError}
              </div>
            )}
          </div>
        </div>
      )}
      {renderPage()}
    </Layout>
  );
}
