import {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
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
  ArrowUp,
  Loader2,
  Image,
} from "lucide-react";
import { loadOnboardingData } from "../lib/profile";
import { WALLPAPERS, DEFAULT_WALLPAPER_ID, getWallpaperById } from "../lib/wallpapers";
import { loadDesktopSettings, updateDesktopSettings } from "../lib/settingsStore";
import type {
  ChatSession as SharedChatSession,
  ChatSessionActionRequest,
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
import { hostedFeaturesEnabled } from "../lib/buildProfile";
import { clientLog } from "../lib/clientLog";
import { createOnlyOfficeSession } from "../lib/office";
import {
  clampWindowFrame,
  getWindowZ,
  startDesktopWindowDrag,
  startDesktopWindowResize,
  useWindowZStack,
  windowRectsIntersect,
  type WindowDragState,
  type WindowKey,
  type WindowPoint,
  type WindowRect,
  type WindowResizeDirection,
  type WindowResizeState,
  type WindowSize,
} from "../desktop/windowManager";
import { AppWindow } from "../desktop/AppWindow";
import { BrowserApp } from "../desktop/browser/BrowserApp";
import { ChatDesktopApp } from "../desktop/chat/ChatDesktopApp";
import {
  dispatchDesktopAction,
  type DesktopAction,
} from "../desktop/actions";
import { resolveDesktopHandoff, type DesktopHandoff } from "../desktop/handoff";
import {
  OfficeApps,
  officeAppKindForPath,
  pushOfficeRecentEntry,
  type OfficeAppKind,
  type OfficeAppSession,
  type OfficeRecentEntry,
} from "../desktop/office/OfficeApps";
import { DesktopIconGrid } from "../desktop/finder/DesktopIconGrid";
import { FinderApp } from "../desktop/finder/FinderApp";
import { FilePreviewWindow, type FilePreviewState } from "../desktop/finder/FilePreviewWindow";
import { CreateWorkspaceEntryModal } from "../desktop/finder/CreateWorkspaceEntryModal";
import { DesktopDock } from "../desktop/dock/DesktopDock";
import { DesktopContextMenus } from "../desktop/contextMenus/DesktopContextMenus";
import {
  DESKTOP_TERMINAL_EVENT,
  TerminalApp,
  type DesktopTerminalEventPayload,
  type DesktopTerminalSnapshot,
  type DesktopTerminalStatus,
} from "../desktop/terminal/TerminalApp";
import { DesktopUtilityWindows } from "../desktop/utility/UtilityWindows";
import { WallpaperPicker } from "../desktop/wallpaper/WallpaperPicker";
import {
  workspaceBrowserUrl,
  workspaceFileCanOpenInBrowser,
  workspaceFileIsHtml,
  workspaceFileUsesOnlyOffice,
  workspacePathName,
  workspacePathParent,
} from "../desktop/finder/workspacePaths";
import { VoiceProvider } from "../desktop/voice/VoiceProvider";
import type { VoiceDesktopContext } from "../desktop/voice/voiceActions";
import type { VoiceSpeechVoice } from "../desktop/voice/voicePreferences";

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
  onApplyRuntimeResources?: () => void | Promise<void>;
  onRecoverProxyAuth?: () => Promise<boolean> | boolean;
  isTogglingGateway: boolean;
  selectedModel: string;
  onModelChange: (model: string) => void;
  useLocalKeys: boolean;
  onUseLocalKeysChange: (value: boolean) => void;
  codeModel: string;
  imageModel: string;
  imageGenerationModel: string;
  textToSpeechModel: string;
  audioUnderstandingModel: string;
  voiceShortcut: string;
  voiceSpeechRate: number;
  voiceSpeechVoice: VoiceSpeechVoice;
  onCodeModelChange: (model: string) => void;
  onImageGenerationModelChange: (model: string) => void;
  onTextToSpeechModelChange: (model: string) => void;
  onAudioUnderstandingModelChange: (model: string) => void;
  onVoiceShortcutChange: (shortcut: string) => void | Promise<void>;
  onVoiceSpeechRateChange: (rate: number) => void | Promise<void>;
  onVoiceSpeechVoiceChange: (voice: VoiceSpeechVoice) => void | Promise<void>;
  onImageModelChange: (model: string) => void;
  pendingDesktopAction?: { id: string; action: DesktopAction } | null;
  onDesktopActionHandled?: (id: string) => void;
};
type ViewMode = "grid" | "list";
type DesktopIcon = { id: string; x: number; y: number };
type BrowserSnapshot = {
  session_id: string;
  url: string;
  title: string;
  live_ws_url?: string | null;
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

const HIDDEN_FILES = new Set(["HEARTBEAT.md", "IDENTITY.md", "SOUL.md", "TOOLS.md", "AGENTS.md", "USER.md"]);
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"]);
const BINARY_EXTS = new Set(["pdf", "zip", "xlsx", "xls", "docx", "pptx"]);
const DESKTOP_HANDOFF_STORAGE_KEY = "entropic.desktop.handoff";
const DESKTOP_HANDOFF_EVENT = "entropic-desktop-handoff";
const DESKTOP_SESSION_STORAGE_KEY = "entropic.desktop.session.v1";
const DESKTOP_WORKSPACE_PATH = "Desktop";
const CHAT_WORKSPACE_PREFIXES = [
  "/data/.openclaw/workspace",
  "/data/workspace",
  "/home/node/.openclaw/workspace",
];
const CHAT_WORKSPACE_PATH_RE = /((?:\/data\/(?:\.openclaw\/)?workspace|\/home\/node\/\.openclaw\/workspace)(?:\/[^\s`"'<>]+)?)/g;
const DEFAULT_BROWSER_URL = "https://www.google.com";
const DEFAULT_BROWSER_LIVE_WS_BASE = "ws://127.0.0.1:19792/live";
const WORKSPACE_FOLDER_REFRESH_MS = 4000;
const DESKTOP_CACHE_STALE_MS = 12000;
const DESKTOP_WARM_CACHE_TTL_MS = 5 * 60 * 1000;
const DESKTOP_IMAGE_PREVIEW_MAX_BYTES = 8 * 1024 * 1024;
const DESKTOP_IMAGE_PREVIEW_MAX_ITEMS = 48;
const DESKTOP_IMAGE_PREVIEW_MAX_CONCURRENT = 4;
const BROWSER_APP_WINDOW_TITLEBAR_HEIGHT = 34;
const BROWSER_TOOLBAR_HEIGHT = 49;
const CHAT_WINDOW_MIN_SIZE_EXPANDED = { w: 560, h: 420 };
const CHAT_WINDOW_MIN_SIZE_COLLAPSED = { w: 420, h: 360 };
const PREVIEW_WINDOW_MIN_SIZE = { w: 420, h: 320 };
const DESKTOP_CONTEXT_MENU_Z = 2000;
const DESKTOP_MODAL_Z = 2100;
const DESKTOP_ICON_WIDTH = 84;
const DESKTOP_ICON_HEIGHT = 110;
const DESKTOP_ICON_GRID_START_X = 28;
const DESKTOP_ICON_GRID_START_Y = 72;
const DESKTOP_ICON_GRID_STEP_X = 96;
const DESKTOP_ICON_GRID_STEP_Y = 108;
const WORKSPACE_ICON_GRID_Y = DESKTOP_ICON_GRID_START_Y;
const LOCAL_BROWSER_INPUT_RE = /^(?:container\.localhost|runtime\.localhost|localhost|127\.0\.0\.1)(?::\d+)?(?:[/?#].*)?$/i;
const BROWSER_DESKTOP_MIN_VIEWPORT_WIDTH = 1180;
const BROWSER_DESKTOP_MIN_VIEWPORT_HEIGHT = 760;
const BROWSER_DESKTOP_VIEWPORT_SCALE = 1.08;
const EMBEDDED_PREVIEW_FRAME_INSET = 8;
type ChatWorkspaceReference = {
  key: string;
  path: string;
  name: string;
  isHtml: boolean;
  looksLikeFile: boolean;
};
type DesktopDropTarget = string | null;
type NativeDragDropPayload = {
  paths?: string[] | null;
  position?: {
    x: number;
    y: number;
  } | null;
};
type DesktopSessionState = {
  finderOpen: boolean;
  chatOpen: boolean;
  chatNavCollapsed: boolean;
  browserOpen: boolean;
  terminalOpen: boolean;
  sheetsOpen: boolean;
  docsOpen: boolean;
  slidesOpen: boolean;
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
  sheetsPos: WindowPoint;
  sheetsSize: WindowSize;
  docsPos: WindowPoint;
  docsSize: WindowSize;
  slidesPos: WindowPoint;
  slidesSize: WindowSize;
  pluginsPos: WindowPoint;
  skillsPos: WindowPoint;
  skillsSize: WindowSize;
  channelsPos: WindowPoint;
  tasksPos: WindowPoint;
  jobsPos: WindowPoint;
  logsPos: WindowPoint;
  billingPos: WindowPoint;
  settingsPos: WindowPoint;
  previewPos: WindowPoint;
  previewSize: WindowSize;
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
  sheetsRecent: OfficeRecentEntry[];
  docsRecent: OfficeRecentEntry[];
  slidesRecent: OfficeRecentEntry[];
};

type DesktopWarmCache = {
  entries: WorkspaceFileEntry[];
  imagePreviews: Record<string, string>;
  lastLoadedAt: number;
};

const desktopWarmCache: DesktopWarmCache = {
  entries: [],
  imagePreviews: {},
  lastLoadedAt: 0,
};

function clearDesktopWarmCache() {
  desktopWarmCache.entries = [];
  desktopWarmCache.imagePreviews = {};
  desktopWarmCache.lastLoadedAt = 0;
}

function readDesktopWarmCache(): DesktopWarmCache {
  if (Date.now() - desktopWarmCache.lastLoadedAt > DESKTOP_WARM_CACHE_TTL_MS) {
    clearDesktopWarmCache();
  }
  return {
    entries: desktopWarmCache.entries,
    imagePreviews: desktopWarmCache.imagePreviews,
    lastLoadedAt: desktopWarmCache.lastLoadedAt,
  };
}

function shouldLoadDesktopImagePreview(entry: WorkspaceFileEntry): boolean {
  if (!isImageWorkspaceEntry(entry)) return false;
  if (entry.size <= 0) return true;
  return entry.size <= DESKTOP_IMAGE_PREVIEW_MAX_BYTES;
}

function pruneDesktopImagePreviewCache(
  entries: WorkspaceFileEntry[],
  previews: Record<string, string>,
): Record<string, string> {
  const allowedPaths = new Set(
    entries
      .filter(shouldLoadDesktopImagePreview)
      .slice(0, DESKTOP_IMAGE_PREVIEW_MAX_ITEMS)
      .map((entry) => entry.path),
  );
  const nextEntries = Object.entries(previews).filter(([path]) => allowedPaths.has(path));
  return Object.fromEntries(nextEntries);
}

function writeDesktopWarmCache(
  entries: WorkspaceFileEntry[],
  previews: Record<string, string>,
  lastLoadedAt: number,
) {
  if (entries.length === 0 || Date.now() - lastLoadedAt > DESKTOP_WARM_CACHE_TTL_MS) {
    clearDesktopWarmCache();
    return;
  }
  desktopWarmCache.entries = entries;
  desktopWarmCache.imagePreviews = pruneDesktopImagePreviewCache(entries, previews);
  desktopWarmCache.lastLoadedAt = lastLoadedAt;
}

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

function browserTabTargetUrl(tab?: BrowserTabState | null): string {
  if (!tab) return DEFAULT_BROWSER_URL;
  return tab.embeddedPreview?.url || tab.liveState?.url || tab.snapshot?.url || tab.urlInput || DEFAULT_BROWSER_URL;
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

function asOfficeRecentEntries(value: unknown): OfficeRecentEntry[] | null {
  if (!Array.isArray(value)) return null;
  const entries = value
    .map((raw): OfficeRecentEntry | null => {
      if (!isRecord(raw)) return null;
      const path = typeof raw.path === "string" ? raw.path : "";
      const name = typeof raw.name === "string" ? raw.name : workspacePathName(path);
      const openedAt = Number(raw.openedAt);
      if (!path || !Number.isFinite(openedAt)) return null;
      return { path, name, openedAt };
    })
    .filter((entry): entry is OfficeRecentEntry => entry !== null);
  return entries.length > 0 ? entries : [];
}

function nativeDragDropClientPoint(payload: NativeDragDropPayload | null | undefined): WindowPoint | null {
  if (!payload?.position) return null;
  const rawX = Number(payload.position.x);
  const rawY = Number(payload.position.y);
  if (!Number.isFinite(rawX) || !Number.isFinite(rawY)) return null;
  const scale = typeof window !== "undefined" && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
  return {
    x: rawX / scale,
    y: rawY / scale,
  };
}

function dropTargetFromClientPoint(point: WindowPoint | null): DesktopDropTarget {
  if (!point || typeof document === "undefined" || typeof document.elementsFromPoint !== "function") {
    return null;
  }
  const elements = document.elementsFromPoint(point.x, point.y);
  for (const element of elements) {
    if (!(element instanceof HTMLElement) || !element.hasAttribute("data-desktop-drop-target")) {
      continue;
    }
    const target = element.getAttribute("data-desktop-drop-target");
    if (target !== null) {
      return target;
    }
  }
  return null;
}

function describeDesktopDropTarget(target: DesktopDropTarget): string {
  if (target === null) return "your workspace";
  if (target === "") return "Workspace";
  if (target === DESKTOP_WORKSPACE_PATH) return "Desktop";
  return target;
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function firstMeaningfulLine(value: string): string {
  const line = value
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find(Boolean);
  return line || value.trim();
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function desktopIconGridKey(point: WindowPoint) {
  return `${point.x}:${point.y}`;
}

function desktopIconIdForPath(path: string) {
  return `desktop:${path}`;
}

function desktopIconGridConfig(id: string) {
  if (id === "workspace") {
    return {
      startY: WORKSPACE_ICON_GRID_Y,
      fixedRow: true,
    };
  }
  return {
    startY: DESKTOP_ICON_GRID_START_Y,
    fixedRow: false,
  };
}

function desktopIconGridPoint(id: string, col: number, row: number): WindowPoint {
  const config = desktopIconGridConfig(id);
  return {
    x: DESKTOP_ICON_GRID_START_X + col * DESKTOP_ICON_GRID_STEP_X,
    y: config.fixedRow ? config.startY : config.startY + row * DESKTOP_ICON_GRID_STEP_Y,
  };
}

function desktopIconGridLimits(bounds: { width: number; height: number }, id: string) {
  const config = desktopIconGridConfig(id);
  const maxX = Math.max(DESKTOP_ICON_GRID_START_X, Math.floor(bounds.width - DESKTOP_ICON_WIDTH));
  const maxY = config.fixedRow
    ? config.startY
    : Math.max(config.startY, Math.floor(bounds.height - DESKTOP_ICON_HEIGHT));
  return {
    maxCol: Math.max(0, Math.floor((maxX - DESKTOP_ICON_GRID_START_X) / DESKTOP_ICON_GRID_STEP_X)),
    maxRow: config.fixedRow ? 0 : Math.max(0, Math.floor((maxY - config.startY) / DESKTOP_ICON_GRID_STEP_Y)),
  };
}

function nearestDesktopIconGridPoint(
  bounds: { width: number; height: number },
  target: WindowPoint,
  id: string,
): WindowPoint {
  const config = desktopIconGridConfig(id);
  const limits = desktopIconGridLimits(bounds, id);
  const rawCol = Math.round((target.x - DESKTOP_ICON_GRID_START_X) / DESKTOP_ICON_GRID_STEP_X);
  const rawRow = config.fixedRow ? 0 : Math.round((target.y - config.startY) / DESKTOP_ICON_GRID_STEP_Y);
  const col = Math.min(Math.max(0, rawCol), limits.maxCol);
  const row = config.fixedRow ? 0 : Math.min(Math.max(0, rawRow), limits.maxRow);
  return desktopIconGridPoint(id, col, row);
}

function snapDesktopIconPosition(
  bounds: { width: number; height: number },
  target: WindowPoint,
  occupied: Set<string>,
  id: string,
): WindowPoint {
  const preferred = nearestDesktopIconGridPoint(bounds, target, id);
  if (!occupied.has(desktopIconGridKey(preferred))) {
    return preferred;
  }

  const limits = desktopIconGridLimits(bounds, id);
  let best: WindowPoint | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let col = 0; col <= limits.maxCol; col += 1) {
    for (let row = 0; row <= limits.maxRow; row += 1) {
      const candidate = desktopIconGridPoint(id, col, row);
      if (occupied.has(desktopIconGridKey(candidate))) continue;
      const distance = ((candidate.x - target.x) ** 2) + ((candidate.y - target.y) ** 2);
      if (distance < bestDistance) {
        best = candidate;
        bestDistance = distance;
      }
    }
  }
  return best ?? preferred;
}

function nextDesktopIconPosition(
  occupied: Set<string>,
  bounds?: { width: number; height: number },
) {
  if (bounds && bounds.width > 0 && bounds.height > 0) {
    const limits = desktopIconGridLimits(bounds, "desktop:new");
    for (let col = 0; col <= limits.maxCol; col += 1) {
      for (let row = 0; row <= limits.maxRow; row += 1) {
        const point = desktopIconGridPoint("desktop:new", col, row);
        const key = desktopIconGridKey(point);
        if (!occupied.has(key)) {
          occupied.add(key);
          return point;
        }
      }
    }
  }
  for (let col = 0; col < 12; col += 1) {
    for (let row = 0; row < 20; row += 1) {
      const point = desktopIconGridPoint("desktop:new", col, row);
      const key = desktopIconGridKey(point);
      if (!occupied.has(key)) {
        occupied.add(key);
        return point;
      }
    }
  }
  return desktopIconGridPoint("desktop:new", 0, 0);
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

function imageMimeTypeForName(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  if (ext === "svg") return "image/svg+xml";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  return `image/${ext || "png"}`;
}

function isImageWorkspaceEntry(entry: WorkspaceFileEntry): boolean {
  if (entry.is_directory) return false;
  const ext = entry.name.split(".").pop()?.toLowerCase() || "";
  return IMAGE_EXTS.has(ext);
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

function extractChatWorkspaceReferences(content: string): ChatWorkspaceReference[] {
  const refs: ChatWorkspaceReference[] = [];
  const seen = new Set<string>();

  for (const match of content.matchAll(CHAT_WORKSPACE_PATH_RE)) {
    const path = normalizeChatWorkspacePath(match[1] || "");
    if (path === null) continue;
    const name = workspacePathName(path);
    const ref: ChatWorkspaceReference = {
      key: path || "__workspace__",
      path,
      name,
      isHtml: workspaceFileIsHtml(path),
      looksLikeFile: Boolean(path) && name.includes("."),
    };
    if (seen.has(ref.key)) continue;
    seen.add(ref.key);
    refs.push(ref);
  }

  return refs;
}

// ═════════════════════════════════════════════════════════════════════
export function Files({
  gatewayRunning,
  gatewayRetryIn,
  integrationsSyncing,
  integrationsMissing,
  onGatewayToggle,
  onApplyRuntimeResources,
  onRecoverProxyAuth,
  isTogglingGateway,
  selectedModel,
  onModelChange,
  useLocalKeys,
  onUseLocalKeysChange,
  codeModel,
  imageModel,
  imageGenerationModel,
  textToSpeechModel,
  audioUnderstandingModel,
  voiceShortcut,
  voiceSpeechRate,
  voiceSpeechVoice,
  onCodeModelChange,
  onImageGenerationModelChange,
  onTextToSpeechModelChange,
  onAudioUnderstandingModelChange,
  onVoiceShortcutChange,
  onVoiceSpeechRateChange,
  onVoiceSpeechVoiceChange,
  onImageModelChange,
  pendingDesktopAction,
  onDesktopActionHandled,
}: Props) {
  const initialDesktopWarmCache = useMemo(() => readDesktopWarmCache(), []);
  const { balance, isAuthenticated, isAuthConfigured } = useAuth();
  const billingEnabled = hostedFeaturesEnabled;
  const [agentName, setAgentName] = useState("Joulie");
  const handledDesktopActionIdsRef = useRef<Set<string>>(new Set());

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
  const [sheetsOpen, setSheetsOpen] = useState(false);
  const [docsOpen, setDocsOpen] = useState(false);
  const [slidesOpen, setSlidesOpen] = useState(false);
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
  const dragRef = useRef<WindowDragState | null>(null);

  // Chat window drag
  const [chatPos, setChatPos] = useState({ x: 120, y: 40 });
  const [chatSize, setChatSize] = useState({ w: 860, h: 560 });
  const [chatNavCollapsed, setChatNavCollapsed] = useState(false);
  const chatMinSize = chatNavCollapsed ? CHAT_WINDOW_MIN_SIZE_COLLAPSED : CHAT_WINDOW_MIN_SIZE_EXPANDED;
  const chatDragRef = useRef<WindowDragState | null>(null);
  const chatResizeRef = useRef<WindowResizeState | null>(null);
  const [desktopBounds, setDesktopBounds] = useState({ width: 0, height: 0 });
  const [browserPos, setBrowserPos] = useState({ x: 108, y: 40 });
  const [browserSize, setBrowserSize] = useState({ w: 1180, h: 760 });
  const browserDragRef = useRef<WindowDragState | null>(null);
  const browserResizeRef = useRef<WindowResizeState | null>(null);
  const [terminalPos, setTerminalPos] = useState({ x: 156, y: 70 });
  const [terminalSize, setTerminalSize] = useState({ w: 920, h: 560 });
  const terminalDragRef = useRef<WindowDragState | null>(null);
  const terminalResizeRef = useRef<WindowResizeState | null>(null);
  const [sheetsPos, setSheetsPos] = useState({ x: 156, y: 58 });
  const [sheetsSize, setSheetsSize] = useState({ w: 1100, h: 720 });
  const sheetsDragRef = useRef<WindowDragState | null>(null);
  const sheetsResizeRef = useRef<WindowResizeState | null>(null);
  const [docsPos, setDocsPos] = useState({ x: 186, y: 78 });
  const [docsSize, setDocsSize] = useState({ w: 1040, h: 700 });
  const docsDragRef = useRef<WindowDragState | null>(null);
  const docsResizeRef = useRef<WindowResizeState | null>(null);
  const [slidesPos, setSlidesPos] = useState({ x: 216, y: 98 });
  const [slidesSize, setSlidesSize] = useState({ w: 1120, h: 720 });
  const slidesDragRef = useRef<WindowDragState | null>(null);
  const slidesResizeRef = useRef<WindowResizeState | null>(null);

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
  const [skillsSize, setSkillsSize] = useState({ w: 520, h: 560 });
  const [channelsSize] = useState({ w: 520, h: 520 });
  const [tasksSize] = useState({ w: 760, h: 560 });
  const [jobsSize] = useState({ w: 620, h: 560 });
  const [logsSize] = useState({ w: 560, h: 420 });
  const [billingSize] = useState({ w: 520, h: 520 });
  const [settingsSize] = useState({ w: 740, h: 560 });
  const [previewPos, setPreviewPos] = useState({ x: 260, y: 72 });
  const [previewSize, setPreviewSize] = useState({ w: 860, h: 620 });
  const pluginsDragRef = useRef<WindowDragState | null>(null);
  const skillsDragRef = useRef<WindowDragState | null>(null);
  const skillsResizeRef = useRef<WindowResizeState | null>(null);
  const channelsDragRef = useRef<WindowDragState | null>(null);
  const tasksDragRef = useRef<WindowDragState | null>(null);
  const jobsDragRef = useRef<WindowDragState | null>(null);
  const logsDragRef = useRef<WindowDragState | null>(null);
  const billingDragRef = useRef<WindowDragState | null>(null);
  const settingsDragRef = useRef<WindowDragState | null>(null);
  const previewDragRef = useRef<WindowDragState | null>(null);
  const previewResizeRef = useRef<WindowResizeState | null>(null);
  const { windowZ, setWindowZ, zCounter, focusWindow } = useWindowZStack();

  // File browser
  const [entries, setEntries] = useState<WorkspaceFileEntry[]>([]);
  const [desktopEntries, setDesktopEntries] = useState<WorkspaceFileEntry[]>(() => initialDesktopWarmCache.entries);
  const [desktopImagePreviews, setDesktopImagePreviews] = useState<Record<string, string>>(
    () => initialDesktopWarmCache.imagePreviews,
  );
  const [currentPath, setCurrentPath] = useState("");
  const [history, setHistory] = useState<string[]>([""]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<FilePreviewState | null>(null);
  const [sheetsSession, setSheetsSession] = useState<OfficeAppSession | null>(null);
  const [docsSession, setDocsSession] = useState<OfficeAppSession | null>(null);
  const [slidesSession, setSlidesSession] = useState<OfficeAppSession | null>(null);
  const [sheetsRecent, setSheetsRecent] = useState<OfficeRecentEntry[]>([]);
  const [docsRecent, setDocsRecent] = useState<OfficeRecentEntry[]>([]);
  const [slidesRecent, setSlidesRecent] = useState<OfficeRecentEntry[]>([]);
  const [uploading, setUploading] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const [selected, setSelected] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [dragDropTarget, setDragDropTarget] = useState<DesktopDropTarget>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; entry?: WorkspaceFileEntry } | null>(null);
  const [createFolderOpen, setCreateFolderOpen] = useState(false);
  const [createFolderName, setCreateFolderName] = useState("");
  const [createFolderBasePath, setCreateFolderBasePath] = useState("");
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [createFileOpen, setCreateFileOpen] = useState(false);
  const [createFileName, setCreateFileName] = useState("");
  const [createFileBasePath, setCreateFileBasePath] = useState("");
  const [creatingFile, setCreatingFile] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const createFolderInputRef = useRef<HTMLInputElement>(null);
  const createFileInputRef = useRef<HTMLInputElement>(null);
  const filesFetchSeqRef = useRef(0);
  const filesLoadingSeqRef = useRef(0);
  const desktopEntriesFetchSeqRef = useRef(0);
  const desktopImagePreviewSeqRef = useRef(0);
  const desktopActionHandlerRef = useRef<((action: DesktopAction) => Promise<void>) | null>(null);
  const desktopLoadedAtRef = useRef(initialDesktopWarmCache.lastLoadedAt);

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
  const [browserEmbeddedPreviewCovered, setBrowserEmbeddedPreviewCovered] = useState(false);
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
  const browserEmbeddedPreviewSnapshotPendingRef = useRef<string>("");
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
      const savedBrowserOpen = saved.browserOpen === true;
      if (typeof saved.terminalOpen === "boolean") setTerminalOpen(saved.terminalOpen);
      // Office document sessions are intentionally not persisted. Restoring only
      // the open booleans reopens an empty app shell on Desktop startup.
      setSheetsOpen(false);
      setDocsOpen(false);
      setSlidesOpen(false);
      if (typeof saved.pluginsOpen === "boolean") setPluginsOpen(saved.pluginsOpen);
      if (typeof saved.skillsOpen === "boolean") setSkillsOpen(saved.skillsOpen);
      if (typeof saved.channelsOpen === "boolean") setChannelsOpen(saved.channelsOpen);
      if (typeof saved.tasksOpen === "boolean") setTasksOpen(saved.tasksOpen);
      if (typeof saved.jobsOpen === "boolean") setJobsOpen(saved.jobsOpen);
      if (typeof saved.logsOpen === "boolean") setLogsOpen(saved.logsOpen);
      if (billingEnabled && typeof saved.billingOpen === "boolean") {
        setBillingOpen(saved.billingOpen);
      }
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
      const nextSheetsPos = asWindowPoint(saved.sheetsPos);
      if (nextSheetsPos) setSheetsPos(nextSheetsPos);
      const nextSheetsSize = asWindowSize(saved.sheetsSize);
      if (nextSheetsSize) setSheetsSize(nextSheetsSize);
      const nextDocsPos = asWindowPoint(saved.docsPos);
      if (nextDocsPos) setDocsPos(nextDocsPos);
      const nextDocsSize = asWindowSize(saved.docsSize);
      if (nextDocsSize) setDocsSize(nextDocsSize);
      const nextSlidesPos = asWindowPoint(saved.slidesPos);
      if (nextSlidesPos) setSlidesPos(nextSlidesPos);
      const nextSlidesSize = asWindowSize(saved.slidesSize);
      if (nextSlidesSize) setSlidesSize(nextSlidesSize);
      const nextPluginsPos = asWindowPoint(saved.pluginsPos);
      if (nextPluginsPos) setPluginsPos(nextPluginsPos);
      const nextSkillsPos = asWindowPoint(saved.skillsPos);
      if (nextSkillsPos) setSkillsPos(nextSkillsPos);
      const nextSkillsSize = asWindowSize(saved.skillsSize);
      if (nextSkillsSize) setSkillsSize(nextSkillsSize);
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
      const nextPreviewPos = asWindowPoint(saved.previewPos);
      if (nextPreviewPos) setPreviewPos(nextPreviewPos);
      const nextPreviewSize = asWindowSize(saved.previewSize);
      if (nextPreviewSize) setPreviewSize(nextPreviewSize);

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
      const savedLegacyBrowserTarget =
        typeof saved.browserEmbeddedPreviewUrl === "string" && saved.browserEmbeddedPreviewUrl
          ? saved.browserEmbeddedPreviewUrl
          : typeof saved.browserUrlInput === "string"
            ? saved.browserUrlInput
            : "";
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
          const activeTarget = browserTabTargetUrl(activeTab);
          if (isTrustedLocalPreviewUrl(activeTarget)) {
            const fallbackTab = createBrowserTabState({
              title: null,
              urlInput: DEFAULT_BROWSER_URL,
            });
            setBrowserTabs([fallbackTab]);
            setActiveBrowserTabId(fallbackTab.id);
            setBrowserUrlInput(DEFAULT_BROWSER_URL);
            setBrowserSessionId(null);
            setBrowserEmbeddedPreview(null);
            setBrowserSnapshot(null);
            setBrowserLiveState(null);
            setBrowserLiveError(null);
            setBrowserLoading(false);
            setBrowserOpen(false);
          } else {
            setBrowserTabs(restoredTabs);
            setActiveBrowserTabId(activeTab?.id ?? null);
            setBrowserOpen(savedBrowserOpen);
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
      } else {
        if (savedLegacyBrowserTarget && isTrustedLocalPreviewUrl(savedLegacyBrowserTarget)) {
          const fallbackTab = createBrowserTabState({
            title: null,
            urlInput: DEFAULT_BROWSER_URL,
          });
          setBrowserTabs([fallbackTab]);
          setActiveBrowserTabId(fallbackTab.id);
          setBrowserUrlInput(DEFAULT_BROWSER_URL);
          setBrowserSessionId(null);
          setBrowserEmbeddedPreview(null);
          setBrowserSnapshot(null);
          setBrowserLiveState(null);
          setBrowserLiveError(null);
          setBrowserLoading(false);
          setBrowserOpen(false);
        } else {
          setBrowserOpen(savedBrowserOpen);
        }
      }
      const nextDesktopIcons = asDesktopIcons(saved.desktopIcons);
      if (nextDesktopIcons) setDesktopIcons(nextDesktopIcons);
      const nextSheetsRecent = asOfficeRecentEntries(saved.sheetsRecent);
      if (nextSheetsRecent) setSheetsRecent(nextSheetsRecent);
      const nextDocsRecent = asOfficeRecentEntries(saved.docsRecent);
      if (nextDocsRecent) setDocsRecent(nextDocsRecent);
      const nextSlidesRecent = asOfficeRecentEntries(saved.slidesRecent);
      if (nextSlidesRecent) setSlidesRecent(nextSlidesRecent);
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
      const maxX = bounds ? Math.max(0, bounds.width - DESKTOP_ICON_WIDTH) : undefined;
      const maxY = bounds ? Math.max(0, bounds.height - DESKTOP_ICON_HEIGHT) : undefined;
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
        const boundsRect = containerRef.current?.getBoundingClientRect();
        if (boundsRect) {
          const bounds = {
            width: Math.max(0, Math.floor(boundsRect.width)),
            height: Math.max(0, Math.floor(boundsRect.height)),
          };
          setDesktopIcons((prev) => {
            const current = prev[id];
            if (!current) return prev;
            const occupied = new Set<string>();
            for (const [key, value] of Object.entries(prev)) {
              if (key === id) continue;
              occupied.add(desktopIconGridKey(nearestDesktopIconGridPoint(bounds, value, key)));
            }
            const snapped = snapDesktopIconPosition(bounds, current, occupied, id);
            if (current.x === snapped.x && current.y === snapped.y) {
              return prev;
            }
            return {
              ...prev,
              [id]: {
                ...current,
                x: snapped.x,
                y: snapped.y,
              },
            };
          });
        }
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
    loadDesktopSettings().then((settings) => {
      const wp = settings.desktopWallpaper;
      if (wp) setWallpaperId(wp);
      const cwp = settings.desktopCustomWallpaper;
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
    clampResizableWindow(chatPos, chatSize, chatMinSize, setChatPos, setChatSize);
    clampResizableWindow(browserPos, browserSize, { w: 640, h: 420 }, setBrowserPos, setBrowserSize);
    clampResizableWindow(terminalPos, terminalSize, { w: 680, h: 360 }, setTerminalPos, setTerminalSize);
    clampResizableWindow(sheetsPos, sheetsSize, { w: 720, h: 480 }, setSheetsPos, setSheetsSize);
    clampResizableWindow(docsPos, docsSize, { w: 720, h: 480 }, setDocsPos, setDocsSize);
    clampResizableWindow(slidesPos, slidesSize, { w: 720, h: 480 }, setSlidesPos, setSlidesSize);
    clampFixedWindow(pluginsPos, pluginsSize, setPluginsPos);
    clampResizableWindow(skillsPos, skillsSize, { w: 420, h: 360 }, setSkillsPos, setSkillsSize);
    clampFixedWindow(channelsPos, channelsSize, setChannelsPos);
    clampFixedWindow(tasksPos, tasksSize, setTasksPos);
    clampFixedWindow(jobsPos, jobsSize, setJobsPos);
    clampFixedWindow(logsPos, logsSize, setLogsPos);
    clampFixedWindow(billingPos, billingSize, setBillingPos);
    clampFixedWindow(settingsPos, settingsSize, setSettingsPos);
    clampResizableWindow(previewPos, previewSize, PREVIEW_WINDOW_MIN_SIZE, setPreviewPos, setPreviewSize);
  }, [
    desktopBounds,
    finderPos,
    finderSize,
    chatPos,
    chatSize,
    chatMinSize,
    browserPos,
    browserSize,
    terminalPos,
    terminalSize,
    sheetsPos,
    sheetsSize,
    docsPos,
    docsSize,
    slidesPos,
    slidesSize,
    pluginsPos,
    skillsPos,
    channelsPos,
    tasksPos,
    jobsPos,
    logsPos,
    billingPos,
    settingsPos,
    previewPos,
    previewSize,
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
      // Persist Office geometry/recents, but not transient document windows.
      sheetsOpen: false,
      docsOpen: false,
      slidesOpen: false,
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
      sheetsPos,
      sheetsSize,
      docsPos,
      docsSize,
      slidesPos,
      slidesSize,
      pluginsPos,
      skillsPos,
      skillsSize,
      channelsPos,
      tasksPos,
      jobsPos,
      logsPos,
      billingPos,
      settingsPos,
      previewPos,
      previewSize,
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
      sheetsRecent,
      docsRecent,
      slidesRecent,
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
    sheetsOpen,
    docsOpen,
    slidesOpen,
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
    sheetsPos,
    sheetsSize,
    docsPos,
    docsSize,
    slidesPos,
    slidesSize,
    pluginsPos,
    skillsPos,
    skillsSize,
    channelsPos,
    tasksPos,
    jobsPos,
    logsPos,
    billingPos,
    settingsPos,
    previewPos,
    previewSize,
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
    sheetsRecent,
    docsRecent,
    slidesRecent,
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
      await updateDesktopSettings({
        desktopWallpaper: id,
        desktopCustomWallpaper: custom !== undefined ? custom ?? undefined : customWallpaper ?? undefined,
      });
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

  function startWindowDrag(
    e: ReactMouseEvent<HTMLElement>,
    ref: React.MutableRefObject<WindowDragState | null>,
    pos: WindowPoint,
    size: WindowSize,
    setPos: (next: WindowPoint) => void,
    id: string
  ) {
    startDesktopWindowDrag(
      e,
      ref,
      pos,
      size,
      setPos,
      () => containerRef.current?.getBoundingClientRect(),
      () => focusWindow(id),
    );
  }

  function handleFinderDragStart(e: ReactMouseEvent<HTMLElement>) {
    startWindowDrag(e, dragRef, finderPos, finderSize, setFinderPos, "finder");
  }

  function handleChatDragStart(e: ReactMouseEvent<HTMLElement>) {
    startWindowDrag(e, chatDragRef, chatPos, chatSize, setChatPos, "chat");
  }

  function handlePreviewDragStart(e: ReactMouseEvent<HTMLElement>) {
    startWindowDrag(e, previewDragRef, previewPos, previewSize, setPreviewPos, "preview");
  }

  function startWindowResize(
    e: ReactMouseEvent<HTMLElement>,
    direction: WindowResizeDirection,
    ref: React.MutableRefObject<WindowResizeState | null>,
    pos: WindowPoint,
    size: WindowSize,
    setPos: (next: WindowPoint) => void,
    setSize: (next: WindowSize) => void,
    id: string,
    minSize: WindowSize,
  ) {
    startDesktopWindowResize(
      e,
      direction,
      ref,
      pos,
      size,
      setPos,
      setSize,
      minSize,
      () => containerRef.current?.getBoundingClientRect(),
      () => focusWindow(id),
    );
  }

  function handlePreviewResizeStart(
    direction: WindowResizeDirection,
    e: ReactMouseEvent<HTMLElement>,
  ) {
    startWindowResize(
      e,
      direction,
      previewResizeRef,
      previewPos,
      previewSize,
      setPreviewPos,
      setPreviewSize,
      "preview",
      PREVIEW_WINDOW_MIN_SIZE,
    );
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
  const browserSnapshotImage =
    browserSnapshot?.screenshot_base64 ? `data:image/png;base64,${browserSnapshot.screenshot_base64}` : null;
  const browserEmbeddedPreviewSnapshotTarget = browserEmbeddedPreview?.url
    ? presentBrowserUrl(browserEmbeddedPreview.url)
    : null;
  const browserSnapshotMatchesEmbeddedPreview = Boolean(
    browserEmbeddedPreviewSnapshotTarget &&
    browserSnapshot?.url &&
    presentBrowserUrl(browserSnapshot.url) === browserEmbeddedPreviewSnapshotTarget
  );
  const browserHasRenderableImage = browserLiveHasFrame || Boolean(browserSnapshotImage);
  const browserTitle =
    browserEmbeddedPreview?.title ||
    browserLiveState?.title ||
    browserSnapshot?.title ||
    browserSnapshot?.url ||
    browserCurrentUrl;
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

  function openFreshBrowserWindow(targetUrl: string = DEFAULT_BROWSER_URL) {
    const normalizedTarget = normalizeBrowserUrl(targetUrl) || DEFAULT_BROWSER_URL;
    const nextTab = createBrowserTabState({
      title: null,
      urlInput: normalizedTarget,
      embeddedPreview:
        isTrustedLocalPreviewUrl(normalizedTarget)
          ? { url: normalizedTarget, title: null }
          : null,
      loading: false,
    });
    setBrowserTabs([nextTab]);
    setActiveBrowserTabId(nextTab.id);
    applyBrowserTabState(nextTab);
    setBrowserOpen(true);
    setBrowserLoadError(null);
    focusWindow("browser");
    if (!isTrustedLocalPreviewUrl(normalizedTarget)) {
      void navigateBrowser(normalizedTarget, { sessionId: null });
    }
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
          | { type: "state"; url: string; title: string; can_go_back: boolean; can_go_forward: boolean; viewport_width: number; viewport_height: number; session_id: string; live_ws_url?: string | null; }
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
    if (!browserOpen || !browserSessionId || !browserLiveConnected) {
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
  }, [browserOpen, browserSessionId, browserLiveConnected]);

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
    const detailsPanelHeight = browserLoadError ? 116 : 0;
    return requestedBrowserViewportSize(
      browserSize.w,
      browserSize.h
        - BROWSER_APP_WINDOW_TITLEBAR_HEIGHT
        - BROWSER_TOOLBAR_HEIGHT
        - detailsPanelHeight,
    );
  }

  useEffect(() => {
    if (!browserOpen || !browserUsingEmbeddedPreview || !browserEmbeddedPreviewSnapshotTarget) {
      browserEmbeddedPreviewSnapshotPendingRef.current = "";
      return;
    }
    if (browserLoading || browserSnapshotMatchesEmbeddedPreview) {
      return;
    }
    if (
      browserEmbeddedPreviewSnapshotPendingRef.current === browserEmbeddedPreviewSnapshotTarget
    ) {
      return;
    }

    let cancelled = false;
    browserEmbeddedPreviewSnapshotPendingRef.current = browserEmbeddedPreviewSnapshotTarget;

    void (async () => {
      let snapshotSessionId: string | null = null;
      try {
        const viewport = browserRequestedViewportSize();
        const snapshot = await invoke<BrowserSnapshot>("browser_session_create", {
          url: browserEmbeddedPreviewSnapshotTarget,
          viewportWidth: viewport.width,
          viewportHeight: viewport.height,
        });
        snapshotSessionId = snapshot.session_id;
        if (cancelled) return;
        setBrowserSnapshot(snapshot);
      } catch {
        // Ignore local preview snapshot failures; the live native webview remains primary.
      } finally {
        if (snapshotSessionId) {
          try {
            await invoke("browser_session_close", { sessionId: snapshotSessionId });
          } catch {
            // Ignore best-effort cleanup failures for fallback snapshots.
          }
        }
        if (browserEmbeddedPreviewSnapshotPendingRef.current === browserEmbeddedPreviewSnapshotTarget) {
          browserEmbeddedPreviewSnapshotPendingRef.current = "";
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    browserOpen,
    browserUsingEmbeddedPreview,
    browserEmbeddedPreviewSnapshotTarget,
    browserSnapshotMatchesEmbeddedPreview,
    browserLoading,
    browserSize.w,
    browserSize.h,
  ]);

  async function closeBrowserSession(sessionId: string | null) {
    if (!sessionId) return;
    try {
      await invoke("browser_session_close", { sessionId });
    } catch {
      // Ignore best-effort browser session cleanup failures.
    }
  }

  async function createBrowserSessionSnapshot(targetUrl: string) {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const viewport = browserRequestedViewportSize();
        return await invoke<BrowserSnapshot>("browser_session_create", {
          url: targetUrl,
          viewportWidth: viewport.width,
          viewportHeight: viewport.height,
        });
      } catch (error) {
        lastError = error;
        if (attempt === 0) {
          await sleep(250);
        }
      }
    }
    throw lastError;
  }

  async function retryCurrentBrowserTarget() {
    if (browserUsingEmbeddedPreview) {
      await reloadBrowser();
      return;
    }
    const target = normalizeBrowserUrl(browserCurrentUrl || browserUrlInput || DEFAULT_BROWSER_URL);
    if (!target) return;
    const sessionId = browserSessionId;
    closeBrowserLiveSocket();
    resetBrowserLiveFrame();
    setBrowserLiveState(null);
    setBrowserLiveConnected(false);
    setBrowserLiveError(null);
    setBrowserSnapshot(null);
    setBrowserSessionId(null);
    setBrowserLoadError(null);
    await closeBrowserSession(sessionId);
    await navigateBrowser(target, { sessionId: null });
  }

  async function navigateBrowser(input: string, options?: { sessionId?: string | null }) {
    const next = normalizeBrowserUrl(input);
    if (!next) return;
    const activeSessionId =
      options && Object.prototype.hasOwnProperty.call(options, "sessionId")
        ? options.sessionId ?? null
        : browserSessionId;
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
      if (!activeSessionId) {
        snapshot = await createBrowserSessionSnapshot(next);
      } else {
        try {
          snapshot = await invoke<BrowserSnapshot>("browser_navigate", { sessionId: activeSessionId, url: next });
        } catch (error) {
          const initialMessage = describeError(error);
          closeBrowserLiveSocket();
          resetBrowserLiveFrame();
          setBrowserLiveState(null);
          setBrowserLiveConnected(false);
          setBrowserLiveError(null);
          setBrowserSnapshot(null);
          await closeBrowserSession(activeSessionId);
          setBrowserSessionId(null);
          try {
            snapshot = await createBrowserSessionSnapshot(next);
          } catch (retryError) {
            throw new Error(`${describeError(retryError)}\n\nInitial navigation error: ${initialMessage}`);
          }
        }
      }
      setBrowserSessionId(snapshot.session_id);
      setBrowserSnapshot(snapshot);
      setBrowserUrlInput(presentBrowserUrl(snapshot.url));
    } catch (e) {
      setBrowserLoadError(describeError(e));
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

  async function clickBrowserSnapshotAtPoint(clientX: number, clientY: number) {
    if (!browserSessionId || browserLiveConnected || browserLoading || browserClickingId) return;
    const point = browserViewportPoint(clientX, clientY);
    if (!point) return;
    setBrowserLoadError(null);
    setBrowserClickingId("__snapshot__");
    try {
      const snapshot = await invoke<BrowserSnapshot>("browser_click", {
        sessionId: browserSessionId,
        x: point.x,
        y: point.y,
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
      setBrowserLoadError(`Failed to open browser externally: ${describeError(e)}`);
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

  const fetchDesktopEntries = useCallback(async () => {
    const requestSeq = desktopEntriesFetchSeqRef.current + 1;
    desktopEntriesFetchSeqRef.current = requestSeq;
    try {
      const result = await invoke<WorkspaceFileEntry[]>("list_workspace_files", { path: DESKTOP_WORKSPACE_PATH });
      if (requestSeq !== desktopEntriesFetchSeqRef.current) return;
      const filtered = result
        .filter((entry) => !HIDDEN_FILES.has(entry.name))
        .sort((a, b) => (
          a.is_directory !== b.is_directory
            ? (a.is_directory ? -1 : 1)
            : a.name.localeCompare(b.name)
        ));
      const loadedAt = Date.now();
      writeDesktopWarmCache(filtered, desktopWarmCache.imagePreviews, loadedAt);
      desktopLoadedAtRef.current = loadedAt;
      setDesktopEntries((prev) => (workspaceEntriesEqual(prev, filtered) ? prev : filtered));
    } catch {
      if (requestSeq !== desktopEntriesFetchSeqRef.current) return;
      // Keep the current desktop visible on transient refresh failures instead of
      // clearing and repopulating every icon on the next successful poll.
    }
  }, []);

  useEffect(() => { if (finderOpen) fetchFiles(currentPath); }, [currentPath, fetchFiles, finderOpen]);
  useEffect(() => {
    if (desktopWarmCache.entries.length === 0) {
      void fetchDesktopEntries();
    }
    const refreshRootFolder = () => {
      if (document.hidden) return;
      if (Date.now() - desktopLoadedAtRef.current < DESKTOP_CACHE_STALE_MS) return;
      void fetchDesktopEntries();
    };
    const intervalId = window.setInterval(refreshRootFolder, WORKSPACE_FOLDER_REFRESH_MS);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [fetchDesktopEntries]);
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

  useEffect(() => {
    setDesktopIcons((prev) => {
      const next: Record<string, DesktopIcon> = {};
      const hasBounds = desktopBounds.width > 0 && desktopBounds.height > 0;
      const bounds = hasBounds ? desktopBounds : null;
      const workspaceBase = prev.workspace ?? { id: "workspace", x: DESKTOP_ICON_GRID_START_X, y: WORKSPACE_ICON_GRID_Y };
      next.workspace = bounds
        ? { id: "workspace", ...snapDesktopIconPosition(bounds, workspaceBase, new Set(), "workspace") }
        : workspaceBase;
      const occupied = new Set<string>([desktopIconGridKey(next.workspace)]);
      for (const entry of desktopEntries) {
        const key = desktopIconIdForPath(entry.path);
        const existing = prev[key];
        if (existing) {
          const normalized = bounds ? snapDesktopIconPosition(bounds, existing, occupied, key) : existing;
          next[key] = { id: key, x: normalized.x, y: normalized.y };
          occupied.add(desktopIconGridKey(next[key]));
        }
      }
      for (const entry of desktopEntries) {
        const key = desktopIconIdForPath(entry.path);
        if (next[key]) continue;
        const point = nextDesktopIconPosition(occupied, bounds ?? undefined);
        next[key] = { id: key, x: point.x, y: point.y };
      }
      const prevKeys = Object.keys(prev);
      const nextKeys = Object.keys(next);
      if (
        prevKeys.length === nextKeys.length &&
        nextKeys.every((key) => (
          prev[key]?.x === next[key]?.x &&
          prev[key]?.y === next[key]?.y
        ))
      ) {
        return prev;
      }
      return next;
    });
  }, [desktopBounds.height, desktopBounds.width, desktopEntries]);

  useEffect(() => {
    const requestSeq = desktopImagePreviewSeqRef.current + 1;
    desktopImagePreviewSeqRef.current = requestSeq;
    const previewableImageEntries = desktopEntries
      .filter(shouldLoadDesktopImagePreview)
      .slice(0, DESKTOP_IMAGE_PREVIEW_MAX_ITEMS);
    const imagePaths = new Set(previewableImageEntries.map((entry) => entry.path));
    setDesktopImagePreviews((prev) => {
      const nextEntries = Object.entries(prev).filter(([path]) => imagePaths.has(path));
      if (nextEntries.length === Object.keys(prev).length) {
        return prev;
      }
      return Object.fromEntries(nextEntries);
    });
    const missingEntries = previewableImageEntries.filter((entry) => !desktopImagePreviews[entry.path]);
    if (missingEntries.length === 0) {
      return;
    }
    let cancelled = false;
    void (async () => {
      const loadedEntries: Array<readonly [string, string]> = [];
      for (let index = 0; index < missingEntries.length; index += DESKTOP_IMAGE_PREVIEW_MAX_CONCURRENT) {
        const batch = missingEntries.slice(index, index + DESKTOP_IMAGE_PREVIEW_MAX_CONCURRENT);
        const batchResults: Array<[string, string] | null> = await Promise.all(
          batch.map(async (entry) => {
            try {
              const base64 = await invoke<string>("read_workspace_file_base64", { path: entry.path });
              return [
                entry.path,
                `data:${imageMimeTypeForName(entry.name)};base64,${base64}`,
              ];
            } catch {
              return null;
            }
          }),
        );
        if (cancelled || requestSeq !== desktopImagePreviewSeqRef.current) return;
        loadedEntries.push(
          ...batchResults.filter((entry): entry is [string, string] => entry !== null),
        );
      }
      if (cancelled || requestSeq !== desktopImagePreviewSeqRef.current || loadedEntries.length === 0) return;
      setDesktopImagePreviews((prev) => {
        const next = { ...prev };
        for (const [path, dataUrl] of loadedEntries) {
          next[path] = dataUrl;
        }
        return next;
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [desktopEntries, desktopImagePreviews]);

  useEffect(() => {
    writeDesktopWarmCache(desktopEntries, desktopImagePreviews, desktopLoadedAtRef.current);
  }, [desktopEntries, desktopImagePreviews]);

  function openFolder(path: string) { setCurrentPath(path); setHistory([path]); setHistoryIndex(0); setFinderOpen(true); setSelected(null); }
  function navigateTo(path: string) { const h = history.slice(0, historyIndex + 1); h.push(path); setHistory(h); setHistoryIndex(h.length - 1); setCurrentPath(path); setSelected(null); }
  function goBack() { if (historyIndex > 0) { setHistoryIndex(historyIndex - 1); setCurrentPath(history[historyIndex - 1]); setSelected(null); } }
  function goForward() { if (historyIndex < history.length - 1) { setHistoryIndex(historyIndex + 1); setCurrentPath(history[historyIndex + 1]); setSelected(null); } }

  function openOfficeWindow(kind: OfficeAppKind) {
    switch (kind) {
      case "sheets":
        setSheetsOpen(true);
        focusWindow("sheets");
        return;
      case "docs":
        setDocsOpen(true);
        focusWindow("docs");
        return;
      case "slides":
        setSlidesOpen(true);
        focusWindow("slides");
        return;
    }
  }

  function recordOfficeRecent(kind: OfficeAppKind, entry: WorkspaceFileEntry) {
    const nextRecent = {
      path: entry.path,
      name: entry.name,
      openedAt: Date.now(),
    };
    switch (kind) {
      case "sheets":
        setSheetsRecent((current) => pushOfficeRecentEntry(current, nextRecent));
        return;
      case "docs":
        setDocsRecent((current) => pushOfficeRecentEntry(current, nextRecent));
        return;
      case "slides":
        setSlidesRecent((current) => pushOfficeRecentEntry(current, nextRecent));
        return;
    }
  }

  function openOfficeAppHomeInChat() {
    createNewChatSession();
  }

  function openRecentOfficePath(path: string) {
    void runDesktopAction({ type: "open_workspace_file", path });
  }

  async function openWorkspaceFileInOfficeApp(entry: WorkspaceFileEntry) {
    const officeKind = officeAppKindForPath(entry.path);
    if (!officeKind) return false;
    try {
      setError(null);
      clientLog("office.open.start", { appKind: officeKind, path: entry.path });
      const session = await createOnlyOfficeSession(entry.path);
      const nextSession: OfficeAppSession = {
        path: entry.path,
        name: session.fileName || entry.name,
        url: session.url,
        appKind: officeKind,
        launchToken: `${Date.now()}`,
      };
      switch (officeKind) {
        case "sheets":
          setSheetsSession(nextSession);
          recordOfficeRecent("sheets", entry);
          openOfficeWindow("sheets");
          break;
        case "docs":
          setDocsSession(nextSession);
          recordOfficeRecent("docs", entry);
          openOfficeWindow("docs");
          break;
        case "slides":
          setSlidesSession(nextSession);
          recordOfficeRecent("slides", entry);
          openOfficeWindow("slides");
          break;
      }
      clientLog("office.open.ready", { appKind: officeKind, path: entry.path });
    } catch (e) {
      clientLog("office.open.failed", {
        appKind: officeKind,
        path: entry.path,
        error: e instanceof Error ? e.message : String(e),
      });
      setError(`Failed to start ONLYOFFICE: ${e instanceof Error ? e.message : String(e)}`);
    }
    return true;
  }

  function handleEntryClick(entry: WorkspaceFileEntry, e: React.MouseEvent) { e.stopPropagation(); setSelected(entry.path); }
  function handleEntryDoubleClick(entry: WorkspaceFileEntry) {
    if (entry.is_directory) {
      navigateTo(entry.path);
      return;
    }
    void runDesktopAction({ type: "open_workspace_file", path: entry.path });
  }
  function handleDesktopEntryOpen(entry: WorkspaceFileEntry) {
    if (entry.is_directory) {
      void runDesktopAction({ type: "open_workspace_folder", path: entry.path });
      return;
    }
    void runDesktopAction({ type: "open_workspace_file", path: entry.path });
  }
  function handleContextMenuEntry(entry: WorkspaceFileEntry, e: React.MouseEvent) { e.preventDefault(); e.stopPropagation(); setSelected(entry.path); setContextMenu({ x: e.clientX, y: e.clientY, entry }); }

  function dragEventHasFiles(e: React.DragEvent) {
    return Array.from(e.dataTransfer?.types ?? []).includes("Files");
  }

  function handleUploadDragOver(e: React.DragEvent, destPath: string) {
    if (!dragEventHasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "copy";
    setDragOver(true);
    setDragDropTarget(destPath);
  }

  function handleUploadDragLeave(e: React.DragEvent, destPath?: DesktopDropTarget) {
    e.preventDefault();
    e.stopPropagation();
    if (destPath !== undefined && dragDropTarget === destPath) {
      setDragDropTarget(null);
    }
    const rect = containerRef.current?.getBoundingClientRect();
    if (rect) {
      const { clientX: cx, clientY: cy } = e;
      if (cx < rect.left || cx > rect.right || cy < rect.top || cy > rect.bottom) {
        setDragOver(false);
        setDragDropTarget(null);
      }
    }
  }

  async function handleUploadDropToPath(e: React.DragEvent, destPath: string) {
    if (!dragEventHasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    setDragDropTarget(null);
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) {
      await uploadFiles(files, destPath);
    }
  }

  function resolveNativeDropTarget(payload: NativeDragDropPayload | null | undefined): DesktopDropTarget {
    return dropTargetFromClientPoint(nativeDragDropClientPoint(payload));
  }

  async function openWorkspaceFileInBrowser(entry: WorkspaceFileEntry) {
    if (entry.is_directory) return;
    if (workspaceFileUsesOnlyOffice(entry.path) && await openWorkspaceFileInOfficeApp(entry)) {
      return;
    }
    if (!workspaceFileCanOpenInBrowser(entry.path)) return;
    let targetUrl: string;
    targetUrl = workspaceBrowserUrl(entry.path);
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
    const resolution = resolveDesktopHandoff(handoff);
    switch (resolution.type) {
      case "ignore":
        return;
      case "open_browser_url":
        await openBrowserUrlInDesktop(resolution.url);
        return;
      case "open_workspace_in_browser":
        await openWorkspacePathInBrowser(resolution.path);
        return;
      case "preview_workspace_path":
        showWorkspacePathInDesktop(resolution.path, true);
        await previewWorkspacePath(resolution.path);
        return;
      case "open_workspace_file":
        await openWorkspaceFilePath(resolution.path);
        return;
      case "open_workspace_folder":
        openFolder(resolution.path);
        return;
      case "show_workspace_path":
        showWorkspacePathInDesktop(resolution.path, resolution.looksLikeFile);
        return;
    }
  }

  useEffect(() => {
    void applyDesktopHandoff(consumeDesktopHandoff());
    const handleDesktopHandoff = (event: Event) => {
      const detail = (event as CustomEvent<DesktopHandoff>).detail;
      void applyDesktopHandoff(detail ?? consumeDesktopHandoff());
    };
    window.addEventListener(DESKTOP_HANDOFF_EVENT, handleDesktopHandoff);
    return () => {
      window.removeEventListener(DESKTOP_HANDOFF_EVENT, handleDesktopHandoff);
    };
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

  async function openWorkspaceFilePath(path: string) {
    const entry: WorkspaceFileEntry = {
      name: workspacePathName(path),
      path,
      is_directory: false,
      size: 0,
      modified_at: 0,
    };
    if (workspaceFileUsesOnlyOffice(path) && await openWorkspaceFileInOfficeApp(entry)) {
      return;
    }
    if (workspaceFileCanOpenInBrowser(path)) {
      await openWorkspaceFileInBrowser(entry);
      return;
    }
    await handleView(entry);
  }

  function focusDesktopWindow(window: WindowKey) {
    switch (window) {
      case "finder":
        if (!finderOpen) {
          setFinderOpen(true);
          void fetchFiles(currentPath || "");
        }
        focusWindow("finder");
        return;
      case "chat":
        if (!chatOpen) setChatOpen(true);
        focusWindow("chat");
        return;
      case "browser":
        if (!browserOpen) setBrowserOpen(true);
        focusWindow("browser");
        return;
      case "terminal":
        if (!terminalOpen) setTerminalOpen(true);
        focusWindow("terminal");
        return;
      case "plugins":
      case "integrations":
        if (!pluginsOpen) setPluginsOpen(true);
        focusWindow("plugins");
        return;
      case "skills":
        if (!skillsOpen) setSkillsOpen(true);
        focusWindow("skills");
        return;
      case "channels":
        if (!channelsOpen) setChannelsOpen(true);
        focusWindow("channels");
        return;
      case "tasks":
        if (!tasksOpen) setTasksOpen(true);
        focusWindow("tasks");
        return;
      case "jobs":
        if (!jobsOpen) setJobsOpen(true);
        focusWindow("jobs");
        return;
      case "logs":
        if (!logsOpen) setLogsOpen(true);
        focusWindow("logs");
        return;
      case "billing":
        if (billingEnabled && !billingOpen) setBillingOpen(true);
        if (billingEnabled) focusWindow("billing");
        return;
      case "settings":
        if (!settingsOpen) setSettingsOpen(true);
        focusWindow("settings");
        return;
      case "preview":
        if (preview) focusWindow("preview");
        return;
      case "sheets":
        if (!sheetsOpen) setSheetsOpen(true);
        focusWindow("sheets");
        return;
      case "docs":
        if (!docsOpen) setDocsOpen(true);
        focusWindow("docs");
        return;
      case "slides":
        if (!slidesOpen) setSlidesOpen(true);
        focusWindow("slides");
        return;
      case "voiceOverlay":
        focusWindow("voiceOverlay");
        return;
    }
  }

  async function closeDesktopWindow(window: WindowKey) {
    switch (window) {
      case "finder":
        setFinderOpen(false);
        return;
      case "chat":
        setChatOpen(false);
        return;
      case "browser":
        await closeBrowserWindow();
        return;
      case "terminal":
        await closeTerminalWindow();
        return;
      case "plugins":
      case "integrations":
        setPluginsOpen(false);
        return;
      case "skills":
        setSkillsOpen(false);
        return;
      case "channels":
        setChannelsOpen(false);
        return;
      case "tasks":
        setTasksOpen(false);
        return;
      case "jobs":
        setJobsOpen(false);
        return;
      case "logs":
        setLogsOpen(false);
        return;
      case "billing":
        setBillingOpen(false);
        return;
      case "settings":
        setSettingsOpen(false);
        return;
      case "preview":
        setPreview(null);
        return;
      case "sheets":
        setSheetsOpen(false);
        setSheetsSession(null);
        return;
      case "docs":
        setDocsOpen(false);
        setDocsSession(null);
        return;
      case "slides":
        setSlidesOpen(false);
        setSlidesSession(null);
        return;
      case "voiceOverlay":
        return;
    }
  }

  function startDesktopChatTask(
    prompt: string,
    sessionId?: string,
    autoSubmit?: boolean,
    speakResponse?: boolean,
  ) {
    setChatOpen(true);
    focusWindow("chat");
    setChatRequestedSession(sessionId || null);
    setChatRequestedAction({
      id: `compose-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      type: "compose",
      key: sessionId,
      prompt,
      submit: autoSubmit === true,
      speakResponse: speakResponse === true,
    });
  }

  async function runDesktopAction(action: DesktopAction) {
    await dispatchDesktopAction(
      action,
      {
        openWorkspaceFile: openWorkspaceFilePath,
        openWorkspaceFolder: openFolder,
        openBrowserUrl: openBrowserUrlInDesktop,
        focusWindow: focusDesktopWindow,
        closeWindow: closeDesktopWindow,
        newChatTask: startDesktopChatTask,
      },
      { isTrustedLocalPreviewUrl },
    );
  }
  desktopActionHandlerRef.current = runDesktopAction;

  useEffect(() => {
    if (!pendingDesktopAction) return;
    const handler = desktopActionHandlerRef.current;
    if (!handler) return;
    const { id, action } = pendingDesktopAction;
    if (handledDesktopActionIdsRef.current.has(id)) return;
    handledDesktopActionIdsRef.current.add(id);
    clientLog("desktop_action.replay", { id, type: action.type });
    void handler(action)
      .catch((error) => {
        clientLog("desktop_action.replay.failed", {
          id,
          error: error instanceof Error ? error.message : String(error),
        });
        setError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        clientLog("desktop_action.replay.done", { id });
        onDesktopActionHandled?.(id);
      });
  }, [pendingDesktopAction, onDesktopActionHandled]);

  function requestDesktopWindowFocus(window: WindowKey) {
    void runDesktopAction({ type: "focus_window", window });
  }

  async function copyDesktopPath(path: string) {
    try {
      await navigator.clipboard?.writeText?.(path);
    } catch (e) {
      setError(`Copy failed: ${describeError(e)}`);
    }
  }

  async function exportWorkspaceEntry(entry: Pick<WorkspaceFileEntry, "name" | "path">) {
    try {
      await invoke("export_workspace_file", {
        path: entry.path,
        suggestedName: entry.name,
      });
    } catch (e) {
      setError(`Export failed: ${describeError(e)}`);
    }
  }

  async function exportPreviewFile() {
    if (!preview) return;
    await exportWorkspaceEntry(preview);
  }

  async function copyPreviewText() {
    if (!preview || preview.kind !== "text") return;
    try {
      await navigator.clipboard?.writeText?.(preview.content);
    } catch (e) {
      setError(`Copy failed: ${describeError(e)}`);
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
        setPreview({ kind: "image", name: entry.name, path: entry.path, dataUrl: `data:${mime};base64,${base64}` });
        focusWindow("preview");
        return;
      }
      if (BINARY_EXTS.has(ext)) {
        setPreview({ kind: "binary", name: entry.name, path: entry.path, size: entry.size });
        focusWindow("preview");
        return;
      }
      const c = await invoke<string>("read_workspace_file", { path: entry.path });
      setPreview({ kind: "text", name: entry.name, path: entry.path, content: c });
      focusWindow("preview");
    } catch (e) {
      setError(`Failed to read: ${describeError(e)}`);
    }
  }

  async function handleDelete(entry: WorkspaceFileEntry) {
    if (!confirm(`Move "${entry.name}" to Trash?`)) return;
    try {
      await invoke("delete_workspace_file", { path: entry.path });
      setSelected(null);
      void fetchDesktopEntries();
      fetchFiles(currentPath);
    }
    catch (e) { setError(`Delete failed: ${e instanceof Error ? e.message : String(e)}`); }
  }

  function handleCreateFolder(basePath?: string) {
    const root = typeof basePath === "string" ? basePath : currentPath;
    setCreateFolderBasePath(root);
    setCreateFolderName("");
    setCreateFolderOpen(true);
    setContextMenu(null);
  }

  function handleCreateFile(basePath?: string) {
    const root = typeof basePath === "string" ? basePath : currentPath;
    setCreateFileBasePath(root);
    setCreateFileName("");
    setCreateFileOpen(true);
    setContextMenu(null);
  }

  useEffect(() => {
    if (!createFolderOpen) return;
    const id = window.setTimeout(() => createFolderInputRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [createFolderOpen]);

  useEffect(() => {
    if (!createFileOpen) return;
    const id = window.setTimeout(() => createFileInputRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [createFileOpen]);

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
      void fetchDesktopEntries();
      if (finderOpen) await fetchFiles(currentPath);
    }
    catch (e) { setError(`Failed to create folder: ${describeError(e)}`); }
    finally { setCreatingFolder(false); }
  }

  async function submitCreateFile() {
    const trimmedName = createFileName.trim();
    if (!trimmedName || creatingFile) return;
    const root = createFileBasePath;
    setCreatingFile(true);
    setError(null);
    try {
      const created = await invoke<WorkspaceFileEntry>("create_workspace_file", {
        parentPath: root,
        name: trimmedName,
        content: "",
      });
      setCreateFileOpen(false);
      setCreateFileName("");
      setSelected(created.path);
      void fetchDesktopEntries();
      if (finderOpen) await fetchFiles(currentPath);
    } catch (e) {
      setError(`Failed to create file: ${describeError(e)}`);
    } finally {
      setCreatingFile(false);
    }
  }

  // ── Drag & Drop files ───────────────────────────────────────────────

  async function uploadFiles(files: globalThis.File[], destPath: string) {
    setUploading(true); setError(null);
    try {
      for (const file of files) {
        const buf = await file.arrayBuffer(); const bytes = new Uint8Array(buf);
        let binary = ""; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
        await invoke("upload_workspace_file", { fileName: file.name, base64: btoa(binary), destPath });
      }
      void fetchDesktopEntries();
      if (finderOpen) fetchFiles(currentPath);
    } catch (err) { setError(`Upload failed: ${err instanceof Error ? err.message : String(err)}`); }
    finally { setUploading(false); }
  }

  async function uploadHostDroppedFiles(paths: string[], destPath: string) {
    const sanitizedPaths = paths
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter(Boolean);
    if (sanitizedPaths.length === 0) return;
    setUploading(true);
    setError(null);
    try {
      await invoke<WorkspaceFileEntry[]>("upload_host_dropped_files", {
        paths: sanitizedPaths,
        destPath,
      });
      void fetchDesktopEntries();
      if (finderOpen) void fetchFiles(currentPath);
    } catch (err) {
      setError(`Upload failed: ${describeError(err)}`);
    } finally {
      setUploading(false);
    }
  }

  async function handleFileInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files ? Array.from(e.target.files) : [];
    if (files.length === 0) return;
    e.target.value = "";
    uploadFiles(files, finderOpen ? currentPath : DESKTOP_WORKSPACE_PATH);
  }

  useEffect(() => {
    let disposed = false;
    const unlistenFns: Array<() => void> = [];

    const register = async () => {
      const attach = async (
        eventName: string,
        handler: (payload: NativeDragDropPayload | null | undefined) => void | Promise<void>,
      ) => {
        const unlisten = await listen<NativeDragDropPayload>(eventName, (event) => {
          if (disposed) return;
          void handler(event.payload);
        });
        if (disposed) {
          unlisten();
          return;
        }
        unlistenFns.push(unlisten);
      };

      await attach("tauri://drag-enter", (payload) => {
        const target = resolveNativeDropTarget(payload);
        setDragOver(target !== null);
        setDragDropTarget(target);
      });
      await attach("tauri://drag-over", (payload) => {
        const target = resolveNativeDropTarget(payload);
        setDragOver(target !== null);
        setDragDropTarget(target);
      });
      await attach("tauri://drag-leave", () => {
        setDragOver(false);
        setDragDropTarget(null);
      });
      await attach("tauri://drag-drop", async (payload) => {
        const target = resolveNativeDropTarget(payload);
        setDragOver(false);
        setDragDropTarget(null);
        if (target === null) return;
        const droppedPaths = Array.isArray(payload?.paths)
          ? payload.paths.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
          : [];
        if (droppedPaths.length === 0) return;
        await uploadHostDroppedFiles(droppedPaths, target);
      });
    };

    void register();
    return () => {
      disposed = true;
      for (const unlisten of unlistenFns) {
        unlisten();
      }
    };
  }, [currentPath, fetchDesktopEntries, fetchFiles, finderOpen]);

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

  function handleDesktopChatNavigate(page: "chat" | "store" | "integrations" | "skills" | "channels" | "files" | "tasks" | "jobs" | "settings" | "billing") {
    switch (page) {
      case "chat":
        setChatOpen(true);
        focusWindow("chat");
        return;
      case "store":
      case "integrations":
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
        if (!billingEnabled) {
          return;
        }
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
  const browserWindowZ = getWindowZ(windowZ, "browser");
  const embeddedPreviewForegroundWindows = useMemo(() => {
    const frames: Array<{ z: number; rect: WindowRect }> = [];
    if (finderOpen) {
      frames.push({ z: getWindowZ(windowZ, "finder"), rect: { x: finderPos.x, y: finderPos.y, w: finderSize.w, h: finderSize.h } });
    }
    if (chatOpen) {
      frames.push({ z: getWindowZ(windowZ, "chat"), rect: { x: chatPos.x, y: chatPos.y, w: chatSize.w, h: chatSize.h } });
    }
    if (terminalOpen) {
      frames.push({ z: getWindowZ(windowZ, "terminal"), rect: { x: terminalPos.x, y: terminalPos.y, w: terminalSize.w, h: terminalSize.h } });
    }
    if (sheetsOpen) {
      frames.push({ z: getWindowZ(windowZ, "sheets"), rect: { x: sheetsPos.x, y: sheetsPos.y, w: sheetsSize.w, h: sheetsSize.h } });
    }
    if (docsOpen) {
      frames.push({ z: getWindowZ(windowZ, "docs"), rect: { x: docsPos.x, y: docsPos.y, w: docsSize.w, h: docsSize.h } });
    }
    if (slidesOpen) {
      frames.push({ z: getWindowZ(windowZ, "slides"), rect: { x: slidesPos.x, y: slidesPos.y, w: slidesSize.w, h: slidesSize.h } });
    }
    if (pluginsOpen) {
      frames.push({ z: getWindowZ(windowZ, "plugins"), rect: { x: pluginsPos.x, y: pluginsPos.y, w: pluginsSize.w, h: pluginsSize.h } });
    }
    if (skillsOpen) {
      frames.push({ z: getWindowZ(windowZ, "skills"), rect: { x: skillsPos.x, y: skillsPos.y, w: skillsSize.w, h: skillsSize.h } });
    }
    if (channelsOpen) {
      frames.push({ z: getWindowZ(windowZ, "channels"), rect: { x: channelsPos.x, y: channelsPos.y, w: channelsSize.w, h: channelsSize.h } });
    }
    if (tasksOpen) {
      frames.push({ z: getWindowZ(windowZ, "tasks"), rect: { x: tasksPos.x, y: tasksPos.y, w: tasksSize.w, h: tasksSize.h } });
    }
    if (jobsOpen) {
      frames.push({ z: getWindowZ(windowZ, "jobs"), rect: { x: jobsPos.x, y: jobsPos.y, w: jobsSize.w, h: jobsSize.h } });
    }
    if (logsOpen) {
      frames.push({ z: getWindowZ(windowZ, "logs"), rect: { x: logsPos.x, y: logsPos.y, w: logsSize.w, h: logsSize.h } });
    }
    if (billingEnabled && billingOpen) {
      frames.push({ z: getWindowZ(windowZ, "billing"), rect: { x: billingPos.x, y: billingPos.y, w: billingSize.w, h: billingSize.h } });
    }
    if (settingsOpen) {
      frames.push({ z: getWindowZ(windowZ, "settings"), rect: { x: settingsPos.x, y: settingsPos.y, w: settingsSize.w, h: settingsSize.h } });
    }
    if (preview) {
      frames.push({
        z: getWindowZ(windowZ, "preview"),
        rect: { x: previewPos.x, y: previewPos.y, w: previewSize.w, h: previewSize.h },
      });
    }
    return frames.filter((frame) => frame.z > browserWindowZ);
  }, [
    browserWindowZ,
    finderOpen,
    finderPos.x,
    finderPos.y,
    finderSize.w,
    finderSize.h,
    chatOpen,
    chatPos.x,
    chatPos.y,
    chatSize.w,
    chatSize.h,
    terminalOpen,
    terminalPos.x,
    terminalPos.y,
    terminalSize.w,
    terminalSize.h,
    sheetsOpen,
    sheetsPos.x,
    sheetsPos.y,
    sheetsSize.w,
    sheetsSize.h,
    docsOpen,
    docsPos.x,
    docsPos.y,
    docsSize.w,
    docsSize.h,
    slidesOpen,
    slidesPos.x,
    slidesPos.y,
    slidesSize.w,
    slidesSize.h,
    pluginsOpen,
    pluginsPos.x,
    pluginsPos.y,
    pluginsSize.w,
    pluginsSize.h,
    skillsOpen,
    skillsPos.x,
    skillsPos.y,
    skillsSize.w,
    skillsSize.h,
    channelsOpen,
    channelsPos.x,
    channelsPos.y,
    channelsSize.w,
    channelsSize.h,
    tasksOpen,
    tasksPos.x,
    tasksPos.y,
    tasksSize.w,
    tasksSize.h,
    jobsOpen,
    jobsPos.x,
    jobsPos.y,
    jobsSize.w,
    jobsSize.h,
    logsOpen,
    logsPos.x,
    logsPos.y,
    logsSize.w,
    logsSize.h,
    billingEnabled,
    billingOpen,
    billingPos.x,
    billingPos.y,
    billingSize.w,
    billingSize.h,
    settingsOpen,
    settingsPos.x,
    settingsPos.y,
    settingsSize.w,
    settingsSize.h,
    preview,
    previewPos.x,
    previewPos.y,
    previewSize.w,
    previewSize.h,
    windowZ.finder,
    windowZ.chat,
    windowZ.terminal,
    windowZ.sheets,
    windowZ.docs,
    windowZ.slides,
    windowZ.plugins,
    windowZ.skills,
    windowZ.channels,
    windowZ.tasks,
    windowZ.jobs,
    windowZ.logs,
    windowZ.billing,
    windowZ.settings,
    windowZ.preview,
  ]);
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
        setBrowserEmbeddedPreviewCovered(false);
        try {
          await hideEmbeddedPreviewWebview();
        } catch {
          // Ignore embedded preview hide failures during teardown.
        }
        return;
      }

      const viewport = browserViewportRef.current;
      const containerBounds = containerRef.current?.getBoundingClientRect();
      const viewportBounds = viewport?.getBoundingClientRect();
      const isCoveredByForegroundWindow = Boolean(
        viewportBounds &&
        containerBounds &&
        embeddedPreviewForegroundWindows.some((frame) => (
          windowRectsIntersect(
            {
              x: viewportBounds.left - containerBounds.left,
              y: viewportBounds.top - containerBounds.top,
              w: viewportBounds.width,
              h: viewportBounds.height,
            },
            frame.rect,
          )
        ))
      );
      setBrowserEmbeddedPreviewCovered(isCoveredByForegroundWindow);
      if (!browserOpen || !viewport || isCoveredByForegroundWindow) {
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
      const previewInset = EMBEDDED_PREVIEW_FRAME_INSET;
      const embeddedPreviewX = rect.left + previewInset;
      const embeddedPreviewY = rect.top + previewInset;
      const embeddedPreviewWidth = Math.max(rect.width - previewInset * 2, 1);
      const embeddedPreviewHeight = Math.max(rect.height - previewInset * 2, 1);

      const nextKey = [
        browserEmbeddedPreview.url,
        Math.round(embeddedPreviewX),
        Math.round(embeddedPreviewY),
        Math.round(embeddedPreviewWidth),
        Math.round(embeddedPreviewHeight),
      ].join("|");
      if (browserEmbeddedPreviewSyncKeyRef.current === nextKey) {
        return;
      }
      browserEmbeddedPreviewSyncKeyRef.current = nextKey;

      try {
        const resolved = await syncEmbeddedPreviewWebview({
          url: browserEmbeddedPreview.url,
          x: embeddedPreviewX,
          y: embeddedPreviewY,
          width: embeddedPreviewWidth,
          height: embeddedPreviewHeight,
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
    embeddedPreviewForegroundWindows,
    browserPos,
    browserSize,
    desktopBounds.width,
    desktopBounds.height,
  ]);

  const voiceOpenWindows: WindowKey[] = [];
  if (finderOpen) voiceOpenWindows.push("finder");
  if (chatOpen) voiceOpenWindows.push("chat");
  if (browserOpen) voiceOpenWindows.push("browser");
  if (terminalOpen) voiceOpenWindows.push("terminal");
  if (sheetsOpen) voiceOpenWindows.push("sheets");
  if (docsOpen) voiceOpenWindows.push("docs");
  if (slidesOpen) voiceOpenWindows.push("slides");
  if (pluginsOpen) voiceOpenWindows.push("plugins");
  if (skillsOpen) voiceOpenWindows.push("skills");
  if (channelsOpen) voiceOpenWindows.push("channels");
  if (tasksOpen) voiceOpenWindows.push("tasks");
  if (jobsOpen) voiceOpenWindows.push("jobs");
  if (logsOpen) voiceOpenWindows.push("logs");
  if (billingEnabled && billingOpen) voiceOpenWindows.push("billing");
  if (settingsOpen) voiceOpenWindows.push("settings");
  if (preview) voiceOpenWindows.push("preview");

  const focusedVoiceWindow = voiceOpenWindows.reduce<WindowKey | null>((current, key) => {
    if (!current) return key;
    return getWindowZ(windowZ, key) > getWindowZ(windowZ, current) ? key : current;
  }, null);
  const isDesktopWindowActive = (key: WindowKey) => focusedVoiceWindow === key;
  const activeOffice = [
    { appKind: "sheets" as const, open: sheetsOpen, session: sheetsSession },
    { appKind: "docs" as const, open: docsOpen, session: docsSession },
    { appKind: "slides" as const, open: slidesOpen, session: slidesSession },
  ]
    .filter((entry) => entry.open)
    .sort((a, b) => getWindowZ(windowZ, b.appKind) - getWindowZ(windowZ, a.appKind))[0] ?? null;
  const voiceDesktopContext: VoiceDesktopContext = {
    focusedWindow: focusedVoiceWindow,
    openWindows: voiceOpenWindows,
    finderPath: currentPath || "/",
    selectedWorkspaceFile: selected && !selected.startsWith("__") ? selected : null,
    browser: browserOpen ? { url: browserCurrentUrl, title: browserTitle || null } : null,
    office: activeOffice
      ? {
          appKind: activeOffice.appKind,
          path: activeOffice.session?.path ?? null,
          name: activeOffice.session?.name ?? null,
        }
      : null,
    integrations: integrationsMissing ? "missing configuration" : integrationsSyncing ? "syncing" : "ready",
  };

  // ═══════════════════════════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════════════════════════

  return (
    <div className="h-full w-full min-w-0 flex flex-col relative overflow-hidden">
      {/* Main area */}
      <div className="flex-1 min-w-0 flex overflow-hidden">

        {/* Desktop area */}
        <div
          ref={containerRef}
          className="flex-1 min-w-0 relative overflow-hidden"
          data-desktop-drop-target={DESKTOP_WORKSPACE_PATH}
          onDragOver={(e) => handleUploadDragOver(e, DESKTOP_WORKSPACE_PATH)}
          onDragLeave={(e) => handleUploadDragLeave(e)}
          onDrop={(e) => { void handleUploadDropToPath(e, DESKTOP_WORKSPACE_PATH); }}
          onContextMenu={(e) => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY }); }}
          onClick={() => { setSelected(null); setContextMenu(null); setShowWallpaperPicker(false); setDragDropTarget(null); }}
        >
          {/* Wallpaper */}
          <div className="absolute inset-0" style={isWpImage ? { backgroundImage: wallpaperCss, backgroundSize: "cover", backgroundPosition: "center" } : { background: wallpaperCss }} />

          <DesktopIconGrid
            agentName={agentName}
            entries={desktopEntries}
            desktopIcons={desktopIcons}
            imagePreviews={desktopImagePreviews}
            selected={selected}
            dragDropTarget={dragDropTarget}
            iconClickGuardRef={iconClickGuardRef}
            iconIdForPath={desktopIconIdForPath}
            isImageEntry={isImageWorkspaceEntry}
            onIconMouseDown={handleIconMouseDown}
            onUploadDragOver={handleUploadDragOver}
            onUploadDragLeave={handleUploadDragLeave}
            onUploadDropToPath={(e, path) => { void handleUploadDropToPath(e, path); }}
            onSelectWorkspace={() => setSelected("__user_folder")}
            onWorkspaceContextMenu={(e) => {
              setSelected("__user_folder");
              setContextMenu({ x: e.clientX, y: e.clientY });
            }}
            onOpenWorkspace={() => openFolder("")}
            onSelectEntry={(entry) => setSelected(entry.path)}
            onEntryContextMenu={(entry, e) => {
              setSelected(entry.path);
              setContextMenu({ x: e.clientX, y: e.clientY, entry });
            }}
            onOpenEntry={handleDesktopEntryOpen}
          />

          {/* Drag overlay */}
          {dragOver && (
            <div className="absolute inset-0 z-20 flex items-center justify-center pointer-events-none animate-fade-in" style={{ background: "rgba(0,0,0,0.3)", backdropFilter: "blur(8px)" }}>
              <div className="rounded-3xl px-16 py-12 text-center" style={{ border: "3px dashed rgba(255,255,255,0.7)", background: "rgba(255,255,255,0.08)", boxShadow: "0 0 80px rgba(147,51,234,0.12)" }}>
                <div className="w-20 h-20 mx-auto mb-4 rounded-2xl flex items-center justify-center" style={{ background: "rgba(255,255,255,0.12)" }}>
                  <ArrowUp className="w-10 h-10 animate-bounce" style={{ color: "white" }} />
                </div>
                <p className="text-xl font-semibold" style={{ color: "white", textShadow: "0 2px 8px rgba(0,0,0,0.4)" }}>Drop files to upload</p>
                <p className="text-sm mt-2" style={{ color: "rgba(255,255,255,0.7)" }}>
                  {`Files will be added to ${describeDesktopDropTarget(dragDropTarget)}`}
                </p>
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

          {finderOpen && (
            <FinderApp
              position={finderPos}
              size={finderSize}
              zIndex={getWindowZ(windowZ, "finder")}
              currentPath={currentPath}
              pathSegments={pathSegments}
              folderName={folderName}
              entries={entries}
              loading={loading}
              viewMode={viewMode}
              selected={selected}
              dragDropTarget={dragDropTarget}
              historyIndex={historyIndex}
              historyLength={history.length}
              itemCount={itemCount}
              formatDate={formatDate}
              formatSize={formatSize}
              onClose={() => setFinderOpen(false)}
              onFocus={() => focusWindow("finder")}
              onDragStart={handleFinderDragStart}
              onBack={goBack}
              onForward={goForward}
              onNavigate={navigateTo}
              onViewModeChange={setViewMode}
              onCreateFile={handleCreateFile}
              onCreateFolder={handleCreateFolder}
              onChooseFiles={() => fileInputRef.current?.click()}
              onClearSelection={() => {
                setSelected(null);
                setContextMenu(null);
                setDragDropTarget(null);
              }}
              onDragOverPath={handleUploadDragOver}
              onDragLeavePath={handleUploadDragLeave}
              onDropToPath={(e, path) => { void handleUploadDropToPath(e, path); }}
              onEntryClick={handleEntryClick}
              onEntryDoubleClick={handleEntryDoubleClick}
              onEntryContextMenu={handleContextMenuEntry}
            />
          )}

          <DesktopContextMenus
            contextMenu={contextMenu}
            desktopBasePath={DESKTOP_WORKSPACE_PATH}
            currentPath={currentPath}
            finderOpen={finderOpen}
            zIndex={DESKTOP_CONTEXT_MENU_Z}
            onClose={() => setContextMenu(null)}
            onCreateFile={handleCreateFile}
            onCreateFolder={handleCreateFolder}
            onOpenBrowser={openBrowserWindow}
            onOpenTerminal={openTerminalWindow}
            onChangeWallpaper={() => setShowWallpaperPicker(true)}
            onAddFiles={() => fileInputRef.current?.click()}
            onOpenWorkspace={() => openFolder("")}
            onOpenEntry={handleEntryDoubleClick}
            onOpenEntryInBrowser={openWorkspaceFileInBrowser}
            onQuickLook={handleView}
            onExport={exportWorkspaceEntry}
            onCopyPath={copyDesktopPath}
            onDelete={handleDelete}
            canOpenInBrowser={workspaceFileCanOpenInBrowser}
          />

          {showWallpaperPicker ? (
            <WallpaperPicker
              wallpaperId={wallpaperId}
              customWallpaper={customWallpaper}
              inputRef={wallpaperInputRef}
              onSelectWallpaper={(id, custom) => {
                void saveWallpaper(id, custom);
                setShowWallpaperPicker(false);
              }}
              onChooseCustom={() => wallpaperInputRef.current?.click()}
              onCustomUpload={handleCustomWallpaperUpload}
            />
          ) : null}

          {preview !== null ? (
            <FilePreviewWindow
              preview={preview}
              position={previewPos}
              size={previewSize}
              zIndex={getWindowZ(windowZ, "preview")}
              formatSize={formatSize}
              onFocus={() => focusWindow("preview")}
              onDragStart={handlePreviewDragStart}
              onResizeStart={handlePreviewResizeStart}
              onClose={() => setPreview(null)}
              onCopyText={copyPreviewText}
              onExport={exportPreviewFile}
            />
          ) : null}

          {/* Error toast */}
          {error && (
            <div className="absolute top-4 left-1/2 -translate-x-1/2 z-[70] flex items-center gap-2 px-4 py-2 rounded-lg text-xs animate-fade-in" style={{ background: "rgba(220,38,38,0.9)", color: "white", backdropFilter: "blur(8px)", boxShadow: "0 4px 20px rgba(0,0,0,0.3)" }} onClick={(e) => e.stopPropagation()}>
              <span className="flex-1">{error}</span>
              <button onClick={() => setError(null)} className="font-medium underline">Dismiss</button>
            </div>
          )}

          <CreateWorkspaceEntryModal
            kind="folder"
            open={createFolderOpen}
            basePath={createFolderBasePath}
            value={createFolderName}
            busy={creatingFolder}
            inputRef={createFolderInputRef}
            zIndex={DESKTOP_MODAL_Z}
            placeholder="Folder name"
            onValueChange={setCreateFolderName}
            onCancel={() => setCreateFolderOpen(false)}
            onSubmit={submitCreateFolder}
          />

          <CreateWorkspaceEntryModal
            kind="file"
            open={createFileOpen}
            basePath={createFileBasePath}
            value={createFileName}
            busy={creatingFile}
            inputRef={createFileInputRef}
            zIndex={DESKTOP_MODAL_Z}
            placeholder="notes.md"
            helperText="Markdown and text files can be copied directly from Quick Look after creation."
            onValueChange={setCreateFileName}
            onCancel={() => setCreateFileOpen(false)}
            onSubmit={submitCreateFile}
          />

          {chatOpen && (
            <ChatDesktopApp
              open={chatOpen}
              position={chatPos}
              size={chatSize}
              zIndex={getWindowZ(windowZ, "chat")}
              active={isDesktopWindowActive("chat")}
              navCollapsed={chatNavCollapsed}
              sessions={chatSessions}
              currentSession={chatCurrentSession}
              query={chatSessionQuery}
              requestedSession={chatRequestedSession}
              requestedSessionAction={chatRequestedAction}
              openSessionMenuKey={openChatSessionMenuKey}
              gatewayRunning={gatewayRunning}
              gatewayStarting={Boolean(gatewayRetryIn) || (isTogglingGateway && !gatewayRunning)}
              gatewayRetryIn={gatewayRetryIn ?? null}
              useLocalKeys={useLocalKeys}
              selectedModel={selectedModel}
              imageModel={imageModel}
              imageGenerationModel={imageGenerationModel}
              textToSpeechModel={textToSpeechModel}
              audioUnderstandingModel={audioUnderstandingModel}
              voiceSpeechRate={voiceSpeechRate}
              voiceSpeechVoice={voiceSpeechVoice}
              integrationsSyncing={integrationsSyncing}
              integrationsMissing={integrationsMissing}
              formatDate={formatDate}
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
                  chatMinSize,
                )
              }
              onNavCollapsedChange={setChatNavCollapsed}
              onQueryChange={setChatSessionQuery}
              onCreateSession={createNewChatSession}
              onSelectSession={selectChatSession}
              onRequestSessionAction={requestChatSessionAction}
              onOpenSessionMenuKeyChange={setOpenChatSessionMenuKey}
              onStartGateway={onGatewayToggle}
              onRecoverProxyAuth={onRecoverProxyAuth}
              onModelChange={onModelChange}
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
            />
          )}

          {browserOpen && (
            <BrowserApp
              position={browserPos}
              size={browserSize}
              zIndex={getWindowZ(windowZ, "browser")}
              tabs={browserTabs}
              activeTabId={activeBrowserTabId}
              urlInput={browserUrlInput}
              canGoBack={browserCanGoBack}
              canGoForward={browserCanGoForward}
              loading={browserLoading}
              loadError={browserLoadError}
              loadErrorSummary={browserLoadError ? firstMeaningfulLine(browserLoadError) : null}
              usingEmbeddedPreview={browserUsingEmbeddedPreview}
              embeddedPreviewCovered={browserEmbeddedPreviewCovered}
              snapshotImage={browserSnapshotImage}
              title={browserTitle}
              liveConnected={browserLiveConnected}
              hasRenderableImage={browserHasRenderableImage}
              liveStatePresent={Boolean(browserLiveState)}
              snapshotPresent={Boolean(browserSnapshot)}
              snapshotWidth={browserSnapshot?.screenshot_width ?? 0}
              snapshotHeight={browserSnapshot?.screenshot_height ?? 0}
              viewportWidth={browserViewportWidth}
              viewportHeight={browserViewportHeight}
              interactiveElements={browserSnapshot?.interactive_elements ?? []}
              clickingId={browserClickingId}
              viewportRef={browserViewportRef}
              liveImageRef={browserLiveImageRef}
              labelTab={browserTabLabel}
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
              onSelectTab={selectBrowserTab}
              onCloseTab={(tabId) => { void closeBrowserTab(tabId); }}
              onUrlInputChange={setBrowserUrlInput}
              onNavigate={(target) => { void navigateBrowser(target); }}
              onBack={() => { void goBrowserBack(); }}
              onForward={() => { void goBrowserForward(); }}
              onReload={() => { void reloadBrowser(); }}
              onOpenExternal={(target) => { void openBrowserExternally(target); }}
              onCreateTab={() => createBrowserTab()}
              onRetry={() => { void retryCurrentBrowserTarget(); }}
              onDismissError={() => setBrowserLoadError(null)}
              onLiveFocus={() => sendBrowserLiveMessage({ type: "focus" })}
              onViewportMouseMove={handleBrowserViewportMouseMove}
              onViewportMouseDown={handleBrowserViewportMouseDown}
              onViewportMouseUp={handleBrowserViewportMouseUp}
              onViewportClick={(clientX, clientY) => {
                void clickBrowserSnapshotAtPoint(clientX, clientY);
              }}
              onViewportWheel={handleBrowserViewportWheel}
              onViewportKeyDown={handleBrowserViewportKeyDown}
              onViewportPaste={handleBrowserViewportPaste}
              onViewportCopy={handleBrowserViewportCopy}
              onElementClick={(element) => { void clickBrowserElement(element); }}
            />
          )}

          <OfficeApps
            open={{ sheets: sheetsOpen, docs: docsOpen, slides: slidesOpen }}
            sessions={{ sheets: sheetsSession, docs: docsSession, slides: slidesSession }}
            recent={{ sheets: sheetsRecent, docs: docsRecent, slides: slidesRecent }}
            position={{ sheets: sheetsPos, docs: docsPos, slides: slidesPos }}
            size={{ sheets: sheetsSize, docs: docsSize, slides: slidesSize }}
            zIndex={{
              sheets: getWindowZ(windowZ, "sheets"),
              docs: getWindowZ(windowZ, "docs"),
              slides: getWindowZ(windowZ, "slides"),
            }}
            onClose={(kind) => closeDesktopWindow(kind)}
            onFocus={(kind) => focusWindow(kind)}
            onDragStart={(kind, e) => {
              if (kind === "sheets") {
                startWindowDrag(e, sheetsDragRef, sheetsPos, sheetsSize, setSheetsPos, "sheets");
              } else if (kind === "docs") {
                startWindowDrag(e, docsDragRef, docsPos, docsSize, setDocsPos, "docs");
              } else {
                startWindowDrag(e, slidesDragRef, slidesPos, slidesSize, setSlidesPos, "slides");
              }
            }}
            onResizeStart={(kind, direction, e) => {
              if (kind === "sheets") {
                startWindowResize(
                  e,
                  direction,
                  sheetsResizeRef,
                  sheetsPos,
                  sheetsSize,
                  setSheetsPos,
                  setSheetsSize,
                  "sheets",
                  { w: 720, h: 480 },
                );
              } else if (kind === "docs") {
                startWindowResize(
                  e,
                  direction,
                  docsResizeRef,
                  docsPos,
                  docsSize,
                  setDocsPos,
                  setDocsSize,
                  "docs",
                  { w: 720, h: 480 },
                );
              } else {
                startWindowResize(
                  e,
                  direction,
                  slidesResizeRef,
                  slidesPos,
                  slidesSize,
                  setSlidesPos,
                  setSlidesSize,
                  "slides",
                  { w: 720, h: 480 },
                );
              }
            }}
            onOpenRecent={openRecentOfficePath}
            onOpenChat={openOfficeAppHomeInChat}
          />

          {/* ── TERMINAL WINDOW ─────────────────────────────────────── */}
          {terminalOpen && (
            <TerminalApp
              position={terminalPos}
              size={terminalSize}
              zIndex={getWindowZ(windowZ, "terminal")}
              sessionId={terminalSessionId}
              output={terminalOutput}
              input={terminalInput}
              status={terminalStatus}
              exitCode={terminalExitCode}
              error={terminalError}
              bootstrapping={terminalBootstrapping}
              outputRef={terminalOutputRef}
              onInputChange={setTerminalInput}
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
              onClear={() => { void clearTerminalBuffer(); }}
              onRestart={() => { void restartTerminalSession(); }}
              onSubmit={() => { void submitTerminalInput(); }}
            />
          )}

          <DesktopUtilityWindows
            windowZ={windowZ}
            active={{
              plugins: isDesktopWindowActive("plugins"),
              skills: isDesktopWindowActive("skills"),
              channels: isDesktopWindowActive("channels"),
              tasks: isDesktopWindowActive("tasks"),
              jobs: isDesktopWindowActive("jobs"),
              logs: isDesktopWindowActive("logs"),
              billing: isDesktopWindowActive("billing"),
              settings: isDesktopWindowActive("settings"),
            }}
            windows={{
              plugins: { open: pluginsOpen, position: pluginsPos, size: pluginsSize },
              skills: { open: skillsOpen, position: skillsPos, size: skillsSize },
              channels: { open: channelsOpen, position: channelsPos, size: channelsSize },
              tasks: { open: tasksOpen, position: tasksPos, size: tasksSize },
              jobs: { open: jobsOpen, position: jobsPos, size: jobsSize },
              logs: { open: logsOpen, position: logsPos, size: logsSize },
              billing: { open: billingOpen, position: billingPos, size: billingSize },
              settings: { open: settingsOpen, position: settingsPos, size: settingsSize },
            }}
            billingEnabled={billingEnabled}
            gatewayRunning={gatewayRunning}
            integrationsSyncing={integrationsSyncing}
            integrationsMissing={integrationsMissing}
            onGatewayToggle={onGatewayToggle}
            onApplyRuntimeResources={onApplyRuntimeResources}
            isTogglingGateway={isTogglingGateway}
            selectedModel={selectedModel}
            onModelChange={onModelChange}
            useLocalKeys={useLocalKeys}
            onUseLocalKeysChange={onUseLocalKeysChange}
            codeModel={codeModel}
            imageModel={imageModel}
            imageGenerationModel={imageGenerationModel}
            textToSpeechModel={textToSpeechModel}
            audioUnderstandingModel={audioUnderstandingModel}
            voiceShortcut={voiceShortcut}
            voiceSpeechRate={voiceSpeechRate}
            voiceSpeechVoice={voiceSpeechVoice}
            onCodeModelChange={onCodeModelChange}
            onImageGenerationModelChange={onImageGenerationModelChange}
            onTextToSpeechModelChange={onTextToSpeechModelChange}
            onAudioUnderstandingModelChange={onAudioUnderstandingModelChange}
            onVoiceShortcutChange={onVoiceShortcutChange}
            onVoiceSpeechRateChange={onVoiceSpeechRateChange}
            onVoiceSpeechVoiceChange={onVoiceSpeechVoiceChange}
            onImageModelChange={onImageModelChange}
            onClose={{
              plugins: () => setPluginsOpen(false),
              skills: () => setSkillsOpen(false),
              channels: () => setChannelsOpen(false),
              tasks: () => setTasksOpen(false),
              jobs: () => setJobsOpen(false),
              logs: () => setLogsOpen(false),
              billing: () => setBillingOpen(false),
              settings: () => setSettingsOpen(false),
            }}
            onFocus={focusWindow}
            onDragStart={{
              plugins: (e) =>
                startWindowDrag(e, pluginsDragRef, pluginsPos, pluginsSize, setPluginsPos, "plugins"),
              skills: (e) =>
                startWindowDrag(e, skillsDragRef, skillsPos, skillsSize, setSkillsPos, "skills"),
              channels: (e) =>
                startWindowDrag(e, channelsDragRef, channelsPos, channelsSize, setChannelsPos, "channels"),
              tasks: (e) =>
                startWindowDrag(e, tasksDragRef, tasksPos, tasksSize, setTasksPos, "tasks"),
              jobs: (e) =>
                startWindowDrag(e, jobsDragRef, jobsPos, jobsSize, setJobsPos, "jobs"),
              logs: (e) =>
                startWindowDrag(e, logsDragRef, logsPos, logsSize, setLogsPos, "logs"),
              billing: (e) =>
                startWindowDrag(e, billingDragRef, billingPos, billingSize, setBillingPos, "billing"),
              settings: (e) =>
                startWindowDrag(e, settingsDragRef, settingsPos, settingsSize, setSettingsPos, "settings"),
            }}
            onSkillsResizeStart={(direction, e) =>
              startWindowResize(
                e,
                direction,
                skillsResizeRef,
                skillsPos,
                skillsSize,
                setSkillsPos,
                setSkillsSize,
                "skills",
                { w: 420, h: 360 },
              )
            }
          />

          <VoiceProvider
            audioUnderstandingModel={audioUnderstandingModel}
            desktopContext={voiceDesktopContext}
            shortcut={voiceShortcut}
            dispatchAction={runDesktopAction}
          />

          <DesktopDock
            active={{
              finder: finderOpen,
              chat: chatOpen,
              browser: browserOpen,
              sheets: sheetsOpen,
              docs: docsOpen,
              slides: slidesOpen,
              terminal: terminalOpen,
              skills: skillsOpen,
              channels: channelsOpen,
              tasks: tasksOpen,
              jobs: jobsOpen,
              logs: logsOpen,
              billing: billingOpen,
              settings: settingsOpen,
            }}
            billingEnabled={billingEnabled}
            onFocusWindow={requestDesktopWindowFocus}
            onOpenBrowser={() => {
              if (!browserOpen) {
                openFreshBrowserWindow(DEFAULT_BROWSER_URL);
                return;
              }
              focusWindow("browser");
            }}
            onToggleWallpaper={() => setShowWallpaperPicker(!showWallpaperPicker)}
            onAddFiles={() => fileInputRef.current?.click()}
          />
          <input ref={fileInputRef} type="file" className="hidden" onChange={handleFileInputChange} multiple />
        </div>
      </div>

    </div>
  );
}
