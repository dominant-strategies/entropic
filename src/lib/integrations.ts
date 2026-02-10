import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-shell";
import { Store } from "@tauri-apps/plugin-store";
import { createGatewayClient } from "./gateway";
import { getGatewayStatusCached } from "./gateway-status";
import { apiRequest } from "./auth";
import {
  loadIntegrationSecret,
  saveIntegrationSecret,
  removeIntegrationSecret,
  listIntegrationSecrets,
  listIntegrationIndexCache,
} from "./vault";

const INTEGRATION_STORE = "nova-integrations.json";
const DEFAULT_GATEWAY_URL = "ws://127.0.0.1:19789";
const GATEWAY_TOKEN = "nova-local-gateway";
const INTEGRATIONS_REDIRECT_URL =
  (import.meta as any).env?.VITE_INTEGRATIONS_REDIRECT_URL ||
  "nova://integrations/success";

const OPENCLAW_SYNC_PROVIDERS = new Set<IntegrationProvider>([
  "google_calendar",
  "google_email",
]);

const INTEGRATIONS_CACHE_TTL_MS = 30_000;
let integrationsCache: { ts: number; data: Integration[] } | null = null;
let integrationsCachedIndex: { ts: number; data: Integration[] } | null = null;

export type IntegrationProvider = "google_calendar" | "google_email" | "x";

export interface Integration {
  provider: IntegrationProvider;
  connected: boolean;
  email?: string;
  scopes: string[];
  stale?: boolean;
}

type StoredIntegration = {
  provider: IntegrationProvider;
  access_token: string;
  refresh_token?: string | null;
  token_type?: string | null;
  expires_at?: number | null;
  scopes?: string[];
  email?: string | null;
  provider_user_id?: string | null;
  metadata?: Record<string, unknown>;
};

export type IntegrationTokenBundle = {
  provider: IntegrationProvider;
  access_token: string;
  token_type?: string | null;
  expires_at?: number | null;
  scopes?: string[];
  provider_email?: string | null;
  provider_user_id?: string | null;
  metadata?: Record<string, unknown>;
};

type OAuthExchangeResponse = {
  access_token: string;
  refresh_token: string;
  token_type?: string;
  expires_at: number;
  scopes?: string[];
  email?: string | null;
  provider_user_id?: string | null;
  metadata?: Record<string, unknown>;
};

type RefreshResponse = {
  access_token: string;
  expires_at: number;
  token_type?: string;
};

function isExpiringSoon(expiresAt?: number | null): boolean {
  if (!expiresAt || !Number.isFinite(expiresAt)) return false;
  return expiresAt - Date.now() <= 5 * 60 * 1000;
}

async function loadPendingImports(): Promise<Record<string, IntegrationTokenBundle>> {
  const store = await Store.load(INTEGRATION_STORE);
  const pending = (await store.get("pendingImports")) as Record<
    string,
    IntegrationTokenBundle
  > | null;
  return pending || {};
}

async function savePendingImports(pending: Record<string, IntegrationTokenBundle>) {
  const store = await Store.load(INTEGRATION_STORE);
  await store.set("pendingImports", pending);
  await store.save();
}

export async function queueIntegrationImport(bundle: IntegrationTokenBundle) {
  const pending = await loadPendingImports();
  pending[bundle.provider] = bundle;
  await savePendingImports(pending);
}

export async function clearPendingImport(provider: IntegrationProvider) {
  const pending = await loadPendingImports();
  if (pending[provider]) {
    delete pending[provider];
    await savePendingImports(pending);
  }
}

export async function getIntegrations(opts?: { force?: boolean }): Promise<Integration[]> {
  const now = Date.now();
  if (!opts?.force && integrationsCache && now - integrationsCache.ts < INTEGRATIONS_CACHE_TTL_MS) {
    return integrationsCache.data;
  }
  const records = await listIntegrationSecrets<StoredIntegration>();
  const local: Integration[] = records.map((record) => ({
    provider: record.provider,
    connected: Boolean(record.access_token),
    stale: !record.access_token,
    email: record.email ?? undefined,
    scopes: record.scopes ?? [],
  }));
  try {
    const xStatus = await getXIntegrationStatus();
    if (xStatus) {
      local.push({ ...xStatus, stale: xStatus.stale ?? false });
    }
  } catch (err) {
    console.warn("Failed to load X integration status:", err);
  }
  integrationsCache = { ts: now, data: local };
  return local;
}

export async function getIntegrationsCached(opts?: { force?: boolean }): Promise<Integration[]> {
  const now = Date.now();
  if (!opts?.force && integrationsCachedIndex && now - integrationsCachedIndex.ts < INTEGRATIONS_CACHE_TTL_MS) {
    return integrationsCachedIndex.data;
  }
  const cached = await listIntegrationIndexCache();
  const mapped = cached.map((record) => ({
    provider: record.provider as IntegrationProvider,
    connected: true,
    stale: true,
    email: record.email ?? undefined,
    scopes: record.scopes ?? [],
  }));
  integrationsCachedIndex = { ts: now, data: mapped };
  return mapped;
}

export async function isIntegrationConnected(provider: IntegrationProvider): Promise<boolean> {
  const record = await loadIntegrationSecret<StoredIntegration>(provider);
  return Boolean(record?.access_token);
}

export async function connectIntegration(provider: IntegrationProvider): Promise<void> {
  if (provider === "x") {
    const result = await apiRequest<{ url: string }>("/x/oauth/start", {
      method: "POST",
      body: JSON.stringify({ redirect_uri: INTEGRATIONS_REDIRECT_URL }),
    });
    if (result?.url) {
      await open(result.url);
    }
    return;
  }

  const result = await invoke<OAuthExchangeResponse>("start_google_oauth", { provider });
  const record: StoredIntegration = {
    provider,
    access_token: result.access_token,
    refresh_token: result.refresh_token,
    token_type: result.token_type ?? "Bearer",
    expires_at: result.expires_at,
    scopes: result.scopes ?? [],
    email: result.email ?? null,
    provider_user_id: result.provider_user_id ?? null,
    metadata: result.metadata ?? {},
  };
  await saveIntegrationSecret(provider, record);
  integrationsCache = null;
  integrationsCachedIndex = null;
  window.dispatchEvent(new Event("nova-integration-updated"));
  // Sync in the background so the UI can update immediately.
  syncIntegrationToGateway(provider).catch((err) => {
    console.warn(`Failed to sync ${provider} after connect:`, err);
  });
}

export async function disconnectIntegration(provider: IntegrationProvider): Promise<void> {
  if (provider === "x") {
    await apiRequest("/x/oauth/disconnect", { method: "POST" });
    integrationsCache = null;
    integrationsCachedIndex = null;
    window.dispatchEvent(new Event("nova-integration-updated"));
    return;
  }
  await removeIntegrationSecret(provider);
  integrationsCache = null;
  integrationsCachedIndex = null;
  window.dispatchEvent(new Event("nova-integration-updated"));
}

async function getXIntegrationStatus(): Promise<Integration | null> {
  const data = await apiRequest<{
    connected: boolean;
    username?: string | null;
    expires_at?: string | null;
    scopes?: string[] | null;
  }>("/x/oauth/status");
  if (!data?.connected) {
    return null;
  }
  return {
    provider: "x",
    connected: true,
    stale: false,
    email: data.username ? `@${data.username}` : undefined,
    scopes: data.scopes ?? [],
  };
}

async function refreshIntegration(record: StoredIntegration): Promise<StoredIntegration> {
  if (!record.refresh_token) {
    throw new Error("Missing refresh token");
  }
  const refreshed = await invoke<RefreshResponse>("refresh_google_token", {
    provider: record.provider,
    refreshToken: record.refresh_token,
  });
  const updated: StoredIntegration = {
    ...record,
    access_token: refreshed.access_token,
    expires_at: refreshed.expires_at,
    token_type: refreshed.token_type ?? record.token_type ?? "Bearer",
  };
  await saveIntegrationSecret(record.provider, updated);
  return updated;
}

export async function getIntegrationAccessToken(provider: IntegrationProvider): Promise<string> {
  const record = await loadIntegrationSecret<StoredIntegration>(provider);
  if (!record?.access_token) {
    throw new Error("Integration not connected");
  }
  const updated = isExpiringSoon(record.expires_at)
    ? await refreshIntegration(record)
    : record;
  return updated.access_token;
}

export async function exportIntegrationTokenBundle(
  provider: IntegrationProvider
): Promise<IntegrationTokenBundle> {
  const record = await loadIntegrationSecret<StoredIntegration>(provider);
  if (!record?.access_token) {
    throw new Error("Integration not connected");
  }
  const updated = isExpiringSoon(record.expires_at)
    ? await refreshIntegration(record)
    : record;
  return {
    provider,
    access_token: updated.access_token,
    token_type: updated.token_type ?? "Bearer",
    expires_at: updated.expires_at ?? null,
    scopes: updated.scopes ?? [],
    provider_email: updated.email ?? null,
    provider_user_id: updated.provider_user_id ?? null,
    metadata: updated.metadata ?? {},
  };
}

async function importIntegrationBundle(bundle: IntegrationTokenBundle): Promise<void> {
  const isRunning = await getGatewayStatusCached().catch(() => false);
  if (!isRunning) {
    console.warn("[integrations] Gateway status check failed; attempting import anyway.");
  }
  const gatewayUrl =
    (await invoke<string>("get_gateway_ws_url").catch(() => "")) || DEFAULT_GATEWAY_URL;
  const client = createGatewayClient(gatewayUrl, GATEWAY_TOKEN);
  if (!client.isConnected()) {
    await client.connect();
  }
  await client.rpc("integrations.import", {
    provider: bundle.provider,
    access_token: bundle.access_token,
    token_type: bundle.token_type ?? undefined,
    expires_at: bundle.expires_at ?? undefined,
    scopes: bundle.scopes ?? [],
    provider_email: bundle.provider_email ?? undefined,
    provider_user_id: bundle.provider_user_id ?? undefined,
    metadata: bundle.metadata ?? {},
  });
}

export async function syncIntegrationToGateway(provider: IntegrationProvider): Promise<void> {
  if (!OPENCLAW_SYNC_PROVIDERS.has(provider)) {
    return;
  }
  const bundle = await exportIntegrationTokenBundle(provider);
  try {
    await importIntegrationBundle(bundle);
    await clearPendingImport(provider);
  } catch (err) {
    await queueIntegrationImport(bundle);
    throw err;
  }
}

export async function syncPendingIntegrationImports(): Promise<void> {
  const pending = await loadPendingImports();
  const providers = Object.keys(pending) as IntegrationProvider[];
  for (const provider of providers) {
    try {
      await importIntegrationBundle(pending[provider]);
      await clearPendingImport(provider);
    } catch (err) {
      console.warn(`Failed to sync integration ${provider}:`, err);
    }
  }
}

export async function hasPendingIntegrationImports(): Promise<boolean> {
  const pending = await loadPendingImports();
  return Object.keys(pending).length > 0;
}

export async function syncAllIntegrationsToGateway(): Promise<string[]> {
  const records = await listIntegrationSecrets<StoredIntegration>();
  const synced: string[] = [];
  for (const record of records) {
    if (!record?.access_token) continue;
    if (!OPENCLAW_SYNC_PROVIDERS.has(record.provider)) continue;
    try {
      await syncIntegrationToGateway(record.provider);
      synced.push(record.provider);
    } catch (err) {
      console.warn(`Failed to sync ${record.provider} to OpenClaw:`, err);
    }
  }
  return synced;
}

export async function getCachedIntegrationProviders(): Promise<string[]> {
  const cached = await listIntegrationIndexCache();
  return cached.map((entry) => entry.provider).filter(Boolean);
}

export async function removeIntegrationFromGateway(provider: IntegrationProvider): Promise<void> {
  if (!OPENCLAW_SYNC_PROVIDERS.has(provider)) {
    return;
  }
  const isRunning = await getGatewayStatusCached().catch(() => false);
  if (!isRunning) {
    return;
  }
  const gatewayUrl =
    (await invoke<string>("get_gateway_ws_url").catch(() => "")) || DEFAULT_GATEWAY_URL;
  const client = createGatewayClient(gatewayUrl, GATEWAY_TOKEN);
  if (!client.isConnected()) {
    await client.connect();
  }
  await client.rpc("integrations.remove", { provider });
}

let refreshIntervalId: number | null = null;

export function startIntegrationRefreshLoop(): void {
  if (refreshIntervalId !== null) return;
  refreshIntervalId = window.setInterval(async () => {
    try {
      const records = await listIntegrationSecrets<StoredIntegration>();
      for (const record of records) {
        if (!OPENCLAW_SYNC_PROVIDERS.has(record.provider)) continue;
        if (!isExpiringSoon(record.expires_at)) continue;
        try {
          await refreshIntegration(record);
          await syncIntegrationToGateway(record.provider);
        } catch (err) {
          console.warn(`Failed to refresh ${record.provider}:`, err);
        }
      }
    } catch (err) {
      console.warn("Integration refresh loop failed:", err);
    }
  }, 5 * 60_000);
}

export function stopIntegrationRefreshLoop(): void {
  if (refreshIntervalId === null) return;
  window.clearInterval(refreshIntervalId);
  refreshIntervalId = null;
}

// =============================================================================
// Helper functions for using integrations
// =============================================================================

export async function fetchCalendarEvents(
  timeMin?: Date,
  timeMax?: Date,
  maxResults = 10
): Promise<any[]> {
  const token = await getIntegrationAccessToken("google_calendar");

  const params = new URLSearchParams({
    maxResults: maxResults.toString(),
    singleEvents: "true",
    orderBy: "startTime",
  });

  if (timeMin) {
    params.set("timeMin", timeMin.toISOString());
  }
  if (timeMax) {
    params.set("timeMax", timeMax.toISOString());
  }

  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    }
  );

  if (!response.ok) {
    throw new Error(`Calendar API error: ${response.status}`);
  }

  const data = await response.json();
  return data.items || [];
}

export async function createCalendarEvent(event: {
  summary: string;
  description?: string;
  start: { dateTime: string; timeZone?: string };
  end: { dateTime: string; timeZone?: string };
  attendees?: { email: string }[];
}): Promise<any> {
  const token = await getIntegrationAccessToken("google_calendar");

  const response = await fetch(
    "https://www.googleapis.com/calendar/v3/calendars/primary/events",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(event),
    }
  );

  if (!response.ok) {
    throw new Error(`Calendar API error: ${response.status}`);
  }

  return response.json();
}

export async function fetchEmails(query?: string, maxResults = 10): Promise<any[]> {
  const token = await getIntegrationAccessToken("google_email");

  const params = new URLSearchParams({
    maxResults: maxResults.toString(),
  });

  if (query) {
    params.set("q", query);
  }

  const listResponse = await fetch(
    `https://www.googleapis.com/gmail/v1/users/me/messages?${params}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    }
  );

  if (!listResponse.ok) {
    throw new Error(`Gmail API error: ${listResponse.status}`);
  }

  const listData = await listResponse.json();
  const messages = listData.messages || [];

  const fullMessages = await Promise.all(
    messages.slice(0, maxResults).map(async (msg: { id: string }) => {
      const msgResponse = await fetch(
        `https://www.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );
      return msgResponse.json();
    })
  );

  return fullMessages;
}

export async function sendEmail(to: string, subject: string, body: string): Promise<any> {
  const token = await getIntegrationAccessToken("google_email");

  const email = [
    `To: ${to}`,
    `Subject: ${subject}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    body,
  ].join("\r\n");

  const encodedEmail = btoa(email)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const response = await fetch("https://www.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ raw: encodedEmail }),
  });

  if (!response.ok) {
    throw new Error(`Gmail API error: ${response.status}`);
  }

  return response.json();
}
