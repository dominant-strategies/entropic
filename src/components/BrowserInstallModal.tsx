import { useEffect, useState, useCallback } from "react";
import { X, Loader2, CheckCircle2, Circle, AlertTriangle } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import clsx from "clsx";

type BrowserInstallProgress = {
  stage: string;
  message: string;
  percent: number;
  complete: boolean;
  error: string | null;
};

type Props = {
  isOpen: boolean;
  onClose: () => void;
  onInstallComplete: () => void;
};

const INSTALL_STAGES = [
  {
    key: "downloading",
    title: "Downloading Chromium browser",
    detail: "Fetching patched Chromium binary (~200 MB)",
  },
  {
    key: "configuring",
    title: "Configuring browser paths",
    detail: "Setting up executable paths and symlinks",
  },
  {
    key: "verifying",
    title: "Verifying installation",
    detail: "Running browser version check",
  },
];

function stageIndex(stage: string): number {
  return INSTALL_STAGES.findIndex((s) => s.key === stage);
}

export function BrowserInstallModal({ isOpen, onClose, onInstallComplete }: Props) {
  const [progress, setProgress] = useState<BrowserInstallProgress | null>(null);
  const [installing, setInstalling] = useState(false);
  const [pollActive, setPollActive] = useState(false);

  const startInstall = useCallback(async () => {
    setInstalling(true);
    setPollActive(true);
    setProgress({
      stage: "downloading",
      message: "Starting installation...",
      percent: 2,
      complete: false,
      error: null,
    });
    try {
      await invoke("install_patchright_browser");
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      setProgress((prev) =>
        prev?.error
          ? prev
          : {
              stage: "error",
              message: detail,
              percent: 0,
              complete: false,
              error: detail,
            }
      );
      setInstalling(false);
      setPollActive(false);
    }
  }, []);

  useEffect(() => {
    if (!isOpen) {
      setProgress(null);
      setInstalling(false);
      setPollActive(false);
      return;
    }
    startInstall();
  }, [isOpen, startInstall]);

  useEffect(() => {
    if (!pollActive) return;
    const timer = setInterval(async () => {
      try {
        const p = await invoke<BrowserInstallProgress>("get_browser_install_progress");
        setProgress(p);
        if (p.complete || p.error) {
          setPollActive(false);
          setInstalling(false);
          if (p.complete) {
            onInstallComplete();
          }
        }
      } catch {
        // ignore poll errors
      }
    }, 500);
    return () => clearInterval(timer);
  }, [pollActive, onInstallComplete]);

  if (!isOpen) return null;

  const currentStageIdx = progress ? stageIndex(progress.stage) : -1;
  const isError = progress?.stage === "error";
  const isComplete = progress?.complete;

  return (
    <div
      className="fixed inset-0 bg-black/20 flex items-center justify-center z-50"
      onClick={installing ? undefined : onClose}
    >
      <div
        className="bg-white p-6 w-full max-w-lg m-4 max-h-[80vh] overflow-y-auto rounded-2xl shadow-xl border border-[var(--border-subtle)]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-[var(--text-primary)]">
            {isComplete
              ? "Browser Installed"
              : isError
                ? "Installation Failed"
                : "Installing Stealth Browser"}
          </h3>
          <button
            onClick={installing ? undefined : onClose}
            disabled={installing}
            className="p-1.5 text-[var(--text-tertiary)] hover:text-[var(--text-primary)] rounded-md hover:bg-black/5"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Progress area */}
        {installing && progress && !isError && !isComplete && (
          <div className="py-3">
            <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] p-4 mb-4">
              <div className="flex items-start gap-3 mb-3">
                <div className="w-9 h-9 rounded-full bg-[var(--system-blue)]/10 flex items-center justify-center shrink-0 mt-0.5">
                  <Loader2 className="w-5 h-5 animate-spin text-[var(--system-blue)]" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-[var(--text-primary)]">
                    {progress.message}
                  </p>
                  <p className="text-xs text-[var(--text-secondary)] mt-1">
                    This may take a few minutes on first install.
                  </p>
                </div>
              </div>
              <div className="w-full h-2 rounded-full bg-[var(--system-gray-6)] overflow-hidden">
                <div
                  className="h-full bg-[var(--system-blue)] transition-all duration-500 ease-out"
                  style={{ width: `${progress.percent}%` }}
                />
              </div>
            </div>

            <div className="space-y-2">
              {INSTALL_STAGES.map((stage, idx) => {
                const complete = currentStageIdx > idx;
                const active = currentStageIdx === idx;

                return (
                  <div
                    key={stage.key}
                    className={clsx(
                      "rounded-lg border px-3 py-2.5 flex items-start gap-2.5 transition-colors",
                      complete
                        ? "border-green-100 bg-green-50"
                        : active
                          ? "border-blue-100 bg-blue-50"
                          : "border-[var(--border-subtle)] bg-white"
                    )}
                  >
                    <div className="mt-0.5">
                      {complete ? (
                        <CheckCircle2 className="w-4 h-4 text-green-600" />
                      ) : active ? (
                        <Loader2 className="w-4 h-4 text-blue-600 animate-spin" />
                      ) : (
                        <Circle className="w-4 h-4 text-[var(--text-tertiary)]" />
                      )}
                    </div>
                    <div>
                      <p className="text-sm font-medium text-[var(--text-primary)]">
                        {stage.title}
                      </p>
                      <p className="text-xs text-[var(--text-secondary)] mt-0.5">
                        {stage.detail}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Complete state */}
        {isComplete && progress && (
          <div className="py-4">
            <div className="rounded-lg p-4 bg-green-50 flex items-center gap-3 mb-4">
              <CheckCircle2 className="w-6 h-6 text-green-600 shrink-0" />
              <div>
                <p className="font-medium text-green-700">
                  Browser installed successfully
                </p>
                <p className="text-xs text-green-600 mt-1">{progress.message}</p>
              </div>
            </div>
            <div className="flex justify-end">
              <button
                onClick={onClose}
                className="inline-flex items-center justify-center px-4 py-1.5 rounded-lg font-medium bg-[var(--text-primary)] text-white hover:bg-black shadow-sm transition-all duration-200 active:scale-95"
              >
                Done
              </button>
            </div>
          </div>
        )}

        {/* Error state */}
        {isError && progress && (
          <div className="py-4">
            <div className="rounded-lg p-4 bg-red-50 flex items-start gap-3 mb-4">
              <AlertTriangle className="w-6 h-6 text-red-600 shrink-0 mt-0.5" />
              <div>
                <p className="font-medium text-red-700">Installation failed</p>
                <p className="text-xs text-red-600 mt-1 break-words">
                  {progress.error || progress.message}
                </p>
              </div>
            </div>
            <div className="flex gap-3 justify-end">
              <button
                onClick={onClose}
                className="inline-flex items-center justify-center px-4 py-1.5 rounded-lg font-medium bg-white text-[var(--text-primary)] border border-[var(--border-default)] hover:bg-[var(--system-gray-6)] shadow-sm transition-all duration-200 active:scale-95"
              >
                Close
              </button>
              <button
                onClick={startInstall}
                className="inline-flex items-center justify-center px-4 py-1.5 rounded-lg font-medium bg-[var(--text-primary)] text-white hover:bg-black shadow-sm transition-all duration-200 active:scale-95"
              >
                Retry
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
