import { useState, useRef, useEffect } from "react";
import { Send, Sparkles, X, Loader2, Plus, ExternalLink } from "lucide-react";
import { open } from "@tauri-apps/plugin-shell";
import { invoke } from "@tauri-apps/api/core";
import clsx from "clsx";
import {
  GatewayClient,
  createGatewayClient,
} from "../lib/gateway";
import { Paperclip, X as XIcon } from "lucide-react";

type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp?: Date;
};

type Session = {
  key: string;
  sessionId?: string;
  label?: string;
  displayName?: string;
  derivedTitle?: string;
  updatedAt: number | null;
};

type Provider = {
  id: string;
  name: string;
  icon: string;
  placeholder: string;
  keyUrl: string;
  color: string;
};

type PendingAttachment = {
  id: string;
  fileName: string;
  mimeType: string;
  tempPath: string;
  sizeBytes: number;
  isImage: boolean;
  base64?: string;
  savedPath?: string;
};

type AuthState = {
  active_provider: string | null;
  providers: Array<{
    id: string;
    has_key: boolean;
    last4: string | null;
  }>;
};

const PROVIDERS: Provider[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    icon: "A",
    placeholder: "sk-ant-...",
    keyUrl: "https://console.anthropic.com/settings/keys",
    color: "bg-orange-100 text-orange-700",
  },
  {
    id: "openai",
    name: "OpenAI",
    icon: "O",
    placeholder: "sk-...",
    keyUrl: "https://platform.openai.com/api-keys",
    color: "bg-green-100 text-green-700",
  },
  {
    id: "google",
    name: "Google AI",
    icon: "G",
    placeholder: "AIza...",
    keyUrl: "https://aistudio.google.com/app/apikey",
    color: "bg-blue-100 text-blue-700",
  },
];

const DEFAULT_GATEWAY_URL = "ws://127.0.0.1:19789";
const GATEWAY_TOKEN = "zara-local-gateway";

type Props = {
  gatewayRunning: boolean;
};

export function Chat({ gatewayRunning }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [message, setMessage] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Session state
  const [sessions, setSessions] = useState<Session[]>([]);
  const [currentSession, setCurrentSession] = useState<string | null>(null);

  // API key modal
  const [showKeyModal, setShowKeyModal] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState<Provider | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [connectedProvider, setConnectedProvider] = useState<string | null>(null);
  const [providerStatus, setProviderStatus] = useState<AuthState["providers"]>([]);
  const [gatewayUrl, setGatewayUrl] = useState<string>(DEFAULT_GATEWAY_URL);
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [dragActive, setDragActive] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const clientRef = useRef<GatewayClient | null>(null);
  const pendingMessageRef = useRef<string>("");

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Load persisted auth state (provider selection)
  useEffect(() => {
    let cancelled = false;
    invoke<AuthState>("get_auth_state")
      .then((state) => {
        if (cancelled) return;
        setProviderStatus(state.providers);
        if (state.active_provider) {
          setConnectedProvider(state.active_provider);
          return;
        }
        const first = state.providers.find((p) => p.has_key);
        if (first) {
          setConnectedProvider(first.id);
        }
      })
      .catch(() => {});
    invoke<string>("get_gateway_ws_url")
      .then((url) => {
        if (cancelled || !url) return;
        setGatewayUrl(url);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Connect to gateway when it's running
  useEffect(() => {
    if (gatewayRunning && connectedProvider && !connected && !isConnecting) {
      connectToGateway();
    }
  }, [gatewayRunning, connectedProvider]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      clientRef.current?.disconnect();
    };
  }, []);

  async function connectToGateway() {
    setIsConnecting(true);
    setError(null);

    try {
      console.log("[Zara] Connecting to gateway...");
      const client = createGatewayClient(gatewayUrl, GATEWAY_TOKEN);
      clientRef.current = client;

      // Set up event listeners
      client.on("connected", () => {
        console.log("[Zara] Gateway connected");
        setConnected(true);
        setIsConnecting(false);
        loadSessions();
      });

      client.on("disconnected", () => {
        console.log("[Zara] Gateway disconnected");
        setConnected(false);
      });

      client.on("chat", (event) => {
        console.log("[Zara] Chat event:", event.state, event.seq);

        if (event.state === "delta" || event.state === "final") {
          // Extract text from message content
          const content = event.message?.content || [];
          const text = content
            .filter((b): b is { type: "text"; text: string } => b.type === "text")
            .map((b) => b.text)
            .join("");

          if (text) {
            setMessages((prev) => {
              // Find existing assistant message for this run or create new
              const existingIdx = prev.findIndex(
                (m) => m.id === event.runId && m.role === "assistant"
              );

              if (existingIdx >= 0) {
                // Update existing message
                const updated = [...prev];
                updated[existingIdx] = {
                  ...updated[existingIdx],
                  content: text,
                };
                return updated;
              } else {
                // Add new assistant message
                return [
                  ...prev,
                  {
                    id: event.runId,
                    role: "assistant",
                    content: text,
                    timestamp: new Date(),
                  },
                ];
              }
            });
          }

          if (event.state === "final") {
            setIsLoading(false);
          }
        } else if (event.state === "error") {
          console.error("[Zara] Chat error:", event.errorMessage);
          setError(event.errorMessage || "Chat error");
          setIsLoading(false);
        } else if (event.state === "aborted") {
          setIsLoading(false);
        }
      });

      client.on("error", (err) => {
        console.error("[Zara] Gateway error:", err);
        setError(err);
        setIsConnecting(false);
      });

      await client.connect();
    } catch (e) {
      console.error("[Zara] Failed to connect:", e);
      setError(e instanceof Error ? e.message : "Connection failed");
      setIsConnecting(false);
    }
  }

  async function loadSessions() {
    const client = clientRef.current;
    if (!client) return;

    try {
      const sessionList = await client.listSessions();
      console.log("[Zara] Sessions:", sessionList);
      setSessions(sessionList);

      // Select first session or create new one
      if (sessionList.length > 0) {
        selectSession(sessionList[0].key);
      } else {
        createNewSession();
      }
    } catch (e) {
      console.error("[Zara] Failed to load sessions:", e);
    }
  }

  async function selectSession(sessionId: string) {
    const client = clientRef.current;
    if (!client) return;

    setCurrentSession(sessionId);
    setMessages([]);

    try {
      const history = await client.getChatHistory(sessionId);
      console.log("[Zara] Chat history:", history);

      // Convert to our message format
      const msgs: Message[] = history.map((m, i) => ({
        id: `history-${i}`,
        role: m.role,
        content: m.content
          .filter((b): b is { type: "text"; text: string } => b.type === "text")
          .map((b) => b.text)
          .join(""),
      }));

      setMessages(msgs);
    } catch (e) {
      console.error("[Zara] Failed to load history:", e);
    }
  }

  function createNewSession() {
    const client = clientRef.current;
    if (!client) return;

    // Sessions are created automatically when you send a message
    // Just generate a new session key
    const sessionKey = client.createSessionKey();
    console.log("[Zara] Created new session key:", sessionKey);
    setCurrentSession(sessionKey);
    setMessages([]);
    // Session will be created when first message is sent
  }

  function openKeyModal(provider: Provider) {
    setSelectedProvider(provider);
    setKeyInput("");
    setShowKeyModal(true);
  }

  async function connectWithKey() {
    if (!keyInput.trim() || !selectedProvider) return;

    console.log("[Zara] Connecting with", selectedProvider.name);
    setShowKeyModal(false);
    setError(null);

    try {
      // Store API key in backend
      await invoke("set_api_key", {
        provider: selectedProvider.id,
        key: keyInput.trim(),
      });
      console.log("[Zara] API key stored for", selectedProvider.id);

      // Restart gateway with new API key (removes old container, creates new with env vars)
      console.log("[Zara] Restarting gateway with API key...");
      await invoke("restart_gateway");
      console.log("[Zara] Gateway started with API key");

      // Wait a moment for gateway to be ready
      await new Promise((r) => setTimeout(r, 2000));

      // Refresh auth state and set provider
      try {
        const state = await invoke<AuthState>("get_auth_state");
        setProviderStatus(state.providers);
      } catch {}
      setConnectedProvider(selectedProvider.id);

      // Explicitly connect now
      await connectToGateway();
    } catch (e) {
      console.error("[Zara] Failed to configure gateway:", e);
      setError(e instanceof Error ? e.message : String(e));
      setIsConnecting(false);
    }
  }

  async function switchProvider(providerId: string) {
    if (providerId === connectedProvider) return;
    const status = providerStatus.find((p) => p.id === providerId);
    if (!status?.has_key) {
      const target = PROVIDERS.find((p) => p.id === providerId);
      if (target) openKeyModal(target);
      return;
    }

    setIsConnecting(true);
    setError(null);

    try {
      await invoke("set_active_provider", { provider: providerId });
      await invoke("restart_gateway");
      await new Promise((r) => setTimeout(r, 2000));
      setConnectedProvider(providerId);
      await connectToGateway();
    } catch (e) {
      console.error("[Zara] Failed to switch provider:", e);
      setError(e instanceof Error ? e.message : String(e));
      setIsConnecting(false);
    }
  }

  async function handleSend() {
    if (!currentSession || !connected || isLoading) return;
    if (!message.trim() && pendingAttachments.length === 0) return;

    const client = clientRef.current;
    if (!client) return;

    const attachmentLines = pendingAttachments.map((att) => {
      const location = att.savedPath || att.tempPath;
      return `- ${att.fileName} (${location})`;
    });
    const attachmentBlock =
      attachmentLines.length > 0 ? `\n\nAttached files:\n${attachmentLines.join("\n")}` : "";
    const finalMessage = `${message.trim()}${attachmentBlock}`.trim();

    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: "user",
      content: finalMessage,
      timestamp: new Date(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setMessage("");
    setIsLoading(true);
    setError(null);

    try {
      console.log("[Zara] Sending message...");
      const imageAttachments = pendingAttachments
        .filter((a) => a.isImage && a.base64)
        .map((a) => ({
          fileName: a.fileName,
          mimeType: a.mimeType,
          content: a.base64!,
        }));
      await client.sendMessage(currentSession, userMessage.content, imageAttachments);
      setPendingAttachments([]);
      // Response will come via chat event
    } catch (e) {
      console.error("[Zara] Failed to send:", e);
      setError(e instanceof Error ? e.message : "Send failed");
      setIsLoading(false);
    }
  }

  async function handleFiles(files: FileList | File[]) {
    const list = Array.from(files);
    for (const file of list) {
      const reader = new FileReader();
      await new Promise<void>((resolve, reject) => {
        reader.onerror = () => reject(reader.error);
        reader.onload = async () => {
          try {
            const result = typeof reader.result === "string" ? reader.result : "";
            const base64 = result.includes(",") ? result.split(",")[1] : result;
            const info = await invoke<{
              id: string;
              file_name: string;
              mime_type: string;
              temp_path: string;
              size_bytes: number;
              is_image: boolean;
            }>("upload_attachment", {
              fileName: file.name,
              mimeType: file.type || "application/octet-stream",
              base64,
            });
            setPendingAttachments((prev) => [
              ...prev,
              {
                id: info.id,
                fileName: info.file_name,
                mimeType: info.mime_type,
                tempPath: info.temp_path,
                sizeBytes: info.size_bytes,
                isImage: info.is_image,
                base64: info.is_image ? base64 : undefined,
              },
            ]);
            resolve();
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
            resolve();
          }
        };
        reader.readAsDataURL(file);
      });
    }
  }

  async function removeAttachment(att: PendingAttachment) {
    try {
      await invoke("delete_attachment", { tempPath: att.tempPath });
    } catch {}
    setPendingAttachments((prev) => prev.filter((a) => a.id !== att.id));
  }

  async function saveAttachment(att: PendingAttachment) {
    try {
      const savedPath = await invoke<string>("save_attachment", {
        tempPath: att.tempPath,
      });
      setPendingAttachments((prev) =>
        prev.map((a) => (a.id === att.id ? { ...a, savedPath } : a))
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  // Show connection prompt if no provider connected
  if (!connectedProvider) {
    return (
      <>
        <div className="h-full flex flex-col items-center justify-center p-8">
          <div className="max-w-md text-center">
            <div className="w-16 h-16 bg-violet-100 rounded-2xl flex items-center justify-center mx-auto mb-6">
              <Sparkles className="w-8 h-8 text-violet-600" />
            </div>
            <h2 className="text-2xl font-semibold text-gray-900 mb-2">
              Connect an AI Provider
            </h2>
            <p className="text-gray-500 mb-8">
              Add your API key to start chatting through Zara's secure sandbox.
            </p>

            <div className="space-y-3">
              {PROVIDERS.map((provider) => (
                <button
                  key={provider.id}
                  onClick={() => openKeyModal(provider)}
                  className="w-full flex items-center gap-4 p-4 bg-white border border-gray-200 rounded-xl hover:border-violet-300 hover:shadow-sm transition-all group"
                >
                  <div className={clsx(
                    "w-10 h-10 rounded-lg flex items-center justify-center font-semibold",
                    provider.color
                  )}>
                    {provider.icon}
                  </div>
                  <div className="flex-1 text-left">
                    <p className="font-medium text-gray-900">{provider.name}</p>
                    <p className="text-sm text-gray-500">Claude, GPT, Gemini & more</p>
                  </div>
                  <ExternalLink className="w-4 h-4 text-gray-300 group-hover:text-violet-500 transition-colors" />
                </button>
              ))}
            </div>

            <p className="text-xs text-gray-400 mt-6">
              Your API keys are stored locally and never sent to our servers.
            </p>
          </div>
        </div>

        {/* API Key Modal */}
        {showKeyModal && selectedProvider && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
            <div className="bg-white rounded-2xl p-6 w-full max-w-md mx-4 shadow-xl">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-semibold text-gray-900">
                  Connect {selectedProvider.name}
                </h3>
                <button
                  onClick={() => setShowKeyModal(false)}
                  className="p-1 text-gray-400 hover:text-gray-600"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Step 1: Get API Key */}
              <div className="mb-4 p-4 bg-gray-50 rounded-xl">
                <p className="text-sm font-medium text-gray-700 mb-2">
                  Step 1: Get your API key
                </p>
                <button
                  onClick={() => open(selectedProvider.keyUrl)}
                  className={clsx(
                    "w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg font-medium transition-colors",
                    selectedProvider.color
                  )}
                >
                  <ExternalLink className="w-4 h-4" />
                  Open {selectedProvider.name} Console
                </button>
                <p className="text-xs text-gray-500 mt-2">
                  Create a new API key and copy it
                </p>
              </div>

              {/* Step 2: Paste Key */}
              <div className="mb-4">
                <p className="text-sm font-medium text-gray-700 mb-2">
                  Step 2: Paste your key
                </p>
                <input
                  type="password"
                  value={keyInput}
                  onChange={(e) => setKeyInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && connectWithKey()}
                  placeholder={selectedProvider.placeholder}
                  className="w-full px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-violet-500"
                />
              </div>

              <div className="flex gap-3">
                <button
                  onClick={() => setShowKeyModal(false)}
                  className="flex-1 px-4 py-2 text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={connectWithKey}
                  disabled={!keyInput.trim()}
                  className="flex-1 px-4 py-2 bg-violet-600 text-white rounded-lg hover:bg-violet-700 transition-colors disabled:opacity-50"
                >
                  Connect
                </button>
              </div>
            </div>
          </div>
        )}
      </>
    );
  }

  // Show connecting state
  if (isConnecting) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center">
          <Loader2 className="w-8 h-8 animate-spin text-violet-600 mx-auto mb-3" />
          <p className="text-gray-600">Connecting to gateway...</p>
        </div>
      </div>
    );
  }

  // Show chat interface
  return (
    <div
      className="h-full flex flex-col"
      onDragOver={(e) => {
        e.preventDefault();
        setDragActive(true);
      }}
      onDragLeave={() => setDragActive(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragActive(false);
        if (e.dataTransfer.files?.length) {
          handleFiles(e.dataTransfer.files);
        }
      }}
    >
      {/* Provider Switcher */}
      <div className="flex items-center justify-between px-6 py-2 border-b border-gray-100 bg-white">
        <div className="text-xs text-gray-500">Provider</div>
        <div className="flex items-center gap-2">
          {PROVIDERS.map((provider) => {
            const status = providerStatus.find((p) => p.id === provider.id);
            const active = connectedProvider === provider.id;
            return (
              <button
                key={provider.id}
                onClick={() => switchProvider(provider.id)}
                className={clsx(
                  "px-3 py-1.5 text-xs font-medium rounded-full border transition-colors",
                  active
                    ? "bg-gray-900 text-white border-gray-900"
                    : "bg-white text-gray-700 border-gray-200 hover:border-gray-300",
                  !status?.has_key && "opacity-60"
                )}
                title={status?.has_key ? provider.name : `Add ${provider.name} key`}
              >
                {provider.name}
              </button>
            );
          })}
        </div>
      </div>

      {/* Session Header */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-gray-200 bg-white">
        <div className="flex items-center gap-3">
          <select
            value={currentSession || ""}
            onChange={(e) => selectSession(e.target.value)}
            className="text-sm border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-violet-500"
          >
            {sessions.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label || s.displayName || s.derivedTitle || `Chat ${s.key.slice(0, 8)}`}
              </option>
            ))}
          </select>
          <button
            onClick={createNewSession}
            className="p-1.5 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg"
            title="New chat"
          >
            <Plus className="w-4 h-4" />
          </button>
        </div>
        <div className="flex items-center gap-2">
          <div
            className={clsx(
              "w-2 h-2 rounded-full",
              connected ? "bg-green-500" : "bg-gray-300"
            )}
          />
          <span className="text-xs text-gray-500">
            {connected ? "Connected" : "Disconnected"}
          </span>
        </div>
      </div>

      {/* Error Banner */}
      {error && (
        <div className="px-6 py-2 bg-red-50 border-b border-red-100 text-red-600 text-sm">
          {error}
        </div>
      )}

      {/* Chat Messages */}
      <div className="flex-1 p-6 overflow-auto">
        {!gatewayRunning ? (
          <div className="h-full flex items-center justify-center">
            <div className="text-center text-gray-500">
              <p className="mb-2">Gateway is not running</p>
              <p className="text-sm">Go to Settings to start the gateway</p>
            </div>
          </div>
        ) : messages.length === 0 ? (
          <div className="h-full flex items-center justify-center">
            <div className="text-center text-gray-400">
              <Sparkles className="w-8 h-8 mx-auto mb-3 opacity-50" />
              <p>Start a conversation</p>
            </div>
          </div>
        ) : (
          <div className="max-w-3xl mx-auto space-y-4">
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={clsx(
                  "flex",
                  msg.role === "user" ? "justify-end" : "justify-start"
                )}
              >
                <div
                  className={clsx(
                    "max-w-[80%] px-4 py-3 rounded-2xl",
                    msg.role === "user"
                      ? "bg-violet-600 text-white"
                      : "bg-white border border-gray-200 text-gray-900"
                  )}
                >
                  <p className="whitespace-pre-wrap">{msg.content}</p>
                </div>
              </div>
            ))}
            {isLoading && (
              <div className="flex justify-start">
                <div className="bg-white border border-gray-200 px-4 py-3 rounded-2xl">
                  <Loader2 className="w-5 h-5 animate-spin text-gray-400" />
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* Input Area */}
      <div className="border-t border-gray-200 p-4 bg-white relative">
        <div className="max-w-3xl mx-auto">
          {pendingAttachments.length > 0 && (
            <div className="mb-3 flex flex-wrap gap-2">
              {pendingAttachments.map((att) => (
                <div
                  key={att.id}
                  className="flex items-center gap-2 px-3 py-1.5 bg-gray-50 border border-gray-200 rounded-lg text-xs"
                >
                  <Paperclip className="w-3 h-3 text-gray-500" />
                  <span className="text-gray-700">{att.fileName}</span>
                  {att.savedPath ? (
                    <span className="text-green-600">Saved</span>
                  ) : (
                    <button
                      onClick={() => saveAttachment(att)}
                      className="text-violet-600 hover:text-violet-700"
                    >
                      Save
                    </button>
                  )}
                  <button
                    onClick={() => removeAttachment(att)}
                    className="text-gray-400 hover:text-gray-600"
                    title="Remove"
                  >
                    <XIcon className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="flex gap-3">
            <label
              className="px-3 py-3 bg-gray-50 border border-gray-200 rounded-xl text-gray-500 cursor-pointer hover:bg-gray-100"
              title="Attach files"
            >
              <Paperclip className="w-5 h-5" />
              <input
                type="file"
                multiple
                className="hidden"
                onChange={(e) => {
                  if (e.target.files?.length) {
                    handleFiles(e.target.files);
                    e.target.value = "";
                  }
                }}
              />
            </label>
            <input
              type="text"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && handleSend()}
              placeholder={
                !gatewayRunning
                  ? "Start gateway to chat"
                  : !connected
                  ? "Connecting..."
                  : "Type a message..."
              }
              disabled={!gatewayRunning || !connected || isLoading}
              className={clsx(
                "flex-1 px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl",
                "focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent",
                "disabled:opacity-50 disabled:cursor-not-allowed"
              )}
            />
            <button
              onClick={handleSend}
              disabled={!message.trim() || !gatewayRunning || !connected || isLoading}
              className={clsx(
                "px-4 py-3 bg-violet-600 text-white rounded-xl",
                "hover:bg-violet-700 transition-colors",
                "disabled:opacity-50 disabled:cursor-not-allowed"
              )}
            >
              <Send className="w-5 h-5" />
            </button>
          </div>
        </div>
        {dragActive && (
          <div className="absolute inset-0 bg-violet-50/80 border-2 border-dashed border-violet-300 flex items-center justify-center text-violet-700 font-medium">
            Drop files to attach
          </div>
        )}
      </div>
    </div>
  );
}
