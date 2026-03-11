import { useState, useEffect, useRef, type CSSProperties } from "react";
import { ChevronDown, Zap, Star, Brain, Sparkles } from "lucide-react";
import { Model } from "../lib/auth";

// Proxy-mode models (routed through Entropic backend)
const PROXY_MODELS: Model[] = [
  { id: "openrouter/free", name: "OpenRouter Free (Router)", provider: "OpenRouter", tier: "fast" },
  { id: "anthropic/claude-opus-4-6:thinking", name: "Claude Opus 4.6 (Thinking)", provider: "Anthropic", tier: "premium" },
  { id: "anthropic/claude-opus-4-6", name: "Claude Opus 4.6", provider: "Anthropic", tier: "premium" },
  { id: "anthropic/claude-opus-4.5", name: "Claude Opus 4.5", provider: "Anthropic", tier: "premium" },
  { id: "openai/gpt-5.4", name: "GPT-5.4", provider: "OpenAI", tier: "recommended" },
  { id: "openai/gpt-5.3-codex", name: "GPT-5.3 Codex", provider: "OpenAI", tier: "reasoning" },
  { id: "openai/gpt-5.2", name: "GPT-5.2", provider: "OpenAI", tier: "recommended" },
  { id: "openai/gpt-5.2-codex", name: "GPT-5.2 Codex", provider: "OpenAI", tier: "reasoning" },
  { id: "google/gemini-3.1-pro-preview", name: "Gemini 3.1 Pro Preview", provider: "Google", tier: "premium" },
  { id: "google/gemini-3.1-flash-image-preview", name: "Gemini 3.1 Flash Image Preview", provider: "Google", tier: "premium" },
  { id: "google/gemini-3-pro-image-preview", name: "Gemini 3 Pro Image (Nano Banana 3)", provider: "Google", tier: "premium" },
];

// Local-keys models (direct provider API access)
const LOCAL_MODELS: Model[] = [
  // Anthropic — thinking-enabled variants first
  { id: "anthropic/claude-opus-4-6:thinking", name: "Claude Opus 4.6 (Thinking)", provider: "Anthropic", tier: "premium" },
  { id: "anthropic/claude-opus-4-6", name: "Claude Opus 4.6", provider: "Anthropic", tier: "premium" },
  { id: "anthropic/claude-opus-4-5:thinking", name: "Claude Opus 4.5 (Thinking)", provider: "Anthropic", tier: "premium" },
  { id: "anthropic/claude-opus-4-5", name: "Claude Opus 4.5", provider: "Anthropic", tier: "premium" },
  { id: "anthropic/claude-sonnet-4-5-20250929:thinking", name: "Claude Sonnet 4.5 (Thinking)", provider: "Anthropic", tier: "recommended" },
  { id: "anthropic/claude-sonnet-4-5-20250929", name: "Claude Sonnet 4.5", provider: "Anthropic", tier: "recommended" },
  { id: "anthropic/claude-sonnet-4-20250514:thinking", name: "Claude Sonnet 4 (Thinking)", provider: "Anthropic", tier: "recommended" },
  { id: "anthropic/claude-sonnet-4-20250514", name: "Claude Sonnet 4", provider: "Anthropic", tier: "recommended" },
  { id: "anthropic/claude-haiku-3-5-20241022", name: "Claude Haiku 3.5", provider: "Anthropic", tier: "fast" },
  // OpenAI Codex — uses openai-codex/ provider prefix for OAuth auth-profiles
  { id: "openai-codex/gpt-5.3-codex:reasoning=xhigh", name: "GPT-5.3 Codex (Extra High)", provider: "OpenAI", tier: "premium" },
  { id: "openai-codex/gpt-5.3-codex:reasoning=high", name: "GPT-5.3 Codex (High)", provider: "OpenAI", tier: "premium" },
  { id: "openai-codex/gpt-5.3-codex:reasoning=medium", name: "GPT-5.3 Codex (Medium)", provider: "OpenAI", tier: "premium" },
  { id: "openai-codex/gpt-5.3-codex:reasoning=low", name: "GPT-5.3 Codex (Low)", provider: "OpenAI", tier: "premium" },
  { id: "openai-codex/gpt-5.2:reasoning=xhigh", name: "GPT-5.2 (Extra High)", provider: "OpenAI", tier: "recommended" },
  { id: "openai-codex/gpt-5.2:reasoning=high", name: "GPT-5.2 (High)", provider: "OpenAI", tier: "recommended" },
  { id: "openai-codex/gpt-5.2:reasoning=medium", name: "GPT-5.2 (Medium)", provider: "OpenAI", tier: "recommended" },
  { id: "openai-codex/gpt-5.2:reasoning=low", name: "GPT-5.2 (Low)", provider: "OpenAI", tier: "recommended" },
  { id: "openai-codex/gpt-5.2-codex:reasoning=xhigh", name: "GPT-5.2 Codex (Extra High)", provider: "OpenAI", tier: "reasoning" },
  { id: "openai-codex/gpt-5.2-codex:reasoning=high", name: "GPT-5.2 Codex (High)", provider: "OpenAI", tier: "reasoning" },
  { id: "openai-codex/gpt-5.2-codex:reasoning=medium", name: "GPT-5.2 Codex (Medium)", provider: "OpenAI", tier: "reasoning" },
  { id: "openai-codex/gpt-5.2-codex:reasoning=low", name: "GPT-5.2 Codex (Low)", provider: "OpenAI", tier: "reasoning" },
  // Google
  { id: "google/gemini-2.5-pro", name: "Gemini 2.5 Pro", provider: "Google", tier: "premium" },
  { id: "google/gemini-2.0-flash", name: "Gemini 2.0 Flash", provider: "Google", tier: "fast" },
];

// Exported ID sets for mode-mismatch detection in Dashboard
export const PROXY_MODEL_IDS = new Set(PROXY_MODELS.map(m => m.id));
export const LOCAL_MODEL_IDS = new Set(LOCAL_MODELS.map(m => m.id));

// Map provider display names to auth provider IDs
const PROVIDER_AUTH_ID: Record<string, string> = {
  Anthropic: "anthropic",
  OpenAI: "openai",
  Google: "google",
  OpenRouter: "openrouter",
};

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
  useLocalKeys?: boolean;
  /** Provider IDs that have keys configured (e.g. ["anthropic", "openai"]). When set, only matching providers are shown. */
  connectedProviders?: string[];
}

export function ModelSelector({ selectedModel, onModelChange, compact = false, useLocalKeys = false, connectedProviders }: ModelSelectorProps) {
  const allModels = useLocalKeys ? LOCAL_MODELS : PROXY_MODELS;
  // Filter to only show models from providers the user has connected
  const models = connectedProviders && connectedProviders.length > 0
    ? allModels.filter(m => connectedProviders.includes(PROVIDER_AUTH_ID[m.provider] ?? m.provider.toLowerCase()))
    : allModels;
  const [isOpen, setIsOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [menuStyle, setMenuStyle] = useState<CSSProperties | null>(null);

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

  useEffect(() => {
    if (!isOpen || !wrapperRef.current) {
      setMenuStyle(null);
      return;
    }
    const rect = wrapperRef.current.getBoundingClientRect();
    const spacing = 8;
    const maxMenuHeight = Math.min(400, window.innerHeight - 16);
    let top = rect.bottom + spacing;
    if (top + maxMenuHeight > window.innerHeight - spacing) {
      top = Math.max(spacing, rect.top - spacing - maxMenuHeight);
    }
    const left = rect.left;
    const width = rect.width;
    setMenuStyle({
      position: "fixed",
      top,
      left,
      width,
      zIndex: 60,
      maxHeight: `${maxMenuHeight}px`,
    });
  }, [isOpen]);

  if (compact) {
    return (
      <div className="relative">
        <button
          onClick={() => setIsOpen(!isOpen)}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg
                   bg-[var(--bg-card)] border border-[var(--border-subtle)] shadow-sm
                   hover:bg-[var(--system-gray-6)]
                   text-[13px] text-[var(--text-primary)] font-medium transition-all"
        >
          <TierIcon className={`w-3.5 h-3.5 ${TIER_COLORS[currentModel?.tier || "recommended"]}`} />
          <span className="max-w-[150px] truncate">{currentModel?.name || "Select model"}</span>
          <ChevronDown className={`w-3.5 h-3.5 text-[var(--text-tertiary)] transition-transform ${isOpen ? "rotate-180" : ""}`} />
        </button>

        {isOpen && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setIsOpen(false)} />
            <div className="absolute right-0 mt-2 w-72 max-h-96 overflow-y-auto z-50
                          bg-[var(--bg-card)] border border-[var(--border-subtle)]
                          rounded-xl shadow-2xl animate-scale-in">
              {Object.entries(groupedModels).map(([provider, providerModels]) => (
                <div key={provider}>
                  <div className="px-3 py-2 text-[11px] font-bold text-[var(--text-tertiary)]
                                border-b border-[var(--border-subtle)] bg-[var(--system-gray-6)]/50 uppercase tracking-wider">
                    {provider}
                  </div>
                  {providerModels.map(model => {
                    const Icon = TIER_ICONS[model.tier] || Star;
                    return (
                      <button
                        key={model.id}
                        onClick={() => handleModelChange(model.id)}
                        className={`w-full flex items-center gap-3 px-3 py-2.5
                                  hover:bg-[var(--system-gray-6)] transition-colors text-left
                                  ${model.id === selectedModel ? "bg-[var(--system-blue)]/10" : ""}`}
                      >
                        <Icon className={`w-4 h-4 ${TIER_COLORS[model.tier]}`} />
                        <div className="flex-1 min-w-0">
                          <div className="text-[13px] font-medium text-[var(--text-primary)] truncate">
                            {model.name}
                          </div>
                          <div className="text-[11px] text-[var(--text-tertiary)] truncate">
                            {model.tier}
                          </div>
                        </div>
                        {model.id === selectedModel && (
                          <div className="w-1.5 h-1.5 rounded-full bg-[var(--system-blue)]" />
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
    );
  }

  // Full version for settings page
  return (
    <div className="relative" ref={wrapperRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between gap-3 px-4 py-3
                 bg-[var(--bg-card)] hover:bg-[var(--system-gray-6)]
                 rounded-xl border border-[var(--border-subtle)] shadow-sm transition-all"
      >
        <div className="flex items-center gap-3">
          <TierIcon className={`w-5 h-5 ${TIER_COLORS[currentModel?.tier || "recommended"]}`} />
          <div className="text-left">
            <div className="text-[14px] font-semibold text-[var(--text-primary)]">
              {currentModel?.name || "Select model"}
            </div>
            <div className="text-[12px] text-[var(--text-secondary)]">
              {currentModel?.provider} · {currentModel?.tier}
            </div>
          </div>
        </div>
        <ChevronDown className={`w-5 h-5 text-[var(--text-tertiary)] transition-transform ${isOpen ? "rotate-180" : ""}`} />
      </button>

      {isOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setIsOpen(false)} />
          <div
            style={menuStyle ?? undefined}
            className="overflow-y-auto bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-xl shadow-2xl animate-scale-in"
          >
            {Object.entries(groupedModels).map(([provider, providerModels]) => (
              <div key={provider}>
                <div className="sticky top-0 px-4 py-2 text-[11px] font-bold text-[var(--text-tertiary)]
                              bg-[var(--system-gray-6)]/80 backdrop-blur-md border-b border-[var(--border-subtle)] uppercase tracking-wider">
                  {provider}
                </div>
                {providerModels.map(model => {
                  const Icon = TIER_ICONS[model.tier] || Star;
                  return (
                    <button
                      key={model.id}
                      onClick={() => handleModelChange(model.id)}
                      className={`w-full flex items-center gap-4 px-4 py-4
                                hover:bg-[var(--system-gray-6)] transition-colors
                                ${model.id === selectedModel ? "bg-[var(--system-blue)]/5" : ""}`}
                    >
                      <Icon className={`w-5 h-5 ${TIER_COLORS[model.tier]}`} />
                      <div className="flex-1 text-left min-w-0">
                        <div className="text-[14px] font-semibold text-[var(--text-primary)] truncate">
                          {model.name}
                        </div>
                        <div className="text-[12px] text-[var(--text-secondary)]">
                          {model.tier === "fast" && "Fast & affordable response"}
                          {model.tier === "recommended" && "Optimized for most tasks"}
                          {model.tier === "premium" && "Maximum intelligence & reasoning"}
                          {model.tier === "reasoning" && "Deep chain-of-thought processing"}
                        </div>
                      </div>
                      {model.id === selectedModel && (
                        <div className="w-2 h-2 rounded-full bg-[var(--system-blue)] shadow-[0_0_8px_rgba(0,122,255,0.4)]" />
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
  );
}
