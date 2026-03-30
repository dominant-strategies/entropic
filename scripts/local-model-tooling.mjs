#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SCRIPT_DIR = path.dirname(new URL(import.meta.url).pathname);
const DEFAULT_MANIFEST_PATH = path.join(SCRIPT_DIR, "local-model-tool-tests.json");
const DEFAULT_PROFILES_PATH = path.join(SCRIPT_DIR, "local-model-profiles.json");
const DEFAULT_PACKS_PATH = path.join(SCRIPT_DIR, "local-model-test-packs.json");
const DEFAULT_GATEWAY_SCRIPT_PATH = path.join(SCRIPT_DIR, "local-model-gateway.mjs");
const DEFAULT_MANAGED_RUNTIME_RESTART_SCRIPT = path.join(SCRIPT_DIR, "restart-managed-runtime.sh");
const DEFAULT_CAPTURE_PATH = path.join(
  os.homedir(),
  ".local",
  "share",
  "ai.openclaw.entropic.dev",
  "rnn-runtime",
  "state",
  "tool-bridge-captures.jsonl",
);
const DEFAULT_SETTINGS_PATH = path.join(
  os.homedir(),
  ".local",
  "share",
  "ai.openclaw.entropic.dev",
  "entropic-settings.json",
);
const DEFAULT_LOG_ROOT = path.join(
  "/home/alan/agent/entropic",
  ".local-model-tooling-logs",
);
const DEFAULT_FIXTURE_ROOT = path.join("/tmp", "entropic-local-tooling-fixtures");
const DEFAULT_BACKUP_ROOT = path.join("/tmp", "entropic-local-tooling-backups");
const DEFAULT_LOCK_ROOT = path.join("/tmp", "entropic-local-tooling-locks");

function usage() {
  console.log(`Usage:
  node ./scripts/local-model-tooling.mjs inventory [--json]
  node ./scripts/local-model-tooling.mjs profiles [--json]
  node ./scripts/local-model-tooling.mjs packs [--json]
  node ./scripts/local-model-tooling.mjs plan [--json]
  node ./scripts/local-model-tooling.mjs apply-profile <profile-id> [--json]
  node ./scripts/local-model-tooling.mjs run-pack <pack-id> --profile <profile-id> [options]
  node ./scripts/local-model-tooling.mjs run-tool <tool-name> --profile <profile-id> [options]
  node ./scripts/local-model-tooling.mjs run-category <category> --profile <profile-id> [options]
  node ./scripts/local-model-tooling.mjs run-matrix --profile <profile-id> [--profile <profile-id> ...] [options]

Options:
  --manifest PATH           Override tool manifest JSON
  --profiles PATH           Override model profile JSON
  --packs PATH              Override test pack JSON
  --settings PATH           Override entropic-settings.json
  --capture-path PATH       Override tool-bridge capture path
  --log-root PATH           Override log root directory
  --fixture-root PATH       Override fixture root directory
  --timeout-ms N            Per-turn timeout to pass through to the harness
  --lock-root PATH          Override shared lock directory
  --lock-timeout-ms N       How long to wait for a managed-runtime lock (default 600000)
  --profile ID              Profile id to apply before running harness
  --profile-repeat N        Repeat each case N times (default 1)
  --variants N              Max variants to run per tool (default 3)
  --family NAME             Restrict to one or more fuzz families
  --case NAME               Restrict to one or more named cases per tool
  --tool NAME               Restrict run-matrix to one or more tool names
  --category NAME           Restrict run-matrix to one or more categories
  --allow-side-effects      Include side-effect and admin tools
  --allow-credentialed      Include connector-backed tools that need auth
  --include-disabled        Include manifest entries with defaultEnabled=false
  --dry-run                 Print what would run without invoking the harness
  --json                    Emit JSON
`);
}

function parseArgs(argv) {
  const args = {
    _: [],
    profilesRequested: [],
    toolsRequested: [],
    categoriesRequested: [],
    familiesRequested: [],
    casesRequested: [],
    profileRepeat: 1,
    variants: 3,
    timeoutMs: null,
    lockTimeoutMs: 600000,
    json: false,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--manifest") {
      args.manifestPath = argv[++i];
    } else if (token === "--profiles") {
      args.profilesPath = argv[++i];
    } else if (token === "--packs") {
      args.packsPath = argv[++i];
    } else if (token === "--settings") {
      args.settingsPath = argv[++i];
    } else if (token === "--capture-path") {
      args.capturePath = argv[++i];
    } else if (token === "--log-root") {
      args.logRoot = argv[++i];
    } else if (token === "--fixture-root") {
      args.fixtureRoot = argv[++i];
    } else if (token === "--timeout-ms") {
      args.timeoutMs = Number.parseInt(argv[++i], 10);
    } else if (token === "--lock-root") {
      args.lockRoot = argv[++i];
    } else if (token === "--lock-timeout-ms") {
      args.lockTimeoutMs = Number.parseInt(argv[++i], 10);
    } else if (token === "--profile") {
      args.profilesRequested.push(argv[++i]);
    } else if (token === "--profile-repeat") {
      args.profileRepeat = Number.parseInt(argv[++i], 10);
    } else if (token === "--variants") {
      args.variants = Number.parseInt(argv[++i], 10);
    } else if (token === "--family") {
      args.familiesRequested.push(argv[++i]);
    } else if (token === "--case") {
      args.casesRequested.push(argv[++i]);
    } else if (token === "--tool") {
      args.toolsRequested.push(argv[++i]);
    } else if (token === "--category") {
      args.categoriesRequested.push(argv[++i]);
    } else if (token === "--allow-side-effects") {
      args.allowSideEffects = true;
    } else if (token === "--allow-credentialed") {
      args.allowCredentialed = true;
    } else if (token === "--include-disabled") {
      args.includeDisabled = true;
    } else if (token === "--dry-run") {
      args.dryRun = true;
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

function loadManifest(manifestPath) {
  const manifest = readJson(manifestPath, null);
  if (!manifest || !Array.isArray(manifest.tools)) {
    throw new Error(`Invalid tool manifest at ${manifestPath}`);
  }
  return manifest;
}

function loadProfiles(profilesPath) {
  const payload = readJson(profilesPath, null);
  if (!payload || !Array.isArray(payload.profiles)) {
    throw new Error(`Invalid profile manifest at ${profilesPath}`);
  }
  return payload.profiles;
}

function loadPacks(packsPath) {
  const payload = readJson(packsPath, null);
  if (!payload || !Array.isArray(payload.packs)) {
    throw new Error(`Invalid pack manifest at ${packsPath}`);
  }
  return payload.packs;
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
      captures.push(JSON.parse(trimmed));
    } catch {
      // ignore
    }
  }
  return captures;
}

function extractLiveTools(capturePath) {
  const captures = loadCaptures(capturePath);
  const last = captures.at(-1);
  if (!last || !Array.isArray(last.tools)) {
    return [];
  }
  return last.tools
    .map((entry) => entry?.function || null)
    .filter(Boolean)
    .map((tool) => ({
      name: normalizeText(tool.name),
      description: normalizeText(tool.description),
      parameters: tool.parameters || null,
    }))
    .filter((tool) => tool.name);
}

function buildInventory(manifest, liveTools) {
  const liveByName = new Map(liveTools.map((tool) => [tool.name, tool]));
  return manifest.tools.map((entry) => {
    const live = liveByName.get(entry.tool) || null;
    const cases = Array.isArray(entry.cases) && entry.cases.length > 0
      ? entry.cases.map((item, index) => ({
          id: normalizeText(item.id) || `case-${index + 1}`,
          description: normalizeText(item.description),
          messages: item.messages || [],
        }))
      : [{
          id: "default",
          description: "",
          messages: entry.messages || [],
        }];
    return {
      tool: entry.tool,
      category: entry.category,
      risk: entry.risk,
      defaultEnabled: Boolean(entry.defaultEnabled),
      acceptedToolNames: entry.acceptedToolNames || [entry.tool],
      preconditions: entry.preconditions || [],
      description: live?.description || "",
      parameterKeys: Object.keys(live?.parameters?.properties || {}),
      messages: entry.messages || [],
      cases,
      fuzzFamilies: entry.fuzzFamilies || [],
    };
  });
}

function categorizeInventory(inventory) {
  const result = new Map();
  for (const entry of inventory) {
    const bucket = result.get(entry.category) || [];
    bucket.push(entry);
    result.set(entry.category, bucket);
  }
  return Array.from(result.entries())
    .map(([category, entries]) => ({
      category,
      count: entries.length,
      tools: entries.map((entry) => entry.tool),
    }))
    .sort((a, b) => a.category.localeCompare(b.category));
}

function summarizePlan(inventory, profiles) {
  const riskCounts = {};
  for (const entry of inventory) {
    riskCounts[entry.risk] = (riskCounts[entry.risk] || 0) + 1;
  }
  return {
    toolCount: inventory.length,
    categories: categorizeInventory(inventory),
    risks: riskCounts,
    profiles: profiles.map((profile) => ({
      id: profile.id,
      description: profile.description,
      harnessMode: profile.harnessMode,
      connectionMode: profile.connectionMode,
      modelName: profile.localModelConfig?.modelName || null,
      serviceType: profile.localModelConfig?.serviceType || null,
      template: Boolean(profile.template),
    })),
  };
}

function summarizePacks(packs) {
  return packs.map((pack) => ({
    id: pack.id,
    description: pack.description || "",
    tools: pack.tools || [],
    categories: pack.categories || [],
    cases: pack.cases || [],
    families: pack.families || [],
    includeDisabled: Boolean(pack.includeDisabled),
    allowSideEffects: Boolean(pack.allowSideEffects),
    allowCredentialed: Boolean(pack.allowCredentialed),
  }));
}

function findProfile(profiles, profileId) {
  const profile = profiles.find((entry) => entry.id === profileId);
  if (!profile) {
    throw new Error(`Unknown profile '${profileId}'`);
  }
  return profile;
}

function findPack(packs, packId) {
  const pack = packs.find((entry) => entry.id === packId);
  if (!pack) {
    throw new Error(`Unknown pack '${packId}'`);
  }
  return pack;
}

function applyProfile(settingsPath, profile) {
  const current = readJson(settingsPath, {});
  const next = {
    ...current,
    connectionMode: profile.connectionMode,
    useLocalKeys: profile.connectionMode !== "managed",
    selectedModel: profile.selectedModel,
    localDebugMode: true,
    localCapturePromptPreview: true,
    localLightweightBootstrap: true,
    localDisableTools: false,
    localDebugDirectBypass: false,
    localModelConfig: {
      ...(current.localModelConfig || {}),
      ...(profile.localModelConfig || {}),
    },
  };
  fs.mkdirSync(DEFAULT_BACKUP_ROOT, { recursive: true });
  const backupPath = path.join(
    DEFAULT_BACKUP_ROOT,
    `${path.basename(settingsPath)}.${safeSlug(profile.id)}.bak.json`,
  );
  if (fs.existsSync(settingsPath)) {
    fs.copyFileSync(settingsPath, backupPath);
  }
  writeJson(settingsPath, next);
  return { settings: next, backupPath };
}

function ensureFixtures(fixtureRoot) {
  fs.mkdirSync(fixtureRoot, { recursive: true });
  const fixtures = {
    "sample-read.txt": "Local model testing is easier when the prompts are deterministic. This file exists for the read tool scenario.\nSecond line for offset tests.\n",
    "edit-target.txt": "The current marker is ALPHA.\nPlease replace ALPHA with the new value.\n",
    "upload-source.txt": "Upload me if the Drive upload connector is enabled.\n",
    "notes.md": "# Local Tooling Fixture\n\nThis markdown file is available for read and edit scenarios.\n",
  };
  for (const [name, content] of Object.entries(fixtures)) {
    fs.writeFileSync(path.join(fixtureRoot, name), content, "utf8");
  }
}

function replaceFixtureRoot(value, fixtureRoot) {
  return value.replaceAll("{{FIXTURE_ROOT}}", fixtureRoot);
}

function applyFamilyToMessages(messages, family) {
  if (!messages.length) {
    return messages;
  }
  const next = messages.slice();
  const lastIndex = next.length - 1;
  const last = next[lastIndex];
  switch (family) {
    case "direct":
      return next;
    case "polite":
      next[lastIndex] = `Please ${last}`;
      return next;
    case "terse":
      next[lastIndex] = last
        .replace(/^Please\s+/i, "")
        .replace(/^Use\s+/i, "")
        .replace(/\s+and\s+/gi, " & ");
      return next;
    case "noisy":
      next[lastIndex] = `${last}\n\nPLEASE use the right tool. !!!`;
      return next;
    case "tool_hint":
      next[lastIndex] = `${last} Use the appropriate tool and do not answer from memory.`;
      return next;
    case "followup":
      return [...next, "What result did you get?"];
    default:
      return next;
  }
}

function buildVariants(entry, fixtureRoot, maxVariants, familiesRequested, casesRequested) {
  const families =
    familiesRequested.length > 0
      ? familiesRequested.filter((family) => (entry.fuzzFamilies || []).includes(family))
      : entry.fuzzFamilies || [];
  const selectedFamilies = ["direct", ...families.filter((family) => family !== "direct")].slice(0, Math.max(1, maxVariants));
  const selectedCases = (entry.cases || []).filter((item) => {
    if (casesRequested.length === 0) {
      return true;
    }
    return casesRequested.includes(item.id);
  });
  const casesToRun = selectedCases.length > 0 ? selectedCases : (entry.cases || []);
  const variants = [];
  for (const caseEntry of casesToRun) {
    const baseMessages = (caseEntry.messages || []).map((message) => replaceFixtureRoot(message, fixtureRoot));
    selectedFamilies.forEach((family, index) => {
      variants.push({
        caseId: caseEntry.id,
        caseDescription: caseEntry.description || "",
        family,
        index,
        messages: applyFamilyToMessages(baseMessages, family),
      });
    });
  }
  return variants;
}

function shouldIncludeEntry(entry, args) {
  if (!args.includeDisabled && !entry.defaultEnabled) {
    return false;
  }
  if (!args.allowSideEffects && (entry.risk === "side_effect" || entry.risk === "admin")) {
    return false;
  }
  if (!args.allowCredentialed && entry.risk === "credentialed") {
    return false;
  }
  return true;
}

function mergePackIntoArgs(args, pack) {
  if (Array.isArray(pack.tools) && pack.tools.length > 0) {
    args.toolsRequested = Array.from(new Set([...args.toolsRequested, ...pack.tools]));
  }
  if (Array.isArray(pack.categories) && pack.categories.length > 0) {
    args.categoriesRequested = Array.from(new Set([...args.categoriesRequested, ...pack.categories]));
  }
  if (Array.isArray(pack.cases) && pack.cases.length > 0) {
    args.casesRequested = Array.from(new Set([...args.casesRequested, ...pack.cases]));
  }
  if (Array.isArray(pack.families) && pack.families.length > 0) {
    args.familiesRequested = Array.from(new Set([...args.familiesRequested, ...pack.families]));
  }
  if (pack.includeDisabled) {
    args.includeDisabled = true;
  }
  if (pack.allowSideEffects) {
    args.allowSideEffects = true;
  }
  if (pack.allowCredentialed) {
    args.allowCredentialed = true;
  }
}

function filterEntries(entries, args) {
  return entries.filter((entry) => {
    if (args.toolsRequested.length > 0 && !args.toolsRequested.includes(entry.tool)) {
      return false;
    }
    if (args.categoriesRequested.length > 0 && !args.categoriesRequested.includes(entry.category)) {
      return false;
    }
    return shouldIncludeEntry(entry, args);
  });
}

function timestampSlug(date = new Date()) {
  return date.toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

function batchSlug(label, date = new Date()) {
  return `${timestampSlug(date)}-pid${process.pid}-${safeSlug(label || "batch")}`;
}

function safeSlug(value) {
  return normalizeText(value)
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function runHarness({
  profile,
  messages,
  capturePath,
  runRoot,
  toolEntry,
  variant,
  repetition,
  fixtureRoot,
  gateway,
  timeoutMs,
}) {
  const runStartedAt = Date.now();
  const caseSlug = [
    safeSlug(profile.id),
    safeSlug(toolEntry.tool),
    safeSlug(variant.caseId || "default"),
    safeSlug(variant.family),
    `rep${Math.max(0, repetition || 0)}`,
  ].filter(Boolean).join("-");
  const runDir = path.join(runRoot, caseSlug);
  fs.mkdirSync(runDir, { recursive: true });
  const messagesFile = path.join(runDir, "messages.json");
  writeJson(messagesFile, messages);

  const usePersistentHarness =
    Boolean(gateway?.wsUrl) &&
    normalizeText(profile?.localModelConfig?.serviceType) === "rnn-local";
  const command =
    profile.harnessMode === "live" && !usePersistentHarness
      ? ["pnpm", "dev:runtime:harness:live", "run", "--messages-file", messagesFile, "--json"]
      : ["pnpm", "dev:runtime:harness", "run", "--messages-file", messagesFile, "--json"];
  command.push("--model", profile.localModelConfig?.modelName || "");
  command.push("--bootstrap", "lightweight", "--capture-prompt", "--enable-tools", "--latest-captures", "6");
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    command.push("--timeout-ms", String(timeoutMs));
  }
  if (profile.selectedModel) {
    command.push("--session-model", profile.selectedModel);
  }
  if (gateway?.wsUrl) {
    command.push("--ws-url", gateway.wsUrl);
  }
  if (gateway?.token) {
    command.push("--token", gateway.token);
  }

  const result = spawnSync(command[0], command.slice(1), {
    cwd: "/home/alan/agent/entropic",
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    env: {
      ...process.env,
      ...(gateway?.container ? { ENTROPIC_OPENCLAW_CONTAINER: gateway.container } : {}),
      ...(gateway?.token ? { ENTROPIC_GATEWAY_TOKEN: gateway.token } : {}),
    },
  });
  const runFinishedAt = Date.now();
  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  fs.writeFileSync(path.join(runDir, "stdout.json"), stdout, "utf8");
  fs.writeFileSync(path.join(runDir, "stderr.txt"), stderr, "utf8");

  const summary = parseHarnessSummary(stdout);

  const allCaptures = loadCaptures(capturePath);
  const expectedModel = profile.localModelConfig?.modelName || "";
  const matchedCaptures = allCaptures.filter((record) => {
    const capturedAt = Date.parse(String(record?.capturedAt || ""));
    if (!Number.isFinite(capturedAt)) {
      return false;
    }
    if (capturedAt < runStartedAt - 5000 || capturedAt > runFinishedAt + 5000) {
      return false;
    }
    if (expectedModel && normalizeText(record?.model) !== expectedModel) {
      return false;
    }
    const latestUserText = normalizeText(record?.latestUserText);
    return latestUserText === normalizeText(messages.at(-1));
  });
  writeJson(path.join(runDir, "captures.full.json"), matchedCaptures);

  const evaluation = evaluateRun(toolEntry, summary, matchedCaptures, result.status);
  writeJson(path.join(runDir, "evaluation.json"), evaluation);
  writeJson(path.join(runDir, "profile.json"), profile);
  writeJson(path.join(runDir, "tool.json"), toolEntry);
  writeJson(path.join(runDir, "fixture.json"), { fixtureRoot });
  if (gateway) {
    writeJson(path.join(runDir, "gateway.json"), gateway);
  }
  if (summary) {
    writeJson(path.join(runDir, "summary.json"), summary);
  }

  return {
    runDir,
    command,
    startedAt: new Date(runStartedAt).toISOString(),
    finishedAt: new Date(runFinishedAt).toISOString(),
    exitCode: result.status,
    summary,
    stderr,
    evaluation,
    captures: matchedCaptures,
  };
}

function parseHarnessSummary(stdout) {
  const text = normalizeText(stdout);
  if (!text) {
    return null;
  }
  const firstObject = text.indexOf("{");
  const lastObject = text.lastIndexOf("}");
  if (firstObject === -1 || lastObject === -1 || lastObject < firstObject) {
    return null;
  }
  try {
    return JSON.parse(text.slice(firstObject, lastObject + 1));
  } catch {
    return null;
  }
}

function looksLikeFinalAssistantAnswer(value) {
  const text = normalizeText(value);
  if (!text) {
    return false;
  }
  const lowered = text.toLowerCase();
  if (["assistant", "user", "system", "tool"].includes(lowered)) {
    return false;
  }
  if (
    lowered === "let's do that." ||
    lowered === "let's call tool." ||
    lowered === "ok" ||
    lowered === "</tool_call>"
  ) {
    return false;
  }
  if (
    text.startsWith("{") ||
    text.startsWith("<tools.") ||
    text.startsWith("[[") ||
    text.startsWith("Tool:")
  ) {
    return false;
  }
  return true;
}

function evaluateRun(toolEntry, summary, captures, exitCode) {
  const parsedToolNames = new Set();
  for (const capture of captures) {
    for (const name of capture?.parsedToolCallNames || []) {
      parsedToolNames.add(normalizeText(name));
    }
  }
  for (const turn of summary?.turns || []) {
    for (const capture of turn?.captures || []) {
      for (const name of capture?.parsedToolCallNames || []) {
        parsedToolNames.add(normalizeText(name));
      }
    }
  }
  for (const turn of summary?.turnSummaries || []) {
    for (const name of turn?.parsedToolCalls || []) {
      parsedToolNames.add(normalizeText(name));
    }
  }

  const accepted = new Set((toolEntry.acceptedToolNames || [toolEntry.tool]).map((value) => normalizeText(value)));
  const targetSeen = parsedToolNames.has(normalizeText(toolEntry.tool));
  const acceptedSeen = Array.from(parsedToolNames).some((name) => accepted.has(name));
  const toolResultSeen = Boolean(
    (summary?.turnSummaries || []).some((turn) => turn.hasToolResult),
  );
  const assistantText = (summary?.turnSummaries || [])
    .map((turn) => normalizeText(turn.finalAssistantText))
    .filter(Boolean)
    .at(-1) || "";
  const assistantLooksFinal = looksLikeFinalAssistantAnswer(assistantText);
  const formatHints = Array.from(
    new Set(
      [
        ...captures.map((capture) => guessOutputFormat(capture?.rawContent || capture?.cleanedContent || "")),
        guessOutputFormat(assistantText),
      ].filter(Boolean),
    ),
  );
  const runtimeMetrics = extractRuntimeMetrics(summary);
  const expectedModel = normalizeText(summary?.settings?.selectedModel);
  const actualModels = Array.from(
    new Set(
      (summary?.turnSummaries || [])
        .flatMap((turn) => (Array.isArray(turn?.actualModels) ? turn.actualModels : []))
        .map((value) => normalizeText(value))
        .filter(Boolean),
    ),
  );
  const modelMatched =
    actualModels.length === 0 ||
    !expectedModel ||
    actualModels.includes(expectedModel);
  const blockedReason = /model context window too small/i.test(assistantText)
    ? "context_window_hard_min"
    : "";

  let status = "fail";
  if (blockedReason) {
    status = "blocked";
  } else if (!modelMatched) {
    status = "invalid";
  } else if (targetSeen) {
    status = toolResultSeen && assistantLooksFinal ? "pass" : "partial";
  } else if (acceptedSeen) {
    status = "partial";
  } else if (exitCode === 0 && assistantText) {
    status = "soft-fail";
  }

  return {
    status,
    exitCode,
    targetTool: toolEntry.tool,
    parsedToolNames: Array.from(parsedToolNames),
    targetSeen,
    acceptedSeen,
    toolResultSeen,
    assistantText,
    assistantLooksFinal,
    formatHints,
    runtimeMetrics,
    actualModels,
    expectedModel,
    modelMatched,
    blockedReason,
  };
}

function guessOutputFormat(value) {
  const text = normalizeText(value);
  if (!text) {
    return "";
  }
  const lowered = text.toLowerCase();
  if (lowered.startsWith("{")) {
    return "json_object";
  }
  if (lowered.startsWith("<tools.")) {
    return "tools_tag";
  }
  if (lowered.startsWith("[[tool_call:")) {
    return "inline_bracket_tool_call";
  }
  if (lowered.startsWith("[[")) {
    return "double_bracket";
  }
  if (lowered.startsWith("tool:")) {
    return "tool_prefix";
  }
  const bareCall = /^\s*([a-z][a-z0-9_:-]+)\s+\{/.exec(text);
  if (bareCall) {
    return `bare_call:${bareCall[1]}`;
  }
  return "plain_text";
}

function extractRuntimeMetrics(summary) {
  const lines = Array.isArray(summary?.runtimeLogDelta)
    ? summary.runtimeLogDelta
    : Array.isArray(summary?.runtimeLogTail)
      ? summary.runtimeLogTail
      : [];
  let firstTokenMs = null;
  let elapsedMs = null;
  let tokensPerSecond = null;
  for (const line of lines) {
    const firstMatch = /firstTokenMs=(\d+)/.exec(line);
    if (firstMatch) {
      firstTokenMs = Number.parseInt(firstMatch[1], 10);
    }
    const elapsedMatch = /elapsedMs=(\d+)/.exec(line);
    if (elapsedMatch) {
      elapsedMs = Number.parseInt(elapsedMatch[1], 10);
    }
    const tpsMatch = /tokensPerSecond=([0-9.]+)/.exec(line);
    if (tpsMatch) {
      tokensPerSecond = Number.parseFloat(tpsMatch[1]);
    }
  }
  return { firstTokenMs, elapsedMs, tokensPerSecond };
}

function profileUsesManagedRuntime(profile) {
  return normalizeText(profile?.localModelConfig?.serviceType) === "rnn-local";
}

function lockPath(lockRoot, name) {
  return path.join(lockRoot, `${safeSlug(name)}.lock`);
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function tryAcquireFilesystemLock(lockRoot, name) {
  const target = lockPath(lockRoot, name);
  fs.mkdirSync(lockRoot, { recursive: true });
  try {
    fs.mkdirSync(target);
    writeJson(path.join(target, "owner.json"), {
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
      cwd: process.cwd(),
      argv: process.argv.slice(1),
    });
    return { ok: true, target };
  } catch (error) {
    if (error && error.code !== "EEXIST") {
      throw error;
    }
  }

  const owner = readJson(path.join(target, "owner.json"), {});
  if (!isPidAlive(Number.parseInt(String(owner?.pid || ""), 10))) {
    fs.rmSync(target, { recursive: true, force: true });
    try {
      fs.mkdirSync(target);
      writeJson(path.join(target, "owner.json"), {
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
        cwd: process.cwd(),
        argv: process.argv.slice(1),
        replacedStaleOwner: owner || null,
      });
      return { ok: true, target };
    } catch (error) {
      if (error && error.code !== "EEXIST") {
        throw error;
      }
    }
  }

  return { ok: false, target, owner };
}

function releaseFilesystemLock(lockHandle) {
  if (!lockHandle?.target) {
    return;
  }
  fs.rmSync(lockHandle.target, { recursive: true, force: true });
}

function acquireFilesystemLock(lockRoot, name, timeoutMs) {
  const startedAt = Date.now();
  const maxWait = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 600000;
  while (Date.now() - startedAt < maxWait) {
    const attempt = tryAcquireFilesystemLock(lockRoot, name);
    if (attempt.ok) {
      return attempt;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  throw new Error(`Timed out waiting for lock '${name}' in ${lockRoot}`);
}

function printInventory(inventory, asJson) {
  if (asJson) {
    console.log(JSON.stringify(inventory, null, 2));
    return;
  }
  for (const entry of inventory) {
    console.log(`${entry.tool}`);
    console.log(`  category: ${entry.category}`);
    console.log(`  risk: ${entry.risk}`);
    console.log(`  enabled by default: ${entry.defaultEnabled ? "yes" : "no"}`);
    if (entry.description) {
      console.log(`  description: ${entry.description}`);
    }
    if (entry.preconditions.length > 0) {
      console.log(`  preconditions: ${entry.preconditions.join("; ")}`);
    }
    console.log(`  accepted tool names: ${entry.acceptedToolNames.join(", ")}`);
    console.log("");
  }
}

function printProfiles(profiles, asJson) {
  if (asJson) {
    console.log(JSON.stringify(profiles, null, 2));
    return;
  }
  for (const profile of profiles) {
    console.log(`${profile.id}`);
    console.log(`  ${profile.description}`);
    console.log(`  mode: ${profile.connectionMode} / ${profile.harnessMode}`);
    console.log(`  model: ${profile.localModelConfig?.modelName || "n/a"}`);
    if (profile.template) {
      console.log("  template: yes");
    }
    console.log("");
  }
}

function printPacks(packs, asJson) {
  const summary = summarizePacks(packs);
  if (asJson) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  for (const pack of summary) {
    console.log(pack.id);
    console.log(`  ${pack.description}`);
    if (pack.categories.length > 0) {
      console.log(`  categories: ${pack.categories.join(", ")}`);
    }
    if (pack.tools.length > 0) {
      console.log(`  tools: ${pack.tools.join(", ")}`);
    }
    if (pack.cases.length > 0) {
      console.log(`  cases: ${pack.cases.join(", ")}`);
    }
    if (pack.families.length > 0) {
      console.log(`  families: ${pack.families.join(", ")}`);
    }
    console.log("");
  }
}

function printPlan(plan, asJson) {
  if (asJson) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  console.log(`Tools: ${plan.toolCount}`);
  console.log("Risks:");
  for (const [risk, count] of Object.entries(plan.risks)) {
    console.log(`  - ${risk}: ${count}`);
  }
  console.log("Categories:");
  for (const category of plan.categories) {
    console.log(`  - ${category.category}: ${category.count} tools`);
  }
  console.log("Profiles:");
  for (const profile of plan.profiles) {
    console.log(`  - ${profile.id}: ${profile.modelName || "template"} (${profile.connectionMode}/${profile.harnessMode})`);
  }
}

function printRunResults(results, asJson) {
  if (asJson) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }
  for (const item of results) {
    console.log(`${item.profileId} :: ${item.tool} :: ${item.caseId || "default"} :: ${item.family}`);
    console.log(`  status: ${item.evaluation.status}`);
    if (item.evaluation.expectedModel) {
      console.log(`  expected model: ${item.evaluation.expectedModel}`);
    }
    if (item.evaluation.actualModels.length > 0) {
      console.log(`  actual models: ${item.evaluation.actualModels.join(", ")}`);
    }
    if (item.evaluation.blockedReason) {
      console.log(`  blocked: ${item.evaluation.blockedReason}`);
    }
    console.log(`  parsed tool names: ${item.evaluation.parsedToolNames.join(", ") || "<none>"}`);
    if (item.evaluation.formatHints.length > 0) {
      console.log(`  format hints: ${item.evaluation.formatHints.join(", ")}`);
    }
    if (item.evaluation.runtimeMetrics.firstTokenMs != null) {
      console.log(
        `  timing: first=${item.evaluation.runtimeMetrics.firstTokenMs}ms total=${item.evaluation.runtimeMetrics.elapsedMs ?? "?"}ms tps=${item.evaluation.runtimeMetrics.tokensPerSecond ?? "?"}`,
      );
    }
    console.log(`  assistant: ${item.evaluation.assistantText || "<none>"}`);
    console.log(`  log dir: ${item.runDir}`);
    console.log("");
  }
}

function buildBatchSummary({ command, packId, results, selectedProfiles, selectedEntries, args, batchDir }) {
  const byStatus = {};
  const byProfile = {};
  const byTool = {};
  for (const item of results) {
    byStatus[item.evaluation.status] = (byStatus[item.evaluation.status] || 0) + 1;
    byProfile[item.profileId] = byProfile[item.profileId] || { total: 0, pass: 0, partial: 0, fail: 0, softFail: 0, blocked: 0, invalid: 0 };
    byProfile[item.profileId].total += 1;
    if (item.evaluation.status === "pass") byProfile[item.profileId].pass += 1;
    if (item.evaluation.status === "partial") byProfile[item.profileId].partial += 1;
    if (item.evaluation.status === "fail") byProfile[item.profileId].fail += 1;
    if (item.evaluation.status === "soft-fail") byProfile[item.profileId].softFail += 1;
    if (item.evaluation.status === "blocked") byProfile[item.profileId].blocked += 1;
    if (item.evaluation.status === "invalid") byProfile[item.profileId].invalid += 1;
    byTool[item.tool] = byTool[item.tool] || { total: 0, statuses: {}, profiles: {} };
    byTool[item.tool].total += 1;
    byTool[item.tool].statuses[item.evaluation.status] = (byTool[item.tool].statuses[item.evaluation.status] || 0) + 1;
    byTool[item.tool].profiles[item.profileId] = (byTool[item.tool].profiles[item.profileId] || 0) + 1;
  }
  return {
    command,
    packId: packId || null,
    generatedAt: new Date().toISOString(),
    batchDir,
    args: {
      profiles: selectedProfiles.map((profile) => profile.id),
      toolsRequested: args.toolsRequested,
      categoriesRequested: args.categoriesRequested,
      casesRequested: args.casesRequested,
      familiesRequested: args.familiesRequested,
      variants: args.variants,
      profileRepeat: args.profileRepeat,
      allowSideEffects: Boolean(args.allowSideEffects),
      allowCredentialed: Boolean(args.allowCredentialed),
      includeDisabled: Boolean(args.includeDisabled),
    },
    selectedEntries: selectedEntries.map((entry) => ({
      tool: entry.tool,
      category: entry.category,
      acceptedToolNames: entry.acceptedToolNames,
      risk: entry.risk,
    })),
    counts: {
      totalRuns: results.length,
      byStatus,
    },
    byProfile,
    byTool,
    results,
  };
}

function selectProfiles(args, profiles) {
  const requested = args.profilesRequested.length > 0 ? args.profilesRequested : [];
  if (requested.length === 0) {
    throw new Error("At least one --profile is required for run-tool, run-category, and run-matrix.");
  }
  return requested.map((profileId) => findProfile(profiles, profileId));
}

function buildRunQueue(entries, profiles, args, fixtureRoot) {
  const queue = [];
  for (const profile of profiles) {
    for (let repetition = 0; repetition < Math.max(1, args.profileRepeat); repetition += 1) {
      for (const entry of entries) {
        const variants = buildVariants(
          entry,
          fixtureRoot,
          Math.max(1, args.variants),
          args.familiesRequested,
          args.casesRequested,
        );
        for (const variant of variants) {
          queue.push({ profile, entry, variant, repetition });
        }
      }
    }
  }
  return queue;
}

function ensureGatewayForProfile(profile, profilesPath, fixtureRoot, capturePath) {
  const command = [
    "node",
    DEFAULT_GATEWAY_SCRIPT_PATH,
    "ensure",
    "--profiles",
    profilesPath,
    "--profile",
    profile.id,
    "--fixture-root",
    fixtureRoot,
    "--capture-path",
    capturePath,
    "--json",
  ];
  const result = spawnSync(command[0], command.slice(1), {
    cwd: "/home/alan/agent/entropic",
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      [
        `Failed to prepare isolated gateway for profile ${profile.id}.`,
        normalizeText(result.stderr) || normalizeText(result.stdout) || `exit=${result.status}`,
      ].filter(Boolean).join("\n"),
    );
  }
  const payload = parseHarnessSummary(result.stdout);
  if (!payload || !payload.wsUrl || !payload.token) {
    throw new Error(`Gateway ensure for ${profile.id} did not return wsUrl/token`);
  }
  return payload;
}

function restartManagedRuntime() {
  const result = spawnSync("bash", [DEFAULT_MANAGED_RUNTIME_RESTART_SCRIPT], {
    cwd: "/home/alan/agent/entropic",
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      [
        "Failed to restart managed runtime.",
        normalizeText(result.stderr) || normalizeText(result.stdout) || `exit=${result.status}`,
      ].filter(Boolean).join("\n"),
    );
  }
  return {
    pid: normalizeText(result.stdout),
  };
}

function warmManagedRuntimeModel(modelName) {
  const normalizedModel = normalizeText(modelName);
  if (!normalizedModel) {
    return { attempted: false, warmed: false, reason: "missing_model" };
  }
  const payload = {
    model: normalizedModel,
    stream: false,
    temperature: 0,
    top_p: 1,
    max_tokens: 8,
    messages: [
      {
        role: "user",
        content: "Reply with OK.",
      },
    ],
  };
  const result = spawnSync(
    "curl",
    [
      "-sf",
      "-H",
      "Content-Type: application/json",
      "-d",
      JSON.stringify(payload),
      "http://127.0.0.1:11445/v1/chat/completions",
    ],
    {
      cwd: "/home/alan/agent/entropic",
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
      timeout: 300000,
    },
  );
  if (result.status !== 0) {
    return {
      attempted: true,
      warmed: false,
      reason: normalizeText(result.stderr) || normalizeText(result.stdout) || `exit=${result.status}`,
    };
  }
  return {
    attempted: true,
    warmed: true,
    responsePreview: normalizeText(result.stdout).slice(0, 400),
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args._.length === 0) {
    usage();
    process.exit(args.help ? 0 : 1);
  }

  const manifestPath = path.resolve(args.manifestPath || DEFAULT_MANIFEST_PATH);
  const profilesPath = path.resolve(args.profilesPath || DEFAULT_PROFILES_PATH);
  const packsPath = path.resolve(args.packsPath || DEFAULT_PACKS_PATH);
  const capturePath = path.resolve(args.capturePath || DEFAULT_CAPTURE_PATH);
  const settingsPath = path.resolve(args.settingsPath || DEFAULT_SETTINGS_PATH);
  const logRoot = path.resolve(args.logRoot || DEFAULT_LOG_ROOT);
  const fixtureRoot = path.resolve(args.fixtureRoot || DEFAULT_FIXTURE_ROOT);
  const lockRoot = path.resolve(args.lockRoot || DEFAULT_LOCK_ROOT);

  const manifest = loadManifest(manifestPath);
  const profiles = loadProfiles(profilesPath);
  const packs = loadPacks(packsPath);
  const inventory = buildInventory(manifest, extractLiveTools(capturePath));

  const command = args._[0];
  if (command === "inventory") {
    printInventory(inventory, args.json);
    return;
  }
  if (command === "profiles") {
    printProfiles(profiles, args.json);
    return;
  }
  if (command === "packs") {
    printPacks(packs, args.json);
    return;
  }
  if (command === "plan") {
    printPlan(summarizePlan(inventory, profiles), args.json);
    return;
  }
  if (command === "apply-profile") {
    const profileId = args._[1];
    if (!profileId) {
      throw new Error("apply-profile requires a profile id");
    }
    const profile = findProfile(profiles, profileId);
    const applied = applyProfile(settingsPath, profile);
    const payload = {
      profileId: profile.id,
      settingsPath,
      backupPath: applied.backupPath,
      selectedModel: applied.settings.selectedModel,
      connectionMode: applied.settings.connectionMode,
      localModelConfig: applied.settings.localModelConfig,
    };
    if (args.json) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    console.log(`Applied profile ${profile.id}`);
    console.log(`  settings: ${settingsPath}`);
    console.log(`  backup: ${applied.backupPath}`);
    console.log(`  model: ${payload.localModelConfig?.modelName || payload.selectedModel}`);
    return;
  }

  if (command === "run-tool" || command === "run-category" || command === "run-matrix" || command === "run-pack") {
    ensureFixtures(fixtureRoot);
    const selectedProfiles = selectProfiles(args, profiles);
    let selectedEntries = inventory;
    let pack = null;
    if (command === "run-pack") {
      const packId = args._[1];
      if (!packId) {
        throw new Error("run-pack requires a pack id");
      }
      pack = findPack(packs, packId);
      mergePackIntoArgs(args, pack);
    } else if (command === "run-tool") {
      const toolName = args._[1];
      if (!toolName) {
        throw new Error("run-tool requires a tool name");
      }
      args.toolsRequested = Array.from(new Set([...args.toolsRequested, toolName]));
    } else if (command === "run-category") {
      const category = args._[1];
      if (!category) {
        throw new Error("run-category requires a category");
      }
      args.categoriesRequested = Array.from(new Set([...args.categoriesRequested, category]));
    }
    selectedEntries = filterEntries(inventory, args);
    if (selectedEntries.length === 0) {
      throw new Error("No tool entries matched the requested filters.");
    }
    const queue = buildRunQueue(selectedEntries, selectedProfiles, args, fixtureRoot);
    const batchDir = path.join(logRoot, batchSlug(pack?.id || command), `batch-${safeSlug(pack?.id || command)}`);
    fs.mkdirSync(batchDir, { recursive: true });
    if (args.dryRun) {
        const payload = queue.map((item) => ({
          profileId: item.profile.id,
          tool: item.entry.tool,
          category: item.entry.category,
          caseId: item.variant.caseId,
          family: item.variant.family,
          messages: item.variant.messages,
        }));
      if (args.json) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        printRunResults(payload.map((entry) => ({
          ...entry,
          evaluation: {
            status: "dry-run",
            parsedToolNames: [],
            assistantText: "",
            formatHints: [],
            runtimeMetrics: { firstTokenMs: null, elapsedMs: null, tokensPerSecond: null },
          },
          runDir: "<dry-run>",
        })), false);
      }
      return;
    }

    const results = [];
    let lastAppliedProfileId = "";
    let currentGateway = null;
    const needsManagedRuntimeLock = selectedProfiles.some((profile) => profileUsesManagedRuntime(profile));
    let lockHandle = null;
    try {
      if (needsManagedRuntimeLock) {
        lockHandle = acquireFilesystemLock(lockRoot, "managed-rnn-local-runtime", args.lockTimeoutMs);
        writeJson(path.join(batchDir, "managed-runtime-lock.json"), {
          acquiredAt: new Date().toISOString(),
          lockRoot,
          target: lockHandle.target,
          ownerPid: process.pid,
        });
      }

      for (const item of queue) {
        let applied = null;
        if (item.profile.id !== lastAppliedProfileId) {
          let managedRuntime = null;
          let managedRuntimeWarmup = null;
          if (profileUsesManagedRuntime(item.profile)) {
            managedRuntime = restartManagedRuntime();
            managedRuntimeWarmup = warmManagedRuntimeModel(item.profile.localModelConfig?.modelName || "");
          }
          applied = applyProfile(settingsPath, item.profile);
          currentGateway =
            item.profile.localModelConfig && typeof item.profile.localModelConfig === "object"
              ? ensureGatewayForProfile(item.profile, profilesPath, fixtureRoot, capturePath)
              : null;
          lastAppliedProfileId = item.profile.id;
          if (managedRuntime) {
            writeJson(path.join(batchDir, `managed-runtime-${safeSlug(item.profile.id)}.json`), managedRuntime);
          }
          if (managedRuntimeWarmup) {
            writeJson(
              path.join(batchDir, `managed-runtime-warmup-${safeSlug(item.profile.id)}.json`),
              managedRuntimeWarmup,
            );
          }
        }
        const profileTimeoutMs =
          Number.isFinite(args.timeoutMs) && args.timeoutMs > 0
            ? args.timeoutMs
            : profileUsesManagedRuntime(item.profile)
              ? 120000
              : 30000;
        const run = runHarness({
          profile: item.profile,
          messages: item.variant.messages,
          capturePath,
          runRoot: batchDir,
          toolEntry: item.entry,
          variant: item.variant,
          repetition: item.repetition,
          fixtureRoot,
          gateway: currentGateway,
          timeoutMs: profileTimeoutMs,
        });
        results.push({
          profileId: item.profile.id,
          tool: item.entry.tool,
          category: item.entry.category,
          caseId: item.variant.caseId,
          family: item.variant.family,
          repetition: item.repetition,
          runDir: run.runDir,
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
          evaluation: run.evaluation,
          exitCode: run.exitCode,
          backupPath: applied?.backupPath || null,
          gateway: currentGateway,
        });
      }
    } finally {
      releaseFilesystemLock(lockHandle);
    }
    const batchSummary = buildBatchSummary({
      command,
      packId: pack?.id || null,
      results,
      selectedProfiles,
      selectedEntries,
      args,
      batchDir,
    });
    writeJson(path.join(batchDir, "batch-summary.json"), batchSummary);
    printRunResults(results, args.json);
    return;
  }

  usage();
  process.exit(1);
}

main();
