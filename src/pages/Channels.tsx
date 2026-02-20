import { useEffect, useState, type ReactNode } from "react";
import {
  CheckCircle2,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";

function ChannelGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mb-10">
      <h2 className="text-xl font-bold text-[var(--text-primary)] mb-4">{title}</h2>
      <div className="bg-white rounded-2xl shadow-sm border border-[var(--border-subtle)] p-6 space-y-6">
        {children}
      </div>
    </div>
  );
}

function ToggleSwitch({ checked, onChange }: { checked: boolean; onChange: (next: boolean) => void }) {
  return (
    <label className="relative inline-flex items-center cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="sr-only peer"
      />
      <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-[var(--system-blue)]" />
    </label>
  );
}

function SetupStateBadge({ enabled, ready }: { enabled: boolean; ready: boolean }) {
  if (!enabled) {
    return (
      <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded-md bg-[var(--system-gray-6)] text-[var(--text-tertiary)]">
        Off
      </span>
    );
  }
  if (ready) {
    return (
      <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded-md bg-green-50 text-green-700">
        Ready
      </span>
    );
  }
  return (
    <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded-md bg-amber-50 text-amber-700">
      Needs Setup
    </span>
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

export function Channels() {
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

  const [savingSetup, setSavingSetup] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

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
    invoke<{
      telegram_enabled: boolean;
      telegram_token: string;
      telegram_dm_policy?: string;
      telegram_group_policy?: string;
      telegram_config_writes?: boolean;
      telegram_require_mention?: boolean;
      telegram_reply_to_mode?: string;
      telegram_link_preview?: boolean;
    }>("get_agent_profile_state")
      .then((state) => {
        setTelegramEnabled(state.telegram_enabled ?? false);
        setTelegramToken(state.telegram_token || "");
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
        setTelegramTokenSaved(Boolean(state.telegram_token?.trim()));

        // Auto-configure runtime if Telegram is enabled with a token
        if (state.telegram_enabled && state.telegram_token?.trim()) {
          console.log("[Channels] Auto-configuring Telegram on startup");
          autoConfigureTelegram({
            enabled: state.telegram_enabled,
            token: state.telegram_token,
            dmPolicy,
            groupPolicy,
            configWrites,
            requireMention,
            replyToMode,
            linkPreview,
          });
        }
        refreshTelegramConnectedStatus();
        refreshGatewayRunningStatus();
      })
      .catch(() => {});
  }, []);

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
      await invoke("set_channels_config", {
        discordEnabled: false,
        discordToken: "",
        telegramEnabled: params.enabled,
        telegramToken: params.token,
        telegramDmPolicy: params.dmPolicy,
        telegramGroupPolicy: params.groupPolicy,
        telegramConfigWrites: params.configWrites,
        telegramRequireMention: params.requireMention,
        telegramReplyToMode: params.replyToMode,
        telegramLinkPreview: params.linkPreview,
        slackEnabled: false,
        slackBotToken: "",
        slackAppToken: "",
        googlechatEnabled: false,
        googlechatServiceAccount: "",
        googlechatAudienceType: "app-url",
        googlechatAudience: "",
        whatsappEnabled: false,
        whatsappAllowFrom: "",
      });
      console.log("[Channels] Auto-configuration succeeded");
    } catch (err) {
      console.error("[Channels] Auto-configuration failed:", err);
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
        validationResult = await invoke<TelegramTokenValidationResult>("validate_telegram_token", {
          token: telegramToken,
        });
        if (!validationResult.valid) {
          setSaveError(`Invalid bot token: ${validationResult.message}`);
          return;
        }
      }

      console.log("[Channels] Invoking set_channels_config...");
      await invoke("set_channels_config", {
        discordEnabled: false,
        discordToken: "",
        telegramEnabled,
        telegramToken,
        telegramDmPolicy,
        telegramGroupPolicy,
        telegramConfigWrites,
        telegramRequireMention,
        telegramReplyToMode,
        telegramLinkPreview,
        slackEnabled: false,
        slackBotToken: "",
        slackAppToken: "",
        googlechatEnabled: false,
        googlechatServiceAccount: "",
        googlechatAudienceType: "app-url",
        googlechatAudience: "",
        whatsappEnabled: false,
        whatsappAllowFrom: "",
      });
      console.log("[Channels] set_channels_config succeeded");
      setTelegramTokenSaved(Boolean(telegramToken.trim()));
      const [connected, running] = await Promise.all([
        refreshTelegramConnectedStatus(),
        refreshGatewayRunningStatus(),
      ]);
      setTelegramConnected(Boolean(connected));
      setGatewayRunning(Boolean(running));
      setRestartPending(Boolean(running));
      if (target === "token") {
        const botHandle = validationResult?.username?.trim() ? ` for @${validationResult.username.trim()}` : "";
        setSaveMessage(
          running
            ? `Bot token saved${botHandle}. Check Telegram messages from your new bot for your pairing token. Restart gateway to apply changes.`
            : `Bot token saved${botHandle}. Check Telegram messages from your new bot for your pairing token.`
        );
      } else {
        setSaveMessage(
          running
            ? "Telegram settings saved. Restart gateway to apply changes."
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
      await invoke("restart_gateway_in_place");
      setRestartPending(false);
      const [connected, running] = await Promise.all([
        refreshTelegramConnectedStatus(),
        refreshGatewayRunningStatus(),
      ]);
      setTelegramConnected(Boolean(connected));
      setGatewayRunning(Boolean(running));
      setSaveMessage(
        running
          ? "Gateway restarted. Telegram configuration is now active."
          : "Gateway restart requested. It may take a few seconds to become healthy."
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
      const connected = await invoke<boolean>("get_telegram_connection_status").catch(() => true);
      setTelegramConnected(Boolean(connected));
      setTelegramPairingCode("");
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error("[Channels] approve_pairing failed:", detail);
      setTelegramPairingStatus(`Failed to approve pairing: ${detail}`);
    }
  }

  const telegramReady = telegramEnabled && telegramToken.trim().length > 0;

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
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h3 className="text-lg font-bold">Telegram Bot</h3>
                  <p className="text-sm text-[var(--text-secondary)]">Connect your Telegram bot to enable messaging with Joulie.</p>
                </div>
                <div className="flex items-center gap-3">
                  <SetupStateBadge enabled={telegramEnabled} ready={telegramReady} />
                  <ToggleSwitch checked={telegramEnabled} onChange={setTelegramEnabled} />
                </div>
              </div>

              <div className="mb-4 p-4 bg-blue-50 border border-blue-200 rounded-lg">
                <h4 className="text-sm font-semibold text-blue-900 mb-2">Setup Instructions:</h4>
                <ol className="text-sm text-blue-800 space-y-1 list-decimal list-inside">
                  <li>Open Telegram and message <span className="font-mono bg-blue-100 px-1 rounded">@BotFather</span></li>
                  <li>Send <span className="font-mono bg-blue-100 px-1 rounded">/newbot</span> and follow prompts to create your bot</li>
                  <li>Copy the bot token and paste it below</li>
                  <li>Enable the toggle above and click "Save Bot Token"</li>
                  <li>Message your new bot and send <span className="font-mono bg-blue-100 px-1 rounded">/start</span></li>
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
                    className="px-4 py-2 bg-black text-white rounded-lg text-sm font-semibold hover:bg-gray-800 disabled:opacity-50"
                  >
                    {savingSetup ? "Saving..." : "Save Bot Token"}
                  </button>
                </div>
                {saveError && <p className="text-sm text-red-600">{saveError}</p>}
                {saveMessage && (
                  <p className="text-sm text-green-700 flex items-center gap-1">
                    <CheckCircle2 className="w-4 h-4" />
                    {saveMessage}
                  </p>
                )}
                {restartPending && (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 flex items-center justify-between gap-3">
                    <p className="text-xs text-amber-800">
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
                {!gatewayRunning && telegramTokenSaved && (
                  <p className="text-xs text-[var(--text-secondary)]">
                    Gateway is currently stopped. Saved changes apply automatically the next time it starts.
                  </p>
                )}

                {telegramTokenSaved && (
                  <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--system-gray-6)]/60 px-4 py-3 space-y-3">
                    <p className="text-xs text-[var(--text-secondary)]">
                      Check your Telegram messages with the new bot and paste the pairing token below.
                    </p>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={telegramPairingCode}
                        onChange={(e) => setTelegramPairingCode(e.target.value)}
                        placeholder="Pairing code"
                        className="flex-1 px-4 py-2 bg-white border border-[var(--border-subtle)] rounded-lg focus:ring-2 focus:ring-[var(--system-blue)]/20 outline-none text-sm"
                      />
                      <button
                        onClick={approveTelegramPairing}
                        disabled={telegramPairingCode.trim().length === 0}
                        className="px-4 py-2 bg-black text-white rounded-lg text-sm font-semibold hover:bg-gray-800 disabled:opacity-50"
                      >
                        Approve
                      </button>
                    </div>
                    {telegramPairingStatus && <p className="text-xs text-[var(--text-tertiary)]">{telegramPairingStatus}</p>}
                  </div>
                )}

                {!telegramConnected && telegramTokenSaved && (
                  <p className="text-xs text-[var(--text-secondary)]">
                    Advanced Telegram configuration will appear after Telegram pairing is connected.
                  </p>
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
                          className="w-6 h-6 rounded-full border border-[var(--border-subtle)] text-xs font-bold text-[var(--text-secondary)] hover:bg-white"
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
                            className="mt-1 w-full px-3 py-2 bg-white border border-[var(--border-subtle)] rounded-md text-sm text-[var(--text-primary)]"
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
                            className="mt-1 w-full px-3 py-2 bg-white border border-[var(--border-subtle)] rounded-md text-sm text-[var(--text-primary)]"
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
                            className="mt-1 w-full px-3 py-2 bg-white border border-[var(--border-subtle)] rounded-md text-sm text-[var(--text-primary)]"
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
                          className="px-4 py-2 bg-black text-white rounded-lg text-sm font-semibold hover:bg-gray-800 disabled:opacity-50"
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
        >
          <div
            className="w-full max-w-xl bg-white rounded-xl border border-[var(--border-subtle)] shadow-xl"
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
