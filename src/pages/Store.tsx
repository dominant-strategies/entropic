import { useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { invoke } from "@tauri-apps/api/core";
import clsx from "clsx";
import { CheckCircle2, ExternalLink, ShieldCheck, Loader2 } from "lucide-react";
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
  icon: ComponentType<{ className?: string }>;
  connected: boolean;
  stale?: boolean;
  email?: string;
};

type ExternalIntegration = {
  id: IntegrationProvider;
  name: string;
  description: string;
  icon: ComponentType<{ className?: string }>;
  connected: boolean;
  stale?: boolean;
  email?: string;
};

// --- Custom Icons ---

const GoogleCalendarIcon = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
    <path fill="#4285F4" d="M19 4h-1V2h-2v2H8V2H6v2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 16H5V9h14v11z" />
    <path fill="#FBBC05" d="M5 20h14v2H5z" />
    <path fill="#34A853" d="M19 4h2v5h-2z" />
    <path fill="#EA4335" d="M5 4h2v5H5z" />
  </svg>
);

const GmailIcon = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
    <path fill="#EA4335" d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4V8l8 5 8-5v10zm-8-7L4 6h16l-8 5z" />
  </svg>
);

const GoogleWorkspaceIcon = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
    <path fill="#4285F4" d="M11.53 13.06L17.5 7.11 20.94 10.56 15 16.5H11.53V13.06Z" />
    <path fill="#34A853" d="M7.06 17.5 13.03 11.53 16.47 15 10.5 20.94 7.06 17.5Z" />
    <path fill="#FBBC05" d="M7.06 6.47 13.03 12.44 9.59 15.88 3.63 9.91 7.06 6.47Z" />
    <path fill="#EA4335" d="M11.53 10.94 17.5 16.91 14.06 20.34 8.13 14.41V10.94H11.53Z" />
  </svg>
);

const XLogo = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
    <path
      fill="currentColor"
      d="M18.9 3H22l-6.8 7.8L23 21h-6.2l-4.9-6.1L6.6 21H3.5l7.3-8.3L1 3h6.3l4.4 5.6L18.9 3zm-1.1 16h1.7L7.5 4.9H5.7L17.8 19z"
    />
  </svg>
);

const META: Record<string, Partial<Plugin>> = {
  "memory-lancedb": { name: "Long-Term Memory", description: "Keeps long‑term memories and recalls them automatically.", category: "memory" },
  "memory-core": { name: "Short-Term Memory", description: "Lightweight memory search for recent conversations.", category: "memory" },
  discord: { name: "Discord", description: "Connect Nova to Discord servers and DMs.", category: "integrations" },
  telegram: { name: "Telegram", description: "Run your agent as a Telegram bot.", category: "integrations" },
  slack: { name: "Slack", description: "Connect Nova to Slack workspaces.", category: "integrations" },
};

const GOOGLE_INTEGRATIONS: Omit<GoogleIntegration, 'connected' | 'email'>[] = [
  {
    id: 'google_calendar',
    name: 'Google Calendar',
    description: 'Sync your calendar events.',
    icon: GoogleCalendarIcon,
  },
  {
    id: 'google_email',
    name: 'Gmail',
    description: 'Read and send emails.',
    icon: GmailIcon,
  },
];

const EXTERNAL_INTEGRATIONS: Omit<ExternalIntegration, 'connected' | 'email'>[] = [
  {
    id: 'x',
    name: 'X (Twitter)',
    description: 'Search public posts and fetch recent tweets.',
    icon: XLogo,
  },
];

const INTEGRATION_NAMES: Record<IntegrationProvider, string> = {
  google_calendar: "Google Calendar",
  google_email: "Gmail",
  x: "X (Twitter)",
};

const SYNC_REQUIRED = new Set<IntegrationProvider>(["google_calendar", "google_email"]);

const CATEGORIES = [
  { id: "all", label: "All" },
  { id: "tools", label: "Tools" },
  { id: "integrations", label: "Integrations" },
  { id: "memory", label: "Memory" },
];

export function Store({
  integrationsSyncing,
  integrationsMissing,
}: {
  integrationsSyncing?: boolean;
  integrationsMissing?: boolean;
}) {
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [category, setCategory] = useState("all");
  const [installing, setInstalling] = useState<string | null>(null);
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [setupProvider, setSetupProvider] = useState<IntegrationProvider | null>(null);
  const [setupStage, setSetupStage] = useState<"authorizing" | "syncing">("authorizing");
  const [setupTimedOut, setSetupTimedOut] = useState(false);
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

  useEffect(() => {
    const handleIntegrationUpdate = () => {
      refreshIntegrations();
    };
    window.addEventListener("nova-integration-updated", handleIntegrationUpdate);
    window.addEventListener("nova-integration-error", handleIntegrationUpdate);
    return () => {
      window.removeEventListener("nova-integration-updated", handleIntegrationUpdate);
      window.removeEventListener("nova-integration-error", handleIntegrationUpdate);
    };
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

  async function refreshIntegrations(opts?: { force?: boolean }) {
    try {
      const cached = await getIntegrationsCached(opts);
      if (cached.length > 0) {
        setIntegrations(cached);
      }
      try {
        const list = await getIntegrations(opts);
        const listProviders = new Set(list.map((entry) => entry.provider));
        const merged: Integration[] = [];
        for (const entry of cached) {
          if (listProviders.has(entry.provider)) {
            const real = list.find((item) => item.provider === entry.provider);
            if (real) merged.push(real);
          } else {
            merged.push({ ...entry, connected: false, stale: true });
          }
        }
        for (const entry of list) {
          if (!cached.find((item) => item.provider === entry.provider)) {
            merged.push(entry);
          }
        }
        setIntegrations(merged.length ? merged : list);
        const connectedIds = new Set(list.filter(i => i.connected).map(i => i.provider));
        for (const id of Array.from(syncedIntegrationsRef.current)) {
          if (!connectedIds.has(id as IntegrationProvider)) {
            syncedIntegrationsRef.current.delete(id);
          }
        }
        syncConnectedIntegrations(list).catch((err) => {
          console.warn("Failed to sync integrations:", err);
        });
        return;
      } catch (err) {
        // ignore cache failures
      }
    } catch (err) {
      // User might not be authenticated or backend might not support integrations yet
      console.error("Failed to load integrations:", err);
    }
  }

  useEffect(() => {
    if (!setupProvider) return;
    const interval = window.setInterval(() => {
      refreshIntegrations({ force: true }).catch(() => undefined);
    }, 3000);
    return () => window.clearInterval(interval);
  }, [setupProvider]);

  useEffect(() => {
    if (!setupProvider) {
      setSetupTimedOut(false);
      return;
    }
    setSetupTimedOut(false);
    const timeout = window.setTimeout(() => setSetupTimedOut(true), 120000);
    return () => window.clearTimeout(timeout);
  }, [setupProvider]);

  useEffect(() => {
    if (!setupProvider) return;
    const entry = integrations.find((i) => i.provider === setupProvider);
    if (!entry || entry.stale || !entry.connected) {
      return;
    }
    if (SYNC_REQUIRED.has(setupProvider) && !syncedIntegrationsRef.current.has(setupProvider)) {
      setSetupStage("syncing");
      return;
    }
    setSetupProvider(null);
    setSetupTimedOut(false);
  }, [integrations, setupProvider]);

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
      const entry = integrations.find(i => i.provider === gi.id);
      return {
        ...gi,
        connected: !!entry && !entry.stale,
        stale: entry?.stale,
        email: entry?.email,
      };
    });
  }, [integrations]);

  const externalIntegrations: ExternalIntegration[] = useMemo(() => {
    return EXTERNAL_INTEGRATIONS.map(integration => {
      const entry = integrations.find(i => i.provider === integration.id);
      return {
        ...integration,
        connected: !!entry && !entry.stale,
        stale: entry?.stale,
        email: entry?.email,
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
    setSetupProvider(provider);
    setSetupStage("authorizing");
    setSetupTimedOut(false);
    try {
      await connectIntegration(provider);
      if (provider !== "x") {
        setSetupStage("syncing");
      }
      setIntegrations((prev) => {
        const exists = prev.some((i) => i.provider === provider);
        if (!exists) return prev;
        return prev.map((i) =>
          i.provider === provider ? { ...i, connected: true, stale: false } : i
        );
      });
      await refreshIntegrations({ force: true });
    } catch (err) {
      console.error("Failed to start OAuth:", err);
      setSetupProvider(null);
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
  const setupLabel = setupProvider ? INTEGRATION_NAMES[setupProvider] : "";

  return (
    <div className="max-w-6xl mx-auto px-6 pb-12">
      <div className="pt-8 mb-8 flex items-center justify-between">
        <div>
        <h1 className="text-3xl font-bold text-[var(--text-primary)] mb-2 tracking-tight">Plugin Store</h1>
        <p className="text-lg text-[var(--text-secondary)]">Extend your assistant's capabilities.</p>
        </div>
        {integrationsSyncing ? (
          <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-[var(--text-tertiary)] bg-white px-3 py-1 rounded-full shadow-sm border border-[var(--border-subtle)]">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            Syncing integrations
          </div>
        ) : integrationsMissing ? (
          <div className="text-xs text-amber-600 uppercase tracking-wide bg-amber-50 px-3 py-1 rounded-full border border-amber-100">
            Integrations need reconnect
          </div>
        ) : null}
      </div>

      <div className="flex gap-3 mb-8 overflow-x-auto pb-2 scrollbar-hide">
        {CATEGORIES.map(cat => (
          <button key={cat.id} onClick={() => setCategory(cat.id)}
            className={clsx(
              "px-5 py-2 rounded-full font-medium text-sm transition-all whitespace-nowrap",
              category === cat.id 
                ? "bg-black text-white shadow-md" 
                : "bg-white text-[var(--text-secondary)] hover:bg-[var(--system-gray-6)] shadow-sm border border-[var(--border-subtle)]"
            )}>
            {cat.label}
          </button>
        ))}
      </div>

      {/* Google Integrations */}
      {showIntegrations && googleIntegrations.length > 0 && (
        <div className="mb-10">
          <h2 className="text-xl font-bold text-[var(--text-primary)] mb-4 flex items-center gap-2">
            Google Workspace
          </h2>
          
          <div className="bg-white rounded-2xl shadow-sm border border-[var(--border-subtle)] p-6">
             <div className="flex items-center gap-4 mb-6">
                <div className="w-14 h-14 bg-white rounded-xl shadow-sm border border-[var(--border-subtle)] flex items-center justify-center">
                    <GoogleWorkspaceIcon className="w-8 h-8" />
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-[var(--text-primary)]">Google Services</h3>
                  <p className="text-sm text-[var(--text-secondary)]">Connect your calendar and email for seamless assistance.</p>
                </div>
                {googleIntegrations.every(i => i.connected) && (
                   <div className="ml-auto flex items-center gap-1.5 px-3 py-1.5 bg-green-50 text-green-700 rounded-full text-xs font-medium">
                     <CheckCircle2 className="w-4 h-4" />
                     All Connected
                   </div>
                )}
             </div>

             <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
               {googleIntegrations.map(integration => {
                 const Icon = integration.icon;
                 return (
                  <div key={integration.id} className="flex items-center justify-between p-4 rounded-xl bg-[var(--system-gray-6)]/50 border border-[var(--border-subtle)]">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 bg-white rounded-lg flex items-center justify-center shadow-sm">
                        <Icon className="w-6 h-6" />
                      </div>
                      <div>
                        <div className="font-semibold text-[var(--text-primary)]">{integration.name}</div>
                        {integration.email ? (
                           <div className="text-xs text-[var(--text-tertiary)]">{integration.email}</div>
                        ) : (
                           <div className="text-xs text-[var(--text-tertiary)]">{integration.description}</div>
                        )}
                      </div>
                    </div>
                    
                    <button
                      onClick={() => integration.connected && !integration.stale
                        ? handleDisconnectIntegration(integration.id)
                        : handleConnectIntegration(integration.id)
                      }
                      disabled={connecting === integration.id}
                      className={clsx(
                        "btn !text-xs !font-semibold",
                        integration.connected && !integration.stale 
                          ? "bg-white border border-[var(--border-subtle)] text-[var(--text-secondary)]" 
                          : "bg-black text-white hover:bg-gray-800"
                      )}
                    >
                      {connecting === integration.id ? "..." : integration.connected ? "Disconnect" : "Connect"}
                    </button>
                  </div>
                 );
               })}
             </div>
          </div>
        </div>
      )}

      {/* External Integrations */}
      {showIntegrations && externalIntegrations.length > 0 && (
        <div className="mb-10">
          <h2 className="text-xl font-bold text-[var(--text-primary)] mb-4">Social & External</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {externalIntegrations.map(integration => {
              const Icon = integration.icon;
              return (
                <div key={integration.id} className="group bg-white rounded-2xl p-5 shadow-sm border border-[var(--border-subtle)] hover:shadow-md transition-all">
                  <div className="flex justify-between items-start mb-4">
                     <div className="w-12 h-12 bg-[var(--system-gray-6)] rounded-xl flex items-center justify-center group-hover:scale-105 transition-transform">
                        <Icon className="w-6 h-6 text-[var(--text-primary)]" />
                     </div>
                     {integration.connected && (
                       <div className="w-2 h-2 rounded-full bg-green-500" title="Connected" />
                     )}
                  </div>
                  
                  <h3 className="font-bold text-[var(--text-primary)] mb-1">{integration.name}</h3>
                  <p className="text-sm text-[var(--text-secondary)] mb-4 h-10 line-clamp-2">{integration.description}</p>
                  
                  <button
                    onClick={() => integration.connected && !integration.stale
                      ? handleDisconnectIntegration(integration.id)
                      : handleConnectIntegration(integration.id)
                    }
                    disabled={connecting === integration.id}
                    className={clsx(
                      "w-full py-2 rounded-lg text-sm font-semibold transition-colors",
                      integration.connected && !integration.stale
                        ? "bg-[var(--system-gray-6)] text-[var(--text-primary)] hover:bg-[var(--system-gray-5)]"
                        : "bg-[var(--system-gray-6)] text-[var(--system-blue)] hover:bg-[var(--system-blue)] hover:text-white"
                    )}
                  >
                    {connecting === integration.id ? "Processing..." : integration.connected ? "Manage" : "Connect"}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Plugins */}
      {filteredPlugins.length > 0 && (
        <div className="mb-10">
          {(showIntegrations && googleIntegrations.length > 0) && (
             <h2 className="text-xl font-bold text-[var(--text-primary)] mb-4">All Plugins</h2>
          )}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {filteredPlugins.map(plugin => (
              <div key={plugin.id} className="group bg-white rounded-2xl p-5 shadow-sm border border-[var(--border-subtle)] hover:shadow-md transition-all flex flex-col h-full">
                <div className="flex justify-between items-start mb-3">
                   <div className="w-12 h-12 bg-gradient-to-br from-blue-50 to-indigo-50 rounded-xl flex items-center justify-center text-blue-600 font-bold text-lg border border-blue-100">
                     {plugin.name.slice(0, 1)}
                   </div>
                   {plugin.enabled && (
                     <span className="text-[10px] font-bold uppercase tracking-wider text-green-600 bg-green-50 px-2 py-1 rounded-md">Installed</span>
                   )}
                </div>

                <div className="mb-4 flex-1">
                   <h3 className="font-bold text-[var(--text-primary)] mb-1 line-clamp-1">{plugin.name}</h3>
                   <p className="text-xs text-[var(--text-tertiary)] mb-2">by {plugin.author}</p>
                   <p className="text-sm text-[var(--text-secondary)] line-clamp-3">{plugin.description}</p>
                </div>

                {plugin.managed ? (
                  <button disabled className="w-full py-2 bg-[var(--system-gray-6)] text-[var(--text-tertiary)] rounded-lg text-sm font-medium cursor-not-allowed">
                    Managed System Plugin
                  </button>
                ) : (
                  <button onClick={() => plugin.enabled
                      ? handleDisablePlugin(plugin.id)
                      : handleEnablePlugin(plugin.id)
                    } disabled={installing === plugin.id}
                    className={clsx(
                      "w-full py-2 rounded-lg text-sm font-semibold transition-colors",
                      plugin.enabled
                        ? "bg-[var(--system-gray-6)] text-[var(--text-secondary)] hover:bg-red-50 hover:text-red-600"
                        : "bg-[var(--system-blue)] text-white hover:bg-blue-600 shadow-sm"
                    )}>
                    {installing === plugin.id ? "Processing..." : plugin.enabled ? "Uninstall" : "Install"}
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Empty state */}
      {filteredPlugins.length === 0 && (!showIntegrations || googleIntegrations.length === 0) && (
        <div className="text-center py-20">
           <div className="w-16 h-16 bg-[var(--system-gray-6)] rounded-full flex items-center justify-center mx-auto mb-4 text-[var(--text-tertiary)]">
             <ShieldCheck className="w-8 h-8" />
           </div>
           <h3 className="text-lg font-medium text-[var(--text-primary)] mb-1">No plugins found</h3>
           <p className="text-[var(--text-secondary)]">Try selecting a different category.</p>
        </div>
      )}

      {/* Scanner attribution */}
      <div className="mt-12 pt-6 border-t border-[var(--border-subtle)] flex items-center justify-center gap-2 text-xs text-[var(--text-tertiary)]">
        <ShieldCheck className="w-3.5 h-3.5" />
        <span>Securely validated by{" "}
          <a href="https://github.com/cisco-ai-defense/skill-scanner"
            target="_blank" rel="noopener noreferrer"
            className="hover:text-[var(--text-secondary)] underline transition-colors">
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

      {setupProvider && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-2xl bg-[var(--bg-primary)] p-6 shadow-xl border border-[var(--glass-border)]">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 rounded-full bg-[var(--bg-tertiary)] p-2">
                <Loader2 className="w-4 h-4 animate-spin text-[var(--text-primary)]" />
              </div>
              <div>
                <div className="text-sm font-semibold text-[var(--text-primary)]">
                  Setting up {setupLabel}
                </div>
                <div className="text-xs text-[var(--text-secondary)] mt-1">
                  {setupStage === "authorizing"
                    ? "Finish authorization in your browser. We’ll update Nova as soon as it’s complete."
                    : "Saving credentials and syncing with Nova so the plugin is ready to use."}
                </div>
                {setupTimedOut && (
                  <div className="text-xs text-amber-600 mt-2">
                    This is taking longer than usual. You can keep waiting or continue in the background.
                  </div>
                )}
              </div>
            </div>
            <div className="mt-4 flex justify-end">
              <button
                className="btn btn-secondary !text-xs"
                onClick={() => setSetupProvider(null)}
              >
                Continue in background
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
