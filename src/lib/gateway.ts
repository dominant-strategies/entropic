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

type ChatEvent = {
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
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;

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
              displayName: "Zara Desktop",
              version: "0.1.0",
              platform: "desktop",
              mode: "ui",  // Must be: webchat, cli, ui, backend, node, probe, test
            },
            role: "operator",
            scopes: ["operator.admin"],
            auth: { token: this.token },
          });
          console.log("[Gateway] Connected successfully");
          this.reconnectAttempts = 0;
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

  private rpc<T = unknown>(method: string, params?: unknown): Promise<T> {
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

  async getConfig(): Promise<unknown> {
    return this.rpc("config.get");
  }

  async setConfig(path: string, value: unknown): Promise<void> {
    await this.rpc("config.set", { path, value });
  }
}

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
