import { useEffect, useState, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Store } from "@tauri-apps/plugin-store";
import { ask } from "@tauri-apps/plugin-dialog";
import { Key, Shield, Sparkles, Cpu, Image, ChevronRight, User, Palette, ChevronDown, ScrollText, LogIn, LogOut, Loader2, Trash2, AlertTriangle, Copy, Download } from "lucide-react";
import clsx from "clsx";
import {
  getProfileInitials,
  isRenderableAvatarDataUrl,
  loadProfile,
  sanitizeProfileName,
  saveProfile,
  type AgentProfile,
} from "../lib/profile";
import { useAuth } from "../contexts/AuthContext";
import { ModelSelector } from "../components/ModelSelector";
import { WALLPAPERS, DEFAULT_WALLPAPER_ID, getWallpaperById } from "../lib/wallpapers";
import { getProxyUrl } from "../lib/auth";
import { Logs } from "./Logs";
import {
  clearDiagnosticLogs,
  diagnosticsUpdatedEventName,
  readDiagnosticLogs,
  type DiagnosticLogEntry,
  type DiagnosticLogType,
} from "../lib/diagnostics";

type Props = {
  gatewayRunning: boolean;
  onGatewayToggle: () => void;
  isTogglingGateway: boolean;
  experimentalDesktop: boolean;
  onExperimentalDesktopChange: (value: boolean) => void;
  selectedModel: string;
  onModelChange: (model: string) => void;
  useLocalKeys: boolean;
  onUseLocalKeysChange: (value: boolean) => void | Promise<void>;
  codeModel: string;
  imageModel: string;
  onCodeModelChange: (model: string) => void;
  onImageModelChange: (model: string) => void;
};

type AgentProfileState = {
  memory_sessions_enabled?: boolean;
  memory_enabled?: boolean;
  memory_qmd_enabled?: boolean;
  soul?: string;
  identity_name?: string;
  identity_avatar?: string | null;
};

type GatewayConfigHealth = {
  status: string;
  summary: string;
  issues: string[];
};

type GatewayHealResult = {
  container: string;
  restarted: boolean;
  message: string;
};

type RuntimeVersionInfo = {
  entropic_version: string;
  runtime_version: string;
  runtime_openclaw_commit?: string | null;
  applied_runtime_version?: string | null;
  applied_runtime_openclaw_commit?: string | null;
  applied_runtime_image_id?: string | null;
  app_manifest_version?: string | null;
  app_manifest_pub_date?: string | null;
};

type RuntimeFetchResult = {
  runtime_version: string;
  runtime_openclaw_commit?: string | null;
  runtime_sha256: string;
  cache_path: string;
};

function SettingsGroup({ title, children }: { title?: string, children: React.ReactNode }) {
  return (
    <div className="mb-8">
      {title && (
        <h3 className="text-[13px] font-medium text-[var(--text-secondary)] uppercase tracking-wide mb-2 px-1">
          {title}
        </h3>
      )}
      <div className="bg-white border border-[var(--border-subtle)] rounded-xl overflow-hidden shadow-sm divide-y divide-[var(--border-subtle)]">
        {children}
      </div>
    </div>
  );
}

function SettingsRow({ 
  label, 
  children, 
  icon: Icon,
  description,
  onClick
}: { 
  label: string, 
  children?: React.ReactNode, 
  icon?: any,
  description?: string,
  onClick?: () => void
}) {
  return (
    <div className={clsx("p-4 flex items-center justify-between gap-4 transition-colors", onClick && "cursor-pointer hover:bg-[var(--system-gray-6)]")} onClick={onClick}>
      <div className="flex items-center gap-3 overflow-hidden">
        {Icon && (
          <div className="w-7 h-7 rounded-md bg-[var(--system-blue)]/10 text-[var(--system-blue)] flex items-center justify-center flex-shrink-0">
            <Icon className="w-4 h-4" />
          </div>
        )}
        <div className="min-w-0">
          <div className="text-[14px] font-medium text-[var(--text-primary)]">{label}</div>
          {description && <div className="text-[12px] text-[var(--text-secondary)] truncate">{description}</div>}
        </div>
      </div>
      <div className="flex-shrink-0 flex items-center gap-2">
        {children}
      </div>
    </div>
  );
}

export function Settings({
  gatewayRunning,
  onGatewayToggle,
  isTogglingGateway,
  experimentalDesktop,
  onExperimentalDesktopChange,
  selectedModel,
  onModelChange,
  useLocalKeys,
  onUseLocalKeysChange,
  codeModel,
  imageModel,
  onCodeModelChange,
  onImageModelChange,
}: Props) {
  console.log("[Settings] Component rendering");
  const { isAuthenticated, isAuthConfigured } = useAuth();
  const proxyEnabled = isAuthConfigured && isAuthenticated && !useLocalKeys;
  const [apiKeys, setApiKeys] = useState({ anthropic: "", openai: "", google: "" });
  const [profile, setProfile] = useState<AgentProfile>({ name: "Entropic" });
  const [saving, setSaving] = useState(false);
  const [memorySessionIndexing, setMemorySessionIndexing] = useState(false);
  const [memoryEnabled, setMemoryEnabled] = useState(true);
  const [memoryQmdEnabled, setMemoryQmdEnabled] = useState(false);
  const [memorySessionIndexingError, setMemorySessionIndexingError] = useState<string | null>(null);
  const [memoryQmdError, setMemoryQmdError] = useState<string | null>(null);
  const [soul, setSoul] = useState("");
  
  // OAuth state
  const [oauthStatus, setOauthStatus] = useState<Record<string, string>>({});
  const [oauthLoading, setOauthLoading] = useState<string | null>(null);
  const [oauthError, setOauthError] = useState<string | null>(null);
  const [authState, setAuthState] = useState<{ providers: Array<{ id: string; has_key: boolean; last4?: string | null }> }>({ providers: [] });
  const connectedProviders = authState.providers.filter(p => p.has_key).map(p => p.id);
  // Anthropic OAuth code-paste state
  const [anthropicCodePending, setAnthropicCodePending] = useState(false);
  const [anthropicCodeInput, setAnthropicCodeInput] = useState("");
  const [cleanupLoading, setCleanupLoading] = useState(false);
  const [legacyMigrationLoading, setLegacyMigrationLoading] = useState(false);
  const [legacyUpgradeLoading, setLegacyUpgradeLoading] = useState(false);
  const [gatewayConfigHealth, setGatewayConfigHealth] = useState<GatewayConfigHealth | null>(null);
  const [gatewayConfigLoading, setGatewayConfigLoading] = useState(false);
  const [gatewayConfigActionLoading, setGatewayConfigActionLoading] = useState(false);
  const [gatewayConfigError, setGatewayConfigError] = useState<string | null>(null);
  const [gatewayConfigNotice, setGatewayConfigNotice] = useState<string | null>(null);
  const [runtimeVersionInfo, setRuntimeVersionInfo] = useState<RuntimeVersionInfo | null>(null);
  const [runtimeFetchLoading, setRuntimeFetchLoading] = useState(false);
  const appliedRuntimeDigest =
    runtimeVersionInfo?.applied_runtime_image_id
      ?.replace(/^sha256:/, "")
      .slice(0, 12) ?? null;
  const appManifestDate = runtimeVersionInfo?.app_manifest_pub_date
    ? runtimeVersionInfo.app_manifest_pub_date.slice(0, 10)
    : null;
  const profileDisplayName = sanitizeProfileName(profile.name);
  const profileAvatarDataUrl = isRenderableAvatarDataUrl(profile.avatarDataUrl)
    ? profile.avatarDataUrl.trim()
    : undefined;

  // Wallpaper state
  const [wallpaperId, setWallpaperId] = useState(DEFAULT_WALLPAPER_ID);
  const [customWallpaper, setCustomWallpaper] = useState<string | null>(null);
  const [wallpaperPickerOpen, setWallpaperPickerOpen] = useState(false);
  const wallpaperInputRef = useRef<HTMLInputElement>(null);

  // Load initial state
  useEffect(() => {
    loadProfile().then(setProfile).catch(() => {});
    invoke<AgentProfileState>("get_agent_profile_state").then((state) => {
      setSoul(state.soul || "");
      setMemorySessionIndexing(Boolean(state.memory_sessions_enabled));
      setMemoryEnabled(state.memory_enabled ?? true);
      setMemoryQmdEnabled(Boolean(state.memory_qmd_enabled));
      const hasIdentityName = Object.prototype.hasOwnProperty.call(state, "identity_name");
      const hasIdentityAvatar = Object.prototype.hasOwnProperty.call(state, "identity_avatar");
      if (hasIdentityName || hasIdentityAvatar) {
        setProfile((prev) => {
          const next: AgentProfile = {
            name:
              hasIdentityName && typeof state.identity_name === "string" && state.identity_name.trim()
                ? sanitizeProfileName(state.identity_name)
                : prev.name,
            avatarDataUrl: hasIdentityAvatar
              ? isRenderableAvatarDataUrl(state.identity_avatar)
                ? state.identity_avatar.trim()
                : undefined
              : prev.avatarDataUrl,
          };
          if (next.name !== prev.name || next.avatarDataUrl !== prev.avatarDataUrl) {
            saveProfile(next)
              .then(() => window.dispatchEvent(new Event("entropic-profile-updated")))
              .catch(() => {});
          }
          return next;
        });
      }
    }).catch(() => {});
    Store.load("entropic-settings.json").then(async (store) => {
      const wp = (await store.get("desktopWallpaper")) as string | null;
      if (wp) setWallpaperId(wp);
      const cwp = (await store.get("desktopCustomWallpaper")) as string | null;
      if (cwp) setCustomWallpaper(cwp);
    }).catch(() => {});
    invoke<RuntimeVersionInfo>("get_runtime_version_info").then(setRuntimeVersionInfo).catch(() => {});
    invoke<Record<string, string>>("get_oauth_status").then(setOauthStatus).catch(() => {});
    invoke<{ providers: Array<{ id: string; has_key: boolean; last4?: string | null }> }>("get_auth_state").then(setAuthState).catch(() => {});
  }, []);

  useEffect(() => {
    refreshGatewayConfigHealth();
  }, [gatewayRunning]);

  useEffect(() => {
    if (!experimentalDesktop) {
      setWallpaperPickerOpen(false);
    }
  }, [experimentalDesktop]);

  async function saveWallpaper(id: string, custom?: string | null) {
    setWallpaperId(id);
    if (custom !== undefined) setCustomWallpaper(custom);
    try {
      const store = await Store.load("entropic-settings.json");
      await store.set("desktopWallpaper", id);
      if (custom !== undefined) {
        if (custom) await store.set("desktopCustomWallpaper", custom);
        else await store.delete("desktopCustomWallpaper");
      }
      await store.save();
    } catch {}
  }

  async function handleWallpaperPick(id: string) {
    await saveWallpaper(id, undefined);
    setWallpaperPickerOpen(false);
  }

  function handleCustomWallpaperUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    const reader = new FileReader();
    reader.onload = () => saveWallpaper("custom", reader.result as string);
    reader.readAsDataURL(file);
  }

  const [isEditingPersonality, setIsEditingPersonality] = useState(false);
  const [logsExpanded, setLogsExpanded] = useState(false);
  const [gatewayDiagnosticsExpanded, setGatewayDiagnosticsExpanded] = useState(false);
  const [gatewayDiagLogs, setGatewayDiagLogs] = useState<DiagnosticLogEntry[]>([]);
  const [diagTypeFilters, setDiagTypeFilters] = useState<Record<DiagnosticLogType, boolean>>({
    info: true,
    warn: true,
    error: true,
  });

  useEffect(() => {
    const refreshDiagnostics = () => setGatewayDiagLogs(readDiagnosticLogs());
    refreshDiagnostics();
    const eventName = diagnosticsUpdatedEventName();
    window.addEventListener(eventName, refreshDiagnostics);
    return () => {
      window.removeEventListener(eventName, refreshDiagnostics);
    };
  }, []);

  const PERSONALITY_TEMPLATES = [
    { label: "Helpful Assistant", text: "You are a helpful, knowledgeable, and friendly AI assistant." },
    { label: "Health Coach", text: "You are an encouraging and knowledgeable health coach. Focus on wellness, nutrition, and positive habits." },
    { label: "Comedian", text: "You are a witty stand-up comedian. Be funny, sarcastic, and entertaining in your responses." },
    { label: "Mentor", text: "You are a wise and patient mentor. Guide the user with insightful advice and Socratic questioning." },
    { label: "Coder", text: "You are an expert software engineer. Focus on clean, efficient code and best practices." },
  ];

  async function handleOAuthLogin(provider: "anthropic" | "openai") {
    setOauthLoading(provider);
    setOauthError(null);
    try {
      if (provider === "anthropic") {
        // Phase 1: Open browser — user will copy code from Anthropic's page
        await invoke("start_anthropic_oauth");
        setAnthropicCodePending(true);
        setAnthropicCodeInput("");
        setOauthLoading(null);
        return; // Don't clear loading state yet — wait for code paste
      }
      // OpenAI: single-step localhost callback flow
      await invoke<{ access_token: string; provider: string }>("start_openai_oauth");
      const status = await invoke<Record<string, string>>("get_oauth_status");
      setOauthStatus(status);
      const state = await invoke<{ providers: Array<{ id: string; has_key: boolean; last4?: string | null }> }>("get_auth_state");
      setAuthState(state);
      // OAuth sets a local API key — switch to local keys mode and restart gateway
      if (!useLocalKeys) {
        await onUseLocalKeysChange(true);
        // Small delay to let React state propagate before toggling gateway
        await new Promise(r => setTimeout(r, 200));
      }
      if (!isTogglingGateway) onGatewayToggle();
      window.dispatchEvent(new Event("entropic-auth-changed"));
    } catch (e) {
      console.error(`[Entropic] OAuth login failed for ${provider}:`, e);
      setOauthError(typeof e === "string" ? e : `OAuth login failed for ${provider}`);
    } finally {
      setOauthLoading(null);
    }
  }

  async function handleAnthropicCodeSubmit() {
    if (!anthropicCodeInput.trim()) return;
    setOauthLoading("anthropic");
    setOauthError(null);
    try {
      await invoke<{ access_token: string; provider: string }>("complete_anthropic_oauth", {
        codeState: anthropicCodeInput.trim(),
      });
      setAnthropicCodePending(false);
      setAnthropicCodeInput("");
      const status = await invoke<Record<string, string>>("get_oauth_status");
      setOauthStatus(status);
      const state = await invoke<{ providers: Array<{ id: string; has_key: boolean; last4?: string | null }> }>("get_auth_state");
      setAuthState(state);
      // OAuth sets a local API key — switch to local keys mode and restart gateway
      if (!useLocalKeys) {
        await onUseLocalKeysChange(true);
        await new Promise(r => setTimeout(r, 200));
      }
      if (!isTogglingGateway) onGatewayToggle();
      window.dispatchEvent(new Event("entropic-auth-changed"));
    } catch (e) {
      console.error("[Entropic] Anthropic OAuth code exchange failed:", e);
      setOauthError(typeof e === "string" ? e : "Failed to exchange authorization code");
    } finally {
      setOauthLoading(null);
    }
  }

  async function handleOAuthDisconnect(provider: "anthropic" | "openai") {
    try {
      await invoke("set_api_key", { provider, key: "" });
      if (provider === "anthropic") {
        setAnthropicCodePending(false);
        setAnthropicCodeInput("");
      }
      const status = await invoke<Record<string, string>>("get_oauth_status");
      setOauthStatus(status);
      const state = await invoke<{ providers: Array<{ id: string; has_key: boolean; last4?: string | null }> }>("get_auth_state");
      setAuthState(state);
    } catch (e) {
      console.error(`[Entropic] OAuth disconnect failed for ${provider}:`, e);
    }
  }

  async function handleMemorySessionIndexingChange(nextEnabled: boolean) {
    setSaving(true);
    setMemorySessionIndexingError(null);
    const previous = memorySessionIndexing;
    setMemorySessionIndexing(nextEnabled);
    try {
      await invoke("set_memory_session_indexing", { enabled: nextEnabled });
    } catch (error) {
      setMemorySessionIndexing(previous);
      console.error("[Entropic] Failed to update memory session indexing:", error);
      setMemorySessionIndexingError("Could not update conversation memory indexing. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  async function handleMemoryQmdToggle(nextEnabled: boolean) {
    setSaving(true);
    setMemoryQmdError(null);
    const previous = memoryQmdEnabled;
    setMemoryQmdEnabled(nextEnabled);
    try {
      await invoke("set_memory_qmd_enabled", { enabled: nextEnabled });
    } catch (error) {
      setMemoryQmdEnabled(previous);
      console.error("[Entropic] Failed to update QMD memory backend:", error);
      setMemoryQmdError(
        "Could not update QMD memory backend. Ensure gateway is running and network access is available for first-time QMD install."
      );
    } finally {
      setSaving(false);
    }
  }

  async function refreshGatewayConfigHealth() {
    setGatewayConfigLoading(true);
    setGatewayConfigError(null);
    try {
      const result = await invoke<GatewayConfigHealth>("get_gateway_config_health");
      setGatewayConfigHealth(result);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setGatewayConfigError(`Failed to check gateway config health: ${detail}`);
    } finally {
      setGatewayConfigLoading(false);
    }
  }

  async function healGatewayConfig() {
    const confirmed = await ask(
      "Run OpenClaw doctor --fix and restart the gateway now? This can briefly interrupt active gateway connections.",
      {
        title: "Heal Gateway Config",
        kind: "warning",
        okLabel: "Heal and Restart",
        cancelLabel: "Cancel",
      }
    );
    if (!confirmed) {
      return;
    }

    setGatewayConfigActionLoading(true);
    setGatewayConfigError(null);
    setGatewayConfigNotice(null);
    try {
      const result = await invoke<GatewayHealResult>("heal_gateway_config");
      setGatewayConfigNotice(result.message || "Gateway config healed.");
      await refreshGatewayConfigHealth();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setGatewayConfigError(`Failed to heal gateway config: ${detail}`);
    } finally {
      setGatewayConfigActionLoading(false);
    }
  }

  const gatewayConfigInvalid = gatewayConfigHealth?.status === "invalid";
  const filteredGatewayDiagLogs = gatewayDiagLogs.filter((entry) => diagTypeFilters[entry.type]);
  const gatewayDiagCounts = gatewayDiagLogs.reduce<Record<DiagnosticLogType, number>>(
    (counts, entry) => {
      counts[entry.type] += 1;
      return counts;
    },
    { info: 0, warn: 0, error: 0 },
  );

  function toggleDiagType(type: DiagnosticLogType) {
    setDiagTypeFilters((prev) => ({ ...prev, [type]: !prev[type] }));
  }

  function handleClearGatewayDiagnostics() {
    clearDiagnosticLogs();
    setGatewayDiagLogs([]);
  }

  function formatGatewayDiagnostics(entries: DiagnosticLogEntry[]): string {
    return entries
      .map((entry) => `[${new Date(entry.ts).toISOString()}] [${entry.type.toUpperCase()}] ${entry.message}`)
      .join("\n");
  }

  async function copyGatewayDiagnostics(entries: DiagnosticLogEntry[]) {
    const payload = formatGatewayDiagnostics(entries);
    if (!payload.trim()) return;
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(payload);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = payload;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
      }
      alert("Diagnostics copied.");
    } catch (error) {
      console.error("[Entropic] Failed to copy diagnostics:", error);
      alert("Failed to copy diagnostics.");
    }
  }

  function exportGatewayDiagnostics(entries: DiagnosticLogEntry[]) {
    const payload = formatGatewayDiagnostics(entries);
    if (!payload.trim()) return;
    try {
      const blob = new Blob([payload], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      a.href = url;
      a.download = `entropic-diagnostics-${ts}.log`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error("[Entropic] Failed to export diagnostics:", error);
      alert("Failed to export diagnostics.");
    }
  }

  return (
    <div className="max-w-3xl mx-auto py-8 px-4">
      <h1 className="text-2xl font-bold mb-8 px-1">Settings</h1>

      {gatewayConfigInvalid && (
        <div className="mb-6 rounded-xl border border-amber-300 bg-amber-50 p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-sm font-semibold text-amber-900">Gateway config warning</div>
              <div className="text-xs text-amber-800 mt-1">
                {gatewayConfigHealth?.summary || "Gateway config is invalid."}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={refreshGatewayConfigHealth}
                disabled={gatewayConfigLoading || gatewayConfigActionLoading}
                className="px-3 py-1.5 text-xs font-medium rounded-md border border-amber-300 text-amber-900 hover:bg-amber-100 disabled:opacity-50"
              >
                {gatewayConfigLoading ? "Checking..." : "Recheck"}
              </button>
              <button
                type="button"
                onClick={healGatewayConfig}
                disabled={gatewayConfigLoading || gatewayConfigActionLoading}
                className="px-3 py-1.5 text-xs font-semibold rounded-md bg-amber-700 text-white hover:bg-amber-800 disabled:opacity-50"
              >
                {gatewayConfigActionLoading ? "Healing..." : "Heal Config"}
              </button>
            </div>
          </div>
          {gatewayConfigHealth?.issues?.length ? (
            <ul className="mt-3 text-xs text-amber-900 space-y-1 list-disc list-inside">
              {gatewayConfigHealth.issues.slice(0, 4).map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          ) : null}
        </div>
      )}

      <SettingsGroup title="Profile">
        <div className="p-4 flex items-start gap-6">
          <div className="relative group cursor-pointer flex-shrink-0">
            <div className="w-20 h-20 rounded-full bg-[var(--system-gray-5)] overflow-hidden shadow-sm">
              {profileAvatarDataUrl ? (
                <img src={profileAvatarDataUrl} alt="Avatar" className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-2xl font-semibold text-[var(--text-secondary)]">
                  {getProfileInitials(profileDisplayName, 2)}
                </div>
              )}
            </div>
            <input
              type="file"
              accept="image/*"
              className="absolute inset-0 opacity-0 cursor-pointer"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = () => {
                  const avatarDataUrl = reader.result as string;
                  setProfile((p) => {
                    const next = { ...p, avatarDataUrl };
                    saveProfile(next)
                      .then(() => window.dispatchEvent(new Event("entropic-profile-updated")))
                      .catch(() => {});
                    invoke("set_identity", {
                      name: next.name,
                      avatarDataUrl: next.avatarDataUrl ?? null,
                    }).catch(() => {});
                    return next;
                  });
                };
                reader.readAsDataURL(file);
              }}
            />
          </div>
          
          <div className="flex-1 space-y-4 pt-1">
            <div>
              <label className="text-xs font-bold text-[var(--text-secondary)] uppercase tracking-wide block mb-1">Name</label>
              <input
                type="text"
                value={profile.name}
                onChange={(e) => {
                  const newName = e.target.value;
                  setProfile(p => ({ ...p, name: newName }));
                  saveProfile({ ...profile, name: newName }).catch(() => {});
                  window.dispatchEvent(new Event("entropic-profile-updated"));
                }}
                onBlur={(e) => {
                  invoke("set_identity", {
                    name: e.target.value,
                    avatarDataUrl: profileAvatarDataUrl ?? null,
                  }).catch(() => {});
                }}
                className="w-full bg-transparent text-xl font-bold text-[var(--text-primary)] focus:outline-none border-b border-transparent focus:border-[var(--system-blue)] transition-colors placeholder:text-[var(--text-tertiary)]"
                placeholder="Name your agent"
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs font-bold text-[var(--text-secondary)] uppercase tracking-wide">Personality</label>
                <button 
                  onClick={() => setIsEditingPersonality(!isEditingPersonality)}
                  className="text-xs font-semibold text-[var(--system-blue)] hover:underline"
                >
                  {isEditingPersonality ? "Done" : "Edit"}
                </button>
              </div>
              
              {isEditingPersonality ? (
                <div className="space-y-3 animate-fade-in">
                  <div className="flex flex-wrap gap-2 mb-2">
                    {PERSONALITY_TEMPLATES.map((t) => (
                      <button
                        key={t.label}
                        onClick={() => {
                          setSoul(t.text);
                          invoke("set_personality", { soul: t.text });
                        }}
                        className="px-3 py-1 text-xs rounded-full bg-[var(--system-gray-6)] hover:bg-[var(--system-blue)] hover:text-white transition-colors border border-[var(--border-subtle)]"
                      >
                        {t.label}
                      </button>
                    ))}
                  </div>
                  <textarea 
                    value={soul} 
                    onChange={e => setSoul(e.target.value)}
                    onBlur={() => invoke("set_personality", { soul })}
                    className="w-full p-3 rounded-xl bg-[var(--system-gray-6)] border-transparent focus:bg-white focus:ring-2 focus:ring-[var(--system-blue)]/20 transition-all text-sm text-[var(--text-primary)] resize-none"
                    rows={4}
                    placeholder="Describe how your assistant should behave..."
                    autoFocus
                  />
                </div>
              ) : (
                <p className="text-sm text-[var(--text-secondary)] line-clamp-3 leading-relaxed">
                  {soul || "Default helpful assistant personality."}
                </p>
              )}
            </div>
          </div>
        </div>
      </SettingsGroup>

      {experimentalDesktop && (
        <SettingsGroup title="Appearance">
          <SettingsRow 
            label="Desktop Wallpaper" 
            icon={Palette} 
            description="Customize the background"
            onClick={() => setWallpaperPickerOpen(true)}
          >
            <div className="flex items-center gap-2">
              <div className="w-24 h-[72px] rounded-md bg-[var(--system-gray-5)] border border-[var(--border-subtle)] overflow-hidden shadow-sm">
                {(() => {
                  const wp = getWallpaperById(wallpaperId);
                  const isPhoto = (wallpaperId === "custom" && customWallpaper) || wp?.type === "photo";
                  const css = wallpaperId === "custom" && customWallpaper
                    ? `url(${customWallpaper})`
                    : wp?.css || WALLPAPERS[0].css;
                  return <div className="w-full h-full" style={isPhoto ? { backgroundImage: css, backgroundSize: "cover" } : { background: css }} />;
                })()}
              </div>
              <ChevronRight className="w-4 h-4 text-[var(--text-tertiary)]" />
            </div>
          </SettingsRow>
        </SettingsGroup>
      )}

      <SettingsGroup title="System">
        <SettingsRow label="Gateway Status" icon={Shield} description={gatewayRunning ? "Running on localhost:19789" : "Secure sandbox stopped"}>
          <button 
            onClick={onGatewayToggle} 
            disabled={isTogglingGateway}
            className={clsx(
              "relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none",
              (gatewayRunning || isTogglingGateway) ? "bg-[var(--system-blue)]" : "bg-[var(--system-gray-4)]"
            )}
          >
            <span
              className={clsx(
                "pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out",
                (gatewayRunning || isTogglingGateway) ? "translate-x-5" : "translate-x-0"
              )}
            />
          </button>
        </SettingsRow>

        <SettingsRow
          label="Use QMD Memory Backend"
          icon={Sparkles}
          description={
            memoryQmdEnabled
              ? "QMD backend enabled for memory search"
              : "Disabled (using builtin memory backend)"
          }
        >
          <button
            onClick={() => handleMemoryQmdToggle(!memoryQmdEnabled)}
            disabled={saving || !memoryEnabled}
            className={clsx(
              "relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none",
              memoryQmdEnabled && !saving ? "bg-[var(--system-blue)]" : "bg-[var(--system-gray-4)]",
              (!memoryEnabled || saving) && "opacity-50"
            )}
          >
            <span
              className={clsx(
                "pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out",
                memoryQmdEnabled && !saving ? "translate-x-5" : "translate-x-0"
              )}
            />
          </button>
        </SettingsRow>
        {memoryQmdError && (
          <div className="px-4 pb-4 pt-2 text-xs text-red-600">{memoryQmdError}</div>
        )}

        <SettingsRow
          label="Conversation Memory Indexing"
          icon={Sparkles}
          description={
            memorySessionIndexing
              ? "Index conversation summaries in qmd memory"
              : memoryEnabled
                ? "Conversation indexing disabled"
                : "Enable memory first to start indexing"
          }
        >
          <button
            onClick={() => handleMemorySessionIndexingChange(!memorySessionIndexing)}
            disabled={saving || !memoryEnabled}
            className={clsx(
              "relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none",
              memorySessionIndexing && !saving ? "bg-[var(--system-blue)]" : "bg-[var(--system-gray-4)]",
              (!memoryEnabled || saving) && "opacity-50"
            )}
          >
            <span
              className={clsx(
                "pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out",
                memorySessionIndexing && !saving ? "translate-x-5" : "translate-x-0"
              )}
            />
          </button>
        </SettingsRow>
        {memorySessionIndexingError && (
          <div className="px-4 pb-4 pt-2 text-xs text-red-600">{memorySessionIndexingError}</div>
        )}

        <SettingsRow
          label="Gateway Config Health"
          icon={AlertTriangle}
          description={gatewayConfigHealth?.summary || "Check gateway config validity"}
        >
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={refreshGatewayConfigHealth}
              disabled={gatewayConfigLoading || gatewayConfigActionLoading}
              className="px-3 py-1.5 text-xs font-medium rounded-md border border-[var(--border-subtle)] bg-white hover:bg-[var(--system-gray-6)] disabled:opacity-50"
            >
              {gatewayConfigLoading ? "Checking..." : "Check"}
            </button>
            <button
              type="button"
              onClick={healGatewayConfig}
              disabled={gatewayConfigLoading || gatewayConfigActionLoading}
              className="px-3 py-1.5 text-xs font-semibold rounded-md bg-black text-white hover:bg-gray-800 disabled:opacity-50"
            >
              {gatewayConfigActionLoading ? "Healing..." : "Heal"}
            </button>
          </div>
        </SettingsRow>
        {gatewayConfigError && (
          <div className="px-4 pb-4 pt-2 text-xs text-red-600">{gatewayConfigError}</div>
        )}
        {gatewayConfigNotice && (
          <div className="px-4 pb-4 pt-2 text-xs text-green-700">{gatewayConfigNotice}</div>
        )}
      </SettingsGroup>


      <div className="relative">
        <SettingsGroup title="Intelligence">
          <SettingsRow label="Primary Model" icon={Cpu}>
            <div className="w-80">
              <ModelSelector selectedModel={selectedModel} onModelChange={onModelChange} useLocalKeys={useLocalKeys} connectedProviders={useLocalKeys ? connectedProviders : undefined} />
            </div>
          </SettingsRow>
          {!useLocalKeys && (
            <>
              <SettingsRow label="Coding Model" icon={Cpu}>
                <div className="w-80">
                  <ModelSelector selectedModel={codeModel} onModelChange={onCodeModelChange} useLocalKeys={useLocalKeys} connectedProviders={useLocalKeys ? connectedProviders : undefined} />
                </div>
              </SettingsRow>
              <SettingsRow label="Vision Model" icon={Image}>
                <div className="w-80">
                  <ModelSelector selectedModel={imageModel} onModelChange={onImageModelChange} useLocalKeys={useLocalKeys} connectedProviders={useLocalKeys ? connectedProviders : undefined} />
                </div>
              </SettingsRow>
            </>
          )}
        </SettingsGroup>
      </div>

      <SettingsGroup title="Keys">
        <SettingsRow
          label="Enable experimental desktop"
          icon={Sparkles}
          description='Show "Desktop" in navigation'
        >
          <button
            onClick={() => onExperimentalDesktopChange(!experimentalDesktop)}
            className={clsx(
              "relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none",
              experimentalDesktop ? "bg-[var(--system-blue)]" : "bg-[var(--system-gray-4)]"
            )}
            aria-label="Enable experimental desktop"
          >
            <span
              className={clsx(
                "pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out",
                experimentalDesktop ? "translate-x-5" : "translate-x-0"
              )}
            />
          </button>
        </SettingsRow>
        <SettingsRow
          label="Use Local Keys"
          icon={Key}
          description={
            useLocalKeys
              ? "Local provider keys in the gateway container"
              : proxyEnabled
                ? `Proxy mode via ${getProxyUrl()}`
                : isAuthConfigured
                  ? "Sign in to enable proxy mode"
                  : "Auth not configured; local keys only"
          }
        >
          <button
            onClick={() => onUseLocalKeysChange(!useLocalKeys)}
            className={clsx(
              "relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none",
              useLocalKeys ? "bg-[var(--system-blue)]" : "bg-[var(--system-gray-4)]"
            )}
          >
            <span
              className={clsx(
                "pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out",
                useLocalKeys ? "translate-x-5" : "translate-x-0"
              )}
            />
          </button>
        </SettingsRow>

        {useLocalKeys && (
          <>
            {/* Anthropic (Claude) OAuth */}
            {(() => {
              const isConnected = oauthStatus["anthropic"] === "claude_code";
              const providerAuth = authState.providers.find(p => p.id === "anthropic");
              const hasKey = providerAuth?.has_key ?? false;
              const last4 = providerAuth?.last4;
              const isLoading = oauthLoading === "anthropic";

              return (
                <>
                  <SettingsRow
                    label="Claude (OAuth)"
                    icon={LogIn}
                    description={
                      isConnected && last4
                        ? `Connected (...${last4})`
                        : anthropicCodePending
                          ? "Paste the code from your browser"
                          : hasKey
                            ? `API key set (...${last4 || "****"})`
                            : "Sign in with your Claude Code account"
                    }
                  >
                    {isLoading ? (
                      <Loader2 className="w-4 h-4 animate-spin text-[var(--text-tertiary)]" />
                    ) : isConnected ? (
                      <button
                        onClick={() => handleOAuthDisconnect("anthropic")}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg text-red-600 hover:bg-red-50 transition-colors"
                      >
                        <LogOut className="w-3.5 h-3.5" />
                        Disconnect
                      </button>
                    ) : anthropicCodePending ? (
                      <button
                        onClick={() => { setAnthropicCodePending(false); setAnthropicCodeInput(""); }}
                        className="text-xs text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] transition-colors"
                      >
                        Cancel
                      </button>
                    ) : (
                      <button
                        onClick={() => handleOAuthLogin("anthropic")}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-[var(--system-blue)] text-white hover:bg-[var(--system-blue)]/90 transition-colors"
                      >
                        <LogIn className="w-3.5 h-3.5" />
                        Sign in
                      </button>
                    )}
                  </SettingsRow>
                  {anthropicCodePending && (
                    <div className="px-4 pb-3 flex gap-2">
                      <input
                        type="text"
                        value={anthropicCodeInput}
                        onChange={(e) => setAnthropicCodeInput(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") handleAnthropicCodeSubmit(); }}
                        placeholder="Paste code here..."
                        className="flex-1 px-3 py-1.5 text-xs rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-secondary)] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:ring-1 focus:ring-[var(--system-blue)]"
                        autoFocus
                      />
                      <button
                        onClick={handleAnthropicCodeSubmit}
                        disabled={!anthropicCodeInput.trim()}
                        className="px-3 py-1.5 text-xs font-medium rounded-lg bg-[var(--system-blue)] text-white hover:bg-[var(--system-blue)]/90 disabled:opacity-40 transition-colors"
                      >
                        Connect
                      </button>
                    </div>
                  )}
                </>
              );
            })()}

            {/* OpenAI OAuth */}
            {(() => {
              const isConnected = oauthStatus["openai"] === "openai_codex";
              const providerAuth = authState.providers.find(p => p.id === "openai");
              const hasKey = providerAuth?.has_key ?? false;
              const last4 = providerAuth?.last4;
              const isLoading = oauthLoading === "openai";

              return (
                <SettingsRow
                  label="OpenAI (OAuth)"
                  icon={LogIn}
                  description={
                    isConnected && last4
                      ? `Connected (...${last4})`
                      : hasKey
                        ? `API key set (...${last4 || "****"})`
                        : "Sign in with your OpenAI / Codex account"
                  }
                >
                  {isLoading ? (
                    <Loader2 className="w-4 h-4 animate-spin text-[var(--text-tertiary)]" />
                  ) : isConnected ? (
                    <button
                      onClick={() => handleOAuthDisconnect("openai")}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg text-red-600 hover:bg-red-50 transition-colors"
                    >
                      <LogOut className="w-3.5 h-3.5" />
                      Disconnect
                    </button>
                  ) : (
                    <button
                      onClick={() => handleOAuthLogin("openai")}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-[var(--system-blue)] text-white hover:bg-[var(--system-blue)]/90 transition-colors"
                    >
                      <LogIn className="w-3.5 h-3.5" />
                      Sign in
                    </button>
                  )}
                </SettingsRow>
              );
            })()}

            {oauthError && (
              <div className="px-4 pb-3 pt-1 text-xs text-red-600">{oauthError}</div>
            )}
          </>
        )}
      </SettingsGroup>

      <SettingsGroup title="Diagnostics">
        <div>
          <button
            onClick={() => setGatewayDiagnosticsExpanded((prev) => !prev)}
            className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left"
          >
            <div className="flex items-center gap-3">
              <div className="w-7 h-7 rounded-md bg-[var(--system-gray-6)] text-[var(--text-tertiary)] flex items-center justify-center flex-shrink-0">
                <ScrollText className="w-4 h-4" />
              </div>
              <div>
                <div className="text-[14px] font-medium text-[var(--text-primary)]">Gateway Diagnostics</div>
                <div className="text-[12px] text-[var(--text-secondary)]">Moved from Chat. Filter by log type below.</div>
              </div>
            </div>
            <ChevronDown
              className={clsx(
                "w-4 h-4 text-[var(--text-tertiary)] transition-transform duration-200",
                gatewayDiagnosticsExpanded ? "rotate-180" : "",
              )}
            />
          </button>
          {gatewayDiagnosticsExpanded && (
            <div className="px-4 pb-4 space-y-4">
              <div className="flex items-center justify-end gap-2">
                <button
                  onClick={() => setGatewayDiagLogs(readDiagnosticLogs())}
                  className="px-2 py-1 text-xs rounded-md border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:bg-[var(--system-gray-6)]"
                >
                  Refresh
                </button>
                <button
                  onClick={() => void copyGatewayDiagnostics(filteredGatewayDiagLogs)}
                  disabled={filteredGatewayDiagLogs.length === 0}
                  className="px-2 py-1 text-xs rounded-md border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:bg-[var(--system-gray-6)] disabled:opacity-50 flex items-center gap-1"
                >
                  <Copy className="w-3 h-3" />
                  Copy
                </button>
                <button
                  onClick={() => exportGatewayDiagnostics(filteredGatewayDiagLogs)}
                  disabled={filteredGatewayDiagLogs.length === 0}
                  className="px-2 py-1 text-xs rounded-md border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:bg-[var(--system-gray-6)] disabled:opacity-50 flex items-center gap-1"
                >
                  <Download className="w-3 h-3" />
                  Export
                </button>
                <button
                  onClick={handleClearGatewayDiagnostics}
                  className="px-2 py-1 text-xs rounded-md border border-red-200 text-red-600 hover:bg-red-50"
                >
                  Clear
                </button>
              </div>

              <div className="flex items-center gap-2 flex-wrap">
                {(["info", "warn", "error"] as DiagnosticLogType[]).map((type) => {
                  const enabled = diagTypeFilters[type];
                  const count = gatewayDiagCounts[type];
                  return (
                    <button
                      key={type}
                      onClick={() => toggleDiagType(type)}
                      className={clsx(
                        "px-2.5 py-1 rounded-md text-xs font-medium border transition-colors",
                        enabled
                          ? "border-[var(--system-blue)] bg-[var(--system-blue)]/10 text-[var(--system-blue)]"
                          : "border-[var(--border-subtle)] text-[var(--text-tertiary)] hover:bg-[var(--system-gray-6)]",
                      )}
                    >
                      {type.toUpperCase()} ({count})
                    </button>
                  );
                })}
              </div>

              <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-tertiary)] max-h-64 overflow-auto p-3 space-y-1 font-mono text-xs">
                {filteredGatewayDiagLogs.length === 0 ? (
                  <div className="text-[var(--text-tertiary)]">No diagnostics for the selected log types.</div>
                ) : (
                  filteredGatewayDiagLogs.map((entry) => (
                    <div key={entry.id} className="flex items-start gap-2">
                      <span className="text-[var(--text-tertiary)] shrink-0">
                        {new Date(entry.ts).toLocaleTimeString()}
                      </span>
                      <span
                        className={clsx(
                          "shrink-0 uppercase text-[10px] font-semibold px-1.5 py-0.5 rounded",
                          entry.type === "info" && "bg-blue-100 text-blue-700",
                          entry.type === "warn" && "bg-amber-100 text-amber-700",
                          entry.type === "error" && "bg-red-100 text-red-700",
                        )}
                      >
                        {entry.type}
                      </span>
                      <span className="text-[var(--text-secondary)] break-words">{entry.message}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>

        <div>
          <button
            onClick={() => setLogsExpanded((prev) => !prev)}
            className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left"
          >
            <div className="flex items-center gap-3">
              <div className="w-7 h-7 rounded-md bg-[var(--system-gray-6)] text-[var(--text-tertiary)] flex items-center justify-center flex-shrink-0">
                <ScrollText className="w-4 h-4" />
              </div>
              <div>
                <div className="text-[14px] font-medium text-[var(--text-primary)]">Local Runtime Logs</div>
                <div className="text-[12px] text-[var(--text-secondary)]">Expand to inspect gateway/container logs</div>
              </div>
            </div>
            <ChevronDown
              className={clsx(
                "w-4 h-4 text-[var(--text-tertiary)] transition-transform duration-200",
                logsExpanded ? "rotate-180" : "",
              )}
            />
          </button>
          {logsExpanded && (
            <div className="px-4 pb-4">
              <Logs compact />
            </div>
          )}
        </div>
      </SettingsGroup>

      <SettingsGroup title="Data Management">
        <div className="p-4 space-y-4">
          <div className="flex items-start gap-3">
            <div className="w-7 h-7 rounded-md bg-blue-50 text-blue-600 flex items-center justify-center flex-shrink-0">
              <Cpu className="w-4 h-4" />
            </div>
            <div className="flex-1">
              <div className="text-[14px] font-medium text-[var(--text-primary)] mb-1">Fetch Latest OpenClaw Runtime</div>
              <div className="text-[12px] text-[var(--text-secondary)] mb-3">
                Refresh the runtime manifest and cache the newest OpenClaw runtime tar for faster startup and updates.
              </div>
              <button
                onClick={async () => {
                  setRuntimeFetchLoading(true);
                  try {
                    const result = await invoke<RuntimeFetchResult>("fetch_latest_openclaw_runtime");
                    invoke<RuntimeVersionInfo>("get_runtime_version_info").then(setRuntimeVersionInfo).catch(() => {});
                    const shortCommit = result.runtime_openclaw_commit
                      ? ` (${result.runtime_openclaw_commit.slice(0, 7)})`
                      : "";
                    alert(
                      "Runtime cache updated.\n\n" +
                        `Version: ${result.runtime_version}${shortCommit}\n` +
                        `SHA256: ${result.runtime_sha256}\n` +
                        `Path: ${result.cache_path}`
                    );
                  } catch (err) {
                    alert("Failed to fetch latest runtime: " + (err instanceof Error ? err.message : String(err)));
                  } finally {
                    setRuntimeFetchLoading(false);
                  }
                }}
                disabled={runtimeFetchLoading}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {runtimeFetchLoading && <Loader2 className="w-4 h-4 animate-spin" />}
                {runtimeFetchLoading ? "Fetching..." : "Fetch Latest Runtime"}
              </button>
            </div>
          </div>

          <div className="flex items-start gap-3">
            <div className="w-7 h-7 rounded-md bg-amber-50 text-amber-600 flex items-center justify-center flex-shrink-0">
              <AlertTriangle className="w-4 h-4" />
            </div>
            <div className="flex-1">
              <div className="text-[14px] font-medium text-[var(--text-primary)] mb-1">Import Legacy Entropic Data</div>
              <div className="text-[12px] text-[var(--text-secondary)] mb-3">
                Imports auth/session/profile/settings files from a previous Entropic install into this app data directory.
              </div>
              <button
                onClick={async () => {
                  setLegacyMigrationLoading(true);
                  try {
                    const result = await invoke<string>("migrate_legacy_nova_data");
                    alert("Legacy migration complete.\n\n" + result);
                  } catch (err) {
                    alert("Legacy migration failed: " + (err instanceof Error ? err.message : String(err)));
                  } finally {
                    setLegacyMigrationLoading(false);
                  }
                }}
                disabled={legacyMigrationLoading}
                className="px-4 py-2 bg-amber-600 hover:bg-amber-700 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {legacyMigrationLoading && <Loader2 className="w-4 h-4 animate-spin" />}
                {legacyMigrationLoading ? "Importing..." : "Import Entropic Data"}
              </button>

              <button
                onClick={async () => {
                  const confirmed = await ask(
                    "Import data from previous install, then fully reset runtime VMs/containers/volumes to fix Colima or Docker drift? Runtime workspace data may be removed, but imported auth/settings are kept.",
                    {
                      title: "Import + Runtime Reset",
                      kind: "warning",
                      okLabel: "Import and Reset",
                      cancelLabel: "Cancel",
                    }
                  );
                  if (!confirmed) return;
                  setLegacyUpgradeLoading(true);
                  try {
                    const result = await invoke<string>("migrate_legacy_nova_install", {
                      cleanupRuntime: true,
                    });
                    alert("Legacy upgrade migration completed.\n\n" + result);
                  } catch (err) {
                    alert(
                      "Legacy upgrade migration failed: " +
                        (err instanceof Error ? err.message : String(err))
                    );
                  } finally {
                    setLegacyUpgradeLoading(false);
                  }
                }}
                disabled={legacyUpgradeLoading}
                className="mt-2 px-4 py-2 bg-gray-700 hover:bg-gray-800 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {legacyUpgradeLoading && <Loader2 className="w-4 h-4 animate-spin" />}
                {legacyUpgradeLoading
                  ? "Importing + Resetting..."
                  : "Import + Runtime Reset"}
              </button>
            </div>
          </div>

          <div className="flex items-start gap-3">
            <div className="w-7 h-7 rounded-md bg-red-50 text-red-600 flex items-center justify-center flex-shrink-0">
              <Trash2 className="w-4 h-4" />
            </div>
            <div className="flex-1">
              <div className="text-[14px] font-medium text-[var(--text-primary)] mb-1">Reset Application</div>
              <div className="text-[12px] text-[var(--text-secondary)] mb-3">
                Clean up Entropic + legacy Nova Colima VMs, Docker containers, volumes, and app cache. Your auth settings will be preserved.
              </div>
              <button
                onClick={async () => {
                  console.log("[Settings] Reset Application clicked");
                  const confirmed = await ask("Are you sure you want to reset the application? This also removes legacy Nova runtime data.", {
                    title: "Reset Application",
                    kind: "warning",
                    okLabel: "Reset",
                    cancelLabel: "Cancel"
                  });
                  console.log("[Settings] Confirmation result:", confirmed);
                  if (!confirmed) {
                    console.log("[Settings] Reset cancelled by user");
                    return;
                  }

                  setCleanupLoading(true);
                  console.log("[Settings] Starting cleanup...");
                  try {
                    const result = await invoke<string>("cleanup_app_data", { includeVms: true });
                    console.log("[Settings] Cleanup succeeded:", result);
                    alert("Cleanup completed!\n\n" + result);
                  } catch (err) {
                    console.error("[Settings] Cleanup failed:", err);
                    alert("Cleanup failed: " + (err instanceof Error ? err.message : String(err)));
                  } finally {
                    setCleanupLoading(false);
                    console.log("[Settings] Cleanup finished");
                  }
                }}
                disabled={cleanupLoading}
                className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {cleanupLoading && <Loader2 className="w-4 h-4 animate-spin" />}
                {cleanupLoading ? "Cleaning up..." : "Reset Application"}
              </button>
            </div>
          </div>

          <div className="border-t border-[var(--border-subtle)] pt-4">
            <div className="flex items-start gap-3">
              <div className="w-7 h-7 rounded-md bg-gray-100 text-gray-600 flex items-center justify-center flex-shrink-0">
                <LogOut className="w-4 h-4" />
              </div>
              <div className="flex-1">
                <div className="text-[14px] font-medium text-[var(--text-primary)] mb-1">Uninstall Entropic</div>
                <div className="text-[12px] text-[var(--text-secondary)] mb-3">
                  Clean up all data and quit the app. After this, you can move Entropic to trash.
                </div>
                <div className="flex items-center gap-2 p-3 bg-blue-50 border border-blue-200 rounded-lg mb-3">
                  <AlertTriangle className="w-4 h-4 text-blue-600 flex-shrink-0" />
                  <p className="text-xs text-blue-800">
                    This will delete everything including your settings. Use "Reset Application" instead if you plan to reinstall.
                  </p>
                </div>
                <button
                  onClick={async () => {
                    console.log("[Settings] Cleanup and Quit clicked");
                    const confirmed = await ask("Are you sure you want to completely uninstall Entropic?\n\nThis will delete all data including settings and quit the app. You can then move Entropic.app to trash.\n\nThis action cannot be undone.", {
                      title: "Uninstall Entropic",
                      kind: "warning",
                      okLabel: "Uninstall",
                      cancelLabel: "Cancel"
                    });
                    console.log("[Settings] Confirmation result:", confirmed);
                    if (!confirmed) {
                      console.log("[Settings] Uninstall cancelled by user");
                      return;
                    }

                    setCleanupLoading(true);
                    console.log("[Settings] Starting uninstall cleanup...");
                    try {
                      const result = await invoke<string>("cleanup_app_data", { includeVms: true });
                      console.log("[Settings] Cleanup succeeded:", result);

                      // Also clear auth settings for complete uninstall
                      console.log("[Settings] Clearing auth settings...");
                      const store = await Store.load("auth.json");
                      await store.clear();
                      await store.save();

                      alert("Uninstall cleanup completed!\n\n" + result + "\n\nThe app will now quit. You can move Entropic to trash.");

                      // Quit the app
                      console.log("[Settings] Quitting app...");
                      const { exit } = await import("@tauri-apps/plugin-process");
                      await exit(0);
                    } catch (err) {
                      console.error("[Settings] Cleanup failed:", err);
                      alert("Cleanup failed: " + (err instanceof Error ? err.message : String(err)));
                      setCleanupLoading(false);
                    }
                  }}
                  disabled={cleanupLoading}
                  className="px-4 py-2 bg-gray-600 hover:bg-gray-700 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                >
                  {cleanupLoading && <Loader2 className="w-4 h-4 animate-spin" />}
                  {cleanupLoading ? "Cleaning up..." : "Cleanup and Quit"}
                </button>
              </div>
            </div>
          </div>
        </div>
      </SettingsGroup>

      <div className="px-1 pb-2 text-xs text-[var(--text-tertiary)] space-y-1">
        <div>Entropic v{runtimeVersionInfo?.entropic_version ?? "..."}</div>
        <div>
          Entropic Manifest {runtimeVersionInfo?.app_manifest_version ?? "unavailable"}
          {appManifestDate ? ` (${appManifestDate})` : ""}
        </div>
        <div>
          OpenClaw Runtime {runtimeVersionInfo?.runtime_version ?? "unknown"}
          {runtimeVersionInfo?.runtime_openclaw_commit
            ? ` (${runtimeVersionInfo.runtime_openclaw_commit.slice(0, 7)})`
            : ""}
        </div>
        <div>
          Applied Runtime{" "}
          {runtimeVersionInfo?.applied_runtime_version
            ? runtimeVersionInfo.applied_runtime_version
            : appliedRuntimeDigest
              ? `image ${appliedRuntimeDigest}`
              : "not loaded"}
          {runtimeVersionInfo?.applied_runtime_openclaw_commit
            ? ` (${runtimeVersionInfo.applied_runtime_openclaw_commit.slice(0, 7)})`
            : ""}
        </div>
      </div>

      {/* Wallpaper Picker Modal */}
      {wallpaperPickerOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/20"
          onClick={() => setWallpaperPickerOpen(false)}
        >
          <div
            className="bg-white rounded-xl shadow-2xl p-6 w-full max-w-4xl max-h-[85vh] overflow-auto border border-[var(--border-subtle)]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-lg font-semibold">Choose Wallpaper</h2>
              <button onClick={() => setWallpaperPickerOpen(false)} className="btn-secondary">Done</button>
            </div>

            <div className="space-y-8">
              <div>
                <h4 className="text-sm font-semibold text-[var(--text-secondary)] uppercase mb-4 tracking-wide">Scenic</h4>
                <div className="grid grid-cols-3 sm:grid-cols-4 gap-4">
                  {WALLPAPERS.filter((wp) => wp.type === "photo").map((wp) => (
                    <button
                      key={wp.id}
                      onClick={() => handleWallpaperPick(wp.id)}
                      className={clsx(
                        "aspect-video rounded-xl overflow-hidden transition-all hover:opacity-90 shadow-sm hover:shadow-md",
                        wallpaperId === wp.id ? "ring-4 ring-[var(--system-blue)] ring-offset-2" : ""
                      )}
                    >
                      <div 
                        className="w-full h-full bg-cover bg-center"
                        style={{ backgroundImage: wp.thumbnail ? `url(${wp.thumbnail})` : wp.css }}
                      />
                    </button>
                  ))}
                </div>
              </div>
              
              <div>
                <h4 className="text-sm font-semibold text-[var(--text-secondary)] uppercase mb-4 tracking-wide">Colors</h4>
                <div className="grid grid-cols-6 sm:grid-cols-8 gap-4">
                  {WALLPAPERS.filter((wp) => wp.type === "gradient").map((wp) => (
                    <button
                      key={wp.id}
                      onClick={() => handleWallpaperPick(wp.id)}
                      className={clsx(
                        "aspect-square rounded-full overflow-hidden transition-all hover:scale-105 shadow-sm",
                        wallpaperId === wp.id ? "ring-4 ring-[var(--system-blue)] ring-offset-2" : ""
                      )}
                      style={{ background: wp.css }}
                    />
                  ))}
                </div>
              </div>

              <div>
                <button
                   onClick={() => wallpaperInputRef.current?.click()}
                   className="flex items-center gap-2 text-[var(--system-blue)] hover:underline text-sm font-medium"
                >
                  <Plus className="w-4 h-4" />
                  Upload Custom Image...
                </button>
                <input ref={wallpaperInputRef} type="file" accept="image/*" className="hidden" onChange={handleCustomWallpaperUpload} />
              </div>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

// Icon for the upload button
function Plus({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
    </svg>
  );
}
