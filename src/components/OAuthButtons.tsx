import { useState, type FormEvent } from "react";
import { Mail } from "lucide-react";
import { GoogleIcon, DiscordIcon } from "./OAuthIcons";

type OAuthProvider = "google" | "discord";
type EmailAuthMode = "signin" | "signup";
type LoadingState = OAuthProvider | "email-signin" | "email-signup" | null;

type Props = {
  onOAuthSignIn: (provider: OAuthProvider) => Promise<void>;
  onEmailSignIn?: (email: string, password: string) => Promise<void>;
  onEmailSignUp?: (email: string, password: string) => Promise<void>;
  error?: string | null;
  notice?: string | null;
  onClearFeedback?: () => void;
  disabled?: boolean;
};

export function OAuthButtons({
  onOAuthSignIn,
  onEmailSignIn,
  onEmailSignUp,
  error,
  notice,
  onClearFeedback,
  disabled = false,
}: Props) {
  const [loading, setLoading] = useState<LoadingState>(null);
  const [showEmail, setShowEmail] = useState(false);
  const [emailMode, setEmailMode] = useState<EmailAuthMode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const isDisabled = disabled || loading !== null;

  async function handleOAuth(provider: OAuthProvider) {
    setLoading(provider);
    try {
      await onOAuthSignIn(provider);
    } finally {
      setLoading(null);
    }
  }

  async function handleEmailSubmit(e: FormEvent) {
    e.preventDefault();
    if (!email.trim() || !password.trim()) return;
    const handler = emailMode === "signup" ? onEmailSignUp : onEmailSignIn;
    if (!handler) return;
    setLoading(emailMode === "signup" ? "email-signup" : "email-signin");
    try {
      await handler(email.trim(), password);
    } finally {
      setLoading(null);
    }
  }

  return (
    <div className="space-y-3">
      {error && (
        <div className="rounded-xl border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-500 text-center">
          {error}
        </div>
      )}
      {notice && (
        <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-500 text-center">
          {notice}
        </div>
      )}

      <button
        onClick={() => handleOAuth("google")}
        disabled={isDisabled}
        className="w-full flex items-center justify-center gap-3 px-4 py-3 bg-[var(--bg-card)] hover:bg-[var(--system-gray-6)] text-[var(--text-primary)] font-medium rounded-xl border border-[var(--border-default)] active:scale-95 duration-200 disabled:opacity-50"
      >
        <GoogleIcon className="w-5 h-5" />
        <span>{loading === "google" ? "Opening Google..." : "Continue with Google"}</span>
      </button>

      <button
        onClick={() => handleOAuth("discord")}
        disabled={isDisabled}
        className="w-full flex items-center justify-center gap-3 px-4 py-3 bg-[#5865F2] hover:bg-[#4752C4] text-white font-medium rounded-xl shadow-md hover:shadow-lg active:scale-95 duration-200 disabled:opacity-50"
      >
        <DiscordIcon className="w-5 h-5" />
        <span>{loading === "discord" ? "Opening Discord..." : "Continue with Discord"}</span>
      </button>

      {(onEmailSignIn || onEmailSignUp) && (
        <>
          <div className="relative py-2">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-[var(--border-subtle)]" />
            </div>
            <div className="relative flex justify-center text-[10px] uppercase tracking-wider">
              <span className="bg-[var(--bg-card)] px-2 text-[var(--text-tertiary)]">or</span>
            </div>
          </div>

          <button
            onClick={() => {
              setShowEmail((prev) => !prev);
              onClearFeedback?.();
            }}
            disabled={isDisabled}
            className="w-full flex items-center justify-center gap-3 px-4 py-3 bg-[var(--system-gray-6)] hover:bg-[var(--system-gray-5)] text-[var(--text-primary)] font-medium rounded-xl active:scale-95 duration-200 disabled:opacity-50"
          >
            <Mail className="w-5 h-5 text-[var(--text-secondary)]" />
            <span>Continue with Email</span>
          </button>

          {showEmail && (
            <form onSubmit={handleEmailSubmit} className="space-y-3 rounded-xl bg-[var(--system-gray-6)] p-4">
              <label htmlFor="oauth-email" className="sr-only">Email address</label>
              <input
                id="oauth-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@example.com"
                className="w-full px-4 py-3 rounded-lg bg-[var(--bg-card)] border border-[var(--border-default)] focus:ring-2 focus:ring-[var(--system-blue)]/20 focus:outline-none text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] text-sm"
                required
              />
              <label htmlFor="oauth-password" className="sr-only">Password</label>
              <input
                id="oauth-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={emailMode === "signup" ? "Create password" : "Password"}
                className="w-full px-4 py-3 rounded-lg bg-[var(--bg-card)] border border-[var(--border-default)] focus:ring-2 focus:ring-[var(--system-blue)]/20 focus:outline-none text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] text-sm"
                required
                minLength={emailMode === "signup" ? 8 : undefined}
              />
              <div className="flex items-center gap-2">
                <button
                  type="submit"
                  disabled={isDisabled}
                  className="px-4 py-2.5 rounded-lg bg-[#1A1A2E] hover:opacity-90 text-white text-xs font-semibold disabled:opacity-50"
                >
                  {emailMode === "signup"
                    ? loading === "email-signup" ? "Creating..." : "Create account"
                    : loading === "email-signin" ? "Signing in..." : "Sign in"}
                </button>
                {onEmailSignIn && onEmailSignUp && (
                  <button
                    type="button"
                    onClick={() => {
                      setEmailMode((prev) => (prev === "signup" ? "signin" : "signup"));
                      onClearFeedback?.();
                    }}
                    className="text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
                  >
                    {emailMode === "signup" ? "Have an account? Sign in" : "Need an account? Sign up"}
                  </button>
                )}
              </div>
            </form>
          )}
        </>
      )}
    </div>
  );
}
