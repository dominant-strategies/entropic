import { ReactNode, useEffect, useState } from "react";
import {
  MessageSquare,
  Radio,
  ScrollText,
  Settings,
  Shield,
  Sparkles,
  Search,
  FolderOpen,
  CalendarClock,
  CreditCard,
  Loader2,
  Plus,
  Clock,
} from "lucide-react";
import type { ChatSession } from "../pages/Chat";
import clsx from "clsx";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { loadProfile, type AgentProfile } from "../lib/profile";

function startDrag(e: React.MouseEvent) {
  if (e.button === 0 && e.target === e.currentTarget) {
    e.preventDefault();
    getCurrentWindow().startDragging();
  }
}

export type Page = "chat" | "store" | "channels" | "files" | "tasks" | "logs" | "settings" | "billing";

type Props = {
  currentPage: Page;
  onNavigate: (page: Page) => void;
  children: ReactNode;
  gatewayRunning: boolean;
  integrationsSyncing?: boolean;
  chatSessions?: ChatSession[];
  currentChatSession?: string | null;
  onSelectChatSession?: (key: string) => void;
  onNewChat?: () => void;
};

const navItems: { id: Page; label: string; icon: typeof MessageSquare }[] = [
  { id: "files", label: "Home", icon: FolderOpen },
  { id: "chat", label: "New Chat", icon: Plus },
  { id: "store", label: "Plugins", icon: Sparkles },
  { id: "channels", label: "Channels", icon: Radio },
  { id: "tasks", label: "Tasks", icon: CalendarClock },
  { id: "logs", label: "Logs", icon: ScrollText },
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
  return s.label || s.displayName || s.derivedTitle || `Chat ${s.key.slice(0, 8)}`;
}

export function Layout({ currentPage, onNavigate, children, gatewayRunning, integrationsSyncing, chatSessions, currentChatSession, onSelectChatSession, onNewChat }: Props) {
  const [profile, setProfile] = useState<AgentProfile>({ name: "Nova" });
  const [searchTerm, setSearchTerm] = useState("");

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
    window.addEventListener("nova-profile-updated", handler);
    return () => {
      cancelled = true;
      window.removeEventListener("nova-profile-updated", handler);
    };
  }, []);

  return (
    <div className="h-screen w-screen flex bg-[var(--bg-primary)]">
      {/* Sidebar */}
      <div
        data-tauri-drag-region
        onMouseDown={startDrag}
        className="w-56 flex flex-col flex-shrink-0"
        style={{
          background: 'var(--bg-sidebar)',
          borderRight: '1px solid var(--glass-border-subtle)'
        }}
      >
        {/* Logo */}
        <div
          data-tauri-drag-region
          onMouseDown={startDrag}
          className="h-14 flex items-center gap-3 px-4 flex-shrink-0"
          style={{ borderBottom: '1px solid var(--glass-border-subtle)' }}
        >
          <Shield className="w-6 h-6 text-[var(--purple-accent)]" />
          <span className="font-semibold text-lg text-[var(--text-primary)]">Nova</span>
        </div>

        {/* Search */}
        <div className="p-2 flex-shrink-0">
          <div className="relative">
            <Search className="w-4 h-4 text-[var(--text-tertiary)] absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="Search"
              className="form-input !pl-9 w-full text-sm"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </div>
        </div>

        {/* Navigation */}
        <nav className="flex-1 p-2 space-y-1 overflow-auto">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isChat = item.id === "chat";
            const isActive = isChat ? currentPage === "chat" && !currentChatSession : currentPage === item.id;
            return (
              <div key={item.id}>
                <button
                  onClick={() => isChat ? onNewChat?.() : onNavigate(item.id)}
                  className={clsx(
                    "w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors",
                    isActive
                      ? "bg-[#f3e8ff] text-[var(--purple-accent)]"
                      : "text-[var(--text-secondary)] hover:bg-black/5"
                  )}
                >
                  <Icon className={clsx("w-5 h-5", isActive ? 'text-[var(--purple-accent)]' : 'text-[var(--text-tertiary)]')} />
                  {item.label}
                </button>

                {/* Recent chat sessions — always visible */}
                {isChat && chatSessions && chatSessions.length > 0 && (
                  <div className="mt-1 space-y-0.5 max-h-[180px] overflow-y-auto">
                    <div className="px-3 pt-1 pb-0.5 text-[10px] uppercase tracking-wider text-[var(--text-tertiary)] font-medium">
                      Your Chats
                    </div>
                    {chatSessions.slice(0, 5).map((session) => (
                      <button
                        key={session.key}
                        onClick={() => onSelectChatSession?.(session.key)}
                        className={clsx(
                          "w-full flex items-center gap-2 px-3 py-1.5 rounded-md text-xs transition-colors text-left",
                          currentChatSession === session.key
                            ? "bg-[#f3e8ff]/60 text-[var(--purple-accent)] font-medium"
                            : "text-[var(--text-secondary)] hover:bg-black/5"
                        )}
                      >
                        <MessageSquare className="w-3 h-3 flex-shrink-0 opacity-50" />
                        <span className="truncate flex-1">{sessionTitle(session)}</span>
                        {session.updatedAt && (
                          <span className="flex-shrink-0 text-[10px] text-[var(--text-tertiary)] flex items-center gap-0.5">
                            <Clock className="w-2.5 h-2.5" />
                            {relativeTime(session.updatedAt)}
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </nav>

        {/* Agent Profile */}
        <div className="p-2 flex-shrink-0">
          <button
            onClick={() => onNavigate("settings")}
            className="w-full flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-black/5"
          >
            <div className="w-9 h-9 rounded-full bg-black/5 overflow-hidden flex items-center justify-center">
              {profile.avatarDataUrl ? (
                <img
                  src={profile.avatarDataUrl}
                  alt="Agent avatar"
                  className="w-full h-full object-cover"
                />
              ) : (
                <span className="text-xs font-semibold text-[var(--text-accent)]">
                  {profile.name.slice(0, 2).toUpperCase()}
                </span>
              )}
            </div>
            <div className="flex-1 text-left">
              <div className="text-sm font-medium text-[var(--text-primary)]">
                {profile.name}
              </div>
              <div className="text-xs text-[var(--text-tertiary)]">Your Assistant</div>
            </div>
          </button>
        </div>

        {/* Gateway Status */}
        <div className="p-2 flex-shrink-0" style={{ borderTop: '1px solid var(--glass-border-subtle)' }}>
          <div className="flex items-center justify-between gap-2 px-3 py-2">
            <div className="flex items-center gap-2">
              <div
                className="w-2 h-2 rounded-full"
                style={{ background: gatewayRunning ? '#22c55e' : '#e0e0e0' }}
              />
              <span className="text-xs text-[var(--text-tertiary)]">
                {gatewayRunning ? 'Connected' : 'Offline'}
              </span>
            </div>
            {integrationsSyncing ? (
              <div className="flex items-center gap-1 text-[var(--text-tertiary)] text-[10px] uppercase tracking-wide">
                <Loader2 className="w-3 h-3 animate-spin" />
                Syncing integrations
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col">
        {/* Drag region for window */}
        <div data-tauri-drag-region onMouseDown={startDrag} className="h-8 flex-shrink-0" />

        {/* Page Content */}
        <main className="flex-1 overflow-auto px-6 pb-6">
          {children}
        </main>
      </div>
    </div>
  );
}
