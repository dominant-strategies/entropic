import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Layout, Page } from "../components/Layout";
import { Chat } from "./Chat";
import { Store } from "./Store";
import { Channels } from "./Channels";
import { Logs } from "./Logs";
import { Settings } from "./Settings";

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

export function Dashboard({ status, onRefresh }: Props) {
  const [currentPage, setCurrentPage] = useState<Page>("chat");
  const [gatewayRunning, setGatewayRunning] = useState(false);
  const [isTogglingGateway, setIsTogglingGateway] = useState(false);

  useEffect(() => {
    checkGateway();
    const interval = setInterval(checkGateway, 5000);
    return () => clearInterval(interval);
  }, []);

  async function checkGateway() {
    try {
      const running = await invoke<boolean>("get_gateway_status");
      setGatewayRunning(running);
      console.log("[Zara] Gateway health check:", running ? "healthy" : "not responding");
    } catch (error) {
      console.error("[Zara] Gateway check failed:", error);
      setGatewayRunning(false);
    }
  }

  async function toggleGateway() {
    setIsTogglingGateway(true);
    try {
      if (gatewayRunning) {
        console.log("[Zara] Stopping gateway...");
        await invoke("stop_gateway");
        console.log("[Zara] Gateway stopped successfully");
      } else {
        console.log("[Zara] Starting gateway...");
        await invoke("start_gateway");
        console.log("[Zara] Gateway started successfully");
      }
      await new Promise((r) => setTimeout(r, 2000));
      await checkGateway();
    } catch (error) {
      console.error("[Zara] Failed to toggle gateway:", error);
    } finally {
      setIsTogglingGateway(false);
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
