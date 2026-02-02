import { useState, useRef, useEffect } from "react";
import { Send, Sparkles, X, Loader2, Plus, ExternalLink, Paperclip } from "lucide-react";
import { open } from "@tauri-apps/plugin-shell";
import { invoke } from "@tauri-apps/api/core";
import clsx from "clsx";
import { GatewayClient, createGatewayClient } from "../lib/gateway";

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

export function Chat({ gatewayRunning }: { gatewayRunning: boolean }) {
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

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const clientRef = useRef<GatewayClient | null>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLoading]);

  // Simplified effect for loading initial state
  useEffect(() => {
    invoke<AuthState>("get_auth_state").then(state => {
      setProviderStatus(state.providers);
      setConnectedProvider(state.active_provider || state.providers.find(p => p.has_key)?.id || null);
    }).catch(console.error);
    invoke<string>("get_gateway_ws_url").then(url => url && setGatewayUrl(url)).catch(console.error);
  }, []);

  // Simplified connection effect
  useEffect(() => {
    if (gatewayRunning && connectedProvider && !clientRef.current) {
      connectToGateway();
    }
    return () => {
      clientRef.current?.disconnect();
      clientRef.current = null;
    };
  }, [gatewayRunning, connectedProvider]);

  async function connectToGateway() {
    setIsConnecting(true);
    setError(null);
    try {
      const client = createGatewayClient(gatewayUrl, GATEWAY_TOKEN);
      clientRef.current = client;
      client.on("connected", () => {
        setConnected(true);
        setIsConnecting(false);
        loadSessions();
      });
      client.on("disconnected", () => setConnected(false));
      client.on("chat", handleChatEvent);
      client.on("error", (err) => {
        setError(err);
        setIsConnecting(false);
      });
      await client.connect();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Connection failed");
      setIsConnecting(false);
    }
  }

  function handleChatEvent(event: any) {
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
    } else if (event.state === "aborted") {
      setIsLoading(false);
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
  }

  function createNewSession() {
    const sessionKey = clientRef.current!.createSessionKey();
    setCurrentSession(sessionKey);
    setMessages([]);
  }

  async function handleSend() {
    if (!currentSession || !connected || isLoading || (!message.trim() && pendingAttachments.length === 0)) return;
    const content = message.trim();
    const userMessage: Message = { id: crypto.randomUUID(), role: "user", content };
    setMessages(prev => [...prev, userMessage]);
    setMessage("");
    setIsLoading(true);
    setError(null);
    try {
      await clientRef.current?.sendMessage(currentSession, content, []);
      setPendingAttachments([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Send failed");
      setIsLoading(false);
    }
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
                  <p className="text-sm text-[var(--text-tertiary)]">Claude, GPT, Gemini & more</p>
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
  if (!connectedProvider) return renderNoProvider();

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
            <button onClick={createNewSession} title="New Chat"
              className="p-1.5 rounded-md text-[var(--text-secondary)] hover:bg-black/5 hover:text-[var(--text-primary)]"><Plus className="w-4 h-4" /></button>
          </div>
          <div className="flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full ${connected ? 'bg-green-500' : 'bg-gray-300'}`} />
            <span className="text-xs text-[var(--text-tertiary)]">{connected ? 'Connected' : 'Disconnected'}</span>
          </div>
        </div>
      </div>

      {/* Error Banner */}
      {error && <div className="p-2 text-center text-sm bg-red-500/10 text-red-500">{error}</div>}

      {/* Messages */}
      <div className="flex-1 p-4 overflow-auto">
        <div className="max-w-3xl mx-auto space-y-4">
          {messages.length === 0 && (
            <div className="h-full flex items-center justify-center text-center text-[var(--text-tertiary)]">
              <div>
                <Sparkles className="w-8 h-8 mx-auto mb-2 opacity-50" />
                <p>Start a conversation</p>
              </div>
            </div>
          )}
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
          <button onClick={handleSend} disabled={!message.trim() || isLoading} className="btn-primary !p-2.5"><Send className="w-5 h-5" /></button>
        </div>
        {dragActive && (
          <div className="absolute inset-0 bg-black/10 border-2 border-dashed border-white/50 flex items-center justify-center font-medium text-white">
            Drop files to attach
          </div>
        )}
      </div>
    </div>
  );
}
