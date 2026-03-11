#!/usr/bin/env node

import http from "node:http";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { chromium } from "patchright";
import { WebSocketServer, WebSocket } from "ws";

const PORT = Number(process.env.ENTROPIC_BROWSER_SERVICE_PORT || 19791);
const HOST_PORT = Number(process.env.ENTROPIC_BROWSER_HOST_PORT || 19792);
const DESKTOP_PORT = Number(process.env.ENTROPIC_BROWSER_DESKTOP_PORT || 19793);
const DESKTOP_HOST_PORT = Number(process.env.ENTROPIC_BROWSER_DESKTOP_HOST_PORT || DESKTOP_PORT);
const LISTEN_HOST = process.env.ENTROPIC_BROWSER_BIND || "0.0.0.0";
const PROFILE_ROOT = process.env.ENTROPIC_BROWSER_PROFILE || "/data/browser/profile";
const WORKSPACE_ROOT = process.env.ENTROPIC_WORKSPACE_PATH || "/data/workspace";
const DEFAULT_TIMEOUT_MS = Number(process.env.ENTROPIC_BROWSER_TIMEOUT_MS || 30000);
const LIVE_FRAME_FORMAT = (process.env.ENTROPIC_BROWSER_LIVE_FORMAT || "png").toLowerCase() === "jpeg"
  ? "jpeg"
  : "png";
const LIVE_FRAME_QUALITY = Number(
  process.env.ENTROPIC_BROWSER_LIVE_QUALITY || (LIVE_FRAME_FORMAT === "jpeg" ? 88 : 100),
);
const LIVE_POST_NAVIGATION_DELAY_MS = Number(process.env.ENTROPIC_BROWSER_LIVE_DELAY_MS || 120);
const WORKSPACE_RELOAD_POLL_MS = Math.max(
  250,
  Number(process.env.ENTROPIC_BROWSER_WORKSPACE_RELOAD_POLL_MS || 700),
);
const WORKSPACE_RELOAD_DEBOUNCE_MS = Math.max(
  80,
  Number(process.env.ENTROPIC_BROWSER_WORKSPACE_RELOAD_DEBOUNCE_MS || 180),
);
const WORKSPACE_RELOAD_MAX_FILES = Math.max(
  100,
  Number(process.env.ENTROPIC_BROWSER_WORKSPACE_RELOAD_MAX_FILES || 2000),
);
const MAX_INTERACTIVE_ELEMENTS = 75;
const DEFAULT_VIEWPORT = { width: 1440, height: 900 };
const HEADFUL_MIN_VIEWPORT = { width: 640, height: 420 };
const BROWSER_DEVICE_SCALE_FACTOR = Math.max(
  1,
  Math.min(3, Number(process.env.ENTROPIC_BROWSER_DEVICE_SCALE_FACTOR || 2)),
);
const DISPLAY_AVAILABLE = typeof process.env.DISPLAY === "string" && process.env.DISPLAY.trim() !== "";
const USE_HEADFUL_DISPLAY = (process.env.ENTROPIC_BROWSER_HEADFUL ?? "1") !== "0" && DISPLAY_AVAILABLE;
const EXPOSE_REMOTE_DESKTOP_UI = (process.env.ENTROPIC_BROWSER_REMOTE_DESKTOP_UI ?? "0") === "1";
const ALLOW_UNSAFE_NO_SANDBOX = (process.env.ENTROPIC_BROWSER_ALLOW_UNSAFE_NO_SANDBOX ?? "0") === "1";
const ALLOW_INSECURE_SECURE_CONTEXTS =
  (process.env.ENTROPIC_BROWSER_ALLOW_INSECURE_SECURE_CONTEXTS ?? "0") === "1";
const BROWSER_CONTROL_TOKEN_PATH =
  process.env.ENTROPIC_BROWSER_CONTROL_TOKEN_PATH || "/data/browser/control-token";
const BROWSER_APP_URL = `data:text/html,${encodeURIComponent(
  "<html><head><title>Entropic Browser</title><style>html,body{margin:0;background:#fff;height:100%;}</style></head><body></body></html>",
)}`;
const WORKSPACE_RELOAD_IGNORED_DIRS = new Set([
  ".git",
  ".next",
  ".openclaw",
  "build",
  "coverage",
  "dist",
  "node_modules",
]);

const sessions = new Map();
const BROWSER_CONTROL_TOKEN = loadBrowserControlToken();

function loadBrowserControlToken() {
  try {
    const existing = fs.readFileSync(BROWSER_CONTROL_TOKEN_PATH, "utf8").trim();
    if (existing) {
      return existing;
    }
  } catch {
    // Fall through and create a token.
  }

  const token = randomUUID().replace(/-/g, "");
  fs.mkdirSync(path.dirname(BROWSER_CONTROL_TOKEN_PATH), { recursive: true });
  fs.writeFileSync(BROWSER_CONTROL_TOKEN_PATH, `${token}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(BROWSER_CONTROL_TOKEN_PATH, 0o600);
  } catch {
    // Best-effort only.
  }
  return token;
}

function parseUrlOrNull(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function secureContextOverrideOrigin(targetUrl) {
  if (!ALLOW_INSECURE_SECURE_CONTEXTS) {
    return null;
  }
  const parsed = parseUrlOrNull(targetUrl);
  if (!parsed || parsed.protocol !== "http:") {
    return null;
  }
  if (
    parsed.hostname === "host.docker.internal" ||
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1"
  ) {
    return parsed.origin;
  }
  return null;
}

function buildLaunchArgs(secureOrigins = [], viewport = DEFAULT_VIEWPORT) {
  const args = ["--disable-dev-shm-usage"];
  if (ALLOW_UNSAFE_NO_SANDBOX) {
    args.push("--no-sandbox");
  }
  if (secureOrigins.length > 0) {
    args.push(`--unsafely-treat-insecure-origin-as-secure=${secureOrigins.join(",")}`);
  }
  if (USE_HEADFUL_DISPLAY) {
    args.push(
      `--app=${BROWSER_APP_URL}`,
      "--window-position=0,0",
      `--window-size=${viewport.width},${viewport.height}`,
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--test-type",
      "--disable-infobars",
    );
  }
  return args;
}

function isSandboxLaunchFailure(error) {
  const message = String(error instanceof Error ? error.message : error || "").toLowerCase();
  return (
    message.includes("sandbox") ||
    message.includes("setuid") ||
    message.includes("zygote") ||
    message.includes("namespace")
  );
}

function normalizeNavigationTarget(rawTargetUrl) {
  const raw = typeof rawTargetUrl === "string" ? rawTargetUrl.trim() : "";
  if (!raw) {
    return "";
  }

  const withScheme = /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(raw) ? raw : `https://${raw}`;
  const parsed = parseUrlOrNull(withScheme);
  if (!parsed) {
    throw new Error(`Invalid URL: ${raw}`);
  }

  // Patchright currently hangs on the apex Google URL in this runtime, while
  // the canonical www host works reliably.
  if ((parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.hostname === "google.com") {
    parsed.hostname = "www.google.com";
  }

  return parsed.toString();
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function browserControlTokenFromRequest(req, url = null) {
  const headerValue = req.headers["x-entropic-browser-token"];
  const token = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (typeof token === "string" && token.trim()) {
    return token.trim();
  }
  return url?.searchParams.get("token")?.trim() || "";
}

function isAuthorizedBrowserControlRequest(req, url = null) {
  return browserControlTokenFromRequest(req, url) === BROWSER_CONTROL_TOKEN;
}

function sendBrowserControlUnauthorized(res) {
  sendJson(res, 401, { error: "Unauthorized browser control request" });
}

function proxyPortFromHostHeader(hostHeader) {
  const host = String(hostHeader || "")
    .split(":")[0]
    .trim()
    .toLowerCase();
  const match = /^p(\d+)\.localhost$/.exec(host);
  if (!match) {
    return null;
  }
  const port = Number(match[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return null;
  }
  return port;
}

function rewriteProxyInboundUrl(value, targetPort) {
  if (typeof value !== "string" || !value) {
    return value;
  }
  return value.replace(/^https?:\/\/p\d+\.localhost:\d+/i, `http://127.0.0.1:${targetPort}`);
}

function rewriteProxyLocation(value, targetPort) {
  if (typeof value !== "string" || !value) {
    return value;
  }
  const proxyOrigin = `http://p${targetPort}.localhost:${HOST_PORT}`;
  return value
    .replace(`http://127.0.0.1:${targetPort}`, proxyOrigin)
    .replace(`http://localhost:${targetPort}`, proxyOrigin);
}

function proxiedRequestHeaders(req, targetPort) {
  const headers = { ...req.headers };
  headers.host = `127.0.0.1:${targetPort}`;
  if (typeof headers.origin === "string") {
    headers.origin = rewriteProxyInboundUrl(headers.origin, targetPort);
  }
  if (typeof headers.referer === "string") {
    headers.referer = rewriteProxyInboundUrl(headers.referer, targetPort);
  }
  return headers;
}

function isHtmlNavigationRequest(req) {
  if ((req.method || "GET").toUpperCase() !== "GET") {
    return false;
  }
  const accept = String(req.headers.accept || "").toLowerCase();
  if (accept.includes("text/html")) {
    return true;
  }
  return String(req.headers["sec-fetch-dest"] || "").toLowerCase() === "document";
}

function sendLocalAppRetryPage(req, res, targetPort, error) {
  const nextPath = req.url || "/";
  const message = error instanceof Error ? error.message : String(error);
  const escapedPath = JSON.stringify(nextPath);
  const escapedMessage = JSON.stringify(message);
  const escapedPort = JSON.stringify(String(targetPort));
  const body = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta http-equiv="refresh" content="1" />
    <title>Starting local app...</title>
    <style>
      :root { color-scheme: light; }
      html, body {
        margin: 0;
        min-height: 100%;
        background:
          radial-gradient(circle at top, rgba(74,144,226,0.18), transparent 42%),
          linear-gradient(180deg, #f7f8fb 0%, #eef1f7 100%);
        color: #142033;
        font: 15px/1.45 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      body {
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
      }
      .card {
        width: min(520px, 100%);
        padding: 24px 24px 20px;
        border-radius: 20px;
        background: rgba(255,255,255,0.88);
        box-shadow: 0 20px 60px rgba(18, 35, 64, 0.12);
        border: 1px solid rgba(20, 32, 51, 0.08);
        backdrop-filter: blur(10px);
      }
      .row {
        display: flex;
        align-items: center;
        gap: 14px;
      }
      .spinner {
        width: 16px;
        height: 16px;
        border-radius: 999px;
        border: 2px solid rgba(45, 93, 167, 0.18);
        border-top-color: #2d5da7;
        animation: spin 0.9s linear infinite;
        flex: 0 0 auto;
      }
      h1 {
        margin: 0;
        font-size: 18px;
        font-weight: 700;
      }
      p {
        margin: 12px 0 0;
        color: #49566b;
      }
      code {
        display: inline-block;
        margin-top: 12px;
        padding: 7px 10px;
        border-radius: 10px;
        background: rgba(20, 32, 51, 0.06);
        color: #182230;
        font-size: 13px;
      }
      .meta {
        margin-top: 18px;
        font-size: 12px;
        color: #6b7687;
      }
      .actions {
        margin-top: 18px;
        display: flex;
        gap: 10px;
      }
      button {
        border: 0;
        border-radius: 10px;
        padding: 9px 13px;
        background: #2d5da7;
        color: white;
        font: inherit;
        cursor: pointer;
      }
      .secondary {
        background: rgba(20, 32, 51, 0.08);
        color: #142033;
      }
      @keyframes spin {
        to { transform: rotate(360deg); }
      }
    </style>
  </head>
  <body>
    <div class="card">
      <div class="row">
        <div class="spinner" aria-hidden="true"></div>
        <h1>Waiting for localhost:${escapedPort.slice(1, -1)}...</h1>
      </div>
      <p>Entropic can see the preview route, but nothing is listening on the app port yet. This page will retry automatically.</p>
      <code>${targetPort}${nextPath}</code>
      <div class="meta" id="status"></div>
      <div class="actions">
        <button type="button" id="retry">Retry now</button>
        <button type="button" class="secondary" id="open">Open when ready</button>
      </div>
    </div>
    <script>
      const nextPath = ${escapedPath};
      const errorMessage = ${escapedMessage};
      const status = document.getElementById("status");
      const retry = () => window.location.replace(nextPath);
      document.getElementById("retry")?.addEventListener("click", retry);
      document.getElementById("open")?.addEventListener("click", retry);
      if (status) {
        status.textContent = "Last error: " + errorMessage;
      }
      window.setTimeout(retry, 1000);
    </script>
  </body>
</html>`;
  res.writeHead(503, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Retry-After": "1",
  });
  res.end(body);
}

function proxyLocalAppRequest(req, res, targetPort) {
  const proxyReq = http.request(
    {
      hostname: "127.0.0.1",
      port: targetPort,
      method: req.method,
      path: req.url || "/",
      headers: proxiedRequestHeaders(req, targetPort),
    },
    (proxyRes) => {
      const headers = { ...proxyRes.headers };
      if (typeof headers.location === "string") {
        headers.location = rewriteProxyLocation(headers.location, targetPort);
      }
      res.writeHead(proxyRes.statusCode || 502, headers);
      proxyRes.pipe(res);
    },
  );

  proxyReq.on("error", (error) => {
    if (!res.headersSent) {
      if (isHtmlNavigationRequest(req)) {
        sendLocalAppRetryPage(req, res, targetPort, error);
        return;
      }
      sendJson(res, 502, {
        error: `Failed to reach local app on port ${targetPort}: ${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }
    res.destroy(error);
  });

  req.pipe(proxyReq);
}

function proxyLocalAppUpgrade(req, socket, head, targetPort) {
  const targetSocket = net.connect(targetPort, "127.0.0.1");

  targetSocket.on("connect", () => {
    const headers = proxiedRequestHeaders(req, targetPort);
    const lines = [`GET ${req.url || "/"} HTTP/1.1`];
    for (const [key, value] of Object.entries(headers)) {
      if (value == null) continue;
      if (Array.isArray(value)) {
        for (const item of value) {
          lines.push(`${key}: ${item}`);
        }
        continue;
      }
      lines.push(`${key}: ${value}`);
    }
    lines.push("", "");
    targetSocket.write(lines.join("\r\n"));
    if (head?.length) {
      targetSocket.write(head);
    }
    socket.pipe(targetSocket);
    targetSocket.pipe(socket);
  });

  targetSocket.on("error", () => {
    socket.destroy();
  });
  socket.on("error", () => {
    targetSocket.destroy();
  });
}

function decodeUrlPathPart(rawPart) {
  try {
    return decodeURIComponent(rawPart);
  } catch {
    throw new Error("Invalid URL path segment");
  }
}

function resolveWorkspaceAssetPath(urlParts) {
  const workspaceRoot = path.resolve(WORKSPACE_ROOT);
  const relativeParts = urlParts
    .map(decodeUrlPathPart)
    .filter((part) => part && part !== ".");

  for (const part of relativeParts) {
    if (part === "..") {
      throw new Error("Invalid workspace path");
    }
  }

  let resolved = path.resolve(workspaceRoot, relativeParts.join("/"));
  if (resolved !== workspaceRoot && !resolved.startsWith(`${workspaceRoot}${path.sep}`)) {
    throw new Error("Invalid workspace path");
  }

  if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
    resolved = path.join(resolved, "index.html");
  }

  return resolved;
}

function contentTypeForFile(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case ".html":
    case ".htm":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
    case ".mjs":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".ico":
      return "image/x-icon";
    case ".txt":
    case ".md":
      return "text/plain; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

function serveWorkspaceAsset(res, urlParts) {
  const filePath = resolveWorkspaceAssetPath(urlParts);
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    sendJson(res, 404, { error: "Workspace file not found" });
    return;
  }

  res.writeHead(200, {
    "Content-Type": contentTypeForFile(filePath),
    "Cache-Control": "no-store",
  });
  fs.createReadStream(filePath).pipe(res);
}

function resolveWorkspaceAssetFromUrl(rawUrl) {
  const parsed = parseUrlOrNull(rawUrl);
  if (!parsed) {
    return null;
  }
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts[0] !== "__workspace__") {
    return null;
  }
  try {
    return resolveWorkspaceAssetPath(parts.slice(1));
  } catch {
    return null;
  }
}

function workspaceReloadRootFromUrl(rawUrl) {
  const assetPath = resolveWorkspaceAssetFromUrl(rawUrl);
  if (!assetPath) {
    return null;
  }
  return path.dirname(assetPath);
}

function collectWorkspaceFingerprint(rootPath, relativePath = "", entries = [], state = { count: 0 }) {
  if (state.count >= WORKSPACE_RELOAD_MAX_FILES) {
    return entries;
  }
  const absolutePath = relativePath ? path.join(rootPath, relativePath) : rootPath;
  const children = fs
    .readdirSync(absolutePath, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const child of children) {
    if (state.count >= WORKSPACE_RELOAD_MAX_FILES) {
      break;
    }
    const nextRelativePath = relativePath ? `${relativePath}/${child.name}` : child.name;
    const childPath = path.join(rootPath, nextRelativePath);

    if (child.isDirectory()) {
      if (WORKSPACE_RELOAD_IGNORED_DIRS.has(child.name)) {
        continue;
      }
      collectWorkspaceFingerprint(rootPath, nextRelativePath, entries, state);
      continue;
    }

    if (!child.isFile()) {
      continue;
    }

    try {
      const stats = fs.statSync(childPath);
      entries.push(`${nextRelativePath}:${stats.size}:${Math.round(stats.mtimeMs)}`);
      state.count += 1;
    } catch {
      entries.push(`${nextRelativePath}:missing`);
      state.count += 1;
    }
  }

  return entries;
}

function workspaceFingerprint(rootPath) {
  if (!rootPath || !fs.existsSync(rootPath)) {
    return null;
  }
  try {
    const entries = collectWorkspaceFingerprint(rootPath);
    return entries.join("\n");
  } catch {
    return null;
  }
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 5_000_000) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error(`Invalid JSON body: ${error.message}`));
      }
    });
    req.on("error", reject);
  });
}

function getSession(id) {
  const session = sessions.get(id);
  if (!session) {
    throw new Error(`Unknown browser session: ${id}`);
  }
  return session;
}

function trimText(text) {
  return (text || "").replace(/\n{3,}/g, "\n\n").trim().slice(0, 12000);
}

function trimLabel(text, maxLength = 120) {
  const normalized = (text || "").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, maxLength - 1)}…`;
}

function liveWsUrl(sessionId) {
  return `ws://127.0.0.1:${HOST_PORT}/live/${sessionId}?token=${encodeURIComponent(BROWSER_CONTROL_TOKEN)}`;
}

function desktopViewerUrl() {
  if (!USE_HEADFUL_DISPLAY || !EXPOSE_REMOTE_DESKTOP_UI) {
    return null;
  }
  const params = new URLSearchParams({
    autoconnect: "1",
    resize: "scale",
    reconnect: "1",
    view_only: "0",
    path: "websockify",
  });
  return `http://127.0.0.1:${DESKTOP_HOST_PORT}/vnc_lite.html?${params.toString()}`;
}

function normalizeViewport(width, height) {
  const minWidth = USE_HEADFUL_DISPLAY ? HEADFUL_MIN_VIEWPORT.width : 320;
  const minHeight = USE_HEADFUL_DISPLAY ? HEADFUL_MIN_VIEWPORT.height : 240;
  return {
    width: Math.max(minWidth, Math.min(2560, Number(width) || DEFAULT_VIEWPORT.width)),
    height: Math.max(minHeight, Math.min(1600, Number(height) || DEFAULT_VIEWPORT.height)),
  };
}

function recordSessionHistory(session, nextUrl, options = {}) {
  if (options.recordHistory === false) {
    return;
  }
  const base = session.history.slice(0, session.historyIndex + 1);
  if (base[base.length - 1] !== nextUrl) {
    base.push(nextUrl);
    session.history = base;
    session.historyIndex = Math.max(0, session.history.length - 1);
  }
}

async function ensurePage(session) {
  if (!session.page || session.page.isClosed()) {
    session.page = session.context.pages()[0] || await session.context.newPage();
    installSessionPageObservers(session, session.page);
  }
  return session.page;
}

async function waitForPageStable(page, timeoutMs, options = {}) {
  const requireDom = options.requireDom !== false;
  if (requireDom) {
    await page.waitForLoadState("domcontentloaded", { timeout: timeoutMs });
  }
  if (options.allowNetworkIdle) {
    await page.waitForLoadState("networkidle", {
      timeout: Math.min(timeoutMs, 1200),
    }).catch(() => {});
    return;
  }
  await page.waitForTimeout(Math.min(timeoutMs, LIVE_POST_NAVIGATION_DELAY_MS)).catch(() => {});
}

async function buildSessionState(session) {
  const page = await ensurePage(session);
  syncSessionWorkspaceAutoReload(session, page.url());
  const title = await page.title().catch(() => "");
  return {
    type: "state",
    session_id: session.id,
    url: page.url(),
    title,
    live_ws_url: liveWsUrl(session.id),
    remote_desktop_url: desktopViewerUrl(),
    viewport_width: session.viewport.width,
    viewport_height: session.viewport.height,
    can_go_back: session.historyIndex > 0,
    can_go_forward: session.historyIndex >= 0 && session.historyIndex < session.history.length - 1,
  };
}

function broadcastSessionMessage(session, payload) {
  const raw = JSON.stringify(payload);
  for (const client of session.liveClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(raw);
    }
  }
}

async function sendSessionState(session, client = null) {
  const payload = await buildSessionState(session);
  const raw = JSON.stringify(payload);
  if (client) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(raw);
    }
    return;
  }
  for (const liveClient of session.liveClients) {
    if (liveClient.readyState === WebSocket.OPEN) {
      liveClient.send(raw);
    }
  }
}

function sendSessionLastFrame(session, client) {
  if (!session.lastFrame || client.readyState !== WebSocket.OPEN) {
    return;
  }
  client.send(JSON.stringify({
    type: "frame",
    format: session.lastFrame.format,
    data: session.lastFrame.data,
    width: session.lastFrame.width,
    height: session.lastFrame.height,
  }));
}

function clearSessionStateSync(session) {
  if (session.stateSyncTimer) {
    clearTimeout(session.stateSyncTimer);
    session.stateSyncTimer = null;
  }
}

function clearSessionWorkspaceAutoReload(session) {
  if (session.workspaceReloadTimer) {
    clearInterval(session.workspaceReloadTimer);
    session.workspaceReloadTimer = null;
  }
  if (session.workspaceReloadPendingTimer) {
    clearTimeout(session.workspaceReloadPendingTimer);
    session.workspaceReloadPendingTimer = null;
  }
  session.workspaceReloadRoot = null;
  session.workspaceReloadFingerprint = null;
}

async function performSessionWorkspaceReload(session) {
  if (session.workspaceReloadInFlight) {
    return;
  }
  session.workspaceReloadInFlight = true;
  try {
    const page = await ensurePage(session);
    await page.reload({
      waitUntil: "domcontentloaded",
      timeout: DEFAULT_TIMEOUT_MS,
    });
    await waitForPageStable(page, DEFAULT_TIMEOUT_MS);
    recordSessionHistory(session, page.url(), { recordHistory: false });
    await sendSessionState(session);
  } catch (error) {
    broadcastSessionMessage(session, {
      type: "error",
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    session.workspaceReloadInFlight = false;
  }
}

function scheduleSessionWorkspaceReload(session) {
  if (session.workspaceReloadPendingTimer) {
    clearTimeout(session.workspaceReloadPendingTimer);
  }
  session.workspaceReloadPendingTimer = setTimeout(() => {
    session.workspaceReloadPendingTimer = null;
    void performSessionWorkspaceReload(session);
  }, WORKSPACE_RELOAD_DEBOUNCE_MS);
}

function syncSessionWorkspaceAutoReload(session, currentUrl) {
  const nextRoot = workspaceReloadRootFromUrl(currentUrl);
  if (!nextRoot) {
    clearSessionWorkspaceAutoReload(session);
    return;
  }

  const normalizedRoot = path.resolve(nextRoot);
  if (session.workspaceReloadRoot === normalizedRoot && session.workspaceReloadTimer) {
    return;
  }

  clearSessionWorkspaceAutoReload(session);
  session.workspaceReloadRoot = normalizedRoot;
  session.workspaceReloadFingerprint = workspaceFingerprint(normalizedRoot);
  session.workspaceReloadTimer = setInterval(async () => {
    try {
      const page = await ensurePage(session);
      const activeRoot = workspaceReloadRootFromUrl(page.url());
      if (!activeRoot || path.resolve(activeRoot) !== normalizedRoot) {
        clearSessionWorkspaceAutoReload(session);
        return;
      }

      const nextFingerprint = workspaceFingerprint(normalizedRoot);
      if (nextFingerprint === null) {
        session.workspaceReloadFingerprint = null;
        return;
      }
      if (session.workspaceReloadFingerprint === null) {
        session.workspaceReloadFingerprint = nextFingerprint;
        return;
      }
      if (nextFingerprint !== session.workspaceReloadFingerprint) {
        session.workspaceReloadFingerprint = nextFingerprint;
        scheduleSessionWorkspaceReload(session);
      }
    } catch {
      clearSessionWorkspaceAutoReload(session);
    }
  }, WORKSPACE_RELOAD_POLL_MS);
  session.workspaceReloadTimer.unref?.();
}

function scheduleSessionStateSync(session, options = {}) {
  clearSessionStateSync(session);
  const delayMs = Math.max(0, Number(options.delayMs) || 150);
  session.stateSyncTimer = setTimeout(async () => {
    session.stateSyncTimer = null;
    try {
      const page = await ensurePage(session);
      recordSessionHistory(session, page.url(), options);
      await sendSessionState(session);
    } catch (error) {
      broadcastSessionMessage(session, {
        type: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, delayMs);
}

function installSessionPageObservers(session, page) {
  if (!page || session.observedPages.has(page)) {
    return;
  }
  session.observedPages.add(page);

  const scheduleForCurrentPage = (options = {}) => {
    if (session.page !== page) {
      return;
    }
    scheduleSessionStateSync(session, options);
  };

  page.on("domcontentloaded", () => {
    scheduleForCurrentPage({ delayMs: 40 });
  });

  page.on("load", () => {
    scheduleForCurrentPage({ delayMs: 80 });
  });

  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) {
      scheduleForCurrentPage({ delayMs: 30 });
    }
  });

  page.on("close", () => {
    if (session.page !== page) {
      return;
    }
    const nextPage = session.context
      .pages()
      .find((candidate) => candidate !== page && !candidate.isClosed());
    session.page = nextPage || null;
    if (session.page) {
      installSessionPageObservers(session, session.page);
      if (session.liveClients.size > 0) {
        void ensureSessionScreencast(session)
          .then(() => sendSessionState(session))
          .catch((error) => {
            broadcastSessionMessage(session, {
              type: "error",
              error: error instanceof Error ? error.message : String(error),
            });
          });
      }
    }
  });
}

function installSessionContextObservers(session) {
  session.context.on("page", (page) => {
    session.page = page;
    installSessionPageObservers(session, page);
    if (session.liveClients.size > 0) {
      void ensureSessionScreencast(session)
        .then(() => sendSessionState(session))
        .catch((error) => {
          broadcastSessionMessage(session, {
            type: "error",
            error: error instanceof Error ? error.message : String(error),
          });
        });
      return;
    }
    scheduleSessionStateSync(session, { delayMs: 40 });
  });
}

async function buildSnapshot(session) {
  const page = await ensurePage(session);
  syncSessionWorkspaceAutoReload(session, page.url());
  const screenshot = await page.screenshot({ type: "png" });
  const title = await page.title().catch(() => "");
  const pageData = await page.evaluate((maxElements) => {
    const main =
      document.querySelector("main, article, [role='main'], .content, #content") ||
      document.body;
    const interactiveSelectors = [
      "a[href]",
      "button",
      "summary",
      "input[type='button']",
      "input[type='submit']",
      "input[type='checkbox']",
      "input[type='radio']",
      "label[for]",
      "[role='button']",
      "[role='link']",
      "[onclick]",
      "[tabindex]"
    ];
    const candidates = Array.from(document.querySelectorAll(interactiveSelectors.join(",")));
    const elements = [];
    for (const node of candidates) {
      if (!(node instanceof HTMLElement)) continue;
      const rect = node.getBoundingClientRect();
      if (rect.width < 12 || rect.height < 12) continue;
      if (
        rect.bottom < 0 ||
        rect.right < 0 ||
        rect.left > window.innerWidth ||
        rect.top > window.innerHeight
      ) {
        continue;
      }
      const style = window.getComputedStyle(node);
      if (
        style.visibility === "hidden" ||
        style.display === "none" ||
        Number(style.opacity || "1") < 0.05
      ) {
        continue;
      }
      const text =
        node.getAttribute("aria-label") ||
        node.getAttribute("title") ||
        node.textContent ||
        (node instanceof HTMLInputElement ? node.value : "") ||
        "";
      const label = text.replace(/\s+/g, " ").trim();
      if (!label && !(node instanceof HTMLInputElement)) continue;
      const href =
        node instanceof HTMLAnchorElement && typeof node.href === "string" ? node.href : null;
      elements.push({
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
        label,
        tag: node.tagName.toLowerCase(),
        href,
      });
      if (elements.length >= maxElements) break;
    }

    return {
      text: main?.innerText || document.body?.innerText || "",
      pageWidth: window.innerWidth || 0,
      pageHeight: window.innerHeight || 0,
      interactiveElements: elements,
    };
  }, MAX_INTERACTIVE_ELEMENTS);

  return {
    session_id: session.id,
    url: page.url(),
    title,
    live_ws_url: liveWsUrl(session.id),
    remote_desktop_url: desktopViewerUrl(),
    text: trimText(pageData.text),
    screenshot_base64: screenshot.toString("base64"),
    screenshot_width: Math.max(1, Number(pageData.pageWidth) || 1440),
    screenshot_height: Math.max(1, Number(pageData.pageHeight) || 900),
    interactive_elements: (pageData.interactiveElements || []).map((element, index) => ({
      id: `${index}`,
      x: Math.max(0, Number(element.x) || 0),
      y: Math.max(0, Number(element.y) || 0),
      width: Math.max(1, Number(element.width) || 1),
      height: Math.max(1, Number(element.height) || 1),
      label: trimLabel(element.label),
      tag: element.tag || "element",
      href: typeof element.href === "string" ? element.href : null,
    })),
    can_go_back: session.historyIndex > 0,
    can_go_forward: session.historyIndex >= 0 && session.historyIndex < session.history.length - 1,
  };
}

async function buildLiveSnapshot(session) {
  const state = await buildSessionState(session);
  return {
    session_id: state.session_id,
    url: state.url,
    title: state.title,
    live_ws_url: state.live_ws_url,
    remote_desktop_url: state.remote_desktop_url,
    text: "",
    screenshot_base64: "",
    screenshot_width: state.viewport_width,
    screenshot_height: state.viewport_height,
    interactive_elements: [],
    can_go_back: state.can_go_back,
    can_go_forward: state.can_go_forward,
  };
}

async function buildActionSnapshot(session, options = {}) {
  if (options.forceFullSnapshot) {
    return buildSnapshot(session);
  }
  if (USE_HEADFUL_DISPLAY) {
    return buildLiveSnapshot(session);
  }
  if (session.liveClients.size === 0) {
    return buildSnapshot(session);
  }
  return buildLiveSnapshot(session);
}

async function navigateSession(session, targetUrl, options = {}) {
  const normalizedTargetUrl = normalizeNavigationTarget(targetUrl);
  const requiredSecureOrigin = secureContextOverrideOrigin(normalizedTargetUrl);
  if (requiredSecureOrigin && !session.secureOrigins.includes(requiredSecureOrigin)) {
    session.secureOrigins.push(requiredSecureOrigin);
    await relaunchSessionContext(session);
  }

  const page = await ensurePage(session);
  await page.goto(normalizedTargetUrl, {
    waitUntil: "domcontentloaded",
    timeout: DEFAULT_TIMEOUT_MS,
  });
  await waitForPageStable(page, DEFAULT_TIMEOUT_MS);

  recordSessionHistory(session, page.url(), options);
  await sendSessionState(session);
  return buildActionSnapshot(session, options);
}

async function launchBrowserContext(userDataDir, secureOrigins = [], viewport = DEFAULT_VIEWPORT) {
  try {
    return await chromium.launchPersistentContext(userDataDir, {
      headless: !USE_HEADFUL_DISPLAY,
      args: buildLaunchArgs(secureOrigins, viewport),
      viewport,
      deviceScaleFactor: BROWSER_DEVICE_SCALE_FACTOR,
      locale: "en-US",
      timezoneId: "America/Chicago",
    });
  } catch (error) {
    if (!ALLOW_UNSAFE_NO_SANDBOX && isSandboxLaunchFailure(error)) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}. ` +
          "Chromium sandbox launch failed in the runtime container. " +
          "If you need the previous dev-only fallback, set ENTROPIC_BROWSER_ALLOW_UNSAFE_NO_SANDBOX=1."
      );
    }
    throw error;
  }
}

async function stopSessionScreencast(session) {
  if (session.screencastActive && session.cdp) {
    await session.cdp.send("Page.stopScreencast").catch(() => {});
  }
  session.screencastActive = false;
}

async function readSelectedText(page) {
  return page.evaluate(() => {
    const active = document.activeElement;
    if (active instanceof HTMLTextAreaElement) {
      const start = active.selectionStart ?? 0;
      const end = active.selectionEnd ?? start;
      return active.value.slice(start, end);
    }
    if (active instanceof HTMLInputElement) {
      const selectableTypes = new Set(["", "text", "search", "url", "tel", "password", "email"]);
      if (selectableTypes.has((active.type || "").toLowerCase())) {
        const start = active.selectionStart ?? 0;
        const end = active.selectionEnd ?? start;
        return active.value.slice(start, end);
      }
    }
    const selection = window.getSelection();
    return selection ? selection.toString() : "";
  }).catch(() => "");
}

async function resetSessionStream(session, options = {}) {
  clearSessionStateSync(session);
  await stopSessionScreencast(session);
  if (session.cdp) {
    session.cdp.removeAllListeners("Page.screencastFrame");
    if (options.detach !== false) {
      await session.cdp.detach?.().catch(() => {});
    }
  }
  session.cdp = null;
  session.cdpPage = null;
  session.lastFrame = null;
}

async function ensureSessionCdp(session) {
  const page = await ensurePage(session);
  if (session.cdp && session.cdpPage === page) {
    return session.cdp;
  }

  await resetSessionStream(session);
  const cdp = await session.context.newCDPSession(page);
  await cdp.send("Page.enable");

  cdp.on("Page.screencastFrame", async (event) => {
    const width = Math.max(
      1,
      Number(event.metadata?.deviceWidth) || session.viewport.width,
    );
    const height = Math.max(
      1,
      Number(event.metadata?.deviceHeight) || session.viewport.height,
    );
    session.lastFrame = { data: event.data, format: LIVE_FRAME_FORMAT, width, height };
    broadcastSessionMessage(session, {
      type: "frame",
      format: LIVE_FRAME_FORMAT,
      data: event.data,
      width,
      height,
    });
    await cdp.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => {});
  });

  session.cdp = cdp;
  session.cdpPage = page;
  return cdp;
}

async function ensureSessionScreencast(session) {
  if (session.liveClients.size === 0) {
    return;
  }
  const cdp = await ensureSessionCdp(session);
  if (session.screencastActive) {
    return;
  }
  const screencastOptions = {
    format: LIVE_FRAME_FORMAT,
    everyNthFrame: 1,
    maxWidth: Math.max(1, Math.round(session.viewport.width * BROWSER_DEVICE_SCALE_FACTOR)),
    maxHeight: Math.max(1, Math.round(session.viewport.height * BROWSER_DEVICE_SCALE_FACTOR)),
  };
  if (LIVE_FRAME_FORMAT === "jpeg") {
    screencastOptions.quality = LIVE_FRAME_QUALITY;
  }
  await cdp.send("Page.startScreencast", screencastOptions);
  session.screencastActive = true;
}

async function relaunchSessionContext(session) {
  await resetSessionStream(session, { detach: false });
  if (session.context) {
    await session.context.close();
  }
  session.context = await launchBrowserContext(session.userDataDir, session.secureOrigins, session.viewport);
  session.page = session.context.pages()[0] || await session.context.newPage();
  installSessionContextObservers(session);
  installSessionPageObservers(session, session.page);
  if (session.liveClients.size > 0) {
    await ensureSessionScreencast(session);
    await sendSessionState(session);
  }
}

async function createSession(initialUrl, viewportInput = DEFAULT_VIEWPORT) {
  const id = randomUUID();
  const userDataDir = path.join(PROFILE_ROOT, id);
  fs.mkdirSync(userDataDir, { recursive: true });
  const secureOrigins = [];
  const initialSecureOrigin = initialUrl ? secureContextOverrideOrigin(initialUrl) : null;
  if (initialSecureOrigin) {
    secureOrigins.push(initialSecureOrigin);
  }

  const viewport = normalizeViewport(viewportInput.width, viewportInput.height);
  const context = await launchBrowserContext(userDataDir, secureOrigins, viewport);

  const session = {
    id,
    userDataDir,
    context,
    page: context.pages()[0] || (await context.newPage()),
    viewport,
    secureOrigins,
    history: [],
    historyIndex: -1,
    liveClients: new Set(),
    cdp: null,
    cdpPage: null,
    screencastActive: false,
    lastFrame: null,
    stateSyncTimer: null,
    workspaceReloadTimer: null,
    workspaceReloadPendingTimer: null,
    workspaceReloadRoot: null,
    workspaceReloadFingerprint: null,
    workspaceReloadInFlight: false,
    observedPages: new WeakSet(),
  };
  sessions.set(id, session);
  installSessionContextObservers(session);
  installSessionPageObservers(session, session.page);

  if (initialUrl) {
    return navigateSession(session, initialUrl);
  }
  if (USE_HEADFUL_DISPLAY) {
    return buildLiveSnapshot(session);
  }
  return buildSnapshot(session);
}

async function closeSession(id) {
  const session = getSession(id);
  sessions.delete(id);
  clearSessionStateSync(session);
  clearSessionWorkspaceAutoReload(session);
  for (const client of session.liveClients) {
    client.close(1000, "Session closed");
  }
  await resetSessionStream(session, { detach: false });
  await session.context.close();
}

async function clickSession(session, x, y) {
  const page = await ensurePage(session);
  await page.mouse.click(x, y);
  if (session.liveClients.size === 0) {
    await waitForPageStable(page, DEFAULT_TIMEOUT_MS, {
      allowNetworkIdle: false,
    });
    recordSessionHistory(session, page.url());
    await sendSessionState(session);
    return buildSnapshot(session);
  }
  scheduleSessionStateSync(session, { delayMs: 120 });
  return buildLiveSnapshot(session);
}

function normalizeMouseButton(button) {
  return button === "right" || button === "middle" ? button : "left";
}

function normalizeKeyboardToken(payload) {
  const key = typeof payload.key === "string" ? payload.key : "";
  const code = typeof payload.code === "string" ? payload.code : "";
  if (key === " ") return "Space";
  if (
    key === "Enter" ||
    key === "Tab" ||
    key === "Escape" ||
    key === "Backspace" ||
    key === "Delete" ||
    key === "ArrowUp" ||
    key === "ArrowDown" ||
    key === "ArrowLeft" ||
    key === "ArrowRight" ||
    key === "Home" ||
    key === "End" ||
    key === "PageUp" ||
    key === "PageDown"
  ) {
    return key;
  }
  if (key === "Shift" || key === "Control" || key === "Alt" || key === "Meta") {
    return key;
  }
  if (code.startsWith("Key") || code.startsWith("Digit")) {
    return code;
  }
  if (key.length === 1) {
    return key;
  }
  return code || key || null;
}

async function dispatchKeyboardInput(page, payload) {
  const text = typeof payload.text === "string" ? payload.text : "";
  const modifierTokens = [];
  if (payload.altKey) modifierTokens.push("Alt");
  if (payload.ctrlKey) modifierTokens.push("Control");
  if (payload.metaKey) modifierTokens.push("Meta");
  if (payload.shiftKey && text.length !== 1) modifierTokens.push("Shift");
  const hasModifiers = modifierTokens.length > 0;
  if (text && !hasModifiers) {
    await page.keyboard.insertText(text);
    return;
  }
  const token = normalizeKeyboardToken(payload);
  if (token) {
    for (const modifier of modifierTokens) {
      await page.keyboard.down(modifier);
    }
    try {
      await page.keyboard.press(token);
    } finally {
      for (const modifier of modifierTokens.slice().reverse()) {
        await page.keyboard.up(modifier).catch(() => {});
      }
    }
  }
}

async function handleLiveClientMessage(session, payload) {
  if (!payload || typeof payload !== "object") {
    return;
  }
  const page = await ensurePage(session);
  switch (payload.type) {
    case "resize": {
      session.viewport = normalizeViewport(payload.width, payload.height);
      await page.setViewportSize(session.viewport);
      await resetSessionStream(session);
      await ensureSessionScreencast(session);
      await sendSessionState(session);
      return;
    }
    case "mouse_move": {
      await page.mouse.move(Number(payload.x) || 0, Number(payload.y) || 0);
      return;
    }
    case "mouse_down": {
      await page.mouse.move(Number(payload.x) || 0, Number(payload.y) || 0);
      await page.mouse.down({ button: normalizeMouseButton(payload.button) });
      return;
    }
    case "mouse_up": {
      await page.mouse.move(Number(payload.x) || 0, Number(payload.y) || 0);
      await page.mouse.up({ button: normalizeMouseButton(payload.button) });
      scheduleSessionStateSync(session, { delayMs: 180 });
      return;
    }
    case "wheel": {
      await page.mouse.move(Number(payload.x) || 0, Number(payload.y) || 0);
      await page.mouse.wheel(Number(payload.deltaX) || 0, Number(payload.deltaY) || 0);
      return;
    }
    case "key": {
      await dispatchKeyboardInput(page, payload);
      scheduleSessionStateSync(session, { delayMs: 220 });
      return;
    }
    case "paste": {
      if (typeof payload.text === "string" && payload.text.length > 0) {
        await page.keyboard.insertText(payload.text);
        scheduleSessionStateSync(session, { delayMs: 120 });
      }
      return;
    }
    case "copy_request": {
      const text = await readSelectedText(page);
      broadcastSessionMessage(session, { type: "clipboard_copy", text });
      return;
    }
    case "focus": {
      await sendSessionState(session);
      return;
    }
    default:
      return;
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);
    const parts = url.pathname.split("/").filter(Boolean);
    const proxiedPort = proxyPortFromHostHeader(req.headers.host);

    if (proxiedPort !== null) {
      proxyLocalAppRequest(req, res, proxiedPort);
      return;
    }

    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { ok: true, sessions: sessions.size });
      return;
    }

    if (req.method === "GET" && parts.length >= 1 && parts[0] === "__workspace__") {
      serveWorkspaceAsset(res, parts.slice(1));
      return;
    }

    if (!isAuthorizedBrowserControlRequest(req, url)) {
      sendBrowserControlUnauthorized(res);
      return;
    }

    if (req.method === "POST" && parts.length === 1 && parts[0] === "sessions") {
      const body = await parseBody(req);
      const snapshot = await createSession(body.url || "", {
        width: body.viewport_width,
        height: body.viewport_height,
      });
      sendJson(res, 200, snapshot);
      return;
    }

    if (parts.length === 2 && parts[0] === "sessions" && req.method === "GET") {
      const snapshot = await buildSnapshot(getSession(parts[1]));
      sendJson(res, 200, snapshot);
      return;
    }

    if (parts.length === 2 && parts[0] === "sessions" && req.method === "DELETE") {
      await closeSession(parts[1]);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (parts.length === 3 && parts[0] === "sessions" && req.method === "POST") {
      const session = getSession(parts[1]);
      const action = parts[2];
      if (action === "navigate") {
        const body = await parseBody(req);
        const snapshot = await navigateSession(session, body.url);
        sendJson(res, 200, snapshot);
        return;
      }
      if (action === "reload") {
        const page = await ensurePage(session);
        await page.reload({ waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT_MS });
        await waitForPageStable(page, DEFAULT_TIMEOUT_MS);
        recordSessionHistory(session, page.url());
        await sendSessionState(session);
        sendJson(res, 200, await buildActionSnapshot(session));
        return;
      }
      if (action === "back") {
        if (session.historyIndex <= 0) {
          await sendSessionState(session);
          sendJson(res, 200, await buildActionSnapshot(session));
          return;
        }
        session.historyIndex -= 1;
        const snapshot = await navigateSession(session, session.history[session.historyIndex], {
          recordHistory: false,
        });
        sendJson(res, 200, snapshot);
        return;
      }
      if (action === "forward") {
        if (session.historyIndex >= session.history.length - 1) {
          await sendSessionState(session);
          sendJson(res, 200, await buildActionSnapshot(session));
          return;
        }
        session.historyIndex += 1;
        const snapshot = await navigateSession(session, session.history[session.historyIndex], {
          recordHistory: false,
        });
        sendJson(res, 200, snapshot);
        return;
      }
      if (action === "click") {
        const body = await parseBody(req);
        const x = Number(body.x);
        const y = Number(body.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          sendJson(res, 400, { error: "Click coordinates are required" });
          return;
        }
        const snapshot = await clickSession(session, x, y);
        sendJson(res, 200, snapshot);
        return;
      }
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    console.error("[EntropicBrowserService] request failed", error);
    sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

const liveWss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

liveWss.on("connection", async (socket, _req, session) => {
  session.liveClients.add(socket);
  socket.on("message", async (raw) => {
    try {
      const payload = JSON.parse(String(raw));
      await handleLiveClientMessage(session, payload);
    } catch (error) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
          type: "error",
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    }
  });
  socket.on("close", () => {
    session.liveClients.delete(socket);
    if (session.liveClients.size === 0) {
      void stopSessionScreencast(session);
    }
  });

  try {
    await ensureSessionScreencast(session);
    await sendSessionState(session, socket);
    sendSessionLastFrame(session, socket);
  } catch (error) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
        type: "error",
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }
});

server.on("upgrade", (req, socket, head) => {
  try {
    const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);
    const proxiedPort = proxyPortFromHostHeader(req.headers.host);
    if (proxiedPort !== null) {
      proxyLocalAppUpgrade(req, socket, head, proxiedPort);
      return;
    }
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length === 2 && parts[0] === "live") {
      if (!isAuthorizedBrowserControlRequest(req, url)) {
        socket.destroy();
        return;
      }
      const session = getSession(parts[1]);
      liveWss.handleUpgrade(req, socket, head, (ws) => {
        liveWss.emit("connection", ws, req, session);
      });
      return;
    }
  } catch (error) {
    console.error("[EntropicBrowserService] upgrade failed", error);
  }
  socket.destroy();
});

server.listen(PORT, LISTEN_HOST, () => {
  console.log(`[EntropicBrowserService] listening on ${LISTEN_HOST}:${PORT} (host ws port ${HOST_PORT})`);
});
