import { Billing } from "../components/Billing";
import { useEffect, useState } from "react";
import { useAuth } from "../contexts/AuthContext";
import {
  signInWithGoogle,
  signInWithDiscord,
  signInWithEmail,
  signUpWithEmail,
} from "../lib/auth";
import {
  getLocalCreditBalance,
  getLocalUsageSummary,
  LocalBalanceResponse,
  LocalUsageResponse,
} from "../lib/localCredits";
import { OAuthButtons } from "../components/OAuthButtons";

export function BillingPage() {
  const { isAuthenticated, isAuthConfigured } = useAuth();
  const [localBalance, setLocalBalance] = useState<LocalBalanceResponse | null>(null);
  const [localUsage, setLocalUsage] = useState<LocalUsageResponse | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authNotice, setAuthNotice] = useState<string | null>(null);

  useEffect(() => {
    if (isAuthenticated || !isAuthConfigured) {
      return;
    }
    let cancelled = false;
    const load = async () => {
      const [balanceResult, usageResult] = await Promise.allSettled([
        getLocalCreditBalance(),
        getLocalUsageSummary(30),
      ]);

      if (cancelled) return;

      if (balanceResult.status === "fulfilled") {
        setLocalBalance(balanceResult.value);
      } else {
        console.warn("[Entropic] Failed to load local trial balance:", balanceResult.reason);
      }

      if (usageResult.status === "fulfilled") {
        setLocalUsage(usageResult.value);
      } else {
        console.warn("[Entropic] Failed to load local trial usage:", usageResult.reason);
      }
    };
    load();

    const onLocalCreditsChanged = () => load();
    window.addEventListener("entropic-local-credits-changed", onLocalCreditsChanged);
    return () => {
      cancelled = true;
      window.removeEventListener("entropic-local-credits-changed", onLocalCreditsChanged);
    };
  }, [isAuthenticated, isAuthConfigured]);

  if (!isAuthenticated) {
    const localBalanceCents = localBalance?.balance_cents ?? 0;
    const trialExhausted = localBalanceCents <= 0;

    const handleOAuthSignIn = async (provider: "google" | "discord") => {
      setAuthError(null);
      setAuthNotice(null);
      try {
        if (provider === "google") {
          await signInWithGoogle();
        } else {
          await signInWithDiscord();
        }
      } catch (err) {
        console.error("Billing OAuth sign in failed:", err);
        setAuthError("Failed to start sign in. Please try again.");
      }
    };

    const handleEmailSignIn = async (email: string, password: string) => {
      setAuthError(null);
      setAuthNotice(null);
      try {
        await signInWithEmail(email, password);
      } catch (err: any) {
        console.error("Billing email auth failed:", err);
        setAuthError(err?.message || "Authentication failed. Please try again.");
      }
    };

    const handleEmailSignUp = async (email: string, password: string) => {
      setAuthError(null);
      setAuthNotice(null);
      try {
        await signUpWithEmail(email, password);
        setAuthNotice("Check your email to confirm your account, then sign in.");
      } catch (err: any) {
        console.error("Billing email auth failed:", err);
        setAuthError(err?.message || "Authentication failed. Please try again.");
      }
    };

    const clearFeedback = () => {
      setAuthError(null);
      setAuthNotice(null);
    };

    return (
      <div className="p-6 h-full flex flex-col">
        <div className="mb-4">
          <h1 className="text-xl font-semibold text-[var(--text-primary)]">
            Billing
          </h1>
          <p className="text-sm text-[var(--text-tertiary)]">
            Free trial credits
          </p>
        </div>
        <div className="flex-1 overflow-auto">
          <div className="max-w-3xl mx-auto py-8 px-4">
            <div className="bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-xl shadow-sm p-6 mb-6">
              <p className="text-xs uppercase tracking-wide text-[var(--text-tertiary)] mb-2">
                Remaining Free Credits
              </p>
              <p className="text-3xl font-semibold text-[var(--text-primary)]">
                ${localBalance?.balance_dollars || "0.00"}
              </p>
              <p className="text-sm text-[var(--text-secondary)] mt-2">
                You can use free trial credits without signing in. Billing starts only after sign-in.
              </p>
            </div>

            <div className="bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-xl shadow-sm p-6 mb-6">
              <p className="text-xs uppercase tracking-wide text-[var(--text-tertiary)] mb-3">
                Trial Usage (30 Days)
              </p>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-2xl font-semibold text-[var(--text-primary)]">
                    {localUsage?.total_requests || 0}
                  </p>
                  <p className="text-xs text-[var(--text-secondary)]">Requests</p>
                </div>
                <div>
                  <p className="text-2xl font-semibold text-[var(--text-primary)]">
                    ${localUsage?.total_cost_dollars || "0.00"}
                  </p>
                  <p className="text-xs text-[var(--text-secondary)]">Estimated Cost</p>
                </div>
              </div>
            </div>

            <div className="bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-xl shadow-sm p-6">
              <p className="text-xs uppercase tracking-wide text-[var(--text-tertiary)] mb-2">
                Add More Credits
              </p>
              <p className="text-sm text-[var(--text-secondary)] mb-4">
                {!isAuthConfigured
                  ? "Cloud billing is not configured in this build. Use local provider keys in Settings."
                  : trialExhausted
                    ? "Sign in to continue and add paid credits with Stripe."
                    : "Sign in anytime to transfer your remaining free credits to your account, then add more with Stripe."}
              </p>
              {isAuthConfigured ? (
                <OAuthButtons
                  onOAuthSignIn={handleOAuthSignIn}
                  onEmailSignIn={handleEmailSignIn}
                  onEmailSignUp={handleEmailSignUp}
                  error={authError}
                  notice={authNotice}
                  onClearFeedback={clearFeedback}
                />
              ) : null}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 h-full flex flex-col">
      <div className="mb-4">
        <h1 className="text-xl font-semibold text-[var(--text-primary)]">
          Billing
        </h1>
        <p className="text-sm text-[var(--text-tertiary)]">
          Credits, usage, and payments
        </p>
      </div>
      <div className="flex-1 overflow-auto">
        <Billing />
      </div>
    </div>
  );
}
