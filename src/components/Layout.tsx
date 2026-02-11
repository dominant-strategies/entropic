import { ReactNode, useEffect, useState } from "react";
import {
  MessageSquare,
  Radio,
  ScrollText,
  Settings,
  FolderOpen,
  CalendarClock,
  CreditCard,
  Loader2,
  Plus,
  Clock,
  Puzzle,
} from "lucide-react";
import novaLogo from "../assets/nova-logo.png";
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
  { id: "store", label: "Plugins", icon: Puzzle },
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
    <div className="h-screen w-screen flex bg-[var(--bg-app)] text-[var(--text-primary)] font-sans overflow-hidden">
      {/* Sidebar - Transparent blend */}
      <div
        data-tauri-drag-region
        onMouseDown={startDrag}
        className="w-[240px] flex flex-col flex-shrink-0 bg-transparent pt-8 pb-4 pl-4 pr-2"
      >
        {/* Profile / Brand */}
        <div className="px-2 mb-6 flex items-center gap-3">
          <img src={novaLogo} alt="Nova" className="w-8 h-8 rounded-lg shadow-md" />
          <div className="font-semibold text-lg tracking-tight text-[var(--text-primary)]">
            Nova
          </div>
        </div>

        {/* Navigation */}
        <nav className="flex-1 space-y-0.5 overflow-y-auto pr-2 custom-scrollbar">
          <div className="text-[11px] font-semibold text-[var(--text-tertiary)] uppercase tracking-wider px-3 mb-2 mt-2">
            Menu
          </div>
          
          {navItems.map((item) => {
            const Icon = item.icon;
            const isChat = item.id === "chat";
            const isActive = isChat ? currentPage === "chat" && !currentChatSession : currentPage === item.id;
            
            return (
              <div key={item.id}>
                <button
                  onClick={() => isChat ? onNewChat?.() : onNavigate(item.id)}
                    className={clsx(
                      "w-full flex items-center gap-3 px-3 py-2 rounded-md text-[13px] font-medium transition-all duration-200",
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
                  {item.label}
                </button>

                {/* Chat History sub-items */}
                {isChat && chatSessions && chatSessions.length > 0 && (
                  <div className="mt-1 ml-2 pl-2 border-l border-[var(--border-subtle)] space-y-0.5">
                    {chatSessions.slice(0, 5).map((session) => (
                      <button
                        key={session.key}
                        onClick={() => onSelectChatSession?.(session.key)}
                        className={clsx(
                          "w-full flex items-center gap-2 px-3 py-1 rounded-md text-[12px] transition-colors text-left",
                          currentChatSession === session.key
                            ? "bg-[rgba(147,51,234,0.08)] text-[var(--purple-accent)] font-medium"
                            : "text-[var(--text-secondary)] hover:bg-[rgba(0,0,0,0.03)]"
                        )}
                      >
                        <span className="truncate flex-1">{sessionTitle(session)}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </nav>

        {/* User / Gateway Status Footer */}
        <div className="mt-auto px-2 pt-4">
          <button
             onClick={() => onNavigate("settings")}
             className="w-full flex items-center gap-3 p-2 rounded-lg hover:bg-[rgba(0,0,0,0.04)] transition-colors text-left group"
          >
            <div className="w-8 h-8 rounded-full bg-gray-200 overflow-hidden flex-shrink-0 border border-black/5">
              {profile.avatarDataUrl ? (
                <img src={profile.avatarDataUrl} alt="Avatar" className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-xs font-medium text-gray-500">
                  {profile.name.slice(0, 1).toUpperCase()}
                </div>
              )}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[13px] font-medium text-[var(--text-primary)] truncate group-hover:text-black">
                {profile.name}
              </div>
              <div className="flex items-center gap-1.5 mt-0.5">
                <div className={clsx("w-1.5 h-1.5 rounded-full", gatewayRunning ? "bg-green-500" : "bg-gray-300")} />
                <span className="text-[11px] text-[var(--text-tertiary)]">
                  {gatewayRunning ? "Online" : "Offline"}
                </span>
              </div>
            </div>
            <Settings className="w-4 h-4 text-[var(--text-tertiary)] opacity-0 group-hover:opacity-100 transition-opacity" />
          </button>
        </div>
      </div>

      {/* Main Content Area - The "Content Card" */}
      <div className="flex-1 h-screen p-4 pl-0 overflow-hidden flex flex-col">
        {/* Window Drag Region */}
        <div data-tauri-drag-region onMouseDown={startDrag} className="h-6 flex-shrink-0" />
        
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
