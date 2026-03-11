import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Loader2, Sparkles } from "lucide-react";
import { saveProfile, saveOnboardingData, setOnboardingComplete } from "../lib/profile";
import { clientLog } from "../lib/clientLog";

type Props = {
  onComplete: () => void;
};

const DEFAULT_AGENT_NAME = "Joulie";

const DEFAULT_SOUL = `# About Joulie

You are Joulie, a helpful AI assistant for coding, research, and execution tasks.
Be concise, practical, and action-oriented.
`;

async function withTimeout<T>(
  promise: Promise<T>,
  label: string,
  timeoutMs = 15000
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${Math.floor(timeoutMs / 1000)}s`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function Onboarding({ onComplete }: Props) {
  const startedRef = useRef(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitStage, setSubmitStage] = useState("");
  const [submitError, setSubmitError] = useState("");

  const handleComplete = async () => {
    setIsSubmitting(true);
    setSubmitError("");
    clientLog("onboarding.complete.start");

    try {
      setSubmitStage("Preparing your workspace...");
      await withTimeout(
        saveOnboardingData({
          soul: DEFAULT_SOUL,
          agentName: DEFAULT_AGENT_NAME,
          completedAt: new Date().toISOString(),
        }),
        "Saving onboarding data"
      );

      setSubmitStage("Syncing settings...");
      try {
        await withTimeout(
          invoke("sync_onboarding_to_settings", {
            soul: DEFAULT_SOUL,
            agentName: DEFAULT_AGENT_NAME,
          }),
          "Syncing onboarding settings"
        );
      } catch (error) {
        console.warn("Onboarding sync warning:", error);
      }

      setSubmitStage("Finalizing...");
      try {
        await withTimeout(saveProfile({ name: DEFAULT_AGENT_NAME }), "Saving agent profile");
      } catch (error) {
        console.warn("Profile save warning:", error);
      }

      await withTimeout(setOnboardingComplete(true), "Marking onboarding complete");
      window.dispatchEvent(new Event("entropic-profile-updated"));

      clientLog("onboarding.complete.success");
      onComplete();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Failed to complete onboarding:", error);
      clientLog("onboarding.complete.failed", { error: message });
      setSubmitError(message);
    } finally {
      setSubmitStage("");
      setIsSubmitting(false);
    }
  };

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void handleComplete();
  }, []);

  return (
    <div className="h-screen w-screen flex flex-col items-center justify-center bg-[var(--bg-primary)] px-6">
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

      <main className="w-full max-w-xl bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-2xl shadow-xl p-8 text-center animate-scale-in">
        <div className="mb-6 p-4 bg-[var(--system-gray-6)] rounded-xl inline-flex">
          <Sparkles className="w-7 h-7 text-[var(--purple-accent)]" />
        </div>

        <h1 className="text-3xl font-bold text-[var(--text-primary)] tracking-tight mb-3">
          Welcome to Entropic
        </h1>
        <p className="text-[var(--text-secondary)] mb-8">
          Entropic runs a secure local runtime for tools and coding workflows. We&apos;ll finish setup next.
        </p>

        <div className="text-left rounded-xl bg-[var(--system-gray-6)] border border-[var(--border-subtle)] p-4 mb-8">
          <p className="text-sm font-semibold text-[var(--text-primary)] mb-2">What happens next</p>
          <ul className="text-sm text-[var(--text-secondary)] space-y-1 list-disc pl-5">
            <li>Set up Docker/Colima runtime once</li>
            <li>Start a secure OpenClaw sandbox locally</li>
            <li>Begin with free credits and sign in later if needed</li>
          </ul>
        </div>

        <div className="w-full flex items-center justify-center gap-2 px-6 py-4 bg-[#1A1A2E] text-white rounded-xl font-semibold">
          <Loader2 className="w-4 h-4 animate-spin" />
          <span>{submitStage || "Preparing..."}</span>
        </div>

        {submitError && (
          <div className="mt-4 text-xs text-red-500">
            {submitError}
            <button
              onClick={handleComplete}
              disabled={isSubmitting}
              className="ml-3 underline"
            >
              Retry
            </button>
          </div>
        )}
      </main>
    </div>
  );
}
