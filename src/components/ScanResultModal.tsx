import { useState } from "react";
import { X, Loader2, ShieldCheck, ShieldAlert, AlertTriangle, ChevronDown, ChevronRight } from "lucide-react";
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
  pluginName: string;
  scanResult: PluginScanResult | null;
  isScanning: boolean;
  error: string | null;
  onClose: () => void;
  onEnablePlugin: () => void;
  onEnableAnyway: () => void;
};

const SEVERITY_COLORS: Record<string, string> = {
  CRITICAL: "text-red-600 bg-red-100",
  HIGH: "text-red-500 bg-red-50",
  MEDIUM: "text-yellow-600 bg-yellow-50",
  LOW: "text-blue-600 bg-blue-50",
  INFO: "text-gray-600 bg-gray-100",
};

export function ScanResultModal({
  isOpen, pluginName, scanResult, isScanning, error,
  onClose, onEnablePlugin, onEnableAnyway,
}: Props) {
  const [expandedFindings, setExpandedFindings] = useState<Set<number>>(new Set());

  if (!isOpen) return null;

  const isBlocked = scanResult && !scanResult.is_safe &&
    ["CRITICAL", "HIGH"].includes(scanResult.max_severity);

  function toggleFinding(idx: number) {
    const next = new Set(expandedFindings);
    if (next.has(idx)) next.delete(idx); else next.add(idx);
    setExpandedFindings(next);
  }

  return (
    <div className="fixed inset-0 bg-black/20 flex items-center justify-center z-50"
         onClick={onClose}>
      <div className="bg-white p-6 w-full max-w-lg m-4 max-h-[80vh] overflow-y-auto rounded-2xl shadow-xl border border-[var(--border-subtle)]"
           onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-[var(--text-primary)]">
            Security Scan: {pluginName}
          </h3>
          <button onClick={onClose}
            className="p-1.5 text-[var(--text-tertiary)] hover:text-[var(--text-primary)] rounded-md hover:bg-black/5">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Scanning state */}
        {isScanning && (
          <div className="py-12 text-center">
            <Loader2 className="w-8 h-8 animate-spin mx-auto mb-3 text-[var(--text-accent)]" />
            <p className="text-[var(--text-secondary)]">Scanning plugin for security issues...</p>
            <p className="text-xs text-[var(--text-tertiary)] mt-1">Static + behavioral analysis</p>
          </div>
        )}

        {/* Error state */}
        {error && !isScanning && (
          <div className="py-8 text-center">
            <p className="text-red-500 mb-4">{error}</p>
            <button onClick={onClose} className="btn btn-secondary">Close</button>
          </div>
        )}

        {/* Results */}
        {scanResult && !isScanning && !error && (
          <>
            {/* Summary badge */}
            <div className={clsx("rounded-lg p-4 mb-4 flex items-center gap-3",
              scanResult.is_safe ? "bg-green-50" : isBlocked ? "bg-red-50" : "bg-yellow-50"
            )}>
              {scanResult.is_safe ? (
                <ShieldCheck className="w-6 h-6 text-green-600 shrink-0" />
              ) : isBlocked ? (
                <ShieldAlert className="w-6 h-6 text-red-600 shrink-0" />
              ) : (
                <AlertTriangle className="w-6 h-6 text-yellow-600 shrink-0" />
              )}
              <div>
                <p className={clsx("font-medium",
                  scanResult.is_safe ? "text-green-700" : isBlocked ? "text-red-700" : "text-yellow-700"
                )}>
                  {scanResult.is_safe
                    ? "No issues found"
                    : `${scanResult.findings_count} issue(s) found — ${scanResult.max_severity} severity`}
                </p>
                {!scanResult.scanner_available && (
                  <p className="text-xs text-[var(--text-tertiary)] mt-1">
                    Scanner unavailable — skipped security check
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
                      className="w-full flex items-center gap-2 p-3 text-left hover:bg-black/5">
                      {expandedFindings.has(idx)
                        ? <ChevronDown className="w-4 h-4 shrink-0" />
                        : <ChevronRight className="w-4 h-4 shrink-0" />}
                      <span className={clsx("text-xs font-medium px-2 py-0.5 rounded",
                        SEVERITY_COLORS[finding.severity] || "text-gray-600 bg-gray-100"
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
                          <p className="text-xs text-blue-600">{finding.remediation}</p>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Action buttons */}
            <div className="flex gap-3 justify-end">
              <button onClick={onClose} className="btn btn-secondary">Cancel</button>
              {scanResult.is_safe || !scanResult.scanner_available ? (
                <button onClick={onEnablePlugin} className="btn btn-primary">Enable Plugin</button>
              ) : isBlocked ? (
                <button onClick={onEnableAnyway}
                  className="btn btn-secondary !text-red-600 !border-red-200">
                  Enable Anyway
                </button>
              ) : (
                <button onClick={onEnablePlugin} className="btn btn-primary">
                  Enable Plugin
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
