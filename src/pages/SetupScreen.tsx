import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Shield, Loader2, CheckCircle2, XCircle, AlertTriangle, Copy } from "lucide-react";

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
        "Nova could not verify the Colima disk image download. This is usually a network/proxy issue, not your data.",
      causes: [
        "Network path modified or corrupted the image download",
        "Temporary CDN/network reliability issue while fetching Colima image",
      ],
      actions: [
        "Click Try Again. Nova will retry startup automatically.",
        "If it fails again, retry on a different network (hotspot/home Wi-Fi).",
        "If your username has spaces and you keep seeing `cd: /Users/...` in logs, update to the latest Nova build.",
      ],
      technical,
    };
  }

  if (hasHomeSplit) {
    return {
      title: "Sandbox Startup Hit a Home Path Parsing Error",
      summary:
        "Nova runtime tools failed while resolving your macOS home path. This is recoverable with the latest runtime fix.",
      causes: [
        "Bundled Colima/Lima shell step split a whitespace home path",
        "Older Nova build without runtime HOME isolation fix",
      ],
      actions: [
        "Update to the latest Nova build and click Try Again.",
        "If this persists, reset Nova’s isolated runtime using the command shown in technical details.",
      ],
      technical,
    };
  }

  return {
    title: "Secure Sandbox Setup Failed",
    summary:
      "Nova could not complete first-time runtime setup. The error details below can help identify the exact cause.",
    causes: ["Runtime startup returned an unexpected error"],
    actions: ["Click Try Again.", "If it persists, share technical details for diagnosis."],
    technical,
  };
}

export function SetupScreen({ onComplete }: Props) {
  const [isRunning, setIsRunning] = useState(false);
  const [progress, setProgress] = useState<SetupProgress | null>(null);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "error">("idle");

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

  async function startSetup() {
    setIsRunning(true);
    try {
      await invoke("run_first_time_setup");
    } catch (error) {
      console.error("Setup failed:", error);
    }
  }

  return (
    <div className="h-screen w-screen flex flex-col items-center justify-center bg-gradient-to-b from-gray-50 to-gray-100 p-8">
      {/* Logo and Title */}
      <div className="mb-12 text-center">
        <div className="w-20 h-20 bg-gradient-to-br from-violet-500 to-purple-600 rounded-2xl flex items-center justify-center mx-auto mb-6 shadow-lg">
          <Shield className="w-10 h-10 text-white" />
        </div>
        <h1 className="text-3xl font-semibold text-gray-900 mb-2">
          Welcome to Nova
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
              Nova needs to set up a secure sandbox environment. Everything is
              included — no Docker Desktop or other tools required. This only
              needs to happen once.
            </p>
            <button
              onClick={startSetup}
              className="w-full py-3 px-4 bg-violet-600 hover:bg-violet-700 text-white font-medium rounded-xl transition-colors"
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
          </div>
        )}

        {progress?.complete && (
          <div className="text-center">
            <CheckCircle2 className="w-12 h-12 text-green-500 mx-auto mb-4" />
            <p className="text-gray-900 font-medium">Setup Complete!</p>
            <p className="text-gray-500 text-sm mt-1">
              Launching Nova...
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
                    <button
                      onClick={() => {
                        setIsRunning(false);
                        setProgress(null);
                        setCopyStatus("idle");
                      }}
                      className="px-4 py-2 text-violet-600 hover:text-violet-700 font-medium"
                    >
                      Try Again
                    </button>
                  </div>
                </>
              );
            })()}
          </div>
        )}
      </div>

      {/* Footer */}
      <p className="mt-8 text-gray-400 text-sm">
        Powered by OpenClaw
      </p>
    </div>
  );
}
