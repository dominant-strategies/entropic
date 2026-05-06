import { Loader2, Mic } from "lucide-react";

type VoiceOverlayProps = {
  state: "idle" | "listening" | "transcribing" | "thinking" | "speaking" | "error";
  message?: string | null;
  onCancel?: () => void;
};

export function VoiceOverlay({ state, message, onCancel }: VoiceOverlayProps) {
  if (state === "idle") {
    return null;
  }

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-20 z-[100] flex justify-center px-4">
      <div className="pointer-events-auto flex max-w-xl items-center gap-3 rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-card)] px-4 py-3 text-sm text-[var(--text-primary)] shadow-2xl">
        {state === "listening" ? (
          <Mic className="h-4 w-4 text-red-300" />
        ) : (
          <Loader2 className="h-4 w-4 animate-spin text-[var(--text-secondary)]" />
        )}
        <span>{message || state}</span>
        {onCancel ? (
          <button
            type="button"
            onClick={onCancel}
            className="ml-2 rounded-md px-2 py-1 text-xs text-[var(--text-secondary)] hover:bg-[var(--system-gray-6)]"
          >
            Cancel
          </button>
        ) : null}
      </div>
    </div>
  );
}
