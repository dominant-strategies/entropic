import { ReactNode, useEffect, useState } from "react";
import {
  MessageSquare,
  Radio,
  Settings,
  FolderOpen,
  CalendarClock,
  CreditCard,
  Loader2,
  Plus,
  Clock,
  Puzzle,
  Sparkles,
  PanelLeftClose,
  PanelLeftOpen,
  MoreHorizontal,
  Pin,
  Trash2,
} from "lucide-react";
import entropicLogo from "../assets/entropic-logo.png";
import type { ChatSession } from "../pages/Chat";
import clsx from "clsx";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { platform } from "@tauri-apps/plugin-os";
import {
  getProfileInitials,
  isRenderableAvatarDataUrl,
  loadProfile,
  sanitizeProfileName,
  type AgentProfile,
} from "../lib/profile";

function startDrag(e: React.MouseEvent) {
  if (e.button !== 0) return;
  const target = e.target as HTMLElement;
  if (target.closest("button, a, input, select, textarea, [role='button']")) return;
  e.preventDefault();
  getCurrentWindow().startDragging();
}

export type Page = "chat" | "store" | "skills" | "channels" | "files" | "tasks" | "settings" | "billing";

type Props = {
  currentPage: Page;
  onNavigate: (page: Page) => void;
  children: ReactNode;
  gatewayRunning: boolean;
  experimentalDesktop?: boolean;
  integrationsSyncing?: boolean;
  chatSessions?: ChatSession[];
  currentChatSession?: string | null;
  onSelectChatSession?: (key: string) => void;
  onNewChat?: () => void;
  onChatSessionAction?: (
    action:
      | { type: "delete"; key: string }
      | { type: "pin"; key: string; pinned: boolean }
      | { type: "rename"; key: string; label: string },
  ) => void;
};

const baseNavItems: { id: Page; label: string; icon: typeof MessageSquare }[] = [
  { id: "chat", label: "New Chat", icon: Plus },
  { id: "files", label: "Desktop", icon: FolderOpen },
  { id: "channels", label: "Messaging", icon: Radio },
  { id: "store", label: "Plugins", icon: Puzzle },
  { id: "skills", label: "Skills", icon: Sparkles },
  { id: "tasks", label: "Tasks", icon: CalendarClock },
  { id: "billing", label: "Billing", icon: CreditCard },
  { id: "settings", label: "Settings", icon: Settings },
];

function relativeTime(ts?: number | null): string {
  if (!ts) return "";
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function sessionTitle(s: ChatSession): string {
  return s.label || s.derivedTitle || s.displayName || `Chat ${s.key.slice(0, 8)}`;
}

export function Layout({
  currentPage,
  onNavigate,
  children,
  gatewayRunning,
  experimentalDesktop = false,
  integrationsSyncing,
  chatSessions,
  currentChatSession,
  onSelectChatSession,
  onNewChat,
  onChatSessionAction,
}: Props) {
  const [profile, setProfile] = useState<AgentProfile>({ name: "Entropic" });
  const [isMacOS, setIsMacOS] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [showAllChatSessions, setShowAllChatSessions] = useState(false);
  const [openSessionMenuKey, setOpenSessionMenuKey] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      loadProfile()
        .then((data) => {
          if (!cancelled) setProfile(data);
        })
        .catch(() => {});
    };
    refresh();
    const handler = () => refresh();
    window.addEventListener("entropic-profile-updated", handler);
    return () => {
      cancelled = true;
      window.removeEventListener("entropic-profile-updated", handler);
    };
  }, []);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      if (target.closest("[data-chat-session-menu]") || target.closest("[data-chat-session-trigger]")) {
        return;
      }
      setOpenSessionMenuKey(null);
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, []);

  useEffect(() => {
    try {
      setIsMacOS(platform() === "macos");
    } catch {
      setIsMacOS(false);
    }
  }, []);

  useEffect(() => {
    try {
      const saved = localStorage.getItem("entropic.sidebarCollapsed");
      if (saved === "1") {
        setSidebarCollapsed(true);
      }
    } catch {
      // ignore storage failures
    }
  }, []);

  function toggleSidebarCollapsed() {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("entropic.sidebarCollapsed", next ? "1" : "0");
      } catch {
        // ignore storage failures
      }
      return next;
    });
  }

  const sortedChatSessions = [...(chatSessions || [])].sort((a, b) => {
    const aPinned = a.pinned ? 1 : 0;
    const bPinned = b.pinned ? 1 : 0;
    if (aPinned !== bPinned) return bPinned - aPinned;
    const aUpdated = typeof a.updatedAt === "number" ? a.updatedAt : 0;
    const bUpdated = typeof b.updatedAt === "number" ? b.updatedAt : 0;
    return bUpdated - aUpdated;
  });
  const visibleChatSessions = showAllChatSessions
    ? sortedChatSessions
    : sortedChatSessions.slice(0, 5);
  const hasMoreChatSessions = sortedChatSessions.length > 5;
  const profileName = sanitizeProfileName(profile.name);
  const profileAvatarUrl = isRenderableAvatarDataUrl(profile.avatarDataUrl)
    ? profile.avatarDataUrl.trim()
    : undefined;
  const navItems = baseNavItems.filter((item) =>
    item.id === "files" ? experimentalDesktop : true
  );

  return (
    <div className="h-screen w-screen flex bg-[var(--bg-app)] text-[var(--text-primary)] font-sans overflow-hidden">
      {/* Sidebar - Transparent blend */}
      <div
        data-tauri-drag-region
        onMouseDown={startDrag}
        className={clsx(
          "flex flex-col flex-shrink-0 bg-transparent pb-4 pt-2 transition-[width,padding] duration-200",
          sidebarCollapsed ? "w-[74px] pl-1.5 pr-1" : "w-[240px] pl-3 pr-2"
        )}
      >
        {sidebarCollapsed ? (
          /* Collapsed: stack vertically — traffic-light clearance, then logo, then toggle, then nav */
          <div className="flex flex-col items-center">
            {/* Clear native macOS traffic light buttons */}
            {isMacOS && <div className="h-7 shrink-0" />}
            <img src={entropicLogo} alt="Entropic" className="w-8 h-8 rounded-lg shadow-md mt-3 mb-4 pointer-events-none" />
            <button
              onMouseDown={(e) => e.stopPropagation()}
              onClick={toggleSidebarCollapsed}
              className="w-8 h-8 mb-4 rounded-md bg-black/5 hover:bg-black/10 text-[var(--text-secondary)] hover:text-[var(--text-primary)] flex items-center justify-center transition-colors"
              title="Expand navigation"
              aria-label="Expand navigation"
            >
              <PanelLeftOpen className="w-4 h-4" />
            </button>
          </div>
        ) : (
          /* Expanded: horizontal row — spacer, logo + title, collapse button */
          <div className="h-8 mb-3 flex items-center gap-2 px-1">
            {isMacOS && <div className="w-[68px] shrink-0" />}
            <div
              data-tauri-drag-region
              onMouseDown={startDrag}
              className="h-full flex items-center gap-3 flex-1 min-w-0"
            >
              <img src={entropicLogo} alt="Entropic" className="w-8 h-8 rounded-lg shadow-md pointer-events-none" />
              <div className="font-semibold text-lg tracking-tight text-[var(--text-primary)] pointer-events-none">
                Entropic
              </div>
            </div>
            <button
              onMouseDown={(e) => e.stopPropagation()}
              onClick={toggleSidebarCollapsed}
              className="w-7 h-7 rounded-md bg-black/5 hover:bg-black/10 text-[var(--text-secondary)] hover:text-[var(--text-primary)] flex items-center justify-center transition-colors"
              title="Collapse navigation"
              aria-label="Collapse navigation"
            >
              <PanelLeftClose className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* Navigation */}
        <nav className={clsx("flex-1 space-y-0.5 overflow-y-auto custom-scrollbar", sidebarCollapsed ? "pr-1" : "pr-2")}>
          {!sidebarCollapsed && (
            <div className="text-[11px] font-semibold text-[var(--text-tertiary)] uppercase tracking-wider px-3 mb-2 mt-0">
              Menu
            </div>
          )}
          
          {navItems.map((item) => {
            const Icon = item.icon;
            const isChat = item.id === "chat";
            const isActive = isChat ? currentPage === "chat" && !currentChatSession : currentPage === item.id;
            
            return (
              <div key={item.id}>
                <button
                  onClick={() => {
                    if (!isChat) {
                      onNavigate(item.id);
                      return;
                    }
                    if (currentPage === "chat") {
                      onNewChat?.();
                      return;
                    }
                    if (currentChatSession) {
                      onSelectChatSession?.(currentChatSession);
                      return;
                    }
                    onNavigate("chat");
                  }}
                    className={clsx(
                      "w-full flex items-center rounded-md text-[13px] font-medium transition-all duration-200",
                      sidebarCollapsed ? "justify-center px-1.5 py-2" : "gap-3 px-3 py-2",
                      isActive
                      ? "bg-[rgba(0,0,0,0.06)] text-black shadow-sm"
                      : "text-black/70 hover:bg-[rgba(0,0,0,0.03)] hover:text-black"
                    )}
                  >
                  <div
                    className={clsx(
                      "w-8 h-8 rounded-lg flex items-center justify-center transition-colors",
                      isActive ? "bg-white shadow-sm" : "bg-black/5"
                    )}
                  >
                    <Icon
                      className={clsx("w-5 h-5", isActive ? "text-[var(--purple-accent)]" : "text-[var(--text-tertiary)]")}
                    />
                  </div>
                  {!sidebarCollapsed && item.label}
                </button>

                {/* Chat History sub-items */}
                {!sidebarCollapsed && isChat && chatSessions && chatSessions.length > 0 && (
                  <div className="mt-1 ml-2 pl-2 border-l border-[var(--border-subtle)] space-y-0.5">
                    {visibleChatSessions.map((session) => (
                      <div key={session.key} className="relative flex items-center gap-1">
                        <button
                          onClick={() => {
                            setOpenSessionMenuKey(null);
                            onSelectChatSession?.(session.key);
                          }}
                          className={clsx(
                            "flex-1 flex items-center gap-2 px-3 py-1 rounded-md text-[12px] transition-colors text-left min-w-0",
                            currentChatSession === session.key
                              ? "bg-[rgba(147,51,234,0.08)] text-[var(--purple-accent)] font-medium"
                              : "text-[var(--text-secondary)] hover:bg-[rgba(0,0,0,0.03)]"
                          )}
                        >
                          {session.pinned ? <Pin className="w-3 h-3 text-[var(--text-tertiary)]" /> : null}
                          <span className="truncate flex-1">{sessionTitle(session)}</span>
                        </button>
                        <button
                          data-chat-session-trigger
                          onClick={(e) => {
                            e.stopPropagation();
                            setOpenSessionMenuKey((prev) => (prev === session.key ? null : session.key));
                          }}
                          className="p-1 rounded-md text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[rgba(0,0,0,0.05)] transition-colors"
                          title="Chat options"
                          aria-label="Chat options"
                        >
                          <MoreHorizontal className="w-3.5 h-3.5" />
                        </button>
                        {openSessionMenuKey === session.key && (
                          <div
                            data-chat-session-menu
                            className="absolute right-0 top-7 z-30 w-40 rounded-lg border border-[var(--border-subtle)] bg-white shadow-lg p-1"
                          >
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                onChatSessionAction?.({
                                  type: "pin",
                                  key: session.key,
                                  pinned: !session.pinned,
                                });
                                setOpenSessionMenuKey(null);
                              }}
                              className="w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-[12px] text-left text-[var(--text-primary)] hover:bg-[var(--bg-secondary)]"
                            >
                              <Pin className="w-3.5 h-3.5" />
                              {session.pinned ? "Unpin" : "Pin"}
                            </button>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                onChatSessionAction?.({ type: "delete", key: session.key });
                                setOpenSessionMenuKey(null);
                              }}
                              className="w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-[12px] text-left text-red-600 hover:bg-red-50"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                              Delete
                            </button>
                          </div>
                        )}
                      </div>
                    ))}
                    {hasMoreChatSessions && (
                      <button
                        onClick={() => setShowAllChatSessions((prev) => !prev)}
                        className="w-full px-3 py-1 text-left rounded-md text-[11px] font-medium text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[rgba(0,0,0,0.03)] transition-colors"
                      >
                        {showAllChatSessions ? "Show less" : `Show ${sortedChatSessions.length - 5} more`}
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </nav>

        {/* User / Gateway Status Footer */}
        <div className={clsx("mt-auto pt-4", sidebarCollapsed ? "px-1" : "px-2")}>
          <button
             onClick={() => onNavigate("settings")}
             className={clsx(
               "w-full flex items-center p-2 rounded-lg hover:bg-[rgba(0,0,0,0.04)] transition-colors text-left group",
               sidebarCollapsed ? "justify-center" : "gap-3"
             )}
          >
            <div className="w-8 h-8 rounded-full bg-gray-200 overflow-hidden flex-shrink-0 border border-black/5">
              {profileAvatarUrl ? (
                <img src={profileAvatarUrl} alt="Avatar" className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-xs font-medium text-gray-500">
                  {getProfileInitials(profileName, 1)}
                </div>
              )}
            </div>
            {!sidebarCollapsed && (
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-medium text-[var(--text-primary)] truncate group-hover:text-black">
                  {profileName}
                </div>
                <div className="flex items-center gap-1.5 mt-0.5">
                  <div className={clsx("w-1.5 h-1.5 rounded-full", gatewayRunning ? "bg-green-500" : "bg-gray-300")} />
                  <span className="text-[11px] text-[var(--text-tertiary)]">
                    {gatewayRunning ? "Online" : "Offline"}
                  </span>
                </div>
              </div>
            )}
            {!sidebarCollapsed && (
              <Settings className="w-4 h-4 text-[var(--text-tertiary)] opacity-0 group-hover:opacity-100 transition-opacity" />
            )}
          </button>
        </div>
      </div>

      {/* Main Content Area - The "Content Card" */}
      <div className="flex-1 h-screen p-2 pl-0 overflow-hidden flex flex-col">
        {/* Drag strip above the card */}
        <div
          data-tauri-drag-region
          onMouseDown={startDrag}
          className="h-2 flex-shrink-0 ml-2"
        />
        {/* The Card */}
        <main className="flex-1 bg-white rounded-2xl shadow-sm border border-[var(--border-subtle)] overflow-hidden flex flex-col relative ml-2">
          <div className="absolute inset-0 overflow-y-auto scroll-smooth">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
