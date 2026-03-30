import { useEffect, useState } from "react";
import { Bot, CheckCircle2, Loader2, X } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";

type Props = {
  isOpen: boolean;
  onClose: () => void;
  onSetupComplete: () => void;
};

type SavedChannelsState = {
  discord_enabled?: boolean;
  discord_token?: string;
  telegram_enabled?: boolean;
  telegram_token?: string;
  telegram_dm_policy?: string;
  telegram_group_policy?: string;
  telegram_config_writes?: boolean;
  telegram_require_mention?: boolean;
  telegram_reply_to_mode?: string;
  telegram_link_preview?: boolean;
  slack_enabled?: boolean;
  slack_bot_token?: string;
  slack_app_token?: string;
  googlechat_enabled?: boolean;
  googlechat_service_account?: string;
  googlechat_audience_type?: string;
  googlechat_audience?: string;
  whatsapp_enabled?: boolean;
  whatsapp_allow_from?: string;
};

type GatewayMutationResult = {
  wsReconnectExpected: boolean;
};

export function TelegramSetupModal({ isOpen, onClose, onSetupComplete }: Props) {
  const [loadingState, setLoadingState] = useState(false);
  const [savingToken, setSavingToken] = useState(false);
  const [approvingPairing, setApprovingPairing] = useState(false);
  const [token, setToken] = useState("");
  const [tokenSaved, setTokenSaved] = useState(false);
  const [pairingCode, setPairingCode] = useState("");
  const [connected, setConnected] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setLoadingState(true);
    setErrorMsg(null);
    setStatusMsg(null);
    Promise.all([
      invoke<SavedChannelsState>("get_saved_channels_state"),
      invoke<boolean>("get_telegram_connection_status").catch(() => false),
    ])
      .then(([state, telegramConnected]) => {
        if (cancelled) return;
        setToken(state.telegram_token?.trim() || "");
        setTokenSaved(Boolean(state.telegram_enabled && state.telegram_token?.trim()));
        setConnected(Boolean(telegramConnected));
        if (telegramConnected) {
          setStatusMsg("Telegram is already connected.");
        }
      })
      .catch((err) => {
        if (cancelled) return;
        const detail = err instanceof Error ? err.message : String(err);
        setErrorMsg(`Failed to load Telegram setup: ${detail}`);
      })
      .finally(() => {
        if (!cancelled) setLoadingState(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  async function verifyConnection() {
    setLoadingState(true);
    setErrorMsg(null);
    try {
      const telegramConnected = await invoke<boolean>("get_telegram_connection_status").catch(() => false);
      setConnected(Boolean(telegramConnected));
      if (telegramConnected) {
        setStatusMsg("Telegram connected.");
        onSetupComplete();
        return;
      }
      setStatusMsg("Telegram is not connected yet. Complete pairing in Telegram, then retry.");
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      setErrorMsg(`Failed to verify Telegram connection: ${detail}`);
    } finally {
      setLoadingState(false);
    }
  }

  async function saveTelegramTokenFromChat() {
    const trimmedToken = token.trim();
    if (!trimmedToken) return;
    setSavingToken(true);
    setErrorMsg(null);
    setStatusMsg(null);
    try {
      const validation = await invoke<{
        valid: boolean;
        username?: string | null;
        message: string;
      }>("validate_telegram_token", { token: trimmedToken });
      if (!validation.valid) {
        setErrorMsg(`Invalid bot token: ${validation.message}`);
        return;
      }

      const state = await invoke<SavedChannelsState>("get_saved_channels_state");

      const result = await invoke<GatewayMutationResult>("apply_gateway_mutation", {
        request: {
          channels: {
            discordEnabled: state.discord_enabled ?? false,
            discordToken: state.discord_token ?? "",
            telegramEnabled: true,
            telegramToken: trimmedToken,
            telegramDmPolicy: state.telegram_dm_policy ?? "pairing",
            telegramGroupPolicy: state.telegram_group_policy ?? "allowlist",
            telegramConfigWrites: state.telegram_config_writes ?? false,
            telegramRequireMention: state.telegram_require_mention ?? true,
            telegramReplyToMode: state.telegram_reply_to_mode ?? "off",
            telegramLinkPreview: state.telegram_link_preview ?? true,
            slackEnabled: state.slack_enabled ?? false,
            slackBotToken: state.slack_bot_token ?? "",
            slackAppToken: state.slack_app_token ?? "",
            googlechatEnabled: state.googlechat_enabled ?? false,
            googlechatServiceAccount: state.googlechat_service_account ?? "",
            googlechatAudienceType: state.googlechat_audience_type ?? "app-url",
            googlechatAudience: state.googlechat_audience ?? "",
            whatsappEnabled: state.whatsapp_enabled ?? false,
            whatsappAllowFrom: state.whatsapp_allow_from ?? "",
          },
        },
      });

      setTokenSaved(true);
      const botHandle = validation.username?.trim() ? ` (@${validation.username.trim()})` : "";

      const gatewayRunning = await invoke<boolean>("get_gateway_status").catch(() => false);
      if (gatewayRunning) {
        setStatusMsg(
          result.wsReconnectExpected
            ? `Bot token saved${botHandle}. Gateway is reloading Telegram configuration. Send /start to your bot and paste the pairing code below.`
            : `Bot token saved${botHandle}. Send /start to your bot and paste the pairing code below.`,
        );
      } else {
        setStatusMsg(
          `Bot token saved${botHandle}. Starting gateway. Send /start to your bot and paste the pairing code below.`,
        );
        window.dispatchEvent(new CustomEvent("entropic-start-gateway"));
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      setErrorMsg(`Failed to save bot token: ${detail}`);
    } finally {
      setSavingToken(false);
    }
  }

  async function approveTelegramPairingFromChat() {
    const code = pairingCode.trim();
    if (!code) return;
    setApprovingPairing(true);
    setErrorMsg(null);
    setStatusMsg(null);
    try {
      const result = await invoke<string>("approve_pairing", {
        channel: "telegram",
        code,
      });
      setPairingCode("");
      setStatusMsg(result || "Pairing approved.");
      setConnected(true);
      invoke("send_telegram_welcome_message").catch(() => {
        // Non-fatal. Pairing already succeeded.
      });
      onSetupComplete();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      setErrorMsg(`Failed to approve pairing: ${detail}`);
    } finally {
      setApprovingPairing(false);
    }
  }

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 bg-black/25 flex items-center justify-center z-50 p-4"
      onClick={onClose}
      onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
    >
      <div
        className="w-full max-w-md rounded-2xl bg-[var(--bg-card)] border border-[var(--border-subtle)] shadow-xl p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-[#0088cc] flex items-center justify-center text-white">
              <Bot className="w-4 h-4" />
            </div>
            <h3 className="text-lg font-semibold text-[var(--text-primary)]">Setup Telegram messaging</h3>
          </div>
          <button onClick={onClose} aria-label="Close" className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)]">
            <X className="w-5 h-5" />
          </button>
        </div>

        {loadingState ? (
          <div className="py-8 text-center">
            <Loader2 className="w-6 h-6 animate-spin mx-auto mb-2 text-[var(--text-tertiary)]" />
            <p className="text-sm text-[var(--text-secondary)]">Loading Telegram setup...</p>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-[var(--text-secondary)]">
              1) Create a bot via @BotFather, 2) paste token, 3) save, 4) send /start to your bot, 5) paste pairing code.
            </p>

            <div className="flex gap-2">
              <input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="Telegram bot token"
                className="form-input flex-1 !py-2"
              />
              <button
                onClick={saveTelegramTokenFromChat}
                disabled={savingToken || token.trim().length === 0}
                className="btn-primary !text-xs !py-2"
              >
                {savingToken ? "Saving..." : "Save token"}
              </button>
            </div>

            {tokenSaved ? (
              <div className="flex gap-2">
                <input
                  type="text"
                  value={pairingCode}
                  onChange={(e) => setPairingCode(e.target.value)}
                  placeholder="Pairing code"
                  className="form-input flex-1 !py-2"
                />
                <button
                  onClick={approveTelegramPairingFromChat}
                  disabled={approvingPairing || pairingCode.trim().length === 0}
                  className="btn-secondary !text-xs !py-2"
                >
                  {approvingPairing ? "Approving..." : "Approve"}
                </button>
              </div>
            ) : null}

            {errorMsg ? <p className="text-xs text-red-500">{errorMsg}</p> : null}
            {statusMsg ? (
              <p className="text-xs text-green-500 flex items-center gap-1">
                <CheckCircle2 className="w-3.5 h-3.5" />
                {statusMsg}
              </p>
            ) : null}

            <div className="flex gap-2 pt-1">
              <button onClick={verifyConnection} disabled={loadingState} className="btn-secondary !text-xs !py-1.5 disabled:opacity-50">
                Check connection
              </button>
              {connected ? (
                <button onClick={onSetupComplete} className="btn-primary !text-xs !py-1.5">
                  Use Telegram now
                </button>
              ) : null}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
