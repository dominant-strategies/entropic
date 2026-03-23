/**
 * Pure functions for parsing, sanitizing, and normalizing chat messages.
 * Extracted from Chat.tsx to reduce file size and improve testability.
 */

import type { GatewayMessage } from "./gateway";

// ── Types ──────────────────────────────────────────────────────

export type MessageAttachment = {
  fileName: string;
  mimeType: string;
  previewUrl: string;
};

export type CalendarEvent = {
  id?: string;
  summary?: string;
  start?: string;
  end?: string;
  attendees?: Array<{ email?: string; displayName?: string }>;
};

export type ToolError = { tool?: string; error?: string; status?: string };

export type TerminalCommandResult = {
  command: string;
  cwd: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
};

export type AssistantPayload = {
  events: CalendarEvent[];
  errors: ToolError[];
  hadToolPayload: boolean;
};

export type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  kind?: "toolResult";
  toolName?: string;
  sentAt?: number | null;
  attachments?: MessageAttachment[];
  terminalResult?: TerminalCommandResult;
  assistantPayload?: AssistantPayload;
};

export type ChatSession = {
  key: string;
  label?: string;
  displayName?: string;
  derivedTitle?: string;
  updatedAt?: number | null;
  pinned?: boolean;
};

// ── Constants ──────────────────────────────────────────────────

export const UI_SESSION_KEY_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const CHANNEL_SESSION_KEY_MARKERS = [
  "telegram",
  "slack",
  "discord",
  "whatsapp",
  "signal",
  "matrix",
  "googlechat",
  "google_chat",
];

export const INTERNAL_USER_PROMPT_PREFIX = "[[ENTROPIC_INTERNAL_PROMPT]]";

export const BILLING_RECOVERY_MESSAGE =
  "You're out of credits. Add credits to continue using Entropic in proxy mode.";

// ── Slash-command parsing ──────────────────────────────────────

export function parseRunSlashCommand(raw: string): string | null {
  const match = raw.match(/^\/run(?:\s+|\n)([\s\S]+)$/i);
  if (!match) {
    return raw.trim().toLowerCase() === "/run" ? "" : null;
  }
  return match[1].trimEnd();
}

// ── JSON block extraction ──────────────────────────────────────

export function extractJsonBlocks(text: string): Array<{ jsonText: string; start: number; end: number }> {
  const blocks: Array<{ jsonText: string; start: number; end: number }> = [];
  const codeFence = /```json\\s*([\\s\\S]*?)```/gi;
  let match: RegExpExecArray | null = null;
  const fencedRanges: Array<{ start: number; end: number }> = [];
  while ((match = codeFence.exec(text))) {
    const start = match.index;
    const end = match.index + match[0].length;
    blocks.push({ jsonText: match[1].trim(), start, end });
    fencedRanges.push({ start, end });
  }

  const inFence = (pos: number) => fencedRanges.some(range => pos >= range.start && pos < range.end);
  let i = 0;
  while (i < text.length) {
    if (inFence(i)) {
      i += 1;
      continue;
    }
    if (text[i] !== "{") {
      i += 1;
      continue;
    }
    let depth = 0;
    let inString = false;
    let escape = false;
    const start = i;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (inString) {
        if (escape) {
          escape = false;
        } else if (ch === "\\\\") {
          escape = true;
        } else if (ch === "\"") {
          inString = false;
        }
        continue;
      }
      if (ch === "\"") {
        inString = true;
        continue;
      }
      if (ch === "{") depth += 1;
      if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          blocks.push({ jsonText: text.slice(start, j + 1), start, end: j + 1 });
          i = j;
          break;
        }
      }
    }
    i += 1;
  }

  return blocks.sort((a, b) => a.start - b.start);
}

// ── Tool transport detection ───────────────────────────────────

export function isToolTransportPayload(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);

  const hasWebFetchShape =
    ("url" in obj || "finalUrl" in obj) &&
    "status" in obj &&
    ("contentType" in obj || "extractMode" in obj || "extractor" in obj);
  const hasWebSearchShape =
    "query" in obj &&
    "provider" in obj &&
    ("content" in obj || "citations" in obj || "model" in obj);
  const hasToolErrorShape = "error" in obj && ("message" in obj || "docs" in obj) && keys.length <= 8;
  const wrappedExternalInText =
    typeof obj.text === "string" &&
    (obj.text.includes("SECURITY NOTICE:") || obj.text.includes("<<<EXTERNAL_UNTRUSTED_CONTENT>>>"));
  const wrappedExternalInContent =
    typeof obj.content === "string" &&
    (obj.content.includes("SECURITY NOTICE:") || obj.content.includes("<<<EXTERNAL_UNTRUSTED_CONTENT>>>"));

  return (
    hasWebFetchShape ||
    hasWebSearchShape ||
    hasToolErrorShape ||
    wrappedExternalInText ||
    wrappedExternalInContent
  );
}

// ── Content sanitization ───────────────────────────────────────

export function stripExternalUntrustedSections(raw: string): string {
  if (!raw) return "";
  let text = raw;
  text = text.replace(
    /SECURITY NOTICE:[\s\S]*?<<<EXTERNAL_UNTRUSTED_CONTENT>>>[\s\S]*?<<<END_EXTERNAL_UNTRUSTED_CONTENT>>>/gi,
    ""
  );
  text = text.replace(/<<<EXTERNAL_UNTRUSTED_CONTENT>>>[\s\S]*?<<<END_EXTERNAL_UNTRUSTED_CONTENT>>>/gi, "");
  return text.trim();
}

export function sanitizeAuthStoreDetails(raw: string): string {
  if (!raw) return "";
  return raw
    .replace(/Auth store:\s*[^\n]+/g, "Auth store: [hidden]")
    .replace(/\(agentDir:\s*[^)]+\)/g, "(agentDir: [hidden])");
}

// ── Error detection & formatting ───────────────────────────────

export function isBillingIssueMessage(raw?: string | null): boolean {
  if (!raw) return false;
  const message = raw.toLowerCase();
  return (
    message.includes("insufficient credits") ||
    message.includes("out of credits") ||
    message.includes("out of free credits") ||
    message.includes("trial credits") ||
    message.includes("add more credits") ||
    message.includes("payment required") ||
    message.includes("billing issue")
  );
}

export function isPolicyMessageRemovedError(raw?: string | null): boolean {
  if (!raw) return false;
  const text = raw.toLowerCase();
  return (
    text.includes("all messages were removed by policy") ||
    text.includes("messages were removed by policy")
  );
}

export function isContainerRestartingError(raw?: string | null): boolean {
  if (!raw) return false;
  const text = raw.toLowerCase();
  return (
    (text.includes("container") && (text.includes("restarting") || text.includes("restart"))) ||
    (text.includes("is restarting") && text.includes("wait"))
  );
}

export function sanitizeGatewayErrorMessage(raw?: string | null): string {
  const message = (raw || "").trim();
  if (!message) return "Chat error";

  if (/session file path must be within sessions directory/i.test(message)) {
    return "The conversation history path was invalid. Restart the sandbox and retry.";
  }

  const providerMatches = [...message.matchAll(/No API key found for provider "([^"]+)"/g)];
  const providers = [...new Set(providerMatches.map((m) => m[1]).filter(Boolean))];
  if (providers.length > 0) {
    return `Missing API key for ${providers.join(", ")}. Add provider keys in Settings, or switch back to Managed Provider mode.`;
  }

  return sanitizeAuthStoreDetails(message);
}

export function formatAssistantErrorTextForUi(raw?: string | null): string {
  const message = sanitizeGatewayErrorMessage(raw || "");
  if (isBillingIssueMessage(message)) {
    return `${BILLING_RECOVERY_MESSAGE} Open Billing to add funds.`;
  }
  if (isPolicyMessageRemovedError(raw)) {
    return "The conversation context was cleared by the provider. Starting fresh — please resend your message.";
  }
  if (isContainerRestartingError(raw)) {
    return "The AI model is reloading. Please wait a moment and try again.";
  }
  if (/^connection error\.?$/i.test(message)) {
    return "The AI provider connection failed. Check your network, auth, and billing setup, then retry.";
  }
  if (/failed to authenticate request with clerk/i.test(message)) {
    return "Entropic backend authentication failed. Sign out and sign back in, then retry.";
  }
  return message;
}

export function extractAssistantErrorFromGatewayMessage(message: GatewayMessage): string | null {
  const stopReason = typeof message?.stopReason === "string" ? message.stopReason.toLowerCase() : "";
  const errorMessage =
    typeof message?.errorMessage === "string" ? message.errorMessage.trim() : "";
  if (stopReason !== "error" && !errorMessage) return null;
  return formatAssistantErrorTextForUi(errorMessage || "LLM request failed with an unknown error.");
}

// ── Tool payload parsing ───────────────────────────────────────

export function parseToolPayloads(raw: string): {
  cleanText: string;
  events: CalendarEvent[];
  errors: ToolError[];
  hadToolPayload: boolean;
} {
  try {
    const direct = JSON.parse(raw);
    if (typeof direct === "string") {
      return parseToolPayloads(direct);
    }
    if (isToolTransportPayload(direct)) {
      return { cleanText: "", events: [], errors: [], hadToolPayload: true };
    }
    if (direct && typeof direct === "object") {
      const events = Array.isArray((direct as any).events) ? (direct as any).events as CalendarEvent[] : [];
      const errors = (direct as any).tool || (direct as any).status === "error"
        ? [{ tool: (direct as any).tool, error: (direct as any).error, status: (direct as any).status }]
        : [];
      if (events.length || errors.length) {
        return { cleanText: "", events, errors, hadToolPayload: true };
      }
    }
  } catch {
    // ignore
  }

  const blocks = extractJsonBlocks(raw);
  if (blocks.length === 0) {
    return { cleanText: sanitizeAuthStoreDetails(raw), events: [], errors: [], hadToolPayload: false };
  }

  const events: CalendarEvent[] = [];
  const errors: ToolError[] = [];
  const removalRanges: Array<{ start: number; end: number }> = [];

  for (const block of blocks) {
    try {
      const parsed = JSON.parse(block.jsonText);
      if (isToolTransportPayload(parsed)) {
        removalRanges.push({ start: block.start, end: block.end });
        continue;
      }
      if (parsed && typeof parsed === "object") {
        if (Array.isArray((parsed as any).events)) {
          events.push(...(parsed as any).events);
          removalRanges.push({ start: block.start, end: block.end });
          continue;
        }
        if ((parsed as any).tool || (parsed as any).status === "error") {
          errors.push({
            tool: (parsed as any).tool,
            error: sanitizeGatewayErrorMessage((parsed as any).error),
            status: (parsed as any).status,
          });
          removalRanges.push({ start: block.start, end: block.end });
          continue;
        }
      }
    } catch {
      // ignore
    }
  }

  if (removalRanges.length === 0) {
    return { cleanText: sanitizeAuthStoreDetails(raw), events: [], errors: [], hadToolPayload: false };
  }

  let clean = "";
  let cursor = 0;
  for (const range of removalRanges) {
    if (range.start > cursor) {
      clean += raw.slice(cursor, range.start);
    }
    cursor = Math.max(cursor, range.end);
  }
  if (cursor < raw.length) {
    clean += raw.slice(cursor);
  }

  return { cleanText: sanitizeAuthStoreDetails(clean.trim()), events, errors, hadToolPayload: true };
}

// ── Metadata stripping ─────────────────────────────────────────

export function stripConversationMetadata(raw: string): string {
  if (!raw) return "";
  let text = raw;
  const prefix = /^\s*Conversation info\s*\(untrusted metadata\)\s*:/i;
  if (!prefix.test(text)) {
    return text;
  }

  text = text.replace(
    /^\s*Conversation info\s*\(untrusted metadata\)\s*:\s*```json[\s\S]*?```\s*/i,
    ""
  );
  text = text.replace(
    /^\s*Conversation info\s*\(untrusted metadata\)\s*:\s*\{[\s\S]*?\}\s*/i,
    ""
  );
  text = text.replace(/^\s*Conversation info\s*\(untrusted metadata\)\s*:\s*/i, "");
  return text.trimStart();
}

export function stripInlineClawdbotMetadata(raw: string): string {
  let result = "";
  let cursor = 0;

  while (cursor < raw.length) {
    const remaining = raw.slice(cursor);
    const match = /metadata\s*:/i.exec(remaining);
    if (!match) {
      result += remaining;
      break;
    }

    const matchStart = cursor + match.index;
    const labelEnd = matchStart + match[0].length;
    result += raw.slice(cursor, matchStart);

    let i = labelEnd;
    while (i < raw.length && /\s/.test(raw[i])) i += 1;
    if (raw[i] !== "{") {
      result += raw.slice(matchStart, labelEnd);
      cursor = labelEnd;
      continue;
    }

    const objectStart = i;
    let depth = 0;
    let inString = false;
    let escape = false;
    let objectEnd = -1;

    for (; i < raw.length; i += 1) {
      const ch = raw[i];
      if (inString) {
        if (escape) {
          escape = false;
        } else if (ch === "\\") {
          escape = true;
        } else if (ch === "\"") {
          inString = false;
        }
        continue;
      }
      if (ch === "\"") {
        inString = true;
        continue;
      }
      if (ch === "{") depth += 1;
      if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          objectEnd = i;
          break;
        }
      }
    }

    if (objectEnd < 0) {
      result += raw.slice(matchStart);
      break;
    }

    const objectText = raw.slice(objectStart, objectEnd + 1);
    if (/[\"']?clawdbot[\"']?\s*:/i.test(objectText)) {
      cursor = objectEnd + 1;
      while (cursor < raw.length && raw[cursor] === " ") cursor += 1;
      continue;
    }

    result += raw.slice(matchStart, objectEnd + 1);
    cursor = objectEnd + 1;
  }

  return result;
}

const OPENCLAW_STATUS_LINE_PATTERNS: RegExp[] = [
  /^\s*🦞\s*OpenClaw\b.*$/i,
  /^\s*🕒\s*Time:\s*.*$/i,
  /^\s*🧠\s*Model:\s*.*$/i,
  /^\s*📚\s*Context:\s*.*$/i,
  /^\s*🧹\s*Compactions:\s*.*$/i,
  /^\s*🧵\s*Session:\s*.*$/i,
  /^\s*⚙️?\s*Runtime:\s*.*$/i,
  /^\s*🪢\s*Queue:\s*.*$/i,
];

export function stripOpenClawStatusLines(raw: string): string {
  if (!raw) return "";
  return raw
    .split(/\r?\n/)
    .filter((line) => !OPENCLAW_STATUS_LINE_PATTERNS.some((pattern) => pattern.test(line.trim())))
    .join("\n");
}

// ── Content normalization pipeline ─────────────────────────────

export function sanitizeAssistantDisplayContent(raw: string): string {
  if (!raw) return "";
  let text = stripConversationMetadata(raw);
  text = stripExternalUntrustedSections(text);
  text = stripOpenClawStatusLines(text);

  try {
    const direct = JSON.parse(text);
    if (isToolTransportPayload(direct)) {
      return "";
    }
  } catch {
    // ignore non-JSON
  }

  try {
    const direct = JSON.parse(text);
    if (direct && typeof direct === "object" && !Array.isArray(direct)) {
      const error = (direct as Record<string, unknown>).error;
      if (typeof error === "string" && /No API key found for provider/i.test(error)) {
        return sanitizeGatewayErrorMessage(error);
      }
    }
  } catch {
    // ignore non-JSON
  }

  text = text.replace(
    /^\s*metadata:\s*\{[\s\S]*?"clawdbot"[\s\S]*?\}\s*$/gim,
    ""
  );
  text = text.replace(
    /^\s*metadata:\s*(?:\r?\n[ \t]+[^\n]*)+/gim,
    (block) => (/(?:^|\n)\s*clawdbot\s*:/i.test(block) ? "" : block)
  );
  text = stripInlineClawdbotMetadata(text);

  text = sanitizeAuthStoreDetails(text);
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

export function buildAssistantPayload(raw: string) {
  const cleaned = sanitizeAssistantDisplayContent(raw);
  const parsed = parseToolPayloads(cleaned);
  return {
    content: parsed.cleanText,
    assistantPayload: {
      events: parsed.events,
      errors: parsed.errors,
      hadToolPayload: parsed.hadToolPayload,
    },
  };
}

export function normalizeCachedMessage(message: Message): Message {
  if (message.role !== "assistant") return message;
  const prepared = buildAssistantPayload(message.content || "");
  if (!prepared.content && prepared.assistantPayload.events.length === 0 && prepared.assistantPayload.errors.length === 0) {
    return { ...message, content: "", assistantPayload: prepared.assistantPayload };
  }
  return {
    ...message,
    content: prepared.content,
    assistantPayload: prepared.assistantPayload,
  };
}

// ── Timestamp utilities ────────────────────────────────────────

export function parseUtcBracketTimestamp(raw: string): { text: string; sentAt: number | null } {
  if (!raw) return { text: "", sentAt: null };
  const match = raw.match(/^\s*\[[A-Za-z]{3}\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}(?::\d{2})?)\s+UTC\]\s*/);
  if (!match) return { text: raw, sentAt: null };
  const iso = `${match[1]}T${match[2]}Z`;
  const parsed = Date.parse(iso);
  return {
    text: raw.slice(match[0].length),
    sentAt: Number.isNaN(parsed) ? null : parsed,
  };
}

export function toTimestampMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value < 1_000_000_000_000 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === "string") {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) {
      return numeric < 1_000_000_000_000 ? Math.round(numeric * 1000) : Math.round(numeric);
    }
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
}

export function extractMessageTimestamp(message: GatewayMessage): number | null {
  const candidates = [
    message.createdAt,
    message.created_at,
    message.timestamp,
    message.sentAt,
    message.sent_at,
    message.time,
    message.ts,
  ];
  for (const candidate of candidates) {
    const timestamp = toTimestampMs(candidate);
    if (timestamp) return timestamp;
  }
  return null;
}

// ── User content normalization ─────────────────────────────────

export function normalizeUserContent(content: string, fallbackTimestamp?: number | null): { content: string; sentAt: number | null } {
  const withoutMeta = stripConversationMetadata(content).trim();
  if (withoutMeta.startsWith(INTERNAL_USER_PROMPT_PREFIX)) {
    return {
      content: "",
      sentAt: fallbackTimestamp ?? null,
    };
  }
  const parsedPrefix = parseUtcBracketTimestamp(withoutMeta);
  return {
    content: parsedPrefix.text.trim(),
    sentAt: fallbackTimestamp ?? parsedPrefix.sentAt ?? null,
  };
}

// ── Session title utilities ────────────────────────────────────

export function summarizeSessionTitleFromMessages(messages: Message[]): string | null {
  for (const message of messages) {
    if (message.role !== "user") continue;
    const normalized = normalizeUserContent(message.content || "", message.sentAt);
    const text = normalized.content.replace(/\s+/g, " ").trim();
    if (!text) continue;
    const maxLen = 72;
    return text.length > maxLen ? `${text.slice(0, maxLen - 1).trimEnd()}…` : text;
  }
  return null;
}

export function isGenericConversationTitle(value: string | null | undefined): boolean {
  const title = (value || "").trim();
  if (!title) return true;
  const lowered = title.toLocaleLowerCase();
  if (lowered === "entropic desktop") return true;
  if (lowered === "new chat" || lowered === "conversation" || lowered === "chat") return true;
  if (/^chat\s+[a-f0-9]{8,}$/i.test(title)) return true;
  return false;
}

export function titleDedupKey(value: string): string {
  return value.trim().replace(/\s+\(\d+\)\s*$/u, "").toLocaleLowerCase();
}

export function sessionTitleHint(session: ChatSession): string | null {
  const candidate =
    session.label?.trim() ||
    session.derivedTitle?.trim() ||
    session.displayName?.trim() ||
    "";
  if (!candidate || isGenericConversationTitle(candidate)) return null;
  return candidate;
}

// ── Display formatting ─────────────────────────────────────────

export function formatMessageTime(sentAt?: number | null): string {
  if (!sentAt) return "";
  const date = new Date(sentAt);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export function formatEventRange(start?: string, end?: string): { date?: string; time?: string } {
  if (!start) return {};
  const startDate = new Date(start);
  if (Number.isNaN(startDate.getTime())) return { date: start, time: end };
  const dateFmt = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
  const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
  const date = dateFmt.format(startDate);
  let time = timeFmt.format(startDate);
  if (end) {
    const endDate = new Date(end);
    if (!Number.isNaN(endDate.getTime())) {
      time = `${time} - ${timeFmt.format(endDate)}`;
    }
  }
  return { date, time };
}

// ── Message text extraction ────────────────────────────────────

export function extractMessageText(message: GatewayMessage): { text: string; hasText: boolean; hasNonText: boolean } {
  if (!message) return { text: "", hasText: false, hasNonText: false };
  if (typeof message.content === "string") {
    const trimmed = message.content.trim();
    return { text: message.content, hasText: trimmed.length > 0, hasNonText: false };
  }
  if (typeof message.text === "string") {
    const trimmed = message.text.trim();
    return { text: message.text, hasText: trimmed.length > 0, hasNonText: false };
  }
  if (Array.isArray(message.content)) {
    const parts: string[] = [];
    let hasNonText = false;
    for (const block of message.content) {
      if (!block || typeof block !== "object") continue;
      const entry = block as { type?: unknown; text?: unknown };
      if (typeof entry.text === "string") {
        parts.push(entry.text);
      } else if (typeof entry.type === "string") {
        hasNonText = true;
      }
    }
    const text = parts.join("");
    return { text, hasText: text.trim().length > 0, hasNonText };
  }
  return { text: "", hasText: false, hasNonText: false };
}

// ── Session filtering ──────────────────────────────────────────

export function isChannelOrSystemSessionKey(rawKey: string | null | undefined): boolean {
  const key = (rawKey || "").trim().toLowerCase();
  if (!key) return true;
  if (key === "agent:main:main") return true;
  if (key.startsWith("agent:main:")) return false;
  if (key.startsWith("agent:") || key.startsWith("cron:") || key.startsWith("system:")) {
    return true;
  }
  return CHANNEL_SESSION_KEY_MARKERS.some(
    (marker) => key.startsWith(`${marker}:`) || key.includes(`:${marker}:`),
  );
}

export function shouldDisplayGatewaySession(rawKey: string | null | undefined): boolean {
  const key = (rawKey || "").trim();
  if (!key) return false;
  if (UI_SESSION_KEY_RE.test(key)) return true;
  return !isChannelOrSystemSessionKey(key);
}

export function isChannelOriginGatewayMessage(message: GatewayMessage): boolean {
  const channelKeys = ["channel", "provider", "surface", "originatingChannel"] as const;
  for (const key of channelKeys) {
    const raw = message?.[key];
    if (typeof raw !== "string") continue;
    const normalized = raw.trim().toLowerCase();
    if (!normalized) continue;
    if (CHANNEL_SESSION_KEY_MARKERS.includes(normalized)) {
      return true;
    }
  }
  const sessionKey =
    typeof message?.sessionKey === "string"
      ? message.sessionKey
      : typeof message?.session_id === "string"
        ? message.session_id
        : "";
  if (!sessionKey) return false;
  return isChannelOrSystemSessionKey(sessionKey);
}

// ── Gateway message normalization ──────────────────────────────

function normalizeGatewayMarker(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function normalizeGatewayMessage(message: GatewayMessage, id: string): Message | null {
  if (isChannelOriginGatewayMessage(message)) {
    return null;
  }
  const roleRaw = typeof message?.role === "string" ? message.role.toLowerCase() : "assistant";
  const providerTag = normalizeGatewayMarker(message?.provider);
  const modelTag = normalizeGatewayMarker(message?.model);
  if (providerTag === "openclaw" || modelTag === "gateway-injected") {
    return null;
  }
  const { text, hasText, hasNonText } = extractMessageText(message);
  const messageTimestamp = extractMessageTimestamp(message);
  if (roleRaw === "user") {
    if (!hasText) return null;
    const normalized = normalizeUserContent(text, messageTimestamp);
    if (!normalized.content) return null;
    return { id, role: "user", content: normalized.content, sentAt: normalized.sentAt };
  }
  if (roleRaw === "assistant") {
    const assistantError = extractAssistantErrorFromGatewayMessage(message);
    if (!hasText && !hasNonText && !assistantError) return null;
    if (!hasText) {
      if (!assistantError) return null;
      return {
        id,
        role: "assistant",
        content: assistantError,
        sentAt: messageTimestamp ?? Date.now(),
      };
    }
    const prepared = buildAssistantPayload(text);
    const resolvedContent = prepared.content || assistantError || "";
    if (!resolvedContent && prepared.assistantPayload.events.length === 0 && prepared.assistantPayload.errors.length === 0) {
      return null;
    }
    return {
      id,
      role: "assistant",
      content: resolvedContent,
      assistantPayload: prepared.assistantPayload,
      sentAt: messageTimestamp,
    };
  }
  if (roleRaw === "toolresult" || roleRaw === "tool_result" || roleRaw === "tool") {
    return null;
  }
  return null;
}
