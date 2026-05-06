import { Mic, Square } from "lucide-react";
import clsx from "clsx";

type VoiceControlButtonProps = {
  isRecording: boolean;
  disabled?: boolean;
  isSupported: boolean;
  onStart: () => void;
  onStop: () => void;
};

export function VoiceControlButton({
  isRecording,
  disabled,
  isSupported,
  onStart,
  onStop,
}: VoiceControlButtonProps) {
  const unavailable = disabled || !isSupported;
  return (
    <button
      type="button"
      onClick={isRecording ? onStop : onStart}
      disabled={unavailable && !isRecording}
      className={clsx(
        "btn-secondary !p-2.5",
        isRecording && "!border-red-400/50 !bg-red-500/15 !text-red-300",
      )}
      title={isSupported ? (isRecording ? "Stop" : "Record") : "Microphone unavailable"}
      aria-label={isRecording ? "Stop recording" : "Record"}
    >
      {isRecording ? <Square className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
    </button>
  );
}
