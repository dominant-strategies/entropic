import type { MouseEvent as ReactMouseEvent } from "react";
import {
  MessageSquare,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Pin,
  Plus,
  Trash2,
} from "lucide-react";
import {
  Chat,
  type ChatSession as SharedChatSession,
  type ChatSessionActionRequest,
} from "../../pages/Chat";
import { AppWindow } from "../AppWindow";
import type {
  WindowPoint,
  WindowResizeDirection,
  WindowSize,
} from "../windowManager";
import type { VoiceSpeechVoice } from "../voice/voicePreferences";

const DEFAULT_DESKTOP_CHAT_TITLE = "New chat";

type DesktopChatNavigateTarget =
  | "chat"
  | "store"
  | "integrations"
  | "skills"
  | "channels"
  | "files"
  | "tasks"
  | "jobs"
  | "settings"
  | "billing";

type DesktopChatSessionMenuAction =
  | { type: "delete"; key: string }
  | { type: "pin"; key: string; pinned: boolean }
  | { type: "rename"; key: string; label: string };

type ChatDesktopAppProps = {
  position: WindowPoint;
  size: WindowSize;
  zIndex: number;
  active?: boolean;
  open: boolean;
  navCollapsed: boolean;
  sessions: SharedChatSession[];
  currentSession: string | null;
  query: string;
  requestedSession: string | null;
  requestedSessionAction: ChatSessionActionRequest | null;
  openSessionMenuKey: string | null;
  gatewayRunning: boolean;
  gatewayStarting: boolean;
  gatewayRetryIn: number | null;
  useLocalKeys: boolean;
  selectedModel: string;
  imageModel: string;
  imageGenerationModel: string;
  textToSpeechModel: string;
  audioUnderstandingModel: string;
  voiceSpeechRate: number;
  voiceSpeechVoice: VoiceSpeechVoice;
  integrationsSyncing?: boolean;
  integrationsMissing?: boolean;
  formatDate: (timestamp: number) => string;
  onClose: () => void;
  onFocus: () => void;
  onDragStart: (event: ReactMouseEvent<HTMLElement>) => void;
  onResizeStart: (
    direction: WindowResizeDirection,
    event: ReactMouseEvent<HTMLDivElement>,
  ) => void;
  onNavCollapsedChange: (collapsed: boolean | ((previous: boolean) => boolean)) => void;
  onQueryChange: (query: string) => void;
  onCreateSession: () => void;
  onSelectSession: (sessionKey: string) => void;
  onRequestSessionAction: (action: DesktopChatSessionMenuAction) => void;
  onOpenSessionMenuKeyChange: (key: string | null | ((previous: string | null) => string | null)) => void;
  onStartGateway: () => void;
  onRecoverProxyAuth?: () => Promise<boolean> | boolean;
  onModelChange: (model: string) => void;
  onNavigate: (page: DesktopChatNavigateTarget) => void;
  onSessionsChange: (sessions: SharedChatSession[], currentKey: string | null) => void;
};

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

export function ChatDesktopApp({
  position,
  size,
  zIndex,
  active = true,
  open,
  navCollapsed,
  sessions,
  currentSession,
  query,
  requestedSession,
  requestedSessionAction,
  openSessionMenuKey,
  gatewayRunning,
  gatewayStarting,
  gatewayRetryIn,
  useLocalKeys,
  selectedModel,
  imageModel,
  imageGenerationModel,
  textToSpeechModel,
  audioUnderstandingModel,
  voiceSpeechRate,
  voiceSpeechVoice,
  integrationsSyncing,
  integrationsMissing,
  formatDate,
  onClose,
  onFocus,
  onDragStart,
  onResizeStart,
  onNavCollapsedChange,
  onQueryChange,
  onCreateSession,
  onSelectSession,
  onRequestSessionAction,
  onOpenSessionMenuKeyChange,
  onStartGateway,
  onRecoverProxyAuth,
  onModelChange,
  onNavigate,
  onSessionsChange,
}: ChatDesktopAppProps) {
  const normalizedQuery = query.trim().toLowerCase();
  const sortedSessions = sortDesktopChatSessions(sessions);
  const activeSession = currentSession
    ? sessions.find((session) => session.key === currentSession) || null
    : null;
  const visibleSessions = normalizedQuery
    ? sortedSessions.filter((session) =>
        desktopChatSessionTitle(session).toLowerCase().includes(normalizedQuery),
      )
    : sortedSessions;

  return (
    <AppWindow
      title="Chat"
      icon={MessageSquare}
      position={position}
      size={size}
      zIndex={zIndex}
      active={active}
      glass={false}
      onClose={onClose}
      onFocus={onFocus}
      onDragStart={onDragStart}
      onResizeStart={onResizeStart}
    >
      <div className="h-full min-w-0 flex bg-[var(--bg-app)] text-[var(--text-primary)]">
        {!navCollapsed && (
          <aside
            className="w-[280px] shrink-0 border-r flex flex-col"
            style={{ borderColor: "var(--border-subtle)", background: "var(--bg-secondary)" }}
          >
            <div className="p-3 border-b" style={{ borderColor: "var(--border-subtle)" }}>
              <div className="flex items-center justify-between gap-2 mb-3">
                <div className="min-w-0">
                  <button
                    type="button"
                    onClick={() => onNavCollapsedChange((previous) => !previous)}
                    className="h-8 w-8 rounded-xl border flex items-center justify-center transition-colors hover:bg-[var(--border-subtle)]"
                    style={{ borderColor: "var(--border-subtle)", color: "var(--text-primary)" }}
                    title="Collapse conversations"
                    aria-label="Collapse conversations"
                  >
                    <PanelLeftClose className="w-4 h-4" />
                  </button>
                  <p
                    className="text-[11px] uppercase tracking-[0.24em]"
                    style={{ color: "var(--text-tertiary)" }}
                  >
                    Conversations
                  </p>
                  <p className="text-[12px] mt-1" style={{ color: "var(--text-secondary)" }}>
                    {activeSession ? desktopChatSessionTitle(activeSession) : "Shared with main chat"}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={onCreateSession}
                  className="h-8 rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5 px-3"
                  style={{
                    background: "var(--text-primary)",
                    color: "var(--bg-card)",
                    border: "1px solid var(--border-subtle)",
                  }}
                  title="New chat"
                >
                  <Plus className="w-3.5 h-3.5" />
                  New
                </button>
              </div>
              <input
                type="text"
                value={query}
                onChange={(event) => onQueryChange(event.target.value)}
                placeholder="Search history"
                className="w-full h-9 px-3 rounded-xl text-xs outline-none"
                style={{
                  background: "var(--bg-card)",
                  color: "var(--text-primary)",
                  border: "1px solid var(--border-subtle)",
                }}
              />
            </div>
            <div className="flex-1 overflow-auto p-2 space-y-1.5">
              {visibleSessions.length === 0 ? (
                <div className="px-3 py-5 text-center">
                  <p className="text-xs" style={{ color: "var(--text-tertiary)" }}>
                    No matching chats
                  </p>
                </div>
              ) : (
                visibleSessions.map((session) => {
                  const isActive = session.key === currentSession;
                  return (
                    <div key={session.key} className="relative flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => onSelectSession(session.key)}
                        className="flex-1 flex items-center gap-2 px-3 py-2.5 rounded-2xl text-left transition-colors min-w-0"
                        style={{
                          background: isActive ? "rgba(139,92,246,0.15)" : "var(--bg-tertiary)",
                          border: isActive
                            ? "1px solid rgba(139,92,246,0.25)"
                            : "1px solid var(--border-subtle)",
                        }}
                      >
                        {session.pinned ? (
                          <Pin
                            className="w-3.5 h-3.5 shrink-0"
                            style={{ color: "var(--text-secondary)" }}
                          />
                        ) : (
                          <MessageSquare
                            className="w-3.5 h-3.5 shrink-0"
                            style={{ color: "var(--text-secondary)" }}
                          />
                        )}
                        <div className="min-w-0 flex-1">
                          <p
                            className="truncate text-[12px] font-semibold"
                            style={{ color: "var(--text-primary)" }}
                          >
                            {desktopChatSessionTitle(session)}
                          </p>
                          <p className="mt-1 text-[10px]" style={{ color: "var(--text-tertiary)" }}>
                            {typeof session.updatedAt === "number"
                              ? formatDate(Math.floor(session.updatedAt / 1000))
                              : "Saved conversation"}
                          </p>
                        </div>
                      </button>
                      <button
                        data-desktop-chat-session-trigger
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          onOpenSessionMenuKeyChange((previous) =>
                            previous === session.key ? null : session.key,
                          );
                        }}
                        className="p-1.5 rounded-lg transition-colors hover:bg-[var(--border-subtle)]"
                        style={{ color: "var(--text-secondary)" }}
                        title="Chat options"
                        aria-label="Chat options"
                      >
                        <MoreHorizontal className="w-3.5 h-3.5" />
                      </button>
                      {openSessionMenuKey === session.key && (
                        <div
                          data-desktop-chat-session-menu
                          className="absolute right-0 top-10 z-30 w-40 rounded-xl border p-1.5 shadow-lg"
                          style={{
                            background: "var(--bg-card)",
                            borderColor: "var(--border-subtle)",
                          }}
                        >
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              onRequestSessionAction({
                                type: "pin",
                                key: session.key,
                                pinned: !session.pinned,
                              });
                              onOpenSessionMenuKeyChange(null);
                            }}
                            className="w-full flex items-center gap-2 rounded-lg px-2 py-1.5 text-[12px] text-left transition-colors hover:bg-[var(--border-subtle)]"
                            style={{ color: "var(--text-primary)" }}
                          >
                            <Pin className="w-3.5 h-3.5" />
                            {session.pinned ? "Unpin" : "Pin"}
                          </button>
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              onRequestSessionAction({ type: "delete", key: session.key });
                              onOpenSessionMenuKeyChange(null);
                            }}
                            className="w-full flex items-center gap-2 rounded-lg px-2 py-1.5 text-[12px] text-left transition-colors hover:bg-red-500/10"
                            style={{ color: "#dc2626" }}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                            Delete
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </aside>
        )}

        <div className="min-w-0 flex-1 flex flex-col bg-[var(--bg-app)] relative">
          {navCollapsed && (
            <button
              type="button"
              onClick={() => onNavCollapsedChange(false)}
              className="absolute left-3 top-3 z-20 h-9 w-9 rounded-xl border shadow-sm flex items-center justify-center transition-colors hover:bg-[var(--bg-secondary)]"
              style={{
                borderColor: "var(--border-subtle)",
                background: "color-mix(in srgb, var(--bg-card) 92%, transparent)",
                color: "var(--text-primary)",
                backdropFilter: "blur(10px)",
                WebkitBackdropFilter: "blur(10px)",
              }}
              title="Show conversations"
              aria-label="Show conversations"
            >
              <PanelLeftOpen className="w-4 h-4" />
            </button>
          )}
          <div className="min-w-0 flex-1 overflow-hidden">
            <Chat
              isVisible={open}
              gatewayRunning={gatewayRunning}
              gatewayStarting={gatewayStarting}
              gatewayRetryIn={gatewayRetryIn}
              gatewayLifecycleLabel={null}
              onStartGateway={onStartGateway}
              onRecoverProxyAuth={onRecoverProxyAuth}
              useLocalKeys={useLocalKeys}
              selectedModel={selectedModel}
              onModelChange={onModelChange}
              imageModel={imageModel}
              imageGenerationModel={imageGenerationModel}
              textToSpeechModel={textToSpeechModel}
              audioUnderstandingModel={audioUnderstandingModel}
              voiceSpeechRate={voiceSpeechRate}
              voiceSpeechVoice={voiceSpeechVoice}
              integrationsSyncing={integrationsSyncing}
              integrationsMissing={integrationsMissing}
              onNavigate={onNavigate}
              onSessionsChange={onSessionsChange}
              requestedSession={requestedSession}
              requestedSessionAction={requestedSessionAction}
              wideLayout={navCollapsed}
            />
          </div>
        </div>
      </div>
    </AppWindow>
  );
}
