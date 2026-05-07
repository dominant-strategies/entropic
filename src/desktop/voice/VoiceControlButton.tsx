import { Loader2, Mic, Square } from "lucide-react";
import clsx from "clsx";

type VoiceControlButtonProps = {
  isRecording: boolean;
  isFinalizing?: boolean;
  isTranscribing?: boolean;
  recordingAction?: "stop" | "listen";
  disabled?: boolean;
  isSupported: boolean;
  onStart: () => void;
  onStop: () => void;
};

export function VoiceControlButton({
  isRecording,
  isFinalizing = false,
  isTranscribing = false,
  recordingAction = "stop",
  disabled,
  isSupported,
  onStart,
  onStop,
}: VoiceControlButtonProps) {
  const isProcessing = isFinalizing || isTranscribing;
  const unavailable = disabled || isProcessing || !isSupported;
  const passiveRecording = isRecording && recordingAction === "listen";
  const title = !isSupported
    ? "Microphone unavailable"
    : isRecording
      ? passiveRecording
        ? "Listening. Press Send when done."
        : "Stop recording"
      : isTranscribing
        ? "Transcribing recording"
        : isFinalizing
          ? "Finalizing recording"
          : "Record";
  return (
    <button
      type="button"
      onClick={isRecording ? (passiveRecording ? undefined : onStop) : onStart}
      disabled={unavailable && !isRecording}
      className={clsx(
        "btn-secondary !p-2.5 transition",
        isRecording && !passiveRecording && "!border-red-400/50 !bg-red-500/15 !text-red-300",
        passiveRecording && "!border-[var(--purple-accent)]/45 !bg-[var(--purple-accent)]/15 !text-[var(--purple-accent)]",
        isProcessing && "!border-amber-400/50 !bg-amber-500/15 !text-amber-300",
      )}
      title={title}
      aria-label={title}
    >
      {isRecording && passiveRecording ? (
        <Loader2 className="w-4 h-4 animate-spin" />
      ) : isRecording ? (
        <Square className="w-4 h-4" />
      ) : isProcessing ? (
        <Loader2 className="w-4 h-4 animate-spin" />
      ) : (
        <Mic className="w-4 h-4" />
      )}
    </button>
  );
}
