import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
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

type RuntimeMemorySample = {
  ts: number;
  model: string;
  backend: string | null;
  source: string;
  usedMiB: number;
  totalMiB?: number | null;
};

const MANAGED_RUNTIME_MEMORY_HISTORY_KEY = "entropic.managed-runtime.memory-history";
const MAX_MANAGED_RUNTIME_MEMORY_SAMPLES = 90;

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

function formatBackend(value?: string | null): string | null {
  const normalized = (value || "").trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "rwkv") return "RWKV";
  if (normalized === "mamba") return "Mamba";
  if (normalized === "huggingface") return "Hugging Face";
  if (normalized === "albatross") return "Albatross";
  if (normalized === "llama-cpp") return "llama.cpp";
  return normalized.toUpperCase();
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
  if (normalized === "state-spaces") return "state-spaces";
  if (normalized === "shoumenchougou") return "shoumenchougou";
  return owner;
}

function catalogFamily(entry: Pick<RnnCatalogEntry, "name" | "display_name" | "architecture">): string {
  const haystack = `${entry.display_name || ""} ${entry.name || ""}`.trim().toLowerCase();
  const architecture = (entry.architecture || "").trim().toLowerCase();
  if (haystack.includes("goose")) return "Goose";
  if (haystack.includes("nemotron")) return "Nemotron";
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
  if (haystack.includes("nemotron 3")) return "Nemotron 3";
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
    nCtx: typeof value?.nCtx === "number" && value.nCtx > 0 ? value.nCtx : 32768,
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

  async function startDownload(catalogId: string, label: string) {
    setBusyAction({ kind: "download", target: catalogId });
    setError(null);
    setMessage(`Starting download for ${label}...`);
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

  async function runAction(
    nextBusyAction: NonNullable<BusyAction>,
    request: () => Promise<any>,
    successMessage: string,
  ) {
    setBusyAction(nextBusyAction);
    setError(null);
    setMessage(null);
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
    runtimeStatus?.activeBackend || loadedLocalEntry?.backend || loadedCatalogEntry?.backend || null;
  const persistedVllmConfig = normalizeVllmRuntimeConfig(runtimeStatus?.runtimeConfig?.vllm);
  const vllmConfigDirty =
    JSON.stringify(vllmDraft) !== JSON.stringify(persistedVllmConfig);
  const persistedLlamaCppConfig = normalizeLlamaCppRuntimeConfig(
    runtimeStatus?.runtimeConfig?.llamaCpp,
  );
  const llamaCppConfigDirty =
    JSON.stringify(llamaCppDraft) !== JSON.stringify(persistedLlamaCppConfig);
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

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <div className="text-[13px] font-semibold text-[var(--text-primary)]">
          Downloaded Models
        </div>
        {snapshot?.local.length ? (
          <div className="divide-y divide-[var(--border-subtle)]">
            {sortedLocalEntries.map((entry) => {
              const isLoaded = snapshot.loadedModel === entry.name || entry.loaded === true;
              const isBusy =
                busyAction?.kind !== "refresh" && busyAction?.target === entry.name;
              const sourceCatalogEntry =
                (entry.catalog_id
                  ? catalogEntries.find((candidate) => candidate.id === entry.catalog_id)
                  : null) || null;
              return (
                <div
                  key={entry.name}
                  className={clsx(
                    "flex flex-wrap items-start justify-between gap-3 rounded-xl px-2 py-2.5",
                    isLoaded && "border border-emerald-500/30 bg-emerald-500/8",
                  )}
                >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <div
                          className={clsx(
                            "text-sm font-medium",
                            isLoaded ? "text-emerald-700" : "text-[var(--text-primary)]",
                          )}
                        >
                          {entry.display_name || entry.name}
                        </div>
                        {isLoaded ? (
                          <span className="inline-flex items-center rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">
                            Loaded
                          </span>
                        ) : null}
                        {entry.thinking ? <span className={badgeClassName}>Thinking</span> : null}
                        {sourceCatalogEntry?.hf_repo ? (
                          <span className={badgeClassName}>
                            {formatProvider(sourceCatalogEntry.hf_repo)}
                          </span>
                        ) : null}
                      </div>
                      <div className="mt-1 text-xs text-[var(--text-secondary)]">
                        {[
                          formatBackend(entry.backend),
                          formatArchitecture(entry.architecture),
                          formatSize(entry.size_gb),
                        ]
                          .filter(Boolean)
                          .join(" • ") || entry.filename}
                      </div>
                      {entry.description ? (
                        <div className="mt-1 text-xs text-[var(--text-secondary)]">
                          {entry.description}
                        </div>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() =>
                          void runAction(
                            { kind: "load", target: entry.name },
                            () => invoke("load_rnn_model", { modelName: entry.name }),
                            `Loaded ${entry.display_name || entry.name}.`,
                          )
                        }
                        disabled={busyAction !== null}
                        className={buttonClassName}
                      >
                        {isBusy && busyAction?.kind === "load" ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Cpu className="h-3.5 w-3.5" />
                        )}
                        Load
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          void runAction(
                            { kind: "warm", target: entry.name },
                            () => invoke("warm_rnn_model", { modelName: entry.name }),
                            `Warmed ${entry.display_name || entry.name}.`,
                          )
                        }
                        disabled={busyAction !== null}
                        className={buttonClassName}
                      >
                        {isBusy && busyAction?.kind === "warm" ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Flame className="h-3.5 w-3.5" />
                        )}
                        Warm
                      </button>
                      {isLoaded ? (
                        <button
                          type="button"
                          onClick={() =>
                            void runAction(
                              { kind: "unload" },
                              () => invoke("unload_rnn_model"),
                              `Unloaded ${entry.display_name || entry.name}.`,
                            )
                          }
                          disabled={busyAction !== null}
                          className={buttonClassName}
                        >
                          {busyAction?.kind === "unload" ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Square className="h-3.5 w-3.5" />
                          )}
                          Unload
                        </button>
                      ) : null}
                      <button
                        type="button"
                        onClick={() =>
                          void runAction(
                            { kind: "delete", target: entry.name },
                            () => invoke("delete_rnn_model", { modelName: entry.name }),
                            `Deleted ${entry.display_name || entry.name}.`,
                          )
                        }
                        disabled={busyAction !== null}
                        className={clsx(buttonClassName, "text-red-500")}
                      >
                        {isBusy && busyAction?.kind === "delete" ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Trash2 className="h-3.5 w-3.5" />
                        )}
                        Delete
                      </button>
                    </div>
                  </div>
              );
            })}
          </div>
        ) : (
          <div className="py-2 text-xs text-[var(--text-secondary)]">
            No models downloaded yet. Browse available models below to get started.
          </div>
        )}
      </div>

      <div className="space-y-2 pt-3 border-t border-[var(--border-subtle)]">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-[13px] font-semibold text-[var(--text-primary)]">
            Available Models
          </div>
          <div className="text-xs text-[var(--text-secondary)]">
            {catalogEntries.length} model{catalogEntries.length === 1 ? "" : "s"}
          </div>
        </div>
        <div className="space-y-2">
          {catalogFamilyGroups.map((group) => (
            <details
              key={group.family}
              open={group.loadedCount > 0 || group.downloadedCount > 0}
              className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-panel)]/30"
            >
              <summary className="cursor-pointer list-none px-3 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-[var(--text-primary)]">
                      {group.family}
                    </span>
                    <span className={badgeClassName}>
                      {group.series.reduce((sum, seriesGroup) => sum + seriesGroup.entries.length, 0)} model
                      {group.series.reduce((sum, seriesGroup) => sum + seriesGroup.entries.length, 0) === 1
                        ? ""
                        : "s"}
                    </span>
                    {group.loadedCount > 0 ? (
                      <span className={badgeClassName}>{group.loadedCount} loaded</span>
                    ) : null}
                    {group.downloadedCount > 0 ? (
                      <span className={badgeClassName}>{group.downloadedCount} downloaded</span>
                    ) : null}
                  </div>
                </div>
              </summary>
              <div className="border-t border-[var(--border-subtle)]">
                {group.series.map((seriesGroup) => (
                  <div key={`${group.family}-${seriesGroup.series}`}>
                    {group.series.length > 1 && (
                      <div className="px-3 pt-3 pb-1 text-[11px] font-medium text-[var(--text-tertiary)]">
                        {seriesGroup.series}
                        {seriesGroup.downloadedCount > 0 || seriesGroup.loadedCount > 0 ? (
                          <span className="ml-2 font-normal text-[var(--text-secondary)]">
                            {seriesGroup.loadedCount > 0 ? `${seriesGroup.loadedCount} loaded` : `${seriesGroup.downloadedCount} downloaded`}
                          </span>
                        ) : null}
                      </div>
                    )}
                    {seriesGroup.entries.map((entry) => {
                        const localEntry = localByCatalogId.get(entry.id);
                        const targetName = localEntry?.name || entry.id;
                        const isBusy = busyAction?.kind !== "refresh" && busyAction?.target === targetName;
                        const activeDownload =
                          snapshot?.downloadState?.catalogId === entry.id ? snapshot.downloadState : null;
                        const isDownloading = activeDownload?.status === "downloading";
                        const isLoaded =
                          snapshot?.loadedModel === localEntry?.name || entry.loaded === true || localEntry?.loaded === true;
                        const progressLabel = isDownloading
                          ? [
                              formatBytes(activeDownload.downloadedBytes),
                              activeDownload.totalBytes ? `of ${formatBytes(activeDownload.totalBytes)}` : null,
                              typeof activeDownload.progressPercent === "number"
                                ? `${activeDownload.progressPercent.toFixed(
                                    activeDownload.progressPercent >= 10 ? 0 : 1,
                                  )}%`
                                : null,
                            ]
                              .filter(Boolean)
                              .join(" • ")
                          : null;
                        return (
                          <div
                            key={entry.id}
                            className="flex flex-wrap items-start justify-between gap-3 px-3 py-2.5"
                          >
                              <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-2">
                                  <div className="text-sm font-medium text-[var(--text-primary)]">
                                    {entry.display_name || entry.name}
                                  </div>
                                  {entry.params ? <span className={badgeClassName}>{entry.params}</span> : null}
                                  {entry.thinking ? <span className={badgeClassName}>Thinking</span> : null}
                                  {entry.hf_repo ? (
                                    <span className={badgeClassName}>
                                      {formatProvider(entry.hf_repo)}
                                    </span>
                                  ) : null}
                                  {isLoaded ? (
                                    <span className={badgeClassName}>Loaded</span>
                                  ) : localEntry ? (
                                    <span className={badgeClassName}>Downloaded</span>
                                  ) : null}
                                </div>
                                <div className="mt-1 text-xs text-[var(--text-secondary)]">
                                  {[
                                    catalogCategory(entry),
                                    formatBackend(entry.backend),
                                    formatArchitecture(entry.architecture),
                                    formatSize(entry.size_gb),
                                  ]
                                    .filter(Boolean)
                                    .join(" • ")}
                                </div>
                                {entry.description ? (
                                  <div className="mt-1 text-xs text-[var(--text-secondary)]">
                                    {entry.description}
                                  </div>
                                ) : null}
                                {isDownloading ? (
                                  <div className="mt-3 space-y-1">
                                    <div className="flex items-center justify-between gap-2 text-[11px] text-[var(--text-secondary)]">
                                      <span>Downloading…</span>
                                      {progressLabel ? <span>{progressLabel}</span> : null}
                                    </div>
                                    <div className="h-1.5 overflow-hidden rounded-full bg-[var(--border-subtle)]">
                                      <div
                                        className="h-full rounded-full bg-[var(--system-blue)] transition-all"
                                        style={{
                                          width:
                                            typeof activeDownload?.progressPercent === "number"
                                              ? `${Math.max(4, Math.min(100, activeDownload.progressPercent))}%`
                                              : "20%",
                                        }}
                                      />
                                    </div>
                                  </div>
                                ) : null}
                              </div>
                              <div className="flex flex-wrap items-center gap-2">
                                {localEntry ? (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      void runAction(
                                        { kind: "load", target: localEntry.name },
                                        () => invoke("load_rnn_model", { modelName: localEntry.name }),
                                        `Loaded ${localEntry.display_name || localEntry.name}.`,
                                      )
                                    }
                                    disabled={busyAction !== null}
                                    className={buttonClassName}
                                  >
                                    {isBusy && busyAction?.kind === "load" ? (
                                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                    ) : (
                                      <Cpu className="h-3.5 w-3.5" />
                                    )}
                                    Load
                                  </button>
                                ) : (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      void startDownload(entry.id, entry.display_name || entry.name)
                                    }
                                    disabled={busyAction !== null || snapshot?.downloadState?.status === "downloading"}
                                    className={buttonClassName}
                                  >
                                    {isDownloading || (isBusy && busyAction?.kind === "download") ? (
                                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                    ) : (
                                      <Download className="h-3.5 w-3.5" />
                                    )}
                                    {isDownloading ? "Downloading" : "Download"}
                                  </button>
                                )}
                              </div>
                          </div>
                        );
                      })}
                  </div>
                ))}
              </div>
            </details>
          ))}
          {!catalogEntries.length ? (
            <div className="rounded-xl border border-dashed border-[var(--border-subtle)] p-3 text-xs text-[var(--text-secondary)]">
              No models available yet. Try refreshing.
            </div>
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap items-start justify-between gap-3 pt-3 border-t border-[var(--border-subtle)]">
        <div>
          <div className="flex items-center gap-2 text-sm font-medium text-[var(--text-primary)]">
            <span className="flex h-7 w-7 items-center justify-center rounded-md bg-[var(--system-blue)]/10 text-[var(--system-blue)]">
              <Cpu className="h-4 w-4" />
            </span>
            <span>Local Runtime</span>
          </div>
          <div className="mt-1 text-xs text-[var(--text-secondary)]">
            Entropic manages your local model runtime and cache. Supports RWKV, transformer, and GGUF formats.
          </div>
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

      <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--text-secondary)]">
        <span className={badgeClassName}>
          {runtimeStatus?.running ? "Runtime ready" : "Runtime starting"}
        </span>
        <span className={badgeClassName}>{accelerationBadge}</span>
        <span className={badgeClassName}>{deviceBadge}</span>
        {runtimeStatus?.activeBackend ? (
          <span className={badgeClassName}>Backend: {formatBackend(runtimeStatus.activeBackend)}</span>
        ) : null}
        {runtimeStatus?.loadedModel ? (
          <span className={badgeClassName}>Loaded: {loadedModelLabel}</span>
        ) : runtimeStatus?.running ? (
          <span className={badgeClassName}>No model loaded</span>
        ) : null}
        {runtimeStatus?.pid ? <span className={badgeClassName}>PID {runtimeStatus.pid}</span> : null}
        {preferredDevice === "cuda" && effectiveGpuProcessMemoryMiB ? (
          <span className={badgeClassName}>
            VRAM: {formatMemory(effectiveGpuProcessMemoryMiB)}
          </span>
        ) : null}
      </div>

      <div className="grid gap-2 md:grid-cols-3">
        <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-panel)]/40 p-3">
          <div className="text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--text-tertiary)]">
            Active Model
          </div>
          <div className="mt-2 text-sm font-medium text-[var(--text-primary)]">
            {loadedModelLabel}
          </div>
          <div className="mt-1 text-xs text-[var(--text-secondary)]">
            {[loadedModelBackend, formatSize(loadedModelSize || undefined)]
              .filter(Boolean)
              .join(" • ") || "No model loaded"}
          </div>
          {loadedModelLoadTime ? (
            <div className="mt-1 text-xs text-[var(--text-secondary)]">
              Last load time: {loadedModelLoadTime.toFixed(2)}s
            </div>
          ) : null}
        </div>
        <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-panel)]/40 p-3">
          <div className="text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--text-tertiary)]">
            Model Cache
          </div>
          <div className="mt-2 text-sm font-medium text-[var(--text-primary)]">
            {downloadedCount} downloaded • {formatSize(totalLocalSizeGb) || "0 GB"}
          </div>
          <div className="mt-1 text-xs text-[var(--text-secondary)]">
            {localBreakdown || "No cached models yet"}
          </div>
          <div className="mt-1 break-all text-xs text-[var(--text-secondary)]">
            {runtimeStatus?.modelsDir}
          </div>
        </div>
        <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-panel)]/40 p-3">
          <div className="text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--text-tertiary)]">
            Catalog
          </div>
          <div className="mt-2 text-sm font-medium text-[var(--text-primary)]">
            {catalogEntries.length} models
          </div>
          <div className="mt-1 text-xs text-[var(--text-secondary)]">
            Grouped by family first, then series, so you can drill into the catalog instead of
            scanning one flat list.
          </div>
          {snapshot?.downloadState?.status === "downloading" ? (
            <div className="mt-1 text-xs text-[var(--text-secondary)]">
              Downloading {snapshot.downloadState.modelName || "model"}…
            </div>
          ) : null}
        </div>
      </div>

      <div className="grid gap-2 text-xs text-[var(--text-secondary)] md:grid-cols-2">
        {runtimeStatus?.pythonCommand ? (
          <div>
            Python:{" "}
            <span className="font-medium text-[var(--text-primary)]">{runtimeStatus.pythonCommand}</span>
          </div>
        ) : null}
        {runtimeStatus?.capabilities?.torchAvailable !== undefined ? (
          <div>
            Runtime stack:{" "}
            <span className="font-medium text-[var(--text-primary)]">
              {runtimeStatus.capabilities.torchAvailable
                ? `torch${runtimeStatus.capabilities.torchVersion ? ` ${runtimeStatus.capabilities.torchVersion}` : ""}`
                : "torch not detected"}
            </span>
          </div>
        ) : null}
        {runtimeStatus?.capabilities?.supportedBackends?.length ? (
          <div>
            Backends:{" "}
            <span className="font-medium text-[var(--text-primary)]">
              {runtimeStatus.capabilities.supportedBackends.map((value) => formatBackend(value) || value).join(", ")}
            </span>
          </div>
        ) : null}
        {preferredDevice === "cuda" ? (
          <div>
            CUDA compiler:{" "}
            <span className="font-medium text-[var(--text-primary)]">
              {nvccPath || "not detected"}
            </span>
          </div>
        ) : null}
        {preferredDevice === "cuda" ? (
          <div>
            Process GPU memory:{" "}
            <span className="font-medium text-[var(--text-primary)]">
              {effectiveGpuProcessMemoryMiB
                ? formatMemory(effectiveGpuProcessMemoryMiB)
                : "not observed yet"}
              {effectiveGpuMemorySource ? ` • ${effectiveGpuMemorySource}` : ""}
              {!processGpuMemoryMiB && currentCudaReservedMiB > currentCudaAllocatedMiB
                ? ` • ${formatMemory(currentCudaReservedMiB)} reserved`
                : ""}
            </span>
          </div>
        ) : null}
      </div>

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
            {busyAction?.kind === "install-backend" ? (
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
            The llama.cpp backend is not installed yet. Install it to run GGUF models like Nemotron Nano.
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
            {busyAction?.kind === "install-backend" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Download className="h-3.5 w-3.5" />
            )}
            Install llama.cpp Backend
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
          Settings for the llama.cpp backend used by GGUF models.
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

      {message ? <div className="text-xs text-green-600">{message}</div> : null}
      {error ? <div className="text-xs text-red-500">{error}</div> : null}
      {!error && snapshot?.lastError ? (
        <div className="text-xs text-amber-600">{snapshot.lastError}</div>
      ) : null}
    </div>
  );
}
