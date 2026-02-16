import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ArrowRight, ArrowLeft, Sparkles } from "lucide-react";
import { saveProfile, setOnboardingComplete, saveOnboardingData } from "../lib/profile";
import { clientLog } from "../lib/clientLog";

type OnboardingData = {
  userName: string;
  agentName: string;
};

type Props = {
  onComplete: () => void;
};

const steps = [
  { id: "user", title: "Welcome", subtitle: "First, what's your name?" },
  { id: "agent", title: "Name your AI", subtitle: "What would you like to call your assistant?" },
];

export function Onboarding({ onComplete }: Props) {
  const [currentStep, setCurrentStep] = useState(0);
  const [data, setData] = useState<OnboardingData>({
    userName: "",
    agentName: "Nova",
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitStage, setSubmitStage] = useState("");
  const [submitError, setSubmitError] = useState("");

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

  const canProceed = () => {
    switch (currentStep) {
      case 0: return data.userName.trim().length > 0;
      case 1: return data.agentName.trim().length > 0;
      default: return false;
    }
  };

  const handleNext = async () => {
    if (currentStep < steps.length - 1) {
      setCurrentStep(currentStep + 1);
    } else {
      await handleComplete();
    }
  };

  const handleBack = () => {
    if (currentStep > 0) {
      setCurrentStep(currentStep - 1);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && canProceed() && !isSubmitting) {
      handleNext();
    }
  };

  const generateSoul = (): string => {
    return `# About ${data.userName}

You are ${data.agentName}, ${data.userName}'s helpful AI assistant.
Be friendly, knowledgeable, and ready to help.
`;
  };

  const handleComplete = async () => {
    setIsSubmitting(true);
    setSubmitError("");
    clientLog("onboarding.complete.start");
    try {
      // Generate the SOUL.md content
      const soul = generateSoul();

      // Save onboarding data locally
      setSubmitStage("Saving profile...");
      clientLog("onboarding.stage.save_profile");
      await withTimeout(
        saveOnboardingData({
          userName: data.userName,
          agentName: data.agentName,
          soul,
        }),
        "Saving onboarding data"
      );

      // Sync to Rust store (best effort)
      setSubmitStage("Syncing settings...");
      clientLog("onboarding.stage.sync_settings");
      try {
        await withTimeout(
          invoke("sync_onboarding_to_settings", {
            soul,
            agentName: data.agentName,
          }),
          "Syncing onboarding settings"
        );
      } catch (error) {
        console.warn("Onboarding sync warning:", error);
      }

      // Save the agent profile (best effort)
      setSubmitStage("Finalizing...");
      clientLog("onboarding.stage.finalize");
      try {
        await withTimeout(saveProfile({ name: data.agentName }), "Saving agent profile");
      } catch (error) {
        console.warn("Profile save warning:", error);
      }

      // Mark onboarding as complete (required)
      await withTimeout(
        setOnboardingComplete(true),
        "Marking onboarding as complete"
      );

      // Notify that profile was updated
      window.dispatchEvent(new Event("nova-profile-updated"));

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

  return (
    <div className="h-screen w-screen flex flex-col items-center justify-center bg-[var(--bg-primary)] transition-colors duration-500">
      
      {/* Progress Indicator - Minimalist at top */}
      <div className="absolute top-12 flex gap-3">
        {steps.map((_, index) => (
          <div
            key={index}
            className={`h-1 rounded-full transition-all duration-500 ${
              index === currentStep ? "w-8 bg-black" : "w-2 bg-gray-300"
            }`}
          />
        ))}
      </div>

      <div className="w-full max-w-2xl px-8 flex flex-col items-center animate-scale-in">
        
        {/* Step Icon/Decoration */}
        <div className="mb-8 p-4 bg-white rounded-3xl shadow-xl shadow-purple-500/10">
          <Sparkles className="w-8 h-8 text-[var(--purple-accent)] transition-colors duration-500" />
        </div>

        {/* Text Content */}
        <h1 className="text-4xl font-bold text-gray-900 mb-3 text-center tracking-tight">
          {steps[currentStep].title}
        </h1>
        <p className="text-xl text-gray-500 mb-12 text-center font-medium">
          {steps[currentStep].subtitle}
        </p>

        {/* Input Area */}
        <div className="w-full max-w-md relative mb-16 group">
          <input
            type="text"
            value={currentStep === 0 ? data.userName : data.agentName}
            onChange={(e) => {
              if (currentStep === 0) setData({ ...data, userName: e.target.value });
              else setData({ ...data, agentName: e.target.value });
            }}
            onKeyDown={handleKeyDown}
            placeholder={currentStep === 0 ? "Type your name..." : "Name your assistant..."}
            className="w-full bg-transparent text-4xl text-center font-medium text-gray-900 placeholder:text-gray-300
                     focus:outline-none border-b-2 border-gray-100 focus:border-black transition-all pb-4"
            autoFocus
          />
        </div>

        {/* Navigation Actions */}
        <div className="flex flex-col items-center gap-6">
          <button
            onClick={handleNext}
            disabled={!canProceed() || isSubmitting}
            className="group relative flex items-center gap-3 px-12 py-4 bg-black text-white rounded-full font-semibold text-lg
                     hover:bg-gray-800 disabled:opacity-30 disabled:cursor-not-allowed transition-all shadow-lg hover:shadow-xl hover:-translate-y-0.5"
          >
            {isSubmitting ? (
              <span className="flex items-center gap-2">
                {submitStage || "Setup..."}
              </span>
            ) : (
              <span className="flex items-center gap-2">
                {currentStep === steps.length - 1 ? "Get Started" : "Continue"}
                <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
              </span>
            )}
          </button>

          {submitError && (
            <div className="max-w-md text-center text-xs text-red-500">
              {submitError}
            </div>
          )}

          <button
            onClick={handleBack}
            className={`text-sm font-medium text-gray-400 hover:text-gray-600 transition-all
                     ${currentStep === 0 ? "opacity-0 pointer-events-none" : "opacity-100"}`}
          >
            Go back
          </button>
        </div>

      </div>
    </div>
  );
}
