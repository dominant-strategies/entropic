import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Shield,
  Power,
  Activity,
  Settings,
  MessageSquare,
  RefreshCw,
} from "lucide-react";
import clsx from "clsx";

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
  const [gatewayRunning, setGatewayRunning] = useState(false);
  const [isStarting, setIsStarting] = useState(false);

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
    setIsStarting(true);
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
      console.log("[Zara] Gateway status:", gatewayRunning ? "running" : "stopped");
    } catch (error) {
      console.error("[Zara] Failed to toggle gateway:", error);
    } finally {
      setIsStarting(false);
    }
  }

  return (
    <div className="h-screen w-screen bg-gray-50">
      {/* Title Bar Drag Region */}
      <div
        data-tauri-drag-region
        className="h-12 flex items-center px-4 bg-white border-b border-gray-100"
      >
        <div className="flex items-center gap-2 ml-16">
          <Shield className="w-5 h-5 text-violet-600" />
          <span className="font-medium text-gray-900">Zara</span>
        </div>
      </div>

      <div className="p-6 max-w-3xl mx-auto">
        {/* Status Card */}
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 mb-6">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-lg font-medium text-gray-900">Status</h2>
            <button
              onClick={onRefresh}
              className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
          </div>

          <div className="grid grid-cols-2 gap-4 mb-6">
            <StatusItem
              label="Sandbox VM"
              active={status?.vm_running ?? false}
            />
            <StatusItem
              label="Docker Ready"
              active={status?.docker_ready ?? false}
            />
          </div>

          {/* Gateway Toggle */}
          <div className="flex items-center justify-between p-4 bg-gray-50 rounded-xl">
            <div className="flex items-center gap-3">
              <div
                className={clsx(
                  "w-3 h-3 rounded-full",
                  gatewayRunning ? "bg-green-500" : "bg-gray-300"
                )}
              />
              <div>
                <p className="font-medium text-gray-900">Gateway</p>
                <p className="text-sm text-gray-500">
                  {gatewayRunning ? "Running on localhost:19789" : "Stopped"}
                </p>
              </div>
            </div>
            <button
              onClick={toggleGateway}
              disabled={isStarting}
              className={clsx(
                "px-4 py-2 rounded-lg font-medium transition-colors flex items-center gap-2",
                gatewayRunning
                  ? "bg-red-50 text-red-600 hover:bg-red-100"
                  : "bg-violet-600 text-white hover:bg-violet-700",
                isStarting && "opacity-50 cursor-not-allowed"
              )}
            >
              <Power className="w-4 h-4" />
              {isStarting ? "..." : gatewayRunning ? "Stop" : "Start"}
            </button>
          </div>
        </div>

        {/* Quick Actions */}
        <div className="grid grid-cols-3 gap-4">
          <ActionCard
            icon={<MessageSquare className="w-5 h-5" />}
            label="Channels"
            description="Configure Discord, Telegram"
            onClick={() => {}}
          />
          <ActionCard
            icon={<Activity className="w-5 h-5" />}
            label="Logs"
            description="View gateway logs"
            onClick={() => {}}
          />
          <ActionCard
            icon={<Settings className="w-5 h-5" />}
            label="Settings"
            description="API keys, preferences"
            onClick={() => {}}
          />
        </div>
      </div>
    </div>
  );
}

function StatusItem({ label, active }: { label: string; active: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <div
        className={clsx(
          "w-2 h-2 rounded-full",
          active ? "bg-green-500" : "bg-gray-300"
        )}
      />
      <span className="text-sm text-gray-600">{label}</span>
    </div>
  );
}

function ActionCard({
  icon,
  label,
  description,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="bg-white rounded-xl border border-gray-100 p-4 text-left hover:border-violet-200 hover:shadow-sm transition-all"
    >
      <div className="w-10 h-10 bg-violet-50 rounded-lg flex items-center justify-center text-violet-600 mb-3">
        {icon}
      </div>
      <p className="font-medium text-gray-900">{label}</p>
      <p className="text-sm text-gray-500">{description}</p>
    </button>
  );
}
