import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-shell";
import { Loader2, CheckCircle2, XCircle, AlertTriangle, Copy } from "lucide-react";
import entropicLogo from "../assets/entropic-logo.png";
import quaiHeaderWhite from "../assets/quai-header-white.png";
import quaiLogo from "../assets/quai-logo.svg";

export type SetupProgress = {
  stage: string;
  message: string;
  percent: number;
  complete: boolean;
  error: string | null;
};

export type SetupScreenPreviewState = "idle" | "running" | "complete" | "error";

type SetupScreenPreview = {
  state: SetupScreenPreviewState;
  tosAccepted?: boolean;
  progress?: SetupProgress | null;
  onToggleTos?: (accepted: boolean) => void;
  onStart?: (withCleanup: boolean) => void;
};

type Props = {
  onComplete: () => void;
  preview?: SetupScreenPreview;
};

type SetupErrorDiagnosis = {
  title: string;
  summary: string;
  causes: string[];
  actions: string[];
  technical: string;
};

const EDUCATIONAL_FACTS = [
  "Entropic runs OpenClaw in an isolated container so generated commands stay sandboxed.",
  "Colima is a lightweight local VM runtime that Entropic uses on macOS for secure container execution.",
  "Use Integrations to connect tools like Calendar or Gmail after setup completes.",
  "Local Keys mode lets you use your own provider keys directly from Settings.",
  "Proxy mode uses Entropic credits and keeps model routing and billing centralized.",
  "Jobs and Files are designed for longer-running automation, while Chat is best for quick iterations.",
];

function sanitizeSetupError(rawError: string): string {
  return rawError
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => {
      // Filter noisy progress bars from Colima image downloads.
      if (/^\s*[#.\d%\s]+\s*$/.test(line)) return false;
      return true;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function diagnoseSetupError(rawError: string): SetupErrorDiagnosis {
  const technical = sanitizeSetupError(rawError);
  const lower = technical.toLowerCase();
  const hasQcowSha =
    lower.includes("error validating sha sum") || lower.includes("error getting qcow image");
  const hasHomeSplit =
    lower.includes("cd: /users/") && lower.includes("no such file or directory");

  if (hasQcowSha) {
    return {
      title: "Couldn’t Download Sandbox Image Reliably",
      summary:
        "Entropic could not verify the Colima disk image download. This is usually a network/proxy issue, not your data.",
      causes: [
        "Network path modified or corrupted the image download",
        "Temporary CDN/network reliability issue while fetching Colima image",
      ],
      actions: [
        "Click Try Again. Entropic will retry startup automatically.",
        "If it fails again, retry on a different network (hotspot/home Wi-Fi).",
        "If your username has spaces and you keep seeing `cd: /Users/...` in logs, update to the latest Entropic build.",
      ],
      technical,
    };
  }

  if (hasHomeSplit) {
    return {
      title: "Sandbox Startup Hit a Home Path Parsing Error",
      summary:
        "Entropic runtime tools failed while resolving your macOS home path. This is recoverable with the latest runtime fix.",
      causes: [
        "Bundled Colima/Lima shell step split a whitespace home path",
        "Older Entropic build without runtime HOME isolation fix",
      ],
      actions: [
        "Update to the latest Entropic build and click Try Again.",
        "If this persists, reset Entropic’s isolated runtime using the command shown in technical details.",
      ],
      technical,
    };
  }

  if (
    lower.includes("wsl platform installed") &&
    lower.includes("restart windows")
  ) {
    return {
      title: "Restart Windows to Finish WSL Setup",
      summary:
        "Windows accepted the WSL platform install, but the OS still needs one reboot before Entropic can import its managed runtime.",
      causes: [
        "WSL was enabled for the first time on this PC",
        "Windows feature activation has not finished yet",
      ],
      actions: [
        "Restart Windows completely, then reopen Entropic.",
        "After the reboot, run first-time setup again.",
      ],
      technical,
    };
  }

  if (
    lower.includes("installed wsl command is too old") ||
    (lower.includes("invalid command line option") && lower.includes("--install"))
  ) {
    return {
      title: "Update WSL Before Setup Can Continue",
      summary:
        "This Windows PC has an older WSL command-line tool that does not support Entropic's automatic WSL installation flow.",
      causes: [
        "Windows is using an older in-box WSL CLI without `wsl --install` support",
        "WSL platform components are missing or the machine needs the newer WSL package",
      ],
      actions: [
        "Update WSL, or enable Windows Subsystem for Linux and Virtual Machine Platform in Windows Features.",
        "Restart Windows completely, then reopen Entropic and run setup again.",
      ],
      technical,
    };
  }

  if (
    lower.includes("docker engine is not ready in entropic-prod") &&
    (
      lower.includes("temporary failure resolving") ||
      lower.includes("unable to locate package docker.io") ||
      lower.includes("missing native docker engine binaries")
    )
  ) {
    return {
      title: "Sandbox Runtime Image Is Outdated",
      summary:
        "The Windows sandbox image did not contain a working Docker engine, so setup fell back to package installation and failed.",
      causes: [
        "Published Windows WSL rootfs artifact is missing Docker",
        "First-run setup tried to install Docker inside WSL and hit network or DNS failures",
      ],
      actions: [
        "Update to the latest Entropic Windows build and retry setup.",
        "If the issue persists, Entropic needs a republished Windows WSL rootfs artifact.",
      ],
      technical,
    };
  }

  return {
    title: "Secure Sandbox Setup Failed",
    summary:
      "Entropic could not complete first-time runtime setup. The error details below can help identify the exact cause.",
    causes: ["Runtime startup returned an unexpected error"],
    actions: ["Click Try Again.", "If it persists, share technical details for diagnosis."],
    technical,
  };
}

function detectDarkTheme(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  const root = document.documentElement;
  if (root.classList.contains("dark")) return true;
  if (root.classList.contains("light")) return false;

  return window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ?? false;
}

export function SetupScreen({ onComplete, preview }: Props) {
  const [isRunning, setIsRunning] = useState(false);
  const [progress, setProgress] = useState<SetupProgress | null>(null);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "error">("idle");
  const [factIndex, setFactIndex] = useState(0);
  const [tosAccepted, setTosAccepted] = useState(false);
  const [isDarkTheme, setIsDarkTheme] = useState(() => detectDarkTheme());
  const isPreview = Boolean(preview);

  const activeProgress = useMemo(() => {
    if (!preview) {
      return progress;
    }
    if (preview.progress !== undefined) {
      return preview.progress;
    }
    switch (preview.state) {
      case "running":
        return {
          stage: "runtime",
          message: "Downloading and configuring secure sandbox runtime...",
          percent: 42,
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
          percent: 67,
          complete: false,
          error:
            "colima start --profile entropic-vz\nerror validating sha sum: expected checksum to match downloaded image",
        };
      default:
        return null;
    }
  }, [preview, progress]);
  const activeIsRunning = preview ? preview.state === "running" : isRunning;
  const activeTosAccepted = preview ? Boolean(preview.tosAccepted) : tosAccepted;

  useEffect(() => {
    if (!isPreview && isRunning) {
      const interval = setInterval(async () => {
        const p = await invoke<SetupProgress>("get_setup_progress");
        setProgress(p);
        if (p.complete) {
          clearInterval(interval);
          setTimeout(onComplete, 1500);
        }
      }, 500);
      return () => clearInterval(interval);
    }
  }, [isPreview, isRunning, onComplete]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    const updateTheme = () => setIsDarkTheme(detectDarkTheme());
    updateTheme();

    const observer = new MutationObserver(updateTheme);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });

    if (media?.addEventListener) {
      media.addEventListener("change", updateTheme);
    } else if (media?.addListener) {
      media.addListener(updateTheme);
    }

    return () => {
      observer.disconnect();
      if (media?.removeEventListener) {
        media.removeEventListener("change", updateTheme);
      } else if (media?.removeListener) {
        media.removeListener(updateTheme);
      }
    };
  }, []);

  // Rotate educational facts during setup
  useEffect(() => {
    if (!activeIsRunning || !activeProgress || activeProgress.complete || activeProgress.error) {
      return;
    }
    const interval = window.setInterval(() => {
      setFactIndex((current) => (current + 1) % EDUCATIONAL_FACTS.length);
    }, 5000);
    return () => window.clearInterval(interval);
  }, [activeIsRunning, activeProgress]);

  // Auto-start setup on component mount only if ToS already accepted
  useEffect(() => {
    if (!isPreview && !isRunning && !progress && tosAccepted) {
      void startSetup(false);
    }
    // Mount-only: this is only meant for a pre-accepted setup state, not checkbox changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function startSetup(withCleanup = false) {
    if (preview) {
      preview.onStart?.(withCleanup);
      return;
    }
    setCopyStatus("idle");
    setProgress({
      stage: withCleanup ? "cleanup" : "starting",
      message: withCleanup
        ? "Cleaning isolated runtime and retrying setup..."
        : "Starting setup...",
      percent: withCleanup ? 5 : 0,
      complete: false,
      error: null,
    });
    setIsRunning(true);
    try {
      await invoke(
        withCleanup ? "run_first_time_setup_with_cleanup" : "run_first_time_setup",
      );
    } catch (error) {
      console.error("Setup failed:", error);
    }
  }

  async function openExternalLink(url: string) {
    if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
      await open(url);
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
  }

  return (
    <div className="min-h-screen w-screen flex flex-col items-center bg-gradient-to-b from-[var(--bg-muted)] to-[var(--bg-tertiary)] px-8 py-12 overflow-y-auto">
      {/* Drag region for window movement */}
      <div
        data-tauri-drag-region
        onMouseDown={(e) => {
          if (e.button !== 0) return;
          if ((e.target as HTMLElement).closest("button, a, input, select, textarea, [role='button']")) return;
          if (!(typeof window !== "undefined" && "__TAURI_INTERNALS__" in window)) return;
          e.preventDefault();
          getCurrentWindow().startDragging();
        }}
        className="absolute top-0 left-0 right-0 h-12"
      />

      {/* Logo and Title — hidden entirely on error screen */}
      {!activeProgress?.error && (
        <div className="mb-12 text-center mt-auto">
          <img
            src={isDarkTheme ? quaiHeaderWhite : entropicLogo}
            alt={isDarkTheme ? "Quai Network" : "Entropic"}
            className={isDarkTheme ? "mx-auto mb-6 h-auto w-full max-w-[260px]" : "mx-auto mb-6 h-20 w-20"}
          />
          <h1 className="text-3xl font-semibold text-[var(--text-primary)] mb-2">
            Welcome to Entropic
          </h1>
          <p className="text-[var(--text-secondary)] max-w-md">
            Your AI assistant with secure sandboxing. Commands run in an isolated
            container, keeping your system safe.
          </p>
        </div>
      )}

      {/* Setup Card */}
      <div className={`bg-[var(--bg-card)] rounded-2xl shadow-xl p-8 w-full max-h-[calc(100vh-10rem)] overflow-y-auto ${activeProgress?.error ? "max-w-xl" : "max-w-md"}`}>
        {!activeIsRunning && !activeProgress?.complete && !activeProgress?.error && (
          <>
            <h2 className="text-lg font-medium text-[var(--text-primary)] mb-4">
              First-Time Setup
            </h2>
            <p className="text-[var(--text-secondary)] text-sm mb-6">
              Entropic needs to set up a secure sandbox environment. Everything is
              included — no Docker Desktop or other tools required. This only
              needs to happen once.
            </p>
            <label className="flex items-start gap-3 mb-6 cursor-pointer group">
              <input
                type="checkbox"
                checked={activeTosAccepted}
                onChange={(e) => {
                  if (preview) {
                    preview.onToggleTos?.(e.target.checked);
                    return;
                  }
                  setTosAccepted(e.target.checked);
                }}
                className="mt-0.5 w-4 h-4 rounded border-[var(--border-primary)] text-violet-600 focus:ring-violet-500 cursor-pointer"
              />
              <span className="text-sm text-[var(--text-secondary)] leading-relaxed">
                I have read and agree to the{" "}
                <button
                  type="button"
                  className="text-violet-600 hover:text-violet-800 underline font-medium"
                  onClick={(e) => {
                    e.stopPropagation();
                    void openExternalLink("https://entropic.qu.ai/terms");
                  }}
                >
                  Terms of Service
                </button>
                {" "}and{" "}
                <button
                  type="button"
                  className="text-violet-600 hover:text-violet-800 underline font-medium"
                  onClick={(e) => {
                    e.stopPropagation();
                    void openExternalLink("https://entropic.qu.ai/privacy");
                  }}
                >
                  Privacy Policy
                </button>.
              </span>
            </label>
            <button
              onClick={() => startSetup(false)}
              disabled={!activeTosAccepted}
              className="w-full py-3 px-4 bg-violet-600 hover:bg-violet-700 disabled:bg-[var(--bg-secondary)] disabled:text-[var(--text-tertiary)] disabled:cursor-not-allowed text-white font-medium rounded-xl transition-colors"
            >
              Set Up Secure Sandbox
            </button>
          </>
        )}

        {activeIsRunning && activeProgress && !activeProgress.complete && !activeProgress.error && (
          <div className="text-center">
            <Loader2 className="w-12 h-12 text-violet-600 animate-spin mx-auto mb-4" />
            <p className="text-[var(--text-primary)] font-medium mb-2">{activeProgress.message}</p>
            <div className="w-full bg-[var(--bg-tertiary)] rounded-full h-2 mb-2">
              <div
                className="bg-violet-600 h-2 rounded-full transition-all duration-500"
                style={{ width: `${activeProgress.percent}%` }}
              />
            </div>
            <p className="text-[var(--text-tertiary)] text-sm">{activeProgress.percent}%</p>
            <div className="mt-5 rounded-xl border border-violet-500/20 bg-violet-500/10 p-3 text-left">
              <p className="text-[10px] uppercase tracking-wide text-violet-500 font-semibold mb-1">
                Setup Fact
              </p>
              <p className="text-xs text-[var(--text-secondary)]">{EDUCATIONAL_FACTS[factIndex]}</p>
            </div>
          </div>
        )}

        {activeProgress?.complete && (
          <div className="text-center">
            <CheckCircle2 className="w-12 h-12 text-green-500 mx-auto mb-4" />
            <p className="text-[var(--text-primary)] font-medium">Setup Complete!</p>
            <p className="text-[var(--text-secondary)] text-sm mt-1">
              Launching Entropic...
            </p>
          </div>
        )}

        {activeProgress?.error && (
          <div>
            {(() => {
              const diagnosis = diagnoseSetupError(activeProgress.error);
              return (
                <>
                  <div className="text-center mb-4">
                    <XCircle className="w-10 h-10 text-red-500 mx-auto mb-3" />
                    <p className="text-[var(--text-primary)] font-medium mb-1">Setup Failed</p>
                    <p className="text-red-500 text-sm font-medium">{diagnosis.title}</p>
                    <p className="text-[var(--text-secondary)] text-sm mt-1">{diagnosis.summary}</p>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
                    <div className="rounded-xl border border-red-500/20 bg-red-500/10 p-4">
                      <div className="flex items-center gap-2 text-red-500 font-medium text-sm mb-2">
                        <AlertTriangle className="w-4 h-4 shrink-0" />
                        What likely happened
                      </div>
                      <ul className="text-sm text-[var(--text-secondary)] space-y-1 list-disc pl-5">
                        {diagnosis.causes.map((cause) => (
                          <li key={cause}>{cause}</li>
                        ))}
                      </ul>
                    </div>

                    <div className="rounded-xl border border-violet-500/20 bg-violet-500/10 p-4">
                      <p className="text-violet-500 font-medium text-sm mb-2">Next steps</p>
                      <ol className="text-sm text-[var(--text-secondary)] space-y-1 list-decimal pl-5">
                        {diagnosis.actions.map((action) => (
                          <li key={action}>{action}</li>
                        ))}
                      </ol>
                    </div>
                  </div>

                  <div className="text-center mb-4">
                    <p className="text-xs text-[var(--text-secondary)] mb-3">
                      Automatic cleanup resets Entropic&apos;s isolated runtime state. On Windows it removes Entropic&apos;s managed WSL distros and runtime cache; on macOS it resets Entropic&apos;s isolated Colima runtime. It does not touch your normal WSL distros, macOS home files, or Docker Desktop data.
                    </p>
                    <button
                      onClick={() => startSetup(false)}
                      className="w-full px-4 py-2 mb-2 rounded-lg border border-violet-500/20 text-violet-500 hover:bg-violet-500/10 font-medium"
                    >
                      Retry Setup
                    </button>
                    <button
                      onClick={() => startSetup(true)}
                      className="w-full px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-700 text-white font-medium"
                    >
                      Retry with Automatic Cleanup
                    </button>
                  </div>

                  <details className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-muted)] p-3">
                    <summary className="cursor-pointer text-sm font-medium text-[var(--text-secondary)]">
                      Technical details
                    </summary>
                    <pre className="mt-3 text-xs text-[var(--text-secondary)] whitespace-pre-wrap break-words max-h-56 overflow-auto">
                      {diagnosis.technical}
                    </pre>
                    <button
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(diagnosis.technical);
                          setCopyStatus("copied");
                        } catch {
                          setCopyStatus("error");
                        } finally {
                          setTimeout(() => setCopyStatus("idle"), 1800);
                        }
                      }}
                      className="mt-3 inline-flex items-center gap-2 px-3 py-2 rounded-lg text-xs border border-[var(--border-primary)] bg-[var(--bg-card)] hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"
                    >
                      <Copy className="w-3.5 h-3.5" />
                      {copyStatus === "copied"
                        ? "Copied"
                        : copyStatus === "error"
                          ? "Copy failed"
                          : "Copy details"}
                    </button>
                  </details>
                </>
              );
            })()}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="mt-auto pt-8 flex flex-col items-center gap-1.5">
        <p className="text-[var(--text-tertiary)] text-sm">Powered by OpenClaw</p>
        <a href="https://qu.ai" target="_blank" rel="noopener noreferrer">
          <img
            src={quaiLogo}
            alt="Quai Network"
            className="h-5 w-auto"
          />
        </a>
      </div>
    </div>
  );
}
