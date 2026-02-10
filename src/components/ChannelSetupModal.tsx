import { useState, useEffect } from "react";
import { X, Loader2, CheckCircle, MessageSquare, QrCode, ExternalLink } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";

type ChannelType = "imessage" | "whatsapp";

type Props = {
  channel: ChannelType;
  isOpen: boolean;
  onClose: () => void;
  onSetupComplete: (channel: ChannelType) => void;
};

type ChannelStatus = {
  configured: boolean;
  connected: boolean;
};

export function ChannelSetupModal({ channel, isOpen, onClose, onSetupComplete }: Props) {
  const [status, setStatus] = useState<ChannelStatus>({ configured: false, connected: false });
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      checkChannelStatus();
    }
  }, [isOpen, channel]);

  async function checkChannelStatus() {
    setIsLoading(true);
    setError(null);
    try {
      const result = await invoke<ChannelStatus>("get_channel_status", { channel });
      setStatus(result);

      if (channel === "whatsapp" && !result.connected) {
        // Request QR code for WhatsApp
        const qr = await invoke<string | null>("get_whatsapp_qr");
        setQrCode(qr);
      }
    } catch (e) {
      console.error(`Failed to check ${channel} status:`, e);
      setError(`Failed to check ${channel} status`);
    } finally {
      setIsLoading(false);
    }
  }

  async function handleRefresh() {
    await checkChannelStatus();
    if (status.connected) {
      onSetupComplete(channel);
    }
  }

  if (!isOpen) return null;

  const channelInfo = {
    imessage: {
      name: "iMessage",
      icon: MessageSquare,
      color: "bg-blue-500",
    },
    whatsapp: {
      name: "WhatsApp",
      icon: MessageSquare,
      color: "bg-green-500",
    },
  };

  const info = channelInfo[channel];
  const Icon = info.icon;

  return (
    <div
      className="fixed inset-0 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm m-4 rounded-2xl bg-white border border-[var(--border-subtle)] shadow-xl p-6"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className={`w-10 h-10 rounded-lg ${info.color} flex items-center justify-center`}>
              <Icon className="w-5 h-5 text-white" />
            </div>
            <div>
              <h3 className="text-lg font-semibold text-[var(--text-primary)]">
                Connect {info.name}
              </h3>
              <p className="text-sm text-[var(--text-tertiary)]">
                Let your assistant message you
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-[var(--text-tertiary)] hover:text-[var(--text-primary)] rounded-md hover:bg-black/5"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        {isLoading ? (
          <div className="py-8 text-center">
            <Loader2 className="w-7 h-7 animate-spin mx-auto mb-3 text-[var(--text-primary)]" />
            <p className="text-sm font-medium text-[var(--text-primary)]">Checking connection…</p>
            <p className="text-xs text-[var(--text-tertiary)] mt-1">Hang tight while Nova verifies your channel.</p>
          </div>
        ) : error ? (
          <div className="py-6 text-center">
            <div className="text-sm font-semibold text-[var(--text-primary)]">Connection check failed</div>
            <p className="text-xs text-[var(--text-secondary)] mt-2 mb-4">
              {error}. Make sure the secure sandbox is running, then try again.
            </p>
            <div className="flex items-center justify-center gap-2">
              <button onClick={handleRefresh} className="btn-primary !text-xs">
                Try Again
              </button>
              <button onClick={onClose} className="btn-secondary !text-xs">
                Close
              </button>
            </div>
          </div>
        ) : status.connected ? (
          <div className="py-8 text-center">
            <CheckCircle className="w-12 h-12 mx-auto mb-4 text-green-500" />
            <h4 className="text-lg font-medium text-[var(--text-primary)] mb-2">
              {info.name} Connected
            </h4>
            <p className="text-[var(--text-secondary)] mb-6">
              Your assistant can now message you on {info.name}.
            </p>
            <button onClick={onClose} className="btn-primary">
              Done
            </button>
          </div>
        ) : channel === "whatsapp" ? (
          <div className="space-y-4">
            <div className="text-center">
              <p className="text-[var(--text-secondary)] mb-4">
                Scan this QR code with WhatsApp to connect:
              </p>
              {qrCode ? (
                <div className="bg-white p-4 rounded-lg inline-block mb-4">
                  <img
                    src={`data:image/png;base64,${qrCode}`}
                    alt="WhatsApp QR Code"
                    className="w-48 h-48"
                  />
                </div>
              ) : (
                <div className="w-48 h-48 bg-[var(--bg-tertiary)] rounded-lg flex items-center justify-center mx-auto mb-4">
                  <QrCode className="w-12 h-12 text-[var(--text-tertiary)]" />
                </div>
              )}
            </div>
            <ol className="text-sm text-[var(--text-secondary)] space-y-2">
              <li>1. Open WhatsApp on your phone</li>
              <li>2. Go to Settings → Linked Devices</li>
              <li>3. Tap "Link a Device"</li>
              <li>4. Scan the QR code above</li>
            </ol>
            <button onClick={handleRefresh} className="btn-secondary w-full mt-4">
              <Loader2 className="w-4 h-4 mr-2" />
              Check Connection
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-[var(--text-secondary)]">
              To connect iMessage, you'll need to set up BlueBubbles on a Mac.
            </p>
            <div className="bg-[var(--bg-tertiary)] rounded-lg p-4 space-y-3">
              <h4 className="font-medium text-[var(--text-primary)]">Setup Steps:</h4>
              <ol className="text-sm text-[var(--text-secondary)] space-y-2">
                <li>1. Download BlueBubbles on your Mac</li>
                <li>2. Sign in with your Apple ID</li>
                <li>3. Connect it to your Nova instance</li>
              </ol>
            </div>
            <a
              href="https://bluebubbles.app"
              target="_blank"
              rel="noopener noreferrer"
              className="btn-secondary w-full flex items-center justify-center"
            >
              <ExternalLink className="w-4 h-4 mr-2" />
              Learn More
            </a>
            <button onClick={handleRefresh} className="btn-primary w-full">
              Check Connection
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
