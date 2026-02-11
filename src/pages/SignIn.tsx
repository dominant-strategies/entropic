import { useState } from "react";
import { Mail, Eye, EyeOff, ChevronLeft, ArrowRight } from "lucide-react";
import novaLogo from "../assets/nova-logo.png";
import {
  signInWithGoogle,
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

  const handleOAuthSignIn = async (provider: "google" | "discord") => {
    setIsLoading(true);
    setError(null);

    try {
      if (provider === "google") await signInWithGoogle();
      else if (provider === "discord") await signInWithDiscord();
      onSignInStarted?.();

      setTimeout(() => {
        if (sessionStorage.getItem('nova_oauth_pending')) {
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

  // Shared container styles
  const containerClasses = "h-screen w-screen flex items-center justify-center bg-[var(--bg-primary)] p-4 transition-colors duration-500";
  const cardClasses = "w-full max-w-[400px] bg-white rounded-3xl shadow-xl p-10 animate-scale-in border border-gray-100/50";
  
  // Own keys mode
  if (mode === "own-keys") {
    return (
      <div className={containerClasses}>
        <div className={cardClasses}>
          <div className="text-center mb-8">
            <div className="w-16 h-16 rounded-2xl bg-transparent mx-auto flex items-center justify-center mb-6">
              <img src={novaLogo} alt="Nova" className="w-16 h-16 rounded-2xl shadow-lg" />
            </div>
            <h1 className="text-2xl font-bold text-gray-900 mb-2">
              Developer Mode
            </h1>
            <p className="text-gray-500">
              Use your own API keys
            </p>
          </div>

          <div className="space-y-6">
            <div className="p-4 rounded-2xl bg-amber-50 border border-amber-100 text-amber-900 text-sm">
              <span className="font-semibold block mb-1">Advanced Setup</span>
              Bypasses Nova billing. You'll need to configure your own API keys in Settings.
            </div>

            <button
              onClick={() => onSkipAuth?.()}
              className="w-full py-4 px-4 rounded-2xl bg-black hover:bg-gray-800
                       text-white font-medium transition-all shadow-lg hover:shadow-xl active:scale-95 duration-200"
            >
              Continue Locally
            </button>

            <button
              onClick={() => setMode("options")}
              className="w-full flex items-center justify-center gap-2 text-sm text-gray-500 hover:text-gray-900 transition-colors py-2"
            >
              <ChevronLeft className="w-4 h-4" />
              Back
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
      <div className={containerClasses}>
        <div className={cardClasses}>
          <div className="text-center mb-8">
            <h1 className="text-2xl font-bold text-gray-900 mb-2">
              {isSignUp ? "Create account" : "Welcome back"}
            </h1>
            <p className="text-gray-500 text-sm">
              {isSignUp ? "Enter your details to get started" : "Enter your email to sign in"}
            </p>
          </div>

          <form onSubmit={handleEmailSubmit} className="space-y-5">
            {error && (
              <div className="p-3 rounded-xl bg-red-50 text-red-600 text-sm border border-red-100 text-center animate-fade-in">
                {error}
              </div>
            )}

            <div className="space-y-4">
              <div>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="name@example.com"
                  className="w-full px-4 py-4 rounded-2xl bg-gray-50 border-none focus:ring-2 focus:ring-black/5 text-gray-900 placeholder:text-gray-400 transition-all text-lg"
                  required
                  autoFocus
                />
              </div>

              <div className="relative">
                <input
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={isSignUp ? "Create password" : "Password"}
                  className="w-full px-4 py-4 rounded-2xl bg-gray-50 border-none focus:ring-2 focus:ring-black/5 text-gray-900 placeholder:text-gray-400 transition-all text-lg pr-12"
                  required
                  minLength={isSignUp ? 8 : undefined}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 p-1"
                >
                  {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={isLoading}
              className="w-full py-4 px-4 rounded-2xl bg-black hover:bg-gray-800
                       text-white font-semibold transition-all shadow-lg hover:shadow-xl active:scale-95 duration-200
                       disabled:opacity-50 disabled:scale-100 flex items-center justify-center gap-2"
            >
              {isLoading && <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />}
              {isSignUp ? "Create Account" : "Sign In"}
            </button>

            <div className="flex flex-col items-center gap-4 pt-2">
              <button
                type="button"
                onClick={() => { setMode(isSignUp ? "email-signin" : "email-signup"); setError(null); }}
                className="text-sm text-gray-600 hover:text-black font-medium transition-colors"
              >
                {isSignUp ? "Already have an account? Sign in" : "No account? Create one"}
              </button>

              <button
                type="button"
                onClick={() => { setMode("options"); setError(null); }}
                className="flex items-center gap-1 text-sm text-gray-400 hover:text-gray-600 transition-colors"
              >
                <ChevronLeft className="w-3 h-3" />
                All options
              </button>
            </div>
          </form>
        </div>
      </div>
    );
  }

  // Main options view
  return (
    <div className={containerClasses}>
      <div className={cardClasses}>
        <div className="text-center mb-10">
          <button
            onClick={handleLogoClick}
            className="w-20 h-20 rounded-[2rem] bg-transparent mx-auto flex items-center justify-center mb-8
                     cursor-default focus:outline-none transition-transform hover:scale-105 active:scale-95 duration-300"
            aria-label="Nova logo"
          >
            <img src={novaLogo} alt="Nova" className="w-20 h-20 rounded-[2rem] shadow-xl" />
          </button>
          <h1 className="text-3xl font-bold text-gray-900 mb-3 tracking-tight">
            Nova
          </h1>
          <p className="text-gray-500 font-medium">
            Your personal AI workspace
          </p>
        </div>

        {error && (
          <div className="mb-6 p-3 rounded-xl bg-red-50 text-red-600 text-sm border border-red-100 text-center animate-fade-in">
            {error}
          </div>
        )}

        <div className="space-y-3">
          <button
            onClick={() => handleOAuthSignIn("google")}
            disabled={isLoading}
            className="w-full flex items-center justify-center gap-3 px-4 py-4
                     bg-white hover:bg-gray-50 text-gray-700 font-medium
                     rounded-2xl border border-gray-200 transition-all hover:border-gray-300
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
                     rounded-2xl transition-all shadow-md hover:shadow-lg active:scale-95 duration-200
                     disabled:opacity-50"
          >
            <DiscordIcon className="w-5 h-5" />
            <span>Continue with Discord</span>
          </button>

          <div className="relative py-4">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-gray-100" />
            </div>
            <div className="relative flex justify-center text-xs uppercase tracking-wider">
              <span className="bg-white px-2 text-gray-400">or</span>
            </div>
          </div>

          <button
            onClick={() => setMode("email-signin")}
            disabled={isLoading}
            className="w-full flex items-center justify-center gap-3 px-4 py-4
                     bg-gray-50 hover:bg-gray-100
                     text-gray-900 font-medium
                     rounded-2xl transition-all active:scale-95 duration-200
                     disabled:opacity-50"
          >
            <Mail className="w-5 h-5 text-gray-500" />
            <span>Continue with Email</span>
          </button>
        </div>

        <p className="text-[10px] text-center text-gray-400 mt-8 max-w-xs mx-auto leading-relaxed">
          By continuing, you agree to our Terms of Service and Privacy Policy.
        </p>
      </div>
    </div>
  );
}
