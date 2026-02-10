import { useEffect, useRef, useState } from "react";
import { MessageCircle, CheckCircle2, QrCode, RefreshCw, MessageSquare, Smartphone } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import clsx from "clsx";

function ChannelGroup({ title, children }: { title: string, children: React.ReactNode }) {
  return (
    <div className="mb-10">
      <h2 className="text-xl font-bold text-[var(--text-primary)] mb-4">{title}</h2>
      <div className="bg-white rounded-2xl shadow-sm border border-[var(--border-subtle)] p-6 space-y-6">
        {children}
      </div>
    </div>
  );
}

const DiscordIcon = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" className={className} fill="currentColor">
    <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/>
  </svg>
);

const TelegramIcon = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" className={className} fill="currentColor">
    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.64 6.8c-.15 1.58-.8 5.42-1.13 7.19-.14.75-.42 1-.68 1.03-.58.05-1.02-.38-1.58-.75-.88-.58-1.38-.94-2.23-1.5-.99-.65-.35-1.01.22-1.66.15-.17 2.71-2.48 2.76-2.69.01-.03.01-.14-.07-.18-.08-.04-.19-.03-.27-.01-.11.02-1.82 1.15-5.14 2.3-.49.17-.93.25-1.33.24-.44-.01-1.29-.25-1.92-.45-.77-.25-1.38-.39-1.33-.82.03-.23.34-.46.94-.7 3.68-1.6 6.13-2.66 7.35-3.17 3.5-.14 4.22.11 4.23.11.01.01.03.01.03.02z"/>
  </svg>
);

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
        setWhatsappStatus("WhatsApp connection restarting (normal after scan)...");
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
      setWhatsappMessage(`Could not generate QR. ${detail}`);
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
    <div className="max-w-6xl mx-auto px-6 pb-12">
      <div className="pt-8 mb-8">
        <h1 className="text-3xl font-bold text-[var(--text-primary)] mb-2 tracking-tight">Channels</h1>
        <p className="text-lg text-[var(--text-secondary)]">Connect your agent to messaging apps.</p>
      </div>

      <div className="bg-white rounded-2xl shadow-sm border border-[var(--border-subtle)] p-6 mb-8 flex items-center gap-4">
        <div className="w-12 h-12 rounded-xl bg-[var(--system-gray-6)] flex items-center justify-center text-[var(--system-blue)]">
          <MessageCircle className="w-6 h-6" />
        </div>
        <div>
          <p className="font-semibold text-[var(--text-primary)]">Unified Connectivity</p>
          <p className="text-sm text-[var(--text-secondary)]">
            Enable channels below to allow your agent to communicate via mobile apps.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4">
        
        {/* WhatsApp */}
        <ChannelGroup title="WhatsApp">
          <div className="flex items-start gap-4">
            <div className="w-12 h-12 bg-green-500 rounded-xl flex items-center justify-center text-white flex-shrink-0">
              <MessageSquare className="w-6 h-6" />
            </div>
            <div className="flex-1">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h3 className="text-lg font-bold">WhatsApp Messenger</h3>
                  <p className="text-sm text-[var(--text-secondary)]">Connect via QR code scan.</p>
                </div>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input type="checkbox" checked={whatsappEnabled} onChange={(e) => setWhatsappEnabled(e.target.checked)} className="sr-only peer" />
                  <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-[var(--system-blue)]"></div>
                </label>
              </div>

              <div className="space-y-4">
                <input
                  type="text"
                  value={whatsappAllowFrom}
                  onChange={(e) => setWhatsappAllowFrom(e.target.value)}
                  placeholder="Your phone number (E.164, optional)"
                  className="w-full px-4 py-2 bg-[var(--system-gray-6)] border-transparent rounded-lg focus:ring-2 focus:ring-[var(--system-blue)]/20 outline-none text-sm"
                />
                
                <div className="flex gap-2">
                  <button onClick={() => showWhatsAppQr(false)} disabled={whatsappLoading} className="btn btn-primary bg-black text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-gray-800 disabled:opacity-50">
                    {whatsappLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <QrCode className="w-4 h-4 mr-2" />}
                    Show QR Code
                  </button>
                  <button onClick={() => showWhatsAppQr(true)} className="btn btn-secondary px-4 py-2 border border-[var(--border-subtle)] rounded-lg text-sm font-semibold hover:bg-[var(--system-gray-6)]">
                    <RefreshCw className="w-4 h-4 mr-2" />
                    Refresh
                  </button>
                </div>

                {whatsappStatus && <p className="text-sm font-medium text-green-600 flex items-center gap-1"><CheckCircle2 className="w-4 h-4" /> {whatsappStatus}</p>}
                {whatsappError && <p className="text-sm text-red-500">{whatsappError}</p>}
                
                {whatsappQr && (
                  <div className="mt-4 p-4 bg-white border border-[var(--border-subtle)] rounded-xl inline-block shadow-inner">
                    <img src={whatsappQr} alt="WhatsApp QR" className="w-48 h-48" />
                  </div>
                )}
              </div>
            </div>
          </div>
        </ChannelGroup>

        {/* Discord */}
        <ChannelGroup title="Discord">
          <div className="flex items-start gap-4">
            <div className="w-12 h-12 bg-[#5865F2] rounded-xl flex items-center justify-center text-white flex-shrink-0">
              <DiscordIcon className="w-6 h-6" />
            </div>
            <div className="flex-1">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h3 className="text-lg font-bold">Discord Bot</h3>
                  <p className="text-sm text-[var(--text-secondary)]">Run your agent as a Discord bot.</p>
                </div>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input type="checkbox" checked={discordEnabled} onChange={(e) => setDiscordEnabled(e.target.checked)} className="sr-only peer" />
                  <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-[var(--system-blue)]"></div>
                </label>
              </div>
              <input
                type="password"
                value={discordToken}
                onChange={(e) => setDiscordToken(e.target.value)}
                placeholder="Discord bot token"
                className="w-full px-4 py-2 bg-[var(--system-gray-6)] border-transparent rounded-lg focus:ring-2 focus:ring-[var(--system-blue)]/20 outline-none text-sm"
              />
            </div>
          </div>
        </ChannelGroup>

        {/* Telegram */}
        <ChannelGroup title="Telegram">
          <div className="flex items-start gap-4">
            <div className="w-12 h-12 bg-[#0088cc] rounded-xl flex items-center justify-center text-white flex-shrink-0">
              <TelegramIcon className="w-6 h-6" />
            </div>
            <div className="flex-1">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h3 className="text-lg font-bold">Telegram Bot</h3>
                  <p className="text-sm text-[var(--text-secondary)]">Connect via @BotFather token.</p>
                </div>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input type="checkbox" checked={telegramEnabled} onChange={(e) => setTelegramEnabled(e.target.checked)} className="sr-only peer" />
                  <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-[var(--system-blue)]"></div>
                </label>
              </div>
              <div className="space-y-3">
                <input
                  type="password"
                  value={telegramToken}
                  onChange={(e) => setTelegramToken(e.target.value)}
                  placeholder="Bot token"
                  className="w-full px-4 py-2 bg-[var(--system-gray-6)] border-transparent rounded-lg focus:ring-2 focus:ring-[var(--system-blue)]/20 outline-none text-sm"
                />
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={telegramPairingCode}
                    onChange={(e) => setTelegramPairingCode(e.target.value)}
                    placeholder="Pairing code"
                    className="flex-1 px-4 py-2 bg-[var(--system-gray-6)] border-transparent rounded-lg focus:ring-2 focus:ring-[var(--system-blue)]/20 outline-none text-sm"
                  />
                  <button onClick={approveTelegramPairing} className="px-4 py-2 bg-black text-white rounded-lg text-sm font-semibold hover:bg-gray-800">Approve</button>
                </div>
                {telegramPairingStatus && <p className="text-xs text-[var(--text-tertiary)]">{telegramPairingStatus}</p>}
              </div>
            </div>
          </div>
        </ChannelGroup>

        {/* iMessage */}
        <ChannelGroup title="Apple iMessage">
          <div className="flex items-start gap-4">
            <div className="w-12 h-12 bg-blue-600 rounded-xl flex items-center justify-center text-white flex-shrink-0">
              <Smartphone className="w-6 h-6" />
            </div>
            <div className="flex-1">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h3 className="text-lg font-bold">iMessage (macOS)</h3>
                  <p className="text-sm text-[var(--text-secondary)]">Requires imsg tool on a Mac.</p>
                </div>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input type="checkbox" checked={imessageEnabled} onChange={(e) => setImessageEnabled(e.target.checked)} className="sr-only peer" />
                  <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-[var(--system-blue)]"></div>
                </label>
              </div>
              <div className="space-y-3">
                <input type="text" value={imessageCliPath} onChange={(e) => setImessageCliPath(e.target.value)} placeholder="CLI Path" className="w-full px-4 py-2 bg-[var(--system-gray-6)] border-transparent rounded-lg text-sm outline-none" />
                <input type="text" value={imessageDbPath} onChange={(e) => setImessageDbPath(e.target.value)} placeholder="Database Path" className="w-full px-4 py-2 bg-[var(--system-gray-6)] border-transparent rounded-lg text-sm outline-none" />
                <label className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
                  <input type="checkbox" checked={imessageIncludeAttachments} onChange={(e) => setImessageIncludeAttachments(e.target.checked)} />
                  Include attachments
                </label>
              </div>
            </div>
          </div>
        </ChannelGroup>

        <div className="flex justify-end gap-3 pt-4">
          <button
            onClick={saveIMessage}
            disabled={savingIMessage}
            className="px-6 py-2.5 bg-white border border-[var(--border-subtle)] text-black rounded-xl font-bold text-sm hover:bg-[var(--system-gray-6)] shadow-sm transition-all"
          >
            {savingIMessage ? "Saving..." : "Update iMessage"}
          </button>
          <button
            onClick={saveChannels}
            disabled={savingChannels}
            className="px-6 py-2.5 bg-black text-white rounded-xl font-bold text-sm hover:bg-gray-800 shadow-lg transition-all"
          >
            {savingChannels ? "Saving..." : "Apply All Changes"}
          </button>
        </div>
      </div>
    </div>
  );
}

