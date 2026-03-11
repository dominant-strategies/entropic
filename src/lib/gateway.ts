// OpenClaw Gateway WebSocket Client

import { invoke } from "@tauri-apps/api/core";

type Frame = RequestFrame | ResponseFrame | EventFrame;

type RequestFrame = {
  type: "req";
  id: string;
  method: string;
  params?: unknown;
};

type ResponseFrame = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { code: string; message: string; details?: unknown };
};

export class GatewayError extends Error {
  code?: string;
  details?: unknown;

  constructor(message: string, code?: string, details?: unknown) {
    super(message);
    this.name = "GatewayError";
    this.code = code;
    this.details = details;
  }
}

type GatewayDeviceIdentity = {
  device_id: string;
  public_key: string;
};

type StoredDeviceAuthEntry = {
  token: string;
  role: string;
  scopes?: string[];
  updatedAtMs?: number;
};

type StoredDeviceAuthStore = {
  version: 1;
  deviceId: string;
  tokens: Record<string, StoredDeviceAuthEntry>;
};

const DEVICE_AUTH_STORAGE_KEY = "openclaw.device.auth.v1";

function readDeviceAuthStore(): StoredDeviceAuthStore | null {
  try {
    const raw = window.localStorage.getItem(DEVICE_AUTH_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredDeviceAuthStore;
    if (
      parsed?.version !== 1 ||
      typeof parsed.deviceId !== "string" ||
      !parsed.tokens ||
      typeof parsed.tokens !== "object"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeDeviceAuthStore(store: StoredDeviceAuthStore) {
  try {
    window.localStorage.setItem(DEVICE_AUTH_STORAGE_KEY, JSON.stringify(store));
  } catch {
    // best-effort
  }
}

function loadDeviceAuthToken(params: { deviceId: string; role: string }): StoredDeviceAuthEntry | null {
  const store = readDeviceAuthStore();
  if (!store || store.deviceId !== params.deviceId) return null;
  return store.tokens[params.role] ?? null;
}

function storeDeviceAuthToken(params: {
  deviceId: string;
  role: string;
  token: string;
  scopes?: string[];
}) {
  const existing = readDeviceAuthStore();
  const next: StoredDeviceAuthStore = {
    version: 1,
    deviceId: params.deviceId,
    tokens:
      existing && existing.deviceId === params.deviceId && existing.tokens
        ? { ...existing.tokens }
        : {},
  };
  next.tokens[params.role] = {
    token: params.token,
    role: params.role,
    scopes: params.scopes,
    updatedAtMs: Date.now(),
  };
  writeDeviceAuthStore(next);
}

function clearDeviceAuthToken(params: { deviceId: string; role: string }) {
  const store = readDeviceAuthStore();
  if (!store || store.deviceId !== params.deviceId) return;
  if (!store.tokens[params.role]) return;
  const next: StoredDeviceAuthStore = {
    version: 1,
    deviceId: store.deviceId,
    tokens: { ...store.tokens },
  };
  delete next.tokens[params.role];
  writeDeviceAuthStore(next);
}

function buildDeviceAuthPayload(params: {
  deviceId: string;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  signedAtMs: number;
  token?: string | null;
  nonce: string;
}) {
  return [
    "v2",
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    params.scopes.join(","),
    String(params.signedAtMs),
    params.token ?? "",
    params.nonce,
  ].join("|");
}

async function loadGatewayDeviceIdentity(): Promise<GatewayDeviceIdentity> {
  return invoke<GatewayDeviceIdentity>("get_gateway_device_identity");
}

async function signGatewayDevicePayload(payload: string): Promise<string> {
  return invoke<string>("sign_gateway_device_payload", { payload });
}

type EventFrame = {
  type: "event";
  event: string;
  payload?: unknown;
  seq?: number;
};

export type ChatEvent = {
  runId: string;
  sessionKey: string;
  seq: number;
  state: "delta" | "final" | "aborted" | "error";
  message?: GatewayMessage;
  errorMessage?: string;
  usage?: unknown;
  stopReason?: string;
};

export type GatewayContentBlock = {
  type?: string;
  text?: string;
  [key: string]: unknown;
};

export type GatewayMessage = {
  role?: string;
  content?: string | GatewayContentBlock[];
  text?: string;
  toolName?: string;
  toolCallId?: string;
  [key: string]: unknown;
};

type Session = {
  key: string;  // Session key used for API calls
  sessionId?: string;
  label?: string;
  displayName?: string;
  derivedTitle?: string;
  updatedAt: number | null;
};

export type AgentEvent = {
  runId: string;
  seq: number;
  stream: "lifecycle" | "tool" | "assistant" | "error" | string;
  ts: number;
  sessionKey?: string;
  data: Record<string, unknown>;
};

type GatewayEvents = {
  connected: () => void;
  disconnected: () => void;
  chat: (event: ChatEvent) => void;
  agent: (event: AgentEvent) => void;
  error: (error: string) => void;
};

export class GatewayClient {
  private ws: WebSocket | null = null;
  private url: string;
  private token: string;
  private authenticated = false;
  private requestId = 0;
  private pendingRequests = new Map<
    string,
    {
      method: string;
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      startedAt: number;
      timeoutHandle?: ReturnType<typeof setTimeout>;
    }
  >();
  private listeners: Partial<{ [K in keyof GatewayEvents]: GatewayEvents[K][] }> = {};
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private static KEEPALIVE_INTERVAL_MS = 30_000;
  private connectNonce: string | null = null;
  private pairingApprovalAttempts = new Set<string>();

  private shouldLog() {
    if (typeof window === "undefined") {
      return false;
    }
    if (window.localStorage?.getItem("ENTROPIC_GATEWAY_DEBUG") === "1") {
      return true;
    }
    if (import.meta.env.DEV) {
      return true;
    }
    return new URLSearchParams(window.location.search).has("debugGateway");
  }

  private log(...parts: unknown[]) {
    if (this.shouldLog()) {
      console.log("[Gateway]", ...parts);
    }
  }

  private logError(...parts: unknown[]) {
    if (this.shouldLog()) {
      console.error("[Gateway]", ...parts);
    }
  }

  private failPendingRequests(code: string, event: string, details?: string) {
    for (const [id, pending] of this.pendingRequests) {
      if (pending.timeoutHandle) clearTimeout(pending.timeoutHandle);
      const message = details
        ? `Gateway socket ${event} before response for ${pending.method} (id=${id}): ${details}`
        : `Gateway socket ${event} before response for ${pending.method} (id=${id})`;
      pending.reject(new GatewayError(message, code));
    }
    this.pendingRequests.clear();
  }

  constructor(url: string, token: string) {
    this.url = url;
    this.token = token;
  }

  on<K extends keyof GatewayEvents>(event: K, callback: GatewayEvents[K]) {
    if (!this.listeners[event]) {
      this.listeners[event] = [];
    }
    this.listeners[event]!.push(callback);
  }

  off<K extends keyof GatewayEvents>(event: K, callback: GatewayEvents[K]) {
    const arr = this.listeners[event];
    if (arr) {
      const idx = arr.indexOf(callback);
      if (idx >= 0) arr.splice(idx, 1);
    }
  }

  private emit<K extends keyof GatewayEvents>(event: K, ...args: Parameters<GatewayEvents[K]>) {
    const arr = this.listeners[event];
    if (arr) {
      for (const cb of arr) {
        (cb as (...args: unknown[]) => void)(...args);
      }
    }
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const connectTimeoutMs = 15_000;
      const connectTimeout = setTimeout(() => {
        rejectOnce(
          new GatewayError(
            `Gateway connection timed out after ${connectTimeoutMs}ms waiting for authentication`,
            "timeout",
          ),
        );
        this.ws?.close();
      }, connectTimeoutMs);
      const resolveOnce = () => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimeout);
        resolve();
      };
      const rejectOnce = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimeout);
        reject(error);
      };

      this.log("Connecting to", this.url);
      this.ws = new WebSocket(this.url);
      this.authenticated = false;

      this.ws.onopen = () => {
        this.log("WebSocket opened, waiting for challenge...");
      };

      this.ws.onmessage = async (event) => {
        try {
          const frame: Frame = JSON.parse(event.data);
          await this.handleFrame(frame, resolveOnce, rejectOnce);
        } catch (e) {
          this.logError("Failed to parse frame:", e);
        }
      };

      this.ws.onerror = (e) => {
        this.logError("WebSocket error:", e);
        // Browser WebSocket errors are intentionally opaque and are almost
        // always followed by a close event with better context. Avoid surfacing
        // a generic "WebSocket error" banner to the user here.
      };

      this.ws.onclose = (event) => {
        this.log("WebSocket closed", `code=${event.code}`, `reason=${event.reason || "(none)"}`);
        this.stopKeepalive();
        this.failPendingRequests("ws.closed", "closed", `code=${event.code} reason=${event.reason || "(none)"}`);
        if (!this.authenticated) {
          rejectOnce(
            new GatewayError(
              `Gateway socket closed during connect (code=${event.code} reason=${event.reason || "(none)"})`,
              "ws.closed",
            ),
          );
        }
        this.authenticated = false;
        this.emit("disconnected");
        this.ws = null;
      };
    });
  }

  private async handleFrame(
    frame: Frame,
    connectResolve?: (v: void) => void,
    connectReject?: (e: Error) => void
  ) {
    if (frame.type === "event") {
      if (frame.event === "connect.challenge") {
        // Respond with connect RPC
        this.log("Received challenge, authenticating...");
        const role = "operator";
        let deviceIdentity: GatewayDeviceIdentity | null = null;
        let canFallbackToShared = false;
        try {
          const clientId = "openclaw-control-ui";
          const clientMode = "ui";
          const scopes = ["operator.admin", "operator.approvals", "operator.pairing"];
          const nonce =
            frame.payload && typeof frame.payload === "object" && "nonce" in frame.payload
              ? String((frame.payload as { nonce?: unknown }).nonce ?? "")
              : "";
          this.connectNonce = nonce;
          const isSecureContext = typeof window !== "undefined" && window.isSecureContext;
          let device: {
            id: string;
            publicKey: string;
            signature: string;
            signedAt: number;
            nonce: string;
          } | undefined;
          let authToken = this.token;

          if (isSecureContext) {
            deviceIdentity = await loadGatewayDeviceIdentity();
            const storedToken = loadDeviceAuthToken({
              deviceId: deviceIdentity.device_id,
              role,
            })?.token;
            authToken = storedToken ?? this.token;
            canFallbackToShared = Boolean(storedToken && this.token);

            const signedAtMs = Date.now();
            const payload = buildDeviceAuthPayload({
              deviceId: deviceIdentity.device_id,
              clientId,
              clientMode,
              role,
              scopes,
              signedAtMs,
              token: authToken ?? null,
              nonce,
            });
            const signature = await signGatewayDevicePayload(payload);
            device = {
              id: deviceIdentity.device_id,
              publicKey: deviceIdentity.public_key,
              signature,
              signedAt: signedAtMs,
              nonce,
            };
          }

          await this.rpc("connect", {
            minProtocol: 3,
            maxProtocol: 3,
            client: {
              id: clientId,
              displayName: "Entropic Desktop",
              version: "0.1.0",
              platform: "desktop",
              mode: clientMode,
            },
            role,
            scopes,
            auth: authToken ? { token: authToken } : undefined,
            device,
            caps: [],
            userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "Entropic Desktop",
            locale: typeof navigator !== "undefined" ? navigator.language : "en-US",
          });
          this.log("Connected successfully");
          this.authenticated = true;
          this.startKeepalive();
          this.emit("connected");
          connectResolve?.();
        } catch (e) {
          const pairingRequestId =
            e instanceof GatewayError &&
            e.code === "NOT_PAIRED" &&
            e.details &&
            typeof e.details === "object" &&
            "requestId" in e.details
              ? String((e.details as { requestId?: unknown }).requestId ?? "").trim()
              : "";
          if (pairingRequestId && !this.pairingApprovalAttempts.has(pairingRequestId)) {
            this.pairingApprovalAttempts.add(pairingRequestId);
            try {
              await invoke("approve_gateway_device_pairing", { requestId: pairingRequestId });
              this.log("Approved local gateway pairing request", pairingRequestId);
            } catch (approveError) {
              this.logError("Failed to auto-approve gateway pairing:", approveError);
            }
          }
          if (e instanceof GatewayError && deviceIdentity && canFallbackToShared) {
            clearDeviceAuthToken({ deviceId: deviceIdentity.device_id, role });
          }
          this.logError("Auth failed:", e);
          connectReject?.(e as Error);
        }
      } else if (frame.event === "chat") {
        this.emit("chat", frame.payload as ChatEvent);
      } else if (frame.event === "agent") {
        this.emit("agent", frame.payload as AgentEvent);
      }
    } else if (frame.type === "res") {
      const pending = this.pendingRequests.get(frame.id);
      if (pending) {
        this.pendingRequests.delete(frame.id);
        if (pending.timeoutHandle) {
          clearTimeout(pending.timeoutHandle);
        }
        const status = frame.ok ? "ok" : "error";
        const method = pending.method;
        const elapsedMs = Date.now() - pending.startedAt;
        if (frame.ok) {
          this.log("res", status, `id=${frame.id}`, `method=${method}`, `ms=${elapsedMs}`);
        } else {
          this.logError(
            "res",
            status,
            `id=${frame.id}`,
            `method=${method}`,
            `ms=${elapsedMs}`,
            frame.error,
          );
        }
        if (frame.ok) {
          if (pending.method === "connect") {
            const auth = (
              frame.payload as {
                auth?: { deviceToken?: string; role?: string; scopes?: string[] };
              } | undefined
            )?.auth;
            const deviceToken = auth?.deviceToken?.trim();
            if (deviceToken) {
              try {
                const identity = await loadGatewayDeviceIdentity();
                storeDeviceAuthToken({
                  deviceId: identity.device_id,
                  role: auth?.role || "operator",
                  token: deviceToken,
                  scopes: auth?.scopes,
                });
              } catch (error) {
                this.log("Failed to persist gateway device token", error);
              }
            }
          }
          pending.resolve(frame.payload);
        } else {
          pending.reject(
            new GatewayError(
              frame.error?.message || "RPC failed",
              frame.error?.code,
              frame.error?.details,
            ),
          );
        }
      } else {
        this.log("res", "unmatched", `id=${frame.id}`);
      }
    }
  }

  rpc<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = String(++this.requestId);
    const startedAt = Date.now();

    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error("Not connected"));
        return;
      }
      if (!this.authenticated && method !== "connect") {
        reject(new Error("Not authenticated"));
        return;
      }

      const frame: RequestFrame = { type: "req", id, method, params };
      const timeoutMs =
        method === "chat.send"
          ? 60_000
          : method === "chat.history" || method === "sessions.list"
            ? 45_000
            : 20_000;
      const timeoutHandle = setTimeout(() => {
        const pending = this.pendingRequests.get(id);
        if (pending) {
          this.pendingRequests.delete(id);
          pending.reject(
            new GatewayError(
              `Request timeout after ${timeoutMs}ms for ${method} (id=${id})`,
              "timeout",
            ),
          );
        }
      }, timeoutMs);

      this.pendingRequests.set(id, {
        method,
        resolve: resolve as (v: unknown) => void,
        reject,
        startedAt,
        timeoutHandle,
      });

      this.log(
        "send",
        `id=${id}`,
        `method=${method}`,
        `lagMs=${Date.now() - startedAt}`,
        frame.params
      );
        this.ws.send(JSON.stringify(frame));
    });
  }

  private startKeepalive() {
    this.stopKeepalive();
    this.keepaliveTimer = setInterval(() => {
      if (!this.isConnected()) {
        this.stopKeepalive();
        return;
      }
      this.rpc("health").catch((e) => {
        this.log("Keepalive ping failed:", e);
      });
    }, GatewayClient.KEEPALIVE_INTERVAL_MS);
  }

  private stopKeepalive() {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }

  disconnect() {
    this.stopKeepalive();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN && this.authenticated;
  }

  // API Methods

  async listSessions(): Promise<Session[]> {
    const result = await this.rpc<{ sessions: Session[] }>("sessions.list", {});
    return result.sessions || [];
  }

  async getChatHistory(sessionKey: string, limit = 200): Promise<GatewayMessage[]> {
    const result = await this.rpc<{ messages: GatewayMessage[] }>("chat.history", {
      sessionKey,
      limit,
    });
    return result.messages || [];
  }

  async sendMessage(
    sessionKey: string,
    message: string,
    attachments?: Array<{
      fileName?: string;
      mimeType?: string;
      content?: string;
    }>
  ): Promise<string> {
    const result = await this.rpc<{ runId: string }>("chat.send", {
      sessionKey,
      message,
      attachments,
      idempotencyKey: crypto.randomUUID(),
    });
    return result.runId;
  }

  async abortChat(sessionKey: string, runId?: string): Promise<void> {
    await this.rpc("chat.abort", { sessionKey, runId });
  }

  // Sessions are created automatically when you send a message
  // Just generate a new session key (UUID) and start chatting
  createSessionKey(): string {
    return crypto.randomUUID();
  }

  async resetSession(sessionKey: string): Promise<void> {
    await this.rpc("sessions.reset", { key: sessionKey });
  }

  async patchSession(
    sessionKey: string,
    patch: { model?: string | null; label?: string | null },
  ): Promise<void> {
    await this.rpc("sessions.patch", { key: sessionKey, ...patch });
  }

  async deleteSession(sessionKey: string, deleteTranscript = true): Promise<boolean> {
    const result = await this.rpc<{ deleted?: boolean }>("sessions.delete", {
      key: sessionKey,
      deleteTranscript,
    });
    return result?.deleted ?? true;
  }

  async getConfig(): Promise<unknown> {
    return this.rpc("config.get");
  }

  async setConfig(path: string, value: unknown): Promise<void> {
    await this.rpc("config.set", { path, value });
  }

  // ── Cron API ─────────────────────────────────────────────────────

  async listCronJobs(includeDisabled = true): Promise<CronJob[]> {
    const result = await this.rpc<{ jobs: CronJob[] }>("cron.list", { includeDisabled });
    return result.jobs || [];
  }

  async addCronJob(job: {
    name: string;
    description?: string;
    schedule: CronSchedule;
    payload: CronPayload;
    sessionTarget: "main" | "isolated";
    wakeMode?: "next-heartbeat" | "now";
    enabled?: boolean;
    agentId?: string | null;
    deleteAfterRun?: boolean;
    isolation?: unknown;
  }): Promise<CronJob> {
    return this.rpc<CronJob>("cron.add", job);
  }

  async updateCronJob(
    id: string,
    patch: Partial<{
      name: string;
      description: string;
      schedule: CronSchedule;
      payload: CronPayload;
      sessionTarget: "main" | "isolated";
      wakeMode: "next-heartbeat" | "now";
      enabled: boolean;
    }>
  ): Promise<CronJob> {
    return this.rpc<CronJob>("cron.update", { id, patch });
  }

  async removeCronJob(id: string): Promise<void> {
    await this.rpc("cron.remove", { id });
  }

  async runCronJob(id: string, mode?: "force" | "normal"): Promise<unknown> {
    return this.rpc("cron.run", { id, mode: mode ?? "force" });
  }

  async getCronRuns(id: string, limit = 20): Promise<CronRunLogEntry[]> {
    const result = await this.rpc<{
      runs?: CronRunLogEntry[];
      entries?: Array<
        Partial<CronRunLogEntry> & {
          action?: string;
          status?: "ok" | "error" | "skipped";
          summary?: string;
          durationMs?: number;
          runAtMs?: number;
          ts?: number;
        }
      >;
    }>("cron.runs", { id, limit });
    const entries = result.entries;
    if (entries && entries.length > 0) {
      return entries.map((entry, index) => {
        const startedAt =
          (typeof entry.startedAt === "number" && Number.isFinite(entry.startedAt)
            ? entry.startedAt
            : undefined) ??
          (typeof entry.runAtMs === "number" && Number.isFinite(entry.runAtMs)
            ? entry.runAtMs
            : undefined) ??
          (typeof entry.ts === "number" && Number.isFinite(entry.ts) ? entry.ts : undefined);
        const durationMs =
          typeof entry.durationMs === "number" && Number.isFinite(entry.durationMs)
            ? entry.durationMs
            : undefined;
        const finishedAt =
          (typeof entry.finishedAt === "number" && Number.isFinite(entry.finishedAt)
            ? entry.finishedAt
            : undefined) ??
          (startedAt && durationMs ? startedAt + durationMs : undefined);
        const status =
          entry.status === "ok" || entry.status === "error" || entry.status === "skipped"
            ? entry.status
            : "ok";
        const jobId = entry.jobId || id;
        const fallbackId = startedAt ?? entry.ts ?? index;
        return {
          id: entry.id || `${jobId}:${fallbackId}`,
          jobId,
          startedAt,
          finishedAt,
          status,
          error: entry.error,
          result: entry.result,
          summary: entry.summary,
          durationMs,
          runAtMs: entry.runAtMs,
          ts: entry.ts,
        };
      });
    }
    return result.runs || [];
  }
}

// ── Cron Types ───────────────────────────────────────────────────────

export type CronSchedule =
  | { kind: "at"; atMs: number }
  | { kind: "every"; everyMs: number; anchorMs?: number }
  | { kind: "cron"; expr: string; tz?: string };

export type CronPayload =
  | { kind: "systemEvent"; text: string }
  | {
      kind: "agentTurn";
      message: string;
      deliver?: boolean;
      channel?: "last" | string;
      to?: string;
      bestEffortDeliver?: boolean;
    };

export type CronJobState = "idle" | "running" | "error";

export type CronJob = {
  id: string;
  name: string;
  description?: string;
  schedule: CronSchedule;
  sessionTarget: "main" | "isolated";
  wakeMode?: "next-heartbeat" | "now";
  payload: CronPayload;
  enabled: boolean;
  state: CronJobState;
  lastRunAt?: number;
  nextRunAt?: number;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
};

export type CronRunLogEntry = {
  id: string;
  jobId: string;
  startedAt?: number;
  finishedAt?: number;
  status: "ok" | "error" | "skipped";
  error?: string;
  result?: unknown;
  summary?: string;
  durationMs?: number;
  runAtMs?: number;
  ts?: number;
};

export function getGatewayClient(): GatewayClient | null {
  return null;
}

export function createGatewayClient(url: string, token: string): GatewayClient {
  // Return an isolated client for each caller. Sharing a singleton across
  // chat/files/tasks/integration sync causes websocket handshake races where
  // connect is no longer the first request on a reused socket.
  return new GatewayClient(url, token);
}
