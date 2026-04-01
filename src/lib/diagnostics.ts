export type DiagnosticLogType = "info" | "warn" | "error";

export type DiagnosticLogSource = "chat";

export type OptimizationTraceMode = "direct-local-debug" | "openclaw-local-chat";

export type OptimizationTraceStatus = "running" | "completed" | "error" | "aborted";

export type DiagnosticLogEntry = {
  id: string;
  ts: number;
  source: DiagnosticLogSource;
  type: DiagnosticLogType;
  message: string;
};

export type OptimizationTraceEntry = {
  ts: number;
  message: string;
};

export type OptimizationTraceRecord = {
  id: string;
  startedTs: number;
  updatedTs: number;
  mode: OptimizationTraceMode;
  status: OptimizationTraceStatus;
  sessionKey: string;
  model: string;
  runId?: string | null;
  entries: OptimizationTraceEntry[];
};

const DIAGNOSTICS_STORAGE_KEY = "entropic.gateway.diagnostics";
const DIAGNOSTICS_UPDATED_EVENT = "entropic-diagnostics-updated";
const MAX_DIAGNOSTIC_LOGS = 500;
const OPTIMIZATION_TRACES_STORAGE_KEY = "entropic.optimization.traces";
const OPTIMIZATION_TRACES_UPDATED_EVENT = "entropic-optimization-traces-updated";
const MAX_OPTIMIZATION_TRACES = 40;

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

function readStoredOptimizationTracesRaw(): unknown {
  if (!canUseStorage()) return [];
  try {
    const raw = window.localStorage.getItem(OPTIMIZATION_TRACES_STORAGE_KEY);
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

function normalizeOptimizationTraceEntry(value: unknown): OptimizationTraceEntry | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const ts = typeof item.ts === "number" ? item.ts : 0;
  const message = typeof item.message === "string" ? item.message : "";
  if (!ts || !message) return null;
  return { ts, message };
}

function isOptimizationTraceMode(value: unknown): value is OptimizationTraceMode {
  return value === "direct-local-debug" || value === "openclaw-local-chat";
}

function isOptimizationTraceStatus(value: unknown): value is OptimizationTraceStatus {
  return value === "running" || value === "completed" || value === "error" || value === "aborted";
}

function normalizeOptimizationTrace(value: unknown): OptimizationTraceRecord | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const id = typeof item.id === "string" ? item.id : "";
  const startedTs = typeof item.startedTs === "number" ? item.startedTs : 0;
  const updatedTs = typeof item.updatedTs === "number" ? item.updatedTs : 0;
  const mode = isOptimizationTraceMode(item.mode) ? item.mode : null;
  const status = isOptimizationTraceStatus(item.status) ? item.status : null;
  const sessionKey = typeof item.sessionKey === "string" ? item.sessionKey : "";
  const model = typeof item.model === "string" ? item.model : "";
  const runId =
    typeof item.runId === "string" && item.runId.trim().length > 0 ? item.runId : undefined;
  const entries = Array.isArray(item.entries)
    ? item.entries
        .map(normalizeOptimizationTraceEntry)
        .filter((entry): entry is OptimizationTraceEntry => Boolean(entry))
    : [];
  if (!id || !startedTs || !updatedTs || !mode || !status || !sessionKey || !model) {
    return null;
  }
  return {
    id,
    startedTs,
    updatedTs,
    mode,
    status,
    sessionKey,
    model,
    runId,
    entries,
  };
}

function readStoredLogs(): DiagnosticLogEntry[] {
  const raw = readStoredLogsRaw();
  if (!Array.isArray(raw)) return [];
  return raw
    .map(normalizeLogEntry)
    .filter((entry): entry is DiagnosticLogEntry => Boolean(entry))
    .sort((a, b) => a.ts - b.ts);
}

function readStoredOptimizationTraces(): OptimizationTraceRecord[] {
  const raw = readStoredOptimizationTracesRaw();
  if (!Array.isArray(raw)) return [];
  return raw
    .map(normalizeOptimizationTrace)
    .filter((trace): trace is OptimizationTraceRecord => Boolean(trace))
    .sort((a, b) => b.startedTs - a.startedTs);
}

function writeStoredLogs(logs: DiagnosticLogEntry[]) {
  if (!canUseStorage()) return;
  try {
    window.localStorage.setItem(DIAGNOSTICS_STORAGE_KEY, JSON.stringify(logs.slice(-MAX_DIAGNOSTIC_LOGS)));
  } catch {
    // Ignore storage write errors.
  }
}

function writeStoredOptimizationTraces(traces: OptimizationTraceRecord[]) {
  if (!canUseStorage()) return;
  try {
    window.localStorage.setItem(
      OPTIMIZATION_TRACES_STORAGE_KEY,
      JSON.stringify(traces.slice(0, MAX_OPTIMIZATION_TRACES)),
    );
  } catch {
    // Ignore storage write errors.
  }
}

function emitDiagnosticsUpdated() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(DIAGNOSTICS_UPDATED_EVENT));
}

function emitOptimizationTracesUpdated() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(OPTIMIZATION_TRACES_UPDATED_EVENT));
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

export function beginOptimizationTrace(params: {
  mode: OptimizationTraceMode;
  sessionKey: string;
  model: string;
}): string {
  const id =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random()}`;
  const now = Date.now();
  const traces = readStoredOptimizationTraces();
  traces.unshift({
    id,
    startedTs: now,
    updatedTs: now,
    mode: params.mode,
    status: "running",
    sessionKey: params.sessionKey,
    model: params.model.trim() || "unknown",
    entries: [],
  });
  writeStoredOptimizationTraces(traces);
  emitOptimizationTracesUpdated();
  return id;
}

export function appendOptimizationTraceLine(traceId: string, message: string) {
  const trimmed = message.trim();
  if (!traceId || !trimmed) return;
  const traces = readStoredOptimizationTraces();
  const next = traces.map((trace) => {
    if (trace.id !== traceId) return trace;
    return {
      ...trace,
      updatedTs: Date.now(),
      entries: [...trace.entries, { ts: Date.now(), message: trimmed }],
    };
  });
  writeStoredOptimizationTraces(next);
  emitOptimizationTracesUpdated();
}

export function attachOptimizationTraceRunId(traceId: string, runId: string) {
  const trimmedTraceId = traceId.trim();
  const trimmedRunId = runId.trim();
  if (!trimmedTraceId || !trimmedRunId) return;
  const traces = readStoredOptimizationTraces();
  const next = traces.map((trace) =>
    trace.id === trimmedTraceId
      ? {
          ...trace,
          runId: trimmedRunId,
          updatedTs: Date.now(),
        }
      : trace,
  );
  writeStoredOptimizationTraces(next);
  emitOptimizationTracesUpdated();
}

export function finishOptimizationTrace(
  traceId: string,
  status: Exclude<OptimizationTraceStatus, "running">,
) {
  const trimmedTraceId = traceId.trim();
  if (!trimmedTraceId) return;
  const traces = readStoredOptimizationTraces();
  const next = traces.map((trace) =>
    trace.id === trimmedTraceId
      ? {
          ...trace,
          status,
          updatedTs: Date.now(),
        }
      : trace,
  );
  writeStoredOptimizationTraces(next);
  emitOptimizationTracesUpdated();
}

export function readOptimizationTraces(): OptimizationTraceRecord[] {
  return readStoredOptimizationTraces();
}

export function clearOptimizationTraces() {
  writeStoredOptimizationTraces([]);
  emitOptimizationTracesUpdated();
}

export function optimizationTracesUpdatedEventName(): string {
  return OPTIMIZATION_TRACES_UPDATED_EVENT;
}

export function clearDiagnosticLogs() {
  writeStoredLogs([]);
  emitDiagnosticsUpdated();
}

export function diagnosticsUpdatedEventName(): string {
  return DIAGNOSTICS_UPDATED_EVENT;
}
