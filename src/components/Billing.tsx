import { useState, useEffect, useRef } from "react";
import { CreditCard, TrendingUp, AlertCircle, ExternalLink, RefreshCw, Wallet } from "lucide-react";
import { open } from "@tauri-apps/plugin-shell";
import { useAuth } from "../contexts/AuthContext";
import { getUsage, createCheckout, UsageResponse } from "../lib/auth";

const CREDIT_AMOUNTS = [
  { cents: 1000, label: "$10" },
  { cents: 2500, label: "$25" },
  { cents: 5000, label: "$50" },
  { cents: 10000, label: "$100" },
];
const BALANCE_POLL_INTERVAL_MS = 10000;
const BALANCE_POLL_DURATION_MS = 5 * 60 * 1000;
const USAGE_CACHE_KEY = "entropic_usage_cache_v1";
const USAGE_CACHE_TTL_MS = 5 * 60 * 1000;

function BillingGroup({ title, children }: { title?: string, children: React.ReactNode }) {
  return (
    <div className="mb-8">
      {title && (
        <h3 className="text-[13px] font-medium text-[var(--text-secondary)] uppercase tracking-wide mb-2 px-1">
          {title}
        </h3>
      )}
      <div className="bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-xl overflow-hidden shadow-sm">
        {children}
      </div>
    </div>
  );
}

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
    <div className="max-w-3xl mx-auto py-8 px-4">
      <h1 className="text-2xl font-bold mb-8 px-1">Account & Billing</h1>

      <BillingGroup title="Current Balance">
        <div className="p-6">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-[var(--system-gray-6)] flex items-center justify-center text-[var(--system-blue)]">
                <Wallet className="w-5 h-5" />
              </div>
              <div>
                <div className="text-3xl font-bold text-[var(--text-primary)] tracking-tight">
                  ${balance?.balance_dollars || "0.00"}
                </div>
                {isLowBalance && (
                  <div className="flex items-center gap-1.5 mt-1 text-amber-500 text-xs font-medium">
                    <AlertCircle className="w-3.5 h-3.5" />
                    <span>Low balance</span>
                  </div>
                )}
              </div>
            </div>
            <button
              onClick={refreshBalance}
              aria-label="Refresh balance"
              className="p-2 rounded-full hover:bg-[var(--system-gray-6)] transition-colors text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
          </div>
        </div>
      </BillingGroup>

      <BillingGroup title="Add Credits">
        <div className="p-6">
          <div className="flex flex-wrap gap-3 mb-6">
            {CREDIT_AMOUNTS.map(({ cents, label }) => (
              <button
                key={cents}
                onClick={() => setSelectedAmount(cents)}
                className={`flex-1 py-3 px-4 rounded-lg font-medium text-sm transition-all border
                          ${selectedAmount === cents
                            ? "bg-[var(--system-blue)] border-transparent text-white shadow-sm"
                            : "bg-[var(--bg-card)] border-[var(--border-default)] text-[var(--text-primary)] hover:bg-[var(--system-gray-6)]"
                          }`}
              >
                {label}
              </button>
            ))}
          </div>

          <button
            onClick={handleAddCredits}
            disabled={isAddingCredits}
            className="w-full py-3 bg-[var(--purple-accent)] text-white rounded-lg font-medium text-sm hover:bg-[var(--purple-accent-hover)] disabled:opacity-50 transition-colors flex items-center justify-center gap-2"
          >
            {isAddingCredits ? (
              <>
                <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                Processing...
              </>
            ) : (
              <>
                Add Funds with Stripe
                <ExternalLink className="w-3.5 h-3.5 opacity-70" />
              </>
            )}
          </button>
          <p className="text-[11px] text-[var(--text-tertiary)] mt-3 text-center">
            Payments are secure and encrypted. Credits do not expire.
          </p>
        </div>
      </BillingGroup>

      <BillingGroup title="Recent Usage (30 Days)">
        {isLoadingUsage ? (
          <div className="p-8 flex justify-center">
            <div className="w-6 h-6 border-2 border-[var(--system-gray-3)] border-t-[var(--text-primary)] rounded-full animate-spin" />
          </div>
        ) : usage ? (
          <div className="divide-y divide-[var(--border-subtle)]">
            <div className="grid grid-cols-2 divide-x divide-[var(--border-subtle)]">
              <div className="p-4 text-center">
                <div className="text-2xl font-semibold text-[var(--text-primary)]">{usage.total_requests}</div>
                <div className="text-xs text-[var(--text-secondary)] uppercase tracking-wide mt-1">Requests</div>
              </div>
              <div className="p-4 text-center">
                <div className="text-2xl font-semibold text-[var(--text-primary)]">${usage.total_cost_dollars}</div>
                <div className="text-xs text-[var(--text-secondary)] uppercase tracking-wide mt-1">Total Cost</div>
              </div>
            </div>

            {Object.keys(usage.by_model ?? {}).length > 0 && (
              <div className="bg-[var(--system-gray-6)]/30">
                {Object.entries(usage.by_model ?? {}).map(([model, data]) => {
                  const modelName = model.split("/").pop() || model;
                  return (
                    <div key={model} className="flex items-center justify-between py-3 px-4 border-b border-[var(--border-subtle)] last:border-0">
                      <span className="text-sm font-medium text-[var(--text-primary)]">{modelName}</span>
                      <div className="text-right">
                        <span className="text-sm text-[var(--text-primary)]">${(data.cost / 100).toFixed(4)}</span>
                        <span className="text-xs text-[var(--text-tertiary)] ml-2 w-12 inline-block text-right">{data.requests} reqs</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ) : (
          <div className="p-8 text-center text-[var(--text-tertiary)] text-sm">
            No recent usage activity.
          </div>
        )}
      </BillingGroup>
    </div>
  );
}
