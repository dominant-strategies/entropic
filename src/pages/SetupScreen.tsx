import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Loader2, CheckCircle2, XCircle, AlertTriangle, Copy } from "lucide-react";
import entropicLogo from "../assets/entropic-logo.png";
import quaiLogo from "../assets/quai-logo.svg";

type SetupProgress = {
  stage: string;
  message: string;
  percent: number;
  complete: boolean;
  error: string | null;
};

type Props = {
  onComplete: () => void;
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

  return {
    title: "Secure Sandbox Setup Failed",
    summary:
      "Entropic could not complete first-time runtime setup. The error details below can help identify the exact cause.",
    causes: ["Runtime startup returned an unexpected error"],
    actions: ["Click Try Again.", "If it persists, share technical details for diagnosis."],
    technical,
  };
}

export function SetupScreen({ onComplete }: Props) {
  const [isRunning, setIsRunning] = useState(false);
  const [progress, setProgress] = useState<SetupProgress | null>(null);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "error">("idle");
  const [factIndex, setFactIndex] = useState(0);
  const [tosAccepted, setTosAccepted] = useState(false);

  useEffect(() => {
    if (isRunning) {
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
  }, [isRunning, onComplete]);

  // Rotate educational facts during setup
  useEffect(() => {
    if (!isRunning || !progress || progress.complete || progress.error) {
      return;
    }
    const interval = window.setInterval(() => {
      setFactIndex((current) => (current + 1) % EDUCATIONAL_FACTS.length);
    }, 5000);
    return () => window.clearInterval(interval);
  }, [isRunning, progress]);

  // Auto-start setup on component mount only if ToS already accepted
  useEffect(() => {
    if (!isRunning && !progress && tosAccepted) {
      startSetup(false);
    }
  }, []);

  async function startSetup(withCleanup = false) {
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

  return (
    <div className="h-screen w-screen flex flex-col items-center justify-center bg-gradient-to-b from-gray-50 to-gray-100 p-8">
      {/* Drag region for window movement */}
      <div
        data-tauri-drag-region
        onMouseDown={(e) => {
          if (e.button !== 0) return;
          if ((e.target as HTMLElement).closest("button, a, input, select, textarea, [role='button']")) return;
          e.preventDefault();
          getCurrentWindow().startDragging();
        }}
        className="absolute top-0 left-0 right-0 h-12"
      />

      {/* Logo and Title */}
      <div className="mb-12 text-center">
        <div className="w-20 h-20 rounded-2xl flex items-center justify-center mx-auto mb-6 shadow-lg overflow-hidden bg-white border border-gray-100">
          <img src={entropicLogo} alt="Entropic" className="w-full h-full object-cover" />
        </div>
        <h1 className="text-3xl font-semibold text-gray-900 mb-2">
          Welcome to Entropic
        </h1>
        <p className="text-gray-500 max-w-md">
          Your AI assistant with secure sandboxing. Commands run in an isolated
          container, keeping your system safe.
        </p>
      </div>

      {/* Setup Card */}
      <div className="bg-white rounded-2xl shadow-xl p-8 max-w-md w-full">
        {!isRunning && !progress?.complete && (
          <>
            <h2 className="text-lg font-medium text-gray-900 mb-4">
              First-Time Setup
            </h2>
            <p className="text-gray-500 text-sm mb-6">
              Entropic needs to set up a secure sandbox environment. Everything is
              included — no Docker Desktop or other tools required. This only
              needs to happen once.
            </p>
            <label className="flex items-start gap-3 mb-6 cursor-pointer group">
              <input
                type="checkbox"
                checked={tosAccepted}
                onChange={(e) => setTosAccepted(e.target.checked)}
                className="mt-0.5 w-4 h-4 rounded border-gray-300 text-violet-600 focus:ring-violet-500 cursor-pointer"
              />
              <span className="text-sm text-gray-600 leading-relaxed">
                I have read and agree to the{" "}
                <a
                  href="https://entropic.qu.ai/terms"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-violet-600 hover:text-violet-800 underline font-medium"
                  onClick={(e) => e.stopPropagation()}
                >
                  Terms of Service
                </a>
                {" "}and{" "}
                <a
                  href="https://entropic.qu.ai/privacy"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-violet-600 hover:text-violet-800 underline font-medium"
                  onClick={(e) => e.stopPropagation()}
                >
                  Privacy Policy
                </a>.
              </span>
            </label>
            <button
              onClick={() => startSetup(false)}
              disabled={!tosAccepted}
              className="w-full py-3 px-4 bg-violet-600 hover:bg-violet-700 disabled:bg-gray-200 disabled:text-gray-400 disabled:cursor-not-allowed text-white font-medium rounded-xl transition-colors"
            >
              Set Up Secure Sandbox
            </button>
          </>
        )}

        {isRunning && progress && !progress.complete && !progress.error && (
          <div className="text-center">
            <Loader2 className="w-12 h-12 text-violet-600 animate-spin mx-auto mb-4" />
            <p className="text-gray-900 font-medium mb-2">{progress.message}</p>
            <div className="w-full bg-gray-100 rounded-full h-2 mb-2">
              <div
                className="bg-violet-600 h-2 rounded-full transition-all duration-500"
                style={{ width: `${progress.percent}%` }}
              />
            </div>
            <p className="text-gray-400 text-sm">{progress.percent}%</p>
            <div className="mt-5 rounded-xl border border-violet-100 bg-violet-50/70 p-3 text-left">
              <p className="text-[10px] uppercase tracking-wide text-violet-700 font-semibold mb-1">
                Setup Fact
              </p>
              <p className="text-xs text-violet-900">{EDUCATIONAL_FACTS[factIndex]}</p>
            </div>
          </div>
        )}

        {progress?.complete && (
          <div className="text-center">
            <CheckCircle2 className="w-12 h-12 text-green-500 mx-auto mb-4" />
            <p className="text-gray-900 font-medium">Setup Complete!</p>
            <p className="text-gray-500 text-sm mt-1">
              Launching Entropic...
            </p>
          </div>
        )}

        {progress?.error && (
          <div>
            {(() => {
              const diagnosis = diagnoseSetupError(progress.error);
              return (
                <>
                  <div className="text-center mb-5">
                    <XCircle className="w-12 h-12 text-red-500 mx-auto mb-4" />
                    <p className="text-gray-900 font-medium mb-1">Setup Failed</p>
                    <p className="text-red-600 text-sm font-medium">{diagnosis.title}</p>
                    <p className="text-gray-600 text-sm mt-2">{diagnosis.summary}</p>
                  </div>

                  <div className="rounded-xl border border-red-100 bg-red-50/60 p-4 mb-4">
                    <div className="flex items-center gap-2 text-red-700 font-medium text-sm mb-2">
                      <AlertTriangle className="w-4 h-4" />
                      What likely happened
                    </div>
                    <ul className="text-sm text-red-700 space-y-1 list-disc pl-5">
                      {diagnosis.causes.map((cause) => (
                        <li key={cause}>{cause}</li>
                      ))}
                    </ul>
                  </div>

                  <div className="rounded-xl border border-violet-100 bg-violet-50/60 p-4 mb-4">
                    <p className="text-violet-800 font-medium text-sm mb-2">Next steps</p>
                    <ol className="text-sm text-violet-800 space-y-1 list-decimal pl-5">
                      {diagnosis.actions.map((action) => (
                        <li key={action}>{action}</li>
                      ))}
                    </ol>
                  </div>

                  <details className="rounded-xl border border-gray-200 bg-gray-50 p-3 mb-4">
                    <summary className="cursor-pointer text-sm font-medium text-gray-700">
                      Technical details
                    </summary>
                    <pre className="mt-3 text-xs text-gray-700 whitespace-pre-wrap break-words max-h-56 overflow-auto">
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
                      className="mt-3 inline-flex items-center gap-2 px-3 py-2 rounded-lg text-xs border border-gray-300 bg-white hover:bg-gray-100 text-gray-700"
                    >
                      <Copy className="w-3.5 h-3.5" />
                      {copyStatus === "copied"
                        ? "Copied"
                        : copyStatus === "error"
                          ? "Copy failed"
                          : "Copy details"}
                    </button>
                  </details>

                  <div className="text-center">
                    <p className="text-xs text-gray-500 mb-3">
                      Automatic cleanup resets Entropic&apos;s isolated Colima runtime (VM/image/cache and container state under Entropic&apos;s runtime). It does not touch your macOS home files or Docker Desktop data.
                    </p>
                    <button
                      onClick={() => startSetup(false)}
                      className="w-full px-4 py-2 mb-2 rounded-lg border border-violet-200 text-violet-700 hover:bg-violet-50 font-medium"
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
                </>
              );
            })()}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="mt-8 flex flex-col items-center gap-1.5">
        <p className="text-gray-400 text-sm">Powered by OpenClaw</p>
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
