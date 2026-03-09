#!/usr/bin/env node

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { chromium } from "patchright";

const PORT = Number(process.env.ENTROPIC_BROWSER_SERVICE_PORT || 19791);
const PROFILE_ROOT = process.env.ENTROPIC_BROWSER_PROFILE || "/data/browser/profile";
const DEFAULT_TIMEOUT_MS = Number(process.env.ENTROPIC_BROWSER_TIMEOUT_MS || 30000);
const MAX_INTERACTIVE_ELEMENTS = 75;

const sessions = new Map();

function parseUrlOrNull(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function secureContextOverrideOrigin(targetUrl) {
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

function buildLaunchArgs(secureOrigins = []) {
  const args = ["--no-sandbox", "--disable-dev-shm-usage"];
  if (secureOrigins.length > 0) {
    args.push(`--unsafely-treat-insecure-origin-as-secure=${secureOrigins.join(",")}`);
  }
  return args;
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
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

async function ensurePage(session) {
  if (!session.page || session.page.isClosed()) {
    session.page = session.context.pages()[0] || await session.context.newPage();
  }
  return session.page;
}

async function waitForPageStable(page, timeoutMs) {
  await page.waitForLoadState("domcontentloaded", { timeout: timeoutMs });
  await page.waitForLoadState("networkidle", { timeout: timeoutMs }).catch(() => {});
}

async function buildSnapshot(session) {
  const page = await ensurePage(session);
  const screenshot = await page.screenshot({ type: "png", fullPage: true });
  const title = await page.title().catch(() => "");
  const pageData = await page.evaluate((maxElements) => {
    const remove = document.querySelectorAll(
      "script, style, nav, footer, aside, [role='banner'], [role='navigation'], .ad, .ads, .advertisement"
    );
    remove.forEach((el) => el.remove());
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
        x: rect.left + window.scrollX,
        y: rect.top + window.scrollY,
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
      pageWidth: Math.max(
        document.documentElement?.scrollWidth || 0,
        document.body?.scrollWidth || 0,
        window.innerWidth || 0
      ),
      pageHeight: Math.max(
        document.documentElement?.scrollHeight || 0,
        document.body?.scrollHeight || 0,
        window.innerHeight || 0
      ),
      interactiveElements: elements,
    };
  }, MAX_INTERACTIVE_ELEMENTS);

  return {
    session_id: session.id,
    url: page.url(),
    title,
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

async function navigateSession(session, targetUrl, options = {}) {
  const requiredSecureOrigin = secureContextOverrideOrigin(targetUrl);
  if (requiredSecureOrigin && !session.secureOrigins.includes(requiredSecureOrigin)) {
    session.secureOrigins.push(requiredSecureOrigin);
    await relaunchSessionContext(session);
  }

  const page = await ensurePage(session);
  await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT_MS });
  await waitForPageStable(page, DEFAULT_TIMEOUT_MS);

  const recordHistory = options.recordHistory !== false;
  if (recordHistory) {
    const base = session.history.slice(0, session.historyIndex + 1);
    if (base[base.length - 1] !== page.url()) {
      base.push(page.url());
    }
    session.history = base;
    session.historyIndex = Math.max(0, session.history.length - 1);
  }

  return buildSnapshot(session);
}

async function launchBrowserContext(userDataDir, secureOrigins = []) {
  return chromium.launchPersistentContext(userDataDir, {
    headless: true,
    args: buildLaunchArgs(secureOrigins),
    viewport: { width: 1440, height: 900 },
    locale: "en-US",
    timezoneId: "America/Chicago",
  });
}

async function relaunchSessionContext(session) {
  if (session.context) {
    await session.context.close();
  }
  session.context = await launchBrowserContext(session.userDataDir, session.secureOrigins);
  session.page = session.context.pages()[0] || await session.context.newPage();
}

async function createSession(initialUrl) {
  const id = randomUUID();
  const userDataDir = path.join(PROFILE_ROOT, id);
  fs.mkdirSync(userDataDir, { recursive: true });
  const secureOrigins = [];
  const initialSecureOrigin = initialUrl ? secureContextOverrideOrigin(initialUrl) : null;
  if (initialSecureOrigin) {
    secureOrigins.push(initialSecureOrigin);
  }

  const context = await launchBrowserContext(userDataDir, secureOrigins);

  const session = {
    id,
    userDataDir,
    context,
    page: context.pages()[0] || (await context.newPage()),
    secureOrigins,
    history: [],
    historyIndex: -1,
  };
  sessions.set(id, session);

  if (initialUrl) {
    return navigateSession(session, initialUrl);
  }
  return buildSnapshot(session);
}

async function closeSession(id) {
  const session = getSession(id);
  sessions.delete(id);
  await session.context.close();
}

async function clickSession(session, x, y) {
  const page = await ensurePage(session);
  await page.mouse.click(x, y);
  await waitForPageStable(page, DEFAULT_TIMEOUT_MS);
  const currentUrl = page.url();
  const base = session.history.slice(0, session.historyIndex + 1);
  if (base[base.length - 1] !== currentUrl) {
    base.push(currentUrl);
    session.history = base;
    session.historyIndex = Math.max(0, session.history.length - 1);
  }
  return buildSnapshot(session);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);
    const parts = url.pathname.split("/").filter(Boolean);

    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { ok: true, sessions: sessions.size });
      return;
    }

    if (req.method === "POST" && parts.length === 1 && parts[0] === "sessions") {
      const body = await parseBody(req);
      const snapshot = await createSession(body.url || "");
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
        sendJson(res, 200, await buildSnapshot(session));
        return;
      }
      if (action === "back") {
        if (session.historyIndex <= 0) {
          sendJson(res, 200, await buildSnapshot(session));
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
          sendJson(res, 200, await buildSnapshot(session));
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
    sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[EntropicBrowserService] listening on 127.0.0.1:${PORT}`);
});
