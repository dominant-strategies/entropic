import { useState } from "react";
import { Sparkles, Mail, Eye, EyeOff, ChevronLeft } from "lucide-react";
import {
  signInWithGoogle,
  signInWithApple,
  signInWithDiscord,
  signInWithEmail,
  signUpWithEmail,
} from "../lib/auth";

// Simple icons for OAuth providers
function GoogleIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
    </svg>
  );
}

function AppleIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/>
    </svg>
  );
}

function DiscordIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/>
    </svg>
  );
}

type AuthMode = "options" | "email-signin" | "email-signup" | "own-keys";

type Props = {
  onSignInStarted?: () => void;
  onSkipAuth?: () => void;
};

export function SignIn({ onSignInStarted, onSkipAuth }: Props) {
  const [mode, setMode] = useState<AuthMode>("options");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [skipClickCount, setSkipClickCount] = useState(0);

  const handleOAuthSignIn = async (provider: "google" | "apple" | "discord") => {
    setIsLoading(true);
    setError(null);

    try {
      if (provider === "google") await signInWithGoogle();
      else if (provider === "apple") await signInWithApple();
      else if (provider === "discord") await signInWithDiscord();
      onSignInStarted?.();
    } catch (err) {
      console.error("Sign in failed:", err);
      setError("Failed to start sign in. Please try again.");
      setIsLoading(false);
    }
  };

  const handleEmailSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) return;

    setIsLoading(true);
    setError(null);

    try {
      if (mode === "email-signup") {
        await signUpWithEmail(email, password);
        setError(null);
        // Show success message for signup
        setMode("options");
        alert("Check your email for a confirmation link!");
      } else {
        await signInWithEmail(email, password);
        onSignInStarted?.();
      }
    } catch (err: any) {
      console.error("Auth failed:", err);
      setError(err.message || "Authentication failed. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  // Hidden skip: click the logo 5 times
  const handleLogoClick = () => {
    const newCount = skipClickCount + 1;
    setSkipClickCount(newCount);

    if (newCount >= 5) {
      setMode("own-keys");
      setSkipClickCount(0);
    }
  };

  // Own keys mode
  if (mode === "own-keys") {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-[var(--bg-primary)]">
        <div className="w-full max-w-md p-8">
          <div className="text-center mb-8">
            <div className="w-20 h-20 rounded-2xl bg-[var(--purple-accent)] mx-auto flex items-center justify-center mb-6">
              <Sparkles className="w-10 h-10 text-white" />
            </div>
            <h1 className="text-2xl font-bold text-[var(--text-primary)] mb-2">
              Use Your Own API Keys
            </h1>
            <p className="text-[var(--text-secondary)]">
              Skip the managed service and use your own provider keys
            </p>
          </div>

          <div className="glass-card p-8 space-y-6">
            <div className="p-4 rounded-lg bg-yellow-500/10 border border-yellow-500/20">
              <p className="text-sm text-yellow-300">
                <strong>Advanced Mode:</strong> You'll need to configure API keys in Settings after setup.
                This bypasses Nova's billing system.
              </p>
            </div>

            <button
              onClick={() => onSkipAuth?.()}
              className="w-full py-3 px-4 rounded-xl bg-[var(--purple-accent)] hover:bg-[var(--purple-accent-hover)]
                       text-white font-medium transition-all"
            >
              Continue Without Account
            </button>

            <button
              onClick={() => setMode("options")}
              className="w-full flex items-center justify-center gap-2 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            >
              <ChevronLeft className="w-4 h-4" />
              Back to sign in options
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Email form mode
  if (mode === "email-signin" || mode === "email-signup") {
    const isSignUp = mode === "email-signup";

    return (
      <div className="h-screen w-screen flex items-center justify-center bg-[var(--bg-primary)]">
        <div className="w-full max-w-md p-8">
          <div className="text-center mb-8">
            <div className="w-20 h-20 rounded-2xl bg-[var(--purple-accent)] mx-auto flex items-center justify-center mb-6">
              <Sparkles className="w-10 h-10 text-white" />
            </div>
            <h1 className="text-2xl font-bold text-[var(--text-primary)] mb-2">
              {isSignUp ? "Create an Account" : "Sign In with Email"}
            </h1>
          </div>

          <div className="glass-card p-8">
            <form onSubmit={handleEmailSubmit} className="space-y-4">
              {error && (
                <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
                  {error}
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">
                  Email
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="form-input w-full"
                  required
                  autoFocus
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">
                  Password
                </label>
                <div className="relative">
                  <input
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={isSignUp ? "Create a password" : "Enter password"}
                    className="form-input w-full pr-10"
                    required
                    minLength={isSignUp ? 8 : undefined}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                {isSignUp && (
                  <p className="text-xs text-[var(--text-tertiary)] mt-1">
                    Must be at least 8 characters
                  </p>
                )}
              </div>

              <button
                type="submit"
                disabled={isLoading}
                className="w-full py-3 px-4 rounded-xl bg-[var(--purple-accent)] hover:bg-[var(--purple-accent-hover)]
                         text-white font-medium transition-all disabled:opacity-50"
              >
                {isLoading ? (
                  <span className="flex items-center justify-center gap-2">
                    <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    {isSignUp ? "Creating account..." : "Signing in..."}
                  </span>
                ) : (
                  isSignUp ? "Create Account" : "Sign In"
                )}
              </button>

              <div className="text-center text-sm">
                {isSignUp ? (
                  <p className="text-[var(--text-secondary)]">
                    Already have an account?{" "}
                    <button
                      type="button"
                      onClick={() => { setMode("email-signin"); setError(null); }}
                      className="text-[var(--text-accent)] hover:underline"
                    >
                      Sign in
                    </button>
                  </p>
                ) : (
                  <p className="text-[var(--text-secondary)]">
                    Don't have an account?{" "}
                    <button
                      type="button"
                      onClick={() => { setMode("email-signup"); setError(null); }}
                      className="text-[var(--text-accent)] hover:underline"
                    >
                      Sign up
                    </button>
                  </p>
                )}
              </div>

              <button
                type="button"
                onClick={() => { setMode("options"); setError(null); }}
                className="w-full flex items-center justify-center gap-2 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              >
                <ChevronLeft className="w-4 h-4" />
                Back to all options
              </button>
            </form>
          </div>
        </div>
      </div>
    );
  }

  // Main options view
  return (
    <div className="h-screen w-screen flex items-center justify-center bg-[var(--bg-primary)]">
      <div className="w-full max-w-md p-8">
        {/* Logo - clickable for hidden skip */}
        <div className="text-center mb-8">
          <button
            onClick={handleLogoClick}
            className="w-20 h-20 rounded-2xl bg-[var(--purple-accent)] mx-auto flex items-center justify-center mb-6
                     cursor-default focus:outline-none"
            aria-label="Nova logo"
          >
            <Sparkles className="w-10 h-10 text-white" />
          </button>
          <h1 className="text-3xl font-bold text-[var(--text-primary)] mb-2">
            Welcome to Nova
          </h1>
          <p className="text-[var(--text-secondary)]">
            Your personal AI assistant
          </p>
        </div>

        {/* Sign In Card */}
        <div className="glass-card p-8 space-y-4">
          <div className="text-center mb-2">
            <h2 className="text-xl font-semibold text-[var(--text-primary)] mb-1">
              Sign in to continue
            </h2>
            <p className="text-sm text-[var(--text-secondary)]">
              Choose your preferred sign-in method
            </p>
          </div>

          {error && (
            <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm text-center">
              {error}
            </div>
          )}

          {/* OAuth Buttons */}
          <div className="space-y-3">
            <button
              onClick={() => handleOAuthSignIn("google")}
              disabled={isLoading}
              className="w-full flex items-center justify-center gap-3 px-4 py-3
                       bg-white hover:bg-gray-50 text-gray-800 font-medium
                       rounded-xl border border-gray-200 transition-all
                       disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <GoogleIcon className="w-5 h-5" />
              <span>Continue with Google</span>
            </button>

            <button
              onClick={() => handleOAuthSignIn("apple")}
              disabled={isLoading}
              className="w-full flex items-center justify-center gap-3 px-4 py-3
                       bg-black hover:bg-gray-900 text-white font-medium
                       rounded-xl transition-all
                       disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <AppleIcon className="w-5 h-5" />
              <span>Continue with Apple</span>
            </button>

            <button
              onClick={() => handleOAuthSignIn("discord")}
              disabled={isLoading}
              className="w-full flex items-center justify-center gap-3 px-4 py-3
                       bg-[#5865F2] hover:bg-[#4752C4] text-white font-medium
                       rounded-xl transition-all
                       disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <DiscordIcon className="w-5 h-5" />
              <span>Continue with Discord</span>
            </button>
          </div>

          {/* Divider */}
          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-[var(--glass-border-subtle)]" />
            </div>
            <div className="relative flex justify-center text-sm">
              <span className="px-3 bg-[var(--bg-secondary)] text-[var(--text-tertiary)]">
                or
              </span>
            </div>
          </div>

          {/* Email Button */}
          <button
            onClick={() => setMode("email-signin")}
            disabled={isLoading}
            className="w-full flex items-center justify-center gap-3 px-4 py-3
                     bg-[var(--glass-bg)] hover:bg-[var(--glass-bg-hover)]
                     text-[var(--text-primary)] font-medium
                     rounded-xl border border-[var(--glass-border)] transition-all
                     disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Mail className="w-5 h-5" />
            <span>Continue with Email</span>
          </button>

          <p className="text-xs text-center text-[var(--text-tertiary)] pt-2">
            By signing in, you agree to our Terms of Service and Privacy Policy
          </p>
        </div>

        {/* Pricing Info */}
        <div className="mt-6 text-center text-sm text-[var(--text-tertiary)]">
          <p>Pay-as-you-go pricing. New accounts get $0.50 free credits.</p>
        </div>
      </div>
    </div>
  );
}
