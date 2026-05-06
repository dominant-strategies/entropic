import { useEffect, useState } from "react";
import { Loader2, Mic } from "lucide-react";
import clsx from "clsx";
import type { DesktopAction } from "../actions";
import { validateDesktopAction } from "../actions";
import { useAudioRecorder, type RecordedAudioAttachment } from "./useAudioRecorder";
import { useAudioTranscription } from "./useAudioTranscription";
import { VoiceOverlay } from "./VoiceOverlay";
import {
  chatTaskNeedsConfirmation,
  formatVoiceTaskPrompt,
  messageForMode,
  resolveVoiceAction,
  type VoiceDesktopContext,
  type VoiceMode,
} from "./voiceActions";

type VoiceState = "idle" | "listening" | "transcribing" | "thinking" | "confirming" | "error";

type VoiceProviderProps = {
  audioUnderstandingModel: string;
  desktopContext?: VoiceDesktopContext;
  shortcut?: string;
  dispatchAction: (action: DesktopAction) => Promise<void>;
};

function previewForAction(action: DesktopAction): { message: string; confirmLabel: string } | null {
  switch (action.type) {
    case "open_workspace_file":
      return { message: `Open workspace file: ${action.path}?`, confirmLabel: "Open" };
    case "open_workspace_folder":
      return { message: `Open workspace folder: ${action.path || "/"}?`, confirmLabel: "Open" };
    case "open_browser_url":
      return { message: `Open browser URL: ${action.url}?`, confirmLabel: "Open" };
    case "new_chat_task":
      if (action.autoSubmit && chatTaskNeedsConfirmation(action.prompt)) {
        return { message: "Send this voice task to the agent now?", confirmLabel: "Send" };
      }
      return null;
    default:
      return null;
  }
}

function normalizeShortcutKey(key: string): string {
  const normalized = key.trim().toLowerCase();
  if (normalized === " ") return "space";
  if (normalized === "escape") return "esc";
  if (normalized === "arrowup") return "up";
  if (normalized === "arrowdown") return "down";
  if (normalized === "arrowleft") return "left";
  if (normalized === "arrowright") return "right";
  return normalized;
}

function shortcutMatchesEvent(shortcut: string | undefined, event: KeyboardEvent): boolean {
  const parts = (shortcut || "")
    .split("+")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  if (parts.length < 2) return false;

  const wantsCtrl = parts.includes("ctrl") || parts.includes("control");
  const wantsShift = parts.includes("shift");
  const wantsAlt = parts.includes("alt") || parts.includes("option");
  const wantsMeta = parts.includes("meta") || parts.includes("cmd") || parts.includes("command");
  const keyParts = parts.filter(
    (part) => !["ctrl", "control", "shift", "alt", "option", "meta", "cmd", "command"].includes(part),
  );
  if (keyParts.length !== 1 || (!wantsCtrl && !wantsShift && !wantsAlt && !wantsMeta)) {
    return false;
  }

  return (
    event.ctrlKey === wantsCtrl &&
    event.shiftKey === wantsShift &&
    event.altKey === wantsAlt &&
    event.metaKey === wantsMeta &&
    normalizeShortcutKey(event.key) === normalizeShortcutKey(keyParts[0])
  );
}

export function VoiceProvider({
  audioUnderstandingModel,
  desktopContext,
  shortcut,
  dispatchAction,
}: VoiceProviderProps) {
  const [state, setState] = useState<VoiceState>("idle");
  const [mode, setMode] = useState<VoiceMode>("command");
  const [message, setMessage] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<DesktopAction | null>(null);
  const [confirmLabel, setConfirmLabel] = useState("Continue");
  const { isTranscribing, transcribeAudio } = useAudioTranscription(audioUnderstandingModel);

  function clearVoiceState() {
    setState("idle");
    setMessage(null);
    setPendingAction(null);
    setConfirmLabel("Continue");
  }

  async function dispatchVoiceAction(action: DesktopAction) {
    setState("thinking");
    setPendingAction(null);
    try {
      await dispatchAction(action);
      clearVoiceState();
    } catch (error) {
      setState("error");
      setMessage(error instanceof Error ? error.message : "Voice command failed.");
    }
  }

  async function handleRecordedAudio(attachment: RecordedAudioAttachment) {
    setState("transcribing");
    setMessage(mode === "dictation" ? "Transcribing dictation..." : "Transcribing voice command...");
    try {
      const transcript = await transcribeAudio([attachment]);

      if (mode === "dictation") {
        setMessage(`Dictation: ${transcript}`);
        await dispatchVoiceAction({ type: "new_chat_task", prompt: transcript, autoSubmit: false });
        return;
      }

      let action = validateDesktopAction(resolveVoiceAction(transcript));
      if (action.type === "new_chat_task") {
        action = {
          ...action,
          prompt: formatVoiceTaskPrompt(action.prompt, mode, desktopContext),
          autoSubmit: true,
        };
      }
      const preview = previewForAction(action);
      if (preview) {
        setPendingAction(action);
        setConfirmLabel(preview.confirmLabel);
        setState("confirming");
        setMessage(preview.message);
        return;
      }
      setMessage(`Voice: ${transcript}`);
      await dispatchVoiceAction(action);
    } catch (error) {
      setState("error");
      setMessage(error instanceof Error ? error.message : "Voice command failed.");
    } finally {
      if (attachment.previewUrl.startsWith("blob:")) {
        URL.revokeObjectURL(attachment.previewUrl);
      }
    }
  }

  const recorder = useAudioRecorder({
    maxBytes: 5_000_000,
    onRecorded: (attachment) => {
      void handleRecordedAudio(attachment);
    },
    onError: (error) => {
      setState("error");
      setMessage(error);
      setPendingAction(null);
    },
  });

  const busy =
    recorder.isRecording || isTranscribing || state === "thinking" || state === "confirming";

  function startVoiceCapture() {
    setState("listening");
    setMessage(messageForMode(mode));
    setPendingAction(null);
    void recorder.startRecording();
  }

  useEffect(() => {
    if (!shortcut?.trim()) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (!shortcutMatchesEvent(shortcut, event) || busy || recorder.isRecording) return;
      event.preventDefault();
      startVoiceCapture();
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [busy, recorder, shortcut]);

  return (
    <>
      <div className="absolute bottom-24 right-5 z-20 flex items-center gap-2">
        <select
          value={mode}
          onChange={(event) => setMode(event.target.value as VoiceMode)}
          disabled={busy || recorder.isRecording}
          className="h-9 rounded-xl border border-white/20 bg-black/40 px-2 text-xs font-medium text-white shadow-2xl backdrop-blur-xl outline-none transition disabled:opacity-50"
          title="Voice mode"
          aria-label="Voice mode"
        >
          <option value="dictation">Dictation</option>
          <option value="command">Command</option>
          <option value="conversation">Conversation</option>
        </select>
        <button
          type="button"
          onClick={() => {
            if (recorder.isRecording) {
              recorder.stopRecording();
              return;
            }
            startVoiceCapture();
          }}
          disabled={!recorder.isSupported || (busy && !recorder.isRecording)}
          className={clsx(
            "inline-flex h-12 w-12 items-center justify-center rounded-2xl border border-white/25 bg-black/40 text-white shadow-2xl backdrop-blur-xl transition",
            recorder.isRecording && "border-red-300/60 bg-red-500/30 text-red-100",
            !recorder.isSupported && "cursor-not-allowed opacity-50",
          )}
          title={recorder.isSupported ? `Voice ${mode}` : "Microphone unavailable"}
          aria-label={`Voice ${mode}`}
        >
          {busy && !recorder.isRecording ? (
            <Loader2 className="h-5 w-5 animate-spin" />
          ) : (
            <Mic className="h-5 w-5" />
          )}
        </button>
      </div>
      <VoiceOverlay
        state={state === "error" || state === "listening" || state === "confirming" ? state : busy ? "transcribing" : "idle"}
        mode={mode}
        message={message}
        confirmLabel={confirmLabel}
        onModeChange={(nextMode) => {
          if (recorder.isRecording || busy) return;
          setMode(nextMode);
        }}
        onConfirm={
          pendingAction
            ? () => {
                void dispatchVoiceAction(pendingAction);
              }
            : undefined
        }
        onCancel={
          pendingAction
            ? clearVoiceState
            : recorder.isRecording
            ? () => {
                recorder.stopRecording();
                clearVoiceState();
              }
            : undefined
        }
      />
    </>
  );
}
