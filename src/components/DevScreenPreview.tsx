import { useEffect, useMemo, useState } from "react";
import { SetupScreen, type SetupProgress, type SetupScreenPreviewState } from "../pages/SetupScreen";
import {
  SANDBOX_STARTUP_FACTS,
  SandboxStartupOverlay,
  type GatewayStartupStage,
} from "./SandboxStartupOverlay";

type DevScreenKind = "setup" | "startup";

const STARTUP_STAGES: GatewayStartupStage[] = ["credits", "token", "launch", "health"];
const SETUP_STATES: SetupScreenPreviewState[] = ["idle", "running", "complete", "error"];
const PREVIEW_SETUP_ERROR = `colima start --profile entropic-vz
error validating sha sum: expected sha256 checksum to match downloaded image
hint: retry on a stable network or rebuild the local runtime bundle`;

function parseDevScreen(raw: string | null): DevScreenKind {
  return raw === "startup" ? "startup" : "setup";
}

function parseSetupState(raw: string | null): SetupScreenPreviewState {
  return raw === "running" || raw === "complete" || raw === "error" ? raw : "idle";
}

function parseStartupStage(raw: string | null): GatewayStartupStage {
  return raw === "token" || raw === "launch" || raw === "health" ? raw : "credits";
}

function buildPreviewProgress(state: SetupScreenPreviewState): SetupProgress | null {
  switch (state) {
    case "running":
      return {
        stage: "runtime",
        message: "Downloading and configuring secure sandbox runtime...",
        percent: 47,
        complete: false,
        error: null,
      };
    case "complete":
      return {
        stage: "complete",
        message: "Setup Complete!",
        percent: 100,
        complete: true,
        error: null,
      };
    case "error":
      return {
        stage: "error",
        message: "Setup failed",
        percent: 63,
        complete: false,
        error: PREVIEW_SETUP_ERROR,
      };
    default:
      return null;
  }
}

export function DevScreenPreview() {
  const initialParams = useMemo(() => new URLSearchParams(window.location.search), []);
  const [screen, setScreen] = useState<DevScreenKind>(parseDevScreen(initialParams.get("devScreen")));
  const [setupState, setSetupState] = useState<SetupScreenPreviewState>(
    parseSetupState(initialParams.get("setupState")),
  );
  const [setupTosAccepted, setSetupTosAccepted] = useState(initialParams.get("tos") !== "0");
  const [startupStage, setStartupStage] = useState<GatewayStartupStage>(
    parseStartupStage(initialParams.get("startupStage")),
  );
  const [startupRetryIn, setStartupRetryIn] = useState<number | null>(
    initialParams.get("retry") === "1" ? 7 : null,
  );
  const [factIndex, setFactIndex] = useState(0);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    params.set("devScreen", screen);
    if (screen === "setup") {
      params.set("setupState", setupState);
      params.set("tos", setupTosAccepted ? "1" : "0");
      params.delete("startupStage");
      params.delete("retry");
    } else {
      params.set("startupStage", startupStage);
      if (startupRetryIn) {
        params.set("retry", "1");
      } else {
        params.delete("retry");
      }
      params.delete("setupState");
      params.delete("tos");
    }
    window.history.replaceState(null, "", `${window.location.pathname}?${params.toString()}`);
  }, [screen, setupState, setupTosAccepted, startupRetryIn, startupStage]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      setFactIndex((current) => (current + 1) % SANDBOX_STARTUP_FACTS.length);
    }, 4500);
    return () => window.clearInterval(interval);
  }, []);

  return (
    <div className="h-screen w-screen overflow-hidden bg-[var(--bg-primary)]">
      <div className="fixed top-4 right-4 z-[100] w-[320px] rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-card)]/95 shadow-xl backdrop-blur-sm">
        <div className="border-b border-[var(--border-subtle)] px-4 py-3">
          <div className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--text-tertiary)]">
            Dev Screen Preview
          </div>
          <div className="mt-1 text-sm text-[var(--text-secondary)]">
            Open this directly in your browser while running <code>pnpm dev</code>.
          </div>
        </div>

        <div className="space-y-4 p-4">
          <div>
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--text-tertiary)]">
              Screen
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setScreen("setup")}
                className={`rounded-full px-3 py-1.5 text-xs font-medium ${
                  screen === "setup"
                    ? "bg-[#1A1A2E] text-white"
                    : "bg-[var(--bg-muted)] text-[var(--text-secondary)]"
                }`}
              >
                Setup
              </button>
              <button
                type="button"
                onClick={() => setScreen("startup")}
                className={`rounded-full px-3 py-1.5 text-xs font-medium ${
                  screen === "startup"
                    ? "bg-[#1A1A2E] text-white"
                    : "bg-[var(--bg-muted)] text-[var(--text-secondary)]"
                }`}
              >
                Startup Overlay
              </button>
            </div>
          </div>

          {screen === "setup" ? (
            <>
              <div>
                <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--text-tertiary)]">
                  Setup State
                </div>
                <div className="flex flex-wrap gap-2">
                  {SETUP_STATES.map((state) => (
                    <button
                      key={state}
                      type="button"
                      onClick={() => setSetupState(state)}
                      className={`rounded-full px-3 py-1.5 text-xs font-medium ${
                        setupState === state
                          ? "bg-violet-600 text-white"
                          : "bg-[var(--bg-muted)] text-[var(--text-secondary)]"
                      }`}
                    >
                      {state}
                    </button>
                  ))}
                </div>
              </div>

              <label className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
                <input
                  type="checkbox"
                  checked={setupTosAccepted}
                  onChange={(event) => setSetupTosAccepted(event.target.checked)}
                  className="h-4 w-4"
                />
                Terms accepted
              </label>
            </>
          ) : (
            <>
              <div>
                <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--text-tertiary)]">
                  Startup Stage
                </div>
                <div className="flex flex-wrap gap-2">
                  {STARTUP_STAGES.map((stage) => (
                    <button
                      key={stage}
                      type="button"
                      onClick={() => setStartupStage(stage)}
                      className={`rounded-full px-3 py-1.5 text-xs font-medium ${
                        startupStage === stage
                          ? "bg-violet-600 text-white"
                          : "bg-[var(--bg-muted)] text-[var(--text-secondary)]"
                      }`}
                    >
                      {stage}
                    </button>
                  ))}
                </div>
              </div>

              <label className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
                <input
                  type="checkbox"
                  checked={startupRetryIn !== null}
                  onChange={(event) => setStartupRetryIn(event.target.checked ? 7 : null)}
                  className="h-4 w-4"
                />
                Show reconnect state
              </label>
            </>
          )}

          <div className="rounded-xl bg-[var(--bg-muted)] px-3 py-2 text-xs text-[var(--text-secondary)]">
            URL: <code>{window.location.pathname}?devScreen={screen}</code>
          </div>
        </div>
      </div>

      {screen === "setup" ? (
        <SetupScreen
          onComplete={() => {}}
          preview={{
            state: setupState,
            tosAccepted: setupTosAccepted,
            progress: buildPreviewProgress(setupState),
            onToggleTos: setSetupTosAccepted,
            onStart: () => setSetupState("running"),
          }}
        />
      ) : (
        <div className="relative h-full w-full bg-[var(--bg-primary)]">
          <SandboxStartupOverlay
            className="absolute inset-0 z-10"
            stage={startupStage}
            retryIn={startupRetryIn}
            factIndex={factIndex}
          />
        </div>
      )}
    </div>
  );
}
