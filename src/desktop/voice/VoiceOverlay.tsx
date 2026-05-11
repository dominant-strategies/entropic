import { Loader2, Mic } from "lucide-react";

type VoiceOverlayProps = {
  state: "idle" | "listening" | "transcribing" | "thinking" | "speaking" | "error";
  message?: string | null;
  onCancel?: () => void;
  cancelLabel?: string;
  transcript?: string | null;
};

export function VoiceOverlay({
  state,
  message,
  onCancel,
  cancelLabel = "Cancel",
  transcript,
}: VoiceOverlayProps) {
  if (state === "idle") {
    return null;
  }

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-20 z-[100] flex justify-center px-4">
      <div className="pointer-events-auto flex max-w-2xl flex-col gap-3 rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-card)] px-4 py-3 text-sm text-[var(--text-primary)] shadow-2xl">
        {transcript ? (
          <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] px-3 py-2">
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-secondary)]">
              Heard
            </div>
            <div className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-[var(--text-primary)]">
              {transcript}
            </div>
          </div>
        ) : null}
        <div className="flex items-center gap-3">
          {state === "listening" ? (
            <Mic className="h-4 w-4 text-red-300" />
          ) : (
            <Loader2 className="h-4 w-4 animate-spin text-[var(--text-secondary)]" />
          )}
          <span className="min-w-0 flex-1">{message || state}</span>
          {onCancel ? (
            <button
              type="button"
              onClick={onCancel}
              className="rounded-md px-2 py-1 text-xs text-[var(--text-secondary)] hover:bg-[var(--system-gray-6)]"
            >
              {cancelLabel}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
