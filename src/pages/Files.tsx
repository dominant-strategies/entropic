import {
  useState,
  useEffect,
  useCallback,
  useRef,
  lazy,
  Suspense,
  type ReactNode,
  type ClipboardEvent as ReactClipboardEvent,
  type MouseEvent as ReactMouseEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-shell";
import { Store } from "@tauri-apps/plugin-store";
import {
  Folder,
  FileText,
  FileImage,
  FileCode,
  FileJson,
  File,
  ChevronLeft,
  ChevronRight,
  LayoutGrid,
  List,
  Trash2,
  Eye,
  Plus,
  X,
  ArrowUp,
  MessageSquare,
  Loader2,
  Image,
  Puzzle,
  Sparkles,
  Globe,
  Radio,
  ScrollText,
  Settings as SettingsIcon,
  CalendarClock,
  ListTodo,
  CreditCard,
  Terminal,
  MoreHorizontal,
  Pin,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import { loadOnboardingData } from "../lib/profile";
import { WALLPAPERS, DEFAULT_WALLPAPER_ID, getWallpaperById } from "../lib/wallpapers";
const PluginStore = lazy(() => import("./Store").then((m) => ({ default: m.Store })));
const SkillsStore = lazy(() => import("./Store").then((m) => ({ default: m.Store })));
const Channels = lazy(() => import("./Channels").then((m) => ({ default: m.Channels })));
const Logs = lazy(() => import("./Logs").then((m) => ({ default: m.Logs })));
const Settings = lazy(() => import("./Settings").then((m) => ({ default: m.Settings })));
const Tasks = lazy(() => import("./Tasks").then((m) => ({ default: m.Tasks })));
const Jobs = lazy(() => import("./Jobs").then((m) => ({ default: m.Jobs })));
const BillingPage = lazy(() => import("./BillingPage").then((m) => ({ default: m.BillingPage })));
import {
  Chat,
  type ChatSession as SharedChatSession,
  type ChatSessionActionRequest,
} from "./Chat";
import { ModelSelector } from "../components/ModelSelector";
import { useAuth } from "../contexts/AuthContext";
import {
  goEmbeddedPreviewBack,
  goEmbeddedPreviewForward,
  hideEmbeddedPreviewWebview,
  isTrustedLocalPreviewUrl,
  reloadEmbeddedPreview,
  syncEmbeddedPreviewWebview,
} from "../lib/nativePreview";

type WorkspaceFileEntry = {
  name: string;
  path: string;
  is_directory: boolean;
  size: number;
  modified_at: number;
};

type Props = {
  gatewayRunning: boolean;
  gatewayRetryIn?: number | null;
  integrationsSyncing?: boolean;
  integrationsMissing?: boolean;
  onGatewayToggle: () => void;
  onRecoverProxyAuth?: () => Promise<boolean> | boolean;
  isTogglingGateway: boolean;
  experimentalDesktop: boolean;
  onExperimentalDesktopChange: (value: boolean) => void;
  selectedModel: string;
  onModelChange: (model: string) => void;
  useLocalKeys: boolean;
  onUseLocalKeysChange: (value: boolean) => void;
  codeModel: string;
  imageModel: string;
  onCodeModelChange: (model: string) => void;
  onImageModelChange: (model: string) => void;
};
type ViewMode = "grid" | "list";
type DesktopIcon = { id: string; x: number; y: number };
type BrowserSnapshot = {
  session_id: string;
  url: string;
  title: string;
  live_ws_url?: string | null;
  remote_desktop_url?: string | null;
  text: string;
  screenshot_base64: string;
  screenshot_width: number;
  screenshot_height: number;
  interactive_elements: Array<{
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
    label: string;
    tag: string;
    href?: string | null;
  }>;
  can_go_back: boolean;
  can_go_forward: boolean;
};

type BrowserLiveState = {
  session_id: string;
  url: string;
  title: string;
  live_ws_url?: string | null;
  remote_desktop_url?: string | null;
  viewport_width: number;
  viewport_height: number;
  can_go_back: boolean;
  can_go_forward: boolean;
};

type EmbeddedPreviewState = {
  url: string;
  title: string | null;
};

type BrowserTabState = {
  id: string;
  title: string | null;
  urlInput: string;
  sessionId: string | null;
  embeddedPreview: EmbeddedPreviewState | null;
  snapshot: BrowserSnapshot | null;
  liveState: BrowserLiveState | null;
  liveError: string | null;
  loading: boolean;
};

type PersistedBrowserTab = {
  id: string;
  title: string | null;
  urlInput: string;
  sessionId: string | null;
  embeddedPreviewUrl: string | null;
  embeddedPreviewTitle: string | null;
};

type DesktopTerminalStatus = "disconnected" | "ready" | "exited" | "error";

type DesktopTerminalSnapshot = {
  session_id: string;
  output: string;
  status: Exclude<DesktopTerminalStatus, "disconnected">;
  exit_code: number | null;
  container_name: string;
  workspace_path: string;
};

type DesktopTerminalEventPayload = {
  session_id: string;
  chunk: string;
  stream: "stdout" | "stderr" | "system";
  status: Exclude<DesktopTerminalStatus, "disconnected">;
  exit_code: number | null;
};

const DEFAULT_WINDOW_Z: Record<string, number> = {
  finder: 60,
  chat: 61,
  browser: 62,
  terminal: 63,
  plugins: 64,
  skills: 65,
  channels: 66,
  tasks: 67,
  jobs: 68,
  logs: 69,
  billing: 70,
  settings: 71,
  preview: 80,
};

const HIDDEN_FILES = new Set(["HEARTBEAT.md", "IDENTITY.md", "SOUL.md", "TOOLS.md", "AGENTS.md", "USER.md"]);
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"]);
const BINARY_EXTS = new Set(["pdf", "zip", "xlsx", "xls", "docx", "pptx"]);
const HTML_EXTS = new Set(["html", "htm"]);
const DESKTOP_HANDOFF_STORAGE_KEY = "entropic.desktop.handoff";
const DESKTOP_SESSION_STORAGE_KEY = "entropic.desktop.session.v1";
const DEFAULT_DESKTOP_CHAT_TITLE = "New chat";
const CHAT_WORKSPACE_PREFIXES = [
  "/data/.openclaw/workspace",
  "/data/workspace",
  "/home/node/.openclaw/workspace",
];
const CHAT_WORKSPACE_PATH_RE = /((?:\/data\/(?:\.openclaw\/)?workspace|\/home\/node\/\.openclaw\/workspace)(?:\/[^\s`"'<>]+)?)/g;
const DEFAULT_BROWSER_URL = "https://clawhub.ai/skills";
const DEFAULT_BROWSER_LIVE_WS_BASE = "ws://127.0.0.1:19792/live";
const CONTAINER_LOCAL_BROWSER_BASE = "http://container.localhost:19791";
const WORKSPACE_FOLDER_REFRESH_MS = 1500;
const BROWSER_DETAILS_PANEL_HEIGHT = 0;
const BROWSER_APP_WINDOW_TITLEBAR_HEIGHT = 34;
const BROWSER_TOOLBAR_HEIGHT = 49;
const LOCAL_BROWSER_INPUT_RE = /^(?:container\.localhost|runtime\.localhost|localhost|127\.0\.0\.1)(?::\d+)?(?:[/?#].*)?$/i;
const BROWSER_DESKTOP_MIN_VIEWPORT_WIDTH = 1180;
const BROWSER_DESKTOP_MIN_VIEWPORT_HEIGHT = 760;
const BROWSER_DESKTOP_VIEWPORT_SCALE = 1.08;
const DESKTOP_TERMINAL_EVENT = "desktop-terminal-output";
const PANEL_FALLBACK = (
  <div className="p-4 text-xs text-[var(--text-tertiary)]">Loading…</div>
);

type PreviewState =
  | { kind: "text"; name: string; content: string }
  | { kind: "image"; name: string; dataUrl: string }
  | { kind: "binary"; name: string; size: number };

type WindowResizeDirection = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
type WindowResizeState = { sx: number; sy: number; ox: number; oy: number; ow: number; oh: number };
type ChatWorkspaceReference = {
  key: string;
  path: string;
  name: string;
  isHtml: boolean;
  looksLikeFile: boolean;
};
type DesktopHandoff = {
  path?: string;
  url?: string;
  action: "open" | "preview" | "browser";
  looksLikeFile?: boolean;
};
type WindowPoint = { x: number; y: number };
type WindowSize = { w: number; h: number };
type DesktopSessionState = {
  finderOpen: boolean;
  chatOpen: boolean;
  chatNavCollapsed: boolean;
  browserOpen: boolean;
  terminalOpen: boolean;
  pluginsOpen: boolean;
  skillsOpen: boolean;
  channelsOpen: boolean;
  tasksOpen: boolean;
  jobsOpen: boolean;
  logsOpen: boolean;
  billingOpen: boolean;
  settingsOpen: boolean;
  finderPos: WindowPoint;
  finderSize: WindowSize;
  chatPos: WindowPoint;
  chatSize: WindowSize;
  browserPos: WindowPoint;
  browserSize: WindowSize;
  terminalPos: WindowPoint;
  terminalSize: WindowSize;
  pluginsPos: WindowPoint;
  skillsPos: WindowPoint;
  channelsPos: WindowPoint;
  tasksPos: WindowPoint;
  jobsPos: WindowPoint;
  logsPos: WindowPoint;
  billingPos: WindowPoint;
  settingsPos: WindowPoint;
  windowZ: Record<string, number>;
  zCounter: number;
  currentPath: string;
  history: string[];
  historyIndex: number;
  viewMode: ViewMode;
  selected: string | null;
  browserUrlInput: string;
  browserSessionId: string | null;
  browserEmbeddedPreviewUrl: string | null;
  browserEmbeddedPreviewTitle: string | null;
  browserTabs: PersistedBrowserTab[];
  activeBrowserTabId: string | null;
  terminalSessionId: string | null;
  terminalInput: string;
  desktopIcons: Record<string, DesktopIcon>;
};

function makeBrowserTabId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `browser-tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function createBrowserTabState(overrides: Partial<BrowserTabState> = {}): BrowserTabState {
  return {
    id: overrides.id ?? makeBrowserTabId(),
    title: overrides.title ?? null,
    urlInput: overrides.urlInput ?? DEFAULT_BROWSER_URL,
    sessionId: overrides.sessionId ?? null,
    embeddedPreview: overrides.embeddedPreview ?? null,
    snapshot: overrides.snapshot ?? null,
    liveState: overrides.liveState ?? null,
    liveError: overrides.liveError ?? null,
    loading: overrides.loading ?? false,
  };
}

function persistBrowserTabState(tab: BrowserTabState): PersistedBrowserTab {
  return {
    id: tab.id,
    title: tab.title ?? null,
    urlInput: tab.urlInput,
    sessionId: tab.sessionId,
    embeddedPreviewUrl: tab.embeddedPreview?.url ?? null,
    embeddedPreviewTitle: tab.embeddedPreview?.title ?? null,
  };
}

function restoreBrowserTabState(tab: PersistedBrowserTab): BrowserTabState {
  return createBrowserTabState({
    id: tab.id,
    title: tab.title ?? null,
    urlInput: tab.urlInput || DEFAULT_BROWSER_URL,
    sessionId: tab.sessionId ?? null,
    embeddedPreview: tab.embeddedPreviewUrl
      ? {
          url: tab.embeddedPreviewUrl,
          title: tab.embeddedPreviewTitle ?? null,
        }
      : null,
  });
}

// ── Helpers ──────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asWindowPoint(value: unknown): WindowPoint | null {
  if (!isRecord(value)) return null;
  const x = Number(value.x);
  const y = Number(value.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

function asWindowSize(value: unknown): WindowSize | null {
  if (!isRecord(value)) return null;
  const w = Number(value.w);
  const h = Number(value.h);
  if (!Number.isFinite(w) || !Number.isFinite(h)) return null;
  return { w, h };
}

function desktopChatSessionTitle(session: SharedChatSession): string {
  return session.label || session.derivedTitle || session.displayName || DEFAULT_DESKTOP_CHAT_TITLE;
}

function sortDesktopChatSessions(list: SharedChatSession[]): SharedChatSession[] {
  return [...list].sort((a, b) => {
    const aPinned = a.pinned ? 1 : 0;
    const bPinned = b.pinned ? 1 : 0;
    if (aPinned !== bPinned) return bPinned - aPinned;
    const aUpdated = typeof a.updatedAt === "number" ? a.updatedAt : 0;
    const bUpdated = typeof b.updatedAt === "number" ? b.updatedAt : 0;
    return bUpdated - aUpdated;
  });
}

function clampWindowFrame(
  bounds: { width: number; height: number },
  position: WindowPoint,
  size: WindowSize,
  minSize: WindowSize,
): { position: WindowPoint; size: WindowSize } {
  const maxWidth = Math.max(minSize.w, Math.floor(bounds.width - 12));
  const maxHeight = Math.max(minSize.h, Math.floor(bounds.height - 12));
  const nextSize = {
    w: Math.min(Math.max(size.w, minSize.w), maxWidth),
    h: Math.min(Math.max(size.h, minSize.h), maxHeight),
  };
  const maxX = Math.max(0, Math.floor(bounds.width - nextSize.w));
  const maxY = Math.max(0, Math.floor(bounds.height - nextSize.h));
  return {
    position: {
      x: Math.min(Math.max(0, position.x), maxX),
      y: Math.min(Math.max(0, position.y), maxY),
    },
    size: nextSize,
  };
}

function workspaceEntriesEqual(a: WorkspaceFileEntry[], b: WorkspaceFileEntry[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i];
    const right = b[i];
    if (
      left.name !== right.name
      || left.path !== right.path
      || left.is_directory !== right.is_directory
      || left.size !== right.size
      || left.modified_at !== right.modified_at
    ) {
      return false;
    }
  }
  return true;
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const next = value.filter((entry): entry is string => typeof entry === "string");
  return next.length > 0 ? next : [""];
}

function asWindowZ(value: unknown): Record<string, number> | null {
  if (!isRecord(value)) return null;
  const next: Record<string, number> = {};
  for (const [key, rawValue] of Object.entries(value)) {
    const numeric = Number(rawValue);
    if (Number.isFinite(numeric)) {
      next[key] = numeric;
    }
  }
  return Object.keys(next).length > 0 ? next : null;
}

function asDesktopIcons(value: unknown): Record<string, DesktopIcon> | null {
  if (!isRecord(value)) return null;
  const next: Record<string, DesktopIcon> = {};
  for (const [key, rawValue] of Object.entries(value)) {
    const point = asWindowPoint(rawValue);
    if (!point) continue;
    next[key] = { id: key, x: point.x, y: point.y };
  }
  return Object.keys(next).length > 0 ? next : null;
}

function formatSize(bytes: number): string {
  if (bytes === 0) return "Zero bytes";
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatDate(epochSec: number): string {
  if (!epochSec) return "\u2014";
  const d = new Date(epochSec * 1000);
  const now = new Date();
  if (d.toDateString() === now.toDateString())
    return `Today at ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString())
    return `Yesterday at ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
  return d.toLocaleDateString(undefined, {
    month: "short", day: "numeric",
    year: d.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
    hour: "numeric", minute: "2-digit",
  });
}

function getFileIcon(name: string, isDir: boolean) {
  if (isDir) return Folder;
  const ext = name.split(".").pop()?.toLowerCase() || "";
  if (["png","jpg","jpeg","gif","svg","webp","ico","bmp"].includes(ext)) return FileImage;
  if (["js","ts","jsx","tsx","py","rs","go","c","cpp","h","rb","sh","bash","zsh","css","html","xml"].includes(ext)) return FileCode;
  if (["json","yaml","yml","toml"].includes(ext)) return FileJson;
  if (["md","txt","log","csv","rtf"].includes(ext)) return FileText;
  return File;
}

function getFileColor(name: string, isDir: boolean): string {
  if (isDir) return "#54a3f7";
  const ext = name.split(".").pop()?.toLowerCase() || "";
  if (["png","jpg","jpeg","gif","svg","webp"].includes(ext)) return "#e879a8";
  if (["js","ts","jsx","tsx"].includes(ext)) return "#f0c94d";
  if (["py"].includes(ext)) return "#5b9bd5";
  if (["json","yaml","yml","toml"].includes(ext)) return "#a78bfa";
  if (["md","txt"].includes(ext)) return "#8c8c8c";
  return "#8c8c8c";
}

function normalizeBrowserUrl(raw: string): string {
  const value = raw.trim();
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  if (LOCAL_BROWSER_INPUT_RE.test(value)) return `http://${value}`;
  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(value)) return value;
  return `https://${value}`;
}

function presentBrowserUrl(raw: string): string {
  if (!raw) return raw;
  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.toLowerCase();
    const proxiedPortMatch = host.match(/^p(\d+)\.localhost$/i);
    if (proxiedPortMatch && parsed.port === "19792") {
      parsed.hostname = "container.localhost";
      parsed.port = proxiedPortMatch[1] || "";
      return parsed.toString();
    }
    if ((host === "127.0.0.1" || host === "localhost") && parsed.port === "19792") {
      if (parsed.pathname === "/__workspace__/" || parsed.pathname.startsWith("/__workspace__/")) {
        parsed.hostname = "container.localhost";
        parsed.port = "19791";
        return parsed.toString();
      }
    }
    if (host === "127.0.0.1" || host === "localhost") {
      parsed.hostname = "container.localhost";
      return parsed.toString();
    }
    return raw;
  } catch {
    return raw;
  }
}

function requestedBrowserViewportSize(width: number, height: number) {
  return {
    width: Math.max(
      BROWSER_DESKTOP_MIN_VIEWPORT_WIDTH,
      Math.round(Math.max(320, width) * BROWSER_DESKTOP_VIEWPORT_SCALE),
    ),
    height: Math.max(
      BROWSER_DESKTOP_MIN_VIEWPORT_HEIGHT,
      Math.round(Math.max(240, height) * BROWSER_DESKTOP_VIEWPORT_SCALE),
    ),
  };
}

function workspaceBrowserUrl(path: string): string {
  const normalized = path
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");
  return normalized
    ? `${CONTAINER_LOCAL_BROWSER_BASE}/__workspace__/${normalized}`
    : `${CONTAINER_LOCAL_BROWSER_BASE}/__workspace__/`;
}

function trimChatWorkspaceToken(raw: string): string {
  return raw
    .replace(/^[("'`\[]+/, "")
    .replace(/[)"'`\],:;.!?]+$/, "");
}

function normalizeChatWorkspacePath(raw: string): string | null {
  const trimmed = trimChatWorkspaceToken(raw.trim());
  for (const prefix of CHAT_WORKSPACE_PREFIXES) {
    if (trimmed === prefix) {
      return "";
    }
    if (trimmed.startsWith(`${prefix}/`)) {
      return trimmed.slice(prefix.length + 1);
    }
  }
  return null;
}

function workspacePathName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] || "Workspace";
}

function workspacePathParent(path: string): string {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

function extractChatWorkspaceReferences(content: string): ChatWorkspaceReference[] {
  const refs: ChatWorkspaceReference[] = [];
  const seen = new Set<string>();

  for (const match of content.matchAll(CHAT_WORKSPACE_PATH_RE)) {
    const path = normalizeChatWorkspacePath(match[1] || "");
    if (path === null) continue;
    const name = workspacePathName(path);
    const ext = name.split(".").pop()?.toLowerCase() || "";
    const ref: ChatWorkspaceReference = {
      key: path || "__workspace__",
      path,
      name,
      isHtml: HTML_EXTS.has(ext),
      looksLikeFile: Boolean(path) && name.includes("."),
    };
    if (seen.has(ref.key)) continue;
    seen.add(ref.key);
    refs.push(ref);
  }

  return refs;
}

function FolderIcon({ size = 64, selected = false }: { size?: number; selected?: boolean }) {
  return (
    <svg viewBox="0 0 64 52" width={size} height={size * (52 / 64)} fill="none">
      <path d="M2 8C2 5.79 3.79 4 6 4H22L28 10H58C60.21 10 62 11.79 62 14V46C62 48.21 60.21 50 58 50H6C3.79 50 2 48.21 2 46V8Z" fill={selected ? "#4d94f7" : "#54a3f7"} />
      <path d="M2 14H62V46C62 48.21 60.21 50 58 50H6C3.79 50 2 48.21 2 46V14Z" fill={selected ? "#6ab0ff" : "#7ab8f5"} />
    </svg>
  );
}

function AppWindow({
  title,
  icon: Icon,
  position,
  size,
  onClose,
  onDragStart,
  onResizeStart,
  onFocus,
  zIndex,
  glass = true,
  children,
}: {
  title: string;
  icon: typeof Folder;
  position: { x: number; y: number };
  size: { w: number; h: number };
  onClose: () => void;
  onDragStart: (e: ReactMouseEvent<HTMLDivElement>) => void;
  onResizeStart?: (direction: WindowResizeDirection, e: ReactMouseEvent<HTMLDivElement>) => void;
  onFocus: () => void;
  zIndex: number;
  glass?: boolean;
  children: ReactNode;
}) {
  const resizeHandles: Array<{
    direction: WindowResizeDirection;
    className: string;
  }> = [
    { direction: "n", className: "absolute left-4 right-4 top-0 z-20 h-3 cursor-ns-resize" },
    { direction: "s", className: "absolute bottom-0 left-4 right-4 z-20 h-3 cursor-ns-resize" },
    { direction: "e", className: "absolute right-0 top-4 bottom-4 z-20 w-3 cursor-ew-resize" },
    { direction: "w", className: "absolute left-0 top-4 bottom-4 z-20 w-3 cursor-ew-resize" },
    { direction: "nw", className: "absolute left-0 top-0 z-20 h-4 w-4 cursor-nwse-resize" },
    { direction: "ne", className: "absolute right-0 top-0 z-20 h-4 w-4 cursor-nesw-resize" },
    { direction: "se", className: "absolute bottom-0 right-0 z-20 h-4 w-4 cursor-nwse-resize" },
    { direction: "sw", className: "absolute bottom-0 left-0 z-20 h-4 w-4 cursor-nesw-resize" },
  ];

  return (
    <div
      className="absolute flex flex-col rounded-xl overflow-hidden animate-scale-in"
      style={{
        top: position.y,
        left: position.x,
        width: size.w,
        height: size.h,
        zIndex,
        background: glass ? "rgba(248,248,248,0.92)" : "#f6f1e8",
        backdropFilter: glass ? "blur(18px)" : "none",
        WebkitBackdropFilter: glass ? "blur(18px)" : "none",
        boxShadow: "0 24px 70px rgba(0,0,0,0.28), 0 0 0 0.5px rgba(255,255,255,0.6)",
        border: "1px solid rgba(255,255,255,0.65)",
      }}
      onMouseDownCapture={onFocus}
      onClick={(e) => e.stopPropagation()}
    >
      <div
        className="flex items-center px-3 py-2 flex-shrink-0 relative cursor-grab active:cursor-grabbing"
        style={{
          background: glass ? "rgba(255,255,255,0.9)" : "#f9f4ec",
          borderBottom: "1px solid rgba(0,0,0,0.08)",
        }}
        onMouseDown={onDragStart}
      >
        <div className="flex items-center gap-2 z-10">
          <button
            onClick={onClose}
            className="w-3 h-3 rounded-full hover:opacity-80 group relative"
            style={{ background: "#ff5f57" }}
            title="Close"
          >
            <X className="w-2 h-2 absolute inset-0.5 opacity-0 group-hover:opacity-100 text-black/60" />
          </button>
          <div className="w-3 h-3 rounded-full" style={{ background: "#febc2e" }} />
          <div className="w-3 h-3 rounded-full" style={{ background: "#28c840" }} />
        </div>
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="flex items-center gap-2">
            <Icon className="w-3.5 h-3.5" style={{ color: "#7c3aed" }} />
            <span className="text-xs font-medium" style={{ color: "#2b2b2b" }}>
              {title}
            </span>
          </div>
        </div>
      </div>
      <div
        className="flex-1 overflow-hidden"
        style={{ background: glass ? "rgba(255,255,255,0.94)" : "#f6f1e8" }}
      >
        <div className="h-full overflow-auto">{children}</div>
      </div>
      {onResizeStart && (
        <>
          {resizeHandles.map((handle) => (
            <div
              key={handle.direction}
              className={handle.className}
              onMouseDown={(e) => onResizeStart(handle.direction, e)}
            />
          ))}
          <div className="pointer-events-none absolute bottom-1 right-1 z-10 h-3 w-3 rounded-sm border-r-2 border-b-2 border-black/25" />
        </>
      )}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════
export function Files({
  gatewayRunning,
  gatewayRetryIn,
  integrationsSyncing,
  integrationsMissing,
  onGatewayToggle,
  onRecoverProxyAuth,
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
  const { balance, isAuthenticated, isAuthConfigured } = useAuth();
  const [agentName, setAgentName] = useState("Joulie");

  // Wallpaper
  const [wallpaperId, setWallpaperId] = useState(DEFAULT_WALLPAPER_ID);
  const [customWallpaper, setCustomWallpaper] = useState<string | null>(null);
  const [showWallpaperPicker, setShowWallpaperPicker] = useState(false);
  const wallpaperInputRef = useRef<HTMLInputElement>(null);

  // Windows
  const [finderOpen, setFinderOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [pluginsOpen, setPluginsOpen] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [channelsOpen, setChannelsOpen] = useState(false);
  const [tasksOpen, setTasksOpen] = useState(false);
  const [jobsOpen, setJobsOpen] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);
  const [billingOpen, setBillingOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Finder drag
  const [finderPos, setFinderPos] = useState({ x: 30, y: 20 });
  const [finderSize, setFinderSize] = useState({ w: 680, h: 460 });
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);

  // Chat window drag
  const [chatPos, setChatPos] = useState({ x: 120, y: 40 });
  const [chatSize, setChatSize] = useState({ w: 860, h: 560 });
  const [chatNavCollapsed, setChatNavCollapsed] = useState(false);
  const chatDragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);
  const chatResizeRef = useRef<WindowResizeState | null>(null);
  const [desktopBounds, setDesktopBounds] = useState({ width: 0, height: 0 });
  const [browserPos, setBrowserPos] = useState({ x: 108, y: 40 });
  const [browserSize, setBrowserSize] = useState({ w: 1180, h: 760 });
  const browserDragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);
  const browserResizeRef = useRef<WindowResizeState | null>(null);
  const [terminalPos, setTerminalPos] = useState({ x: 156, y: 70 });
  const [terminalSize, setTerminalSize] = useState({ w: 920, h: 560 });
  const terminalDragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);
  const terminalResizeRef = useRef<WindowResizeState | null>(null);

  // Plugin windows drag
  const [pluginsPos, setPluginsPos] = useState({ x: 180, y: 80 });
  const [skillsPos, setSkillsPos] = useState({ x: 210, y: 95 });
  const [channelsPos, setChannelsPos] = useState({ x: 240, y: 120 });
  const [tasksPos, setTasksPos] = useState({ x: 220, y: 140 });
  const [jobsPos, setJobsPos] = useState({ x: 250, y: 150 });
  const [logsPos, setLogsPos] = useState({ x: 300, y: 160 });
  const [billingPos, setBillingPos] = useState({ x: 260, y: 110 });
  const [settingsPos, setSettingsPos] = useState({ x: 200, y: 70 });
  const [pluginsSize] = useState({ w: 520, h: 540 });
  const [skillsSize] = useState({ w: 520, h: 560 });
  const [channelsSize] = useState({ w: 520, h: 520 });
  const [tasksSize] = useState({ w: 760, h: 560 });
  const [jobsSize] = useState({ w: 620, h: 560 });
  const [logsSize] = useState({ w: 560, h: 420 });
  const [billingSize] = useState({ w: 520, h: 520 });
  const [settingsSize] = useState({ w: 740, h: 560 });
  const pluginsDragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);
  const skillsDragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);
  const channelsDragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);
  const tasksDragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);
  const jobsDragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);
  const logsDragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);
  const billingDragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);
  const settingsDragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);
  const zCounter = useRef(Math.max(...Object.values(DEFAULT_WINDOW_Z)));
  const [windowZ, setWindowZ] = useState<Record<string, number>>(DEFAULT_WINDOW_Z);

  // File browser
  const [entries, setEntries] = useState<WorkspaceFileEntry[]>([]);
  const [currentPath, setCurrentPath] = useState("");
  const [history, setHistory] = useState<string[]>([""]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [uploading, setUploading] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const [selected, setSelected] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; entry?: WorkspaceFileEntry } | null>(null);
  const [createFolderOpen, setCreateFolderOpen] = useState(false);
  const [createFolderName, setCreateFolderName] = useState("");
  const [createFolderBasePath, setCreateFolderBasePath] = useState("");
  const [creatingFolder, setCreatingFolder] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const createFolderInputRef = useRef<HTMLInputElement>(null);
  const filesFetchSeqRef = useRef(0);
  const filesLoadingSeqRef = useRef(0);

  // Chat
  const [chatSessions, setChatSessions] = useState<SharedChatSession[]>([]);
  const [chatCurrentSession, setChatCurrentSession] = useState<string | null>(null);
  const [chatRequestedSession, setChatRequestedSession] = useState<string | null>(null);
  const [chatRequestedAction, setChatRequestedAction] = useState<ChatSessionActionRequest | null>(null);
  const [chatSessionQuery, setChatSessionQuery] = useState("");
  const [openChatSessionMenuKey, setOpenChatSessionMenuKey] = useState<string | null>(null);
  const initialBrowserTabRef = useRef<BrowserTabState>(createBrowserTabState());
  const [browserTabs, setBrowserTabs] = useState<BrowserTabState[]>([initialBrowserTabRef.current]);
  const [activeBrowserTabId, setActiveBrowserTabId] = useState<string | null>(initialBrowserTabRef.current.id);
  const [browserUrlInput, setBrowserUrlInput] = useState(DEFAULT_BROWSER_URL);
  const [browserLoading, setBrowserLoading] = useState(false);
  const [browserLoadError, setBrowserLoadError] = useState<string | null>(null);
  const [browserSessionId, setBrowserSessionId] = useState<string | null>(null);
  const [browserEmbeddedPreview, setBrowserEmbeddedPreview] = useState<EmbeddedPreviewState | null>(null);
  const [browserSnapshot, setBrowserSnapshot] = useState<BrowserSnapshot | null>(null);
  const [browserClickingId, setBrowserClickingId] = useState<string | null>(null);
  const [browserLiveState, setBrowserLiveState] = useState<BrowserLiveState | null>(null);
  const [browserLiveHasFrame, setBrowserLiveHasFrame] = useState(false);
  const [browserLiveConnected, setBrowserLiveConnected] = useState(false);
  const [browserLiveError, setBrowserLiveError] = useState<string | null>(null);
  const browserLiveSocketRef = useRef<WebSocket | null>(null);
  const browserLiveImageRef = useRef<HTMLImageElement | null>(null);
  const browserViewportRef = useRef<HTMLDivElement | null>(null);
  const browserLiveMovePendingRef = useRef<{ x: number; y: number } | null>(null);
  const browserLiveMoveRafRef = useRef<number | null>(null);
  const browserLiveFramePendingRef = useRef<string | null>(null);
  const browserLiveFrameRafRef = useRef<number | null>(null);
  const browserLiveLastFrameRef = useRef<string | null>(null);
  const browserLiveSizeRef = useRef<string>("");
  const browserEmbeddedPreviewSyncKeyRef = useRef<string>("");
  const [terminalSessionId, setTerminalSessionId] = useState<string | null>(null);
  const [terminalOutput, setTerminalOutput] = useState("");
  const [terminalInput, setTerminalInput] = useState("");
  const [terminalStatus, setTerminalStatus] = useState<DesktopTerminalStatus>("disconnected");
  const [terminalExitCode, setTerminalExitCode] = useState<number | null>(null);
  const [terminalError, setTerminalError] = useState<string | null>(null);
  const [terminalBootstrapping, setTerminalBootstrapping] = useState(false);
  const terminalOutputRef = useRef<HTMLDivElement | null>(null);

  const proxyEnabled = isAuthConfigured && isAuthenticated && !useLocalKeys;

  // Desktop icons
  const [desktopIcons, setDesktopIcons] = useState<Record<string, DesktopIcon>>({
    workspace: { id: "workspace", x: 28, y: 72 },
  });
  const iconDragRef = useRef<{
    id: string;
    sx: number;
    sy: number;
    ox: number;
    oy: number;
    moved: boolean;
  } | null>(null);
  const iconClickGuardRef = useRef(false);
  const [desktopStateHydrated, setDesktopStateHydrated] = useState(false);
  const desktopSessionSnapshotRef = useRef<DesktopSessionState | null>(null);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(DESKTOP_SESSION_STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as Partial<DesktopSessionState>;
      if (!isRecord(saved)) return;

      if (typeof saved.finderOpen === "boolean") setFinderOpen(saved.finderOpen);
      if (typeof saved.chatOpen === "boolean") setChatOpen(saved.chatOpen);
      if (typeof saved.chatNavCollapsed === "boolean") setChatNavCollapsed(saved.chatNavCollapsed);
      if (typeof saved.browserOpen === "boolean") setBrowserOpen(saved.browserOpen);
      if (typeof saved.terminalOpen === "boolean") setTerminalOpen(saved.terminalOpen);
      if (typeof saved.pluginsOpen === "boolean") setPluginsOpen(saved.pluginsOpen);
      if (typeof saved.skillsOpen === "boolean") setSkillsOpen(saved.skillsOpen);
      if (typeof saved.channelsOpen === "boolean") setChannelsOpen(saved.channelsOpen);
      if (typeof saved.tasksOpen === "boolean") setTasksOpen(saved.tasksOpen);
      if (typeof saved.jobsOpen === "boolean") setJobsOpen(saved.jobsOpen);
      if (typeof saved.logsOpen === "boolean") setLogsOpen(saved.logsOpen);
      if (typeof saved.billingOpen === "boolean") setBillingOpen(saved.billingOpen);
      if (typeof saved.settingsOpen === "boolean") setSettingsOpen(saved.settingsOpen);

      const nextFinderPos = asWindowPoint(saved.finderPos);
      if (nextFinderPos) setFinderPos(nextFinderPos);
      const nextFinderSize = asWindowSize(saved.finderSize);
      if (nextFinderSize) setFinderSize(nextFinderSize);
      const nextChatPos = asWindowPoint(saved.chatPos);
      if (nextChatPos) setChatPos(nextChatPos);
      const nextChatSize = asWindowSize(saved.chatSize);
      if (nextChatSize) setChatSize(nextChatSize);
      const nextBrowserPos = asWindowPoint(saved.browserPos);
      if (nextBrowserPos) setBrowserPos(nextBrowserPos);
      const nextBrowserSize = asWindowSize(saved.browserSize);
      if (nextBrowserSize) setBrowserSize(nextBrowserSize);
      const nextTerminalPos = asWindowPoint(saved.terminalPos);
      if (nextTerminalPos) setTerminalPos(nextTerminalPos);
      const nextTerminalSize = asWindowSize(saved.terminalSize);
      if (nextTerminalSize) setTerminalSize(nextTerminalSize);
      const nextPluginsPos = asWindowPoint(saved.pluginsPos);
      if (nextPluginsPos) setPluginsPos(nextPluginsPos);
      const nextSkillsPos = asWindowPoint(saved.skillsPos);
      if (nextSkillsPos) setSkillsPos(nextSkillsPos);
      const nextChannelsPos = asWindowPoint(saved.channelsPos);
      if (nextChannelsPos) setChannelsPos(nextChannelsPos);
      const nextTasksPos = asWindowPoint(saved.tasksPos);
      if (nextTasksPos) setTasksPos(nextTasksPos);
      const nextJobsPos = asWindowPoint(saved.jobsPos);
      if (nextJobsPos) setJobsPos(nextJobsPos);
      const nextLogsPos = asWindowPoint(saved.logsPos);
      if (nextLogsPos) setLogsPos(nextLogsPos);
      const nextBillingPos = asWindowPoint(saved.billingPos);
      if (nextBillingPos) setBillingPos(nextBillingPos);
      const nextSettingsPos = asWindowPoint(saved.settingsPos);
      if (nextSettingsPos) setSettingsPos(nextSettingsPos);

      const nextWindowZ = asWindowZ(saved.windowZ);
      if (nextWindowZ) {
        setWindowZ(nextWindowZ);
      }
      if (typeof saved.zCounter === "number" && Number.isFinite(saved.zCounter)) {
        zCounter.current = saved.zCounter;
      } else if (nextWindowZ) {
        zCounter.current = Math.max(...Object.values(nextWindowZ));
      }

      if (typeof saved.currentPath === "string") setCurrentPath(saved.currentPath);
      const nextHistory = asStringArray(saved.history);
      if (nextHistory) setHistory(nextHistory);
      if (typeof saved.historyIndex === "number" && Number.isFinite(saved.historyIndex)) {
        setHistoryIndex(Math.max(0, Math.floor(saved.historyIndex)));
      }
      if (saved.viewMode === "grid" || saved.viewMode === "list") setViewMode(saved.viewMode);
      if (typeof saved.selected === "string" || saved.selected === null) setSelected(saved.selected ?? null);
      if (typeof saved.browserUrlInput === "string") setBrowserUrlInput(presentBrowserUrl(saved.browserUrlInput));
      if (typeof saved.browserSessionId === "string" || saved.browserSessionId === null) {
        setBrowserSessionId(saved.browserSessionId ?? null);
      }
      if (typeof saved.terminalSessionId === "string" || saved.terminalSessionId === null) {
        setTerminalSessionId(saved.terminalSessionId ?? null);
      }
      if (typeof saved.terminalInput === "string") {
        setTerminalInput(saved.terminalInput);
      }
      if (
        typeof saved.browserEmbeddedPreviewUrl === "string" ||
        saved.browserEmbeddedPreviewUrl === null
      ) {
        setBrowserEmbeddedPreview(
          saved.browserEmbeddedPreviewUrl
            ? {
                url: saved.browserEmbeddedPreviewUrl,
                title:
                  typeof saved.browserEmbeddedPreviewTitle === "string"
                    ? saved.browserEmbeddedPreviewTitle
                    : null,
              }
            : null,
        );
      }
      if (Array.isArray(saved.browserTabs) && saved.browserTabs.length > 0) {
        const restoredTabs = saved.browserTabs
          .map((value) => {
            if (!isRecord(value) || typeof value.id !== "string") return null;
            return restoreBrowserTabState({
              id: value.id,
              title: typeof value.title === "string" ? value.title : null,
              urlInput: typeof value.urlInput === "string" ? value.urlInput : DEFAULT_BROWSER_URL,
              sessionId: typeof value.sessionId === "string" ? value.sessionId : null,
              embeddedPreviewUrl:
                typeof value.embeddedPreviewUrl === "string" ? value.embeddedPreviewUrl : null,
              embeddedPreviewTitle:
                typeof value.embeddedPreviewTitle === "string" ? value.embeddedPreviewTitle : null,
            });
          })
          .filter((value): value is BrowserTabState => value !== null);
        if (restoredTabs.length > 0) {
          const nextActiveTabId =
            typeof saved.activeBrowserTabId === "string"
              ? saved.activeBrowserTabId
              : restoredTabs[0]?.id ?? null;
          const activeTab =
            restoredTabs.find((tab) => tab.id === nextActiveTabId) ?? restoredTabs[0] ?? null;
          setBrowserTabs(restoredTabs);
          setActiveBrowserTabId(activeTab?.id ?? null);
          if (activeTab) {
            setBrowserUrlInput(presentBrowserUrl(activeTab.urlInput));
            setBrowserSessionId(activeTab.sessionId);
            setBrowserEmbeddedPreview(activeTab.embeddedPreview);
            setBrowserSnapshot(activeTab.snapshot);
            setBrowserLiveState(activeTab.liveState);
            setBrowserLiveError(activeTab.liveError);
            setBrowserLoading(activeTab.loading);
          }
        }
      }
      const nextDesktopIcons = asDesktopIcons(saved.desktopIcons);
      if (nextDesktopIcons) setDesktopIcons(nextDesktopIcons);
    } catch {
      // Ignore invalid persisted desktop state.
    } finally {
      setDesktopStateHydrated(true);
    }
  }, []);

  function handleIconMouseDown(id: string, e: ReactMouseEvent<HTMLElement>) {
    e.stopPropagation();
    const icon = desktopIcons[id];
    if (!icon) return;
    iconDragRef.current = {
      id,
      sx: e.clientX,
      sy: e.clientY,
      ox: icon.x,
      oy: icon.y,
      moved: false,
    };
    function onMove(ev: globalThis.MouseEvent) {
      if (!iconDragRef.current) return;
      const dx = ev.clientX - iconDragRef.current.sx;
      const dy = ev.clientY - iconDragRef.current.sy;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
        iconDragRef.current.moved = true;
        iconClickGuardRef.current = true;
      }
      const bounds = containerRef.current?.getBoundingClientRect();
      const maxX = bounds ? Math.max(0, bounds.width - 84) : undefined;
      const maxY = bounds ? Math.max(0, bounds.height - 110) : undefined;
      const nextX = iconDragRef.current.ox + dx;
      const nextY = iconDragRef.current.oy + dy;
      setDesktopIcons((prev) => ({
        ...prev,
        [id]: {
          ...prev[id],
          x: maxX !== undefined ? Math.min(Math.max(0, nextX), maxX) : nextX,
          y: maxY !== undefined ? Math.min(Math.max(0, nextY), maxY) : nextY,
        },
      }));
    }
    function onUp() {
      if (iconDragRef.current?.moved) {
        iconClickGuardRef.current = true;
        setTimeout(() => {
          iconClickGuardRef.current = false;
        }, 0);
      }
      iconDragRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  // ── Init ────────────────────────────────────────────────────────────

  useEffect(() => {
    loadOnboardingData().then((d) => {
      if (d?.agentName) setAgentName(d.agentName);
    });
    Store.load("entropic-settings.json").then(async (s) => {
      const wp = (await s.get("desktopWallpaper")) as string | null;
      if (wp) setWallpaperId(wp);
      const cwp = (await s.get("desktopCustomWallpaper")) as string | null;
      if (cwp) setCustomWallpaper(cwp);
    }).catch(() => {});
  }, []);

  // Track desktop bounds for window clamping.
  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver(([e]) => {
      const width = Math.max(0, Math.floor(e.contentRect.width));
      const height = Math.max(0, Math.floor(e.contentRect.height));
      setDesktopBounds((prev) => (
        prev.width === width && prev.height === height
          ? prev
          : { width, height }
      ));
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (desktopBounds.width <= 0 || desktopBounds.height <= 0) return;
    const bounds = desktopBounds;

    const clampResizableWindow = (
      position: WindowPoint,
      size: WindowSize,
      minSize: WindowSize,
      setPosition: (value: WindowPoint | ((prev: WindowPoint) => WindowPoint)) => void,
      setWindowSize: (value: WindowSize | ((prev: WindowSize) => WindowSize)) => void,
    ) => {
      const next = clampWindowFrame(bounds, position, size, minSize);
      setPosition((prev) => (
        prev.x === next.position.x && prev.y === next.position.y ? prev : next.position
      ));
      setWindowSize((prev) => (
        prev.w === next.size.w && prev.h === next.size.h ? prev : next.size
      ));
    };

    const clampFixedWindow = (
      position: WindowPoint,
      size: WindowSize,
      setPosition: (value: WindowPoint | ((prev: WindowPoint) => WindowPoint)) => void,
    ) => {
      const next = clampWindowFrame(bounds, position, size, size);
      setPosition((prev) => (
        prev.x === next.position.x && prev.y === next.position.y ? prev : next.position
      ));
    };

    clampResizableWindow(finderPos, finderSize, { w: 320, h: 240 }, setFinderPos, setFinderSize);
    clampResizableWindow(chatPos, chatSize, { w: 720, h: 500 }, setChatPos, setChatSize);
    clampResizableWindow(browserPos, browserSize, { w: 640, h: 420 }, setBrowserPos, setBrowserSize);
    clampResizableWindow(terminalPos, terminalSize, { w: 680, h: 360 }, setTerminalPos, setTerminalSize);
    clampFixedWindow(pluginsPos, pluginsSize, setPluginsPos);
    clampFixedWindow(skillsPos, skillsSize, setSkillsPos);
    clampFixedWindow(channelsPos, channelsSize, setChannelsPos);
    clampFixedWindow(tasksPos, tasksSize, setTasksPos);
    clampFixedWindow(jobsPos, jobsSize, setJobsPos);
    clampFixedWindow(logsPos, logsSize, setLogsPos);
    clampFixedWindow(billingPos, billingSize, setBillingPos);
    clampFixedWindow(settingsPos, settingsSize, setSettingsPos);
  }, [
    desktopBounds,
    finderPos,
    finderSize,
    chatPos,
    chatSize,
    browserPos,
    browserSize,
    terminalPos,
    terminalSize,
    pluginsPos,
    skillsPos,
    channelsPos,
    tasksPos,
    jobsPos,
    logsPos,
    billingPos,
    settingsPos,
    pluginsSize,
    skillsSize,
    channelsSize,
    tasksSize,
    jobsSize,
    logsSize,
    billingSize,
    settingsSize,
  ]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      if (target.closest("[data-desktop-chat-session-menu]") || target.closest("[data-desktop-chat-session-trigger]")) {
        return;
      }
      setOpenChatSessionMenuKey(null);
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, []);

  useEffect(() => {
    if (!openChatSessionMenuKey) return;
    if (chatSessions.some((session) => session.key === openChatSessionMenuKey)) return;
    setOpenChatSessionMenuKey(null);
  }, [chatSessions, openChatSessionMenuKey]);

  useEffect(() => {
    if (!desktopStateHydrated) return;
    const snapshot: DesktopSessionState = {
      finderOpen,
      chatOpen,
      chatNavCollapsed,
      browserOpen,
      terminalOpen,
      pluginsOpen,
      skillsOpen,
      channelsOpen,
      tasksOpen,
      jobsOpen,
      logsOpen,
      billingOpen,
      settingsOpen,
      finderPos,
      finderSize,
      chatPos,
      chatSize,
      browserPos,
      browserSize,
      terminalPos,
      terminalSize,
      pluginsPos,
      skillsPos,
      channelsPos,
      tasksPos,
      jobsPos,
      logsPos,
      billingPos,
      settingsPos,
      windowZ,
      zCounter: zCounter.current,
      currentPath,
      history,
      historyIndex,
      viewMode,
      selected,
      browserUrlInput,
      browserSessionId,
      browserEmbeddedPreviewUrl: browserEmbeddedPreview?.url ?? null,
      browserEmbeddedPreviewTitle: browserEmbeddedPreview?.title ?? null,
      browserTabs: browserTabs.map(persistBrowserTabState),
      activeBrowserTabId,
      terminalSessionId,
      terminalInput,
      desktopIcons,
    };
    desktopSessionSnapshotRef.current = snapshot;
    const timeoutId = window.setTimeout(() => {
      try {
        window.localStorage.setItem(DESKTOP_SESSION_STORAGE_KEY, JSON.stringify(snapshot));
      } catch {
        // Ignore storage failures.
      }
    }, 120);
    return () => window.clearTimeout(timeoutId);
  }, [
    desktopStateHydrated,
    finderOpen,
    chatOpen,
    chatNavCollapsed,
    browserOpen,
    terminalOpen,
    pluginsOpen,
    skillsOpen,
    channelsOpen,
    tasksOpen,
    jobsOpen,
    logsOpen,
    billingOpen,
    settingsOpen,
    finderPos,
    finderSize,
    chatPos,
    chatSize,
    browserPos,
    browserSize,
    terminalPos,
    terminalSize,
    pluginsPos,
    skillsPos,
    channelsPos,
    tasksPos,
    jobsPos,
    logsPos,
    billingPos,
    settingsPos,
    windowZ,
    currentPath,
    history,
    historyIndex,
    viewMode,
    selected,
    browserUrlInput,
    browserSessionId,
    browserEmbeddedPreview,
    browserTabs,
    activeBrowserTabId,
    terminalSessionId,
    terminalInput,
    desktopIcons,
  ]);

  useEffect(() => {
    return () => {
      const snapshot = desktopSessionSnapshotRef.current;
      if (!snapshot) return;
      try {
        window.localStorage.setItem(DESKTOP_SESSION_STORAGE_KEY, JSON.stringify(snapshot));
      } catch {
        // Ignore storage failures.
      }
    };
  }, []);

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

  function getWallpaperCss(): string {
    if (wallpaperId === "custom" && customWallpaper) return `url(${customWallpaper})`;
    return getWallpaperById(wallpaperId)?.css || WALLPAPERS[0].css;
  }

  async function handleCustomWallpaperUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]; if (!f) return; e.target.value = "";
    const reader = new FileReader();
    reader.onload = () => { saveWallpaper("custom", reader.result as string); setShowWallpaperPicker(false); };
    reader.readAsDataURL(f);
  }

  // ── Finder drag ─────────────────────────────────────────────────────

  function focusWindow(id: string) {
    setWindowZ((prev) => {
      const nextZ = zCounter.current + 1;
      zCounter.current = nextZ;
      return { ...prev, [id]: nextZ };
    });
  }

  function startWindowDrag(
    e: ReactMouseEvent<HTMLElement>,
    ref: React.MutableRefObject<{ sx: number; sy: number; ox: number; oy: number } | null>,
    pos: { x: number; y: number },
    size: { w: number; h: number },
    setPos: (next: { x: number; y: number }) => void,
    id: string
  ) {
    if ((e.target as HTMLElement).closest("button")) return;
    e.preventDefault();
    focusWindow(id);
    ref.current = { sx: e.clientX, sy: e.clientY, ox: pos.x, oy: pos.y };
    function onMove(ev: globalThis.MouseEvent) {
      if (!ref.current) return;
      const bounds = containerRef.current?.getBoundingClientRect();
      const maxX = bounds ? Math.max(0, Math.floor(bounds.width - size.w)) : Number.POSITIVE_INFINITY;
      const maxY = bounds ? Math.max(0, Math.floor(bounds.height - size.h)) : Number.POSITIVE_INFINITY;
      setPos({
        x: Math.min(Math.max(0, ref.current.ox + ev.clientX - ref.current.sx), maxX),
        y: Math.min(Math.max(0, ref.current.oy + ev.clientY - ref.current.sy), maxY),
      });
    }
    function onUp() {
      ref.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  function handleFinderDragStart(e: ReactMouseEvent<HTMLElement>) {
    startWindowDrag(e, dragRef, finderPos, finderSize, setFinderPos, "finder");
  }

  function handleChatDragStart(e: ReactMouseEvent<HTMLElement>) {
    startWindowDrag(e, chatDragRef, chatPos, chatSize, setChatPos, "chat");
  }

  function startWindowResize(
    e: ReactMouseEvent<HTMLElement>,
    direction: WindowResizeDirection,
    ref: React.MutableRefObject<WindowResizeState | null>,
    pos: { x: number; y: number },
    size: { w: number; h: number },
    setPos: (next: { x: number; y: number }) => void,
    setSize: (next: { w: number; h: number }) => void,
    id: string,
    minSize: { w: number; h: number },
  ) {
    e.preventDefault();
    e.stopPropagation();
    focusWindow(id);
    ref.current = { sx: e.clientX, sy: e.clientY, ox: pos.x, oy: pos.y, ow: size.w, oh: size.h };
    function onMove(ev: globalThis.MouseEvent) {
      if (!ref.current) return;
      const deltaX = ev.clientX - ref.current.sx;
      const deltaY = ev.clientY - ref.current.sy;
      const bounds = containerRef.current?.getBoundingClientRect();
      const maxRight = bounds ? Math.floor(bounds.width - 12) : Number.POSITIVE_INFINITY;
      const maxBottom = bounds ? Math.floor(bounds.height - 12) : Number.POSITIVE_INFINITY;
      const originalLeft = ref.current.ox;
      const originalTop = ref.current.oy;
      const originalRight = ref.current.ox + ref.current.ow;
      const originalBottom = ref.current.oy + ref.current.oh;

      let nextLeft = originalLeft;
      let nextTop = originalTop;
      let nextRight = originalRight;
      let nextBottom = originalBottom;

      if (direction.includes("w")) {
        nextLeft = Math.max(0, Math.min(originalLeft + deltaX, originalRight - minSize.w));
      }
      if (direction.includes("e")) {
        nextRight = Math.max(
          originalLeft + minSize.w,
          Math.min(originalRight + deltaX, maxRight),
        );
      }
      if (direction.includes("n")) {
        nextTop = Math.max(0, Math.min(originalTop + deltaY, originalBottom - minSize.h));
      }
      if (direction.includes("s")) {
        nextBottom = Math.max(
          originalTop + minSize.h,
          Math.min(originalBottom + deltaY, maxBottom),
        );
      }

      setPos({ x: nextLeft, y: nextTop });
      setSize({ w: nextRight - nextLeft, h: nextBottom - nextTop });
    }
    function onUp() {
      ref.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  function applyTerminalSnapshot(snapshot: DesktopTerminalSnapshot) {
    setTerminalSessionId(snapshot.session_id);
    setTerminalOutput(snapshot.output);
    setTerminalStatus(snapshot.status);
    setTerminalExitCode(snapshot.exit_code ?? null);
    setTerminalError(null);
  }

  function appendTerminalLocalOutput(chunk: string) {
    if (!chunk) return;
    setTerminalOutput((prev) => `${prev}${chunk}`);
  }

  function openTerminalWindow() {
    if (!terminalOpen) {
      setTerminalOpen(true);
    }
    focusWindow("terminal");
  }

  async function closeTerminalWindow() {
    const sessionId = terminalSessionId;
    setTerminalOpen(false);
    setTerminalSessionId(null);
    setTerminalOutput("");
    setTerminalStatus("disconnected");
    setTerminalExitCode(null);
    setTerminalError(null);
    if (!sessionId) return;
    try {
      await invoke("desktop_terminal_close", { sessionId });
    } catch {
      // Ignore close failures while tearing down UI state.
    }
  }

  async function restartTerminalSession() {
    const sessionId = terminalSessionId;
    setTerminalSessionId(null);
    setTerminalOutput("");
    setTerminalStatus("disconnected");
    setTerminalExitCode(null);
    setTerminalError(null);
    if (sessionId) {
      try {
        await invoke("desktop_terminal_close", { sessionId });
      } catch {
        // Ignore restart cleanup failures and let the next create attempt recover.
      }
    }
  }

  async function clearTerminalBuffer() {
    if (!terminalSessionId) {
      setTerminalOutput("");
      return;
    }
    try {
      await invoke("desktop_terminal_clear", { sessionId: terminalSessionId });
      setTerminalOutput("");
      setTerminalError(null);
    } catch (error) {
      setTerminalError(error instanceof Error ? error.message : String(error));
    }
  }

  async function submitTerminalInput() {
    if (!terminalSessionId) return;
    const command = terminalInput.replace(/\r\n/g, "\n");
    if (!command.trim()) return;
    const payload = command.endsWith("\n") ? command : `${command}\n`;
    appendTerminalLocalOutput(`$ ${command}\n`);
    setTerminalInput("");
    setTerminalError(null);
    try {
      await invoke("desktop_terminal_write", { sessionId: terminalSessionId, input: payload });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setTerminalError(message);
      appendTerminalLocalOutput(`[write failed] ${message}\n`);
    }
  }

  function closeBrowserLiveSocket() {
    if (browserLiveMoveRafRef.current !== null) {
      window.cancelAnimationFrame(browserLiveMoveRafRef.current);
      browserLiveMoveRafRef.current = null;
    }
    if (browserLiveFrameRafRef.current !== null) {
      window.cancelAnimationFrame(browserLiveFrameRafRef.current);
      browserLiveFrameRafRef.current = null;
    }
    browserLiveMovePendingRef.current = null;
    browserLiveFramePendingRef.current = null;
    browserLiveSizeRef.current = "";
    const socket = browserLiveSocketRef.current;
    browserLiveSocketRef.current = null;
    if (socket) {
      socket.close();
    }
  }

  function sendBrowserLiveMessage(payload: Record<string, unknown>) {
    const socket = browserLiveSocketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }
    socket.send(JSON.stringify(payload));
  }

  const browserUsingEmbeddedPreview = Boolean(browserEmbeddedPreview?.url);
  const browserCurrentUrl =
    browserEmbeddedPreview?.url || browserLiveState?.url || browserSnapshot?.url || browserUrlInput || DEFAULT_BROWSER_URL;
  const browserCanGoBack = browserUsingEmbeddedPreview
    ? true
    : browserLiveState?.can_go_back ?? browserSnapshot?.can_go_back ?? false;
  const browserCanGoForward = browserUsingEmbeddedPreview
    ? true
    : browserLiveState?.can_go_forward ?? browserSnapshot?.can_go_forward ?? false;
  const browserViewportWidth = browserLiveState?.viewport_width ?? browserSnapshot?.screenshot_width ?? 1440;
  const browserViewportHeight = browserLiveState?.viewport_height ?? browserSnapshot?.screenshot_height ?? 900;
  const browserRemoteDesktopUrl =
    browserLiveState?.remote_desktop_url || browserSnapshot?.remote_desktop_url || null;
  const browserHasRemoteDesktop = Boolean(browserRemoteDesktopUrl);
  const browserSnapshotImage =
    browserSnapshot?.screenshot_base64 ? `data:image/png;base64,${browserSnapshot.screenshot_base64}` : null;
  const browserHasRenderableImage = browserLiveHasFrame || Boolean(browserSnapshotImage);
  const browserUsingEmbeddedRemoteDesktop = browserHasRemoteDesktop && !browserHasRenderableImage;
  const browserTitle =
    browserEmbeddedPreview?.title ||
    browserLiveState?.title ||
    browserSnapshot?.title ||
    browserSnapshot?.url ||
    browserCurrentUrl;
  const terminalStatusLabel = terminalBootstrapping
    ? "Connecting"
    : terminalStatus === "ready"
      ? "Live"
      : terminalStatus === "exited"
        ? terminalExitCode === null
          ? "Exited"
          : `Exited (${terminalExitCode})`
        : terminalStatus === "error"
          ? "Error"
          : "Idle";
  const terminalStatusTone = terminalBootstrapping
    ? "#f59e0b"
    : terminalStatus === "ready"
      ? "#22c55e"
      : terminalStatus === "error"
        ? "#ef4444"
        : "rgba(148,163,184,0.95)";
  function buildActiveBrowserTabState(base?: BrowserTabState | null): BrowserTabState {
    return {
      id: base?.id ?? activeBrowserTabId ?? makeBrowserTabId(),
      title: browserTitle || base?.title || null,
      urlInput: browserUrlInput,
      sessionId: browserSessionId,
      embeddedPreview: browserEmbeddedPreview,
      snapshot: browserSnapshot,
      liveState: browserLiveState,
      liveError: browserLiveError,
      loading: browserLoading,
    };
  }

  function commitActiveBrowserTabState(tabs: BrowserTabState[]): BrowserTabState[] {
    if (!activeBrowserTabId) return tabs;
    const index = tabs.findIndex((tab) => tab.id === activeBrowserTabId);
    if (index < 0) return tabs;
    const current = tabs[index];
    const next = buildActiveBrowserTabState(current);
    if (
      current.title === next.title &&
      current.urlInput === next.urlInput &&
      current.sessionId === next.sessionId &&
      current.embeddedPreview === next.embeddedPreview &&
      current.snapshot === next.snapshot &&
      current.liveState === next.liveState &&
      current.liveError === next.liveError &&
      current.loading === next.loading
    ) {
      return tabs;
    }
    const copy = tabs.slice();
    copy[index] = next;
    return copy;
  }

  function applyBrowserTabState(tab: BrowserTabState) {
    closeBrowserLiveSocket();
    resetBrowserLiveFrame();
    setBrowserUrlInput(presentBrowserUrl(tab.urlInput));
    setBrowserSessionId(tab.sessionId);
    setBrowserEmbeddedPreview(tab.embeddedPreview);
    setBrowserSnapshot(tab.snapshot);
    setBrowserLiveState(tab.liveState);
    setBrowserLiveConnected(false);
    setBrowserLiveError(tab.liveError);
    setBrowserLoading(tab.loading);
    setBrowserClickingId(null);
  }

  function browserTabLabel(tab: BrowserTabState): string {
    const title = tab.title?.trim();
    if (title) return title;
    const rawUrl = tab.embeddedPreview?.url || tab.liveState?.url || tab.snapshot?.url || tab.urlInput;
    try {
      const parsed = new URL(normalizeBrowserUrl(rawUrl));
      const host = parsed.hostname.replace(/^www\./, "");
      return host || "New tab";
    } catch {
      return rawUrl || "New tab";
    }
  }

  function selectBrowserTab(tabId: string) {
    const committedTabs = commitActiveBrowserTabState(browserTabs);
    const nextTab = committedTabs.find((tab) => tab.id === tabId);
    if (!nextTab) return;
    setBrowserTabs(committedTabs);
    setActiveBrowserTabId(tabId);
    applyBrowserTabState(nextTab);
    if (!browserOpen) {
      setBrowserOpen(true);
    }
    focusWindow("browser");
  }

  function createBrowserTab(targetUrl?: string) {
    const normalizedTarget = targetUrl ? normalizeBrowserUrl(targetUrl) : "";
    const nextTab = createBrowserTabState({
      title: null,
      urlInput: normalizedTarget || DEFAULT_BROWSER_URL,
      embeddedPreview:
        normalizedTarget && isTrustedLocalPreviewUrl(normalizedTarget)
          ? { url: normalizedTarget, title: null }
          : null,
      loading: false,
    });
    const committedTabs = commitActiveBrowserTabState(browserTabs);
    setBrowserTabs([...committedTabs, nextTab]);
    setActiveBrowserTabId(nextTab.id);
    applyBrowserTabState(nextTab);
    setBrowserLoadError(null);
    if (!browserOpen) {
      setBrowserOpen(true);
    }
    focusWindow("browser");
  }

  async function closeBrowserTab(tabId: string) {
    const committedTabs = commitActiveBrowserTabState(browserTabs);
    const closingTab = committedTabs.find((tab) => tab.id === tabId);
    if (!closingTab) return;

    if (closingTab.sessionId) {
      try {
        await invoke("browser_session_close", { sessionId: closingTab.sessionId });
      } catch {
        // Ignore background tab close failures.
      }
    }

    const remainingTabs = committedTabs.filter((tab) => tab.id !== tabId);
    if (remainingTabs.length === 0) {
      const nextTab = createBrowserTabState();
      setBrowserTabs([nextTab]);
      setActiveBrowserTabId(nextTab.id);
      applyBrowserTabState(nextTab);
      setBrowserOpen(false);
      return;
    }

    setBrowserTabs(remainingTabs);
    if (tabId === activeBrowserTabId) {
      const nextIndex = Math.max(0, committedTabs.findIndex((tab) => tab.id === tabId) - 1);
      const nextTab = remainingTabs[nextIndex] ?? remainingTabs[remainingTabs.length - 1];
      setActiveBrowserTabId(nextTab.id);
      applyBrowserTabState(nextTab);
    }
  }

  useEffect(() => {
    if (!activeBrowserTabId) return;
    setBrowserTabs((prev) => commitActiveBrowserTabState(prev));
  }, [
    activeBrowserTabId,
    browserUrlInput,
    browserSessionId,
    browserEmbeddedPreview,
    browserSnapshot,
    browserLiveState,
    browserLiveError,
    browserLoading,
    browserTitle,
  ]);

  function browserFrameDataUrl(format: string | null | undefined, data: string) {
    const normalized = format === "png" ? "png" : "jpeg";
    return `data:image/${normalized};base64,${data}`;
  }

  function resetBrowserLiveFrame() {
    if (browserLiveFrameRafRef.current !== null) {
      window.cancelAnimationFrame(browserLiveFrameRafRef.current);
      browserLiveFrameRafRef.current = null;
    }
    browserLiveFramePendingRef.current = null;
    browserLiveLastFrameRef.current = null;
    setBrowserLiveHasFrame(false);
    const image = browserLiveImageRef.current;
    if (image) {
      image.removeAttribute("src");
    }
  }

  function queueBrowserLiveFrame(format: string | null | undefined, data: string) {
    browserLiveFramePendingRef.current = browserFrameDataUrl(format, data);
    if (browserLiveFrameRafRef.current !== null) {
      return;
    }
    browserLiveFrameRafRef.current = window.requestAnimationFrame(() => {
      browserLiveFrameRafRef.current = null;
      const nextFrame = browserLiveFramePendingRef.current;
      browserLiveFramePendingRef.current = null;
      if (!nextFrame) return;
      browserLiveLastFrameRef.current = nextFrame;
      const image = browserLiveImageRef.current;
      if (image && image.src !== nextFrame) {
        image.src = nextFrame;
      }
      setBrowserLiveHasFrame((prev) => (prev ? prev : true));
    });
  }

  useEffect(() => {
    if (browserUsingEmbeddedPreview) return;
    const nextUrl = browserLiveState?.url || browserSnapshot?.url;
    if (nextUrl) {
      setBrowserUrlInput(presentBrowserUrl(nextUrl));
    }
  }, [browserUsingEmbeddedPreview, browserLiveState?.url, browserSnapshot?.url]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<EmbeddedPreviewState>("embedded-preview-state", (event) => {
      const payload = event.payload;
      if (!payload?.url) return;
      setBrowserEmbeddedPreview((prev) => ({
        url: payload.url,
        title: typeof payload.title === "string" ? payload.title : prev?.title ?? null,
      }));
      setBrowserUrlInput(presentBrowserUrl(payload.url));
    }).then((dispose) => {
      unlisten = dispose;
    }).catch(() => {});
    return () => {
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    let unlistenTerminal: (() => void) | undefined;
    void listen<DesktopTerminalEventPayload>(DESKTOP_TERMINAL_EVENT, (event) => {
      const payload = event.payload;
      if (!payload || payload.session_id !== terminalSessionId) return;
      if (payload.chunk) {
        appendTerminalLocalOutput(payload.chunk);
      }
      setTerminalStatus(payload.status);
      setTerminalExitCode(payload.exit_code ?? null);
    }).then((dispose) => {
      unlistenTerminal = dispose;
    }).catch(() => {});
    return () => {
      unlistenTerminal?.();
    };
  }, [terminalSessionId]);

  useEffect(() => {
    if (!desktopStateHydrated || !terminalOpen) return;
    let cancelled = false;
    async function ensureTerminalSession() {
      setTerminalBootstrapping(true);
      try {
        if (terminalSessionId) {
          try {
            const snapshot = await invoke<DesktopTerminalSnapshot>("desktop_terminal_snapshot", {
              sessionId: terminalSessionId,
            });
            if (!cancelled) {
              applyTerminalSnapshot(snapshot);
            }
            return;
          } catch {
            if (!cancelled) {
              setTerminalSessionId(null);
              setTerminalOutput("");
              setTerminalStatus("disconnected");
              setTerminalExitCode(null);
            }
          }
        }

        const snapshot = await invoke<DesktopTerminalSnapshot>("desktop_terminal_create");
        if (!cancelled) {
          applyTerminalSnapshot(snapshot);
        }
      } catch (error) {
        if (!cancelled) {
          setTerminalStatus("error");
          setTerminalError(error instanceof Error ? error.message : String(error));
        }
      } finally {
        if (!cancelled) {
          setTerminalBootstrapping(false);
        }
      }
    }
    void ensureTerminalSession();
    return () => {
      cancelled = true;
    };
  }, [desktopStateHydrated, terminalOpen, terminalSessionId]);

  useEffect(() => {
    const element = terminalOutputRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, [terminalOutput, terminalOpen]);

  useEffect(() => {
    const image = browserLiveImageRef.current;
    if (!image) return;
    const nextSrc = browserLiveLastFrameRef.current || browserSnapshotImage;
    if (nextSrc) {
      if (image.src !== nextSrc) {
        image.src = nextSrc;
      }
    } else {
      image.removeAttribute("src");
    }
  }, [browserSnapshotImage, browserLiveHasFrame, browserSessionId]);

  useEffect(() => {
    if (
      !desktopStateHydrated ||
      !browserOpen ||
      browserUsingEmbeddedPreview ||
      !browserSessionId ||
      browserSnapshot ||
      browserLiveState
    ) {
      return;
    }
    let cancelled = false;
    setBrowserLoading(true);
    invoke<BrowserSnapshot>("browser_snapshot", { sessionId: browserSessionId })
      .then((snapshot) => {
        if (cancelled) return;
        setBrowserSnapshot(snapshot);
        setBrowserUrlInput(presentBrowserUrl(snapshot.url));
        setBrowserLoadError(null);
      })
      .catch((error) => {
        if (cancelled) return;
        setBrowserSessionId(null);
        setBrowserSnapshot(null);
        setBrowserLiveState(null);
        resetBrowserLiveFrame();
        setBrowserLiveConnected(false);
        setBrowserLoadError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!cancelled) {
          setBrowserLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [desktopStateHydrated, browserOpen, browserUsingEmbeddedPreview, browserSessionId, browserSnapshot, browserLiveState]);

  useEffect(() => {
    if (!browserOpen || !browserSessionId || browserUsingEmbeddedPreview) {
      closeBrowserLiveSocket();
      resetBrowserLiveFrame();
      setBrowserLiveConnected(false);
      return;
    }

    resetBrowserLiveFrame();
    const wsUrl = browserSnapshot?.live_ws_url || browserLiveState?.live_ws_url || `${DEFAULT_BROWSER_LIVE_WS_BASE}/${browserSessionId}`;
    const socket = new WebSocket(wsUrl);
    browserLiveSocketRef.current = socket;
    setBrowserLiveConnected(false);
    setBrowserLiveError(null);

    socket.onopen = () => {
      if (browserLiveSocketRef.current !== socket) return;
      setBrowserLiveConnected(true);
      sendBrowserLiveMessage({ type: "focus" });
    };

    socket.onmessage = (event) => {
      if (browserLiveSocketRef.current !== socket) return;
      try {
        const message = JSON.parse(String(event.data)) as
          | { type: "frame"; data: string; format?: string }
          | { type: "state"; url: string; title: string; can_go_back: boolean; can_go_forward: boolean; viewport_width: number; viewport_height: number; session_id: string; live_ws_url?: string | null; remote_desktop_url?: string | null; }
          | { type: "clipboard_copy"; text: string }
          | { type: "error"; error: string };

        if (message.type === "frame") {
          queueBrowserLiveFrame(message.format, message.data);
          return;
        }
        if (message.type === "state") {
          setBrowserLiveState(message);
          return;
        }
        if (message.type === "error") {
          setBrowserLiveError(message.error);
          return;
        }
        if (message.type === "clipboard_copy") {
          if (typeof message.text === "string" && message.text.length > 0) {
            void navigator.clipboard?.writeText?.(message.text).catch(() => {});
          }
        }
      } catch (error) {
        setBrowserLiveError(error instanceof Error ? error.message : String(error));
      }
    };

    socket.onerror = () => {
      if (browserLiveSocketRef.current !== socket) return;
      setBrowserLiveError("Live browser connection failed.");
    };

    socket.onclose = () => {
      if (browserLiveSocketRef.current === socket) {
        browserLiveSocketRef.current = null;
      }
      setBrowserLiveConnected(false);
    };

    return () => {
      if (browserLiveSocketRef.current === socket) {
        browserLiveSocketRef.current = null;
      }
      socket.close();
    };
  }, [browserOpen, browserSessionId, browserSnapshot?.live_ws_url, browserUsingEmbeddedPreview]);

  useEffect(() => {
    if (!browserOpen || !browserSessionId || !browserLiveConnected || browserUsingEmbeddedRemoteDesktop) {
      browserLiveSizeRef.current = "";
      return;
    }

    const viewport = browserViewportRef.current;
    if (!viewport) return;

    let rafId: number | null = null;
    const sendResize = () => {
      rafId = null;
      const rect = viewport.getBoundingClientRect();
      const viewportSize = requestedBrowserViewportSize(rect.width, rect.height);
      const nextSize = `${viewportSize.width}x${viewportSize.height}`;
      if (browserLiveSizeRef.current === nextSize) {
        return;
      }
      browserLiveSizeRef.current = nextSize;
      sendBrowserLiveMessage({
        type: "resize",
        width: viewportSize.width,
        height: viewportSize.height,
      });
    };

    const scheduleResize = () => {
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
      }
      rafId = window.requestAnimationFrame(sendResize);
    };

    scheduleResize();
    const observer = new ResizeObserver(() => {
      scheduleResize();
    });
    observer.observe(viewport);

    return () => {
      observer.disconnect();
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
      }
    };
  }, [browserOpen, browserSessionId, browserLiveConnected, browserUsingEmbeddedRemoteDesktop]);

  function browserViewportPoint(clientX: number, clientY: number) {
    const target = browserLiveConnected ? browserViewportRef.current : browserLiveImageRef.current;
    if (!target) return null;
    const rect = target.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const relativeX = Math.min(Math.max(clientX - rect.left, 0), rect.width);
    const relativeY = Math.min(Math.max(clientY - rect.top, 0), rect.height);
    return {
      x: (relativeX / rect.width) * browserViewportWidth,
      y: (relativeY / rect.height) * browserViewportHeight,
    };
  }

  function queueBrowserMouseMove(x: number, y: number) {
    browserLiveMovePendingRef.current = { x, y };
    if (browserLiveMoveRafRef.current !== null) {
      return;
    }
    browserLiveMoveRafRef.current = window.requestAnimationFrame(() => {
      browserLiveMoveRafRef.current = null;
      const point = browserLiveMovePendingRef.current;
      browserLiveMovePendingRef.current = null;
      if (!point) return;
      sendBrowserLiveMessage({ type: "mouse_move", x: point.x, y: point.y });
    });
  }

  function handleBrowserViewportMouseMove(e: ReactMouseEvent<HTMLElement>) {
    if (!browserLiveConnected) return;
    const point = browserViewportPoint(e.clientX, e.clientY);
    if (!point) return;
    queueBrowserMouseMove(point.x, point.y);
  }

  function handleBrowserViewportMouseDown(e: ReactMouseEvent<HTMLElement>) {
    if (!browserLiveConnected) return;
    const point = browserViewportPoint(e.clientX, e.clientY);
    if (!point) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.focus();
    sendBrowserLiveMessage({
      type: "mouse_down",
      x: point.x,
      y: point.y,
      button: e.button === 2 ? "right" : e.button === 1 ? "middle" : "left",
    });
  }

  function handleBrowserViewportMouseUp(e: ReactMouseEvent<HTMLElement>) {
    if (!browserLiveConnected) return;
    const point = browserViewportPoint(e.clientX, e.clientY);
    if (!point) return;
    e.preventDefault();
    e.stopPropagation();
    sendBrowserLiveMessage({
      type: "mouse_up",
      x: point.x,
      y: point.y,
      button: e.button === 2 ? "right" : e.button === 1 ? "middle" : "left",
    });
  }

  function handleBrowserViewportWheel(e: ReactWheelEvent<HTMLElement>) {
    if (!browserLiveConnected) return;
    const point = browserViewportPoint(e.clientX, e.clientY);
    if (!point) return;
    e.preventDefault();
    sendBrowserLiveMessage({
      type: "wheel",
      x: point.x,
      y: point.y,
      deltaX: e.deltaX,
      deltaY: e.deltaY,
    });
  }

  function handleBrowserViewportPaste(e: ReactClipboardEvent<HTMLElement>) {
    if (!browserLiveConnected) return;
    const text = e.clipboardData.getData("text/plain");
    if (!text) return;
    e.preventDefault();
    e.stopPropagation();
    sendBrowserLiveMessage({ type: "paste", text });
  }

  function handleBrowserViewportCopy(e: ReactClipboardEvent<HTMLElement>) {
    if (!browserLiveConnected) return;
    e.preventDefault();
    e.stopPropagation();
    sendBrowserLiveMessage({ type: "copy_request" });
  }

  async function handleBrowserViewportKeyDown(e: ReactKeyboardEvent<HTMLElement>) {
    if (!browserLiveConnected) return;
    e.preventDefault();
    e.stopPropagation();
    const usesPrimaryModifier = e.metaKey || e.ctrlKey;
    const normalizedKey = e.key.toLowerCase();
    if (usesPrimaryModifier && !e.altKey) {
      if (normalizedKey === "v") {
        const text = await navigator.clipboard?.readText?.().catch(() => "") ?? "";
        if (text) {
          sendBrowserLiveMessage({ type: "paste", text });
        }
        return;
      }
      if (normalizedKey === "c") {
        sendBrowserLiveMessage({ type: "copy_request" });
        return;
      }
    }
    sendBrowserLiveMessage({
      type: "key",
      key: e.key,
      code: e.code,
      text: e.key.length === 1 ? e.key : "",
      altKey: e.altKey,
      ctrlKey: e.ctrlKey,
      metaKey: e.metaKey,
      shiftKey: e.shiftKey,
    });
  }

  function browserRequestedViewportSize() {
    const liveViewport = browserViewportRef.current?.getBoundingClientRect();
    if (liveViewport && liveViewport.width > 0 && liveViewport.height > 0) {
      return requestedBrowserViewportSize(liveViewport.width, liveViewport.height);
    }
    return requestedBrowserViewportSize(
      browserSize.w,
      browserSize.h
        - BROWSER_APP_WINDOW_TITLEBAR_HEIGHT
        - BROWSER_TOOLBAR_HEIGHT
        - BROWSER_DETAILS_PANEL_HEIGHT,
    );
  }

  async function navigateBrowser(input: string) {
    const next = normalizeBrowserUrl(input);
    if (!next) return;
    if (isTrustedLocalPreviewUrl(next)) {
      setBrowserEmbeddedPreview((prev) => ({
        url: next,
        title: prev?.title ?? null,
      }));
      setBrowserUrlInput(presentBrowserUrl(next));
      setBrowserLoadError(null);
      setBrowserLoading(false);
      return;
    }

    setBrowserEmbeddedPreview(null);
    setBrowserLoadError(null);
    setBrowserLoading(true);
    try {
      let snapshot: BrowserSnapshot;
      if (!browserSessionId) {
        const viewport = browserRequestedViewportSize();
        snapshot = await invoke<BrowserSnapshot>("browser_session_create", {
          url: next,
          viewportWidth: viewport.width,
          viewportHeight: viewport.height,
        });
        setBrowserSessionId(snapshot.session_id);
      } else {
        snapshot = await invoke<BrowserSnapshot>("browser_navigate", { sessionId: browserSessionId, url: next });
      }
      setBrowserSnapshot(snapshot);
      setBrowserUrlInput(presentBrowserUrl(snapshot.url));
    } catch (e) {
      setBrowserLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setBrowserLoading(false);
    }
  }

  async function goBrowserBack() {
    if (browserUsingEmbeddedPreview) {
      try {
        await goEmbeddedPreviewBack();
      } catch (e) {
        setBrowserLoadError(e instanceof Error ? e.message : String(e));
      }
      return;
    }
    if (!browserSessionId) return;
    setBrowserLoadError(null);
    setBrowserLoading(true);
    try {
      const snapshot = await invoke<BrowserSnapshot>("browser_back", { sessionId: browserSessionId });
      setBrowserSnapshot(snapshot);
      setBrowserUrlInput(presentBrowserUrl(snapshot.url));
    } catch (e) {
      setBrowserLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setBrowserLoading(false);
    }
  }

  async function goBrowserForward() {
    if (browserUsingEmbeddedPreview) {
      try {
        await goEmbeddedPreviewForward();
      } catch (e) {
        setBrowserLoadError(e instanceof Error ? e.message : String(e));
      }
      return;
    }
    if (!browserSessionId) return;
    setBrowserLoadError(null);
    setBrowserLoading(true);
    try {
      const snapshot = await invoke<BrowserSnapshot>("browser_forward", { sessionId: browserSessionId });
      setBrowserSnapshot(snapshot);
      setBrowserUrlInput(presentBrowserUrl(snapshot.url));
    } catch (e) {
      setBrowserLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setBrowserLoading(false);
    }
  }

  async function reloadBrowser() {
    if (browserUsingEmbeddedPreview) {
      try {
        await reloadEmbeddedPreview();
      } catch (e) {
        setBrowserLoadError(e instanceof Error ? e.message : String(e));
      }
      return;
    }
    if (!browserSessionId) {
      await navigateBrowser(browserUrlInput || DEFAULT_BROWSER_URL);
      return;
    }
    setBrowserLoadError(null);
    setBrowserLoading(true);
    try {
      const snapshot = await invoke<BrowserSnapshot>("browser_reload", { sessionId: browserSessionId });
      setBrowserSnapshot(snapshot);
      setBrowserUrlInput(presentBrowserUrl(snapshot.url));
    } catch (e) {
      setBrowserLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setBrowserLoading(false);
    }
  }

  async function clickBrowserElement(
    element: BrowserSnapshot["interactive_elements"][number]
  ) {
    if (!browserSessionId || browserLoading || browserClickingId) return;
    setBrowserLoadError(null);
    setBrowserClickingId(element.id);
    try {
      const snapshot = await invoke<BrowserSnapshot>("browser_click", {
        sessionId: browserSessionId,
        x: element.x + element.width / 2,
        y: element.y + element.height / 2,
      });
      setBrowserSnapshot(snapshot);
      setBrowserUrlInput(presentBrowserUrl(snapshot.url));
    } catch (e) {
      setBrowserLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setBrowserClickingId(null);
    }
  }

  async function closeBrowserWindow() {
    const committedTabs = commitActiveBrowserTabState(browserTabs);
    const sessionIds = committedTabs
      .map((tab) => tab.sessionId)
      .filter((value): value is string => typeof value === "string" && value.length > 0);
    const nextTab = createBrowserTabState();
    closeBrowserLiveSocket();
    resetBrowserLiveFrame();
    setBrowserOpen(false);
    setBrowserTabs([nextTab]);
    setActiveBrowserTabId(nextTab.id);
    setBrowserSnapshot(null);
    setBrowserLiveState(null);
    setBrowserLiveConnected(false);
    setBrowserLiveError(null);
    setBrowserSessionId(null);
    setBrowserEmbeddedPreview(null);
    setBrowserUrlInput(DEFAULT_BROWSER_URL);
    setBrowserLoading(false);
    setBrowserClickingId(null);
    setBrowserLoadError(null);
    for (const sessionId of sessionIds) {
      try {
        await invoke("browser_session_close", { sessionId });
      } catch {
        // Ignore close errors; session cleanup is best-effort.
      }
    }
  }

  async function openBrowserExternally(target?: string) {
    const rawTarget = browserUsingEmbeddedPreview
      ? browserEmbeddedPreview?.url || target || browserCurrentUrl
      : target ?? browserCurrentUrl;
    const url = normalizeBrowserUrl(rawTarget);
    if (!url) return;
    try {
      await open(url);
    } catch (e) {
      setBrowserLoadError(`Failed to open browser externally: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ── File browser logic ──────────────────────────────────────────────

  const fetchFiles = useCallback(async (path: string, options?: { silent?: boolean }) => {
    const silent = options?.silent === true;
    const requestSeq = filesFetchSeqRef.current + 1;
    filesFetchSeqRef.current = requestSeq;
    if (!silent) {
      filesLoadingSeqRef.current = requestSeq;
      setLoading(true);
      setError(null);
    }
    try {
      const result = await invoke<WorkspaceFileEntry[]>("list_workspace_files", { path });
      if (requestSeq !== filesFetchSeqRef.current) return;
      const filtered = result.filter((entry) => !(path === "" && HIDDEN_FILES.has(entry.name)));
      filtered.sort((a, b) => a.is_directory !== b.is_directory ? (a.is_directory ? -1 : 1) : a.name.localeCompare(b.name));
      setEntries((prev) => (workspaceEntriesEqual(prev, filtered) ? prev : filtered));
      if (selected && !filtered.some((entry) => entry.path === selected)) {
        setSelected(null);
      }
      if (!silent) {
        setError(null);
      }
    } catch (e) {
      if (requestSeq !== filesFetchSeqRef.current) return;
      if (!silent) {
        setError(e instanceof Error ? e.message : String(e));
        setEntries([]);
      }
    } finally {
      if (!silent && requestSeq === filesLoadingSeqRef.current) {
        setLoading(false);
      }
    }
  }, [selected]);

  useEffect(() => { if (finderOpen) fetchFiles(currentPath); }, [currentPath, fetchFiles, finderOpen]);
  useEffect(() => {
    if (!finderOpen) return;
    const refreshCurrentFolder = () => {
      if (document.hidden) return;
      void fetchFiles(currentPath, { silent: true });
    };
    const intervalId = window.setInterval(refreshCurrentFolder, WORKSPACE_FOLDER_REFRESH_MS);
    const handleVisibilityChange = () => {
      if (!document.hidden) {
        void fetchFiles(currentPath, { silent: true });
      }
    };
    window.addEventListener("focus", refreshCurrentFolder);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", refreshCurrentFolder);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [currentPath, fetchFiles, finderOpen]);
  useEffect(() => { const h = () => setContextMenu(null); window.addEventListener("click", h); return () => window.removeEventListener("click", h); }, []);

  function openFolder(path: string) { setCurrentPath(path); setHistory([path]); setHistoryIndex(0); setFinderOpen(true); setSelected(null); }
  function navigateTo(path: string) { const h = history.slice(0, historyIndex + 1); h.push(path); setHistory(h); setHistoryIndex(h.length - 1); setCurrentPath(path); setSelected(null); }
  function goBack() { if (historyIndex > 0) { setHistoryIndex(historyIndex - 1); setCurrentPath(history[historyIndex - 1]); setSelected(null); } }
  function goForward() { if (historyIndex < history.length - 1) { setHistoryIndex(historyIndex + 1); setCurrentPath(history[historyIndex + 1]); setSelected(null); } }

  function handleEntryClick(entry: WorkspaceFileEntry, e: React.MouseEvent) { e.stopPropagation(); setSelected(entry.path); }
  function handleEntryDoubleClick(entry: WorkspaceFileEntry) {
    if (entry.is_directory) {
      navigateTo(entry.path);
      return;
    }
    const ext = entry.name.split(".").pop()?.toLowerCase() || "";
    if (HTML_EXTS.has(ext)) {
      void openWorkspaceFileInBrowser(entry);
      return;
    }
    handleView(entry);
  }
  function handleContextMenuEntry(entry: WorkspaceFileEntry, e: React.MouseEvent) { e.preventDefault(); e.stopPropagation(); setSelected(entry.path); setContextMenu({ x: e.clientX, y: e.clientY, entry }); }

  async function openWorkspaceFileInBrowser(entry: WorkspaceFileEntry) {
    if (entry.is_directory) return;
    const ext = entry.name.split(".").pop()?.toLowerCase() || "";
    if (!HTML_EXTS.has(ext)) return;
    const targetUrl = workspaceBrowserUrl(entry.path);
    if (!browserOpen) {
      setBrowserOpen(true);
    }
    focusWindow("browser");
    if (isTrustedLocalPreviewUrl(targetUrl)) {
      setBrowserEmbeddedPreview({
        url: targetUrl,
        title: entry.name,
      });
      setBrowserUrlInput(presentBrowserUrl(targetUrl));
      setBrowserLoadError(null);
      return;
    }
    await navigateBrowser(targetUrl);
  }

  function showWorkspacePathInDesktop(path: string, looksLikeFile: boolean) {
    if (!path) {
      openFolder("");
      return;
    }
    if (looksLikeFile) {
      openFolder(workspacePathParent(path));
      setSelected(path);
      return;
    }
    openFolder(path);
  }

  async function previewWorkspacePath(path: string) {
    await handleView({
      name: workspacePathName(path),
      path,
      is_directory: false,
      size: 0,
      modified_at: 0,
    });
  }

  async function openWorkspacePathInBrowser(path: string) {
    await openWorkspaceFileInBrowser({
      name: workspacePathName(path),
      path,
      is_directory: false,
      size: 0,
      modified_at: 0,
    });
  }

  async function openBrowserUrlInDesktop(targetUrl: string) {
    if (!browserOpen) {
      setBrowserOpen(true);
    }
    focusWindow("browser");
    if (isTrustedLocalPreviewUrl(targetUrl)) {
      setBrowserEmbeddedPreview((prev) => ({
        url: targetUrl,
        title: prev?.title ?? "Entropic Preview",
      }));
      setBrowserUrlInput(presentBrowserUrl(targetUrl));
      setBrowserLoadError(null);
      return;
    }
    setBrowserUrlInput(presentBrowserUrl(targetUrl));
    await navigateBrowser(targetUrl);
  }

  function consumeDesktopHandoff(): DesktopHandoff | null {
    try {
      const raw = window.localStorage.getItem(DESKTOP_HANDOFF_STORAGE_KEY);
      if (!raw) return null;
      window.localStorage.removeItem(DESKTOP_HANDOFF_STORAGE_KEY);
      return JSON.parse(raw) as DesktopHandoff;
    } catch {
      return null;
    }
  }

  async function applyDesktopHandoff(handoff: DesktopHandoff | null) {
    if (!handoff || typeof handoff.action !== "string") {
      return;
    }
    if (handoff.action === "browser" && typeof handoff.url === "string" && handoff.url.trim()) {
      await openBrowserUrlInDesktop(handoff.url);
      return;
    }
    if (typeof handoff.path !== "string") {
      return;
    }
    const looksLikeFile =
      typeof handoff.looksLikeFile === "boolean"
        ? handoff.looksLikeFile
        : Boolean(handoff.path && workspacePathName(handoff.path).includes("."));
    if (handoff.action === "browser") {
      await openWorkspacePathInBrowser(handoff.path);
      return;
    }
    if (handoff.action === "preview") {
      showWorkspacePathInDesktop(handoff.path, true);
      await previewWorkspacePath(handoff.path);
      return;
    }
    showWorkspacePathInDesktop(handoff.path, looksLikeFile);
  }

  useEffect(() => {
    void applyDesktopHandoff(consumeDesktopHandoff());
  }, []);

  function openBrowserWindow(targetUrl = browserCurrentUrl) {
    if (!browserOpen) {
      setBrowserOpen(true);
    }
    focusWindow("browser");
    setBrowserUrlInput(presentBrowserUrl(targetUrl));
    if (isTrustedLocalPreviewUrl(targetUrl)) {
      setBrowserEmbeddedPreview((prev) => ({
        url: targetUrl,
        title: prev?.title ?? "Entropic Preview",
      }));
      return;
    }
    if (browserSessionId && targetUrl !== browserCurrentUrl) {
      void navigateBrowser(targetUrl);
    }
  }

  async function copyDesktopPath(path: string) {
    try {
      await navigator.clipboard?.writeText?.(path);
    } catch (e) {
      setError(`Copy failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function handleView(entry: WorkspaceFileEntry) {
    const ext = entry.name.split(".").pop()?.toLowerCase() || "";
    try {
      if (IMAGE_EXTS.has(ext)) {
        const base64 = await invoke<string>("read_workspace_file_base64", { path: entry.path });
        const mime =
          ext === "svg"
            ? "image/svg+xml"
            : ext === "jpg" || ext === "jpeg"
              ? "image/jpeg"
              : `image/${ext}`;
        setPreview({ kind: "image", name: entry.name, dataUrl: `data:${mime};base64,${base64}` });
        return;
      }
      if (BINARY_EXTS.has(ext)) {
        setPreview({ kind: "binary", name: entry.name, size: entry.size });
        return;
      }
      const c = await invoke<string>("read_workspace_file", { path: entry.path });
      setPreview({ kind: "text", name: entry.name, content: c });
    } catch (e) {
      setError(`Failed to read: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function handleDelete(entry: WorkspaceFileEntry) {
    if (!confirm(`Move "${entry.name}" to Trash?`)) return;
    try { await invoke("delete_workspace_file", { path: entry.path }); setSelected(null); fetchFiles(currentPath); }
    catch (e) { setError(`Delete failed: ${e instanceof Error ? e.message : String(e)}`); }
  }

  function handleCreateFolder(basePath?: string) {
    const root = typeof basePath === "string" ? basePath : currentPath;
    setCreateFolderBasePath(root);
    setCreateFolderName("");
    setCreateFolderOpen(true);
    setContextMenu(null);
  }

  useEffect(() => {
    if (!createFolderOpen) return;
    const id = window.setTimeout(() => createFolderInputRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [createFolderOpen]);

  async function submitCreateFolder() {
    const trimmedName = createFolderName.trim();
    if (!trimmedName || creatingFolder) return;
    const root = createFolderBasePath;
    setCreatingFolder(true);
    setError(null);
    try {
      try {
        await invoke<WorkspaceFileEntry>("create_workspace_directory", { parentPath: root, name: trimmedName });
      } catch {
        const fallbackPath = root ? `${root}/${trimmedName}` : trimmedName;
        await invoke<WorkspaceFileEntry[]>("list_workspace_files", { path: fallbackPath });
      }
      setCreateFolderOpen(false);
      setCreateFolderName("");
      if (finderOpen) await fetchFiles(currentPath);
    }
    catch (e) { setError(`Failed to create folder: ${e instanceof Error ? e.message : String(e)}`); }
    finally { setCreatingFolder(false); }
  }

  // ── Drag & Drop files ───────────────────────────────────────────────

  function handleDragOver(e: React.DragEvent) { e.preventDefault(); e.stopPropagation(); if (e.dataTransfer.types.includes("Files")) { setDragOver(true); e.dataTransfer.dropEffect = "copy"; } }
  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault(); e.stopPropagation();
    const rect = containerRef.current?.getBoundingClientRect();
    if (rect) { const { clientX: cx, clientY: cy } = e; if (cx < rect.left || cx > rect.right || cy < rect.top || cy > rect.bottom) setDragOver(false); }
  }

  async function uploadFiles(files: globalThis.File[], destPath: string) {
    setUploading(true); setError(null);
    try {
      for (const file of files) {
        const buf = await file.arrayBuffer(); const bytes = new Uint8Array(buf);
        let binary = ""; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
        await invoke("upload_workspace_file", { fileName: file.name, base64: btoa(binary), destPath });
      }
      if (finderOpen) fetchFiles(currentPath);
    } catch (err) { setError(`Upload failed: ${err instanceof Error ? err.message : String(err)}`); }
    finally { setUploading(false); }
  }

  async function handleDrop(e: React.DragEvent) { e.preventDefault(); e.stopPropagation(); setDragOver(false); const f = Array.from(e.dataTransfer.files); if (f.length > 0) uploadFiles(f, finderOpen ? currentPath : ""); }
  async function handleFileInputChange(e: React.ChangeEvent<HTMLInputElement>) { const f = e.target.files?.[0]; if (!f) return; e.target.value = ""; uploadFiles([f], finderOpen ? currentPath : ""); }

  // ── Chat ────────────────────────────────────────────────────────────

  function createNewChatSession() {
    setChatRequestedSession("__new__");
    setChatRequestedAction(null);
    setChatOpen(true);
    focusWindow("chat");
  }

  function selectChatSession(sessionKey: string) {
    setChatRequestedSession(sessionKey);
    setChatRequestedAction(null);
    setChatCurrentSession(sessionKey);
    setChatOpen(true);
    focusWindow("chat");
  }

  function requestChatSessionAction(
    action:
      | { type: "delete"; key: string }
      | { type: "pin"; key: string; pinned: boolean }
      | { type: "rename"; key: string; label: string }
  ) {
    setChatRequestedAction({ id: crypto.randomUUID(), ...action });
    setChatRequestedSession(action.key);
    setChatOpen(true);
    focusWindow("chat");
  }

  function handleDesktopChatNavigate(page: "chat" | "store" | "skills" | "channels" | "files" | "tasks" | "jobs" | "settings" | "billing") {
    switch (page) {
      case "chat":
        setChatOpen(true);
        focusWindow("chat");
        return;
      case "store":
        setPluginsOpen(true);
        focusWindow("plugins");
        return;
      case "skills":
        setSkillsOpen(true);
        focusWindow("skills");
        return;
      case "channels":
        setChannelsOpen(true);
        focusWindow("channels");
        return;
      case "files":
        {
          const handoff = consumeDesktopHandoff();
          if (handoff) {
            void applyDesktopHandoff(handoff);
            return;
          }
        }
        setFinderOpen(true);
        focusWindow("finder");
        return;
      case "tasks":
        setTasksOpen(true);
        focusWindow("tasks");
        return;
      case "jobs":
        setJobsOpen(true);
        focusWindow("jobs");
        return;
      case "settings":
        setSettingsOpen(true);
        focusWindow("settings");
        return;
      case "billing":
        setBillingOpen(true);
        focusWindow("billing");
        return;
      default:
    }
  }

  // ── Computed ─────────────────────────────────────────────────────────

  const pathSegments = currentPath.split("/").filter(Boolean);
  const folderName = pathSegments.length > 0 ? pathSegments[pathSegments.length - 1] : "Workspace";
  const itemCount = entries.length;
  const wallpaperCss = getWallpaperCss();
  const currentWp = getWallpaperById(wallpaperId);
  const isWpImage = (wallpaperId === "custom" && customWallpaper) || currentWp?.type === "photo";
  const highestWindowZ = Math.max(...Object.values(windowZ));
  const normalizedChatQuery = chatSessionQuery.trim().toLowerCase();
  const sortedChatSessions = sortDesktopChatSessions(chatSessions);
  const activeChatSession = chatCurrentSession
    ? chatSessions.find((session) => session.key === chatCurrentSession) || null
    : null;
  const visibleChatSessions = normalizedChatQuery
    ? sortedChatSessions.filter((session) => (
      desktopChatSessionTitle(session).toLowerCase().includes(normalizedChatQuery)
    ))
    : sortedChatSessions;
  const browserWindowZ = windowZ.browser ?? DEFAULT_WINDOW_Z.browser;
  const browserNeedsFocusOverlay = browserWindowZ < highestWindowZ;

  useEffect(() => {
    return () => {
      void hideEmbeddedPreviewWebview().catch(() => {});
    };
  }, []);

  useEffect(() => {
    let frameId: number | null = null;
    let cancelled = false;

    const syncOrHide = async () => {
      if (!browserUsingEmbeddedPreview || !browserEmbeddedPreview?.url) {
        browserEmbeddedPreviewSyncKeyRef.current = "";
        try {
          await hideEmbeddedPreviewWebview();
        } catch {
          // Ignore embedded preview hide failures during teardown.
        }
        return;
      }

      const viewport = browserViewportRef.current;
      if (!browserOpen || browserNeedsFocusOverlay || !viewport) {
        const hiddenKey = `${browserEmbeddedPreview.url}|hidden`;
        if (browserEmbeddedPreviewSyncKeyRef.current === hiddenKey) {
          return;
        }
        browserEmbeddedPreviewSyncKeyRef.current = hiddenKey;
        try {
          await syncEmbeddedPreviewWebview({
            url: browserEmbeddedPreview.url,
            x: 0,
            y: 0,
            width: 1,
            height: 1,
            visible: false,
          });
        } catch {
          // Ignore embedded preview hide failures while the browser is backgrounded.
        }
        return;
      }

      const rect = viewport.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        return;
      }

      const nextKey = [
        browserEmbeddedPreview.url,
        Math.round(rect.left),
        Math.round(rect.top),
        Math.round(rect.width),
        Math.round(rect.height),
      ].join("|");
      if (browserEmbeddedPreviewSyncKeyRef.current === nextKey) {
        return;
      }
      browserEmbeddedPreviewSyncKeyRef.current = nextKey;

      try {
        const resolved = await syncEmbeddedPreviewWebview({
          url: browserEmbeddedPreview.url,
          x: rect.left,
          y: rect.top,
          width: rect.width,
          height: rect.height,
          visible: true,
        });
        if (cancelled) return;
        setBrowserEmbeddedPreview((prev) => {
          if (!prev) return prev;
          if (prev.url === resolved) return prev;
          return { ...prev, url: resolved };
        });
        setBrowserUrlInput(presentBrowserUrl(resolved));
        setBrowserLoadError(null);
      } catch (error) {
        if (cancelled) return;
        setBrowserLoadError(error instanceof Error ? error.message : String(error));
      }
    };

    frameId = window.requestAnimationFrame(() => {
      void syncOrHide();
    });

    return () => {
      cancelled = true;
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
    };
  }, [
    browserOpen,
    browserUsingEmbeddedPreview,
    browserEmbeddedPreview,
    browserNeedsFocusOverlay,
    browserPos,
    browserSize,
    desktopBounds.width,
    desktopBounds.height,
  ]);

  // ═══════════════════════════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════════════════════════

  return (
    <div className="h-full w-full min-w-0 flex flex-col select-none relative overflow-hidden">
      {/* Top toolbar */}
      <div className="absolute top-0 left-0 right-0 z-20">
        <div
          className="flex items-center justify-between gap-2 px-3 py-1.5"
          style={{
            background: "rgba(255,255,255,0.9)",
            backdropFilter: "blur(10px)",
            WebkitBackdropFilter: "blur(10px)",
            borderBottom: "1px solid rgba(0,0,0,0.08)",
            boxShadow: "0 4px 12px rgba(0,0,0,0.05)",
          }}
        >
          <div className="flex items-center gap-2 flex-shrink-0">
            <span className="text-[12px] font-bold text-[var(--text-primary)]">
              Home
            </span>
            <div
              className="flex items-center gap-1.5 text-[10px] px-2 py-0.5 rounded-full border border-black/5 bg-black/5 flex-shrink-0"
            >
              <span
                className="h-1.5 w-1.5 rounded-full"
                style={{
                  background: gatewayRunning
                    ? "#22c55e"
                    : isTogglingGateway
                    ? "#f59e0b"
                    : "#ef4444",
                }}
              />
              <span className="text-[var(--text-secondary)] font-medium">
                {gatewayRunning ? "Online" : isTogglingGateway ? "Starting" : "Offline"}
              </span>
            </div>
          </div>

          <div className="flex-1" />
        </div>
      </div>

      {/* Main area */}
      <div className="flex-1 min-w-0 flex overflow-hidden">

        {/* Desktop area */}
        <div
          ref={containerRef}
          className="flex-1 min-w-0 relative overflow-hidden"
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onContextMenu={(e) => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY }); }}
          onClick={() => { setSelected(null); setContextMenu(null); setShowWallpaperPicker(false); }}
        >
          {/* Wallpaper */}
          <div className="absolute inset-0" style={isWpImage ? { backgroundImage: wallpaperCss, backgroundSize: "cover", backgroundPosition: "center" } : { background: wallpaperCss }} />

          {/* Desktop icons */}
          <div className="relative flex-1 pt-12 px-0 pb-0 h-full">
            {(() => {
              const icon = desktopIcons.workspace;
              return (
                <div
                  className="absolute flex flex-col items-center w-20 p-2 rounded-xl cursor-grab active:cursor-grabbing transition-all"
                  style={{
                    left: icon?.x ?? 28,
                    top: icon?.y ?? 72,
                    background: selected === "__user_folder" ? "rgba(255,255,255,0.18)" : "transparent",
                  }}
                  onMouseDown={(e) => handleIconMouseDown("workspace", e)}
                  onClick={(e) => {
                    if (iconClickGuardRef.current) return;
                    e.stopPropagation();
                    setSelected("__user_folder");
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setSelected("__user_folder");
                    setContextMenu({ x: e.clientX, y: e.clientY });
                  }}
                  onDoubleClick={() => openFolder("")}
                >
                  <FolderIcon size={56} selected={selected === "__user_folder"} />
                  <span
                    className="text-[11px] text-center leading-tight mt-1 w-full truncate"
                    style={{
                      color: "white",
                      textShadow: "0 1px 3px rgba(0,0,0,0.6)",
                      fontWeight: selected === "__user_folder" ? 600 : 400,
                    }}
                  >
                    {agentName}&apos;s Files
                  </span>
                </div>
              );
            })()}
          </div>

          {/* Drag overlay */}
          {dragOver && (
            <div className="absolute inset-0 z-20 flex items-center justify-center pointer-events-none animate-fade-in" style={{ background: "rgba(0,0,0,0.3)", backdropFilter: "blur(8px)" }}>
              <div className="rounded-3xl px-16 py-12 text-center" style={{ border: "3px dashed rgba(255,255,255,0.7)", background: "rgba(255,255,255,0.08)", boxShadow: "0 0 80px rgba(147,51,234,0.12)" }}>
                <div className="w-20 h-20 mx-auto mb-4 rounded-2xl flex items-center justify-center" style={{ background: "rgba(255,255,255,0.12)" }}>
                  <ArrowUp className="w-10 h-10 animate-bounce" style={{ color: "white" }} />
                </div>
                <p className="text-xl font-semibold" style={{ color: "white", textShadow: "0 2px 8px rgba(0,0,0,0.4)" }}>Drop files to upload</p>
                <p className="text-sm mt-2" style={{ color: "rgba(255,255,255,0.7)" }}>Files will be added to your workspace</p>
              </div>
            </div>
          )}

          {/* Upload spinner */}
          {uploading && (
            <div className="absolute inset-0 z-[60] flex items-center justify-center" style={{ background: "rgba(0,0,0,0.3)", backdropFilter: "blur(4px)" }}>
              <div className="text-center">
                <div className="w-10 h-10 rounded-full border-2 border-white border-t-transparent animate-spin mx-auto mb-3" />
                <p className="text-sm font-medium text-white">Uploading...</p>
              </div>
            </div>
          )}

          {/* ── FLOATING FINDER WINDOW (draggable) ────────────────────── */}
          {finderOpen && (
            <div
              className="absolute flex flex-col rounded-xl overflow-hidden animate-scale-in"
              style={{
                top: finderPos.y, left: finderPos.x,
                width: finderSize.w, height: finderSize.h,
                boxShadow: "0 22px 70px 4px rgba(0,0,0,0.56), 0 0 0 0.5px rgba(255,255,255,0.1)",
                border: "0.5px solid rgba(255,255,255,0.08)",
                zIndex: windowZ.finder ?? DEFAULT_WINDOW_Z.finder,
              }}
              onMouseDownCapture={() => focusWindow("finder")}
              onClick={(e) => e.stopPropagation()}
            >
              {/* Title bar — drag handle */}
              <div
                className="flex items-center px-3 py-2 flex-shrink-0 relative cursor-grab active:cursor-grabbing"
                style={{ background: "#2d2d2d", borderBottom: "1px solid #1a1a1a" }}
                onMouseDown={handleFinderDragStart}
              >
                <div className="flex items-center gap-2 z-10">
                  <button onClick={() => setFinderOpen(false)} className="w-3 h-3 rounded-full hover:opacity-80 group relative" style={{ background: "#ff5f57" }} title="Close">
                    <X className="w-2 h-2 absolute inset-0.5 opacity-0 group-hover:opacity-100 text-black/60" />
                  </button>
                  <div className="w-3 h-3 rounded-full" style={{ background: "#febc2e" }} />
                  <div className="w-3 h-3 rounded-full" style={{ background: "#28c840" }} />
                </div>
                <div className="flex items-center gap-0.5 ml-3 z-10">
                  <button onClick={goBack} disabled={historyIndex <= 0} className="p-1 rounded disabled:opacity-30 hover:bg-white/10"><ChevronLeft className="w-3.5 h-3.5" style={{ color: "#aaa" }} /></button>
                  <button onClick={goForward} disabled={historyIndex >= history.length - 1} className="p-1 rounded disabled:opacity-30 hover:bg-white/10"><ChevronRight className="w-3.5 h-3.5" style={{ color: "#aaa" }} /></button>
                </div>
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                  <div className="flex items-center gap-2">
                    {currentPath && <button onClick={() => navigateTo(pathSegments.slice(0, -1).join("/"))} className="pointer-events-auto p-0.5 rounded hover:bg-white/10"><ArrowUp className="w-3 h-3" style={{ color: "#888" }} /></button>}
                    <Folder className="w-3.5 h-3.5" style={{ color: "#54a3f7" }} />
                    <span className="text-xs font-medium" style={{ color: "#ccc" }}>{folderName}</span>
                  </div>
                </div>
                <div className="flex items-center gap-0.5 ml-auto z-10">
                  <button onClick={() => setViewMode("grid")} className="p-1 rounded" style={{ color: viewMode === "grid" ? "#fff" : "#666", background: viewMode === "grid" ? "rgba(255,255,255,0.1)" : "transparent" }}><LayoutGrid className="w-3.5 h-3.5" /></button>
                  <button onClick={() => setViewMode("list")} className="p-1 rounded" style={{ color: viewMode === "list" ? "#fff" : "#666", background: viewMode === "list" ? "rgba(255,255,255,0.1)" : "transparent" }}><List className="w-3.5 h-3.5" /></button>
                  <div className="w-px h-3.5 mx-1" style={{ background: "rgba(255,255,255,0.1)" }} />
                  <button onClick={() => handleCreateFolder(finderOpen ? currentPath : "")} className="p-1 rounded hover:bg-white/10"><Plus className="w-3.5 h-3.5" style={{ color: "#aaa" }} /></button>
                </div>
              </div>

              {/* Path bar */}
              <div className="flex items-center gap-0.5 px-3 py-1 text-[11px] flex-shrink-0 overflow-x-auto" style={{ background: "#252526", borderBottom: "1px solid #1a1a1a", color: "#888" }}>
                <button onClick={() => navigateTo("")} className="px-1.5 py-0.5 rounded hover:bg-white/10 flex-shrink-0" style={{ color: pathSegments.length === 0 ? "#ddd" : "#888" }}>Workspace</button>
                {pathSegments.map((seg, i) => {
                  const segPath = pathSegments.slice(0, i + 1).join("/");
                  return (
                    <span key={segPath} className="flex items-center gap-0.5 flex-shrink-0">
                      <ChevronRight className="w-3 h-3" style={{ color: "#555" }} />
                      <button onClick={() => navigateTo(segPath)} className="px-1.5 py-0.5 rounded hover:bg-white/10" style={{ color: i === pathSegments.length - 1 ? "#ddd" : "#888" }}>{seg}</button>
                    </span>
                  );
                })}
              </div>

              {/* File area */}
              <div
                className="flex-1 overflow-auto relative"
                onClick={() => { setSelected(null); setContextMenu(null); }}
                onDragOver={handleDragOver}
                onDrop={handleDrop}
                style={{ background: "#1e1e1e" }}
              >
                {loading && entries.length === 0 ? (
                  <div className="flex items-center justify-center h-full"><div className="text-center"><div className="w-8 h-8 rounded-full border-2 border-t-transparent animate-spin mx-auto mb-3" style={{ borderColor: "#555", borderTopColor: "transparent" }} /><p className="text-xs" style={{ color: "#888" }}>Loading...</p></div></div>
                ) : entries.length === 0 ? (
                  <div className="flex items-center justify-center h-full"><div className="text-center max-w-xs"><Folder className="w-16 h-16 mx-auto mb-4" style={{ color: "#54a3f7", opacity: 0.3 }} /><p className="text-sm font-medium mb-1" style={{ color: "#ddd" }}>This folder is empty</p><p className="text-xs mb-4" style={{ color: "#888" }}>Drag files here or click + to add</p><button onClick={() => fileInputRef.current?.click()} className="text-xs px-4 py-2 rounded-lg" style={{ background: "rgba(255,255,255,0.1)", color: "#ccc" }}>Choose Files</button></div></div>
                ) : viewMode === "grid" ? (
                  <div className="p-3 grid gap-1" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(84px, 1fr))" }}>
                    {entries.map((entry) => {
                      const Icon = getFileIcon(entry.name, entry.is_directory);
                      const iconColor = getFileColor(entry.name, entry.is_directory);
                      const isSel = selected === entry.path;
                      return (
                        <div key={entry.path} className="flex flex-col items-center p-2 rounded-lg cursor-default" style={{ background: isSel ? "rgba(59,130,246,0.2)" : "transparent" }} onClick={(e) => handleEntryClick(entry, e)} onDoubleClick={() => handleEntryDoubleClick(entry)} onContextMenu={(e) => handleContextMenuEntry(entry, e)}>
                          {entry.is_directory ? <div className="w-11 h-11 flex items-center justify-center mb-1"><FolderIcon size={44} selected={isSel} /></div> : <div className="w-11 h-11 flex items-center justify-center mb-1"><Icon className="w-8 h-8" style={{ color: iconColor }} strokeWidth={1.2} /></div>}
                          <span className="text-[10px] text-center leading-tight w-full px-0.5" style={{ color: isSel ? "#fff" : "#ccc", fontWeight: isSel ? 500 : 400, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", wordBreak: "break-all" }}>{entry.name}</span>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="flex flex-col">
                    <div className="flex items-center gap-3 px-4 py-1.5 text-[11px] font-medium sticky top-0 z-10" style={{ color: "#888", background: "#252526", borderBottom: "1px solid #1a1a1a" }}><span className="flex-1">Name</span><span className="w-28 text-right">Date Modified</span><span className="w-20 text-right">Size</span></div>
                    {entries.map((entry) => {
                      const Icon = getFileIcon(entry.name, entry.is_directory);
                      const iconColor = getFileColor(entry.name, entry.is_directory);
                      const isSel = selected === entry.path;
                      return (
                        <div key={entry.path} className="flex items-center gap-3 px-4 py-1.5 cursor-default" style={{ background: isSel ? "rgba(59,130,246,0.15)" : "transparent", borderBottom: "1px solid #2a2a2a" }} onClick={(e) => handleEntryClick(entry, e)} onDoubleClick={() => handleEntryDoubleClick(entry)} onContextMenu={(e) => handleContextMenuEntry(entry, e)}>
                          <Icon className="w-4 h-4 flex-shrink-0" style={{ color: iconColor }} />
                          <span className="flex-1 text-xs truncate" style={{ color: isSel ? "#fff" : "#ccc", fontWeight: isSel ? 500 : 400 }}>{entry.name}</span>
                          <span className="w-28 text-right text-[11px]" style={{ color: "#666" }}>{formatDate(entry.modified_at)}</span>
                          <span className="w-20 text-right text-[11px]" style={{ color: "#666" }}>{entry.is_directory ? "\u2014" : formatSize(entry.size)}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Status bar */}
              <div className="flex items-center justify-between px-3 py-1 flex-shrink-0 text-[11px]" style={{ background: "#252526", borderTop: "1px solid #1a1a1a", color: "#888" }}>
                <span>{itemCount} item{itemCount !== 1 ? "s" : ""}</span>
                <button onClick={() => fileInputRef.current?.click()} className="hover:underline" style={{ color: "#aaa" }}>Add files...</button>
              </div>
            </div>
          )}

          {/* Context menus */}
          {contextMenu && !contextMenu.entry && (
            <div className="fixed z-50 py-1 rounded-lg min-w-[180px] animate-fade-in" style={{ left: contextMenu.x, top: contextMenu.y, background: "rgba(30,30,30,0.9)", backdropFilter: "blur(20px)", border: "1px solid rgba(255,255,255,0.1)", boxShadow: "0 8px 32px rgba(0,0,0,0.4)" }} onClick={(e) => e.stopPropagation()}>
              <button className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-white/10 text-left text-white/80" onClick={() => { handleCreateFolder(finderOpen ? currentPath : ""); setContextMenu(null); }}><Plus className="w-3.5 h-3.5" />New Folder</button>
              <button className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-white/10 text-left text-white/80" onClick={() => { openBrowserWindow(); setContextMenu(null); }}><Globe className="w-3.5 h-3.5" />Open Browser</button>
              <button className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-white/10 text-left text-white/80" onClick={() => { openTerminalWindow(); setContextMenu(null); }}><Terminal className="w-3.5 h-3.5" />Open Terminal</button>
              <button className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-white/10 text-left text-white/80" onClick={() => { setShowWallpaperPicker(true); setContextMenu(null); }}><Image className="w-3.5 h-3.5" />Change Wallpaper</button>
              <button className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-white/10 text-left text-white/80" onClick={() => { fileInputRef.current?.click(); setContextMenu(null); }}><Plus className="w-3.5 h-3.5" />Add Files</button>
              <button className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-white/10 text-left text-white/80" onClick={() => { openFolder(""); setContextMenu(null); }}><Folder className="w-3.5 h-3.5" />Open Workspace</button>
            </div>
          )}
          {contextMenu && contextMenu.entry && (
            <div className="fixed z-[55] py-1 rounded-lg min-w-[160px] animate-fade-in" style={{ left: contextMenu.x, top: contextMenu.y, background: "rgba(30,30,30,0.95)", backdropFilter: "blur(20px)", border: "1px solid rgba(255,255,255,0.1)", boxShadow: "0 8px 32px rgba(0,0,0,0.5)" }} onClick={(e) => e.stopPropagation()}>
              <button className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-white/10 text-left text-white/80" onClick={() => { handleEntryDoubleClick(contextMenu.entry!); setContextMenu(null); }}><Folder className="w-3.5 h-3.5" style={{ color: "#888" }} />Open</button>
              {!contextMenu.entry.is_directory && HTML_EXTS.has(contextMenu.entry.name.split(".").pop()?.toLowerCase() || "") && (
                <button className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-white/10 text-left text-white/80" onClick={() => { void openWorkspaceFileInBrowser(contextMenu.entry!); setContextMenu(null); }}><Globe className="w-3.5 h-3.5" style={{ color: "#888" }} />Open in Browser</button>
              )}
              {!contextMenu.entry.is_directory && <button className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-white/10 text-left text-white/80" onClick={() => { handleView(contextMenu.entry!); setContextMenu(null); }}><Eye className="w-3.5 h-3.5" style={{ color: "#888" }} />Quick Look</button>}
              <button className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-white/10 text-left text-white/80" onClick={() => { void copyDesktopPath(contextMenu.entry!.path); setContextMenu(null); }}><FileText className="w-3.5 h-3.5" style={{ color: "#888" }} />Copy Path</button>
              <div className="my-1" style={{ borderTop: "1px solid rgba(255,255,255,0.08)" }} />
              <button className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-white/10 text-left" style={{ color: "#ff5f57" }} onClick={() => { handleDelete(contextMenu.entry!); setContextMenu(null); }}><Trash2 className="w-3.5 h-3.5" />Move to Trash</button>
            </div>
          )}

          {/* Wallpaper picker */}
          {showWallpaperPicker && (
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-40 p-4 rounded-xl animate-fade-in" style={{ background: "rgba(20,20,20,0.92)", backdropFilter: "blur(20px)", border: "1px solid rgba(255,255,255,0.1)", boxShadow: "0 12px 40px rgba(0,0,0,0.5)" }} onClick={(e) => e.stopPropagation()}>
              <p className="text-xs font-medium mb-2" style={{ color: "rgba(255,255,255,0.6)" }}>Scenic</p>
              <div className="grid grid-cols-4 gap-2 mb-3">
                {WALLPAPERS.filter((wp) => wp.type === "photo").map((wp) => (
                  <button key={wp.id} onClick={() => { saveWallpaper(wp.id, null); setShowWallpaperPicker(false); }} className="w-16 h-10 rounded-lg hover:scale-105 transition-transform overflow-hidden" style={{ backgroundImage: wp.thumbnail ? `url(${wp.thumbnail})` : wp.css, backgroundSize: "cover", backgroundPosition: "center", border: wallpaperId === wp.id ? "2px solid white" : "2px solid transparent", boxShadow: wallpaperId === wp.id ? "0 0 0 1px rgba(255,255,255,0.3)" : "none" }} title={wp.label} />
                ))}
              </div>
              <p className="text-xs font-medium mb-2" style={{ color: "rgba(255,255,255,0.6)" }}>Gradients</p>
              <div className="grid grid-cols-4 gap-2">
                {WALLPAPERS.filter((wp) => wp.type === "gradient").map((wp) => (
                  <button key={wp.id} onClick={() => { saveWallpaper(wp.id, null); setShowWallpaperPicker(false); }} className="w-16 h-10 rounded-lg hover:scale-105 transition-transform" style={{ background: wp.css, border: wallpaperId === wp.id ? "2px solid white" : "2px solid transparent", boxShadow: wallpaperId === wp.id ? "0 0 0 1px rgba(255,255,255,0.3)" : "none" }} title={wp.label} />
                ))}
                <button onClick={() => wallpaperInputRef.current?.click()} className="w-16 h-10 rounded-lg flex items-center justify-center hover:scale-105 transition-transform" style={{ background: customWallpaper ? `url(${customWallpaper})` : "rgba(255,255,255,0.1)", backgroundSize: "cover", backgroundPosition: "center", border: wallpaperId === "custom" ? "2px solid white" : "2px solid transparent" }} title="Custom">{!customWallpaper && <Image className="w-4 h-4" style={{ color: "rgba(255,255,255,0.4)" }} />}</button>
              </div>
              <input ref={wallpaperInputRef} type="file" accept="image/*" className="hidden" onChange={handleCustomWallpaperUpload} />
            </div>
          )}

          {/* File viewer */}
          {preview !== null && (() => {
            const ext = preview.name.split(".").pop()?.toLowerCase() || "";
            const isCode = ["js","ts","jsx","tsx","py","rs","go","c","cpp","h","rb","sh","bash","zsh","css","html","xml","json","yaml","yml","toml","sql","java","kt","swift","php","lua","r","pl","ex","exs","hs","ml","scala","clj","dart","vue","svelte"].includes(ext);
            const isMd = ext === "md";
            const Icon = getFileIcon(preview.name, false);
            const iconColor = getFileColor(preview.name, false);
            const lines = preview.kind === "text" ? preview.content.split("\n") : [];
            const lnw = String(lines.length || 1).length;
            return (
              <div
                className="absolute inset-0 flex items-center justify-center"
                style={{ zIndex: windowZ.preview ?? DEFAULT_WINDOW_Z.preview, background: "rgba(0,0,0,0.45)" }}
                onMouseDownCapture={() => focusWindow("preview")}
              >
                <div
                  className="w-full max-w-3xl mx-6 h-[min(85vh,720px)] flex flex-col rounded-xl overflow-hidden animate-fade-in"
                  style={{ boxShadow: "0 22px 70px 4px rgba(0,0,0,0.56)" }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="flex items-center px-3 py-2.5 flex-shrink-0 relative" style={{ background: "#2d2d2d", borderBottom: "1px solid #1a1a1a" }}>
                    <div className="flex items-center gap-2 z-10">
                      <button onClick={() => setPreview(null)} className="w-3 h-3 rounded-full hover:opacity-80 group relative" style={{ background: "#ff5f57" }}><X className="w-2 h-2 absolute inset-0.5 opacity-0 group-hover:opacity-100 text-black/60" /></button>
                      <div className="w-3 h-3 rounded-full" style={{ background: "#febc2e" }} /><div className="w-3 h-3 rounded-full" style={{ background: "#28c840" }} />
                    </div>
                    <div className="absolute inset-0 flex items-center justify-center pointer-events-none"><div className="flex items-center gap-2"><Icon className="w-3.5 h-3.5" style={{ color: iconColor }} /><span className="text-xs font-medium" style={{ color: "#ccc" }}>{preview.name}</span></div></div>
                  </div>
                  <div className="flex-1 min-h-0 overflow-auto" style={{ background: preview.kind === "text" && (isCode || isMd) ? "#1e1e1e" : "#252526" }}>
                    {preview.kind === "image" && (
                      <div className="p-4 flex items-center justify-center">
                        <img
                          src={preview.dataUrl}
                          alt={preview.name}
                          className="max-w-full max-h-[70vh] rounded-lg shadow-lg"
                        />
                      </div>
                    )}
                    {preview.kind === "binary" && (
                      <div className="p-6 text-sm" style={{ color: "#d4d4d4" }}>
                        <p className="font-medium mb-2">Preview not available</p>
                        <p>This file type isn’t viewable yet.</p>
                        <p className="text-xs mt-2" style={{ color: "#888" }}>
                          {preview.name} · {formatSize(preview.size)}
                        </p>
                      </div>
                    )}
                    {preview.kind === "text" && (
                      (isCode || isMd) ? (
                        <div className="flex text-[13px] font-mono leading-[1.6]">
                          <div className="flex-shrink-0 text-right select-none py-3 pr-3 sticky left-0" style={{ color: "#858585", background: "#1e1e1e", paddingLeft: "12px", minWidth: `${lnw * 0.65 + 1.8}em`, borderRight: "1px solid #2d2d2d" }}>{lines.map((_, i) => <div key={i}>{i + 1}</div>)}</div>
                          <pre className="flex-1 py-3 px-4 whitespace-pre-wrap break-words" style={{ color: "#d4d4d4", tabSize: 4 }}>{preview.content}</pre>
                        </div>
                      ) : (
                        <pre className="p-5 text-[13px] font-mono whitespace-pre-wrap break-words leading-relaxed" style={{ color: "#d4d4d4" }}>{preview.content}</pre>
                      )
                    )}
                  </div>
                  <div className="flex items-center justify-between px-3 py-1 flex-shrink-0 text-[11px]" style={{ background: "#007acc", color: "rgba(255,255,255,0.9)" }}>
                    <span>{ext.toUpperCase() || "TXT"}</span>
                    {preview.kind === "text" ? (
                      <span>{lines.length} lines · {formatSize(new Blob([preview.content]).size)}</span>
                    ) : preview.kind === "image" ? (
                      <span>Image preview</span>
                    ) : (
                      <span>{formatSize(preview.size)}</span>
                    )}
                  </div>
                </div>
              </div>
            );
          })()}

          {/* Error toast */}
          {error && (
            <div className="absolute top-4 left-1/2 -translate-x-1/2 z-[70] flex items-center gap-2 px-4 py-2 rounded-lg text-xs animate-fade-in" style={{ background: "rgba(220,38,38,0.9)", color: "white", backdropFilter: "blur(8px)", boxShadow: "0 4px 20px rgba(0,0,0,0.3)" }} onClick={(e) => e.stopPropagation()}>
              <span className="flex-1">{error}</span>
              <button onClick={() => setError(null)} className="font-medium underline">Dismiss</button>
            </div>
          )}

          {createFolderOpen && (
            <div
              className="absolute inset-0 z-[72] flex items-center justify-center"
              style={{ background: "rgba(0,0,0,0.34)", backdropFilter: "blur(6px)" }}
              onClick={() => { if (!creatingFolder) setCreateFolderOpen(false); }}
            >
              <div
                className="w-full max-w-sm rounded-2xl p-4"
                style={{
                  background: "rgba(28,28,30,0.92)",
                  border: "1px solid rgba(255,255,255,0.08)",
                  boxShadow: "0 24px 60px rgba(0,0,0,0.45)",
                }}
                onClick={(e) => e.stopPropagation()}
              >
                <div className="mb-3">
                  <p className="text-sm font-semibold" style={{ color: "#fff" }}>New Folder</p>
                  <p className="text-xs mt-1" style={{ color: "#9a9a9a" }}>
                    {createFolderBasePath ? `Create inside ${createFolderBasePath}` : "Create in Workspace"}
                  </p>
                </div>
                <input
                  ref={createFolderInputRef}
                  type="text"
                  value={createFolderName}
                  disabled={creatingFolder}
                  onChange={(e) => setCreateFolderName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      submitCreateFolder();
                    }
                    if (e.key === "Escape" && !creatingFolder) {
                      setCreateFolderOpen(false);
                    }
                  }}
                  className="w-full px-3 py-2 rounded-xl text-sm outline-none"
                  style={{
                    background: "rgba(255,255,255,0.08)",
                    color: "#fff",
                    border: "1px solid rgba(255,255,255,0.12)",
                  }}
                  placeholder="Folder name"
                />
                <div className="mt-4 flex items-center justify-end gap-2">
                  <button
                    onClick={() => setCreateFolderOpen(false)}
                    disabled={creatingFolder}
                    className="px-3 py-1.5 rounded-lg text-xs"
                    style={{ background: "rgba(255,255,255,0.08)", color: "#d0d0d0" }}
                  >
                    Cancel
                  </button>
                  <button
                    onClick={submitCreateFolder}
                    disabled={!createFolderName.trim() || creatingFolder}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium disabled:opacity-50"
                    style={{ background: "#54a3f7", color: "#fff" }}
                  >
                    {creatingFolder ? "Creating..." : "Create"}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ── FLOATING CHAT WINDOW (draggable) ────────────────────── */}
          {chatOpen && (
            <AppWindow
              title="Chat"
              icon={MessageSquare}
              position={chatPos}
              size={chatSize}
              zIndex={windowZ.chat ?? DEFAULT_WINDOW_Z.chat}
              glass={false}
              onClose={() => setChatOpen(false)}
              onFocus={() => focusWindow("chat")}
              onDragStart={handleChatDragStart}
              onResizeStart={(direction, e) =>
                startWindowResize(
                  e,
                  direction,
                  chatResizeRef,
                  chatPos,
                  chatSize,
                  setChatPos,
                  setChatSize,
                  "chat",
                  { w: 640, h: 420 },
                )
              }
            >
              <div className="h-full min-w-0 flex bg-[#f4f0ea] text-[var(--text-primary)]">
                <aside
                  className={`${chatNavCollapsed ? "w-[78px]" : "w-[280px]"} shrink-0 border-r flex flex-col transition-[width] duration-200`}
                  style={{ borderColor: "rgba(0,0,0,0.08)", background: "linear-gradient(180deg, rgba(255,250,243,0.98) 0%, rgba(244,238,228,0.98) 100%)" }}
                >
                  <div className="p-3 border-b" style={{ borderColor: "rgba(0,0,0,0.08)" }}>
                    <div className={`flex items-center gap-2 ${chatNavCollapsed ? "flex-col" : "justify-between mb-3"}`}>
                      <div className={`min-w-0 ${chatNavCollapsed ? "flex flex-col items-center gap-2 w-full" : ""}`}>
                        <button
                          type="button"
                          onClick={() => setChatNavCollapsed((prev) => !prev)}
                          className="h-8 w-8 rounded-xl border flex items-center justify-center transition-colors hover:bg-black/5"
                          style={{ borderColor: "rgba(36,26,18,0.1)", color: "#241a12" }}
                          title={chatNavCollapsed ? "Expand conversations" : "Collapse conversations"}
                          aria-label={chatNavCollapsed ? "Expand conversations" : "Collapse conversations"}
                        >
                          {chatNavCollapsed ? (
                            <PanelLeftOpen className="w-4 h-4" />
                          ) : (
                            <PanelLeftClose className="w-4 h-4" />
                          )}
                        </button>
                        {!chatNavCollapsed && (
                          <>
                            <p className="text-[11px] uppercase tracking-[0.24em]" style={{ color: "rgba(36,26,18,0.46)" }}>
                              Conversations
                            </p>
                            <p className="text-[12px] mt-1" style={{ color: "rgba(36,26,18,0.68)" }}>
                              {activeChatSession ? desktopChatSessionTitle(activeChatSession) : "Shared with main chat"}
                            </p>
                          </>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={createNewChatSession}
                        className={`h-8 rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5 ${chatNavCollapsed ? "w-8 px-0" : "px-3"}`}
                        style={{ background: "rgba(36,26,18,0.92)", color: "#fff8ef", border: "1px solid rgba(36,26,18,0.1)" }}
                        title="New chat"
                      >
                        <Plus className="w-3.5 h-3.5" />
                        {!chatNavCollapsed && "New"}
                      </button>
                    </div>
                    {!chatNavCollapsed && (
                      <input
                        type="text"
                        value={chatSessionQuery}
                        onChange={(e) => setChatSessionQuery(e.target.value)}
                        placeholder="Search history"
                        className="w-full h-9 px-3 rounded-xl text-xs outline-none"
                        style={{ background: "rgba(255,255,255,0.78)", color: "#241a12", border: "1px solid rgba(36,26,18,0.1)" }}
                      />
                    )}
                  </div>
                  <div className={`flex-1 overflow-auto ${chatNavCollapsed ? "p-2 space-y-2" : "p-2 space-y-1.5"}`}>
                    {visibleChatSessions.length === 0 ? (
                      <div className="px-3 py-5 text-center">
                        <p className="text-xs" style={{ color: "rgba(36,26,18,0.58)" }}>No matching chats</p>
                      </div>
                    ) : chatNavCollapsed ? visibleChatSessions.slice(0, 8).map((session) => {
                      const isActive = session.key === chatCurrentSession;
                      const SessionIcon = session.pinned ? Pin : MessageSquare;
                      return (
                        <button
                          key={session.key}
                          type="button"
                          onClick={() => selectChatSession(session.key)}
                          className="w-full h-11 rounded-2xl border flex items-center justify-center transition-colors"
                          style={{
                            background: isActive ? "rgba(109,40,217,0.12)" : "rgba(255,255,255,0.56)",
                            borderColor: isActive ? "rgba(109,40,217,0.18)" : "rgba(36,26,18,0.06)",
                            color: "#241a12",
                          }}
                          title={desktopChatSessionTitle(session)}
                        >
                          <SessionIcon className="w-4 h-4" />
                        </button>
                      );
                    }) : visibleChatSessions.map((session) => {
                      const isActive = session.key === chatCurrentSession;
                      return (
                        <div key={session.key} className="relative flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => selectChatSession(session.key)}
                            className="flex-1 flex items-center gap-2 px-3 py-2.5 rounded-2xl text-left transition-colors min-w-0"
                            style={{
                              background: isActive ? "rgba(109,40,217,0.12)" : "rgba(255,255,255,0.56)",
                              border: isActive ? "1px solid rgba(109,40,217,0.18)" : "1px solid rgba(36,26,18,0.06)",
                            }}
                          >
                            {session.pinned ? (
                              <Pin className="w-3.5 h-3.5 shrink-0" style={{ color: "rgba(36,26,18,0.54)" }} />
                            ) : (
                              <MessageSquare className="w-3.5 h-3.5 shrink-0" style={{ color: "rgba(36,26,18,0.54)" }} />
                            )}
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-[12px] font-semibold" style={{ color: "#241a12" }}>
                                {desktopChatSessionTitle(session)}
                              </p>
                              <p className="mt-1 text-[10px]" style={{ color: "rgba(36,26,18,0.48)" }}>
                                {typeof session.updatedAt === "number"
                                  ? formatDate(Math.floor(session.updatedAt / 1000))
                                  : "Saved conversation"}
                              </p>
                            </div>
                          </button>
                          <button
                            data-desktop-chat-session-trigger
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setOpenChatSessionMenuKey((prev) => (prev === session.key ? null : session.key));
                            }}
                            className="p-1.5 rounded-lg transition-colors hover:bg-black/5"
                            style={{ color: "rgba(36,26,18,0.54)" }}
                            title="Chat options"
                            aria-label="Chat options"
                          >
                            <MoreHorizontal className="w-3.5 h-3.5" />
                          </button>
                          {openChatSessionMenuKey === session.key && (
                            <div
                              data-desktop-chat-session-menu
                              className="absolute right-0 top-10 z-30 w-40 rounded-xl border p-1.5 shadow-lg"
                              style={{
                                background: "rgba(255,250,243,0.98)",
                                borderColor: "rgba(36,26,18,0.1)",
                              }}
                            >
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  requestChatSessionAction({
                                    type: "pin",
                                    key: session.key,
                                    pinned: !session.pinned,
                                  });
                                  setOpenChatSessionMenuKey(null);
                                }}
                                className="w-full flex items-center gap-2 rounded-lg px-2 py-1.5 text-[12px] text-left transition-colors hover:bg-black/5"
                                style={{ color: "#241a12" }}
                              >
                                <Pin className="w-3.5 h-3.5" />
                                {session.pinned ? "Unpin" : "Pin"}
                              </button>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  requestChatSessionAction({ type: "delete", key: session.key });
                                  setOpenChatSessionMenuKey(null);
                                }}
                                className="w-full flex items-center gap-2 rounded-lg px-2 py-1.5 text-[12px] text-left transition-colors hover:bg-red-50"
                                style={{ color: "#dc2626" }}
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                                Delete
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </aside>

                <div className="min-w-0 flex-1 flex flex-col bg-[rgba(255,255,255,0.62)]">
                  <div
                    className="px-4 py-3 border-b flex items-center justify-between gap-3"
                    style={{ borderColor: "rgba(0,0,0,0.08)", background: "rgba(255,250,243,0.82)" }}
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold" style={{ color: "#241a12" }}>
                        {activeChatSession ? desktopChatSessionTitle(activeChatSession) : DEFAULT_DESKTOP_CHAT_TITLE}
                      </p>
                      <p className="mt-1 text-[11px]" style={{ color: "rgba(36,26,18,0.56)" }}>
                        Same sessions, drafts, and history as the main chat view
                      </p>
                    </div>
                    <div className="shrink-0 px-2.5 py-1 rounded-full text-[10px] font-medium" style={{ background: "rgba(36,26,18,0.06)", color: "rgba(36,26,18,0.56)" }}>
                      {chatSessions.length} session{chatSessions.length === 1 ? "" : "s"}
                    </div>
                  </div>
                  <div className="min-w-0 flex-1 overflow-hidden">
                    <Chat
                      isVisible={chatOpen}
                      gatewayRunning={gatewayRunning}
                      gatewayStarting={Boolean(gatewayRetryIn) || (isTogglingGateway && !gatewayRunning)}
                      gatewayRetryIn={gatewayRetryIn ?? null}
                      onStartGateway={onGatewayToggle}
                      onRecoverProxyAuth={onRecoverProxyAuth}
                      useLocalKeys={useLocalKeys}
                      selectedModel={selectedModel}
                      onModelChange={onModelChange}
                      imageModel={imageModel}
                      integrationsSyncing={integrationsSyncing}
                      integrationsMissing={integrationsMissing}
                      onNavigate={handleDesktopChatNavigate}
                      onSessionsChange={(sessions, currentKey) => {
                        setChatSessions(sessions);
                        setChatCurrentSession((prev) => currentKey ?? prev);
                        setChatRequestedSession((pending) => {
                          if (!pending) return pending;
                          if (pending === "__new__") {
                            return currentKey ? null : pending;
                          }
                          return pending === currentKey ? null : pending;
                        });
                        setChatRequestedAction(null);
                      }}
                      requestedSession={chatRequestedSession}
                      requestedSessionAction={chatRequestedAction}
                    />
                  </div>
                </div>
              </div>
            </AppWindow>
          )}

          {/* ── BROWSER WINDOW ───────────────────────────────────────── */}
          {browserOpen && (
            <AppWindow
              title="Browser"
              icon={Globe}
              position={browserPos}
              size={browserSize}
              zIndex={windowZ.browser ?? DEFAULT_WINDOW_Z.browser}
              onClose={() => { void closeBrowserWindow(); }}
              onFocus={() => focusWindow("browser")}
              onDragStart={(e) =>
                startWindowDrag(e, browserDragRef, browserPos, browserSize, setBrowserPos, "browser")
              }
              onResizeStart={(direction, e) =>
                startWindowResize(
                  e,
                  direction,
                  browserResizeRef,
                  browserPos,
                  browserSize,
                  setBrowserPos,
                  setBrowserSize,
                  "browser",
                  { w: 640, h: 420 },
                )
              }
            >
              <div className="h-full flex flex-col bg-white">
                <div className="flex items-center gap-2 px-2 py-2 border-b border-[var(--border-subtle)] bg-[#f7f3eb]">
                  <div className="flex-1 min-w-0 flex items-center gap-2 overflow-x-auto">
                    {browserTabs.map((tab) => {
                      const isActive = tab.id === activeBrowserTabId;
                      return (
                        <button
                          key={tab.id}
                          type="button"
                          onClick={() => selectBrowserTab(tab.id)}
                          className={`group min-w-0 max-w-[240px] h-9 px-3 rounded-xl border flex items-center gap-2 text-sm transition-colors ${
                            isActive
                              ? "bg-white text-[var(--text-primary)] shadow-sm"
                              : "bg-white/55 text-[var(--text-secondary)] hover:bg-white/80"
                          }`}
                          style={{ borderColor: isActive ? "rgba(24,34,48,0.12)" : "rgba(24,34,48,0.08)" }}
                          title={browserTabLabel(tab)}
                        >
                          <Globe className="w-3.5 h-3.5 shrink-0" />
                          <span className="min-w-0 flex-1 truncate text-left">
                            {browserTabLabel(tab)}
                          </span>
                          <span
                            role="button"
                            tabIndex={-1}
                            onClick={(e) => {
                              e.stopPropagation();
                              void closeBrowserTab(tab.id);
                            }}
                            className="shrink-0 rounded-md p-0.5 text-[var(--text-tertiary)] hover:bg-black/5 hover:text-[var(--text-primary)]"
                            aria-label={`Close ${browserTabLabel(tab)}`}
                          >
                            <X className="w-3.5 h-3.5" />
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  <button
                    type="button"
                    onClick={() => createBrowserTab()}
                    className="h-9 w-9 shrink-0 rounded-xl border border-[var(--border-subtle)] bg-white text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                    title="New tab"
                    aria-label="New tab"
                  >
                    <Plus className="w-4 h-4 mx-auto" />
                  </button>
                </div>
                <div className="px-3 py-2 border-b border-[var(--border-subtle)] bg-[var(--system-gray-6)]/70">
                  <form
                    className="flex items-center gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void navigateBrowser(browserUrlInput);
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => { void goBrowserBack(); }}
                      disabled={!browserCanGoBack || browserLoading}
                      className="h-8 w-8 rounded-lg border border-[var(--border-subtle)] bg-white text-[var(--text-secondary)] disabled:opacity-40"
                      title="Back"
                    >
                      <ChevronLeft className="w-4 h-4 mx-auto" />
                    </button>
                    <button
                      type="button"
                      onClick={() => { void goBrowserForward(); }}
                      disabled={!browserCanGoForward || browserLoading}
                      className="h-8 w-8 rounded-lg border border-[var(--border-subtle)] bg-white text-[var(--text-secondary)] disabled:opacity-40"
                      title="Forward"
                    >
                      <ChevronRight className="w-4 h-4 mx-auto" />
                    </button>
                    <button
                      type="button"
                      onClick={() => { void reloadBrowser(); }}
                      className="h-8 w-8 rounded-lg border border-[var(--border-subtle)] bg-white text-[var(--text-secondary)]"
                      title="Reload"
                    >
                      {browserLoading ? (
                        <Loader2 className="w-4 h-4 mx-auto animate-spin" />
                      ) : (
                        <ArrowUp className="w-4 h-4 mx-auto rotate-90" />
                      )}
                    </button>
                    <input
                      type="text"
                      value={browserUrlInput}
                      onChange={(e) => setBrowserUrlInput(e.target.value)}
                      className="flex-1 h-8 px-3 rounded-lg border border-[var(--border-subtle)] bg-white text-sm outline-none"
                      placeholder="Enter URL"
                    />
                    <button
                      type="submit"
                      className="h-8 px-3 rounded-lg bg-[var(--system-blue)] text-white text-sm font-semibold"
                    >
                      Go
                    </button>
                    <button
                      type="button"
                      onClick={() => openBrowserExternally(browserUrlInput)}
                      className="h-8 px-3 rounded-lg border border-[var(--border-subtle)] bg-white text-sm font-medium text-[var(--text-primary)]"
                    >
                      Open
                    </button>
                  </form>
                </div>
                <div className="relative flex-1 bg-white">
                  {browserNeedsFocusOverlay && (
                    <button
                      type="button"
                      className="absolute inset-0 z-10 flex items-center justify-center bg-white/20 text-xs font-medium text-[var(--text-primary)] backdrop-blur-[1px]"
                      onClick={() => focusWindow("browser")}
                    >
                      Click to focus browser
                    </button>
                  )}
                  {browserLoading && !browserSnapshot && !browserLiveState && !browserUsingEmbeddedPreview ? (
                    <div className="absolute inset-0 flex items-center justify-center text-sm text-[var(--text-secondary)]">
                      <div className="flex items-center gap-2">
                        <Loader2 className="w-4 h-4 animate-spin" />
                        Loading browser session...
                      </div>
                    </div>
                  ) : (browserUsingEmbeddedPreview || browserSnapshot || browserLiveState) ? (
                    <div className="h-full flex flex-col">
                      <div
                        ref={browserViewportRef}
                        className={browserUsingEmbeddedPreview
                          ? "flex-1 min-h-0 overflow-hidden bg-white"
                          : browserUsingEmbeddedRemoteDesktop
                          ? "flex-1 min-h-0 overflow-hidden bg-[#f4f4f5]"
                          : browserLiveConnected
                          ? "flex-1 min-h-0 overflow-hidden bg-[#0b0b0c] flex items-center justify-center"
                          : "flex-1 min-h-0 overflow-auto bg-[#f5f5f5]"}
                      >
                        {browserUsingEmbeddedPreview ? (
                          <div className="relative w-full h-full overflow-hidden bg-white">
                            <div className="absolute inset-0 flex items-center justify-center text-sm text-[var(--text-secondary)]">
                              Local preview is loading...
                            </div>
                          </div>
                        ) : browserUsingEmbeddedRemoteDesktop && browserRemoteDesktopUrl ? (
                          <div className="relative w-full h-full overflow-hidden bg-white">
                            <iframe
                              key={browserRemoteDesktopUrl}
                              src={browserRemoteDesktopUrl}
                              title={browserTitle}
                              className="absolute left-0 w-full border-0 bg-white"
                              allow="clipboard-read; clipboard-write"
                              style={{
                                top: -44,
                                height: "calc(100% + 44px)",
                                pointerEvents: browserLiveConnected ? "none" : undefined,
                              }}
                            />
                            {browserLiveConnected && (
                              <div
                                className="absolute inset-0 z-10 cursor-default"
                                tabIndex={0}
                                onFocus={() => sendBrowserLiveMessage({ type: "focus" })}
                                onMouseMove={handleBrowserViewportMouseMove}
                                onMouseDown={handleBrowserViewportMouseDown}
                                onMouseUp={handleBrowserViewportMouseUp}
                                onWheel={handleBrowserViewportWheel}
                                onKeyDown={handleBrowserViewportKeyDown}
                                onPaste={handleBrowserViewportPaste}
                                onCopy={handleBrowserViewportCopy}
                                onContextMenu={(e) => e.preventDefault()}
                              />
                            )}
                          </div>
                        ) : browserHasRenderableImage ? (
                          <div
                            className={browserLiveConnected
                              ? "relative w-full h-full flex items-center justify-center"
                              : "relative w-full"}
                          >
                            <img
                              ref={browserLiveImageRef}
                              src={browserSnapshotImage || undefined}
                              alt={browserTitle}
                              className={browserLiveConnected
                                ? "block max-w-full max-h-full object-contain select-none"
                                : "w-full h-auto block"}
                              draggable={false}
                              decoding="async"
                              tabIndex={browserLiveConnected ? 0 : -1}
                              onFocus={() => sendBrowserLiveMessage({ type: "focus" })}
                              onMouseMove={handleBrowserViewportMouseMove}
                              onMouseDown={handleBrowserViewportMouseDown}
                              onMouseUp={handleBrowserViewportMouseUp}
                              onWheel={handleBrowserViewportWheel}
                              onKeyDown={handleBrowserViewportKeyDown}
                              onPaste={handleBrowserViewportPaste}
                              onCopy={handleBrowserViewportCopy}
                              onContextMenu={(e) => e.preventDefault()}
                            />
                            {!browserLiveConnected && (browserSnapshot?.interactive_elements ?? []).map((element) => (
                              <button
                                key={element.id}
                                type="button"
                                title={element.label || element.tag}
                                onClick={() => { void clickBrowserElement(element); }}
                                disabled={Boolean(browserClickingId) || browserLoading}
                                className="absolute rounded border border-sky-500/80 bg-sky-400/10 hover:bg-sky-400/20 transition-colors disabled:cursor-wait"
                                style={{
                                  left: `${(element.x / Math.max(browserSnapshot?.screenshot_width ?? browserViewportWidth, 1)) * 100}%`,
                                  top: `${(element.y / Math.max(browserSnapshot?.screenshot_height ?? browserViewportHeight, 1)) * 100}%`,
                                  width: `${(element.width / Math.max(browserSnapshot?.screenshot_width ?? browserViewportWidth, 1)) * 100}%`,
                                  height: `${(element.height / Math.max(browserSnapshot?.screenshot_height ?? browserViewportHeight, 1)) * 100}%`,
                                }}
                              >
                                <span className="absolute left-0 top-0 -translate-y-full rounded bg-sky-600 px-1.5 py-0.5 text-[10px] font-medium text-white shadow-sm max-w-[240px] truncate">
                                  {element.label || element.tag}
                                </span>
                              </button>
                            ))}
                          </div>
                        ) : browserLiveConnected ? (
                          <div className="h-full flex items-center justify-center text-sm text-white/60">
                            Waiting for live browser frame...
                          </div>
                        ) : (
                          <div className="h-full flex items-center justify-center text-sm text-[var(--text-secondary)]">
                            No browser screenshot available.
                          </div>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="absolute inset-0 flex items-center justify-center text-sm text-[var(--text-secondary)]">
                      Enter a URL to start a browser session.
                    </div>
                  )}
                </div>
              </div>
            </AppWindow>
          )}

          {/* ── TERMINAL WINDOW ─────────────────────────────────────── */}
          {terminalOpen && (
            <AppWindow
              title="Terminal"
              icon={Terminal}
              position={terminalPos}
              size={terminalSize}
              zIndex={windowZ.terminal ?? DEFAULT_WINDOW_Z.terminal}
              onClose={() => { void closeTerminalWindow(); }}
              onFocus={() => focusWindow("terminal")}
              onDragStart={(e) =>
                startWindowDrag(e, terminalDragRef, terminalPos, terminalSize, setTerminalPos, "terminal")
              }
              onResizeStart={(direction, e) =>
                startWindowResize(
                  e,
                  direction,
                  terminalResizeRef,
                  terminalPos,
                  terminalSize,
                  setTerminalPos,
                  setTerminalSize,
                  "terminal",
                  { w: 680, h: 360 },
                )
              }
            >
              <div className="h-full flex flex-col bg-[#060816] text-[#e5e7eb]">
                <div className="flex items-center justify-between gap-3 px-4 py-2 border-b border-white/10 bg-[#0b1020]">
                  <div className="min-w-0 flex items-center gap-3">
                    <div
                      className="inline-flex items-center gap-2 rounded-full px-2.5 py-1 text-[11px] font-medium"
                      style={{ background: "rgba(255,255,255,0.06)", color: "#f8fafc" }}
                    >
                      <span className="h-2 w-2 rounded-full" style={{ background: terminalStatusTone }} />
                      {terminalStatusLabel}
                    </div>
                    <span className="truncate text-[11px] text-slate-400">
                      OpenClaw runtime shell in `/data/workspace`
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => { void clearTerminalBuffer(); }}
                      className="h-8 px-3 rounded-lg border border-white/10 bg-white/5 text-xs font-medium text-slate-200 hover:bg-white/10"
                    >
                      Clear
                    </button>
                    <button
                      type="button"
                      onClick={() => { void restartTerminalSession(); }}
                      className="h-8 px-3 rounded-lg border border-white/10 bg-white/5 text-xs font-medium text-slate-200 hover:bg-white/10"
                    >
                      Restart
                    </button>
                  </div>
                </div>
                <div
                  ref={terminalOutputRef}
                  className="flex-1 overflow-auto px-4 py-3 font-mono text-[12px] leading-6 select-text"
                >
                  {terminalOutput ? (
                    <pre className="whitespace-pre-wrap break-words text-[#e5e7eb]">{terminalOutput}</pre>
                  ) : (
                    <div className="text-[12px] text-slate-500">
                      {terminalBootstrapping
                        ? "Starting runtime shell..."
                        : "Run commands inside the OpenClaw container workspace."}
                    </div>
                  )}
                </div>
                <div className="border-t border-white/10 bg-[#0b1020] px-4 py-3">
                  {terminalError && (
                    <div className="mb-2 rounded-lg border border-red-400/20 bg-red-400/10 px-3 py-2 text-[11px] text-red-100">
                      {terminalError}
                    </div>
                  )}
                  <div className="flex items-start gap-3 rounded-2xl border border-white/10 bg-black/25 px-3 py-3">
                    <span className="pt-1 font-mono text-sm text-emerald-400">$</span>
                    <textarea
                      value={terminalInput}
                      onChange={(e) => setTerminalInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          void submitTerminalInput();
                        }
                      }}
                      disabled={terminalBootstrapping || terminalStatus !== "ready" || !terminalSessionId}
                      placeholder={
                        terminalBootstrapping
                          ? "Starting shell…"
                          : terminalStatus === "ready"
                            ? "Enter a command"
                            : "Restart the session to run more commands"
                      }
                      className="min-h-[78px] flex-1 resize-none bg-transparent font-mono text-[13px] leading-6 text-[#f8fafc] outline-none placeholder:text-slate-500 disabled:cursor-not-allowed disabled:opacity-60"
                    />
                    <button
                      type="button"
                      onClick={() => { void submitTerminalInput(); }}
                      disabled={terminalBootstrapping || terminalStatus !== "ready" || !terminalSessionId || !terminalInput.trim()}
                      className="mt-1 h-9 px-4 rounded-xl bg-emerald-500 text-sm font-semibold text-slate-950 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Run
                    </button>
                  </div>
                  <div className="mt-2 flex items-center justify-between gap-3 text-[11px] text-slate-500">
                    <span>`Enter` runs the command. `Shift+Enter` adds a new line.</span>
                    <span>This shell runs inside the sandbox container, not on your host.</span>
                  </div>
                </div>
              </div>
            </AppWindow>
          )}

          {/* ── PLUGINS WINDOW ───────────────────────────────────────── */}
          {pluginsOpen && (
            <AppWindow
              title="Integrations"
              icon={Puzzle}
              position={pluginsPos}
              size={pluginsSize}
              zIndex={windowZ.plugins ?? DEFAULT_WINDOW_Z.plugins}
              onClose={() => setPluginsOpen(false)}
              onFocus={() => focusWindow("plugins")}
              onDragStart={(e) =>
                startWindowDrag(e, pluginsDragRef, pluginsPos, pluginsSize, setPluginsPos, "plugins")
              }
            >
              <Suspense fallback={PANEL_FALLBACK}>
                <PluginStore
                  integrationsSyncing={integrationsSyncing}
                  integrationsMissing={integrationsMissing}
                />
              </Suspense>
            </AppWindow>
          )}

          {/* ── SKILLS WINDOW ────────────────────────────────────────── */}
          {skillsOpen && (
            <AppWindow
              title="Skills"
              icon={Sparkles}
              position={skillsPos}
              size={skillsSize}
              zIndex={windowZ.skills ?? DEFAULT_WINDOW_Z.skills}
              onClose={() => setSkillsOpen(false)}
              onFocus={() => focusWindow("skills")}
              onDragStart={(e) =>
                startWindowDrag(e, skillsDragRef, skillsPos, skillsSize, setSkillsPos, "skills")
              }
            >
              <Suspense fallback={PANEL_FALLBACK}>
                <SkillsStore
                  integrationsSyncing={integrationsSyncing}
                  integrationsMissing={integrationsMissing}
                />
              </Suspense>
            </AppWindow>
          )}

          {/* ── MESSAGING WINDOW ─────────────────────────────────────── */}
          {channelsOpen && (
            <AppWindow
              title="Messaging"
              icon={Radio}
              position={channelsPos}
              size={channelsSize}
              zIndex={windowZ.channels ?? DEFAULT_WINDOW_Z.channels}
              onClose={() => setChannelsOpen(false)}
              onFocus={() => focusWindow("channels")}
              onDragStart={(e) =>
                startWindowDrag(e, channelsDragRef, channelsPos, channelsSize, setChannelsPos, "channels")
              }
            >
              <Suspense fallback={PANEL_FALLBACK}>
                <Channels />
              </Suspense>
            </AppWindow>
          )}

          {/* ── TASKS WINDOW ──────────────────────────────────────── */}
          {tasksOpen && (
            <AppWindow
              title="Tasks"
              icon={ListTodo}
              position={tasksPos}
              size={tasksSize}
              zIndex={windowZ.tasks ?? DEFAULT_WINDOW_Z.tasks}
              onClose={() => setTasksOpen(false)}
              onFocus={() => focusWindow("tasks")}
              onDragStart={(e) =>
                startWindowDrag(e, tasksDragRef, tasksPos, tasksSize, setTasksPos, "tasks")
              }
            >
              <Suspense fallback={PANEL_FALLBACK}>
                <Tasks gatewayRunning={gatewayRunning} />
              </Suspense>
            </AppWindow>
          )}

          {/* ── JOBS WINDOW ───────────────────────────────────────── */}
          {jobsOpen && (
            <AppWindow
              title="Jobs"
              icon={CalendarClock}
              position={jobsPos}
              size={jobsSize}
              zIndex={windowZ.jobs ?? DEFAULT_WINDOW_Z.jobs}
              onClose={() => setJobsOpen(false)}
              onFocus={() => focusWindow("jobs")}
              onDragStart={(e) =>
                startWindowDrag(e, jobsDragRef, jobsPos, jobsSize, setJobsPos, "jobs")
              }
            >
              <Suspense fallback={PANEL_FALLBACK}>
                <Jobs gatewayRunning={gatewayRunning} />
              </Suspense>
            </AppWindow>
          )}

          {/* ── LOGS WINDOW ─────────────────────────────────────────── */}
          {logsOpen && (
            <AppWindow
              title="Logs"
              icon={ScrollText}
              position={logsPos}
              size={logsSize}
              zIndex={windowZ.logs ?? DEFAULT_WINDOW_Z.logs}
              onClose={() => setLogsOpen(false)}
              onFocus={() => focusWindow("logs")}
              onDragStart={(e) =>
                startWindowDrag(e, logsDragRef, logsPos, logsSize, setLogsPos, "logs")
              }
            >
              <Suspense fallback={PANEL_FALLBACK}>
                <Logs />
              </Suspense>
            </AppWindow>
          )}

          {/* ── BILLING WINDOW ─────────────────────────────────────── */}
          {billingOpen && (
            <AppWindow
              title="Billing"
              icon={CreditCard}
              position={billingPos}
              size={billingSize}
              zIndex={windowZ.billing ?? DEFAULT_WINDOW_Z.billing}
              onClose={() => setBillingOpen(false)}
              onFocus={() => focusWindow("billing")}
              onDragStart={(e) =>
                startWindowDrag(e, billingDragRef, billingPos, billingSize, setBillingPos, "billing")
              }
            >
              <Suspense fallback={PANEL_FALLBACK}>
                <BillingPage />
              </Suspense>
            </AppWindow>
          )}

          {/* ── SETTINGS WINDOW ─────────────────────────────────────── */}
          {settingsOpen && (
            <AppWindow
              title="Settings"
              icon={SettingsIcon}
              position={settingsPos}
              size={settingsSize}
              zIndex={windowZ.settings ?? DEFAULT_WINDOW_Z.settings}
              onClose={() => setSettingsOpen(false)}
              onFocus={() => focusWindow("settings")}
              onDragStart={(e) =>
                startWindowDrag(e, settingsDragRef, settingsPos, settingsSize, setSettingsPos, "settings")
              }
            >
              <Suspense fallback={PANEL_FALLBACK}>
                <Settings
                  gatewayRunning={gatewayRunning}
                  onGatewayToggle={onGatewayToggle}
                  isTogglingGateway={isTogglingGateway}
                  experimentalDesktop={experimentalDesktop}
                  onExperimentalDesktopChange={onExperimentalDesktopChange}
                  selectedModel={selectedModel}
                  onModelChange={onModelChange}
                  useLocalKeys={useLocalKeys}
                  onUseLocalKeysChange={onUseLocalKeysChange}
                  codeModel={codeModel}
                  imageModel={imageModel}
                  onCodeModelChange={onCodeModelChange}
                  onImageModelChange={onImageModelChange}
                />
              </Suspense>
            </AppWindow>
          )}

          {/* ── FLOATING DOCK ─────────────────────────────────────────── */}
          <div
            className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 flex items-end justify-center gap-2 px-2.5 py-1.5 rounded-[22px]"
            style={{
              background: "rgba(255,255,255,0.18)",
              backdropFilter: "blur(40px)",
              WebkitBackdropFilter: "blur(40px)",
              border: "1px solid rgba(255,255,255,0.25)",
              boxShadow: "0 8px 32px rgba(0,0,0,0.35), inset 0 0.5px 0 rgba(255,255,255,0.2)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Finder */}
            <button
              onClick={() => {
                if (!finderOpen) {
                  setFinderOpen(true);
                  fetchFiles(currentPath || "");
                }
                focusWindow("finder");
              }}
              className="group flex flex-col items-center"
              title="Finder"
            >
              <div
                className="w-12 h-12 rounded-[14px] flex items-center justify-center transition-all duration-200 group-hover:scale-[1.15] group-hover:-translate-y-2.5"
                style={{ background: "linear-gradient(180deg, #4dc7f0 0%, #1a9ad7 100%)", boxShadow: "0 3px 10px rgba(26,154,215,0.4)" }}
              >
                <Folder className="w-6 h-6 text-white" />
              </div>
              <div className={`w-1 h-1 rounded-full mt-1 transition-opacity ${finderOpen ? "bg-white/80" : "opacity-0"}`} />
            </button>

            {/* Chat */}
            <button
              onClick={() => {
                if (!chatOpen) setChatOpen(true);
                focusWindow("chat");
              }}
              className="group flex flex-col items-center"
              title="Chat"
            >
              <div
                className="w-12 h-12 rounded-[14px] flex items-center justify-center transition-all duration-200 group-hover:scale-[1.15] group-hover:-translate-y-2.5"
                style={{ background: "linear-gradient(180deg, #5be579 0%, #32b350 100%)", boxShadow: "0 3px 10px rgba(50,179,80,0.4)" }}
              >
                <MessageSquare className="w-6 h-6 text-white" />
              </div>
              <div className={`w-1 h-1 rounded-full mt-1 transition-opacity ${chatOpen ? "bg-white/80" : "opacity-0"}`} />
            </button>

            {/* Browser */}
            <button
              onClick={() => {
                if (!browserOpen) {
                  setBrowserOpen(true);
                  void navigateBrowser(browserUrlInput || DEFAULT_BROWSER_URL);
                }
                focusWindow("browser");
              }}
              className="group flex flex-col items-center"
              title="Browser"
            >
              <div
                className="w-12 h-12 rounded-[14px] flex items-center justify-center transition-all duration-200 group-hover:scale-[1.15] group-hover:-translate-y-2.5"
                style={{ background: "linear-gradient(180deg, #0ea5e9 0%, #0284c7 100%)", boxShadow: "0 3px 10px rgba(2,132,199,0.4)" }}
              >
                <Globe className="w-6 h-6 text-white" />
              </div>
              <div className={`w-1 h-1 rounded-full mt-1 transition-opacity ${browserOpen ? "bg-white/80" : "opacity-0"}`} />
            </button>

            {/* Terminal */}
            <button
              onClick={() => {
                openTerminalWindow();
              }}
              className="group flex flex-col items-center"
              title="Terminal"
            >
              <div
                className="w-12 h-12 rounded-[14px] flex items-center justify-center transition-all duration-200 group-hover:scale-[1.15] group-hover:-translate-y-2.5"
                style={{ background: "linear-gradient(180deg, #1f2937 0%, #0f172a 100%)", boxShadow: "0 3px 10px rgba(15,23,42,0.45)" }}
              >
                <Terminal className="w-6 h-6 text-white" />
              </div>
              <div className={`w-1 h-1 rounded-full mt-1 transition-opacity ${terminalOpen ? "bg-white/80" : "opacity-0"}`} />
            </button>

            {/* Integrations */}
            <button
              onClick={() => {
                if (!pluginsOpen) setPluginsOpen(true);
                focusWindow("plugins");
              }}
              className="group flex flex-col items-center"
              title="Integrations"
            >
              <div
                className="w-12 h-12 rounded-[14px] flex items-center justify-center transition-all duration-200 group-hover:scale-[1.15] group-hover:-translate-y-2.5"
                style={{ background: "linear-gradient(180deg, #c084fc 0%, #7c3aed 100%)", boxShadow: "0 3px 10px rgba(124,58,237,0.4)" }}
              >
                <Puzzle className="w-6 h-6 text-white" />
              </div>
              <div className={`w-1 h-1 rounded-full mt-1 transition-opacity ${pluginsOpen ? "bg-white/80" : "opacity-0"}`} />
            </button>

            {/* Skills */}
            <button
              onClick={() => {
                if (!skillsOpen) setSkillsOpen(true);
                focusWindow("skills");
              }}
              className="group flex flex-col items-center"
              title="Skills"
            >
              <div
                className="w-12 h-12 rounded-[14px] flex items-center justify-center transition-all duration-200 group-hover:scale-[1.15] group-hover:-translate-y-2.5"
                style={{ background: "linear-gradient(180deg, #22d3ee 0%, #0ea5e9 100%)", boxShadow: "0 3px 10px rgba(14,165,233,0.4)" }}
              >
                <Sparkles className="w-6 h-6 text-white" />
              </div>
              <div className={`w-1 h-1 rounded-full mt-1 transition-opacity ${skillsOpen ? "bg-white/80" : "opacity-0"}`} />
            </button>

            {/* Messaging */}
            <button
              onClick={() => {
                if (!channelsOpen) setChannelsOpen(true);
                focusWindow("channels");
              }}
              className="group flex flex-col items-center"
              title="Messaging"
            >
              <div
                className="w-12 h-12 rounded-[14px] flex items-center justify-center transition-all duration-200 group-hover:scale-[1.15] group-hover:-translate-y-2.5"
                style={{ background: "linear-gradient(180deg, #60a5fa 0%, #2563eb 100%)", boxShadow: "0 3px 10px rgba(37,99,235,0.4)" }}
              >
                <Radio className="w-6 h-6 text-white" />
              </div>
              <div className={`w-1 h-1 rounded-full mt-1 transition-opacity ${channelsOpen ? "bg-white/80" : "opacity-0"}`} />
            </button>

            {/* Tasks */}
            <button
              onClick={() => {
                if (!tasksOpen) setTasksOpen(true);
                focusWindow("tasks");
              }}
              className="group flex flex-col items-center"
              title="Tasks"
            >
              <div
                className="w-12 h-12 rounded-[14px] flex items-center justify-center transition-all duration-200 group-hover:scale-[1.15] group-hover:-translate-y-2.5"
                style={{ background: "linear-gradient(180deg, #22c55e 0%, #16a34a 100%)", boxShadow: "0 3px 10px rgba(22,163,74,0.35)" }}
              >
                <ListTodo className="w-6 h-6 text-white" />
              </div>
              <div className={`w-1 h-1 rounded-full mt-1 transition-opacity ${tasksOpen ? "bg-white/80" : "opacity-0"}`} />
            </button>

            {/* Jobs */}
            <button
              onClick={() => {
                if (!jobsOpen) setJobsOpen(true);
                focusWindow("jobs");
              }}
              className="group flex flex-col items-center"
              title="Jobs"
            >
              <div
                className="w-12 h-12 rounded-[14px] flex items-center justify-center transition-all duration-200 group-hover:scale-[1.15] group-hover:-translate-y-2.5"
                style={{ background: "linear-gradient(180deg, #f97316 0%, #ea580c 100%)", boxShadow: "0 3px 10px rgba(234,88,12,0.35)" }}
              >
                <CalendarClock className="w-6 h-6 text-white" />
              </div>
              <div className={`w-1 h-1 rounded-full mt-1 transition-opacity ${jobsOpen ? "bg-white/80" : "opacity-0"}`} />
            </button>

            {/* Logs */}
            <button
              onClick={() => {
                if (!logsOpen) setLogsOpen(true);
                focusWindow("logs");
              }}
              className="group flex flex-col items-center"
              title="Logs"
            >
              <div
                className="w-12 h-12 rounded-[14px] flex items-center justify-center transition-all duration-200 group-hover:scale-[1.15] group-hover:-translate-y-2.5"
                style={{ background: "linear-gradient(180deg, #94a3b8 0%, #475569 100%)", boxShadow: "0 3px 10px rgba(71,85,105,0.4)" }}
              >
                <ScrollText className="w-6 h-6 text-white" />
              </div>
              <div className={`w-1 h-1 rounded-full mt-1 transition-opacity ${logsOpen ? "bg-white/80" : "opacity-0"}`} />
            </button>

            {/* Billing */}
            <button
              onClick={() => {
                if (!billingOpen) setBillingOpen(true);
                focusWindow("billing");
              }}
              className="group flex flex-col items-center"
              title="Billing"
            >
              <div
                className="w-12 h-12 rounded-[14px] flex items-center justify-center transition-all duration-200 group-hover:scale-[1.15] group-hover:-translate-y-2.5"
                style={{ background: "linear-gradient(180deg, #22c55e 0%, #16a34a 100%)", boxShadow: "0 3px 10px rgba(34,197,94,0.35)" }}
              >
                <CreditCard className="w-6 h-6 text-white" />
              </div>
              <div className={`w-1 h-1 rounded-full mt-1 transition-opacity ${billingOpen ? "bg-white/80" : "opacity-0"}`} />
            </button>

            {/* Settings */}
            <button
              onClick={() => {
                if (!settingsOpen) setSettingsOpen(true);
                focusWindow("settings");
              }}
              className="group flex flex-col items-center"
              title="Settings"
            >
              <div
                className="w-12 h-12 rounded-[14px] flex items-center justify-center transition-all duration-200 group-hover:scale-[1.15] group-hover:-translate-y-2.5"
                style={{ background: "linear-gradient(180deg, #f3f4f6 0%, #d1d5db 100%)", boxShadow: "0 3px 10px rgba(148,163,184,0.35)" }}
              >
                <SettingsIcon className="w-6 h-6 text-[#111827]" />
              </div>
              <div className={`w-1 h-1 rounded-full mt-1 transition-opacity ${settingsOpen ? "bg-white/80" : "opacity-0"}`} />
            </button>

            <div className="w-px self-stretch my-1.5 mx-0.5" style={{ background: "rgba(255,255,255,0.25)" }} />

            {/* Wallpaper */}
            <button
              onClick={() => setShowWallpaperPicker(!showWallpaperPicker)}
              className="group flex flex-col items-center"
              title="Change Wallpaper"
            >
              <div
                className="w-12 h-12 rounded-[14px] flex items-center justify-center transition-all duration-200 group-hover:scale-[1.15] group-hover:-translate-y-2.5"
                style={{ background: "linear-gradient(180deg, #c084fc 0%, #9333ea 100%)", boxShadow: "0 3px 10px rgba(147,51,234,0.4)" }}
              >
                <Image className="w-6 h-6 text-white" />
              </div>
              <div className="w-1 h-1 rounded-full mt-1 opacity-0" />
            </button>

            {/* Add Files */}
            <button
              onClick={() => fileInputRef.current?.click()}
              className="group flex flex-col items-center"
              title="Add Files"
            >
              <div
                className="w-12 h-12 rounded-[14px] flex items-center justify-center transition-all duration-200 group-hover:scale-[1.15] group-hover:-translate-y-2.5"
                style={{ background: "linear-gradient(180deg, #fbbf24 0%, #f59e0b 100%)", boxShadow: "0 3px 10px rgba(245,158,11,0.4)" }}
              >
                <Plus className="w-6 h-6 text-white" />
              </div>
              <div className="w-1 h-1 rounded-full mt-1 opacity-0" />
            </button>

            <input ref={fileInputRef} type="file" className="hidden" onChange={handleFileInputChange} multiple />
          </div>
        </div>
      </div>

    </div>
  );
}
