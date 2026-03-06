import { createClient, Session, User, SupabaseClient } from "@supabase/supabase-js";
import { open } from "@tauri-apps/plugin-shell";
import { Store } from "@tauri-apps/plugin-store";
import { invoke } from "@tauri-apps/api/core";
import { platform } from "@tauri-apps/plugin-os";
import { getDeviceFingerprintHash } from "./localCredits";
import { nativeApiRequest, shouldUseNativeApiTransport } from "./nativeApi";

// These should be set via environment variables
const SUPABASE_URL = (import.meta as any).env?.VITE_SUPABASE_URL || "";
const SUPABASE_ANON_KEY = (import.meta as any).env?.VITE_SUPABASE_ANON_KEY || "";
const RAW_API_URL = (import.meta as any).env?.VITE_API_URL || "";
const API_URL = RAW_API_URL || ((import.meta as any).env?.DEV ? "/api" : "");
const APP_SCHEME = (import.meta as any).env?.DEV ? "entropic-dev" : "entropic";
const AUTH_REDIRECT_URL =
  (import.meta as any).env?.VITE_AUTH_REDIRECT_URL || `${APP_SCHEME}://auth/callback`;
const BILLING_SUCCESS_REDIRECT_URL =
  (import.meta as any).env?.VITE_BILLING_SUCCESS_REDIRECT_URL ||
  `${APP_SCHEME}://billing/success`;
const BILLING_CANCEL_REDIRECT_URL =
  (import.meta as any).env?.VITE_BILLING_CANCEL_REDIRECT_URL ||
  `${APP_SCHEME}://billing/cancel`;
const AUTH_STORE_NAME =
  (import.meta as any).env?.VITE_AUTH_STORE_NAME || "entropic-auth.json";
const AUTH_USE_LOCALHOST =
  (import.meta as any).env?.VITE_AUTH_USE_LOCALHOST === "1";
const AUTH_FORCE_DEEPLINK =
  (import.meta as any).env?.VITE_AUTH_FORCE_DEEPLINK === "1";
const AUTH_DEBUG =
  (import.meta as any).env?.VITE_AUTH_DEBUG === "1" ||
  (import.meta as any).env?.DEV;
const USE_NATIVE_API_TRANSPORT = shouldUseNativeApiTransport(API_URL);

function authDebug(message: string, data?: Record<string, unknown>) {
  if (!AUTH_DEBUG) return;
  if (data) console.log(`[auth] ${message}`, data);
  else console.log(`[auth] ${message}`);
}

authDebug("config", {
  apiUrl: API_URL || "(empty)",
  supabaseConfigured: Boolean(SUPABASE_URL && SUPABASE_ANON_KEY),
  authStore: AUTH_STORE_NAME,
});

function redactToken(token?: string | null) {
  if (!token) return null;
  if (token.length <= 10) return "***";
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}

// Check if auth is configured
export const isAuthConfigured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

// Create Supabase client (or null if not configured)
export const supabase: SupabaseClient | null = isAuthConfigured
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        autoRefreshToken: true,
        flowType: "pkce",
        persistSession: true,
        storage: {
          // Use Tauri store for session persistence
          getItem: async (key: string) => {
            try {
              const store = await Store.load(AUTH_STORE_NAME);
              const value = await store.get(key);
              authDebug("storage getItem", { key, hasValue: Boolean(value) });
              return value as string | null;
            } catch {
              authDebug("storage getItem failed", { key });
              return null;
            }
          },
          setItem: async (key: string, value: string) => {
            try {
              const store = await Store.load(AUTH_STORE_NAME);
              await store.set(key, value);
              await store.save();
              authDebug("storage setItem", { key, bytes: value.length });
            } catch (error) {
              console.error("Failed to save auth:", error);
            }
          },
          removeItem: async (key: string) => {
            try {
              const store = await Store.load(AUTH_STORE_NAME);
              await store.delete(key);
              await store.save();
              authDebug("storage removeItem", { key });
            } catch (error) {
              console.error("Failed to remove auth:", error);
            }
          },
        },
      },
    })
  : null;

export type AuthState = {
  isLoading: boolean;
  isAuthenticated: boolean;
  user: User | null;
  session: Session | null;
};

type OAuthProvider = "google" | "apple" | "discord";
type LocalhostAuthStart = { redirect_url: string };

async function shouldUseLocalhostOAuth(): Promise<boolean> {
  if (AUTH_FORCE_DEEPLINK) return false;
  if (AUTH_USE_LOCALHOST) return true;
  if (!(import.meta as any).env?.DEV) return false;
  try {
    const os = await platform();
    // In tauri dev on desktop, prefer localhost OAuth. The debug app is not a
    // normal installed bundle, so deep-link callbacks are less reliable than in
    // packaged builds.
    return os === "macos" || os === "windows";
  } catch {
    return false;
  }
}

async function resolveOAuthRedirectUrl(): Promise<string> {
  const useLocalhost = await shouldUseLocalhostOAuth();
  if (!useLocalhost) {
    return AUTH_REDIRECT_URL;
  }

  try {
    const result = await invoke<LocalhostAuthStart>("start_auth_localhost");
    authDebug("localhost OAuth server started", { redirectTo: result.redirect_url });
    return result.redirect_url;
  } catch (error) {
    console.error("Failed to start localhost OAuth server", error);
    throw new Error(
      "Failed to start localhost OAuth server. Is port 27100 in use? You can change it with ENTROPIC_AUTH_LOCALHOST_PORT."
    );
  }
}

/**
 * Sign in with OAuth provider
 * Opens system browser for authentication
 */
export async function signInWithOAuth(provider: OAuthProvider): Promise<void> {
  if (!supabase) {
    throw new Error("Auth not configured");
  }

  const redirectTo = await resolveOAuthRedirectUrl();
  authDebug("signInWithOAuth start", { provider, redirectTo });

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider,
    options: {
      redirectTo,
      skipBrowserRedirect: true,
    },
  });

  if (error) {
    console.error("OAuth error:", error);
    throw error;
  }

  if (data?.url) {
    try {
      const parsed = new URL(data.url);
      authDebug("OAuth URL generated", { host: parsed.host, path: parsed.pathname });
    } catch {
      authDebug("OAuth URL generated", { hasUrl: true });
    }
    // Set a timestamp for OAuth pending (for both dev and production)
    sessionStorage.setItem('entropic_oauth_pending', Date.now().toString());

    // Open system browser for OAuth
    await open(data.url);
  }
}

// Convenience wrappers
export const signInWithGoogle = () => signInWithOAuth("google");
export const signInWithApple = () => signInWithOAuth("apple");
export const signInWithDiscord = () => signInWithOAuth("discord");

/**
 * Sign in with email and password
 */
export async function signInWithEmail(email: string, password: string): Promise<void> {
  if (!supabase) {
    throw new Error("Auth not configured");
  }

  const { error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (error) {
    throw error;
  }
}

/**
 * Sign up with email and password
 */
export async function signUpWithEmail(email: string, password: string): Promise<void> {
  if (!supabase) {
    throw new Error("Auth not configured");
  }

  const { error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      emailRedirectTo: AUTH_REDIRECT_URL,
    },
  });

  if (error) {
    throw error;
  }
}

/**
 * Handle OAuth callback from deep link
 */
export async function handleAuthCallback(url: string): Promise<boolean> {
  if (!supabase) {
    return false;
  }

  try {
    authDebug("handleAuthCallback", { url });
    // Parse the URL to extract tokens
    const urlObj = new URL(url);
    const hashParams = new URLSearchParams(urlObj.hash.slice(1));
    const queryParams = new URLSearchParams(urlObj.search);

    // Check for error
    const error = hashParams.get("error") || queryParams.get("error");
    if (error) {
      console.error("OAuth callback error:", error);
      return false;
    }

    // Get access token from hash fragment (OAuth implicit flow)
    const accessToken = hashParams.get("access_token");
    const refreshToken = hashParams.get("refresh_token");
    authDebug("callback tokens", {
      hasAccessToken: Boolean(accessToken),
      accessToken: redactToken(accessToken),
      hasRefreshToken: Boolean(refreshToken),
      refreshToken: redactToken(refreshToken),
      hasCode: Boolean(queryParams.get("code")),
      hashKeys: Array.from(hashParams.keys()),
      queryKeys: Array.from(queryParams.keys()),
    });

    if (accessToken) {
      // Set the session manually
      const { error: sessionError } = await supabase.auth.setSession({
        access_token: accessToken,
        refresh_token: refreshToken || "",
      });

      if (sessionError) {
        console.error("Failed to set session:", sessionError);
        return false;
      }

      authDebug("setSession ok");
      return true;
    }

    // Check for authorization code (OAuth code flow)
    const code = queryParams.get("code");
    if (code) {
      const { error: exchangeError } =
        await supabase.auth.exchangeCodeForSession(code);

      if (exchangeError) {
        console.error("Failed to exchange code:", exchangeError);
        return false;
      }

      authDebug("exchangeCodeForSession ok");
      return true;
    }

    console.error("No tokens or code in callback URL");
    return false;
  } catch (error) {
    console.error("Failed to handle auth callback:", error);
    return false;
  }
}

/**
 * Get current session
 */
export async function getSession(): Promise<Session | null> {
  if (!supabase) {
    return null;
  }

  const {
    data: { session },
  } = await supabase.auth.getSession();
  return session;
}

/**
 * Get current user
 */
export async function getUser(): Promise<User | null> {
  if (!supabase) {
    return null;
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}

/**
 * Sign out
 */
export async function signOut(): Promise<void> {
  if (!supabase) {
    return;
  }

  await supabase.auth.signOut();
}

/**
 * Get access token for API calls
 * Ensures the token is fresh and valid
 */
export async function getAccessToken(): Promise<string | null> {
  if (!supabase) {
    return null;
  }

  const { data: { session }, error } = await supabase.auth.getSession();
  if (error) return session?.access_token || null;

  if (!session) return null;

  // Avoid hammering the token endpoint; only refresh near expiry and throttle.
  const nowSec = Math.floor(Date.now() / 1000);
  const expiresAt = session.expires_at ?? 0;
  const expiresIn = expiresAt - nowSec;
  if (expiresIn > 90) {
    return session.access_token;
  }

  if (!session.refresh_token) {
    return session.access_token;
  }

  const refreshed = await throttledRefreshSession(session.refresh_token);
  return refreshed?.access_token || session.access_token || null;
}

let refreshInFlight: Promise<Session | null> | null = null;
let lastRefreshAtMs = 0;
const REFRESH_THROTTLE_MS = 30_000;

async function throttledRefreshSession(refreshToken: string): Promise<Session | null> {
  if (!supabase) return null;
  const now = Date.now();
  if (refreshInFlight) return refreshInFlight;
  if (now - lastRefreshAtMs < REFRESH_THROTTLE_MS) {
    const { data: { session } } = await supabase.auth.getSession();
    return session ?? null;
  }
  lastRefreshAtMs = now;
  refreshInFlight = supabase.auth
    .refreshSession({ refresh_token: refreshToken })
    .then(({ data, error }) => {
      if (error) {
        console.warn("Token refresh failed:", error);
        return null;
      }
      return data.session ?? null;
    })
    .finally(() => {
      refreshInFlight = null;
    });
  return refreshInFlight;
}

/**
 * Subscribe to auth state changes
 */
export function onAuthStateChange(
  callback: (session: Session | null, event?: string) => void
): () => void {
  if (!supabase) {
    // Return a no-op unsubscribe function
    return () => {};
  }

  const {
    data: { subscription },
  } = supabase.auth.onAuthStateChange((_event: string, session: Session | null) => {
    callback(session, _event);
  });

  return () => subscription.unsubscribe();
}

// API client functions

export interface BalanceResponse {
  balance_cents: number;
  balance_dollars: string;
}

export interface UsageResponse {
  period_days: number;
  total_cost_cents: number;
  total_cost_dollars: string;
  total_requests: number;
  by_model: Record<string, { cost: number; requests: number }>;
}

export interface CheckoutResponse {
  checkout_url: string;
}

export interface Model {
  id: string;
  name: string;
  provider: string;
  tier: string;
}

/**
 * Make authenticated API request
 */
export class ApiRequestError extends Error {
  status?: number;
  data?: any;
  kind?: "network" | "http";

  constructor(message: string, opts?: { status?: number; data?: any; kind?: "network" | "http" }) {
    super(message);
    this.name = "ApiRequestError";
    this.status = opts?.status;
    this.data = opts?.data;
    this.kind = opts?.kind;
  }
}

function extractApiErrorMessage(body: any, fallback: string): string {
  const serverMessage = body?.error?.message;
  if (typeof serverMessage === "string" && serverMessage.trim()) {
    return serverMessage;
  }
  if (typeof body?.raw === "string" && body.raw.trim()) {
    return body.raw;
  }
  return fallback;
}

export async function apiRequest<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const token = await getAccessToken();

  if (!token) {
    throw new ApiRequestError("Not authenticated", { status: 401, kind: "http" });
  }

  const requestUrl = `${API_URL}${endpoint}`;
  let deviceFingerprint: string | undefined;
  try {
    deviceFingerprint = await getDeviceFingerprintHash();
  } catch (error: any) {
    authDebug("apiRequest fingerprint unavailable", {
      endpoint,
      message: error?.message || String(error),
    });
  }

  authDebug("apiRequest", {
    method: options.method || "GET",
    url: requestUrl,
    hasToken: Boolean(token),
    bodyLength: options.body ? String(options.body).length : 0,
    native: USE_NATIVE_API_TRANSPORT,
  });

  if (USE_NATIVE_API_TRANSPORT) {
    try {
      const nativeResponse = await nativeApiRequest({
        method: options.method || "GET",
        url: requestUrl,
        accessToken: token,
        body: typeof options.body === "string" && options.body.length > 0
          ? JSON.parse(options.body)
          : undefined,
        deviceFingerprint,
      });
      if (nativeResponse.status < 200 || nativeResponse.status >= 300) {
        throw new ApiRequestError(
          extractApiErrorMessage(nativeResponse.body, `API error: ${nativeResponse.status}`),
          { status: nativeResponse.status, data: nativeResponse.body, kind: "http" }
        );
      }
      return nativeResponse.body as T;
    } catch (error: any) {
      if (error instanceof ApiRequestError) throw error;
      authDebug("apiRequest failed", {
        message: error?.message || String(error),
        name: error?.name,
      });
      throw new ApiRequestError("Network request failed", { kind: "network", data: error });
    }
  }

  let response: Response;
  try {
    const requestHeaders: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };
    if (deviceFingerprint) {
      requestHeaders["X-Entropic-Device-Fingerprint"] = deviceFingerprint;
    }
    response = await fetch(requestUrl, {
      ...options,
      headers: {
        ...requestHeaders,
        ...options.headers,
      },
    });
  } catch (error: any) {
    authDebug("apiRequest failed", {
      message: error?.message || String(error),
      name: error?.name,
    });
    throw new ApiRequestError("Network request failed", { kind: "network", data: error });
  }

  if (!response.ok) {
    let errorBody: any = {};
    try {
      errorBody = await response.json();
    } catch {
      try {
        errorBody = { raw: await response.text() };
      } catch {
        errorBody = {};
      }
    }
    // On 401: try to force-refresh the Supabase session and retry once.
    // This handles the case where the JWT expired but the refresh token is still valid.
    if (response.status === 401 && supabase) {
      const { data: { session } } = await supabase.auth.getSession();
      if (session?.refresh_token) {
        const refreshed = await supabase.auth.refreshSession({ refresh_token: session.refresh_token });
        const newToken = refreshed.data.session?.access_token;
        if (newToken && newToken !== token) {
          const retryResponse = await fetch(`${API_URL}${endpoint}`, {
            ...options,
            headers: {
              Authorization: `Bearer ${newToken}`,
              "Content-Type": "application/json",
              ...options.headers,
            },
          });
          if (retryResponse.ok) return retryResponse.json();
        }
      }
      // Refresh didn't help — session is truly dead, user needs to sign in again.
      throw new ApiRequestError(
        "Session expired — please sign out and sign back in.",
        { status: 401, data: errorBody, kind: "http" }
      );
    }
    throw new ApiRequestError(
      extractApiErrorMessage(errorBody, `API error: ${response.status}`),
      { status: response.status, data: errorBody, kind: "http" }
    );
  }

  return response.json();
}

/**
 * Get user's credit balance
 */
export async function getBalance(): Promise<BalanceResponse> {
  return apiRequest<BalanceResponse>("/balance");
}

/**
 * Get usage summary
 */
export async function getUsage(days = 30): Promise<UsageResponse> {
  return apiRequest<UsageResponse>(`/usage?days=${days}`);
}

/**
 * Create checkout session for adding credits
 */
export async function createCheckout(
  amountCents: number
): Promise<CheckoutResponse> {
  return apiRequest<CheckoutResponse>("/create-checkout", {
    method: "POST",
    body: JSON.stringify({
      amount_cents: amountCents,
      app_redirect_success_url: BILLING_SUCCESS_REDIRECT_URL,
      app_redirect_cancel_url: BILLING_CANCEL_REDIRECT_URL,
    }),
  });
}

/**
 * Get available models
 */
export async function getModels(): Promise<Model[]> {
  let data: any;
  if (USE_NATIVE_API_TRANSPORT) {
    const nativeResponse = await nativeApiRequest({
      method: "GET",
      url: `${API_URL}/v1/models`,
    });
    if (nativeResponse.status < 200 || nativeResponse.status >= 300) {
      throw new ApiRequestError(
        extractApiErrorMessage(nativeResponse.body, `API error: ${nativeResponse.status}`),
        { status: nativeResponse.status, data: nativeResponse.body, kind: "http" }
      );
    }
    data = nativeResponse.body;
  } else {
    const response = await fetch(`${API_URL}/v1/models`);
    data = await response.json();
  }
  return data.data || [];
}

export interface GatewayTokenResponse {
  token: string;
  expires_at: number;
}

/**
 * Create a gateway token for OpenClaw to use.
 * If allowAnonymous is true and no auth session exists, a local anonymous
 * device fingerprint hash is sent so the backend can issue a trial token.
 */
export async function createGatewayToken(opts?: {
  allowAnonymous?: boolean;
}): Promise<GatewayTokenResponse> {
  const allowAnonymous = opts?.allowAnonymous === true;
  const accessToken = await getAccessToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
    try {
      headers["X-Entropic-Device-Fingerprint"] = await getDeviceFingerprintHash();
    } catch (error: any) {
      authDebug("createGatewayToken fingerprint unavailable", {
        message: error?.message || String(error),
      });
    }
  } else if (allowAnonymous) {
    headers["X-Entropic-Device-Fingerprint"] = await getDeviceFingerprintHash();
  } else {
    throw new ApiRequestError("Not authenticated", { status: 401, kind: "http" });
  }

  if (USE_NATIVE_API_TRANSPORT) {
    try {
      const nativeResponse = await nativeApiRequest({
        method: "POST",
        url: `${API_URL}/create-gateway-token`,
        accessToken: accessToken || undefined,
        body: {},
        deviceFingerprint: headers["X-Entropic-Device-Fingerprint"],
      });
      if (nativeResponse.status < 200 || nativeResponse.status >= 300) {
        throw new ApiRequestError(
          extractApiErrorMessage(nativeResponse.body, `API error: ${nativeResponse.status}`),
          { status: nativeResponse.status, data: nativeResponse.body, kind: "http" }
        );
      }
      return nativeResponse.body as GatewayTokenResponse;
    } catch (error: any) {
      if (error instanceof ApiRequestError) throw error;
      throw new ApiRequestError("Network request failed", { kind: "network", data: error });
    }
  }

  let response: Response;
  try {
    response = await fetch(`${API_URL}/create-gateway-token`, {
      method: "POST",
      headers,
      body: "{}",
    });
  } catch (error: any) {
    throw new ApiRequestError("Network request failed", { kind: "network", data: error });
  }

  if (!response.ok) {
    let errorBody: any = {};
    try {
      errorBody = await response.json();
    } catch {
      try {
        errorBody = { raw: await response.text() };
      } catch {
        errorBody = {};
      }
    }
    throw new ApiRequestError(
      extractApiErrorMessage(errorBody, `API error: ${response.status}`),
      { status: response.status, data: errorBody, kind: "http" }
    );
  }

  return response.json();
}

/**
 * Revoke a gateway token
 */
export async function revokeGatewayToken(token: string): Promise<void> {
  await apiRequest("/revoke-gateway-token", {
    method: "POST",
    body: JSON.stringify({ token }),
  });
}

/**
 * Get the absolute API URL for the Docker container (OpenClaw) to use.
 * In dev mode, VITE_API_URL is a relative path ("/api") for Vite proxy;
 * the container needs an absolute URL, so we resolve against VITE_API_ORIGIN.
 */
const API_ORIGIN = (import.meta as any).env?.VITE_API_ORIGIN || "";
export function getProxyUrl(): string {
  if (!API_URL) return API_URL;
  // Relative path (e.g. "/api") — resolve to absolute URL for Docker
  if (API_URL.startsWith("/")) {
    if (API_ORIGIN) {
      return API_ORIGIN.replace(/\/$/, "") + API_URL;
    }
    // No origin configured — return relative path and let Rust fallback handle it
    return API_URL;
  }
  try {
    const url = new URL(API_URL);
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
      url.hostname = "host.docker.internal";
      return url.toString().replace(/\/$/, "");
    }
  } catch {
    // Not a valid URL, return as-is
  }
  return API_URL;
}
