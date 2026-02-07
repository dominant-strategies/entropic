import { useState, useEffect } from "react";
import { ChevronDown, Zap, Star, Brain, Sparkles } from "lucide-react";
import { Model } from "../lib/auth";

// Fallback models if API fails
const FALLBACK_MODELS: Model[] = [
  { id: "openrouter/free", name: "OpenRouter Free (Router)", provider: "OpenRouter", tier: "fast" },
  { id: "anthropic/claude-opus-4.5", name: "Claude Opus 4.5", provider: "Anthropic", tier: "premium" },
  { id: "openai/gpt-5.2", name: "GPT‑5.2", provider: "OpenAI", tier: "recommended" },
  { id: "openai/gpt-5.2-codex", name: "GPT‑5.2 Codex", provider: "OpenAI", tier: "reasoning" },
  { id: "google/gemini-3-pro-image-preview", name: "Gemini 3 Pro Image (Nano Banana 3)", provider: "Google", tier: "premium" },
];

const TIER_ICONS: Record<string, typeof Zap> = {
  fast: Zap,
  recommended: Star,
  premium: Sparkles,
  reasoning: Brain,
};

const TIER_COLORS: Record<string, string> = {
  fast: "text-green-400",
  recommended: "text-yellow-400",
  premium: "text-purple-400",
  reasoning: "text-blue-400",
};

// Provider colors for future use
// const PROVIDER_COLORS: Record<string, string> = {
//   Anthropic: "bg-orange-500/20 text-orange-400",
//   OpenAI: "bg-green-500/20 text-green-400",
//   Google: "bg-blue-500/20 text-blue-400",
//   Meta: "bg-indigo-500/20 text-indigo-400",
//   DeepSeek: "bg-cyan-500/20 text-cyan-400",
//   Mistral: "bg-amber-500/20 text-amber-400",
// };

interface ModelSelectorProps {
  selectedModel: string;
  onModelChange: (modelId: string) => void;
  compact?: boolean;
}

export function ModelSelector({ selectedModel, onModelChange, compact = false }: ModelSelectorProps) {
  const [models, _setModels] = useState<Model[]>(FALLBACK_MODELS);
  const [isOpen, setIsOpen] = useState(false);
  const [_isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    setIsLoading(false);
  }, []);

  // Save model preference
  const handleModelChange = async (modelId: string) => {
    onModelChange(modelId);
    setIsOpen(false);
  };

  const currentModel = models.find(m => m.id === selectedModel) || models[0];
  const TierIcon = TIER_ICONS[currentModel?.tier || "recommended"] || Star;

  // Group models by provider
  const groupedModels = models.reduce((acc, model) => {
    if (!acc[model.provider]) {
      acc[model.provider] = [];
    }
    acc[model.provider].push(model);
    return acc;
  }, {} as Record<string, Model[]>);

  if (compact) {
    return (
      <div className="relative">
        <button
          onClick={() => setIsOpen(!isOpen)}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg
                   bg-[var(--bg-tertiary)] hover:bg-[var(--bg-secondary)]
                   text-sm text-[var(--text-secondary)] transition-colors"
        >
          <TierIcon className={`w-3.5 h-3.5 ${TIER_COLORS[currentModel?.tier || "recommended"]}`} />
          <span className="max-w-[120px] truncate">{currentModel?.name || "Select model"}</span>
          <ChevronDown className={`w-3.5 h-3.5 transition-transform ${isOpen ? "rotate-180" : ""}`} />
        </button>

        {isOpen && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setIsOpen(false)} />
            <div className="absolute right-0 mt-2 w-64 max-h-80 overflow-y-auto z-50
                          bg-[var(--bg-secondary)] border border-[var(--border-primary)]
                          rounded-xl shadow-xl">
              {Object.entries(groupedModels).map(([provider, providerModels]) => (
                <div key={provider}>
                  <div className="px-3 py-2 text-xs font-medium text-[var(--text-tertiary)]
                                border-b border-[var(--border-primary)]">
                    {provider}
                  </div>
                  {providerModels.map(model => {
                    const Icon = TIER_ICONS[model.tier] || Star;
                    return (
                      <button
                        key={model.id}
                        onClick={() => handleModelChange(model.id)}
                        className={`w-full flex items-center gap-3 px-3 py-2.5
                                  hover:bg-[var(--bg-tertiary)] transition-colors
                                  ${model.id === selectedModel ? "bg-[var(--bg-tertiary)]" : ""}`}
                      >
                        <Icon className={`w-4 h-4 ${TIER_COLORS[model.tier]}`} />
                        <span className="flex-1 text-left text-sm text-[var(--text-primary)]">
                          {model.name}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    );
  }

  // Full version for settings page
  return (
    <div className="space-y-3">
      <label className="text-sm font-medium text-[var(--text-secondary)]">
        AI Model
      </label>

      <div className="relative">
        <button
          onClick={() => setIsOpen(!isOpen)}
          className="w-full flex items-center justify-between gap-3 px-4 py-3
                   bg-[var(--bg-tertiary)] hover:bg-[var(--bg-secondary)]
                   rounded-xl border border-[var(--border-primary)] transition-colors"
        >
          <div className="flex items-center gap-3">
            <TierIcon className={`w-5 h-5 ${TIER_COLORS[currentModel?.tier || "recommended"]}`} />
            <div className="text-left">
              <div className="font-medium text-[var(--text-primary)]">
                {currentModel?.name || "Select model"}
              </div>
              <div className="text-xs text-[var(--text-tertiary)]">
                {currentModel?.provider}
              </div>
            </div>
          </div>
          <ChevronDown className={`w-5 h-5 text-[var(--text-tertiary)] transition-transform ${isOpen ? "rotate-180" : ""}`} />
        </button>

        {isOpen && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setIsOpen(false)} />
            <div className="absolute left-0 right-0 mt-2 max-h-96 overflow-y-auto z-50
                          bg-[var(--bg-secondary)] border border-[var(--border-primary)]
                          rounded-xl shadow-xl">
              {Object.entries(groupedModels).map(([provider, providerModels]) => (
                <div key={provider}>
                  <div className="sticky top-0 px-4 py-2 text-xs font-semibold text-[var(--text-tertiary)]
                                bg-[var(--bg-secondary)] border-b border-[var(--border-primary)]">
                    {provider}
                  </div>
                  {providerModels.map(model => {
                    const Icon = TIER_ICONS[model.tier] || Star;
                    return (
                      <button
                        key={model.id}
                        onClick={() => handleModelChange(model.id)}
                        className={`w-full flex items-center gap-4 px-4 py-3
                                  hover:bg-[var(--bg-tertiary)] transition-colors
                                  ${model.id === selectedModel ? "bg-[var(--purple-accent)]/10" : ""}`}
                      >
                        <Icon className={`w-5 h-5 ${TIER_COLORS[model.tier]}`} />
                        <div className="flex-1 text-left">
                          <div className="font-medium text-[var(--text-primary)]">
                            {model.name}
                          </div>
                          <div className="text-xs text-[var(--text-tertiary)]">
                            {model.tier === "fast" && "Fast & affordable"}
                            {model.tier === "recommended" && "Best balance"}
                            {model.tier === "premium" && "Most capable"}
                            {model.tier === "reasoning" && "Advanced reasoning"}
                          </div>
                        </div>
                        {model.id === selectedModel && (
                          <div className="w-2 h-2 rounded-full bg-[var(--purple-accent)]" />
                        )}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      <p className="text-xs text-[var(--text-tertiary)]">
        Different models have different capabilities and costs.
        <span className="inline-flex items-center gap-1 ml-2">
          <Zap className="w-3 h-3 text-green-400" /> Fast
          <Star className="w-3 h-3 text-yellow-400 ml-2" /> Balanced
          <Sparkles className="w-3 h-3 text-purple-400 ml-2" /> Premium
        </span>
      </p>
    </div>
  );
}
