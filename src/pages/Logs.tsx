import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Copy, Download, RefreshCw, Trash2 } from "lucide-react";

type LogsProps = {
  compact?: boolean;
  className?: string;
};

type LogEntry = {
  id: string;
  timeLabel: string;
  level: "info" | "warn" | "error";
  message: string;
};

function parseClientLog(raw: string): LogEntry[] {
  if (!raw.trim()) return [];
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
  return lines.map((line, index) => {
    const match = line.match(/^\[(\d+)\]\s+\[([^\]]+)\]\s+(.*)$/);
    if (!match) {
      return {
        id: `line-${index}`,
        timeLabel: "",
        level: "info",
        message: line,
      };
    }
    const tsSeconds = Number(match[1]);
    const scope = String(match[2] || "").toLowerCase();
    const message = match[3] || "";
    const date = Number.isFinite(tsSeconds) ? new Date(tsSeconds * 1000) : null;
    const level: "info" | "warn" | "error" =
      /error|failed|timeout|disconnect|panic/.test(message.toLowerCase()) || scope.includes("error")
        ? "error"
        : /warn|retry|recover|fallback/.test(message.toLowerCase()) || scope.includes("warn")
          ? "warn"
          : "info";
    return {
      id: `line-${index}`,
      timeLabel: date && !Number.isNaN(date.getTime()) ? date.toLocaleTimeString() : "",
      level,
      message: `[${scope}] ${message}`.trim(),
    };
  });
}

async function copyText(text: string) {
  if (!text.trim()) return;
  if (navigator?.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const el = document.createElement("textarea");
  el.value = text;
  document.body.appendChild(el);
  el.select();
  document.execCommand("copy");
  document.body.removeChild(el);
}

export function Logs({ compact = false, className = "" }: LogsProps) {
  const [rawLogText, setRawLogText] = useState("");
  const logs = useMemo(() => parseClientLog(rawLogText), [rawLogText]);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [loading, setLoading] = useState(false);
  const [copying, setCopying] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [clearing, setClearing] = useState(false);

  const refreshLogs = useCallback(async () => {
    setLoading(true);
    try {
      const text = await invoke<string>("read_client_log", { maxBytes: 1024 * 1024 });
      setRawLogText(text || "");
    } catch (error) {
      console.error("[Entropic] Failed to read runtime log:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshLogs();
  }, [refreshLogs]);

  useEffect(() => {
    if (!autoRefresh) return;
    const timer = window.setInterval(() => {
      void refreshLogs();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [autoRefresh, refreshLogs]);

  async function clearLogs() {
    setClearing(true);
    try {
      await invoke("clear_client_log");
      setRawLogText("");
    } catch (error) {
      console.error("[Entropic] Failed to clear runtime log:", error);
      alert("Failed to clear runtime logs.");
    } finally {
      setClearing(false);
    }
  }

  async function handleCopyLogs() {
    if (!rawLogText.trim()) return;
    setCopying(true);
    try {
      await copyText(rawLogText);
      alert("Runtime logs copied.");
    } catch (error) {
      console.error("[Entropic] Failed to copy runtime log:", error);
      alert("Failed to copy runtime logs.");
    } finally {
      setCopying(false);
    }
  }

  async function handleExportLogs() {
    setExporting(true);
    try {
      const path = await invoke<string>("export_client_log");
      alert(`Runtime logs exported to:\n${path}`);
    } catch (error) {
      console.error("[Entropic] Failed to export runtime log:", error);
      alert("Failed to export runtime logs.");
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className={`${compact ? "flex flex-col" : "p-6 h-full flex flex-col"} ${className}`}>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className={compact ? "text-base font-semibold" : "text-xl font-semibold"} style={{ color: 'var(--text-primary)' }}>logs</h1>
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
            disabled={loading}
            aria-label="Refresh logs"
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
            <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
          </button>
          <button
            onClick={handleCopyLogs}
            disabled={copying || !rawLogText.trim()}
            aria-label="Copy logs"
            className="p-2 rounded-lg transition-all duration-200 disabled:opacity-40"
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
            <Copy className="w-4 h-4" />
          </button>
          <button
            onClick={handleExportLogs}
            disabled={exporting || !rawLogText.trim()}
            aria-label="Export logs"
            className="p-2 rounded-lg transition-all duration-200 disabled:opacity-40"
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
            <Download className="w-4 h-4" />
          </button>
          <button
            onClick={clearLogs}
            disabled={clearing || !rawLogText.trim()}
            aria-label="Clear logs"
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
            <Trash2 className={`w-4 h-4 ${clearing ? "animate-pulse" : ""}`} />
          </button>
        </div>
      </div>

      <div 
        className={compact ? "h-64 rounded-xl p-4 font-mono text-sm overflow-auto" : "flex-1 rounded-xl p-4 font-mono text-sm overflow-auto"}
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
                  {log.timeLabel}
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
