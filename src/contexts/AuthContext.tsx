import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
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
  supabase,
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
  const balanceFetchRef = useRef({ inFlight: false, lastAt: 0 });
  const BALANCE_FETCH_THROTTLE_MS = 3000;

  const loadBalance = useCallback(
    async (opts?: { force?: boolean }) => {
      if (!session) return;

      const now = Date.now();
      if (!opts?.force) {
        if (balanceFetchRef.current.inFlight) return;
        if (now - balanceFetchRef.current.lastAt < BALANCE_FETCH_THROTTLE_MS) return;
      }

      balanceFetchRef.current.inFlight = true;
      balanceFetchRef.current.lastAt = now;
      try {
        const bal = await getBalance();
        setBalance(bal);
      } catch (err) {
        console.error("Failed to load balance:", err);
      } finally {
        balanceFetchRef.current.inFlight = false;
      }
    },
    [session]
  );

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
          await loadBalance({ force: true });
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
        await loadBalance({ force: true });
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
          await loadBalance({ force: true });
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

    // Handle OAuth callback with improved polling for production and dev
    const handleFocus = async () => {
      // Check if there's a pending OAuth callback in sessionStorage
      const pendingCallback = sessionStorage.getItem('nova_oauth_pending');
      if (pendingCallback) {
        const pendingTime = parseInt(pendingCallback);
        const now = Date.now();

        // If OAuth has been pending for more than 30 seconds, clear it
        if (now - pendingTime > 30000) {
          sessionStorage.removeItem('nova_oauth_pending');
          console.log('OAuth timeout - clearing pending state');
          return;
        }

        // Try to get the session again - OAuth flow might have completed
        if (supabase) {
          try {
            // First try to get the current session
            const { data: { session: currentSession } } = await supabase.auth.getSession();
            if (currentSession) {
              sessionStorage.removeItem('nova_oauth_pending');
              setSession(currentSession);
              setUser(currentSession.user);
              console.log('OAuth completed successfully');
              return;
            }

            // Avoid hammering refresh; wait for the session to land via deep link.
          } catch (error) {
            console.error('Failed to check session after OAuth:', error);
          }
        }
      }
    };

    window.addEventListener('focus', handleFocus);

    // Check periodically while OAuth is pending (for both dev and production)
    const checkInterval = setInterval(async () => {
      const pendingCallback = sessionStorage.getItem('nova_oauth_pending');
      if (pendingCallback && supabase) {
        const pendingTime = parseInt(pendingCallback);
        const now = Date.now();

        // Clear if timeout exceeded
        if (now - pendingTime > 30000) {
          sessionStorage.removeItem('nova_oauth_pending');
          clearInterval(checkInterval);
          console.log('OAuth timeout - clearing pending state');
          return;
        }

        try {
          // First try to get the current session
          const { data: { session: currentSession } } = await supabase.auth.getSession();
          if (currentSession) {
            sessionStorage.removeItem('nova_oauth_pending');
            setSession(currentSession);
            setUser(currentSession.user);
            console.log('OAuth completed successfully (via polling)');
            clearInterval(checkInterval);
            return;
          }

          // Avoid hammering refresh; let deep-link handler set the session.
        } catch (error) {
          // Ignore errors during polling
        }
      } else if (!pendingCallback) {
        // No pending OAuth, stop checking
        clearInterval(checkInterval);
      }
    }, 1000);

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

  const refreshBalance = useCallback(async () => {
    await loadBalance();
  }, [loadBalance]);

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
