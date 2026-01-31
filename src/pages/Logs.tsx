import { useState, useEffect } from "react";
import { RefreshCw, Trash2 } from "lucide-react";
import clsx from "clsx";

type LogEntry = {
  timestamp: string;
  level: "info" | "warn" | "error";
  message: string;
};

export function Logs() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [autoRefresh, setAutoRefresh] = useState(true);

  useEffect(() => {
    // TODO: Fetch logs from gateway
    // For now, show placeholder logs
    setLogs([
      { timestamp: new Date().toISOString(), level: "info", message: "Gateway started" },
      { timestamp: new Date().toISOString(), level: "info", message: "Listening on ws://0.0.0.0:18789" },
    ]);
  }, []);

  function clearLogs() {
    setLogs([]);
  }

  function refreshLogs() {
    console.log("[Zara] Refreshing logs...");
    // TODO: Fetch from gateway
  }

  return (
    <div className="p-6 h-full flex flex-col">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Logs</h1>
          <p className="text-sm text-gray-500">Gateway activity and events</p>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-2 text-sm text-gray-600">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              className="rounded border-gray-300"
            />
            Auto-refresh
          </label>
          <button
            onClick={refreshLogs}
            className="p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
          <button
            onClick={clearLogs}
            className="p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="flex-1 bg-gray-900 rounded-xl p-4 font-mono text-sm overflow-auto">
        {logs.length === 0 ? (
          <div className="text-gray-500 text-center py-8">No logs yet</div>
        ) : (
          <div className="space-y-1">
            {logs.map((log, i) => (
              <div key={i} className="flex gap-3">
                <span className="text-gray-500 shrink-0">
                  {new Date(log.timestamp).toLocaleTimeString()}
                </span>
                <span
                  className={clsx(
                    "shrink-0 uppercase text-xs font-medium px-1.5 py-0.5 rounded",
                    log.level === "info" && "bg-blue-900/50 text-blue-400",
                    log.level === "warn" && "bg-yellow-900/50 text-yellow-400",
                    log.level === "error" && "bg-red-900/50 text-red-400"
                  )}
                >
                  {log.level}
                </span>
                <span className="text-gray-300">{log.message}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
