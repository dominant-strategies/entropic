import { useEffect, useMemo, useState } from "react";
import { X, Loader2, ShieldCheck, ShieldAlert, AlertTriangle, ChevronDown, ChevronRight, CheckCircle2, Circle } from "lucide-react";
import clsx from "clsx";

type ScanFinding = {
  analyzer?: string;
  category?: string;
  severity: string;
  title: string;
  description: string;
  file_path?: string;
  line_number?: number;
  snippet?: string;
  remediation?: string;
};

export type PluginScanResult = {
  scan_id?: string;
  is_safe: boolean;
  max_severity: string;
  findings_count: number;
  findings: ScanFinding[];
  scanner_available: boolean;
};

type Props = {
  isOpen: boolean;
  targetName: string;
  targetType?: "plugin" | "skill";
  scanResult: PluginScanResult | null;
  isScanning: boolean;
  error: string | null;
  onClose: () => void;
  onRetry?: () => void;
  onConfirm?: () => void;
  confirmLabel?: string;
  confirmAnywayLabel?: string;
};

const SEVERITY_COLORS: Record<string, string> = {
  CRITICAL: "text-red-500 bg-red-500/15",
  HIGH: "text-red-500 bg-red-500/10",
  MEDIUM: "text-yellow-500 bg-yellow-500/10",
  LOW: "text-blue-500 bg-blue-500/10",
  INFO: "text-[var(--text-secondary)] bg-[var(--bg-tertiary)]",
};

export function ScanResultModal({
  isOpen, targetName, targetType = "plugin", scanResult, isScanning, error,
  onClose, onRetry, onConfirm, confirmLabel = "Enable Plugin", confirmAnywayLabel = "Enable Anyway",
}: Props) {
  const [expandedFindings, setExpandedFindings] = useState<Set<number>>(new Set());
  const [scanElapsedSeconds, setScanElapsedSeconds] = useState(0);

  const isBlocked = scanResult && !scanResult.is_safe &&
    ["CRITICAL", "HIGH"].includes(scanResult.max_severity);
  const scannerUnavailable = !!scanResult && !scanResult.scanner_available;
  const scanPassed = !!scanResult && scanResult.is_safe;

  useEffect(() => {
    if (!isOpen) {
      setScanElapsedSeconds(0);
      return;
    }
    if (!isScanning) {
      return;
    }
    setScanElapsedSeconds(0);
    const timer = window.setInterval(() => {
      setScanElapsedSeconds((prev) => prev + 1);
    }, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [isOpen, isScanning]);

  const scanStages = useMemo(
    () => [
      {
        title: "Prepare isolated scanner runtime",
        detail: "Starting scanner dependencies and workspace sandbox",
        completeAfterSeconds: 2,
      },
      {
        title: `Inspect ${targetType} files and manifest`,
        detail: "Collecting package metadata and behavior signals",
        completeAfterSeconds: 6,
      },
      {
        title: "Run static + behavioral checks",
        detail: "Evaluating permissions, network usage, and execution patterns",
        completeAfterSeconds: 12,
      },
      {
        title: "Generate security report",
        detail: "Scoring findings and preparing final recommendation",
        completeAfterSeconds: 18,
      },
    ],
    [targetType]
  );
  const scanProgress = Math.min(100, Math.max(8, Math.round((scanElapsedSeconds / 18) * 100)));
  const normalizedError = (error || "").trim();
  const errorLower = normalizedError.toLowerCase();
  const errorState = (() => {
    if (!normalizedError) {
      return null;
    }
    if (
      errorLower.includes("scanner unavailable") ||
      errorLower.includes("failed to check scanner")
    ) {
      return {
        title: "Scanner unavailable",
        tone: "amber",
        body: "The security scanner is not running right now, so we couldn't verify this item yet.",
        hint: "Try again in a few seconds after the scanner runtime comes up.",
      };
    }
    if (
      errorLower.includes("scanner may not be ready") ||
      errorLower.includes("connection refused") ||
      errorLower.includes("connection closed") ||
      errorLower.includes("scan request failed after retries")
    ) {
      return {
        title: "Scanner is still starting",
        tone: "amber",
        body: "The scanner looks like it was warming up when this check ran.",
        hint: "Retrying usually works once the scanner container is fully ready.",
      };
    }
    return {
      title: "Security scan failed",
      tone: "red",
      body: "We couldn't complete the scan because the scanner backend returned an unexpected error.",
      hint: normalizedError,
    };
  })();

  if (!isOpen) return null;

  function toggleFinding(idx: number) {
    const next = new Set(expandedFindings);
    if (next.has(idx)) next.delete(idx); else next.add(idx);
    setExpandedFindings(next);
  }

  return (
    <div className="fixed inset-0 bg-black/20 flex items-center justify-center z-50"
         onClick={onClose}
         onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}>
      <div className="bg-[var(--bg-card)] p-6 w-full max-w-lg m-4 max-h-[80vh] overflow-y-auto rounded-2xl shadow-xl border border-[var(--border-subtle)]"
           onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-[var(--text-primary)]">
            {isScanning ? `Installing ${targetName}` : `Security Scan: ${targetName}`}
          </h3>
          <button onClick={onClose} aria-label="Close"
            className="p-1.5 text-[var(--text-tertiary)] hover:text-[var(--text-primary)] rounded-md hover:bg-black/5">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Scanning state */}
        {isScanning && (
          <div className="py-3">
            <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] p-4 mb-4">
              <div className="flex items-start gap-3 mb-3">
                <div className="w-9 h-9 rounded-full bg-[var(--system-blue)]/10 flex items-center justify-center shrink-0 mt-0.5">
                  <Loader2 className="w-5 h-5 animate-spin text-[var(--system-blue)]" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-[var(--text-primary)]">
                    Scanning and installing {targetName}
                  </p>
                  <p className="text-xs text-[var(--text-secondary)] mt-1">
                    Running security checks before installing the {targetType}.
                  </p>
                </div>
              </div>
              <div className="w-full h-2 rounded-full bg-[var(--system-gray-6)] overflow-hidden">
                <div
                  className="h-full bg-[var(--system-blue)] transition-all duration-500 ease-out"
                  style={{ width: `${scanProgress}%` }}
                />
              </div>
              <p className="text-[11px] text-[var(--text-tertiary)] mt-2">
                Usually takes 10-25s. Elapsed: {scanElapsedSeconds}s
              </p>
            </div>

            <div className="space-y-2">
              {scanStages.map((stage, idx) => {
                const complete = scanElapsedSeconds >= stage.completeAfterSeconds;
                const previousComplete = idx === 0 ? true : scanElapsedSeconds >= scanStages[idx - 1].completeAfterSeconds;
                const active = !complete && previousComplete;

                return (
                  <div
                    key={stage.title}
                    className={clsx(
                      "rounded-lg border px-3 py-2.5 flex items-start gap-2.5 transition-colors",
                      complete
                        ? "border-green-500/20 bg-green-500/10"
                        : active
                          ? "border-blue-500/20 bg-blue-500/10"
                          : "border-[var(--border-subtle)] bg-[var(--bg-card)]"
                    )}
                  >
                    <div className="mt-0.5">
                      {complete ? (
                        <CheckCircle2 className="w-4 h-4 text-green-500" />
                      ) : active ? (
                        <Loader2 className="w-4 h-4 text-blue-500 animate-spin" />
                      ) : (
                        <Circle className="w-4 h-4 text-[var(--text-tertiary)]" />
                      )}
                    </div>
                    <div>
                      <p className="text-sm font-medium text-[var(--text-primary)]">{stage.title}</p>
                      <p className="text-xs text-[var(--text-secondary)] mt-0.5">{stage.detail}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Error state */}
        {error && !isScanning && (
          <div className="py-4">
            <div
              className={clsx(
                "rounded-xl border px-4 py-4",
                errorState?.tone === "amber"
                  ? "border-amber-500/20 bg-amber-500/10"
                  : "border-red-500/20 bg-red-500/10",
              )}
            >
              <div className="flex items-start gap-3">
                <AlertTriangle
                  className={clsx(
                    "mt-0.5 h-5 w-5 shrink-0",
                    errorState?.tone === "amber" ? "text-amber-500" : "text-red-500",
                  )}
                />
                <div className="min-w-0">
                  <p
                    className={clsx(
                      "text-sm font-semibold",
                      errorState?.tone === "amber" ? "text-amber-500" : "text-red-500",
                    )}
                  >
                    {errorState?.title || "Security scan failed"}
                  </p>
                  <p className="mt-1 text-sm text-[var(--text-primary)]">
                    {errorState?.body || normalizedError}
                  </p>
                  {errorState?.hint ? (
                    <p className="mt-2 text-xs text-[var(--text-secondary)] whitespace-pre-wrap break-words">
                      {errorState.hint}
                    </p>
                  ) : null}
                </div>
              </div>
            </div>
            <div className="mt-4 flex gap-3 justify-end">
              {onRetry ? (
                <button onClick={onRetry} className="btn btn-primary">Retry Scan</button>
              ) : null}
              <button onClick={onClose} className="btn btn-secondary">Close</button>
            </div>
          </div>
        )}

        {/* Results */}
        {scanResult && !isScanning && !error && (
          <>
            {/* Summary badge */}
            <div className={clsx("rounded-lg p-4 mb-4 flex items-center gap-3",
              scannerUnavailable ? "bg-amber-500/10" : scanResult.is_safe ? "bg-green-500/10" : isBlocked ? "bg-red-500/10" : "bg-yellow-500/10"
            )}>
              {scannerUnavailable ? (
                <AlertTriangle className="w-6 h-6 text-amber-500 shrink-0" />
              ) : scanResult.is_safe ? (
                <ShieldCheck className="w-6 h-6 text-green-500 shrink-0" />
              ) : isBlocked ? (
                <ShieldAlert className="w-6 h-6 text-red-500 shrink-0" />
              ) : (
                <AlertTriangle className="w-6 h-6 text-yellow-500 shrink-0" />
              )}
              <div>
                <p className={clsx("font-medium",
                  scannerUnavailable ? "text-amber-500" : scanResult.is_safe ? "text-green-500" : isBlocked ? "text-red-500" : "text-yellow-500"
                )}>
                  {scannerUnavailable
                    ? "Scanner unavailable"
                    : scanResult.is_safe
                    ? "No issues found"
                    : `${scanResult.findings_count} issue(s) found — ${scanResult.max_severity} severity`}
                </p>
                {!scanResult.scanner_available && (
                  <p className="text-xs text-[var(--text-tertiary)] mt-1">
                    Security scan was skipped because the scanner runtime was unavailable.
                  </p>
                )}
              </div>
            </div>

            {/* Findings list */}
            {scanResult.findings.length > 0 && (
              <div className="space-y-2 mb-4">
                {scanResult.findings.map((finding, idx) => (
                  <div key={idx} className="border border-[var(--border-subtle)] rounded-lg overflow-hidden">
                    <button onClick={() => toggleFinding(idx)}
                      className="w-full flex items-center gap-2 p-3 text-left hover:bg-[var(--border-subtle)]">
                      {expandedFindings.has(idx)
                        ? <ChevronDown className="w-4 h-4 shrink-0" />
                        : <ChevronRight className="w-4 h-4 shrink-0" />}
                      <span className={clsx("text-xs font-medium px-2 py-0.5 rounded",
                        SEVERITY_COLORS[finding.severity] || "text-[var(--text-secondary)] bg-[var(--bg-tertiary)]"
                      )}>
                        {finding.severity}
                      </span>
                      <span className="text-sm font-medium text-[var(--text-primary)] truncate">
                        {finding.title}
                      </span>
                    </button>
                    {expandedFindings.has(idx) && (
                      <div className="px-3 pb-3 space-y-2">
                        <p className="text-sm text-[var(--text-secondary)]">{finding.description}</p>
                        {finding.file_path && (
                          <p className="text-xs text-[var(--text-tertiary)]">
                            {finding.file_path}{finding.line_number ? `:${finding.line_number}` : ""}
                          </p>
                        )}
                        {finding.snippet && (
                          <pre className="text-xs bg-[var(--bg-tertiary)] p-2 rounded overflow-x-auto border border-[var(--border-subtle)]">
                            {finding.snippet}
                          </pre>
                        )}
                        {finding.remediation && (
                          <p className="text-xs text-blue-500">{finding.remediation}</p>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Action buttons */}
            <div className="flex gap-3 justify-end">
              {!scanPassed && (
                <button onClick={onClose} className="btn btn-secondary">Cancel</button>
              )}
              {onRetry && !scanResult.scanner_available && (
                <button onClick={onRetry} className="btn btn-secondary">Retry Scan</button>
              )}
              {onConfirm && (scanResult.is_safe || !scanResult.scanner_available) && (
                <button onClick={onConfirm} className="btn btn-primary">{confirmLabel}</button>
              )}
              {onConfirm && !scanResult.is_safe && scanResult.scanner_available && isBlocked && (
                <button onClick={onConfirm}
                  className="btn btn-secondary !text-red-500 !border-red-500/20">
                  {confirmAnywayLabel}
                </button>
              )}
              {onConfirm && !scanResult.is_safe && scanResult.scanner_available && !isBlocked && (
                <button onClick={onConfirm} className="btn btn-primary">
                  {confirmLabel}
                </button>
              )}
              {!onConfirm && scanPassed && (
                <button onClick={onClose} className="btn btn-primary">Done</button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
