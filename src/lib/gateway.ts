// OpenClaw Gateway WebSocket Client

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
  error?: { code: string; message: string };
};

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
  message?: Message;
  errorMessage?: string;
  usage?: unknown;
  stopReason?: string;
};

type Message = {
  role: "user" | "assistant";
  content: ContentBlock[];
};

type ContentBlock = {
  type: "text";
  text: string;
};

type Session = {
  key: string;  // Session key used for API calls
  sessionId?: string;
  label?: string;
  displayName?: string;
  derivedTitle?: string;
  updatedAt: number | null;
};

type GatewayEvents = {
  connected: () => void;
  disconnected: () => void;
  chat: (event: ChatEvent) => void;
  error: (error: string) => void;
};

export class GatewayClient {
  private ws: WebSocket | null = null;
  private url: string;
  private token: string;
  private requestId = 0;
  private pendingRequests = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private listeners: Partial<{ [K in keyof GatewayEvents]: GatewayEvents[K][] }> = {};
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
      console.log("[Gateway] Connecting to", this.url);
      this.ws = new WebSocket(this.url);

      this.ws.onopen = () => {
        console.log("[Gateway] WebSocket opened, waiting for challenge...");
      };

      this.ws.onmessage = async (event) => {
        try {
          const frame: Frame = JSON.parse(event.data);
          await this.handleFrame(frame, resolve, reject);
        } catch (e) {
          console.error("[Gateway] Failed to parse frame:", e);
        }
      };

      this.ws.onerror = (e) => {
        console.error("[Gateway] WebSocket error:", e);
        this.emit("error", "WebSocket error");
        reject(new Error("WebSocket error"));
      };

      this.ws.onclose = () => {
        console.log("[Gateway] WebSocket closed");
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
        console.log("[Gateway] Received challenge, authenticating...");
        try {
          await this.rpc("connect", {
            minProtocol: 3,
            maxProtocol: 3,
            client: {
              id: "webchat-ui",  // Must be a known client ID
              displayName: "Nova Desktop",
              version: "0.1.0",
              platform: "desktop",
              mode: "ui",  // Must be: webchat, cli, ui, backend, node, probe, test
            },
            role: "operator",
            scopes: ["operator.admin"],
            auth: { token: this.token },
          });
          console.log("[Gateway] Connected successfully");
          this.emit("connected");
          connectResolve?.();
        } catch (e) {
          console.error("[Gateway] Auth failed:", e);
          connectReject?.(e as Error);
        }
      } else if (frame.event === "chat") {
        this.emit("chat", frame.payload as ChatEvent);
      }
    } else if (frame.type === "res") {
      const pending = this.pendingRequests.get(frame.id);
      if (pending) {
        this.pendingRequests.delete(frame.id);
        if (frame.ok) {
          pending.resolve(frame.payload);
        } else {
          pending.reject(new Error(frame.error?.message || "RPC failed"));
        }
      }
    }
  }

  rpc<T = unknown>(method: string, params?: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error("Not connected"));
        return;
      }

      const id = String(++this.requestId);
      const frame: RequestFrame = { type: "req", id, method, params };

      this.pendingRequests.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
      });

      this.ws.send(JSON.stringify(frame));
    });
  }

  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  // API Methods

  async listSessions(): Promise<Session[]> {
    const result = await this.rpc<{ sessions: Session[] }>("sessions.list", {});
    return result.sessions || [];
  }

  async getChatHistory(sessionKey: string, limit = 50): Promise<Message[]> {
    const result = await this.rpc<{ messages: Message[] }>("chat.history", {
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

  async patchSession(sessionKey: string, patch: { model?: string | null }): Promise<void> {
    await this.rpc("sessions.patch", { key: sessionKey, ...patch });
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

// Singleton instance
let client: GatewayClient | null = null;

export function getGatewayClient(): GatewayClient | null {
  return client;
}

export function createGatewayClient(url: string, token: string): GatewayClient {
  if (client) {
    client.disconnect();
  }
  client = new GatewayClient(url, token);
  return client;
}
