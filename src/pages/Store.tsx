import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import clsx from "clsx";
import { Calendar, Mail, CheckCircle2, ExternalLink, ShieldCheck, Loader2 } from "lucide-react";
import {
  getIntegrations,
  getIntegrationsCached,
  connectIntegration,
  disconnectIntegration,
  syncIntegrationToGateway,
  removeIntegrationFromGateway,
  Integration,
  IntegrationProvider,
} from "../lib/integrations";
import { ScanResultModal, type PluginScanResult } from "../components/ScanResultModal";

type Plugin = {
  id: string;
  name: string;
  description: string;
  author: string;
  installed: boolean;
  enabled: boolean;
  managed?: boolean;
  category: "tools" | "integrations" | "memory" | "agents";
};

type GoogleIntegration = {
  id: IntegrationProvider;
  name: string;
  description: string;
  icon: typeof Calendar;
  connected: boolean;
  email?: string;
};

const META: Record<string, Partial<Plugin>> = {
  "memory-lancedb": { name: "Memory (Long‑Term)", description: "Keeps long‑term memories and recalls them automatically.", category: "memory" },
  "memory-core": { name: "Memory (Core)", description: "Lightweight memory search for recent conversations.", category: "memory" },
  discord: { name: "Discord", description: "Connect Nova to Discord servers and DMs.", category: "integrations" },
  telegram: { name: "Telegram", description: "Run your agent as a Telegram bot.", category: "integrations" },
  slack: { name: "Slack", description: "Connect Nova to Slack workspaces.", category: "integrations" },
};

const GOOGLE_INTEGRATIONS: Omit<GoogleIntegration, 'connected' | 'email'>[] = [
  {
    id: 'google_calendar',
    name: 'Google Calendar',
    description: 'Sync your calendar events. Nova can read and create events.',
    icon: Calendar,
  },
  {
    id: 'google_email',
    name: 'Gmail',
    description: 'Read and send emails. Nova can help manage your inbox.',
    icon: Mail,
  },
];

const CATEGORIES = [
  { id: "all", label: "All" },
  { id: "tools", label: "Tools" },
  { id: "integrations", label: "Integrations" },
  { id: "memory", label: "Memory" },
];

export function Store({ integrationsSyncing }: { integrationsSyncing?: boolean }) {
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [category, setCategory] = useState("all");
  const [installing, setInstalling] = useState<string | null>(null);
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [scanModalOpen, setScanModalOpen] = useState(false);
  const [scanPluginId, setScanPluginId] = useState<string | null>(null);
  const [scanResult, setScanResult] = useState<PluginScanResult | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const syncedIntegrationsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    refresh();
    refreshIntegrations();
  }, []);

  async function refresh() {
    try {
      const list = await invoke<any[]>("get_plugin_store");
      const normalized: Plugin[] = list.map(p => {
        const meta = META[p.id] || {};
        const category: Plugin["category"] = meta.category || (p.kind === "memory" ? "memory" : p.channels?.length > 0 ? "integrations" : "tools");
        return {
          id: p.id,
          name: meta.name || p.id,
          description: meta.description || "OpenClaw plugin",
          author: "OpenClaw",
          installed: p.installed,
          enabled: p.enabled,
          managed: p.managed,
          category,
        };
      });
      setPlugins(normalized);
    } catch (err) {
      console.error("Failed to load plugins:", err);
    }
  }

  async function refreshIntegrations() {
    try {
      try {
        const cached = await getIntegrationsCached();
        if (cached.length > 0) {
          setIntegrations(cached);
        }
      } catch (err) {
        // ignore cache failures
      }
      const list = await getIntegrations();
      setIntegrations(list);
      const connectedIds = new Set(list.filter(i => i.connected).map(i => i.provider));
      for (const id of Array.from(syncedIntegrationsRef.current)) {
        if (!connectedIds.has(id)) {
          syncedIntegrationsRef.current.delete(id);
        }
      }
      syncConnectedIntegrations(list).catch((err) => {
        console.warn("Failed to sync integrations:", err);
      });
    } catch (err) {
      // User might not be authenticated or backend might not support integrations yet
      console.error("Failed to load integrations:", err);
    }
  }

  async function syncConnectedIntegrations(list: Integration[]) {
    for (const integration of list) {
      if (!integration.connected) continue;
      if (syncedIntegrationsRef.current.has(integration.provider)) continue;
      try {
        await syncIntegrationToGateway(integration.provider as IntegrationProvider);
        syncedIntegrationsRef.current.add(integration.provider);
      } catch (err) {
        console.warn(`Failed to sync ${integration.provider} to OpenClaw:`, err);
      }
    }
  }

  const filteredPlugins = useMemo(() =>
    category === "all" ? plugins : plugins.filter(p => p.category === category),
    [category, plugins]
  );

  const googleIntegrations: GoogleIntegration[] = useMemo(() => {
    return GOOGLE_INTEGRATIONS.map(gi => {
      const connected = integrations.find(i => i.provider === gi.id);
      return {
        ...gi,
        connected: !!connected,
        email: connected?.email,
      };
    });
  }, [integrations]);

  async function handleEnablePlugin(id: string) {
    setScanPluginId(id);
    setScanResult(null);
    setScanError(null);
    setIsScanning(true);
    setScanModalOpen(true);

    try {
      const result = await invoke<PluginScanResult>("scan_plugin", { id });
      setScanResult(result);
    } catch (err) {
      setScanError(String(err));
    } finally {
      setIsScanning(false);
    }
  }

  async function confirmEnablePlugin() {
    if (!scanPluginId) return;
    setScanModalOpen(false);
    setInstalling(scanPluginId);
    try {
      await invoke("set_plugin_enabled", { id: scanPluginId, enabled: true });
    } finally {
      setInstalling(null);
      setScanPluginId(null);
      await refresh();
    }
  }

  async function handleDisablePlugin(id: string) {
    setInstalling(id);
    try {
      await invoke("set_plugin_enabled", { id, enabled: false });
    } finally {
      setInstalling(null);
      await refresh();
    }
  }

  async function handleConnectIntegration(provider: IntegrationProvider) {
    setConnecting(provider);
    try {
      await connectIntegration(provider);
      await refreshIntegrations();
    } catch (err) {
      console.error("Failed to start OAuth:", err);
    } finally {
      setConnecting(null);
    }
  }

  async function handleDisconnectIntegration(provider: IntegrationProvider) {
    setConnecting(provider);
    try {
      await disconnectIntegration(provider);
      await removeIntegrationFromGateway(provider);
      await refreshIntegrations();
    } catch (err) {
      console.error("Failed to disconnect:", err);
    } finally {
      setConnecting(null);
    }
  }

  const showIntegrations = category === "all" || category === "integrations";

  return (
    <div className="max-w-4xl">
      <div className="mb-6 flex items-center justify-between">
        <div>
        <h1 className="text-xl font-semibold text-[var(--text-primary)]">Plugins</h1>
        <p className="text-sm text-[var(--text-secondary)]">Extend your AI with plugins and integrations</p>
        </div>
        {integrationsSyncing ? (
          <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-[var(--text-tertiary)]">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            Syncing integrations
          </div>
        ) : null}
      </div>

      <div className="flex gap-2 mb-6">
        {CATEGORIES.map(cat => (
          <button key={cat.id} onClick={() => setCategory(cat.id)}
            className={clsx("btn btn-secondary !text-sm", category === cat.id && "bg-black/10")}>
            {cat.label}
          </button>
        ))}
      </div>

      {/* Google Integrations */}
      {showIntegrations && googleIntegrations.length > 0 && (
        <div className="mb-8">
          <h2 className="text-sm font-medium text-[var(--text-secondary)] mb-3 flex items-center gap-2">
            <span>Google Services</span>
            <span className="text-xs text-[var(--text-tertiary)]">Requires Google account</span>
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {googleIntegrations.map(integration => {
              const Icon = integration.icon;
              return (
                <div key={integration.id} className="glass-card p-4 flex flex-col">
                  <div className="flex items-start justify-between mb-2">
                    <div className="flex items-center gap-3">
                      <div className={clsx(
                        "w-10 h-10 rounded-lg flex items-center justify-center",
                        integration.connected ? "bg-green-100" : "bg-black/5"
                      )}>
                        <Icon className={clsx(
                          "w-5 h-5",
                          integration.connected ? "text-green-600" : "text-[var(--text-tertiary)]"
                        )} />
                      </div>
                      <div>
                        <h3 className="font-medium text-[var(--text-primary)] flex items-center gap-2">
                          {integration.name}
                          {integration.connected && (
                            <CheckCircle2 className="w-4 h-4 text-green-600" />
                          )}
                        </h3>
                        {integration.email && (
                          <p className="text-xs text-[var(--text-tertiary)]">{integration.email}</p>
                        )}
                      </div>
                    </div>
                    <button
                      onClick={() => integration.connected
                        ? handleDisconnectIntegration(integration.id)
                        : handleConnectIntegration(integration.id)
                      }
                      disabled={connecting === integration.id}
                      className={clsx(
                        "btn !text-xs",
                        integration.connected ? "btn-secondary" : "btn-primary"
                      )}
                    >
                      {connecting === integration.id ? "..." : integration.connected ? "Disconnect" : "Connect"}
                      {!integration.connected && <ExternalLink className="w-3 h-3 ml-1" />}
                    </button>
                  </div>
                  <p className="text-sm text-[var(--text-secondary)] flex-1">{integration.description}</p>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Plugins */}
      {filteredPlugins.length > 0 && (
        <>
          {showIntegrations && googleIntegrations.length > 0 && (
            <h2 className="text-sm font-medium text-[var(--text-secondary)] mb-3">Plugins</h2>
          )}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {filteredPlugins.map(plugin => (
              <div key={plugin.id} className="glass-card p-4 flex flex-col">
                <div className="flex items-start justify-between mb-2">
                  <div>
                    <h3 className="font-medium text-[var(--text-primary)]">{plugin.name}</h3>
                    <p className="text-xs text-[var(--text-tertiary)]">by {plugin.author}</p>
                  </div>
                  {plugin.managed ? (
                    <span className="text-xs text-[var(--text-tertiary)]">Managed in Settings</span>
                  ) : (
                    <button onClick={() => plugin.enabled
                        ? handleDisablePlugin(plugin.id)
                        : handleEnablePlugin(plugin.id)
                      } disabled={installing === plugin.id}
                      className={clsx("btn !text-xs", plugin.enabled ? "btn-secondary" : "btn-primary")}>
                      {installing === plugin.id ? "..." : plugin.enabled ? "Disable" : "Install"}
                    </button>
                  )}
                </div>
                <p className="text-sm text-[var(--text-secondary)] flex-1">{plugin.description}</p>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Empty state */}
      {filteredPlugins.length === 0 && (!showIntegrations || googleIntegrations.length === 0) && (
        <div className="text-center py-12 text-[var(--text-tertiary)]">
          No plugins found in this category
        </div>
      )}

      {/* Scanner attribution */}
      <div className="mt-8 pt-4 border-t border-[var(--glass-border)] flex items-center gap-2 text-xs text-[var(--text-tertiary)]">
        <ShieldCheck className="w-3.5 h-3.5" />
        <span>Plugins are validated using{" "}
          <a href="https://github.com/cisco-ai-defense/skill-scanner"
            target="_blank" rel="noopener noreferrer"
            className="underline hover:text-[var(--text-secondary)]">
            Cisco AI Defense Skill Scanner
          </a>
        </span>
      </div>

      <ScanResultModal
        isOpen={scanModalOpen}
        pluginName={META[scanPluginId || ""]?.name || scanPluginId || ""}
        scanResult={scanResult}
        isScanning={isScanning}
        error={scanError}
        onClose={() => { setScanModalOpen(false); setScanPluginId(null); }}
        onEnablePlugin={confirmEnablePlugin}
        onEnableAnyway={confirmEnablePlugin}
      />
    </div>
  );
}
