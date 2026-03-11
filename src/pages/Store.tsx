import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-shell";
import clsx from "clsx";
import { CheckCircle2, Loader2, Search, ShieldCheck, Download, Star, ExternalLink, Box, Puzzle, Sparkles, ChevronRight, Info, X } from "lucide-react";
import quaiLogo from "../assets/quai-logo.png";
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
import { useAuth } from "../contexts/AuthContext";

// Module-level cache for the ClawHub catalog — survives page navigation.
// Keyed by "sort:query" so different sort/search results are cached independently.
const CLAWHUB_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const PAGE_SIZE = 20; // items per page
type ClawhubCacheEntry = {
  items: ClawhubCatalogSkill[];
  ts: number;
};
const clawhubCatalogCache = new Map<string, ClawhubCacheEntry>();

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

type PluginIconSpec =
  | { kind: "component"; component: ComponentType<{ className?: string }> }
  | { kind: "image"; src: string; alt: string };

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
  scan?: PluginScanResult;
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
  is_fallback?: boolean;
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

const formatCompactNumber = (value: number) => {
  if (value >= 1_000_000) {
    const compact = (value / 1_000_000).toFixed(1).replace(/\.0$/, "");
    return `${compact}M`;
  }
  if (value >= 1_000) {
    const compact = (value / 1_000).toFixed(1).replace(/\.0$/, "");
    return `${compact}K`;
  }
  return String(value);
};

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

const PLUGIN_ICONS: Record<string, PluginIconSpec> = {
  discord: { kind: "component", component: DiscordLogo },
  telegram: { kind: "component", component: TelegramLogo },
  slack: { kind: "component", component: SlackLogo },
  "entropic-x": { kind: "component", component: XLogo },
  "entropic-quai-builder": { kind: "image", src: quaiLogo, alt: "Quai Network" },
  "memory-lancedb": { kind: "component", component: MemoryLogo },
  "memory-core": { kind: "component", component: MemoryLogo },
};

const META: Record<string, Partial<Plugin>> = {
  "memory-lancedb": { name: "Long-Term Memory", description: "OpenAI-powered long-term recall (optional add-on).", category: "memory" },
  "memory-core": { name: "QMD Memory (Default)", description: "Fast local hybrid memory search over notes and sessions.", category: "memory" },
  discord: { name: "Discord", description: "Connect Entropic to Discord servers and DMs with a bot token and OAuth invite.", category: "integrations" },
  telegram: { name: "Telegram", description: "Run your agent as a Telegram bot.", category: "integrations" },
  slack: { name: "Slack", description: "Connect Entropic to Slack workspaces.", category: "integrations" },
  "entropic-x": { name: "Entropic X Skill", description: "Search public posts and fetch profile/thread context from X." },
  "entropic-quai-builder": { name: "Quai Network Builder", description: "Learn and build on Quai Network." },
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
const ENTROPIC_X_SKILL_ID = "entropic-x";
const ENTROPIC_QUAI_SKILL_ID = "entropic-quai-builder";
const MANAGED_SKILL_PLUGIN_IDS = new Set([ENTROPIC_X_SKILL_ID, ENTROPIC_QUAI_SKILL_ID]);
const MESSAGING_PLUGIN_IDS = new Set([
  "discord",
  "telegram",
  "whatsapp",
  "slack",
  "googlechat",
]);
const HIDDEN_PLUGIN_IDS = new Set(["matrix", "mstreams"]);

const FEATURED_SLUGS = new Set([
  "github", "ontology", "summarize", "slack",
]);

const FEATURED_SKILLS_FALLBACK: ClawhubCatalogSkill[] = [
  { slug: "github", display_name: "GitHub", summary: "Interact with GitHub repos, issues, PRs, and commits.", downloads: 0, installs_all_time: 0, stars: 0 },
  { slug: "ontology", display_name: "Ontology", summary: "Knowledge graph and ontology management for structured reasoning.", downloads: 0, installs_all_time: 0, stars: 0 },
  { slug: "summarize", display_name: "Summarize", summary: "Intelligent text summarization for long documents and content.", downloads: 0, installs_all_time: 0, stars: 0 },
  { slug: "slack", display_name: "Slack", summary: "Send and manage Slack messages and channels.", downloads: 0, installs_all_time: 0, stars: 0 },
];

const CATEGORIES = [
  { id: "all", label: "All" },
  { id: "tools", label: "Tools" },
  { id: "integrations", label: "Integrations" },
  { id: "memory", label: "Memory" },
];

function scanBadge(result: PluginScanResult | null) {
  if (!result) {
    return { label: "Not Scanned", className: "bg-[var(--bg-tertiary)] text-[var(--text-secondary)]" };
  }
  if (!result.scanner_available) {
    return { label: "Scanner Unavailable", className: "bg-amber-500/10 text-amber-500" };
  }
  if (result.is_safe) {
    return { label: "Safe", className: "bg-green-500/10 text-green-500" };
  }
  return {
    label: `${result.max_severity} (${result.findings_count})`,
    className: result.max_severity === "CRITICAL" || result.max_severity === "HIGH"
      ? "bg-red-500/10 text-red-500"
      : "bg-yellow-500/10 text-yellow-500",
  };
}

export function Store({
  integrationsSyncing,
  integrationsMissing,
  onNavigate,
}: {
  integrationsSyncing?: boolean;
  integrationsMissing?: boolean;
  onNavigate?: (page: "channels") => void;
}) {
  const { isAuthenticated, isAuthConfigured } = useAuth();
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
  const [setupLaunchUrl, setSetupLaunchUrl] = useState<string | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [setupVerifying, setSetupVerifying] = useState(false);
  const [setupUrlCopied, setSetupUrlCopied] = useState(false);

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
  const [clawhubDetailModalSlug, setClawhubDetailModalSlug] = useState<string | null>(null);
  const [clawhubDetailModalSkill, setClawhubDetailModalSkill] = useState<ClawhubCatalogSkill | null>(null);
  const [clawhubDetails, setClawhubDetails] = useState<Record<string, ClawhubSkillDetails>>({});
  const [clawhubDetailLoading, setClawhubDetailLoading] = useState<string | null>(null);
  const [clawhubDetailError, setClawhubDetailError] = useState<string | null>(null);
  const [removingSkill, setRemovingSkill] = useState<string | null>(null);
  const [skillScanResults, setSkillScanResults] = useState<Record<string, PluginScanResult>>({});
  const [gatewayRestarting, setGatewayRestarting] = useState(false);
  // How many browse-skills are currently visible (incremented on scroll)
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const syncedIntegrationsRef = useRef<Set<string>>(new Set());
  const [justInstalledSlugs, setJustInstalledSlugs] = useState<Set<string>>(new Set());
  const clawhubRequestSeqRef = useRef(0);

  // Redesign state - sub-tab removed, single unified view

  useEffect(() => {
    refreshPlugins();
    refreshIntegrations();
    refreshSkills();
    refreshClawhubCatalog({ silent: true });

    let unlistenRestarting: (() => void) | undefined;
    listen("gateway-restarting", () => {
      setGatewayRestarting(true);
      setTimeout(() => setGatewayRestarting(false), 8000);
    }).then((fn) => { unlistenRestarting = fn; });

    return () => {
      unlistenRestarting?.();
    };
  }, []);


  useEffect(() => {
    const handleIntegrationUpdate = () => {
      setSetupError(null);
      refreshIntegrations({ force: true });
    };
    const handleIntegrationError = (event: Event) => {
      const detail = (event as CustomEvent<{ error?: string }>).detail;
      const message =
        typeof detail?.error === "string" && detail.error.trim().length > 0
          ? detail.error
          : "Integration authorization failed.";
      setSetupError(message);
      setSetupTimedOut(true);
      refreshIntegrations({ force: true });
    };
    window.addEventListener("entropic-integration-updated", handleIntegrationUpdate);
    window.addEventListener("entropic-integration-error", handleIntegrationError as EventListener);
    return () => {
      window.removeEventListener("entropic-integration-updated", handleIntegrationUpdate);
      window.removeEventListener("entropic-integration-error", handleIntegrationError as EventListener);
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

      setSkillScanResults((prev) => {
        const next: Record<string, PluginScanResult> = {};
        for (const skill of list) {
          if (skill.scan) {
            next[skill.id] = skill.scan;
          } else if (prev[skill.id]) {
            next[skill.id] = prev[skill.id];
          }
        }
        return next;
      });
    } catch (err) {
      const message = String(err);
      setSkillsError(message);
      console.error("Failed to load skills:", err);
    } finally {
      setSkillsLoading(false);
    }
  }

  const refreshClawhubCatalog = useCallback(async (
    opts?: { silent?: boolean; force?: boolean; query?: string; sort?: ClawhubSort }
  ) => {
    const query = (opts?.query ?? skillQuery).trim();
    const sort = opts?.sort ?? clawhubSort;
    const requestSeq = ++clawhubRequestSeqRef.current;
    const fetchSort =
      sort === "newest" ? "newest"
      : sort === "downloads" ? "downloads"
      : sort === "installs" ? "installsAllTime"
      : "rating";
    const cacheKey = `${fetchSort}:${query}`;

    // Serve from cache if fresh and not forced
    if (!opts?.force) {
      const cached = clawhubCatalogCache.get(cacheKey);
      if (cached && Date.now() - cached.ts < CLAWHUB_CACHE_TTL_MS) {
        if (requestSeq === clawhubRequestSeqRef.current) {
          setClawhubCatalog(cached.items);
          setVisibleCount(PAGE_SIZE);
        }
        return;
      }
    }

    if (!opts?.silent) setClawhubLoading(true);
    setClawhubLookupError(null);
    try {
      // Fetch enough to fill several pages; ClawHub rate-limits per request so
      // we fetch a reasonable max up front and paginate client-side.
      const list = await invoke<ClawhubCatalogSkill[]>("get_clawhub_catalog", {
        query: query || null,
        limit: 100,
        sort: fetchSort,
      });
      const sorted = [...list].sort((a, b) => {
        if (sort === "newest") return (b.updated_at || 0) - (a.updated_at || 0);
        if (sort === "downloads") return b.downloads - a.downloads;
        if (sort === "installs") return b.installs_all_time - a.installs_all_time;
        return b.stars - a.stars;
      });
      clawhubCatalogCache.set(cacheKey, { items: sorted, ts: Date.now() });
      if (requestSeq === clawhubRequestSeqRef.current) {
        setClawhubCatalog(sorted);
        setVisibleCount(PAGE_SIZE);
      }
    } catch (err) {
      const message = String(err);
      if (requestSeq === clawhubRequestSeqRef.current) {
        setClawhubLookupError(message);
      }
      console.error("Failed to load ClawHub catalog:", err);
    } finally {
      if (requestSeq === clawhubRequestSeqRef.current) {
        setClawhubLoading(false);
      }
    }
  }, [clawhubSort, skillQuery]);

  async function refreshIntegrations(opts?: { force?: boolean }) {
    let cached: Integration[] = [];
    try {
      cached = await getIntegrationsCached(opts);
      if (cached.length > 0) {
        setIntegrations(cached);
      }
    } catch (err) {
      console.warn("Failed to load cached integrations:", err);
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
      setSetupLaunchUrl(null);
      setSetupError(null);
      setSetupVerifying(false);
      return;
    }
    setSetupTimedOut(false);
    const timeout = window.setTimeout(() => setSetupTimedOut(true), 120000);
    return () => window.clearTimeout(timeout);
  }, [setupProvider]);

  useEffect(() => {
    const query = skillQuery;
    const sort = clawhubSort;
    const timer = window.setTimeout(() => {
      refreshClawhubCatalog({ query, sort });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [skillQuery, clawhubSort, refreshClawhubCatalog]);

  // Infinite scroll: when the sentinel div enters the viewport, show more items.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          setVisibleCount((n) => n + PAGE_SIZE);
        }
      },
      { threshold: 0.1 }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [clawhubCatalog.length]);

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
    setSetupLaunchUrl(null);
    setSetupError(null);
    setSetupVerifying(false);
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
    setSetupLaunchUrl(null);
    setSetupError(null);
    try {
      const result = await connectIntegration(provider);
      if (provider === "x") {
        setSetupLaunchUrl(result.oauthUrl || null);
      }
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
      const message = err instanceof Error ? err.message : String(err);
      setSetupError(message);
      setSetupTimedOut(true);
    } finally {
      setConnecting(null);
    }
  }

  async function reopenSetupLaunchUrl() {
    if (!setupLaunchUrl) return;
    try {
      await open(setupLaunchUrl);
      setSetupError(null);
      setSetupTimedOut(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setSetupError(`Couldn't open browser: ${message}`);
      setSetupTimedOut(true);
    }
  }

  async function verifySetupComplete() {
    const provider = setupProvider;
    if (!provider) return;

    setSetupVerifying(true);
    setSetupError(null);
    setSetupTimedOut(false);
    try {
      await refreshIntegrations({ force: true });
      const latest = await getIntegrations({ force: true });
      const entry = latest.find((integration) => integration.provider === provider);
      const connected = Boolean(entry && entry.connected && !entry.stale);

      if (connected) {
        setSetupProvider(null);
        setSetupTimedOut(false);
        setSetupLaunchUrl(null);
        setSetupError(null);
        return;
      }

      setSetupError(
        `${INTEGRATION_NAMES[provider]} is not connected yet. Finish authorization in your browser, then try again.`
      );
      setSetupTimedOut(true);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setSetupError(`Failed to verify connection: ${message}`);
      setSetupTimedOut(true);
    } finally {
      setSetupVerifying(false);
    }
  }

  async function handleDisconnectIntegration(provider: IntegrationProvider) {
    setConnecting(provider);
    setIntegrations((prev) =>
      prev.map((integration) =>
        integration.provider === provider
          ? { ...integration, connected: false, stale: true }
          : integration
      )
    );
    try {
      await disconnectIntegration(provider);
      try {
        await removeIntegrationFromGateway(provider);
      } catch (err) {
        console.warn(`Failed to remove ${provider} from gateway cache:`, err);
      }
    } catch (err) {
      console.error("Failed to disconnect:", err);
    } finally {
      await refreshIntegrations({ force: true });
      setConnecting(null);
    }
  }

  async function scanInstallSkillFromClawhub(slug: string, allowUnsafe: boolean, targetName?: string) {
    const normalizedSlug = slug.trim();
    if (!normalizedSlug) return;

    setClawhubBusy(true);
    setClawhubBusySlug(normalizedSlug);
    setClawhubError(null);
    setPendingUnsafeSlug(null);

    // Open the scan modal immediately so the user sees scanning progress
    setScanIntent("skill-audit");
    setScanTargetName((targetName || normalizedSlug).trim() || normalizedSlug);
    setScanPluginId(null);
    setScanResult(null);
    setScanError(null);
    setIsScanning(true);
    setScanModalOpen(true);

    try {
      const result = await invoke<ClawhubInstallResult>("scan_and_install_clawhub_skill", {
        slug: normalizedSlug,
        allowUnsafe,
      });
      setIsScanning(false);
      setScanResult(result.scan);
      setSkillScanResults((prev) => ({ ...prev, [result.installed_skill_id || normalizedSlug]: result.scan }));
      if (result.blocked && !allowUnsafe) {
        setPendingUnsafeSlug(normalizedSlug);
      } else {
        setPendingUnsafeSlug(null);
      }
      if (result.installed) {
        setJustInstalledSlugs((prev) => new Set(prev).add(normalizedSlug));
        await refreshSkills();
        await refreshClawhubCatalog({ silent: true });
      } else if (result.message) {
        setClawhubError(result.message);
      }
    } catch (err) {
      const msg = String(err);
      setIsScanning(false);
      setClawhubError(msg);
      setScanError(msg);
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
      setJustInstalledSlugs((prev) => {
        const next = new Set(prev);
        next.delete(skillId);
        return next;
      });
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

  async function openClawhubDetails(skill: ClawhubCatalogSkill) {
    const slug = skill.slug;
    setClawhubDetailModalSlug(slug);
    setClawhubDetailModalSkill(skill);
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

  function closeClawhubDetailsModal() {
    setClawhubDetailModalSlug(null);
    setClawhubDetailModalSkill(null);
    setClawhubDetailError(null);
  }

  const pluginsSansManagedSkills = useMemo(
    () => plugins.filter((p) => !MANAGED_SKILL_PLUGIN_IDS.has(p.id)),
    [plugins]
  );
  const visiblePlugins = useMemo(
    () => pluginsSansManagedSkills.filter((p) => !MESSAGING_PLUGIN_IDS.has(p.id) && !HIDDEN_PLUGIN_IDS.has(p.id)),
    [pluginsSansManagedSkills]
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
        id: ENTROPIC_X_SKILL_ID,
        name: "X Research",
        description: "Default Entropic skill for searching posts, reading profiles, and pulling thread context.",
        sourceLabel: "Entropic Default",
        tags: ["x", "search", "default"],
        integrationProvider: "x",
        pluginId: ENTROPIC_X_SKILL_ID,
        connected: xConnected,
        managed: true,
      },
      {
        id: ENTROPIC_QUAI_SKILL_ID,
        name: "Quai Network Builder",
        description: "Default Entropic skill for learning and building on Quai Network.",
        sourceLabel: "Entropic Default",
        tags: ["quai", "qi", "wallets", "contracts", "default"],
        pluginId: ENTROPIC_QUAI_SKILL_ID,
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

  const featuredSkills = useMemo(
    () =>
      Array.from(FEATURED_SLUGS).map(
        (slug) =>
          clawhubCatalog.find((s) => s.slug === slug) ??
          FEATURED_SKILLS_FALLBACK.find((s) => s.slug === slug)!
      ),
    [clawhubCatalog]
  );

  const allBrowseSkills = useMemo(
    () => clawhubCatalog.filter((s) => !FEATURED_SLUGS.has(s.slug)),
    [clawhubCatalog]
  );
  const browseSkills = useMemo(
    () => allBrowseSkills.slice(0, visibleCount),
    [allBrowseSkills, visibleCount]
  );
  const hasMoreBrowseSkills = visibleCount < allBrowseSkills.length;

  const isRateLimited = clawhubCatalog.some((s) => s.is_fallback);
  const activeClawhubSkill = clawhubDetailModalSlug
    ? clawhubCatalog.find((skill) => skill.slug === clawhubDetailModalSlug) ?? clawhubDetailModalSkill
    : clawhubDetailModalSkill;
  const activeClawhubDetails = clawhubDetailModalSlug ? clawhubDetails[clawhubDetailModalSlug] : null;
  const activeClawhubInstalled = clawhubDetailModalSlug ? (installedWorkspaceSkillIds.has(clawhubDetailModalSlug) || justInstalledSlugs.has(clawhubDetailModalSlug)) : false;
  const activeClawhubBusy = !!(clawhubDetailModalSlug && clawhubBusy && clawhubBusySlug === clawhubDetailModalSlug);

  function renderClawhubSkillCard(skill: ClawhubCatalogSkill) {
    const installed = installedWorkspaceSkillIds.has(skill.slug) || justInstalledSlugs.has(skill.slug);

    return (
      <div key={skill.slug} className="group bg-[var(--bg-card)] rounded-xl p-4 shadow-sm border border-[var(--border-subtle)] hover:shadow-md transition-all duration-300 flex flex-col h-full">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <h3 className="font-semibold text-sm text-[var(--text-primary)] leading-tight truncate">{skill.display_name || skill.slug}</h3>
              {skill.stars > 10 && (
                <div className="flex items-center gap-0.5 text-amber-500">
                  <Star className="w-3 h-3 fill-current" />
                  <span className="text-[10px] font-bold">{formatCompactNumber(skill.stars)}</span>
                </div>
              )}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-semibold text-[var(--text-tertiary)] uppercase tracking-wide">v{skill.latest_version || "1.0"}</span>
              <div className="w-1 h-1 rounded-full bg-[var(--border-default)]" />
              <span className="text-[10px] font-medium text-[var(--text-tertiary)] lowercase">{skill.slug}</span>
            </div>
          </div>
          <div className="flex flex-col items-end gap-2">
            <button
              onClick={() => scanInstallSkillFromClawhub(skill.slug, false, skill.display_name || skill.slug)}
              disabled={clawhubBusy || installed}
              className={clsx(
                "px-4 py-1.5 rounded-full text-[11px] font-semibold uppercase tracking-wide inline-flex items-center gap-1.5",
                installed
                  ? "bg-[var(--system-gray-6)] text-[var(--text-tertiary)] cursor-default"
                  : clawhubBusySlug === skill.slug
                    ? "bg-[var(--system-blue)]/80 text-white"
                    : "bg-[var(--system-blue)] text-white shadow-md shadow-blue-500/20 hover:brightness-95"
              )}
            >
              {installed ? (
                "Installed"
              ) : clawhubBusySlug === skill.slug ? (
                <>
                  <Loader2 className="w-3 h-3 animate-spin" />
                  Installing
                </>
              ) : (
                "Install"
              )}
            </button>
            <div className="flex items-center gap-1.5 text-[10px] text-[var(--text-tertiary)] font-medium bg-[var(--system-gray-6)] px-2 py-0.5 rounded-full border border-[var(--border-subtle)]">
              <Download className="w-3 h-3" />
              {formatCompactNumber(skill.downloads)}
            </div>
          </div>
        </div>

        <div className="mb-4 flex-1">
          <p className="text-sm text-[var(--text-secondary)] leading-relaxed line-clamp-3 mb-2">{skill.summary || "No description available."}</p>
        </div>

        <button
          onClick={() => { void openClawhubDetails(skill); }}
          className="w-full py-2 rounded-lg text-xs font-semibold text-[var(--text-secondary)] bg-[var(--system-gray-6)] border border-[var(--border-subtle)] hover:bg-[var(--system-gray-5)] hover:text-[var(--text-primary)] transition-colors flex items-center justify-center gap-2"
        >
          View Details
          <ChevronRight className="w-3.5 h-3.5" />
        </button>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col p-6">
      <div className="mb-4 flex flex-col md:flex-row md:items-center md:justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold" style={{ color: "var(--text-primary)" }}>
            Skills
          </h1>
          <p className="text-sm" style={{ color: "var(--text-tertiary)" }}>
            Enhance your AI with new capabilities.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {integrationsSyncing && (
            <div className="flex items-center gap-2 px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wide bg-[var(--system-blue)]/10 text-[var(--system-blue)]">
              <Loader2 className="w-3 h-3 animate-spin" />
              Syncing
            </div>
          )}
          <div className="relative group">
            <Search className="w-4 h-4 text-[var(--text-tertiary)] absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              value={skillQuery}
              onChange={(e) => setSkillQuery(e.target.value)}
              className="w-full sm:w-[260px] pl-9 pr-3 py-2.5 rounded-lg border border-[var(--border-default)] bg-[var(--bg-card)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--system-blue)]/20"
              placeholder="Search skills..."
            />
          </div>
        </div>
      </div>

      {gatewayRestarting && (
        <div className="mb-3 flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[var(--system-blue)]/10 text-[var(--system-blue)] text-sm font-semibold border border-[var(--system-blue)]/20">
          <Loader2 className="w-4 h-4 animate-spin shrink-0" />
          Gateway is restarting to load the new skill&hellip;
        </div>
      )}
      <div className="flex-1 overflow-auto max-w-6xl w-full mx-auto">
          <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
            {/* Installed Skills */}
            {installedSkillCards.length > 0 && (
              <div className="mb-8">
                <h2 className="text-[13px] font-medium uppercase tracking-wide mb-4 text-[var(--text-secondary)]">My Skills</h2>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                  {installedSkillCards.map((skill) => {
                    const badge = skill.managed
                      ? { label: "Managed", className: "bg-blue-500/10 text-blue-500 border-blue-500/20" }
                      : scanBadge(skillScanResults[skill.id] || null);
                    const icon = skill.pluginId ? PLUGIN_ICONS[skill.pluginId] : null;
                    const integrationEntry = skill.integrationProvider
                      ? integrations.find((entry) => entry.provider === skill.integrationProvider)
                      : null;
                    const integrationConnected = Boolean(
                      skill.integrationProvider &&
                      integrationEntry &&
                      integrationEntry.connected &&
                      !integrationEntry.stale
                    );

                    return (
                      <div key={skill.id} className="bg-[var(--bg-card)] rounded-xl p-4 shadow-sm border border-[var(--border-subtle)] hover:shadow-md transition-all duration-300 flex flex-col">
                        <div className="flex items-start gap-4 mb-4">
                          {icon && (
                              <div className="w-12 h-12 rounded-xl bg-[var(--system-gray-6)] flex items-center justify-center shrink-0 border border-[var(--border-subtle)]">
                              {icon.kind === "component" ? (
                                <icon.component className="w-7 h-7" />
                              ) : (
                                <img src={icon.src} alt={icon.alt} className="w-7 h-7 object-contain" />
                              )}
                            </div>
                          )}
                          <div className="min-w-0 flex-1">
                            <h3 className="font-semibold text-[var(--text-primary)] text-sm truncate">{skill.name}</h3>
                            <div className="flex flex-wrap items-center gap-2 mt-1">
                              <span className={clsx("px-2 py-0.5 rounded-md text-[9px] font-bold uppercase tracking-widest border", badge.className)}>
                                {badge.label}
                              </span>
                            </div>
                          </div>
                        </div>
                        <p className="text-sm text-[var(--text-secondary)] leading-relaxed line-clamp-3 mb-4 flex-1">{skill.description}</p>

                        <div className="flex flex-col gap-2 mt-auto">
                          {!skill.managed && (
                            <button
                              onClick={() => handleAuditSkill(skill)}
                              disabled={isScanning}
                              className="w-full py-2 bg-[var(--bg-muted)] text-[var(--text-secondary)] rounded-xl text-xs font-bold uppercase tracking-widest hover:bg-[var(--bg-tertiary)] transition-colors border border-[var(--border-subtle)] disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              Audit
                            </button>
                          )}
                          {skill.integrationProvider ? (
                            <button
                              onClick={() =>
                                integrationConnected
                                  ? handleDisconnectIntegration(skill.integrationProvider as IntegrationProvider)
                                  : handleConnectIntegration(skill.integrationProvider as IntegrationProvider)
                              }
                              disabled={connecting === skill.integrationProvider}
                              className={clsx(
                                "w-full py-2 rounded-xl text-xs font-bold uppercase tracking-widest transition-all",
                                integrationConnected
                                  ? "bg-green-500/10 text-green-500"
                                  : "bg-blue-600 text-white shadow-lg shadow-blue-500/20"
                              )}
                            >
                              {connecting === skill.integrationProvider
                                ? "..."
                                : integrationConnected
                                  ? "Connected"
                                  : integrationEntry?.connected && integrationEntry.stale
                                    ? "Reconnect"
                                    : "Setup"}
                            </button>
                          ) : skill.workspaceSkillId ? (
                            <button
                              onClick={() => handleRemoveWorkspaceSkill(skill.workspaceSkillId as string)}
                              disabled={removingSkill === skill.workspaceSkillId}
                              className="w-full py-2 bg-red-500/10 text-red-500 rounded-xl text-xs font-bold uppercase tracking-widest hover:bg-red-500/15 transition-colors border border-red-500/20"
                            >
                              Remove
                            </button>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Marketplace */}
            <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] p-4 md:p-6">
              {/* Security Banner */}
              <div className="relative overflow-hidden bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-xl p-5 mb-8 shadow-sm">
                <div className="relative z-10 flex flex-col md:flex-row md:items-center gap-6">
                  <div className="w-12 h-12 rounded-xl bg-[var(--system-blue)] flex items-center justify-center shrink-0">
                    <ShieldCheck className="w-6 h-6 text-white" strokeWidth={2.5} />
                  </div>
                  <div className="flex-1">
                    <h2 className="text-sm font-semibold text-[var(--text-primary)] mb-1">Verified by Cisco AI Defense</h2>
                    <p className="text-sm text-[var(--text-secondary)] leading-snug max-w-2xl">
                      All skills on ClawHub are automatically audited for security and behavioral risks by Cisco's industry-leading scanner.
                    </p>
                  </div>
                  <button
                    onClick={() => open("https://github.com/cisco-ai-defense/skill-scanner")}
                    className="px-4 py-2 bg-[var(--bg-card)] rounded-lg text-xs font-semibold border border-[var(--border-default)] hover:bg-[var(--system-gray-6)] transition-all flex items-center gap-2 shrink-0"
                  >
                    <Info className="w-4 h-4 text-[var(--system-blue)]" />
                    Scanner Specs
                  </button>
                </div>
              </div>

              <div className="mb-10">
                <div className="flex items-center gap-4 mb-4">
                  <h2 className="text-[13px] font-medium uppercase tracking-wide text-[var(--text-secondary)]">Featured Skills</h2>
                  <div className="px-2.5 py-0.5 bg-amber-500/10 text-amber-500 rounded-full text-[10px] font-bold uppercase tracking-widest border border-amber-500/20">Editor's Choice</div>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {featuredSkills.map((skill) => renderClawhubSkillCard(skill))}
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-[13px] font-medium uppercase tracking-wide text-[var(--text-secondary)]">Explore ClawHub</h2>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold text-[var(--text-tertiary)] uppercase tracking-wide">Sort:</span>
                    <select
                      value={clawhubSort}
                      onChange={(e) => setClawhubSort(e.target.value as ClawhubSort)}
                      className="bg-transparent border-none text-xs font-semibold text-[var(--system-blue)] focus:ring-0 cursor-pointer"
                    >
                      <option value="stars">Most Stars</option>
                      <option value="downloads">Most Popular</option>
                      <option value="installs">Trending</option>
                      <option value="newest">Newest</option>
                    </select>
                  </div>
                </div>

                {clawhubLoading ? (
                  <div className="py-24 flex flex-col items-center gap-4">
                    <Loader2 className="w-8 h-8 animate-spin text-[var(--system-blue)]" />
                    <p className="text-[var(--text-tertiary)] font-semibold uppercase tracking-wide text-[10px]">Loading catalog...</p>
                  </div>
                ) : clawhubLookupError ? (
                  <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-8 text-center text-red-500">
                    <p className="font-semibold">{clawhubLookupError}</p>
                  </div>
                ) : (
                  <>
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                      {browseSkills.map((skill) => renderClawhubSkillCard(skill))}
                    </div>
                    {hasMoreBrowseSkills && (
                      <div ref={sentinelRef} className="py-8 flex justify-center">
                        <Loader2 className="w-5 h-5 animate-spin text-[var(--text-tertiary)]" />
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
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
                  const pendingSkillName = clawhubCatalog.find((skill) => skill.slug === pendingUnsafeSlug)?.display_name || pendingUnsafeSlug;
                  void scanInstallSkillFromClawhub(pendingUnsafeSlug, true, pendingSkillName);
                }
              : undefined
        }
        confirmLabel={scanIntent === "plugin-enable" ? "Enable Plugin" : "Install Skill"}
        confirmAnywayLabel={scanIntent === "plugin-enable" ? "Enable Anyway" : "Install Anyway"}
      />

      {clawhubDetailModalSlug && (
        <div
          className="fixed inset-0 z-50 bg-black/30 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={closeClawhubDetailsModal}
          onKeyDown={(e) => { if (e.key === "Escape") closeClawhubDetailsModal(); }}
        >
          <div
            className="w-full max-w-4xl max-h-[88vh] overflow-y-auto rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-card)] shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="sticky top-0 z-10 bg-[var(--glass-bg-hover)] backdrop-blur border-b border-[var(--border-subtle)] px-6 py-4 flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="text-xs uppercase tracking-wide font-semibold text-[var(--text-tertiary)] mb-1">ClawHub Skill</p>
                <h2 className="text-xl font-semibold text-[var(--text-primary)] truncate">
                  {activeClawhubSkill?.display_name || clawhubDetailModalSlug}
                </h2>
                <div className="flex items-center gap-2 mt-1 text-xs text-[var(--text-tertiary)]">
                  <span className="font-medium">Slug:</span>
                  <span>{clawhubDetailModalSlug}</span>
                  <span>•</span>
                  <span>v{activeClawhubDetails?.latest_version || activeClawhubSkill?.latest_version || "1.0"}</span>
                </div>
              </div>
              <button
                onClick={closeClawhubDetailsModal}
                className="p-2 rounded-lg text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--system-gray-6)]"
                aria-label="Close details"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="px-6 py-5 space-y-5">
              {clawhubDetailLoading === clawhubDetailModalSlug ? (
                <div className="py-16 flex flex-col items-center gap-3">
                  <Loader2 className="w-7 h-7 animate-spin text-[var(--system-blue)]" />
                  <p className="text-sm text-[var(--text-secondary)]">Loading skill details...</p>
                </div>
              ) : (
                <>
                  <p className="text-sm leading-relaxed text-[var(--text-secondary)]">
                    {activeClawhubDetails?.summary || activeClawhubSkill?.summary || "No summary available for this skill."}
                  </p>

                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                    <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-secondary)] p-3">
                      <p className="text-[11px] uppercase font-semibold tracking-wide text-[var(--text-tertiary)] mb-1">Developer</p>
                      <p className="text-sm text-[var(--text-primary)]">
                        {activeClawhubDetails?.owner_display_name || activeClawhubDetails?.owner_handle || "OpenClaw"}
                      </p>
                    </div>
                    <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-secondary)] p-3">
                      <p className="text-[11px] uppercase font-semibold tracking-wide text-[var(--text-tertiary)] mb-1">Stars</p>
                      <p className="text-sm text-[var(--text-primary)] flex items-center gap-1.5">
                        <Star className="w-3.5 h-3.5 text-amber-500 fill-current" />
                        {formatCompactNumber(activeClawhubDetails?.stars ?? activeClawhubSkill?.stars ?? 0)}
                      </p>
                    </div>
                    <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-secondary)] p-3">
                      <p className="text-[11px] uppercase font-semibold tracking-wide text-[var(--text-tertiary)] mb-1">Downloads</p>
                      <p className="text-sm text-[var(--text-primary)] flex items-center gap-1.5">
                        <Download className="w-3.5 h-3.5 text-[var(--text-tertiary)]" />
                        {formatCompactNumber(activeClawhubDetails?.downloads ?? activeClawhubSkill?.downloads ?? 0)}
                      </p>
                    </div>
                    <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-secondary)] p-3">
                      <p className="text-[11px] uppercase font-semibold tracking-wide text-[var(--text-tertiary)] mb-1">Total Installs</p>
                      <p className="text-sm text-[var(--text-primary)]">
                        {formatCompactNumber(activeClawhubDetails?.installs_all_time ?? activeClawhubSkill?.installs_all_time ?? 0)}
                      </p>
                    </div>
                  </div>

                  {clawhubDetailError && (
                    <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2.5 text-sm text-red-500">
                      {clawhubDetailError}
                    </div>
                  )}

                  <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--system-gray-6)]/40 p-4">
                    <div className="flex items-center justify-between gap-3 mb-2">
                      <p className="text-[11px] uppercase font-semibold tracking-wide text-[var(--text-tertiary)]">What&apos;s New</p>
                      <a
                        href={`https://clawhub.org/skills/${clawhubDetailModalSlug}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 text-xs font-semibold text-[var(--system-blue)] hover:underline"
                      >
                        Open on ClawHub
                        <ExternalLink className="w-3.5 h-3.5" />
                      </a>
                    </div>
                    <p className="text-sm leading-relaxed whitespace-pre-wrap text-[var(--text-secondary)]">
                      {activeClawhubDetails?.changelog || "No changelog provided for this version."}
                    </p>
                  </div>
                </>
              )}
            </div>

            <div className="sticky bottom-0 z-10 border-t border-[var(--border-subtle)] bg-[var(--glass-bg-hover)] backdrop-blur px-6 py-4 flex items-center justify-end gap-3">
              <button
                onClick={closeClawhubDetailsModal}
                className="btn btn-secondary"
              >
                Close
              </button>
              <button
                onClick={() => {
                  if (!activeClawhubSkill) return;
                  closeClawhubDetailsModal();
                  void scanInstallSkillFromClawhub(
                    activeClawhubSkill.slug,
                    false,
                    activeClawhubSkill.display_name || activeClawhubSkill.slug,
                  );
                }}
                disabled={activeClawhubInstalled || activeClawhubBusy || !activeClawhubSkill}
                className={clsx(
                  "btn btn-primary inline-flex items-center gap-2",
                  activeClawhubInstalled && "opacity-70 cursor-default"
                )}
              >
                {activeClawhubBusy ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Installing...
                  </>
                ) : activeClawhubInstalled ? (
                  "Installed"
                ) : (
                  "Security Scan + Install"
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {setupProvider && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-900/40 backdrop-blur-sm"
          onKeyDown={(e) => { if (e.key === "Escape" && !setupVerifying) { setSetupProvider(null); setSetupStage("authorizing"); } }}>
          <div className="w-full max-w-sm rounded-[32px] bg-[var(--bg-card)] p-8 shadow-2xl border border-[var(--border-subtle)] animate-in zoom-in-95 duration-200">
            <div className="flex flex-col items-center text-center">
              <div className="w-16 h-16 rounded-3xl bg-blue-500/10 flex items-center justify-center mb-6">
                <Loader2 className="w-8 h-8 animate-spin text-blue-500" />
              </div>
              <h2 className="text-xl font-bold text-[var(--text-primary)] mb-2">
                Setting up {INTEGRATION_NAMES[setupProvider]}
              </h2>
              <p className="text-sm text-[var(--text-secondary)] font-medium leading-relaxed mb-3">
                {setupStage === "authorizing"
                  ? "Finish authorization in your browser. We'll update Entropic as soon as it's complete."
                  : "Syncing your credentials with Entropic..."}
              </p>
              {setupTimedOut && !setupError && (
                <p className="text-xs text-amber-500 bg-amber-500/10 border border-amber-500/20 rounded-xl px-3 py-2 mb-3 w-full">
                  This is taking longer than expected. If your browser didn&apos;t open, use the buttons below to open or copy the link manually.
                </p>
              )}
              {setupError && (() => {
                const isAuthError = isAuthConfigured && !isAuthenticated ||
                  /not authenticated|session expired|unauthorized/i.test(setupError);
                return isAuthError ? (
                  <div className="w-full mb-3 bg-amber-500/10 border border-amber-500/20 rounded-xl px-4 py-3 text-left">
                    <p className="text-xs font-semibold text-[var(--text-primary)] mb-1">Sign in required</p>
                    <p className="text-xs text-[var(--text-secondary)] mb-3 leading-relaxed">
                      You need an Entropic account to connect X (Twitter). Sign in or create a free account to continue.
                    </p>
                    <button
                      className="w-full py-2 bg-amber-600 text-white rounded-xl text-[12px] font-bold hover:bg-amber-700 transition-colors"
                      onClick={() => {
                        setSetupProvider(null);
                        setSetupError(null);
                        setSetupTimedOut(false);
                        window.dispatchEvent(new CustomEvent("entropic-open-page", { detail: { page: "billing" } }));
                      }}
                    >
                      Go to Billing &amp; Sign In
                    </button>
                  </div>
                ) : (
                  <p className="text-xs text-red-500 bg-red-500/10 border border-red-500/20 rounded-xl px-3 py-2 mb-3 w-full">
                    {setupError}
                  </p>
                );
              })()}
              {setupProvider === "x" && setupLaunchUrl && (
                <div className="w-full mb-3 flex flex-col gap-2">
                  <button
                    className="w-full py-2.5 bg-blue-600 text-white rounded-2xl text-[13px] font-bold hover:bg-blue-700 transition-colors flex items-center justify-center gap-2"
                    onClick={() => { void reopenSetupLaunchUrl(); }}
                    disabled={setupVerifying}
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                    Open in Browser
                  </button>
                  <button
                    className="w-full py-2 bg-[var(--bg-muted)] border border-[var(--border-default)] text-[var(--text-secondary)] rounded-2xl text-[12px] font-medium hover:bg-[var(--bg-tertiary)] transition-colors px-3"
                    title={setupLaunchUrl}
                    onClick={() => {
                      void navigator.clipboard.writeText(setupLaunchUrl).then(() => {
                        setSetupUrlCopied(true);
                        setTimeout(() => setSetupUrlCopied(false), 2000);
                      });
                    }}
                  >
                    {setupUrlCopied ? "Copied!" : "Copy link to open manually"}
                  </button>
                </div>
              )}
              {setupProvider === "x" && !setupLaunchUrl && (setupTimedOut || setupError) && (
                <button
                  className="w-full py-2.5 mb-3 bg-blue-600 text-white rounded-2xl text-[13px] font-bold hover:bg-blue-700 transition-colors flex items-center justify-center gap-2"
                  onClick={() => { void handleConnectIntegration("x"); }}
                  disabled={!!connecting || setupVerifying}
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  {connecting === "x" ? "Opening..." : "Try Again"}
                </button>
              )}
              <button
                className="w-full py-2.5 mb-3 bg-[var(--bg-card)] border border-[var(--border-default)] text-[var(--text-primary)] rounded-2xl text-[13px] font-bold hover:bg-[var(--bg-muted)] transition-colors"
                onClick={() => {
                  void verifySetupComplete();
                }}
                disabled={setupVerifying}
              >
                {setupVerifying ? "Checking..." : "I've Completed Setup"}
              </button>
              <button
                className="w-full py-3 bg-[var(--bg-tertiary)] text-[var(--text-primary)] rounded-2xl text-[14px] font-bold hover:bg-[var(--bg-secondary)] transition-colors"
                onClick={() => {
                  setSetupProvider(null);
                  setSetupTimedOut(false);
                  setSetupLaunchUrl(null);
                  setSetupError(null);
                  setSetupVerifying(false);
                  setSetupUrlCopied(false);
                }}
                disabled={setupVerifying}
              >
                Continue in Background
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
