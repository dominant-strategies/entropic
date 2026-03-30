#!/usr/bin/env node

import { createPrivateKey, randomUUID, sign as signBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_WS_URL = "ws://localhost:19789";
const DEFAULT_CAPTURE_PATH = path.join(
  os.homedir(),
  ".local",
  "share",
  "ai.openclaw.entropic.dev",
  "rnn-runtime",
  "state",
  "tool-bridge-captures.jsonl",
);
const DEFAULT_RUNTIME_LOG_PATH = path.join(
  os.homedir(),
  ".local",
  "share",
  "ai.openclaw.entropic.dev",
  "rnn-runtime",
  "runtime.log",
);
const DEFAULT_SETTINGS_PATH = path.join(
  os.homedir(),
  ".local",
  "share",
  "ai.openclaw.entropic.dev",
  "entropic-settings.json",
);
const DEFAULT_AUTH_PATH = path.join(
  os.homedir(),
  ".local",
  "share",
  "ai.openclaw.entropic.dev",
  "auth.json",
);
const DEFAULT_COMPAT_CACHE_PATH = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  ".local-model-harness-cache.json",
);
const DEFAULT_DEVICE_IDENTITY_PATH = path.join(
  os.homedir(),
  ".local",
  "share",
  "ai.openclaw.entropic.dev",
  "gateway-device-identity.json",
);
const DEFAULT_SCENARIOS_PATH = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "local-model-scenarios.json",
);
const OPENCLAW_CONTAINER = process.env.ENTROPIC_OPENCLAW_CONTAINER || "entropic-openclaw";

function usage() {
  console.log(`Usage:
  node ./scripts/local-model-harness.mjs scenarios [--scenario-file PATH]
  node ./scripts/local-model-harness.mjs run <scenario-id> [options]
  node ./scripts/local-model-harness.mjs suite [scenario-id ...] [options]

Options:
  --scenario-file PATH        Override the scenario JSON file
  --messages-file PATH        JSON file with an array of message strings
  --message TEXT              Add a message turn manually (repeatable)
  --ws-url URL               Override gateway WebSocket URL
  --token TOKEN              Override gateway auth token
  --capture-path PATH        Override tool-bridge capture path
  --runtime-log PATH         Override managed runtime log path
  --timeout-ms N             Per-turn timeout in milliseconds (default 30000)
  --history-limit N          History fetch limit after each turn (default 80)
  --latest-captures N        Number of recent captures to print per turn (default 3)
  --model NAME               Filter printed captures by exact model name
  --session-model MODEL_REF  Patch the gateway session model before sending turns
  --session-key KEY          Reuse a specific gateway session key
  --bootstrap MODE           full|lightweight (defaults from entropic-settings.json)
  --no-bootstrap             Do not send bootstrapContextMode
  --capture-prompt           Send debugPromptCapture=true
  --no-capture-prompt        Do not send debugPromptCapture
  --disable-tools            Send disableTools=true
  --enable-tools             Do not send disableTools
  --json                     Emit JSON instead of formatted text
`);
}

function parseArgs(argv) {
  const args = {
    _: [],
    messages: [],
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--scenario-file") {
      args.scenarioFile = argv[++i];
    } else if (token === "--messages-file") {
      args.messagesFile = argv[++i];
    } else if (token === "--message") {
      args.messages.push(argv[++i]);
    } else if (token === "--ws-url") {
      args.wsUrl = argv[++i];
    } else if (token === "--token") {
      args.token = argv[++i];
    } else if (token === "--capture-path") {
      args.capturePath = argv[++i];
    } else if (token === "--runtime-log") {
      args.runtimeLog = argv[++i];
    } else if (token === "--timeout-ms") {
      args.timeoutMs = Number.parseInt(argv[++i], 10);
    } else if (token === "--history-limit") {
      args.historyLimit = Number.parseInt(argv[++i], 10);
    } else if (token === "--latest-captures") {
      args.latestCaptures = Number.parseInt(argv[++i], 10);
    } else if (token === "--model") {
      args.model = argv[++i];
    } else if (token === "--session-model") {
      args.sessionModel = argv[++i];
    } else if (token === "--session-key") {
      args.sessionKey = argv[++i];
    } else if (token === "--bootstrap") {
      args.bootstrap = argv[++i];
    } else if (token === "--no-bootstrap") {
      args.noBootstrap = true;
    } else if (token === "--capture-prompt") {
      args.capturePrompt = true;
    } else if (token === "--no-capture-prompt") {
      args.capturePrompt = false;
    } else if (token === "--disable-tools") {
      args.disableTools = true;
    } else if (token === "--enable-tools") {
      args.disableTools = false;
    } else if (token === "--json") {
      args.json = true;
    } else if (token === "--help" || token === "-h") {
      args.help = true;
    } else {
      args._.push(token);
    }
  }
  return args;
}

function loadJsonFile(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath, payload) {
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2) + "\n", "utf8");
}

function loadSettings(settingsPath) {
  return loadJsonFile(settingsPath, {});
}

function loadScenarios(scenarioFile) {
  const scenarios = loadJsonFile(scenarioFile, []);
  if (!Array.isArray(scenarios)) {
    throw new Error(`Scenario file ${scenarioFile} must contain an array`);
  }
  return scenarios;
}

function normalizeText(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function base64UrlToBuffer(value) {
  const normalized = normalizeText(value).replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4 || 4)) % 4);
  return Buffer.from(padded, "base64");
}

function readGatewayDeviceIdentity(identityPath) {
  const payload = loadJsonFile(identityPath, null);
  if (
    !payload ||
    payload.version !== 1 ||
    !normalizeText(payload.device_id) ||
    !normalizeText(payload.public_key) ||
    !normalizeText(payload.private_key)
  ) {
    return null;
  }
  return payload;
}

function buildDeviceAuthPayload({
  deviceId,
  clientId,
  clientMode,
  role,
  scopes,
  signedAtMs,
  token,
  nonce,
}) {
  return [
    "v2",
    deviceId,
    clientId,
    clientMode,
    role,
    scopes.join(","),
    String(signedAtMs),
    token || "",
    nonce || "",
  ].join("|");
}

function signGatewayDevicePayload(identity, payload) {
  const privateKey = createPrivateKey({
    key: {
      kty: "OKP",
      crv: "Ed25519",
      x: identity.public_key,
      d: identity.private_key,
    },
    format: "jwk",
  });
  const signature = signBytes(null, Buffer.from(payload, "utf8"), privateKey);
  return signature.toString("base64url");
}

function resolveMessages(args, scenarios) {
  if (args.messagesFile) {
    const payload = loadJsonFile(args.messagesFile, null);
    if (!Array.isArray(payload) || payload.some((entry) => typeof entry !== "string")) {
      throw new Error(`Messages file ${args.messagesFile} must contain a JSON array of strings`);
    }
    return { id: path.basename(args.messagesFile), description: "messages file", messages: payload };
  }
  if (args.messages.length > 0) {
    return { id: "ad-hoc", description: "messages from CLI", messages: args.messages };
  }
  const scenarioId = args._[1];
  if (!scenarioId) {
    throw new Error("Missing scenario id. Run `scenarios` to list available examples.");
  }
  const scenario = scenarios.find((entry) => entry && entry.id === scenarioId);
  if (!scenario) {
    throw new Error(`Unknown scenario '${scenarioId}'. Run \`scenarios\` to list available examples.`);
  }
  if (!Array.isArray(scenario.messages) || scenario.messages.some((entry) => typeof entry !== "string")) {
    throw new Error(`Scenario '${scenarioId}' does not define a valid messages array.`);
  }
  return scenario;
}

function resolveGatewayToken(explicitToken, authPath) {
  const cliToken = normalizeText(explicitToken);
  if (cliToken) {
    return { token: cliToken, source: "cli" };
  }
  const envToken = normalizeText(process.env.ENTROPIC_GATEWAY_TOKEN);
  if (envToken) {
    return { token: envToken, source: "env" };
  }
  const authJson = loadJsonFile(authPath, {});
  const storedToken = normalizeText(authJson?.gateway_token);
  if (storedToken) {
    return { token: storedToken, source: authPath };
  }
  const docker = spawnSync(
    "docker",
    ["exec", OPENCLAW_CONTAINER, "sh", "-lc", 'printf "%s" "$OPENCLAW_GATEWAY_TOKEN"'],
    { encoding: "utf8" },
  );
  const dockerToken = normalizeText(docker.stdout);
  if (docker.status === 0 && dockerToken) {
    return { token: dockerToken, source: `docker:${OPENCLAW_CONTAINER}` };
  }
  const stderr = normalizeText(docker.stderr);
  throw new Error(
    [
      "Unable to resolve the OpenClaw gateway token.",
      `Tried: --token, ENTROPIC_GATEWAY_TOKEN, ${authPath}, and docker exec ${OPENCLAW_CONTAINER}.`,
      stderr ? `docker exec stderr: ${stderr}` : null,
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

function loadCaptures(capturePath) {
  if (!fs.existsSync(capturePath)) {
    return [];
  }
  const raw = fs.readFileSync(capturePath, "utf8");
  const captures = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object") {
        captures.push(parsed);
      }
    } catch {
      // ignore malformed lines
    }
  }
  return captures;
}

function loadRuntimeLogTail(runtimeLogPath, lineCount = 80) {
  if (!fs.existsSync(runtimeLogPath)) {
    return [];
  }
  const lines = fs.readFileSync(runtimeLogPath, "utf8").split(/\r?\n/);
  return lines.filter(Boolean).slice(-lineCount);
}

function readRuntimeLog(runtimeLogPath) {
  if (!fs.existsSync(runtimeLogPath)) {
    return "";
  }
  return fs.readFileSync(runtimeLogPath, "utf8");
}

function isUnsupportedChatSendOptionsError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (!message.includes("invalid chat.send params")) {
    return false;
  }
  return (
    message.includes("unexpected property 'disableTools'") ||
    message.includes("unexpected property 'bootstrapContextMode'") ||
    message.includes("unexpected property 'debugPromptCapture'")
  );
}

function shortJson(value) {
  return JSON.stringify(value, null, 2);
}

function truncateText(value, maxChars = 1200) {
  const text = normalizeText(value);
  if (!text) {
    return "";
  }
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars - 1)}…`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseToolCallName(value) {
  const text = normalizeText(value);
  if (!text) {
    return "";
  }
  const bareMatch = /^([a-z][a-z0-9_:-]*)\s+\{/i.exec(text);
  if (bareMatch) {
    return normalizeText(bareMatch[1]);
  }
  const tagMatch = /<tools?\.([a-z][a-z0-9_:-]*)>/i.exec(text);
  if (tagMatch) {
    return normalizeText(tagMatch[1]);
  }
  return "";
}

function localModelProviderId(serviceType) {
  switch (normalizeText(serviceType)) {
    case "rnn-local":
      return "rnn";
    case "openai-compatible":
      return "local";
    case "lmstudio":
      return "lmstudio";
    case "vllm":
      return "vllm";
    case "ollama":
    default:
      return "ollama";
  }
}

function localModelApi(serviceType, apiMode) {
  if (normalizeText(serviceType) === "ollama") {
    return "ollama";
  }
  const normalized = normalizeText(apiMode);
  if (normalized === "openai-responses") {
    return "openai-responses";
  }
  return "openai-completions";
}

function rewriteLoopbackForGateway(baseUrl) {
  const trimmed = normalizeText(baseUrl);
  if (!trimmed) {
    return "";
  }
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return trimmed;
  }
  const host = normalizeText(parsed.hostname).toLowerCase();
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1"
  ) {
    parsed.hostname = "host.docker.internal";
    return parsed.toString();
  }
  return trimmed;
}

function gatewayBaseUrlForLocalModel(config) {
  const serviceType = normalizeText(config?.serviceType);
  const baseUrl = normalizeText(config?.baseUrl);
  if (!baseUrl) {
    return "";
  }
  if (serviceType === "rnn-local") {
    return "http://127.0.0.1:11445/v1";
  }
  const rewritten = rewriteLoopbackForGateway(baseUrl).replace(/\/+$/g, "");
  if (serviceType === "ollama") {
    return rewritten.replace(/\/v1$/i, "");
  }
  return rewritten;
}

function inferContextWindow(modelName, serviceType) {
  const normalizedModel = normalizeText(modelName);
  const ctxMatch = /ctx(\d{3,6})/i.exec(normalizedModel);
  if (ctxMatch) {
    const parsed = Number.parseInt(ctxMatch[1], 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  if (/nemotron/i.test(normalizedModel)) {
    return 32768;
  }
  if (normalizeText(serviceType) === "rnn-local") {
    return 8192;
  }
  return 8192;
}

function resolveLocalModelGatewayModelRef(modelRef, settings) {
  const normalized = normalizeText(modelRef);
  if (!normalized) {
    return "";
  }
  if (!normalized.startsWith("local/")) {
    return normalized;
  }
  const providerId = localModelProviderId(settings?.localModelConfig?.serviceType);
  return `${providerId}/${normalized.slice(6)}`;
}

function deriveSessionModelRef(args, settings) {
  const explicit = resolveLocalModelGatewayModelRef(args.sessionModel, settings);
  if (explicit) {
    return explicit;
  }
  const selectedModel = normalizeText(settings?.selectedModel);
  const requestedModelName = normalizeText(args.model);
  if (selectedModel) {
    if (!requestedModelName) {
      return resolveLocalModelGatewayModelRef(selectedModel, settings);
    }
    if (selectedModel === requestedModelName || selectedModel.endsWith(`/${requestedModelName}`)) {
      return resolveLocalModelGatewayModelRef(selectedModel, settings);
    }
  }
  if (
    requestedModelName &&
    settings?.localModelConfig &&
    typeof settings.localModelConfig === "object"
  ) {
    return `${localModelProviderId(settings.localModelConfig.serviceType)}/${requestedModelName}`;
  }
  return resolveLocalModelGatewayModelRef(selectedModel, settings);
}

async function maybeLoadManagedLocalModel(settings, requestedModelName) {
  const modelName = normalizeText(requestedModelName);
  const serviceType = normalizeText(settings?.localModelConfig?.serviceType);
  const baseUrl = normalizeText(settings?.localModelConfig?.baseUrl);
  if (!modelName || serviceType !== "rnn-local" || !baseUrl) {
    return { attempted: false, loaded: false, error: null };
  }
  try {
    const rootUrl = baseUrl.replace(/\/v1\/?$/i, "");
    const response = await fetch(`${rootUrl}/api/rnn/models/load`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ modelName }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      return {
        attempted: true,
        loaded: false,
        error:
          normalizeText(payload?.error?.message) ||
          normalizeText(payload?.error) ||
          `HTTP ${response.status}`,
      };
    }
    return { attempted: true, loaded: true, error: null, payload };
  } catch (error) {
    return {
      attempted: true,
      loaded: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function buildGatewayProviderConfig(settings, requestedModelName) {
  const localModelConfig =
    settings?.localModelConfig && typeof settings.localModelConfig === "object"
      ? settings.localModelConfig
      : null;
  if (!localModelConfig) {
    return null;
  }
  const modelName =
    normalizeText(requestedModelName) || normalizeText(localModelConfig.modelName);
  const serviceType = normalizeText(localModelConfig.serviceType);
  const providerId = localModelProviderId(serviceType);
  const baseUrl = gatewayBaseUrlForLocalModel(localModelConfig);
  if (!modelName || !providerId || !baseUrl) {
    return null;
  }
  const api = localModelApi(serviceType, localModelConfig.apiMode);
  const contextWindow = inferContextWindow(modelName, serviceType);
  return {
    providerId,
    modelName,
    modelRef: `${providerId}/${modelName}`,
    value: {
      baseUrl,
      apiKey: normalizeText(localModelConfig.apiKey) || "local-placeholder",
      api,
      models: [
        {
          id: modelName,
          name: modelName,
          input: ["text"],
          reasoning: false,
          contextWindow,
          maxTokens: 8192,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
    },
  };
}

function extractText(value) {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map((block) => {
        if (block && typeof block === "object" && typeof block.text === "string") {
          return block.text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function summarizeHistoryMessage(message) {
  const role = normalizeText(message?.role) || "unknown";
  const toolName = normalizeText(message?.toolName);
  const toolCallId = normalizeText(message?.toolCallId);
  const text = truncateText(message?.text) || truncateText(extractText(message?.content));
  if (role === "toolResult") {
    return `toolResult${toolName ? `:${toolName}` : ""}${toolCallId ? `(${toolCallId})` : ""} ${text || shortJson(message)}`;
  }
  if (toolName) {
    return `${role}:${toolName} ${text || shortJson(message)}`;
  }
  return `${role} ${text || shortJson(message)}`;
}

class GatewayHarnessClient {
  constructor({
    url,
    token,
    origin = "http://localhost",
    deviceIdentity = null,
    legacyChatSendOptionsUnsupported = false,
    onLegacyCompatibilityDetected = null,
  }) {
    this.url = url;
    this.token = token;
    this.origin = origin;
    this.deviceIdentity = deviceIdentity;
    this.ws = null;
    this.requestId = 0;
    this.pending = new Map();
    this.chatListeners = new Set();
    this.legacyChatSendOptionsUnsupported = legacyChatSendOptionsUnsupported;
    this.onLegacyCompatibilityDetected = onLegacyCompatibilityDetected;
  }

  async connect() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timeoutHandle = setTimeout(() => {
        cleanup();
        reject(new Error("Gateway connection timed out waiting for connect.challenge/connect response"));
      }, 15000);

      const cleanup = () => {
        clearTimeout(timeoutHandle);
      };

      const resolveOnce = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };

      const rejectOnce = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };

      const ws = new WebSocket(this.url, { headers: { Origin: this.origin } });
      this.ws = ws;

      ws.addEventListener("message", (event) => {
        let frame;
        try {
          frame = JSON.parse(String(event.data));
        } catch (error) {
          rejectOnce(new Error(`Failed to parse gateway frame: ${error instanceof Error ? error.message : String(error)}`));
          return;
        }

        if (frame?.type === "event" && frame.event === "connect.challenge") {
          const clientId = "openclaw-control-ui";
          const clientMode = "ui";
          const role = "operator";
          const scopes = ["operator.admin", "operator.read", "operator.write", "operator.approvals", "operator.pairing"];
          const nonce = normalizeText(frame?.payload?.nonce);
          let device;
          if (this.deviceIdentity) {
            const signedAtMs = Date.now();
            const payload = buildDeviceAuthPayload({
              deviceId: this.deviceIdentity.device_id,
              clientId,
              clientMode,
              role,
              scopes,
              signedAtMs,
              token: this.token,
              nonce,
            });
            const signature = signGatewayDevicePayload(this.deviceIdentity, payload);
            device = {
              id: this.deviceIdentity.device_id,
              publicKey: this.deviceIdentity.public_key,
              signature,
              signedAt: signedAtMs,
              nonce,
            };
          }
          const payload = {
            type: "req",
            id: "__connect__",
            method: "connect",
            params: {
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
              auth: { token: this.token },
              device,
              caps: [],
              locale: "en-US",
              userAgent: "Entropic Local Model Harness",
            },
          };
          ws.send(JSON.stringify(payload));
          return;
        }

        if (frame?.type === "event" && frame.event === "chat") {
          for (const listener of this.chatListeners) {
            try {
              listener(frame.payload);
            } catch {
              // ignore
            }
          }
          return;
        }

        if (frame?.type === "res") {
          if (frame.id === "__connect__") {
            if (frame.ok) {
              resolveOnce();
            } else {
              const message =
                frame?.error?.message || "Gateway rejected connect request";
              rejectOnce(new Error(message));
            }
            return;
          }
          const pending = this.pending.get(frame.id);
          if (!pending) {
            return;
          }
          this.pending.delete(frame.id);
          clearTimeout(pending.timeoutHandle);
          if (frame.ok) {
            pending.resolve(frame.payload);
          } else {
            pending.reject(new Error(frame?.error?.message || `Gateway RPC ${pending.method} failed`));
          }
        }
      });

      ws.addEventListener("error", () => {
        // close event usually follows with better detail
      });

      ws.addEventListener("close", (event) => {
        const error = new Error(
          `Gateway socket closed${event.code ? ` (code=${event.code}` : ""}${event.reason ? ` reason=${event.reason}` : ""}${event.code ? ")" : ""}`,
        );
        rejectOnce(error);
        for (const [id, pending] of this.pending) {
          clearTimeout(pending.timeoutHandle);
          pending.reject(new Error(`Gateway socket closed before ${pending.method} response (id=${id})`));
        }
        this.pending.clear();
      });
    });
  }

  disconnect() {
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
    this.ws = null;
  }

  onChat(listener) {
    this.chatListeners.add(listener);
    return () => {
      this.chatListeners.delete(listener);
    };
  }

  rpc(method, params = {}, timeoutMs = 20000) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Gateway socket is not connected"));
    }
    const id = `rpc-${++this.requestId}`;
    const frame = {
      type: "req",
      id,
      method,
      params,
    };
    return new Promise((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Gateway RPC ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timeoutHandle });
      this.ws.send(JSON.stringify(frame));
    });
  }

  createSessionKey() {
    return `agent:main:${randomUUID()}`;
  }

  async sendMessage(sessionKey, message, options = {}) {
    const idempotencyKey = randomUUID();
    const params = {
      sessionKey,
      message,
      attachments: undefined,
      idempotencyKey,
    };
    if (options.disableTools === true) {
      params.disableTools = true;
    }
    if (!this.legacyChatSendOptionsUnsupported && options.bootstrapContextMode) {
      params.bootstrapContextMode = options.bootstrapContextMode;
    }
    if (!this.legacyChatSendOptionsUnsupported && options.debugPromptCapture === true) {
      params.debugPromptCapture = true;
    }
    try {
      const response = await this.rpc("chat.send", params, 30000);
      return response?.runId;
    } catch (error) {
      if (
        (options.disableTools === true || options.bootstrapContextMode || options.debugPromptCapture === true) &&
        isUnsupportedChatSendOptionsError(error)
      ) {
        this.legacyChatSendOptionsUnsupported = true;
        if (typeof this.onLegacyCompatibilityDetected === "function") {
          try {
            this.onLegacyCompatibilityDetected();
          } catch {
            // best-effort
          }
        }
        const fallbackResponse = await this.rpc(
          "chat.send",
          {
            sessionKey,
            message,
            attachments: undefined,
            idempotencyKey,
            ...(options.disableTools === true ? { disableTools: true } : {}),
          },
          30000,
        );
        return fallbackResponse?.runId;
      }
      throw error;
    }
  }

  async getChatHistory(sessionKey, limit = 80) {
    const response = await this.rpc("chat.history", { sessionKey, limit }, 20000);
    return Array.isArray(response?.messages) ? response.messages : [];
  }

  async patchSession(sessionKey, patch = {}) {
    return this.rpc("sessions.patch", { key: sessionKey, ...patch }, 20000);
  }

  async getConfig(pathValue = null) {
    const params = pathValue ? { path: pathValue } : {};
    return this.rpc("config.get", params, 20000);
  }

  async patchConfig(rawPatch, baseHash) {
    return this.rpc(
      "config.patch",
      {
        raw: JSON.stringify(rawPatch),
        baseHash,
        restartDelayMs: 0,
      },
      30000,
    );
  }
}

async function activateGatewayModel(client, settings, requestedModelName) {
  const providerConfig = buildGatewayProviderConfig(settings, requestedModelName);
  if (!providerConfig) {
    return {
      attempted: false,
      applied: false,
      modelRef: "",
      providerId: "",
      error: null,
    };
  }
  try {
    const current = await client.getConfig();
    const currentConfig =
      current && typeof current === "object" && current.config && typeof current.config === "object"
        ? current.config
        : {};
    const currentPrimary = normalizeText(
      currentConfig?.agents?.defaults?.model?.primary,
    );
    const currentProvider =
      currentConfig?.models?.providers?.[providerConfig.providerId] || null;
    const currentProviderBaseUrl = normalizeText(currentProvider?.baseUrl);
    const currentProviderApi = normalizeText(currentProvider?.api);
    const currentProviderModel = normalizeText(currentProvider?.models?.[0]?.id);
    if (
      currentPrimary === providerConfig.modelRef &&
      currentProviderBaseUrl === providerConfig.value.baseUrl &&
      currentProviderApi === providerConfig.value.api &&
      currentProviderModel === providerConfig.modelName
    ) {
      return {
        attempted: true,
        applied: true,
        alreadyActive: true,
        modelRef: providerConfig.modelRef,
        providerId: providerConfig.providerId,
        providerBaseUrl: providerConfig.value.baseUrl,
        providerApi: providerConfig.value.api,
        error: null,
      };
    }
    const baseHash = normalizeText(current?.hash);
    if (!baseHash) {
      throw new Error("config.get did not return a base hash");
    }
    const patch = {
      agents: {
        defaults: {
          model: {
            primary: providerConfig.modelRef,
          },
        },
      },
      models: {
        providers: {
          [providerConfig.providerId]: providerConfig.value,
        },
      },
    };
    await client.patchConfig(patch, baseHash);
    client.disconnect();
    await sleep(2500);
    let lastError = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (attempt > 0) {
        await sleep(attempt < 5 ? 500 : 1000);
      }
      try {
        await client.connect();
        lastError = null;
        break;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    if (lastError) {
      throw new Error(`gateway reconnect failed after config.patch: ${lastError}`);
    }
    return {
      attempted: true,
      applied: true,
      modelRef: providerConfig.modelRef,
      providerId: providerConfig.providerId,
      providerBaseUrl: providerConfig.value.baseUrl,
      providerApi: providerConfig.value.api,
      error: null,
    };
  } catch (error) {
    return {
      attempted: true,
      applied: false,
      modelRef: providerConfig.modelRef,
      providerId: providerConfig.providerId,
      providerBaseUrl: providerConfig.value.baseUrl,
      providerApi: providerConfig.value.api,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function waitForRun(client, { runId, sessionKey, timeoutMs }) {
  const startedAt = Date.now();
  const events = [];
  let done = false;
  const stopListening = client.onChat((event) => {
    if (!event || event.runId !== runId) {
      return;
    }
    events.push(event);
    if (event.state === "final" || event.state === "aborted" || event.state === "error") {
      done = true;
    }
  });

  try {
    while (Date.now() - startedAt < timeoutMs) {
      if (done) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    let waitPayload = null;
    if (!done) {
      try {
        waitPayload = await client.rpc(
          "agent.wait",
          { runId, timeoutMs: Math.max(1000, timeoutMs - (Date.now() - startedAt)) },
          Math.max(timeoutMs, 10000),
        );
      } catch (error) {
        waitPayload = { error: error instanceof Error ? error.message : String(error) };
      }
    }
    const history = await client.getChatHistory(sessionKey, 80);
    return { events, history, waitPayload };
  } finally {
    stopListening();
  }
}

function summarizeCapture(record) {
  return {
    capturedAt: record?.capturedAt ?? null,
    requestId: record?.requestId ?? null,
    finishReason: record?.finishReason ?? null,
    latestUserText: record?.latestUserText ?? null,
    parsedToolCallNames: record?.parsedToolCallNames ?? [],
    rawContent: record?.rawContent ?? "",
    cleanedContent: record?.cleanedContent ?? "",
    toolChoiceRequested: record?.toolChoiceRequested ?? null,
    toolChoiceEffective: record?.toolChoiceEffective ?? null,
  };
}

function filterRecentCaptures(captures, { startMs, latestUserText, model, count }) {
  let filtered = captures;
  if (model) {
    filtered = filtered.filter((record) => record?.model === model);
  }
  filtered = filtered.filter((record) => {
    const capturedAt = Date.parse(String(record?.capturedAt || ""));
    if (Number.isFinite(capturedAt) && capturedAt >= startMs - 5000) {
      return true;
    }
    return false;
  });
  if (latestUserText) {
    const exact = filtered.filter((record) => record?.latestUserText === latestUserText);
    if (exact.length > 0) {
      filtered = exact;
    }
  }
  return filtered.slice(-count).map(summarizeCapture);
}

function extractAssistantMessages(history, previousLength) {
  return history
    .slice(previousLength)
    .filter((message) => normalizeText(message?.role) === "assistant")
    .map((message) => {
      const content = Array.isArray(message?.content) ? message.content : [];
      const toolCalls = content
        .filter((block) => block && typeof block === "object" && normalizeText(block.type) === "toolCall")
        .map((block) => {
          const name = normalizeText(block?.name) || "unknown";
          const argumentsText = truncateText(shortJson(block?.arguments ?? {}), 240);
          return `${name} ${argumentsText}`.trim();
        });
      const plainText =
        truncateText(message?.text) || truncateText(extractText(message?.content));
      return {
        role: "assistant",
        text: plainText || (toolCalls.length > 0 ? `[toolCall] ${toolCalls.join(" | ")}` : ""),
        meta: {
          stopReason: normalizeText(message?.stopReason),
          errorMessage: truncateText(message?.errorMessage, 400),
          timestamp: message?.timestamp ?? null,
          toolCalls,
          toolCallNames: toolCalls.map(parseToolCallName).filter(Boolean),
          model: normalizeText(message?.model),
          provider: normalizeText(message?.provider),
        },
      };
    });
}

function extractToolResults(history, previousLength) {
  return history
    .slice(previousLength)
    .filter((message) => normalizeText(message?.role) === "toolResult")
    .map((message) => ({
      role: "toolResult",
      toolName: normalizeText(message?.toolName),
      text: truncateText(message?.text) || truncateText(extractText(message?.content)),
      meta: {
        toolCallId: normalizeText(message?.toolCallId),
        timestamp: message?.timestamp ?? null,
      },
    }));
}

function deriveTurnStatus(turn) {
  const eventStates = new Set(
    (turn.events || [])
      .map((event) => normalizeText(event?.state))
      .filter(Boolean),
  );
  const preferredAssistantText =
    (turn.assistantMessages || [])
      .filter((message) => normalizeText(message?.meta?.stopReason) !== "toolUse")
      .map((message) => normalizeText(message?.text))
      .filter(Boolean)
      .at(-1) || "";
  const finalAssistantText =
    preferredAssistantText ||
    (turn.assistantMessages || [])
      .map((message) => normalizeText(message?.text))
      .filter(Boolean)
      .at(-1) || "";
  const parsedToolCalls = (turn.captures || []).flatMap((capture) =>
    Array.isArray(capture?.parsedToolCallNames) ? capture.parsedToolCallNames : [],
  );
  const historyToolCalls = (turn.assistantMessages || []).flatMap((message) =>
    Array.isArray(message?.meta?.toolCallNames) ? message.meta.toolCallNames : [],
  );
  const actualModels = Array.from(
    new Set(
      (turn.assistantMessages || [])
        .map((message) => normalizeText(message?.meta?.model))
        .filter(Boolean),
    ),
  );
  const hasToolResults = (turn.toolResults || []).length > 0;
  return {
    hasToolCall:
      parsedToolCalls.length > 0 ||
      historyToolCalls.length > 0 ||
      normalizeText(turn.toolCall) === "seen",
    hasToolResult: hasToolResults,
    hasAssistantText: Boolean(finalAssistantText),
    finalAssistantText: truncateText(finalAssistantText, 280),
    eventStates: Array.from(eventStates),
    parsedToolCalls: Array.from(new Set([...parsedToolCalls, ...historyToolCalls])),
    actualModels,
  };
}

function printScenarioList(scenarios, asJson) {
  if (asJson) {
    console.log(JSON.stringify(scenarios, null, 2));
    return;
  }
  for (const scenario of scenarios) {
    console.log(`${scenario.id}`);
    console.log(`  ${scenario.description}`);
    for (const message of scenario.messages || []) {
      console.log(`  - ${message}`);
    }
    console.log("");
  }
}

function printTurnSummary(turn, { json = false }) {
  if (json) {
    console.log(JSON.stringify(turn, null, 2));
    return;
  }
  console.log(`Turn ${turn.turn}: ${turn.user}`);
  console.log(`  runId: ${turn.runId}`);
  console.log(`  events: ${turn.events.length}`);
  if (turn.waitPayload) {
    console.log(`  agent.wait: ${shortJson(turn.waitPayload)}`);
  }
  if (turn.assistantMessages.length === 0) {
    console.log("  assistant: <none>");
  } else {
    for (const [index, message] of turn.assistantMessages.entries()) {
      console.log(`  assistant[${index + 1}]: ${message.text || shortJson(message.meta)}`);
    }
  }
  if (turn.toolResults.length > 0) {
    for (const [index, result] of turn.toolResults.entries()) {
      console.log(
        `  toolResult[${index + 1}]${result.toolName ? ` (${result.toolName})` : ""}: ${result.text || shortJson(result.meta)}`,
      );
    }
  }
  if (turn.historyDelta.length > 0) {
    console.log("  historyDelta:");
    for (const entry of turn.historyDelta) {
      console.log(`    - ${entry}`);
    }
  }
  if (turn.captures.length === 0) {
    console.log("  captures: <none>");
  } else {
    for (const capture of turn.captures) {
      console.log(
        `  capture ${capture.requestId || "?"}: finish=${capture.finishReason || "?"} parsedToolCalls=${JSON.stringify(capture.parsedToolCallNames || [])}`,
      );
      if (capture.rawContent) {
        console.log(`    raw: ${truncateText(capture.rawContent, 800)}`);
      }
      if (capture.cleanedContent && capture.cleanedContent !== capture.rawContent) {
        console.log(`    cleaned: ${truncateText(capture.cleanedContent, 800)}`);
      }
    }
  }
}

async function runScenario(args) {
  const scenarioFile = path.resolve(args.scenarioFile || DEFAULT_SCENARIOS_PATH);
  const scenarios = loadScenarios(scenarioFile);
  const scenario = resolveMessages(args, scenarios);
  const settingsPath = DEFAULT_SETTINGS_PATH;
  const settings = loadSettings(settingsPath);
  const capturePath = path.resolve(args.capturePath || DEFAULT_CAPTURE_PATH);
  const runtimeLogPath = path.resolve(args.runtimeLog || DEFAULT_RUNTIME_LOG_PATH);
  const timeoutMs = Number.isFinite(args.timeoutMs) ? args.timeoutMs : 30000;
  const historyLimit = Number.isFinite(args.historyLimit) ? args.historyLimit : 80;
  const latestCaptures = Number.isFinite(args.latestCaptures) ? args.latestCaptures : 3;
  const bootstrapContextMode = args.noBootstrap
    ? undefined
    : args.bootstrap || (settings?.localLightweightBootstrap ? "lightweight" : undefined);
  const debugPromptCapture =
    typeof args.capturePrompt === "boolean"
      ? args.capturePrompt
      : Boolean(settings?.localCapturePromptPreview);
  const disableTools =
    typeof args.disableTools === "boolean"
      ? args.disableTools
      : Boolean(settings?.localDisableTools);
  const gatewayToken = resolveGatewayToken(args.token, DEFAULT_AUTH_PATH);
  const sessionModelRef = deriveSessionModelRef(args, settings);
  const managedLoad = await maybeLoadManagedLocalModel(
    settings,
    args.model || settings?.localModelConfig?.modelName,
  );
  const deviceIdentity = readGatewayDeviceIdentity(DEFAULT_DEVICE_IDENTITY_PATH);
  const compatCachePath = path.resolve(DEFAULT_COMPAT_CACHE_PATH);
  const compatCache = loadJsonFile(compatCachePath, {});
  const wsUrl = normalizeText(args.wsUrl) || DEFAULT_WS_URL;
  const client = new GatewayHarnessClient({
    url: wsUrl,
    token: gatewayToken.token,
    deviceIdentity,
    legacyChatSendOptionsUnsupported: Boolean(compatCache?.legacyChatSendOptionsUnsupported),
    onLegacyCompatibilityDetected: () => {
      writeJsonFile(compatCachePath, { legacyChatSendOptionsUnsupported: true });
    },
  });
  let sessionKey = normalizeText(args.sessionKey) || client.createSessionKey();
  const allCapturesBefore = loadCaptures(capturePath);
  const runtimeLogBeforeRaw = readRuntimeLog(runtimeLogPath);

  await client.connect();
  let history = [];
  const turns = [];
  const gatewayActivation = await activateGatewayModel(
    client,
    settings,
    args.model || settings?.localModelConfig?.modelName,
  );
  let sessionPatchResult = null;
  try {
    if (sessionModelRef) {
      const patched = await client.patchSession(sessionKey, { model: sessionModelRef });
      sessionPatchResult = patched || null;
      const canonicalKey = normalizeText(patched?.key);
      if (canonicalKey) {
        sessionKey = canonicalKey;
      }
    }
    for (let index = 0; index < scenario.messages.length; index += 1) {
      const userMessage = scenario.messages[index];
      const historyBeforeLength = history.length;
      const turnStartMs = Date.now();
      const runId = await client.sendMessage(sessionKey, userMessage, {
        disableTools,
        bootstrapContextMode,
        debugPromptCapture,
      });
      const completion = await waitForRun(client, { runId, sessionKey, timeoutMs });
      history = Array.isArray(completion.history) ? completion.history.slice(-historyLimit) : [];
      const captures = filterRecentCaptures(loadCaptures(capturePath), {
        startMs: turnStartMs,
        latestUserText: userMessage,
        model: args.model || settings?.localModelConfig?.modelName || null,
        count: latestCaptures,
      });
      turns.push({
        turn: index + 1,
        user: userMessage,
        runId,
        sessionKey,
        events: completion.events,
        waitPayload: completion.waitPayload,
        assistantMessages: extractAssistantMessages(history, historyBeforeLength),
        toolResults: extractToolResults(history, historyBeforeLength),
        historyDelta: history.slice(historyBeforeLength).map(summarizeHistoryMessage),
        captures,
      });
    }
  } finally {
    try {
      await client.rpc("sessions.delete", { key: sessionKey }, 10000);
    } catch {
      // ignore cleanup failures
    }
    client.disconnect();
  }

  const runtimeLogAfterRaw = readRuntimeLog(runtimeLogPath);
  const runtimeLogDelta = runtimeLogAfterRaw.startsWith(runtimeLogBeforeRaw)
    ? runtimeLogAfterRaw.slice(runtimeLogBeforeRaw.length)
    : runtimeLogAfterRaw;
  const runtimeLogDeltaLines = runtimeLogDelta.split(/\r?\n/).filter(Boolean);
  const runtimeLogAfter = loadRuntimeLogTail(runtimeLogPath, 120);
  const summary = {
    scenario: scenario.id,
    description: scenario.description,
    gateway: {
      wsUrl,
      tokenSource: gatewayToken.source,
      deviceIdentitySource: deviceIdentity ? DEFAULT_DEVICE_IDENTITY_PATH : null,
      legacyChatSendOptionsUnsupported: client.legacyChatSendOptionsUnsupported,
      compatCachePath,
      sessionKey,
    },
    settings: {
      bootstrapContextMode: bootstrapContextMode || null,
      debugPromptCapture,
      disableTools,
      sessionModelRef: sessionModelRef || null,
      managedLoad,
      gatewayActivation,
      sessionPatchResult,
      selectedModel:
        args.model ||
        settings?.localModelConfig?.modelName ||
        settings?.selectedModel ||
        null,
      settingsPath,
      capturePath,
      runtimeLogPath,
    },
    turns,
    runtimeLogTail: runtimeLogAfter,
    runtimeLogDelta: runtimeLogDeltaLines,
    captureCountDelta: Math.max(0, loadCaptures(capturePath).length - allCapturesBefore.length),
  };
  summary.turnSummaries = turns.map((turn) => ({
    turn: turn.turn,
    user: turn.user,
    ...deriveTurnStatus(turn),
  }));

  return summary;
}

function printSingleScenarioSummary(summary, asJson = false) {
  if (asJson) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log(`Scenario: ${summary.scenario}`);
  console.log(`Description: ${summary.description}`);
  console.log(`Gateway: ${summary.gateway.wsUrl} (${summary.gateway.tokenSource})`);
  console.log(`Session: ${summary.gateway.sessionKey}`);
  console.log(
    `Options: bootstrap=${summary.settings.bootstrapContextMode || "none"} debugPromptCapture=${summary.settings.debugPromptCapture ? "on" : "off"} disableTools=${summary.settings.disableTools ? "on" : "off"}`,
  );
  console.log("");
  for (const turn of summary.turns) {
    printTurnSummary(turn, { json: false });
    console.log("");
  }
  const runtimeLinesToPrint =
    summary.runtimeLogDelta.length > 0
      ? summary.runtimeLogDelta
      : summary.runtimeLogTail.slice(-20);
  console.log(summary.runtimeLogDelta.length > 0 ? "Runtime log delta:" : "Recent runtime log lines:");
  for (const line of runtimeLinesToPrint) {
    console.log(`  ${line}`);
  }
}

async function runSuite(args) {
  const scenarioFile = path.resolve(args.scenarioFile || DEFAULT_SCENARIOS_PATH);
  const scenarios = loadScenarios(scenarioFile);
  const requestedIds = args._.slice(1);
  const selectedScenarios =
    requestedIds.length > 0
      ? requestedIds.map((scenarioId) => {
          const scenario = scenarios.find((entry) => entry && entry.id === scenarioId);
          if (!scenario) {
            throw new Error(`Unknown scenario '${scenarioId}'. Run \`scenarios\` to list available examples.`);
          }
          return scenario;
        })
      : scenarios;
  const results = [];
  for (const scenario of selectedScenarios) {
    results.push(await runScenario({ ...args, _: ["run", scenario.id] }));
  }
  if (args.json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }
  for (const [index, summary] of results.entries()) {
    if (index > 0) {
      console.log("\n---\n");
    }
    const turnStatus = summary.turnSummaries
      .map(
        (turn) =>
          `turn ${turn.turn}: toolCall=${turn.hasToolCall ? "yes" : "no"} toolResult=${turn.hasToolResult ? "yes" : "no"} reply=${turn.hasAssistantText ? "yes" : "no"}${turn.finalAssistantText ? ` text=${JSON.stringify(turn.finalAssistantText)}` : ""}`,
      )
      .join("\n");
    console.log(`${summary.scenario}`);
    console.log(`  ${summary.description}`);
    console.log(`  ${turnStatus}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args._.length === 0) {
    usage();
    process.exit(args.help ? 0 : 1);
  }
  const command = args._[0];
  if (command === "scenarios") {
    const scenarios = loadScenarios(path.resolve(args.scenarioFile || DEFAULT_SCENARIOS_PATH));
    printScenarioList(scenarios, args.json);
    return;
  }
  if (command === "run") {
    const summary = await runScenario(args);
    printSingleScenarioSummary(summary, args.json);
    return;
  }
  if (command === "suite") {
    await runSuite(args);
    return;
  }
  usage();
  process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
