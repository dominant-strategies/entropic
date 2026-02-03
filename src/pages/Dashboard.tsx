import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Layout, Page } from "../components/Layout";
import { Chat } from "./Chat";
import { Store } from "./Store";
import { Channels } from "./Channels";
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
const DEFAULT_MODEL = "anthropic/claude-sonnet-4-20250514";

export function Dashboard({ status: _status, onRefresh: _onRefresh }: Props) {
  const { isAuthenticated, isAuthConfigured } = useAuth();
  const [currentPage, setCurrentPage] = useState<Page>("chat");
  const [gatewayRunning, setGatewayRunning] = useState(false);
  const [isTogglingGateway, setIsTogglingGateway] = useState(false);
  const [selectedModel, setSelectedModel] = useState(DEFAULT_MODEL);
  const gatewayTokenRef = useRef<string | null>(null);
  const autoStartAttemptedRef = useRef(false);

  // Load saved model preference
  useEffect(() => {
    async function loadModel() {
      try {
        const store = await TauriStore.load("nova-settings.json");
        const saved = await store.get("selectedModel") as string | null;
        if (saved) setSelectedModel(saved);
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

  // Auto-start gateway for authenticated users
  useEffect(() => {
    async function autoStartGateway() {
      // Only attempt auto-start once, when authenticated via OAuth
      if (
        !autoStartAttemptedRef.current &&
        isAuthConfigured &&
        isAuthenticated &&
        !gatewayRunning &&
        !isTogglingGateway
      ) {
        autoStartAttemptedRef.current = true;
        console.log("[Nova] Auto-starting gateway for authenticated user...");

        setIsTogglingGateway(true);
        try {
          // Get a gateway token for OpenClaw to use
          const { token } = await createGatewayToken();
          gatewayTokenRef.current = token;

          const proxyUrl = getProxyUrl();
          console.log("[Nova] Auto-start: Using proxy mode with URL:", proxyUrl);

          await invoke("start_gateway_with_proxy", {
            gatewayToken: token,
            proxyUrl,
            model: selectedModel,
          });

          console.log("[Nova] Auto-start: Gateway started successfully");
          await new Promise((r) => setTimeout(r, 2000));
          await checkGateway();
        } catch (error) {
          console.error("[Nova] Auto-start: Failed to start gateway:", error);
          // Reset the flag so user can try manually
          autoStartAttemptedRef.current = false;
        } finally {
          setIsTogglingGateway(false);
        }
      }
    }

    autoStartGateway();
  }, [isAuthenticated, isAuthConfigured, gatewayRunning, isTogglingGateway, selectedModel]);

  async function checkGateway() {
    try {
      const running = await invoke<boolean>("get_gateway_status");
      setGatewayRunning(running);
      console.log("[Nova] Gateway health check:", running ? "healthy" : "not responding");
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
        if (isAuthConfigured && isAuthenticated) {
          try {
            // Get a gateway token for OpenClaw to use
            const { token } = await createGatewayToken();
            gatewayTokenRef.current = token;

            const proxyUrl = getProxyUrl();
            console.log("[Nova] Using proxy mode with URL:", proxyUrl);

            await invoke("start_gateway_with_proxy", {
              gatewayToken: token,
              proxyUrl,
              model: selectedModel,
            });
          } catch (proxyError) {
            console.error("[Nova] Proxy mode failed, falling back to direct:", proxyError);
            // Fall back to direct API keys if proxy fails
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
    } finally {
      setIsTogglingGateway(false);
    }
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
    if (gatewayRunning && isAuthConfigured && isAuthenticated && gatewayTokenRef.current) {
      setIsTogglingGateway(true);
      try {
        await invoke("stop_gateway");
        const { token } = await createGatewayToken();
        gatewayTokenRef.current = token;
        await invoke("start_gateway_with_proxy", {
          gatewayToken: token,
          proxyUrl: getProxyUrl(),
          model: newModel,
        });
        await new Promise((r) => setTimeout(r, 2000));
        await checkGateway();
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
        return <Chat gatewayRunning={gatewayRunning} />;
      case "store":
        return <Store />;
      case "channels":
        return <Channels />;
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
      {renderPage()}
    </Layout>
  );
}
