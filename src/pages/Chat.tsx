import { useState, useRef, useEffect, useCallback, useMemo, type ComponentType, type FormEvent, type ReactNode } from "react";
import {
  Send,
  Paperclip,
  Copy,
  Check,
  Sparkles,
  Image as ImageIcon,
  Download,
  X,
  Loader2,
  ExternalLink,
  Calendar,
  Mail,
  Globe,
  Activity,
  TrendingUp,
  Terminal,
  ChevronDown,
  ChevronUp,
  Bot,
  Puzzle,
  User,
  FileText,
  FileSpreadsheet,
  Presentation,
  Music2,
  Mic,
  Square,
} from "lucide-react";
import { open } from "@tauri-apps/plugin-shell";
import { invoke } from "@tauri-apps/api/core";
import clsx from "clsx";
import {
  GatewayClient,
  GatewayError,
  createGatewayClient,
  type ChatEvent,
  type AgentEvent,
  type GatewayMessage,
} from "../lib/gateway";
import {
  isRenderableAvatarDataUrl,
  loadOnboardingData,
  loadProfile,
  sanitizeProfileName,
  saveProfile,
  type OnboardingData,
  type AgentProfile,
} from "../lib/profile";
import { SuggestionChip, type SuggestionAction } from "../components/SuggestionChip";
import { TelegramSetupModal } from "../components/TelegramSetupModal";
import { MarkdownContent } from "../components/MarkdownContent";
import { AgentAvatar } from "../components/AgentAvatar";
import { useAuth } from "../contexts/AuthContext";
import { apiRequest } from "../lib/auth";
import {
  syncAllIntegrationsToGateway,
  getCachedIntegrationProviders,
  getIntegrations,
  connectIntegration,
  type HostedIntegrationPermissionProfile,
  type IntegrationProvider,
} from "../lib/integrations";
import {
  getVisibleQuickActions,
  getQuickActionById,
  getTaskPresetLabel,
  getScheduleForTaskPreset,
  type AgentQuickActionDefinition,
  type ChatQuickActionIcon,
  type IntegrationQuickActionRequirement,
  type SuggestionTaskPreset,
} from "../lib/chatQuickActions";
import {
  extractWorkspaceOfficeFileName,
  formatWorkspaceOfficeRoutingPrompt,
  shouldRouteWorkspaceOfficeRequest,
  workspaceOfficeRequestWantsDesktopOpen,
} from "../lib/chatOfficeRouting";
import {
  addTaskBoardItem,
  formatTaskBoardOwnerLabel,
  formatTaskBoardStatusLabel,
  parseTaskBoardChatIntent,
  type TaskBoardChatIntent,
} from "../lib/taskBoard";
import { resolveGatewayAuth } from "../lib/gateway-auth";
import { clientLog } from "../lib/clientLog";
import { appendDiagnosticLog } from "../lib/diagnostics";
import { entropicSitePath } from "../lib/buildProfile";
import { Store as TauriStore } from "@tauri-apps/plugin-store";
import { getLocalCreditBalance } from "../lib/localCredits";
import { signInWithDiscord, signInWithEmail, signInWithGoogle, signUpWithEmail, createCheckout, getBalance } from "../lib/auth";
import entropicLogo from "../assets/entropic-logo.png";
import asanaLogo from "../assets/integrations/asana.svg";
import gmailAssetLogo from "../assets/integrations/gmail.svg";
import googleCalendarAssetLogo from "../assets/integrations/google-calendar.svg";
import googleDriveLogo from "../assets/integrations/google-drive.svg";
import googleSheetsLogo from "../assets/integrations/google-sheets.svg";
import microsoftTeamsLogo from "../assets/integrations/microsoft-teams.svg";
import oneDriveLogo from "../assets/integrations/onedrive.svg";
import outlookLogo from "../assets/integrations/outlook.svg";
import type { Page } from "../components/Layout";
import {
  type Message,
  type MessageAttachment,
  type CalendarEvent,
  type ToolError,
  type TerminalCommandResult,
  type AssistantPayload,
  type ChatSession,
  INTERNAL_USER_PROMPT_PREFIX,
  CHANNEL_SESSION_KEY_MARKERS,
  UI_SESSION_KEY_RE,
  BILLING_RECOVERY_MESSAGE,
  parseRunSlashCommand,
  extractJsonBlocks,
  isToolTransportPayload,
  stripExternalUntrustedSections,
  sanitizeAuthStoreDetails,
  isBillingIssueMessage,
  isPolicyMessageRemovedError,
  isContainerRestartingError,
  sanitizeGatewayErrorMessage,
  formatAssistantErrorTextForUi,
  extractAssistantErrorFromGatewayMessage,
  parseToolPayloads,
  stripConversationMetadata,
  stripInlineClawdbotMetadata,
  stripOpenClawStatusLines,
  sanitizeAssistantDisplayContent,
  buildAssistantPayload,
  normalizeCachedMessage,
  parseUtcBracketTimestamp,
  toTimestampMs,
  extractMessageTimestamp,
  normalizeUserContent,
  summarizeSessionTitleFromMessages,
  isGenericConversationTitle,
  titleDedupKey,
  sessionTitleHint,
  formatMessageTime,
  formatEventRange,
  extractMessageText,
  isChannelOrSystemSessionKey,
  shouldDisplayGatewaySession,
  isChannelOriginGatewayMessage,
  normalizeGatewayMessage,
} from "../lib/chatMessageUtils";
import {
  recordedAudioHasDetectedSpeech,
  useAudioRecorder,
  type RecordedAudioAttachment,
} from "../desktop/voice/useAudioRecorder";
import {
  cleanRecordedVoiceTranscript,
  useAudioTranscription,
} from "../desktop/voice/useAudioTranscription";
import { useLiveSpeechRecognition } from "../desktop/voice/useLiveSpeechRecognition";
import { useStreamingAudioTranscription } from "../desktop/voice/useStreamingAudioTranscription";
import { useTextToSpeech } from "../desktop/voice/useTextToSpeech";
import {
  DEFAULT_VOICE_SPEECH_RATE,
  DEFAULT_VOICE_SPEECH_VOICE,
  normalizeVoiceSpeechRate,
  normalizeVoiceSpeechVoice,
  voiceIdForSpeechProvider,
  type VoiceSpeechVoice,
} from "../desktop/voice/voicePreferences";
import { DEFAULT_AGENT_NAME } from "../lib/agentDefaults";

type GatewayMutationResult = {
  plan: "noop" | "config_reload" | "container_restart" | "container_recreate";
};

export type { ChatSession };
export type ChatSessionActionRequest =
  | { id: string; type: "delete"; key: string }
  | { id: string; type: "pin"; key: string; pinned: boolean }
  | { id: string; type: "rename"; key: string; label: string }
  | { id: string; type: "compose"; key?: string; prompt: string; submit?: boolean; speakResponse?: boolean };
type Provider = { id: string; name: string; icon: string; placeholder: string; keyUrl: string };
type PendingAttachment = {
  id: string;
  fileName: string;
  mimeType: string;
  content: string;
  previewUrl?: string;
};
type AuthState = { active_provider: string | null; providers: Array<{ id: string; has_key: boolean }> };
type WorkspaceChatReference = {
  key: string;
  path: string;
  name: string;
  isHtml: boolean;
  looksLikeFile: boolean;
  cloudSource?: {
    provider: "onedrive";
    webUrl?: string;
    itemPath: string;
  };
};
type DesktopHandoff = {
  path?: string;
  url?: string;
  action: "open" | "preview" | "browser";
  looksLikeFile?: boolean;
};
type ComposerMode = "chat" | "shell" | "image";
type ChatTerminalState = {
  cwd: string;
};
type ChatTerminalRunResponse = {
  stdout: string;
  stderr: string;
  exit_code: number | null;
  cwd: string;
};
type ChatImageGenerationResponse = {
  text: string;
  images: Array<{
    file_name: string;
    mime_type: string;
    url: string;
  }>;
};

const DESKTOP_HANDOFF_STORAGE_KEY = "entropic.desktop.handoff";
const DESKTOP_HANDOFF_EVENT = "entropic-desktop-handoff";
const TERMINAL_DEFAULT_CWD = "/data/workspace";
const DEFAULT_COMPOSER_MODE: ComposerMode = "chat";
const CHAT_WORKSPACE_PREFIXES = [
  "/data/.openclaw/workspace",
  "/data/workspace",
  "/home/node/.openclaw/workspace",
];
const CHAT_WORKSPACE_PATH_RE = /((?:\/data\/(?:\.openclaw\/)?workspace|\/home\/node\/\.openclaw\/workspace)(?:\/[^\s`"'<>]+)?)/g;
const CHAT_OFFICE_FILENAME_RE = /(^|[\s`"'([])([A-Za-z0-9][A-Za-z0-9._-]*\.(?:docx|xlsx|pptx))(?=$|[\s`"')\],:;.!?])/gi;
const ONEDRIVE_URL_RE = /https:\/\/(?:[^\s`"'<>)]*\.)?(?:onedrive\.live\.com|1drv\.ms)[^\s`"'<>)]*/gi;
const FINAL_RESPONSE_RECOVERY_RETRY_MS = 1200;
const FINAL_RESPONSE_RECOVERY_MAX_ATTEMPTS = 2;
const MAX_VOICE_RESPONSE_SPEECH_CHARS = 1800;
const VOICE_TTS_MIN_STREAM_CHARS = 18;
const VOICE_TTS_MAX_STREAM_CHARS = 360;

type VoiceSpeechChunk = {
  sequence: number;
  text: string;
  source: "delta" | "final_event" | "history";
};

type VoiceSpeechRunState = {
  lastSourceText: string;
  pendingText: string;
  queue: VoiceSpeechChunk[];
  processing: boolean;
  final: boolean;
  started: boolean;
  notified: boolean;
  sequence: number;
  queuedAny: boolean;
};

function formatAssistantResponseForSpeech(text: string): string {
  const normalized = text
    .replace(/```[\s\S]*?```/g, "Code block omitted.")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}[-*+]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length <= MAX_VOICE_RESPONSE_SPEECH_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_VOICE_RESPONSE_SPEECH_CHARS).trim()}...`;
}

function audioDataUrlFromBase64(base64: string, mimeType?: string | null): string {
  return `data:${mimeType?.trim() || "audio/mpeg"};base64,${base64.trim()}`;
}

function findVoiceSpeechBoundary(text: string): number {
  const limit = Math.min(text.length, VOICE_TTS_MAX_STREAM_CHARS);
  let newlineBoundary = -1;
  for (let index = 0; index < limit; index += 1) {
    const char = text[index];
    const next = text[index + 1] || "";
    const candidateLength = text.slice(0, index + 1).trim().length;
    if (char === "\n" && candidateLength >= VOICE_TTS_MIN_STREAM_CHARS) {
      newlineBoundary = index + 1;
    }
    if (
      (char === "." || char === "!" || char === "?") &&
      candidateLength >= VOICE_TTS_MIN_STREAM_CHARS &&
      (!next || /\s/.test(next))
    ) {
      return index + 1;
    }
  }

  if (newlineBoundary >= 0) return newlineBoundary;
  if (text.length <= VOICE_TTS_MAX_STREAM_CHARS) return -1;

  const hardLimit = Math.min(text.length, VOICE_TTS_MAX_STREAM_CHARS);
  for (let index = hardLimit; index >= VOICE_TTS_MIN_STREAM_CHARS; index -= 1) {
    if (/\s/.test(text[index] || "")) {
      return index + 1;
    }
  }
  return hardLimit;
}

function splitVoiceSpeechBuffer(
  buffer: string,
  final: boolean,
): { chunks: string[]; rest: string } {
  const chunks: string[] = [];
  let rest = buffer;

  while (rest.trim()) {
    const boundary = findVoiceSpeechBoundary(rest);
    if (boundary < 0) break;
    const chunk = rest.slice(0, boundary).trim();
    rest = rest.slice(boundary).trimStart();
    if (chunk) chunks.push(chunk);
  }

  if (final && rest.trim()) {
    chunks.push(rest.trim());
    rest = "";
  }

  return { chunks, rest };
}

function trimChatWorkspaceToken(raw: string): string {
  return raw
    .replace(/^[("'`\[]+/, "")
    .replace(/[)"'`\],:;.!?]+$/, "");
}

function normalizeChatWorkspacePath(raw: string): string | null {
  const trimmed = trimChatWorkspaceToken(raw.trim());
  for (const prefix of CHAT_WORKSPACE_PREFIXES) {
    if (trimmed === prefix) {
      return "";
    }
    if (trimmed.startsWith(`${prefix}/`)) {
      return trimmed.slice(prefix.length + 1);
    }
  }
  return null;
}

function workspacePathName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] || "Workspace";
}

function workspacePathExtension(path: string): string {
  return workspacePathName(path).split(".").pop()?.toLowerCase() || "";
}

function officeWorkspaceFileMeta(path: string):
  | { kind: "docs"; label: "Word document"; appLabel: "Docs"; Icon: ComponentType<{ className?: string }>; accent: string }
  | { kind: "sheets"; label: "Excel workbook"; appLabel: "Sheets"; Icon: ComponentType<{ className?: string }>; accent: string }
  | { kind: "slides"; label: "PowerPoint presentation"; appLabel: "Slides"; Icon: ComponentType<{ className?: string }>; accent: string }
  | null {
  const ext = workspacePathExtension(path);
  if (ext === "docx") {
    return { kind: "docs", label: "Word document", appLabel: "Docs", Icon: FileText, accent: "#2563EB" };
  }
  if (ext === "xlsx") {
    return { kind: "sheets", label: "Excel workbook", appLabel: "Sheets", Icon: FileSpreadsheet, accent: "#16A34A" };
  }
  if (ext === "pptx") {
    return { kind: "slides", label: "PowerPoint presentation", appLabel: "Slides", Icon: Presentation, accent: "#EA580C" };
  }
  return null;
}

function isTransientGatewayConnectCloseMessage(raw?: string | null): boolean {
  const message = (raw || "").trim();
  if (!message) return false;
  return /gateway socket closed during connect/i.test(message);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function buildNoVisibleResponseMessage(params: {
  lastGatewayError?: string | null;
  connected: boolean;
}): string {
  const lastGatewayError = params.lastGatewayError || "";
  const normalized = sanitizeGatewayErrorMessage(lastGatewayError);
  if (
    /conversation history path was invalid/i.test(normalized) ||
    /session file path must be within sessions directory/i.test(lastGatewayError)
  ) {
    return "The conversation history path was invalid. Restart the sandbox and retry.";
  }
  if (
    !params.connected ||
    isTransientGatewayConnectCloseMessage(lastGatewayError) ||
    /connection lost while waiting for response/i.test(normalized)
  ) {
    return "The response was interrupted while the sandbox was reconnecting. Please retry.";
  }
  return "The assistant finished without a visible reply. Retry once; if it keeps happening, check Billing, auth, and network.";
}

function trimUrlToken(raw: string): string {
  return raw.replace(/[)\],:;.!?]+$/, "");
}

function findOneDriveUrlNearFile(content: string, filename: string): string | null {
  let searchFrom = 0;
  while (searchFrom < content.length) {
    const index = content.indexOf(filename, searchFrom);
    if (index < 0) return null;
    const nearby = content.slice(index + filename.length, index + filename.length + 900);
    ONEDRIVE_URL_RE.lastIndex = 0;
    const match = ONEDRIVE_URL_RE.exec(nearby);
    if (match?.[0]) {
      return trimUrlToken(match[0]);
    }
    searchFrom = index + filename.length;
  }
  return null;
}

function extractWorkspaceChatReferences(content: string): WorkspaceChatReference[] {
  const refs: WorkspaceChatReference[] = [];
  const seen = new Set<string>();

  const pushReference = (path: string, cloudSource?: WorkspaceChatReference["cloudSource"]) => {
    const name = workspacePathName(path);
    const ext = name.split(".").pop()?.toLowerCase() || "";
    const ref: WorkspaceChatReference = {
      key: path || "__workspace__",
      path,
      name,
      isHtml: ext === "html" || ext === "htm",
      looksLikeFile: Boolean(path) && name.includes("."),
      ...(cloudSource ? { cloudSource } : {}),
    };
    if (seen.has(ref.key)) return;
    seen.add(ref.key);
    refs.push(ref);
  };

  for (const match of content.matchAll(CHAT_WORKSPACE_PATH_RE)) {
    const path = normalizeChatWorkspacePath(match[1] || "");
    if (path === null) continue;
    pushReference(path);
  }

  for (const match of content.matchAll(CHAT_OFFICE_FILENAME_RE)) {
    const filename = trimChatWorkspaceToken(match[2] || "");
    if (!filename || filename.includes("/")) continue;
    const oneDriveUrl = findOneDriveUrlNearFile(content, filename);
    pushReference(
      filename,
      oneDriveUrl
        ? {
            provider: "onedrive",
            webUrl: oneDriveUrl,
            itemPath: filename,
          }
        : undefined
    );
  }

  return refs;
}

// OAuth icons imported from shared component
import { GoogleIcon, DiscordIcon } from "../components/OAuthIcons";

function GoogleCalendarLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path fill="#4285F4" d="M19 4h-1V2h-2v2H8V2H6v2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 16H5V9h14v11z" />
      <path fill="#FBBC05" d="M5 20h14v2H5z" />
      <path fill="#34A853" d="M19 4h2v5h-2z" />
      <path fill="#EA4335" d="M5 4h2v5H5z" />
    </svg>
  );
}

function GmailLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path fill="#EA4335" d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4V8l8 5 8-5v10zm-8-7L4 6h16l-8 5z" />
    </svg>
  );
}

function XLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path
        fill="currentColor"
        d="M18.9 3H22l-6.8 7.8L23 21h-6.2l-4.9-6.1L6.6 21H3.5l7.3-8.3L1 3h6.3l4.4 5.6L18.9 3zm-1.1 16h1.7L7.5 4.9H5.7L17.8 19z"
      />
    </svg>
  );
}

function brandAssetLogo(src: string, alt: string): ComponentType<{ className?: string }> {
  const Logo = ({ className }: { className?: string }) => (
    <img src={src} alt={alt} className={className} draggable={false} />
  );
  Logo.displayName = `BrandAssetLogo(${alt})`;
  return Logo;
}

// ── Local chat persistence ─────────────────────────────────────
const CHAT_STORE_FILE = "entropic-chat-history.json";
const MAX_PERSISTED_SESSIONS = 50;
const MAX_PERSISTED_MESSAGES = 1000;
const MAX_PERSISTED_OUTBOX = 16;

type PersistedPendingSendAttachment = {
  fileName?: string;
  mimeType?: string;
  content?: string;
};

type PersistedPendingSend = {
  id: string;
  sessionKey: string;
  outboundMessageContent: string;
  routingContent: string;
  attachments: PersistedPendingSendAttachment[];
  idempotencyKey: string;
  createdAt: number;
  attemptCount: number;
  nextAttemptAt: number;
};

type PersistedChatData = {
  sessions: ChatSession[];
  messages: Record<string, Message[]>; // sessionKey -> messages
  drafts: Record<string, string>; // sessionKey -> unsent draft
  shellDrafts: Record<string, string>;
  imageDrafts: Record<string, string>;
  composerModeBySession: Record<string, ComposerMode>;
  terminalBySession: Record<string, ChatTerminalState>;
  currentSession: string | null;
  outbox: PersistedPendingSend[];
};

type ChatToolActivityStatus = "running" | "complete" | "error";

type ChatToolActivity = {
  id: string;
  name: string;
  label: string;
  status: ChatToolActivityStatus;
  detail?: string;
  input?: Record<string, unknown>;
  result?: Record<string, unknown>;
  resultSummary?: string;
  query?: string;
  url?: string;
  links?: Array<{ title?: string; url: string; domain?: string }>;
  seq: number;
  ts: number;
};

function extractApprovalCommand(text: string): string | null {
  const match = text.match(/(?:^|\n|\s)(\/approve\s+[A-Za-z0-9_-]+\s+(?:allow-once|allow-always|deny))(?:\s|$)/i);
  return match?.[1]?.trim() ?? null;
}

function approvalCommandLabel(command: string): string {
  if (/\ballow-always\b/i.test(command)) return "Approve always";
  if (/\bdeny\b/i.test(command)) return "Deny";
  return "Approve once";
}

const SETTINGS_PROFILE_REQUEST_EVENT = "entropic-settings-open-profile";
const SETTINGS_PROFILE_REQUEST_KEY = "entropic.settings.requestedSection";

const THINKING_WORDS = [
  "Thinking",
  "Reasoning",
  "Synthesizing",
  "Mapping",
  "Parsing",
  "Weighing",
  "Composing",
  "Drafting",
  "Inspecting",
  "Solving",
  "Planning",
  "Tracing",
  "Checking",
  "Refining",
  "Structuring",
  "Connecting",
  "Searching",
  "Reading",
  "Calculating",
  "Evaluating",
  "Designing",
  "Building",
  "Testing",
  "Verifying",
  "Aligning",
  "Debugging",
  "Organizing",
  "Clarifying",
  "Comparing",
  "Integrating",
  "Sequencing",
  "Modeling",
  "Projecting",
  "Exploring",
  "Distilling",
  "Interpreting",
  "Reframing",
  "Balancing",
  "Prioritizing",
  "Simulating",
  "Navigating",
  "Scanning",
  "Reviewing",
  "Assembling",
  "Optimizing",
  "Polishing",
  "Resolving",
  "Translating",
  "Summarizing",
  "Generating",
  "Coordinating",
  "Validating",
  "Triaging",
  "Investigating",
  "Unpacking",
  "Filtering",
  "Ranking",
  "Selecting",
  "Expanding",
  "Condensing",
  "Calibrating",
  "Inferring",
  "Contextualizing",
  "Grounding",
  "Focusing",
  "Sharpening",
  "Iterating",
  "Routing",
  "Synchronizing",
  "Preparing",
  "Forming",
  "Linking",
  "Measuring",
  "Rendering",
  "Updating",
  "Adapting",
  "Tuning",
  "Compressing",
  "Indexing",
  "Sampling",
  "Estimating",
  "Scheduling",
  "Threading",
  "Merging",
  "Sorting",
  "Staging",
  "Cataloging",
  "Fetching",
  "Querying",
  "Crosschecking",
  "Harmonizing",
  "Orchestrating",
  "Reconciling",
  "Segmenting",
  "Annotating",
  "Comprehending",
  "Forecasting",
  "Curating",
  "Evolving",
  "Finalizing",
] as const;

function randomThinkingWordIndex(exclude?: number): number {
  const count = THINKING_WORDS.length;
  if (count <= 1) return 0;
  let next = Math.floor(Math.random() * count);
  if (exclude !== undefined && next === exclude) {
    next = (next + 1 + Math.floor(Math.random() * (count - 1))) % count;
  }
  return next;
}

function normalizeSessionsList(list: ChatSession[]): ChatSession[] {
  const byKey = new Map<string, ChatSession>();
  for (const raw of list) {
    const key = typeof raw?.key === "string" ? raw.key.trim() : "";
    if (!key) continue;
    if (!shouldDisplayGatewaySession(key)) continue;
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
    const localLabel = current.label?.trim() || meta?.label?.trim();
    return {
      ...session,
      label: localLabel || session.label,
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

function normalizePersistedPendingSend(raw: unknown): PersistedPendingSend | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  const sessionKey = typeof record.sessionKey === "string" ? record.sessionKey.trim() : "";
  const outboundMessageContent =
    typeof record.outboundMessageContent === "string" ? record.outboundMessageContent : "";
  const routingContent =
    typeof record.routingContent === "string" ? record.routingContent : outboundMessageContent;
  const idempotencyKey =
    typeof record.idempotencyKey === "string" ? record.idempotencyKey.trim() : "";
  const createdAt =
    typeof record.createdAt === "number" && Number.isFinite(record.createdAt)
      ? record.createdAt
      : Date.now();
  const attemptCount =
    typeof record.attemptCount === "number" && Number.isFinite(record.attemptCount)
      ? Math.max(0, Math.floor(record.attemptCount))
      : 0;
  const nextAttemptAt =
    typeof record.nextAttemptAt === "number" && Number.isFinite(record.nextAttemptAt)
      ? record.nextAttemptAt
      : createdAt;
  const attachments = Array.isArray(record.attachments)
    ? record.attachments.reduce<PersistedPendingSendAttachment[]>((list, attachment) => {
        if (!attachment || typeof attachment !== "object") {
          return list;
        }
        const value = attachment as Record<string, unknown>;
        list.push({
          fileName: typeof value.fileName === "string" ? value.fileName : undefined,
          mimeType: typeof value.mimeType === "string" ? value.mimeType : undefined,
          content: typeof value.content === "string" ? value.content : undefined,
        });
        return list;
      }, [])
    : [];

  if (!id || !sessionKey || !idempotencyKey) {
    return null;
  }
  if (!outboundMessageContent.trim() && attachments.length === 0) {
    return null;
  }

  return {
    id,
    sessionKey,
    outboundMessageContent,
    routingContent,
    attachments,
    idempotencyKey,
    createdAt,
    attemptCount,
    nextAttemptAt,
  };
}

const AGENT_IDENTITY_CONTEXT_START = "[[ENTROPIC_AGENT_IDENTITY]]";
const AGENT_IDENTITY_CONTEXT_END = "[[END_ENTROPIC_AGENT_IDENTITY]]";

function withAgentIdentityContext(content: string, rawAgentName: unknown): string {
  const trimmedContent = content.trim();
  if (!trimmedContent || trimmedContent.includes(AGENT_IDENTITY_CONTEXT_START)) {
    return content;
  }
  const agentName = sanitizeProfileName(rawAgentName, DEFAULT_AGENT_NAME);
  const context = [
    AGENT_IDENTITY_CONTEXT_START,
    `Your current agent name is ${agentName}. Use this as your own name when identity is relevant.`,
    "Do not quote or expose this internal identity context to the user.",
    AGENT_IDENTITY_CONTEXT_END,
  ].join("\n");
  return `${context}\n\n${content}`;
}

function compactToolText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > 120 ? `${text.slice(0, 117).trimEnd()}...` : text;
}

function compactFirstToolText(...values: unknown[]): string | undefined {
  for (const value of values) {
    const text = compactToolText(value);
    if (text) return text;
  }
  return undefined;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}

function toolRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseToolRecord(value: unknown): Record<string, unknown> | null {
  const direct = toolRecord(value);
  if (direct) return direct;
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || (!text.startsWith("{") && !text.startsWith("["))) return null;
  try {
    const parsed = JSON.parse(text);
    return toolRecord(parsed);
  } catch {
    return null;
  }
}

function firstToolRecord(...values: unknown[]): Record<string, unknown> | undefined {
  for (const value of values) {
    const record = parseToolRecord(value);
    if (record) return record;
  }
  return undefined;
}

function humanizeToolName(name: string): string {
  const cleaned = name.trim().replace(/^functions\./, "");
  if (!cleaned) return "Tool";
  return cleaned
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function normalizeToolNameKey(name: string | undefined): string {
  return (name || "").trim().toLowerCase().replace(/^functions\./, "").replace(/[\s.-]+/g, "_");
}

function isGenericToolName(name: string | undefined): boolean {
  const normalized = normalizeToolNameKey(name);
  return !normalized || normalized === "tool" || normalized === "function" || normalized === "unknown";
}

function isWebSearchToolName(name: string | undefined): boolean {
  const normalized = normalizeToolNameKey(name);
  return (
    normalized === "web_search" ||
    normalized === "search_query" ||
    normalized === "web_run" ||
    (normalized.includes("web") && normalized.includes("search"))
  );
}

function isWebFetchToolName(name: string | undefined): boolean {
  const normalized = normalizeToolNameKey(name);
  return (
    normalized === "web_fetch" ||
    normalized === "open_url" ||
    (normalized.includes("web") && (normalized.includes("fetch") || normalized.includes("open")))
  );
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

function domainFromUrl(raw: string | undefined): string | undefined {
  if (!raw || !isHttpUrl(raw)) return undefined;
  try {
    return new URL(raw).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

function toolInputFromAgentData(data: Record<string, unknown>): Record<string, unknown> | undefined {
  return firstToolRecord(data.arguments, data.args, data.input, data.params);
}

function toolResultFromAgentData(data: Record<string, unknown>): Record<string, unknown> | undefined {
  return firstToolRecord(data.result, data.output, data.response, data.partialResult);
}

function extractToolQuery(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string") {
      const text = compactToolText(value);
      if (text && !isHttpUrl(text)) return text;
      continue;
    }
    const record = parseToolRecord(value);
    if (!record) continue;
    const direct =
      compactToolText(record.query) ??
      compactToolText(record.q) ??
      compactToolText(record.search) ??
      compactToolText(record.prompt);
    if (direct) return direct;
    const searchQuery = record.search_query;
    if (Array.isArray(searchQuery)) {
      for (const item of searchQuery) {
        const itemRecord = parseToolRecord(item);
        const q = itemRecord
          ? compactToolText(itemRecord.q) ?? compactToolText(itemRecord.query)
          : compactToolText(item);
        if (q) return q;
      }
    } else {
      const q = compactToolText(searchQuery);
      if (q) return q;
    }
    const nested = firstToolRecord(record.arguments, record.args, record.input, record.params);
    const nestedQuery = nested ? extractToolQuery(nested) : undefined;
    if (nestedQuery) return nestedQuery;
  }
  return undefined;
}

function extractToolUrl(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && isHttpUrl(value)) return value.trim();
    const record = parseToolRecord(value);
    if (!record) continue;
    for (const key of ["url", "finalUrl", "href", "link"] as const) {
      const text = compactToolText(record[key]);
      if (text && isHttpUrl(text)) return text;
    }
    const nested = firstToolRecord(record.arguments, record.args, record.input, record.params);
    const nestedUrl = nested ? extractToolUrl(nested) : undefined;
    if (nestedUrl) return nestedUrl;
  }
  return undefined;
}

function collectToolLinks(value: unknown, limit = 4): Array<{ title?: string; url: string; domain?: string }> {
  const links: Array<{ title?: string; url: string; domain?: string }> = [];
  const seen = new Set<string>();

  function add(url: string, title?: unknown, domain?: unknown) {
    const normalized = url.trim();
    if (!isHttpUrl(normalized) || seen.has(normalized) || links.length >= limit) return;
    seen.add(normalized);
    links.push({
      url: normalized,
      title: compactToolText(title),
      domain: compactToolText(domain) ?? domainFromUrl(normalized),
    });
  }

  function visit(item: unknown, depth: number) {
    if (links.length >= limit || depth > 3 || item == null) return;
    if (typeof item === "string") {
      const matches = item.match(/https?:\/\/[^\s)"'<>]+/gi) ?? [];
      for (const match of matches) add(match);
      return;
    }
    if (Array.isArray(item)) {
      for (const child of item) visit(child, depth + 1);
      return;
    }
    const record = parseToolRecord(item);
    if (!record) return;
    const url = extractToolUrl(record);
    if (url) {
      add(url, record.title ?? record.name, record.domain ?? record.site);
    }
    for (const key of ["results", "citations", "links", "items", "documents", "sources", "data"] as const) {
      if (record[key] !== undefined) visit(record[key], depth + 1);
    }
  }

  visit(value, 0);
  return links;
}

function summarizeToolResult(value: unknown): string | undefined {
  const record = parseToolRecord(value);
  if (!record) return compactToolText(value);
  for (const key of ["results", "citations", "links", "items", "documents", "sources"] as const) {
    const child = record[key];
    if (Array.isArray(child)) return `${child.length} result${child.length === 1 ? "" : "s"}`;
  }
  return (
    compactToolText(record.summary) ??
    compactToolText(record.result) ??
    compactToolText(record.output) ??
    compactToolText(record.message) ??
    compactToolText(record.title) ??
    compactToolText(record.status)
  );
}

function toolStatusFromAgentData(data: Record<string, unknown>): ChatToolActivityStatus {
  const raw = String(data.status ?? data.state ?? data.phase ?? "").toLowerCase();
  if (raw.includes("error") || raw.includes("fail")) return "error";
  if (raw.includes("end") || raw.includes("done") || raw.includes("complete") || raw.includes("success")) {
    return "complete";
  }
  return "running";
}

function toolDetailFromAgentData(data: Record<string, unknown>): string | undefined {
  const args =
    toolRecord(data.arguments) ??
    toolRecord(data.args) ??
    toolRecord(data.input) ??
    toolRecord(data.params) ??
    toolRecord(data.details);
  const tookMs = typeof data.tookMs === "number" && Number.isFinite(data.tookMs)
    ? data.tookMs
    : typeof args?.tookMs === "number" && Number.isFinite(args.tookMs)
      ? args.tookMs
      : null;
  const duration = tookMs !== null
    ? `Finished in ${(tookMs / 1000).toFixed(tookMs < 10_000 ? 1 : 0)}s`
    : undefined;
  return (
    compactToolText(data.title) ??
    compactToolText(data.message) ??
    compactToolText(data.query) ??
    compactToolText(data.path) ??
    compactToolText(data.url) ??
    compactToolText(data.command) ??
    compactToolText(args?.query) ??
    compactToolText(args?.path) ??
    compactToolText(args?.url) ??
    compactToolText(args?.command) ??
    compactToolText(data.error) ??
    duration
  );
}

function gatewayToolResultPayload(message: GatewayMessage): Record<string, unknown> | undefined {
  const details = toolRecord(message.details) ?? {};
  const direct = firstToolRecord(
    details.result,
    details.output,
    details.response,
    message.result,
    message.output,
    typeof message.content === "string" ? message.content : undefined,
  );
  if (direct) return direct;
  if (!Array.isArray(message.content)) return undefined;
  for (const block of message.content) {
    const record = parseToolRecord(block);
    if (!record) continue;
    const nested = firstToolRecord(record.result, record.output, record.response, record.content, record.text);
    if (nested) return nested;
    if (Object.keys(record).some((key) => ["results", "citations", "url", "finalUrl", "summary"].includes(key))) {
      return record;
    }
  }
  return undefined;
}

function toolActivityFromAgentEvent(event: AgentEvent): ChatToolActivity | null {
  if (event.stream !== "tool") return null;
  const data = event.data || {};
  const rawName =
    compactToolText(data.name) ??
    compactToolText(data.tool) ??
    compactToolText(data.toolName) ??
    compactToolText(data.call) ??
    "tool";
  const id =
    compactToolText(data.id) ??
    compactToolText(data.callId) ??
    compactToolText(data.toolCallId) ??
    rawName;
  const input = toolInputFromAgentData(data);
  const result = toolResultFromAgentData(data);
  const status = toolStatusFromAgentData(data);
  const links = collectToolLinks(result ?? data);
  return {
    id,
    name: rawName,
    label: humanizeToolName(rawName),
    status,
    detail: toolDetailFromAgentData(data),
    input,
    result,
    resultSummary: summarizeToolResult(result ?? data),
    query: extractToolQuery(input, data),
    url: extractToolUrl(input, result, data),
    links: links.length > 0 ? links : undefined,
    seq: event.seq,
    ts: event.ts || Date.now(),
  };
}

function toolActivitiesFromGatewayMessage(
  message: GatewayMessage | null | undefined,
  event: Pick<ChatEvent, "seq">,
): ChatToolActivity[] {
  if (!message) return [];
  const roleRaw = typeof message.role === "string" ? message.role.toLowerCase() : "assistant";
  const ts = extractMessageTimestamp(message) ?? Date.now();
  const seqBase = Number.isFinite(event.seq) ? event.seq * 100 : Date.now();

  if (roleRaw === "assistant" && Array.isArray(message.content)) {
    return message.content.reduce<ChatToolActivity[]>((activities, block, idx) => {
      const record = toolRecord(block);
      if (!record) return activities;
      const type = compactToolText(record.type)?.toLowerCase().replace(/[_-]+/g, "") ?? "";
      if (!["toolcall", "tooluse", "functioncall"].includes(type)) return activities;
      const rawName =
        compactFirstToolText(record.name, record.toolName, record.tool, record.functionName) ??
        "tool";
      const id =
        compactFirstToolText(record.id, record.callId, record.toolCallId, record.functionCallId) ??
        rawName;
      const input = firstToolRecord(record.arguments, record.args, record.input, record.params);
      activities.push({
        id,
        name: rawName,
        label: humanizeToolName(rawName),
        status: "running",
        detail: toolDetailFromAgentData(record),
        input,
        query: extractToolQuery(input, record),
        url: extractToolUrl(input, record),
        links: collectToolLinks(input ?? record),
        seq: seqBase + idx,
        ts,
      });
      return activities;
    }, []);
  }

  if (roleRaw === "toolresult" || roleRaw === "tool_result" || roleRaw === "tool") {
    const details = toolRecord(message.details) ?? {};
    const rawName =
      compactFirstToolText(message.toolName, details.toolName, details.name, details.tool) ??
      "tool";
    const id = compactFirstToolText(message.toolCallId, details.toolCallId, details.callId) ?? rawName;
    const isError = message.isError === true || details.isError === true;
    const result = gatewayToolResultPayload(message);
    const input = firstToolRecord(details.arguments, details.args, details.input, details.params);
    const links = collectToolLinks(result ?? details ?? message);
    return [{
      id,
      name: rawName,
      label: humanizeToolName(rawName),
      status: isError ? "error" : "complete",
      detail: toolDetailFromAgentData({ ...details, ...message }),
      input,
      result,
      resultSummary: summarizeToolResult(result ?? details ?? message),
      query: extractToolQuery(input, result, details, message),
      url: extractToolUrl(input, result, details, message),
      links: links.length > 0 ? links : undefined,
      seq: seqBase,
      ts,
    }];
  }

  return [];
}

function isGatewayToolOnlyMessage(
  message: GatewayMessage | null | undefined,
  activities: ChatToolActivity[],
): boolean {
  if (!message || activities.length === 0) return false;
  const roleRaw = typeof message.role === "string" ? message.role.toLowerCase() : "assistant";
  if (roleRaw === "toolresult" || roleRaw === "tool_result" || roleRaw === "tool") {
    return true;
  }
  if (roleRaw === "assistant") {
    return !extractMessageText(message).hasText;
  }
  return false;
}

function mergeToolActivities(
  existing: ChatToolActivity[],
  incoming: ChatToolActivity[],
): ChatToolActivity[] {
  let next = existing;
  for (const activity of incoming) {
    let existingIdx = next.findIndex((item) => item.id === activity.id);
    if (existingIdx < 0 && activity.status !== "running") {
      const incomingName = normalizeToolNameKey(activity.name);
      for (let idx = next.length - 1; idx >= 0; idx -= 1) {
        const item = next[idx];
        if (item.status !== "running") continue;
        const itemName = normalizeToolNameKey(item.name);
        if (incomingName && itemName && incomingName === itemName) {
          existingIdx = idx;
          break;
        }
      }
      if (existingIdx < 0 && isGenericToolName(activity.name)) {
        for (let idx = next.length - 1; idx >= 0; idx -= 1) {
          if (next[idx].status === "running") {
            existingIdx = idx;
            break;
          }
        }
      }
    }
    next =
      existingIdx >= 0
        ? next.map((item, idx) =>
            idx === existingIdx
              ? (() => {
                  const status =
                    (item.status === "complete" || item.status === "error") && activity.status === "running"
                      ? item.status
                      : activity.status;
                  const mergedName = isGenericToolName(activity.name) ? item.name : activity.name;
                  return {
                    ...item,
                    ...activity,
                    id: item.id,
                    name: mergedName,
                    label: isGenericToolName(activity.name) ? item.label : activity.label,
                    status,
                    detail: activity.detail ?? activity.resultSummary ?? item.detail,
                    input: activity.input ?? item.input,
                    result: activity.result ?? item.result,
                    resultSummary: activity.resultSummary ?? item.resultSummary,
                    query: activity.query ?? item.query,
                    url: activity.url ?? item.url,
                    links: activity.links?.length ? activity.links : item.links,
                    seq: Math.max(item.seq, activity.seq),
                    ts: item.ts || activity.ts,
                  };
                })()
              : item,
          )
        : [...next, activity];
  }
  return next.sort((a, b) => a.seq - b.seq).slice(-8);
}

function toolLoadingStatus(activity: ChatToolActivity): string {
  if (activity.status === "error") return `${activity.label} failed`;
  if (activity.status === "complete") return `${activity.label} finished`;
  if (isWebSearchToolName(activity.name)) return activity.query ? `Searching for ${activity.query}` : "Searching the web";
  if (isWebFetchToolName(activity.name)) return activity.url ? `Reading ${domainFromUrl(activity.url) ?? activity.url}` : "Reading web page";
  return `Using ${activity.label}`;
}

async function persistChatData(data: PersistedChatData): Promise<void> {
  try {
    const store = await getChatStore();
    const protectedSessionKeys = new Set<string>();
    if (typeof data.currentSession === "string" && data.currentSession.trim()) {
      protectedSessionKeys.add(data.currentSession);
    }
    for (const entry of data.outbox || []) {
      if (entry.sessionKey?.trim()) {
        protectedSessionKeys.add(entry.sessionKey);
      }
    }
    const orderedSessions = normalizeSessionsList(data.sessions);
    const protectedSessions = orderedSessions.filter((session) =>
      protectedSessionKeys.has(session.key),
    );
    const otherSessions = orderedSessions.filter((session) => !protectedSessionKeys.has(session.key));
    const sessionLimit = Math.max(MAX_PERSISTED_SESSIONS, protectedSessions.length);
    // Keep only recent sessions
    const trimmed: PersistedChatData = {
      sessions: [...protectedSessions, ...otherSessions].slice(0, sessionLimit),
      messages: {},
      drafts: {},
      shellDrafts: {},
      imageDrafts: {},
      composerModeBySession: {},
      terminalBySession: {},
      currentSession: data.currentSession,
      outbox: [],
    };
    const allowedKeys = new Set(trimmed.sessions.map((session) => session.key));
    for (const s of trimmed.sessions) {
      const msgs = data.messages[s.key];
      if (msgs && msgs.length > 0) {
        // Strip large previewUrl data from attachments to avoid bloating the store
        trimmed.messages[s.key] = msgs.slice(-MAX_PERSISTED_MESSAGES).map((m) =>
          m.attachments
            ? {
                ...m,
                attachments: m.attachments.map(({ fileName, mimeType, omitted, byteLength }) => ({
                  fileName,
                  mimeType,
                  previewUrl: "",
                  omitted,
                  byteLength,
                })),
              }
            : m,
        );
      }
      const draft = data.drafts[s.key];
      if (typeof draft === "string" && draft.length > 0) {
        trimmed.drafts[s.key] = draft;
      }
      const shellDraft = data.shellDrafts[s.key];
      if (typeof shellDraft === "string" && shellDraft.length > 0) {
        trimmed.shellDrafts[s.key] = shellDraft;
      }
      const imageDraft = data.imageDrafts[s.key];
      if (typeof imageDraft === "string" && imageDraft.length > 0) {
        trimmed.imageDrafts[s.key] = imageDraft;
      }
      const composerMode = data.composerModeBySession[s.key];
      if (composerMode && composerMode !== DEFAULT_COMPOSER_MODE) {
        trimmed.composerModeBySession[s.key] = composerMode;
      }
      const terminalState = data.terminalBySession[s.key];
      if (terminalState?.cwd) {
        trimmed.terminalBySession[s.key] = {
          cwd: terminalState.cwd,
        };
      }
    }
    if (trimmed.currentSession) {
      const currentDraft = data.drafts[trimmed.currentSession];
      if (typeof currentDraft === "string" && currentDraft.length > 0) {
        trimmed.drafts[trimmed.currentSession] = currentDraft;
      }
      const currentShellDraft = data.shellDrafts[trimmed.currentSession];
      if (typeof currentShellDraft === "string" && currentShellDraft.length > 0) {
        trimmed.shellDrafts[trimmed.currentSession] = currentShellDraft;
      }
      const currentImageDraft = data.imageDrafts[trimmed.currentSession];
      if (typeof currentImageDraft === "string" && currentImageDraft.length > 0) {
        trimmed.imageDrafts[trimmed.currentSession] = currentImageDraft;
      }
      const currentMode = data.composerModeBySession[trimmed.currentSession];
      if (currentMode && currentMode !== DEFAULT_COMPOSER_MODE) {
        trimmed.composerModeBySession[trimmed.currentSession] = currentMode;
      }
    }
    trimmed.outbox = (data.outbox || [])
      .filter((entry) => allowedKeys.has(entry.sessionKey))
      .slice(0, MAX_PERSISTED_OUTBOX)
      .map((entry) => ({
        ...entry,
        attachments: (entry.attachments || []).map((attachment) => ({
          fileName: attachment.fileName,
          mimeType: attachment.mimeType,
          content: attachment.content,
        })),
      }));
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
    if (!data) return null;

    const sessions = normalizeSessionsList(Array.isArray(data.sessions) ? data.sessions : []);
    const allowedKeys = new Set(sessions.map((session) => session.key));
    const messages: Record<string, Message[]> = {};
    for (const [sessionKey, sessionMessages] of Object.entries(data.messages || {})) {
      if (!allowedKeys.has(sessionKey)) continue;
      if (!Array.isArray(sessionMessages)) continue;
      messages[sessionKey] = sessionMessages;
    }
    const drafts: Record<string, string> = {};
    for (const [sessionKey, draft] of Object.entries(data.drafts || {})) {
      if (!allowedKeys.has(sessionKey)) continue;
      if (typeof draft !== "string") continue;
      drafts[sessionKey] = draft;
    }
    const shellDrafts: Record<string, string> = {};
    for (const [sessionKey, draft] of Object.entries(data.shellDrafts || {})) {
      if (!allowedKeys.has(sessionKey)) continue;
      if (typeof draft !== "string") continue;
      shellDrafts[sessionKey] = draft;
    }
    const imageDrafts: Record<string, string> = {};
    for (const [sessionKey, draft] of Object.entries(data.imageDrafts || {})) {
      if (!allowedKeys.has(sessionKey)) continue;
      if (typeof draft !== "string") continue;
      imageDrafts[sessionKey] = draft;
    }
    const composerModeBySession: Record<string, ComposerMode> = {};
    for (const [sessionKey, mode] of Object.entries(data.composerModeBySession || {})) {
      if (!allowedKeys.has(sessionKey)) continue;
      composerModeBySession[sessionKey] =
        mode === "shell" || mode === "image" ? mode : "chat";
    }
    const terminalBySession: Record<string, ChatTerminalState> = {};
    for (const [sessionKey, value] of Object.entries(data.terminalBySession || {})) {
      if (!allowedKeys.has(sessionKey)) continue;
      if (!value || typeof value !== "object") continue;
      const cwd = typeof (value as ChatTerminalState).cwd === "string"
        ? (value as ChatTerminalState).cwd.trim()
        : "";
      terminalBySession[sessionKey] = {
        cwd: cwd || TERMINAL_DEFAULT_CWD,
      };
    }
    const currentSession =
      typeof data.currentSession === "string" && allowedKeys.has(data.currentSession)
        ? data.currentSession
        : null;
    const outbox = Array.isArray(data.outbox)
      ? data.outbox
          .map(normalizePersistedPendingSend)
          .filter((entry): entry is PersistedPendingSend => entry !== null)
          .filter((entry) => allowedKeys.has(entry.sessionKey))
      : [];

    return {
      sessions,
      messages,
      drafts,
      shellDrafts,
      imageDrafts,
      composerModeBySession,
      terminalBySession,
      currentSession,
      outbox,
    };
  } catch (err) {
    console.warn("[Entropic] Failed to load persisted chat data:", err);
    return null;
  }
}

// Message parsing/sanitization functions imported from ../lib/chatMessageUtils

const PROVIDERS: Provider[] = [
  { id: "anthropic", name: "Anthropic", icon: "A", placeholder: "sk-ant-...", keyUrl: "https://console.anthropic.com/settings/keys" },
  { id: "openai", name: "OpenAI", icon: "O", placeholder: "sk-...", keyUrl: "https://platform.openai.com/api-keys" },
  { id: "google", name: "Google AI", icon: "G", placeholder: "AIza...", keyUrl: "https://aistudio.google.com/app/apikey" },
];

const DEFAULT_GATEWAY_URL = "ws://localhost:19789";
const TERMS_URL = entropicSitePath("/terms");
const PRIVACY_URL = entropicSitePath("/privacy");
const HISTORY_LIMIT = 500;
const ACTIVE_RUN_IDLE_TIMEOUT_MS = 120_000;
const MAX_ATTACHMENTS_PER_MESSAGE = 4;
const MAX_ATTACHMENT_BYTES = 25_000_000;
const MAX_ATTACHMENT_MB = Math.floor(MAX_ATTACHMENT_BYTES / 1_000_000);
const GENERATED_IMAGES_DEST_PATH = "generated-images";

const QUICK_ACTION_ICONS: Record<ChatQuickActionIcon, typeof Mail> = {
  mail: Mail,
  calendar: Calendar,
  trending: TrendingUp,
  globe: Globe,
  activity: Activity,
  bot: Bot,
  user: User,
};

const OneDriveLogo = brandAssetLogo(oneDriveLogo, "OneDrive");
const OutlookLogo = brandAssetLogo(outlookLogo, "Outlook");
const GmailAssetLogo = brandAssetLogo(gmailAssetLogo, "Gmail");
const GoogleCalendarAssetLogo = brandAssetLogo(googleCalendarAssetLogo, "Google Calendar");
const GoogleDriveLogo = brandAssetLogo(googleDriveLogo, "Google Drive");
const GoogleSheetsLogo = brandAssetLogo(googleSheetsLogo, "Google Sheets");
const MicrosoftTeamsLogo = brandAssetLogo(microsoftTeamsLogo, "Microsoft Teams");
const AsanaLogo = brandAssetLogo(asanaLogo, "Asana");

const INTEGRATION_LOGOS: Partial<Record<
  IntegrationQuickActionRequirement["provider"],
  ComponentType<{ className?: string }>
>> = {
  google_email: GmailLogo,
  google_calendar: GoogleCalendarLogo,
  onedrive: OneDriveLogo,
  outlook: OutlookLogo,
  x: XLogo,
};

const HOME_PRIMARY_INTEGRATIONS = [
  { name: "OneDrive", provider: "onedrive", Logo: OneDriveLogo, size: "large" },
  { name: "Outlook", provider: "outlook", Logo: OutlookLogo, size: "large" },
  { name: "Gmail", provider: "google_email", Logo: GmailAssetLogo, size: "medium" },
  { name: "Calendar", provider: "google_calendar", Logo: GoogleCalendarAssetLogo, size: "medium" },
  { name: "Drive", provider: "google_drive", Logo: GoogleDriveLogo, size: "medium" },
  { name: "Sheets", provider: "google_sheets", Logo: GoogleSheetsLogo, size: "medium" },
  { name: "Teams", provider: "microsoft_teams", Logo: MicrosoftTeamsLogo, size: "medium" },
  { name: "Asana", provider: "asana", Logo: AsanaLogo, size: "small" },
  { name: "X", provider: "x", Logo: XLogo, size: "small" },
] as const;

const CRON_GUARD_LINES = [
  "This is a scheduled run. Do NOT create, edit, or run cron jobs.",
  "Use the available tools needed to complete this scheduled task, then report results.",
];
const CRON_GUARD_BLOCK = `${CRON_GUARD_LINES.join("\n")}\n\n`;

type IntegrationSetupState = {
  requirement: IntegrationQuickActionRequirement;
  pendingAction: AgentQuickActionDefinition;
  status: "idle" | "connecting" | "awaiting_callback";
  error: string | null;
};

type IntegrationLaunchState = {
  provider: IntegrationProvider;
  name: string;
  status: "ready" | "connecting" | "selecting_access";
  error: string | null;
  permissionProfiles?: HostedIntegrationPermissionProfile[];
};

type QuickSuggestionState = {
  action: AgentQuickActionDefinition;
  taskName: string;
  taskPreset: SuggestionTaskPreset;
  creatingTask: boolean;
  error: string | null;
};

type BuilderQuickActionId = "build_agent_identity" | "build_user_profile";

type BuilderChecklistOption = {
  id: string;
  label: string;
  fileTarget: string;
  uiHint?: string;
  promptInstruction: string;
  defaultSelected?: boolean;
};

type BuilderChecklistConfig = {
  title: string;
  summary: string;
  options: BuilderChecklistOption[];
};

type BuilderChecklistState = {
  action: AgentQuickActionDefinition & { id: BuilderQuickActionId };
  selectedByOptionId: Record<string, boolean>;
  error: string | null;
};

const AGENT_BUILDER_CHECKLIST_OPTIONS: BuilderChecklistOption[] = [
  {
    id: "identity_name",
    label: "Agent name",
    fileTarget: "IDENTITY.md - Name",
    uiHint: "How your agent is introduced",
    promptInstruction: "Confirm or update `- **Name:**` in IDENTITY.md.",
  },
  {
    id: "identity_avatar",
    label: "Avatar image",
    fileTarget: "IDENTITY.md - Avatar",
    uiHint: "Profile visual (upload or generate)",
    promptInstruction:
      "Run avatar upload/generation flow and update `- **Avatar:**` only after explicit approval.",
  },
  {
    id: "identity_creature",
    label: "Creature archetype",
    fileTarget: "IDENTITY.md - Creature",
    uiHint: "The character or form your agent embodies",
    promptInstruction: "Confirm or update `- **Creature:**`.",
  },
  {
    id: "identity_vibe",
    label: "Vibe and tone",
    fileTarget: "IDENTITY.md - Vibe + SOUL.md - Vibe",
    uiHint: "How your agent should feel in conversation",
    promptInstruction: "Align `- **Vibe:**` with SOUL.md vibe guidance.",
  },
  {
    id: "identity_emoji",
    label: "Signature emoji",
    fileTarget: "IDENTITY.md - Emoji",
    uiHint: "A small signature marker for your agent",
    promptInstruction: "Confirm or update `- **Emoji:**`.",
  },
  {
    id: "soul_mission",
    label: "Mission statement",
    fileTarget: "SOUL.md - Mission Statement",
    uiHint: "One-line north star for how the agent helps",
    promptInstruction: "Draft or revise `## Mission Statement` (north star).",
  },
  {
    id: "soul_core_truths",
    label: "Core principles",
    fileTarget: "SOUL.md - Core Truths",
    uiHint: "Guiding beliefs the agent should follow",
    promptInstruction: "Draft or revise `## Core Truths`.",
  },
  {
    id: "soul_boundaries",
    label: "Boundaries",
    fileTarget: "SOUL.md - Boundaries",
    uiHint: "What the agent should avoid or confirm first",
    promptInstruction: "Draft or revise `## Boundaries`.",
  },
  {
    id: "soul_continuity",
    label: "Continuity and work style",
    fileTarget: "SOUL.md - Continuity + Working Preferences",
    uiHint: "How it should persist context and collaborate",
    promptInstruction: "Draft or revise continuity and working-style sections.",
  },
  {
    id: "heartbeat",
    label: "Recurring check-ins",
    fileTarget: "HEARTBEAT.md",
    uiHint: "Periodic reminders and routine tasks",
    promptInstruction: "Keep empty/comment-only or add a concise recurring checklist if requested.",
  },
];

const PROFILE_BUILDER_CHECKLIST_OPTIONS: BuilderChecklistOption[] = [
  {
    id: "user_name",
    label: "Your name",
    fileTarget: "USER.md - Name",
    uiHint: "The name your agent should remember",
    promptInstruction: "Confirm or update `- **Name:**`.",
  },
  {
    id: "user_call_them",
    label: "How I should address you",
    fileTarget: "USER.md - What to call them",
    uiHint: "Preferred way your agent should call you",
    promptInstruction: "Confirm or update `- **What to call them:**`.",
  },
  {
    id: "user_timezone",
    label: "Timezone",
    fileTarget: "USER.md - Timezone",
    uiHint: "Your local time context",
    promptInstruction: "Confirm or update `- **Timezone:**`.",
  },
  {
    id: "user_interests",
    label: "Interests",
    fileTarget: "USER.md - Notes",
    uiHint: "Topics and domains you care about",
    promptInstruction: "Capture interests in Notes/Context.",
  },
  {
    id: "user_career",
    label: "Career background",
    fileTarget: "USER.md - Notes",
    uiHint: "What you do and your professional context",
    promptInstruction: "Capture career background in Notes/Context.",
  },
  {
    id: "user_goals",
    label: "Current goals",
    fileTarget: "USER.md - Notes",
    uiHint: "Near-term outcomes you want to hit",
    promptInstruction: "Capture near-term goals in Notes/Context.",
  },
  {
    id: "user_ambitions",
    label: "Long-term ambitions",
    fileTarget: "USER.md - Notes",
    uiHint: "Bigger direction you are building toward",
    promptInstruction: "Capture long-term ambitions in Notes/Context.",
  },
  {
    id: "user_working_preferences",
    label: "Working preferences",
    fileTarget: "USER.md - Notes",
    uiHint: "How you like to plan, execute, and review",
    promptInstruction: "Capture preferred workflows and collaboration style.",
  },
  {
    id: "user_communication_and_context",
    label: "Communication style and context",
    fileTarget: "USER.md - Notes + Context",
    uiHint: "Tone, cadence, and personal context to remember",
    promptInstruction: "Capture communication style and relevant personal context to remember.",
  },
];

const BUILDER_CHECKLIST_CONFIG_BY_ACTION: Record<BuilderQuickActionId, BuilderChecklistConfig> = {
  build_agent_identity: {
    title: "Build my agent checklist",
    summary: "Pick what you want to shape in this session.",
    options: AGENT_BUILDER_CHECKLIST_OPTIONS,
  },
  build_user_profile: {
    title: "Build my profile checklist",
    summary: "Pick what you want your agent to update about you.",
    options: PROFILE_BUILDER_CHECKLIST_OPTIONS,
  },
};

function isBuilderQuickAction(
  action: AgentQuickActionDefinition
): action is AgentQuickActionDefinition & { id: BuilderQuickActionId } {
  return action.id === "build_agent_identity" || action.id === "build_user_profile";
}

function createDefaultBuilderSelection(actionId: BuilderQuickActionId): Record<string, boolean> {
  const options = BUILDER_CHECKLIST_CONFIG_BY_ACTION[actionId].options;
  const selected = Object.fromEntries(
    options.map((option) => [option.id, option.defaultSelected !== false])
  );
  return selected;
}

function selectedBuilderChecklistOptions(state: BuilderChecklistState): BuilderChecklistOption[] {
  const options = BUILDER_CHECKLIST_CONFIG_BY_ACTION[state.action.id].options;
  return options.filter((option) => Boolean(state.selectedByOptionId[option.id]));
}

function buildChecklistScopeBlock(
  actionId: BuilderQuickActionId,
  selectedOptions: BuilderChecklistOption[]
): string {
  const selectedLines = selectedOptions
    .map((option) => `- ${option.label} (${option.fileTarget}): ${option.promptInstruction}`)
    .join("\n");
  const flowLabel = actionId === "build_agent_identity" ? "Build my agent" : "Build my profile";
  return [
    `Checklist selections for this session (${flowLabel}):`,
    "This checklist overrides default scope for this session.",
    selectedLines,
    "",
    "Scope rules:",
    "- Ask questions only for selected checklist items unless the user expands scope.",
    "- Only draft/edit selected file sections unless the user asks for broader edits.",
    "- If an unselected field is required for validity, ask for confirmation before changing it.",
  ].join("\n");
}

function integrationRequirementLabel(requirement: IntegrationQuickActionRequirement): string {
  return requirement.label;
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

type XSearchIntent = {
  topic: string | null;
};

function cleanXIntentTopic(raw: string): string | null {
  const collapsed = raw
    .replace(/\s+/g, " ")
    .replace(/[.?!,:;]+$/g, "")
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .trim();
  if (!collapsed) return null;
  if (/^(?:x|twitter)$/i.test(collapsed)) return null;
  return collapsed;
}

function parseXSearchIntent(raw: string): XSearchIntent | null {
  const text = raw.trim();
  if (!text) return null;

  const hasTwitterMention = /\btwitter\b/i.test(text);
  const hasXPlatformMention =
    /\b(?:on|from|in|via|using)\s+x\b(?!\s*(?:axis|value|values|coordinate|coordinates|chart|graph|plot|table)\b)/i.test(
      text
    ) || hasTwitterMention;
  if (!hasXPlatformMention) return null;

  const directQueryPatterns = [
    /\bwhat(?:'s| is)\s+on\s+(?:x|twitter)\b/i,
    /\bwhat(?:'s| is)\s+latest\b.*\b(?:on|from|in)\s+(?:x|twitter)\b/i,
    /\b(?:latest|newest|recent|trending|trend|news|updates?)\s+on\s+.+\s+(?:on|from|in)\s+(?:x|twitter)\b/i,
    /\b(?:search|find|look(?:\s+up)?|check|show|track)\b.*\b(?:on|from|in)\s+(?:x|twitter)\b/i,
    /\b(?:on|from|in)\s+(?:x|twitter)\s+(?:about|for|regarding)\b/i,
    /\bwhat\s+are\s+people\s+saying\b.*\b(?:on|from|in)\s+(?:x|twitter)\b/i,
  ];
  if (!directQueryPatterns.some((pattern) => pattern.test(text))) {
    return null;
  }

  const topicPatterns = [
    /\b(?:latest|newest|recent|trending|trend|news|updates?)\s+on\s+(.+?)\s+(?:on|from|in)\s+(?:x|twitter)\b/i,
    /\bwhat(?:'s| is)\s+latest\s+on\s+(.+?)\s+(?:on|from|in)\s+(?:x|twitter)\b/i,
    /\b(?:on|from|in)\s+(?:x|twitter)\s+(?:about|for|regarding)\s+(.+)$/i,
    /\b(?:search|find|look(?:\s+up)?|check|show|track)\s+(?:on\s+)?(?:x|twitter)\s+(?:for|about)\s+(.+)$/i,
    /\b(?:search|find|look(?:\s+up)?|check|show|track)\s+(.+?)\s+(?:on|from|in)\s+(?:x|twitter)\b/i,
  ];

  for (const pattern of topicPatterns) {
    const match = text.match(pattern);
    if (!match?.[1]) continue;
    const topic = cleanXIntentTopic(match[1]);
    if (topic) return { topic };
  }

  return { topic: null };
}

function parseGmailIntent(raw: string): boolean {
  const text = raw.trim().toLowerCase();
  if (!text) return false;

  // Keep explicit Microsoft mail requests on the Outlook path.
  if (/\b(?:outlook|microsoft\s+mail|office\s*365\s+mail)\b/.test(text)) {
    return false;
  }

  const mentionsGmail = /\bgmail\b/.test(text);
  const mentionsInbox = /\binbox\b/.test(text);
  const mentionsGenericMail =
    /\b(?:email|emails|mail|messages?)\b/.test(text) &&
    /\b(?:check|search|read|summari[sz]e|triage|send|draft|reply|inbox)\b/.test(text);

  return mentionsGmail || mentionsInbox || mentionsGenericMail;
}

function parseOutlookIntent(raw: string): boolean {
  const text = raw.trim().toLowerCase();
  if (!text) return false;
  return (
    /\b(?:outlook|microsoft\s+mail|office\s*365\s+mail)\b/.test(text) ||
    (/\bcomposio\b/.test(text) && /\b(?:outlook|microsoft|office\s*365)\b/.test(text))
  );
}

function hasExplicitGmailIntent(raw: string): boolean {
  const text = raw.trim().toLowerCase();
  return /\bgmail\b/.test(text) || (/\bgoogle\b/.test(text) && /\b(?:email|mail|inbox)\b/.test(text));
}

function hasExplicitOutlookIntent(raw: string): boolean {
  return parseOutlookIntent(raw);
}

function parseOneDriveIntent(raw: string): boolean {
  const text = raw.trim().toLowerCase();
  if (!text) return false;
  const mentionsOneDrive = /\b(?:one\s*drive|onedrive)\b/.test(text);
  if (!mentionsOneDrive) return false;
  return /\b(?:upload|save|send|copy|move|create|make|write|put|list|search|find|download|share|folder|file|files|docx|xlsx|pptx|document|spreadsheet|presentation)\b/.test(text);
}

function formatIntegrationLaunchRoutingPrompt(
  launch: IntegrationLaunchState,
  message: string,
): string | null {
  const original = `Original user request: ${message.trim()}`;
  switch (launch.provider) {
    case "onedrive":
      return [
        "Use the connected OneDrive integration for this request.",
        "Use only OneDrive tools for this request. Do not call Google Drive, Google Docs, Google Sheets, Outlook, Gmail, or local Office workflow tools unless the user explicitly asks for them.",
        "Available OneDrive tools: `onedrive_items_list`, `onedrive_items_search`, `onedrive_item_resolve_path`, `onedrive_item_get`, `onedrive_item_content_get`, `onedrive_item_download`, `onedrive_item_share`, `onedrive_folder_create`, `onedrive_text_file_upload`, `onedrive_base64_file_upload`, `onedrive_docx_create`, and `onedrive_item_move`.",
        "For uploading an existing local workspace file, read the file bytes from `/data/workspace`, base64-encode them, then call `onedrive_base64_file_upload` with the original filename. For creating a Word document directly from text, use `onedrive_docx_create`.",
        "If the user mentions a OneDrive folder path, resolve or create the folder first, then pass its item id as `parentItemId`.",
        "After a successful upload, report the OneDrive item name and any web/share link returned by the tool.",
        original,
      ].join("\n");
    case "outlook":
      return [
        "Use the connected Outlook integration for this request.",
        "Use only Outlook tools for this request. Do not call Gmail tools.",
        "Available Outlook tools: `outlook_messages_list`, `outlook_message_get`, `outlook_message_send`, `outlook_mail_folders_list`, `outlook_calendars_list`, `outlook_events_list`, and `outlook_event_create`.",
        "For inbox/list/summarize requests, start with `outlook_messages_list` using limit 10.",
        original,
      ].join("\n");
    case "google_email":
      return [
        "Use the connected Gmail integration for this request.",
        "Use only Gmail tools for this request. Do not call Outlook tools.",
        "Available Gmail tools: `gmail_search`, `gmail_get`, `gmail_send`, and `gmail_draft`.",
        "For inbox/list/summarize requests, start with `gmail_search` using query `in:inbox` and maxResults 10.",
        original,
      ].join("\n");
    case "google_calendar":
      return [
        "Use the connected Google Calendar integration for this request.",
        "Use only Google Calendar tools for this request.",
        "Available Google Calendar tools: `calendar_list` and `calendar_create`.",
        original,
      ].join("\n");
    case "x":
      return [
        "Use the connected X integration for this request.",
        "Return concise bullets with direct X links, a short why-it-matters note, and clear recency cues when relevant.",
        original,
      ].join("\n");
    default:
      return [
        `Use the connected ${launch.name} integration for this request.`,
        `Use ${launch.name} tools only unless the user explicitly asks to involve another app.`,
        original,
      ].join("\n");
  }
}

function parseGenericEmailIntent(raw: string): boolean {
  const text = raw.trim().toLowerCase();
  if (!text) return false;
  return (
    /\b(?:email|emails|mail|message|messages|inbox)\b/.test(text) &&
    /\b(?:check|search|read|summari[sz]e|triage|send|draft|reply|forward|inbox)\b/.test(text)
  );
}

export function Chat({
  isVisible,
  gatewayRunning,
  gatewayStarting,
  gatewayRetryIn,
  gatewayLifecycleLabel,
  onGatewayConnectionReady,
  onStartGateway,
  onRecoverProxyAuth,
  useLocalKeys,
  selectedModel,
  onModelChange: _onModelChange,
  imageModel: _imageModel,
  imageGenerationModel,
  textToSpeechModel,
  audioUnderstandingModel,
  voiceSpeechRate = DEFAULT_VOICE_SPEECH_RATE,
  voiceSpeechVoice = DEFAULT_VOICE_SPEECH_VOICE,
  integrationsSyncing,
  integrationsMissing,
  onNavigate,
  onBrowserLinkClick,
  onSessionsChange,
  requestedSession,
  requestedSessionAction,
  wideLayout = false,
}: {
  isVisible?: boolean;
  gatewayRunning: boolean;
  gatewayStarting: boolean;
  gatewayRetryIn: number | null;
  gatewayLifecycleLabel?: string | null;
  onGatewayConnectionReady?: () => void;
  onStartGateway?: () => void;
  onRecoverProxyAuth?: () => Promise<boolean> | boolean;
  useLocalKeys: boolean;
  selectedModel: string;
  onModelChange?: (model: string) => void;
  imageModel: string;
  imageGenerationModel: string;
  textToSpeechModel: string;
  audioUnderstandingModel: string;
  voiceSpeechRate?: number;
  voiceSpeechVoice?: VoiceSpeechVoice;
  integrationsSyncing?: boolean;
  integrationsMissing?: boolean;
  onNavigate?: (page: Page) => void;
  onBrowserLinkClick?: (url: string) => void | Promise<void>;
  onSessionsChange?: (sessions: ChatSession[], currentKey: string | null) => void;
  requestedSession?: string | null;
  requestedSessionAction?: ChatSessionActionRequest | null;
  wideLayout?: boolean;
}) {
  const { isAuthenticated, isAuthConfigured, refreshBalance } = useAuth();
  const [localCreditsCents, setLocalCreditsCents] = useState<number | null>(null);
  const localTrialLoading =
    !gatewayRunning &&
    !isAuthenticated &&
    isAuthConfigured &&
    !useLocalKeys &&
    localCreditsCents === null;
  const proxyEnabled =
    isAuthConfigured &&
    !useLocalKeys &&
    (isAuthenticated || gatewayRunning || (localCreditsCents ?? 0) > 0);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draftsBySession, setDraftsBySession] = useState<Record<string, string>>({});
  const [shellDraftsBySession, setShellDraftsBySession] = useState<Record<string, string>>({});
  const [imageDraftsBySession, setImageDraftsBySession] = useState<Record<string, string>>({});
  const [isLoading, setIsLoading] = useState(false);
  const [activeWorkSessionKey, setActiveWorkSessionKey] = useState<string | null>(null);
  const [thinkingStatus, setThinkingStatus] = useState<string | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [showConnectingScreen, setShowConnectingScreen] = useState(false);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [currentSession, setCurrentSession] = useState<string | null>(null);
  const [outboxEntries, setOutboxEntries] = useState<PersistedPendingSend[]>([]);
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
  const [gatewayUrl, setGatewayUrl] = useState(DEFAULT_GATEWAY_URL);
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [savingWorkspaceImageKeys, setSavingWorkspaceImageKeys] = useState<Record<string, boolean>>({});
  const [savedWorkspaceImagePaths, setSavedWorkspaceImagePaths] = useState<Record<string, string>>({});
  const [openingOfficeFileKey, setOpeningOfficeFileKey] = useState<string | null>(null);
  const [toolActivityByRunId, setToolActivityByRunId] = useState<Record<string, ChatToolActivity[]>>({});
  const [activeToolRunId, setActiveToolRunId] = useState<string | null>(null);
  const [cancelInFlight, setCancelInFlight] = useState(false);
  const [approvalCommandInFlight, setApprovalCommandInFlight] = useState<string | null>(null);
  const [loadingWordIndex, setLoadingWordIndex] = useState(() => randomThinkingWordIndex());
  const [loadingWordChanging, setLoadingWordChanging] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [onboardingData, setOnboardingData] = useState<OnboardingData | null>(null);
  const [agentProfile, setAgentProfile] = useState<AgentProfile | null>(null);
  const [showWelcome, setShowWelcome] = useState(true);
  const [lastGatewayError, setLastGatewayError] = useState<string | null>(null);
  const [showOutOfCreditsModal, setShowOutOfCreditsModal] = useState(false);
  const [creditsCheckoutLoading, setCreditsCheckoutLoading] = useState(false);
  const [componentMountedAt] = useState(Date.now());
  const [showGatewayOfflineCta, setShowGatewayOfflineCta] = useState(false);
  const runTimingsRef = useRef<Record<string, {
    startedAt: number;
    ackAt?: number;
    firstDeltaAt?: number;
    finalAt?: number;
    toolSeenAt?: number;
  }>>({});
  const sessionModelRef = useRef<Record<string, string | null>>({});
  const runRevertModelRef = useRef<Record<string, string | null>>({});
  const [channelConfig, setChannelConfig] = useState<{
    telegramEnabled: boolean;
    telegramConnected: boolean;
  } | null>(null);
  const [telegramSetupOpen, setTelegramSetupOpen] = useState(false);
  const [composerModeBySession, setComposerModeBySession] = useState<Record<string, ComposerMode>>({});
  const [terminalStateBySession, setTerminalStateBySession] = useState<Record<string, ChatTerminalState>>({});
  const [integrationSetupBySession, setIntegrationSetupBySession] = useState<Record<string, IntegrationSetupState>>({});
  const [integrationLaunchBySession, setIntegrationLaunchBySession] = useState<Record<string, IntegrationLaunchState>>({});
  const [quickSuggestionBySession, setQuickSuggestionBySession] = useState<Record<string, QuickSuggestionState>>({});
  const [builderChecklistBySession, setBuilderChecklistBySession] = useState<Record<string, BuilderChecklistState>>({});

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const clientRef = useRef<GatewayClient | null>(null);
  const connectInFlightRef = useRef(false);
  const currentSessionRef = useRef<string | null>(null);
  const draftsRef = useRef<Record<string, string>>({});
  const shellDraftsRef = useRef<Record<string, string>>({});
  const imageDraftsRef = useRef<Record<string, string>>({});
  const outboxEntriesRef = useRef<PersistedPendingSend[]>([]);
  const copyResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const composerModeBySessionRef = useRef<Record<string, ComposerMode>>({});
  const terminalStateBySessionRef = useRef<Record<string, ChatTerminalState>>({});
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
  const providerOAuthRecoveryInFlightRef = useRef(false);
  const lastProviderOAuthRecoveryAtRef = useRef(0);
  const gatewayAuthRateLimitedUntilRef = useRef(0);
  // Local persistence: cache messages per session key
  const sessionMessagesRef = useRef<Record<string, Message[]>>({});
  const persistTimerRef = useRef<number | null>(null);
  const streamPersistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restoredFromCacheRef = useRef(false);
  const cacheLoadedRef = useRef(false);
  const activeRunIdRef = useRef<string | null>(null);
  const activeRunSessionRef = useRef<string | null>(null);
  const activeRunTimeoutRef = useRef<number | null>(null);
  const runSessionKeyRef = useRef<Record<string, string>>({});
  const runHistoryRecoveryRef = useRef<Record<string, boolean>>({});
  const detachedRunSessionRef = useRef<Record<string, string>>({});
  const gatewaySessionKeysRef = useRef<Set<string>>(new Set());
  const visibleMessagesSessionRef = useRef<string | null>(null);
  const builderSessionsRef = useRef<Set<string>>(new Set());
  const avatarUploadDataUrlByFileNameRef = useRef<Map<string, string>>(new Map());
  const wasVisibleRef = useRef(isVisible !== false);
  const outboxReplayInFlightRef = useRef(false);
  const streamedAssistantRunIdsRef = useRef<Set<string>>(new Set());
  const outboxDispatchInFlightRef = useRef<Set<string>>(new Set());
  const outboxWakeTimerRef = useRef<number | null>(null);
  const connectingScreenTimerRef = useRef<number | null>(null);
  const voiceSpeakResponseBySendIdRef = useRef<Set<string>>(new Set());
  const voiceSpeakResponseByRunIdRef = useRef<Set<string>>(new Set());
  const voiceReplyAudioRef = useRef<HTMLAudioElement | null>(null);
  const voiceSpeakingRunIdRef = useRef<string | null>(null);
  const voiceSpeechRunStateByRunIdRef = useRef<Record<string, VoiceSpeechRunState>>({});
  const liveVoiceDraftBaseRef = useRef<{ sessionKey: string; baseText: string } | null>(null);
  const sendAfterLiveVoiceStopRef = useRef(false);
  const workspaceOfficeOpenBySendIdRef = useRef<Record<string, { path: string }>>({});
  const workspaceOfficeOpenByRunIdRef = useRef<Record<string, { path: string }>>({});
  const [outboxWakeTick, setOutboxWakeTick] = useState(0);
  const activeComposerMode = currentSession
    ? composerModeBySession[currentSession] || DEFAULT_COMPOSER_MODE
    : DEFAULT_COMPOSER_MODE;
  const activeTerminalState = currentSession
    ? terminalStateBySession[currentSession] || { cwd: TERMINAL_DEFAULT_CWD }
    : { cwd: TERMINAL_DEFAULT_CWD };
  const normalizedVoiceSpeechRate = normalizeVoiceSpeechRate(voiceSpeechRate);
  const normalizedVoiceSpeechVoice = normalizeVoiceSpeechVoice(voiceSpeechVoice);
  const voiceSpeechProviderVoiceId = voiceIdForSpeechProvider(normalizedVoiceSpeechVoice, {
    useLocalKeys,
  });
  const { isTranscribing, transcribeAudio } = useAudioTranscription(audioUnderstandingModel);
  const { isGeneratingAudio, generateSpeech } = useTextToSpeech(textToSpeechModel, {
    voiceId: voiceSpeechProviderVoiceId,
    speed: normalizedVoiceSpeechRate,
  });

  function resizeChatComposer() {
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.style.height = "auto";
      const lineHeight = parseInt(getComputedStyle(textarea).lineHeight) || 20;
      const maxHeight = lineHeight * 5;
      textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`;
      textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
    });
  }

  async function startChatVoiceCapture() {
    const sessionKey = currentSession || ensureComposerSession();
    if (!sessionKey) return;
    setComposerModeForSession(sessionKey, "chat");
    sendAfterLiveVoiceStopRef.current = false;
    setError(null);
    if (streamingSpeech.isSupported) {
      liveVoiceDraftBaseRef.current = {
        sessionKey,
        baseText: draftsRef.current[sessionKey] || "",
      };
      setThinkingStatus("Listening");
      if (await streamingSpeech.start()) {
        resizeChatComposer();
        return;
      }
      liveVoiceDraftBaseRef.current = null;
      setThinkingStatus(null);
    }
    if (liveSpeech.isSupported) {
      liveVoiceDraftBaseRef.current = {
        sessionKey,
        baseText: draftsRef.current[sessionKey] || "",
      };
      setThinkingStatus("Listening");
      if (liveSpeech.start({ continuous: true, autoRestart: true })) {
        resizeChatComposer();
        return;
      }
      liveVoiceDraftBaseRef.current = null;
      setThinkingStatus(null);
    }
    setError("Live dictation is not available in this WebView.");
  }

  function handleComposerSend() {
    if (liveSpeech.isListening) {
      sendAfterLiveVoiceStopRef.current = true;
      liveSpeech.stop();
      return;
    }
    if (streamingSpeech.isRecording) {
      sendAfterLiveVoiceStopRef.current = true;
      streamingSpeech.stop();
      return;
    }
    void handleSend();
  }

  function stopChatVoiceCapture() {
    sendAfterLiveVoiceStopRef.current = false;
    if (liveSpeech.isListening) {
      setThinkingStatus("Finalizing recording");
      liveSpeech.stop();
      return;
    }
    if (streamingSpeech.isRecording) {
      setThinkingStatus("Transcribing recording");
      streamingSpeech.stop();
    }
  }

  function setChatDraftForSession(sessionKey: string, nextValue: string) {
    setDraftsBySession((prev) => {
      if (prev[sessionKey] === nextValue) return prev;
      return { ...prev, [sessionKey]: nextValue };
    });
    resizeChatComposer();
  }

  function updateLiveVoiceDraft(transcript: string) {
    const normalized = cleanRecordedVoiceTranscript(transcript).trim();
    const base = liveVoiceDraftBaseRef.current;
    if (!base) return;
    const nextValue = normalized
      ? base.baseText.trim()
        ? `${base.baseText.trimEnd()}\n\n${normalized}`
        : normalized
      : base.baseText;
    setComposerModeForSession(base.sessionKey, "chat");
    setChatDraftForSession(base.sessionKey, nextValue);
  }

  function finishLiveVoiceCapture(text: string) {
    const normalized = cleanRecordedVoiceTranscript(text).trim();
    const hadBase = liveVoiceDraftBaseRef.current !== null;
    updateLiveVoiceDraft(text);
    liveVoiceDraftBaseRef.current = null;
    setThinkingStatus(null);
    if (!normalized && hadBase && !sendAfterLiveVoiceStopRef.current) {
      setError("I didn't catch any speech in that recording. Try again.");
    }
    if (sendAfterLiveVoiceStopRef.current) {
      sendAfterLiveVoiceStopRef.current = false;
      window.setTimeout(() => {
        void handleSend();
      }, 0);
    }
  }

  function handleLiveVoiceError(message: string) {
    sendAfterLiveVoiceStopRef.current = false;
    setError(message);
    setThinkingStatus(null);
  }

  const liveSpeech = useLiveSpeechRecognition({
    onPartial: updateLiveVoiceDraft,
    onFinal: updateLiveVoiceDraft,
    onEnd: finishLiveVoiceCapture,
    onError: handleLiveVoiceError,
  });

  const streamingSpeech = useStreamingAudioTranscription({
    model: audioUnderstandingModel,
    maxBytes: MAX_ATTACHMENT_BYTES,
    onPartial: updateLiveVoiceDraft,
    onEnd: finishLiveVoiceCapture,
    onError: handleLiveVoiceError,
  });

  function attachRecordedAudio(attachment: RecordedAudioAttachment) {
    setPendingAttachments((prev) => {
      if (prev.length >= MAX_ATTACHMENTS_PER_MESSAGE) {
        setError(`You can attach up to ${MAX_ATTACHMENTS_PER_MESSAGE} files per message.`);
        revokeAttachmentPreviewUrl(attachment);
        return prev;
      }
      return [
        ...prev,
        {
          id: crypto.randomUUID(),
          fileName: attachment.fileName,
          mimeType: attachment.mimeType,
          content: attachment.content,
          previewUrl: attachment.previewUrl,
        },
      ];
    });
  }

  async function handleRecordedAudio(attachment: RecordedAudioAttachment) {
    try {
      setThinkingStatus("Transcribing recording");
      setError(null);
      if (!recordedAudioHasDetectedSpeech(attachment)) {
        revokeAttachmentPreviewUrl(attachment);
        setError("I didn't catch any speech in that recording. Try again.");
        return;
      }
      const transcript = cleanRecordedVoiceTranscript(await transcribeAudio([attachment]));
      insertTextIntoChatDraft(transcript);
      revokeAttachmentPreviewUrl(attachment);
    } catch (error) {
      attachRecordedAudio(attachment);
      setError(
        `${formatUnknownUiError(error, "Failed to transcribe recording.")} The audio was attached so you can retry.`,
      );
    } finally {
      setThinkingStatus(null);
    }
  }

  const audioRecorder = useAudioRecorder({
    maxBytes: MAX_ATTACHMENT_BYTES,
    onRecorded: handleRecordedAudio,
    onError: setError,
    autoStopOnSilence: {
      levelThreshold: 0.0035,
      silenceLevelThreshold: 0.0025,
      peakSilenceRatio: 0.18,
      noiseFloorMultiplier: 1.35,
      silenceMs: 750,
      minRecordingMs: 500,
      checkIntervalMs: 60,
    },
  });
  const pendingAudioAttachments = pendingAttachments.filter((attachment) =>
    attachment.mimeType.startsWith("audio/"),
  );
  const hasPendingAudioAttachments = pendingAudioAttachments.length > 0;
  const integrationSetup = currentSession ? integrationSetupBySession[currentSession] || null : null;
  const integrationLaunch = currentSession ? integrationLaunchBySession[currentSession] || null : null;
  const quickSuggestion = currentSession ? quickSuggestionBySession[currentSession] || null : null;
  const builderChecklist = currentSession ? builderChecklistBySession[currentSession] || null : null;

  function setIntegrationSetupForSession(sessionKey: string, value: IntegrationSetupState | null) {
    setIntegrationSetupBySession((prev) => {
      const next = { ...prev };
      if (value) {
        next[sessionKey] = value;
      } else {
        delete next[sessionKey];
      }
      return next;
    });
  }

  function setIntegrationLaunchForSession(sessionKey: string, value: IntegrationLaunchState | null) {
    setIntegrationLaunchBySession((prev) => {
      const next = { ...prev };
      if (value) {
        next[sessionKey] = value;
      } else {
        delete next[sessionKey];
      }
      return next;
    });
  }

  function cancelIntegrationLaunch(sessionKey: string) {
    setIntegrationLaunchForSession(sessionKey, null);
    const cachedMessages = sessionMessagesRef.current[sessionKey] || [];
    if (currentSessionRef.current === sessionKey && cachedMessages.length === 0) {
      setShowWelcome(true);
    }
  }

  function setTerminalStateForSession(sessionKey: string, value: ChatTerminalState | null) {
    setTerminalStateBySession((prev) => {
      const next = { ...prev };
      if (value) {
        next[sessionKey] = value;
      } else {
        delete next[sessionKey];
      }
      return next;
    });
  }

  function setComposerModeForSession(sessionKey: string, value: ComposerMode | null) {
    setComposerModeBySession((prev) => {
      const next = { ...prev };
      if (value && value !== DEFAULT_COMPOSER_MODE) {
        next[sessionKey] = value;
      } else {
        delete next[sessionKey];
      }
      return next;
    });
  }

  function setQuickSuggestionForSession(sessionKey: string, value: QuickSuggestionState | null) {
    setQuickSuggestionBySession((prev) => {
      const next = { ...prev };
      if (value) {
        next[sessionKey] = value;
      } else {
        delete next[sessionKey];
      }
      return next;
    });
  }

  function setBuilderChecklistForSession(sessionKey: string, value: BuilderChecklistState | null) {
    setBuilderChecklistBySession((prev) => {
      const next = { ...prev };
      if (value) {
        next[sessionKey] = value;
      } else {
        delete next[sessionKey];
      }
      return next;
    });
  }

  function requestSignIn() {
    window.dispatchEvent(
      new CustomEvent("entropic-require-signin", {
        detail: { source: "chat-credits" },
      })
    );
  }

  function extractBase64FromDataUrl(value: string): string | null {
    const match = /^data:[^;]+;base64,(.*)$/i.exec(value);
    return match ? match[1] : null;
  }

  function getGeneratedImageWorkspaceSaveUnsupportedReason(
    attachment: MessageAttachment,
  ): string | null {
    if (!attachment.previewUrl) {
      return "Image preview is unavailable.";
    }
    if (extractBase64FromDataUrl(attachment.previewUrl)) {
      return null;
    }
    return "This image was returned as a remote URL and cannot be saved to the workspace yet.";
  }

  function formatUnknownUiError(error: unknown, fallback: string): string {
    if (error instanceof Error && error.message.trim()) {
      return error.message.trim();
    }
    if (typeof error === "string" && error.trim()) {
      return error.trim();
    }
    if (error && typeof error === "object" && "message" in error) {
      const message = (error as { message?: unknown }).message;
      if (typeof message === "string" && message.trim()) {
        return message.trim();
      }
    }
    try {
      const serialized = JSON.stringify(error);
      if (serialized && serialized !== "{}") {
        return serialized;
      }
    } catch {
      // Ignore serialization failures and fall through.
    }
    return fallback;
  }

  function normalizeAttachmentFileName(name: string): string {
    return name.trim().toLowerCase();
  }

  function imageAttachmentActionKey(messageId: string, index: number): string {
    return `${messageId}-attachment-${index}`;
  }

  function extensionForImageMimeType(mimeType: string): string {
    const normalized = mimeType.trim().toLowerCase();
    if (normalized === "image/jpeg") return "jpg";
    if (normalized === "image/svg+xml") return "svg";
    if (normalized === "image/webp") return "webp";
    if (normalized === "image/gif") return "gif";
    return "png";
  }

  function buildWorkspaceImageFileName(fileName: string, mimeType: string): string {
    const trimmed = fileName.trim();
    const safeBase = (trimmed || "generated-image")
      .replace(/\.[a-z0-9]+$/i, "")
      .replace(/[^a-z0-9._-]+/gi, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .toLowerCase();
    const base = safeBase || "generated-image";
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const ext = extensionForImageMimeType(mimeType);
    return `${base}-${stamp}.${ext}`;
  }

  function readFileAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error(`Failed to read file: ${file.name}`));
      reader.onload = () => {
        if (typeof reader.result === "string") {
          resolve(reader.result);
        } else {
          reject(new Error(`Failed to read file: ${file.name}`));
        }
      };
      reader.readAsDataURL(file);
    });
  }

  function revokeAttachmentPreviewUrl(attachment: Pick<PendingAttachment, "previewUrl">) {
    if (attachment.previewUrl?.startsWith("blob:")) {
      URL.revokeObjectURL(attachment.previewUrl);
    }
  }

  function attachmentKindLabel(mimeType: string): string {
    const normalized = mimeType.trim().toLowerCase();
    if (normalized.startsWith("image/")) return "image";
    if (normalized.startsWith("audio/")) return "audio";
    if (normalized.startsWith("text/")) return "text";
    if (normalized === "application/pdf") return "pdf";
    return "file";
  }

  function renderPendingAttachmentPreview(attachment: PendingAttachment) {
    const officeMeta = officeWorkspaceFileMeta(attachment.fileName);
    const OfficeIcon = officeMeta?.Icon;
    if (attachment.mimeType.startsWith("image/") && attachment.previewUrl) {
      return (
        <img
          src={attachment.previewUrl}
          alt={attachment.fileName}
          className="w-8 h-8 rounded object-cover"
        />
      );
    }
    if (attachment.mimeType.startsWith("audio/")) {
      return (
        <div className="flex h-8 w-8 items-center justify-center rounded bg-[var(--bg-secondary)] text-[var(--text-secondary)]">
          <Music2 className="h-4 w-4" />
        </div>
      );
    }
    return (
      <div
        className="flex h-8 w-8 items-center justify-center rounded bg-[var(--bg-secondary)] text-[var(--text-secondary)]"
        style={officeMeta ? { color: officeMeta.accent } : undefined}
      >
        {OfficeIcon ? <OfficeIcon className="h-4 w-4" /> : <FileText className="h-4 w-4" />}
      </div>
    );
  }

  async function addAttachments(filesInput: FileList | File[] | null | undefined) {
    const files = filesInput ? Array.from(filesInput) : [];
    if (files.length === 0) return;

    const allowedFiles =
      activeComposerMode === "image"
        ? files.filter((file) => file.type.startsWith("image/"))
        : files;
    if (allowedFiles.length === 0) {
      setError(
        activeComposerMode === "image"
          ? "Only image attachments are supported in Image mode."
          : "No supported attachments were selected.",
      );
      return;
    }

    const remainingSlots = Math.max(0, MAX_ATTACHMENTS_PER_MESSAGE - pendingAttachments.length);
    if (remainingSlots <= 0) {
      setError(`You can attach up to ${MAX_ATTACHMENTS_PER_MESSAGE} files per message.`);
      return;
    }

    const selectedFiles = allowedFiles.slice(0, remainingSlots);
    if (allowedFiles.length > remainingSlots) {
      setError(`You can attach up to ${MAX_ATTACHMENTS_PER_MESSAGE} files per message.`);
    } else {
      setError(null);
    }

    const nextAttachments: PendingAttachment[] = [];
    for (const file of selectedFiles) {
      if (file.size > MAX_ATTACHMENT_BYTES) {
        setError(`${file.name} is too large. Max size is ${MAX_ATTACHMENT_MB} MB per file.`);
        continue;
      }
      try {
        const dataUrl = await readFileAsDataUrl(file);
        const base64 = extractBase64FromDataUrl(dataUrl);
        if (!base64) {
          throw new Error(`Failed to read file: ${file.name}`);
        }
        nextAttachments.push({
          id: crypto.randomUUID(),
          fileName: file.name,
          mimeType: file.type || "application/octet-stream",
          content: base64,
          previewUrl: dataUrl,
        });
        if (file.type.startsWith("image/")) {
          const key = normalizeAttachmentFileName(file.name);
          if (key) {
            avatarUploadDataUrlByFileNameRef.current.set(key, dataUrl);
            if (avatarUploadDataUrlByFileNameRef.current.size > 128) {
              const firstKey = avatarUploadDataUrlByFileNameRef.current.keys().next().value as
                | string
                | undefined;
              if (firstKey) avatarUploadDataUrlByFileNameRef.current.delete(firstKey);
            }
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : `Failed to attach ${file.name}.`);
      }
    }

    if (nextAttachments.length > 0) {
      setPendingAttachments((prev) => [...prev, ...nextAttachments]);
    }
  }

  function removePendingAttachment(attachmentId: string) {
    setPendingAttachments((prev) => {
      const next: PendingAttachment[] = [];
      for (const attachment of prev) {
        if (attachment.id === attachmentId) {
          revokeAttachmentPreviewUrl(attachment);
        } else {
          next.push(attachment);
        }
      }
      return next;
    });
  }

  function clearPendingAttachments() {
    setPendingAttachments((prev) => {
      for (const attachment of prev) {
        revokeAttachmentPreviewUrl(attachment);
      }
      return [];
    });
  }

  function insertTextIntoChatDraft(text: string) {
    const sessionKey = currentSession || ensureComposerSession();
    if (!sessionKey) return;
    setComposerModeForSession(sessionKey, "chat");
    setDraftsBySession((prev) => {
      const existing = (prev[sessionKey] || "").trim();
      const nextValue = existing ? `${existing}\n\n${text}` : text;
      if (prev[sessionKey] === nextValue) return prev;
      return { ...prev, [sessionKey]: nextValue };
    });
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.style.height = "auto";
      const lineHeight = parseInt(getComputedStyle(textarea).lineHeight) || 20;
      const maxHeight = lineHeight * 5;
      textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`;
      textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
    });
  }

  async function transcribePendingAudio() {
    try {
      setThinkingStatus("Transcribing audio");
      setError(null);
      const transcript = await transcribeAudio(pendingAudioAttachments);
      insertTextIntoChatDraft(transcript);
    } catch (error) {
      setError(formatUnknownUiError(error, "Failed to transcribe audio."));
    } finally {
      setThinkingStatus(null);
    }
  }

  function notifyVoiceResponseComplete(runId: string) {
    window.dispatchEvent(
      new CustomEvent("entropic-voice-response-complete", {
        detail: { runId },
      }),
    );
  }

  function notifyVoiceResponseStarted(runId: string) {
    window.dispatchEvent(
      new CustomEvent("entropic-voice-response-started", {
        detail: { runId },
      }),
    );
  }

  function getVoiceSpeechRunState(runId: string): VoiceSpeechRunState {
    const existing = voiceSpeechRunStateByRunIdRef.current[runId];
    if (existing) return existing;
    const next: VoiceSpeechRunState = {
      lastSourceText: "",
      pendingText: "",
      queue: [],
      processing: false,
      final: false,
      started: false,
      notified: false,
      sequence: 0,
      queuedAny: false,
    };
    voiceSpeechRunStateByRunIdRef.current[runId] = next;
    return next;
  }

  function clearCurrentVoiceReplyAudio() {
    const audio = voiceReplyAudioRef.current;
    if (!audio) return;
    audio.pause();
    audio.removeAttribute("src");
    voiceReplyAudioRef.current = null;
  }

  function completeVoiceSpeechRun(runId: string) {
    const state = voiceSpeechRunStateByRunIdRef.current[runId];
    if (state?.notified) return;
    if (state) state.notified = true;
    delete voiceSpeechRunStateByRunIdRef.current[runId];
    voiceSpeakResponseByRunIdRef.current.delete(runId);
    if (voiceSpeakingRunIdRef.current === runId) {
      voiceSpeakingRunIdRef.current = null;
    }
    setThinkingStatus((current) => (current === "Speaking response" ? null : current));
    notifyVoiceResponseComplete(runId);
  }

  async function createVoiceSpeechAudio(
    runId: string,
    speechText: string,
    chunk: VoiceSpeechChunk,
  ): Promise<HTMLAudioElement | null> {
    if (!voiceSpeakResponseByRunIdRef.current.has(runId)) return null;
    voiceSpeakingRunIdRef.current = runId;

    try {
      const generated = await generateSpeech(speechText);
      if (voiceSpeakingRunIdRef.current !== runId || !voiceSpeakResponseByRunIdRef.current.has(runId)) {
        return null;
      }
      const generatedAudio = generated.audio[0];
      if (!generatedAudio?.previewUrl) {
        throw new Error("Speech generation did not return audio.");
      }

      clientLog("voice.reply.generated_tts", {
        runId,
        sequence: chunk.sequence,
        source: chunk.source,
        chars: speechText.length,
        mimeType: generatedAudio.mimeType,
      });
      return new Audio(generatedAudio.previewUrl);
    } catch (error) {
      const message = formatUnknownUiError(
        error,
        "Voice response speech generation failed.",
      );
      addDiag(`voice reply TTS failed runId=${runId} seq=${chunk.sequence}: ${message}`);
      if (voiceSpeakingRunIdRef.current === runId) {
        voiceSpeakingRunIdRef.current = null;
      }
      setError(message);
      return null;
    }
  }

  function playVoiceSpeechAudio(runId: string, audio: HTMLAudioElement): Promise<void> {
    clearCurrentVoiceReplyAudio();
    voiceReplyAudioRef.current = audio;

    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        audio.removeEventListener("ended", handleEnded);
        audio.removeEventListener("error", handleError);
        audio.removeEventListener("pause", handlePause);
        if (voiceReplyAudioRef.current === audio) {
          voiceReplyAudioRef.current = null;
        }
      };
      const settle = (error?: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (voiceSpeakingRunIdRef.current === runId) {
          voiceSpeakingRunIdRef.current = null;
        }
        if (error) {
          reject(error);
          return;
        }
        resolve();
      };
      const handleEnded = () => settle();
      const handleError = () => settle(new Error("Voice response audio playback failed."));
      const handlePause = () => {
        if (voiceSpeakingRunIdRef.current !== runId) {
          settle();
        }
      };

      audio.addEventListener("ended", handleEnded);
      audio.addEventListener("error", handleError);
      audio.addEventListener("pause", handlePause);
      audio.play().catch((error: unknown) => {
        settle(error instanceof Error ? error : new Error("Voice response audio playback failed."));
      });
    });
  }

  async function processVoiceSpeechQueue(runId: string) {
    const state = voiceSpeechRunStateByRunIdRef.current[runId];
    if (!state || state.processing) return;
    state.processing = true;
    if (!state.started) {
      state.started = true;
      notifyVoiceResponseStarted(runId);
    }
    setThinkingStatus("Speaking response");

    try {
      while (voiceSpeakResponseByRunIdRef.current.has(runId)) {
        const chunk = state.queue.shift();
        if (!chunk) break;
        const speechText = formatAssistantResponseForSpeech(chunk.text);
        if (!speechText) continue;

        const audio = await createVoiceSpeechAudio(runId, speechText, chunk);
        if (!audio || !voiceSpeakResponseByRunIdRef.current.has(runId)) return;
        await playVoiceSpeechAudio(runId, audio);
      }
    } catch (error) {
      addDiag(`voice reply playback failed runId=${runId}: ${String(error)}`);
    } finally {
      const current = voiceSpeechRunStateByRunIdRef.current[runId];
      if (!current) return;
      current.processing = false;
      if (current.queue.length > 0) {
        void processVoiceSpeechQueue(runId);
        return;
      }
      if (current.final) {
        completeVoiceSpeechRun(runId);
        return;
      }
      setThinkingStatus((status) => (status === "Speaking response" ? null : status));
    }
  }

  function enqueueVoiceAssistantSpeech(
    runId: string,
    text: string,
    options: { final: boolean; source: VoiceSpeechChunk["source"] },
  ) {
    if (!runId || !voiceSpeakResponseByRunIdRef.current.has(runId)) return;

    const state = getVoiceSpeechRunState(runId);
    const sourceText = text.trimEnd();
    let delta = "";
    if (!state.lastSourceText) {
      delta = sourceText;
    } else if (sourceText.startsWith(state.lastSourceText)) {
      delta = sourceText.slice(state.lastSourceText.length);
    } else if (options.final) {
      delta = state.queuedAny ? "" : sourceText;
    } else if (sourceText.length > state.lastSourceText.length) {
      delta = sourceText.slice(state.lastSourceText.length);
    }
    state.lastSourceText = sourceText;

    if (delta) {
      state.pendingText += delta;
    }
    if (options.final) {
      state.final = true;
    }

    const { chunks, rest } = splitVoiceSpeechBuffer(state.pendingText, options.final);
    state.pendingText = rest;
    for (const chunkText of chunks) {
      state.sequence += 1;
      state.queuedAny = true;
      state.queue.push({
        sequence: state.sequence,
        text: chunkText,
        source: options.source,
      });
    }

    if (state.queue.length > 0 && !state.processing) {
      void processVoiceSpeechQueue(runId);
      return;
    }
    if (state.final && !state.processing && state.queue.length === 0) {
      completeVoiceSpeechRun(runId);
    }
  }

  function scheduleSpeakAssistantResponseForRun(
    runId: string,
    sessionKey: string | null | undefined,
    fallbackText: string,
  ) {
    if (!runId || !voiceSpeakResponseByRunIdRef.current.has(runId)) return;
    const existingSpeechState = voiceSpeechRunStateByRunIdRef.current[runId];
    if (
      existingSpeechState &&
      (
        existingSpeechState.queuedAny ||
        existingSpeechState.queue.length > 0 ||
        existingSpeechState.pendingText.trim() ||
        existingSpeechState.processing
      )
    ) {
      enqueueVoiceAssistantSpeech(runId, "", {
        final: true,
        source: "history",
      });
      return;
    }

    let attempts = 0;
    const maxAttempts = 10;
    const scheduleAttempt = () => {
      window.setTimeout(() => {
        if (!voiceSpeakResponseByRunIdRef.current.has(runId)) return;
        const currentSpeechState = voiceSpeechRunStateByRunIdRef.current[runId];
        if (
          currentSpeechState &&
          (
            currentSpeechState.queuedAny ||
            currentSpeechState.queue.length > 0 ||
            currentSpeechState.pendingText.trim() ||
            currentSpeechState.processing
          )
        ) {
          enqueueVoiceAssistantSpeech(runId, "", {
            final: true,
            source: "history",
          });
          return;
        }
        attempts += 1;

        const sessionMessages = sessionKey ? sessionMessagesRef.current[sessionKey] || [] : [];
        const visibleMessages = messagesRef.current;
        const visibleAssistantText = [...sessionMessages, ...visibleMessages]
          .reverse()
          .find((message) => message.id === runId && message.role === "assistant")
          ?.content
          ?.trim();
        if (!visibleAssistantText && attempts < maxAttempts) {
          scheduleAttempt();
          return;
        }

        const assistantText = visibleAssistantText || fallbackText.trim();
        if (!assistantText) return;
        clientLog("voice.reply.speak", {
          runId,
          chars: assistantText.length,
          source: visibleAssistantText ? "chat_state" : "final_event",
        });
        enqueueVoiceAssistantSpeech(runId, assistantText, {
          final: true,
          source: visibleAssistantText ? "history" : "final_event",
        });
      }, 100);
    };

    scheduleAttempt();
  }

  async function handleQuickAddCredits() {
    setCreditsCheckoutLoading(true);
    try {
      const { checkout_url } = await createCheckout(500);
      if (checkout_url) {
        await open(checkout_url);
        setShowOutOfCreditsModal(false);
      }
    } catch (err) {
      console.error("[Entropic] Quick checkout failed:", err);
      setError("Failed to start checkout. Try from Billing page.");
    } finally {
      setCreditsCheckoutLoading(false);
    }
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
    if (text.includes("gateway token mismatch")) return true;
    if (text.includes("ai provider error: 401")) return true;
    if (text.includes("no cookie auth credentials found")) return true;
    if (text.includes("oauth token has expired")) return true;
    if (text.includes("authentication_error") && text.includes("refresh your existing token")) return true;
    const has401 = text.includes("401") || text.includes("unauthorized");
    const looksProxy =
      text.includes("chat/completions") ||
      text.includes("ai provider") ||
      text.includes("authentication_error") ||
      text.includes("cookie auth credentials") ||
      text.includes("gateway token");
    return has401 && looksProxy;
  }

  function isGatewayAuthRateLimited(message?: string | null): boolean {
    if (!message) return false;
    const text = message.toLowerCase();
    return (
      text.includes("too many failed authentication attempts") ||
      text.includes("auth_rate_limited") ||
      (text.includes("rate_limited") && text.includes("unauthorized"))
    );
  }

  function isProviderOAuthExpiryFailure(message?: string | null): boolean {
    if (!message) return false;
    const text = message.toLowerCase();
    return (
      text.includes("oauth token has expired") ||
      (text.includes("authentication_error") && text.includes("refresh your existing token")) ||
      (text.includes("authentication_error") && text.includes("obtain a new token"))
    );
  }

  function currentRecoverableOAuthProvider(): "anthropic" | "openai" | null {
    if (!useLocalKeys) return null;
    if (connectedProvider === "anthropic" || connectedProvider === "openai") {
      return connectedProvider;
    }
    return null;
  }

  function providerDisplayName(provider: "anthropic" | "openai"): string {
    return provider === "anthropic" ? "Anthropic" : "OpenAI";
  }

  function readGatewayRetryAfterMs(details: unknown): number | null {
    if (!details || typeof details !== "object" || Array.isArray(details)) {
      return null;
    }
    const retryAfterMs = (details as { retryAfterMs?: unknown }).retryAfterMs;
    return typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs > 0
      ? retryAfterMs
      : null;
  }

  function applyGatewayAuthRateLimit(message?: string | null, retryAfterMs?: number | null) {
    const cooldownMs =
      typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs > 0
        ? retryAfterMs
        : 60_000;
    gatewayAuthRateLimitedUntilRef.current = Date.now() + cooldownMs;
    const retrySeconds = Math.max(
      1,
      Math.ceil((gatewayAuthRateLimitedUntilRef.current - Date.now()) / 1000),
    );
    setError(
      message?.trim()
        ? `${message.trim()} Waiting about ${retrySeconds}s before reconnecting.`
        : `Gateway authentication was rate-limited. Waiting about ${retrySeconds}s before reconnecting.`,
    );
    addDiag(`gateway auth rate-limited; backing off for ${retrySeconds}s`);
  }

  async function getRecoveryCreditBalanceCents(): Promise<number | null> {
    if (!isAuthConfigured || useLocalKeys) {
      return null;
    }

    if (isAuthenticated) {
      const balance = await getBalance();
      return balance.balance_cents;
    }

    const balance = await getLocalCreditBalance();
    setLocalCreditsCents(balance.balance_cents);
    return balance.balance_cents;
  }

  async function applyProxyRecoveryFailureState(label: string) {
    try {
      const balanceCents = await getRecoveryCreditBalanceCents();
      if (typeof balanceCents === "number" && balanceCents <= 0) {
        setShowOutOfCreditsModal(true);
        setError(BILLING_RECOVERY_MESSAGE);
        addDiag(`${label} caused by exhausted credits`);
        return;
      }
    } catch (err) {
      addDiag(`${label} balance check failed: ${String(err)}`);
    }

    setError("Failed to refresh proxy session. Retry from Settings > Gateway.");
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
      .then(async (ok) => {
        if (ok) {
          setError("Proxy session refreshed. Please resend your last message.");
          addDiag("proxy auth recovery succeeded");
          return;
        }
        addDiag("proxy auth recovery failed; checking credit balance");
        await applyProxyRecoveryFailureState("proxy auth failure");
      })
      .catch(async (err) => {
        addDiag(`proxy auth recovery error: ${String(err)}`);
        await applyProxyRecoveryFailureState("proxy auth error");
      })
      .finally(() => {
        proxyAuthRecoveryInFlightRef.current = false;
      });
  }

  async function recoverExpiredProviderOAuth(
    source: string,
    rawMessage?: string | null,
  ): Promise<boolean> {
    if (!isProviderOAuthExpiryFailure(rawMessage)) return false;
    const provider = currentRecoverableOAuthProvider();
    if (!provider) return false;

    const now = Date.now();
    const recoveryCooldownMs = 30_000;
    const inCooldown = now - lastProviderOAuthRecoveryAtRef.current < recoveryCooldownMs;
    if (providerOAuthRecoveryInFlightRef.current || inCooldown) {
      addDiag(`provider oauth recovery skipped (${source}; already in progress or cooldown)`);
      return true;
    }

    providerOAuthRecoveryInFlightRef.current = true;
    lastProviderOAuthRecoveryAtRef.current = now;
    const label = providerDisplayName(provider);
    setError(`${label} OAuth token expired. Refreshing...`);
    addDiag(`provider oauth failure detected from ${source}; refreshing ${provider}`);

    try {
      await invoke("refresh_provider_token", { provider });
      window.dispatchEvent(new Event("entropic-auth-changed"));

      if (gatewayRunning) {
        addDiag(`provider oauth refresh succeeded; restarting gateway for ${provider}`);
        await invoke<GatewayMutationResult>("apply_gateway_mutation", {
          request: {
            model: selectedModel,
            forceRestart: true,
          },
        });
      } else {
        addDiag(`provider oauth refresh succeeded; starting gateway for ${provider}`);
        await invoke("start_gateway", { model: selectedModel });
      }

      setError(`${label} OAuth token refreshed. Please resend your last message.`);
      return true;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      addDiag(`provider oauth recovery failed for ${provider}: ${detail}`);
      setError(`${label} OAuth token expired. Refresh failed. Sign in again in Settings.`);
      return false;
    } finally {
      providerOAuthRecoveryInFlightRef.current = false;
    }
  }

  async function refreshGatewayAfterProviderAuthChange(): Promise<void> {
    window.dispatchEvent(new Event("entropic-auth-changed"));

    if (!useLocalKeys) {
      const refreshed = onRecoverProxyAuth
        ? await Promise.resolve(onRecoverProxyAuth())
        : false;
      if (!refreshed) {
        throw new Error(
          "Proxy mode is selected, but the proxy session could not be refreshed. Sign in to Entropic or enable local keys to use direct provider auth.",
        );
      }
      return;
    }

    if (gatewayRunning) {
      await invoke<GatewayMutationResult>("apply_gateway_mutation", {
        request: {
          model: selectedModel,
          forceRestart: true,
        },
      });
    } else {
      await invoke("start_gateway", { model: selectedModel });
    }
  }

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      invoke<{
        telegram_enabled?: boolean;
        telegram_token?: string;
      }>("get_agent_profile_state"),
      invoke<boolean>("get_telegram_connection_status").catch(() => false),
    ])
      .then(([state, telegramConnected]) => {
        if (cancelled) return;
        setChannelConfig({
          telegramEnabled: Boolean(state.telegram_enabled && state.telegram_token?.trim()),
          telegramConnected: Boolean(telegramConnected),
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Restore sessions from local cache on mount
  useEffect(() => {
    if (restoredFromCacheRef.current) return;
    restoredFromCacheRef.current = true;
    loadPersistedChatData().then((cached) => {
      if (!cached) {
        cacheLoadedRef.current = true;
        return;
      }
      if (cached.sessions.length > 0) {
        sessionMessagesRef.current = cached.messages || {};
        for (const [sessionKey, msgs] of Object.entries(sessionMessagesRef.current)) {
          sessionMessagesRef.current[sessionKey] = msgs.map(normalizeCachedMessage);
        }
        setSessions(applySessionTitles(cached.sessions));
        setDraftsBySession(cached.drafts || {});
        setShellDraftsBySession(cached.shellDrafts || {});
        setImageDraftsBySession(cached.imageDrafts || {});
        replaceOutboxEntries(cached.outbox || []);
        setComposerModeBySession(cached.composerModeBySession || {});
        setTerminalStateBySession(cached.terminalBySession || {});
        const restoreKey = cached.currentSession || cached.sessions[0].key;
        currentSessionRef.current = restoreKey;
        setCurrentSession(restoreKey);
        const restoredMsgs = (cached.messages[restoreKey] || []).map(normalizeCachedMessage);
        visibleMessagesSessionRef.current = restoreKey;
        setMessages(restoredMsgs);
        if (restoredMsgs.length > 0) setShowWelcome(false);
      }
      cacheLoadedRef.current = true;
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
      const shellDraftsSnap = { ...shellDraftsRef.current };
      const imageDraftsSnap = { ...imageDraftsRef.current };
      const outboxSnap = [...outboxEntriesRef.current];
      const composerModeSnap = { ...composerModeBySessionRef.current };
      const terminalSnap = { ...terminalStateBySessionRef.current };
      persistChatData({
        sessions: sessionsSnap,
        messages: messagesSnap,
        drafts: draftsSnap,
        shellDrafts: shellDraftsSnap,
        imageDrafts: imageDraftsSnap,
        composerModeBySession: composerModeSnap,
        terminalBySession: terminalSnap,
        currentSession: currentSnap,
        outbox: outboxSnap,
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

    setShellDraftsBySession((prev) => {
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

    setImageDraftsBySession((prev) => {
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

    setComposerModeBySession((prev) => {
      const fromMode = prev[from];
      if (!fromMode) return prev;
      const next = { ...prev };
      if (!next[to]) {
        next[to] = fromMode;
      }
      delete next[from];
      return next;
    });

    setIntegrationSetupBySession((prev) => {
      const fromSetup = prev[from];
      if (!fromSetup) return prev;
      const next = { ...prev };
      if (!next[to]) {
        next[to] = fromSetup;
      }
      delete next[from];
      return next;
    });

    setQuickSuggestionBySession((prev) => {
      const fromSuggestion = prev[from];
      if (!fromSuggestion) return prev;
      const next = { ...prev };
      if (!next[to]) {
        next[to] = fromSuggestion;
      }
      delete next[from];
      return next;
    });

    setTerminalStateBySession((prev) => {
      const fromState = prev[from];
      if (!fromState) return prev;
      const next = { ...prev };
      if (!next[to]) {
        next[to] = fromState;
      }
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

    if (outboxEntriesRef.current.some((entry) => entry.sessionKey === from)) {
      replaceOutboxEntries(
        outboxEntriesRef.current.map((entry) =>
          entry.sessionKey === from ? { ...entry, sessionKey: to } : entry,
        ),
      );
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
  const messagesRef = useRef<Message[]>([]);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

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

  useEffect(() => {
    shellDraftsRef.current = shellDraftsBySession;
  }, [shellDraftsBySession]);

  useEffect(() => {
    imageDraftsRef.current = imageDraftsBySession;
  }, [imageDraftsBySession]);

  useEffect(() => {
    outboxEntriesRef.current = outboxEntries;
  }, [outboxEntries]);

  useEffect(() => {
    composerModeBySessionRef.current = composerModeBySession;
  }, [composerModeBySession]);

  useEffect(() => {
    terminalStateBySessionRef.current = terminalStateBySession;
  }, [terminalStateBySession]);

  // Persist on unmount (navigation away)
  useEffect(() => {
    return () => {
      if (persistTimerRef.current) window.clearTimeout(persistTimerRef.current);
      if (streamPersistTimerRef.current) clearTimeout(streamPersistTimerRef.current);
      clearActiveRunTracking();
      clearCurrentVoiceReplyAudio();
      voiceSpeakingRunIdRef.current = null;
      voiceSpeechRunStateByRunIdRef.current = {};
      const sessionsSnap = sessionsRef.current;
      const currentSnap = currentSessionRef.current;
      const messagesSnap = { ...sessionMessagesRef.current };
      const draftsSnap = { ...draftsRef.current };
      const shellDraftsSnap = { ...shellDraftsRef.current };
      const imageDraftsSnap = { ...imageDraftsRef.current };
      const outboxSnap = [...outboxEntriesRef.current];
      const composerModeSnap = { ...composerModeBySessionRef.current };
      const terminalSnap = { ...terminalStateBySessionRef.current };
      if (sessionsSnap.length > 0 || outboxSnap.length > 0) {
        persistChatData({
          sessions: sessionsSnap,
          messages: messagesSnap,
          drafts: draftsSnap,
          shellDrafts: shellDraftsSnap,
          imageDrafts: imageDraftsSnap,
          composerModeBySession: composerModeSnap,
          terminalBySession: terminalSnap,
          currentSession: currentSnap,
          outbox: outboxSnap,
        });
      }
      if (outboxWakeTimerRef.current) {
        window.clearTimeout(outboxWakeTimerRef.current);
        outboxWakeTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    function stopVoiceReplyAudio() {
      const hadSpeechState =
        voiceReplyAudioRef.current ||
        voiceSpeakingRunIdRef.current ||
        Object.keys(voiceSpeechRunStateByRunIdRef.current).length > 0;
      if (!hadSpeechState) return;
      voiceSpeakResponseBySendIdRef.current.clear();
      voiceSpeakResponseByRunIdRef.current.clear();
      voiceSpeechRunStateByRunIdRef.current = {};
      voiceSpeakingRunIdRef.current = null;
      clearCurrentVoiceReplyAudio();
      setThinkingStatus((current) => (current === "Speaking response" ? null : current));
      clientLog("voice.reply.stopped_for_capture");
    }

    window.addEventListener("entropic-voice-capture-started", stopVoiceReplyAudio);
    window.addEventListener("entropic-voice-response-stop-requested", stopVoiceReplyAudio);
    return () => {
      window.removeEventListener("entropic-voice-capture-started", stopVoiceReplyAudio);
      window.removeEventListener("entropic-voice-response-stop-requested", stopVoiceReplyAudio);
    };
  }, []);

  function addDiag(message: string) {
    appendDiagnosticLog({
      source: "chat",
      message,
    });
  }

  function sortOutboxEntries(entries: PersistedPendingSend[]): PersistedPendingSend[] {
    return [...entries].sort((a, b) => {
      if (a.nextAttemptAt !== b.nextAttemptAt) {
        return a.nextAttemptAt - b.nextAttemptAt;
      }
      return a.createdAt - b.createdAt;
    });
  }

  function clearOutboxWakeTimer() {
    if (outboxWakeTimerRef.current !== null) {
      window.clearTimeout(outboxWakeTimerRef.current);
      outboxWakeTimerRef.current = null;
    }
  }

  function scheduleOutboxWake(entries: PersistedPendingSend[] = outboxEntriesRef.current) {
    clearOutboxWakeTimer();
    if (entries.length === 0) {
      return;
    }
    const nextAttemptAt = entries.reduce<number | null>((soonest, entry) => {
      if (soonest === null) return entry.nextAttemptAt;
      return Math.min(soonest, entry.nextAttemptAt);
    }, null);
    if (nextAttemptAt === null) {
      return;
    }
    const delayMs = Math.max(0, nextAttemptAt - Date.now());
    if (delayMs === 0) {
      setOutboxWakeTick((tick) => tick + 1);
      return;
    }
    outboxWakeTimerRef.current = window.setTimeout(() => {
      outboxWakeTimerRef.current = null;
      setOutboxWakeTick((tick) => tick + 1);
    }, delayMs);
  }

  function replaceOutboxEntries(nextEntries: PersistedPendingSend[]) {
    const next = sortOutboxEntries(nextEntries);
    outboxEntriesRef.current = next;
    setOutboxEntries(next);
    scheduleOutboxWake(next);
    schedulePersist();
  }

  function upsertOutboxEntry(entry: PersistedPendingSend) {
    const next = [
      ...outboxEntriesRef.current.filter((current) => current.id !== entry.id),
      entry,
    ];
    replaceOutboxEntries(next);
  }

  function removeOutboxEntry(entryId: string) {
    if (!outboxEntriesRef.current.some((entry) => entry.id === entryId)) {
      return;
    }
    replaceOutboxEntries(outboxEntriesRef.current.filter((entry) => entry.id !== entryId));
  }

  function updateOutboxEntry(
    entryId: string,
    updater: (entry: PersistedPendingSend) => PersistedPendingSend | null,
  ) {
    const next: PersistedPendingSend[] = [];
    let changed = false;
    for (const entry of outboxEntriesRef.current) {
      if (entry.id !== entryId) {
        next.push(entry);
        continue;
      }
      const updated = updater(entry);
      changed = true;
      if (updated) {
        next.push(updated);
      }
    }
    if (!changed) {
      return;
    }
    replaceOutboxEntries(next);
  }

  function pendingSendBackoffMs(attemptCount: number) {
    return Math.min(5_000, 500 * Math.pow(2, Math.min(attemptCount, 4)));
  }

  function isTransientGatewayConnectState() {
    const inStartupGracePeriod = Date.now() - componentMountedAt < 15_000;
    return gatewayStarting || isConnecting || !gatewayRunning || inStartupGracePeriod;
  }

  function clearActiveRunTracking() {
    activeRunIdRef.current = null;
    activeRunSessionRef.current = null;
    setActiveWorkSessionKey(null);
    setActiveToolRunId(null);
    if (activeRunTimeoutRef.current) {
      window.clearTimeout(activeRunTimeoutRef.current);
      activeRunTimeoutRef.current = null;
    }
    setOutboxWakeTick((tick) => tick + 1);
  }

  async function cancelCurrentWork() {
    if (cancelInFlight) return;
    const sessionKey = currentSessionRef.current;
    if (!sessionKey) return;

    const runId = activeRunIdRef.current;
    const runSessionKey =
      activeRunSessionRef.current ||
      (runId ? runSessionKeyRef.current[runId] || "" : "");
    if (runId && runSessionKey === sessionKey && clientRef.current) {
      setCancelInFlight(true);
      setThinkingStatus("Stopping");
      setError(null);
      try {
        await clientRef.current.abortChat(sessionKey, runId);
        addDiag(`abort requested runId=${runId}`);
      } catch (error) {
        const message = formatUnknownUiError(error, "Failed to stop the current response.");
        setError(message);
        addDiag(`abort failed runId=${runId}: ${String(error)}`);
      } finally {
        setCancelInFlight(false);
      }
      return;
    }

    const queuedEntries = outboxEntriesRef.current.filter((entry) => entry.sessionKey === sessionKey);
    if (queuedEntries.length > 0) {
      queuedEntries.forEach((entry) => {
        removeOutboxEntry(entry.id);
        voiceSpeakResponseBySendIdRef.current.delete(entry.id);
        delete workspaceOfficeOpenBySendIdRef.current[entry.id];
      });
      setIsLoading(false);
      setThinkingStatus(null);
      setActiveWorkSessionKey(null);
      setError(null);
      appendAssistantNotice("Queued message cancelled.", sessionKey);
      addDiag(`cancelled ${queuedEntries.length} queued send(s) session=${sessionKey}`);
      return;
    }

    setError("Stopping `/run` commands is not available yet.");
  }

  function recoverInterruptedActiveRun(reason: string) {
    const runId = activeRunIdRef.current;
    const sessionKey =
      activeRunSessionRef.current ||
      (runId ? runSessionKeyRef.current[runId] || "" : "") ||
      currentSessionRef.current ||
      "";
    if (!runId || !sessionKey) {
      setIsLoading(false);
      setThinkingStatus(null);
      setActiveWorkSessionKey(null);
      clearActiveRunTracking();
      return;
    }

    addDiag(`${reason} runId=${runId}; waiting for reconnect/history recovery`);
    setIsLoading(true);
    setActiveWorkSessionKey(sessionKey);
    setThinkingStatus("Finalizing response");
    setError(null);
    clearActiveRunTracking();
    void recoverFinalRunFromHistory(runId, sessionKey).finally(() => {
      setIsLoading(false);
      setActiveWorkSessionKey(null);
    });
  }

  function refreshActiveRunTimeout(runId: string) {
    if (!runId || activeRunIdRef.current !== runId) return;
    if (activeRunTimeoutRef.current) {
      window.clearTimeout(activeRunTimeoutRef.current);
      activeRunTimeoutRef.current = null;
    }
    activeRunTimeoutRef.current = window.setTimeout(() => {
      if (activeRunIdRef.current !== runId) return;
      const lastActivity = lastEventByRunIdRef.current[runId] ?? Date.now();
      const idleMs = Date.now() - lastActivity;
      if (idleMs < ACTIVE_RUN_IDLE_TIMEOUT_MS) {
        refreshActiveRunTimeout(runId);
        return;
      }
      setIsLoading(false);
      setError("Response timed out waiting for stream activity. Please retry.");
      finalizeRunningToolActivities(runId, "error");
      addDiag(`run timeout after ${Math.round(ACTIVE_RUN_IDLE_TIMEOUT_MS / 1000)}s idle runId=${runId}`);
      clearActiveRunTracking();
    }, ACTIVE_RUN_IDLE_TIMEOUT_MS);
  }

  function scheduleActiveRunTimeout(runId: string, sessionKey: string) {
    clearActiveRunTracking();
    activeRunIdRef.current = runId;
    activeRunSessionRef.current = sessionKey;
    setActiveWorkSessionKey(sessionKey);
    setActiveToolRunId(runId);
    streamedAssistantRunIdsRef.current.delete(runId);
    setToolActivityByRunId((prev) => ({ ...prev, [runId]: [] }));
    runSessionKeyRef.current[runId] = sessionKey;
    lastEventByRunIdRef.current[runId] = Date.now();
    refreshActiveRunTimeout(runId);
  }

  function createDetachedRunSession(runId: string, label = "Scheduled run"): string {
    const existing = detachedRunSessionRef.current[runId] || runSessionKeyRef.current[runId];
    if (existing) return existing;

    const sessionKey = `scheduled-${runId || crypto.randomUUID()}`;
    detachedRunSessionRef.current[runId] = sessionKey;
    runSessionKeyRef.current[runId] = sessionKey;
    sessionMessagesRef.current[sessionKey] = sessionMessagesRef.current[sessionKey] || [];
    setSessions((prev) => {
      if (prev.some((session) => session.key === sessionKey)) {
        return prev;
      }
      return applySessionTitles(
        normalizeSessionsList([{ key: sessionKey, label, updatedAt: Date.now() }, ...prev]),
      );
    });
    schedulePersist();
    return sessionKey;
  }

  function upsertAssistantMessageForSession(
    sessionKey: string,
    runId: string,
    normalized: ReturnType<typeof normalizeGatewayMessage>,
  ) {
    if (!normalized) return;
    const text = normalized.content ?? "";
    const hasRenderableAssistantPayload = Boolean(
      normalized.assistantPayload &&
        (normalized.assistantPayload.events.length > 0 || normalized.assistantPayload.errors.length > 0)
    );
    if (!text && !hasRenderableAssistantPayload) return;

    const nextMessage: Message = {
      id: runId || crypto.randomUUID(),
      role: "assistant",
      content: text,
      kind: normalized.kind,
      toolName: normalized.toolName,
      assistantPayload: normalized.assistantPayload,
      sentAt: normalized.sentAt ?? Date.now(),
    };
    const existing = sessionMessagesRef.current[sessionKey] || [];
    const existingIdx = existing.findIndex((message) => message.id === nextMessage.id && message.role === "assistant");
    const nextMessages =
      existingIdx >= 0
        ? existing.map((message, index) =>
            index === existingIdx
              ? {
                  ...message,
                  content: text,
                  kind: normalized.kind ?? message.kind,
                  toolName: normalized.toolName ?? message.toolName,
                  assistantPayload: normalized.assistantPayload ?? message.assistantPayload,
                  sentAt: message.sentAt ?? normalized.sentAt ?? Date.now(),
                }
              : message,
          )
        : [...existing, nextMessage];
    sessionMessagesRef.current[sessionKey] = nextMessages;
    setSessions((prev) =>
      applySessionTitles(
        normalizeSessionsList(
          prev.some((session) => session.key === sessionKey)
            ? prev.map((session) =>
                session.key === sessionKey ? { ...session, updatedAt: Date.now() } : session,
              )
            : [{ key: sessionKey, label: "Scheduled run", updatedAt: Date.now() }, ...prev],
        ),
      ),
    );
    if (currentSessionRef.current === sessionKey) {
      setMessages(nextMessages);
    }
    schedulePersist();
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
      createNewSession({ force: true });
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
  }, [messages, isLoading, integrationSetup, quickSuggestion]);

  useEffect(() => {
    if (!isLoading) {
      setLoadingWordIndex((current) => randomThinkingWordIndex(current));
      setLoadingWordChanging(false);
      return;
    }
    setLoadingWordIndex((current) => randomThinkingWordIndex(current));
    let settleTimer: number | null = null;
    const intervalId = window.setInterval(() => {
      setLoadingWordChanging(true);
      if (settleTimer !== null) {
        window.clearTimeout(settleTimer);
      }
      settleTimer = window.setTimeout(() => {
        setLoadingWordIndex((current) => randomThinkingWordIndex(current));
        setLoadingWordChanging(false);
        settleTimer = null;
      }, 180);
    }, 3_000);
    return () => {
      window.clearInterval(intervalId);
      if (settleTimer !== null) {
        window.clearTimeout(settleTimer);
      }
    };
  }, [isLoading]);

  useEffect(() => {
    currentSessionRef.current = currentSession;
  }, [currentSession]);

  useEffect(() => {
    if (!textareaRef.current) return;
    const ta = textareaRef.current;
    ta.style.height = "auto";
    const lineHeight = parseInt(getComputedStyle(ta).lineHeight) || 20;
    const maxHeight = lineHeight * 5;
    ta.style.height = `${Math.min(ta.scrollHeight, maxHeight)}px`;
    ta.style.overflowY = ta.scrollHeight > maxHeight ? "auto" : "hidden";
  }, [currentSession, activeComposerMode]);

  // When returning to the chat view, rehydrate the currently selected session.
  useEffect(() => {
    const visible = isVisible !== false;
    if (!visible) {
      wasVisibleRef.current = false;
      return;
    }
    if (wasVisibleRef.current) return;
    wasVisibleRef.current = true;

    const sessionKey = currentSessionRef.current;
    if (!sessionKey) {
      const fallback = sessionsRef.current[0]?.key;
      if (fallback) {
        void selectSession(fallback);
      }
      return;
    }

    const sessionExists = sessionsRef.current.some((session) => session.key === sessionKey);
    if (!sessionExists) {
      const fallback = sessionsRef.current[0]?.key;
      if (fallback && fallback !== sessionKey) {
        void selectSession(fallback);
      }
      return;
    }

    const cachedMsgs = (sessionMessagesRef.current[sessionKey] || []).map(normalizeCachedMessage);
    visibleMessagesSessionRef.current = sessionKey;
    setMessages(cachedMsgs);
    setShowWelcome(cachedMsgs.length === 0);
    void selectSession(sessionKey);
  }, [isVisible]);

  // Load onboarding data + agent profile for personalized welcome & avatars
  useEffect(() => {
    loadOnboardingData().then(setOnboardingData).catch(console.error);
    loadProfile().then(setAgentProfile).catch(console.error);
    const onProfileUpdated = () => {
      loadProfile().then(setAgentProfile).catch(console.error);
    };
    window.addEventListener("entropic-profile-updated", onProfileUpdated);
    return () => window.removeEventListener("entropic-profile-updated", onProfileUpdated);
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
  // retry connectToGateway() every 1 s rather than waiting for a dep change.
  useEffect(() => {
    const shouldPoll =
      gatewayRunning && !gatewayStarting && !connected && !showOutOfCreditsModal && (connectedProvider || proxyEnabled);
    if (!shouldPoll) return;
    const id = window.setInterval(() => {
      if (!connectInFlightRef.current && !clientRef.current?.isConnected()) {
        void connectToGateway();
      }
    }, 1000);
    return () => window.clearInterval(id);
  }, [gatewayRunning, gatewayStarting, connected, connectedProvider, proxyEnabled, showOutOfCreditsModal]);

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

  // Clear stale errors when the model changes (errors are expected during model transitions)
  useEffect(() => {
    setError(null);
  }, [selectedModel]);

  useEffect(() => {
    if (isConnecting) {
      setError(null);
    }
  }, [isConnecting]);

  const shouldHoldConnectingScreen =
    !showOutOfCreditsModal &&
    Boolean(connectedProvider || proxyEnabled) &&
    (gatewayStarting || (!gatewayRunning && (isConnecting || connectInFlightRef.current)));

  useEffect(() => {
    if (connectingScreenTimerRef.current !== null) {
      window.clearTimeout(connectingScreenTimerRef.current);
      connectingScreenTimerRef.current = null;
    }

    if (shouldHoldConnectingScreen) {
      setShowConnectingScreen(true);
      setError(null);
      return;
    }

    const delay = connected ? 180 : 1200;
    connectingScreenTimerRef.current = window.setTimeout(() => {
      setShowConnectingScreen(false);
      connectingScreenTimerRef.current = null;
    }, delay);

    return () => {
      if (connectingScreenTimerRef.current !== null) {
        window.clearTimeout(connectingScreenTimerRef.current);
        connectingScreenTimerRef.current = null;
      }
    };
  }, [shouldHoldConnectingScreen, connected]);

  useEffect(() => {
    if (gatewayRunning || gatewayStarting || showConnectingScreen) {
      setShowGatewayOfflineCta(false);
      return;
    }
    const id = window.setTimeout(() => {
      setShowGatewayOfflineCta(true);
    }, 3500);
    return () => window.clearTimeout(id);
  }, [gatewayRunning, gatewayStarting, showConnectingScreen]);

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

  useEffect(() => {
    if (activeRunIdRef.current) {
      return;
    }
    const currentQueued = currentSession
      ? outboxEntries.find((entry) => entry.sessionKey === currentSession)
      : null;
    if (currentQueued) {
      setIsLoading(true);
      setActiveWorkSessionKey(currentSession);
      setThinkingStatus("Waiting for reconnect");
      return;
    }
    if (thinkingStatus === "Waiting for reconnect") {
      setThinkingStatus(null);
      setIsLoading(false);
      setActiveWorkSessionKey(null);
    }
  }, [currentSession, outboxEntries, thinkingStatus]);

  useEffect(() => {
    if (!connected || gatewayStarting || isConnecting || showOutOfCreditsModal) {
      return;
    }
    if (activeRunIdRef.current || outboxReplayInFlightRef.current) {
      return;
    }
    const now = Date.now();
    const nextEntry = outboxEntries.find(
      (entry) =>
        entry.nextAttemptAt <= now && !outboxDispatchInFlightRef.current.has(entry.id),
    );
    if (!nextEntry) {
      scheduleOutboxWake(outboxEntries);
      return;
    }
    void replayOutboxEntry(nextEntry);
  }, [
    connected,
    gatewayStarting,
    isConnecting,
    showOutOfCreditsModal,
    outboxEntries,
    outboxWakeTick,
    selectedModel,
    proxyEnabled,
    connectedProvider,
    gatewayRunning,
  ]);

  async function connectToGateway() {
    if (connectInFlightRef.current || showOutOfCreditsModal) return;
    const blockedForMs = gatewayAuthRateLimitedUntilRef.current - Date.now();
    if (blockedForMs > 0) {
      const retrySeconds = Math.max(1, Math.ceil(blockedForMs / 1000));
      setError(`Gateway authentication is temporarily rate-limited. Retrying in about ${retrySeconds}s.`);
      addDiag(`connect skipped due to gateway auth rate limit (${retrySeconds}s remaining)`);
      return;
    }
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
        gatewayAuthRateLimitedUntilRef.current = 0;
        setConnected(true);
        setIsConnecting(false);
        setError(null);
        onGatewayConnectionReady?.();
        loadSessions();
        syncAllIntegrationsToGateway()
          .then((providers) => {
            addDiag(`integrations synced: ${providers.length ? providers.join(", ") : "none"}`);
            if (providers.length === 0) {
              getCachedIntegrationProviders()
                .then((cached) => {
                  if (cached.length > 0) {
                    addDiag("integrations missing secrets; reconnect in Integrations");
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
          if (isTransientGatewayConnectState()) {
            recoverInterruptedActiveRun("active run interrupted by disconnect");
          } else {
            setIsLoading(false);
            setError("Connection lost while waiting for response. Please retry.");
            finalizeRunningToolActivities(activeRunIdRef.current, "error");
            addDiag(`active run interrupted by disconnect runId=${activeRunIdRef.current}`);
            clearActiveRunTracking();
          }
        }
        if (isTransientGatewayConnectState()) {
          addDiag("gateway reconnect pending");
        } else {
          addDiag("gateway disconnected");
        }
      };
      const onChat = (event: ChatEvent) => handleChatEvent(event);
      const onAgent = (event: AgentEvent) => handleAgentEvent(event);
      const onError = (err: string) => {
        const normalizedError = sanitizeGatewayErrorMessage(err);
        const transientConnectClose = isTransientGatewayConnectCloseMessage(normalizedError);
        // Suppress errors during startup grace period (first 15 seconds after component mount)
        const inStartupGracePeriod = Date.now() - componentMountedAt < 15_000;
        const suppressError =
          transientConnectClose || gatewayStarting || isConnecting || !gatewayRunning || inStartupGracePeriod;
        if (!client.isConnected()) {
          setConnected(false);
        }

        // Suppress container restarting errors — these are transient during model switches
        if (isContainerRestartingError(err)) {
          addDiag(`gateway error (container restart, suppressed): ${err}`);
          return;
        }

        if (isGatewayAuthRateLimited(normalizedError)) {
          applyGatewayAuthRateLimit(normalizedError);
          setIsConnecting(false);
          setLastGatewayError(normalizedError);
          addDiag(`gateway error (auth rate-limited): ${normalizedError}`);
          return;
        }

        if (transientConnectClose) {
          setIsConnecting(false);
          setLastGatewayError(null);
          addDiag("gateway connect retry pending");
          return;
        }

        // Route OAuth expiry by mode: proxy mode refreshes the proxy session,
        // local-keys mode refreshes the provider token directly.
        if (isProviderOAuthExpiryFailure(normalizedError)) {
          if (proxyEnabled) {
            if (!proxyAuthRecoveryInFlightRef.current) {
              triggerProxyAuthRecovery("gateway error");
            }
            addDiag(`gateway error (proxy oauth intercepted): ${normalizedError}`);
          } else {
            void recoverExpiredProviderOAuth("gateway error", normalizedError);
            addDiag(`gateway error (provider oauth intercepted): ${normalizedError}`);
          }
        } else if (isProxyAuthFailure(normalizedError)) {
          if (!proxyAuthRecoveryInFlightRef.current) {
            triggerProxyAuthRecovery("gateway error");
          }
          addDiag(`gateway error (proxy auth intercepted): ${normalizedError}`);
        } else if (!suppressError) {
          setError(normalizedError);
        }

        setIsConnecting(false);
        if (activeRunIdRef.current) {
          if (suppressError || isTransientGatewayConnectState()) {
            recoverInterruptedActiveRun("active run interrupted by gateway error");
          } else {
            setIsLoading(false);
            finalizeRunningToolActivities(activeRunIdRef.current, "error");
            addDiag(`active run interrupted by gateway error runId=${activeRunIdRef.current}`);
            clearActiveRunTracking();
          }
        }
        setLastGatewayError(normalizedError);
        if (!isProxyAuthFailure(normalizedError)) {
          addDiag(`gateway error: ${normalizedError}${inStartupGracePeriod ? ' (suppressed: startup grace period)' : ''}`);
        }
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
        const errorMessage = e instanceof Error ? e.message : "Connection failed";
        const transientConnectClose = isTransientGatewayConnectCloseMessage(errorMessage);
        const suppressConnectDiag =
          gatewayStarting || !gatewayRunning || inStartupGracePeriod;
        if (isGatewayAuthRateLimited(errorMessage)) {
          applyGatewayAuthRateLimit(
            errorMessage,
            e instanceof GatewayError ? readGatewayRetryAfterMs(e.details) : null,
          );
      } else if (!gatewayStarting && !inStartupGracePeriod && !transientConnectClose) {
        setError(errorMessage);
      }
      if (!gatewayStarting && !inStartupGracePeriod && !transientConnectClose) {
        setLastGatewayError(errorMessage);
      } else if (transientConnectClose) {
        setLastGatewayError(null);
      }
      setIsConnecting(false);
      if (
        transientConnectClose ||
        (suppressConnectDiag && errorMessage.includes("Gateway socket closed during connect"))
      ) {
        addDiag("gateway connect retry pending");
      } else {
        addDiag(`connect failed: ${errorMessage}${inStartupGracePeriod ? ' (suppressed: startup grace period)' : ''}`);
      }
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

  function recordToolActivities(runId: string, activities: ChatToolActivity[]) {
    if (!runId || activities.length === 0) return;
    setToolActivityByRunId((prev) => ({
      ...prev,
      [runId]: mergeToolActivities(prev[runId] ?? [], activities),
    }));
  }

  function finalizeRunningToolActivities(runId: string, status: Exclude<ChatToolActivityStatus, "running"> = "complete") {
    if (!runId) return;
    setToolActivityByRunId((prev) => {
      const activities = prev[runId];
      if (!activities?.some((activity) => activity.status === "running")) {
        return prev;
      }
      return {
        ...prev,
        [runId]: activities.map((activity) =>
          activity.status === "running"
            ? {
                ...activity,
                status,
              }
            : activity,
        ),
      };
    });
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
      if (phase === "start") return "Preparing response";
      if (phase === "end" || phase === "error") return null;
    }
    return null;
  }

  function handleAgentEvent(event: AgentEvent) {
    if (!event?.runId || event.runId !== activeRunIdRef.current) return;
    lastEventByRunIdRef.current[event.runId] = Date.now();
    refreshActiveRunTimeout(event.runId);
    const toolActivity = toolActivityFromAgentEvent(event);
    if (toolActivity) {
      recordToolActivities(event.runId, [toolActivity]);
    }
    const status = describeAgentActivity(event);
    if (status) {
      setThinkingStatus(status);
    }
  }

  async function recoverFinalRunFromHistory(runId: string, sessionKey: string) {
    if (!runId || !sessionKey) return;
    if (runHistoryRecoveryRef.current[runId]) return;

    const isRecoveryBoundaryUserMessage = (item: GatewayMessage): boolean => {
      const role = typeof item?.role === "string" ? item.role.toLowerCase() : "";
      if (role !== "user") return false;
      const { text, hasText, hasNonText } = extractMessageText(item);
      const trimmed = text.trim();
      if (!hasText) return hasNonText;
      if (trimmed.startsWith(INTERNAL_USER_PROMPT_PREFIX)) return false;
      if (/^pre-compaction memory flush\b/i.test(trimmed)) return false;
      if (/^please summarize the conversation\b/i.test(trimmed)) return false;
      return true;
    };

    runHistoryRecoveryRef.current[runId] = true;
    setIsLoading(true);
    setActiveWorkSessionKey(sessionKey);
    try {
      for (let attempt = 0; attempt < FINAL_RESPONSE_RECOVERY_MAX_ATTEMPTS; attempt += 1) {
        const client = clientRef.current;
        if (!client || !client.isConnected()) {
          if (attempt + 1 < FINAL_RESPONSE_RECOVERY_MAX_ATTEMPTS) {
            setThinkingStatus("Finalizing response");
            addDiag(`final recovery waiting for reconnect runId=${runId} attempt=${attempt + 1}`);
            await delay(FINAL_RESPONSE_RECOVERY_RETRY_MS);
            continue;
          }
          setError(
            buildNoVisibleResponseMessage({
              lastGatewayError,
              connected,
            }),
          );
          addDiag(`final recovery missed runId=${runId} (client disconnected)`);
          return;
        }

        try {
          const history = await client.getChatHistory(sessionKey, 40);
          let latestUserIdx = -1;
          for (let i = history.length - 1; i >= 0; i -= 1) {
            if (isRecoveryBoundaryUserMessage(history[i] as GatewayMessage)) {
              latestUserIdx = i;
              break;
            }
          }
          const recoveryWindow = latestUserIdx >= 0 ? history.slice(latestUserIdx + 1) : history;
          const fallback = [...recoveryWindow].reverse().find((item) => {
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
            if (attempt + 1 < FINAL_RESPONSE_RECOVERY_MAX_ATTEMPTS) {
              setThinkingStatus("Finalizing response");
              addDiag(`final recovery retry runId=${runId} (no assistant payload in history)`);
              await delay(FINAL_RESPONSE_RECOVERY_RETRY_MS);
              continue;
            }
            setError(
              buildNoVisibleResponseMessage({
                lastGatewayError,
                connected,
              }),
            );
            addDiag(`final recovery missed runId=${runId} (no assistant payload in history)`);
            return;
          }

          const normalized = normalizeGatewayMessage(fallback as GatewayMessage, runId);
          if (!normalized) {
            if (attempt + 1 < FINAL_RESPONSE_RECOVERY_MAX_ATTEMPTS) {
              setThinkingStatus("Finalizing response");
              addDiag(`final recovery retry runId=${runId} (normalize failed)`);
              await delay(FINAL_RESPONSE_RECOVERY_RETRY_MS);
              continue;
            }
            setError(
              buildNoVisibleResponseMessage({
                lastGatewayError,
                connected,
              }),
            );
            addDiag(`final recovery missed runId=${runId} (normalize failed)`);
            return;
          }

          const text = normalized.content ?? "";
          const hasRenderableAssistantPayload = Boolean(
            normalized.assistantPayload &&
            (normalized.assistantPayload.events.length > 0 || normalized.assistantPayload.errors.length > 0)
          );
          if (!text && !hasRenderableAssistantPayload) {
            if (attempt + 1 < FINAL_RESPONSE_RECOVERY_MAX_ATTEMPTS) {
              setThinkingStatus("Finalizing response");
              addDiag(`final recovery retry runId=${runId} (empty normalized payload)`);
              await delay(FINAL_RESPONSE_RECOVERY_RETRY_MS);
              continue;
            }
            setError(
              buildNoVisibleResponseMessage({
                lastGatewayError,
                connected,
              }),
            );
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
          finalizeRunningToolActivities(runId, "complete");
          setThinkingStatus(null);
          setError(null);
          setIsLoading(false);
          setActiveWorkSessionKey(null);
          if (isBillingIssueMessage(text)) {
            setError(BILLING_RECOVERY_MESSAGE);
            setShowOutOfCreditsModal(true);
          }
          if (text.trim()) {
            scheduleSpeakAssistantResponseForRun(runId, sessionKey, text);
          }
          addDiag(`recovered final response from history runId=${runId} attempt=${attempt + 1}`);
          return;
        } catch (err) {
          if (attempt + 1 < FINAL_RESPONSE_RECOVERY_MAX_ATTEMPTS) {
            setThinkingStatus("Finalizing response");
            addDiag(`final recovery retry runId=${runId}: ${String(err)}`);
            await delay(FINAL_RESPONSE_RECOVERY_RETRY_MS);
            continue;
          }
          setError(
            buildNoVisibleResponseMessage({
              lastGatewayError: err instanceof Error ? err.message : lastGatewayError,
              connected,
            }),
          );
          setIsLoading(false);
          setActiveWorkSessionKey(null);
          addDiag(`final recovery failed runId=${runId}: ${String(err)}`);
          return;
        }
      }
    } finally {
      setIsLoading(false);
      setActiveWorkSessionKey(null);
      delete runHistoryRecoveryRef.current[runId];
    }
  }

  function handleChatEvent(event: any) {
    const composer = textareaRef.current;
    const keepComposerFocus = !!composer && document.activeElement === composer;
    const selection = keepComposerFocus && composer
      ? { start: composer.selectionStart, end: composer.selectionEnd }
      : null;

    const eventRunId = typeof event?.runId === "string" ? event.runId.trim() : "";
    if (eventRunId) {
      lastEventByRunIdRef.current[eventRunId] = Date.now();
      if (activeRunIdRef.current === eventRunId) {
        refreshActiveRunTimeout(eventRunId);
      }
    }
    const eventSessionKey =
      typeof event?.sessionKey === "string" ? event.sessionKey.trim() : "";
    const hasMissingSessionKey = !eventSessionKey || eventSessionKey === "unknown";
    const isActiveRun = Boolean(eventRunId && activeRunIdRef.current === eventRunId);
    if (eventRunId && hasMissingSessionKey && !isActiveRun && !runSessionKeyRef.current[eventRunId]) {
      createDetachedRunSession(eventRunId);
    }
    if (eventRunId && eventSessionKey && eventSessionKey !== "unknown") {
      runSessionKeyRef.current[eventRunId] = eventSessionKey;
    }
    const knownSessionKey =
      eventSessionKey && eventSessionKey !== "unknown"
        ? eventSessionKey
        : eventRunId
          ? runSessionKeyRef.current[eventRunId] || ""
          : "";
    if (isActiveRun) {
      lastEventByRunIdRef.current[eventRunId!] = Date.now();
      refreshActiveRunTimeout(eventRunId!);
    }
    if (
      isActiveRun &&
      knownSessionKey &&
      activeRunSessionRef.current &&
      knownSessionKey !== activeRunSessionRef.current
    ) {
      migrateSessionKey(activeRunSessionRef.current, knownSessionKey);
    }
    const gatewayToolActivities = event.message
      ? toolActivitiesFromGatewayMessage(event.message as GatewayMessage, event as ChatEvent)
      : [];
    const isGatewayToolOnlyEvent = isGatewayToolOnlyMessage(
      event.message as GatewayMessage | undefined,
      gatewayToolActivities,
    );
    if (eventRunId && gatewayToolActivities.length > 0) {
      recordToolActivities(eventRunId, gatewayToolActivities);
      const timings = runTimingsRef.current[eventRunId];
      if (timings && !timings.toolSeenAt) {
        timings.toolSeenAt = Date.now();
        addDiag(`timing tool_activity runId=${eventRunId} t=${timings.toolSeenAt - timings.startedAt}ms`);
      }
      if (isActiveRun) {
        setThinkingStatus(toolLoadingStatus(gatewayToolActivities[gatewayToolActivities.length - 1]));
      }
    }
    const isActiveRunTerminalEvent = Boolean(
      eventRunId &&
      activeRunIdRef.current === eventRunId &&
      (event.state === "final" || event.state === "error" || event.state === "aborted") &&
      !isGatewayToolOnlyEvent
    );
    if (isActiveRunTerminalEvent) {
      finalizeRunningToolActivities(
        eventRunId,
        event.state === "final" ? "complete" : "error",
      );
      setIsLoading(false);
      setThinkingStatus(null);
      if (
        eventRunId &&
        (event.state === "error" || event.state === "aborted") &&
        voiceSpeakResponseByRunIdRef.current.has(eventRunId)
      ) {
        completeVoiceSpeechRun(eventRunId);
      }
      clearActiveRunTracking();
      // Refresh credit balance after message completion
      window.dispatchEvent(new Event("entropic-local-credits-changed"));
      if (isAuthenticated) {
        refreshBalance();
      }
    }
    if (
      !isActiveRun &&
      currentSessionRef.current &&
      knownSessionKey &&
      knownSessionKey !== currentSessionRef.current
    ) {
      if (event.state === "delta" || event.state === "final") {
        const normalized = event.message
          ? normalizeGatewayMessage(event.message as GatewayMessage, eventRunId || "evt")
          : null;
        upsertAssistantMessageForSession(knownSessionKey, eventRunId || "evt", normalized);
      }
      return;
    }
    if (
      !isActiveRun &&
      currentSessionRef.current &&
      !knownSessionKey &&
      (event.state === "delta" || event.state === "final")
    ) {
      addDiag(`ignored chat event without session key runId=${eventRunId || "unknown"}`);
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
        if (eventRunId) {
          streamedAssistantRunIdsRef.current.add(eventRunId);
        }
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
        // Throttled persist during streaming: save every 5s so partial responses
        // survive app crashes or network drops mid-stream.
        if (event.state === "delta" && !streamPersistTimerRef.current) {
          streamPersistTimerRef.current = setTimeout(() => {
            streamPersistTimerRef.current = null;
            schedulePersist();
          }, 5000);
        }
        if (eventRunId && text.trim() && normalized?.kind !== "toolResult") {
          enqueueVoiceAssistantSpeech(eventRunId, text, {
            final: event.state === "final",
            source: event.state === "final" ? "final_event" : "delta",
          });
        }
      } else if (event.state === "final" && eventRunId && knownSessionKey && !isGatewayToolOnlyEvent) {
        addDiag(`final event missing payload runId=${eventRunId}; attempting history recovery`);
        void recoverFinalRunFromHistory(eventRunId, knownSessionKey);
      }
      if (event.state === "final" && !isGatewayToolOnlyEvent) {
        if (eventRunId) {
          finalizeRunningToolActivities(eventRunId, "complete");
        }
        setIsLoading(false);
        if (eventRunId && activeRunIdRef.current === eventRunId) {
          clearActiveRunTracking();
        }
      }
      if (event.state === "final" && eventRunId && !isGatewayToolOnlyEvent) {
        const timings = runTimingsRef.current[eventRunId];
        if (timings && !timings.finalAt) {
          timings.finalAt = Date.now();
          addDiag(`timing final runId=${eventRunId} t=${timings.finalAt - timings.startedAt}ms`);
        }
        if (
          voiceSpeakResponseByRunIdRef.current.has(eventRunId) &&
          (normalized?.kind === "toolResult" ||
            (!text.trim() && Boolean(voiceSpeechRunStateByRunIdRef.current[eventRunId])))
        ) {
          enqueueVoiceAssistantSpeech(eventRunId, "", {
            final: true,
            source: "final_event",
          });
        }
        const pendingOfficeOpen = workspaceOfficeOpenByRunIdRef.current[eventRunId];
        if (pendingOfficeOpen) {
          delete workspaceOfficeOpenByRunIdRef.current[eventRunId];
          addDiag(`workspace office auto-open path=${pendingOfficeOpen.path}`);
          clientLog("chat.office.auto_open", {
            runId: eventRunId,
            path: pendingOfficeOpen.path,
          });
          void handoffWorkspacePathToDesktop({
            path: pendingOfficeOpen.path,
            action: "open",
            looksLikeFile: true,
          });
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

        // Clear streaming persist timer — final persist below supersedes it
        if (streamPersistTimerRef.current) {
          clearTimeout(streamPersistTimerRef.current);
          streamPersistTimerRef.current = null;
        }
        // Persist the full conversation after assistant response completes
        if (currentSessionRef.current) {
          // Refresh session list from gateway to get derived titles
          clientRef.current?.listSessions().then((updatedSessions) => {
            if (updatedSessions && updatedSessions.length > 0) {
              gatewaySessionKeysRef.current = new Set(updatedSessions.map((s) => s.key));
              setSessions(prev => {
                // Merge: gateway sessions take priority, keep local-only sessions
                const gatewayKeys = new Set(updatedSessions.map(s => s.key));
                const localOnly = prev.filter(s => !gatewayKeys.has(s.key) && ((sessionMessagesRef.current[s.key]?.length ?? 0) > 0 || s.key === currentSessionRef.current));
                return applySessionTitles(overlaySessionMetadata([...updatedSessions, ...localOnly], prev));
              });
            }
          }).catch(() => {});
          schedulePersist();
        }
        const completedSessionKey = knownSessionKey || currentSessionRef.current || "";
        if (completedSessionKey && builderSessionsRef.current.has(completedSessionKey)) {
          void syncDesktopProfileFromIdentity();
        }
      }
    } else if (event.state === "error") {
      const rawErrorMessage = event.errorMessage || "Chat error";
      const errorMessage = formatAssistantErrorTextForUi(rawErrorMessage);
      setError(errorMessage);
      const handledOAuthExpiryInProxyMode = proxyEnabled && isProviderOAuthExpiryFailure(rawErrorMessage);
      if (isProviderOAuthExpiryFailure(rawErrorMessage)) {
        if (handledOAuthExpiryInProxyMode) {
          triggerProxyAuthRecovery("chat error event");
        } else {
          void recoverExpiredProviderOAuth("chat error event", rawErrorMessage);
        }
      }
      if (isBillingIssueMessage(errorMessage)) {
        setShowOutOfCreditsModal(true);
      }
      setIsLoading(false);
      setActiveWorkSessionKey(null);
      if (eventRunId) {
        finalizeRunningToolActivities(eventRunId, "error");
      }
      if (eventRunId && activeRunIdRef.current === eventRunId) {
        clearActiveRunTracking();
      }
      if (eventRunId) {
        delete runSessionKeyRef.current[eventRunId];
      }
      // Auto-clear transient container restart errors after a brief delay
      if (isContainerRestartingError(rawErrorMessage)) {
        addDiag(`container restart error (will auto-clear): ${rawErrorMessage}`);
        setTimeout(() => {
          setError((prev) => (prev === errorMessage ? null : prev));
        }, 6000);
      } else {
        addDiag(`chat error: ${rawErrorMessage}`);
      }
      if (isPolicyMessageRemovedError(rawErrorMessage)) {
        // The provider stripped all messages (e.g. internal-only history). Reset
        // the session context on the gateway so the next send starts clean.
        const sessionToReset = event.sessionKey || currentSessionRef.current;
        if (sessionToReset && clientRef.current) {
          addDiag(`policy message removal — resetting session context: ${sessionToReset}`);
          clientRef.current.resetSession(sessionToReset).catch((err: unknown) => {
            addDiag(`session reset failed: ${String(err)}`);
          });
        }
      }
      if (!handledOAuthExpiryInProxyMode && isProxyAuthFailure(errorMessage)) {
        triggerProxyAuthRecovery("chat error event");
      }
    } else if (event.state === "aborted") {
      setIsLoading(false);
      setActiveWorkSessionKey(null);
      if (eventRunId) {
        finalizeRunningToolActivities(eventRunId, "error");
      }
      if (eventRunId && activeRunIdRef.current === eventRunId) {
        clearActiveRunTracking();
      }
      if (eventRunId) {
        delete runSessionKeyRef.current[eventRunId];
      }
      addDiag("chat aborted");
    }

  }

  async function loadSessions() {
    // Wait for local cache to load before merging with gateway sessions.
    // Without this, sessionMessagesRef is empty and local-only sessions are dropped.
    for (let i = 0; i < 20 && !cacheLoadedRef.current; i++) {
      await new Promise(r => setTimeout(r, 100));
    }
    const gatewayAllSessions = await clientRef.current?.listSessions() || [];
    const gatewaySessions = gatewayAllSessions.filter((session) =>
      shouldDisplayGatewaySession(session.key),
    );
    const filteredSessionCount = gatewayAllSessions.length - gatewaySessions.length;
    if (filteredSessionCount > 0) {
      addDiag(`filtered ${filteredSessionCount} non-chat sessions from gateway`);
    }
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
    const localOnlyKeys = new Set<string>();
    if (cached?.sessions) {
      for (const s of cached.sessions) {
        if (gatewayKeys.has(s.key)) continue;
        const rawLocalMessages = cached.messages[s.key] || [];
        if (rawLocalMessages.length === 0 && s.key !== currentSessionRef.current) continue;
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
        localOnlyKeys.add(s.key);
      }
    }

    // Preserve in-memory sessions that haven't been persisted yet
    // (e.g., just created by createNewSession before schedulePersist fires)
    for (const s of sessionsRef.current) {
      if (gatewayKeys.has(s.key) || localOnlyKeys.has(s.key)) continue;
      const inMemoryMessages = sessionMessagesRef.current[s.key] || [];
      if (inMemoryMessages.length === 0 && s.key !== currentSessionRef.current) continue;
      localOnly.push(s);
      localOnlyKeys.add(s.key);
    }

    const merged = [...gatewaySessions, ...localOnly];
    const fallbackSessions = normalizeSessionsList([
      ...(cached?.sessions || []),
      ...sessionsRef.current,
    ]);
    let nextSessions = merged.length > 0 ? merged : fallbackSessions;
    const latestCurrent = currentSessionRef.current;
    if (latestCurrent && !nextSessions.some((session) => session.key === latestCurrent)) {
      const inMemoryCurrent =
        sessionsRef.current.find((session) => session.key === latestCurrent) ||
        cached?.sessions?.find((session) => session.key === latestCurrent) ||
        { key: latestCurrent, updatedAt: Date.now() };
      nextSessions = normalizeSessionsList([inMemoryCurrent, ...nextSessions]);
    }
    setSessions((prev) =>
      applySessionTitles(
        overlaySessionMetadata(nextSessions, [...(cached?.sessions || []), ...prev]),
      ),
    );

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

    if (localToGateway.size > 0 && outboxEntriesRef.current.length > 0) {
      const remappedOutbox = outboxEntriesRef.current.map((entry) => {
        const targetKey = localToGateway.get(entry.sessionKey);
        return targetKey ? { ...entry, sessionKey: targetKey } : entry;
      });
      const changed = remappedOutbox.some(
        (entry, index) => entry.sessionKey !== outboxEntriesRef.current[index]?.sessionKey,
      );
      if (changed) {
        replaceOutboxEntries(remappedOutbox);
      }
    }

    if (nextSessions.length > 0) {
      // Prefer the active session, then persisted session, then first in list.
      const activeKeyRaw = currentSessionRef.current;
      const preferredKeyRaw = cached?.currentSession;
      const activeKey = activeKeyRaw ? localToGateway.get(activeKeyRaw) || activeKeyRaw : null;
      const preferredKey = preferredKeyRaw ? localToGateway.get(preferredKeyRaw) || preferredKeyRaw : null;
      const target =
        activeKey && nextSessions.find((s) => s.key === activeKey)
          ? activeKey
          : preferredKey && nextSessions.find((s) => s.key === preferredKey)
            ? preferredKey
            : nextSessions[0].key;
      await selectSession(target);
    } else {
      createNewSession();
    }
  }

  async function selectSession(sessionId: string) {
    currentSessionRef.current = sessionId;
    setCurrentSession(sessionId);
    setError(null);
    const activeRunSession = activeRunSessionRef.current;
    if (activeRunIdRef.current && activeRunSession) {
      setIsLoading(true);
      setActiveWorkSessionKey(activeRunSession);
      if (activeRunSession !== sessionId) {
        setThinkingStatus(null);
      }
    } else if (outboxEntriesRef.current.some((entry) => entry.sessionKey === sessionId)) {
      setIsLoading(true);
      setActiveWorkSessionKey(sessionId);
      setThinkingStatus("Waiting for reconnect");
    } else {
      setIsLoading(false);
      setActiveWorkSessionKey(null);
      setThinkingStatus(null);
    }

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
      // Keep whichever source has more messages to avoid data loss from
      // normalizeGatewayMessage filtering out tool-only or system messages.
      msgs = parsedHistory.length >= cachedMsgs.length ? parsedHistory : cachedMsgs;
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
    if (action.type === "compose") {
      let targetKey = action.key || currentSessionRef.current;
      if (!targetKey) {
        createNewSession({ force: true });
        targetKey = currentSessionRef.current;
      } else if (targetKey !== currentSessionRef.current) {
        await selectSession(targetKey);
      }
      if (!targetKey) return;
      setComposerModeForSession(targetKey, "chat");
      if (action.submit) {
        void handleSend(action.prompt, {
          mode: "chat",
          speakResponse: action.speakResponse === true,
        });
      } else {
        setDraftsBySession((prev) => {
          const existing = (prev[targetKey] || "").trim();
          const nextValue = existing ? `${existing}\n\n${action.prompt}` : action.prompt;
          if (prev[targetKey] === nextValue) return prev;
          return { ...prev, [targetKey]: nextValue };
        });
        requestAnimationFrame(() => {
          textareaRef.current?.focus();
        });
      }
      return;
    }
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
      const snapshotShellDraft = shellDraftsRef.current[action.key] || "";
      const snapshotImageDraft = imageDraftsRef.current[action.key] || "";
      const snapshotComposerMode = composerModeBySessionRef.current[action.key] || null;
      const snapshotTerminalState = terminalStateBySessionRef.current[action.key] || null;
      const snapshotIntegrationSetup = integrationSetupBySession[action.key] || null;
      const snapshotIntegrationLaunch = integrationLaunchBySession[action.key] || null;
      const snapshotQuickSuggestion = quickSuggestionBySession[action.key] || null;
      const snapshotBuilderChecklist = builderChecklistBySession[action.key] || null;
      const snapshotOutbox = outboxEntriesRef.current.filter((entry) => entry.sessionKey === action.key);
      const deletingCurrent = currentSessionRef.current === action.key;
      const remaining = normalizeSessionsList(
        sessionsRef.current.filter((session) => session.key !== action.key),
      );

      sessionsRef.current = applySessionTitles(remaining);
      const nextDrafts = { ...draftsRef.current };
      delete nextDrafts[action.key];
      draftsRef.current = nextDrafts;
      const nextShellDrafts = { ...shellDraftsRef.current };
      delete nextShellDrafts[action.key];
      shellDraftsRef.current = nextShellDrafts;
      const nextImageDrafts = { ...imageDraftsRef.current };
      delete nextImageDrafts[action.key];
      imageDraftsRef.current = nextImageDrafts;
      setSessions(applySessionTitles(remaining));
      const nextMessages = { ...sessionMessagesRef.current };
      delete nextMessages[action.key];
      sessionMessagesRef.current = nextMessages;
      setDraftsBySession(nextDrafts);
      setShellDraftsBySession(nextShellDrafts);
      setImageDraftsBySession(nextImageDrafts);
      setComposerModeBySession((prev) => {
        if (!prev[action.key]) return prev;
        const next = { ...prev };
        delete next[action.key];
        return next;
      });
      setTerminalStateBySession((prev) => {
        if (!prev[action.key]) return prev;
        const next = { ...prev };
        delete next[action.key];
        return next;
      });
      setIntegrationSetupBySession((prev) => {
        if (!prev[action.key]) return prev;
        const next = { ...prev };
        delete next[action.key];
        return next;
      });
      setIntegrationLaunchBySession((prev) => {
        if (!prev[action.key]) return prev;
        const next = { ...prev };
        delete next[action.key];
        return next;
      });
      setQuickSuggestionBySession((prev) => {
        if (!prev[action.key]) return prev;
        const next = { ...prev };
        delete next[action.key];
        return next;
      });
      setBuilderChecklistBySession((prev) => {
        if (!prev[action.key]) return prev;
        const next = { ...prev };
        delete next[action.key];
        return next;
      });
      if (snapshotOutbox.length > 0) {
        replaceOutboxEntries(
          outboxEntriesRef.current.filter((entry) => entry.sessionKey !== action.key),
        );
      }
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
          const restoredSessions = applySessionTitles(normalizeSessionsList([...sessionsRef.current, snapshotSession]));
          sessionsRef.current = restoredSessions;
          setSessions(restoredSessions);
          if (snapshotMessages.length > 0) {
            sessionMessagesRef.current[action.key] = snapshotMessages;
          }
          if (snapshotDraft) {
            const restoredDrafts = { ...draftsRef.current, [action.key]: snapshotDraft };
            draftsRef.current = restoredDrafts;
            setDraftsBySession(restoredDrafts);
          }
          if (snapshotShellDraft) {
            const restoredShellDrafts = { ...shellDraftsRef.current, [action.key]: snapshotShellDraft };
            shellDraftsRef.current = restoredShellDrafts;
            setShellDraftsBySession(restoredShellDrafts);
          }
          if (snapshotImageDraft) {
            const restoredImageDrafts = { ...imageDraftsRef.current, [action.key]: snapshotImageDraft };
            imageDraftsRef.current = restoredImageDrafts;
            setImageDraftsBySession(restoredImageDrafts);
          }
          if (snapshotComposerMode) {
            setComposerModeBySession((prev) => ({ ...prev, [action.key]: snapshotComposerMode }));
          }
          if (snapshotTerminalState) {
            setTerminalStateBySession((prev) => ({ ...prev, [action.key]: snapshotTerminalState }));
          }
          if (snapshotIntegrationSetup) {
            setIntegrationSetupBySession((prev) => ({ ...prev, [action.key]: snapshotIntegrationSetup }));
          }
          if (snapshotIntegrationLaunch) {
            setIntegrationLaunchBySession((prev) => ({ ...prev, [action.key]: snapshotIntegrationLaunch }));
          }
          if (snapshotQuickSuggestion) {
            setQuickSuggestionBySession((prev) => ({ ...prev, [action.key]: snapshotQuickSuggestion }));
          }
          if (snapshotBuilderChecklist) {
            setBuilderChecklistBySession((prev) => ({ ...prev, [action.key]: snapshotBuilderChecklist }));
          }
          if (snapshotOutbox.length > 0) {
            replaceOutboxEntries([...outboxEntriesRef.current, ...snapshotOutbox]);
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
      const existingShellDraft = shellDraftsRef.current[existing] || "";
      const existingImageDraft = imageDraftsRef.current[existing] || "";
      if (
        existingMessages.length === 0 &&
        existingDraft.trim().length === 0 &&
        existingShellDraft.trim().length === 0 &&
        existingImageDraft.trim().length === 0
      ) {
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

  async function handleTaskBoardChatIntent(
    intent: TaskBoardChatIntent,
    sessionKey: string
  ): Promise<boolean> {
    if (!gatewayRunning) {
      const message = "Gateway is offline. Start it to update the task board.";
      setError(message);
      appendAssistantNotice(message, sessionKey);
      return true;
    }

    if (intent.action !== "create") return false;

    try {
      const created = await addTaskBoardItem({
        title: intent.title,
        description: intent.description,
        status: intent.status,
        priority: intent.priority,
        owner: intent.owner,
        labels: intent.labels,
        dueAt: intent.dueAt,
      });
      const statusLabel = formatTaskBoardStatusLabel(created.status);
      const ownerLabel = formatTaskBoardOwnerLabel(created.owner);
      const dueText =
        typeof created.dueAt === "string" && Number.isFinite(Date.parse(created.dueAt))
          ? ` due ${new Date(created.dueAt).toLocaleDateString([], { month: "short", day: "numeric" })}`
          : "";
      appendAssistantNotice(
        `Added "${created.title}" to ${statusLabel} for ${ownerLabel} (${created.priority} priority${dueText}).`,
        sessionKey
      );
      window.dispatchEvent(new Event("entropic-task-board-updated"));
      setError(null);
      return true;
    } catch (e) {
      const message = e instanceof Error ? e.message : "Failed to update task board.";
      setError(message);
      appendAssistantNotice(`I couldn't update the task board: ${message}`, sessionKey);
      return true;
    }
  }

  function isRecoverablePendingSendError(error: unknown, message: string): boolean {
    if (
      isProviderOAuthExpiryFailure(message) ||
      isProxyAuthFailure(message) ||
      isGatewayAuthRateLimited(message) ||
      isContainerRestartingError(message) ||
      isTransientGatewayConnectCloseMessage(message)
    ) {
      return true;
    }
    if (error instanceof GatewayError) {
      if (error.code === "ws.closed" || error.code === "timeout") {
        return true;
      }
    }
    return /gateway|socket|connection|connect|network|reconnect|timeout|draining|restart/i.test(
      message,
    );
  }

  async function prepareSessionModelForSend(sessionKey: string, routingContent: string) {
    const routingEnabled = import.meta.env.VITE_MODEL_ROUTING === "1";
    const fastModelOverride = normalizeModelId(import.meta.env.VITE_FAST_MODEL, proxyEnabled);
    const reasoningOverride = normalizeModelId(import.meta.env.VITE_REASONING_MODEL, proxyEnabled);
    const defaultModel = normalizeModelId(selectedModel, proxyEnabled);
    const fastModel = fastModelOverride ?? defaultModel;
    const reasoningModel = reasoningOverride ?? defaultModel;
    const decision = getRoutingDecision(routingContent);
    const chosenModel = routingEnabled
      ? decision.useReasoning
        ? reasoningModel
        : fastModel
      : null;
    const targetModel = routingEnabled ? chosenModel ?? defaultModel : defaultModel;

    if (targetModel && sessionKey && clientRef.current) {
      const lastModel = sessionModelRef.current[sessionKey];
      if (lastModel !== targetModel) {
        sessionModelRef.current[sessionKey] = targetModel;
        try {
          await clientRef.current.patchSession(sessionKey, { model: targetModel });
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

    return {
      routingEnabled,
      chosenModel,
      fastModel,
      reasoningModel,
      targetModel,
      decision,
    };
  }

  function maybeSyncIntegrationsBeforeSend() {
    const now = Date.now();
    if (
      gatewayRunning &&
      (connectedProvider || proxyEnabled) &&
      now - lastIntegrationsSyncRef.current > 60_000
    ) {
      lastIntegrationsSyncRef.current = now;
      syncAllIntegrationsToGateway().then(
        (providers) => addDiag(`integrations synced: ${providers.length ? providers.join(", ") : "none"}`),
        (err: unknown) => addDiag(`integrations sync failed: ${String(err)}`),
      );
    }
  }

  async function dispatchPendingSend(entry: PersistedPendingSend): Promise<string> {
    const liveClient = clientRef.current;
    if (!liveClient || !liveClient.isConnected()) {
      throw new Error("Gateway is still connecting. The message remains queued.");
    }

    const sendStart = Date.now();
    const {
      routingEnabled,
      chosenModel,
      fastModel,
      reasoningModel,
    } = await prepareSessionModelForSend(entry.sessionKey, entry.routingContent);
    maybeSyncIntegrationsBeforeSend();

    if (!entry.outboundMessageContent.trim() && entry.attachments.length === 0) {
      throw new Error("Message content is empty. Please type a message before sending.");
    }

    addDiag(
      `send -> session=${entry.sessionKey} len=${entry.outboundMessageContent.length} attachments=${entry.attachments.length}`,
    );
    const runId = await liveClient.sendMessage(
      entry.sessionKey,
      entry.outboundMessageContent,
      entry.attachments,
      entry.idempotencyKey,
    );
    if (!runId) {
      throw new Error("Failed to start response stream");
    }

    const pendingOfficeOpen = workspaceOfficeOpenBySendIdRef.current[entry.id];
    if (pendingOfficeOpen) {
      workspaceOfficeOpenByRunIdRef.current[runId] = pendingOfficeOpen;
      delete workspaceOfficeOpenBySendIdRef.current[entry.id];
    }
    if (voiceSpeakResponseBySendIdRef.current.has(entry.id)) {
      voiceSpeakResponseByRunIdRef.current.add(runId);
      voiceSpeakResponseBySendIdRef.current.delete(entry.id);
    }

    scheduleActiveRunTimeout(runId, entry.sessionKey);
    removeOutboxEntry(entry.id);
    runTimingsRef.current[runId] = { startedAt: sendStart, ackAt: Date.now() };
    addDiag(`timing send_ack runId=${runId} t=${runTimingsRef.current[runId].ackAt! - sendStart}ms`);
    addDiag(`send ok runId=${runId}`);
    setThinkingStatus("Preparing response");
    if (routingEnabled && chosenModel && fastModel && reasoningModel && chosenModel !== fastModel) {
      runRevertModelRef.current[runId] = fastModel;
    }
    const capturedRunId = runId;
    setTimeout(() => {
      if (!lastEventByRunIdRef.current[capturedRunId]) {
        addDiag(`no chat event within 15s runId=${capturedRunId}`);
      }
    }, 15000);
    return runId;
  }

  async function approveOperatorCommand(command: string) {
    const normalizedCommand = command.trim();
    if (!normalizedCommand) return;
    const sendSession = currentSessionRef.current || currentSession;
    if (!sendSession) {
      setError("Open a chat before approving a command.");
      return;
    }
    const liveClient = clientRef.current;
    if (!liveClient || !liveClient.isConnected()) {
      setError("Gateway is still connecting. Try approving again in a moment.");
      if (!connectInFlightRef.current) {
        void connectToGateway();
      }
      return;
    }

    setApprovalCommandInFlight(normalizedCommand);
    setError(null);
    setThinkingStatus("Approving command");
    appendLocalMessage(
      {
        id: crypto.randomUUID(),
        role: "user",
        content: normalizedCommand,
        sentAt: Date.now(),
      },
      sendSession,
    );

    try {
      const startedAt = Date.now();
      const runId = await liveClient.sendMessage(
        sendSession,
        normalizedCommand,
        [],
        crypto.randomUUID(),
      );
      if (runId) {
        scheduleActiveRunTimeout(runId, sendSession);
        runTimingsRef.current[runId] = { startedAt, ackAt: Date.now() };
      }
      setIsLoading(true);
      setActiveWorkSessionKey(sendSession);
      setThinkingStatus("Continuing");
    } catch (e) {
      setError(formatUnknownUiError(e, "Approval failed."));
      setThinkingStatus(null);
    } finally {
      setApprovalCommandInFlight(null);
    }
  }

  async function replayOutboxEntry(entry: PersistedPendingSend) {
    if (outboxReplayInFlightRef.current) {
      return;
    }
    outboxReplayInFlightRef.current = true;
    setIsLoading(true);
    setActiveWorkSessionKey(entry.sessionKey);
    setThinkingStatus("Waiting for reconnect");
    setError(null);

    try {
      await dispatchPendingSend(entry);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Send failed";
      let handledProviderOAuth = false;
      if (proxyEnabled && isProviderOAuthExpiryFailure(errorMessage)) {
        triggerProxyAuthRecovery("queued send");
        handledProviderOAuth = true;
      } else {
        handledProviderOAuth = await recoverExpiredProviderOAuth("queued send", errorMessage);
      }
      if (!handledProviderOAuth && isProxyAuthFailure(errorMessage)) {
        triggerProxyAuthRecovery("queued send");
      }

      if (isRecoverablePendingSendError(error, errorMessage)) {
        updateOutboxEntry(entry.id, (current) => ({
          ...current,
          attemptCount: current.attemptCount + 1,
          nextAttemptAt: Date.now() + pendingSendBackoffMs(current.attemptCount + 1),
        }));
        if (!handledProviderOAuth) {
          setError(null);
        }
        setThinkingStatus("Waiting for reconnect");
      } else {
        removeOutboxEntry(entry.id);
        voiceSpeakResponseBySendIdRef.current.delete(entry.id);
        setError(errorMessage);
        setIsLoading(false);
        setActiveWorkSessionKey(null);
        setThinkingStatus(null);
      }
      addDiag(`queued send failed: ${errorMessage}`);
      return;
    } finally {
      outboxReplayInFlightRef.current = false;
    }
  }

  async function handleSend(
    content?: string,
    options?: { mode?: ComposerMode; speakResponse?: boolean },
  ) {
    let sendSession = currentSessionRef.current;
    if (!sendSession) {
      createNewSession({ force: true });
      sendSession = currentSessionRef.current;
    }
    const composerMode =
      options?.mode ??
      (content === undefined
        ? sendSession
          ? composerModeBySessionRef.current[sendSession] || DEFAULT_COMPOSER_MODE
          : DEFAULT_COMPOSER_MODE
        : DEFAULT_COMPOSER_MODE);
    const draftSource =
      composerMode === "shell"
        ? shellDraftsRef.current
        : composerMode === "image"
          ? imageDraftsRef.current
          : draftsRef.current;
    const currentDraft = sendSession ? (draftSource[sendSession] || "") : "";
    const composerInput = content || currentDraft.trim();
    const rawMessageContent =
      composerMode === "shell"
        ? parseRunSlashCommand(composerInput) ?? composerInput
        : composerInput;
    const messageContent =
      composerMode === "shell" && rawMessageContent
        ? `/run ${rawMessageContent}`
        : rawMessageContent;
    const userMessageContent =
      composerMode === "shell" ? rawMessageContent : messageContent;
    const failedDraftRestore = content ? null : currentDraft;
    const sendSessionIsBusy =
      isLoading &&
      (activeWorkSessionKey === sendSession ||
        activeRunSessionRef.current === sendSession ||
        outboxEntriesRef.current.some((entry) => entry.sessionKey === sendSession));
    if (!sendSession || sendSessionIsBusy || (!rawMessageContent && pendingAttachments.length === 0)) return;
    const attachmentsPayload = pendingAttachments.map((attachment) => ({
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
      content: attachment.content,
    }));
    const imageGenerationAttachmentsPayload = pendingAttachments.map((attachment) => ({
      file_name: attachment.fileName,
      mime_type: attachment.mimeType,
      content: attachment.content,
    }));
    const hasAttachments = attachmentsPayload.length > 0;
    const attachmentNames = pendingAttachments.map((attachment) => attachment.fileName || "file");
    const attachmentLine =
      pendingAttachments.length === 1
        ? `[Attached ${attachmentKindLabel(pendingAttachments[0]?.mimeType || "")}: ${pendingAttachments[0]?.fileName || "file"}]`
        : `[Attached ${pendingAttachments.length} files]`;
    const userVisibleContent = hasAttachments
      ? userMessageContent
        ? `${userMessageContent}\n\n${attachmentLine}`
        : attachmentLine
      : userMessageContent;
    let outboundMessageContent = hasAttachments
      ? userMessageContent
        ? `${userMessageContent}\n\nAttached file context: ${attachmentNames.join(", ")}`
        : `Attached file context: ${attachmentNames.join(", ")}`
      : messageContent;
    const runCommand = parseRunSlashCommand(messageContent);
    if (runCommand !== null) {
      if (hasAttachments) {
        const message = "Attachments are not supported with `/run`.";
        setError(message);
        appendAssistantNotice(message, sendSession);
        return;
      }
      if (!runCommand.trim()) {
        const message = "Usage: `/run <command>`";
        setError(message);
        appendAssistantNotice(message, sendSession);
        return;
      }

      const userMessage: Message = {
        id: crypto.randomUUID(),
        role: "user",
        content: userMessageContent,
        sentAt: Date.now(),
      };
      appendLocalMessage(userMessage, sendSession);

      if (!content && sendSession) {
        if (composerMode === "shell") {
          setShellDraftsBySession((prev) => ({ ...prev, [sendSession]: "" }));
        } else {
          setDraftsBySession((prev) => ({ ...prev, [sendSession]: "" }));
        }
        if (textareaRef.current) {
          textareaRef.current.style.height = "auto";
          textareaRef.current.style.overflowY = "hidden";
        }
      }

      setIsLoading(true);
      setActiveWorkSessionKey(sendSession);
      setThinkingStatus("Running command");
      setError(null);

      const currentCwd =
        terminalStateBySessionRef.current[sendSession]?.cwd || TERMINAL_DEFAULT_CWD;

      try {
        const response = await invoke<ChatTerminalRunResponse>("run_chat_terminal_command", {
          command: runCommand,
          cwd: currentCwd,
        });
        const nextCwd = response.cwd?.trim() || currentCwd;
        setTerminalStateForSession(sendSession, { cwd: nextCwd });
        appendLocalMessage(
          {
            id: crypto.randomUUID(),
            role: "assistant",
            content: "",
            kind: "toolResult",
            toolName: "/run",
            sentAt: Date.now(),
            terminalResult: {
              command: runCommand,
              cwd: nextCwd,
              stdout: response.stdout || "",
              stderr: response.stderr || "",
              exitCode: response.exit_code ?? null,
            },
          },
          sendSession
        );
      } catch (e) {
        const message = e instanceof Error ? e.message : "Failed to run command.";
        setError(message);
        appendLocalMessage(
          {
            id: crypto.randomUUID(),
            role: "assistant",
            content: "",
            kind: "toolResult",
            toolName: "/run",
            sentAt: Date.now(),
            terminalResult: {
              command: runCommand,
              cwd: currentCwd,
              stdout: "",
              stderr: message,
              exitCode: null,
            },
          },
          sendSession
        );
      } finally {
        setIsLoading(false);
        setActiveWorkSessionKey(null);
        setThinkingStatus(null);
      }
      return;
    }

    if (composerMode === "image") {
      if (!useLocalKeys && !proxyEnabled) {
        const message = "Image generation currently requires proxy mode in Settings.";
        setError(message);
        appendAssistantNotice(message, sendSession);
        return;
      }
      if (!gatewayRunning) {
        const message = "Start the sandbox first to generate images.";
        setError(message);
        appendAssistantNotice(message, sendSession);
        return;
      }
      if (!userMessageContent && !hasAttachments) {
        const message = "Enter an image prompt or attach a reference image.";
        setError(message);
        appendAssistantNotice(message, sendSession);
        return;
      }
      const nonImageAttachment = pendingAttachments.find(
        (attachment) => !attachment.mimeType.startsWith("image/"),
      );
      if (nonImageAttachment) {
        const message = "Image mode only supports image attachments. Remove other files first.";
        setError(message);
        appendAssistantNotice(message, sendSession);
        return;
      }

      const userMessage: Message = {
        id: crypto.randomUUID(),
        role: "user",
        content: userVisibleContent,
        sentAt: Date.now(),
        attachments: hasAttachments
          ? pendingAttachments.map((a) => ({
              fileName: a.fileName,
              mimeType: a.mimeType,
              previewUrl: a.previewUrl || `data:${a.mimeType};base64,${a.content}`,
            }))
          : undefined,
      };
      appendLocalMessage(userMessage, sendSession);

      if (!content && sendSession) {
        setImageDraftsBySession((prev) => ({ ...prev, [sendSession]: "" }));
        if (textareaRef.current) {
          textareaRef.current.style.height = "auto";
          textareaRef.current.style.overflowY = "hidden";
        }
      }

      setIsLoading(true);
      setActiveWorkSessionKey(sendSession);
      setThinkingStatus("Generating image");
      setError(null);

      try {
        const response = await invoke<ChatImageGenerationResponse>("generate_chat_image", {
          model: imageGenerationModel,
          prompt: userMessageContent,
          attachments: imageGenerationAttachmentsPayload,
        });
        const generatedCount = response.images.length;
        appendLocalMessage(
          {
            id: crypto.randomUUID(),
            role: "assistant",
            content:
              response.text ||
              (generatedCount > 0
                ? `Generated ${generatedCount} image${generatedCount === 1 ? "" : "s"}.`
                : ""),
            sentAt: Date.now(),
            attachments: response.images.map((image, index) => ({
              fileName: image.file_name || `generated-${index + 1}.png`,
              mimeType: image.mime_type || "image/png",
              previewUrl: image.url,
            })),
          },
          sendSession
        );
      } catch (e) {
        const message = formatUnknownUiError(e, "Failed to generate image.");
        setError(message);
        appendAssistantNotice(`I couldn't generate that image: ${message}`, sendSession);
      } finally {
        clearPendingAttachments();
        setIsLoading(false);
        setActiveWorkSessionKey(null);
        setThinkingStatus(null);
      }
      return;
    }

    const liveClient = clientRef.current;
    const shouldQueueForReconnect =
      gatewayStarting || isConnecting || connectInFlightRef.current || gatewayRunning;
    if ((!liveClient || !liveClient.isConnected()) && !shouldQueueForReconnect) {
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

    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: "user",
      content: userVisibleContent,
      sentAt: Date.now(),
      attachments: hasAttachments
        ? pendingAttachments.map((a) => ({
            fileName: a.fileName,
            mimeType: a.mimeType,
            previewUrl: a.previewUrl || `data:${a.mimeType};base64,${a.content}`,
          }))
        : undefined,
    };
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
      if (composerMode === "shell") {
        setShellDraftsBySession((prev) => ({ ...prev, [sendSession]: "" }));
      } else {
        setDraftsBySession((prev) => ({ ...prev, [sendSession]: "" }));
      }
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
        textareaRef.current.style.overflowY = 'hidden';
      }
    }
    setShowWelcome(false);
    setIsLoading(true);
    setActiveWorkSessionKey(sendSession);
    setThinkingStatus("Checking request");
    setError(null);

    const shouldCheckTaskBoardIntent =
      !hasAttachments &&
      !messageContent.startsWith(INTERNAL_USER_PROMPT_PREFIX) &&
      messageContent.trim().length <= 500;
    const looksLikeTaskBoardWriteCommand =
      shouldCheckTaskBoardIntent &&
      /^(?:please\s+)?(?:add|create|track)\b/i.test(messageContent.trim()) &&
      /\b(?:task\s+)?board\b/i.test(messageContent);
    const taskBoardIntent = shouldCheckTaskBoardIntent
      ? parseTaskBoardChatIntent(messageContent)
      : null;
    if (taskBoardIntent && sendSession) {
      setThinkingStatus("Updating task board");
      const handled = await handleTaskBoardChatIntent(taskBoardIntent, sendSession);
      if (handled) {
        clearPendingAttachments();
        setIsLoading(false);
        setActiveWorkSessionKey(null);
        setThinkingStatus(null);
        return;
      }
    }
    if (!taskBoardIntent && looksLikeTaskBoardWriteCommand && sendSession) {
      appendAssistantNotice(
        "I couldn't safely parse that board command, so I didn't change tasks. Try: `add task board: <task>` or `add a task on my board to <task>`.",
        sendSession
      );
      setIsLoading(false);
      setActiveWorkSessionKey(null);
      setThinkingStatus(null);
      return;
    }

    const shouldCheckXIntent =
      !hasAttachments &&
      !messageContent.startsWith(INTERNAL_USER_PROMPT_PREFIX) &&
      messageContent.trim().length <= 500;
    const activeIntegrationLaunch =
      sendSession && integrationLaunchBySession[sendSession]?.status === "ready"
        ? integrationLaunchBySession[sendSession]
        : null;
    const integrationLaunchPrompt =
      activeIntegrationLaunch && !messageContent.startsWith(INTERNAL_USER_PROMPT_PREFIX)
        ? formatIntegrationLaunchRoutingPrompt(activeIntegrationLaunch, messageContent)
        : null;
    const integrationLaunchIntent = Boolean(integrationLaunchPrompt);
    if (integrationLaunchPrompt && activeIntegrationLaunch) {
      outboundMessageContent = integrationLaunchPrompt;
      addDiag(`integration launcher routing provider=${activeIntegrationLaunch.provider}`);
    }
    const xIntent = !integrationLaunchIntent && shouldCheckXIntent ? parseXSearchIntent(messageContent) : null;
    if (xIntent && sendSession) {
      const xQuickActionCandidate = getQuickActionById("x_trending_news");
      const xQuickAction =
        xQuickActionCandidate && xQuickActionCandidate.kind === "agent"
          ? xQuickActionCandidate
          : null;
      const requirement = xQuickAction?.requirement;

      if (xQuickAction && requirement?.kind === "integration") {
        try {
          const connectedNow = await isIntegrationReady(requirement.provider);
          if (!connectedNow) {
            addDiag("x intent detected; X integration not connected");
            setIntegrationSetupForSession(sendSession, {
              requirement,
              pendingAction: xQuickAction,
              status: "idle",
              error: null,
            });
            setQuickSuggestionForSession(sendSession, null);
            setBuilderChecklistForSession(sendSession, null);
            appendAssistantNotice(
              `I can do that with ${integrationRequirementLabel(requirement)}, but it is not connected yet. Complete setup below and I will continue.`,
              sendSession
            );
            setIsLoading(false);
            setActiveWorkSessionKey(null);
            setThinkingStatus(null);
            return;
          }
        } catch {
          setIntegrationSetupForSession(sendSession, {
            requirement,
            pendingAction: xQuickAction,
            status: "idle",
            error: `Failed to check ${integrationRequirementLabel(requirement)} status.`,
          });
          setQuickSuggestionForSession(sendSession, null);
          setBuilderChecklistForSession(sendSession, null);
          setIsLoading(false);
          setActiveWorkSessionKey(null);
          setThinkingStatus(null);
          return;
        }
      }

      const topicLine = xIntent.topic
        ? `Primary topic: ${xIntent.topic}.`
        : "Primary topic: top trending conversations right now.";
      outboundMessageContent = [
        "Use the connected X integration for this request.",
        topicLine,
        "Return concise bullets with direct X links, a short why-it-matters note, and clear recency cues.",
        `Original user request: ${messageContent.trim()}`,
      ].join("\n");
      addDiag(`x intent detected; routing via X integration topic=${xIntent.topic ? "yes" : "no"}`);
    }

    const oneDriveIntent =
      !xIntent &&
      !integrationLaunchIntent &&
      shouldCheckXIntent &&
      parseOneDriveIntent(messageContent);
    if (oneDriveIntent && sendSession) {
      try {
        const connectedNow = await isIntegrationReady("onedrive");
        if (!connectedNow) {
          addDiag("onedrive intent detected; OneDrive integration not connected");
          appendAssistantNotice(
            "I can do that with OneDrive, but it is not connected yet. Connect OneDrive in Integrations, then try again.",
            sendSession
          );
          setIsLoading(false);
          setActiveWorkSessionKey(null);
          setThinkingStatus(null);
          return;
        }
      } catch {
        appendAssistantNotice("Failed to check OneDrive integration status.", sendSession);
        setIsLoading(false);
        setActiveWorkSessionKey(null);
        setThinkingStatus(null);
        return;
      }

      outboundMessageContent = [
        "Use the connected OneDrive integration for this request.",
        "Use only OneDrive tools for this request. Do not call Google Drive, Google Docs, Google Sheets, Outlook, Gmail, or local Office workflow tools unless the user explicitly asks for them.",
        "Available OneDrive tools: `onedrive_items_list`, `onedrive_items_search`, `onedrive_item_resolve_path`, `onedrive_item_get`, `onedrive_item_content_get`, `onedrive_item_download`, `onedrive_item_share`, `onedrive_folder_create`, `onedrive_text_file_upload`, `onedrive_base64_file_upload`, `onedrive_docx_create`, and `onedrive_item_move`.",
        "For uploading an existing local workspace file, read the file bytes from `/data/workspace`, base64-encode them, then call `onedrive_base64_file_upload` with the original filename. For creating a Word document directly from text, use `onedrive_docx_create`.",
        "If the user mentions a OneDrive folder path, resolve or create the folder first, then pass its item id as `parentItemId`.",
        "After a successful upload, report the OneDrive item name and any web/share link returned by the tool.",
        `Original user request: ${messageContent.trim()}`,
      ].join("\n");
      addDiag("onedrive intent detected; routing via OneDrive integration");
    }

    const workspaceOfficeIntent =
      !xIntent &&
      !integrationLaunchIntent &&
      !oneDriveIntent &&
      !hasAttachments &&
      !messageContent.startsWith(INTERNAL_USER_PROMPT_PREFIX) &&
      shouldRouteWorkspaceOfficeRequest(messageContent);
    if (workspaceOfficeIntent) {
      outboundMessageContent = formatWorkspaceOfficeRoutingPrompt(messageContent);
      addDiag("workspace office intent detected; routing via local Office workflow");
    }
    const workspaceOfficeAutoOpenPath =
      workspaceOfficeIntent && workspaceOfficeRequestWantsDesktopOpen(messageContent)
        ? extractWorkspaceOfficeFileName(messageContent)
        : null;

    const explicitOutlookIntent = hasExplicitOutlookIntent(messageContent);
    const explicitGmailIntent = hasExplicitGmailIntent(messageContent);
    let genericEmailProvider: "gmail" | "outlook" | null = null;
    if (
      !xIntent &&
      !integrationLaunchIntent &&
      !oneDriveIntent &&
      !workspaceOfficeIntent &&
      shouldCheckXIntent &&
      !explicitOutlookIntent &&
      !explicitGmailIntent &&
      parseGenericEmailIntent(messageContent)
    ) {
      const [gmailConnected, outlookConnected] = await Promise.all([
        isIntegrationReady("google_email").catch(() => false),
        isIntegrationReady("outlook").catch(() => false),
      ]);

      if (gmailConnected && outlookConnected && sendSession) {
        addDiag("generic email intent detected with Gmail and Outlook connected; asking for provider");
        appendAssistantNotice(
          "I can use Gmail or Outlook for that. Which account should I use?",
          sendSession
        );
        setIsLoading(false);
        setActiveWorkSessionKey(null);
        setThinkingStatus(null);
        return;
      }

      if (outlookConnected) {
        genericEmailProvider = "outlook";
      } else if (gmailConnected) {
        genericEmailProvider = "gmail";
      }
    }

    const outlookIntent =
      !xIntent &&
      !integrationLaunchIntent &&
      !oneDriveIntent &&
      !workspaceOfficeIntent &&
      shouldCheckXIntent &&
      (explicitOutlookIntent || genericEmailProvider === "outlook");
    if (outlookIntent && sendSession) {
      try {
        const connectedNow = await isIntegrationReady("outlook");
        if (!connectedNow) {
          addDiag("outlook intent detected; Outlook integration not connected");
          appendAssistantNotice(
            "I can do that with Outlook, but it is not connected yet. Connect Outlook in Integrations, then try again.",
            sendSession
          );
          setIsLoading(false);
          setActiveWorkSessionKey(null);
          setThinkingStatus(null);
          return;
        }
      } catch {
        appendAssistantNotice("Failed to check Outlook integration status.", sendSession);
        setIsLoading(false);
        setActiveWorkSessionKey(null);
        setThinkingStatus(null);
        return;
      }

      outboundMessageContent = [
        "Use the connected Outlook integration for this request.",
        "Use only Outlook tools for this request. Do not call Gmail tools, including `gmail_send`, `gmail_draft`, `gmail_search`, or `gmail_get`.",
        "Available Outlook tools: `outlook_messages_list` for inbox/message lists, `outlook_message_get` for reading a specific message, `outlook_message_send` for sending mail, and `outlook_mail_folders_list` for folders.",
        "For calendar requests, use `outlook_calendars_list`, `outlook_events_list`, and `outlook_event_create`.",
        "Do not say Outlook or Composio is unavailable unless an Outlook tool call actually fails.",
        "For inbox/list/summarize requests, start with `outlook_messages_list` using limit 10.",
        `Original user request: ${messageContent.trim()}`,
      ].join("\n");
      addDiag("outlook intent detected; routing via Outlook integration");
    }

    const gmailIntent =
      !xIntent &&
      !integrationLaunchIntent &&
      !oneDriveIntent &&
      !workspaceOfficeIntent &&
      !outlookIntent &&
      shouldCheckXIntent &&
      (explicitGmailIntent || genericEmailProvider === "gmail" || parseGmailIntent(messageContent));
    if (gmailIntent && sendSession) {
      const gmailQuickActionCandidate = getQuickActionById("inbox_cleanup");
      const gmailQuickAction =
        gmailQuickActionCandidate && gmailQuickActionCandidate.kind === "agent"
          ? gmailQuickActionCandidate
          : null;
      const requirement = gmailQuickAction?.requirement;

      if (gmailQuickAction && requirement?.kind === "integration") {
        try {
          const connectedNow = await isIntegrationReady(requirement.provider);
          if (!connectedNow) {
            addDiag("gmail intent detected; Gmail integration not connected");
            setIntegrationSetupForSession(sendSession, {
              requirement,
              pendingAction: gmailQuickAction,
              status: "idle",
              error: null,
            });
            setQuickSuggestionForSession(sendSession, null);
            setBuilderChecklistForSession(sendSession, null);
            appendAssistantNotice(
              `I can do that with ${integrationRequirementLabel(requirement)}, but it is not connected yet. Complete setup below and I will continue.`,
              sendSession
            );
            setIsLoading(false);
            setActiveWorkSessionKey(null);
            setThinkingStatus(null);
            return;
          }
        } catch {
          setIntegrationSetupForSession(sendSession, {
            requirement,
            pendingAction: gmailQuickAction,
            status: "idle",
            error: `Failed to check ${integrationRequirementLabel(requirement)} status.`,
          });
          setQuickSuggestionForSession(sendSession, null);
          setBuilderChecklistForSession(sendSession, null);
          setIsLoading(false);
          setActiveWorkSessionKey(null);
          setThinkingStatus(null);
          return;
        }
      }

      outboundMessageContent = [
        "Use the connected Gmail integration for this request.",
        "Use only Gmail tools for this request. Do not call Outlook tools, including `outlook_message_send`, `outlook_messages_list`, `outlook_message_get`, or `outlook_mail_folders_list`.",
        "Available Gmail tools: `gmail_search` for inbox/search, `gmail_get` for reading a specific message, `gmail_send` for sending, and `gmail_draft` for drafts.",
        "Do not say Gmail or Composio is unavailable unless a Gmail tool call actually fails.",
        "For inbox/list/summarize requests, start with `gmail_search` using query `in:inbox` and maxResults 10.",
        `Original user request: ${messageContent.trim()}`,
      ].join("\n");
      addDiag("gmail intent detected; routing via Gmail integration");
    }

    outboundMessageContent = withAgentIdentityContext(
      outboundMessageContent,
      agentProfile?.name || onboardingData?.agentName || DEFAULT_AGENT_NAME,
    );

    const pendingSend: PersistedPendingSend = {
      id: userMessage.id,
      sessionKey: sendSession,
      outboundMessageContent,
      routingContent: messageContent,
      attachments: attachmentsPayload,
      idempotencyKey: crypto.randomUUID(),
      createdAt: Date.now(),
      attemptCount: 0,
      nextAttemptAt: Date.now(),
    };
    if (options?.speakResponse) {
      voiceSpeakResponseBySendIdRef.current.add(pendingSend.id);
    }
    if (workspaceOfficeAutoOpenPath) {
      workspaceOfficeOpenBySendIdRef.current[pendingSend.id] = {
        path: workspaceOfficeAutoOpenPath,
      };
      clientLog("chat.office.auto_open.pending", {
        sendId: pendingSend.id,
        path: workspaceOfficeAutoOpenPath,
      });
    }
    if (integrationLaunchIntent) {
      setIntegrationLaunchForSession(sendSession, null);
    }
    upsertOutboxEntry(pendingSend);
    clearPendingAttachments();

    if (activeRunIdRef.current && activeRunSessionRef.current !== sendSession) {
      setThinkingStatus("Queued behind current task");
      setError(null);
      addDiag(
        `send queued behind active run session=${sendSession} activeSession=${activeRunSessionRef.current}`,
      );
      return;
    }

    if (!liveClient || !liveClient.isConnected()) {
      if (!connectInFlightRef.current) {
        void connectToGateway();
      }
      setIsLoading(true);
      setThinkingStatus("Waiting for reconnect");
      setError(null);
      addDiag(
        `send queued: gateway reconnect pending session=${sendSession} attachments=${attachmentsPayload.length}`,
      );
      return;
    }

    outboxDispatchInFlightRef.current.add(pendingSend.id);
    await refreshTrialCredits();
    setIsLoading(true);
    setActiveWorkSessionKey(sendSession);
    setThinkingStatus("Thinking");
    setError(null);
    try {
      await dispatchPendingSend(pendingSend);
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : "Send failed";
      let handledProviderOAuth = false;
      if (proxyEnabled && isProviderOAuthExpiryFailure(errorMessage)) {
        triggerProxyAuthRecovery("send failed");
        handledProviderOAuth = true;
      } else {
        handledProviderOAuth = await recoverExpiredProviderOAuth("send failed", errorMessage);
      }
      if (!handledProviderOAuth && isProxyAuthFailure(errorMessage)) {
        triggerProxyAuthRecovery("send failed");
      }
      if (isRecoverablePendingSendError(e, errorMessage)) {
        updateOutboxEntry(pendingSend.id, (current) => ({
          ...current,
          attemptCount: current.attemptCount + 1,
          nextAttemptAt: Date.now() + pendingSendBackoffMs(current.attemptCount + 1),
        }));
        if (!handledProviderOAuth) {
          setError(null);
        }
        setThinkingStatus("Waiting for reconnect");
      } else {
        removeOutboxEntry(pendingSend.id);
        voiceSpeakResponseBySendIdRef.current.delete(pendingSend.id);
        if (!handledProviderOAuth) {
          setError(errorMessage);
        }
        setIsLoading(false);
        setActiveWorkSessionKey(null);
        setThinkingStatus(null);
      }
      await refreshTrialCredits();
      addDiag(`send failed: ${e instanceof Error ? e.message : "unknown"}`);
      if (
        !isRecoverablePendingSendError(e, errorMessage) &&
        failedDraftRestore !== null &&
        sendSession &&
        currentSessionRef.current === sendSession
      ) {
        if (composerMode === "shell") {
          setShellDraftsBySession((prev) => ({ ...prev, [sendSession]: failedDraftRestore }));
        } else {
          setDraftsBySession((prev) => ({ ...prev, [sendSession]: failedDraftRestore }));
        }
      }
    } finally {
      outboxDispatchInFlightRef.current.delete(pendingSend.id);
    }
  }

  function sessionTitle(s: ChatSession): string {
    return s.label || s.derivedTitle || s.displayName || `Chat ${s.key.slice(0, 8)}`;
  }

  function appendLocalMessage(message: Message, sessionKeyInput?: string) {
    const sessionKey = sessionKeyInput || ensureComposerSession();
    if (!sessionKey) return;
    if (currentSessionRef.current === sessionKey) {
      setShowWelcome(false);
      visibleMessagesSessionRef.current = sessionKey;
      setMessages((prev) => [...prev, message]);
    }
    const cachedMsgs = sessionMessagesRef.current[sessionKey] || [];
    sessionMessagesRef.current[sessionKey] = [...cachedMsgs, message];
    setSessions((prev) => {
      const updated = prev.some((s) => s.key === sessionKey)
        ? prev.map((s) => (s.key === sessionKey ? { ...s, updatedAt: Date.now() } : s))
        : [{ key: sessionKey, updatedAt: Date.now() }, ...prev];
      return applySessionTitles(normalizeSessionsList(updated));
    });
    schedulePersist();
  }

  function appendAssistantNotice(content: string, sessionKeyInput?: string) {
    appendLocalMessage(
      {
        id: crypto.randomUUID(),
        role: "assistant",
        content,
        sentAt: Date.now(),
      },
      sessionKeyInput
    );
  }

  async function isIntegrationReady(provider: IntegrationProvider): Promise<boolean> {
    const integrations = await getIntegrations({ force: true });
    const entry = integrations.find((item) => item.provider === provider);
    return Boolean(entry && entry.connected && !entry.stale);
  }

  async function refreshHomeIntegrationLaunch(
    sessionKey: string,
    launch: Pick<IntegrationLaunchState, "provider" | "name">
  ): Promise<boolean> {
    const integrations = await getIntegrations({ force: true });
    const entry = integrations.find((item) => item.provider === launch.provider);
    const connectedNow = Boolean(entry && entry.connected && !entry.stale);
    if (!connectedNow) return false;

    setIntegrationLaunchBySession((prev) => {
      const current = prev[sessionKey];
      if (!current || current.provider !== launch.provider) return prev;
      return {
        ...prev,
        [sessionKey]: {
          provider: current.provider,
          name: current.name || launch.name,
          status: "ready",
          error: null,
        },
      };
    });
    syncAllIntegrationsToGateway().then(
      (providers) => addDiag(`integrations synced after launcher connect: ${providers.join(", ") || "none"}`),
      (err) => addDiag(`integration sync after launcher connect failed: ${err instanceof Error ? err.message : String(err)}`)
    );
    if (currentSessionRef.current === sessionKey) {
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
    return true;
  }

  async function connectHomeIntegration(
    sessionKey: string,
    integration: typeof HOME_PRIMARY_INTEGRATIONS[number],
    permissionProfile?: string | null
  ) {
    setIntegrationLaunchForSession(sessionKey, {
      provider: integration.provider,
      name: integration.name,
      status: "connecting",
      error: null,
    });
    await connectIntegration(integration.provider, { permissionProfile });
    setIntegrationLaunchForSession(sessionKey, {
      provider: integration.provider,
      name: integration.name,
      status: "connecting",
      error: `Finish connecting ${integration.name}, then click this icon again.`,
    });
  }

  async function handleHomeIntegrationClick(integration: typeof HOME_PRIMARY_INTEGRATIONS[number]) {
    const sessionKey = currentSessionRef.current || ensureComposerSession();
    if (!sessionKey) return;
    setError(null);
    setShowWelcome(false);
    setComposerModeForSession(sessionKey, "chat");
    setIntegrationSetupForSession(sessionKey, null);
    setQuickSuggestionForSession(sessionKey, null);
    setBuilderChecklistForSession(sessionKey, null);
    setIntegrationLaunchForSession(sessionKey, {
      provider: integration.provider,
      name: integration.name,
      status: "connecting",
      error: null,
    });

    try {
      const integrations = await getIntegrations({ force: true });
      const entry = integrations.find((item) => item.provider === integration.provider);
      if (entry?.connected && !entry.stale) {
        setIntegrationLaunchForSession(sessionKey, {
          provider: integration.provider,
          name: integration.name,
          status: "ready",
          error: null,
        });
        requestAnimationFrame(() => textareaRef.current?.focus());
        return;
      }

      const configuredProfiles = entry?.permissionProfiles?.filter((profile) => profile.configured) ?? [];
      if (configuredProfiles.length > 1) {
        setIntegrationLaunchForSession(sessionKey, {
          provider: integration.provider,
          name: integration.name,
          status: "selecting_access",
          error: null,
          permissionProfiles: configuredProfiles,
        });
        return;
      }

      const profile = configuredProfiles.find((item) => item.default) ?? configuredProfiles[0] ?? null;
      await connectHomeIntegration(sessionKey, integration, profile?.id ?? null);
    } catch (e) {
      const message = e instanceof Error ? e.message : `Failed to connect ${integration.name}.`;
      setIntegrationLaunchForSession(sessionKey, {
        provider: integration.provider,
        name: integration.name,
        status: "connecting",
        error: message,
      });
    }
  }

  useEffect(() => {
    if (!currentSession || !integrationLaunch || integrationLaunch.status !== "connecting") return;
    let cancelled = false;
    const sessionKey = currentSession;
    const launch = {
      provider: integrationLaunch.provider,
      name: integrationLaunch.name,
    };

    const checkLaunchConnection = () => {
      refreshHomeIntegrationLaunch(sessionKey, launch).catch((err) => {
        if (!cancelled) {
          addDiag(`launcher integration status check failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      });
    };
    const checkWhenVisible = () => {
      if (document.visibilityState === "visible") checkLaunchConnection();
    };

    checkLaunchConnection();
    const interval = window.setInterval(checkLaunchConnection, 3000);
    window.addEventListener("focus", checkLaunchConnection);
    window.addEventListener("entropic-integration-updated", checkLaunchConnection);
    document.addEventListener("visibilitychange", checkWhenVisible);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener("focus", checkLaunchConnection);
      window.removeEventListener("entropic-integration-updated", checkLaunchConnection);
      document.removeEventListener("visibilitychange", checkWhenVisible);
    };
  }, [currentSession, integrationLaunch?.provider, integrationLaunch?.status]);

  function openQuickSuggestion(action: AgentQuickActionDefinition, sessionKeyInput?: string) {
    const sessionKey = sessionKeyInput || ensureComposerSession();
    if (!sessionKey) return;
    setQuickSuggestionForSession(sessionKey, {
      action,
      taskName: action.label,
      taskPreset: action.taskPreset || "daily",
      creatingTask: false,
      error: null,
    });
    setIntegrationSetupForSession(sessionKey, null);
    setBuilderChecklistForSession(sessionKey, null);
  }

  function openBuilderChecklist(
    action: AgentQuickActionDefinition & { id: BuilderQuickActionId },
    sessionKeyInput?: string
  ) {
    const sessionKey = sessionKeyInput || ensureComposerSession();
    if (!sessionKey) return;
    setBuilderChecklistForSession(sessionKey, {
      action,
      selectedByOptionId: createDefaultBuilderSelection(action.id),
      error: null,
    });
    setQuickSuggestionForSession(sessionKey, null);
    setIntegrationSetupForSession(sessionKey, null);
    setShowWelcome(false);
  }

  function toggleBuilderChecklistOption(optionId: string) {
    const sessionKey = currentSessionRef.current;
    if (!sessionKey) return;
    const checklist = builderChecklistBySession[sessionKey];
    if (!checklist) return;
    setBuilderChecklistForSession(sessionKey, {
      ...checklist,
      selectedByOptionId: {
        ...checklist.selectedByOptionId,
        [optionId]: !checklist.selectedByOptionId[optionId],
      },
      error: null,
    });
  }

  function setAllBuilderChecklistOptions(selected: boolean) {
    const sessionKey = currentSessionRef.current;
    if (!sessionKey) return;
    const checklist = builderChecklistBySession[sessionKey];
    if (!checklist) return;
    const options = BUILDER_CHECKLIST_CONFIG_BY_ACTION[checklist.action.id].options;
    const selectedByOptionId = Object.fromEntries(options.map((option) => [option.id, selected]));
    setBuilderChecklistForSession(sessionKey, {
      ...checklist,
      selectedByOptionId,
      error: null,
    });
  }

  function startBuilderFromChecklist() {
    const sessionKey = currentSessionRef.current;
    if (!sessionKey) return;
    const checklist = builderChecklistBySession[sessionKey];
    if (!checklist) return;
    const selectedOptions = selectedBuilderChecklistOptions(checklist);
    if (selectedOptions.length === 0) {
      setBuilderChecklistForSession(sessionKey, {
        ...checklist,
        error: "Select at least one item to edit in this session.",
      });
      return;
    }

    setBuilderChecklistForSession(sessionKey, null);
    setQuickSuggestionForSession(sessionKey, null);
    setIntegrationSetupForSession(sessionKey, null);
    setShowWelcome(false);
    if (checklist.action.id === "build_agent_identity") {
      builderSessionsRef.current.add(sessionKey);
    }
    let payload = resolveQuickActionMessage(checklist.action);
    payload = `${INTERNAL_USER_PROMPT_PREFIX}\n${payload}\n\n${buildChecklistScopeBlock(checklist.action.id, selectedOptions)}`;
    if (checklist.action.id === "build_agent_identity") {
      appendAssistantNotice(
        `Agent Builder started with ${selectedOptions.length} selected section${selectedOptions.length === 1 ? "" : "s"}. I will stay scoped to these edits unless you expand.`,
        sessionKey
      );
    } else {
      appendAssistantNotice(
        `Profile Builder started with ${selectedOptions.length} selected section${selectedOptions.length === 1 ? "" : "s"}. I will stay scoped to these edits unless you expand.`,
        sessionKey
      );
    }
    void handleSend(payload);
  }

  function resolveQuickActionMessage(action: AgentQuickActionDefinition): string {
    const userName = onboardingData?.userName?.trim();
    if (!userName) return action.message;
    return action.message.split("<Your Name>").join(userName);
  }

  function resolveProfileAvatarDataUrl(
    rawIdentityAvatar: string | null | undefined,
    currentAvatar?: string
  ): string | undefined {
    const current = isRenderableAvatarDataUrl(currentAvatar) ? currentAvatar.trim() : undefined;
    const raw = typeof rawIdentityAvatar === "string" ? rawIdentityAvatar.trim() : "";
    if (!raw) {
      return current;
    }
    if (isRenderableAvatarDataUrl(raw)) {
      return raw;
    }
    const mapped = avatarUploadDataUrlByFileNameRef.current.get(normalizeAttachmentFileName(raw));
    return (isRenderableAvatarDataUrl(mapped) ? mapped.trim() : undefined) || current;
  }

  async function syncDesktopProfileFromIdentity() {
    try {
      const state = await invoke<{
        identity_name?: string;
        identity_avatar?: string | null;
      }>("get_agent_profile_state");
      const current = await loadProfile();
      const nextName =
        typeof state.identity_name === "string" && state.identity_name.trim()
          ? sanitizeProfileName(state.identity_name)
          : current.name;
      const nextAvatar = resolveProfileAvatarDataUrl(state.identity_avatar, current.avatarDataUrl);
      if (nextName === current.name && nextAvatar === current.avatarDataUrl) {
        return;
      }
      await saveProfile({
        name: nextName,
        avatarDataUrl: nextAvatar,
      });
      window.dispatchEvent(new Event("entropic-profile-updated"));
    } catch {
      // ignore profile sync failures; identity files remain source of truth
    }
  }

  async function connectIntegrationInChat() {
    const sessionKey = currentSessionRef.current;
    if (!sessionKey) return;
    const setup = integrationSetupBySession[sessionKey];
    if (!setup) return;
    setIntegrationSetupForSession(sessionKey, { ...setup, status: "connecting", error: null });
    try {
      await connectIntegration(setup.requirement.provider);
      const connectedNow = await isIntegrationReady(setup.requirement.provider);
      if (connectedNow) {
        setIntegrationSetupForSession(sessionKey, null);
        setError(null);
        appendAssistantNotice(
          `${integrationRequirementLabel(setup.requirement)} connected. Ready to run "${setup.pendingAction.label}".`,
          sessionKey
        );
        openQuickSuggestion(setup.pendingAction, sessionKey);
        return;
      }
      setIntegrationSetupForSession(sessionKey, { ...setup, status: "awaiting_callback", error: null });
      appendAssistantNotice(
        `Finish ${integrationRequirementLabel(setup.requirement)} setup in your browser, then click "Verify connection".`,
        sessionKey
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : "Failed to connect integration";
      setIntegrationSetupForSession(sessionKey, { ...setup, status: "idle", error: message });
    }
  }

  async function verifyPendingIntegrationSetup() {
    const sessionKey = currentSessionRef.current;
    if (!sessionKey) return;
    const setup = integrationSetupBySession[sessionKey];
    if (!setup) return;
    setIntegrationSetupForSession(sessionKey, { ...setup, status: "connecting", error: null });
    try {
      const connectedNow = await isIntegrationReady(setup.requirement.provider);
      if (!connectedNow) {
        setIntegrationSetupForSession(sessionKey, {
          ...setup,
          status: "awaiting_callback",
          error: `${integrationRequirementLabel(setup.requirement)} is not connected yet.`,
        });
        return;
      }
      setIntegrationSetupForSession(sessionKey, null);
      setError(null);
      appendAssistantNotice(
        `${integrationRequirementLabel(setup.requirement)} connected. Ready to run "${setup.pendingAction.label}".`,
        sessionKey
      );
      openQuickSuggestion(setup.pendingAction, sessionKey);
    } catch (e) {
      const message = e instanceof Error ? e.message : "Failed to verify integration";
      setIntegrationSetupForSession(sessionKey, { ...setup, status: "awaiting_callback", error: message });
    }
  }

  function runQuickSuggestionNow() {
    const sessionKey = currentSessionRef.current;
    if (!sessionKey) return;
    const quick = quickSuggestionBySession[sessionKey];
    if (!quick) return;
    const action = quick.action;
    setQuickSuggestionForSession(sessionKey, null);
    setShowWelcome(false);
    void handleSend(action.message);
  }

  async function createQuickSuggestionTask() {
    const sessionKey = currentSessionRef.current;
    if (!sessionKey) return;
    const quick = quickSuggestionBySession[sessionKey];
    if (!quick) return;
    if (!gatewayRunning) {
      setQuickSuggestionForSession(sessionKey, {
        ...quick,
        error: "Start the gateway to create scheduled jobs.",
      });
      return;
    }

    setQuickSuggestionForSession(sessionKey, { ...quick, creatingTask: true, error: null });
    const taskName = quick.taskName.trim() || quick.action.label;
    try {
      const auth = await resolveGatewayAuth();
      const taskClient = createGatewayClient(auth.wsUrl, auth.token);
      await taskClient.connect();
      try {
        await taskClient.addCronJob({
          name: taskName,
          description: `Created from chat quick action: ${quick.action.label}`,
          schedule: getScheduleForTaskPreset(quick.taskPreset),
          payload: {
            kind: "agentTurn",
            message: `${CRON_GUARD_BLOCK}${quick.action.message}`,
            deliver: false,
          },
          sessionTarget: "isolated",
          wakeMode: "next-heartbeat",
          enabled: true,
        });
      } finally {
        taskClient.disconnect();
      }
      setQuickSuggestionForSession(sessionKey, null);
      setShowWelcome(false);
      appendAssistantNotice(
        `Scheduled job "${taskName}" created (${getTaskPresetLabel(quick.taskPreset)}). I can run "${quick.action.label}" automatically now.`,
        sessionKey
      );
      window.dispatchEvent(new Event("entropic-tasks-updated"));
    } catch (e) {
      const message = e instanceof Error ? e.message : "Failed to create scheduled job";
      setQuickSuggestionForSession(sessionKey, { ...quick, creatingTask: false, error: message });
    }
  }

  function renderBuilderChecklistAssistantCard() {
    if (!builderChecklist) return null;
    const checklist = builderChecklist;
    const config = BUILDER_CHECKLIST_CONFIG_BY_ACTION[checklist.action.id];
    const selectedCount = selectedBuilderChecklistOptions(checklist).length;

    return (
      <div className="flex justify-start">
        <div className="max-w-[92%] sm:max-w-[80%]">
          <div className="px-4 py-3 rounded-2xl bg-[var(--glass-bg-hover)] text-[var(--text-primary)] border border-[var(--glass-border-subtle)] shadow-sm backdrop-blur-sm">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2">
                <img src={entropicLogo} alt="Entropic" className="w-5 h-5 rounded-md" />
                <span className="text-xs font-semibold text-[var(--text-primary)]">{config.title}</span>
              </div>
              <button
                onClick={() => {
                  if (!currentSession) return;
                  setBuilderChecklistForSession(currentSession, null);
                }}
                className="text-xs text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
              >
                Close
              </button>
            </div>

            <div className="mt-2 flex items-center justify-between gap-3">
              <p className="text-xs text-[var(--text-secondary)]">
                {config.summary}
              </p>
              <span className="inline-flex items-center rounded-full border border-[var(--glass-border-subtle)] bg-[var(--bg-card)] px-2 py-0.5 text-[11px] text-[var(--text-tertiary)] whitespace-nowrap">
                {selectedCount} selected
              </span>
            </div>

            <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-[30rem] overflow-auto pr-1">
              {config.options.map((option) => {
                const checked = Boolean(checklist.selectedByOptionId[option.id]);
                return (
                  <label
                    key={option.id}
                    className={clsx(
                      "flex items-start gap-2 rounded-xl border px-3 py-2.5 cursor-pointer transition-colors",
                      checked
                        ? "border-[var(--purple-accent)] bg-[var(--purple-accent-subtle)] shadow-sm"
                        : "border-[var(--glass-border-subtle)] bg-[var(--glass-bg)] hover:bg-[var(--bg-card)]"
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleBuilderChecklistOption(option.id)}
                      className="mt-0.5 h-4 w-4 rounded border-[var(--border-subtle)] text-[var(--purple-accent)]"
                    />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-[var(--text-primary)]">{option.label}</span>
                      {option.uiHint ? (
                        <span className="block text-[11px] text-[var(--text-tertiary)]">{option.uiHint}</span>
                      ) : null}
                    </span>
                  </label>
                );
              })}
            </div>

            {checklist.error ? <p className="text-xs text-red-500 mt-2">{checklist.error}</p> : null}

            <div className="flex flex-wrap items-center justify-between gap-2 mt-3">
              <p className="text-[11px] text-[var(--text-tertiary)]">
                Your selections scope this session.
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => setAllBuilderChecklistOptions(true)}
                  className="btn-secondary !text-xs !py-1.5"
                >
                  All
                </button>
                <button
                  onClick={() => setAllBuilderChecklistOptions(false)}
                  className="btn-secondary !text-xs !py-1.5"
                >
                  None
                </button>
                <button
                  onClick={startBuilderFromChecklist}
                  disabled={currentSessionIsWorking}
                  className="btn-primary !text-xs !py-1.5"
                >
                  Start
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  function renderIntegrationSetupAssistantCard() {
    if (!integrationSetup) return null;
    const setup = integrationSetup;
    const RequirementLogo = INTEGRATION_LOGOS[setup.requirement.provider] || Puzzle;

    return (
      <div className="flex justify-start">
        <div className="max-w-[85%] sm:max-w-[72%]">
          <div className="px-4 py-3 rounded-2xl bg-[var(--bg-tertiary)] text-[var(--text-primary)] border border-[var(--glass-border-subtle)]">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2">
                <img src={entropicLogo} alt="Entropic" className="w-5 h-5 rounded-md" />
                <span className="text-xs font-semibold text-[var(--text-primary)]">Agent setup flow</span>
              </div>
              <button
                onClick={() => {
                  if (!currentSession) return;
                  setIntegrationSetupForSession(currentSession, null);
                }}
                className="text-xs text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
              >
                Cancel request
              </button>
            </div>

            <div className="flex flex-wrap gap-2 mt-3">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--glass-border-subtle)] bg-[var(--glass-bg)] px-2 py-1 text-[11px] text-[var(--text-secondary)]">
                <RequirementLogo className="w-3.5 h-3.5 text-[var(--text-primary)]" />
                Plugin: {integrationRequirementLabel(setup.requirement)}
              </span>
            </div>

            <p className="text-sm font-semibold text-[var(--text-primary)] mt-3">
              Connect {integrationRequirementLabel(setup.requirement)} in chat
            </p>
            <p className="text-xs text-[var(--text-secondary)] mt-1">
              "{setup.pendingAction.label}" requires {integrationRequirementLabel(setup.requirement)}.
              Complete setup below and I will continue this flow in chat.
            </p>

            <ol className="mt-2 text-[11px] text-[var(--text-tertiary)] space-y-1 list-decimal list-inside">
              <li>Click Connect now.</li>
              <li>Complete authorization in your browser.</li>
              <li>Return here and click Verify connection.</li>
            </ol>

            {setup.error ? <p className="text-xs text-red-500 mt-2">{setup.error}</p> : null}

            <div className="flex flex-wrap gap-2 mt-3">
              <button
                onClick={connectIntegrationInChat}
                disabled={setup.status === "connecting"}
                className="btn-primary !text-xs !py-1.5"
              >
                {setup.status === "connecting" ? "Connecting..." : "Connect now"}
              </button>
              <button
                onClick={verifyPendingIntegrationSetup}
                disabled={setup.status === "connecting"}
                className="btn-secondary !text-xs !py-1.5"
              >
                Verify connection
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  function renderIntegrationLaunchAssistantCard() {
    if (!integrationLaunch || !currentSession) return null;
    const selected = HOME_PRIMARY_INTEGRATIONS.find((item) => item.provider === integrationLaunch.provider);
    const Logo = selected?.Logo ?? Puzzle;

    return (
      <div className="flex justify-start">
        <div className="max-w-[85%] sm:max-w-[72%]">
          <div className="px-4 py-3 rounded-2xl bg-[var(--bg-tertiary)] text-[var(--text-primary)] border border-[var(--glass-border-subtle)]">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2">
                <Logo className="h-5 w-5 object-contain" />
                <span className="text-xs font-semibold text-[var(--text-primary)]">
                  {integrationLaunch.name}
                </span>
              </div>
              <button
                type="button"
                onClick={() => cancelIntegrationLaunch(currentSession)}
                className="text-xs text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
              >
                Cancel
              </button>
            </div>

            {integrationLaunch.status === "ready" ? (
              <>
                <p className="mt-3 text-sm font-semibold text-[var(--text-primary)]">
                  What do you want to do with {integrationLaunch.name}?
                </p>
                <p className="mt-1 text-xs text-[var(--text-secondary)]">
                  Send your next message and I will use {integrationLaunch.name} for it.
                </p>
              </>
            ) : integrationLaunch.status === "selecting_access" ? (
              <>
                <p className="mt-3 text-sm font-semibold text-[var(--text-primary)]">
                  Choose access for {integrationLaunch.name}
                </p>
                <div className="mt-3 grid gap-2">
                  {(integrationLaunch.permissionProfiles ?? []).map((profile) => (
                    <button
                      key={profile.id}
                      type="button"
                      onClick={() => {
                        if (!selected || !currentSession) return;
                        void connectHomeIntegration(currentSession, selected, profile.id);
                      }}
                      className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] px-3 py-2 text-left transition-colors hover:border-[var(--purple-accent)]/35 hover:bg-[var(--bg-secondary)]"
                    >
                      <span className="block text-xs font-semibold text-[var(--text-primary)]">
                        {profile.name}
                      </span>
                      <span className="mt-0.5 block text-[11px] leading-snug text-[var(--text-secondary)]">
                        {profile.description}
                      </span>
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <>
                <p className="mt-3 text-sm font-semibold text-[var(--text-primary)]">
                  Connecting {integrationLaunch.name}
                </p>
                <p className="mt-1 text-xs text-[var(--text-secondary)]">
                  {integrationLaunch.error || "Complete authorization in your browser, then come back here."}
                </p>
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  function renderQuickSuggestionAssistantCard() {
    if (!quickSuggestion) return null;
    const quick = quickSuggestion;
    const requirement = quick.action.requirement?.kind === "integration" ? quick.action.requirement : null;
    const RequirementLogo = requirement ? INTEGRATION_LOGOS[requirement.provider] : null;

    return (
      <div className="flex justify-start">
        <div className="max-w-[85%] sm:max-w-[72%]">
          <div className="px-4 py-3 rounded-2xl bg-[var(--bg-tertiary)] text-[var(--text-primary)] border border-[var(--glass-border-subtle)]">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2">
                <img src={entropicLogo} alt="Entropic" className="w-5 h-5 rounded-md" />
                <span className="text-xs font-semibold text-[var(--text-primary)]">Agent action ready</span>
              </div>
              <button
                onClick={() => {
                  if (!currentSession) return;
                  setQuickSuggestionForSession(currentSession, null);
                }}
                className="text-xs text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
              >
                Close
              </button>
            </div>

            <div className="flex flex-wrap gap-2 mt-3">
              {RequirementLogo && requirement ? (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--glass-border-subtle)] bg-[var(--glass-bg)] px-2 py-1 text-[11px] text-[var(--text-secondary)]">
                  <RequirementLogo className="w-3.5 h-3.5 text-[var(--text-primary)]" />
                  Plugin: {integrationRequirementLabel(requirement)}
                </span>
              ) : null}
              <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--glass-border-subtle)] bg-[var(--glass-bg)] px-2 py-1 text-[11px] text-[var(--text-secondary)]">
                <Calendar className="w-3.5 h-3.5 text-[var(--text-primary)]" />
                Job schedule: {getTaskPresetLabel(quick.taskPreset)}
              </span>
            </div>

            <p className="text-sm font-semibold text-[var(--text-primary)] mt-3">
              {quick.action.label}
            </p>
            <p className="text-xs text-[var(--text-secondary)] mt-1">
              Run this now in chat, or create a recurring job.
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-3">
              <input
                value={quick.taskName}
                onChange={(e) =>
                  currentSession
                    ? setQuickSuggestionForSession(currentSession, {
                        ...quick,
                        taskName: e.target.value,
                        error: null,
                      })
                    : undefined
                }
                placeholder="Job name"
                className="form-input !py-2"
              />
              <select
                value={quick.taskPreset}
                onChange={(e) =>
                  currentSession
                    ? setQuickSuggestionForSession(currentSession, {
                        ...quick,
                        taskPreset: (e.target.value as SuggestionTaskPreset) || "daily",
                        error: null,
                      })
                    : undefined
                }
                className="form-input !py-2"
              >
                <option value="daily">Daily at 9:00</option>
                <option value="daily_10am">Daily at 10:00</option>
                <option value="weekdays">Weekdays at 9:00</option>
                <option value="hourly">Every hour</option>
              </select>
            </div>

            {quick.error ? <p className="text-xs text-red-500 mt-2">{quick.error}</p> : null}

            <div className="flex flex-wrap gap-2 mt-3">
              <button
                onClick={runQuickSuggestionNow}
                disabled={currentSessionIsWorking || quick.creatingTask}
                className="btn-primary !text-xs !py-1.5"
              >
                Run once in chat
              </button>
              <button
                onClick={createQuickSuggestionTask}
                disabled={quick.creatingTask}
                className="btn-secondary !text-xs !py-1.5"
              >
                {quick.creatingTask
                  ? "Creating job..."
                  : `Create job (${getTaskPresetLabel(quick.taskPreset)})`}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  async function handleSuggestionClick(action: SuggestionAction) {
    setError(null);
    if (action.type !== "quick_action") return;
    const quickAction = getQuickActionById(action.actionId);
    if (!quickAction) return;
    const sessionKey = currentSessionRef.current || ensureComposerSession();
    if (!sessionKey) return;

    if (quickAction.handoffPage && onNavigate) {
      setBuilderChecklistForSession(sessionKey, null);
      setQuickSuggestionForSession(sessionKey, null);
      setIntegrationSetupForSession(sessionKey, null);
      onNavigate(quickAction.handoffPage);
      if (quickAction.handoffPage === "channels") {
        appendAssistantNotice("Open Messaging to set up Telegram, then come back here to run it in chat.", sessionKey);
      } else if (
        quickAction.handoffPage === "store" ||
        quickAction.handoffPage === "integrations"
      ) {
        appendAssistantNotice("Open Integrations to connect this integration, then return to run it in chat.", sessionKey);
      }
      return;
    }

    if (quickAction.kind === "telegram_setup") {
      setBuilderChecklistForSession(sessionKey, null);
      setQuickSuggestionForSession(sessionKey, null);
      setIntegrationSetupForSession(sessionKey, null);
      setTelegramSetupOpen(true);
      return;
    }

    const requirement = quickAction.requirement;
    if (requirement?.kind === "integration") {
      try {
        const connectedNow = await isIntegrationReady(requirement.provider);
        if (!connectedNow) {
          addDiag(`suggestion requires ${requirement.provider}; opening in-chat setup`);
          setIntegrationSetupForSession(sessionKey, {
            requirement,
            pendingAction: quickAction,
            status: "idle",
            error: null,
          });
          setQuickSuggestionForSession(sessionKey, null);
          setBuilderChecklistForSession(sessionKey, null);
          appendAssistantNotice(
            `To run "${quickAction.label}", connect ${integrationRequirementLabel(requirement)} in chat. I will continue once it is connected.`,
            sessionKey
          );
          return;
        }
      } catch {
        setIntegrationSetupForSession(sessionKey, {
          requirement,
          pendingAction: quickAction,
          status: "idle",
          error: `Failed to check ${integrationRequirementLabel(requirement)} status.`,
        });
        setQuickSuggestionForSession(sessionKey, null);
        setBuilderChecklistForSession(sessionKey, null);
        return;
      }
    }

    if (quickAction.runMode === "direct_send") {
      if (isBuilderQuickAction(quickAction)) {
        openBuilderChecklist(quickAction, sessionKey);
        return;
      }
      setIntegrationSetupForSession(sessionKey, null);
      setQuickSuggestionForSession(sessionKey, null);
      setBuilderChecklistForSession(sessionKey, null);
      setShowWelcome(false);
      const payload = resolveQuickActionMessage(quickAction);
      void handleSend(payload);
      return;
    }

    openQuickSuggestion(quickAction, sessionKey);
  }

  useEffect(() => {
    if (!integrationSetup) return;
    const onIntegrationUpdated = () => {
      void verifyPendingIntegrationSetup();
    };
    window.addEventListener("entropic-integration-updated", onIntegrationUpdated);
    return () => {
      window.removeEventListener("entropic-integration-updated", onIntegrationUpdated);
    };
  }, [integrationSetup]);

  function handleTelegramSetupComplete() {
    setTelegramSetupOpen(false);
    setChannelConfig((prev) => ({
      telegramEnabled: true,
      telegramConnected: true,
    }));
    appendAssistantNotice("Telegram messaging is connected and ready in chat.");
  }

  type AssistantRenderPayload = ReturnType<typeof parseToolPayloads>;

  async function handoffWorkspacePathToDesktop(link: {
    path: string;
    action: DesktopHandoff["action"];
    looksLikeFile: boolean;
    url?: string;
  }) {
    const normalizedPath =
      typeof link.path === "string" && link.path
        ? normalizeChatWorkspacePath(link.path) ?? link.path
        : link.path;
    const payload: DesktopHandoff = {
      path: normalizedPath,
      url: link.url,
      action: link.action,
      looksLikeFile: link.looksLikeFile,
    };
    try {
      window.localStorage.setItem(DESKTOP_HANDOFF_STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // Ignore storage failures and still navigate.
    }
    window.dispatchEvent(new CustomEvent(DESKTOP_HANDOFF_EVENT, { detail: payload }));
    onNavigate?.("files");
  }

  async function openChatLinkInBrowser(url: string) {
    clientLog("chat.link.open_requested", { url, hasDirectBrowserHandler: Boolean(onBrowserLinkClick) });
    if (onBrowserLinkClick) {
      await onBrowserLinkClick(url);
      return;
    }
    await handoffWorkspacePathToDesktop({
      path: "",
      action: "browser",
      looksLikeFile: false,
      url,
    });
  }

  type OneDriveDownloadResponse = {
    content_base64?: string | null;
    too_large?: boolean;
    max_bytes?: number;
    size_bytes?: number | null;
    item?: {
      id?: string | null;
      name?: string | null;
    };
  };

  type OneDriveSearchResponse = {
    items?: Array<{
      id?: string | null;
      name?: string | null;
      file?: unknown;
    }>;
  };

  async function executeOneDriveAction<T>(action: string, params: Record<string, unknown>): Promise<T> {
    return apiRequest<T>("/integrations/onedrive/execute", {
      method: "POST",
      body: JSON.stringify({ action, params }),
    });
  }

  async function downloadOneDriveOfficeFile(ref: WorkspaceChatReference): Promise<void> {
    if (ref.cloudSource?.provider !== "onedrive") return;
    const maxBytes = 20 * 1024 * 1024;
    let download: OneDriveDownloadResponse | null = null;
    try {
      download = await executeOneDriveAction<OneDriveDownloadResponse>("download_item", {
        path: ref.cloudSource.itemPath || ref.name,
        maxBytes,
      });
    } catch (pathError) {
      const search = await executeOneDriveAction<OneDriveSearchResponse>("search_items", {
        query: ref.name,
        limit: 10,
      });
      const match = search.items?.find((item) => item.file && item.name === ref.name) ??
        search.items?.find((item) => item.file && item.name?.toLowerCase() === ref.name.toLowerCase());
      if (!match?.id) {
        throw pathError;
      }
      download = await executeOneDriveAction<OneDriveDownloadResponse>("download_item", {
        itemId: match.id,
        maxBytes,
      });
    }

    if (!download?.content_base64) {
      if (download?.too_large) {
        const sizeMb = download.size_bytes ? (download.size_bytes / (1024 * 1024)).toFixed(1) : null;
        const maxMb = download.max_bytes ? Math.round(download.max_bytes / (1024 * 1024)) : 20;
        throw new Error(
          `OneDrive file is too large to open locally${sizeMb ? ` (${sizeMb} MB)` : ""}. Limit is ${maxMb} MB.`
        );
      }
      throw new Error("OneDrive did not return downloadable file content.");
    }

    await invoke("upload_workspace_file", {
      fileName: download.item?.name || ref.name,
      base64: download.content_base64,
      destPath: "",
    });
  }

  async function openOfficeReference(ref: WorkspaceChatReference) {
    setOpeningOfficeFileKey(ref.key);
    setError(null);
    try {
      if (ref.cloudSource?.provider === "onedrive") {
        await downloadOneDriveOfficeFile(ref);
      }
      await handoffWorkspacePathToDesktop({
        path: ref.path,
        action: "open",
        looksLikeFile: true,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(`Failed to open ${ref.name}: ${message}`);
      clientLog("office.open_from_chat.failed", {
        path: ref.path,
        provider: ref.cloudSource?.provider ?? "workspace",
        error: message,
      });
    } finally {
      setOpeningOfficeFileKey((current) => current === ref.key ? null : current);
    }
  }

  function renderOfficeWorkspaceOpenCards(content: string) {
    const seenOfficePaths = new Set<string>();
    const officeRefs = extractWorkspaceChatReferences(content)
      .map((ref) => ({ ref, meta: officeWorkspaceFileMeta(ref.path) }))
      .filter((item): item is { ref: WorkspaceChatReference; meta: NonNullable<ReturnType<typeof officeWorkspaceFileMeta>> } =>
        Boolean(item.meta)
      )
      .filter(({ ref }) => {
        if (seenOfficePaths.has(ref.path)) return false;
        seenOfficePaths.add(ref.path);
        return true;
      });
    if (officeRefs.length === 0) return null;

    return (
      <div className="mt-3 space-y-2">
        <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-tertiary)]/55 px-3 py-2 text-xs text-[var(--text-secondary)]">
          Word, Excel, and PowerPoint files open directly in OnlyOffice. Click a file card below.
        </div>
        {officeRefs.map(({ ref, meta }) => {
          const Icon = meta.Icon;
          const isOpening = openingOfficeFileKey === ref.key;
          const opensFromOneDrive = ref.cloudSource?.provider === "onedrive";
          return (
            <button
              type="button"
              key={`office-open-${ref.key}`}
              onClick={() => {
                void openOfficeReference(ref);
              }}
              disabled={isOpening}
              className="group flex w-full min-w-0 cursor-pointer items-center gap-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-tertiary)]/75 px-3 py-3 text-left shadow-sm transition-all hover:-translate-y-px hover:border-[var(--purple-accent)]/35 hover:bg-[var(--bg-card)] hover:shadow-md focus:outline-none focus:ring-2 focus:ring-[var(--purple-accent)]/20"
              title={`Open ${ref.name} in OnlyOffice`}
              aria-label={`Open ${ref.name} in OnlyOffice`}
            >
              <div
                className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-[var(--bg-card)] shadow-sm ring-1 ring-black/5"
                style={{ color: meta.accent }}
                aria-hidden="true"
              >
                <Icon className="h-7 w-7" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold text-[var(--text-primary)]" title={ref.name}>
                  {ref.name}
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-[var(--text-secondary)]">
                  <span>{meta.label}</span>
                  <span className="text-[var(--text-tertiary)]">
                    {opensFromOneDrive ? `Downloads from OneDrive, then opens in OnlyOffice ${meta.appLabel}` : `Opens in OnlyOffice ${meta.appLabel}`}
                  </span>
                </div>
              </div>
              <span className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-[var(--text-primary)] px-3 py-2 text-xs font-semibold text-[var(--bg-primary)] shadow-sm transition-transform group-hover:-translate-y-px">
                {isOpening ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Icon className="h-3.5 w-3.5" />}
                <span>{isOpening ? "Opening..." : "Open in OnlyOffice"}</span>
              </span>
            </button>
          );
        })}
      </div>
    );
  }

  async function saveGeneratedImageToWorkspace(
    message: Message,
    attachment: MessageAttachment,
    index: number,
  ) {
    if (!attachment.previewUrl) return;
    const previewBase64 = extractBase64FromDataUrl(attachment.previewUrl);
    if (!previewBase64) {
      setError(
        getGeneratedImageWorkspaceSaveUnsupportedReason(attachment) ??
          "Failed to save image to workspace.",
      );
      return;
    }
    const actionKey = imageAttachmentActionKey(message.id, index);
    const existingPath = savedWorkspaceImagePaths[actionKey];
    if (existingPath) {
      await handoffWorkspacePathToDesktop({
        path: existingPath,
        action: "open",
        looksLikeFile: true,
      });
      return;
    }

    const fileName = buildWorkspaceImageFileName(attachment.fileName, attachment.mimeType);
    const workspacePath = `${GENERATED_IMAGES_DEST_PATH}/${fileName}`;
    setSavingWorkspaceImageKeys((prev) => ({ ...prev, [actionKey]: true }));
    try {
      await invoke("upload_workspace_file", {
        fileName,
        base64: previewBase64,
        destPath: GENERATED_IMAGES_DEST_PATH,
      });
      setSavedWorkspaceImagePaths((prev) => ({ ...prev, [actionKey]: workspacePath }));
      setError(null);
    } catch (e) {
      setError(formatUnknownUiError(e, "Failed to save image to workspace."));
    } finally {
      setSavingWorkspaceImageKeys((prev) => {
        const next = { ...prev };
        delete next[actionKey];
        return next;
      });
    }
  }

  function renderTerminalResult(message: Message) {
    const result = message.terminalResult;
    if (!result) return null;
    const combined = [result.stdout.trimEnd(), result.stderr.trimEnd()].filter(Boolean).join("\n");
    return (
      <div className="min-w-0 rounded-xl border border-[var(--glass-border-subtle)] bg-[var(--bg-secondary)]/90 p-3 shadow-sm">
        <div className="flex items-center justify-between gap-3 text-[11px] text-[var(--text-tertiary)]">
          <div className="flex items-center gap-2">
            <Terminal className="w-3.5 h-3.5" />
            <span className="font-medium text-[var(--text-primary)]">/run</span>
            <span className="truncate">{result.cwd}</span>
          </div>
          <span className={clsx(
            "rounded-full px-2 py-0.5 font-medium",
            result.exitCode === 0
              ? "bg-emerald-500/10 text-emerald-500"
              : "bg-red-500/10 text-red-500"
          )}>
            exit {result.exitCode ?? "?"}
          </span>
        </div>
        <pre className="mt-2 overflow-x-auto rounded-lg bg-[#0b1020] px-3 py-2 text-[12px] leading-6 text-slate-100">
          <span className="text-emerald-300">$ {result.command}</span>
          {combined ? `\n${combined}` : "\n"}
        </pre>
      </div>
    );
  }

  function renderToolActivityList(activities: ChatToolActivity[]) {
    if (activities.length === 0) return null;
    const ordered = [...activities].sort((a, b) => b.seq - a.seq);
    const hasRunning = ordered.some((activity) => activity.status === "running");
    const completeCount = ordered.filter((activity) => activity.status === "complete").length;
    const failedCount = ordered.filter((activity) => activity.status === "error").length;
    const runningCount = ordered.filter((activity) => activity.status === "running").length;

    const statusText = (activity: ChatToolActivity) => {
      if (activity.status === "error") return "Failed";
      if (activity.status === "complete") return "Success";
      if (isWebSearchToolName(activity.name)) return "Searching";
      if (isWebFetchToolName(activity.name)) return "Reading";
      return "Running";
    };
    const displayLabel = (activity: ChatToolActivity) => {
      if (isWebSearchToolName(activity.name)) return "Web search";
      if (isWebFetchToolName(activity.name)) return "Web page";
      return activity.label;
    };
    const summaryText = (activity: ChatToolActivity) => {
      if (isWebSearchToolName(activity.name)) {
        return activity.query ? activity.query : activity.resultSummary ?? activity.detail ?? "Searching the web";
      }
      if (isWebFetchToolName(activity.name)) {
        return activity.url ? domainFromUrl(activity.url) ?? activity.url : activity.detail ?? "Reading web page";
      }
      return activity.resultSummary ?? activity.detail ?? "";
    };
    const renderStatusIcon = (activity: ChatToolActivity) => {
      if (activity.status === "error") return <X className="h-3.5 w-3.5" />;
      if (activity.status === "complete") return <Check className="h-3.5 w-3.5" />;
      return <Loader2 className="h-3.5 w-3.5 animate-spin" />;
    };
    const headerMeta =
      failedCount > 0
        ? `${failedCount} failed`
        : hasRunning
          ? `${runningCount} running`
          : `${completeCount} succeeded`;
    const headerIcon =
      failedCount > 0
        ? <X className="h-3.5 w-3.5 text-red-500" />
        : hasRunning
          ? <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--text-tertiary)]" />
          : <Check className="h-3.5 w-3.5 text-emerald-500" />;

    return (
      <details className="group text-xs text-[var(--text-secondary)]" open={hasRunning}>
        <summary className="flex cursor-pointer list-none items-center gap-2 py-1 [&::-webkit-details-marker]:hidden">
          <span className="shrink-0">{headerIcon}</span>
          <span className="shrink-0 font-medium text-[var(--text-primary)]">Tool calls</span>
          <span className="shrink-0 text-[var(--text-tertiary)]">{headerMeta}</span>
          <ChevronDown className="ml-auto h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-180" />
        </summary>
        <div className="mt-1 space-y-1 pl-5">
          {ordered.map((activity) => {
            const summary = summaryText(activity);
            const firstLink = activity.links?.[0] ?? (activity.url ? { url: activity.url } : undefined);
            const linkLabel = firstLink?.domain ?? domainFromUrl(firstLink?.url) ?? firstLink?.url;
            return (
              <div key={activity.id} className="flex min-w-0 items-center gap-2">
                <span className="shrink-0">{renderStatusIcon(activity)}</span>
                <span className="shrink-0 text-[var(--text-primary)]">{displayLabel(activity)}</span>
                <span className="shrink-0 text-[var(--text-tertiary)]">{statusText(activity)}</span>
                {summary ? (
                  <span className="min-w-0 truncate text-[var(--text-tertiary)]">{summary}</span>
                ) : null}
                {firstLink?.url && linkLabel ? (
                  <a
                    href={firstLink.url}
                    target="_blank"
                    rel="noreferrer"
                    className="ml-auto inline-flex min-w-0 shrink items-center gap-1 text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                    title={firstLink.url}
                  >
                    <Globe className="h-3 w-3 shrink-0" />
                    <span className="truncate">{linkLabel}</span>
                  </a>
                ) : null}
              </div>
            );
          })}
        </div>
      </details>
    );
  }

  function renderMessageAttachments(message: Message) {
    const attachments = (message.attachments || []).filter(
      (attachment) => attachment.previewUrl || attachment.omitted,
    );
    if (attachments.length === 0) {
      return null;
    }
    return (
      <div className="mb-2 grid gap-2">
        {attachments.map((attachment, index) => {
          const actionKey = imageAttachmentActionKey(message.id, index);
          const savedPath = savedWorkspaceImagePaths[actionKey];
          const saveUnsupportedReason = getGeneratedImageWorkspaceSaveUnsupportedReason(attachment);
          const isImage = attachment.mimeType.startsWith("image/");
          const isAudio = attachment.mimeType.startsWith("audio/");
          const canSaveToWorkspace = isImage && !saveUnsupportedReason;
          return (
            <div
              key={actionKey}
              className="overflow-hidden rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-tertiary)]"
            >
              {isImage ? (
                <img
                  src={attachment.previewUrl}
                  alt={attachment.fileName}
                  className="block h-auto max-h-[360px] w-full object-contain"
                />
              ) : isAudio ? (
                attachment.previewUrl ? (
                  <div className="px-3 pt-3">
                    <audio src={attachment.previewUrl} controls className="w-full" />
                  </div>
                ) : (
                  <div className="flex items-center gap-2 px-3 pt-3 text-sm text-[var(--text-secondary)]">
                    <Music2 className="h-4 w-4" />
                    <span>Audio available only in the live reply</span>
                  </div>
                )
              ) : (
                <div className="flex items-center gap-2 px-3 pt-3 text-sm text-[var(--text-secondary)]">
                  <FileText className="h-4 w-4" />
                  <span>{attachmentKindLabel(attachment.mimeType)}</span>
                </div>
              )}
              <div className="flex items-center justify-between gap-3 px-3 py-2 text-xs text-[var(--text-secondary)]">
                <span className="min-w-0 truncate">
                  {attachment.fileName}
                  {attachment.byteLength ? ` · ${formatBytes(attachment.byteLength)}` : ""}
                </span>
                {message.role === "assistant" && attachment.mimeType.startsWith("image/") ? (
                  <button
                    type="button"
                    onClick={() => {
                      void saveGeneratedImageToWorkspace(message, attachment, index);
                    }}
                    disabled={Boolean(savingWorkspaceImageKeys[actionKey]) || !canSaveToWorkspace}
                    className="inline-flex shrink-0 items-center gap-1 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-secondary)] px-2 py-1 text-[11px] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--system-gray-6)] disabled:cursor-not-allowed disabled:opacity-60"
                    title={
                      savedPath
                        ? `/data/workspace/${savedPath}`
                        : canSaveToWorkspace
                          ? "Save image to /data/workspace/generated-images"
                          : saveUnsupportedReason ?? undefined
                    }
                  >
                    {savingWorkspaceImageKeys[actionKey] ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Download className="h-3.5 w-3.5" />
                    )}
                    <span>
                      {savedPath
                        ? "Open in Workspace"
                        : canSaveToWorkspace
                          ? "Save to Workspace"
                          : "Save unavailable"}
                    </span>
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  function renderAssistantContent(message: Message, precomputedPayload?: AssistantRenderPayload) {
    if (message.kind === "toolResult" && message.toolName === "/run" && message.terminalResult) {
      return renderTerminalResult(message);
    }
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
    const liveActivities = message.id ? toolActivityByRunId[message.id] ?? [] : [];
    const payloadActivities: ChatToolActivity[] = [
      ...payload.errors.map((error, idx) => ({
        id: `payload-error-${idx}-${error.tool || "tool"}`,
        name: error.tool || "tool",
        label: humanizeToolName(error.tool || "Tool"),
        status: "error" as const,
        detail: compactToolText(error.error) ?? compactToolText(error.status),
        seq: 10_000 + idx,
        ts: Date.now(),
      })),
      ...(payload.hadToolPayload && liveActivities.length === 0 && payload.events.length === 0 && payload.errors.length === 0
        ? [{
            id: "payload-tool-output",
            name: message.toolName || "tool",
            label: humanizeToolName(message.toolName || "Tool"),
            status: "complete" as const,
            detail: "Tool output used",
            seq: 10_500,
            ts: Date.now(),
          }]
        : []),
      ...(payload.events.length > 0
        ? [{
            id: "payload-calendar-events",
            name: "calendar",
            label: "Calendar",
            status: "complete" as const,
            detail: `${payload.events.length} event${payload.events.length === 1 ? "" : "s"} returned`,
            seq: 11_000,
            ts: Date.now(),
          }]
        : []),
    ];
    const activities = [...liveActivities, ...payloadActivities];
    const approvalCommand = payload.cleanText ? extractApprovalCommand(payload.cleanText) : null;
    return (
      <div className="min-w-0 max-w-full space-y-3">
        {renderToolActivityList(activities)}
        {payload.cleanText ? (
          <div>
            {renderMessageAttachments(message)}
            <MarkdownContent
              content={payload.cleanText}
              onWorkspaceLinkClick={(link) => handoffWorkspacePathToDesktop(link)}
              onBrowserLinkClick={(url) => {
                void openChatLinkInBrowser(url);
              }}
            />
            {renderOfficeWorkspaceOpenCards(payload.cleanText)}
            {approvalCommand ? (
              <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-tertiary)]/70 p-3">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-[var(--text-primary)]">Command approval requested</div>
                  <div className="mt-0.5 truncate font-mono text-xs text-[var(--text-tertiary)]" title={approvalCommand}>
                    {approvalCommand}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void approveOperatorCommand(approvalCommand)}
                  disabled={approvalCommandInFlight === approvalCommand}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-black px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-black/85 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {approvalCommandInFlight === approvalCommand ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Check className="h-3.5 w-3.5" />
                  )}
                  <span>{approvalCommandLabel(approvalCommand)}</span>
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
        {!payload.cleanText ? renderMessageAttachments(message) : null}
        {payload.events.length > 0 && (
          <div className="rounded-xl border border-[var(--glass-border-subtle)] bg-[var(--bg-tertiary)]/50 p-3">
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
        <p className="text-[var(--text-secondary)]">
          {gatewayLifecycleLabel || "Connecting to your assistant..."}
        </p>
        <p className="mt-2 text-sm text-[var(--text-tertiary)]">
          Chat will open as soon as the sandbox is ready.
        </p>
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
            ? "w-full max-w-[420px] bg-[var(--bg-card)] rounded-3xl shadow-xl p-10 border border-[var(--border-subtle)]"
            : "bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-2xl shadow-sm p-8 max-w-md"}
          >
            {accountSignInAvailable ? (
              <div className="text-center mb-8">
                <div className="w-20 h-20 rounded-[2rem] bg-transparent mx-auto flex items-center justify-center mb-6">
                  <img src={entropicLogo} alt="Entropic" className="w-20 h-20 rounded-[2rem] shadow-xl" />
                </div>
                <h2 className="text-3xl font-bold text-[var(--text-primary)] mb-3 tracking-tight">Continue with Entropic</h2>
                <p className="text-sm text-[var(--text-secondary)]">
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
                  <div className="rounded-xl border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-500 text-center">
                    {authError}
                  </div>
                ) : null}
                {authNotice ? (
                  <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-500 text-center">
                    {authNotice}
                  </div>
                ) : null}
                <button
                  onClick={() => handleEntropicOAuthSignIn("google")}
                  disabled={authLoading !== null || oauthLoading !== null}
                  className="w-full flex items-center justify-center gap-3 px-4 py-4 bg-[var(--bg-card)] hover:bg-[var(--bg-tertiary)] text-[var(--text-primary)] font-medium rounded-2xl border border-[var(--border-default)] transition-all hover:border-[var(--border-primary)] active:scale-95 duration-200 disabled:opacity-50"
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
                    <div className="w-full border-t border-[var(--border-subtle)]" />
                  </div>
                  <div className="relative flex justify-center text-[10px] uppercase tracking-wider">
                    <span className="bg-[var(--bg-card)] px-2 text-[var(--text-tertiary)]">or</span>
                  </div>
                </div>
                <button
                  onClick={() => {
                    setShowEmailAuth((prev) => !prev);
                    setAuthError(null);
                    setAuthNotice(null);
                  }}
                  disabled={authLoading !== null || oauthLoading !== null}
                  className="w-full flex items-center justify-center gap-3 px-4 py-4 bg-[var(--bg-tertiary)] hover:bg-[var(--bg-secondary)] text-[var(--text-primary)] font-medium rounded-2xl transition-all active:scale-95 duration-200 disabled:opacity-50"
                >
                  <Mail className="w-5 h-5 text-[var(--text-secondary)]" />
                  <span>Continue with Email</span>
                </button>
                {showEmailAuth ? (
                  <form onSubmit={handleEntropicEmailAuthSubmit} className="space-y-3 rounded-2xl bg-[var(--bg-tertiary)] p-4 text-left">
                    <input
                      type="email"
                      value={authEmail}
                      onChange={(event) => setAuthEmail(event.target.value)}
                      placeholder="name@example.com"
                      className="w-full px-4 py-3 rounded-xl bg-[var(--bg-card)] border border-[var(--border-default)] focus:ring-2 focus:ring-[var(--purple-accent-subtle)] focus:outline-none text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] text-sm transition-all"
                      required
                    />
                    <input
                      type="password"
                      value={authPassword}
                      onChange={(event) => setAuthPassword(event.target.value)}
                      placeholder={emailAuthMode === "signup" ? "Create password" : "Password"}
                      className="w-full px-4 py-3 rounded-xl bg-[var(--bg-card)] border border-[var(--border-default)] focus:ring-2 focus:ring-[var(--purple-accent-subtle)] focus:outline-none text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] text-sm transition-all"
                      required
                      minLength={emailAuthMode === "signup" ? 8 : undefined}
                    />
                    <div className="flex items-center gap-2">
                      <button
                        type="submit"
                        disabled={authLoading !== null}
                        className="px-4 py-2.5 rounded-xl bg-[#1A1A2E] hover:opacity-80 text-white text-xs font-semibold transition-all disabled:opacity-50"
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
                        className="text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
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
                ? "w-full mb-2 flex flex-col items-center justify-center gap-0.5 text-[11px] uppercase tracking-[0.16em] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] transition-colors"
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
                    <div className="p-3 rounded-lg bg-[var(--border-subtle)]">
                      <p className="text-sm font-medium text-[var(--text-primary)] mb-1">Paste the code from your browser</p>
                      <p className="text-xs text-[var(--text-tertiary)] mb-3">After authorizing in your browser, copy the code and paste it below.</p>
                      <div className="flex gap-2">
                        <input
                          type="text"
                          value={anthropicCodeInput}
                          onChange={(e) => setAnthropicCodeInput(e.target.value)}
                          onKeyDown={(e) => { if (e.key === "Enter") submitAnthropicCode(); }}
                          placeholder="Paste code here..."
                          className="flex-1 px-3 py-2 text-sm rounded-lg border border-black/10 bg-[var(--bg-card)] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:ring-1 focus:ring-[var(--purple-accent)]"
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
                      className="w-full flex items-center gap-4 p-3 rounded-lg text-left transition-colors bg-[var(--border-subtle)] hover:bg-[var(--border-default)] disabled:opacity-50"
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
                    className="w-full flex items-center gap-4 p-3 rounded-lg text-left transition-colors bg-[var(--border-subtle)] hover:bg-[var(--border-default)] disabled:opacity-50"
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
                  <div className="flex-1 h-px bg-[var(--border-default)]" />
                  <span className="text-xs text-[var(--text-tertiary)] font-medium">or use an API key</span>
                  <div className="flex-1 h-px bg-[var(--border-default)]" />
                </div>

                <div className="space-y-2">
                  {PROVIDERS.map(p => (
                    <button key={p.id} onClick={() => { setSelectedProvider(p); setShowKeyModal(true); }}
                      className="w-full flex items-center gap-4 p-3 rounded-lg text-left transition-colors hover:bg-[var(--border-subtle)]">
                      <div className="w-9 h-9 rounded-md bg-[var(--border-subtle)] flex items-center justify-center font-semibold text-[var(--text-accent)]">
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

            {TERMS_URL && PRIVACY_URL ? (
              <p className="text-xs text-center text-[var(--text-tertiary)] mt-6 pt-4 border-t border-[var(--border-subtle)] leading-relaxed">
                By continuing, you agree to the{" "}
                <button type="button" onClick={() => open(TERMS_URL)} className="underline text-[var(--text-secondary)] hover:text-[var(--text-secondary)]">Terms of Service</button>
                {" "}and{" "}
                <button type="button" onClick={() => open(PRIVACY_URL)} className="underline text-[var(--text-secondary)] hover:text-[var(--text-secondary)]">Privacy Policy</button>.
              </p>
            ) : null}
          </div>
        </div>
        {showKeyModal && selectedProvider && <ApiKeyModal />}
      </>
    );
  };

  const renderWelcome = () => {
    const userName = onboardingData?.userName || "there";
    const integrationRows = [
      HOME_PRIMARY_INTEGRATIONS.slice(0, 4),
      HOME_PRIMARY_INTEGRATIONS.slice(4, 8),
      HOME_PRIMARY_INTEGRATIONS.slice(8, 12),
    ];

    return (
      <div className="flex h-full flex-col items-center justify-center px-4 py-8 text-center animate-fade-in">
        <h2 className="mb-16 text-2xl font-semibold tracking-tight text-[var(--text-primary)]">
          Hey {userName}
        </h2>
        <div className="flex w-full max-w-[620px] flex-col items-center gap-9">
          {integrationRows.map((row, rowIndex) => (
            <div
              key={`integration-row-${rowIndex}`}
              className="flex w-full items-start justify-center gap-7 sm:gap-11"
            >
              {row.map((integration) => {
                const { name, Logo, size } = integration;
                const large = size === "large";
                const medium = size === "medium";
                return (
                  <button
                    key={name}
                    type="button"
                    onClick={() => {
                      void handleHomeIntegrationClick(integration);
                    }}
                    className="group flex w-[72px] flex-col items-center gap-2 rounded-xl focus:outline-none focus:ring-2 focus:ring-[var(--purple-accent)]/25"
                    aria-label={`Open Integrations to connect ${name}`}
                    title={`Connect ${name}`}
                  >
                    <Logo
                      className={clsx(
                        "object-contain drop-shadow-sm transition-transform duration-200 ease-out group-hover:-translate-y-1 group-hover:scale-105",
                        large
                          ? "h-[46px] w-[46px]"
                          : medium
                            ? "h-[38px] w-[38px]"
                            : "h-[32px] w-[32px]"
                      )}
                    />
                    <span
                      className="max-w-[76px] truncate text-[10px] font-medium leading-none text-[var(--text-primary)] transition-colors group-hover:text-[var(--text-secondary)]"
                    >
                      {name}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    );
  };

  const ApiKeyModal = () => (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50"
      onClick={() => setShowKeyModal(false)}>
      <div className="bg-[var(--bg-card)] p-6 w-full max-w-md m-4 rounded-2xl shadow-xl border border-[var(--border-subtle)]" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-[var(--text-primary)]">Connect {selectedProvider?.name}</h3>
          <button onClick={() => setShowKeyModal(false)} className="p-1 text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"><X className="w-5 h-5" /></button>
        </div>
        <div className="mb-4 p-4 rounded-lg bg-[var(--border-subtle)]">
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
      await refreshGatewayAfterProviderAuthChange();
    } catch (e) {
      console.error("Failed to set API key:", e);
      setError(e instanceof Error ? e.message : typeof e === "string" ? e : "Failed to save API key");
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
      await refreshGatewayAfterProviderAuthChange();
    } catch (e) {
      console.error(`OAuth login failed for ${provider}:`, e);
      setError(e instanceof Error ? e.message : typeof e === "string" ? e : "OAuth login failed");
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
      await refreshGatewayAfterProviderAuthChange();
    } catch (e) {
      console.error("Anthropic OAuth code exchange failed:", e);
      setError(
        e instanceof Error ? e.message : typeof e === "string" ? e : "Failed to exchange authorization code",
      );
    } finally {
      setOauthLoading(null);
    }
  }

  useEffect(() => {
    return () => {
      if (copyResetTimerRef.current) {
        clearTimeout(copyResetTimerRef.current);
      }
    };
  }, []);

  async function copyMessageText(messageId: string, text: string) {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    try {
      await navigator.clipboard.writeText(trimmed);
      setCopiedMessageId(messageId);
      if (copyResetTimerRef.current) {
        clearTimeout(copyResetTimerRef.current);
      }
      copyResetTimerRef.current = setTimeout(() => {
        setCopiedMessageId((current) => (current === messageId ? null : current));
      }, 1500);
    } catch (e) {
      setError(formatUnknownUiError(e, "Failed to copy message."));
    }
  }

  function resolveMessageCopyText(message: Message): string {
    if (message.role === "user") {
      return normalizeUserContent(message.content, message.sentAt).content;
    }
    if (message.kind === "toolResult" && message.toolName === "/run" && message.terminalResult) {
      const result = message.terminalResult;
      return [`$ ${result.command}`, result.stdout.trimEnd(), result.stderr.trimEnd()]
        .filter(Boolean)
        .join("\n")
        .trim();
    }
    const payload = parseToolPayloads(message.content || "");
    return payload.cleanText.trim() || message.content.trim();
  }

  const chatAgentName = sanitizeProfileName(
    agentProfile?.name || onboardingData?.agentName || DEFAULT_AGENT_NAME,
    DEFAULT_AGENT_NAME,
  );
  const chatAgentAvatarUrl = isRenderableAvatarDataUrl(agentProfile?.avatarDataUrl)
    ? agentProfile?.avatarDataUrl.trim()
    : undefined;

  const openAgentProfileSettings = useCallback(() => {
    try {
      window.localStorage.setItem(SETTINGS_PROFILE_REQUEST_KEY, "profile");
    } catch {
      // Best-effort hint for Settings if it mounts after navigation.
    }
    onNavigate?.("settings");
    window.dispatchEvent(new Event(SETTINGS_PROFILE_REQUEST_EVENT));
    requestAnimationFrame(() => {
      window.dispatchEvent(new Event(SETTINGS_PROFILE_REQUEST_EVENT));
    });
  }, [onNavigate]);

  // Memoize the message list so typing in the composer doesn't re-render
  // every message (and re-parse markdown) on each keystroke.
  // These hooks must be before early returns to satisfy Rules of Hooks.
  const renderedMessages = useMemo(() => messages.map(msg => {
    const normalizedUser = msg.role === "user" ? normalizeUserContent(msg.content, msg.sentAt) : null;
    const bodyContent = msg.role === "user" ? normalizedUser?.content ?? "" : msg.content;
    const messageTime = formatMessageTime(msg.role === "user" ? normalizedUser?.sentAt : msg.sentAt);
    const copyText = resolveMessageCopyText(msg);
    const canCopy = copyText.trim().length > 0;
    const copyLabel = copiedMessageId === msg.id ? "Copied" : "Copy";
    const copyIcon = copiedMessageId === msg.id ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />;
    if (msg.role === "user" && !bodyContent) {
      return null;
    }
    if (msg.role === "assistant") {
      return (
        <div key={msg.id} className="group flex w-full min-w-0 justify-start py-2">
          <div className="flex w-full min-w-0 items-start gap-3.5">
            <button
              type="button"
              onClick={openAgentProfileSettings}
              className="mt-0.5 shrink-0 self-start rounded-full transition hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-[var(--purple-accent)]/30"
              aria-label={`Edit ${chatAgentName} profile`}
              title={`Edit ${chatAgentName} profile`}
            >
              <AgentAvatar
                name={chatAgentName}
                avatarUrl={chatAgentAvatarUrl}
                className="h-11 w-11 border border-[var(--border-subtle)] transition hover:border-[var(--border-primary)]"
              />
            </button>
            <div className="min-w-0 flex-1 pb-3">
              <div className="mb-2 flex min-w-0 items-center gap-2 text-[12px] text-[var(--text-tertiary)]">
                <button
                  type="button"
                  onClick={openAgentProfileSettings}
                  className="min-w-0 truncate rounded-sm font-normal text-[var(--text-secondary)] transition hover:text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--purple-accent)]/20"
                  title={`Edit ${chatAgentName} profile`}
                >
                  {chatAgentName}
                </button>
              </div>
              <div className="min-w-0 text-[var(--chat-assistant-text)]">
                {renderAssistantContent(msg)}
              </div>
              {messageTime || canCopy ? (
                <div className="mt-1.5 flex items-center gap-2 px-1 text-[11px] text-[var(--text-tertiary)]">
                  {messageTime ? <span>{messageTime}</span> : null}
                  {canCopy ? (
                    <button
                      type="button"
                      onClick={() => {
                        void copyMessageText(msg.id, copyText);
                      }}
                      className="inline-flex h-5 w-5 items-center justify-center text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
                      aria-label={copyLabel}
                      title={copyLabel}
                    >
                      {copyIcon}
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      );
    }
    return (
      <div key={msg.id} className="flex min-w-0 justify-end">
        <div className="min-w-0 max-w-[85%]">
          <div className="rounded-2xl bg-[var(--chat-user-bg)] px-3.5 py-2 text-[var(--chat-user-text)]">
            <div>
              {renderMessageAttachments(msg)}
              <p className="whitespace-pre-wrap break-words">{bodyContent}</p>
            </div>
          </div>
          {messageTime ? (
            <div
              className="mt-0.5 flex items-center gap-2 px-1 text-right text-[11px] text-[var(--text-tertiary)]"
            >
              <span className="ml-auto">{messageTime}</span>
              {canCopy ? (
                <button
                  type="button"
                  onClick={() => {
                    void copyMessageText(msg.id, copyText);
                  }}
                  className="inline-flex h-5 w-5 items-center justify-center text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
                  aria-label={copyLabel}
                  title={copyLabel}
                >
                  {copyIcon}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    );
  }), [chatAgentAvatarUrl, chatAgentName, copiedMessageId, messages, openAgentProfileSettings, toolActivityByRunId]);

  const currentSessionHasQueuedWork = Boolean(
    currentSession && outboxEntries.some((entry) => entry.sessionKey === currentSession)
  );
  const currentSessionIsWorking = Boolean(
    isLoading &&
      currentSession &&
      (activeWorkSessionKey === currentSession ||
        activeRunSessionRef.current === currentSession ||
        currentSessionHasQueuedWork)
  );
  const activeRunBelongsToCurrentSession = Boolean(
    currentSession &&
      activeRunIdRef.current &&
      (activeRunSessionRef.current === currentSession ||
        runSessionKeyRef.current[activeRunIdRef.current] === currentSession)
  );
  const canCancelCurrentWork = Boolean(currentSessionIsWorking && (activeRunBelongsToCurrentSession || currentSessionHasQueuedWork));
  const otherSessionIsWorking = Boolean(
    isLoading &&
      currentSession &&
      activeWorkSessionKey &&
      activeWorkSessionKey !== currentSession
  );

  const loadingIndicator = useMemo(() => {
    if (!currentSessionIsWorking) return null;
    if (activeToolRunId && streamedAssistantRunIdsRef.current.has(activeToolRunId)) {
      return null;
    }
    const loadingWord = THINKING_WORDS[loadingWordIndex % THINKING_WORDS.length] ?? "Thinking";
    const loadingLabel = thinkingStatus || loadingWord;
    const activeToolActivities = activeToolRunId ? toolActivityByRunId[activeToolRunId] ?? [] : [];
    return (
      <div className="flex w-full min-w-0 justify-start py-2">
        <div className="flex w-full min-w-0 items-start gap-3.5">
          <button
            type="button"
            onClick={openAgentProfileSettings}
            className="mt-0.5 shrink-0 self-start rounded-full transition hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-[var(--purple-accent)]/30"
            aria-label={`Edit ${chatAgentName} profile`}
            title={`Edit ${chatAgentName} profile`}
          >
            <AgentAvatar
              name={chatAgentName}
              avatarUrl={chatAgentAvatarUrl}
              className="h-11 w-11 border border-[var(--border-subtle)] transition hover:border-[var(--border-primary)]"
            />
          </button>
          <div className="min-w-0 flex-1 pb-3">
            <div className="mb-2 flex min-w-0 items-center gap-2 text-[12px] text-[var(--text-tertiary)]">
              <button
                type="button"
                onClick={openAgentProfileSettings}
                className="min-w-0 truncate rounded-sm font-normal text-[var(--text-secondary)] transition hover:text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--purple-accent)]/20"
                title={`Edit ${chatAgentName} profile`}
              >
                {chatAgentName}
              </button>
            </div>
            <div className="flex min-w-0 items-center gap-2">
              <span
                key={loadingLabel}
                className="entropic-thinking-shimmer inline-block text-sm font-normal"
                data-changing={loadingWordChanging ? "true" : "false"}
              >
                {loadingLabel}
              </span>
            </div>
            {activeToolActivities.length > 0 ? (
              <div className="mt-3 max-w-xl">
                {renderToolActivityList(activeToolActivities)}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    );
  }, [activeToolRunId, canCancelCurrentWork, cancelInFlight, chatAgentAvatarUrl, chatAgentName, currentSessionIsWorking, loadingWordChanging, loadingWordIndex, messages, openAgentProfileSettings, thinkingStatus, toolActivityByRunId]);

  const activeDraft = currentSession
    ? activeComposerMode === "shell"
      ? shellDraftsBySession[currentSession] || ""
      : activeComposerMode === "image"
        ? imageDraftsBySession[currentSession] || ""
        : draftsBySession[currentSession] || ""
    : "";
  const chatVoiceCaptureActive = liveSpeech.isListening || streamingSpeech.isRecording;
  const chatHasSendableContent = activeDraft.trim().length > 0 || pendingAttachments.length > 0;
  const composerSendDisabled =
    (!activeDraft.trim() &&
      pendingAttachments.length === 0 &&
      !liveSpeech.isListening &&
      !streamingSpeech.isRecording) ||
    currentSessionIsWorking ||
    audioRecorder.isRecording ||
    audioRecorder.isFinalizing ||
    (streamingSpeech.isProcessing && !streamingSpeech.isRecording) ||
    isTranscribing ||
    isGeneratingAudio;
  const chatMicDisabled = currentSessionIsWorking || isTranscribing || isGeneratingAudio;

  useEffect(() => {
    if (!textareaRef.current) return;
    const ta = textareaRef.current;
    ta.style.height = "auto";
    const lineHeight = parseInt(getComputedStyle(ta).lineHeight) || 20;
    const maxHeight = lineHeight * 5;
    ta.style.height = `${Math.min(ta.scrollHeight, maxHeight)}px`;
    ta.style.overflowY = ta.scrollHeight > maxHeight ? "auto" : "hidden";
  }, [activeDraft]);

  useEffect(() => {
    if (activeComposerMode === "shell" && dragActive) {
      setDragActive(false);
    }
  }, [activeComposerMode, dragActive]);

  if (showConnectingScreen) return renderConnecting();
  if (localTrialLoading) return renderConnecting();
  if (!connectedProvider && !proxyEnabled) return renderNoProvider();
  const autoStartExpected = proxyEnabled && !gatewayRunning;
  const showGatewayReconnectBanner =
    gatewayRunning &&
    !connected &&
    Boolean(connectedProvider || proxyEnabled) &&
    !showOutOfCreditsModal;
  const showGatewayWarmupBanner =
    gatewayStarting || autoStartExpected || (!gatewayRunning && !showGatewayOfflineCta);
  const showBillingAction = Boolean(error && isBillingIssueMessage(error));
  const showSignInAction = Boolean(
    error && isBillingIssueMessage(error) && !isAuthenticated && isAuthConfigured
  );

  const hasInlineAssistantCard = Boolean(builderChecklist || integrationSetup || integrationLaunch || quickSuggestion);

  // Main Chat UI
  return (
    <div
      className="h-full min-w-0 overflow-x-hidden flex flex-col bg-transparent"
      onDragOver={(event) => {
        if (activeComposerMode === "shell") return;
        event.preventDefault();
        setDragActive(true);
      }}
      onDragLeave={() => setDragActive(false)}
      onDrop={(event) => {
        if (activeComposerMode === "shell") return;
        event.preventDefault();
        setDragActive(false);
        void addAttachments(event.dataTransfer?.files);
      }}
    >

      {showGatewayWarmupBanner && (
        <div className="p-2 text-center text-sm bg-amber-500/10 text-amber-500">
          {gatewayLifecycleLabel ||
            (gatewayRetryIn
              ? `Gateway reconnecting — retrying in ${gatewayRetryIn}s.`
              : gatewayStarting || autoStartExpected
                ? "Gateway starting…"
                : "Preparing sandbox…")}
        </div>
      )}

      {showGatewayReconnectBanner && (
        <div className="p-2 text-center text-sm bg-amber-500/10 text-amber-500">
          Connecting to your assistant — messages will send as soon as the connection is ready.
        </div>
      )}


      {!gatewayRunning && !gatewayStarting && !autoStartExpected && showGatewayOfflineCta && (
        <div className="p-2 text-center text-sm bg-amber-500/10 text-amber-500 flex items-center justify-center gap-3">
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

      {otherSessionIsWorking && (
        <div className="p-2 text-center text-sm bg-[var(--purple-accent)]/10 text-[var(--text-secondary)]">
          Another chat is still working. You can keep typing here; new messages will queue until it finishes.
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
      <div className="flex-1 overflow-y-auto overflow-x-hidden px-4 pt-3 pb-2">
        <div className={clsx("min-w-0 space-y-3", wideLayout ? "w-full max-w-none" : "mx-auto max-w-3xl")}>
          {messages.length === 0 && showWelcome ? (
            renderWelcome()
          ) : messages.length === 0 && !hasInlineAssistantCard ? (
            <div className="h-full flex items-center justify-center text-center text-[var(--text-tertiary)] animate-fade-in">
              <p className="text-[15px]">Start a conversation</p>
            </div>
          ) : null}
          {renderedMessages}
          {loadingIndicator}
          {renderBuilderChecklistAssistantCard()}
          {renderIntegrationSetupAssistantCard()}
          {renderIntegrationLaunchAssistantCard()}
          {renderQuickSuggestionAssistantCard()}
          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Input Area */}
      <div className="flex-shrink-0 px-4 pb-3 pt-1">
        <div className="min-w-0 w-full space-y-2">
          <input
            ref={fileInputRef}
            type="file"
            accept={activeComposerMode === "image" ? "image/*" : "image/*,audio/*,text/*,.txt,.md,.markdown,.csv,.json,.log"}
            multiple
            className="hidden"
            onChange={(event) => {
              void addAttachments(event.target.files);
              event.currentTarget.value = "";
            }}
          />
          <div className="rounded-[26px] border border-[var(--border-subtle)] bg-[var(--bg-card)] p-2 shadow-[0_12px_36px_rgba(15,23,42,0.12)] transition-colors">
            {pendingAttachments.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-2 px-1 pt-1">
                {pendingAttachments.map((attachment) => {
                  const officeMeta = officeWorkspaceFileMeta(attachment.fileName);
                  return (
                    <div
                      key={attachment.id}
                      className="flex min-w-0 items-center gap-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-tertiary)] px-2 py-1.5"
                    >
                      {renderPendingAttachmentPreview(attachment)}
                      <div className="min-w-0">
                        <div className="max-w-[180px] truncate text-xs text-[var(--text-secondary)]">
                          {attachment.fileName}
                        </div>
                        <div className="text-[10px] uppercase tracking-wide text-[var(--text-tertiary)]">
                          {officeMeta ? `${officeMeta.label} · OnlyOffice ready` : attachmentKindLabel(attachment.mimeType)}
                        </div>
                      </div>
                      <button
                        onClick={() => removePendingAttachment(attachment.id)}
                        className="p-0.5 text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                        aria-label={`Remove ${attachment.fileName}`}
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
            <div className="flex items-end gap-1.5">
              {activeComposerMode !== "shell" ? (
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={currentSessionIsWorking}
                  className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
                  title={activeComposerMode === "image" ? "Attach reference image" : "Attach file"}
                  aria-label={activeComposerMode === "image" ? "Attach reference image" : "Attach file"}
                >
                  <Paperclip className="w-4 h-4" />
                </button>
              ) : null}
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
                  if (activeComposerMode === "shell") {
                    setShellDraftsBySession((prev) => {
                      if ((prev[sessionKey] || "") === nextValue) return prev;
                      return { ...prev, [sessionKey]: nextValue };
                    });
                  } else if (activeComposerMode === "image") {
                    setImageDraftsBySession((prev) => {
                      if ((prev[sessionKey] || "") === nextValue) return prev;
                      return { ...prev, [sessionKey]: nextValue };
                    });
                  } else {
                    setDraftsBySession((prev) => {
                      if ((prev[sessionKey] || "") === nextValue) return prev;
                      return { ...prev, [sessionKey]: nextValue };
                    });
                  }
                  const ta = e.target;
                  ta.style.height = 'auto';
                  const lineHeight = parseInt(getComputedStyle(ta).lineHeight) || 20;
                  const maxHeight = lineHeight * 5;
                  ta.style.height = `${Math.min(ta.scrollHeight, maxHeight)}px`;
                  ta.style.overflowY = ta.scrollHeight > maxHeight ? 'auto' : 'hidden';
                }}
                onKeyDown={e => {if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleComposerSend(); }}}
                placeholder={
                  activeComposerMode === "shell"
                    ? "Run a command in the workspace shell"
                    : activeComposerMode === "image"
                      ? "Describe the image you want to generate"
                      : "Message your assistant"
                }
                rows={1}
                className="chat-composer-textarea min-h-[44px] flex-1 resize-none border-0 bg-transparent px-2 py-2.5 text-[15px] leading-[1.45] text-[var(--text-primary)] outline-none focus:outline-none focus-visible:outline-none placeholder:text-[var(--text-tertiary)]"
                style={{ overflow: 'hidden' }}
              />
              {canCancelCurrentWork ? (
                <button
                  type="button"
                  onClick={() => void cancelCurrentWork()}
                  disabled={cancelInFlight}
                  className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-black text-white shadow-sm transition-all duration-200 ease-out hover:bg-black/85 active:scale-95 disabled:cursor-not-allowed disabled:opacity-60"
                  title={cancelInFlight ? "Stopping" : "Stop response"}
                  aria-label={cancelInFlight ? "Stopping response" : "Stop response"}
                >
                  {cancelInFlight ? <Loader2 className="h-[17px] w-[17px] animate-spin" /> : <Square className="h-[15px] w-[15px] fill-current" />}
                </button>
              ) : activeComposerMode === "chat" ? (
                <>
                  {chatVoiceCaptureActive ? (
                    <button
                      type="button"
                      onClick={stopChatVoiceCapture}
                      className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-red-500 text-white shadow-sm transition-all duration-200 ease-out hover:bg-red-600 active:scale-95"
                      title="Stop recording"
                      aria-label="Stop recording"
                    >
                      <Square className="h-[15px] w-[15px] fill-current" />
                    </button>
                  ) : null}
                  {chatHasSendableContent ? (
                    <button
                      type="button"
                      onClick={handleComposerSend}
                      disabled={composerSendDisabled}
                      className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-[var(--purple-accent)] text-white shadow-[0_10px_26px_rgba(91,36,139,0.26)] transition-all duration-200 ease-out hover:bg-[var(--purple-accent-hover)] hover:shadow-[0_12px_30px_rgba(91,36,139,0.34)] active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
                      title="Send"
                      aria-label="Send"
                    >
                      <Send className="h-[18px] w-[18px]" />
                    </button>
                  ) : !chatVoiceCaptureActive ? (
                    <button
                      type="button"
                      onClick={() => void startChatVoiceCapture()}
                      disabled={chatMicDisabled || !(liveSpeech.isSupported || streamingSpeech.isSupported)}
                      className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl text-[var(--text-primary)] transition-all duration-200 ease-out hover:bg-[var(--bg-tertiary)] active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
                      title={liveSpeech.isSupported || streamingSpeech.isSupported ? "Record" : "Microphone unavailable"}
                      aria-label={liveSpeech.isSupported || streamingSpeech.isSupported ? "Record" : "Microphone unavailable"}
                    >
                      <Mic className="h-[18px] w-[18px]" />
                    </button>
                  ) : null}
                </>
              ) : (
                <button
                  type="button"
                  onClick={handleComposerSend}
                  disabled={composerSendDisabled}
                  className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-[var(--purple-accent)] text-white shadow-sm transition-all duration-200 ease-out hover:bg-[var(--purple-accent-hover)] active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Send className="h-[18px] w-[18px]" />
                </button>
              )}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 px-2 pt-1">
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
                {([
                  { key: "chat", label: "Chat", icon: Bot },
                  { key: "shell", label: "Shell", icon: Terminal },
                  { key: "image", label: "Image", icon: ImageIcon },
                ] as const).map((mode) => {
                  const Icon = mode.icon;
                  const active = activeComposerMode === mode.key;
                  return (
                    <button
                      key={mode.key}
                      type="button"
                      onClick={() => {
                        const sessionKey = currentSession || ensureComposerSession();
                        if (!sessionKey) return;
                        setComposerModeForSession(sessionKey, mode.key);
                        requestAnimationFrame(() => textareaRef.current?.focus());
                      }}
                      className={clsx(
                        "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-colors",
                        active
                          ? "bg-[var(--bg-tertiary)] text-[var(--text-primary)]"
                          : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
                      )}
                      aria-pressed={active}
                    >
                      <Icon className="h-3.5 w-3.5" />
                      <span>{mode.label}</span>
                    </button>
                  );
                })}
              </div>
              {activeComposerMode === "shell" ? (
                <div className="min-w-0 max-w-full text-[11px] text-[var(--text-tertiary)]">
                  <div className="inline-flex min-w-0 max-w-full items-center gap-2 px-1 py-0.5">
                    <Terminal className="h-3.5 w-3.5 shrink-0" />
                    <span className="shrink-0 font-medium text-[var(--text-secondary)]">/run</span>
                    <span
                      className="truncate font-mono text-[var(--text-primary)]"
                      title={activeTerminalState.cwd}
                    >
                      {activeTerminalState.cwd}
                    </span>
                  </div>
                </div>
              ) : activeComposerMode === "image" ? (
                <div className="min-w-0 max-w-full text-[11px] text-[var(--text-tertiary)]">
                  <div className="inline-flex min-w-0 max-w-full items-center gap-2 px-1 py-0.5">
                    <ImageIcon className="h-3.5 w-3.5 shrink-0" />
                    <span className="shrink-0 font-medium text-[var(--text-secondary)]">model</span>
                    <span
                      className="truncate font-mono text-[var(--text-primary)]"
                      title={imageGenerationModel}
                    >
                      {imageGenerationModel}
                    </span>
                  </div>
                </div>
              ) : activeComposerMode === "chat" && hasPendingAudioAttachments ? (
                <div className="flex items-center gap-1 text-[11px] text-[var(--text-tertiary)]">
                  <button
                    type="button"
                    onClick={() => void transcribePendingAudio()}
                    disabled={currentSessionIsWorking || isTranscribing}
                    className="inline-flex items-center gap-1 rounded-md bg-[var(--bg-secondary)] px-2 py-1 text-[11px] font-medium text-[var(--text-primary)] hover:bg-[var(--system-gray-6)] disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {isTranscribing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Music2 className="h-3 w-3" />}
                    <span>Transcribe audio</span>
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        </div>
        {dragActive && activeComposerMode !== "shell" && (
          <div className="absolute inset-0 bg-[var(--border-default)] border-2 border-dashed border-white/50 flex items-center justify-center font-medium text-white">
            Drop files to attach
          </div>
        )}
      </div>

      {/* Out of Credits Modal */}
      {showOutOfCreditsModal && (
        <div
          className="fixed inset-0 bg-black/30 flex items-center justify-center z-50"
          onClick={() => setShowOutOfCreditsModal(false)}
        >
          <div
            className="bg-[var(--bg-card)] w-full max-w-sm m-4 rounded-2xl shadow-xl border border-[var(--border-subtle)] p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-purple-100 flex items-center justify-center">
                  <Sparkles className="w-5 h-5 text-purple-600" />
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-[var(--text-primary)]">Out of credits</h3>
                  <p className="text-sm text-[var(--text-tertiary)]">Add credits to continue</p>
                </div>
              </div>
              <button
                onClick={() => setShowOutOfCreditsModal(false)}
                className="p-1.5 text-[var(--text-tertiary)] hover:text-[var(--text-primary)] rounded-md hover:bg-[var(--border-subtle)]"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <p className="text-sm text-[var(--text-secondary)] mb-5">
              Your agent needs credits to keep running. Add funds to continue your conversation.
            </p>

            <div className="flex flex-col items-center gap-2">
              <button
                onClick={handleQuickAddCredits}
                disabled={creditsCheckoutLoading}
                className="btn btn-primary !bg-[var(--purple-accent)] hover:!bg-purple-700 text-white flex items-center gap-2 mx-auto"
              >
                {creditsCheckoutLoading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  "Add $5 Credits"
                )}
              </button>
              {onNavigate && (
                <button
                  onClick={() => {
                    setShowOutOfCreditsModal(false);
                    onNavigate("billing");
                  }}
                  className="text-xs text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] underline underline-offset-2"
                >
                  Go to billing page
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      <TelegramSetupModal
        isOpen={telegramSetupOpen}
        onClose={() => setTelegramSetupOpen(false)}
        onSetupComplete={handleTelegramSetupComplete}
      />
    </div>
  );
}
