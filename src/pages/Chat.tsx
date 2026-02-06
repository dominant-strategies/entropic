import { useState, useRef, useEffect } from "react";
import { Send, Sparkles, X, Loader2, Plus, ExternalLink, Paperclip, MessageSquare, Calendar, Globe, Mail, Activity } from "lucide-react";
import { open } from "@tauri-apps/plugin-shell";
import { invoke } from "@tauri-apps/api/core";
import clsx from "clsx";
import { GatewayClient, createGatewayClient, type ChatEvent } from "../lib/gateway";
import { loadOnboardingData, type OnboardingData } from "../lib/profile";
import { SuggestionChip, type SuggestionAction } from "../components/SuggestionChip";
import { ChannelSetupModal } from "../components/ChannelSetupModal";
import { useAuth } from "../contexts/AuthContext";

// NOTE: Most type definitions are omitted for brevity in this example
type Message = { id: string; role: "user" | "assistant"; content: string };
type Session = { key: string; label?: string; displayName?: string; derivedTitle?: string };
type Provider = { id: string; name: string; icon: string; placeholder: string; keyUrl: string };
type PendingAttachment = { id: string; fileName: string; tempPath: string; savedPath?: string };
type AuthState = { active_provider: string | null; providers: Array<{ id: string; has_key: boolean }> };

const PROVIDERS: Provider[] = [
  { id: "anthropic", name: "Anthropic", icon: "A", placeholder: "sk-ant-...", keyUrl: "https://console.anthropic.com/settings/keys" },
  { id: "openai", name: "OpenAI", icon: "O", placeholder: "sk-...", keyUrl: "https://platform.openai.com/api-keys" },
  { id: "google", name: "Google AI", icon: "G", placeholder: "AIza...", keyUrl: "https://aistudio.google.com/app/apikey" },
];

const DEFAULT_GATEWAY_URL = "ws://127.0.0.1:19789";
const GATEWAY_TOKEN = "nova-local-gateway";

// Suggestion items for the welcome screen
const SUGGESTIONS = [
  { icon: MessageSquare, label: "Message me on iMessage", action: { type: "channel", channel: "imessage" } as SuggestionAction },
  { icon: MessageSquare, label: "Message me on WhatsApp", action: { type: "channel", channel: "whatsapp" } as SuggestionAction },
  { icon: Mail, label: "Clean up my inbox", action: { type: "agent", message: "Help me clean up and organize my email inbox" } as SuggestionAction },
  { icon: Calendar, label: "Check my calendar", action: { type: "agent", message: "What's on my calendar for today and tomorrow?" } as SuggestionAction },
  { icon: Globe, label: "Browse the web for me", action: { type: "agent", message: "I'd like you to browse the web and research something for me." } as SuggestionAction },
];

export function Chat({
  gatewayRunning,
  useLocalKeys,
  codeModel,
  imageModel: _imageModel,
}: {
  gatewayRunning: boolean;
  useLocalKeys: boolean;
  codeModel: string;
  imageModel: string;
}) {
  const { isAuthenticated, isAuthConfigured } = useAuth();
  const proxyEnabled = isAuthConfigured && isAuthenticated && !useLocalKeys;
  const [messages, setMessages] = useState<Message[]>([]);
  const [message, setMessage] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
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
  const [chatMode, setChatMode] = useState<"general" | "code">("general");
  const [channelModal, setChannelModal] = useState<{ isOpen: boolean; channel: "imessage" | "whatsapp" }>({
    isOpen: false,
    channel: "imessage",
  });

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const clientRef = useRef<GatewayClient | null>(null);
  const lastEventByRunIdRef = useRef<Record<string, number>>({});

  function addDiag(message: string) {
    const stamp = new Date().toLocaleTimeString();
    setDiagLogs(prev => {
      const next = [...prev, `${stamp} ${message}`];
      return next.slice(-200);
    });
  }

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLoading]);

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
    if (!currentSession || !clientRef.current) return;
    const modelOverride =
      chatMode === "code"
        ? codeModel.startsWith("openrouter/")
          ? codeModel
          : `openrouter/${codeModel}`
        : null;
    clientRef.current
      .patchSession(currentSession, { model: modelOverride })
      .then(() => addDiag(`session model override: ${modelOverride || "default"}`))
      .catch((err) => addDiag(`session override failed: ${String(err)}`));
  }, [chatMode, currentSession, codeModel]);

  useEffect(() => {
    addDiag(`status proxy=${proxyEnabled} gatewayRunning=${gatewayRunning}`);
  }, [proxyEnabled, gatewayRunning]);

  // Simplified connection effect
  useEffect(() => {
    if (gatewayRunning && (connectedProvider || proxyEnabled) && !clientRef.current) {
      connectToGateway();
    }
    return () => {
      clientRef.current?.disconnect();
      clientRef.current = null;
    };
  }, [gatewayRunning, connectedProvider, proxyEnabled]);

  async function connectToGateway() {
    setIsConnecting(true);
    setError(null);
    try {
      addDiag(`connect -> ${gatewayUrl}`);
      const client = createGatewayClient(gatewayUrl, GATEWAY_TOKEN);
      clientRef.current = client;
      client.on("connected", () => {
        setConnected(true);
        setIsConnecting(false);
        loadSessions();
        addDiag("gateway connected");
      });
      client.on("disconnected", () => {
        setConnected(false);
        addDiag("gateway disconnected");
      });
      client.on("chat", handleChatEvent);
      client.on("error", (err) => {
        setError(err);
        setIsConnecting(false);
        setLastGatewayError(err);
        addDiag(`gateway error: ${err}`);
      });
      await client.connect();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Connection failed");
      setIsConnecting(false);
      addDiag(`connect failed: ${e instanceof Error ? e.message : "unknown"}`);
    }
  }

  function handleChatEvent(event: any) {
    setLastChatEvent(event);
    if (event?.runId) {
      lastEventByRunIdRef.current[event.runId] = Date.now();
    }
    if (event.state === "delta" || event.state === "final") {
      const text = event.message?.content?.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('') || '';
      if (!text) return;
      setMessages(prev => {
        const existingIdx = prev.findIndex(m => m.id === event.runId && m.role === "assistant");
        if (existingIdx >= 0) {
          const updated = [...prev];
          updated[existingIdx].content = text;
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
    const history = await clientRef.current?.getChatHistory(sessionId) || [];
    const msgs: Message[] = history.map((m: any, i: number) => ({
      id: `h-${i}`,
      role: m.role,
      content: m.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('')
    }));
    setMessages(msgs);
    // Hide welcome if there are messages
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

  function handleSuggestionClick(action: SuggestionAction) {
    if (action.type === "channel") {
      setChannelModal({ isOpen: true, channel: action.channel });
    } else if (action.type === "agent") {
      handleSend(action.message);
    }
  }

  function handleChannelSetupComplete(channel: "imessage" | "whatsapp") {
    setChannelModal({ isOpen: false, channel });
    const channelName = channel === "imessage" ? "iMessage" : "WhatsApp";
    handleSend(`I've connected ${channelName}. Please send me a test message!`);
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
            {SUGGESTIONS.map((suggestion, index) => (
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
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 backdrop-blur-sm"
      onClick={() => setShowKeyModal(false)}>
      <div className="glass-card p-6 w-full max-w-md m-4" onClick={e => e.stopPropagation()}>
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

  // Main Chat UI
  return (
    <div className="h-full flex flex-col bg-transparent" onDragOver={e => { e.preventDefault(); setDragActive(true); }}
      onDragLeave={() => setDragActive(false)} onDrop={e => { e.preventDefault(); setDragActive(false); }}>

      {/* Header */}
      <div className="flex-shrink-0" style={{
          background: 'var(--glass-bg)',
          borderBottom: '1px solid var(--glass-border-subtle)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)'
        }}>
        <div className="flex items-center justify-between px-4 py-2">
          <div className="flex items-center gap-2">
            <select value={currentSession || ""} onChange={e => selectSession(e.target.value)}
              className="form-input text-sm !py-1 !px-3 !w-auto">
              {sessions.map(s => <option key={s.key} value={s.key}>{s.label || s.displayName || s.derivedTitle || `Chat ${s.key.slice(0, 8)}`}</option>)}
            </select>
            <select value={chatMode} onChange={e => setChatMode(e.target.value as "general" | "code")}
              className="form-input text-sm !py-1 !px-3 !w-auto">
              <option value="general">General</option>
              <option value="code">Code</option>
            </select>
            <button onClick={createNewSession} title="New Chat"
              className="p-1.5 rounded-md text-[var(--text-secondary)] hover:bg-black/5 hover:text-[var(--text-primary)]"><Plus className="w-4 h-4" /></button>
          </div>
        <div className="flex items-center gap-2">
          <div className={`w-2 h-2 rounded-full ${connected ? 'bg-green-500' : 'bg-gray-300'}`} />
          <span className="text-xs text-[var(--text-tertiary)]">{connected ? 'Connected' : 'Disconnected'}</span>
        </div>
        <button
          onClick={() => setShowDiagnostics(true)}
          className="btn-secondary !py-1 !px-3 text-xs"
          title="Gateway diagnostics"
        >
          <Activity className="w-3.5 h-3.5 mr-1" />
          Diagnostics
        </button>
      </div>
    </div>

      {/* Error Banner */}
      {error && <div className="p-2 text-center text-sm bg-red-500/10 text-red-500">{error}</div>}

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
                <p className="whitespace-pre-wrap">{msg.content}</p>
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
          <button onClick={() => handleSend()} disabled={!message.trim() || isLoading} className="btn-primary !p-2.5"><Send className="w-5 h-5" /></button>
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
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 backdrop-blur-sm"
          onClick={() => setShowDiagnostics(false)}>
          <div className="glass-card p-6 w-full max-w-2xl m-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-[var(--text-primary)]">Gateway Diagnostics</h3>
              <button onClick={() => setShowDiagnostics(false)} className="p-1 text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"><X className="w-5 h-5" /></button>
            </div>
            <div className="grid grid-cols-2 gap-3 text-sm mb-4">
              <div className="glass-card p-3">
                <p className="text-[var(--text-tertiary)]">Gateway URL</p>
                <p className="text-[var(--text-primary)] break-all">{gatewayUrl}</p>
              </div>
              <div className="glass-card p-3">
                <p className="text-[var(--text-tertiary)]">Proxy Enabled</p>
                <p className="text-[var(--text-primary)]">{proxyEnabled ? "true" : "false"}</p>
              </div>
              <div className="glass-card p-3">
                <p className="text-[var(--text-tertiary)]">Connected Provider</p>
                <p className="text-[var(--text-primary)]">{connectedProvider || "—"}</p>
              </div>
              <div className="glass-card p-3">
                <p className="text-[var(--text-tertiary)]">Connected</p>
                <p className="text-[var(--text-primary)]">{connected ? "true" : "false"}</p>
              </div>
              <div className="glass-card p-3">
                <p className="text-[var(--text-tertiary)]">Last Send</p>
                <p className="text-[var(--text-primary)] break-all">{lastSendId || "—"}</p>
                <p className="text-xs text-[var(--text-tertiary)]">
                  {lastSendAt ? new Date(lastSendAt).toLocaleTimeString() : "—"}
                </p>
              </div>
              <div className="glass-card p-3">
                <p className="text-[var(--text-tertiary)]">Last Gateway Error</p>
                <p className="text-[var(--text-primary)] break-all">{lastGatewayError || "—"}</p>
              </div>
              <div className="glass-card p-3">
                <p className="text-[var(--text-tertiary)]">Last Chat Event</p>
                <p className="text-[var(--text-primary)] break-all">{lastChatEvent?.state || "—"}</p>
              </div>
            </div>
            <div className="glass-card p-3 max-h-64 overflow-auto text-xs font-mono whitespace-pre-wrap">
              {diagLogs.length ? diagLogs.join("\n") : "No diagnostics yet."}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
