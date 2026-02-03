import {
  createContext,
  useContext,
  useEffect,
  useState,
  ReactNode,
} from "react";
import type { Session, User } from "@supabase/supabase-js";
import {
  getSession,
  getUser,
  onAuthStateChange,
  handleAuthCallback,
  signOut as authSignOut,
  getBalance,
  isAuthConfigured,
  BalanceResponse,
} from "../lib/auth";

// Dynamic import for deep-link to handle when it's not available
let onOpenUrl: ((callback: (urls: string[]) => void) => Promise<() => void>) | null = null;
let listenTauriEvent:
  | ((event: string, handler: (event: { payload: unknown }) => void) => Promise<() => void>)
  | null = null;
if (isAuthConfigured) {
  try {
    // @ts-ignore - module may not exist
    import("@tauri-apps/plugin-deep-link").then((mod) => {
      onOpenUrl = mod.onOpenUrl;
    }).catch(() => {});
    import("@tauri-apps/api/event").then((mod) => {
      listenTauriEvent = mod.listen;
    }).catch(() => {});
  } catch {
    // Deep link not available
  }
}

interface AuthContextType {
  isLoading: boolean;
  isAuthenticated: boolean;
  isAuthConfigured: boolean;
  user: User | null;
  session: Session | null;
  balance: BalanceResponse | null;
  signOut: () => Promise<void>;
  refreshBalance: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return context;
}

interface AuthProviderProps {
  children: ReactNode;
}

export function AuthProvider({ children }: AuthProviderProps) {
  const [isLoading, setIsLoading] = useState(isAuthConfigured);
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [balance, setBalance] = useState<BalanceResponse | null>(null);

  // Load initial session (only if auth is configured)
  useEffect(() => {
    if (!isAuthConfigured) {
      console.log("[Auth] Auth not configured, skipping initialization");
      return;
    }

    async function init() {
      try {
        const currentSession = await getSession();
        const currentUser = currentSession ? await getUser() : null;

        setSession(currentSession);
        setUser(currentUser);

        if (currentSession) {
          // Load balance
          try {
            const bal = await getBalance();
            setBalance(bal);
          } catch (err) {
            console.error("Failed to load balance:", err);
          }
        }
      } catch (error) {
        console.error("Failed to load session:", error);
      } finally {
        setIsLoading(false);
      }
    }

    init();
  }, []);

  // Listen for auth state changes
  useEffect(() => {
    const unsubscribe = onAuthStateChange(async (newSession) => {
      setSession(newSession);

      if (newSession) {
        const currentUser = await getUser();
        setUser(currentUser);

        // Load balance when user signs in
        try {
          const bal = await getBalance();
          setBalance(bal);
        } catch (err) {
          console.error("Failed to load balance:", err);
        }
      } else {
        setUser(null);
        setBalance(null);
      }
    });

    return unsubscribe;
  }, []);

  // Handle deep link for OAuth callback
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let unlistenEvent: (() => void) | undefined;

    async function handleUrls(urls: string[]) {
      for (const url of urls) {
        console.log("Deep link received:", url);

        if (url.includes("auth/callback")) {
          const success = await handleAuthCallback(url);
          if (success) {
            console.log("Auth callback handled successfully");
            // Session will be updated via onAuthStateChange
          }
        } else if (url.includes("billing/success")) {
          // Refresh balance after successful payment
          try {
            const bal = await getBalance();
            setBalance(bal);
          } catch (err) {
            console.error("Failed to refresh balance:", err);
          }
        } else if (url.includes("integrations/success")) {
          // Integration OAuth completed successfully
          console.log("Integration connected successfully");
          window.dispatchEvent(new CustomEvent('nova-integration-updated'));
        } else if (url.includes("integrations/error")) {
          // Integration OAuth failed
          const urlObj = new URL(url);
          const error = urlObj.searchParams.get('error') || 'Unknown error';
          console.error("Integration OAuth error:", error);
          window.dispatchEvent(new CustomEvent('nova-integration-error', { detail: { error } }));
        }
      }
    }

    async function setupDeepLink() {
      if (!onOpenUrl) {
        console.log("Deep link handler not available");
        return;
      }

      try {
        unlisten = await onOpenUrl(async (urls: string[]) => {
          await handleUrls(urls);
        });
      } catch (error) {
        console.error("Failed to setup deep link listener:", error);
      }
    }

    setupDeepLink();

    async function setupSingleInstanceBridge() {
      if (!listenTauriEvent) {
        return;
      }

      try {
        unlistenEvent = await listenTauriEvent("deep-link-open", async (event) => {
          const payload = event.payload;
          if (Array.isArray(payload)) {
            await handleUrls(payload as string[]);
          } else if (typeof payload === "string") {
            await handleUrls([payload]);
          }
        });
      } catch (error) {
        console.error("Failed to setup deep link event listener:", error);
      }
    }

    setupSingleInstanceBridge();

    return () => {
      unlisten?.();
      unlistenEvent?.();
    };
  }, []);

  const signOut = async () => {
    await authSignOut();
    setUser(null);
    setSession(null);
    setBalance(null);
  };

  const refreshBalance = async () => {
    if (!session) return;

    try {
      const bal = await getBalance();
      setBalance(bal);
    } catch (err) {
      console.error("Failed to refresh balance:", err);
    }
  };

  return (
    <AuthContext.Provider
      value={{
        isLoading,
        isAuthenticated: !!session,
        isAuthConfigured,
        user,
        session,
        balance,
        signOut,
        refreshBalance,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}
