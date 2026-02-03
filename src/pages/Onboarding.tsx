import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ArrowRight, ArrowLeft, Sparkles, User, Bot } from "lucide-react";
import { saveProfile, setOnboardingComplete, saveOnboardingData } from "../lib/profile";

type OnboardingData = {
  userName: string;
  agentName: string;
};

type Props = {
  onComplete: () => void;
};

const steps = [
  { id: "user", title: "Your Name", icon: User },
  { id: "agent", title: "Name Your Assistant", icon: Bot },
];

export function Onboarding({ onComplete }: Props) {
  const [currentStep, setCurrentStep] = useState(0);
  const [data, setData] = useState<OnboardingData>({
    userName: "",
    agentName: "Nova",
  });
  const [isSubmitting, setIsSubmitting] = useState(false);

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

  const generateSoul = (): string => {
    return `# About ${data.userName}

You are ${data.agentName}, ${data.userName}'s helpful AI assistant.
Be friendly, knowledgeable, and ready to help.
`;
  };

  const handleComplete = async () => {
    setIsSubmitting(true);
    try {
      // Generate the SOUL.md content
      const soul = generateSoul();

      // Save onboarding data locally (will be synced to container when Docker is ready)
      await saveOnboardingData({
        userName: data.userName,
        agentName: data.agentName,
        soul,
      });

      // Sync to Rust store so apply_agent_settings can use it when Docker starts
      await invoke("sync_onboarding_to_settings", {
        soul,
        agentName: data.agentName,
      });

      // Save the agent profile (name for sidebar display)
      await saveProfile({ name: data.agentName });

      // Mark onboarding as complete
      await setOnboardingComplete(true);

      // Notify that profile was updated
      window.dispatchEvent(new Event("nova-profile-updated"));

      onComplete();
    } catch (error) {
      console.error("Failed to complete onboarding:", error);
    } finally {
      setIsSubmitting(false);
    }
  };

  const renderStep = () => {
    switch (currentStep) {
      case 0:
        return (
          <div className="space-y-6">
            <div className="text-center">
              <div className="w-16 h-16 rounded-2xl bg-[var(--purple-accent)] mx-auto flex items-center justify-center mb-4">
                <Sparkles className="w-8 h-8 text-white" />
              </div>
              <h1 className="text-2xl font-bold text-[var(--text-primary)] mb-2">
                Welcome to Nova
              </h1>
              <p className="text-[var(--text-secondary)]">
                What's your name?
              </p>
            </div>
            <input
              type="text"
              value={data.userName}
              onChange={(e) => setData({ ...data, userName: e.target.value })}
              placeholder="Enter your name"
              className="form-input text-lg text-center"
              autoFocus
            />
          </div>
        );

      case 1:
        return (
          <div className="space-y-6">
            <div className="text-center">
              <h1 className="text-2xl font-bold text-[var(--text-primary)] mb-2">
                Name your assistant
              </h1>
              <p className="text-[var(--text-secondary)]">
                Give your AI assistant a name, or keep the default.
              </p>
            </div>
            <input
              type="text"
              value={data.agentName}
              onChange={(e) => setData({ ...data, agentName: e.target.value })}
              placeholder="Nova"
              className="form-input text-lg text-center"
              autoFocus
            />
            <div className="text-center text-sm text-[var(--text-tertiary)]">
              You can change this later in Settings.
            </div>
          </div>
        );

      default:
        return null;
    }
  };

  return (
    <div className="h-screen w-screen flex items-center justify-center bg-[var(--bg-primary)]">
      <div className="w-full max-w-lg p-8">
        {/* Progress dots */}
        <div className="flex justify-center gap-2 mb-8">
          {steps.map((_, index) => (
            <div
              key={index}
              className={`w-2 h-2 rounded-full transition-colors ${
                index === currentStep
                  ? "bg-[var(--purple-accent)]"
                  : index < currentStep
                  ? "bg-[var(--purple-accent)]/50"
                  : "bg-[var(--text-tertiary)]/30"
              }`}
            />
          ))}
        </div>

        {/* Step content */}
        <div className="glass-card p-8 mb-6">
          {renderStep()}
        </div>

        {/* Navigation */}
        <div className="flex justify-between">
          <button
            onClick={handleBack}
            disabled={currentStep === 0}
            className={`btn-secondary flex items-center gap-2 ${
              currentStep === 0 ? "opacity-0 pointer-events-none" : ""
            }`}
          >
            <ArrowLeft className="w-4 h-4" />
            Back
          </button>

          <button
            onClick={handleNext}
            disabled={!canProceed() || isSubmitting}
            className="btn-primary flex items-center gap-2"
          >
            {isSubmitting ? (
              "Setting up..."
            ) : currentStep === steps.length - 1 ? (
              <>
                Get Started
                <Sparkles className="w-4 h-4" />
              </>
            ) : (
              <>
                Continue
                <ArrowRight className="w-4 h-4" />
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
