import { CheckCircle2, Loader2 } from "lucide-react";

export type GatewayStartupStage = "idle" | "credits" | "token" | "launch" | "health";

type StartupAction = {
  label: string;
  onClick: () => void;
};

type StartupError = {
  message: string;
  actions?: StartupAction[];
};

export const SANDBOX_STARTUP_FACTS = [
  "Secure Execution: Entropic runs all shell commands in an isolated sandbox to protect your local system.",
  "Custom Providers: Add your own API keys in Settings for direct access to the latest models.",
  "Deep Context: Stage logs or documentation in 'Files' so Entropic can analyze them with full technical detail.",
  "Tasks + Jobs: Plan and track work in Tasks, then automate routines from Jobs.",
  "Codebase Awareness: Ask Entropic to 'read the repo' to generate precise implementation roadmaps.",
  "Seamless Integrations: Connect GitHub, Slack, or Linear via Integrations to extend Entropic's capabilities.",
  "One-click Workflow: Quickly initialize projects or deploy environments with a single command.",
];

type Props = {
  stage: GatewayStartupStage;
  retryIn?: number | null;
  factIndex?: number;
  startupError?: StartupError | null;
  showFirstTimeHint?: boolean;
  className?: string;
};

export function SandboxStartupOverlay({
  stage,
  retryIn = null,
  factIndex = 0,
  startupError = null,
  showFirstTimeHint = false,
  className = "absolute inset-0 z-50",
}: Props) {
  const fact = SANDBOX_STARTUP_FACTS[
    ((factIndex % SANDBOX_STARTUP_FACTS.length) + SANDBOX_STARTUP_FACTS.length) %
      SANDBOX_STARTUP_FACTS.length
  ];

  return (
    <div className={`${className} flex items-center justify-center`}>
      <div className="w-full max-w-sm mx-4 rounded-2xl bg-[var(--bg-card)] border border-[var(--border-subtle)] shadow-xl p-6">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 rounded-full bg-[var(--system-gray-6)] p-2">
            <Loader2 className="w-4 h-4 animate-spin text-[var(--text-primary)]" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-[var(--text-primary)]">
              {retryIn ? "Reconnecting Sandbox" : "Starting Secure Sandbox"}
            </h2>
            <p className="text-xs text-[var(--text-secondary)] mt-1 leading-relaxed">
              {retryIn
                ? `Retrying in ${retryIn}s. We’ll keep trying until the environment is ready.`
                : "Entropic is initializing an isolated environment to safely run tools and plugins."}
            </p>
          </div>
        </div>

        <div className="mt-5 rounded-xl border border-violet-100 bg-violet-50/70 p-4">
          <div className="text-[10px] uppercase tracking-wider text-violet-700 font-bold mb-2">
            Did you know?
          </div>
          <div className="text-xs leading-relaxed text-violet-900 font-medium">
            {fact}
          </div>
        </div>

        <div className="mt-6 pt-4 border-t border-[var(--border-subtle)]">
          <div className="flex items-center justify-between text-[10px] text-[var(--text-tertiary)] uppercase tracking-widest font-semibold mb-3">
            System Status
            {stage === "health" ? (
              <span className="text-green-500">Ready</span>
            ) : (
              <span className="animate-pulse">Initializing...</span>
            )}
          </div>
          <div className="space-y-2.5">
            <div className="flex items-center gap-2.5 text-[11px] text-[var(--text-secondary)]">
              {stage === "credits" || stage === "token" ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin text-violet-500" />
              ) : stage === "launch" || stage === "health" ? (
                <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />
              ) : (
                <div className="w-3.5 h-3.5 rounded-full border border-[var(--border-subtle)]" />
              )}
              <span className={stage === "credits" || stage === "token" ? "font-medium text-[var(--text-primary)]" : ""}>
                Securing gateway credentials
              </span>
            </div>
            <div className="flex items-center gap-2.5 text-[11px] text-[var(--text-secondary)]">
              {stage === "launch" ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin text-violet-500" />
              ) : stage === "health" ? (
                <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />
              ) : (
                <div className="w-3.5 h-3.5 rounded-full border border-[var(--border-subtle)]" />
              )}
              <span className={stage === "launch" ? "font-medium text-[var(--text-primary)]" : ""}>
                Provisioning isolated container
              </span>
            </div>
            <div className="flex items-center gap-2.5 text-[11px] text-[var(--text-secondary)]">
              {stage === "health" ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin text-violet-500" />
              ) : (
                <div className="w-3.5 h-3.5 rounded-full border border-[var(--border-subtle)]" />
              )}
              <span className={stage === "health" ? "font-medium text-[var(--text-primary)]" : ""}>
                Verifying sandbox health
              </span>
            </div>
          </div>
        </div>

        {showFirstTimeHint && !retryIn && (
          <div className="mt-4 text-[10px] text-[var(--text-tertiary)] text-center italic">
            First-time setup may take a few seconds.
          </div>
        )}

        {startupError && (
          <div className="mt-3 text-xs text-red-500">
            {startupError.message}
            {startupError.actions && startupError.actions.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2">
                {startupError.actions.map((action) => (
                  <button
                    key={action.label}
                    className="rounded-full border border-[var(--border-subtle)] bg-[var(--bg-card)] px-3 py-1 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-muted)]"
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
  );
}
