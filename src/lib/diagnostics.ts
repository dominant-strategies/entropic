export type DiagnosticLogType = "info" | "warn" | "error";

export type DiagnosticLogSource = "chat";

export type DiagnosticLogEntry = {
  id: string;
  ts: number;
  source: DiagnosticLogSource;
  type: DiagnosticLogType;
  message: string;
};

const DIAGNOSTICS_STORAGE_KEY = "entropic.gateway.diagnostics";
const DIAGNOSTICS_UPDATED_EVENT = "entropic-diagnostics-updated";
const MAX_DIAGNOSTIC_LOGS = 500;

function canUseStorage(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function readStoredLogsRaw(): unknown {
  if (!canUseStorage()) return [];
  try {
    const raw = window.localStorage.getItem(DIAGNOSTICS_STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function isLogType(value: unknown): value is DiagnosticLogType {
  return value === "info" || value === "warn" || value === "error";
}

function normalizeLogEntry(value: unknown): DiagnosticLogEntry | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const id = typeof item.id === "string" ? item.id : "";
  const ts = typeof item.ts === "number" ? item.ts : 0;
  const source = item.source === "chat" ? "chat" : null;
  const type = isLogType(item.type) ? item.type : null;
  const message = typeof item.message === "string" ? item.message : "";
  if (!id || !ts || !source || !type || !message) return null;
  return { id, ts, source, type, message };
}

function readStoredLogs(): DiagnosticLogEntry[] {
  const raw = readStoredLogsRaw();
  if (!Array.isArray(raw)) return [];
  return raw
    .map(normalizeLogEntry)
    .filter((entry): entry is DiagnosticLogEntry => Boolean(entry))
    .sort((a, b) => a.ts - b.ts);
}

function writeStoredLogs(logs: DiagnosticLogEntry[]) {
  if (!canUseStorage()) return;
  try {
    window.localStorage.setItem(DIAGNOSTICS_STORAGE_KEY, JSON.stringify(logs.slice(-MAX_DIAGNOSTIC_LOGS)));
  } catch {
    // Ignore storage write errors.
  }
}

function emitDiagnosticsUpdated() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(DIAGNOSTICS_UPDATED_EVENT));
}

export function inferDiagnosticType(message: string): DiagnosticLogType {
  const text = message.toLowerCase();
  if (
    /error|failed|timeout|timed out|aborted|disconnect|unauthorized|invalid|blocked|interrupted/.test(
      text,
    )
  ) {
    return "error";
  }
  if (/retry|recover|reconnect|starting|offline|missing|skipped|suppressed|warn/.test(text)) {
    return "warn";
  }
  return "info";
}

export function appendDiagnosticLog(params: {
  source?: DiagnosticLogSource;
  type?: DiagnosticLogType;
  message: string;
}) {
  const message = params.message.trim();
  if (!message) return;
  const logs = readStoredLogs();
  logs.push({
    id: (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function")
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random()}`,
    ts: Date.now(),
    source: params.source ?? "chat",
    type: params.type ?? inferDiagnosticType(message),
    message,
  });
  writeStoredLogs(logs);
  emitDiagnosticsUpdated();
}

export function readDiagnosticLogs(): DiagnosticLogEntry[] {
  return readStoredLogs();
}

export function clearDiagnosticLogs() {
  writeStoredLogs([]);
  emitDiagnosticsUpdated();
}

export function diagnosticsUpdatedEventName(): string {
  return DIAGNOSTICS_UPDATED_EVENT;
}

