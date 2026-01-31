import { useEffect, useRef, useState } from "react";
import { MessageCircle } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import clsx from "clsx";

export function Channels() {
  const [discordEnabled, setDiscordEnabled] = useState(false);
  const [discordToken, setDiscordToken] = useState("");
  const [telegramEnabled, setTelegramEnabled] = useState(false);
  const [telegramToken, setTelegramToken] = useState("");
  const [telegramPairingCode, setTelegramPairingCode] = useState("");
  const [telegramPairingStatus, setTelegramPairingStatus] = useState<string | null>(null);
  const [whatsappEnabled, setWhatsappEnabled] = useState(false);
  const [whatsappAllowFrom, setWhatsappAllowFrom] = useState("");
  const [whatsappQr, setWhatsappQr] = useState<string | null>(null);
  const [whatsappMessage, setWhatsappMessage] = useState<string | null>(null);
  const [whatsappLoading, setWhatsappLoading] = useState(false);
  const [whatsappStatus, setWhatsappStatus] = useState<string | null>(null);
  const [whatsappError, setWhatsappError] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);
  const [imessageEnabled, setImessageEnabled] = useState(false);
  const [imessageCliPath, setImessageCliPath] = useState("/usr/local/bin/imsg");
  const [imessageDbPath, setImessageDbPath] = useState("");
  const [imessageRemoteHost, setImessageRemoteHost] = useState("");
  const [imessageIncludeAttachments, setImessageIncludeAttachments] = useState(true);
  const [savingChannels, setSavingChannels] = useState(false);
  const [savingIMessage, setSavingIMessage] = useState(false);

  useEffect(() => {
    invoke<{
      discord_enabled: boolean;
      discord_token: string;
      telegram_enabled: boolean;
      telegram_token: string;
      whatsapp_enabled: boolean;
      whatsapp_allow_from: string;
      imessage_enabled: boolean;
      imessage_cli_path: string;
      imessage_db_path: string;
      imessage_remote_host: string;
      imessage_include_attachments: boolean;
    }>("get_agent_profile_state")
      .then((state) => {
        setDiscordEnabled(state.discord_enabled ?? false);
        setDiscordToken(state.discord_token || "");
        setTelegramEnabled(state.telegram_enabled ?? false);
        setTelegramToken(state.telegram_token || "");
        setWhatsappEnabled(state.whatsapp_enabled ?? false);
        setWhatsappAllowFrom(state.whatsapp_allow_from || "");
        setImessageEnabled(state.imessage_enabled ?? false);
        setImessageCliPath(state.imessage_cli_path || "/usr/local/bin/imsg");
        setImessageDbPath(state.imessage_db_path || "");
        setImessageRemoteHost(state.imessage_remote_host || "");
        setImessageIncludeAttachments(state.imessage_include_attachments ?? true);
      })
      .catch(() => {});
  }, []);

  async function saveChannels() {
    setSavingChannels(true);
    try {
      await invoke("set_channels_config", {
        discordEnabled,
        discordToken,
        telegramEnabled,
        telegramToken,
        whatsappEnabled,
        whatsappAllowFrom,
      });
    } finally {
      setSavingChannels(false);
    }
  }

  async function approveTelegramPairing() {
    setTelegramPairingStatus(null);
    try {
      const result = await invoke<string>("approve_pairing", {
        channel: "telegram",
        code: telegramPairingCode,
      });
      setTelegramPairingStatus(result || "Pairing approved.");
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      setTelegramPairingStatus(`Failed to approve pairing: ${detail}`);
    }
  }

  async function fetchWhatsAppLogin() {
    try {
      const result = await invoke<{
        status: string;
        message: string;
        qr_data_url?: string | null;
        connected?: boolean | null;
        last_error?: string | null;
        error_status?: number | null;
      }>("get_whatsapp_login");
      setWhatsappMessage(result.message || null);
      setWhatsappQr(result.qr_data_url ?? null);
      if (result.connected) {
        setWhatsappStatus("Connected");
      }
      if (result.error_status === 515) {
        // 515 means WhatsApp requested a stream restart after pairing.
        // The backend handles this automatically - do NOT restart the gateway
        // as that would destroy the pairing session. Just show status and wait.
        setWhatsappStatus("WhatsApp connection restarting (normal after scan)...");
        // Continue polling - backend will recover automatically
      }
      setWhatsappError(result.last_error ?? null);
      return result;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      if (detail.toLowerCase().includes("connection refused")) {
        setWhatsappStatus("Gateway restarting... retrying");
      } else {
        setWhatsappError(detail);
      }
      return null;
    }
  }

  function startWhatsAppPolling() {
    if (pollRef.current) return;
    pollRef.current = window.setInterval(async () => {
      const result = await fetchWhatsAppLogin();
      if (result?.qr_data_url || result?.connected) {
        setWhatsappLoading(false);
      }
    }, 2000);
  }

  function stopWhatsAppPolling() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  async function showWhatsAppQr(force = false) {
    setWhatsappLoading(true);
    setWhatsappStatus(null);
    setWhatsappError(null);
    try {
      await invoke("start_whatsapp_login", { force, timeout_ms: 8000 });
      await fetchWhatsAppLogin();
      startWhatsAppPolling();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      setWhatsappMessage(
        `Could not generate QR. Make sure the gateway is running. ${detail}`,
      );
      setWhatsappQr(null);
      setWhatsappError(detail);
    } finally {
      if (!whatsappQr) setWhatsappLoading(false);
    }
  }

  useEffect(() => {
    startWhatsAppPolling();
    return () => stopWhatsAppPolling();
  }, []);

  async function checkWhatsAppLogin() {
    setWhatsappLoading(true);
    try {
      const result = await fetchWhatsAppLogin();
      if (result?.connected) {
        setWhatsappStatus("Connected");
      } else if (result?.message) {
        setWhatsappStatus(result.message);
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      setWhatsappStatus(`Still waiting for scan. ${detail}`);
    } finally {
      setWhatsappLoading(false);
    }
  }

  async function saveIMessage() {
    setSavingIMessage(true);
    try {
      await invoke("set_imessage_config", {
        enabled: imessageEnabled,
        cliPath: imessageCliPath,
        dbPath: imessageDbPath,
        remoteHost: imessageRemoteHost,
        includeAttachments: imessageIncludeAttachments,
      });
    } finally {
      setSavingIMessage(false);
    }
  }

  return (
    <div className="p-6">
      <div className="max-w-3xl space-y-6">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Channels</h1>
          <p className="text-sm text-gray-500">
            Connect your agent to the apps people already use.
          </p>
        </div>

        <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-gray-100 flex items-center justify-center">
              <MessageCircle className="w-5 h-5 text-gray-500" />
            </div>
            <div>
              <p className="font-medium text-gray-900">How this works</p>
              <p className="text-sm text-gray-500">
                Turn on a channel, paste its token or setup path, then save. All
                channels use pairing by default so random people can’t message your
                agent.
              </p>
            </div>
          </div>
        </div>

        <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-4">
          <h2 className="text-lg font-semibold text-gray-900">WhatsApp</h2>
          <ol className="text-sm text-gray-600 list-decimal pl-5 space-y-1">
            <li>Enable WhatsApp below and save.</li>
            <li>Click “Show QR” and scan it in WhatsApp → Linked Devices.</li>
            <li>Message your agent from WhatsApp to pair.</li>
          </ol>
          <label className="flex items-center gap-3 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={whatsappEnabled}
              onChange={(e) => setWhatsappEnabled(e.target.checked)}
            />
            Enable WhatsApp
          </label>
          <input
            type="text"
            value={whatsappAllowFrom}
            onChange={(e) => setWhatsappAllowFrom(e.target.value)}
            placeholder="Your phone number (E.164, optional)"
            className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-violet-500"
          />
          <p className="text-xs text-gray-500">
            If you add your number, WhatsApp uses an allowlist. Otherwise it uses
            pairing by default.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => showWhatsAppQr(false)}
              disabled={whatsappLoading}
              className={clsx(
                "px-3 py-2 text-sm rounded-lg font-medium",
                whatsappLoading
                  ? "bg-gray-200 text-gray-500"
                  : "bg-violet-600 text-white hover:bg-violet-700"
              )}
            >
              {whatsappLoading ? "Loading..." : "Show QR"}
            </button>
            <button
              onClick={() => showWhatsAppQr(true)}
              disabled={whatsappLoading}
              className="px-3 py-2 text-sm rounded-lg font-medium bg-gray-100 text-gray-700 hover:bg-gray-200"
            >
              Refresh QR
            </button>
            <button
              onClick={checkWhatsAppLogin}
              disabled={whatsappLoading}
              className="px-3 py-2 text-sm rounded-lg font-medium bg-gray-100 text-gray-700 hover:bg-gray-200"
            >
              Check status
            </button>
          </div>
          {whatsappMessage && (
            <p className="text-xs text-gray-500">{whatsappMessage}</p>
          )}
          {whatsappStatus && (
            <p className="text-xs text-gray-600 font-medium">{whatsappStatus}</p>
          )}
          {whatsappError && (
            <p className="text-xs text-red-600">{whatsappError}</p>
          )}
          {whatsappQr && (
            <div className="mt-3 flex justify-center">
              <img
                src={whatsappQr}
                alt="WhatsApp QR"
                className="w-56 h-56 border border-gray-200 rounded-lg"
              />
            </div>
          )}
        </div>

        <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-4">
          <h2 className="text-lg font-semibold text-gray-900">Discord</h2>
          <ol className="text-sm text-gray-600 list-decimal pl-5 space-y-1">
            <li>Create a Discord bot in the Developer Portal.</li>
            <li>Enable “Message Content Intent”.</li>
            <li>Invite the bot to your server.</li>
            <li>Paste the bot token below and save.</li>
          </ol>
          <label className="flex items-center gap-3 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={discordEnabled}
              onChange={(e) => setDiscordEnabled(e.target.checked)}
            />
            Enable Discord
          </label>
          <input
            type="password"
            value={discordToken}
            onChange={(e) => setDiscordToken(e.target.value)}
            placeholder="Discord bot token"
            className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-violet-500"
          />
        </div>

        <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-4">
          <h2 className="text-lg font-semibold text-gray-900">Telegram</h2>
          <ol className="text-sm text-gray-600 list-decimal pl-5 space-y-1">
            <li>Open Telegram and chat with @BotFather.</li>
            <li>Run /newbot and copy the token.</li>
            <li>Paste the token below and save.</li>
            <li>Send a message to your bot to receive a pairing code.</li>
            <li>Enter the pairing code here to approve.</li>
          </ol>
          <label className="flex items-center gap-3 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={telegramEnabled}
              onChange={(e) => setTelegramEnabled(e.target.checked)}
            />
            Enable Telegram
          </label>
          <input
            type="password"
            value={telegramToken}
            onChange={(e) => setTelegramToken(e.target.value)}
            placeholder="BotFather token"
            className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-violet-500"
          />
          <div className="flex gap-2">
            <input
              type="text"
              value={telegramPairingCode}
              onChange={(e) => setTelegramPairingCode(e.target.value)}
              placeholder="Pairing code"
              className="flex-1 px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-violet-500"
            />
            <button
              onClick={approveTelegramPairing}
              className="px-3 py-2 text-sm rounded-lg font-medium bg-gray-100 text-gray-700 hover:bg-gray-200"
            >
              Approve
            </button>
          </div>
          {telegramPairingStatus && (
            <p className="text-xs text-gray-600">{telegramPairingStatus}</p>
          )}
        </div>

        <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-4">
          <h2 className="text-lg font-semibold text-gray-900">iMessage</h2>
          <ol className="text-sm text-gray-600 list-decimal pl-5 space-y-1">
            <li>Install <code>imsg</code> on a Mac (brew install steipete/tap/imsg).</li>
            <li>Allow Full Disk Access + Automation on first use.</li>
            <li>Paste the paths below and save.</li>
          </ol>
          <label className="flex items-center gap-3 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={imessageEnabled}
              onChange={(e) => setImessageEnabled(e.target.checked)}
            />
            Enable iMessage
          </label>
          <div className="space-y-3">
            <input
              type="text"
              value={imessageCliPath}
              onChange={(e) => setImessageCliPath(e.target.value)}
              placeholder="/usr/local/bin/imsg"
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-violet-500"
            />
            <input
              type="text"
              value={imessageDbPath}
              onChange={(e) => setImessageDbPath(e.target.value)}
              placeholder="/Users/you/Library/Messages/chat.db"
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-violet-500"
            />
            <input
              type="text"
              value={imessageRemoteHost}
              onChange={(e) => setImessageRemoteHost(e.target.value)}
              placeholder="user@mac-mini.local (optional)"
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-violet-500"
            />
            <label className="flex items-center gap-3 text-sm text-gray-700">
              <input
                type="checkbox"
                checked={imessageIncludeAttachments}
                onChange={(e) => setImessageIncludeAttachments(e.target.checked)}
              />
              Include attachments
            </label>
          </div>
          <p className="text-xs text-gray-500">
            If Zara runs in Colima/Docker, set the CLI path to an SSH wrapper that
            runs <code>imsg rpc</code> on your Mac.
          </p>
        </div>

        <div className="flex justify-end gap-2">
          <button
            onClick={saveIMessage}
            disabled={savingIMessage}
            className={clsx(
              "px-4 py-2 text-sm rounded-lg font-medium",
              savingIMessage
                ? "bg-gray-200 text-gray-500"
                : "bg-gray-100 text-gray-700 hover:bg-gray-200"
            )}
          >
            {savingIMessage ? "Saving..." : "Save iMessage"}
          </button>
          <button
            onClick={saveChannels}
            disabled={savingChannels}
            className={clsx(
              "px-4 py-2 text-sm rounded-lg font-medium",
              savingChannels
                ? "bg-gray-200 text-gray-500"
                : "bg-violet-600 text-white hover:bg-violet-700"
            )}
          >
            {savingChannels ? "Saving..." : "Save channels"}
          </button>
        </div>
      </div>
    </div>
  );
}
