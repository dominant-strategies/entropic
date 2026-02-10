import { useState, useRef, useEffect } from "react";
import { Send, Sparkles, X, Loader2, ExternalLink, Paperclip, MessageSquare, Calendar, Globe, Mail, Activity, TrendingUp, FolderPlus } from "lucide-react";
import { open } from "@tauri-apps/plugin-shell";
import { invoke } from "@tauri-apps/api/core";
import clsx from "clsx";
import { GatewayClient, createGatewayClient, type ChatEvent, type GatewayMessage } from "../lib/gateway";
import { loadOnboardingData, type OnboardingData } from "../lib/profile";
import { SuggestionChip, type SuggestionAction } from "../components/SuggestionChip";
import { ChannelSetupModal } from "../components/ChannelSetupModal";
import { MarkdownContent } from "../components/MarkdownContent";
import { useAuth } from "../contexts/AuthContext";
import { syncAllIntegrationsToGateway, getCachedIntegrationProviders, getIntegrations } from "../lib/integrations";
import type { Page } from "../components/Layout";

// NOTE: Most type definitions are omitted for brevity in this example
type Message = { id: string; role: "user" | "assistant"; content: string; kind?: "toolResult"; toolName?: string };
export type ChatSession = { key: string; label?: string; displayName?: string; derivedTitle?: string; updatedAt?: number | null };
type Provider = { id: string; name: string; icon: string; placeholder: string; keyUrl: string };
type PendingAttachment = { id: string; fileName: string; tempPath: string; savedPath?: string };
type AuthState = { active_provider: string | null; providers: Array<{ id: string; has_key: boolean }> };
type CalendarEvent = { id?: string; summary?: string; start?: string; end?: string; attendees?: Array<{ email?: string; displayName?: string }> };
type ToolError = { tool?: string; error?: string; status?: string };

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

function parseToolPayloads(raw: string): {
  cleanText: string;
  events: CalendarEvent[];
  errors: ToolError[];
} {
  try {
    const direct = JSON.parse(raw);
    if (typeof direct === "string") {
      return parseToolPayloads(direct);
    }
    if (direct && typeof direct === "object") {
      const events = Array.isArray((direct as any).events) ? (direct as any).events as CalendarEvent[] : [];
      const errors = (direct as any).tool || (direct as any).status === "error"
        ? [{ tool: (direct as any).tool, error: (direct as any).error, status: (direct as any).status }]
        : [];
      if (events.length || errors.length) {
        return { cleanText: "", events, errors };
      }
    }
  } catch {
    // ignore
  }

  const blocks = extractJsonBlocks(raw);
  if (blocks.length === 0) {
    return { cleanText: raw, events: [], errors: [] };
  }

  const events: CalendarEvent[] = [];
  const errors: ToolError[] = [];
  const removalRanges: Array<{ start: number; end: number }> = [];

  for (const block of blocks) {
    try {
      const parsed = JSON.parse(block.jsonText);
      if (parsed && typeof parsed === "object") {
        if (Array.isArray((parsed as any).events)) {
          events.push(...(parsed as any).events);
          removalRanges.push({ start: block.start, end: block.end });
          continue;
        }
        if ((parsed as any).tool || (parsed as any).status === "error") {
          errors.push({
            tool: (parsed as any).tool,
            error: (parsed as any).error,
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
    return { cleanText: raw, events: [], errors: [] };
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

  return { cleanText: clean.trim(), events, errors };
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
  if (roleRaw === "user") {
    if (!hasText) return null;
    return { id, role: "user", content: text };
  }
  if (roleRaw === "assistant") {
    if (!hasText && !hasNonText) return null;
    if (!hasText) return null;
    return { id, role: "assistant", content: text };
  }
  if (roleRaw === "toolresult" || roleRaw === "tool_result" || roleRaw === "tool") {
    if (!hasText) return null;
    return {
      id,
      role: "assistant",
      content: text,
      kind: "toolResult",
      toolName: typeof message.toolName === "string" ? message.toolName : undefined,
    };
  }
  return null;
}

const PROVIDERS: Provider[] = [
  { id: "anthropic", name: "Anthropic", icon: "A", placeholder: "sk-ant-...", keyUrl: "https://console.anthropic.com/settings/keys" },
  { id: "openai", name: "OpenAI", icon: "O", placeholder: "sk-...", keyUrl: "https://platform.openai.com/api-keys" },
  { id: "google", name: "Google AI", icon: "G", placeholder: "AIza...", keyUrl: "https://aistudio.google.com/app/apikey" },
];

const DEFAULT_GATEWAY_URL = "ws://127.0.0.1:19789";
const GATEWAY_TOKEN = "nova-local-gateway";
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

export function Chat({
  gatewayRunning,
  gatewayStarting,
  gatewayRetryIn,
  onStartGateway,
  useLocalKeys,
  imageModel: _imageModel,
  integrationsSyncing,
  integrationsMissing,
  onNavigate,
  onSessionsChange,
  requestedSession,
}: {
  gatewayRunning: boolean;
  gatewayStarting: boolean;
  gatewayRetryIn: number | null;
  onStartGateway?: () => void;
  useLocalKeys: boolean;
  imageModel: string;
  integrationsSyncing?: boolean;
  integrationsMissing?: boolean;
  onNavigate?: (page: Page) => void;
  onSessionsChange?: (sessions: ChatSession[], currentKey: string | null) => void;
  requestedSession?: string | null;
}) {
  const { isAuthenticated, isAuthConfigured } = useAuth();
  const proxyEnabled = isAuthConfigured && isAuthenticated && !useLocalKeys;
  const [messages, setMessages] = useState<Message[]>([]);
  const [message, setMessage] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [currentSession, setCurrentSession] = useState<string | null>(null);
  const [showKeyModal, setShowKeyModal] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState<Provider | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [connectedProvider, setConnectedProvider] = useState<string | null>(null);
  const [_providerStatus, setProviderStatus] = useState<AuthState["providers"]>([]);
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
  const [channelConfig, setChannelConfig] = useState<{ imessageEnabled: boolean; whatsappEnabled: boolean } | null>(null);
  const [channelModal, setChannelModal] = useState<{ isOpen: boolean; channel: "imessage" | "whatsapp" }>({
    isOpen: false,
    channel: "imessage",
  });

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const clientRef = useRef<GatewayClient | null>(null);
  const currentSessionRef = useRef<string | null>(null);
  const handlersRef = useRef<{
    connected?: () => void;
    disconnected?: () => void;
    chat?: (event: ChatEvent) => void;
    error?: (error: string) => void;
  }>({});
  const lastEventByRunIdRef = useRef<Record<string, number>>({});
  const lastIntegrationsSyncRef = useRef<number>(0);

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

  function addDiag(message: string) {
    const stamp = new Date().toLocaleTimeString();
    setDiagLogs(prev => {
      const next = [...prev, `${stamp} ${message}`];
      return next.slice(-200);
    });
  }

  // Emit session list to parent (for sidebar rendering)
  useEffect(() => {
    onSessionsChange?.(sessions, currentSession);
  }, [sessions, currentSession]);

  // Handle session selection from sidebar
  useEffect(() => {
    if (!requestedSession || !clientRef.current) return;
    if (requestedSession === "__new__") {
      createNewSession();
    } else if (requestedSession !== currentSession) {
      selectSession(requestedSession);
    }
  }, [requestedSession]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLoading]);

  useEffect(() => {
    currentSessionRef.current = currentSession;
  }, [currentSession]);

  // Load onboarding data for personalized welcome
  useEffect(() => {
    loadOnboardingData().then(setOnboardingData).catch(console.error);
  }, []);

  // Simplified effect for loading initial state
  useEffect(() => {
    invoke<AuthState>("get_auth_state").then(state => {
      setProviderStatus(state.providers);
      setConnectedProvider(state.active_provider || state.providers.find(p => p.has_key)?.id || null);
    }).catch(console.error);
    invoke<string>("get_gateway_ws_url").then(url => url && setGatewayUrl(url)).catch(console.error);
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

  // Simplified connection effect
  useEffect(() => {
    if (gatewayStarting) {
      clientRef.current?.disconnect();
      clientRef.current = null;
      return;
    }
    if (gatewayRunning && (connectedProvider || proxyEnabled) && !clientRef.current) {
      connectToGateway();
    }
    return () => {
      if (clientRef.current) {
        detachGatewayListeners(clientRef.current);
        clientRef.current = null;
      }
    };
  }, [gatewayRunning, gatewayStarting, connectedProvider, proxyEnabled]);

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

  async function connectToGateway() {
    setIsConnecting(true);
    setError(null);
    try {
      addDiag(`connect -> ${gatewayUrl}`);
      const client = createGatewayClient(gatewayUrl, GATEWAY_TOKEN);
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
        setConnected(false);
        addDiag("gateway disconnected");
      };
      const onChat = (event: ChatEvent) => handleChatEvent(event);
      const onError = (err: string) => {
        const suppressError = gatewayStarting || isConnecting || !gatewayRunning;
        if (!suppressError) {
          setError(err);
        }
        setIsConnecting(false);
        setLastGatewayError(err);
        addDiag(`gateway error: ${err}`);
      };
      client.on("connected", onConnected);
      client.on("disconnected", onDisconnected);
      client.on("chat", onChat);
      client.on("error", onError);
      handlersRef.current = { connected: onConnected, disconnected: onDisconnected, chat: onChat, error: onError };
      if (client.isConnected()) {
        onConnected();
      } else {
        await client.connect();
      }
    } catch (e) {
      if (!gatewayStarting) {
        setError(e instanceof Error ? e.message : "Connection failed");
      }
      setIsConnecting(false);
      addDiag(`connect failed: ${e instanceof Error ? e.message : "unknown"}`);
    }
  }

  function detachGatewayListeners(client: GatewayClient) {
    const handlers = handlersRef.current;
    if (handlers.connected) client.off("connected", handlers.connected);
    if (handlers.disconnected) client.off("disconnected", handlers.disconnected);
    if (handlers.chat) client.off("chat", handlers.chat);
    if (handlers.error) client.off("error", handlers.error);
    handlersRef.current = {};
  }

  function handleChatEvent(event: any) {
    setLastChatEvent(event);
    if (event?.runId) {
      lastEventByRunIdRef.current[event.runId] = Date.now();
    }
    if (event?.sessionKey && currentSessionRef.current && event.sessionKey !== currentSessionRef.current) {
      return;
    }
    if (event.state === "delta" || event.state === "final") {
      const normalized = event.message ? normalizeGatewayMessage(event.message as GatewayMessage, event.runId) : null;
      const text = normalized?.content ?? "";
      if (!text) return;
      setMessages(prev => {
        const existingIdx = prev.findIndex(m => m.id === event.runId && m.role === "assistant");
        if (existingIdx >= 0) {
          const updated = [...prev];
          updated[existingIdx] = { ...updated[existingIdx], content: text };
          return updated;
        }
        return [...prev, { id: event.runId, role: "assistant", content: text }];
      });
      if (event.state === "final") setIsLoading(false);
    } else if (event.state === "error") {
      setError(event.errorMessage || "Chat error");
      setIsLoading(false);
      addDiag(`chat error: ${event.errorMessage || "unknown"}`);
    } else if (event.state === "aborted") {
      setIsLoading(false);
      addDiag("chat aborted");
    }
  }

  async function loadSessions() {
    const sessions = await clientRef.current?.listSessions() || [];
    setSessions(sessions);
    if (sessions.length > 0) {
      selectSession(sessions[0].key);
    } else {
      createNewSession();
    }
  }

  async function selectSession(sessionId: string) {
    setCurrentSession(sessionId);
    const history = await clientRef.current?.getChatHistory(sessionId, HISTORY_LIMIT) || [];
    if (currentSessionRef.current && currentSessionRef.current !== sessionId) {
      return;
    }
    const msgs: Message[] = history
      .map((m: any, i: number) => normalizeGatewayMessage(m as GatewayMessage, `h-${i}`))
      .filter((m: Message | null): m is Message => !!m && m.content.trim().length > 0);
    setMessages(msgs);
    if (msgs.length > 0) {
      setShowWelcome(false);
    }
  }

  function createNewSession() {
    const sessionKey = clientRef.current!.createSessionKey();
    setCurrentSession(sessionKey);
    setMessages([]);
    setShowWelcome(true);
  }

  async function handleSend(content?: string) {
    const messageContent = content || message.trim();
    if (!currentSession || !connected || isLoading || (!messageContent && pendingAttachments.length === 0)) return;

    const userMessage: Message = { id: crypto.randomUUID(), role: "user", content: messageContent };
    setMessages(prev => [...prev, userMessage]);
    setMessage("");
    setShowWelcome(false);
    setIsLoading(true);
    setError(null);
    try {
      const now = Date.now();
      if (gatewayRunning && (connectedProvider || proxyEnabled) && now - lastIntegrationsSyncRef.current > 60_000) {
        try {
          const providers = await syncAllIntegrationsToGateway();
          lastIntegrationsSyncRef.current = now;
          addDiag(`integrations synced before send: ${providers.length ? providers.join(", ") : "none"}`);
        } catch (err) {
          addDiag(`integrations sync before send failed: ${String(err)}`);
        }
      }
      addDiag(`send -> session=${currentSession} len=${messageContent.length}`);
      const runId = await clientRef.current?.sendMessage(currentSession, messageContent, []);
      setLastSendId(runId || null);
      setLastSendAt(Date.now());
      if (runId) {
        addDiag(`send ok runId=${runId}`);
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
      addDiag(`send failed: ${e instanceof Error ? e.message : "unknown"}`);
    }
  }

  function sessionTitle(s: ChatSession): string {
    return s.label || s.displayName || s.derivedTitle || `Chat ${s.key.slice(0, 8)}`;
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
        addDiag(`channel ${action.channel} not configured; redirecting to Channels`);
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

  function renderAssistantContent(message: Message) {
    const payload = parseToolPayloads(message.content);
    if (!payload.events.length && !payload.errors.length) {
      return <MarkdownContent content={message.content} />;
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

  const renderNoProvider = () => (
    <>
      <div className="h-full flex flex-col items-center justify-center p-6 text-center">
        <div className="glass-card p-8 max-w-md">
          <Sparkles className="w-10 h-10 mx-auto mb-4 text-[var(--text-accent)]" />
          <h2 className="text-xl font-semibold mb-2 text-[var(--text-primary)]">Connect an AI Service</h2>
          <p className="mb-6 text-[var(--text-secondary)]">Add an API key to start chatting with your assistant.</p>
          <div className="space-y-3">
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
          <p className="text-xs mt-6 text-[var(--text-tertiary)]">Your API keys are stored locally and securely.</p>
        </div>
      </div>
      {showKeyModal && selectedProvider && <ApiKeyModal />}
    </>
  );

  const renderWelcome = () => {
    const userName = onboardingData?.userName || "there";
    const agentName = onboardingData?.agentName || "Nova";
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
        await invoke("restart_gateway");
      } else {
        await invoke("start_gateway");
      }
    } catch (e) {
      console.error("Failed to set API key:", e);
      setError("Failed to save API key");
    }
  }

  if (isConnecting) return renderConnecting();
  if (!connectedProvider && !proxyEnabled) return renderNoProvider();
  const autoStartExpected = proxyEnabled && !gatewayRunning;

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
        <div className="p-2 text-center text-sm bg-red-500/10 text-red-500">{error}</div>
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
          {messages.map(msg => (
            <div key={msg.id} className={clsx("flex", msg.role === "user" ? "justify-end" : "justify-start")}>
              <div className={clsx("max-w-[85%] px-4 py-2.5 rounded-2xl",
                msg.role === "user" ? "bg-[var(--purple-accent)] text-white" : "bg-[var(--bg-tertiary)] text-[var(--text-primary)]")}>
              {msg.role === "assistant" ? renderAssistantContent(msg) : <p className="whitespace-pre-wrap">{msg.content}</p>}
              </div>
            </div>
          ))}
          {isLoading && (
            <div className="flex justify-start">
              <div className="px-4 py-2.5 rounded-2xl bg-[var(--bg-tertiary)]">
                <Loader2 className="w-5 h-5 animate-spin text-[var(--text-tertiary)]" />
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
          <button className="btn-secondary !p-2.5"><Paperclip className="w-5 h-5" /></button>
          <textarea value={message} onChange={e => setMessage(e.target.value)}
            onKeyDown={e => {if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }}}
            placeholder="Message your assistant..." rows={1}
            className="form-input flex-1 resize-none leading-tight"
          />
          <button onClick={() => handleSend()} disabled={!message.trim() || isLoading} className="btn-primary !p-2.5 !bg-[var(--purple-accent)] hover:!bg-purple-700 text-white"><Send className="w-5 h-5" /></button>
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
