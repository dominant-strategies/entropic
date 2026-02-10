import { useState, useEffect, useRef } from "react";
import { CreditCard, TrendingUp, AlertCircle, ExternalLink, RefreshCw } from "lucide-react";
import { open } from "@tauri-apps/plugin-shell";
import { useAuth } from "../contexts/AuthContext";
import { getUsage, createCheckout, UsageResponse } from "../lib/auth";

const CREDIT_AMOUNTS = [
  { cents: 500, label: "$5" },
  { cents: 1000, label: "$10" },
  { cents: 2500, label: "$25" },
  { cents: 5000, label: "$50" },
];
const BALANCE_POLL_INTERVAL_MS = 10000;
const BALANCE_POLL_DURATION_MS = 5 * 60 * 1000;
const USAGE_CACHE_KEY = "nova_usage_cache_v1";
const USAGE_CACHE_TTL_MS = 5 * 60 * 1000;

export function Billing() {
  const { balance, refreshBalance } = useAuth();
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [isLoadingUsage, setIsLoadingUsage] = useState(true);
  const [isAddingCredits, setIsAddingCredits] = useState(false);
  const [selectedAmount, setSelectedAmount] = useState(1000);
  const pollIntervalRef = useRef<number | null>(null);
  const pollTimeoutRef = useRef<number | null>(null);

  function stopBalancePolling() {
    if (pollIntervalRef.current !== null) {
      window.clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
    if (pollTimeoutRef.current !== null) {
      window.clearTimeout(pollTimeoutRef.current);
      pollTimeoutRef.current = null;
    }
  }

  function startBalancePolling() {
    stopBalancePolling();
    refreshBalance();
    pollIntervalRef.current = window.setInterval(() => {
      refreshBalance();
    }, BALANCE_POLL_INTERVAL_MS);
    pollTimeoutRef.current = window.setTimeout(() => {
      stopBalancePolling();
    }, BALANCE_POLL_DURATION_MS);
  }

  useEffect(() => {
    const cached = readUsageCache();
    if (cached) {
      setUsage(cached.data);
      setIsLoadingUsage(false);
    }
    if (!cached) {
      loadUsage();
    }
    if (!balance) {
      refreshBalance();
    }
    return () => {
      stopBalancePolling();
    };
  }, [refreshBalance, balance]);

  function readUsageCache(): { data: UsageResponse; ts: number } | null {
    try {
      const raw = sessionStorage.getItem(USAGE_CACHE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { ts: number; data: UsageResponse };
      if (!parsed?.data || typeof parsed.ts !== "number") return null;
      if (Date.now() - parsed.ts > USAGE_CACHE_TTL_MS) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  function writeUsageCache(data: UsageResponse) {
    try {
      sessionStorage.setItem(
        USAGE_CACHE_KEY,
        JSON.stringify({ ts: Date.now(), data })
      );
    } catch {
      // Ignore cache failures
    }
  }

  async function loadUsage(opts?: { background?: boolean; force?: boolean }) {
    if (!opts?.background) {
      setIsLoadingUsage(true);
    }
    if (!opts?.force) {
      const cached = readUsageCache();
      if (cached) {
        setUsage(cached.data);
        setIsLoadingUsage(false);
        return;
      }
    }
    try {
      const data = await getUsage(30);
      setUsage(data);
      writeUsageCache(data);
    } catch (error) {
      console.error("Failed to load usage:", error);
    } finally {
      setIsLoadingUsage(false);
    }
  }

  async function handleAddCredits() {
    setIsAddingCredits(true);
    try {
      const { checkout_url } = await createCheckout(selectedAmount);
      if (checkout_url) {
        startBalancePolling();
        await open(checkout_url);
      }
    } catch (error) {
      console.error("Failed to create checkout:", error);
    } finally {
      setIsAddingCredits(false);
    }
  }

  const balanceDollars = balance ? parseFloat(balance.balance_dollars) : 0;
  const isLowBalance = balanceDollars < 1;

  return (
    <div className="space-y-6">
      {/* Current Balance */}
      <div className="glass-card p-6">
        <div className="flex items-start justify-between">
          <div>
            <div className="text-sm text-[var(--text-tertiary)] mb-1">Current Balance</div>
            <div className="text-4xl font-bold text-[var(--text-primary)]">
              ${balance?.balance_dollars || "0.00"}
            </div>
            {isLowBalance && (
              <div className="flex items-center gap-2 mt-2 text-amber-400 text-sm">
                <AlertCircle className="w-4 h-4" />
                <span>Low balance - add credits to continue using Nova</span>
              </div>
            )}
          </div>
          <button
            onClick={refreshBalance}
            className="p-2 rounded-lg hover:bg-[var(--bg-tertiary)] transition-colors"
            title="Refresh balance"
          >
            <RefreshCw className="w-5 h-5 text-[var(--text-tertiary)]" />
          </button>
        </div>
      </div>

      {/* Add Credits */}
      <div className="glass-card p-6">
        <h3 className="text-lg font-semibold text-[var(--text-primary)] mb-4 flex items-center gap-2">
          <CreditCard className="w-5 h-5" />
          Add Credits
        </h3>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
          {CREDIT_AMOUNTS.map(({ cents, label }) => (
            <button
              key={cents}
              onClick={() => setSelectedAmount(cents)}
              className={`py-3 px-4 rounded-xl font-medium transition-all
                        ${selectedAmount === cents
                          ? "bg-[var(--purple-accent)] text-white"
                          : "bg-[var(--bg-tertiary)] text-[var(--text-primary)] hover:bg-[var(--bg-secondary)]"
                        }`}
            >
              {label}
            </button>
          ))}
        </div>

        <button
          onClick={handleAddCredits}
          disabled={isAddingCredits}
          className="w-full btn-primary flex items-center justify-center gap-2"
        >
          {isAddingCredits ? (
            <>
              <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              Opening checkout...
            </>
          ) : (
            <>
              <ExternalLink className="w-4 h-4" />
              Add ${(selectedAmount / 100).toFixed(0)} Credits
            </>
          )}
        </button>

        <p className="text-xs text-[var(--text-tertiary)] mt-3 text-center">
          Secure payment via Stripe. Credits never expire.
        </p>
      </div>

      {/* Usage Summary */}
      <div className="glass-card p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-[var(--text-primary)] flex items-center gap-2">
            <TrendingUp className="w-5 h-5" />
            Usage (Last 30 Days)
          </h3>
        </div>

        {isLoadingUsage ? (
          <div className="flex items-center justify-center py-8">
            <div className="w-6 h-6 border-2 border-[var(--purple-accent)]/30 border-t-[var(--purple-accent)] rounded-full animate-spin" />
          </div>
        ) : usage ? (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="bg-[var(--bg-tertiary)] rounded-xl p-4">
                <div className="text-2xl font-bold text-[var(--text-primary)]">
                  {usage.total_requests}
                </div>
                <div className="text-sm text-[var(--text-tertiary)]">Requests</div>
              </div>
              <div className="bg-[var(--bg-tertiary)] rounded-xl p-4">
                <div className="text-2xl font-bold text-[var(--text-primary)]">
                  ${usage.total_cost_dollars}
                </div>
                <div className="text-sm text-[var(--text-tertiary)]">Spent</div>
              </div>
            </div>

            {Object.keys(usage.by_model ?? {}).length > 0 && (
              <div>
                <div className="text-sm font-medium text-[var(--text-secondary)] mb-2">
                  By Model
                </div>
                <div className="space-y-2">
                  {Object.entries(usage.by_model ?? {}).map(([model, data]) => {
                    const modelName = model.split("/").pop() || model;
                    return (
                      <div
                        key={model}
                        className="flex items-center justify-between py-2 px-3
                                 bg-[var(--bg-tertiary)] rounded-lg"
                      >
                        <span className="text-sm text-[var(--text-primary)]">
                          {modelName}
                        </span>
                        <div className="text-right">
                          <span className="text-sm font-medium text-[var(--text-primary)]">
                            ${(data.cost / 100).toFixed(2)}
                          </span>
                          <span className="text-xs text-[var(--text-tertiary)] ml-2">
                            ({data.requests} req)
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="text-center py-8 text-[var(--text-tertiary)]">
            No usage data available
          </div>
        )}
      </div>
    </div>
  );
}
