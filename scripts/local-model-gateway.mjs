#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SCRIPT_DIR = path.dirname(new URL(import.meta.url).pathname);
const DEFAULT_PROFILES_PATH = path.join(SCRIPT_DIR, "local-model-profiles.json");
const DEFAULT_STATE_ROOT = path.join("/tmp", "entropic-openclaw-harness");
const DEFAULT_CONTAINER = process.env.ENTROPIC_OPENCLAW_HARNESS_CONTAINER || "entropic-openclaw-harness";
const DEFAULT_IMAGE = process.env.ENTROPIC_OPENCLAW_HARNESS_IMAGE || "openclaw-runtime:latest";
const DEFAULT_GATEWAY_PORT = Number.parseInt(process.env.ENTROPIC_OPENCLAW_HARNESS_PORT || "19889", 10);
const DEFAULT_BROWSER_HOST_PORT = Number.parseInt(
  process.env.ENTROPIC_OPENCLAW_HARNESS_BROWSER_PORT || "19991",
  10,
);
const DEFAULT_CAPTURE_PATH = path.join(
  os.homedir(),
  ".local",
  "share",
  "ai.openclaw.entropic.dev",
  "rnn-runtime",
  "state",
  "tool-bridge-captures.jsonl",
);
const RNN_RUNTIME_BRIDGE_DIR = path.join(
  os.homedir(),
  ".local",
  "share",
  "ai.openclaw.entropic.dev",
  "rnn-runtime",
  "bridge",
);
const RNN_RUNTIME_CONTAINER_BRIDGE_DIR = "/data/managed-runtime-bridge";
const RNN_RUNTIME_CONTAINER_SOCKET = `${RNN_RUNTIME_CONTAINER_BRIDGE_DIR}/runtime.sock`;
const OPENCLAW_CONTEXT_WINDOW_MIN = 16000;
const GATEWAY_SCHEMA_VERSION = "2026-02-13";
const DEFAULT_SEED_CONTAINER = process.env.ENTROPIC_OPENCLAW_SEED_CONTAINER || "entropic-openclaw";

function usage() {
  console.log(`Usage:
  node ./scripts/local-model-gateway.mjs ensure --profile <profile-id> [options]
  node ./scripts/local-model-gateway.mjs status [options]
  node ./scripts/local-model-gateway.mjs stop [options]

Options:
  --profile ID            Profile id from local-model-profiles.json
  --profiles PATH         Override profiles JSON path
  --container NAME        Override container name
  --image NAME            Override runtime image
  --port N                Override gateway host port (default 19889)
  --browser-port N        Override browser host port (default 19991)
  --state-root PATH       Override state root (default /tmp/entropic-openclaw-harness)
  --fixture-root PATH     Bind-mount fixture root into the container at the same path
  --capture-path PATH     Include this capture path in JSON output
  --json                  Emit JSON
`);
}

function parseArgs(argv) {
  const args = {
    _: [],
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--profile") {
      args.profile = argv[++i];
    } else if (token === "--profiles") {
      args.profilesPath = argv[++i];
    } else if (token === "--container") {
      args.container = argv[++i];
    } else if (token === "--image") {
      args.image = argv[++i];
    } else if (token === "--port") {
      args.port = Number.parseInt(argv[++i], 10);
    } else if (token === "--browser-port") {
      args.browserPort = Number.parseInt(argv[++i], 10);
    } else if (token === "--state-root") {
      args.stateRoot = argv[++i];
    } else if (token === "--fixture-root") {
      args.fixtureRoot = argv[++i];
    } else if (token === "--capture-path") {
      args.capturePath = argv[++i];
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

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function safeSlug(value) {
  return normalizeText(value)
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function stableProfileOffset(profileId) {
  const normalized = safeSlug(profileId);
  let hash = 0;
  for (let index = 0; index < normalized.length; index += 1) {
    hash = (hash * 31 + normalized.charCodeAt(index)) % 997;
  }
  return hash;
}

function derivedContainerName(baseContainer, profileId, explicitContainer = "") {
  const normalizedExplicit = normalizeText(explicitContainer);
  if (normalizedExplicit) {
    return normalizedExplicit;
  }
  return `${baseContainer}-${safeSlug(profileId)}`;
}

function derivedPort(basePort, profileId, explicitPort) {
  if (Number.isFinite(explicitPort)) {
    return explicitPort;
  }
  return basePort + stableProfileOffset(profileId);
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2) + "\n", "utf8");
}

function loadProfiles(profilesPath) {
  const payload = readJson(profilesPath, null);
  if (!payload || !Array.isArray(payload.profiles)) {
    throw new Error(`Invalid profiles manifest at ${profilesPath}`);
  }
  return payload.profiles;
}

function findProfile(profiles, profileId) {
  const profile = profiles.find((entry) => entry.id === profileId);
  if (!profile) {
    throw new Error(`Unknown profile '${profileId}'`);
  }
  return profile;
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
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
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

function buildGatewaySpec(profile) {
  const localModelConfig =
    profile?.localModelConfig && typeof profile.localModelConfig === "object"
      ? profile.localModelConfig
      : null;
  if (!localModelConfig) {
    throw new Error(`Profile ${profile?.id || "<unknown>"} is missing localModelConfig`);
  }
  const modelName = normalizeText(localModelConfig.modelName);
  const serviceType = normalizeText(localModelConfig.serviceType);
  const providerId = localModelProviderId(serviceType);
  const baseUrl = gatewayBaseUrlForLocalModel(localModelConfig);
  if (!modelName || !providerId || !baseUrl) {
    throw new Error(`Profile ${profile.id} does not define a complete local model gateway config`);
  }
  const actualContextWindow = inferContextWindow(modelName, serviceType);
  const declaredContextWindow = Math.max(
    Number.parseInt(localModelConfig.gatewayContextWindow || "0", 10) || 0,
    actualContextWindow,
    OPENCLAW_CONTEXT_WINDOW_MIN,
  );
  return {
    profileId: profile.id,
    modelName,
    serviceType,
    providerId,
    api: localModelApi(serviceType, localModelConfig.apiMode),
    baseUrl,
    modelRef: `${providerId}/${modelName}`,
    actualContextWindow,
    declaredContextWindow,
    apiKey: normalizeText(localModelConfig.apiKey) || "local-placeholder",
    requiresManagedRuntimeBridge: serviceType === "rnn-local",
  };
}

function runDocker(args, options = {}) {
  const result = spawnSync("docker", args, {
    encoding: "utf8",
    ...options,
  });
  return {
    ...result,
    stdoutText: normalizeText(result.stdout),
    stderrText: normalizeText(result.stderr),
  };
}

function ensureImage(image) {
  const inspect = runDocker(["image", "inspect", image]);
  if (inspect.status !== 0) {
    throw new Error(
      `Runtime image ${image} is unavailable. Build it first with ./scripts/build-openclaw-runtime.sh`,
    );
  }
}

function containerExists(container) {
  const inspect = runDocker(["inspect", container]);
  return inspect.status === 0;
}

function readContainerEnv(container, key) {
  const inspect = runDocker([
    "inspect",
    "--format",
    "{{range .Config.Env}}{{println .}}{{end}}",
    container,
  ]);
  if (inspect.status !== 0) {
    return "";
  }
  for (const line of inspect.stdoutText.split(/\r?\n/)) {
    if (line.startsWith(`${key}=`)) {
      return line.slice(key.length + 1);
    }
  }
  return "";
}

function containerHealthy(container) {
  const inspect = runDocker([
    "inspect",
    "--format",
    "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}",
    container,
  ]);
  if (inspect.status !== 0) {
    return "";
  }
  return inspect.stdoutText;
}

function removeContainer(container) {
  if (!containerExists(container)) {
    return;
  }
  runDocker(["rm", "-f", container]);
}

function directoryHasEntries(dirPath) {
  try {
    return fs.readdirSync(dirPath).length > 0;
  } catch {
    return false;
  }
}

function seedCredentialsFromContainer(sourceContainer, targetDataDir) {
  const source = normalizeText(sourceContainer);
  if (!source || !containerExists(source)) {
    return null;
  }
  const targetCredentialsDir = path.join(targetDataDir, "credentials");
  if (directoryHasEntries(targetCredentialsDir)) {
    return {
      attempted: false,
      copied: false,
      sourceContainer: source,
      reason: "already_present",
    };
  }
  fs.mkdirSync(targetCredentialsDir, { recursive: true });
  const copy = runDocker([
    "cp",
    `${source}:/data/credentials/.`,
    targetCredentialsDir,
  ]);
  if (copy.status !== 0) {
    return {
      attempted: true,
      copied: false,
      sourceContainer: source,
      reason: copy.stderrText || copy.stdoutText || "docker cp failed",
    };
  }
  return {
    attempted: true,
    copied: directoryHasEntries(targetCredentialsDir),
    sourceContainer: source,
    reason: "",
  };
}

async function waitForHealth(port, timeoutMs = 30000) {
  const startedAt = Date.now();
  let lastError = "";
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) {
        return;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Gateway on port ${port} did not become healthy: ${lastError || "timeout"}`);
}

function buildRuntimeMounts({ dataDir, fixtureRoot, requiresManagedRuntimeBridge }) {
  const mounts = [`${dataDir}:/data`];
  const normalizedFixtureRoot = normalizeText(fixtureRoot);
  if (normalizedFixtureRoot) {
    mounts.push(`${normalizedFixtureRoot}:${normalizedFixtureRoot}`);
  }
  if (requiresManagedRuntimeBridge) {
    mounts.push(`${RNN_RUNTIME_BRIDGE_DIR}:${RNN_RUNTIME_CONTAINER_BRIDGE_DIR}`);
  }
  const devSource = normalizeText(process.env.ENTROPIC_DEV_OPENCLAW_SOURCE);
  if (devSource) {
    mounts.push(`${devSource}/dist:/app/dist:ro`);
    mounts.push(`${devSource}/extensions:/app/extensions:ro`);
  }
  const localEntrypoint = "/home/alan/agent/entropic/openclaw-runtime/entrypoint.sh";
  if (fs.existsSync(localEntrypoint)) {
    mounts.push(`${localEntrypoint}:/app/entrypoint.sh:ro`);
  }
  return mounts;
}

function buildRuntimeEnv(spec, token, browserPort) {
  const env = [
    ["OPENCLAW_GATEWAY_TOKEN", token],
    ["ENTROPIC_GATEWAY_SCHEMA_VERSION", GATEWAY_SCHEMA_VERSION],
    ["OPENCLAW_MODEL", spec.modelRef],
    ["ENTROPIC_LOCAL_MODEL_BASE_URL", spec.baseUrl],
    ["ENTROPIC_LOCAL_MODEL_API_KEY", spec.apiKey],
    ["ENTROPIC_LOCAL_MODEL_NAME", spec.modelName],
    ["ENTROPIC_LOCAL_MODEL_SERVICE_TYPE", spec.serviceType],
    ["ENTROPIC_LOCAL_MODEL_API", spec.api],
    ["ENTROPIC_LOCAL_MODEL_CONTEXT_WINDOW", String(spec.declaredContextWindow)],
    ["ENTROPIC_BROWSER_SERVICE_PORT", "19791"],
    ["ENTROPIC_BROWSER_HOST_PORT", String(browserPort)],
    ["ENTROPIC_BROWSER_HEADFUL", "1"],
    ["ENTROPIC_BROWSER_ALLOW_UNSAFE_NO_SANDBOX", "0"],
    ["ENTROPIC_BROWSER_ALLOW_INSECURE_SECURE_CONTEXTS", "0"],
    ["ENTROPIC_BROWSER_BIND", "0.0.0.0"],
    ["ENTROPIC_BROWSER_PROFILE", "/data/browser/profile"],
    ["ENTROPIC_TOOLS_PATH", "/data/tools"],
    ["ENTROPIC_GATEWAY_DISABLE_DEVICE_AUTH", "1"],
  ];
  if (spec.requiresManagedRuntimeBridge) {
    env.push(["ENTROPIC_MANAGED_RUNTIME_UNIX_SOCKET", RNN_RUNTIME_CONTAINER_SOCKET]);
  }
  return env;
}

function readGatewayState(statePath) {
  return readJson(statePath, null) || null;
}

function writeGatewayState(statePath, payload) {
  writeJson(statePath, payload);
}

function sameGatewayConfig(existing, spec, port, browserPort, image, fixtureRoot) {
  if (!existing || typeof existing !== "object") {
    return false;
  }
  return (
    normalizeText(existing.profileId) === spec.profileId &&
    normalizeText(existing.modelRef) === spec.modelRef &&
    normalizeText(existing.image) === image &&
    Number.parseInt(existing.port, 10) === port &&
    Number.parseInt(existing.browserPort, 10) === browserPort &&
    normalizeText(existing.fixtureRoot) === normalizeText(fixtureRoot) &&
    Number.parseInt(existing.declaredContextWindow, 10) === spec.declaredContextWindow
  );
}

async function ensureGateway({
  profile,
  image,
  container,
  port,
  browserPort,
  stateRoot,
  fixtureRoot,
  capturePath,
}) {
  const spec = buildGatewaySpec(profile);
  ensureImage(image);

  const stateDir = path.join(stateRoot, safeSlug(profile.id));
  const dataDir = path.join(stateDir, "data");
  const statePath = path.join(stateDir, "gateway-state.json");
  fs.mkdirSync(dataDir, { recursive: true });
  const existing = readGatewayState(statePath);
  const token =
    normalizeText(existing?.token) ||
    normalizeText(readContainerEnv(container, "OPENCLAW_GATEWAY_TOKEN")) ||
    randomUUID();
  const nextState = {
    profileId: spec.profileId,
    modelRef: spec.modelRef,
    modelName: spec.modelName,
    serviceType: spec.serviceType,
    image,
    container,
    token,
    port,
    browserPort,
    fixtureRoot: normalizeText(fixtureRoot),
    dataDir,
    declaredContextWindow: spec.declaredContextWindow,
    actualContextWindow: spec.actualContextWindow,
    capturePath: capturePath || DEFAULT_CAPTURE_PATH,
  };

  const canReuse =
    containerExists(container) &&
    sameGatewayConfig(existing, spec, port, browserPort, image, fixtureRoot) &&
    containerHealthy(container) === "healthy";

  if (!canReuse) {
    const credentialSeed = seedCredentialsFromContainer(DEFAULT_SEED_CONTAINER, dataDir);
    removeContainer(container);
    const dockerArgs = [
      "run",
      "-d",
      "--name",
      container,
      "--restart",
      "unless-stopped",
      "--user",
      "1000:1000",
      "--add-host",
      "host.docker.internal:host-gateway",
      "--cap-drop=ALL",
      "--security-opt",
      "no-new-privileges",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,nodev,size=100m",
      "--tmpfs",
      "/run:rw,noexec,nosuid,nodev,size=10m",
      "--tmpfs",
      "/home/node/.openclaw:rw,noexec,nosuid,nodev,size=50m,uid=1000,gid=1000",
    ];
    for (const mount of buildRuntimeMounts({
      dataDir,
      fixtureRoot,
      requiresManagedRuntimeBridge: spec.requiresManagedRuntimeBridge,
    })) {
      dockerArgs.push("-v", mount);
    }
    for (const [key, value] of buildRuntimeEnv(spec, token, browserPort)) {
      dockerArgs.push("-e", `${key}=${value}`);
    }
    dockerArgs.push("-p", `127.0.0.1:${port}:18789`);
    dockerArgs.push(image);
    const run = runDocker(dockerArgs);
    if (run.status !== 0) {
      throw new Error(`Failed to start ${container}: ${run.stderrText || run.stdoutText}`);
    }
    await waitForHealth(port);
    nextState.credentialSeed = credentialSeed;
  }

  writeGatewayState(statePath, {
    ...nextState,
    wsUrl: `ws://127.0.0.1:${port}`,
    updatedAt: new Date().toISOString(),
  });

  return {
    ...nextState,
    wsUrl: `ws://127.0.0.1:${port}`,
    reused: canReuse,
    containerHealth: containerHealthy(container) || "unknown",
  };
}

function status(container, stateRoot, profileId = "") {
  const statePath = profileId
    ? path.join(stateRoot, safeSlug(profileId), "gateway-state.json")
    : path.join(stateRoot, "gateway-state.json");
  const saved = readGatewayState(statePath);
  return {
    container,
    exists: containerExists(container),
    health: containerHealthy(container),
    state: saved,
  };
}

function stop(container, stateRoot, profileId = "") {
  removeContainer(container);
  const statePath = profileId
    ? path.join(stateRoot, safeSlug(profileId), "gateway-state.json")
    : path.join(stateRoot, "gateway-state.json");
  if (fs.existsSync(statePath)) {
    fs.rmSync(statePath, { force: true });
  }
  return {
    container,
    stopped: true,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args._.length === 0) {
    usage();
    process.exit(args.help ? 0 : 1);
  }
  const command = args._[0];
  const profilesPath = path.resolve(args.profilesPath || DEFAULT_PROFILES_PATH);
  const image = normalizeText(args.image) || DEFAULT_IMAGE;
  const stateRoot = path.resolve(args.stateRoot || DEFAULT_STATE_ROOT);
  const fixtureRoot = args.fixtureRoot ? path.resolve(args.fixtureRoot) : "";
  const capturePath = path.resolve(args.capturePath || DEFAULT_CAPTURE_PATH);

  if (command === "ensure") {
    if (!args.profile) {
      throw new Error("ensure requires --profile");
    }
    const profile = findProfile(loadProfiles(profilesPath), args.profile);
    const container = derivedContainerName(DEFAULT_CONTAINER, profile.id, args.container);
    const port = derivedPort(DEFAULT_GATEWAY_PORT, profile.id, args.port);
    const browserPort = derivedPort(DEFAULT_BROWSER_HOST_PORT, profile.id, args.browserPort);
    const payload = await ensureGateway({
      profile,
      image,
      container,
      port,
      browserPort,
      stateRoot,
      fixtureRoot,
      capturePath,
    });
    if (args.json) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(`Gateway ready: ${payload.wsUrl}`);
      console.log(`  profile: ${payload.profileId}`);
      console.log(`  model: ${payload.modelRef}`);
      console.log(`  reused: ${payload.reused ? "yes" : "no"}`);
      console.log(`  health: ${payload.containerHealth}`);
    }
    return;
  }

  if (command === "status") {
    const profileId = normalizeText(args.profile);
    const container = derivedContainerName(DEFAULT_CONTAINER, profileId || "default", args.container);
    const payload = status(container, stateRoot, profileId);
    if (args.json) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(`Container: ${payload.container}`);
      console.log(`  exists: ${payload.exists ? "yes" : "no"}`);
      console.log(`  health: ${payload.health || "missing"}`);
      if (payload.state) {
        console.log(`  model: ${payload.state.modelRef || "<unknown>"}`);
        console.log(`  ws: ${payload.state.wsUrl || "<unknown>"}`);
      }
    }
    return;
  }

  if (command === "stop") {
    const profileId = normalizeText(args.profile);
    const container = derivedContainerName(DEFAULT_CONTAINER, profileId || "default", args.container);
    const payload = stop(container, stateRoot, profileId);
    if (args.json) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(`Stopped ${payload.container}`);
    }
    return;
  }

  usage();
  process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
