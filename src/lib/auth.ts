import { createClient, Session, User, SupabaseClient } from "@supabase/supabase-js";
import { open } from "@tauri-apps/plugin-shell";
import { Store } from "@tauri-apps/plugin-store";

// These should be set via environment variables
const SUPABASE_URL = (import.meta as any).env?.VITE_SUPABASE_URL || "";
const SUPABASE_ANON_KEY = (import.meta as any).env?.VITE_SUPABASE_ANON_KEY || "";
const API_URL = (import.meta as any).env?.VITE_API_URL || "";

// Check if auth is configured
export const isAuthConfigured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

// Create Supabase client (or null if not configured)
export const supabase: SupabaseClient | null = isAuthConfigured
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        autoRefreshToken: true,
        persistSession: true,
        storage: {
          // Use Tauri store for session persistence
          getItem: async (key: string) => {
            try {
              const store = await Store.load("nova-auth.json");
              const value = await store.get(key);
              return value as string | null;
            } catch {
              return null;
            }
          },
          setItem: async (key: string, value: string) => {
            try {
              const store = await Store.load("nova-auth.json");
              await store.set(key, value);
              await store.save();
            } catch (error) {
              console.error("Failed to save auth:", error);
            }
          },
          removeItem: async (key: string) => {
            try {
              const store = await Store.load("nova-auth.json");
              await store.delete(key);
              await store.save();
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

/**
 * Sign in with OAuth provider
 * Opens system browser for authentication
 */
export async function signInWithOAuth(provider: OAuthProvider): Promise<void> {
  if (!supabase) {
    throw new Error("Auth not configured");
  }

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider,
    options: {
      redirectTo: "nova://auth/callback",
      skipBrowserRedirect: true,
    },
  });

  if (error) {
    console.error("OAuth error:", error);
    throw error;
  }

  if (data?.url) {
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
      emailRedirectTo: "nova://auth/callback",
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
 */
export async function getAccessToken(): Promise<string | null> {
  const session = await getSession();
  return session?.access_token || null;
}

/**
 * Subscribe to auth state changes
 */
export function onAuthStateChange(
  callback: (session: Session | null) => void
): () => void {
  if (!supabase) {
    // Return a no-op unsubscribe function
    return () => {};
  }

  const {
    data: { subscription },
  } = supabase.auth.onAuthStateChange((_event: string, session: Session | null) => {
    callback(session);
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
async function apiRequest<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const token = await getAccessToken();

  if (!token) {
    throw new Error("Not authenticated");
  }

  const response = await fetch(`${API_URL}${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error?.message || `API error: ${response.status}`);
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
    body: JSON.stringify({ amount_cents: amountCents }),
  });
}

/**
 * Get available models
 */
export async function getModels(): Promise<Model[]> {
  const response = await fetch(`${API_URL}/v1/models`);
  const data = await response.json();
  return data.data || [];
}

export interface GatewayTokenResponse {
  token: string;
  expires_at: number;
}

/**
 * Create a gateway token for OpenClaw to use
 */
export async function createGatewayToken(): Promise<GatewayTokenResponse> {
  return apiRequest<GatewayTokenResponse>("/create-gateway-token", {
    method: "POST",
  });
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
 * Get the API URL for OpenClaw to use
 */
export function getProxyUrl(): string {
  return API_URL;
}
