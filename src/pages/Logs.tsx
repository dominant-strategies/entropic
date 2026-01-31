import { useState, useEffect } from "react";
import { RefreshCw, Trash2 } from "lucide-react";

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
      { timestamp: new Date().toISOString(), level: "info", message: "gateway started" },
      { timestamp: new Date().toISOString(), level: "info", message: "listening on ws://0.0.0.0:18789" },
    ]);
  }, []);

  function clearLogs() {
    setLogs([]);
  }

  function refreshLogs() {
    console.log("[Zara] refreshing logs...");
    // TODO: Fetch from gateway
  }

  return (
    <div className="p-6 h-full flex flex-col">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-xl font-semibold" style={{ color: 'var(--text-primary)' }}>logs</h1>
          <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>gateway activity and events</p>
        </div>
        <div className="flex items-center gap-2">
          <label 
            className="flex items-center gap-2 text-sm"
            style={{ color: 'var(--text-secondary)' }}
          >
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              className="rounded"
              style={{ accentColor: 'var(--purple-600)' }}
            />
            auto-refresh
          </label>
          <button
            onClick={refreshLogs}
            className="p-2 rounded-lg transition-all duration-200"
            style={{ color: 'var(--text-tertiary)' }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'var(--glass-bg-hover)';
              e.currentTarget.style.color = 'var(--text-secondary)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent';
              e.currentTarget.style.color = 'var(--text-tertiary)';
            }}
          >
            <RefreshCw className="w-4 h-4" />
          </button>
          <button
            onClick={clearLogs}
            className="p-2 rounded-lg transition-all duration-200"
            style={{ color: 'var(--text-tertiary)' }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'rgba(239, 68, 68, 0.1)';
              e.currentTarget.style.color = '#dc2626';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent';
              e.currentTarget.style.color = 'var(--text-tertiary)';
            }}
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div 
        className="flex-1 rounded-xl p-4 font-mono text-sm overflow-auto"
        style={{ 
          background: 'var(--bg-secondary)',
          border: '1px solid var(--glass-border-subtle)'
        }}
      >
        {logs.length === 0 ? (
          <div className="text-center py-8" style={{ color: 'var(--text-tertiary)' }}>no logs yet</div>
        ) : (
          <div className="space-y-1">
            {logs.map((log, i) => (
              <div key={i} className="flex gap-3">
                <span className="shrink-0" style={{ color: 'var(--text-tertiary)' }}>
                  {new Date(log.timestamp).toLocaleTimeString()}
                </span>
                <span
                  className="shrink-0 uppercase text-xs font-medium px-1.5 py-0.5 rounded"
                  style={{
                    background: log.level === "info" ? 'rgba(59, 130, 246, 0.15)' :
                                log.level === "warn" ? 'rgba(234, 179, 8, 0.15)' :
                                'rgba(239, 68, 68, 0.15)',
                    color: log.level === "info" ? '#60a5fa' :
                           log.level === "warn" ? '#facc15' :
                           '#f87171'
                  }}
                >
                  {log.level}
                </span>
                <span style={{ color: 'var(--text-secondary)' }}>{log.message}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
