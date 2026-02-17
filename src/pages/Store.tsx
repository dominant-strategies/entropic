import { useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { invoke } from "@tauri-apps/api/core";
import clsx from "clsx";
import { CheckCircle2, Loader2, Search, ShieldCheck } from "lucide-react";
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

type WorkspaceSkill = {
  id: string;
  name: string;
  description: string;
  path: string;
  source: string;
};

type SkillCard = {
  id: string;
  name: string;
  description: string;
  sourceLabel: string;
  tags: string[];
  integrationProvider?: IntegrationProvider;
  pluginId?: string;
  workspaceSkillId?: string;
  connected?: boolean;
  managed?: boolean;
  path?: string;
};

type ScanIntent = "plugin-enable" | "skill-audit";

type ClawhubInstallResult = {
  scan: PluginScanResult;
  installed: boolean;
  blocked: boolean;
  message?: string;
  installed_skill_id?: string;
};

type ClawhubCatalogSkill = {
  slug: string;
  display_name: string;
  summary: string;
  latest_version?: string | null;
  downloads: number;
  installs_all_time: number;
  stars: number;
  updated_at?: number | null;
};

type ClawhubSkillDetails = {
  slug: string;
  display_name: string;
  summary: string;
  latest_version?: string | null;
  changelog?: string | null;
  owner_handle?: string | null;
  owner_display_name?: string | null;
  downloads: number;
  installs_all_time: number;
  stars: number;
  updated_at?: number | null;
};

type ClawhubSort = "stars" | "downloads" | "installs" | "newest";

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

const DiscordLogo = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
    <path
      fill="#5865F2"
      d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"
    />
  </svg>
);

const TelegramLogo = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
    <path
      fill="#26A5E4"
      d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.479.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"
    />
  </svg>
);

const SlackLogo = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
    <path fill="#E01E5A" d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zm1.271 0a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313z" />
    <path fill="#36C5F0" d="M8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zm0 1.271a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312z" />
    <path fill="#2EB67D" d="M18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zm-1.27 0a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.163 0a2.528 2.528 0 0 1 2.523 2.522v6.312z" />
    <path fill="#ECB22E" d="M15.163 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.163 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zm0-1.27a2.527 2.527 0 0 1-2.52-2.523 2.527 2.527 0 0 1 2.52-2.52h6.315A2.528 2.528 0 0 1 24 15.163a2.528 2.528 0 0 1-2.522 2.523h-6.315z" />
  </svg>
);

const MemoryLogo = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" className={className} aria-hidden="true" fill="none" stroke="#8B5CF6" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 2a4 4 0 0 1 4 4v1a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V6a4 4 0 0 1 4-4z" />
    <path d="M8.5 7v1.5a1 1 0 0 0 1 1h5a1 1 0 0 0 1-1V7" />
    <rect x="4" y="11" width="16" height="9" rx="2" />
    <line x1="8" y1="11" x2="8" y2="20" />
    <line x1="12" y1="11" x2="12" y2="20" />
    <line x1="16" y1="11" x2="16" y2="20" />
    <line x1="4" y1="15.5" x2="20" y2="15.5" />
  </svg>
);

const PLUGIN_ICONS: Record<string, ComponentType<{ className?: string }>> = {
  discord: DiscordLogo,
  telegram: TelegramLogo,
  slack: SlackLogo,
  "nova-x": XLogo,
  "memory-lancedb": MemoryLogo,
  "memory-core": MemoryLogo,
};

const META: Record<string, Partial<Plugin>> = {
  "memory-lancedb": { name: "Long-Term Memory", description: "OpenAI-powered long-term recall (optional add-on).", category: "memory" },
  "memory-core": { name: "QMD Memory (Default)", description: "Fast local hybrid memory search over notes and sessions.", category: "memory" },
  discord: { name: "Discord", description: "Connect Nova to Discord servers and DMs with a bot token and OAuth invite.", category: "integrations" },
  telegram: { name: "Telegram", description: "Run your agent as a Telegram bot.", category: "integrations" },
  slack: { name: "Slack", description: "Connect Nova to Slack workspaces.", category: "integrations" },
  "nova-x": { name: "Nova X Skill", description: "Search public posts and fetch profile/thread context from X." },
};

const GOOGLE_INTEGRATIONS: Omit<GoogleIntegration, "connected" | "email">[] = [
  {
    id: "google_calendar",
    name: "Google Calendar",
    description: "Sync your calendar events.",
    icon: GoogleCalendarIcon,
  },
  {
    id: "google_email",
    name: "Gmail",
    description: "Read and send emails.",
    icon: GmailIcon,
  },
];

const INTEGRATION_NAMES: Record<IntegrationProvider, string> = {
  google_calendar: "Google Calendar",
  google_email: "Gmail",
  x: "X (Twitter)",
};

const SYNC_REQUIRED = new Set<IntegrationProvider>(["google_calendar", "google_email"]);
const NOVA_X_SKILL_ID = "nova-x";
const MESSAGING_PLUGIN_IDS = new Set([
  "discord",
  "telegram",
  "whatsapp",
  "imessage",
  "slack",
  "googlechat",
]);
const HIDDEN_PLUGIN_IDS = new Set(["matrix", "mstreams"]);

const CATEGORIES = [
  { id: "all", label: "All" },
  { id: "tools", label: "Tools" },
  { id: "integrations", label: "Integrations" },
  { id: "memory", label: "Memory" },
];

function scanBadge(result: PluginScanResult | null) {
  if (!result) {
    return { label: "Not Scanned", className: "bg-[var(--system-gray-6)] text-[var(--text-secondary)]" };
  }
  if (!result.scanner_available) {
    return { label: "Scanner Unavailable", className: "bg-amber-50 text-amber-700" };
  }
  if (result.is_safe) {
    return { label: "Safe", className: "bg-green-50 text-green-700" };
  }
  return {
    label: `${result.max_severity} (${result.findings_count})`,
    className: result.max_severity === "CRITICAL" || result.max_severity === "HIGH"
      ? "bg-red-50 text-red-700"
      : "bg-yellow-50 text-yellow-700",
  };
}

export function Store({
  integrationsSyncing,
  integrationsMissing,
  view = "plugins",
  onNavigate,
}: {
  integrationsSyncing?: boolean;
  integrationsMissing?: boolean;
  view?: "plugins" | "skills";
  onNavigate?: (page: "channels") => void;
}) {
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [workspaceSkills, setWorkspaceSkills] = useState<WorkspaceSkill[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [skillsError, setSkillsError] = useState<string | null>(null);
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
  const [scanIntent, setScanIntent] = useState<ScanIntent>("plugin-enable");
  const [scanTargetName, setScanTargetName] = useState("");
  const [clawhubBusy, setClawhubBusy] = useState(false);
  const [clawhubBusySlug, setClawhubBusySlug] = useState<string | null>(null);
  const [clawhubError, setClawhubError] = useState<string | null>(null);
  const [pendingUnsafeSlug, setPendingUnsafeSlug] = useState<string | null>(null);
  const [skillQuery, setSkillQuery] = useState("");
  const [clawhubSort, setClawhubSort] = useState<ClawhubSort>("stars");
  const [clawhubCatalog, setClawhubCatalog] = useState<ClawhubCatalogSkill[]>([]);
  const [clawhubLoading, setClawhubLoading] = useState(false);
  const [clawhubLookupError, setClawhubLookupError] = useState<string | null>(null);
  const [expandedClawhubSlug, setExpandedClawhubSlug] = useState<string | null>(null);
  const [clawhubDetails, setClawhubDetails] = useState<Record<string, ClawhubSkillDetails>>({});
  const [clawhubDetailLoading, setClawhubDetailLoading] = useState<string | null>(null);
  const [clawhubDetailError, setClawhubDetailError] = useState<string | null>(null);
  const [removingSkill, setRemovingSkill] = useState<string | null>(null);
  const [skillScanResults, setSkillScanResults] = useState<Record<string, PluginScanResult>>({});
  const syncedIntegrationsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    refreshPlugins();
    refreshIntegrations();
    refreshSkills();
    refreshClawhubCatalog({ silent: true });
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

  async function refreshPlugins() {
    try {
      const list = await invoke<any[]>("get_plugin_store");
      const normalized: Plugin[] = list.map((p) => {
        const meta = META[p.id] || {};
        const category: Plugin["category"] =
          meta.category || (p.kind === "memory" ? "memory" : p.channels?.length > 0 ? "integrations" : "tools");
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

  async function refreshSkills() {
    setSkillsLoading(true);
    setSkillsError(null);
    try {
      const list = await invoke<WorkspaceSkill[]>("get_skill_store");
      setWorkspaceSkills(list);
    } catch (err) {
      const message = String(err);
      setSkillsError(message);
      console.error("Failed to load skills:", err);
    } finally {
      setSkillsLoading(false);
    }
  }

  async function refreshClawhubCatalog(opts?: { silent?: boolean }) {
    if (!opts?.silent) {
      setClawhubLoading(true);
    }
    setClawhubLookupError(null);
    try {
      const fetchSort =
        clawhubSort === "newest"
          ? "newest"
          : clawhubSort === "downloads"
            ? "downloads"
            : clawhubSort === "installs"
              ? "installsAllTime"
              : "rating";
      const list = await invoke<ClawhubCatalogSkill[]>("get_clawhub_catalog", {
        query: skillQuery.trim() || null,
        limit: 60,
        sort: fetchSort,
      });
      const sorted = [...list].sort((a, b) => {
        if (clawhubSort === "newest") {
          return (b.updated_at || 0) - (a.updated_at || 0);
        }
        if (clawhubSort === "downloads") {
          return b.downloads - a.downloads;
        }
        if (clawhubSort === "installs") {
          return b.installs_all_time - a.installs_all_time;
        }
        return b.stars - a.stars;
      });
      setClawhubCatalog(sorted);
    } catch (err) {
      const message = String(err);
      setClawhubLookupError(message);
      console.error("Failed to load ClawHub catalog:", err);
    } finally {
      setClawhubLoading(false);
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
        const connectedIds = new Set(list.filter((i) => i.connected).map((i) => i.provider));
        for (const id of Array.from(syncedIntegrationsRef.current)) {
          if (!connectedIds.has(id as IntegrationProvider)) {
            syncedIntegrationsRef.current.delete(id);
          }
        }
        syncConnectedIntegrations(list).catch((err) => {
          console.warn("Failed to sync integrations:", err);
        });
        return;
      } catch {
        // ignore cache failures
      }
    } catch (err) {
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
    if (view !== "skills") return;
    const timer = window.setTimeout(() => {
      refreshClawhubCatalog();
    }, 250);
    return () => window.clearTimeout(timer);
  }, [view, skillQuery, clawhubSort]);

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

  const pluginsSansNovaX = useMemo(() => plugins.filter((p) => p.id !== NOVA_X_SKILL_ID), [plugins]);
  const visiblePlugins = useMemo(
    () => pluginsSansNovaX.filter((p) => !MESSAGING_PLUGIN_IDS.has(p.id) && !HIDDEN_PLUGIN_IDS.has(p.id)),
    [pluginsSansNovaX]
  );

  const filteredPlugins = useMemo(
    () => (category === "all" ? visiblePlugins : visiblePlugins.filter((p) => p.category === category)),
    [category, visiblePlugins]
  );

  const googleIntegrations: GoogleIntegration[] = useMemo(() => {
    return GOOGLE_INTEGRATIONS.map((gi) => {
      const entry = integrations.find((i) => i.provider === gi.id);
      return {
        ...gi,
        connected: !!entry && !entry.stale,
        stale: entry?.stale,
        email: entry?.email,
      };
    });
  }, [integrations]);

  const xIntegration = useMemo(() => integrations.find((i) => i.provider === "x"), [integrations]);
  const xConnected = !!xIntegration && !xIntegration.stale;

  const installedSkillCards = useMemo(() => {
    const cards: SkillCard[] = [
      {
        id: NOVA_X_SKILL_ID,
        name: "X Research",
        description: "Default Nova skill for searching posts, reading profiles, and pulling thread context.",
        sourceLabel: "Nova Default",
        tags: ["x", "search", "default"],
        integrationProvider: "x",
        pluginId: NOVA_X_SKILL_ID,
        connected: xConnected,
        managed: true,
      },
      ...workspaceSkills.map((skill) => ({
        id: skill.id,
        name: skill.name || skill.id,
        description: skill.description || "Workspace skill",
        sourceLabel: skill.source || "Workspace",
        tags: ["workspace", "custom"],
        workspaceSkillId: skill.id,
        path: skill.path,
      })),
    ];

    const needle = skillQuery.trim().toLowerCase();
    const filtered = !needle ? cards : cards.filter((skill) => {
      const haystack = [skill.name, skill.description, skill.sourceLabel, ...skill.tags].join(" ").toLowerCase();
      return haystack.includes(needle);
    });

    const managed = filtered
      .filter((skill) => skill.managed)
      .sort((a, b) => a.name.localeCompare(b.name));
    const others = filtered
      .filter((skill) => !skill.managed)
      .sort((a, b) => a.name.localeCompare(b.name));
    return [...managed, ...others];
  }, [workspaceSkills, skillQuery, xConnected]);

  const installedWorkspaceSkillIds = useMemo(
    () => new Set(workspaceSkills.map((skill) => skill.id)),
    [workspaceSkills]
  );

  async function beginSecurityScan(params: {
    intent: ScanIntent;
    targetName: string;
    pluginId?: string;
    skillId?: string;
    scan: () => Promise<PluginScanResult>;
  }) {
    setScanIntent(params.intent);
    setScanTargetName(params.targetName);
    setScanPluginId(params.pluginId || null);
    setScanResult(null);
    setScanError(null);
    setIsScanning(true);
    setScanModalOpen(true);
    try {
      const result = await params.scan();
      setScanResult(result);
      if (params.skillId) {
        setSkillScanResults((prev) => ({ ...prev, [params.skillId as string]: result }));
      }
    } catch (err) {
      setScanError(String(err));
    } finally {
      setIsScanning(false);
    }
  }

  async function handleEnablePlugin(id: string) {
    const pluginName = plugins.find((p) => p.id === id)?.name || id;
    await beginSecurityScan({
      intent: "plugin-enable",
      targetName: pluginName,
      pluginId: id,
      scan: () => invoke<PluginScanResult>("scan_plugin", { id }),
    });
  }

  async function handleAuditSkill(skill: SkillCard) {
    await beginSecurityScan({
      intent: "skill-audit",
      targetName: skill.name,
      pluginId: skill.pluginId,
      skillId: skill.id,
      scan: () => {
        if (skill.pluginId) {
          return invoke<PluginScanResult>("scan_plugin", { id: skill.pluginId });
        }
        if (skill.workspaceSkillId) {
          return invoke<PluginScanResult>("scan_workspace_skill", { id: skill.workspaceSkillId });
        }
        return Promise.reject(new Error("Skill source is not scannable"));
      },
    });
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
      await refreshPlugins();
    }
  }

  async function handleDisablePlugin(id: string) {
    setInstalling(id);
    try {
      await invoke("set_plugin_enabled", { id, enabled: false });
    } finally {
      setInstalling(null);
      await refreshPlugins();
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
        return prev.map((i) => (i.provider === provider ? { ...i, connected: true, stale: false } : i));
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

  async function scanInstallSkillFromClawhub(slug: string, allowUnsafe: boolean) {
    const normalizedSlug = slug.trim();
    if (!normalizedSlug) return;

    setClawhubBusy(true);
    setClawhubBusySlug(normalizedSlug);
    setClawhubError(null);
    setPendingUnsafeSlug(null);

    try {
      const result = await invoke<ClawhubInstallResult>("scan_and_install_clawhub_skill", {
        slug: normalizedSlug,
        allowUnsafe,
      });
      setScanIntent("skill-audit");
      setScanTargetName(normalizedSlug);
      setScanPluginId(null);
      setScanResult(result.scan);
      setScanError(null);
      setScanModalOpen(true);
      setSkillScanResults((prev) => ({ ...prev, [result.installed_skill_id || normalizedSlug]: result.scan }));
      if (result.blocked && !allowUnsafe) {
        setPendingUnsafeSlug(normalizedSlug);
      } else {
        setPendingUnsafeSlug(null);
      }
      if (result.installed) {
        await refreshSkills();
        await refreshClawhubCatalog({ silent: true });
      } else if (result.message) {
        setClawhubError(result.message);
      }
    } catch (err) {
      const msg = String(err);
      setClawhubError(msg);
      setScanError(msg);
      setScanModalOpen(true);
    } finally {
      setClawhubBusy(false);
      setClawhubBusySlug(null);
    }
  }

  async function handleRemoveWorkspaceSkill(skillId: string) {
    const confirmed = window.confirm(`Remove "${skillId}" from installed skills?`);
    if (!confirmed) return;

    setRemovingSkill(skillId);
    setSkillsError(null);
    try {
      await invoke("remove_workspace_skill", { id: skillId });
      setSkillScanResults((prev) => {
        const next = { ...prev };
        delete next[skillId];
        return next;
      });
      await refreshSkills();
      await refreshClawhubCatalog({ silent: true });
    } catch (err) {
      const message = String(err);
      setSkillsError(message);
      console.error("Failed to remove skill:", err);
    } finally {
      setRemovingSkill(null);
    }
  }

  async function toggleClawhubDetails(slug: string) {
    if (expandedClawhubSlug === slug) {
      setExpandedClawhubSlug(null);
      setClawhubDetailError(null);
      return;
    }
    setExpandedClawhubSlug(slug);
    setClawhubDetailError(null);

    if (clawhubDetails[slug]) {
      return;
    }

    setClawhubDetailLoading(slug);
    try {
      const detail = await invoke<ClawhubSkillDetails>("get_clawhub_skill_details", { slug });
      setClawhubDetails((prev) => ({ ...prev, [slug]: detail }));
    } catch (err) {
      const message = String(err);
      setClawhubDetailError(message);
      console.error("Failed to load ClawHub skill details:", err);
    } finally {
      setClawhubDetailLoading(null);
    }
  }

  const activeTab = view;
  const showIntegrations = activeTab === "plugins" && (category === "all" || category === "integrations");
  const setupLabel = setupProvider ? INTEGRATION_NAMES[setupProvider] : "";

  return (
    <div className="max-w-6xl mx-auto px-6 pb-12">
      <div className="pt-8 mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-[var(--text-primary)] mb-2 tracking-tight">
            {activeTab === "skills" ? "Skills" : "Plugin Store"}
          </h1>
          <p className="text-lg text-[var(--text-secondary)]">
            {activeTab === "skills"
              ? "Browse, scan, and install skills."
              : "Manage tools and account integrations."}
          </p>
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

      {activeTab === "plugins" && (
        <>
          <div className="flex gap-3 mb-8 overflow-x-auto pb-2 scrollbar-hide">
            {CATEGORIES.map((cat) => (
              <button
                key={cat.id}
                onClick={() => setCategory(cat.id)}
                className={clsx(
                  "px-5 py-2 rounded-full font-medium text-sm transition-all whitespace-nowrap",
                  category === cat.id
                    ? "bg-black text-white shadow-md"
                    : "bg-white text-[var(--text-secondary)] hover:bg-[var(--system-gray-6)] shadow-sm border border-[var(--border-subtle)]"
                )}
              >
                {cat.label}
              </button>
            ))}
          </div>

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
                  {googleIntegrations.every((i) => i.connected) && (
                    <div className="ml-auto flex items-center gap-1.5 px-3 py-1.5 bg-green-50 text-green-700 rounded-full text-xs font-medium">
                      <CheckCircle2 className="w-4 h-4" />
                      All Connected
                    </div>
                  )}
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {googleIntegrations.map((integration) => {
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
                          onClick={() =>
                            integration.connected && !integration.stale
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

          {filteredPlugins.length > 0 && (
            <div className="mb-10">
              {showIntegrations && googleIntegrations.length > 0 && (
                <h2 className="text-xl font-bold text-[var(--text-primary)] mb-4">All Plugins</h2>
              )}
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {filteredPlugins.map((plugin) => (
                  <div key={plugin.id} className="group bg-white rounded-2xl p-5 shadow-sm border border-[var(--border-subtle)] hover:shadow-md transition-all flex flex-col h-full">
                    <div className="flex justify-between items-start mb-3">
                      <div className="w-12 h-12 bg-gradient-to-br from-blue-50 to-indigo-50 rounded-xl flex items-center justify-center text-blue-600 font-bold text-lg border border-blue-100">
                        {PLUGIN_ICONS[plugin.id] ? (
                          (() => { const Icon = PLUGIN_ICONS[plugin.id]; return <Icon className="w-7 h-7" />; })()
                        ) : (
                          plugin.name.slice(0, 1)
                        )}
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
                      <button
                        onClick={() => (plugin.enabled ? handleDisablePlugin(plugin.id) : handleEnablePlugin(plugin.id))}
                        disabled={installing === plugin.id}
                        className={clsx(
                          "w-full py-2 rounded-lg text-sm font-semibold transition-colors",
                          plugin.enabled
                            ? "bg-[var(--system-gray-6)] text-[var(--text-secondary)] hover:bg-red-50 hover:text-red-600"
                            : "bg-[var(--system-blue)] text-white hover:bg-blue-600 shadow-sm"
                        )}
                      >
                        {installing === plugin.id ? "Processing..." : plugin.enabled ? "Uninstall" : "Install"}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {filteredPlugins.length === 0 && (!showIntegrations || googleIntegrations.length === 0) && (
            <div className="text-center py-20">
              <div className="w-16 h-16 bg-[var(--system-gray-6)] rounded-full flex items-center justify-center mx-auto mb-4 text-[var(--text-tertiary)]">
                <ShieldCheck className="w-8 h-8" />
              </div>
              <h3 className="text-lg font-medium text-[var(--text-primary)] mb-1">No plugins found</h3>
              <p className="text-[var(--text-secondary)]">Try selecting a different category.</p>
            </div>
          )}
        </>
      )}

      {activeTab === "skills" && (
        <>
          {skillsLoading && (
            <div className="py-8 text-sm text-[var(--text-secondary)] flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" />
              Loading skills...
            </div>
          )}

          {!skillsLoading && skillsError && (
            <div className="mb-6 rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700">
              {skillsError}
            </div>
          )}

          {!skillsLoading && (
            <div>
              <h2 className="text-xl font-bold text-[var(--text-primary)] mb-4">Installed Skills</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {installedSkillCards.map((skill) => {
                  const badge = skill.managed
                    ? { label: "Nova Managed", className: "bg-blue-50 text-blue-700" }
                    : scanBadge(skillScanResults[skill.id] || null);
                  return (
                    <div key={skill.id} className="aspect-square bg-white rounded-2xl p-4 shadow-sm border border-[var(--border-subtle)] flex flex-col">
                      <div className="flex items-start gap-3">
                        <div className="w-11 h-11 bg-[var(--system-gray-6)] rounded-xl flex items-center justify-center shrink-0">
                          {skill.id === NOVA_X_SKILL_ID ? <XLogo className="w-5 h-5 text-[var(--text-primary)]" /> : <ShieldCheck className="w-5 h-5 text-[var(--text-tertiary)]" />}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <h3 className="font-bold text-[var(--text-primary)] truncate">{skill.name}</h3>
                            <span className={clsx("text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded-md", badge.className)}>
                              {badge.label}
                            </span>
                          </div>
                          <p className="text-xs text-[var(--text-tertiary)] mt-0.5 line-clamp-1">{skill.sourceLabel}</p>
                        </div>
                      </div>
                      <p className="mt-3 text-sm text-[var(--text-secondary)] line-clamp-3 flex-none">{skill.description}</p>
                      <div className="mt-3 flex flex-wrap gap-1.5">
                        {skill.tags.map((tag) => (
                          <span key={tag} className="text-[10px] px-2 py-0.5 rounded-full bg-[var(--system-gray-6)] text-[var(--text-secondary)]">
                            {tag}
                          </span>
                        ))}
                      </div>
                      {skill.path && <p className="mt-2 text-[11px] text-[var(--text-tertiary)] break-all line-clamp-2 flex-none">{skill.path}</p>}
                      <div className="mt-auto pt-3">
                        <div className={clsx("grid gap-2", skill.managed ? "grid-cols-1" : "grid-cols-2")}>
                          {!skill.managed && (
                            <button
                              onClick={() => handleAuditSkill(skill)}
                              className="py-2 rounded-lg text-xs font-semibold bg-[var(--system-gray-6)] text-[var(--text-primary)] hover:bg-[var(--system-gray-5)]"
                            >
                              Security Scan
                            </button>
                          )}
                          {skill.integrationProvider ? (
                            <button
                              onClick={() =>
                                skill.connected
                                  ? handleDisconnectIntegration(skill.integrationProvider as IntegrationProvider)
                                  : handleConnectIntegration(skill.integrationProvider as IntegrationProvider)
                              }
                              disabled={connecting === skill.integrationProvider}
                              className={clsx(
                                "py-2 rounded-lg text-xs font-semibold",
                                skill.connected
                                  ? "bg-green-50 text-green-700 border border-green-100"
                                  : "bg-[var(--system-blue)] text-white"
                              )}
                            >
                              {connecting === skill.integrationProvider ? "..." : skill.connected ? "Connected" : "Connect X"}
                            </button>
                          ) : skill.workspaceSkillId ? (
                            <button
                              onClick={() => handleRemoveWorkspaceSkill(skill.workspaceSkillId as string)}
                              disabled={removingSkill === skill.workspaceSkillId}
                              className="py-2 rounded-lg text-xs font-semibold bg-red-50 text-red-700 border border-red-100 disabled:opacity-60"
                            >
                              {removingSkill === skill.workspaceSkillId ? "Removing..." : "Remove"}
                            </button>
                          ) : (
                            <button disabled className="py-2 rounded-lg text-xs font-semibold bg-[var(--system-gray-6)] text-[var(--text-tertiary)]">
                              Local Skill
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {!skillsLoading && installedSkillCards.length === 0 && (
            <div className="text-center py-20">
              <div className="w-16 h-16 bg-[var(--system-gray-6)] rounded-full flex items-center justify-center mx-auto mb-4 text-[var(--text-tertiary)]">
                <Search className="w-8 h-8" />
              </div>
              <h3 className="text-lg font-medium text-[var(--text-primary)] mb-1">No matching skills</h3>
              <p className="text-[var(--text-secondary)]">Try a different search term or install a skill from ClawHub below.</p>
            </div>
          )}

          <div className="mb-8 bg-white rounded-2xl border border-[var(--border-subtle)] p-5">
            <p className="text-xs uppercase tracking-wide text-[var(--text-tertiary)] mb-2">Skill Lookup</p>
            <div className="flex flex-col lg:flex-row lg:items-center gap-3">
              <div className="relative flex-1">
                <Search className="w-4 h-4 text-[var(--text-tertiary)] absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  value={skillQuery}
                  onChange={(e) => setSkillQuery(e.target.value)}
                  className="w-full pl-9 pr-3 py-2 rounded-lg border border-[var(--border-subtle)] bg-white text-sm"
                  placeholder="Search by skill name, slug, or description"
                />
              </div>
              <select
                value={clawhubSort}
                onChange={(e) => setClawhubSort(e.target.value as ClawhubSort)}
                className="px-3 py-2 rounded-lg border border-[var(--border-subtle)] bg-white text-sm"
              >
                <option value="stars">Most Stars</option>
                <option value="downloads">Most Downloads</option>
                <option value="installs">Most Installs</option>
                <option value="newest">Newest</option>
              </select>
            </div>
            <p className="text-xs text-[var(--text-secondary)] mt-2">
              Search first, then install from the ClawHub rows below. Nova scans before install.
            </p>
            {clawhubError && <p className="text-xs text-red-600 mt-2">{clawhubError}</p>}
          </div>

          <div className="mb-10">
            <h2 className="text-xl font-bold text-[var(--text-primary)] mb-4">Browse ClawHub</h2>
            <div className="bg-white rounded-2xl border border-[var(--border-subtle)] p-5">
              {clawhubLoading && (
                <div className="py-8 text-sm text-[var(--text-secondary)] flex items-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Loading ClawHub skills...
                </div>
              )}

              {!clawhubLoading && clawhubLookupError && (
                <div className="rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700">
                  {clawhubLookupError}
                </div>
              )}

              {!clawhubLoading && !clawhubLookupError && (
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                  {clawhubCatalog.map((skill) => {
                    const installed = installedWorkspaceSkillIds.has(skill.slug);
                    const expanded = expandedClawhubSlug === skill.slug;
                    const details = clawhubDetails[skill.slug];
                    return (
                      <div key={skill.slug} className="aspect-square rounded-xl border border-[var(--border-subtle)] bg-[var(--system-gray-6)]/40 p-4 flex flex-col">
                        <div className="flex items-start gap-2">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <h3 className="font-semibold text-[var(--text-primary)] line-clamp-1">{skill.display_name || skill.slug}</h3>
                              {installed ? (
                                <span className="text-[10px] font-bold uppercase tracking-wider text-green-700 bg-green-50 px-2 py-1 rounded-md">
                                  Installed
                                </span>
                              ) : (
                                <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-tertiary)] bg-white px-2 py-1 rounded-md border border-[var(--border-subtle)]">
                                  ClawHub
                                </span>
                              )}
                            </div>
                            <p className="text-xs text-[var(--text-tertiary)] mt-0.5 line-clamp-1">{skill.slug}</p>
                          </div>
                        </div>
                        <p className="mt-2 text-xs text-[var(--text-secondary)] line-clamp-3">{skill.summary || "No summary provided."}</p>
                        <div className="mt-2 flex flex-wrap gap-1.5 text-[10px] text-[var(--text-tertiary)]">
                          <span className="px-2 py-0.5 rounded-full bg-white border border-[var(--border-subtle)]">v{skill.latest_version || "latest"}</span>
                          <span className="px-2 py-0.5 rounded-full bg-white border border-[var(--border-subtle)]">{skill.stars} stars</span>
                          <span className="px-2 py-0.5 rounded-full bg-white border border-[var(--border-subtle)]">{skill.downloads} downloads</span>
                          <span className="px-2 py-0.5 rounded-full bg-white border border-[var(--border-subtle)]">{skill.installs_all_time} installs</span>
                        </div>
                        <div className="mt-auto pt-3">
                          <div className="grid grid-cols-2 gap-2">
                            <button
                              onClick={() => toggleClawhubDetails(skill.slug)}
                              className="py-2 rounded-lg text-xs font-semibold bg-white border border-[var(--border-subtle)] text-[var(--text-primary)]"
                            >
                              {expanded ? "Hide Details" : "Details"}
                            </button>
                            <button
                              onClick={() => scanInstallSkillFromClawhub(skill.slug, false)}
                              disabled={clawhubBusy || installed}
                              className={clsx(
                                "py-2 rounded-lg text-xs font-semibold",
                                installed
                                  ? "bg-[var(--system-gray-6)] text-[var(--text-tertiary)]"
                                  : "bg-[var(--system-blue)] text-white"
                              )}
                            >
                              {installed
                                ? "Installed"
                                : clawhubBusy && clawhubBusySlug === skill.slug
                                  ? "Scanning..."
                                  : "Scan + Install"}
                            </button>
                          </div>
                        </div>
                        {expanded && (
                          <div className="mt-3 rounded-lg bg-white border border-[var(--border-subtle)] p-3 text-xs">
                            {clawhubDetailLoading === skill.slug && (
                              <div className="flex items-center gap-2 text-[var(--text-secondary)]">
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                Loading details...
                              </div>
                            )}
                            {clawhubDetailError && (
                              <p className="text-red-600">{clawhubDetailError}</p>
                            )}
                            {details && (
                              <div className="space-y-1 text-[var(--text-secondary)]">
                                <p><span className="font-semibold text-[var(--text-primary)]">Owner:</span> {details.owner_display_name || details.owner_handle || "Unknown"}</p>
                                <p><span className="font-semibold text-[var(--text-primary)]">Latest:</span> {details.latest_version || "latest"}</p>
                                <p><span className="font-semibold text-[var(--text-primary)]">Installs:</span> {details.installs_all_time}</p>
                                {details.changelog && (
                                  <p className="whitespace-pre-wrap line-clamp-4"><span className="font-semibold text-[var(--text-primary)]">Changelog:</span> {details.changelog}</p>
                                )}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {!clawhubLoading && !clawhubLookupError && clawhubCatalog.length === 0 && (
                <div className="text-center py-12 text-sm text-[var(--text-secondary)]">
                  No ClawHub skills found for this search.
                </div>
              )}
            </div>
          </div>
        </>
      )}

      <div className="mt-12 pt-6 border-t border-[var(--border-subtle)] flex items-center justify-center gap-2 text-xs text-[var(--text-tertiary)]">
        <ShieldCheck className="w-3.5 h-3.5" />
        <span>
          Securely validated by{" "}
          <a
            href="https://github.com/cisco-ai-defense/skill-scanner"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-[var(--text-secondary)] underline transition-colors"
          >
            Cisco AI Defense Skill Scanner
          </a>
        </span>
      </div>

      <ScanResultModal
        isOpen={scanModalOpen}
        targetName={scanTargetName || META[scanPluginId || ""]?.name || scanPluginId || ""}
        targetType={scanIntent === "plugin-enable" ? "plugin" : "skill"}
        scanResult={scanResult}
        isScanning={isScanning}
        error={scanError}
        onClose={() => {
          setScanModalOpen(false);
          setScanPluginId(null);
          setPendingUnsafeSlug(null);
        }}
        onConfirm={
          scanIntent === "plugin-enable"
            ? confirmEnablePlugin
            : pendingUnsafeSlug
              ? () => {
                  void scanInstallSkillFromClawhub(pendingUnsafeSlug, true);
                }
              : undefined
        }
        confirmLabel={scanIntent === "plugin-enable" ? "Enable Plugin" : "Install Skill"}
        confirmAnywayLabel={scanIntent === "plugin-enable" ? "Enable Anyway" : "Install Anyway"}
      />

      {setupProvider && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20">
          <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl border border-[var(--border-subtle)]">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 rounded-full bg-[var(--bg-tertiary)] p-2">
                <Loader2 className="w-4 h-4 animate-spin text-[var(--text-primary)]" />
              </div>
              <div>
                <div className="text-sm font-semibold text-[var(--text-primary)]">Setting up {setupLabel}</div>
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
              <button className="btn btn-secondary !text-xs" onClick={() => setSetupProvider(null)}>
                Continue in background
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
