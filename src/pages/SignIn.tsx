import { useState } from "react";
import { Mail, Eye, EyeOff, ChevronLeft, ArrowRight } from "lucide-react";
import { open } from "@tauri-apps/plugin-shell";
import entropicLogo from "../assets/entropic-logo.png";
import {
  signInWithGoogle,
  signInWithDiscord,
  signInWithEmail,
  signUpWithEmail,
} from "../lib/auth";
import { GoogleIcon, DiscordIcon } from "../components/OAuthIcons";

type AuthMode = "options" | "email-signin" | "email-signup" | "own-keys";

type Props = {
  onSignInStarted?: () => void;
  onSkipAuth?: () => void;
};

export function SignIn({ onSignInStarted, onSkipAuth }: Props) {
  const [mode, setMode] = useState<AuthMode>("options");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signupNotice, setSignupNotice] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [skipClickCount, setSkipClickCount] = useState(0);

  const handleOAuthSignIn = async (provider: "google" | "discord") => {
    setIsLoading(true);
    setError(null);

    try {
      if (provider === "google") await signInWithGoogle();
      else if (provider === "discord") await signInWithDiscord();
      onSignInStarted?.();

      setTimeout(() => {
        if (sessionStorage.getItem('entropic_oauth_pending')) {
          setError("Sign in is taking longer than expected. If the browser window didn't open, please try again.");
          setIsLoading(false);
        }
      }, 10000);
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
        setSignupNotice("Check your email for a confirmation link!");
        setMode("email-signin");
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

  // Shared container styles
  const containerClasses = "h-screen w-screen flex items-center justify-center bg-[var(--bg-primary)] p-4";
  const cardClasses = "w-full max-w-[400px] bg-[var(--bg-card)] rounded-2xl shadow-xl p-10 animate-scale-in border border-[var(--border-subtle)]";

  // Own keys mode
  if (mode === "own-keys") {
    return (
      <div className={containerClasses}>
        <main className={cardClasses}>
          <div className="text-center mb-8">
            <div className="w-16 h-16 rounded-2xl bg-transparent mx-auto flex items-center justify-center mb-6">
              <img src={entropicLogo} alt="Entropic" width={64} height={64} className="w-16 h-16 rounded-2xl shadow-lg" />
            </div>
            <h1 className="text-2xl font-bold text-[var(--text-primary)] mb-2">
              Developer Mode
            </h1>
            <p className="text-[var(--text-secondary)]">
              Use your own API keys
            </p>
          </div>

          <div className="space-y-6">
            <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/20 text-[var(--text-primary)] text-sm">
              <span className="font-semibold block mb-1">Advanced Setup</span>
              <span className="text-[var(--text-secondary)]">Bypasses Entropic billing. You'll need to configure your own API keys in Settings.</span>
            </div>

            <button
              onClick={() => onSkipAuth?.()}
              className="w-full py-4 px-4 rounded-xl bg-[#1A1A2E] hover:opacity-90
                       text-white font-medium shadow-lg hover:shadow-xl active:scale-95 duration-200"
            >
              Continue Locally
            </button>

            <button
              onClick={() => setMode("options")}
              className="w-full flex items-center justify-center gap-2 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors py-2"
            >
              <ChevronLeft className="w-4 h-4" />
              Back
            </button>
          </div>
        </main>
      </div>
    );
  }

  // Email form mode
  if (mode === "email-signin" || mode === "email-signup") {
    const isSignUp = mode === "email-signup";

    return (
      <div className={containerClasses}>
        <main className={cardClasses}>
          <div className="text-center mb-8">
            <h1 className="text-2xl font-bold text-[var(--text-primary)] mb-2">
              {isSignUp ? "Create account" : "Welcome back"}
            </h1>
            <p className="text-[var(--text-secondary)] text-sm">
              {isSignUp ? "Enter your details to get started" : "Enter your email to sign in"}
            </p>
          </div>

          <form onSubmit={handleEmailSubmit} className="space-y-5">
            {signupNotice && (
              <div className="p-3 rounded-xl bg-emerald-500/10 text-emerald-500 text-sm border border-emerald-500/20 text-center animate-fade-in">
                {signupNotice}
              </div>
            )}

            {error && (
              <div className="p-3 rounded-xl bg-red-500/10 text-red-500 text-sm border border-red-500/20 text-center animate-fade-in">
                {error}
              </div>
            )}

            <div className="space-y-4">
              <div>
                <label htmlFor="signin-email" className="sr-only">Email address</label>
                <input
                  id="signin-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="name@example.com"
                  className="w-full px-4 py-4 rounded-xl bg-[var(--system-gray-6)] border-none focus:ring-2 focus:ring-[var(--system-blue)]/20 text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] text-lg"
                  required
                  autoFocus
                />
              </div>

              <div className="relative">
                <label htmlFor="signin-password" className="sr-only">Password</label>
                <input
                  id="signin-password"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={isSignUp ? "Create password" : "Password"}
                  className="w-full px-4 py-4 rounded-xl bg-[var(--system-gray-6)] border-none focus:ring-2 focus:ring-[var(--system-blue)]/20 text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] text-lg pr-12"
                  required
                  minLength={isSignUp ? 8 : undefined}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-4 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] p-1"
                  aria-label={showPassword ? "Hide password" : "Show password"}
                >
                  {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={isLoading}
              className="w-full py-4 px-4 rounded-xl bg-[#1A1A2E] hover:opacity-90
                       text-white font-semibold shadow-lg hover:shadow-xl active:scale-95 duration-200
                       disabled:opacity-50 disabled:scale-100 flex items-center justify-center gap-2"
            >
              {isLoading && <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />}
              {isSignUp ? "Create Account" : "Sign In"}
            </button>

            <div className="flex flex-col items-center gap-4 pt-2">
              <button
                type="button"
                onClick={() => { setMode(isSignUp ? "email-signin" : "email-signup"); setError(null); setSignupNotice(null); }}
                className="text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] font-medium transition-colors"
              >
                {isSignUp ? "Already have an account? Sign in" : "No account? Create one"}
              </button>

              <button
                type="button"
                onClick={() => { setMode("options"); setError(null); setSignupNotice(null); }}
                className="flex items-center gap-1 text-sm text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] transition-colors"
              >
                <ChevronLeft className="w-3 h-3" />
                All options
              </button>
            </div>
          </form>
        </main>
      </div>
    );
  }

  // Main options view
  return (
    <div className={containerClasses}>
      <main className={cardClasses}>
        <div className="text-center mb-10">
          <button
            onClick={handleLogoClick}
            className="w-20 h-20 rounded-[2rem] bg-transparent mx-auto flex items-center justify-center mb-8
                     cursor-default transition-transform hover:scale-105 active:scale-95 duration-300"
            aria-label="Entropic logo"
          >
            <img src={entropicLogo} alt="Entropic" width={80} height={80} className="w-20 h-20 rounded-[2rem] shadow-xl" />
          </button>
          <h1 className="text-3xl font-bold text-[var(--text-primary)] mb-3 tracking-tight">
            Entropic
          </h1>
          <p className="text-[var(--text-secondary)] font-medium">
            Your personal AI workspace
          </p>
        </div>

        {error && (
          <div className="mb-6 p-3 rounded-xl bg-red-500/10 text-red-500 text-sm border border-red-500/20 text-center animate-fade-in">
            {error}
          </div>
        )}

        <div className="space-y-3">
          <button
            onClick={() => handleOAuthSignIn("google")}
            disabled={isLoading}
            className="w-full flex items-center justify-center gap-3 px-4 py-4
                     bg-[var(--bg-card)] hover:bg-[var(--system-gray-6)] text-[var(--text-primary)] font-medium
                     rounded-xl border border-[var(--border-default)]
                     active:scale-95 duration-200 disabled:opacity-50"
          >
            <GoogleIcon className="w-5 h-5" />
            <span>Continue with Google</span>
          </button>

          <button
            onClick={() => handleOAuthSignIn("discord")}
            disabled={isLoading}
            className="w-full flex items-center justify-center gap-3 px-4 py-4
                     bg-[#5865F2] hover:bg-[#4752C4] text-white font-medium
                     rounded-xl shadow-md hover:shadow-lg active:scale-95 duration-200
                     disabled:opacity-50"
          >
            <DiscordIcon className="w-5 h-5" />
            <span>Continue with Discord</span>
          </button>

          <div className="relative py-4">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-[var(--border-subtle)]" />
            </div>
            <div className="relative flex justify-center text-xs uppercase tracking-wider">
              <span className="bg-[var(--bg-card)] px-2 text-[var(--text-tertiary)]">or</span>
            </div>
          </div>

          <button
            onClick={() => setMode("email-signin")}
            disabled={isLoading}
            className="w-full flex items-center justify-center gap-3 px-4 py-4
                     bg-[var(--system-gray-6)] hover:bg-[var(--system-gray-5)]
                     text-[var(--text-primary)] font-medium
                     rounded-xl active:scale-95 duration-200
                     disabled:opacity-50"
          >
            <Mail className="w-5 h-5 text-[var(--text-secondary)]" />
            <span>Continue with Email</span>
          </button>
        </div>

        <p className="text-xs text-center text-[var(--text-secondary)] mt-8 max-w-xs mx-auto leading-relaxed">
          By continuing, you agree to our{" "}
          <button type="button" onClick={() => open("https://entropic.qu.ai/terms")} className="underline text-[var(--text-primary)] hover:opacity-80">Terms of Service</button>
          {" "}and{" "}
          <button type="button" onClick={() => open("https://entropic.qu.ai/privacy")} className="underline text-[var(--text-primary)] hover:opacity-80">Privacy Policy</button>.
        </p>
      </main>
    </div>
  );
}
