import { useState, useEffect, useRef, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Zap, Star, Brain, Sparkles } from "lucide-react";
import { Model } from "../lib/auth";

// Proxy-mode models (routed through Entropic backend)
export const PROXY_MODELS: Model[] = [
  { id: "venice/kimi-k2-6", name: "Kimi K2.6 (Private)", provider: "Venice", tier: "premium" },
  { id: "venice/claude-opus-4-7", name: "Claude Opus 4.7 (Deanonymized)", provider: "Venice", tier: "premium" },
  { id: "venice/openai-gpt-55", name: "GPT-5.5 (Deanonymized)", provider: "Venice", tier: "premium" },
  { id: "venice/deepseek-v3.2", name: "DeepSeek V3.2 (Private)", provider: "Venice", tier: "reasoning" },
  { id: "venice/zai-org-glm-4.7-flash", name: "GLM 4.7 Flash (Private)", provider: "Venice", tier: "fast" },
  { id: "venice/venice-uncensored-1-2", name: "Venice Uncensored 1.2 (Private)", provider: "Venice", tier: "fast" },
  { id: "venice/openai-gpt-oss-120b", name: "GPT OSS 120B (Private)", provider: "Venice", tier: "fast" },
  { id: "openrouter/free", name: "OpenRouter Free (Router)", provider: "OpenRouter", tier: "fast", group: "OpenRouter" },
  { id: "moonshotai/kimi-k2.6", name: "Kimi K2.6", provider: "MoonshotAI", tier: "premium", group: "OpenRouter" },
  { id: "anthropic/claude-opus-4.7", name: "Claude Opus 4.7", provider: "Anthropic", tier: "premium", group: "OpenRouter" },
  { id: "anthropic/claude-opus-4-6", name: "Claude Opus 4.6", provider: "Anthropic", tier: "premium", group: "OpenRouter" },
  { id: "anthropic/claude-opus-4.5", name: "Claude Opus 4.5", provider: "Anthropic", tier: "premium", group: "OpenRouter" },
  { id: "openai/gpt-5.5", name: "GPT-5.5", provider: "OpenAI", tier: "recommended", group: "OpenRouter" },
  { id: "openai/gpt-5.4", name: "GPT-5.4", provider: "OpenAI", tier: "recommended", group: "OpenRouter" },
  { id: "openai/gpt-5.3-codex", name: "GPT-5.3 Codex", provider: "OpenAI", tier: "reasoning", group: "OpenRouter" },
  { id: "openai/gpt-5.2", name: "GPT-5.2", provider: "OpenAI", tier: "recommended", group: "OpenRouter" },
  { id: "openai/gpt-5.2-codex", name: "GPT-5.2 Codex", provider: "OpenAI", tier: "reasoning", group: "OpenRouter" },
  { id: "tencent/hy3-preview:free", name: "HY3 Preview (free)", provider: "Tencent", tier: "fast", group: "OpenRouter" },
  { id: "deepseek/deepseek-v3.2", name: "DeepSeek V3.2", provider: "DeepSeek", tier: "reasoning", group: "OpenRouter" },
  { id: "google/gemini-3.1-pro-preview", name: "Gemini 3.1 Pro Preview", provider: "Google", tier: "premium", group: "OpenRouter" },
  { id: "google/gemini-3.1-flash-image-preview", name: "Gemini 3.1 Flash Image Preview", provider: "Google", tier: "premium", group: "OpenRouter" },
  { id: "google/gemini-3-pro-image-preview", name: "Gemini 3 Pro Image (Nano Banana 3)", provider: "Google", tier: "premium", group: "OpenRouter" },
];

// Local-keys models (direct provider API access)
export const LOCAL_MODELS: Model[] = [
  // OpenRouter — local-key mode uses the user's OpenRouter key directly.
  { id: "openrouter/moonshotai/kimi-k2.6", name: "Kimi K2.6", provider: "OpenRouter", tier: "premium" },
  { id: "openrouter/anthropic/claude-opus-4.7", name: "Claude Opus 4.7", provider: "OpenRouter", tier: "premium" },
  { id: "openrouter/openai/gpt-5.5", name: "GPT-5.5", provider: "OpenRouter", tier: "recommended" },
  { id: "openrouter/tencent/hy3-preview:free", name: "HY3 Preview (free)", provider: "OpenRouter", tier: "fast" },
  { id: "openrouter/deepseek/deepseek-v3.2", name: "DeepSeek V3.2", provider: "OpenRouter", tier: "reasoning" },
  // Anthropic — thinking-enabled variants first
  { id: "anthropic/claude-opus-4.7:thinking", name: "Claude Opus 4.7 (Thinking)", provider: "Anthropic", tier: "premium" },
  { id: "anthropic/claude-opus-4.7", name: "Claude Opus 4.7", provider: "Anthropic", tier: "premium" },
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

export const PROXY_IMAGE_GENERATION_MODELS: Model[] = [
  {
    id: "google/gemini-3.1-flash-image-preview",
    name: "Gemini 3.1 Flash Image Preview",
    provider: "Google",
    tier: "recommended",
  },
  {
    id: "sourceful/riverflow-v2-pro",
    name: "Riverflow V2 Pro",
    provider: "Sourceful",
    tier: "premium",
  },
  {
    id: "sourceful/riverflow-v2-fast",
    name: "Riverflow V2 Fast",
    provider: "Sourceful",
    tier: "fast",
  },
  {
    id: "bytedance-seed/seedream-4.5",
    name: "Seedream 4.5",
    provider: "ByteDance Seed",
    tier: "premium",
  },
  {
    id: "black-forest-labs/flux.2-pro",
    name: "FLUX.2 Pro",
    provider: "Black Forest Labs",
    tier: "premium",
  },
];

export const LOCAL_IMAGE_GENERATION_MODELS: Model[] = [
  {
    id: "google/gemini-3.1-flash-image-preview",
    name: "Gemini 3.1 Flash Image Preview",
    provider: "Google",
    tier: "recommended",
  },
  {
    id: "google/gemini-3-pro-image-preview",
    name: "Gemini 3 Pro Image (Nano Banana 3)",
    provider: "Google",
    tier: "premium",
  },
  {
    id: "google/gemini-2.5-flash-image",
    name: "Gemini 2.5 Flash Image",
    provider: "Google",
    tier: "fast",
  },
  {
    id: "openai/gpt-image-1",
    name: "GPT Image 1",
    provider: "OpenAI",
    tier: "premium",
  },
];

export const PROXY_AUDIO_UNDERSTANDING_MODELS: Model[] = [
  {
    id: "venice/nvidia/parakeet-tdt-0.6b-v3",
    name: "Parakeet ASR (Private)",
    provider: "Venice",
    tier: "recommended",
  },
  {
    id: "venice/openai/whisper-large-v3",
    name: "Whisper Large V3 (Private)",
    provider: "Venice",
    tier: "premium",
  },
];

export const PROXY_TEXT_TO_SPEECH_MODELS: Model[] = [
  {
    id: "venice/tts-kokoro",
    name: "Kokoro TTS (Private)",
    provider: "Venice",
    tier: "recommended",
  },
];

export const LOCAL_AUDIO_UNDERSTANDING_MODELS: Model[] = [
  {
    id: "google/gemini-3-flash-preview",
    name: "Gemini 3 Flash Audio",
    provider: "Google",
    tier: "recommended",
  },
  {
    id: "openai/gpt-4o-transcribe",
    name: "GPT-4o Transcribe",
    provider: "OpenAI",
    tier: "premium",
  },
];

export const LOCAL_TEXT_TO_SPEECH_MODELS: Model[] = [
  {
    id: "openai/gpt-4o-mini-tts",
    name: "GPT-4o Mini TTS",
    provider: "OpenAI",
    tier: "premium",
  },
];

// Exported ID sets for mode-mismatch detection in Dashboard
export const PROXY_MODEL_IDS = new Set(PROXY_MODELS.map(m => m.id));
export const LOCAL_MODEL_IDS = new Set(LOCAL_MODELS.map(m => m.id));
export const PROXY_IMAGE_GENERATION_MODEL_IDS = new Set(
  PROXY_IMAGE_GENERATION_MODELS.map((m) => m.id),
);
export const LOCAL_IMAGE_GENERATION_MODEL_IDS = new Set(
  LOCAL_IMAGE_GENERATION_MODELS.map((m) => m.id),
);
export const PROXY_AUDIO_UNDERSTANDING_MODEL_IDS = new Set(
  PROXY_AUDIO_UNDERSTANDING_MODELS.map((m) => m.id),
);
export const LOCAL_AUDIO_UNDERSTANDING_MODEL_IDS = new Set(
  LOCAL_AUDIO_UNDERSTANDING_MODELS.map((m) => m.id),
);
export const PROXY_TEXT_TO_SPEECH_MODEL_IDS = new Set(
  PROXY_TEXT_TO_SPEECH_MODELS.map((m) => m.id),
);
export const LOCAL_TEXT_TO_SPEECH_MODEL_IDS = new Set(
  LOCAL_TEXT_TO_SPEECH_MODELS.map((m) => m.id),
);

// Map provider display names to auth provider IDs
const PROVIDER_AUTH_ID: Record<string, string> = {
  Anthropic: "anthropic",
  OpenAI: "openai",
  Google: "google",
  OpenRouter: "openrouter",
  Venice: "venice",
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

interface ModelSelectorProps {
  selectedModel: string;
  onModelChange: (modelId: string) => void;
  compact?: boolean;
  wide?: boolean;
  useLocalKeys?: boolean;
  models?: Model[];
  /** Provider IDs that have keys configured (e.g. ["anthropic", "openai"]). When set, only matching providers are shown. */
  connectedProviders?: string[];
}

export function ModelSelector({
  selectedModel,
  onModelChange,
  compact = false,
  wide = false,
  useLocalKeys = false,
  models,
  connectedProviders,
}: ModelSelectorProps) {
  const allModels = models ?? (useLocalKeys ? LOCAL_MODELS : PROXY_MODELS);
  // Filter to only show models from providers the user has connected
  const availableModels = connectedProviders && connectedProviders.length > 0
    ? allModels.filter(m => connectedProviders.includes(PROVIDER_AUTH_ID[m.provider] ?? m.provider.toLowerCase()))
    : allModels;
  const [isOpen, setIsOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [menuStyle, setMenuStyle] = useState<CSSProperties | null>(null);
  const [menuPlacement, setMenuPlacement] = useState<"top" | "bottom">("bottom");

  // Save model preference
  const handleModelChange = async (modelId: string) => {
    onModelChange(modelId);
    setIsOpen(false);
  };

  const currentModel = availableModels.find(m => m.id === selectedModel) || availableModels[0];
  const TierIcon = TIER_ICONS[currentModel?.tier || "recommended"] || Star;

  // Group models by provider
  const groupedModels = availableModels.reduce((acc, model) => {
    const group = model.group ?? model.provider;
    if (!acc[group]) {
      acc[group] = [];
    }
    acc[group].push(model);
    return acc;
  }, {} as Record<string, Model[]>);

  useEffect(() => {
    if (!isOpen || !wrapperRef.current) {
      setMenuStyle(null);
      return;
    }

    function updateMenuPosition() {
      const rect = wrapperRef.current?.getBoundingClientRect();
      if (!rect) return;

      const spacing = 10;
      const viewportPadding = 16;
      const availableBelow = window.innerHeight - rect.bottom - spacing - viewportPadding;
      const availableAbove = rect.top - spacing - viewportPadding;
      const placeAbove = availableBelow < 280 && availableAbove > availableBelow;
      const maxMenuHeight = Math.max(
        220,
        Math.min(540, placeAbove ? availableAbove : availableBelow, window.innerHeight - viewportPadding * 2),
      );
      const desiredWidth = Math.max(rect.width, wide ? 420 : 340);
      const menuWidth = Math.min(desiredWidth, window.innerWidth - viewportPadding * 2);
      const left = clamp(
        rect.left,
        viewportPadding,
        window.innerWidth - viewportPadding - menuWidth,
      );
      const top = placeAbove
        ? Math.max(viewportPadding, rect.top - spacing - maxMenuHeight)
        : Math.min(rect.bottom + spacing, window.innerHeight - viewportPadding - maxMenuHeight);

      setMenuPlacement(placeAbove ? "top" : "bottom");
      setMenuStyle({
        position: "fixed",
        top,
        left,
        width: menuWidth,
        zIndex: 2_147_483_000,
        maxHeight: `${maxMenuHeight}px`,
        transformOrigin: placeAbove ? "bottom left" : "top left",
      });
    }

    updateMenuPosition();
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsOpen(false);
      }
    }
    window.addEventListener("resize", updateMenuPosition);
    window.addEventListener("scroll", updateMenuPosition, true);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("resize", updateMenuPosition);
      window.removeEventListener("scroll", updateMenuPosition, true);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, wide]);

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
            <div className="absolute right-0 mt-2 w-80 max-h-96 overflow-y-auto z-50
                          bg-[var(--bg-card)] border border-[var(--border-default)]
                          rounded-xl shadow-2xl animate-scale-in ring-1 ring-black/5">
              {Object.entries(groupedModels).map(([provider, providerModels]) => (
                <div key={provider}>
                  <div className="px-3 py-2 text-[11px] font-bold text-[var(--text-tertiary)]
                                border-b border-[var(--border-subtle)] bg-[var(--bg-secondary)]/95 uppercase tracking-wider">
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
  const fullMenu =
    isOpen && menuStyle && typeof document !== "undefined"
      ? createPortal(
          <>
            <div
              className="fixed inset-0"
              style={{ zIndex: 2_147_482_999 }}
              onClick={() => setIsOpen(false)}
            />
            <div
              style={menuStyle}
              className={`overflow-hidden rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] shadow-[0_24px_80px_rgba(0,0,0,0.42)] ring-1 ring-black/10 animate-scale-in ${
                menuPlacement === "top" ? "origin-bottom-left" : "origin-top-left"
              }`}
            >
              <div className="max-h-[inherit] overflow-y-auto">
                {Object.entries(groupedModels).map(([provider, providerModels]) => (
                  <div key={provider}>
                    <div className="sticky top-0 z-10 border-b border-[var(--border-subtle)] bg-[var(--bg-secondary)] px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-[var(--text-tertiary)]">
                      {provider}
                    </div>
                    {providerModels.map((model) => {
                      const Icon = TIER_ICONS[model.tier] || Star;
                      return (
                        <button
                          key={model.id}
                          onClick={() => handleModelChange(model.id)}
                          className={`flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-[var(--system-gray-6)] ${
                            model.id === selectedModel ? "bg-[var(--system-blue)]/10" : ""
                          }`}
                        >
                          <Icon className={`h-4 w-4 shrink-0 ${TIER_COLORS[model.tier]}`} />
                          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--text-primary)]">
                            {model.name}
                          </span>
                          {model.id === selectedModel && (
                            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--system-blue)]" />
                          )}
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
          </>,
          document.body,
        )
      : null;

  return (
    <div className={wide ? "relative w-full" : "relative"} ref={wrapperRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={`flex h-10 w-full items-center justify-between gap-2 rounded-lg border px-3 text-left shadow-sm transition-all focus:outline-none focus:ring-2 focus:ring-[var(--system-blue)]/20 ${
          isOpen
            ? "border-[var(--system-blue)] bg-[var(--bg-card)]"
            : "border-[var(--border-subtle)] bg-[var(--bg-card)] hover:bg-[var(--system-gray-6)]"
        }`}
      >
        <div className="flex min-w-0 items-center gap-2">
          <TierIcon className={`h-3.5 w-3.5 shrink-0 ${TIER_COLORS[currentModel?.tier || "recommended"]}`} />
          <span className="truncate text-[13px] font-medium text-[var(--text-primary)]">
            {currentModel?.name || "Select model"}
          </span>
        </div>
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-[var(--text-tertiary)] transition-transform ${isOpen ? "rotate-180" : ""}`} />
      </button>
      {fullMenu}
    </div>
  );
}
