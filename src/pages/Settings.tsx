import { useEffect, useState, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Store } from "@tauri-apps/plugin-store";
import { ask } from "@tauri-apps/plugin-dialog";
import { Key, Shield, Sparkles, Cpu, Image, ChevronRight, User, Palette, ChevronDown, ScrollText, LogIn, LogOut, Loader2, Trash2, AlertTriangle, Copy, Download, Sun, Moon, Monitor, RotateCcw } from "lucide-react";
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
import {
  LOCAL_IMAGE_GENERATION_MODELS,
  ModelSelector,
  PROXY_IMAGE_GENERATION_MODELS,
} from "../components/ModelSelector";
import { WALLPAPERS, DEFAULT_WALLPAPER_ID, getWallpaperById } from "../lib/wallpapers";
import { getProxyUrl, signOut as authSignOut } from "../lib/auth";
import { disconnectIntegration, resetIntegrationState } from "../lib/integrations";
import { resetIntegrationVaultSession } from "../lib/vault";
import { Logs } from "./Logs";
import {
  clearDiagnosticLogs,
  diagnosticsUpdatedEventName,
  readDiagnosticLogs,
  type DiagnosticLogEntry,
  type DiagnosticLogType,
} from "../lib/diagnostics";
import { loadDesktopSettings, updateDesktopSettings } from "../lib/settingsStore";
import {
  getCachedSettingsWarmState,
  loadSettingsWarmState,
  type AgentProfileState,
  type AuthStateSnapshot,
  type RuntimeVersionInfo,
} from "../lib/settingsWarmState";
import {
  checkForAppUpdates,
  readUpdaterStatus,
  updaterStatusEventName,
  type UpdaterStatus,
} from "../lib/updater";
import { updaterEnabled } from "../lib/buildProfile";
type Props = {
  gatewayRunning: boolean;
  onGatewayToggle: () => void;
  onApplyRuntimeResources?: () => void | Promise<void>;
  isTogglingGateway: boolean;
  selectedModel: string;
  onModelChange: (model: string) => void;
  useLocalKeys: boolean;
  onUseLocalKeysChange: (value: boolean) => void | Promise<void>;
  codeModel: string;
  imageModel: string;
  imageGenerationModel: string;
  onCodeModelChange: (model: string) => void;
  onImageGenerationModelChange: (model: string) => void;
  onImageModelChange: (model: string) => void;
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

type RuntimeFetchResult = {
  runtime_version: string;
  runtime_openclaw_commit?: string | null;
  runtime_sha256: string;
  runtime_download_asset_name?: string | null;
  runtime_download_size_bytes?: number | null;
  cache_path: string;
};

const RESET_STORE_FILES = [
  "entropic-auth.json",
  "entropic-settings.json",
  "entropic-chat-history.json",
  "entropic-integrations.json",
  "entropic-profile.json",
  "auth.json",
];

type RuntimeResourceUsage = {
  running: boolean;
  container?: string | null;
  vm_cpu_count?: number | null;
  vm_memory_total_bytes?: number | null;
  cpu_percent?: number | null;
  memory_used_bytes?: number | null;
  memory_limit_bytes?: number | null;
  disk_used_bytes?: number | null;
  disk_total_bytes?: number | null;
  data_used_bytes?: number | null;
};

type LocalKeyProvider = "anthropic" | "google" | "openai";

function clampRuntimeCpu(value?: number | null) {
  return Math.min(16, Math.max(1, value ?? 2));
}

function clampRuntimeMemoryGb(value?: number | null) {
  return Math.min(64, Math.max(2, value ?? 4));
}

function clampRuntimeDiskGb(value?: number | null) {
  return Math.min(500, Math.max(20, value ?? 20));
}

function SettingsGroup({ title, children }: { title?: string, children: React.ReactNode }) {
  return (
    <div className="mb-8">
      {title && (
        <h3 className="text-[13px] font-medium text-[var(--text-secondary)] uppercase tracking-wide mb-2 px-1">
          {title}
        </h3>
      )}
      <div className="bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-xl overflow-hidden shadow-sm divide-y divide-[var(--border-subtle)]">
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

function formatBytes(value?: number | null) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let next = value;
  let unitIndex = 0;
  while (next >= 1024 && unitIndex < units.length - 1) {
    next /= 1024;
    unitIndex += 1;
  }
  const digits = next >= 10 || unitIndex === 0 ? 0 : 1;
  return `${next.toFixed(digits)} ${units[unitIndex]}`;
}

function formatDateTime(value?: number | null) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "Never";
  return new Date(value).toLocaleString();
}

function assertNever(value: never): never {
  throw new Error(`Unhandled updater status: ${JSON.stringify(value)}`);
}

function scheduleDeferredSettingsWork(work: () => void, delayMs = 0) {
  let rafId: number | null = null;
  let timeoutId: number | null = null;

  rafId = window.requestAnimationFrame(() => {
    timeoutId = window.setTimeout(work, delayMs);
  });

  return () => {
    if (rafId !== null) {
      window.cancelAnimationFrame(rafId);
    }
    if (timeoutId !== null) {
      window.clearTimeout(timeoutId);
    }
  };
}

export function Settings({
  gatewayRunning,
  onGatewayToggle,
  onApplyRuntimeResources,
  isTogglingGateway,
  selectedModel,
  onModelChange,
  useLocalKeys,
  onUseLocalKeysChange,
  codeModel,
  imageModel,
  imageGenerationModel,
  onCodeModelChange,
  onImageGenerationModelChange,
  onImageModelChange,
}: Props) {
  const cachedWarmState = getCachedSettingsWarmState();
  const cachedAgentProfileState = cachedWarmState?.agentProfileState;
  const initialRuntimeCpu = clampRuntimeCpu(cachedAgentProfileState?.runtime_cpu);
  const initialRuntimeMemoryGb = clampRuntimeMemoryGb(cachedAgentProfileState?.runtime_memory_gb);
  const initialRuntimeDiskGb = clampRuntimeDiskGb(cachedAgentProfileState?.runtime_disk_gb);
  const { isAuthenticated, isAuthConfigured, user, signOut } = useAuth();
  const proxyEnabled = isAuthConfigured && isAuthenticated && !useLocalKeys;
  const [apiKeys, setApiKeys] = useState({ anthropic: "", openai: "", google: "" });
  const [localKeySavingProvider, setLocalKeySavingProvider] =
    useState<LocalKeyProvider | null>(null);
  const [localKeyError, setLocalKeyError] = useState<string | null>(null);
  const [localKeyNotice, setLocalKeyNotice] = useState<string | null>(null);
  const [profile, setProfile] = useState<AgentProfile>(cachedWarmState?.profile ?? { name: "Entropic" });
  const [runtimeCpu, setRuntimeCpu] = useState(initialRuntimeCpu);
  const [runtimeMemoryGb, setRuntimeMemoryGb] = useState(initialRuntimeMemoryGb);
  const [runtimeDiskGb, setRuntimeDiskGb] = useState(initialRuntimeDiskGb);
  const [runtimeResourceBaseline, setRuntimeResourceBaseline] = useState({
    cpu: initialRuntimeCpu,
    memoryGb: initialRuntimeMemoryGb,
    diskGb: initialRuntimeDiskGb,
  });
  const [runtimeResourceError, setRuntimeResourceError] = useState<string | null>(null);
  const [runtimeResourceNotice, setRuntimeResourceNotice] = useState<string | null>(null);
  const [runtimeResourceSaving, setRuntimeResourceSaving] = useState(false);
  const [runtimeResourceUsage, setRuntimeResourceUsage] = useState<RuntimeResourceUsage | null>(null);
  const [runtimeResourceUsageError, setRuntimeResourceUsageError] = useState<string | null>(null);
  const [soul, setSoul] = useState(cachedAgentProfileState?.soul || "");
  
  // OAuth state
  const [oauthStatus, setOauthStatus] = useState<Record<string, string>>({});
  const [oauthLoading, setOauthLoading] = useState<string | null>(null);
  const [oauthError, setOauthError] = useState<string | null>(null);
  const [authState, setAuthState] = useState<AuthStateSnapshot>(
    cachedWarmState?.authState ?? {
      active_provider: null,
      providers: [],
    },
  );
  const connectedProviders = authState.providers.filter(p => p.has_key).map(p => p.id);
  const localImageGenerationProviders: string[] = connectedProviders.filter(
    (provider) => provider === "google" || provider === "openai",
  );
  const localImageGenerationProviderKey = localImageGenerationProviders.join(",");
  // Anthropic OAuth code-paste state
  const [anthropicCodePending, setAnthropicCodePending] = useState(false);
  const [anthropicCodeInput, setAnthropicCodeInput] = useState("");
  const [resetLoading, setResetLoading] = useState(false);
  const [uninstallLoading, setUninstallLoading] = useState(false);
  const [legacyMigrationLoading, setLegacyMigrationLoading] = useState(false);
  const [legacyUpgradeLoading, setLegacyUpgradeLoading] = useState(false);
  const [gatewayConfigHealth, setGatewayConfigHealth] = useState<GatewayConfigHealth | null>(null);
  const [gatewayConfigLoading, setGatewayConfigLoading] = useState(false);
  const [gatewayConfigActionLoading, setGatewayConfigActionLoading] = useState(false);
  const [gatewayConfigError, setGatewayConfigError] = useState<string | null>(null);
  const [gatewayConfigNotice, setGatewayConfigNotice] = useState<string | null>(null);
  const [runtimeVersionInfo, setRuntimeVersionInfo] = useState<RuntimeVersionInfo | null>(
    cachedWarmState?.runtimeVersionInfo ?? null,
  );
  const [runtimeVersionLoading, setRuntimeVersionLoading] = useState(false);
  const [authMetaLoading, setAuthMetaLoading] = useState(false);
  const [runtimeFetchLoading, setRuntimeFetchLoading] = useState(false);
  const [appUpdateState, setAppUpdateState] = useState<UpdaterStatus | null>(() => readUpdaterStatus());
  const [appUpdateNotice, setAppUpdateNotice] = useState<string | null>(null);
  const [appUpdateError, setAppUpdateError] = useState<string | null>(null);
  const [profileInfoLoading, setProfileInfoLoading] = useState(!cachedWarmState?.profile);
  const [agentProfileLoading, setAgentProfileLoading] = useState(!cachedAgentProfileState);
  const [wallpaperStateLoading, setWallpaperStateLoading] = useState(true);
  const [runtimeUsageLoading, setRuntimeUsageLoading] = useState(false);
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
  const profileStateLoading = profileInfoLoading || agentProfileLoading;
  const isMacOS =
    typeof document !== "undefined" &&
    document.documentElement.classList.contains("platform-macos");
  const runtimeResourcesDirty =
    runtimeCpu !== runtimeResourceBaseline.cpu ||
    runtimeMemoryGb !== runtimeResourceBaseline.memoryGb ||
    runtimeDiskGb !== runtimeResourceBaseline.diskGb;
  const liveCpuText =
    typeof runtimeResourceUsage?.cpu_percent === "number"
      ? `${runtimeResourceUsage.cpu_percent.toFixed(1)}%`
      : "—";
  const liveMemoryText =
    runtimeResourceUsage?.memory_used_bytes != null
      ? `${formatBytes(runtimeResourceUsage.memory_used_bytes)} / ${runtimeResourceBaseline.memoryGb} GB`
      : "—";
  const liveDiskText =
    runtimeResourceUsage?.disk_used_bytes != null
      ? `${formatBytes(runtimeResourceUsage.disk_used_bytes)} / ${runtimeResourceBaseline.diskGb} GB`
      : "—";
  const currentAppVersion = appUpdateState?.currentVersion ?? runtimeVersionInfo?.entropic_version ?? "…";
  const updateCheckedAt = appUpdateState?.checkedAt ?? null;

  function appUpdateSummary(status: UpdaterStatus | null) {
    if (!status) return "No update check has run yet.";
    switch (status.kind) {
      case "disabled":
        return "Automatic updates are disabled for this build.";
      case "checking":
        return "Checking GitHub releases for a newer Entropic build…";
      case "up-to-date":
        return `Entropic v${status.currentVersion} is current.`;
      case "available":
        return `Entropic v${status.targetVersion} is available.`;
      case "installing":
        return `Installing Entropic v${status.targetVersion} now. The app will restart when ready.`;
      case "installed":
        return `Entropic v${status.targetVersion} was installed. Restarting…`;
      case "error":
        return "The last update check failed.";
      default:
        return assertNever(status);
    }
  }

  const appUpdateBusy =
    appUpdateState?.kind === "checking" || appUpdateState?.kind === "installing";
  // Theme state
  type ThemeMode = "system" | "light" | "dark";
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    try {
      return (localStorage.getItem("entropic.theme") as ThemeMode) || "system";
    } catch {
      return "system";
    }
  });

  function applyTheme(mode: ThemeMode) {
    setThemeMode(mode);
    try {
      localStorage.setItem("entropic.theme", mode);
    } catch {}
    const root = document.documentElement;
    root.classList.remove("dark", "light");
    if (mode === "dark") {
      root.classList.add("dark");
    } else if (mode === "light") {
      root.classList.add("light");
    }
    // "system" uses neither class — CSS media query handles it
  }

  // Wallpaper state
  const [wallpaperId, setWallpaperId] = useState(DEFAULT_WALLPAPER_ID);
  const [customWallpaper, setCustomWallpaper] = useState<string | null>(null);
  const [wallpaperPickerOpen, setWallpaperPickerOpen] = useState(false);
  const wallpaperInputRef = useRef<HTMLInputElement>(null);
  const identityPersistTimeoutRef = useRef<number | null>(null);

  function applyWarmAgentProfileState(state: AgentProfileState) {
    setSoul(state.soul || "");
    const nextRuntimeCpu = clampRuntimeCpu(state.runtime_cpu);
    const nextRuntimeMemoryGb = clampRuntimeMemoryGb(state.runtime_memory_gb);
    const nextRuntimeDiskGb = clampRuntimeDiskGb(state.runtime_disk_gb);
    setRuntimeCpu(nextRuntimeCpu);
    setRuntimeMemoryGb(nextRuntimeMemoryGb);
    setRuntimeDiskGb(nextRuntimeDiskGb);
    setRuntimeResourceBaseline({
      cpu: nextRuntimeCpu,
      memoryGb: nextRuntimeMemoryGb,
      diskGb: nextRuntimeDiskGb,
    });
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
  }

  function persistProfileCache(next: AgentProfile) {
    saveProfile(next)
      .then(() => window.dispatchEvent(new Event("entropic-profile-updated")))
      .catch(() => {});
  }

  function clearPendingIdentityPersist() {
    if (identityPersistTimeoutRef.current !== null) {
      window.clearTimeout(identityPersistTimeoutRef.current);
      identityPersistTimeoutRef.current = null;
    }
  }

  function persistIdentity(next: AgentProfile, immediate = false) {
    const commit = () => {
      identityPersistTimeoutRef.current = null;
      invoke("set_identity", {
        name: next.name,
        avatarDataUrl: next.avatarDataUrl ?? null,
      }).catch(() => {});
    };

    if (immediate) {
      clearPendingIdentityPersist();
      commit();
      return;
    }

    clearPendingIdentityPersist();
    identityPersistTimeoutRef.current = window.setTimeout(commit, 400);
  }

  // Keep profile name in sync when Chat (or any other page) updates it
  useEffect(() => {
    const onProfileUpdated = () => {
      loadProfile().then(setProfile).catch(() => {});
    };
    window.addEventListener("entropic-profile-updated", onProfileUpdated);
    return () => window.removeEventListener("entropic-profile-updated", onProfileUpdated);
  }, []);

  useEffect(() => () => clearPendingIdentityPersist(), []);

  useEffect(() => {
    const eventName = updaterStatusEventName();
    const syncUpdateState = (event: Event) => {
      const detail = (event as CustomEvent<UpdaterStatus>).detail;
      setAppUpdateState(detail ?? readUpdaterStatus());
    };
    window.addEventListener(eventName, syncUpdateState as EventListener);
    return () => window.removeEventListener(eventName, syncUpdateState as EventListener);
  }, []);

  // Load initial state
  useEffect(() => {
    let cancelled = false;
    const cancelDeferred = scheduleDeferredSettingsWork(() => {
      if (!cachedWarmState?.profile) {
        setProfileInfoLoading(true);
      }
      if (!cachedAgentProfileState) {
        setAgentProfileLoading(true);
      }
      setWallpaperStateLoading(true);

      void loadSettingsWarmState()
        .then((state) => {
          if (cancelled) return;
          if (state.profile) {
            setProfile(state.profile);
          }
          if (state.agentProfileState) {
            applyWarmAgentProfileState(state.agentProfileState);
          }
        })
        .catch(() => {})
        .finally(() => {
          if (!cancelled) {
            setProfileInfoLoading(false);
            setAgentProfileLoading(false);
          }
        });

      void loadDesktopSettings()
        .then((settings) => {
          const wp = settings.desktopWallpaper;
          const cwp = settings.desktopCustomWallpaper;
          if (cancelled) return;
          if (wp) setWallpaperId(wp);
          if (cwp) setCustomWallpaper(cwp);
        })
        .catch(() => {})
        .finally(() => {
          if (!cancelled) {
            setWallpaperStateLoading(false);
          }
        });
    });

    return () => {
      cancelled = true;
      cancelDeferred();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const loadDeferredSettingsData = () => {
      if (!cachedWarmState?.runtimeVersionInfo) {
        setRuntimeVersionLoading(true);
      }
      if (!cachedWarmState?.oauthStatus || !cachedWarmState?.authState) {
        setAuthMetaLoading(true);
      }

      void loadSettingsWarmState()
        .then((state) => {
          if (cancelled) return;
          if (state.runtimeVersionInfo) {
            setRuntimeVersionInfo(state.runtimeVersionInfo);
          }
          if (state.oauthStatus) {
            setOauthStatus(state.oauthStatus);
          }
          if (state.authState) {
            setAuthState(state.authState);
          }
        })
        .catch(() => {})
        .finally(() => {
          if (!cancelled) {
            setRuntimeVersionLoading(false);
            setAuthMetaLoading(false);
          }
        });
    };

    const cancelDeferred = scheduleDeferredSettingsWork(loadDeferredSettingsData);

    return () => {
      cancelled = true;
      cancelDeferred();
    };
  }, []);

  function localKeyProviderLabel(provider: LocalKeyProvider) {
    switch (provider) {
      case "anthropic":
        return "Anthropic";
      case "google":
        return "Google";
      case "openai":
        return "OpenAI";
    }
  }

  async function refreshAuthStateSnapshot() {
    const [status, state] = await Promise.all([
      invoke<Record<string, string>>("get_oauth_status"),
      invoke<AuthStateSnapshot>("get_auth_state"),
    ]);
    setOauthStatus(status);
    setAuthState(state);
    return state;
  }

  async function saveLocalApiKey(provider: LocalKeyProvider) {
    const key = apiKeys[provider].trim();
    if (!key) {
      setLocalKeyError(`Paste a ${localKeyProviderLabel(provider)} API key first.`);
      setLocalKeyNotice(null);
      return;
    }

    setLocalKeySavingProvider(provider);
    setLocalKeyError(null);
    setLocalKeyNotice(null);

    try {
      await invoke("set_api_key", { provider, key });
      await invoke("set_active_provider", { provider });
      await refreshAuthStateSnapshot();
      setApiKeys((prev) => ({ ...prev, [provider]: "" }));
      setLocalKeyNotice(
        gatewayRunning
          ? `${localKeyProviderLabel(provider)} key saved. Restart the sandbox to apply it to the running gateway.`
          : `${localKeyProviderLabel(provider)} key saved.`,
      );
    } catch (error) {
      console.error(`[Entropic] Failed to save ${provider} API key:`, error);
      setLocalKeyError(
        `Could not save the ${localKeyProviderLabel(provider)} API key.`,
      );
    } finally {
      setLocalKeySavingProvider(null);
    }
  }

  async function clearLocalApiKey(provider: LocalKeyProvider) {
    setLocalKeySavingProvider(provider);
    setLocalKeyError(null);
    setLocalKeyNotice(null);

    try {
      await invoke("set_api_key", { provider, key: "" });
      const state = await refreshAuthStateSnapshot();
      setApiKeys((prev) => ({ ...prev, [provider]: "" }));
      const anyKeyRemaining = state.providers.some((entry) => entry.has_key);
      if (!anyKeyRemaining && useLocalKeys) {
        await onUseLocalKeysChange(false);
      }
      setLocalKeyNotice(
        gatewayRunning
          ? `${localKeyProviderLabel(provider)} key cleared. Restart the sandbox if it is still using that provider.`
          : `${localKeyProviderLabel(provider)} key cleared.`,
      );
    } catch (error) {
      console.error(`[Entropic] Failed to clear ${provider} API key:`, error);
      setLocalKeyError(
        `Could not clear the ${localKeyProviderLabel(provider)} API key.`,
      );
    } finally {
      setLocalKeySavingProvider(null);
    }
  }

  useEffect(() => {
    if (!useLocalKeys || authMetaLoading || localImageGenerationProviders.length === 0) {
      return;
    }
    const allowedModelIds = new Set(
      LOCAL_IMAGE_GENERATION_MODELS
        .filter((model) => localImageGenerationProviders.includes(model.provider.toLowerCase()))
        .map((model) => model.id),
    );
    if (allowedModelIds.has(imageGenerationModel)) {
      return;
    }
    const nextModel = LOCAL_IMAGE_GENERATION_MODELS.find((model) =>
      localImageGenerationProviders.includes(model.provider.toLowerCase()),
    )?.id;
    if (!nextModel || nextModel === imageGenerationModel) {
      return;
    }
    void Promise.resolve(onImageGenerationModelChange(nextModel));
  }, [
    authMetaLoading,
    imageGenerationModel,
    localImageGenerationProviderKey,
    onImageGenerationModelChange,
    useLocalKeys,
  ]);

  useEffect(() => {
    if (!isMacOS || !gatewayRunning) {
      setRuntimeResourceUsage(null);
      setRuntimeResourceUsageError(null);
      setRuntimeUsageLoading(false);
      return;
    }

    let cancelled = false;
    let intervalId: number | null = null;

    let isFirstLoad = true;
    const refreshRuntimeUsage = () => {
      if (isFirstLoad) setRuntimeUsageLoading(true);
      void invoke<RuntimeResourceUsage>("get_runtime_resource_usage")
        .then((usage) => {
          if (cancelled) return;
          setRuntimeResourceUsage(usage);
          setRuntimeResourceUsageError(null);
        })
        .catch((error) => {
          if (cancelled) return;
          console.error("[Entropic] Failed to load runtime resource usage:", error);
          setRuntimeResourceUsageError("Unable to read live sandbox usage right now.");
        })
        .finally(() => {
          if (!cancelled) {
            isFirstLoad = false;
            setRuntimeUsageLoading(false);
          }
        });
    };

    const cancelDeferred = scheduleDeferredSettingsWork(() => {
      if (cancelled) return;
      refreshRuntimeUsage();
      intervalId = window.setInterval(refreshRuntimeUsage, 5000);
    }, 180);

    return () => {
      cancelled = true;
      cancelDeferred();
      if (intervalId !== null) {
        window.clearInterval(intervalId);
      }
    };
  }, [gatewayRunning, isMacOS]);

  useEffect(() => {
    if (!gatewayRunning) {
      setGatewayConfigHealth(null);
      setGatewayConfigError(null);
      setGatewayConfigNotice(null);
      return;
    }
    let cancelled = false;
    const cancelDeferred = scheduleDeferredSettingsWork(() => {
      if (cancelled) return;
      void refreshGatewayConfigHealth();
    }, 300);
    return () => {
      cancelled = true;
      cancelDeferred();
    };
  }, [gatewayRunning]);

  async function saveWallpaper(id: string, custom?: string | null) {
    setWallpaperId(id);
    if (custom !== undefined) setCustomWallpaper(custom);
    try {
      await updateDesktopSettings({
        desktopWallpaper: id,
        desktopCustomWallpaper: custom !== undefined ? custom ?? undefined : customWallpaper ?? undefined,
      });
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
      await refreshAuthStateSnapshot();
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
      await refreshAuthStateSnapshot();
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
      const state = await refreshAuthStateSnapshot();
      // If no provider keys remain, switch back to proxy (managed) mode.
      const anyKeyRemaining = state.providers.some((p) => p.has_key);
      if (!anyKeyRemaining && useLocalKeys) {
        await onUseLocalKeysChange(false);
      }
    } catch (e) {
      console.error(`[Entropic] OAuth disconnect failed for ${provider}:`, e);
    }
  }

  async function handleRuntimeResourceSave(applyAfterSave = false) {
    const nextCpu = Math.min(16, Math.max(1, Math.round(runtimeCpu)));
    const nextMemoryGb = Math.min(64, Math.max(2, Math.round(runtimeMemoryGb)));
    const nextDiskGb = Math.min(500, Math.max(20, Math.round(runtimeDiskGb)));
    let settingsSaved = false;
    if (applyAfterSave && gatewayRunning && onApplyRuntimeResources) {
      const confirmed = await ask(
        "Save the new Colima CPU, RAM, and disk settings and restart the sandbox now? This will interrupt active tasks.",
        {
          title: "Apply Colima Size",
          kind: "warning",
          okLabel: "Apply and Restart",
          cancelLabel: "Cancel",
        }
      );
      if (!confirmed) {
        return;
      }
    }
    setRuntimeCpu(nextCpu);
    setRuntimeMemoryGb(nextMemoryGb);
    setRuntimeDiskGb(nextDiskGb);
    setRuntimeResourceSaving(true);
    setRuntimeResourceError(null);
    setRuntimeResourceNotice(null);
    try {
      await invoke("set_runtime_resources", {
        cpuCount: nextCpu,
        memoryGb: nextMemoryGb,
        diskGb: nextDiskGb,
      });
      settingsSaved = true;
      setRuntimeResourceBaseline({
        cpu: nextCpu,
        memoryGb: nextMemoryGb,
        diskGb: nextDiskGb,
      });
      if (applyAfterSave && gatewayRunning && onApplyRuntimeResources) {
        setRuntimeResourceNotice("Applying the new Colima size and restarting the sandbox...");
        await onApplyRuntimeResources();
        setRuntimeResourceNotice("Applied. Sandbox restarted with the new Colima size.");
      } else {
        setRuntimeResourceNotice(
          gatewayRunning
            ? "Saved. Restart the sandbox to apply the new Colima size."
            : "Saved. The new Colima size will apply the next time the sandbox starts."
        );
      }
    } catch (error) {
      console.error("[Entropic] Failed to save runtime resources:", error);
      const detail = error instanceof Error ? error.message : String(error);
      setRuntimeResourceError(
        settingsSaved && applyAfterSave && gatewayRunning
          ? `Saved the new Colima size, but could not restart the sandbox: ${detail}`
          : "Could not save Colima CPU, memory, and disk settings."
      );
    } finally {
      setRuntimeResourceSaving(false);
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
      <div className="mb-8 px-1">
        <h1 className="text-2xl font-bold">Settings</h1>
      </div>

      {gatewayConfigInvalid && (
        <div className="mb-6 rounded-xl border border-amber-500/20 bg-amber-500/10 p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-sm font-semibold text-[var(--text-primary)]">Gateway config warning</div>
              <div className="text-xs text-[var(--text-secondary)] mt-1">
                {gatewayConfigHealth?.summary || "Gateway config is invalid."}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={refreshGatewayConfigHealth}
                disabled={gatewayConfigLoading || gatewayConfigActionLoading}
                className="px-3 py-1.5 text-xs font-medium rounded-md border border-amber-500/30 text-[var(--text-primary)] hover:bg-amber-500/10 disabled:opacity-50"
              >
                {gatewayConfigLoading ? "Checking..." : "Recheck"}
              </button>
              <button
                type="button"
                onClick={healGatewayConfig}
                disabled={gatewayConfigLoading || gatewayConfigActionLoading}
                className="px-3 py-1.5 text-xs font-semibold rounded-md bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50"
              >
                {gatewayConfigActionLoading ? "Healing..." : "Heal Config"}
              </button>
            </div>
          </div>
          {gatewayConfigHealth?.issues?.length ? (
            <ul className="mt-3 text-xs text-[var(--text-secondary)] space-y-1 list-disc list-inside">
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
                if (file.size > 5 * 1024 * 1024) {
                  alert("Image must be under 5 MB.");
                  e.target.value = "";
                  return;
                }
                const reader = new FileReader();
                reader.onload = () => {
                  const avatarDataUrl = reader.result as string;
                  setProfile((p) => {
                    const next = { ...p, avatarDataUrl };
                    persistProfileCache(next);
                    persistIdentity(next, true);
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
                  setProfile((p) => {
                    const next = { ...p, name: newName };
                    persistProfileCache(next);
                    persistIdentity(next);
                    return next;
                  });
                }}
                onBlur={(e) => {
                  const next = {
                    ...profile,
                    name: e.target.value,
                    avatarDataUrl: profileAvatarDataUrl ?? undefined,
                  };
                  persistIdentity(next, true);
                }}
                maxLength={64}
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
                    className="w-full p-3 rounded-xl bg-[var(--system-gray-6)] border-transparent focus:bg-[var(--bg-card)] focus:ring-2 focus:ring-[var(--system-blue)]/20 transition-all text-sm text-[var(--text-primary)] resize-none"
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
        {isAuthenticated && (
          <div className="px-4 pb-4 pt-0 border-t border-[var(--border-subtle)] mt-0">
            <div className="flex items-center justify-between pt-3">
              <span className="text-[12px] text-[var(--text-secondary)]">
                {user?.email ?? "Signed in"}
              </span>
              <button
                onClick={async () => {
                  try { await signOut(); } catch (e) { console.warn("[Settings] signOut failed:", e); }
                }}
                className="flex items-center gap-1.5 text-[12px] font-medium text-red-500 hover:text-red-400 transition-colors"
              >
                <LogOut className="w-3.5 h-3.5" />
                Sign Out
              </button>
            </div>
          </div>
        )}
      </SettingsGroup>

      <SettingsGroup title="Appearance">
        <SettingsRow
          label="Theme"
          icon={themeMode === "dark" ? Moon : themeMode === "light" ? Sun : Monitor}
          description={themeMode === "system" ? "Follows system preference" : themeMode === "dark" ? "Always dark" : "Always light"}
        >
          <div className="inline-flex items-center rounded-lg border border-[var(--border-default)] bg-[var(--bg-tertiary)] p-0.5">
            {([
              { key: "system" as ThemeMode, icon: Monitor, label: "Auto" },
              { key: "light" as ThemeMode, icon: Sun, label: "Light" },
              { key: "dark" as ThemeMode, icon: Moon, label: "Dark" },
            ]).map((opt) => {
              const Icon = opt.icon;
              const active = themeMode === opt.key;
              return (
                <button
                  key={opt.key}
                  onClick={() => applyTheme(opt.key)}
                  className={clsx(
                    "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors",
                    active
                      ? "bg-[var(--bg-card)] text-[var(--text-primary)] shadow-sm"
                      : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
                  )}
                  title={opt.label}
                >
                  <Icon className="w-3.5 h-3.5" />
                  <span>{opt.label}</span>
                </button>
              );
            })}
          </div>
        </SettingsRow>
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
              <SettingsRow
                label="Image Generation Model"
                icon={Sparkles}
                description="Used for Image mode in Chat and generated images."
              >
                <div className="w-80">
                  <ModelSelector
                    selectedModel={imageGenerationModel}
                    onModelChange={onImageGenerationModelChange}
                    models={PROXY_IMAGE_GENERATION_MODELS}
                  />
                </div>
              </SettingsRow>
            </>
          )}
          {useLocalKeys && !authMetaLoading && localImageGenerationProviders.length > 0 && (
            <>
              <SettingsRow
                label="Image Generation Model"
                icon={Sparkles}
                description="Used for Image mode in Chat and generated images."
              >
                <div className="w-80">
                  <ModelSelector
                    selectedModel={imageGenerationModel}
                    onModelChange={onImageGenerationModelChange}
                    models={LOCAL_IMAGE_GENERATION_MODELS}
                    connectedProviders={localImageGenerationProviders}
                  />
                </div>
              </SettingsRow>
              <div className="px-4 py-3 text-[12px] text-[var(--text-secondary)]">
                Local image generation supports OpenAI and Google keys. Anthropic local keys accept
                image input, but do not generate image output.
              </div>
            </>
          )}
          {useLocalKeys && !authMetaLoading && localImageGenerationProviders.length === 0 && (
            <div className="px-4 py-3 text-[12px] text-[var(--text-secondary)]">
              Connect an OpenAI or Google API key to use local image generation. Anthropic local
              keys accept image input, but do not generate image output.
            </div>
          )}
        </SettingsGroup>
      </div>

      <SettingsGroup title="System">
        <SettingsRow label="Gateway Status" icon={Shield} description={gatewayRunning ? "Running on localhost:19789" : "Secure sandbox stopped"}>
          <button
            type="button"
            onClick={onGatewayToggle}
            disabled={isTogglingGateway}
            className="inline-flex items-center gap-1.5 rounded-md bg-[#1A1A2E] px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isTogglingGateway ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RotateCcw className="h-3.5 w-3.5" />
            )}
            <span>{gatewayRunning ? "Restart" : "Start"}</span>
          </button>
        </SettingsRow>

        {isMacOS && (
          <>
            <div className="p-4 flex items-center justify-between gap-4">
              <div className="flex items-center gap-3 overflow-hidden">
                <div className="w-7 h-7 rounded-md bg-[var(--system-blue)]/10 text-[var(--system-blue)] flex items-center justify-center flex-shrink-0">
                  <Cpu className="w-4 h-4" />
                </div>
                <div className="text-[14px] font-medium text-[var(--text-primary)]">Colima VM</div>
              </div>
              <div className="flex items-center gap-2">
                <label className="flex items-center gap-1.5 text-[11px] text-[var(--text-tertiary)]">
                  <span>CPU</span>
                  <input type="number" min={1} max={16} step={1} value={runtimeCpu} onChange={(event) => setRuntimeCpu(Number(event.target.value) || 1)} className="w-14 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-secondary)] px-2 py-1 text-sm text-[var(--text-primary)]" />
                </label>
                <label className="flex items-center gap-1.5 text-[11px] text-[var(--text-tertiary)]">
                  <span>RAM</span>
                  <input type="number" min={2} max={64} step={1} value={runtimeMemoryGb} onChange={(event) => setRuntimeMemoryGb(Number(event.target.value) || 2)} className="w-16 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-secondary)] px-2 py-1 text-sm text-[var(--text-primary)]" />
                  <span>GB</span>
                </label>
                <label className="flex items-center gap-1.5 text-[11px] text-[var(--text-tertiary)]">
                  <span>Disk</span>
                  <input type="number" min={20} max={500} step={1} value={runtimeDiskGb} onChange={(event) => setRuntimeDiskGb(Number(event.target.value) || 20)} className="w-16 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-secondary)] px-2 py-1 text-sm text-[var(--text-primary)]" />
                  <span>GB</span>
                </label>
                <button
                  type="button"
                  onClick={() => void handleRuntimeResourceSave(gatewayRunning)}
                  disabled={runtimeResourceSaving || !runtimeResourcesDirty}
                  className="px-3 py-1 text-xs font-semibold rounded-md bg-[#1A1A2E] text-white hover:opacity-80 disabled:opacity-50"
                >
                  {runtimeResourceSaving
                    ? gatewayRunning
                      ? "Applying..."
                      : "Saving..."
                    : gatewayRunning
                      ? "Apply and Restart"
                      : "Save"}
                </button>
              </div>
            </div>
            <div className="px-4 pb-4">
              <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-secondary)] px-3 py-2">
                <div className="grid grid-cols-4 gap-3 text-[12px] text-[var(--text-secondary)]">
                  <div className="flex items-center gap-1.5 font-medium">
                    {runtimeResourceUsage?.running ? "Current Usage" : "Usage"}
                    {runtimeUsageLoading && <Loader2 className="w-3 h-3 animate-spin text-[var(--text-tertiary)]" />}
                  </div>
                  <div><div className="text-[var(--text-tertiary)]">CPU</div><div className="font-medium text-[var(--text-primary)]">{liveCpuText}</div></div>
                  <div><div className="text-[var(--text-tertiary)]">RAM</div><div className="font-medium text-[var(--text-primary)]">{liveMemoryText}</div></div>
                  <div><div className="text-[var(--text-tertiary)]">Disk</div><div className="font-medium text-[var(--text-primary)]">{liveDiskText}</div></div>
                </div>
              </div>
            </div>
            {runtimeResourceError && (
              <div className="px-4 pb-3 text-xs text-red-500">{runtimeResourceError}</div>
            )}
            {runtimeResourceUsageError && (
              <div className="px-4 pb-3 text-xs text-red-500">{runtimeResourceUsageError}</div>
            )}
            {runtimeResourceNotice && (
              <div className="px-4 pb-3 text-xs text-green-500">{runtimeResourceNotice}</div>
            )}
          </>
        )}

        <SettingsRow
          label="Gateway Config Health"
          icon={AlertTriangle}
          description={
            gatewayConfigLoading
              ? "Checking gateway config validity…"
              : gatewayConfigHealth?.summary || "Check gateway config validity"
          }
        >
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={refreshGatewayConfigHealth}
              disabled={gatewayConfigLoading || gatewayConfigActionLoading}
              className="px-3 py-1.5 text-xs font-medium rounded-md border border-[var(--border-subtle)] bg-[var(--bg-card)] hover:bg-[var(--system-gray-6)] disabled:opacity-50"
            >
              {gatewayConfigLoading ? "Checking..." : "Check"}
            </button>
            <button
              type="button"
              onClick={healGatewayConfig}
              disabled={gatewayConfigLoading || gatewayConfigActionLoading}
              className="px-3 py-1.5 text-xs font-semibold rounded-md bg-[#1A1A2E] text-white hover:opacity-80 disabled:opacity-50"
            >
              {gatewayConfigActionLoading ? "Healing..." : "Heal"}
            </button>
          </div>
        </SettingsRow>
        {gatewayConfigError && (
          <div className="px-4 pb-4 pt-2 text-xs text-red-500">{gatewayConfigError}</div>
        )}
        {gatewayConfigNotice && (
          <div className="px-4 pb-4 pt-2 text-xs text-green-500">{gatewayConfigNotice}</div>
        )}
      </SettingsGroup>

      <SettingsGroup title="Keys">
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
            onClick={() => {
              if (!isAuthConfigured) {
                return;
              }
              void onUseLocalKeysChange(!useLocalKeys);
            }}
            disabled={!isAuthConfigured}
            className={clsx(
              "relative inline-flex h-6 w-11 flex-shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none disabled:cursor-not-allowed disabled:opacity-60",
              useLocalKeys ? "bg-[var(--system-blue)]" : "bg-[var(--system-gray-4)]"
            )}
          >
            <span
              className={clsx(
                "pointer-events-none inline-block h-5 w-5 transform rounded-full bg-[var(--bg-card)] shadow ring-0 transition duration-200 ease-in-out",
                useLocalKeys ? "translate-x-5" : "translate-x-0"
              )}
            />
          </button>
        </SettingsRow>

        {useLocalKeys && (
          <>
            {/* ── Anthropic ── */}
            <div className="px-4 pt-3 pb-1">
              <span className="text-[11px] font-medium uppercase tracking-wider text-[var(--text-tertiary)]">Anthropic</span>
            </div>
            {(() => {
              const isConnected = oauthStatus["anthropic"] === "claude_code";
              const providerAuth = authState.providers.find(p => p.id === "anthropic");
              const hasKey = providerAuth?.has_key ?? false;
              const last4 = providerAuth?.last4;
              const isLoading = oauthLoading === "anthropic";

              return (
                <>
                  <SettingsRow
                    label="OAuth"
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
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg text-red-500 hover:bg-red-500/10 transition-colors"
                      >
                        <LogOut className="w-3.5 h-3.5" />
                        Disconnect
                      </button>
                    ) : anthropicCodePending ? (
                      <button
                        onClick={() => { setAnthropicCodePending(false); setAnthropicCodeInput(""); }}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg text-[var(--text-tertiary)] hover:bg-[var(--system-gray-5)] transition-colors"
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

            {(() => {
              const isConnected = oauthStatus["anthropic"] === "claude_code";
              const providerAuth = authState.providers.find((p) => p.id === "anthropic");
              const hasKey = providerAuth?.has_key ?? false;
              const last4 = providerAuth?.last4;
              const isSaving = localKeySavingProvider === "anthropic";

              return (
                <SettingsRow
                  label="API Key"
                  icon={Key}
                  description={
                    isConnected && last4
                      ? `Connected via OAuth (...${last4})`
                      : hasKey
                        ? `Key set (...${last4 || "****"})`
                        : "Paste an Anthropic API key, or sign in above"
                  }
                >
                  <div className="flex w-full max-w-[360px] items-center gap-2">
                    <input
                      type="password"
                      value={apiKeys.anthropic}
                      onChange={(event) =>
                        setApiKeys((prev) => ({ ...prev, anthropic: event.target.value }))
                      }
                      placeholder="sk-ant-..."
                      className="flex-1 min-w-0 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-secondary)] px-3 py-1.5 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:ring-1 focus:ring-[var(--system-blue)]"
                    />
                    <button
                      onClick={() => void saveLocalApiKey("anthropic")}
                      disabled={isSaving || !apiKeys.anthropic.trim()}
                      className="flex-shrink-0 px-3 py-1.5 text-xs font-medium rounded-lg bg-[var(--system-blue)] text-white hover:bg-[var(--system-blue)]/90 disabled:opacity-40 transition-colors"
                    >
                      {isSaving ? "Saving..." : hasKey ? "Replace" : "Save Key"}
                    </button>
                    {hasKey && (
                      <button
                        onClick={() => void clearLocalApiKey("anthropic")}
                        disabled={isSaving}
                        className="flex-shrink-0 px-3 py-1.5 text-xs font-medium rounded-lg text-red-500 hover:bg-red-500/10 disabled:opacity-40 transition-colors"
                      >
                        Clear
                      </button>
                    )}
                  </div>
                </SettingsRow>
              );
            })()}

            {/* ── OpenAI ── */}
            <div className="px-4 pt-3 pb-1">
              <span className="text-[11px] font-medium uppercase tracking-wider text-[var(--text-tertiary)]">OpenAI</span>
            </div>
            {(() => {
              const isConnected = oauthStatus["openai"] === "openai_codex";
              const providerAuth = authState.providers.find(p => p.id === "openai");
              const hasKey = providerAuth?.has_key ?? false;
              const last4 = providerAuth?.last4;
              const isLoading = oauthLoading === "openai";

              return (
                <SettingsRow
                  label="OAuth"
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
                      className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg text-red-500 hover:bg-red-500/10 transition-colors"
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

            {(() => {
              const isConnected = oauthStatus["openai"] === "openai_codex";
              const providerAuth = authState.providers.find((p) => p.id === "openai");
              const hasKey = providerAuth?.has_key ?? false;
              const last4 = providerAuth?.last4;
              const isSaving = localKeySavingProvider === "openai";

              return (
                <SettingsRow
                  label="API Key"
                  icon={Key}
                  description={
                    isConnected && last4
                      ? `Connected via OAuth (...${last4})`
                      : hasKey
                        ? `Key set (...${last4 || "****"})`
                        : "Paste an OpenAI API key, or sign in above"
                  }
                >
                  <div className="flex w-full max-w-[360px] items-center gap-2">
                    <input
                      type="password"
                      value={apiKeys.openai}
                      onChange={(event) =>
                        setApiKeys((prev) => ({ ...prev, openai: event.target.value }))
                      }
                      placeholder="sk-..."
                      className="flex-1 min-w-0 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-secondary)] px-3 py-1.5 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:ring-1 focus:ring-[var(--system-blue)]"
                    />
                    <button
                      onClick={() => void saveLocalApiKey("openai")}
                      disabled={isSaving || !apiKeys.openai.trim()}
                      className="flex-shrink-0 px-3 py-1.5 text-xs font-medium rounded-lg bg-[var(--system-blue)] text-white hover:bg-[var(--system-blue)]/90 disabled:opacity-40 transition-colors"
                    >
                      {isSaving ? "Saving..." : hasKey ? "Replace" : "Save Key"}
                    </button>
                    {hasKey && (
                      <button
                        onClick={() => void clearLocalApiKey("openai")}
                        disabled={isSaving}
                        className="flex-shrink-0 px-3 py-1.5 text-xs font-medium rounded-lg text-red-500 hover:bg-red-500/10 disabled:opacity-40 transition-colors"
                      >
                        Clear
                      </button>
                    )}
                  </div>
                </SettingsRow>
              );
            })()}

            {/* ── Google ── */}
            <div className="px-4 pt-3 pb-1">
              <span className="text-[11px] font-medium uppercase tracking-wider text-[var(--text-tertiary)]">Google</span>
            </div>
            {(() => {
              const providerAuth = authState.providers.find((p) => p.id === "google");
              const hasKey = providerAuth?.has_key ?? false;
              const last4 = providerAuth?.last4;
              const isSaving = localKeySavingProvider === "google";

              return (
                <SettingsRow
                  label="API Key"
                  icon={Key}
                  description={
                    hasKey
                      ? `Key set (...${last4 || "****"})`
                      : "Paste a Google AI Studio / Gemini API key"
                  }
                >
                  <div className="flex w-full max-w-[360px] items-center gap-2">
                    <input
                      type="password"
                      value={apiKeys.google}
                      onChange={(event) =>
                        setApiKeys((prev) => ({ ...prev, google: event.target.value }))
                      }
                      placeholder="AIza..."
                      className="flex-1 min-w-0 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-secondary)] px-3 py-1.5 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:ring-1 focus:ring-[var(--system-blue)]"
                    />
                    <button
                      onClick={() => void saveLocalApiKey("google")}
                      disabled={isSaving || !apiKeys.google.trim()}
                      className="flex-shrink-0 px-3 py-1.5 text-xs font-medium rounded-lg bg-[var(--system-blue)] text-white hover:bg-[var(--system-blue)]/90 disabled:opacity-40 transition-colors"
                    >
                      {isSaving ? "Saving..." : hasKey ? "Replace" : "Save Key"}
                    </button>
                    {hasKey && (
                      <button
                        onClick={() => void clearLocalApiKey("google")}
                        disabled={isSaving}
                        className="flex-shrink-0 px-3 py-1.5 text-xs font-medium rounded-lg text-red-500 hover:bg-red-500/10 disabled:opacity-40 transition-colors"
                      >
                        Clear
                      </button>
                    )}
                  </div>
                </SettingsRow>
              );
            })()}

            {(oauthError || localKeyError || localKeyNotice) && (
              <div className="px-4 pb-3 pt-2 flex flex-col gap-1">
                {oauthError && <div className="text-xs text-red-500">{oauthError}</div>}
                {localKeyError && <div className="text-xs text-red-500">{localKeyError}</div>}
                {localKeyNotice && <div className="text-xs text-green-500">{localKeyNotice}</div>}
              </div>
            )}
          </>
        )}
      </SettingsGroup>

      <SettingsGroup title="Diagnostics">
        {updaterEnabled && (
          <div className="p-4 space-y-3">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="text-[14px] font-medium text-[var(--text-primary)]">App Updates</div>
                <div className="text-[12px] text-[var(--text-secondary)] mt-1">
                  {appUpdateSummary(appUpdateState)}
                </div>
                <div className="text-[11px] text-[var(--text-tertiary)] mt-2 space-y-1">
                  <div>Current version: v{currentAppVersion}</div>
                  <div>Last checked: {formatDateTime(updateCheckedAt)}</div>
                  {appUpdateState?.kind === "available" || appUpdateState?.kind === "installing" || appUpdateState?.kind === "installed" ? (
                    <div>Target version: v{appUpdateState.targetVersion}</div>
                  ) : null}
                  {isMacOS ? (
                    <div>On macOS, run Entropic from Applications for auto-updates to apply correctly.</div>
                  ) : null}
                </div>
              </div>
              <button
                onClick={async () => {
                  setAppUpdateNotice(null);
                  setAppUpdateError(null);
                  const result = await checkForAppUpdates({
                    source: "manual",
                    autoInstall: true,
                  });
                  if (result.kind === "up-to-date") {
                    setAppUpdateNotice(`Entropic v${result.currentVersion} is already current.`);
                  } else if (result.kind === "available" || result.kind === "installing" || result.kind === "installed") {
                    setAppUpdateNotice(`Updating to Entropic v${result.targetVersion}.`);
                  } else if (result.kind === "error") {
                    setAppUpdateError(result.error);
                  }
                }}
                disabled={appUpdateBusy}
                className="px-3 py-2 rounded-lg bg-[var(--system-blue)] text-white text-xs font-medium hover:bg-[var(--system-blue)]/90 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {appUpdateBusy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                {appUpdateBusy ? "Checking..." : "Check Now"}
              </button>
            </div>
            {(appUpdateNotice || appUpdateError) && (
              <div className="space-y-1">
                {appUpdateNotice && <div className="text-xs text-green-500">{appUpdateNotice}</div>}
                {appUpdateError && <div className="text-xs text-red-500">{appUpdateError}</div>}
              </div>
            )}
          </div>
        )}

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
                  className="px-2 py-1 text-xs rounded-md border border-red-500/20 text-red-500 hover:bg-red-500/10"
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
                          entry.type === "info" && "bg-blue-500/15 text-blue-500",
                          entry.type === "warn" && "bg-amber-500/15 text-amber-500",
                          entry.type === "error" && "bg-red-500/15 text-red-500",
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
            <div className="w-7 h-7 rounded-md bg-blue-500/10 text-blue-500 flex items-center justify-center flex-shrink-0">
              <Cpu className="w-4 h-4" />
            </div>
            <div className="flex-1">
              <div className="text-[14px] font-medium text-[var(--text-primary)] mb-1">Fetch Latest OpenClaw Runtime</div>
              <div className="text-[12px] text-[var(--text-secondary)] mb-3">
                Refresh the runtime manifest and cache the newest OpenClaw runtime tar for faster startup and updates.
              </div>
              {(runtimeVersionInfo?.runtime_download_asset_name || runtimeVersionInfo?.runtime_download_size_bytes != null) && (
                <div className="text-[11px] text-[var(--text-tertiary)] mb-3">
                  Selected asset: {runtimeVersionInfo?.runtime_download_asset_name ?? "unknown"}
                  {runtimeVersionInfo?.runtime_download_size_bytes != null
                    ? ` · ${formatBytes(runtimeVersionInfo.runtime_download_size_bytes)}`
                    : ""}
                </div>
              )}
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
                        (result.runtime_download_asset_name
                          ? `Asset: ${result.runtime_download_asset_name}\n`
                          : "") +
                        (typeof result.runtime_download_size_bytes === "number"
                          ? `Download: ${formatBytes(result.runtime_download_size_bytes)}\n`
                          : "") +
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
            <div className="w-7 h-7 rounded-md bg-amber-500/10 text-amber-500 flex items-center justify-center flex-shrink-0">
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
                    "Import data from previous install, then fully reset runtime VMs/containers/volumes to fix isolated runtime drift? Runtime workspace data may be removed, but imported auth/settings are kept.",
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
                className="mt-2 px-4 py-2 bg-gray-700 hover:opacity-80 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {legacyUpgradeLoading && <Loader2 className="w-4 h-4 animate-spin" />}
                {legacyUpgradeLoading
                  ? "Importing + Resetting..."
                  : "Import + Runtime Reset"}
              </button>
            </div>
          </div>

          <div className="flex items-start gap-3">
            <div className="w-7 h-7 rounded-md bg-red-500/10 text-red-500 flex items-center justify-center flex-shrink-0">
              <Trash2 className="w-4 h-4" />
            </div>
            <div className="flex-1">
              <div className="text-[14px] font-medium text-[var(--text-primary)] mb-1">Reset Application</div>
              <div className="text-[12px] text-[var(--text-secondary)] mb-3">
                Fully reset Entropic: removes all chat history, settings, isolated runtime state, containers, volumes, and caches.
              </div>
              <button
                onClick={async () => {
                  console.log("[Settings] Reset Application clicked");
                  const confirmed = await ask("Are you sure you want to fully reset? This removes all chat history, settings, runtime state, containers, and caches.", {
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

                  setResetLoading(true);
                  console.log("[Settings] Starting cleanup...");
                  try {
                    // Disconnect X/Twitter OAuth (stored server-side in Supabase, not cleared by rm -rf)
                    try { await disconnectIntegration("x"); } catch (e) { console.warn("[Settings] X disconnect failed:", e); }

                    const result = await invoke<string>("cleanup_app_data", { includeVms: true });
                    console.log("[Settings] Cleanup succeeded:", result);

                    // Sign out and clear all auth/settings stores so in-memory state is also cleared
                    console.log("[Settings] Signing out and clearing auth...");
                    try { await authSignOut(); } catch (e) { console.warn("[Settings] signOut failed:", e); }
                    for (const storeName of RESET_STORE_FILES) {
                      try {
                        const s = await Store.load(storeName);
                        await s.clear();
                        await s.save();
                      } catch (e) { console.warn(`[Settings] Failed to clear ${storeName}:`, e); }
                    }
                    resetIntegrationVaultSession();
                    resetIntegrationState();

                    alert("Cleanup completed!\n\n" + result);
                  } catch (err) {
                    console.error("[Settings] Cleanup failed:", err);
                    alert("Cleanup failed: " + (err instanceof Error ? err.message : String(err)));
                  } finally {
                    setResetLoading(false);
                    console.log("[Settings] Cleanup finished");
                  }
                }}
                disabled={resetLoading || uninstallLoading}
                className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {resetLoading && <Loader2 className="w-4 h-4 animate-spin" />}
                {resetLoading ? "Resetting..." : "Reset Application"}
              </button>
            </div>
          </div>

          <div className="border-t border-[var(--border-subtle)] pt-4">
            <div className="flex items-start gap-3">
              <div className="w-7 h-7 rounded-md bg-[var(--bg-tertiary)] text-[var(--text-secondary)] flex items-center justify-center flex-shrink-0">
                <LogOut className="w-4 h-4" />
              </div>
              <div className="flex-1">
                <div className="text-[14px] font-medium text-[var(--text-primary)] mb-1">Uninstall Entropic</div>
                <div className="text-[12px] text-[var(--text-secondary)] mb-3">
                  Clean up all data and quit the app. After this, you can remove the installed app.
                </div>
                <div className="flex items-center gap-2 p-3 bg-blue-500/10 border border-blue-500/20 rounded-lg mb-3">
                  <AlertTriangle className="w-4 h-4 text-blue-500 flex-shrink-0" />
                  <p className="text-xs text-[var(--text-secondary)]">
                    This will delete everything including your settings. Use "Reset Application" instead if you plan to reinstall.
                  </p>
                </div>
                <button
                  onClick={async () => {
                    console.log("[Settings] Cleanup and Quit clicked");
                    const confirmed = await ask("Are you sure you want to completely uninstall Entropic?\n\nThis will delete all data including settings and quit the app. You can then remove the installed app.\n\nThis action cannot be undone.", {
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

                    setUninstallLoading(true);
                    console.log("[Settings] Starting uninstall cleanup...");
                    try {
                      // Disconnect X/Twitter OAuth (stored server-side in Supabase, not cleared by rm -rf)
                      try { await disconnectIntegration("x"); } catch (e) { console.warn("[Settings] X disconnect failed:", e); }

                      const result = await invoke<string>("cleanup_app_data", { includeVms: true });
                      console.log("[Settings] Cleanup succeeded:", result);

                      // Sign out of Supabase and clear all Tauri stores
                      console.log("[Settings] Signing out and clearing auth...");
                      try { await authSignOut(); } catch (e) { console.warn("[Settings] signOut failed:", e); }
                      for (const storeName of RESET_STORE_FILES) {
                        try {
                          const s = await Store.load(storeName);
                          await s.clear();
                          await s.save();
                        } catch (e) { console.warn(`[Settings] Failed to clear ${storeName}:`, e); }
                      }
                      resetIntegrationVaultSession();
                      resetIntegrationState();

                      alert("Uninstall cleanup completed!\n\n" + result + "\n\nThe app will now quit. You can now remove the installed app.");

                      // Quit the app
                      console.log("[Settings] Quitting app...");
                      const { exit } = await import("@tauri-apps/plugin-process");
                      await exit(0);
                    } catch (err) {
                      console.error("[Settings] Cleanup failed:", err);
                      alert("Cleanup failed: " + (err instanceof Error ? err.message : String(err)));
                      setUninstallLoading(false);
                    }
                  }}
                  disabled={resetLoading || uninstallLoading}
                  className="px-4 py-2 bg-gray-600 hover:bg-gray-700 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                >
                  {uninstallLoading && <Loader2 className="w-4 h-4 animate-spin" />}
                  {uninstallLoading ? "Uninstalling..." : "Cleanup and Quit"}
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
        {(runtimeVersionInfo?.runtime_download_asset_name || runtimeVersionInfo?.runtime_download_size_bytes != null) && (
          <div>
            Runtime Download{" "}
            {runtimeVersionInfo?.runtime_download_asset_name ?? "unknown asset"}
            {runtimeVersionInfo?.runtime_download_size_bytes != null
              ? ` · ${formatBytes(runtimeVersionInfo.runtime_download_size_bytes)}`
              : ""}
          </div>
        )}
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
          onKeyDown={(e) => { if (e.key === "Escape") setWallpaperPickerOpen(false); }}
        >
          <div
            className="bg-[var(--bg-card)] rounded-xl shadow-2xl p-6 w-full max-w-4xl max-h-[85vh] overflow-auto border border-[var(--border-subtle)]"
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
