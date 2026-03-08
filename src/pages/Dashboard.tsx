import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-shell";
import { CheckCircle2, Loader2 } from "lucide-react";
import { Layout, Page } from "../components/Layout";
import { useGatewayController } from "../hooks/useGatewayController";
import { useAuth } from "../contexts/AuthContext";
import { BillingPage } from "./BillingPage";
import { Channels } from "./Channels";
import { Chat, type ChatSession, type ChatSessionActionRequest } from "./Chat";
import { Files } from "./Files";
import { Jobs } from "./Jobs";
import { Settings } from "./Settings";
import { Store } from "./Store";
import { Tasks } from "./Tasks";

type RuntimeStatus = {
  colima_installed: boolean;
  docker_installed: boolean;
  vm_running: boolean;
  docker_ready: boolean;
};

type Props = {
  status: RuntimeStatus | null;
  onRefresh: () => void;
};

const FEEDBACK_FORM_URL = "https://entropic.qu.ai/feedback";

export function Dashboard({ status: _status, onRefresh: _onRefresh }: Props) {
  const { isAuthenticated, isAuthConfigured, refreshBalance } = useAuth();
  const [currentPage, setCurrentPage] = useState<Page>("chat");
  const [chatSessions, setChatSessions] = useState<ChatSession[]>([]);
  const [currentChatSession, setCurrentChatSession] = useState<string | null>(null);
  const [pendingChatSession, setPendingChatSession] = useState<string | null>(null);
  const [pendingChatAction, setPendingChatAction] =
    useState<ChatSessionActionRequest | null>(null);

  function requestSignIn() {
    window.dispatchEvent(
      new CustomEvent("entropic-require-signin", {
        detail: { source: "credits" },
      }),
    );
  }

  const gateway = useGatewayController({
    isAuthenticated,
    isAuthConfigured,
    refreshBalance,
    onNavigate: setCurrentPage,
    onRequestSignIn: requestSignIn,
  });

  useEffect(() => {
    if (!gateway.experimentalDesktop && currentPage === "files") {
      setCurrentPage("chat");
    }
  }, [gateway.experimentalDesktop, currentPage]);

  useEffect(() => {
    const handleOpenPage = (event: Event) => {
      const detail = (event as CustomEvent<{ page?: string }>).detail;
      if (detail?.page === "billing") {
        setCurrentPage("billing");
      }
    };
    window.addEventListener("entropic-open-page", handleOpenPage as EventListener);
    return () => {
      window.removeEventListener("entropic-open-page", handleOpenPage as EventListener);
    };
  }, []);

  async function openFeedbackPage() {
    const url = new URL(FEEDBACK_FORM_URL);
    if (!url.searchParams.get("source")) {
      url.searchParams.set("source", "desktop_sidebar");
    }
    if (!url.searchParams.get("app")) {
      url.searchParams.set("app", "desktop");
    }
    await open(url.toString());
  }

  function renderChatPage() {
    return (
      <Chat
        isVisible={currentPage === "chat"}
        gatewayRunning={gateway.gatewayRunning}
        gatewayStarting={gateway.gatewayStarting}
        gatewayRetryIn={gateway.gatewayRetryIn}
        onStartGateway={gateway.startGatewayFromChat}
        onRecoverProxyAuth={gateway.recoverProxyAuthFromChat}
        useLocalKeys={gateway.useLocalKeys}
        selectedModel={gateway.selectedModel}
        onModelChange={gateway.handleModelChange}
        imageModel={gateway.imageModel}
        integrationsSyncing={gateway.integrationsSyncing}
        integrationsMissing={gateway.integrationsMissing}
        onNavigate={setCurrentPage}
        onSessionsChange={(sessions, currentKey) => {
          setChatSessions((prev) => {
            if (sessions.length === 0 && prev.length > 0 && currentPage !== "chat") {
              return prev;
            }
            return sessions;
          });
          setCurrentChatSession((prev) => currentKey ?? prev);
          setPendingChatSession((pending) => {
            if (!pending) return pending;
            if (pending === "__new__") {
              return currentKey ? null : pending;
            }
            return pending === currentKey ? null : pending;
          });
          setPendingChatAction(null);
        }}
        requestedSession={pendingChatSession}
        requestedSessionAction={pendingChatAction}
      />
    );
  }

  function renderPage() {
    switch (currentPage) {
      case "chat":
        return null;
      case "store":
      case "skills":
        return (
          <Store
            integrationsSyncing={gateway.integrationsSyncing}
            integrationsMissing={gateway.integrationsMissing}
            onNavigate={(page) => setCurrentPage(page)}
          />
        );
      case "channels":
        return <Channels />;
      case "files":
        return (
          <Files
            gatewayRunning={gateway.gatewayRunning}
            integrationsSyncing={gateway.integrationsSyncing}
            integrationsMissing={gateway.integrationsMissing}
            onGatewayToggle={gateway.toggleGateway}
            isTogglingGateway={gateway.isTogglingGateway}
            experimentalDesktop={gateway.experimentalDesktop}
            onExperimentalDesktopChange={gateway.onExperimentalDesktopChange}
            selectedModel={gateway.selectedModel}
            onModelChange={gateway.handleModelChange}
            useLocalKeys={gateway.useLocalKeys}
            onUseLocalKeysChange={gateway.onUseLocalKeysChange}
            codeModel={gateway.codeModel}
            imageModel={gateway.imageModel}
            onCodeModelChange={gateway.onCodeModelChange}
            onImageModelChange={gateway.onImageModelChange}
          />
        );
      case "tasks":
        return <Tasks gatewayRunning={gateway.gatewayRunning} />;
      case "jobs":
        return <Jobs gatewayRunning={gateway.gatewayRunning} />;
      case "billing":
        return <BillingPage />;
      case "settings":
        return (
          <Settings
            gatewayRunning={gateway.gatewayRunning}
            onGatewayToggle={gateway.toggleGateway}
            isTogglingGateway={gateway.isTogglingGateway}
            experimentalDesktop={gateway.experimentalDesktop}
            onExperimentalDesktopChange={gateway.onExperimentalDesktopChange}
            selectedModel={gateway.selectedModel}
            onModelChange={gateway.handleModelChange}
            useLocalKeys={gateway.useLocalKeys}
            onUseLocalKeysChange={gateway.onUseLocalKeysChange}
            codeModel={gateway.codeModel}
            imageModel={gateway.imageModel}
            onCodeModelChange={gateway.onCodeModelChange}
            onImageModelChange={gateway.onImageModelChange}
          />
        );
      default:
        return null;
    }
  }

  return (
    <Layout
      currentPage={currentPage}
      onNavigate={setCurrentPage}
      onOpenFeedback={() => {
        void openFeedbackPage();
      }}
      gatewayRunning={gateway.gatewayRunning}
      experimentalDesktop={gateway.experimentalDesktop}
      integrationsSyncing={gateway.integrationsSyncing}
      chatSessions={chatSessions}
      currentChatSession={currentChatSession}
      onSelectChatSession={(key) => {
        setPendingChatSession(key);
        setCurrentChatSession(key);
        setCurrentPage("chat");
      }}
      onNewChat={() => {
        setPendingChatSession("__new__");
        setCurrentPage("chat");
      }}
      onChatSessionAction={(action) => {
        setPendingChatAction({ id: crypto.randomUUID(), ...action });
        setCurrentPage("chat");
      }}
    >
      {gateway.providerSwitchConfirm && (
        <div className="absolute inset-0 z-50 flex items-center justify-center">
          <div className="w-full max-w-sm mx-4 rounded-2xl bg-white border border-[var(--border-subtle)] shadow-xl p-6">
            <h2 className="text-sm font-semibold text-[var(--text-primary)]">Switch provider?</h2>
            <p className="text-xs text-[var(--text-secondary)] mt-2">
              Switching from <strong>{gateway.providerSwitchConfirm.oldProvider}</strong> to{" "}
              <strong>{gateway.providerSwitchConfirm.newProvider}</strong> will restart the
              sandbox container. Any running tasks will be interrupted.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                className="rounded-full border border-[var(--border-subtle)] bg-white px-4 py-1.5 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-muted)]"
                onClick={gateway.cancelProviderSwitch}
              >
                Cancel
              </button>
              <button
                className="rounded-full bg-[var(--text-primary)] px-4 py-1.5 text-xs text-white hover:opacity-90"
                onClick={() => {
                  void gateway.confirmProviderSwitch();
                }}
              >
                Switch Provider
              </button>
            </div>
          </div>
        </div>
      )}

      {gateway.showGatewayStartup && (
        <div className="absolute inset-0 z-50 flex items-center justify-center">
          <div className="w-full max-w-sm mx-4 rounded-2xl bg-white border border-[var(--border-subtle)] shadow-xl p-6">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 rounded-full bg-[var(--system-gray-6)] p-2">
                <Loader2 className="w-4 h-4 animate-spin text-[var(--text-primary)]" />
              </div>
              <div>
                <h2 className="text-sm font-semibold text-[var(--text-primary)]">
                  {gateway.gatewayRetryIn ? "Reconnecting Sandbox" : "Starting Secure Sandbox"}
                </h2>
                <p className="text-xs text-[var(--text-secondary)] mt-1 leading-relaxed">
                  {gateway.gatewayRetryIn
                    ? `Retrying in ${gateway.gatewayRetryIn}s. We’ll keep trying until the environment is ready.`
                    : "Entropic is initializing an isolated environment to safely run tools and plugins."}
                </p>
              </div>
            </div>

            <div className="mt-5 rounded-xl border border-violet-100 bg-violet-50/70 p-4">
              <div className="text-[10px] uppercase tracking-wider text-violet-700 font-bold mb-2">
                Did you know?
              </div>
              <div className="text-xs leading-relaxed text-violet-900 font-medium">
                {gateway.startupFact}
              </div>
            </div>

            <div className="mt-6 pt-4 border-t border-[var(--border-subtle)]">
              <div className="flex items-center justify-between text-[10px] text-[var(--text-tertiary)] uppercase tracking-widest font-semibold mb-3">
                System Status
                {gateway.gatewayStartupStage === "health" ? (
                  <span className="text-green-600">Ready</span>
                ) : (
                  <span className="animate-pulse">Initializing...</span>
                )}
              </div>
              <div className="space-y-2.5">
                <div className="flex items-center gap-2.5 text-[11px] text-[var(--text-secondary)]">
                  {gateway.gatewayStartupStage === "credits" ||
                  gateway.gatewayStartupStage === "token" ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-violet-500" />
                  ) : gateway.gatewayStartupStage === "launch" ||
                    gateway.gatewayStartupStage === "health" ? (
                    <CheckCircle2 className="w-3.5 h-3.5 text-green-600" />
                  ) : (
                    <div className="w-3.5 h-3.5 rounded-full border border-[var(--border-subtle)]" />
                  )}
                  <span
                    className={
                      gateway.gatewayStartupStage === "credits" ||
                      gateway.gatewayStartupStage === "token"
                        ? "font-medium text-[var(--text-primary)]"
                        : ""
                    }
                  >
                    Securing gateway credentials
                  </span>
                </div>
                <div className="flex items-center gap-2.5 text-[11px] text-[var(--text-secondary)]">
                  {gateway.gatewayStartupStage === "launch" ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-violet-500" />
                  ) : gateway.gatewayStartupStage === "health" ? (
                    <CheckCircle2 className="w-3.5 h-3.5 text-green-600" />
                  ) : (
                    <div className="w-3.5 h-3.5 rounded-full border border-[var(--border-subtle)]" />
                  )}
                  <span
                    className={
                      gateway.gatewayStartupStage === "launch"
                        ? "font-medium text-[var(--text-primary)]"
                        : ""
                    }
                  >
                    Provisioning isolated container
                  </span>
                </div>
                <div className="flex items-center gap-2.5 text-[11px] text-[var(--text-secondary)]">
                  {gateway.gatewayStartupStage === "health" ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-violet-500" />
                  ) : (
                    <div className="w-3.5 h-3.5 rounded-full border border-[var(--border-subtle)]" />
                  )}
                  <span
                    className={
                      gateway.gatewayStartupStage === "health"
                        ? "font-medium text-[var(--text-primary)]"
                        : ""
                    }
                  >
                    Verifying sandbox health
                  </span>
                </div>
              </div>
            </div>

            {!gateway.gatewayRetryIn && (
              <div className="mt-4 text-[10px] text-[var(--text-tertiary)] text-center italic">
                First-time setup may take a few seconds.
              </div>
            )}

            {gateway.startupError && (
              <div className="mt-3 text-xs text-red-600">
                {gateway.startupError.message}
                {gateway.startupError.actions && gateway.startupError.actions.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {gateway.startupError.actions.map((action) => (
                      <button
                        key={action.label}
                        className="rounded-full border border-[var(--border-subtle)] bg-white px-3 py-1 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-muted)]"
                        onClick={action.onClick}
                      >
                        {action.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {!gateway.showGatewayStartup && gateway.startupError && (
        <div className="absolute right-4 top-4 z-40 w-[min(28rem,calc(100%-2rem))] rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800 shadow-lg">
          <div className="font-medium">Gateway Start Failed</div>
          <div className="mt-1 text-xs">{gateway.startupError.message}</div>
          <div className="mt-3 flex flex-wrap gap-2">
            {gateway.startupError.actions &&
              gateway.startupError.actions.length > 0 &&
              gateway.startupError.actions.map((action) => (
                <button
                  key={action.label}
                  className="rounded-full border border-red-200 bg-white px-3 py-1 text-xs text-red-700 hover:bg-red-100"
                  onClick={action.onClick}
                >
                  {action.label}
                </button>
              ))}
            <button
              className="rounded-full border border-red-200 bg-white px-3 py-1 text-xs text-red-700 hover:bg-red-100"
              onClick={gateway.clearStartupError}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      <div
        className={currentPage === "chat" ? "h-full" : "hidden"}
        aria-hidden={currentPage !== "chat"}
      >
        {renderChatPage()}
      </div>
      {renderPage()}
    </Layout>
  );
}
