import { useEffect, useState, type ReactNode } from "react";
import {
  CheckCircle2,
  Loader2,
  WifiOff,
  Wifi,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";

function ChannelGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mb-10">
      <h2 className="text-xl font-bold text-[var(--text-primary)] mb-4">{title}</h2>
      <div className="bg-[var(--bg-card)] rounded-2xl shadow-sm border border-[var(--border-subtle)] p-6 space-y-6">
        {children}
      </div>
    </div>
  );
}

function TelegramConnectionStatus({
  tokenSaved,
  connected,
  gatewayRunning,
  checking,
}: {
  tokenSaved: boolean;
  connected: boolean;
  gatewayRunning: boolean;
  checking: boolean;
}) {
  if (!tokenSaved) {
    return (
      <div className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
        <WifiOff className="w-4 h-4 text-[var(--text-tertiary)]" />
        <span>Not configured</span>
      </div>
    );
  }

  if (connected) {
    return (
      <div className="flex items-center gap-2 text-xs text-green-500">
        <Wifi className="w-4 h-4" />
        <span className="font-medium">Connected</span>
      </div>
    );
  }

  if (!gatewayRunning) {
    return (
      <div className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
        <WifiOff className="w-4 h-4 text-[var(--text-tertiary)]" />
        <span>Gateway offline</span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 text-xs text-amber-500">
      {checking ? (
        <Loader2 className="w-4 h-4 animate-spin" />
      ) : (
        <WifiOff className="w-4 h-4" />
      )}
      <span>Awaiting authorization</span>
    </div>
  );
}

const TelegramIcon = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" className={className} fill="currentColor">
    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.64 6.8c-.15 1.58-.8 5.42-1.13 7.19-.14.75-.42 1-.68 1.03-.58.05-1.02-.38-1.58-.75-.88-.58-1.38-.94-2.23-1.5-.99-.65-.35-1.01.22-1.66.15-.17 2.71-2.48 2.76-2.69.01-.03.01-.14-.07-.18-.08-.04-.19-.03-.27-.01-.11.02-1.82 1.15-5.14 2.3-.49.17-.93.25-1.33.24-.44-.01-1.29-.25-1.92-.45-.77-.25-1.38-.39-1.33-.82.03-.23.34-.46.94-.7 3.68-1.6 6.13-2.66 7.35-3.17 3.5-.14 4.22.11 4.23.11.01.01.03.01.03.02z" />
  </svg>
);

type TelegramDmPolicy = "pairing" | "allowlist" | "open" | "disabled";
type TelegramGroupPolicy = "allowlist" | "open" | "disabled";
type TelegramReplyToMode = "off" | "first" | "all";

function normalizeTelegramDmPolicy(value: string | undefined): TelegramDmPolicy {
  if (value === "allowlist" || value === "open" || value === "disabled") {
    return value;
  }
  return "pairing";
}

function normalizeTelegramGroupPolicy(value: string | undefined): TelegramGroupPolicy {
  if (value === "open" || value === "disabled") {
    return value;
  }
  return "allowlist";
}

function normalizeTelegramReplyToMode(value: string | undefined): TelegramReplyToMode {
  if (value === "first" || value === "all") {
    return value;
  }
  return "off";
}

type TelegramSaveTarget = "token" | "settings";
type TelegramTokenValidationResult = {
  valid: boolean;
  bot_id?: number | null;
  username?: string | null;
  display_name?: string | null;
  message: string;
};

type SavedChannelsState = {
  telegram_enabled: boolean;
  telegram_token: string;
  telegram_dm_policy?: string;
  telegram_group_policy?: string;
  telegram_config_writes?: boolean;
  telegram_require_mention?: boolean;
  telegram_reply_to_mode?: string;
  telegram_link_preview?: boolean;
};

type GatewayMutationPlan = "noop" | "config_reload" | "container_restart" | "container_recreate";

type GatewayMutationResult = {
  plan: GatewayMutationPlan;
  applied: boolean;
  wsReconnectExpected: boolean;
};

export function Channels() {
  const [initialLoading, setInitialLoading] = useState(true);
  const [telegramEnabled, setTelegramEnabled] = useState(false);
  const [telegramToken, setTelegramToken] = useState("");
  const [telegramDmPolicy, setTelegramDmPolicy] = useState<TelegramDmPolicy>("pairing");
  const [telegramGroupPolicy, setTelegramGroupPolicy] = useState<TelegramGroupPolicy>("allowlist");
  const [telegramConfigWrites, setTelegramConfigWrites] = useState(false);
  const [telegramRequireMention, setTelegramRequireMention] = useState(true);
  const [telegramReplyToMode, setTelegramReplyToMode] = useState<TelegramReplyToMode>("off");
  const [telegramLinkPreview, setTelegramLinkPreview] = useState(true);
  const [telegramTokenSaved, setTelegramTokenSaved] = useState(false);
  const [telegramConnected, setTelegramConnected] = useState(false);
  const [showAdvancedHelp, setShowAdvancedHelp] = useState(false);
  const [telegramPairingCode, setTelegramPairingCode] = useState("");
  const [telegramPairingStatus, setTelegramPairingStatus] = useState<string | null>(null);
  const [gatewayRunning, setGatewayRunning] = useState(false);
  const [restartPending, setRestartPending] = useState(false);
  const [restartingGateway, setRestartingGateway] = useState(false);
  const [checkingConnection, setCheckingConnection] = useState(false);

  const [savingSetup, setSavingSetup] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  async function waitForGatewayRunningStatus(
    attempts = 8,
    delayMs = 1500
  ): Promise<boolean> {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const running = await refreshGatewayRunningStatus();
      if (running) {
        return true;
      }
      if (attempt < attempts - 1) {
        await new Promise((resolve) => window.setTimeout(resolve, delayMs));
      }
    }
    return false;
  }

  async function refreshTelegramConnectedStatus() {
    const connected = await invoke<boolean>("get_telegram_connection_status").catch(() => false);
    setTelegramConnected(Boolean(connected));
    return Boolean(connected);
  }

  async function refreshGatewayRunningStatus() {
    const running = await invoke<boolean>("get_gateway_status").catch(() => false);
    setGatewayRunning(Boolean(running));
    return Boolean(running);
  }

  useEffect(() => {
    let cancelled = false;
    const loadingGuard = window.setTimeout(() => {
      if (!cancelled) {
        setInitialLoading(false);
      }
    }, 8000);
    const loadInitialState = async () => {
      let telegramEnabledLoaded = false;
      let telegramTokenLoaded = "";
      try {
        const state = await invoke<SavedChannelsState>("get_saved_channels_state");
        if (cancelled) return;

        telegramEnabledLoaded = state.telegram_enabled ?? false;
        telegramTokenLoaded = state.telegram_token || "";
        setTelegramEnabled(telegramEnabledLoaded);
        setTelegramToken(telegramTokenLoaded);
        const dmPolicy = normalizeTelegramDmPolicy(state.telegram_dm_policy);
        const groupPolicy = normalizeTelegramGroupPolicy(state.telegram_group_policy);
        const configWrites = state.telegram_config_writes ?? false;
        const requireMention = state.telegram_require_mention ?? true;
        const replyToMode = normalizeTelegramReplyToMode(state.telegram_reply_to_mode);
        const linkPreview = state.telegram_link_preview ?? true;
        setTelegramDmPolicy(dmPolicy);
        setTelegramGroupPolicy(groupPolicy);
        setTelegramConfigWrites(configWrites);
        setTelegramRequireMention(requireMention);
        setTelegramReplyToMode(replyToMode);
        setTelegramLinkPreview(linkPreview);
        setTelegramTokenSaved(Boolean(telegramTokenLoaded.trim()));
      } catch {
        // Keep defaults; still transition out of loading.
      } finally {
        if (!cancelled) {
          setInitialLoading(false);
        }
        const isConnected = await refreshTelegramConnectedStatus();
        void refreshGatewayRunningStatus();

        // Send welcome message if already connected on startup
        if (isConnected && telegramEnabledLoaded && telegramTokenLoaded.trim()) {
          console.log("[Channels] Already connected on startup, sending welcome message...");
          invoke("send_telegram_welcome_message").catch((err) => {
            console.error("[Channels] Failed to send welcome message:", err);
          });
        }
      }
    };

    void loadInitialState();
    return () => {
      cancelled = true;
      window.clearTimeout(loadingGuard);
    };
  }, []);

  // Auto-poll connection and gateway status when awaiting authorization
  useEffect(() => {
    if (!telegramTokenSaved || telegramConnected) {
      return;
    }

    let cancelled = false;
    const pollInterval = setInterval(async () => {
      if (cancelled) return;
      // Always refresh gateway status so the page recovers from transient failures
      void refreshGatewayRunningStatus();
      setCheckingConnection(true);
      const connected = await refreshTelegramConnectedStatus();
      setCheckingConnection(false);
      if (connected) {
        // Stop polling once connected
        clearInterval(pollInterval);
        // Send welcome message to bot
        console.log("[Channels] Connection established, sending welcome message...");
        invoke("send_telegram_welcome_message").catch((err) => {
          console.error("[Channels] Failed to send welcome message:", err);
        });
      }
    }, 3000); // Poll every 3 seconds

    return () => {
      cancelled = true;
      clearInterval(pollInterval);
    };
  }, [telegramTokenSaved, telegramConnected]);

  useEffect(() => {
    if (!gatewayRunning || !saveMessage) {
      return;
    }

    if (
      saveMessage.includes("Gateway restart in progress") ||
      saveMessage.includes("Restarting gateway...")
    ) {
      setSaveMessage(
        "Gateway restarted. Message your bot on Telegram and send /start to receive a pairing code."
      );
    }
  }, [gatewayRunning, saveMessage]);

  async function autoConfigureTelegram(params: {
    enabled: boolean;
    token: string;
    dmPolicy: TelegramDmPolicy;
    groupPolicy: TelegramGroupPolicy;
    configWrites: boolean;
    requireMention: boolean;
    replyToMode: TelegramReplyToMode;
    linkPreview: boolean;
  }) {
    try {
      console.log("[Channels] Auto-configuring Telegram...");
      await invoke<GatewayMutationResult>("apply_gateway_mutation", {
        request: {
          channels: {
            telegramEnabled: params.enabled,
            telegramToken: params.token,
            telegramDmPolicy: params.dmPolicy,
            telegramGroupPolicy: params.groupPolicy,
            telegramConfigWrites: params.configWrites,
            telegramRequireMention: params.requireMention,
            telegramReplyToMode: params.replyToMode,
            telegramLinkPreview: params.linkPreview,
          },
        },
      });
      console.log("[Channels] Auto-configuration succeeded");
    } catch (err) {
      console.error("[Channels] Auto-configuration failed:", err);
    }
  }

  async function disconnectTelegram() {
    setSavingSetup(true);
    setSaveMessage(null);
    setSaveError(null);
    try {
      const result = await invoke<GatewayMutationResult>("apply_gateway_mutation", {
        request: {
          channels: {
            telegramEnabled: false,
            telegramToken: "",
            telegramDmPolicy,
            telegramGroupPolicy,
            telegramConfigWrites,
            telegramRequireMention,
            telegramReplyToMode,
            telegramLinkPreview,
          },
        },
      });
      setTelegramEnabled(false);
      setTelegramToken("");
      setTelegramTokenSaved(false);
      setTelegramConnected(false);
      setRestartPending(false);
      const running = await refreshGatewayRunningStatus();
      if (result.wsReconnectExpected) {
        setSaveMessage(
          running ? "Telegram disconnected." : "Telegram disconnect is still applying.",
        );
      } else {
        setSaveMessage("Telegram disconnected.");
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      setSaveError(`Failed to disconnect Telegram: ${detail}`);
    } finally {
      setSavingSetup(false);
    }
  }

  async function saveMessagingSetup(target: TelegramSaveTarget = "token") {
    console.log("[Channels] saveMessagingSetup called");
    console.log("[Channels] telegramEnabled:", telegramEnabled);
    console.log("[Channels] telegramToken length:", telegramToken.length);

    setSavingSetup(true);
    setSaveMessage(null);
    setSaveError(null);
    try {
      let validationResult: TelegramTokenValidationResult | null = null;
      if (target === "token") {
        console.log("[Channels] Validating Telegram bot token...");
        try {
          validationResult = await invoke<TelegramTokenValidationResult>("validate_telegram_token", {
            token: telegramToken,
          });
          console.log("[Channels] Token validation result:", validationResult);
        } catch (validationErr) {
          const detail = validationErr instanceof Error ? validationErr.message : String(validationErr);
          console.error("[Channels] Token validation failed:", detail);
          setSaveError(`Failed to validate bot token: ${detail}. Check your internet connection and try again.`);
          return;
        }
        if (!validationResult.valid) {
          setSaveError(`Invalid bot token: ${validationResult.message}`);
          return;
        }
      }

      // Auto-enable Telegram when saving a valid token
      const effectiveEnabled = target === "token" ? true : telegramEnabled;
      if (target === "token" && !telegramEnabled) {
        console.log("[Channels] Auto-enabling Telegram since valid token is being saved");
        setTelegramEnabled(true);
      }

      console.log("[Channels] Invoking apply_gateway_mutation...");
      const result = await invoke<GatewayMutationResult>("apply_gateway_mutation", {
        request: {
          channels: {
            telegramEnabled: effectiveEnabled,
            telegramToken,
            telegramDmPolicy,
            telegramGroupPolicy,
            telegramConfigWrites,
            telegramRequireMention,
            telegramReplyToMode,
            telegramLinkPreview,
          },
        },
      });
      console.log("[Channels] apply_gateway_mutation succeeded");
      setTelegramTokenSaved(Boolean(telegramToken.trim()));
      const [connected, running] = await Promise.all([
        refreshTelegramConnectedStatus(),
        refreshGatewayRunningStatus(),
      ]);
      setTelegramConnected(Boolean(connected));
      setGatewayRunning(Boolean(running));
      const effectiveRunning = gatewayRunning || running;

      if (target === "token" && effectiveRunning) {
        const botHandle = validationResult?.username?.trim() ? ` @${validationResult.username.trim()}` : "";
        setRestartPending(false);
        setSaveMessage(
          result.wsReconnectExpected
            ? `Bot token saved${botHandle}. Message your bot on Telegram and send /start to receive a pairing code.`
            : `Bot token saved${botHandle}.`,
        );
      } else if (target === "token" && !effectiveRunning) {
        const botHandle = validationResult?.username?.trim() ? ` @${validationResult.username.trim()}` : "";
        setSaveMessage(`Bot token saved${botHandle}. Starting gateway...`);
        // Gateway is not running — ask Dashboard to start it
        window.dispatchEvent(new CustomEvent("entropic-start-gateway"));
      } else {
        setRestartPending(false);
        setSaveMessage(
          effectiveRunning
            ? "Telegram settings saved."
            : "Telegram settings saved. Changes will apply on next gateway start."
        );
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error("[Channels] set_channels_config failed:", detail);
      setSaveError(
        target === "token"
          ? `Failed to save bot token: ${detail}`
          : `Failed to save settings: ${detail}`
      );
    } finally {
      setSavingSetup(false);
      console.log("[Channels] saveMessagingSetup completed");
    }
  }

  async function applyTelegramConfigNow() {
    setRestartingGateway(true);
    setSaveError(null);
    setSaveMessage(null);
    try {
      const result = await invoke<GatewayMutationResult>("apply_gateway_mutation", {
        request: {
          channels: {
            telegramEnabled,
            telegramToken,
            telegramDmPolicy,
            telegramGroupPolicy,
            telegramConfigWrites,
            telegramRequireMention,
            telegramReplyToMode,
            telegramLinkPreview,
          },
        },
      });
      setRestartPending(false);
      const [connected, running] = await Promise.all([
        refreshTelegramConnectedStatus(),
        refreshGatewayRunningStatus(),
      ]);
      setTelegramConnected(Boolean(connected));
      setGatewayRunning(Boolean(running));
      setSaveMessage(
        result.wsReconnectExpected
          ? "Telegram configuration reapplied."
          : "Telegram configuration is saved and will apply on next gateway start."
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      setSaveError(`Failed to restart gateway: ${detail}`);
    } finally {
      setRestartingGateway(false);
    }
  }

  async function approveTelegramPairing() {
    console.log("[Channels] approveTelegramPairing called");
    console.log("[Channels] pairing code:", telegramPairingCode);

    setTelegramPairingStatus(null);
    try {
      console.log("[Channels] Invoking approve_pairing...");
      const result = await invoke<string>("approve_pairing", {
        channel: "telegram",
        code: telegramPairingCode,
      });
      console.log("[Channels] approve_pairing succeeded:", result);
      setTelegramPairingStatus(result || "Pairing approved.");
      setTelegramConnected(true);
      setTelegramPairingCode("");

      // Send welcome message after successful pairing
      console.log("[Channels] Pairing approved, sending welcome message...");
      invoke("send_telegram_welcome_message").catch((err) => {
        console.error("[Channels] Failed to send welcome message:", err);
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error("[Channels] approve_pairing failed:", detail);
      setTelegramPairingStatus(`Failed to approve pairing: ${detail}`);
    }
  }

  if (initialLoading) {
    return (
      <div className="max-w-6xl mx-auto px-6 pb-12">
        <div className="pt-8 mb-8">
          <h1 className="text-3xl font-bold text-[var(--text-primary)] mb-2 tracking-tight">Telegram Setup</h1>
          <p className="text-lg text-[var(--text-secondary)]">Configure your Telegram bot to enable messaging.</p>
        </div>
        <div className="bg-[var(--bg-card)] rounded-2xl shadow-sm border border-[var(--border-subtle)] p-8 flex items-center gap-3 text-sm text-[var(--text-secondary)]">
          <Loader2 className="w-4 h-4 animate-spin text-[var(--text-tertiary)]" />
          Loading Telegram configuration...
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto px-6 pb-12">
      <div className="pt-8 mb-8">
        <h1 className="text-3xl font-bold text-[var(--text-primary)] mb-2 tracking-tight">Telegram Setup</h1>
        <p className="text-lg text-[var(--text-secondary)]">Configure your Telegram bot to enable messaging.</p>
      </div>

      <div className="grid grid-cols-1 gap-4">
        <ChannelGroup title="Telegram Bot">
          <div className="flex items-start gap-4">
            <div className="w-12 h-12 bg-[#0088cc] rounded-xl flex items-center justify-center text-white flex-shrink-0">
              <TelegramIcon className="w-6 h-6" />
            </div>
            <div className="flex-1">
              <div className="mb-4">
                <div className="flex items-center gap-3 mb-1">
                  <h3 className="text-lg font-bold">Telegram Bot</h3>
                  <TelegramConnectionStatus
                    tokenSaved={telegramTokenSaved}
                    connected={telegramConnected}
                    gatewayRunning={gatewayRunning}
                    checking={checkingConnection}
                  />
                </div>
                <p className="text-sm text-[var(--text-secondary)]">Connect your Telegram bot to enable messaging with your agent.</p>
                {telegramTokenSaved && (
                  <p className="text-xs text-[var(--text-tertiary)] mt-1">
                    If Telegram is not responding, try clicking "Save Bot Token" to reconnect.
                  </p>
                )}
              </div>

              <div className="mb-4 p-4 bg-blue-500/10 border border-blue-500/20 rounded-lg">
                <h4 className="text-sm font-semibold text-[var(--text-primary)] mb-2">Setup Instructions:</h4>
                <ol className="text-sm text-[var(--text-secondary)] space-y-1 list-decimal list-inside">
                  <li>Open Telegram and message <span className="font-mono bg-blue-500/15 px-1 rounded text-[var(--text-primary)]">@BotFather</span></li>
                  <li>Send <span className="font-mono bg-blue-500/15 px-1 rounded text-[var(--text-primary)]">/newbot</span> and follow prompts to create your bot</li>
                  <li>Copy the bot token and paste it below, then click "Save Bot Token"</li>
                  <li>Message your new bot and send <span className="font-mono bg-blue-500/15 px-1 rounded text-[var(--text-primary)]">/start</span></li>
                  <li>Check your Telegram messages for the pairing token, paste it below, then click "Approve"</li>
                </ol>
              </div>

              <div className="space-y-3">
                <div className="flex gap-2">
                  <input
                    type="password"
                    value={telegramToken}
                    onChange={(e) => setTelegramToken(e.target.value)}
                    placeholder="Bot token"
                    className="flex-1 px-4 py-2 bg-[var(--system-gray-6)] border-transparent rounded-lg focus:ring-2 focus:ring-[var(--system-blue)]/20 outline-none text-sm"
                  />
                  <button
                    onClick={() => saveMessagingSetup("token")}
                    disabled={savingSetup || telegramToken.trim().length === 0}
                    className="px-4 py-2 bg-[#1A1A2E] text-white rounded-lg text-sm font-semibold hover:opacity-80 disabled:opacity-50 flex items-center gap-2"
                  >
                    {savingSetup && <Loader2 className="w-4 h-4 animate-spin" />}
                    {savingSetup ? "Validating..." : "Save Bot Token"}
                  </button>
                </div>
                {saveError && <p className="text-sm text-red-500">{saveError}</p>}
                {saveMessage && (
                  <p className="text-sm text-green-500 flex items-center gap-1">
                    <CheckCircle2 className="w-4 h-4" />
                    {saveMessage}
                  </p>
                )}
                {restartPending && (
                  <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 flex items-center justify-between gap-3">
                    <p className="text-xs text-[var(--text-secondary)]">
                      Telegram changes are saved. Restart gateway to apply them now.
                    </p>
                    <button
                      type="button"
                      onClick={applyTelegramConfigNow}
                      disabled={restartingGateway}
                      className="px-3 py-1.5 bg-amber-700 text-white rounded-md text-xs font-semibold hover:bg-amber-800 disabled:opacity-50"
                    >
                      {restartingGateway ? "Restarting..." : "Apply now (Restart Gateway)"}
                    </button>
                  </div>
                )}

                {telegramTokenSaved && !telegramConnected && (
                  <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--system-gray-6)]/60 px-4 py-3 space-y-3">
                    <div className="flex items-start gap-2">
                      <div className="flex-1">
                        <p className="text-xs font-medium text-[var(--text-primary)] mb-1">
                          Awaiting authorization
                        </p>
                        <p className="text-xs text-[var(--text-secondary)]">
                          {gatewayRunning
                            ? "Message your bot on Telegram and send /start to receive a pairing code. Paste it below and click Approve."
                            : "Start the gateway, then message your bot on Telegram and send /start to receive a pairing code."}
                        </p>
                      </div>
                      {checkingConnection && (
                        <Loader2 className="w-4 h-4 animate-spin text-[var(--text-tertiary)] flex-shrink-0" />
                      )}
                    </div>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={telegramPairingCode}
                        onChange={(e) => setTelegramPairingCode(e.target.value)}
                        placeholder="Pairing code from Telegram"
                        className="flex-1 px-4 py-2 bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-lg focus:ring-2 focus:ring-[var(--system-blue)]/20 outline-none text-sm"
                      />
                      <button
                        onClick={approveTelegramPairing}
                        disabled={telegramPairingCode.trim().length === 0}
                        className="px-4 py-2 bg-[#1A1A2E] text-white rounded-lg text-sm font-semibold hover:opacity-80 disabled:opacity-50"
                      >
                        Approve
                      </button>
                    </div>
                    {telegramPairingStatus && <p className="text-xs text-[var(--text-tertiary)]">{telegramPairingStatus}</p>}
                    <button
                      onClick={disconnectTelegram}
                      disabled={savingSetup}
                      className="text-xs text-red-500 hover:text-red-400 transition-colors disabled:opacity-50 text-left"
                    >
                      Remove bot token
                    </button>
                  </div>
                )}

                {telegramTokenSaved && telegramConnected && (
                  <div className="rounded-lg border border-green-500/20 bg-green-500/10 px-4 py-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <CheckCircle2 className="w-4 h-4 text-green-500" />
                        <p className="text-xs font-medium text-[var(--text-primary)]">
                          Telegram bot is connected and ready to receive messages
                        </p>
                      </div>
                      <button
                        onClick={disconnectTelegram}
                        disabled={savingSetup}
                        className="px-3 py-1.5 text-xs font-medium rounded-lg text-red-500 hover:bg-red-500/10 transition-colors disabled:opacity-50 whitespace-nowrap"
                      >
                        Disconnect
                      </button>
                    </div>
                  </div>
                )}

                {telegramConnected && (
                  <details className="rounded-lg border border-[var(--border-subtle)] bg-[var(--system-gray-6)]/60">
                    <summary className="cursor-pointer list-none px-4 py-3 text-sm font-semibold text-[var(--text-primary)]">
                      <div className="flex items-center justify-between">
                        <span>Advanced Telegram Configuration</span>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setShowAdvancedHelp(true);
                          }}
                          className="w-6 h-6 rounded-full border border-[var(--border-subtle)] text-xs font-bold text-[var(--text-secondary)] hover:bg-[var(--bg-card)]"
                          aria-label="Explain advanced Telegram settings"
                          title="Explain advanced Telegram settings"
                        >
                          ?
                        </button>
                      </div>
                    </summary>
                    <div className="border-t border-[var(--border-subtle)] px-4 py-3 space-y-3">
                      <p className="text-xs text-[var(--text-secondary)]">
                        After changing advanced settings, click <span className="font-medium">Save Settings</span> to apply.
                      </p>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <label className="text-xs text-[var(--text-secondary)]">
                          DM Policy
                          <select
                            value={telegramDmPolicy}
                            onChange={(e) => setTelegramDmPolicy(normalizeTelegramDmPolicy(e.target.value))}
                            className="mt-1 w-full px-3 py-2 bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-md text-sm text-[var(--text-primary)]"
                          >
                            <option value="pairing">pairing</option>
                            <option value="allowlist">allowlist</option>
                            <option value="open">open</option>
                            <option value="disabled">disabled</option>
                          </select>
                        </label>
                        <label className="text-xs text-[var(--text-secondary)]">
                          Group Policy
                          <select
                            value={telegramGroupPolicy}
                            onChange={(e) => setTelegramGroupPolicy(normalizeTelegramGroupPolicy(e.target.value))}
                            className="mt-1 w-full px-3 py-2 bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-md text-sm text-[var(--text-primary)]"
                          >
                            <option value="allowlist">allowlist</option>
                            <option value="open">open</option>
                            <option value="disabled">disabled</option>
                          </select>
                        </label>
                        <label className="text-xs text-[var(--text-secondary)]">
                          Reply-To Mode
                          <select
                            value={telegramReplyToMode}
                            onChange={(e) => setTelegramReplyToMode(normalizeTelegramReplyToMode(e.target.value))}
                            className="mt-1 w-full px-3 py-2 bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-md text-sm text-[var(--text-primary)]"
                          >
                            <option value="off">off</option>
                            <option value="first">first</option>
                            <option value="all">all</option>
                          </select>
                        </label>
                      </div>

                      {telegramGroupPolicy === "allowlist" && (
                        <p className="text-xs text-[var(--text-secondary)]">
                          To add allowed groups, set entries under <span className="font-mono">channels.telegram.groups.&lt;chatId&gt;</span> in config.
                          Get <span className="font-mono">chatId</span> from Telegram logs/getUpdates.
                        </p>
                      )}

                      <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
                        <input
                          type="checkbox"
                          checked={telegramRequireMention}
                          onChange={(e) => setTelegramRequireMention(e.target.checked)}
                        />
                        Require mentions in groups
                      </label>
                      <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
                        <input
                          type="checkbox"
                          checked={telegramConfigWrites}
                          onChange={(e) => setTelegramConfigWrites(e.target.checked)}
                        />
                        Allow Telegram config writes
                      </label>
                      <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
                        <input
                          type="checkbox"
                          checked={telegramLinkPreview}
                          onChange={(e) => setTelegramLinkPreview(e.target.checked)}
                        />
                        Enable link previews in replies
                      </label>
                      <div className="flex justify-end pt-1">
                        <button
                          type="button"
                          onClick={() => saveMessagingSetup("settings")}
                          disabled={savingSetup || telegramToken.trim().length === 0}
                          className="px-4 py-2 bg-[#1A1A2E] text-white rounded-lg text-sm font-semibold hover:opacity-80 disabled:opacity-50"
                        >
                          {savingSetup ? "Saving..." : "Save Settings"}
                        </button>
                      </div>
                    </div>
                  </details>
                )}

              </div>
            </div>
          </div>
        </ChannelGroup>
      </div>

      {showAdvancedHelp && (
        <div
          className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
          onClick={() => setShowAdvancedHelp(false)}
          onKeyDown={(e) => { if (e.key === "Escape") setShowAdvancedHelp(false); }}
        >
          <div
            className="w-full max-w-xl bg-[var(--bg-card)] rounded-xl border border-[var(--border-subtle)] shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-3 border-b border-[var(--border-subtle)] flex items-center justify-between">
              <h3 className="text-sm font-semibold text-[var(--text-primary)]">Advanced Telegram Settings</h3>
              <button
                type="button"
                onClick={() => setShowAdvancedHelp(false)}
                className="text-xs px-2 py-1 rounded border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:bg-[var(--system-gray-6)]"
              >
                Close
              </button>
            </div>
            <div className="px-4 py-3 text-sm text-[var(--text-secondary)] space-y-2">
              <p><span className="font-medium text-[var(--text-primary)]">DM Policy:</span> Controls who can DM the bot. `pairing` requires approval code, `allowlist` only approved IDs, `open` allows all, `disabled` blocks DMs.</p>
              <p><span className="font-medium text-[var(--text-primary)]">Group Policy:</span> Controls sender rules inside groups. `allowlist` restricts to approved senders, `open` allows any sender, `disabled` ignores group messages.</p>
              <p><span className="font-medium text-[var(--text-primary)]">Reply-To Mode:</span> Controls how replies attach to threaded Telegram messages. `off` disables reply linkage, `first` replies to first relevant message, `all` preserves threaded replies broadly.</p>
              <p><span className="font-medium text-[var(--text-primary)]">Require Mentions:</span> When on, the bot responds in groups only when explicitly mentioned.</p>
              <p><span className="font-medium text-[var(--text-primary)]">Allow Telegram Config Writes:</span> Lets Telegram-side config commands modify gateway config (for example, `/config set`). Keep off for stricter control.</p>
              <p><span className="font-medium text-[var(--text-primary)]">Link Preview:</span> Enables or disables URL previews in bot replies.</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
