import { useState, useRef, useEffect, useCallback, type FormEvent } from "react";
import {
  Send,
  Sparkles,
  X,
  Loader2,
  ExternalLink,
  MessageSquare,
  Calendar,
  Globe,
  Mail,
  Activity,
  TrendingUp,
  FolderPlus,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { open } from "@tauri-apps/plugin-shell";
import { invoke } from "@tauri-apps/api/core";
import clsx from "clsx";
import { GatewayClient, createGatewayClient, type ChatEvent, type AgentEvent, type GatewayMessage } from "../lib/gateway";
import { loadOnboardingData, type OnboardingData } from "../lib/profile";
import { SuggestionChip, type SuggestionAction } from "../components/SuggestionChip";
import { ChannelSetupModal } from "../components/ChannelSetupModal";
import { MarkdownContent } from "../components/MarkdownContent";
import { ModelSelector } from "../components/ModelSelector";
import { useAuth } from "../contexts/AuthContext";
import { syncAllIntegrationsToGateway, getCachedIntegrationProviders, getIntegrations } from "../lib/integrations";
import { resolveGatewayAuth } from "../lib/gateway-auth";
import { Store as TauriStore } from "@tauri-apps/plugin-store";
import { getLocalCreditBalance } from "../lib/localCredits";
import { signInWithDiscord, signInWithEmail, signInWithGoogle, signUpWithEmail } from "../lib/auth";
import entropicLogo from "../assets/entropic-logo.png";
import type { Page } from "../components/Layout";

// NOTE: Most type definitions are omitted for brevity in this example
type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  kind?: "toolResult";
  toolName?: string;
  sentAt?: number | null;
  assistantPayload?: {
    events: CalendarEvent[];
    errors: ToolError[];
    hadToolPayload: boolean;
  };
};
export type ChatSession = {
  key: string;
  label?: string;
  displayName?: string;
  derivedTitle?: string;
  updatedAt?: number | null;
  pinned?: boolean;
};
export type ChatSessionActionRequest =
  | { id: string; type: "delete"; key: string }
  | { id: string; type: "pin"; key: string; pinned: boolean }
  | { id: string; type: "rename"; key: string; label: string };
type Provider = { id: string; name: string; icon: string; placeholder: string; keyUrl: string };
type PendingAttachment = { id: string; fileName: string; tempPath: string; savedPath?: string };
type AuthState = { active_provider: string | null; providers: Array<{ id: string; has_key: boolean }> };
type CalendarEvent = { id?: string; summary?: string; start?: string; end?: string; attendees?: Array<{ email?: string; displayName?: string }> };
type ToolError = { tool?: string; error?: string; status?: string };

function GoogleIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
    </svg>
  );
}

function DiscordIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/>
    </svg>
  );
}

// ── Local chat persistence ─────────────────────────────────────
const CHAT_STORE_FILE = "entropic-chat-history.json";
const MAX_PERSISTED_SESSIONS = 50;
const MAX_PERSISTED_MESSAGES = 200;

type PersistedChatData = {
  sessions: ChatSession[];
  messages: Record<string, Message[]>; // sessionKey -> messages
  drafts: Record<string, string>; // sessionKey -> unsent draft
  currentSession: string | null;
};

function normalizeSessionsList(list: ChatSession[]): ChatSession[] {
  const byKey = new Map<string, ChatSession>();
  for (const raw of list) {
    const key = typeof raw?.key === "string" ? raw.key.trim() : "";
    if (!key) continue;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, { ...raw, key });
      continue;
    }
    byKey.set(key, {
      ...prev,
      ...raw,
      key,
      pinned: (raw as ChatSession & { pinned?: boolean }).pinned ?? (prev as ChatSession & { pinned?: boolean }).pinned,
    });
  }
  return [...byKey.values()].sort((a, b) => {
    const aPinned = (a as ChatSession & { pinned?: boolean }).pinned ? 1 : 0;
    const bPinned = (b as ChatSession & { pinned?: boolean }).pinned ? 1 : 0;
    if (aPinned !== bPinned) return bPinned - aPinned;
    const aUpdated = typeof a.updatedAt === "number" ? a.updatedAt : 0;
    const bUpdated = typeof b.updatedAt === "number" ? b.updatedAt : 0;
    return bUpdated - aUpdated;
  });
}

function overlaySessionMetadata(next: ChatSession[], metadataSources: ChatSession[]): ChatSession[] {
  const metaByKey = new Map<string, ChatSession>();
  for (const item of metadataSources) {
    if (!item?.key) continue;
    metaByKey.set(item.key, item);
  }
  const merged = next.map((session) => {
    const meta = metaByKey.get(session.key) as (ChatSession & { pinned?: boolean }) | undefined;
    const current = session as ChatSession & { pinned?: boolean };
    return {
      ...session,
      pinned: current.pinned ?? meta?.pinned,
    };
  });
  return normalizeSessionsList(merged);
}

let _chatStore: TauriStore | null = null;
async function getChatStore(): Promise<TauriStore> {
  if (!_chatStore) {
    _chatStore = await TauriStore.load(CHAT_STORE_FILE);
  }
  return _chatStore;
}

async function persistChatData(data: PersistedChatData): Promise<void> {
  try {
    const store = await getChatStore();
    // Keep only recent sessions
    const trimmed: PersistedChatData = {
      sessions: data.sessions.slice(0, MAX_PERSISTED_SESSIONS),
      messages: {},
      drafts: {},
      currentSession: data.currentSession,
    };
    for (const s of trimmed.sessions) {
      const msgs = data.messages[s.key];
      if (msgs && msgs.length > 0) {
        trimmed.messages[s.key] = msgs.slice(-MAX_PERSISTED_MESSAGES);
      }
      const draft = data.drafts[s.key];
      if (typeof draft === "string" && draft.length > 0) {
        trimmed.drafts[s.key] = draft;
      }
    }
    if (trimmed.currentSession) {
      const currentDraft = data.drafts[trimmed.currentSession];
      if (typeof currentDraft === "string" && currentDraft.length > 0) {
        trimmed.drafts[trimmed.currentSession] = currentDraft;
      }
    }
    await store.set("chatData", trimmed);
    await store.save();
  } catch (err) {
    console.warn("[Entropic] Failed to persist chat data:", err);
  }
}

async function loadPersistedChatData(): Promise<PersistedChatData | null> {
  try {
    const store = await getChatStore();
    const data = await store.get("chatData") as PersistedChatData | null;
    return data;
  } catch (err) {
    console.warn("[Entropic] Failed to load persisted chat data:", err);
    return null;
  }
}

function extractJsonBlocks(text: string): Array<{ jsonText: string; start: number; end: number }> {
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

function isToolTransportPayload(value: unknown): boolean {
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

function stripExternalUntrustedSections(raw: string): string {
  if (!raw) return "";
  let text = raw;
  text = text.replace(
    /SECURITY NOTICE:[\s\S]*?<<<EXTERNAL_UNTRUSTED_CONTENT>>>[\s\S]*?<<<END_EXTERNAL_UNTRUSTED_CONTENT>>>/gi,
    ""
  );
  text = text.replace(/<<<EXTERNAL_UNTRUSTED_CONTENT>>>[\s\S]*?<<<END_EXTERNAL_UNTRUSTED_CONTENT>>>/gi, "");
  return text.trim();
}

function sanitizeAuthStoreDetails(raw: string): string {
  if (!raw) return "";
  return raw
    .replace(/Auth store:\s*[^\n]+/g, "Auth store: [hidden]")
    .replace(/\(agentDir:\s*[^)]+\)/g, "(agentDir: [hidden])");
}

const BILLING_RECOVERY_MESSAGE = "You're out of credits. Add credits to continue using Entropic in proxy mode.";

function isBillingIssueMessage(raw?: string | null): boolean {
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

function formatAssistantErrorTextForUi(raw?: string | null): string {
  const message = sanitizeGatewayErrorMessage(raw || "");
  if (isBillingIssueMessage(message)) {
    return `${BILLING_RECOVERY_MESSAGE} Open Billing to add funds.`;
  }
  if (/^connection error\.?$/i.test(message)) {
    return "The AI provider connection failed. Check your network, auth, and billing setup, then retry.";
  }
  if (/failed to authenticate request with clerk/i.test(message)) {
    return "Entropic backend authentication failed. Sign out and sign back in, then retry.";
  }
  return message;
}

function sanitizeGatewayErrorMessage(raw?: string | null): string {
  const message = (raw || "").trim();
  if (!message) return "Chat error";

  const providerMatches = [...message.matchAll(/No API key found for provider "([^"]+)"/g)];
  const providers = [...new Set(providerMatches.map((m) => m[1]).filter(Boolean))];
  if (providers.length > 0) {
    return `Missing API key for ${providers.join(", ")}. Add provider keys in Settings, or disable Use Local Keys.`;
  }

  return sanitizeAuthStoreDetails(message);
}

function extractAssistantErrorFromGatewayMessage(message: GatewayMessage): string | null {
  const stopReason = typeof message?.stopReason === "string" ? message.stopReason.toLowerCase() : "";
  const errorMessage =
    typeof message?.errorMessage === "string" ? message.errorMessage.trim() : "";
  if (stopReason !== "error" && !errorMessage) return null;
  return formatAssistantErrorTextForUi(errorMessage || "LLM request failed with an unknown error.");
}

function parseToolPayloads(raw: string): {
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

function stripConversationMetadata(raw: string): string {
  if (!raw) return "";
  let text = raw;
  const prefix = /^\s*Conversation info\s*\(untrusted metadata\)\s*:/i;
  if (!prefix.test(text)) {
    return text;
  }

  // Remove optional fenced JSON metadata block at the beginning.
  text = text.replace(
    /^\s*Conversation info\s*\(untrusted metadata\)\s*:\s*```json[\s\S]*?```\s*/i,
    ""
  );

  // Fallback for non-fenced leading JSON metadata.
  text = text.replace(
    /^\s*Conversation info\s*\(untrusted metadata\)\s*:\s*\{[\s\S]*?\}\s*/i,
    ""
  );

  // If only the header line is present, remove it.
  text = text.replace(/^\s*Conversation info\s*\(untrusted metadata\)\s*:\s*/i, "");

  return text.trimStart();
}

function stripInlineClawdbotMetadata(raw: string): string {
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

function sanitizeAssistantDisplayContent(raw: string): string {
  if (!raw) return "";
  let text = stripConversationMetadata(raw);
  text = stripExternalUntrustedSections(text);

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

  // Hide OpenClaw internal skill manifest metadata payloads (machine format).
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

function buildAssistantPayload(raw: string) {
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

function normalizeCachedMessage(message: Message): Message {
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

function parseUtcBracketTimestamp(raw: string): { text: string; sentAt: number | null } {
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

function toTimestampMs(value: unknown): number | null {
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

function extractMessageTimestamp(message: GatewayMessage): number | null {
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

function normalizeUserContent(content: string, fallbackTimestamp?: number | null): { content: string; sentAt: number | null } {
  const withoutMeta = stripConversationMetadata(content).trim();
  const parsedPrefix = parseUtcBracketTimestamp(withoutMeta);
  return {
    content: parsedPrefix.text.trim(),
    sentAt: fallbackTimestamp ?? parsedPrefix.sentAt ?? null,
  };
}

function summarizeSessionTitleFromMessages(messages: Message[]): string | null {
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

function isGenericConversationTitle(value: string | null | undefined): boolean {
  const title = (value || "").trim();
  if (!title) return true;
  const lowered = title.toLocaleLowerCase();
  if (lowered === "entropic desktop") return true;
  if (lowered === "new chat" || lowered === "conversation" || lowered === "chat") return true;
  if (/^chat\s+[a-f0-9]{8,}$/i.test(title)) return true;
  return false;
}

function titleDedupKey(value: string): string {
  return value.trim().replace(/\s+\(\d+\)\s*$/u, "").toLocaleLowerCase();
}

function sessionTitleHint(session: ChatSession): string | null {
  const candidate =
    session.label?.trim() ||
    session.derivedTitle?.trim() ||
    session.displayName?.trim() ||
    "";
  if (!candidate || isGenericConversationTitle(candidate)) return null;
  return candidate;
}

function formatMessageTime(sentAt?: number | null): string {
  if (!sentAt) return "";
  const date = new Date(sentAt);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatEventRange(start?: string, end?: string): { date?: string; time?: string } {
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

function extractMessageText(message: GatewayMessage): { text: string; hasText: boolean; hasNonText: boolean } {
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

function normalizeGatewayMessage(message: GatewayMessage, id: string): Message | null {
  const roleRaw = typeof message?.role === "string" ? message.role.toLowerCase() : "assistant";
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
    if (!hasText) return null;
    const prepared = buildAssistantPayload(text);
    if (!prepared.content && prepared.assistantPayload.events.length === 0 && prepared.assistantPayload.errors.length === 0) {
      return null;
    }
    return {
      id,
      role: "assistant",
      content: prepared.content,
      kind: "toolResult",
      toolName: typeof message.toolName === "string" ? message.toolName : undefined,
      assistantPayload: prepared.assistantPayload,
      sentAt: messageTimestamp,
    };
  }
  return null;
}

const PROVIDERS: Provider[] = [
  { id: "anthropic", name: "Anthropic", icon: "A", placeholder: "sk-ant-...", keyUrl: "https://console.anthropic.com/settings/keys" },
  { id: "openai", name: "OpenAI", icon: "O", placeholder: "sk-...", keyUrl: "https://platform.openai.com/api-keys" },
  { id: "google", name: "Google AI", icon: "G", placeholder: "AIza...", keyUrl: "https://aistudio.google.com/app/apikey" },
];

const DEFAULT_GATEWAY_URL = "ws://localhost:19789";
const HISTORY_LIMIT = 500;

function buildSuggestions(userName: string, hasName: boolean) {
  const folderLabel = hasName
    ? `Create a ${userName} Folder to save documents in Home`
    : "Create a Folder to save documents in Home";
  const folderMessage = hasName
    ? `Create a ${userName} folder in Home to save documents.`
    : "Create a folder in Home to save documents.";
  return [
    { icon: MessageSquare, label: "Message me on iMessage", action: { type: "channel", channel: "imessage" } as SuggestionAction },
    { icon: MessageSquare, label: "Message me on WhatsApp", action: { type: "channel", channel: "whatsapp" } as SuggestionAction },
    { icon: Mail, label: "Clean up my inbox", action: { type: "agent", message: "Help me clean up and organize my email inbox", requiresIntegration: "google_email" } as SuggestionAction },
    { icon: Calendar, label: "Check my calendar", action: { type: "agent", message: "What's on my calendar for today and tomorrow?", requiresIntegration: "google_calendar" } as SuggestionAction },
    { icon: TrendingUp, label: "Search Trending News on X", action: { type: "agent", message: "Search trending news on X and summarize what’s popular right now.", requiresIntegration: "x" } as SuggestionAction },
    { icon: Globe, label: "Browse the web for me", action: { type: "agent", message: "I'd like you to browse the web and research something for me." } as SuggestionAction },
    { icon: Activity, label: "Write a todo list for this week in Home", action: { type: "agent", message: "Write a todo list for this week and save it in Home." } as SuggestionAction },
    { icon: FolderPlus, label: folderLabel, action: { type: "agent", message: folderMessage } as SuggestionAction },
  ];
}

function normalizeModelId(id: string | null | undefined, proxyMode: boolean): string | null {
  if (!id) return null;
  if (!proxyMode) return id;
  if (id.startsWith("openrouter/")) return id;
  return `openrouter/${id}`;
}

function getRoutingDecision(messageContent: string) {
  const length = messageContent.length;
  const lineCount = messageContent.split("\n").length;
  const complexHints = [
    /step[-\s]?by[-\s]?step/i,
    /trade-?offs?/i,
    /compare|evaluate|analyze/i,
    /architecture|design|system/i,
    /prove|formal|theorem/i,
    /edge cases?|failure modes?/i,
    /multi[-\s]?step|plan|strategy/i,
  ];
  const useReasoning =
    length > 1200 ||
    lineCount > 10 ||
    complexHints.some((re) => re.test(messageContent));
  return {
    useReasoning,
    reason: useReasoning
      ? length > 1200
        ? "length"
        : lineCount > 10
          ? "lines"
          : "complexity"
      : "fast",
  };
}

export function Chat({
  gatewayRunning,
  gatewayStarting,
  gatewayRetryIn,
  onStartGateway,
  onRecoverProxyAuth,
  useLocalKeys,
  selectedModel,
  onModelChange,
  imageModel: _imageModel,
  integrationsSyncing,
  integrationsMissing,
  onNavigate,
  onSessionsChange,
  requestedSession,
  requestedSessionAction,
}: {
  gatewayRunning: boolean;
  gatewayStarting: boolean;
  gatewayRetryIn: number | null;
  onStartGateway?: () => void;
  onRecoverProxyAuth?: () => Promise<boolean> | boolean;
  useLocalKeys: boolean;
  selectedModel: string;
  onModelChange?: (model: string) => void;
  imageModel: string;
  integrationsSyncing?: boolean;
  integrationsMissing?: boolean;
  onNavigate?: (page: Page) => void;
  onSessionsChange?: (sessions: ChatSession[], currentKey: string | null) => void;
  requestedSession?: string | null;
  requestedSessionAction?: ChatSessionActionRequest | null;
}) {
  const { isAuthenticated, isAuthConfigured } = useAuth();
  const [localCreditsCents, setLocalCreditsCents] = useState<number | null>(null);
  const localTrialLoading =
    !isAuthenticated && isAuthConfigured && !useLocalKeys && localCreditsCents === null;
  const proxyEnabled =
    isAuthConfigured &&
    !useLocalKeys &&
    (isAuthenticated || (localCreditsCents ?? 0) > 0);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draftsBySession, setDraftsBySession] = useState<Record<string, string>>({});
  const [isLoading, setIsLoading] = useState(false);
  const [thinkingStatus, setThinkingStatus] = useState<string | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [currentSession, setCurrentSession] = useState<string | null>(null);
  const [showKeyModal, setShowKeyModal] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState<Provider | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [connectedProvider, setConnectedProvider] = useState<string | null>(null);
  const [oauthLoading, setOauthLoading] = useState<string | null>(null);
  const [anthropicCodePending, setAnthropicCodePending] = useState(false);
  const [anthropicCodeInput, setAnthropicCodeInput] = useState("");
  const [authLoading, setAuthLoading] = useState<"google" | "discord" | "email-signin" | "email-signup" | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authNotice, setAuthNotice] = useState<string | null>(null);
  const [showEmailAuth, setShowEmailAuth] = useState(false);
  const [emailAuthMode, setEmailAuthMode] = useState<"signin" | "signup">("signin");
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [showOwnProviderOptions, setShowOwnProviderOptions] = useState(false);
  const [providerStatus, setProviderStatus] = useState<AuthState["providers"]>([]);
  const connectedProviders = providerStatus.filter(p => p.has_key).map(p => p.id);
  const [gatewayUrl, setGatewayUrl] = useState(DEFAULT_GATEWAY_URL);
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [onboardingData, setOnboardingData] = useState<OnboardingData | null>(null);
  const [showWelcome, setShowWelcome] = useState(true);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [diagLogs, setDiagLogs] = useState<string[]>([]);
  const [lastGatewayError, setLastGatewayError] = useState<string | null>(null);
  const [lastChatEvent, setLastChatEvent] = useState<ChatEvent | null>(null);
  const [lastSendId, setLastSendId] = useState<string | null>(null);
  const [lastSendAt, setLastSendAt] = useState<number | null>(null);
  const [componentMountedAt] = useState(Date.now());
  const runTimingsRef = useRef<Record<string, {
    startedAt: number;
    ackAt?: number;
    firstDeltaAt?: number;
    finalAt?: number;
    toolSeenAt?: number;
  }>>({});
  const sessionModelRef = useRef<Record<string, string | null>>({});
  const runRevertModelRef = useRef<Record<string, string | null>>({});
  const [channelConfig, setChannelConfig] = useState<{ imessageEnabled: boolean; whatsappEnabled: boolean } | null>(null);
  const [channelModal, setChannelModal] = useState<{ isOpen: boolean; channel: "imessage" | "whatsapp" }>({
    isOpen: false,
    channel: "imessage",
  });

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const clientRef = useRef<GatewayClient | null>(null);
  const connectInFlightRef = useRef(false);
  const currentSessionRef = useRef<string | null>(null);
  const draftsRef = useRef<Record<string, string>>({});
  const handledRequestedSessionRef = useRef<string | null>(null);
  const handledRequestedActionRef = useRef<string | null>(null);
  const handlersRef = useRef<{
    connected?: () => void;
    disconnected?: () => void;
    chat?: (event: ChatEvent) => void;
    agent?: (event: AgentEvent) => void;
    error?: (error: string) => void;
  }>({});
  const lastEventByRunIdRef = useRef<Record<string, number>>({});
  const lastIntegrationsSyncRef = useRef<number>(0);
  const proxyAuthRecoveryInFlightRef = useRef(false);
  const lastProxyAuthRecoveryAtRef = useRef(0);
  // Local persistence: cache messages per session key
  const sessionMessagesRef = useRef<Record<string, Message[]>>({});
  const persistTimerRef = useRef<number | null>(null);
  const restoredFromCacheRef = useRef(false);
  const lastChatEventRef = useRef<ChatEvent | null>(null);
  const showDiagnosticsRef = useRef(false);
  const activeRunIdRef = useRef<string | null>(null);
  const activeRunSessionRef = useRef<string | null>(null);
  const activeRunTimeoutRef = useRef<number | null>(null);
  const runSessionKeyRef = useRef<Record<string, string>>({});
  const runHistoryRecoveryRef = useRef<Record<string, boolean>>({});
  const gatewaySessionKeysRef = useRef<Set<string>>(new Set());
  const visibleMessagesSessionRef = useRef<string | null>(null);

  function requestSignIn() {
    window.dispatchEvent(
      new CustomEvent("entropic-require-signin", {
        detail: { source: "chat-credits" },
      })
    );
  }

  async function refreshTrialCredits() {
    if (isAuthenticated || !isAuthConfigured || useLocalKeys) {
      return;
    }
    try {
      const balance = await getLocalCreditBalance();
      setLocalCreditsCents(balance.balance_cents);
    } catch (error) {
      console.warn("[Entropic] Failed to refresh trial credits:", error);
    }
  }

  async function handleEntropicOAuthSignIn(provider: "google" | "discord") {
    setAuthLoading(provider);
    setAuthError(null);
    setAuthNotice(null);
    try {
      if (provider === "google") {
        await signInWithGoogle();
      } else {
        await signInWithDiscord();
      }
      window.setTimeout(() => {
        if (sessionStorage.getItem("entropic_oauth_pending")) {
          setAuthError("Sign in is taking longer than expected. If your browser did not open, try again.");
          setAuthLoading(null);
        }
      }, 10000);
    } catch (error) {
      console.error("OAuth sign in failed:", error);
      setAuthError("Failed to start sign in. Please try again.");
      setAuthLoading(null);
    }
  }

  async function handleEntropicEmailAuthSubmit(event: FormEvent) {
    event.preventDefault();
    if (!authEmail.trim() || !authPassword.trim()) return;
    const mode = emailAuthMode;
    setAuthLoading(mode === "signup" ? "email-signup" : "email-signin");
    setAuthError(null);
    setAuthNotice(null);
    try {
      if (mode === "signup") {
        await signUpWithEmail(authEmail.trim(), authPassword);
        setAuthNotice("Check your email for a confirmation link, then sign in.");
        setEmailAuthMode("signin");
      } else {
        await signInWithEmail(authEmail.trim(), authPassword);
      }
    } catch (error: any) {
      const message =
        typeof error?.message === "string" && error.message.trim()
          ? error.message
          : "Authentication failed. Please try again.";
      setAuthError(message);
    } finally {
      setAuthLoading(null);
    }
  }

  const applySessionTitles = useCallback((list: ChatSession[]): ChatSession[] => {
    const normalized = normalizeSessionsList(list);
    const seen = new Map<string, number>();

    return normalized.map((session) => {
      if (session.label?.trim()) {
        return session;
      }

      const messageSummary = summarizeSessionTitleFromMessages(sessionMessagesRef.current[session.key] || []);
      const displayName = session.displayName?.trim() || "";
      const safeDisplayName = !isGenericConversationTitle(displayName) ? displayName : "";
      const baseTitle = messageSummary || safeDisplayName || `Chat ${session.key.slice(0, 8)}`;

      const key = titleDedupKey(baseTitle);
      const count = (seen.get(key) || 0) + 1;
      seen.set(key, count);
      const dedupedTitle = count === 1 ? baseTitle : `${baseTitle} (${count})`;

      return {
        ...session,
        derivedTitle: dedupedTitle,
      };
    });
  }, []);

  function isProxyAuthFailure(message?: string | null): boolean {
    if (!message) return false;
    const text = message.toLowerCase();
    if (text.includes("invalid gateway token")) return true;
    if (text.includes("gateway token validation failed")) return true;
    if (text.includes("ai provider error: 401")) return true;
    if (text.includes("no cookie auth credentials found")) return true;
    const has401 = text.includes("401") || text.includes("unauthorized");
    const looksProxy =
      text.includes("chat/completions") ||
      text.includes("ai provider") ||
      text.includes("cookie auth credentials");
    return has401 && looksProxy;
  }

  function triggerProxyAuthRecovery(source: string) {
    if (!proxyEnabled || !onRecoverProxyAuth) return;
    const now = Date.now();
    const recoveryCooldownMs = 30_000;
    const inCooldown = now - lastProxyAuthRecoveryAtRef.current < recoveryCooldownMs;
    if (proxyAuthRecoveryInFlightRef.current || inCooldown) {
      addDiag(`proxy auth recovery skipped (${source}; already in progress or cooldown)`);
      return;
    }

    proxyAuthRecoveryInFlightRef.current = true;
    lastProxyAuthRecoveryAtRef.current = now;
    setError("Proxy session expired. Reconnecting securely...");
    addDiag(`proxy auth failure detected from ${source}; refreshing gateway token`);

    Promise.resolve(onRecoverProxyAuth())
      .then((ok) => {
        if (ok) {
          setError("Proxy session refreshed. Please resend your last message.");
          addDiag("proxy auth recovery succeeded");
        } else {
          setError("Failed to refresh proxy session. Retry from Settings > Gateway.");
          addDiag("proxy auth recovery failed");
        }
      })
      .catch((err) => {
        setError("Failed to refresh proxy session. Retry from Settings > Gateway.");
        addDiag(`proxy auth recovery error: ${String(err)}`);
      })
      .finally(() => {
        proxyAuthRecoveryInFlightRef.current = false;
      });
  }

  useEffect(() => {
    showDiagnosticsRef.current = showDiagnostics;
    if (showDiagnostics && lastChatEventRef.current) {
      setLastChatEvent(lastChatEventRef.current);
    }
  }, [showDiagnostics]);

  useEffect(() => {
    invoke<{
      imessage_enabled: boolean;
      whatsapp_enabled: boolean;
    }>("get_agent_profile_state")
      .then((state) => {
        setChannelConfig({
          imessageEnabled: state.imessage_enabled ?? false,
          whatsappEnabled: state.whatsapp_enabled ?? false,
        });
      })
      .catch(() => {});
  }, []);

  // Restore sessions from local cache on mount
  useEffect(() => {
    if (restoredFromCacheRef.current) return;
    restoredFromCacheRef.current = true;
    loadPersistedChatData().then((cached) => {
      if (!cached) return;
      if (cached.sessions.length > 0) {
        sessionMessagesRef.current = cached.messages || {};
        for (const [sessionKey, msgs] of Object.entries(sessionMessagesRef.current)) {
          sessionMessagesRef.current[sessionKey] = msgs.map(normalizeCachedMessage);
        }
        setSessions(applySessionTitles(cached.sessions));
        setDraftsBySession(cached.drafts || {});
        const restoreKey = cached.currentSession || cached.sessions[0].key;
        currentSessionRef.current = restoreKey;
        setCurrentSession(restoreKey);
        const restoredMsgs = (cached.messages[restoreKey] || []).map(normalizeCachedMessage);
        visibleMessagesSessionRef.current = restoreKey;
        setMessages(restoredMsgs);
        if (restoredMsgs.length > 0) setShowWelcome(false);
      }
    });
  }, [applySessionTitles]);

  // Debounced persistence: save to Tauri Store when sessions/messages change
  const schedulePersist = useCallback(() => {
    if (persistTimerRef.current) window.clearTimeout(persistTimerRef.current);
    persistTimerRef.current = window.setTimeout(() => {
      persistTimerRef.current = null;
      // Snapshot current state
      const sessionsSnap = sessionsRef.current;
      const currentSnap = currentSessionRef.current;
      const messagesSnap = { ...sessionMessagesRef.current };
      const draftsSnap = { ...draftsRef.current };
      persistChatData({
        sessions: sessionsSnap,
        messages: messagesSnap,
        drafts: draftsSnap,
        currentSession: currentSnap,
      });
    }, 500);
  }, []);

  const migrateSessionKey = useCallback((fromKey: string, toKey: string) => {
    const from = fromKey.trim();
    const to = toKey.trim();
    if (!from || !to || from === to) return;

    const fromMessages = sessionMessagesRef.current[from] || [];
    const toMessages = sessionMessagesRef.current[to] || [];
    const mergedMessages = toMessages.length >= fromMessages.length ? toMessages : fromMessages;
    if (mergedMessages.length > 0) {
      sessionMessagesRef.current[to] = mergedMessages;
    }
    delete sessionMessagesRef.current[from];

    setDraftsBySession((prev) => {
      const fromDraft = prev[from];
      const toDraft = prev[to];
      if (typeof fromDraft !== "string" || fromDraft.length === 0) {
        return prev;
      }
      if (typeof toDraft === "string" && toDraft.length > 0) {
        const next = { ...prev };
        delete next[from];
        return next;
      }
      const next = { ...prev, [to]: fromDraft };
      delete next[from];
      return next;
    });

    if (currentSessionRef.current === from) {
      currentSessionRef.current = to;
      setCurrentSession(to);
      visibleMessagesSessionRef.current = to;
      setMessages(mergedMessages);
      setShowWelcome(mergedMessages.length === 0);
    }
    if (activeRunSessionRef.current === from) {
      activeRunSessionRef.current = to;
    }
    for (const [runId, sessionKey] of Object.entries(runSessionKeyRef.current)) {
      if (sessionKey === from) {
        runSessionKeyRef.current[runId] = to;
      }
    }

    setSessions((prev) => {
      const byKey = new Map<string, ChatSession>();
      for (const session of prev) {
        byKey.set(session.key, session);
      }
      const fromSession = byKey.get(from);
      const toSession = byKey.get(to);
      if (fromSession) {
        const mergedSession = toSession
          ? {
              ...fromSession,
              ...toSession,
              key: to,
              label: toSession.label ?? fromSession.label,
              pinned: toSession.pinned ?? fromSession.pinned,
              updatedAt: Math.max(fromSession.updatedAt ?? 0, toSession.updatedAt ?? 0) || null,
            }
          : { ...fromSession, key: to };
        byKey.set(to, mergedSession);
        byKey.delete(from);
      }
      return applySessionTitles(normalizeSessionsList([...byKey.values()]));
    });

    addDiag(`session remap ${from} -> ${to}`);
    schedulePersist();
  }, [applySessionTitles, schedulePersist]);

  // Keep a ref to sessions for persistence
  const sessionsRef = useRef<ChatSession[]>([]);
  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  // Keep session messages ref in sync with current messages state
  useEffect(() => {
    if (currentSession) {
      if (visibleMessagesSessionRef.current !== currentSession) {
        return;
      }
      sessionMessagesRef.current[currentSession] = messages;
    }
  }, [messages, currentSession]);

  useEffect(() => {
    draftsRef.current = draftsBySession;
  }, [draftsBySession]);

  // Persist on unmount (navigation away)
  useEffect(() => {
    return () => {
      if (persistTimerRef.current) window.clearTimeout(persistTimerRef.current);
      clearActiveRunTracking();
      const sessionsSnap = sessionsRef.current;
      const currentSnap = currentSessionRef.current;
      const messagesSnap = { ...sessionMessagesRef.current };
      const draftsSnap = { ...draftsRef.current };
      if (sessionsSnap.length > 0) {
        persistChatData({
          sessions: sessionsSnap,
          messages: messagesSnap,
          drafts: draftsSnap,
          currentSession: currentSnap,
        });
      }
    };
  }, []);

  function addDiag(message: string) {
    const stamp = new Date().toLocaleTimeString();
    setDiagLogs(prev => {
      const next = [...prev, `${stamp} ${message}`];
      return next.slice(-200);
    });
  }

  function clearActiveRunTracking() {
    activeRunIdRef.current = null;
    activeRunSessionRef.current = null;
    if (activeRunTimeoutRef.current) {
      window.clearTimeout(activeRunTimeoutRef.current);
      activeRunTimeoutRef.current = null;
    }
  }

  function scheduleActiveRunTimeout(runId: string, sessionKey: string) {
    clearActiveRunTracking();
    activeRunIdRef.current = runId;
    activeRunSessionRef.current = sessionKey;
    runSessionKeyRef.current[runId] = sessionKey;
    activeRunTimeoutRef.current = window.setTimeout(() => {
      if (activeRunIdRef.current !== runId) return;
      setIsLoading(false);
      setError("Response timed out. Please retry.");
      addDiag(`run timeout after 45s runId=${runId}`);
      clearActiveRunTracking();
    }, 45_000);
  }

  // Emit session list to parent (for sidebar rendering)
  useEffect(() => {
    if (!sessions.length && !currentSession) {
      return;
    }
    onSessionsChange?.(sessions, currentSession);
  }, [sessions, currentSession]);

  // Handle session selection from sidebar
  useEffect(() => {
    if (!requestedSession) {
      handledRequestedSessionRef.current = null;
      return;
    }
    if (handledRequestedSessionRef.current === requestedSession) return;
    handledRequestedSessionRef.current = requestedSession;
    if (requestedSession === "__new__") {
      createNewSession();
    } else if (requestedSession !== currentSession) {
      void selectSession(requestedSession);
    }
  }, [requestedSession, currentSession]);

  useEffect(() => {
    if (!requestedSessionAction) {
      handledRequestedActionRef.current = null;
      return;
    }
    if (handledRequestedActionRef.current === requestedSessionAction.id) return;
    handledRequestedActionRef.current = requestedSessionAction.id;
    void applySessionAction(requestedSessionAction);
  }, [requestedSessionAction]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: isLoading ? "auto" : "smooth" });
  }, [messages, isLoading]);

  useEffect(() => {
    currentSessionRef.current = currentSession;
  }, [currentSession]);

  // Load onboarding data for personalized welcome
  useEffect(() => {
    loadOnboardingData().then(setOnboardingData).catch(console.error);
  }, []);

  useEffect(() => {
    if (isAuthenticated || !isAuthConfigured || useLocalKeys) {
      setLocalCreditsCents(null);
      return;
    }

    let cancelled = false;
    const refresh = async () => {
      try {
        const balance = await getLocalCreditBalance();
        if (!cancelled) {
          setLocalCreditsCents(balance.balance_cents);
        }
      } catch (error) {
        if (!cancelled) {
          setLocalCreditsCents(0);
        }
        console.warn("[Entropic] Failed to load trial credits:", error);
      }
    };

    refresh();
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, isAuthConfigured, useLocalKeys]);

  useEffect(() => {
    if (!isAuthenticated) return;
    setAuthLoading(null);
    setAuthError(null);
    setAuthNotice(null);
  }, [isAuthenticated]);

  // Load initial auth state + refresh on auth changes (e.g. OAuth in Settings)
  const refreshAuthState = () => {
    invoke<AuthState>("get_auth_state").then(state => {
      setProviderStatus(state.providers);
      setConnectedProvider(state.active_provider || state.providers.find(p => p.has_key)?.id || null);
    }).catch(console.error);
  };

  useEffect(() => {
    refreshAuthState();
    resolveGatewayAuth()
      .then(({ wsUrl }) => {
        if (wsUrl) setGatewayUrl(wsUrl);
      })
      .catch(() => {
        invoke<string>("get_gateway_ws_url").then(url => url && setGatewayUrl(url)).catch(console.error);
      });

    const onAuthChanged = () => refreshAuthState();
    window.addEventListener("entropic-auth-changed", onAuthChanged);
    return () => window.removeEventListener("entropic-auth-changed", onAuthChanged);
  }, []);

  // If authenticated via proxy, treat as connected even without local API keys
  useEffect(() => {
    if (proxyEnabled && !connectedProvider) {
      setConnectedProvider("proxy");
      return;
    }
    if (!proxyEnabled && connectedProvider === "proxy") {
      setConnectedProvider(null);
    }
  }, [proxyEnabled, connectedProvider]);

  useEffect(() => {
    addDiag(`status proxy=${proxyEnabled} gatewayRunning=${gatewayRunning}`);
  }, [proxyEnabled, gatewayRunning]);

  // Keep a single gateway socket alive while gateway + provider are available.
  useEffect(() => {
    const shouldConnect = gatewayRunning && !gatewayStarting && (connectedProvider || proxyEnabled);
    if (!shouldConnect) {
      if (clientRef.current) {
        detachGatewayListeners(clientRef.current);
        clientRef.current.disconnect();
        clientRef.current = null;
      }
      setConnected(false);
      setIsConnecting(false);
      connectInFlightRef.current = false;
      return;
    }
    const hasLiveClient = Boolean(clientRef.current?.isConnected());
    if (!hasLiveClient && !connectInFlightRef.current) {
      if (clientRef.current) {
        addDiag("stale gateway client detected; reconnecting");
        detachGatewayListeners(clientRef.current);
        clientRef.current.disconnect();
        clientRef.current = null;
      }
      void connectToGateway();
    }
  }, [gatewayRunning, gatewayStarting, connectedProvider, proxyEnabled, connected]);

  // Reconnect-polling: when the gateway is running but the WS socket isn't
  // established yet (e.g. during the warm-up window after a container start),
  // retry connectToGateway() every 3 s rather than waiting for a dep change.
  useEffect(() => {
    const shouldPoll =
      gatewayRunning && !gatewayStarting && !connected && (connectedProvider || proxyEnabled);
    if (!shouldPoll) return;
    const id = window.setInterval(() => {
      if (!connectInFlightRef.current && !clientRef.current?.isConnected()) {
        void connectToGateway();
      }
    }, 3000);
    return () => window.clearInterval(id);
  }, [gatewayRunning, gatewayStarting, connected, connectedProvider, proxyEnabled]);

  useEffect(() => {
    return () => {
      if (clientRef.current) {
        detachGatewayListeners(clientRef.current);
        clientRef.current.disconnect();
        clientRef.current = null;
      }
      connectInFlightRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (gatewayStarting) {
      setError(null);
      setIsConnecting(true);
    }
  }, [gatewayStarting]);

  useEffect(() => {
    if (isConnecting) {
      setError(null);
    }
  }, [isConnecting]);

  useEffect(() => {
    if (!connected) return;
    if (currentSessionRef.current) return;
    if (sessionsRef.current.length > 0) {
      void selectSession(sessionsRef.current[0].key);
      addDiag("auto-selected first session after connect");
      return;
    }
    createNewSession();
    addDiag("auto-created session after connect");
  }, [connected]);

  async function connectToGateway() {
    if (connectInFlightRef.current) return;
    connectInFlightRef.current = true;
    setIsConnecting(true);
    setError(null);
    try {
      const auth = await resolveGatewayAuth();
      const wsUrl = auth.wsUrl || gatewayUrl || DEFAULT_GATEWAY_URL;
      if (wsUrl !== gatewayUrl) {
        setGatewayUrl(wsUrl);
      }
      addDiag(`connect -> ${wsUrl}`);
      const client = createGatewayClient(wsUrl, auth.token);
      if (clientRef.current && clientRef.current !== client) {
        detachGatewayListeners(clientRef.current);
        clientRef.current.disconnect();
      }
      clientRef.current = client;
      detachGatewayListeners(client);
      const onConnected = () => {
        setConnected(true);
        setIsConnecting(false);
        setError(null);
        loadSessions();
        syncAllIntegrationsToGateway()
          .then((providers) => {
            addDiag(`integrations synced: ${providers.length ? providers.join(", ") : "none"}`);
            if (providers.length === 0) {
              getCachedIntegrationProviders()
                .then((cached) => {
                  if (cached.length > 0) {
                    addDiag("integrations missing secrets; reconnect in Plugins");
                  }
                })
                .catch(() => {});
            }
          })
          .catch((err) => {
            addDiag(`integrations sync failed: ${String(err)}`);
          });
        addDiag("gateway connected");
      };
      const onDisconnected = () => {
        if (clientRef.current === client) {
          detachGatewayListeners(client);
          clientRef.current = null;
        }
        setConnected(false);
        setIsConnecting(false);
        if (activeRunIdRef.current) {
          setIsLoading(false);
          setError("Connection lost while waiting for response. Please retry.");
          addDiag(`active run interrupted by disconnect runId=${activeRunIdRef.current}`);
          clearActiveRunTracking();
        }
        addDiag("gateway disconnected");
      };
      const onChat = (event: ChatEvent) => handleChatEvent(event);
      const onAgent = (event: AgentEvent) => handleAgentEvent(event);
      const onError = (err: string) => {
        const normalizedError = sanitizeGatewayErrorMessage(err);
        // Suppress errors during startup grace period (first 15 seconds after component mount)
        const inStartupGracePeriod = Date.now() - componentMountedAt < 15_000;
        const suppressError = gatewayStarting || isConnecting || !gatewayRunning || inStartupGracePeriod;
        if (!client.isConnected()) {
          setConnected(false);
        }
        if (!suppressError) {
          setError(normalizedError);
        }
        setIsConnecting(false);
        if (activeRunIdRef.current) {
          setIsLoading(false);
          addDiag(`active run interrupted by gateway error runId=${activeRunIdRef.current}`);
          clearActiveRunTracking();
        }
        setLastGatewayError(normalizedError);
        addDiag(`gateway error: ${normalizedError}${inStartupGracePeriod ? ' (suppressed: startup grace period)' : ''}`);
      };
      client.on("connected", onConnected);
      client.on("disconnected", onDisconnected);
      client.on("chat", onChat);
      client.on("agent", onAgent);
      client.on("error", onError);
      handlersRef.current = { connected: onConnected, disconnected: onDisconnected, chat: onChat, agent: onAgent, error: onError };
      if (client.isConnected()) {
        onConnected();
      } else {
        await client.connect();
      }
    } catch (e) {
      const inStartupGracePeriod = Date.now() - componentMountedAt < 15_000;
      if (!gatewayStarting && !inStartupGracePeriod) {
        setError(e instanceof Error ? e.message : "Connection failed");
      }
      setIsConnecting(false);
      addDiag(`connect failed: ${e instanceof Error ? e.message : "unknown"}${inStartupGracePeriod ? ' (suppressed: startup grace period)' : ''}`);
    } finally {
      connectInFlightRef.current = false;
    }
  }

  function detachGatewayListeners(client: GatewayClient) {
    const handlers = handlersRef.current;
    if (handlers.connected) client.off("connected", handlers.connected);
    if (handlers.disconnected) client.off("disconnected", handlers.disconnected);
    if (handlers.chat) client.off("chat", handlers.chat);
    if (handlers.agent) client.off("agent", handlers.agent);
    if (handlers.error) client.off("error", handlers.error);
    handlersRef.current = {};
  }

  function describeAgentActivity(evt: AgentEvent): string | null {
    const { stream, data } = evt;
    if (stream === "tool") {
      const name = typeof data.name === "string" ? data.name : typeof data.tool === "string" ? data.tool : null;
      if (name) {
        const friendly: Record<string, string> = {
          read_file: "Reading file",
          write_file: "Writing file",
          edit_file: "Editing file",
          list_directory: "Listing directory",
          search_files: "Searching files",
          run_command: "Running command",
          bash: "Running command",
          web_search: "Searching the web",
          web_fetch: "Fetching web page",
          x_search: "Searching X",
          x_profile: "Looking up profile",
          x_thread: "Fetching thread",
          x_user_tweets: "Fetching tweets",
          google_calendar: "Checking calendar",
          google_email: "Checking email",
          memory_search: "Searching memory",
          memory_store: "Saving to memory",
        };
        return friendly[name] || `Using ${name.replace(/_/g, " ")}`;
      }
      return "Using tool";
    }
    if (stream === "assistant") return "Thinking";
    if (stream === "lifecycle") {
      const phase = typeof data.phase === "string" ? data.phase : null;
      if (phase === "start") return "Starting";
      if (phase === "end" || phase === "error") return null;
    }
    return null;
  }

  function handleAgentEvent(event: AgentEvent) {
    if (!event?.runId || event.runId !== activeRunIdRef.current) return;
    const status = describeAgentActivity(event);
    if (status) {
      setThinkingStatus(status);
    }
  }

  async function recoverFinalRunFromHistory(runId: string, sessionKey: string) {
    if (!runId || !sessionKey) return;
    if (runHistoryRecoveryRef.current[runId]) return;
    const client = clientRef.current;
    if (!client || !client.isConnected()) return;

    runHistoryRecoveryRef.current[runId] = true;
    try {
      const history = await client.getChatHistory(sessionKey, 40);
      const fallback = [...history].reverse().find((item) => {
        const role = typeof item?.role === "string" ? item.role.toLowerCase() : "";
        if (role !== "assistant" && role !== "toolresult" && role !== "tool_result" && role !== "tool") {
          return false;
        }
        const normalized = normalizeGatewayMessage(item as GatewayMessage, runId);
        const text = normalized?.content ?? "";
        const hasPayload = Boolean(
          normalized?.assistantPayload &&
          (normalized.assistantPayload.events.length > 0 || normalized.assistantPayload.errors.length > 0)
        );
        return Boolean(text || hasPayload);
      });

      if (!fallback) {
        setError("Assistant returned no visible response. Check Billing/auth/network and retry.");
        addDiag(`final recovery missed runId=${runId} (no assistant payload in history)`);
        return;
      }

      const normalized = normalizeGatewayMessage(fallback as GatewayMessage, runId);
      if (!normalized) {
        setError("Assistant returned no visible response. Check Billing/auth/network and retry.");
        addDiag(`final recovery missed runId=${runId} (normalize failed)`);
        return;
      }

      const text = normalized.content ?? "";
      const hasRenderableAssistantPayload = Boolean(
        normalized.assistantPayload &&
        (normalized.assistantPayload.events.length > 0 || normalized.assistantPayload.errors.length > 0)
      );
      if (!text && !hasRenderableAssistantPayload) {
        setError("Assistant returned no visible response. Check Billing/auth/network and retry.");
        addDiag(`final recovery missed runId=${runId} (empty normalized payload)`);
        return;
      }

      setMessages((prev) => {
        const existingIdx = prev.findIndex((m) => m.id === runId && m.role === "assistant");
        if (existingIdx >= 0) {
          const updated = [...prev];
          updated[existingIdx] = {
            ...updated[existingIdx],
            content: text,
            kind: normalized.kind ?? updated[existingIdx].kind,
            toolName: normalized.toolName ?? updated[existingIdx].toolName,
            assistantPayload: normalized.assistantPayload ?? updated[existingIdx].assistantPayload,
            sentAt: updated[existingIdx].sentAt ?? normalized.sentAt ?? Date.now(),
          };
          return updated;
        }
        return [
          ...prev,
          {
            id: runId,
            role: "assistant",
            content: text,
            kind: normalized.kind,
            toolName: normalized.toolName,
            assistantPayload: normalized.assistantPayload,
            sentAt: normalized.sentAt ?? Date.now(),
          },
        ];
      });
      setThinkingStatus(null);
      if (isBillingIssueMessage(text)) {
        setError(BILLING_RECOVERY_MESSAGE);
      }
      addDiag(`recovered final response from history runId=${runId}`);
    } catch (err) {
      setError("Assistant returned no visible response. Check Billing/auth/network and retry.");
      addDiag(`final recovery failed runId=${runId}: ${String(err)}`);
    } finally {
      delete runHistoryRecoveryRef.current[runId];
    }
  }

  function handleChatEvent(event: any) {
    const composer = textareaRef.current;
    const keepComposerFocus = !!composer && document.activeElement === composer;
    const selection = keepComposerFocus && composer
      ? { start: composer.selectionStart, end: composer.selectionEnd }
      : null;

    lastChatEventRef.current = event;
    if (showDiagnosticsRef.current || event?.state !== "delta") {
      setLastChatEvent(event);
    }
    const eventRunId = typeof event?.runId === "string" ? event.runId.trim() : "";
    if (eventRunId) {
      lastEventByRunIdRef.current[eventRunId] = Date.now();
    }
    const eventSessionKey =
      typeof event?.sessionKey === "string" ? event.sessionKey.trim() : "";
    if (eventRunId && eventSessionKey && eventSessionKey !== "unknown") {
      runSessionKeyRef.current[eventRunId] = eventSessionKey;
    }
    const knownSessionKey =
      eventSessionKey && eventSessionKey !== "unknown"
        ? eventSessionKey
        : eventRunId
          ? runSessionKeyRef.current[eventRunId] || ""
          : "";
    const isActiveRun = Boolean(eventRunId && activeRunIdRef.current === eventRunId);
    if (
      isActiveRun &&
      knownSessionKey &&
      activeRunSessionRef.current &&
      knownSessionKey !== activeRunSessionRef.current
    ) {
      migrateSessionKey(activeRunSessionRef.current, knownSessionKey);
    }
    const isActiveRunTerminalEvent = Boolean(
      eventRunId &&
      activeRunIdRef.current === eventRunId &&
      (event.state === "final" || event.state === "error" || event.state === "aborted")
    );
    if (isActiveRunTerminalEvent) {
      setIsLoading(false);
      setThinkingStatus(null);
      clearActiveRunTracking();
      // Notify Dashboard to refresh credit balance after message completion
      window.dispatchEvent(new Event("entropic-local-credits-changed"));
    }
    if (
      !isActiveRun &&
      currentSessionRef.current &&
      (!knownSessionKey || knownSessionKey !== currentSessionRef.current)
    ) {
      return;
    }
    if (event.state === "delta" || event.state === "final") {
      const normalized = event.message ? normalizeGatewayMessage(event.message as GatewayMessage, eventRunId || "evt") : null;
      const text = normalized?.content ?? "";
      const hasRenderableAssistantPayload = Boolean(
        normalized?.assistantPayload &&
        (normalized.assistantPayload.events.length > 0 || normalized.assistantPayload.errors.length > 0)
      );
      if (text || hasRenderableAssistantPayload) {
        setThinkingStatus(null);
        if (isProxyAuthFailure(text)) {
          triggerProxyAuthRecovery("chat message");
        }
        if (eventRunId) {
          const timings = runTimingsRef.current[eventRunId];
          if (timings && !timings.firstDeltaAt) {
            timings.firstDeltaAt = Date.now();
            addDiag(`timing first_delta runId=${eventRunId} t=${timings.firstDeltaAt - timings.startedAt}ms`);
          }
        }
        setMessages(prev => {
          const existingIdx = prev.findIndex(m => m.id === eventRunId && m.role === "assistant");
          if (existingIdx >= 0) {
            const updated = [...prev];
            updated[existingIdx] = {
              ...updated[existingIdx],
              content: text,
              kind: normalized?.kind ?? updated[existingIdx].kind,
              toolName: normalized?.toolName ?? updated[existingIdx].toolName,
              assistantPayload: normalized?.assistantPayload ?? updated[existingIdx].assistantPayload,
              sentAt: updated[existingIdx].sentAt ?? normalized?.sentAt ?? Date.now(),
            };
            return updated;
          }
          return [
            ...prev,
            {
              id: eventRunId || crypto.randomUUID(),
              role: "assistant",
              content: text,
              kind: normalized?.kind,
              toolName: normalized?.toolName,
              assistantPayload: normalized?.assistantPayload,
              sentAt: normalized?.sentAt ?? Date.now(),
            },
          ];
        });
        if (keepComposerFocus) {
          requestAnimationFrame(() => {
            if (!textareaRef.current) return;
            textareaRef.current.focus();
            if (selection) {
              try {
                textareaRef.current.setSelectionRange(selection.start, selection.end);
              } catch {
                // ignore selection restore failures
              }
            }
          });
        }
        if (normalized && normalized.kind === "toolResult" && eventRunId) {
          const timings = runTimingsRef.current[eventRunId];
          if (timings && !timings.toolSeenAt) {
            timings.toolSeenAt = Date.now();
            addDiag(`timing tool_result runId=${eventRunId} t=${timings.toolSeenAt - timings.startedAt}ms`);
          }
        }
      } else if (event.state === "final" && eventRunId && knownSessionKey) {
        addDiag(`final event missing payload runId=${eventRunId}; attempting history recovery`);
        void recoverFinalRunFromHistory(eventRunId, knownSessionKey);
      }
      if (event.state === "final") {
        setIsLoading(false);
        if (eventRunId && activeRunIdRef.current === eventRunId) {
          clearActiveRunTracking();
        }
      }
      if (event.state === "final" && eventRunId) {
        const timings = runTimingsRef.current[eventRunId];
        if (timings && !timings.finalAt) {
          timings.finalAt = Date.now();
          addDiag(`timing final runId=${eventRunId} t=${timings.finalAt - timings.startedAt}ms`);
        }
        const revertModel = runRevertModelRef.current[eventRunId];
        if (revertModel && currentSessionRef.current && clientRef.current) {
          clientRef.current
            .patchSession(currentSessionRef.current, { model: revertModel })
            .then(() => {
              sessionModelRef.current[currentSessionRef.current!] = revertModel;
              addDiag(`routing revert model=${revertModel}`);
            })
            .catch((err) => addDiag(`routing revert failed: ${String(err)}`));
        }
        delete runRevertModelRef.current[eventRunId];
        delete runSessionKeyRef.current[eventRunId];

        // Persist the full conversation after assistant response completes
        if (currentSessionRef.current) {
          // Refresh session list from gateway to get derived titles
          clientRef.current?.listSessions().then((updatedSessions) => {
            if (updatedSessions && updatedSessions.length > 0) {
              gatewaySessionKeysRef.current = new Set(updatedSessions.map((s) => s.key));
              setSessions(prev => {
                // Merge: gateway sessions take priority, keep local-only sessions
                const gatewayKeys = new Set(updatedSessions.map(s => s.key));
                const localOnly = prev.filter(s => !gatewayKeys.has(s.key) && (sessionMessagesRef.current[s.key]?.length ?? 0) > 0);
                return applySessionTitles(overlaySessionMetadata([...updatedSessions, ...localOnly], prev));
              });
            }
          }).catch(() => {});
          schedulePersist();
        }
      }
    } else if (event.state === "error") {
      const errorMessage = formatAssistantErrorTextForUi(event.errorMessage || "Chat error");
      setError(errorMessage);
      setIsLoading(false);
      if (eventRunId && activeRunIdRef.current === eventRunId) {
        clearActiveRunTracking();
      }
      if (eventRunId) {
        delete runSessionKeyRef.current[eventRunId];
      }
      addDiag(`chat error: ${event.errorMessage || "unknown"}`);
      if (isProxyAuthFailure(errorMessage)) {
        triggerProxyAuthRecovery("chat error event");
      }
    } else if (event.state === "aborted") {
      setIsLoading(false);
      if (eventRunId && activeRunIdRef.current === eventRunId) {
        clearActiveRunTracking();
      }
      if (eventRunId) {
        delete runSessionKeyRef.current[eventRunId];
      }
      addDiag("chat aborted");
    }

    if (showDiagnosticsRef.current) {
      setLastChatEvent(lastChatEventRef.current);
    }
  }

  async function loadSessions() {
    const gatewaySessions = await clientRef.current?.listSessions() || [];
    gatewaySessionKeysRef.current = new Set(gatewaySessions.map((s) => s.key));

    // Merge with locally cached sessions
    const cached = await loadPersistedChatData();
    const gatewayKeys = new Set(gatewaySessions.map(s => s.key));
    const gatewayTitleIndex = new Map<string, string>();
    for (const session of gatewaySessions) {
      const hint = sessionTitleHint(session);
      if (!hint) continue;
      const key = titleDedupKey(hint);
      if (key && !gatewayTitleIndex.has(key)) {
        gatewayTitleIndex.set(key, session.key);
      }
    }

    // Keep local sessions that have messages but aren't on the gateway
    // (e.g., from a previous container restart)
    const localOnly: ChatSession[] = [];
    const localToGateway = new Map<string, string>();
    const claimedGatewayTargets = new Set<string>();
    if (cached?.sessions) {
      for (const s of cached.sessions) {
        if (gatewayKeys.has(s.key)) continue;
        const rawLocalMessages = cached.messages[s.key] || [];
        if (rawLocalMessages.length === 0) continue;
        const normalizedLocalMessages = rawLocalMessages.map(normalizeCachedMessage);
        const localSummary = summarizeSessionTitleFromMessages(normalizedLocalMessages);
        const localSummaryKey = localSummary ? titleDedupKey(localSummary) : "";
        const matchedGatewayKey = localSummaryKey ? gatewayTitleIndex.get(localSummaryKey) : undefined;

        if (matchedGatewayKey && !claimedGatewayTargets.has(matchedGatewayKey)) {
          claimedGatewayTargets.add(matchedGatewayKey);
          localToGateway.set(s.key, matchedGatewayKey);
          const existing = sessionMessagesRef.current[matchedGatewayKey] || [];
          if (existing.length === 0 || normalizedLocalMessages.length > existing.length) {
            sessionMessagesRef.current[matchedGatewayKey] = normalizedLocalMessages;
          }
          continue;
        }

        localOnly.push(s);
      }
    }

    const merged = [...gatewaySessions, ...localOnly];
    setSessions(prev => applySessionTitles(overlaySessionMetadata(merged, [...(cached?.sessions || []), ...prev])));

    // Restore messages cache from persisted data
    if (cached?.messages) {
      for (const [key, msgs] of Object.entries(cached.messages)) {
        const targetKey = localToGateway.get(key) || key;
        const normalized = msgs.map(normalizeCachedMessage);
        if (!sessionMessagesRef.current[targetKey] || sessionMessagesRef.current[targetKey].length < normalized.length) {
          sessionMessagesRef.current[targetKey] = normalized;
        }
        if (targetKey !== key) {
          delete sessionMessagesRef.current[key];
        }
      }
    }

    if (cached?.drafts && localToGateway.size > 0) {
      setDraftsBySession((prev) => {
        const next = { ...prev };
        for (const [from, to] of localToGateway.entries()) {
          const fromDraft = next[from] ?? cached.drafts[from];
          if (typeof fromDraft === "string" && fromDraft.length > 0 && !next[to]) {
            next[to] = fromDraft;
          }
          delete next[from];
        }
        return next;
      });
    }

    if (merged.length > 0) {
      // Prefer the active session, then persisted session, then first in list.
      const activeKeyRaw = currentSessionRef.current;
      const preferredKeyRaw = cached?.currentSession;
      const activeKey = activeKeyRaw ? localToGateway.get(activeKeyRaw) || activeKeyRaw : null;
      const preferredKey = preferredKeyRaw ? localToGateway.get(preferredKeyRaw) || preferredKeyRaw : null;
      const target =
        activeKey && merged.find((s) => s.key === activeKey)
          ? activeKey
          : preferredKey && merged.find((s) => s.key === preferredKey)
            ? preferredKey
            : merged[0].key;
      await selectSession(target);
    } else {
      createNewSession();
    }
  }

  async function selectSession(sessionId: string) {
    currentSessionRef.current = sessionId;
    setCurrentSession(sessionId);
    setError(null);
    setIsLoading(false);
    setThinkingStatus(null);
    clearActiveRunTracking();

    // Optimistically swap to local cache immediately so the selected chat appears right away.
    const cachedMsgs = (sessionMessagesRef.current[sessionId] || []).map(normalizeCachedMessage);
    visibleMessagesSessionRef.current = sessionId;
    setMessages(cachedMsgs);
    setShowWelcome(cachedMsgs.length === 0);

    // Try to load from gateway first
    let history: GatewayMessage[] = [];
    if (gatewaySessionKeysRef.current.has(sessionId)) {
      try {
        history = await clientRef.current?.getChatHistory(sessionId, HISTORY_LIMIT) || [];
      } catch (err) {
        addDiag(`history load failed for session=${sessionId}: ${String(err)}`);
      }
    } else {
      addDiag(`session=${sessionId} is local-only; using cached history`);
    }
    if (currentSessionRef.current !== sessionId) {
      return;
    }
    let msgs: Message[];
    if (history.length > 0) {
      const parsedHistory = history
        .map((m: any, i: number) => normalizeGatewayMessage(m as GatewayMessage, `h-${i}`))
        .filter((m: Message | null): m is Message => !!m && m.content.trim().length > 0);
      msgs = parsedHistory.length > 0 ? parsedHistory : cachedMsgs;
    } else {
      // Fall back to locally cached messages
      msgs = cachedMsgs;
    }
    visibleMessagesSessionRef.current = sessionId;
    setMessages(msgs);
    sessionMessagesRef.current[sessionId] = msgs;
    setSessions((prev) => applySessionTitles(prev));
    setShowWelcome(msgs.length === 0);
    schedulePersist();
  }

  async function applySessionAction(action: ChatSessionActionRequest) {
    if (!action?.key) return;
    if (action.type === "pin") {
      setSessions((prev) =>
        applySessionTitles(
          normalizeSessionsList(
          prev.map((session) =>
            session.key === action.key ? { ...session, pinned: action.pinned } : session,
          ),
          ),
        ),
      );
      schedulePersist();
      return;
    }

    if (action.type === "rename") {
      const nextLabel = action.label.trim();
      if (!nextLabel) return;
      const existing = sessionsRef.current.find((session) => session.key === action.key);
      setSessions((prev) =>
        applySessionTitles(
          normalizeSessionsList(
          prev.map((session) =>
            session.key === action.key ? { ...session, label: nextLabel } : session,
          ),
          ),
        ),
      );
      schedulePersist();
      try {
        await clientRef.current?.patchSession(action.key, { label: nextLabel });
      } catch (err) {
        addDiag(`rename failed key=${action.key}: ${String(err)}`);
        setError("Failed to rename chat");
        if (existing) {
          setSessions((prev) =>
            applySessionTitles(
              normalizeSessionsList(
              prev.map((session) =>
                session.key === action.key ? { ...session, label: existing.label } : session,
              ),
              ),
            ),
          );
          schedulePersist();
        }
      }
      return;
    }

    if (action.type === "delete") {
      const snapshotSession = sessionsRef.current.find((session) => session.key === action.key);
      const snapshotMessages = sessionMessagesRef.current[action.key] || [];
      const snapshotDraft = draftsRef.current[action.key] || "";
      const deletingCurrent = currentSessionRef.current === action.key;
      const remaining = normalizeSessionsList(
        sessionsRef.current.filter((session) => session.key !== action.key),
      );

      setSessions(applySessionTitles(remaining));
      const nextMessages = { ...sessionMessagesRef.current };
      delete nextMessages[action.key];
      sessionMessagesRef.current = nextMessages;
      setDraftsBySession((prev) => {
        const next = { ...prev };
        delete next[action.key];
        return next;
      });
      schedulePersist();

      if (deletingCurrent) {
        if (remaining.length > 0) {
          await selectSession(remaining[0].key);
        } else {
          createNewSession({ force: true });
        }
      }

      try {
        await clientRef.current?.deleteSession(action.key, true);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code = (err as { code?: unknown })?.code;
        const suffix = code ? ` (${String(code)})` : "";
        addDiag(`delete failed key=${action.key}: ${message}${suffix}`);
        setError(`Failed to delete chat: ${message}${suffix}`);
        if (snapshotSession) {
          setSessions((prev) => applySessionTitles(normalizeSessionsList([...prev, snapshotSession])));
          if (snapshotMessages.length > 0) {
            sessionMessagesRef.current[action.key] = snapshotMessages;
          }
          if (snapshotDraft) {
            setDraftsBySession((prev) => ({ ...prev, [action.key]: snapshotDraft }));
          }
          schedulePersist();
          if (deletingCurrent) {
            await selectSession(action.key);
          }
        }
      }
    }
  }

  function createNewSession(options?: { force?: boolean }) {
    const force = options?.force === true;
    const existing = currentSessionRef.current;
    if (!force && existing && sessionsRef.current.some((session) => session.key === existing)) {
      const existingMessages = sessionMessagesRef.current[existing] || [];
      const existingDraft = draftsRef.current[existing] || "";
      if (existingMessages.length === 0 && existingDraft.trim().length === 0) {
        setCurrentSession(existing);
        visibleMessagesSessionRef.current = existing;
        setMessages([]);
        setShowWelcome(true);
        return;
      }
    }

    const sessionKey = clientRef.current?.createSessionKey() || crypto.randomUUID();
    currentSessionRef.current = sessionKey;
    setCurrentSession(sessionKey);
    visibleMessagesSessionRef.current = sessionKey;
    setMessages([]);
    sessionMessagesRef.current[sessionKey] = [];
    setSessions((prev) => {
      if (prev.some((session) => session.key === sessionKey)) {
        return prev;
      }
      return applySessionTitles(normalizeSessionsList([{ key: sessionKey, updatedAt: Date.now() }, ...prev]));
    });
    setDraftsBySession((prev) => ({ ...prev, [sessionKey]: "" }));
    setShowWelcome(true);
    schedulePersist();
  }

  function ensureComposerSession(): string | null {
    const existing = currentSessionRef.current;
    if (existing) return existing;
    createNewSession({ force: true });
    return currentSessionRef.current;
  }

  async function handleSend(content?: string) {
    let sendSession = currentSessionRef.current;
    if (!sendSession) {
      createNewSession({ force: true });
      sendSession = currentSessionRef.current;
    }
    const currentDraft = sendSession ? (draftsRef.current[sendSession] || "") : "";
    const messageContent = content || currentDraft.trim();
    const failedDraftRestore = content ? null : currentDraft;
    if (!sendSession || isLoading || (!messageContent && pendingAttachments.length === 0)) return;
    const liveClient = clientRef.current;
    if (!liveClient || !liveClient.isConnected()) {
      if (!connectInFlightRef.current) {
        void connectToGateway();
      }
      const details = lastGatewayError ? ` Last gateway error: ${lastGatewayError}` : "";
      setError(`Gateway is still connecting. Please try again in a moment.${details}`);
      addDiag(
        `send blocked: gateway not connected (connected=${connected} gatewayRunning=${gatewayRunning} provider=${connectedProvider || "none"} proxy=${proxyEnabled})`
      );
      return;
    }

    await refreshTrialCredits();

    const userMessage: Message = { id: crypto.randomUUID(), role: "user", content: messageContent, sentAt: Date.now() };
    visibleMessagesSessionRef.current = sendSession;
    setMessages(prev => [...prev, userMessage]);

    // Persist the user message immediately so it survives navigation
    if (sendSession) {
      const cachedMsgs = sessionMessagesRef.current[sendSession] || [];
      sessionMessagesRef.current[sendSession] = [...cachedMsgs, userMessage];
      // Ensure this session is in the sessions list
      setSessions(prev => {
        const updated = prev.some((s) => s.key === sendSession)
          ? prev.map((s) => (s.key === sendSession ? { ...s, updatedAt: Date.now() } : s))
          : [{ key: sendSession, updatedAt: Date.now() }, ...prev];
        return applySessionTitles(normalizeSessionsList(updated));
      });
      schedulePersist();
    }

    if (!content && sendSession) {
      setDraftsBySession((prev) => ({ ...prev, [sendSession]: "" }));
    }
    setShowWelcome(false);
    setIsLoading(true);
    setThinkingStatus("Thinking");
    setError(null);
    try {
      const routingEnabled = import.meta.env.VITE_MODEL_ROUTING === "1";
      const fastModelOverride = normalizeModelId(import.meta.env.VITE_FAST_MODEL, proxyEnabled);
      const reasoningOverride = normalizeModelId(import.meta.env.VITE_REASONING_MODEL, proxyEnabled);
      const defaultModel = normalizeModelId(selectedModel, proxyEnabled);
      const fastModel = fastModelOverride ?? defaultModel;
      const reasoningModel = reasoningOverride ?? defaultModel;
      const decision = getRoutingDecision(messageContent);
      const chosenModel = routingEnabled
        ? decision.useReasoning
          ? reasoningModel
          : fastModel
        : null;

      const targetModel = routingEnabled ? chosenModel ?? defaultModel : defaultModel;
      if (targetModel && sendSession && clientRef.current) {
        const lastModel = sessionModelRef.current[sendSession];
        if (lastModel !== targetModel) {
          sessionModelRef.current[sendSession] = targetModel;
          try {
            await clientRef.current.patchSession(sendSession, { model: targetModel });
            if (routingEnabled && chosenModel) {
              addDiag(`routing model=${targetModel} reason=${decision.reason}`);
            } else {
              addDiag(`session model=${targetModel}`);
            }
          } catch (err: unknown) {
            addDiag(`session model patch failed: ${String(err)}`);
          }
        }
      }
      const sendStart = Date.now();
      const now = Date.now();
      if (gatewayRunning && (connectedProvider || proxyEnabled) && now - lastIntegrationsSyncRef.current > 60_000) {
        lastIntegrationsSyncRef.current = now;
        syncAllIntegrationsToGateway().then(
          (providers) => addDiag(`integrations synced: ${providers.length ? providers.join(", ") : "none"}`),
          (err: unknown) => addDiag(`integrations sync failed: ${String(err)}`),
        );
      }
      addDiag(`send -> session=${sendSession} len=${messageContent.length}`);
      const runId = await liveClient.sendMessage(sendSession, messageContent, []);
      if (!runId) {
        throw new Error("Failed to start response stream");
      }
      setLastSendId(runId || null);
      setLastSendAt(Date.now());
      if (runId) {
        scheduleActiveRunTimeout(runId, sendSession);
        runTimingsRef.current[runId] = { startedAt: sendStart, ackAt: Date.now() };
        addDiag(`timing send_ack runId=${runId} t=${runTimingsRef.current[runId].ackAt! - sendStart}ms`);
        addDiag(`send ok runId=${runId}`);
        if (routingEnabled && chosenModel && fastModel && reasoningModel && chosenModel !== fastModel) {
          runRevertModelRef.current[runId] = fastModel;
        }
        const capturedRunId = runId;
        setTimeout(() => {
          if (!lastEventByRunIdRef.current[capturedRunId]) {
            addDiag(`no chat event within 15s runId=${capturedRunId}`);
          }
        }, 15000);
      }
      setPendingAttachments([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Send failed");
      setIsLoading(false);
      clearActiveRunTracking();
      await refreshTrialCredits();
      addDiag(`send failed: ${e instanceof Error ? e.message : "unknown"}`);
      if (failedDraftRestore !== null && sendSession && currentSessionRef.current === sendSession) {
        setDraftsBySession((prev) => ({ ...prev, [sendSession]: failedDraftRestore }));
      }
    }
  }

  function sessionTitle(s: ChatSession): string {
    return s.label || s.derivedTitle || s.displayName || `Chat ${s.key.slice(0, 8)}`;
  }

  async function handleSuggestionClick(action: SuggestionAction) {
    if (action.type === "channel") {
      let config = channelConfig;
      if (!config) {
        try {
          const state = await invoke<{
            imessage_enabled: boolean;
            whatsapp_enabled: boolean;
          }>("get_agent_profile_state");
          config = {
            imessageEnabled: state.imessage_enabled ?? false,
            whatsappEnabled: state.whatsapp_enabled ?? false,
          };
          setChannelConfig(config);
        } catch {
          onNavigate?.("channels");
          return;
        }
      }
      const enabled =
        action.channel === "imessage" ? config.imessageEnabled : config.whatsappEnabled;
      if (!enabled) {
        addDiag(`channel ${action.channel} not configured; redirecting to Messaging`);
        onNavigate?.("channels");
        return;
      }
      setChannelModal({ isOpen: true, channel: action.channel });
    } else if (action.type === "agent") {
      if (action.requiresIntegration) {
        try {
          const integrations = await getIntegrations();
          const entry = integrations.find((item) => item.provider === action.requiresIntegration);
          if (!entry || !entry.connected || entry.stale) {
            addDiag(`suggestion requires ${action.requiresIntegration}; redirecting to Plugins`);
            onNavigate?.("store");
            return;
          }
        } catch {
          onNavigate?.("store");
          return;
        }
      }
      handleSend(action.message);
    }
  }

  function handleChannelSetupComplete(channel: "imessage" | "whatsapp") {
    setChannelModal({ isOpen: false, channel });
    setChannelConfig((prev) => {
      const next = prev ?? { imessageEnabled: false, whatsappEnabled: false };
      return channel === "imessage"
        ? { ...next, imessageEnabled: true }
        : { ...next, whatsappEnabled: true };
    });
    const channelName = channel === "imessage" ? "iMessage" : "WhatsApp";
    handleSend(`I've connected ${channelName}. Please send me a test message!`);
  }

  type AssistantRenderPayload = ReturnType<typeof parseToolPayloads>;

  function renderAssistantContent(message: Message, precomputedPayload?: AssistantRenderPayload) {
    const payload = precomputedPayload ?? {
      cleanText: message.content,
      events: message.assistantPayload?.events ?? [],
      errors: message.assistantPayload?.errors ?? [],
      hadToolPayload: message.assistantPayload?.hadToolPayload ?? false,
    };
    if (payload.hadToolPayload && message.id) {
      const timings = runTimingsRef.current[message.id];
      if (timings && !timings.toolSeenAt) {
        timings.toolSeenAt = Date.now();
        addDiag(`timing tool_payload runId=${message.id} t=${timings.toolSeenAt - timings.startedAt}ms`);
      }
    }
    if (!payload.events.length && !payload.errors.length) {
      return <MarkdownContent content={payload.cleanText} />;
    }
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-[var(--text-tertiary)]">
          <span>{message.kind === "toolResult" ? "Tool Result" : "Assistant"}</span>
          {message.toolName ? <span className="text-[var(--text-quaternary)]">{message.toolName}</span> : null}
        </div>
        {payload.cleanText ? <MarkdownContent content={payload.cleanText} /> : null}
        {payload.events.length > 0 && (
          <div className="rounded-xl border border-[var(--glass-border-subtle)] bg-[var(--glass-bg)] p-3 shadow-sm">
            <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-[var(--text-tertiary)] mb-2">
              <Calendar className="w-3.5 h-3.5" />
              Calendar
            </div>
            <div className="space-y-2">
              {payload.events.map((event, idx) => {
                const { date, time } = formatEventRange(event.start, event.end);
                const attendees = event.attendees?.length ?? 0;
                return (
                  <div
                    key={event.id || `evt-${idx}`}
                    className="rounded-lg bg-[var(--bg-tertiary)]/60 px-3 py-2"
                  >
                    <div className="font-semibold text-[var(--text-primary)]">
                      {event.summary || "Untitled event"}
                    </div>
                    {(date || time) && (
                      <div className="text-xs text-[var(--text-secondary)]">
                        {date}{date && time ? " · " : ""}{time}
                      </div>
                    )}
                    {attendees > 0 && (
                      <div className="text-xs text-[var(--text-tertiary)]">Attendees: {attendees}</div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    );
  }

  // Simplified render helpers for different states
  const renderConnecting = () => (
    <div className="h-full flex items-center justify-center">
      <div className="text-center p-8 glass-card">
        <Loader2 className="w-8 h-8 animate-spin mx-auto mb-3 text-[var(--text-accent)]" />
        <p className="text-[var(--text-secondary)]">Connecting to your assistant...</p>
      </div>
    </div>
  );

  const renderNoProvider = () => {
    const accountSignInAvailable = isAuthConfigured && !useLocalKeys && !isAuthenticated;
    const trialCreditsExhausted =
      accountSignInAvailable &&
      localCreditsCents !== null &&
      localCreditsCents <= 0;
    const ownProviderExpanded =
      !accountSignInAvailable || showOwnProviderOptions || anthropicCodePending;

    return (
      <>
        <div className="h-full flex flex-col items-center justify-center p-6 text-center">
          <div className={accountSignInAvailable
            ? "w-full max-w-[420px] bg-white rounded-3xl shadow-xl p-10 border border-gray-100/60"
            : "glass-card p-8 max-w-md"}
          >
            {accountSignInAvailable ? (
              <div className="text-center mb-8">
                <div className="w-20 h-20 rounded-[2rem] bg-transparent mx-auto flex items-center justify-center mb-6">
                  <img src={entropicLogo} alt="Entropic" className="w-20 h-20 rounded-[2rem] shadow-xl" />
                </div>
                <h2 className="text-3xl font-bold text-gray-900 mb-3 tracking-tight">Continue with Entropic</h2>
                <p className="text-sm text-gray-500">
                  {trialCreditsExhausted
                    ? "Your free credits are used. Sign in to continue, or use your own provider."
                    : "Sign in with your Entropic account, or use your own provider."}
                </p>
              </div>
            ) : (
              <>
                <Sparkles className="w-10 h-10 mx-auto mb-4 text-[var(--text-accent)]" />
                <h2 className="text-xl font-semibold mb-2 text-[var(--text-primary)]">Connect an AI Service</h2>
                <p className="mb-6 text-[var(--text-secondary)]">Use provider OAuth or add an API key.</p>
              </>
            )}

            {accountSignInAvailable ? (
              <div className="space-y-3 mb-6">
                {authError ? (
                  <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 text-center">
                    {authError}
                  </div>
                ) : null}
                {authNotice ? (
                  <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700 text-center">
                    {authNotice}
                  </div>
                ) : null}
                <button
                  onClick={() => handleEntropicOAuthSignIn("google")}
                  disabled={authLoading !== null || oauthLoading !== null}
                  className="w-full flex items-center justify-center gap-3 px-4 py-4 bg-white hover:bg-gray-50 text-gray-700 font-medium rounded-2xl border border-gray-200 transition-all hover:border-gray-300 active:scale-95 duration-200 disabled:opacity-50"
                >
                  <GoogleIcon className="w-5 h-5" />
                  {authLoading === "google" ? "Opening Google..." : "Continue with Google"}
                </button>
                <button
                  onClick={() => handleEntropicOAuthSignIn("discord")}
                  disabled={authLoading !== null || oauthLoading !== null}
                  className="w-full flex items-center justify-center gap-3 px-4 py-4 bg-[#5865F2] hover:bg-[#4752C4] text-white font-medium rounded-2xl transition-all shadow-md hover:shadow-lg active:scale-95 duration-200 disabled:opacity-50"
                >
                  <DiscordIcon className="w-5 h-5" />
                  {authLoading === "discord" ? "Opening Discord..." : "Continue with Discord"}
                </button>
                <div className="relative py-2">
                  <div className="absolute inset-0 flex items-center">
                    <div className="w-full border-t border-gray-100" />
                  </div>
                  <div className="relative flex justify-center text-[10px] uppercase tracking-wider">
                    <span className="bg-white px-2 text-gray-400">or</span>
                  </div>
                </div>
                <button
                  onClick={() => {
                    setShowEmailAuth((prev) => !prev);
                    setAuthError(null);
                    setAuthNotice(null);
                  }}
                  disabled={authLoading !== null || oauthLoading !== null}
                  className="w-full flex items-center justify-center gap-3 px-4 py-4 bg-gray-50 hover:bg-gray-100 text-gray-900 font-medium rounded-2xl transition-all active:scale-95 duration-200 disabled:opacity-50"
                >
                  <Mail className="w-5 h-5 text-gray-500" />
                  <span>Continue with Email</span>
                </button>
                {showEmailAuth ? (
                  <form onSubmit={handleEntropicEmailAuthSubmit} className="space-y-3 rounded-2xl bg-gray-50 p-4 text-left">
                    <input
                      type="email"
                      value={authEmail}
                      onChange={(event) => setAuthEmail(event.target.value)}
                      placeholder="name@example.com"
                      className="w-full px-4 py-3 rounded-xl bg-white border border-gray-200 focus:ring-2 focus:ring-black/5 focus:outline-none text-gray-900 placeholder:text-gray-400 text-sm transition-all"
                      required
                    />
                    <input
                      type="password"
                      value={authPassword}
                      onChange={(event) => setAuthPassword(event.target.value)}
                      placeholder={emailAuthMode === "signup" ? "Create password" : "Password"}
                      className="w-full px-4 py-3 rounded-xl bg-white border border-gray-200 focus:ring-2 focus:ring-black/5 focus:outline-none text-gray-900 placeholder:text-gray-400 text-sm transition-all"
                      required
                      minLength={emailAuthMode === "signup" ? 8 : undefined}
                    />
                    <div className="flex items-center gap-2">
                      <button
                        type="submit"
                        disabled={authLoading !== null}
                        className="px-4 py-2.5 rounded-xl bg-black hover:bg-gray-800 text-white text-xs font-semibold transition-all disabled:opacity-50"
                      >
                        {emailAuthMode === "signup"
                          ? authLoading === "email-signup"
                            ? "Creating..."
                            : "Create account"
                          : authLoading === "email-signin"
                            ? "Signing in..."
                            : "Sign in"}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setEmailAuthMode((prev) => (prev === "signup" ? "signin" : "signup"));
                          setAuthError(null);
                          setAuthNotice(null);
                        }}
                        className="text-xs text-gray-500 hover:text-gray-700 transition-colors"
                      >
                        {emailAuthMode === "signup"
                          ? "Have an account? Sign in"
                          : "Need an account? Sign up"}
                      </button>
                    </div>
                  </form>
                ) : null}
              </div>
            ) : null}

            <button
              onClick={() => setShowOwnProviderOptions((prev) => !prev)}
              className={accountSignInAvailable
                ? "w-full mb-2 flex flex-col items-center justify-center gap-0.5 text-[11px] uppercase tracking-[0.16em] text-gray-400 hover:text-gray-600 transition-colors"
                : "w-full mb-2 flex flex-col items-center justify-center gap-0.5 text-[11px] uppercase tracking-[0.16em] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] transition-colors"}
            >
              <span>Use your own provider</span>
              {ownProviderExpanded ? (
                <ChevronUp className="w-3.5 h-3.5" />
              ) : (
                <ChevronDown className="w-3.5 h-3.5" />
              )}
            </button>

            {ownProviderExpanded ? (
              <>
                <div className="space-y-2 mb-4">
                  {anthropicCodePending ? (
                    <div className="p-3 rounded-lg bg-black/[0.03]">
                      <p className="text-sm font-medium text-[var(--text-primary)] mb-1">Paste the code from your browser</p>
                      <p className="text-xs text-[var(--text-tertiary)] mb-3">After authorizing in your browser, copy the code and paste it below.</p>
                      <div className="flex gap-2">
                        <input
                          type="text"
                          value={anthropicCodeInput}
                          onChange={(e) => setAnthropicCodeInput(e.target.value)}
                          onKeyDown={(e) => { if (e.key === "Enter") submitAnthropicCode(); }}
                          placeholder="Paste code here..."
                          className="flex-1 px-3 py-2 text-sm rounded-lg border border-black/10 bg-white text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:ring-1 focus:ring-[var(--purple-accent)]"
                          autoFocus
                        />
                        <button
                          onClick={submitAnthropicCode}
                          disabled={!anthropicCodeInput.trim() || oauthLoading === "anthropic"}
                          className="px-4 py-2 text-sm font-medium rounded-lg bg-[var(--purple-accent)] text-white hover:opacity-90 disabled:opacity-40 transition-colors"
                        >
                          {oauthLoading === "anthropic" ? "..." : "Connect"}
                        </button>
                      </div>
                      <button
                        onClick={() => { setAnthropicCodePending(false); setAnthropicCodeInput(""); }}
                        className="mt-2 text-xs text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] transition-colors"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => connectWithOAuth("anthropic")}
                      disabled={oauthLoading !== null}
                      className="w-full flex items-center gap-4 p-3 rounded-lg text-left transition-colors bg-black/[0.03] hover:bg-black/[0.07] disabled:opacity-50"
                    >
                      <div className="w-9 h-9 rounded-md bg-[var(--purple-accent)]/10 flex items-center justify-center font-semibold text-[var(--purple-accent)]">
                        A
                      </div>
                      <div className="flex-1">
                        <p className="font-medium text-[var(--text-primary)]">Sign in with Claude</p>
                        <p className="text-xs text-[var(--text-tertiary)]">Use your existing subscription</p>
                      </div>
                      {oauthLoading === "anthropic" ? (
                        <Loader2 className="w-4 h-4 animate-spin text-[var(--text-tertiary)]" />
                      ) : (
                        <ExternalLink className="w-4 h-4 text-[var(--text-tertiary)]" />
                      )}
                    </button>
                  )}

                  <button
                    onClick={() => connectWithOAuth("openai")}
                    disabled={oauthLoading !== null}
                    className="w-full flex items-center gap-4 p-3 rounded-lg text-left transition-colors bg-black/[0.03] hover:bg-black/[0.07] disabled:opacity-50"
                  >
                    <div className="w-9 h-9 rounded-md bg-[var(--purple-accent)]/10 flex items-center justify-center font-semibold text-[var(--purple-accent)]">
                      O
                    </div>
                    <div className="flex-1">
                      <p className="font-medium text-[var(--text-primary)]">Sign in with OpenAI</p>
                      <p className="text-xs text-[var(--text-tertiary)]">Use your existing subscription</p>
                    </div>
                    {oauthLoading === "openai" ? (
                      <Loader2 className="w-4 h-4 animate-spin text-[var(--text-tertiary)]" />
                    ) : (
                      <ExternalLink className="w-4 h-4 text-[var(--text-tertiary)]" />
                    )}
                  </button>
                </div>

                <div className="flex items-center gap-3 my-4">
                  <div className="flex-1 h-px bg-black/10" />
                  <span className="text-xs text-[var(--text-tertiary)] font-medium">or use an API key</span>
                  <div className="flex-1 h-px bg-black/10" />
                </div>

                <div className="space-y-2">
                  {PROVIDERS.map(p => (
                    <button key={p.id} onClick={() => { setSelectedProvider(p); setShowKeyModal(true); }}
                      className="w-full flex items-center gap-4 p-3 rounded-lg text-left transition-colors hover:bg-black/5">
                      <div className="w-9 h-9 rounded-md bg-black/5 flex items-center justify-center font-semibold text-[var(--text-accent)]">
                        {p.icon}
                      </div>
                      <div className="flex-1">
                        <p className="font-medium text-[var(--text-primary)]">{p.name}</p>
                      </div>
                      <ExternalLink className="w-4 h-4 text-[var(--text-tertiary)]" />
                    </button>
                  ))}
                </div>
                <p className="text-xs mt-6 text-[var(--text-tertiary)]">Your credentials are stored locally and securely.</p>
              </>
            ) : null}
          </div>
        </div>
        {showKeyModal && selectedProvider && <ApiKeyModal />}
      </>
    );
  };

  const renderWelcome = () => {
    const userName = onboardingData?.userName || "there";
    const agentName = onboardingData?.agentName || "Joulie";
    const hasName = userName !== "there";
    const displayName = hasName ? userName : "My";
    const suggestions = buildSuggestions(displayName, hasName);

    return (
      <div className="h-full flex flex-col items-center justify-center p-6 text-center">
        <div className="max-w-2xl">
          <div className="w-16 h-16 rounded-2xl bg-[var(--purple-accent)] mx-auto flex items-center justify-center mb-6">
            <Sparkles className="w-8 h-8 text-white" />
          </div>
          <h2 className="text-2xl font-semibold mb-2 text-[var(--text-primary)]">
            Hello {userName}, I am {agentName}
          </h2>
          <p className="text-[var(--text-secondary)] mb-8">
            What would you like me to help you with?
          </p>
          <div className="flex flex-wrap justify-center gap-3">
            {suggestions.map((suggestion, index) => (
              <SuggestionChip
                key={index}
                icon={suggestion.icon}
                label={suggestion.label}
                action={suggestion.action}
                onClick={handleSuggestionClick}
              />
            ))}
          </div>
        </div>
      </div>
    );
  };

  const ApiKeyModal = () => (
    <div className="fixed inset-0 bg-black/20 flex items-center justify-center z-50"
      onClick={() => setShowKeyModal(false)}>
      <div className="bg-white p-6 w-full max-w-md m-4 rounded-2xl shadow-xl border border-[var(--border-subtle)]" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-[var(--text-primary)]">Connect {selectedProvider?.name}</h3>
          <button onClick={() => setShowKeyModal(false)} className="p-1 text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"><X className="w-5 h-5" /></button>
        </div>
        <div className="mb-4 p-4 rounded-lg bg-black/5">
          <p className="text-sm font-medium mb-2 text-[var(--text-secondary)]">Step 1: Get your API key</p>
          <button onClick={() => open(selectedProvider!.keyUrl)} className="btn-secondary w-full justify-center">
            <ExternalLink className="w-4 h-4 mr-2" /> Open {selectedProvider?.name} Console
          </button>
        </div>
        <div className="mb-4">
          <p className="text-sm font-medium mb-2 text-[var(--text-secondary)]">Step 2: Paste your key</p>
          <input type="password" value={keyInput} onChange={e => setKeyInput(e.target.value)}
            placeholder={selectedProvider?.placeholder} className="form-input"
            onKeyDown={e => e.key === 'Enter' && connectWithKey()} />
        </div>
        <div className="flex gap-3">
          <button onClick={() => setShowKeyModal(false)} className="btn-secondary flex-1">Cancel</button>
          <button onClick={connectWithKey} disabled={!keyInput.trim()} className="btn-primary flex-1">Connect</button>
        </div>
      </div>
    </div>
  );

  async function connectWithKey() {
    if (!selectedProvider || !keyInput.trim()) return;
    try {
      const provider = selectedProvider.id;
      await invoke("set_api_key", {
        provider,
        key: keyInput.trim(),
      });
      await invoke("set_active_provider", { provider });
      setConnectedProvider(provider);
      setKeyInput("");
      setShowKeyModal(false);
      if (gatewayRunning) {
        await invoke("restart_gateway", { model: selectedModel });
      } else {
        await invoke("start_gateway", { model: selectedModel });
      }
    } catch (e) {
      console.error("Failed to set API key:", e);
      setError("Failed to save API key");
    }
  }

  async function connectWithOAuth(provider: "anthropic" | "openai") {
    setOauthLoading(provider);
    setError(null);
    try {
      if (provider === "anthropic") {
        // Phase 1: Open browser — user copies code from Anthropic's page
        await invoke("start_anthropic_oauth");
        setAnthropicCodePending(true);
        setAnthropicCodeInput("");
        setOauthLoading(null);
        return;
      }
      // OpenAI: single-step localhost callback
      await invoke<{ access_token: string; provider: string }>("start_openai_oauth");
      setConnectedProvider(provider);
      if (gatewayRunning) {
        await invoke("restart_gateway", { model: selectedModel });
      } else {
        await invoke("start_gateway", { model: selectedModel });
      }
    } catch (e) {
      console.error(`OAuth login failed for ${provider}:`, e);
      setError(typeof e === "string" ? e : `OAuth login failed`);
    } finally {
      setOauthLoading(null);
    }
  }

  async function submitAnthropicCode() {
    if (!anthropicCodeInput.trim()) return;
    setOauthLoading("anthropic");
    setError(null);
    try {
      await invoke<{ access_token: string; provider: string }>("complete_anthropic_oauth", {
        codeState: anthropicCodeInput.trim(),
      });
      setAnthropicCodePending(false);
      setAnthropicCodeInput("");
      setConnectedProvider("anthropic");
      if (gatewayRunning) {
        await invoke("restart_gateway", { model: selectedModel });
      } else {
        await invoke("start_gateway", { model: selectedModel });
      }
    } catch (e) {
      console.error("Anthropic OAuth code exchange failed:", e);
      setError(typeof e === "string" ? e : "Failed to exchange authorization code");
    } finally {
      setOauthLoading(null);
    }
  }

  if (isConnecting) return renderConnecting();
  if (localTrialLoading) return renderConnecting();
  if (!connectedProvider && !proxyEnabled) return renderNoProvider();
  const autoStartExpected = proxyEnabled && !gatewayRunning;
  const activeDraft = currentSession ? (draftsBySession[currentSession] || "") : "";
  const showBillingAction = Boolean(error && isBillingIssueMessage(error));
  const showSignInAction = Boolean(
    error && isBillingIssueMessage(error) && !isAuthenticated && isAuthConfigured
  );

  // Main Chat UI
  return (
    <div className="h-full flex flex-col bg-transparent" onDragOver={e => { e.preventDefault(); setDragActive(true); }}
      onDragLeave={() => setDragActive(false)} onDrop={e => { e.preventDefault(); setDragActive(false); }}>

      {/* Header */}
      <div className="flex-shrink-0" style={{
          background: 'rgba(255,255,255,0.8)',
          borderBottom: '1px solid var(--border-subtle)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)'
        }}>
        <div className="flex items-center justify-between px-3 py-1.5">
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <span className="text-[12px] font-bold text-[var(--text-primary)] truncate max-w-[150px]">
              {currentSession ? sessionTitle(sessions.find(s => s.key === currentSession) || { key: currentSession }) : "New Chat"}
            </span>
          </div>
        {onModelChange && (
          <ModelSelector selectedModel={selectedModel} onModelChange={onModelChange} compact useLocalKeys={useLocalKeys} connectedProviders={useLocalKeys ? connectedProviders : undefined} />
        )}
        <div className="flex items-center gap-3 px-2">
          <div className="flex items-center gap-1.5">
            <div className={`w-1.5 h-1.5 rounded-full ${
              connected ? 'bg-green-500' : (gatewayStarting || isConnecting) ? 'bg-amber-400' : 'bg-gray-300'
            }`} />
            <span className="text-[10px] font-medium text-[var(--text-tertiary)] uppercase tracking-tight">
              {connected
                ? "Connected"
                : gatewayStarting
                  ? "Starting"
                  : "Offline"}
            </span>
          </div>
          {integrationsSyncing ? (
            <span className="text-[10px] font-medium text-[var(--text-tertiary)] flex items-center gap-1 animate-pulse">
              <Loader2 className="w-2.5 h-2.5 animate-spin" />
              Syncing
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowDiagnostics(true)}
            className="px-2 py-1 rounded-md bg-[var(--system-gray-6)] hover:bg-[var(--system-gray-5)] text-[10px] font-bold text-[var(--text-secondary)] transition-colors"
            title="Gateway diagnostics"
          >
            Diag
          </button>
        </div>
      </div>
    </div>

      {(gatewayStarting || autoStartExpected) && (
        <div className="p-2 text-center text-sm bg-amber-500/10 text-amber-600">
          {gatewayRetryIn
            ? `Gateway reconnecting — retrying in ${gatewayRetryIn}s.`
            : "Gateway starting…"}
        </div>
      )}

      {integrationsMissing && !integrationsSyncing && (
        <div className="p-2 text-center text-sm bg-amber-500/10 text-amber-700">
          Integrations need reconnect — open Plugins to reconnect Google Calendar/Gmail.
        </div>
      )}

      {!gatewayRunning && !gatewayStarting && !autoStartExpected && (
        <div className="p-2 text-center text-sm bg-amber-500/10 text-amber-600 flex items-center justify-center gap-3">
          <span>Gateway offline — start the sandbox to chat.</span>
          {onStartGateway && (
            <button
              onClick={onStartGateway}
              className="btn-primary !py-1 !px-3 text-xs"
            >
              Start Gateway
            </button>
          )}
        </div>
      )}

      {/* Error Banner */}
      {!gatewayStarting && error && (
        <div className="p-2 text-center text-sm bg-red-500/10 text-red-500">
          <div className="flex items-center justify-center gap-3 flex-wrap">
            <span>{error}</span>
            {showSignInAction && (
              <button
                onClick={requestSignIn}
                className="btn-primary !py-1 !px-3 text-xs"
              >
                Sign In
              </button>
            )}
            {showBillingAction && onNavigate && (
              <button
                onClick={() => onNavigate("billing")}
                className="btn-primary !py-1 !px-3 text-xs"
              >
                {isAuthenticated ? "Add Credits" : "Billing"}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Messages or Welcome */}
      <div className="flex-1 p-4 overflow-auto">
        <div className="max-w-3xl mx-auto space-y-4">
          {messages.length === 0 && showWelcome ? (
            renderWelcome()
          ) : messages.length === 0 ? (
            <div className="h-full flex items-center justify-center text-center text-[var(--text-tertiary)]">
              <div>
                <Sparkles className="w-8 h-8 mx-auto mb-2 opacity-50" />
                <p>Start a conversation</p>
              </div>
            </div>
          ) : null}
          {messages.map(msg => {
            const normalizedUser = msg.role === "user" ? normalizeUserContent(msg.content, msg.sentAt) : null;
            const assistantPayload = msg.role === "assistant"
              ? {
                  cleanText: msg.content,
                  events: msg.assistantPayload?.events ?? [],
                  errors: msg.assistantPayload?.errors ?? [],
                  hadToolPayload: msg.assistantPayload?.hadToolPayload ?? false,
                }
              : null;
            const bodyContent = msg.role === "user" ? normalizedUser?.content ?? "" : msg.content;
            const messageTime = formatMessageTime(msg.role === "user" ? normalizedUser?.sentAt : msg.sentAt);
            if (msg.role === "user" && !bodyContent) {
              return null;
            }
            return (
              <div key={msg.id} className={clsx("flex", msg.role === "user" ? "justify-end" : "justify-start")}>
                <div className={clsx("max-w-[85%]")}>
                  <div className={clsx("px-4 py-2.5 rounded-2xl",
                    msg.role === "user" ? "bg-[var(--purple-accent)] text-white" : "bg-[var(--bg-tertiary)] text-[var(--text-primary)]")}>
                    {msg.role === "assistant" ? renderAssistantContent(msg) : <p className="whitespace-pre-wrap">{bodyContent}</p>}
                  </div>
                  {messageTime ? (
                    <div
                      className={clsx(
                        "mt-1 px-1 text-[11px] text-[var(--text-tertiary)]",
                        msg.role === "user" ? "text-right" : "text-left"
                      )}
                    >
                      {messageTime}
                    </div>
                  ) : null}
                </div>
              </div>
            );
          })}
          {isLoading && (
            <div className="flex justify-start">
              <div className="px-4 py-2.5 rounded-2xl bg-[var(--bg-tertiary)] flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin text-[var(--text-tertiary)]" />
                <span className="text-sm text-[var(--text-secondary)] animate-pulse">
                  {thinkingStatus || "Thinking"}
                </span>
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Input Area */}
      <div className="flex-shrink-0 p-4" style={{
          background: 'var(--glass-bg)',
          borderTop: '1px solid var(--glass-border-subtle)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)'
        }}>
        <div className="max-w-3xl mx-auto flex items-end gap-2">
          <textarea
            ref={textareaRef}
            value={activeDraft}
            onFocus={() => {
              ensureComposerSession();
            }}
            onChange={e => {
              const sessionKey = currentSession || ensureComposerSession();
              if (!sessionKey) return;
              const nextValue = e.target.value;
              setDraftsBySession((prev) => {
                if ((prev[sessionKey] || "") === nextValue) return prev;
                return { ...prev, [sessionKey]: nextValue };
              });
            }}
            onKeyDown={e => {if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }}}
            placeholder="Message your assistant..." rows={1}
            className="form-input flex-1 resize-none leading-tight"
          />
          <button onClick={() => handleSend()} disabled={!activeDraft.trim() || isLoading} className="btn-primary !p-2.5 !bg-[var(--purple-accent)] hover:!bg-purple-700 text-white"><Send className="w-5 h-5" /></button>
        </div>
        {dragActive && (
          <div className="absolute inset-0 bg-black/10 border-2 border-dashed border-white/50 flex items-center justify-center font-medium text-white">
            Drop files to attach
          </div>
        )}
      </div>

      {/* Channel Setup Modal */}
      <ChannelSetupModal
        channel={channelModal.channel}
        isOpen={channelModal.isOpen}
        onClose={() => setChannelModal({ ...channelModal, isOpen: false })}
        onSetupComplete={handleChannelSetupComplete}
      />

      {showDiagnostics && (
        <div className="fixed inset-0 bg-black/20 flex items-center justify-center z-50"
          onClick={() => setShowDiagnostics(false)}>
          <div className="bg-white p-6 w-full max-w-2xl m-4 rounded-2xl shadow-xl border border-[var(--border-subtle)]" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-[var(--text-primary)]">Gateway Diagnostics</h3>
              <button onClick={() => setShowDiagnostics(false)} className="p-1 text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"><X className="w-5 h-5" /></button>
            </div>
            <div className="grid grid-cols-2 gap-3 text-sm mb-4">
              <div className="bg-[var(--bg-tertiary)] p-3 rounded-xl border border-[var(--border-subtle)]">
                <p className="text-[var(--text-tertiary)]">Gateway URL</p>
                <p className="text-[var(--text-primary)] break-all">{gatewayUrl}</p>
              </div>
              <div className="bg-[var(--bg-tertiary)] p-3 rounded-xl border border-[var(--border-subtle)]">
                <p className="text-[var(--text-tertiary)]">Proxy Enabled</p>
                <p className="text-[var(--text-primary)]">{proxyEnabled ? "true" : "false"}</p>
              </div>
              <div className="bg-[var(--bg-tertiary)] p-3 rounded-xl border border-[var(--border-subtle)]">
                <p className="text-[var(--text-tertiary)]">Connected Provider</p>
                <p className="text-[var(--text-primary)]">{connectedProvider || "—"}</p>
              </div>
              <div className="bg-[var(--bg-tertiary)] p-3 rounded-xl border border-[var(--border-subtle)]">
                <p className="text-[var(--text-tertiary)]">Connected</p>
                <p className="text-[var(--text-primary)]">{connected ? "true" : "false"}</p>
              </div>
              <div className="bg-[var(--bg-tertiary)] p-3 rounded-xl border border-[var(--border-subtle)]">
                <p className="text-[var(--text-tertiary)]">Last Send</p>
                <p className="text-[var(--text-primary)] break-all">{lastSendId || "—"}</p>
                <p className="text-xs text-[var(--text-tertiary)]">
                  {lastSendAt ? new Date(lastSendAt).toLocaleTimeString() : "—"}
                </p>
              </div>
              <div className="bg-[var(--bg-tertiary)] p-3 rounded-xl border border-[var(--border-subtle)]">
                <p className="text-[var(--text-tertiary)]">Last Gateway Error</p>
                <p className="text-[var(--text-primary)] break-all">{lastGatewayError || "—"}</p>
              </div>
              <div className="bg-[var(--bg-tertiary)] p-3 rounded-xl border border-[var(--border-subtle)]">
                <p className="text-[var(--text-tertiary)]">Last Chat Event</p>
                <p className="text-[var(--text-primary)] break-all">{lastChatEvent?.state || "—"}</p>
              </div>
            </div>
            <div className="bg-[var(--bg-tertiary)] p-3 rounded-xl border border-[var(--border-subtle)] max-h-64 overflow-auto text-xs font-mono whitespace-pre-wrap">
              {diagLogs.length ? diagLogs.join("\n") : "No diagnostics yet."}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
