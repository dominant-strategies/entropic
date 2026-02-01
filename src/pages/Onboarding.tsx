import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ArrowRight, ArrowLeft, Sparkles, User, Heart, Target, Bot } from "lucide-react";
import { saveProfile, setOnboardingComplete, saveOnboardingData } from "../lib/profile";

type OnboardingData = {
  userName: string;
  interests: string;
  goals: string;
  agentName: string;
};

type Props = {
  onComplete: () => void;
};

const steps = [
  { id: "welcome", title: "Welcome to Nova", icon: Sparkles },
  { id: "user", title: "About You", icon: User },
  { id: "interests", title: "Your Interests", icon: Heart },
  { id: "goals", title: "Your Goals", icon: Target },
  { id: "agent", title: "Name Your Assistant", icon: Bot },
];

export function Onboarding({ onComplete }: Props) {
  const [currentStep, setCurrentStep] = useState(0);
  const [data, setData] = useState<OnboardingData>({
    userName: "",
    interests: "",
    goals: "",
    agentName: "Nova",
  });
  const [isSubmitting, setIsSubmitting] = useState(false);

  const canProceed = () => {
    switch (currentStep) {
      case 0: return true; // Welcome screen
      case 1: return data.userName.trim().length > 0;
      case 2: return data.interests.trim().length > 0;
      case 3: return data.goals.trim().length > 0;
      case 4: return data.agentName.trim().length > 0;
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

${data.userName} is using Nova as their personal AI assistant.

## Their Interests
${data.interests}

## What They Want From You
${data.goals}

## Your Personality
You are ${data.agentName}, ${data.userName}'s helpful AI assistant. Be friendly, knowledgeable, and attentive to their interests and goals. Tailor your responses to be relevant to what they care about.

Remember:
- Address them by name when appropriate
- Reference their interests when relevant to the conversation
- Help them achieve the goals they've shared with you
- Be concise but thorough
- Maintain a warm, professional tone
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
        interests: data.interests,
        goals: data.goals,
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
          <div className="text-center space-y-6">
            <div className="w-20 h-20 rounded-2xl bg-[var(--purple-accent)] mx-auto flex items-center justify-center">
              <Sparkles className="w-10 h-10 text-white" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-[var(--text-primary)] mb-2">
                Welcome to Nova
              </h1>
              <p className="text-[var(--text-secondary)] max-w-md mx-auto">
                Let's set up your personal AI assistant. This will only take a minute
                and will help Nova understand how to best help you.
              </p>
            </div>
          </div>
        );

      case 1:
        return (
          <div className="space-y-6">
            <div className="text-center">
              <h1 className="text-2xl font-bold text-[var(--text-primary)] mb-2">
                What's your name?
              </h1>
              <p className="text-[var(--text-secondary)]">
                This helps your assistant personalize conversations.
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

      case 2:
        return (
          <div className="space-y-6">
            <div className="text-center">
              <h1 className="text-2xl font-bold text-[var(--text-primary)] mb-2">
                What are you interested in?
              </h1>
              <p className="text-[var(--text-secondary)]">
                Share your hobbies, work, or areas you'd like help with.
              </p>
            </div>
            <textarea
              value={data.interests}
              onChange={(e) => setData({ ...data, interests: e.target.value })}
              placeholder="e.g., software development, cooking, fitness, learning languages, startups..."
              className="form-input text-base"
              rows={4}
              autoFocus
            />
          </div>
        );

      case 3:
        return (
          <div className="space-y-6">
            <div className="text-center">
              <h1 className="text-2xl font-bold text-[var(--text-primary)] mb-2">
                What would you like Nova to help with?
              </h1>
              <p className="text-[var(--text-secondary)]">
                Describe what you hope to get out of using your AI assistant.
              </p>
            </div>
            <textarea
              value={data.goals}
              onChange={(e) => setData({ ...data, goals: e.target.value })}
              placeholder="e.g., help me stay organized, answer technical questions, brainstorm ideas, automate tasks..."
              className="form-input text-base"
              rows={4}
              autoFocus
            />
          </div>
        );

      case 4:
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
