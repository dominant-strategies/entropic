import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ChevronDown,
  Cpu,
  Download,
  Flame,
  Loader2,
  RefreshCw,
  Square,
  Trash2,
} from "lucide-react";
import clsx from "clsx";
import { DEFAULT_LOCAL_MODEL_API_KEY, type LocalModelConfig } from "../lib/auth";

type Props = {
  config: LocalModelConfig;
  onChange: (config: LocalModelConfig) => void | Promise<void>;
  onCatalogChange?: () => void;
  onModelActivated?: (modelName: string) => void | Promise<void>;
};

type RnnCatalogEntry = {
  id: string;
  name: string;
  display_name?: string;
  hf_repo?: string;
  architecture?: string;
  backend?: string;
  params?: string;
  size_gb?: number;
  context?: number;
  description?: string;
  thinking?: boolean;
  downloaded?: boolean;
  loaded?: boolean;
};

type RnnLocalEntry = {
  name: string;
  filename: string;
  path: string;
  size_gb?: number;
  architecture?: string;
  backend?: string;
  display_name?: string;
  catalog_id?: string | null;
  description?: string;
  thinking?: boolean;
  loaded?: boolean;
};

type RnnCatalogSnapshot = {
  catalog: RnnCatalogEntry[];
  local: RnnLocalEntry[];
  loadedModel?: string | null;
  lastError?: string | null;
  downloadState?: {
    status?: "downloading" | "downloaded" | "error";
    catalogId?: string;
    modelName?: string;
    downloadedBytes?: number;
    totalBytes?: number | null;
    progressPercent?: number | null;
    elapsedS?: number | null;
    error?: string | null;
  } | null;
};

type RnnDownloadState = NonNullable<RnnCatalogSnapshot["downloadState"]>;

type RnnRuntimeStatus = {
  running: boolean;
  baseUrl: string;
  loadedModel?: string | null;
  lastError?: string | null;
  pid?: number | null;
  modelsDir: string;
  stateDir: string;
  logFile: string;
  scriptPath?: string | null;
  pythonCommand?: string | null;
  runtimeName?: string | null;
  activeBackend?: string | null;
  activeArchitecture?: string | null;
  activeModelInfo?: Record<string, unknown> | null;
  capabilities?: {
    torchAvailable?: boolean;
    torchVersion?: string | null;
    cudaAvailable?: boolean;
    cudaDeviceCount?: number;
    cudaDeviceName?: string | null;
    mpsAvailable?: boolean;
    nvccPath?: string | null;
    albatrossSourceBundled?: boolean;
    currentProcessCudaAllocatedMiB?: number;
    currentProcessCudaReservedMiB?: number;
    processGpuMemoryMiB?: number;
    gpuMemoryTotalMiB?: number;
    gpuMemoryUtilizationPercent?: number;
    gpuMemoryName?: string | null;
    gpuMemorySource?: string | null;
    hostMemoryTotalBytes?: number;
    hostMemoryAvailableBytes?: number;
    hostMemorySource?: string | null;
    preferredDevice?: string | null;
    supportedBackends?: string[];
    backendAvailability?: Record<string, boolean>;
  } | null;
  runtimeConfig?: {
    vllm?: VllmRuntimeConfig;
    llamaCpp?: LlamaCppRuntimeConfig;
  } | null;
};

type BusyAction = {
  kind:
    | "refresh"
    | "download"
    | "load"
    | "warm"
    | "delete"
    | "unload"
    | "install-backend"
    | "save-config";
  target?: string;
} | null;

type VllmRuntimeConfig = {
  gpuMemoryUtilization: number;
  kvCacheDtype: string;
  calculateKvScales: boolean;
  cpuOffloadGb: number;
  swapSpace: number;
  maxModelLen?: number | null;
  enablePrefixCaching: boolean;
  enforceEager: boolean;
};

type LlamaCppRuntimeConfig = {
  nGpuLayers: number;
  nCtx: number;
  nBatch: number;
  nThreads?: number | null;
  flashAttn: boolean;
  useMmap: boolean;
  useMlock: boolean;
};

type HardwareAssessmentEntry = Pick<RnnCatalogEntry, "backend" | "size_gb"> & {
  context?: number | null;
};

type RuntimeMemorySample = {
  ts: number;
  model: string;
  backend: string | null;
  source: string;
  usedMiB: number;
  totalMiB?: number | null;
};

type RecommendationSlot = "overall" | "tools" | "low-vram";

type RecommendationProfile = {
  toolScore: number;
  speedScore: number;
  lowVramScore: number;
  overallBonus?: number;
  strengths: string[];
  bestFor?: string;
  caution?: string;
};

type HardwareFit = {
  label: string;
  tone: "good" | "warn" | "bad" | "neutral";
  estimatedVramGb: number | null;
  availableVramGb: number | null;
  estimatedHostMemoryGb: number | null;
  availableHostMemoryGb: number | null;
  loadBlocked: boolean;
  loadBlockReason: string | null;
};

type RecommendedModel = {
  slot: RecommendationSlot;
  entry: RnnCatalogEntry;
  score: number;
  fit: HardwareFit;
  profile: RecommendationProfile;
  backendReady: boolean;
};

const MANAGED_RUNTIME_MEMORY_HISTORY_KEY = "entropic.managed-runtime.memory-history";
const MAX_MANAGED_RUNTIME_MEMORY_SAMPLES = 90;
const RECOMMENDATION_LABELS: Record<RecommendationSlot, string> = {
  overall: "Best Overall",
  tools: "Best For Tools",
  "low-vram": "Best Low-VRAM",
};
const RECOMMENDATION_PROFILES: Record<string, RecommendationProfile> = {
  "qwen3-8b-q4-k-m": {
    toolScore: 9.6,
    speedScore: 7.1,
    lowVramScore: 5.4,
    overallBonus: 1.5,
    strengths: ["tools", "coding", "chat"],
    bestFor: "Balanced local default on 8-12 GB GPUs.",
  },
  "qwen3-4b-q4-k-m": {
    toolScore: 9.0,
    speedScore: 8.4,
    lowVramScore: 8.5,
    overallBonus: 0.2,
    strengths: ["tools", "multilingual", "small GPU"],
    bestFor: "Compact Qwen option when you have enough RAM for the configured GGUF context.",
  },
  "phi4-mini-instruct-q4-k-m": {
    toolScore: 9.1,
    speedScore: 8.0,
    lowVramScore: 8.7,
    overallBonus: 1.0,
    strengths: ["tools", "reasoning", "coding"],
    bestFor: "Great compact tool and reasoning option.",
  },
  "llama32-3b-instruct-q4-k-m": {
    toolScore: 7.5,
    speedScore: 9.0,
    lowVramScore: 9.5,
    overallBonus: 0.2,
    strengths: ["safe default", "fast chat", "4 GB class"],
    bestFor: "Smallest broadly useful starter model in the list.",
  },
  "nemotron3-nano-4b-q4-k-m": {
    toolScore: 8.2,
    speedScore: 8.6,
    lowVramScore: 9.0,
    overallBonus: 1.6,
    strengths: ["current info", "browser-heavy", "small GPU"],
    bestFor: "Compact hybrid default for browsing, current-info, and small-laptop workflows.",
    caution: "Still lighter on tool precision than Phi-4 Mini.",
  },
  "rwkv7-world-2.9b": {
    toolScore: 4.3,
    speedScore: 7.9,
    lowVramScore: 6.4,
    overallBonus: -0.5,
    strengths: ["RWKV", "multilingual", "steady decode"],
    bestFor: "Recurrent local-chat experiment when VRAM is tight.",
    caution: "Good experiment path, but not a first-choice tool model for OpenClaw.",
  },
  "rwkv7-g1-2.9b": {
    toolScore: 4.0,
    speedScore: 7.4,
    lowVramScore: 6.2,
    strengths: ["RWKV", "thinking", "local runtime"],
    bestFor: "Reasoning-oriented RWKV experiment when you want Albatross.",
    caution: "Still behind the best small transformers for reliable tools.",
  },
  "rwkv6-world-1.6b": {
    toolScore: 3.2,
    speedScore: 6.8,
    lowVramScore: 5.8,
    strengths: ["legacy RWKV", "small footprint", "baseline"],
    bestFor: "Legacy RWKV baseline if you specifically want Finch compatibility.",
    caution: "Fits small GPUs, but RWKV-7 is a better default and Finch is not a first recommendation for tools.",
  },
  "rwkv7-g1e-7.2b-q4-k-m-gguf": {
    toolScore: 4.1,
    speedScore: 6.7,
    lowVramScore: 5.7,
    strengths: ["RWKV", "GGUF", "experiments"],
    bestFor: "Larger GGUF RWKV experiment on 8-12 GB GPUs.",
    caution: "Experiment-first relative to Qwen, Phi, Llama, and Nemotron.",
  },
  "rwkv7-g1e-13.3b-q4-k-m": {
    toolScore: 3.8,
    speedScore: 5.4,
    lowVramScore: 2.9,
    strengths: ["RWKV", "large context experiments"],
    bestFor: "Large local RWKV experiment when 12 GB VRAM is available.",
    caution: "Tight fit on 12 GB cards and not a first recommendation.",
  },
  "mamba-1.4b": {
    toolScore: 4.6,
    speedScore: 7.0,
    lowVramScore: 6.8,
    strengths: ["SSM", "research", "vLLM"],
    caution: "Interesting, but not a first-choice tool model.",
  },
  "mamba-2.8b": {
    toolScore: 4.8,
    speedScore: 6.3,
    lowVramScore: 5.1,
    strengths: ["SSM", "research", "vLLM"],
    caution: "Research-oriented relative to Qwen/Phi.",
  },
  "xlstm-7b": {
    toolScore: 3.6,
    speedScore: 4.5,
    lowVramScore: 2.6,
    strengths: ["xLSTM", "research"],
    caution: "Experimental compared with the stronger local defaults.",
  },
  "stripedhyena-nous-7b": {
    toolScore: 4.2,
    speedScore: 5.2,
    lowVramScore: 2.9,
    strengths: ["hyena", "research"],
    caution: "Research-oriented relative to the main shortlist.",
  },
};

function formatSize(sizeGb?: number): string | null {
  if (typeof sizeGb !== "number" || Number.isNaN(sizeGb) || sizeGb <= 0) {
    return null;
  }
  return `${sizeGb.toFixed(sizeGb >= 10 ? 0 : 1)} GB`;
}

function formatBytes(bytes?: number | null): string | null {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) {
    return null;
  }
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(bytes >= 10 * 1024 ** 3 ? 0 : 1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(bytes >= 100 * 1024 ** 2 ? 0 : 1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

function downloadProgressPercent(state?: RnnCatalogSnapshot["downloadState"] | null): number | null {
  if (typeof state?.progressPercent === "number" && Number.isFinite(state.progressPercent)) {
    return Math.max(0, Math.min(100, state.progressPercent));
  }
  if (
    typeof state?.downloadedBytes === "number" &&
    Number.isFinite(state.downloadedBytes) &&
    typeof state?.totalBytes === "number" &&
    Number.isFinite(state.totalBytes) &&
    state.totalBytes > 0
  ) {
    return Math.max(0, Math.min(100, (state.downloadedBytes / state.totalBytes) * 100));
  }
  return null;
}

function downloadProgressSummary(state?: RnnCatalogSnapshot["downloadState"] | null): string {
  const percent = downloadProgressPercent(state);
  if (percent !== null) {
    return `${percent.toFixed(percent >= 10 ? 0 : 1)}%`;
  }
  const downloaded = formatBytes(state?.downloadedBytes);
  if (downloaded) {
    return `${downloaded} downloaded`;
  }
  return "Preparing";
}

function downloadProgressDetail(state?: RnnCatalogSnapshot["downloadState"] | null): string | null {
  const downloaded = formatBytes(state?.downloadedBytes);
  const total = formatBytes(state?.totalBytes);
  if (downloaded && total) {
    return `${downloaded} of ${total}`;
  }
  if (total) {
    return total;
  }
  return null;
}

function downloadProgressBarWidth(state?: RnnCatalogSnapshot["downloadState"] | null): string {
  const percent = downloadProgressPercent(state);
  if (percent === null) {
    return "18%";
  }
  return `${Math.max(6, Math.min(100, percent))}%`;
}

function formatMemory(valueMiB?: number | null): string | null {
  if (typeof valueMiB !== "number" || !Number.isFinite(valueMiB) || valueMiB < 0) {
    return null;
  }
  if (valueMiB >= 1024) {
    const valueGiB = valueMiB / 1024;
    return `${valueGiB.toFixed(valueGiB >= 10 ? 0 : 1)} GiB`;
  }
  return `${valueMiB.toFixed(0)} MiB`;
}

function canUseWindowStorage(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function normalizeRuntimeMemorySample(value: unknown): RuntimeMemorySample | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const ts = typeof item.ts === "number" ? item.ts : 0;
  const model = typeof item.model === "string" ? item.model : "";
  const backend =
    typeof item.backend === "string" && item.backend.trim().length > 0 ? item.backend : null;
  const source = typeof item.source === "string" ? item.source : "";
  const usedMiB = typeof item.usedMiB === "number" ? item.usedMiB : NaN;
  const totalMiB =
    typeof item.totalMiB === "number" && Number.isFinite(item.totalMiB) ? item.totalMiB : null;
  if (!ts || !model || !source || !Number.isFinite(usedMiB) || usedMiB < 0) {
    return null;
  }
  return { ts, model, backend, source, usedMiB, totalMiB };
}

function readManagedRuntimeMemoryHistory(): RuntimeMemorySample[] {
  if (!canUseWindowStorage()) return [];
  try {
    const raw = window.localStorage.getItem(MANAGED_RUNTIME_MEMORY_HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(normalizeRuntimeMemorySample)
      .filter((sample): sample is RuntimeMemorySample => Boolean(sample))
      .sort((left, right) => left.ts - right.ts)
      .slice(-MAX_MANAGED_RUNTIME_MEMORY_SAMPLES);
  } catch {
    return [];
  }
}

function writeManagedRuntimeMemoryHistory(samples: RuntimeMemorySample[]) {
  if (!canUseWindowStorage()) return;
  try {
    window.localStorage.setItem(
      MANAGED_RUNTIME_MEMORY_HISTORY_KEY,
      JSON.stringify(samples.slice(-MAX_MANAGED_RUNTIME_MEMORY_SAMPLES)),
    );
  } catch {
    // Ignore localStorage write errors.
  }
}

function trimApiKey(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed === DEFAULT_LOCAL_MODEL_API_KEY) {
    return null;
  }
  return trimmed;
}

function isGgufBackend(value?: string | null): boolean {
  const normalized = (value || "").trim().toLowerCase();
  return normalized === "llama-cpp" || normalized === "prism-llama";
}

function formatBackend(value?: string | null): string | null {
  const normalized = (value || "").trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "rwkv") return "RWKV";
  if (normalized === "mamba") return "Mamba";
  if (normalized === "huggingface") return "Hugging Face";
  if (normalized === "albatross") return "Albatross";
  if (normalized === "llama-cpp") return "llama.cpp";
  if (normalized === "prism-llama") return "Prism llama.cpp";
  return normalized.toUpperCase();
}

function backendInstallActionLabel(value?: string | null): string {
  const formatted = formatBackend(value);
  return formatted ? `Install ${formatted}` : "Install backend";
}

function backendAutoInstallsOnFirstUse(value?: string | null): boolean {
  return isGgufBackend(value);
}

function backendLoadRequirementLabel(value?: string | null): string | null {
  const formatted = formatBackend(value);
  if (!formatted) return null;
  if (backendAutoInstallsOnFirstUse(value)) {
    return `${formatted} installs automatically on first use`;
  }
  return `Needs ${formatted} before load`;
}

function backendMissingBadgeLabel(value?: string | null): string {
  return backendAutoInstallsOnFirstUse(value) ? "Auto-installs on first use" : "Install backend first";
}

function pendingDownloadLabel(
  backend?: string | null,
  backendReady?: boolean,
): string {
  if (!backendReady && backendAutoInstallsOnFirstUse(backend)) {
    return `Installing ${formatBackend(backend) || "backend"}`;
  }
  return "Preparing download";
}

function formatArchitecture(value?: string | null): string | null {
  const normalized = (value || "").trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "rwkv") return "RWKV";
  if (normalized === "mamba") return "Mamba";
  if (normalized === "hyena") return "Hyena";
  if (normalized === "xlstm") return "xLSTM";
  if (normalized === "hf") return "HF";
  if (normalized === "gguf") return "GGUF";
  return normalized.toUpperCase();
}

function formatProvider(value?: string | null): string | null {
  const repo = (value || "").trim();
  if (!repo) return null;
  const owner = repo.split("/")[0]?.trim();
  if (!owner) return null;
  const normalized = owner.toLowerCase();
  if (normalized === "blinkdl") return "BlinkDL";
  if (normalized === "nvidia") return "NVIDIA";
  if (normalized === "qwen") return "Qwen";
  if (normalized === "microsoft") return "Microsoft";
  if (normalized === "gpustack") return "GPUStack";
  if (normalized === "triangle104") return "Triangle104";
  if (normalized === "google") return "Google";
  if (normalized === "meta-llama") return "Meta";
  if (normalized === "deepseek-ai") return "DeepSeek";
  if (normalized === "state-spaces") return "state-spaces";
  if (normalized === "shoumenchougou") return "shoumenchougou";
  if (normalized === "prism-ml") return "Prism ML";
  return owner;
}

function catalogFamily(entry: Pick<RnnCatalogEntry, "name" | "display_name" | "architecture">): string {
  const haystack = `${entry.display_name || ""} ${entry.name || ""}`.trim().toLowerCase();
  const architecture = (entry.architecture || "").trim().toLowerCase();
  if (haystack.includes("goose")) return "Goose";
  if (haystack.includes("bonsai")) return "Bonsai";
  if (haystack.includes("nemotron")) return "Nemotron";
  if (haystack.includes("qwen")) return "Qwen";
  if (haystack.includes("phi")) return "Phi";
  if (haystack.includes("llama")) return "Llama";
  if (haystack.includes("gemma")) return "Gemma";
  if (haystack.includes("finch")) return "Finch";
  if (haystack.includes("mamba") || architecture === "mamba") return "Mamba";
  if (haystack.includes("xlstm") || architecture === "xlstm") return "xLSTM";
  if (haystack.includes("hyena") || architecture === "hyena") return "Hyena";
  if (haystack.includes("rwkv") || architecture === "rwkv") return "RWKV";
  if (architecture === "gguf") return "GGUF";
  return "Other";
}

function catalogSeries(entry: Pick<RnnCatalogEntry, "name" | "display_name" | "architecture">): string {
  const haystack = `${entry.display_name || ""} ${entry.name || ""}`.trim().toLowerCase();
  const architecture = (entry.architecture || "").trim().toLowerCase();
  if (haystack.includes("gooseone")) return "GooseOne";
  if (haystack.includes("goose world")) return "Goose World";
  if (haystack.includes("bonsai")) return "Bonsai";
  if (haystack.includes("nemotron 3")) return "Nemotron 3";
  if (haystack.includes("qwen3")) return "Qwen3";
  if (haystack.includes("phi-4")) return "Phi-4";
  if (haystack.includes("llama 3.2")) return "Llama 3.2";
  if (haystack.includes("gemma 3")) return "Gemma 3";
  if (haystack.includes("finch")) return "Finch";
  if (haystack.includes("mamba") || architecture === "mamba") return "Mamba";
  if (haystack.includes("xlstm") || architecture === "xlstm") return "xLSTM";
  if (haystack.includes("hyena") || architecture === "hyena") return "Hyena";
  if (haystack.includes("rwkv") || architecture === "rwkv") return "RWKV";
  return entry.display_name || entry.name || "Other";
}

function catalogCategory(entry: Pick<RnnCatalogEntry, "architecture" | "name">): string {
  const architecture = (entry.architecture || "").trim().toLowerCase();
  const loweredName = (entry.name || "").trim().toLowerCase();
  if (architecture === "rwkv" || loweredName.includes("rwkv")) return "RWKV";
  if (architecture === "gguf") return "GGUF";
  if (architecture === "mamba") return "Mamba";
  if (architecture === "xlstm") return "xLSTM";
  if (architecture === "hyena") return "Hyena";
  return "Other";
}

function catalogMode(entry: Pick<RnnCatalogEntry, "thinking">): string {
  return entry.thinking ? "Thinking" : "Standard";
}

function formatCatalogName(entry: Pick<RnnCatalogEntry, "display_name" | "name">): string {
  return entry.display_name || entry.name;
}

function formatContext(value?: number | null): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return `${Math.round(value).toLocaleString()} ctx`;
}

function resolvedContextWindow(
  entry: HardwareAssessmentEntry,
  runtimeConfig?: RnnRuntimeStatus["runtimeConfig"] | null,
): number {
  const backend = (entry.backend || "").trim().toLowerCase();
  const modelContext =
    typeof entry.context === "number" && Number.isFinite(entry.context) && entry.context > 0
      ? entry.context
      : isGgufBackend(backend)
        ? 32768
        : 8192;
  if (!isGgufBackend(backend)) {
    return modelContext;
  }
  const configuredContext = runtimeConfig?.llamaCpp?.nCtx;
  if (typeof configuredContext === "number" && Number.isFinite(configuredContext) && configuredContext > 0) {
    return Math.max(512, Math.min(configuredContext, modelContext));
  }
  return modelContext;
}

function contextOverheadGb(context: number): number {
  if (context >= 65536) return 2.2;
  if (context >= 32768) return 1.4;
  if (context >= 16384) return 1.0;
  if (context >= 8192) return 0.8;
  return 0.5;
}

function estimateRuntimeFootprintGb(
  entry: HardwareAssessmentEntry,
  runtimeConfig?: RnnRuntimeStatus["runtimeConfig"] | null,
): number | null {
  const sizeGb = typeof entry.size_gb === "number" && entry.size_gb > 0 ? entry.size_gb : null;
  if (!sizeGb) return null;
  const backend = (entry.backend || "").trim().toLowerCase();
  const context = resolvedContextWindow(entry, runtimeConfig);
  const contextMemoryGb = contextOverheadGb(context);
  if (isGgufBackend(backend)) return Number((sizeGb * 1.22 + contextMemoryGb).toFixed(2));
  if (backend === "albatross") return Number((sizeGb * 1.08 + 0.35).toFixed(2));
  if (backend === "vllm") return Number((sizeGb * 1.55 + 1.75).toFixed(2));
  if (backend === "huggingface") return Number((sizeGb * 1.45 + 1.5).toFixed(2));
  return Number((sizeGb * 1.3 + 0.75).toFixed(2));
}

function estimateHostMemoryRequirementGb(
  entry: HardwareAssessmentEntry,
  preferredDevice?: string | null,
  runtimeConfig?: RnnRuntimeStatus["runtimeConfig"] | null,
): number | null {
  const base = estimateRuntimeFootprintGb(entry, runtimeConfig);
  if (!base) return null;
  const device = (preferredDevice || "").trim().toLowerCase();
  if (device === "cuda") {
    return Number((base * 0.72 + 0.6).toFixed(2));
  }
  if (device === "mps") {
    return Number((base * 1.4 + 0.8).toFixed(2));
  }
  return Number((base * 1.46 + 0.9).toFixed(2));
}

function defaultRecommendationProfile(entry: RnnCatalogEntry): RecommendationProfile {
  const family = catalogFamily(entry);
  const backend = (entry.backend || "").trim().toLowerCase();
  const architecture = (entry.architecture || "").trim().toLowerCase();
  let toolScore = 5.2;
  let speedScore = 5.8;
  let lowVramScore = 5.2;
  const strengths = [catalogCategory(entry)];
  let caution: string | undefined;

  if (isGgufBackend(backend)) {
    toolScore += 1.2;
    speedScore += 0.8;
    lowVramScore += 1.4;
  }
  if (backend === "albatross" || architecture === "rwkv") {
    speedScore += 1.5;
    lowVramScore += 1.3;
    toolScore -= 0.8;
    strengths.push("steady decode");
  }
  if (entry.thinking) {
    speedScore -= 0.4;
    strengths.push("thinking");
  }
  if (family === "Mamba" || family === "xLSTM" || family === "Hyena") {
    toolScore -= 1.0;
    caution = "Research-oriented relative to the stronger local defaults.";
  }
  return {
    toolScore,
    speedScore,
    lowVramScore,
    strengths,
    caution,
  };
}

function recommendationProfileForEntry(entry: RnnCatalogEntry): RecommendationProfile {
  const fallback = defaultRecommendationProfile(entry);
  const curated = RECOMMENDATION_PROFILES[entry.id];
  if (!curated) return fallback;
  return {
    ...fallback,
    ...curated,
    strengths: curated.strengths.length ? curated.strengths : fallback.strengths,
  };
}

function backendReadyForEntry(
  entry: Pick<RnnCatalogEntry, "backend">,
  runtimeStatus: RnnRuntimeStatus | null,
): boolean {
  const backend = (entry.backend || "").trim().toLowerCase();
  if (!backend || !runtimeStatus?.capabilities) return true;
  if (backend === "albatross") {
    const explicit = runtimeStatus.capabilities.backendAvailability?.albatross;
    if (typeof explicit === "boolean") return explicit;
    return runtimeStatus.capabilities.albatrossSourceBundled === true;
  }
  const availability = runtimeStatus.capabilities.backendAvailability?.[backend];
  return availability !== false;
}

function hardwareFitForEntry(
  entry: HardwareAssessmentEntry,
  gpuMemoryTotalMiB?: number | null,
  preferredDevice?: string | null,
  hostMemoryTotalBytes?: number | null,
  runtimeConfig?: RnnRuntimeStatus["runtimeConfig"] | null,
): HardwareFit {
  const estimatedVramGb = estimateRuntimeFootprintGb(entry, runtimeConfig);
  const estimatedHostMemoryGb = estimateHostMemoryRequirementGb(entry, preferredDevice, runtimeConfig);
  const availableVramGb =
    typeof gpuMemoryTotalMiB === "number" && gpuMemoryTotalMiB > 0 ? gpuMemoryTotalMiB / 1024 : null;
  const availableHostMemoryGb =
    typeof hostMemoryTotalBytes === "number" && hostMemoryTotalBytes > 0
      ? hostMemoryTotalBytes / 1024 ** 3
      : null;
  const backend = (entry.backend || "").trim().toLowerCase();
  const contextLabel = isGgufBackend(backend)
    ? formatContext(resolvedContextWindow(entry, runtimeConfig))
    : null;
  const gpuHeadroomGb =
    estimatedVramGb !== null && availableVramGb !== null ? availableVramGb - estimatedVramGb : null;
  const hostHeadroomGb =
    estimatedHostMemoryGb !== null && availableHostMemoryGb !== null
      ? availableHostMemoryGb - estimatedHostMemoryGb
      : null;

  if (
    preferredDevice === "cuda" &&
    availableVramGb !== null &&
    estimatedVramGb !== null &&
    (estimatedVramGb > availableVramGb * 0.96 || (gpuHeadroomGb !== null && gpuHeadroomGb < 0.4))
  ) {
    return {
      label: "Unsafe on this GPU",
      tone: "bad",
      estimatedVramGb,
      availableVramGb,
      estimatedHostMemoryGb,
      availableHostMemoryGb,
      loadBlocked: true,
      loadBlockReason: `${
        contextLabel
          ? `At ${contextLabel}, this model is estimated to use `
          : "This model is estimated to use "
      }${estimatedVramGb.toFixed(1)} GB of GPU memory, but the detected GPU reports ${availableVramGb.toFixed(1)} GB total. Reduce GGUF context or choose a smaller model.`,
    };
  }

  if (
    availableHostMemoryGb !== null &&
    estimatedHostMemoryGb !== null &&
    (estimatedHostMemoryGb > availableHostMemoryGb * 0.96 || (hostHeadroomGb !== null && hostHeadroomGb < 0.4))
  ) {
    return {
      label: "Unsafe on this RAM",
      tone: "bad",
      estimatedVramGb,
      availableVramGb,
      estimatedHostMemoryGb,
      availableHostMemoryGb,
      loadBlocked: true,
      loadBlockReason: `${
        contextLabel
          ? `At ${contextLabel}, this model is estimated to use `
          : "This model is estimated to use "
      }${estimatedHostMemoryGb.toFixed(1)} GB of system memory, but this machine reports ${availableHostMemoryGb.toFixed(1)} GB total. Lower GGUF context or choose a smaller model.`,
    };
  }

  if (preferredDevice === "cuda" && availableVramGb !== null && estimatedVramGb !== null) {
    if (estimatedVramGb <= availableVramGb * 0.72) {
      return {
        label: "Fits GPU memory",
        tone: "good",
        estimatedVramGb,
        availableVramGb,
        estimatedHostMemoryGb,
        availableHostMemoryGb,
        loadBlocked: false,
        loadBlockReason: null,
      };
    }
    return {
      label: "Tight on this GPU",
      tone: "warn",
      estimatedVramGb,
      availableVramGb,
      estimatedHostMemoryGb,
      availableHostMemoryGb,
      loadBlocked: false,
      loadBlockReason: null,
    };
  }

  if (availableHostMemoryGb !== null && estimatedHostMemoryGb !== null) {
    if (estimatedHostMemoryGb <= availableHostMemoryGb * 0.7 && (hostHeadroomGb ?? 0) >= 2) {
      return {
        label: "Fits system RAM",
        tone: "good",
        estimatedVramGb,
        availableVramGb,
        estimatedHostMemoryGb,
        availableHostMemoryGb,
        loadBlocked: false,
        loadBlockReason: null,
      };
    }
    if (estimatedHostMemoryGb > availableHostMemoryGb * 0.85 || (hostHeadroomGb ?? Infinity) < 1.25) {
      return {
        label: "Tight on system RAM",
        tone: "warn",
        estimatedVramGb,
        availableVramGb,
        estimatedHostMemoryGb,
        availableHostMemoryGb,
        loadBlocked: false,
        loadBlockReason: null,
      };
    }
    return {
      label: "Tight on system RAM",
      tone: "warn",
      estimatedVramGb,
      availableVramGb,
      estimatedHostMemoryGb,
      availableHostMemoryGb,
      loadBlocked: false,
      loadBlockReason: null,
    };
  }

  return {
    label:
      estimatedHostMemoryGb !== null
        ? `Est. ${estimatedHostMemoryGb.toFixed(1)} GB RAM`
        : estimatedVramGb !== null
          ? `Est. ${estimatedVramGb.toFixed(1)} GB`
          : "Hardware unknown",
    tone: "neutral",
    estimatedVramGb,
    availableVramGb,
    estimatedHostMemoryGb,
    availableHostMemoryGb,
    loadBlocked: false,
    loadBlockReason: null,
  };
}

function hardwareFitBadgeClass(tone: HardwareFit["tone"]): string {
  if (tone === "good") {
    return "border-emerald-500/25 bg-emerald-500/10 text-emerald-600";
  }
  if (tone === "warn") {
    return "border-amber-500/25 bg-amber-500/10 text-amber-600";
  }
  if (tone === "bad") {
    return "border-red-500/25 bg-red-500/10 text-red-600";
  }
  return "border-[var(--border-subtle)] bg-[var(--bg-card)] text-[var(--text-secondary)]";
}

function recommendationScore(
  entry: RnnCatalogEntry,
  slot: RecommendationSlot,
  runtimeStatus: RnnRuntimeStatus | null,
  gpuMemoryTotalMiB?: number | null,
  preferredDevice?: string | null,
  hostMemoryTotalBytes?: number | null,
  runtimeConfig?: RnnRuntimeStatus["runtimeConfig"] | null,
): number {
  const profile = recommendationProfileForEntry(entry);
  const fit = hardwareFitForEntry(
    entry,
    gpuMemoryTotalMiB,
    preferredDevice,
    hostMemoryTotalBytes,
    runtimeConfig,
  );
  const backendReady = backendReadyForEntry(entry, runtimeStatus);
  const fitScore =
    fit.loadBlocked ? -8 : fit.tone === "good" ? 3 : fit.tone === "warn" ? 1 : fit.tone === "bad" ? -6 : 0;
  const backendScore = backendReady ? 1.5 : -2.5;
  const sizeScore =
    typeof entry.size_gb === "number" && entry.size_gb > 0 ? Math.max(0, 6 - entry.size_gb) * 0.15 : 0;
  if (slot === "overall") {
    return (
      profile.toolScore * 1.45 +
      profile.speedScore * 1.1 +
      fitScore * 1.7 +
      backendScore +
      sizeScore +
      (profile.overallBonus || 0)
    );
  }
  if (slot === "tools") {
    return (
      profile.toolScore * 2 +
      profile.speedScore * 0.65 +
      fitScore * 1.4 +
      backendScore +
      (profile.overallBonus || 0) * 0.4
    );
  }
  return (
    profile.lowVramScore * 2.05 +
    profile.speedScore * 0.7 +
    fitScore * 1.5 +
    backendScore +
    sizeScore * 2
  );
}

function buildRecommendedModels(
  entries: RnnCatalogEntry[],
  runtimeStatus: RnnRuntimeStatus | null,
  gpuMemoryTotalMiB?: number | null,
  preferredDevice?: string | null,
  hostMemoryTotalBytes?: number | null,
  runtimeConfig?: RnnRuntimeStatus["runtimeConfig"] | null,
): RecommendedModel[] {
  const slots: RecommendationSlot[] = ["overall", "tools", "low-vram"];
  const usedIds = new Set<string>();
  const recommendations: RecommendedModel[] = [];
  for (const slot of slots) {
    const ranked = [...entries]
      .map((entry) => ({
        slot,
        entry,
        score: recommendationScore(
          entry,
          slot,
          runtimeStatus,
          gpuMemoryTotalMiB,
          preferredDevice,
          hostMemoryTotalBytes,
          runtimeConfig,
        ),
        fit: hardwareFitForEntry(
          entry,
          gpuMemoryTotalMiB,
          preferredDevice,
          hostMemoryTotalBytes,
          runtimeConfig,
        ),
        profile: recommendationProfileForEntry(entry),
        backendReady: backendReadyForEntry(entry, runtimeStatus),
      }))
      .filter((item) => !usedIds.has(item.entry.id))
      .sort((left, right) => {
        if (right.score !== left.score) return right.score - left.score;
        const leftSize = typeof left.entry.size_gb === "number" ? left.entry.size_gb : Number.POSITIVE_INFINITY;
        const rightSize =
          typeof right.entry.size_gb === "number" ? right.entry.size_gb : Number.POSITIVE_INFINITY;
        if (leftSize !== rightSize) return leftSize - rightSize;
        return formatCatalogName(left.entry).localeCompare(formatCatalogName(right.entry));
      });
    const selected = ranked[0];
    if (!selected) continue;
    usedIds.add(selected.entry.id);
    recommendations.push(selected);
  }
  return recommendations;
}

function readModelInfoNumber(
  value: Record<string, unknown> | null | undefined,
  ...keys: string[]
): number | null {
  for (const key of keys) {
    const next = value?.[key];
    if (typeof next === "number" && Number.isFinite(next)) {
      return next;
    }
  }
  return null;
}

function normalizeVllmRuntimeConfig(
  value?: Partial<VllmRuntimeConfig> | null,
): VllmRuntimeConfig {
  return {
    gpuMemoryUtilization:
      typeof value?.gpuMemoryUtilization === "number"
        ? value.gpuMemoryUtilization
        : 0.9,
    kvCacheDtype: value?.kvCacheDtype?.trim() || "auto",
    calculateKvScales: value?.calculateKvScales === true,
    cpuOffloadGb: typeof value?.cpuOffloadGb === "number" ? value.cpuOffloadGb : 0,
    swapSpace: typeof value?.swapSpace === "number" ? value.swapSpace : 4,
    maxModelLen:
      typeof value?.maxModelLen === "number" && value.maxModelLen > 0
        ? value.maxModelLen
        : null,
    enablePrefixCaching: value?.enablePrefixCaching !== false,
    enforceEager: value?.enforceEager === true,
  };
}

function normalizeLlamaCppRuntimeConfig(
  value?: Partial<LlamaCppRuntimeConfig> | null,
): LlamaCppRuntimeConfig {
  return {
    nGpuLayers: typeof value?.nGpuLayers === "number" ? value.nGpuLayers : -1,
    nCtx: typeof value?.nCtx === "number" && value.nCtx > 0 ? value.nCtx : 8192,
    nBatch: typeof value?.nBatch === "number" && value.nBatch > 0 ? value.nBatch : 512,
    nThreads:
      typeof value?.nThreads === "number" && value.nThreads > 0 ? value.nThreads : null,
    flashAttn: value?.flashAttn !== false,
    useMmap: value?.useMmap !== false,
    useMlock: value?.useMlock === true,
  };
}

export function RnnLocalModelManager({
  config,
  onChange,
  onCatalogChange,
  onModelActivated,
}: Props) {
  const [snapshot, setSnapshot] = useState<RnnCatalogSnapshot | null>(null);
  const [runtimeStatus, setRuntimeStatus] = useState<RnnRuntimeStatus | null>(null);
  const [memoryHistory, setMemoryHistory] = useState<RuntimeMemorySample[]>(
    () => readManagedRuntimeMemoryHistory(),
  );
  const [vllmDraft, setVllmDraft] = useState<VllmRuntimeConfig>(
    normalizeVllmRuntimeConfig(),
  );
  const [llamaCppDraft, setLlamaCppDraft] = useState<LlamaCppRuntimeConfig>(
    normalizeLlamaCppRuntimeConfig(),
  );
  const [busyAction, setBusyAction] = useState<BusyAction>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const requestRef = useRef(0);
  const lastDownloadStatusRef = useRef<string | null>(null);

  async function refreshRuntimeStatus(opts?: { quiet?: boolean }): Promise<RnnRuntimeStatus | null> {
    try {
      const nextStatus = await invoke<RnnRuntimeStatus>("get_rnn_runtime_status");
      setRuntimeStatus(nextStatus);
      if (nextStatus.loadedModel && nextStatus.loadedModel !== config.modelName) {
        onChange({
          ...config,
          enabled: true,
          modelName: nextStatus.loadedModel,
        });
      }
      return nextStatus;
    } catch (nextError: any) {
      if (!opts?.quiet) {
        setError(String(nextError));
      }
      return null;
    }
  }

  async function refreshCatalog(opts?: { quiet?: boolean }): Promise<RnnCatalogSnapshot | null> {
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    if (!opts?.quiet) {
      setBusyAction({ kind: "refresh" });
    }
    setError(null);

    try {
      const nextSnapshot = await invoke<RnnCatalogSnapshot>("get_rnn_catalog");
      const nextStatus = await invoke<RnnRuntimeStatus>("get_rnn_runtime_status");
      if (requestRef.current !== requestId) {
        return nextSnapshot;
      }
      setSnapshot(nextSnapshot);
      setRuntimeStatus(nextStatus);
      setBusyAction((current) => (current?.kind === "refresh" ? null : current));
      if (nextSnapshot.loadedModel && nextSnapshot.loadedModel !== config.modelName) {
        onChange({
          ...config,
          enabled: true,
          modelName: nextSnapshot.loadedModel,
        });
      }
      return nextSnapshot;
    } catch (nextError: any) {
      if (requestRef.current !== requestId) {
        return null;
      }
      setBusyAction((current) => (current?.kind === "refresh" ? null : current));
      setError(String(nextError));
      return null;
    }
  }

  useEffect(() => {
    if (config.serviceType !== "rnn-local") {
      return;
    }
    void refreshCatalog();
  }, [config.serviceType]);

  useEffect(() => {
    if (config.serviceType !== "rnn-local") {
      return;
    }
    const interval = window.setInterval(() => {
      void refreshRuntimeStatus({ quiet: true });
    }, 4000);
    return () => window.clearInterval(interval);
  }, [config.serviceType, config.modelName]);

  useEffect(() => {
    setVllmDraft(normalizeVllmRuntimeConfig(runtimeStatus?.runtimeConfig?.vllm));
  }, [runtimeStatus?.runtimeConfig?.vllm]);

  useEffect(() => {
    setLlamaCppDraft(normalizeLlamaCppRuntimeConfig(runtimeStatus?.runtimeConfig?.llamaCpp));
  }, [runtimeStatus?.runtimeConfig?.llamaCpp]);

  useEffect(() => {
    const isDownloading = snapshot?.downloadState?.status === "downloading";
    if (!isDownloading) {
      return;
    }
    const interval = window.setInterval(() => {
      void refreshCatalog({ quiet: true });
    }, 1000);
    return () => window.clearInterval(interval);
  }, [snapshot?.downloadState?.status]);

  useEffect(() => {
    const status = snapshot?.downloadState?.status || null;
    const previous = lastDownloadStatusRef.current;
    if (status === previous) {
      return;
    }
    lastDownloadStatusRef.current = status;
    if (status === "downloaded") {
      setError(null);
      setMessage(
        `Downloaded ${snapshot?.downloadState?.modelName || "model"}.`,
      );
      onCatalogChange?.();
    } else if (status === "error") {
      setError(snapshot?.downloadState?.error || "Managed-runtime download failed.");
    }
  }, [snapshot?.downloadState, onCatalogChange]);

  async function startDownload(catalogId: string, label: string, backend?: string | null) {
    setBusyAction({ kind: "download", target: catalogId });
    setError(null);
    const shouldAutoInstallBackend =
      backendAutoInstallsOnFirstUse(backend) &&
      !backendReadyForEntry({ backend: backend ?? undefined }, runtimeStatus);
    setMessage(
      shouldAutoInstallBackend
        ? `Installing ${formatBackend(backend) || "backend"} for ${label}, then starting download...`
        : `Starting download for ${label}...`,
    );
    try {
      await invoke("download_rnn_model", {
        catalogId,
        hfToken: trimApiKey(config.apiKey),
      });
      await refreshCatalog({ quiet: true });
    } catch (nextError: any) {
      setError(String(nextError));
    } finally {
      setBusyAction(null);
    }
  }

  async function installBackend(backend?: string | null) {
    const normalized = (backend || "").trim().toLowerCase();
    if (!normalized) {
      setMessage(null);
      setError("This model does not declare a managed runtime backend.");
      return;
    }
    await runAction(
      { kind: "install-backend", target: normalized },
      () => invoke("install_rnn_runtime_backend", { backend: normalized }),
      `Installed the ${formatBackend(normalized) || normalized} backend.`,
    );
  }

  async function loadLocalModel(
    entry: Pick<RnnLocalEntry, "name" | "display_name" | "backend" | "catalog_id" | "size_gb">,
  ) {
    const sourceCatalogEntry =
      (entry.catalog_id
        ? catalogEntries.find((candidate) => candidate.id === entry.catalog_id)
        : null) || null;
    const fit = hardwareFitForEntry(
      sourceCatalogEntry || entry,
      gpuMemoryTotalMiB,
      preferredDevice,
      hostMemoryTotalBytes,
      runtimeStatus?.runtimeConfig,
    );
    if (fit.loadBlocked) {
      setMessage(null);
      setError(fit.loadBlockReason || "This model is blocked on the current hardware.");
      return;
    }
    const backendReady = backendReadyForEntry(entry, runtimeStatus);
    const canAutoInstallBackend = backendAutoInstallsOnFirstUse(entry.backend);
    if (!backendReady && !canAutoInstallBackend) {
      const requirement = backendLoadRequirementLabel(entry.backend);
      setMessage(null);
      setError(
        requirement
          ? `${requirement}. Install the missing backend, then retry.`
          : "Install the required backend before loading this model.",
      );
      return;
    }
    await runAction(
      { kind: "load", target: entry.name },
      () => invoke("load_rnn_model", { modelName: entry.name }),
      `Loaded ${entry.display_name || entry.name}.`,
      !backendReady && canAutoInstallBackend
        ? `Installing ${formatBackend(entry.backend) || "backend"} for ${entry.display_name || entry.name}, then loading...`
        : undefined,
    );
  }

  async function runAction(
    nextBusyAction: NonNullable<BusyAction>,
    request: () => Promise<any>,
    successMessage: string,
    pendingMessage?: string,
  ) {
    setBusyAction(nextBusyAction);
    setError(null);
    setMessage(pendingMessage || null);
    try {
      const result = await request();
      const nextSnapshot = await refreshCatalog({ quiet: true });
      if (nextBusyAction.kind === "load") {
        const nextModel =
          (typeof result?.model === "string" && result.model.trim()) ||
          nextSnapshot?.loadedModel ||
          nextBusyAction.target;
        await Promise.resolve(
          onChange({
            ...config,
            enabled: true,
            modelName: nextModel,
          }),
        );
        await Promise.resolve(onModelActivated?.(nextModel));
        setMessage(`Loaded ${nextModel}. Warming it up...`);
        void invoke("warm_rnn_model", { modelName: nextModel })
          .then(async () => {
            await refreshCatalog({ quiet: true });
            setMessage(`Loaded and warmed ${nextModel}.`);
          })
          .catch((warmError) => {
            setError(String(warmError));
          });
      }
      if (
        nextBusyAction.kind === "delete" &&
        config.modelName === nextBusyAction.target &&
        !nextSnapshot?.local.some((entry) => entry.name === nextBusyAction.target)
      ) {
        await Promise.resolve(
          onChange({
            ...config,
            enabled: true,
            modelName: "",
          }),
        );
      }
      if (nextBusyAction.kind === "unload" && nextSnapshot?.loadedModel === null) {
        setRuntimeStatus((current) =>
          current
            ? {
                ...current,
                loadedModel: null,
              }
            : current,
        );
      }
      setMessage(successMessage);
      onCatalogChange?.();
    } catch (nextError: any) {
      setError(String(nextError));
    } finally {
      setBusyAction(null);
    }
  }

  const localByCatalogId = new Map<string, RnnLocalEntry>();
  for (const entry of snapshot?.local || []) {
    if (entry.catalog_id) {
      localByCatalogId.set(entry.catalog_id, entry);
    }
  }

  const catalogEntries = snapshot?.catalog || [];
  const localEntries = snapshot?.local || [];
  const loadedLocalEntry =
    localEntries.find((entry) => snapshot?.loadedModel === entry.name || entry.loaded) || null;
  const loadedCatalogEntry =
    (loadedLocalEntry?.catalog_id
      ? catalogEntries.find((entry) => entry.id === loadedLocalEntry.catalog_id)
      : null) ||
    catalogEntries.find(
      (entry) =>
        entry.loaded === true ||
        entry.name === snapshot?.loadedModel ||
        entry.display_name === snapshot?.loadedModel,
    ) ||
    null;
  const activeDownloadState: RnnDownloadState | null =
    snapshot?.downloadState?.status === "downloading" ? snapshot.downloadState : null;
  const totalLocalSizeGb = localEntries.reduce(
    (sum, entry) => sum + (typeof entry.size_gb === "number" ? entry.size_gb : 0),
    0,
  );
  const downloadedCount = localEntries.length;
  const loadedModelLabel =
    loadedLocalEntry?.display_name ||
    loadedCatalogEntry?.display_name ||
    snapshot?.loadedModel ||
    runtimeStatus?.loadedModel ||
    "None";
  const loadedModelBackend =
    formatBackend(loadedLocalEntry?.backend) ||
    formatBackend(loadedCatalogEntry?.backend) ||
    formatBackend(runtimeStatus?.activeBackend);
  const loadedModelSize =
    readModelInfoNumber(runtimeStatus?.activeModelInfo, "fileSizeGb", "file_size_gb") ||
    loadedLocalEntry?.size_gb ||
    loadedCatalogEntry?.size_gb ||
    null;
  const loadedModelLoadTime = readModelInfoNumber(runtimeStatus?.activeModelInfo, "loadTime");
  const catalogFamilyGroups: Array<{
    family: string;
    series: Array<{
      series: string;
      entries: RnnCatalogEntry[];
      downloadedCount: number;
      loadedCount: number;
    }>;
    downloadedCount: number;
    loadedCount: number;
  }> = [];
  const familyMap = new Map<string, (typeof catalogFamilyGroups)[number]>();
  for (const entry of catalogEntries) {
    const family = catalogFamily(entry);
    const series = catalogSeries(entry);
    let familyGroup = familyMap.get(family);
    if (!familyGroup) {
      familyGroup = { family, series: [], downloadedCount: 0, loadedCount: 0 };
      familyMap.set(family, familyGroup);
      catalogFamilyGroups.push(familyGroup);
    }
    let seriesGroup = familyGroup.series.find((candidate) => candidate.series === series);
    if (!seriesGroup) {
      seriesGroup = { series, entries: [], downloadedCount: 0, loadedCount: 0 };
      familyGroup.series.push(seriesGroup);
    }
    seriesGroup.entries.push(entry);
    const localEntry = localByCatalogId.get(entry.id);
    const isLoaded =
      snapshot?.loadedModel === localEntry?.name || entry.loaded === true || localEntry?.loaded === true;
    if (isLoaded) {
      familyGroup.loadedCount += 1;
      seriesGroup.loadedCount += 1;
    } else if (localEntry) {
      familyGroup.downloadedCount += 1;
      seriesGroup.downloadedCount += 1;
    }
  }
  const localCountsByCategory = localEntries.reduce<Record<string, number>>((acc, entry) => {
    const sourceCatalogEntry =
      (entry.catalog_id
        ? catalogEntries.find((candidate) => candidate.id === entry.catalog_id)
        : null) || null;
    const category = sourceCatalogEntry
      ? catalogCategory(sourceCatalogEntry)
      : formatArchitecture(entry.architecture) || "Other";
    acc[category] = (acc[category] || 0) + 1;
    return acc;
  }, {});
  const localBreakdown = Object.entries(localCountsByCategory)
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([label, count]) => `${count} ${label}`)
    .join(" • ");
  const sortedLocalEntries = [...localEntries].sort((left, right) => {
    const leftLoaded = snapshot?.loadedModel === left.name || left.loaded === true;
    const rightLoaded = snapshot?.loadedModel === right.name || right.loaded === true;
    if (leftLoaded !== rightLoaded) {
      return leftLoaded ? -1 : 1;
    }
    return (left.display_name || left.name).localeCompare(right.display_name || right.name);
  });

  const buttonClassName =
    "inline-flex items-center gap-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)] px-3 py-1.5 text-xs font-medium text-[var(--text-primary)] transition-colors hover:border-[var(--border-strong)] disabled:cursor-not-allowed disabled:opacity-50";
  const badgeClassName =
    "inline-flex items-center rounded-full border border-[var(--border-subtle)] px-2 py-0.5 text-[11px] font-medium text-[var(--text-secondary)]";
  const preferredDevice = runtimeStatus?.capabilities?.preferredDevice || null;
  const deviceBadge =
    preferredDevice === "cuda"
      ? runtimeStatus?.capabilities?.cudaDeviceName || "CUDA"
      : preferredDevice === "mps"
        ? "Apple GPU"
        : "CPU";
  const accelerationBadge =
    preferredDevice === "cuda"
      ? "GPU ready"
      : preferredDevice === "mps"
        ? "Metal ready"
        : "CPU only";
  const vllmInstalled = runtimeStatus?.capabilities?.backendAvailability?.vllm === true;
  const vllmStatusKnown =
    runtimeStatus?.capabilities?.backendAvailability?.vllm !== undefined;
  const llamaCppInstalled = runtimeStatus?.capabilities?.backendAvailability?.["llama-cpp"] === true;
  const llamaCppStatusKnown =
    runtimeStatus?.capabilities?.backendAvailability?.["llama-cpp"] !== undefined;
  const prismLlamaInstalled =
    runtimeStatus?.capabilities?.backendAvailability?.["prism-llama"] === true;
  const prismLlamaStatusKnown =
    runtimeStatus?.capabilities?.backendAvailability?.["prism-llama"] !== undefined;
  const albatrossReady =
    runtimeStatus?.capabilities?.backendAvailability?.albatross === true;
  const albatrossStatusKnown =
    runtimeStatus?.capabilities?.albatrossSourceBundled !== undefined;
  const albatrossBundled =
    runtimeStatus?.capabilities?.albatrossSourceBundled === true;
  const nvccPath = runtimeStatus?.capabilities?.nvccPath || null;
  const currentCudaAllocatedMiB =
    runtimeStatus?.capabilities?.currentProcessCudaAllocatedMiB ?? 0;
  const currentCudaReservedMiB =
    runtimeStatus?.capabilities?.currentProcessCudaReservedMiB ?? 0;
  const processGpuMemoryMiB =
    typeof runtimeStatus?.capabilities?.processGpuMemoryMiB === "number"
      ? runtimeStatus.capabilities.processGpuMemoryMiB
      : null;
  const gpuMemoryTotalMiB =
    typeof runtimeStatus?.capabilities?.gpuMemoryTotalMiB === "number"
      ? runtimeStatus.capabilities.gpuMemoryTotalMiB
      : null;
  const gpuMemoryUtilizationPercent =
    typeof runtimeStatus?.capabilities?.gpuMemoryUtilizationPercent === "number"
      ? runtimeStatus.capabilities.gpuMemoryUtilizationPercent
      : null;
  const gpuMemorySource = runtimeStatus?.capabilities?.gpuMemorySource || null;
  const gpuMemoryName = runtimeStatus?.capabilities?.gpuMemoryName || null;
  const hostMemoryTotalBytes =
    typeof runtimeStatus?.capabilities?.hostMemoryTotalBytes === "number"
      ? runtimeStatus.capabilities.hostMemoryTotalBytes
      : null;
  const hostMemoryTotalGb =
    typeof hostMemoryTotalBytes === "number" && hostMemoryTotalBytes > 0
      ? hostMemoryTotalBytes / 1024 ** 3
      : null;
  const effectiveGpuProcessMemoryMiB =
    processGpuMemoryMiB ??
    (preferredDevice === "cuda"
      ? currentCudaReservedMiB > 0
        ? currentCudaReservedMiB
        : currentCudaAllocatedMiB > 0
          ? currentCudaAllocatedMiB
          : null
      : null);
  const effectiveGpuMemorySource =
    gpuMemorySource ||
    (preferredDevice === "cuda" &&
    (currentCudaReservedMiB > 0 || currentCudaAllocatedMiB > 0)
      ? "torch"
      : null);
  const activeMemoryModelKey =
    runtimeStatus?.loadedModel ||
    snapshot?.loadedModel ||
    loadedLocalEntry?.name ||
    loadedCatalogEntry?.name ||
    config.modelName ||
    "";
  const activeMemoryBackendKey =
    isGgufBackend(runtimeStatus?.activeBackend || loadedLocalEntry?.backend || loadedCatalogEntry?.backend)
      ? "llama-cpp"
      : runtimeStatus?.activeBackend || loadedLocalEntry?.backend || loadedCatalogEntry?.backend || null;
  const persistedVllmConfig = normalizeVllmRuntimeConfig(runtimeStatus?.runtimeConfig?.vllm);
  const vllmConfigDirty =
    JSON.stringify(vllmDraft) !== JSON.stringify(persistedVllmConfig);
  const persistedLlamaCppConfig = normalizeLlamaCppRuntimeConfig(
    runtimeStatus?.runtimeConfig?.llamaCpp,
  );
  const llamaCppConfigDirty =
    JSON.stringify(llamaCppDraft) !== JSON.stringify(persistedLlamaCppConfig);
  const recommendedModels = buildRecommendedModels(
    catalogEntries,
    runtimeStatus,
    gpuMemoryTotalMiB,
    preferredDevice,
    hostMemoryTotalBytes,
    runtimeStatus?.runtimeConfig,
  );
  const recommendedModelLabels = new Map(
    recommendedModels.map((item) => [item.entry.id, RECOMMENDATION_LABELS[item.slot]]),
  );
  const rankedCatalogEntries = [...catalogEntries].sort((left, right) => {
    const leftRecommendedIndex = recommendedModels.findIndex((item) => item.entry.id === left.id);
    const rightRecommendedIndex = recommendedModels.findIndex((item) => item.entry.id === right.id);
    if (leftRecommendedIndex !== rightRecommendedIndex) {
      if (leftRecommendedIndex === -1) return 1;
      if (rightRecommendedIndex === -1) return -1;
      return leftRecommendedIndex - rightRecommendedIndex;
    }
    const leftFit = hardwareFitForEntry(
      left,
      gpuMemoryTotalMiB,
      preferredDevice,
      hostMemoryTotalBytes,
      runtimeStatus?.runtimeConfig,
    );
    const rightFit = hardwareFitForEntry(
      right,
      gpuMemoryTotalMiB,
      preferredDevice,
      hostMemoryTotalBytes,
      runtimeStatus?.runtimeConfig,
    );
    const toneRank = { good: 0, warn: 1, neutral: 2, bad: 3 } as const;
    if (toneRank[leftFit.tone] !== toneRank[rightFit.tone]) {
      return toneRank[leftFit.tone] - toneRank[rightFit.tone];
    }
    const leftScore = recommendationScore(
      left,
      "overall",
      runtimeStatus,
      gpuMemoryTotalMiB,
      preferredDevice,
      hostMemoryTotalBytes,
      runtimeStatus?.runtimeConfig,
    );
    const rightScore = recommendationScore(
      right,
      "overall",
      runtimeStatus,
      gpuMemoryTotalMiB,
      preferredDevice,
      hostMemoryTotalBytes,
      runtimeStatus?.runtimeConfig,
    );
    if (rightScore !== leftScore) return rightScore - leftScore;
    return formatCatalogName(left).localeCompare(formatCatalogName(right));
  });
  const groupedCatalogEntries: Array<{
    family: string;
    series: Array<{
      series: string;
      entries: RnnCatalogEntry[];
      downloadedCount: number;
      loadedCount: number;
    }>;
    downloadedCount: number;
    loadedCount: number;
  }> = [];
  const groupedCatalogFamilyMap = new Map<string, (typeof groupedCatalogEntries)[number]>();
  for (const entry of rankedCatalogEntries) {
    const family = catalogFamily(entry);
    const series = catalogSeries(entry);
    let familyGroup = groupedCatalogFamilyMap.get(family);
    if (!familyGroup) {
      familyGroup = { family, series: [], downloadedCount: 0, loadedCount: 0 };
      groupedCatalogFamilyMap.set(family, familyGroup);
      groupedCatalogEntries.push(familyGroup);
    }
    let seriesGroup = familyGroup.series.find((candidate) => candidate.series === series);
    if (!seriesGroup) {
      seriesGroup = { series, entries: [], downloadedCount: 0, loadedCount: 0 };
      familyGroup.series.push(seriesGroup);
    }
    seriesGroup.entries.push(entry);
    const localEntry = localByCatalogId.get(entry.id);
    const isLoaded =
      snapshot?.loadedModel === localEntry?.name || entry.loaded === true || localEntry?.loaded === true;
    if (isLoaded) {
      familyGroup.loadedCount += 1;
      seriesGroup.loadedCount += 1;
    } else if (localEntry) {
      familyGroup.downloadedCount += 1;
      seriesGroup.downloadedCount += 1;
    }
  }
  groupedCatalogEntries.sort((left, right) => {
    const leftPinned = left.family === "Nemotron";
    const rightPinned = right.family === "Nemotron";
    if (leftPinned !== rightPinned) {
      return leftPinned ? -1 : 1;
    }
    return 0;
  });
  const hardwareSummary =
    preferredDevice === "cuda" && gpuMemoryTotalMiB
      ? [
          `${formatMemory(gpuMemoryTotalMiB)} ${gpuMemoryName ? `· ${gpuMemoryName}` : "GPU"}`,
          hostMemoryTotalBytes ? `${formatBytes(hostMemoryTotalBytes)} RAM` : null,
        ].filter(Boolean).join(" · ")
      : preferredDevice === "mps"
        ? ["Apple GPU", hostMemoryTotalBytes ? `${formatBytes(hostMemoryTotalBytes)} unified RAM` : null]
            .filter(Boolean)
            .join(" · ")
        : preferredDevice === "cpu"
          ? [hostMemoryTotalBytes ? `${formatBytes(hostMemoryTotalBytes)} RAM` : "CPU only"]
              .filter(Boolean)
              .join(" · ")
          : [deviceBadge, hostMemoryTotalBytes ? `${formatBytes(hostMemoryTotalBytes)} RAM` : null]
              .filter(Boolean)
              .join(" · ");
  const lowMemoryGgufNotice =
    hostMemoryTotalGb !== null &&
    hostMemoryTotalGb <= 8.5 &&
    persistedLlamaCppConfig.nCtx > 16384;
  const activeModelMemoryHistory = memoryHistory
    .filter((sample) => sample.model === activeMemoryModelKey)
    .slice(-20);
  const memoryHistoryPeakMiB = activeModelMemoryHistory.reduce(
    (max, sample) => Math.max(max, sample.usedMiB),
    effectiveGpuProcessMemoryMiB ?? 0,
  );
  const memoryHistoryLatest = activeModelMemoryHistory[activeModelMemoryHistory.length - 1] || null;
  const memoryChartCeilingMiB = Math.max(
    gpuMemoryTotalMiB ?? 0,
    memoryHistoryPeakMiB,
    effectiveGpuProcessMemoryMiB ?? 0,
    1,
  );

  useEffect(() => {
    if (!activeMemoryModelKey || !effectiveGpuProcessMemoryMiB || !effectiveGpuMemorySource) {
      return;
    }
    const nextSample: RuntimeMemorySample = {
      ts: Date.now(),
      model: activeMemoryModelKey,
      backend: activeMemoryBackendKey,
      source: effectiveGpuMemorySource,
      usedMiB: effectiveGpuProcessMemoryMiB,
      totalMiB: gpuMemoryTotalMiB,
    };
    setMemoryHistory((current) => {
      const last = current[current.length - 1];
      if (
        last &&
        last.model === nextSample.model &&
        last.backend === nextSample.backend &&
        last.source === nextSample.source &&
        Math.abs(last.usedMiB - nextSample.usedMiB) < 8 &&
        nextSample.ts - last.ts < 3500
      ) {
        return current;
      }
      const next = [...current, nextSample].slice(-MAX_MANAGED_RUNTIME_MEMORY_SAMPLES);
      writeManagedRuntimeMemoryHistory(next);
      return next;
    });
  }, [
    activeMemoryBackendKey,
    activeMemoryModelKey,
    effectiveGpuMemorySource,
    effectiveGpuProcessMemoryMiB,
    gpuMemoryTotalMiB,
  ]);

  function renderCatalogModelEntry(
    entry: RnnCatalogEntry,
    opts?: {
      summaryPaddingClassName?: string;
      detailPaddingClassName?: string;
    },
  ) {
    const localEntry = localByCatalogId.get(entry.id);
    const activeDownload =
      snapshot?.downloadState?.catalogId === entry.id ? snapshot.downloadState : null;
    const isDownloading = activeDownload?.status === "downloading";
    const isPreparingDownload =
      busyAction?.kind === "download" && busyAction.target === entry.id && !isDownloading;
    const progressSummary = downloadProgressSummary(activeDownload);
    const progressDetail = downloadProgressDetail(activeDownload);
    const fit = hardwareFitForEntry(
      entry,
      gpuMemoryTotalMiB,
      preferredDevice,
      hostMemoryTotalBytes,
      runtimeStatus?.runtimeConfig,
    );
    const profile = recommendationProfileForEntry(entry);
    const backendReady = backendReadyForEntry(entry, runtimeStatus);
    const recommendationLabel = recommendedModelLabels.get(entry.id) || null;
    return (
      <details key={entry.id} className="group/model">
        <summary
          className={clsx(
            "flex items-center justify-between gap-2 py-2 cursor-pointer list-none",
            opts?.summaryPaddingClassName || "px-5",
          )}
        >
          <div className="flex items-center gap-2 min-w-0">
            <ChevronDown className="w-3 h-3 text-[var(--text-tertiary)] transition-transform group-open/model:rotate-180 flex-shrink-0" />
            <span className="text-[13px] font-medium text-[var(--text-primary)] truncate">
              {formatCatalogName(entry)}
            </span>
            {formatSize(entry.size_gb) ? (
              <span className="text-[11px] text-[var(--text-tertiary)] flex-shrink-0">
                {formatSize(entry.size_gb)}
              </span>
            ) : null}
          </div>
          <div
            className="flex items-center gap-1 flex-shrink-0"
            onClick={(event) => event.preventDefault()}
          >
            {localEntry ? (
              <span className="text-[11px] font-medium text-[var(--system-blue)]">Downloaded</span>
            ) : isDownloading ? (
              <span className="flex items-center gap-1.5 text-[11px] text-[var(--system-blue)]">
                <Loader2 className="h-3 w-3 animate-spin" />
                {progressSummary}
                {progressDetail ? (
                  <span className="text-[var(--text-tertiary)]">{progressDetail}</span>
                ) : null}
              </span>
            ) : isPreparingDownload ? (
              <span className="flex items-center gap-1.5 text-[11px] text-[var(--system-blue)]">
                <Loader2 className="h-3 w-3 animate-spin" />
                {pendingDownloadLabel(entry.backend, backendReady)}
              </span>
            ) : (
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  void startDownload(entry.id, formatCatalogName(entry), entry.backend);
                }}
                disabled={busyAction !== null || snapshot?.downloadState?.status === "downloading"}
                className={buttonClassName}
              >
                <Download className="h-3.5 w-3.5" />
                Download
              </button>
            )}
          </div>
        </summary>
        <div
          className={clsx(
            "pb-3 pt-1 border-t border-[var(--border-subtle)] bg-[var(--bg-secondary)]/50",
            opts?.detailPaddingClassName || "px-5",
          )}
        >
          <div className="flex flex-wrap gap-1.5">
            {recommendationLabel ? (
              <span className="inline-flex items-center rounded-full bg-[var(--system-blue)]/10 px-2 py-0.5 text-[10px] font-semibold text-[var(--system-blue)]">
                {recommendationLabel}
              </span>
            ) : null}
            <span className={clsx(badgeClassName, hardwareFitBadgeClass(fit.tone))}>
              {fit.label}
            </span>
            {!backendReady ? (
              <span className="inline-flex items-center rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold text-amber-600">
                {backendMissingBadgeLabel(entry.backend)}
              </span>
            ) : null}
          </div>
          <div className="mt-2 text-[11px] text-[var(--text-secondary)] leading-relaxed">
            {[
              formatBackend(entry.backend),
              formatArchitecture(entry.architecture),
              entry.params,
              entry.hf_repo ? formatProvider(entry.hf_repo) : null,
              formatContext(resolvedContextWindow(entry, runtimeStatus?.runtimeConfig)),
              fit.estimatedHostMemoryGb
                ? `Est. ${fit.estimatedHostMemoryGb.toFixed(1)} GB RAM`
                : null,
              fit.estimatedVramGb
                ? `Est. ${fit.estimatedVramGb.toFixed(1)} GB ${
                    preferredDevice === "cuda" ? "VRAM" : "runtime mem"
                  }`
                : null,
            ].filter(Boolean).join(" · ")}
          </div>
          {entry.description ? (
            <div className="mt-1 text-[11px] text-[var(--text-tertiary)] leading-relaxed">
              {entry.description}
            </div>
          ) : null}
          {fit.loadBlocked && fit.loadBlockReason ? (
            <div className="mt-2 text-[11px] font-medium text-red-600 leading-relaxed">
              {fit.loadBlockReason}
            </div>
          ) : null}
          {profile.bestFor ? (
            <div className="mt-2 text-[12px] text-[var(--text-primary)] leading-relaxed">
              {profile.bestFor}
            </div>
          ) : null}
          <div className="mt-2 flex flex-wrap gap-1">
            {profile.strengths.slice(0, 4).map((strength) => (
              <span key={strength} className={badgeClassName}>
                {strength}
              </span>
            ))}
          </div>
          {profile.caution ? (
            <div className="mt-2 text-[11px] text-[var(--text-tertiary)] leading-relaxed">
              {profile.caution}
            </div>
          ) : null}
          {isDownloading ? (
            <div className="mt-2 space-y-2">
              <div className="text-[11px] text-[var(--text-secondary)]">
                {progressDetail || "Download in progress"}
              </div>
              <div className="h-1 overflow-hidden rounded-full bg-[var(--border-subtle)]">
                <div
                  className="h-full rounded-full bg-[var(--system-blue)] transition-all"
                  style={{ width: downloadProgressBarWidth(activeDownload) }}
                />
              </div>
            </div>
          ) : isPreparingDownload ? (
            <div className="mt-2 flex items-center gap-2 text-[11px] text-[var(--system-blue)]">
              <Loader2 className="h-3 w-3 animate-spin" />
              <span>{pendingDownloadLabel(entry.backend, backendReady)}.</span>
            </div>
          ) : null}
        </div>
      </details>
    );
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <div className="text-[13px] font-semibold text-[var(--text-primary)]">
          Downloaded Models
        </div>
        {snapshot?.local.length ? (
          <div className="rounded-xl border border-[var(--border-subtle)] divide-y divide-[var(--border-subtle)] overflow-hidden">
            {sortedLocalEntries.map((entry) => {
              const isLoaded = snapshot.loadedModel === entry.name || entry.loaded === true;
              const isBusy =
                busyAction?.kind !== "refresh" && busyAction?.target === entry.name;
              const normalizedBackend = (entry.backend || "").trim().toLowerCase();
              const canAutoInstallBackend = backendAutoInstallsOnFirstUse(entry.backend);
              const isInstallingBackend =
                busyAction?.kind === "install-backend" && busyAction.target === normalizedBackend;
              const sourceCatalogEntry =
                (entry.catalog_id
                  ? catalogEntries.find((candidate) => candidate.id === entry.catalog_id)
                  : null) || null;
              const fit = hardwareFitForEntry(
                sourceCatalogEntry || entry,
                gpuMemoryTotalMiB,
                preferredDevice,
                hostMemoryTotalBytes,
                runtimeStatus?.runtimeConfig,
              );
              const backendReady = backendReadyForEntry(entry, runtimeStatus);
              const backendRequirement = backendLoadRequirementLabel(entry.backend);
              return (
                <details key={entry.name} className="group">
                  <summary className="flex items-center justify-between gap-2 px-3 py-2 cursor-pointer list-none">
                    <div className="flex items-center gap-2 min-w-0">
                      <ChevronDown className="w-3 h-3 text-[var(--text-tertiary)] transition-transform group-open:rotate-180 flex-shrink-0" />
                      <span className="text-sm font-medium truncate text-[var(--text-primary)]">
                        {entry.display_name || entry.name}
                      </span>
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0" onClick={(e) => e.preventDefault()}>
                      {isLoaded ? (
                        <span className="inline-flex items-center rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-600">
                          Active
                        </span>
                      ) : fit.loadBlocked ? (
                        <span
                          className="inline-flex items-center rounded-full bg-red-500/10 px-2 py-0.5 text-[10px] font-semibold text-red-600"
                          title={fit.loadBlockReason || undefined}
                        >
                          Load blocked
                        </span>
                      ) : (
                        <>
                          {backendReady || canAutoInstallBackend ? (
                            <button type="button" onClick={(e) => { e.stopPropagation(); void loadLocalModel(entry); }} disabled={busyAction !== null} className={buttonClassName}>
                              {isBusy && busyAction?.kind === "load" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Cpu className="h-3.5 w-3.5" />}
                              Load
                            </button>
                          ) : (
                            <button type="button" onClick={(e) => { e.stopPropagation(); void installBackend(entry.backend); }} disabled={busyAction !== null} className={buttonClassName}>
                              {isInstallingBackend ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                              {backendInstallActionLabel(entry.backend)}
                            </button>
                          )}
                          <button type="button" onClick={(e) => { e.stopPropagation(); void runAction({ kind: "delete", target: entry.name }, () => invoke("delete_rnn_model", { modelName: entry.name }), `Deleted ${entry.display_name || entry.name}.`); }} disabled={busyAction !== null} className={clsx(buttonClassName, "text-red-500")}>
                            {isBusy && busyAction?.kind === "delete" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                          </button>
                        </>
                      )}
                    </div>
                  </summary>
                  <div className="px-3 pb-3 pt-1 pl-8 border-t border-[var(--border-subtle)] bg-[var(--bg-secondary)]/50">
                    <div className="text-xs text-[var(--text-secondary)] space-y-1">
                      <div>
                        {[
                          formatBackend(entry.backend),
                          formatArchitecture(entry.architecture),
                          formatSize(entry.size_gb),
                          entry.thinking ? "Thinking" : null,
                          sourceCatalogEntry?.hf_repo ? formatProvider(sourceCatalogEntry.hf_repo) : null,
                        ].filter(Boolean).join(" · ") || entry.filename}
                      </div>
                      {entry.description ? <div>{entry.description}</div> : null}
                      {fit.loadBlocked && fit.loadBlockReason ? (
                        <div className="text-red-600">{fit.loadBlockReason}</div>
                      ) : null}
                      {!backendReady && backendRequirement ? (
                        <div className="text-amber-600">
                          {backendRequirement}
                          {!canAutoInstallBackend ? ". Use the install button above." : "."}
                        </div>
                      ) : null}
                    </div>
                  </div>
                </details>
              );
            })}
          </div>
        ) : (
          <div className="py-2 text-xs text-[var(--text-secondary)]">
            No models downloaded yet. Browse available models below to get started.
          </div>
        )}
      </div>

      {activeDownloadState ? (
        <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-panel)]/50 p-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[13px] font-semibold text-[var(--text-primary)]">
                Downloading {activeDownloadState.modelName || "model"}
              </div>
              <div className="mt-1 text-xs text-[var(--text-secondary)]">
                {downloadProgressSummary(activeDownloadState)}
                {downloadProgressDetail(activeDownloadState)
                  ? ` • ${downloadProgressDetail(activeDownloadState)}`
                  : ""}
              </div>
            </div>
            <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-[var(--system-blue)]">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Live
            </span>
          </div>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-[var(--border-subtle)]">
            <div
              className="h-full rounded-full bg-[var(--system-blue)] transition-all"
              style={{ width: downloadProgressBarWidth(activeDownloadState) }}
            />
          </div>
        </div>
      ) : null}

      {lowMemoryGgufNotice ? (
        <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-3 text-xs text-red-700">
          This machine reports {hostMemoryTotalGb?.toFixed(1)} GB of RAM and GGUF context is set to{" "}
          {persistedLlamaCppConfig.nCtx.toLocaleString()}.
          Lower <span className="font-medium">Context size</span> under{" "}
          <span className="font-medium">GGUF Runtime Tuning</span> before loading larger GGUF models.
        </div>
      ) : null}

      {recommendedModels.length ? (
        <div className="space-y-1 pt-3 border-t border-[var(--border-subtle)]">
          <div className="text-[13px] font-semibold text-[var(--text-primary)]">
            Recommended
          </div>
          <div className="grid gap-2 grid-cols-3">
            {recommendedModels.map((item) => {
              const localEntry = localByCatalogId.get(item.entry.id);
              const isLoaded =
                snapshot?.loadedModel === localEntry?.name ||
                item.entry.loaded === true ||
                localEntry?.loaded === true;
              const activeDownload =
                snapshot?.downloadState?.catalogId === item.entry.id ? snapshot.downloadState : null;
              const isDownloading = activeDownload?.status === "downloading";
              const isPreparingDownload =
                busyAction?.kind === "download" && busyAction.target === item.entry.id && !isDownloading;
              const progressSummary = downloadProgressSummary(activeDownload);
              const progressDetail = downloadProgressDetail(activeDownload);
              const backendRequirement = backendLoadRequirementLabel(item.entry.backend);
              const normalizedBackend = (item.entry.backend || "").trim().toLowerCase();
              const canAutoInstallBackend = backendAutoInstallsOnFirstUse(item.entry.backend);
              const isInstallingBackend =
                busyAction?.kind === "install-backend" && busyAction.target === normalizedBackend;
              return (
                <div
                  key={`${item.slot}:${item.entry.id}`}
                  className={clsx(
                    "rounded-xl border p-3 flex flex-col",
                    isLoaded
                      ? "border-emerald-500/30 bg-emerald-500/5"
                      : "border-[var(--border-subtle)] bg-[var(--bg-panel)]/50",
                  )}
                >
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">
                    {RECOMMENDATION_LABELS[item.slot]}
                  </div>
                  <div className="mt-1 text-[13px] font-semibold text-[var(--text-primary)] truncate">
                    {formatCatalogName(item.entry)}
                  </div>
                  <div className="mt-1 text-[11px] text-[var(--text-tertiary)]">
                    {[formatSize(item.entry.size_gb), formatBackend(item.entry.backend)].filter(Boolean).join(" · ")}
                  </div>
                  {item.fit.loadBlocked && item.fit.loadBlockReason ? (
                    <div className="mt-2 text-[11px] font-medium text-red-600">
                      {item.fit.loadBlockReason}
                    </div>
                  ) : null}
                  {!item.backendReady && backendRequirement ? (
                    <div className="mt-2 text-[11px] font-medium text-amber-600">
                      {backendRequirement}
                    </div>
                  ) : null}
                  <div className="mt-auto pt-3">
                    {isLoaded ? (
                      <span className="text-[11px] font-medium text-emerald-600">Active</span>
                    ) : localEntry ? (
                      item.fit.loadBlocked ? (
                        <span
                          className="text-[11px] font-medium text-red-600"
                          title={item.fit.loadBlockReason || undefined}
                        >
                          Load blocked
                        </span>
                      ) : item.backendReady || canAutoInstallBackend ? (
                        <button
                          type="button"
                          onClick={() => void loadLocalModel(localEntry)}
                          disabled={busyAction !== null}
                          className={buttonClassName}
                        >
                          <Cpu className="h-3.5 w-3.5" />
                          Load
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => void installBackend(item.entry.backend)}
                          disabled={busyAction !== null}
                          className={buttonClassName}
                        >
                          {isInstallingBackend ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Download className="h-3.5 w-3.5" />
                          )}
                          {backendInstallActionLabel(item.entry.backend)}
                        </button>
                      )
                    ) : isDownloading ? (
                      <div className="space-y-2">
                        <div className="flex items-center justify-between gap-2 text-[11px]">
                          <span className="inline-flex items-center gap-1.5 font-medium text-[var(--system-blue)]">
                            <Loader2 className="h-3 w-3 animate-spin" />
                            {progressSummary}
                          </span>
                          {progressDetail ? (
                            <span className="text-[var(--text-tertiary)]">{progressDetail}</span>
                          ) : null}
                        </div>
                        <div className="h-1.5 overflow-hidden rounded-full bg-[var(--border-subtle)]">
                          <div
                            className="h-full rounded-full bg-[var(--system-blue)] transition-all"
                            style={{ width: downloadProgressBarWidth(activeDownload) }}
                          />
                        </div>
                      </div>
                    ) : isPreparingDownload ? (
                      <div className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--system-blue)]">
                        <Loader2 className="h-3 w-3 animate-spin" />
                        {pendingDownloadLabel(item.entry.backend, item.backendReady)}
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() =>
                          void startDownload(item.entry.id, formatCatalogName(item.entry), item.entry.backend)
                        }
                        disabled={busyAction !== null || snapshot?.downloadState?.status === "downloading"}
                        className={buttonClassName}
                      >
                        <Download className="h-3.5 w-3.5" />
                        Download
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      <div className="space-y-1 pt-3 border-t border-[var(--border-subtle)]">
        <div className="flex items-center justify-between gap-2">
          <div className="text-[13px] font-semibold text-[var(--text-primary)]">
            Available Models
          </div>
          <div className="text-[11px] text-[var(--text-tertiary)]">
            {catalogEntries.length} · {hardwareSummary}
          </div>
        </div>
        {catalogEntries.length ? (
          <div className="rounded-xl border border-[var(--border-subtle)] divide-y divide-[var(--border-subtle)] overflow-hidden">
            {groupedCatalogEntries.map((familyGroup) => (
              <details
                key={familyGroup.family}
                className="group"
                open={familyGroup.loadedCount > 0 || familyGroup.family === "Nemotron"}
              >
                <summary className="flex items-center justify-between gap-2 px-3 py-2.5 cursor-pointer list-none bg-[var(--bg-panel)]/35">
                  <div className="flex items-center gap-2 min-w-0">
                    <ChevronDown className="w-3 h-3 text-[var(--text-tertiary)] transition-transform group-open:rotate-180 flex-shrink-0" />
                    <span className="text-[13px] font-semibold text-[var(--text-primary)] truncate">
                      {familyGroup.family}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 text-[11px] text-[var(--text-tertiary)]">
                    {familyGroup.loadedCount > 0 ? <span>{familyGroup.loadedCount} active</span> : null}
                    {familyGroup.downloadedCount > 0 ? <span>{familyGroup.downloadedCount} downloaded</span> : null}
                    <span>{familyGroup.series.reduce((sum, series) => sum + series.entries.length, 0)} models</span>
                  </div>
                </summary>
                <div className="border-t border-[var(--border-subtle)] bg-[var(--bg-secondary)]/40">
                  {familyGroup.series.length === 1 ? (
                    <div className="divide-y divide-[var(--border-subtle)] bg-[var(--bg-card)]/35">
                      {familyGroup.series[0].entries.map((entry) =>
                        renderCatalogModelEntry(entry, {
                          summaryPaddingClassName: "px-4",
                          detailPaddingClassName: "px-4",
                        }),
                      )}
                    </div>
                  ) : (
                    familyGroup.series.map((seriesGroup) => (
                      <details
                        key={`${familyGroup.family}:${seriesGroup.series}`}
                        className="group/series border-b border-[var(--border-subtle)] last:border-b-0"
                        open={seriesGroup.loadedCount > 0}
                      >
                        <summary className="flex items-center justify-between gap-2 px-4 py-2 cursor-pointer list-none">
                          <div className="flex items-center gap-2 min-w-0">
                            <ChevronDown className="w-3 h-3 text-[var(--text-tertiary)] transition-transform group-open/series:rotate-180 flex-shrink-0" />
                            <span className="text-[12px] font-medium text-[var(--text-primary)] truncate">
                              {seriesGroup.series}
                            </span>
                          </div>
                          <div className="flex items-center gap-2 text-[11px] text-[var(--text-tertiary)]">
                            {seriesGroup.loadedCount > 0 ? <span>{seriesGroup.loadedCount} active</span> : null}
                            {seriesGroup.downloadedCount > 0 ? <span>{seriesGroup.downloadedCount} downloaded</span> : null}
                            <span>{seriesGroup.entries.length}</span>
                          </div>
                        </summary>
                        <div className="border-t border-[var(--border-subtle)] divide-y divide-[var(--border-subtle)] bg-[var(--bg-card)]/35">
                          {seriesGroup.entries.map((entry) => renderCatalogModelEntry(entry))}
                        </div>
                      </details>
                    ))
                  )}
                </div>
              </details>
            ))}
          </div>
        ) : (
          <div className="py-2 text-xs text-[var(--text-secondary)]">
            No models available yet. Try refreshing.
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-3 pt-3 border-t border-[var(--border-subtle)]">
        <div className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
          <span className={clsx("inline-flex h-1.5 w-1.5 rounded-full", runtimeStatus?.running ? "bg-emerald-500" : "bg-amber-500")} />
          <span>{runtimeStatus?.running ? "Runtime ready" : "Starting"}</span>
          {runtimeStatus?.loadedModel ? (
            <><span className="text-[var(--text-tertiary)]">·</span><span>{loadedModelLabel}</span></>
          ) : null}
          {preferredDevice === "cuda" && effectiveGpuProcessMemoryMiB ? (
            <><span className="text-[var(--text-tertiary)]">·</span><span>VRAM {formatMemory(effectiveGpuProcessMemoryMiB)}</span></>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => void refreshCatalog()}
          disabled={busyAction !== null}
          className={buttonClassName}
        >
          {busyAction?.kind === "refresh" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          Refresh
        </button>
      </div>

      <details className="pt-2 border-t border-[var(--border-subtle)]">
        <summary className="cursor-pointer list-none flex items-center gap-2 text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors">
          <ChevronDown className="w-3.5 h-3.5 transition-transform [details[open]>&]:rotate-180" />
          Advanced
        </summary>
        <div className="mt-3 space-y-4">

      {preferredDevice === "cuda" ? (
        <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-panel)]/40 p-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="text-sm font-medium text-[var(--text-primary)]">Runtime Memory</div>
              <div className="mt-1 text-xs text-[var(--text-secondary)]">
                Live GPU memory for the managed runtime. GGUF models use host GPU process telemetry,
                while torch-based backends fall back to torch memory stats.
              </div>
            </div>
            {effectiveGpuMemorySource ? (
              <span className={badgeClassName}>Source: {effectiveGpuMemorySource}</span>
            ) : null}
          </div>
          <div className="mt-3 grid gap-2 md:grid-cols-4">
            <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)] px-3 py-2">
              <div className="text-[11px] uppercase tracking-[0.12em] text-[var(--text-tertiary)]">
                Current
              </div>
              <div className="mt-1 text-sm font-medium text-[var(--text-primary)]">
                {formatMemory(effectiveGpuProcessMemoryMiB) || "Waiting for sample"}
              </div>
            </div>
            <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)] px-3 py-2">
              <div className="text-[11px] uppercase tracking-[0.12em] text-[var(--text-tertiary)]">
                Peak
              </div>
              <div className="mt-1 text-sm font-medium text-[var(--text-primary)]">
                {formatMemory(memoryHistoryPeakMiB) || "No history"}
              </div>
            </div>
            <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)] px-3 py-2">
              <div className="text-[11px] uppercase tracking-[0.12em] text-[var(--text-tertiary)]">
                GPU Total
              </div>
              <div className="mt-1 text-sm font-medium text-[var(--text-primary)]">
                {formatMemory(gpuMemoryTotalMiB) || gpuMemoryName || "Unavailable"}
              </div>
              {gpuMemoryUtilizationPercent !== null ? (
                <div className="mt-1 text-xs text-[var(--text-secondary)]">
                  {gpuMemoryUtilizationPercent.toFixed(1)}% of observed GPU memory
                </div>
              ) : gpuMemoryName ? (
                <div className="mt-1 text-xs text-[var(--text-secondary)]">{gpuMemoryName}</div>
              ) : null}
            </div>
            <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)] px-3 py-2">
              <div className="text-[11px] uppercase tracking-[0.12em] text-[var(--text-tertiary)]">
                Runtime Config
              </div>
              <div className="mt-1 text-sm font-medium text-[var(--text-primary)]">
                {activeMemoryBackendKey === "llama-cpp"
                  ? `${llamaCppDraft.nCtx.toLocaleString()} ctx • ${llamaCppDraft.nBatch} batch`
                  : loadedModelBackend || "Managed runtime"}
              </div>
              {activeMemoryBackendKey === "llama-cpp" ? (
                <div className="mt-1 text-xs text-[var(--text-secondary)]">
                  GPU layers: {llamaCppDraft.nGpuLayers}
                </div>
              ) : null}
            </div>
          </div>
          <div className="mt-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)] px-3 py-2">
            <div className="flex items-center justify-between gap-3">
              <div className="text-xs font-medium text-[var(--text-primary)]">
                Recent samples
              </div>
              <div className="text-[11px] text-[var(--text-secondary)]">
                Stored locally while you debug this model in Settings
              </div>
            </div>
            {activeModelMemoryHistory.length ? (
              <>
                <div className="mt-3 flex h-14 items-end gap-1">
                  {activeModelMemoryHistory.map((sample) => {
                    const height = Math.max(
                      8,
                      Math.round((sample.usedMiB / memoryChartCeilingMiB) * 100),
                    );
                    return (
                      <div
                        key={`${sample.ts}-${sample.usedMiB}`}
                        className="min-w-0 flex-1 rounded-sm bg-emerald-500/60 transition-opacity hover:opacity-100"
                        style={{ height: `${Math.min(100, height)}%` }}
                        title={`${new Date(sample.ts).toLocaleTimeString()} • ${formatMemory(sample.usedMiB)}`}
                      />
                    );
                  })}
                </div>
                <div className="mt-3 grid gap-1 text-xs text-[var(--text-secondary)] md:grid-cols-2">
                  {activeModelMemoryHistory
                    .slice(-6)
                    .reverse()
                    .map((sample) => (
                      <div
                        key={`sample-${sample.ts}-${sample.usedMiB}`}
                        className="flex items-center justify-between gap-3"
                      >
                        <span>{new Date(sample.ts).toLocaleTimeString()}</span>
                        <span className="font-medium text-[var(--text-primary)]">
                          {formatMemory(sample.usedMiB)}
                        </span>
                      </div>
                    ))}
                </div>
                {memoryHistoryLatest ? (
                  <div className="mt-2 text-[11px] text-[var(--text-secondary)]">
                    Last sample at {new Date(memoryHistoryLatest.ts).toLocaleTimeString()} for{" "}
                    <span className="font-medium text-[var(--text-primary)]">
                      {loadedModelLabel}
                    </span>
                    .
                  </div>
                ) : null}
              </>
            ) : (
              <div className="mt-2 text-xs text-[var(--text-secondary)]">
                No GPU memory samples yet. Load a model and keep this panel open while you chat.
              </div>
            )}
          </div>
        </div>
      ) : null}

      {vllmStatusKnown && !vllmInstalled ? (
        <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-panel)]/40 p-3 text-xs text-[var(--text-secondary)]">
          <div className="font-medium text-[var(--text-primary)]">Transformer Backend</div>
          <div className="mt-1">
            The vLLM backend is not installed yet. Install it to run transformer and Mamba models locally.
          </div>
          <button
            type="button"
            onClick={() =>
              void runAction(
                { kind: "install-backend", target: "vllm" },
                () => invoke("install_rnn_runtime_backend", { backend: "vllm" }),
                "Installed the vLLM backend.",
              )
            }
            disabled={busyAction !== null}
            className={clsx(buttonClassName, "mt-3")}
          >
            {busyAction?.kind === "install-backend" && busyAction.target === "vllm" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Download className="h-3.5 w-3.5" />
            )}
            Install vLLM Backend
          </button>
        </div>
      ) : null}

      {llamaCppStatusKnown && !llamaCppInstalled ? (
        <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-panel)]/40 p-3 text-xs text-[var(--text-secondary)]">
          <div className="font-medium text-[var(--text-primary)]">GGUF Backend</div>
          <div className="mt-1">
            The llama.cpp backend is not installed yet. It will install automatically the first time you download or load a GGUF model, or you can install it now.
          </div>
          <button
            type="button"
            onClick={() =>
              void runAction(
                { kind: "install-backend", target: "llama-cpp" },
                () => invoke("install_rnn_runtime_backend", { backend: "llama-cpp" }),
                "Installed the llama.cpp backend.",
              )
            }
            disabled={busyAction !== null}
            className={clsx(buttonClassName, "mt-3")}
          >
            {busyAction?.kind === "install-backend" && busyAction.target === "llama-cpp" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Download className="h-3.5 w-3.5" />
            )}
            Install llama.cpp Backend
          </button>
        </div>
      ) : null}

      {prismLlamaStatusKnown && !prismLlamaInstalled ? (
        <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-panel)]/40 p-3 text-xs text-[var(--text-secondary)]">
          <div className="font-medium text-[var(--text-primary)]">Prism GGUF Backend</div>
          <div className="mt-1">
            Prism-compressed GGUF models like Bonsai need Prism&apos;s llama.cpp server backend. It will auto-install on first use, or you can install it now.
          </div>
          <button
            type="button"
            onClick={() =>
              void runAction(
                { kind: "install-backend", target: "prism-llama" },
                () => invoke("install_rnn_runtime_backend", { backend: "prism-llama" }),
                "Installed the Prism llama.cpp backend.",
              )
            }
            disabled={busyAction !== null}
            className={clsx(buttonClassName, "mt-3")}
          >
            {busyAction?.kind === "install-backend" && busyAction.target === "prism-llama" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Download className="h-3.5 w-3.5" />
            )}
            Install Prism llama.cpp Backend
          </button>
        </div>
      ) : null}

      {!albatrossStatusKnown ? (
        <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-panel)]/40 p-3 text-xs text-[var(--text-secondary)]">
          <div className="font-medium text-[var(--text-primary)]">RWKV Acceleration</div>
          <div className="mt-1">
            Checking for RWKV acceleration support and CUDA toolchain.
          </div>
        </div>
      ) : !albatrossReady ? (
        <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-panel)]/40 p-3 text-xs text-[var(--text-secondary)]">
          <div className="font-medium text-[var(--text-primary)]">RWKV Acceleration</div>
          <div className="mt-1">
            {albatrossBundled
              ? "RWKV acceleration is bundled but needs a CUDA-capable environment and nvcc toolchain to compile."
              : "RWKV acceleration is not included in this build."}
          </div>
        </div>
      ) : null}

      <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-panel)]/40 p-3">
        <div className="text-sm font-medium text-[var(--text-primary)]">Transformer Runtime Tuning</div>
        <div className="mt-1 text-xs text-[var(--text-secondary)]">
          Settings for the vLLM backend used by transformer models. KV-cache compression reduces memory usage.
        </div>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <label className="space-y-1 text-xs text-[var(--text-secondary)]">
            <div>GPU memory utilization</div>
            <input
              type="number"
              min={0.5}
              max={0.99}
              step={0.01}
              value={vllmDraft.gpuMemoryUtilization}
              onChange={(event) =>
                setVllmDraft((current) => ({
                  ...current,
                  gpuMemoryUtilization: Number(event.target.value || current.gpuMemoryUtilization),
                }))
              }
              className="w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)] px-3 py-2 text-sm text-[var(--text-primary)]"
            />
          </label>
          <label className="space-y-1 text-xs text-[var(--text-secondary)]">
            <div>KV cache compression</div>
            <select
              value={vllmDraft.kvCacheDtype}
              onChange={(event) =>
                setVllmDraft((current) => ({
                  ...current,
                  kvCacheDtype: event.target.value,
                }))
              }
              className="w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)] px-3 py-2 text-sm text-[var(--text-primary)]"
            >
              <option value="auto">Auto</option>
              <option value="fp8">FP8</option>
              <option value="fp8_e4m3">FP8 E4M3</option>
              <option value="fp8_e5m2">FP8 E5M2</option>
            </select>
          </label>
          <label className="space-y-1 text-xs text-[var(--text-secondary)]">
            <div>CPU offload (GB)</div>
            <input
              type="number"
              min={0}
              max={64}
              step={0.5}
              value={vllmDraft.cpuOffloadGb}
              onChange={(event) =>
                setVllmDraft((current) => ({
                  ...current,
                  cpuOffloadGb: Number(event.target.value || 0),
                }))
              }
              className="w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)] px-3 py-2 text-sm text-[var(--text-primary)]"
            />
          </label>
          <label className="space-y-1 text-xs text-[var(--text-secondary)]">
            <div>Swap space (GB)</div>
            <input
              type="number"
              min={0}
              max={64}
              step={1}
              value={vllmDraft.swapSpace}
              onChange={(event) =>
                setVllmDraft((current) => ({
                  ...current,
                  swapSpace: Number(event.target.value || 0),
                }))
              }
              className="w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)] px-3 py-2 text-sm text-[var(--text-primary)]"
            />
          </label>
          <label className="space-y-1 text-xs text-[var(--text-secondary)]">
            <div>Max model length</div>
            <input
              type="number"
              min={1}
              step={256}
              value={vllmDraft.maxModelLen ?? ""}
              onChange={(event) =>
                setVllmDraft((current) => ({
                  ...current,
                  maxModelLen: event.target.value ? Number(event.target.value) : null,
                }))
              }
              placeholder="Auto"
              className="w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)] px-3 py-2 text-sm text-[var(--text-primary)]"
            />
          </label>
        </div>
        <div className="mt-3 grid gap-2 text-xs text-[var(--text-secondary)] md:grid-cols-2">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={vllmDraft.calculateKvScales}
              onChange={(event) =>
                setVllmDraft((current) => ({
                  ...current,
                  calculateKvScales: event.target.checked,
                }))
              }
            />
            <span>Calculate KV scales during warmup</span>
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={vllmDraft.enablePrefixCaching}
              onChange={(event) =>
                setVllmDraft((current) => ({
                  ...current,
                  enablePrefixCaching: event.target.checked,
                }))
              }
            />
            <span>Enable prefix caching</span>
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={vllmDraft.enforceEager}
              onChange={(event) =>
                setVllmDraft((current) => ({
                  ...current,
                  enforceEager: event.target.checked,
                }))
              }
            />
            <span>Force eager execution</span>
          </label>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() =>
              void runAction(
                { kind: "save-config", target: "vllm" },
                () => invoke("update_rnn_runtime_config", { config: { vllm: vllmDraft } }),
                "Saved transformer settings. Reload the model to apply changes.",
              )
            }
            disabled={busyAction !== null || !vllmConfigDirty}
            className={buttonClassName}
          >
            {busyAction?.kind === "save-config" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            Save Transformer Settings
          </button>
          {vllmConfigDirty ? (
            <span className="text-xs text-amber-600">Unsaved changes</span>
          ) : null}
        </div>
      </div>

      <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-panel)]/40 p-3">
        <div className="text-sm font-medium text-[var(--text-primary)]">GGUF Runtime Tuning</div>
        <div className="mt-1 text-xs text-[var(--text-secondary)]">
          Settings for the llama.cpp backend used by GGUF models. Context size is the main RAM lever on 8 GB laptops.
        </div>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <label className="space-y-1 text-xs text-[var(--text-secondary)]">
            <div>GPU layers</div>
            <input
              type="number"
              min={-1}
              step={1}
              value={llamaCppDraft.nGpuLayers}
              onChange={(event) =>
                setLlamaCppDraft((current) => ({
                  ...current,
                  nGpuLayers: Number(event.target.value || current.nGpuLayers),
                }))
              }
              className="w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)] px-3 py-2 text-sm text-[var(--text-primary)]"
            />
          </label>
          <label className="space-y-1 text-xs text-[var(--text-secondary)]">
            <div>Context size</div>
            <input
              type="number"
              min={512}
              step={256}
              value={llamaCppDraft.nCtx}
              onChange={(event) =>
                setLlamaCppDraft((current) => ({
                  ...current,
                  nCtx: Number(event.target.value || current.nCtx),
                }))
              }
              className="w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)] px-3 py-2 text-sm text-[var(--text-primary)]"
            />
          </label>
          <label className="space-y-1 text-xs text-[var(--text-secondary)]">
            <div>Batch size</div>
            <input
              type="number"
              min={32}
              step={32}
              value={llamaCppDraft.nBatch}
              onChange={(event) =>
                setLlamaCppDraft((current) => ({
                  ...current,
                  nBatch: Number(event.target.value || current.nBatch),
                }))
              }
              className="w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)] px-3 py-2 text-sm text-[var(--text-primary)]"
            />
          </label>
          <label className="space-y-1 text-xs text-[var(--text-secondary)]">
            <div>CPU threads</div>
            <input
              type="number"
              min={1}
              step={1}
              value={llamaCppDraft.nThreads ?? ""}
              onChange={(event) =>
                setLlamaCppDraft((current) => ({
                  ...current,
                  nThreads: event.target.value ? Number(event.target.value) : null,
                }))
              }
              placeholder="Auto"
              className="w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)] px-3 py-2 text-sm text-[var(--text-primary)]"
            />
          </label>
        </div>
        <div className="mt-3 grid gap-2 text-xs text-[var(--text-secondary)] md:grid-cols-2">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={llamaCppDraft.flashAttn}
              onChange={(event) =>
                setLlamaCppDraft((current) => ({
                  ...current,
                  flashAttn: event.target.checked,
                }))
              }
            />
            <span>Enable Flash Attention</span>
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={llamaCppDraft.useMmap}
              onChange={(event) =>
                setLlamaCppDraft((current) => ({
                  ...current,
                  useMmap: event.target.checked,
                }))
              }
            />
            <span>Use mmap</span>
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={llamaCppDraft.useMlock}
              onChange={(event) =>
                setLlamaCppDraft((current) => ({
                  ...current,
                  useMlock: event.target.checked,
                }))
              }
            />
            <span>Lock model in memory</span>
          </label>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() =>
              void runAction(
                { kind: "save-config", target: "llama-cpp" },
                () => invoke("update_rnn_runtime_config", { config: { llamaCpp: llamaCppDraft } }),
                "Saved GGUF runtime settings. Reload the managed GGUF model to apply them.",
              )
            }
            disabled={busyAction !== null || !llamaCppConfigDirty}
            className={buttonClassName}
          >
            {busyAction?.kind === "save-config" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            Save GGUF Settings
          </button>
          {llamaCppConfigDirty ? (
            <span className="text-xs text-amber-600">Unsaved changes</span>
          ) : null}
        </div>
      </div>

      {runtimeStatus?.logFile ? (
        <div className="text-xs text-[var(--text-secondary)]">
          Log: <span className="font-mono">{runtimeStatus.logFile}</span>
        </div>
      ) : null}

        </div>
      </details>

      {message ? <div className="text-xs text-green-600">{message}</div> : null}
      {error ? <div className="text-xs text-red-500">{error}</div> : null}
      {!error && snapshot?.lastError ? (
        <div className="text-xs text-amber-600">{snapshot.lastError}</div>
      ) : null}
    </div>
  );
}
