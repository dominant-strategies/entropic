import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Layout, Page } from "../components/Layout";
import { Chat } from "./Chat";
import { Store } from "./Store";
import { Channels } from "./Channels";
import { Files } from "./Files";
import { Tasks } from "./Tasks";
import { Logs } from "./Logs";
import { Settings } from "./Settings";
import { useAuth } from "../contexts/AuthContext";
import { createGatewayToken, getProxyUrl } from "../lib/auth";
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
  const [currentPage, setCurrentPage] = useState<Page>("chat");
  const [gatewayRunning, setGatewayRunning] = useState(false);
  const [isTogglingGateway, setIsTogglingGateway] = useState(false);
  const [showGatewayStartup, setShowGatewayStartup] = useState(false);
  const [startupError, setStartupError] = useState<string | null>(null);
  const [gatewayRetryIn, setGatewayRetryIn] = useState<number | null>(null);
  const [selectedModel, setSelectedModel] = useState(DEFAULT_MODEL);
  const [codeModel, setCodeModel] = useState("openai/gpt-5.2-codex");
  const [imageModel, setImageModel] = useState("google/gemini-3-pro-image-preview");
  const gatewayTokenRef = useRef<string | null>(null);
  const autoStartAttemptedRef = useRef(false);
  const retryAttemptRef = useRef(0);
  const retryTimeoutRef = useRef<number | null>(null);
  const retryIntervalRef = useRef<number | null>(null);

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
    checkGateway();
    const interval = setInterval(checkGateway, 5000);
    return () => clearInterval(interval);
  }, []);

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
    if (!isAuthConfigured || !isAuthenticated || useLocalKeys) {
      return false;
    }

    setStartupError(null);
    setShowGatewayStartup(true);
    try {
      if (stopFirst) {
        try {
          await invoke("stop_gateway");
        } catch (error) {
          console.error("[Nova] Failed to stop gateway:", error);
        }
      }

      const { token } = await createGatewayToken();
      gatewayTokenRef.current = token;

      const proxyUrl = getProxyUrl();
      const proxyModel = normalizeProxyModel(model);
      const proxyImageModel = normalizeProxyModel(image);
      console.log("[Nova] Proxy start: Using URL:", proxyUrl);

      await invoke("start_gateway_with_proxy", {
        gatewayToken: token,
        proxyUrl,
        model: proxyModel,
        imageModel: proxyImageModel,
      });

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
      // Only attempt auto-start once, when authenticated via OAuth
      if (
        !autoStartAttemptedRef.current &&
        proxyEnabled &&
        !gatewayRunning &&
        !isTogglingGateway &&
        gatewayRetryIn === null
      ) {
        autoStartAttemptedRef.current = true;
        console.log("[Nova] Auto-starting gateway for authenticated user...");

        setIsTogglingGateway(true);
        try {
          await startGatewayProxyFlow({
            model: selectedModel,
            image: imageModel,
            stopFirst: false,
            allowRetry: true,
          });
        } finally {
          setIsTogglingGateway(false);
        }
      }
    }

    autoStartGateway();
  }, [isAuthenticated, isAuthConfigured, gatewayRunning, isTogglingGateway, selectedModel, gatewayRetryIn, imageModel]);

  async function checkGateway() {
    try {
      const running = await invoke<boolean>("get_gateway_status");
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
      } else {
        console.log("[Nova] Starting gateway...");
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
        return (
          <Chat
            gatewayRunning={gatewayRunning}
            gatewayStarting={showGatewayStartup}
            gatewayRetryIn={gatewayRetryIn}
            onStartGateway={startGatewayFromChat}
            useLocalKeys={useLocalKeys}
            codeModel={codeModel}
            imageModel={imageModel}
          />
        );
      case "store":
        return <Store />;
      case "channels":
        return <Channels />;
      case "files":
        return <Files gatewayRunning={gatewayRunning} />;
      case "tasks":
        return <Tasks gatewayRunning={gatewayRunning} />;
      case "logs":
        return <Logs />;
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
    >
      {showGatewayStartup && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm">
          <div className="glass-card p-8 w-full max-w-md mx-4 text-center">
            <div className="w-12 h-12 rounded-xl mx-auto mb-4 bg-[var(--purple-accent)] animate-pulse-subtle" />
            <h2 className="text-lg font-semibold text-[var(--text-primary)] mb-2">
              {gatewayRetryIn ? "Reconnecting secure sandbox" : "Starting secure sandbox"}
            </h2>
            <p className="text-sm text-[var(--text-secondary)] mb-4">
              {gatewayRetryIn
                ? `Retrying in ${gatewayRetryIn}s…`
                : "We’re spinning up the Docker container for your assistant."}
            </p>
            <div className="text-left text-sm space-y-2">
              <div className="flex items-center gap-2">
                <span className={`h-2 w-2 rounded-full ${isTogglingGateway ? "bg-amber-400" : "bg-green-500"}`} />
                <span className="text-[var(--text-secondary)]">Starting gateway container</span>
              </div>
              <div className="flex items-center gap-2">
                <span className={`h-2 w-2 rounded-full ${gatewayRunning ? "bg-green-500" : "bg-amber-400"}`} />
                <span className="text-[var(--text-secondary)]">Waiting for health check</span>
              </div>
            </div>
            {startupError && (
              <div className="mt-4 text-sm text-red-500">
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
