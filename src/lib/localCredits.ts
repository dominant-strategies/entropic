import { invoke } from "@tauri-apps/api/core";
import { nativeApiRequest, shouldUseNativeApiTransport } from "./nativeApi";

const RAW_API_URL = (import.meta as any).env?.VITE_API_URL || "";
const API_URL = RAW_API_URL || ((import.meta as any).env?.DEV ? "/api" : "");
const USE_NATIVE_API_TRANSPORT = shouldUseNativeApiTransport(API_URL);

const FINGERPRINT_HEADER = "X-Entropic-Device-Fingerprint";
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/i;

type ModelPricing = {
  input: number; // cents per 1M input tokens
  output: number; // cents per 1M output tokens
};

export type LocalBalanceResponse = {
  balance_cents: number;
  balance_dollars: string;
  lifetime_free_credits_cents: number;
  is_local_trial: true;
};

export type LocalUsageResponse = {
  period_days: number;
  total_cost_cents: number;
  total_cost_dollars: string;
  total_requests: number;
  by_model: Record<string, { cost: number; requests: number }>;
  is_local_trial: true;
};

const MODEL_PRICING: Record<string, ModelPricing> = {
  "anthropic/claude-sonnet-4-20250514": { input: 360, output: 1800 },
  "anthropic/claude-opus-4-20250514": { input: 1800, output: 9000 },
  "anthropic/claude-opus-4-6": { input: 1800, output: 9000 },
  "anthropic/claude-opus-4-6:thinking": { input: 1800, output: 9000 },
  "openai/gpt-5.4": { input: 300, output: 1200 },
  "openai/gpt-5.3-codex": { input: 300, output: 1200 },
  "openai/gpt-5.2": { input: 300, output: 1200 },
  "openai/gpt-5.2-codex": { input: 300, output: 1200 },
  "openai/gpt-4o": { input: 300, output: 1200 },
  "openai/gpt-4o-mini": { input: 18, output: 72 },
  "google/gemini-3.1-pro-preview": { input: 150, output: 600 },
  "google/gemini-3.1-flash-image-preview": { input: 150, output: 600 },
  "google/gemini-3-pro-image-preview": { input: 150, output: 600 },
  "google/gemini-2.0-flash": { input: 12, output: 48 },
  "google/gemini-2.5-pro": { input: 150, output: 600 },
  "openrouter/free": { input: 5, output: 5 },
};

const DEFAULT_PRICING: ModelPricing = {
  input: 600,
  output: 1800,
};

let fingerprintPromise: Promise<string> | null = null;

function normalizeModelId(model: string): string {
  const trimmed = (model || "").trim();
  if (!trimmed) return "openrouter/free";
  const withoutParams = trimmed.split(":")[0];
  if (withoutParams.startsWith("openrouter/")) {
    const candidate = withoutParams.slice("openrouter/".length);
    if (!candidate.includes("/")) {
      return withoutParams;
    }
    return candidate;
  }
  return withoutParams;
}

function estimateInputTokens(messageContent: string): number {
  return Math.max(1, Math.ceil((messageContent || "").length / 4));
}

function getPricingForModel(model: string): ModelPricing {
  const normalized = normalizeModelId(model);
  return MODEL_PRICING[normalized] || DEFAULT_PRICING;
}

function apiPath(path: string): string {
  if (!API_URL) {
    throw new Error("API URL is not configured for trial requests");
  }
  if (!path.startsWith("/")) {
    return `${API_URL}/${path}`;
  }
  return `${API_URL}${path}`;
}

async function getTrialHeaders(): Promise<Record<string, string>> {
  const fingerprint = await getDeviceFingerprintHash();
  return {
    "Content-Type": "application/json",
    [FINGERPRINT_HEADER]: fingerprint,
  };
}

async function trialRequest<T>(path: string): Promise<T> {
  const headers = await getTrialHeaders();
  if (USE_NATIVE_API_TRANSPORT) {
    const response = await nativeApiRequest({
      method: "GET",
      url: apiPath(path),
      deviceFingerprint: headers[FINGERPRINT_HEADER],
    });
    if (response.status < 200 || response.status >= 300) {
      const serverMessage = response.body?.error?.message;
      const rawMessage = response.body?.raw;
      throw new Error(
        typeof serverMessage === "string" && serverMessage.trim()
          ? serverMessage
          : typeof rawMessage === "string" && rawMessage.trim()
            ? rawMessage
            : `Trial API error: ${response.status}`
      );
    }
    return response.body as T;
  }

  const response = await fetch(apiPath(path), {
    method: "GET",
    headers,
  });

  if (!response.ok) {
    let message = `Trial API error: ${response.status}`;
    try {
      const payload = await response.json();
      const serverMessage = payload?.error?.message;
      if (typeof serverMessage === "string" && serverMessage.trim()) {
        message = serverMessage;
      }
    } catch {
      // ignore parse errors
    }
    throw new Error(message);
  }

  return response.json();
}

export async function getDeviceFingerprintHash(): Promise<string> {
  if (!fingerprintPromise) {
    fingerprintPromise = invoke<string>("get_device_fingerprint_hash").then((value) => {
      const normalized = (value || "").trim().toLowerCase();
      if (!FINGERPRINT_PATTERN.test(normalized)) {
        throw new Error("Invalid device fingerprint hash");
      }
      return normalized;
    });
  }
  return fingerprintPromise;
}

// Backward-compatible alias used by auth token creation.
export async function getAnonymousClientId(): Promise<string> {
  return getDeviceFingerprintHash();
}

export function estimateLocalMessageCostCents(model: string, messageContent: string): number {
  const pricing = getPricingForModel(model);
  const inputTokens = estimateInputTokens(messageContent);
  const estimatedOutputTokens = 500;
  const inputCost = (inputTokens / 1_000_000) * pricing.input;
  const outputCost = (estimatedOutputTokens / 1_000_000) * pricing.output;
  return Math.max(1, Math.ceil(inputCost + outputCost));
}

export async function getLocalCreditsRemainingCents(): Promise<number> {
  const balance = await getLocalCreditBalance();
  return balance.balance_cents;
}

export async function hasLocalCredits(requiredCents = 1): Promise<boolean> {
  const balance = await getLocalCreditsRemainingCents();
  return balance >= Math.max(1, Math.floor(requiredCents));
}

export async function getLocalCreditBalance(): Promise<LocalBalanceResponse> {
  return trialRequest<LocalBalanceResponse>("/trial/balance");
}

export async function getLocalUsageSummary(days = 30): Promise<LocalUsageResponse> {
  const bounded = Math.min(90, Math.max(1, Math.floor(days || 30)));
  return trialRequest<LocalUsageResponse>(`/trial/usage?days=${bounded}`);
}

// Kept for compatibility with current chat flow; no client-side deduction is performed.
export async function consumeLocalCreditsForMessage(
  model: string,
  messageContent: string
): Promise<{ ok: boolean; costCents: number; balanceCents: number }> {
  const balance = await getLocalCreditBalance();
  const costCents = estimateLocalMessageCostCents(model, messageContent);
  return {
    ok: balance.balance_cents > 0,
    costCents,
    balanceCents: balance.balance_cents,
  };
}
