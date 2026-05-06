import { useState } from "react";
import { Loader2, Mic } from "lucide-react";
import clsx from "clsx";
import type { DesktopAction } from "../actions";
import { validateDesktopAction } from "../actions";
import type { WindowKey } from "../windowManager";
import { useAudioRecorder, type RecordedAudioAttachment } from "./useAudioRecorder";
import { useAudioTranscription } from "./useAudioTranscription";
import { VoiceOverlay } from "./VoiceOverlay";

type VoiceState = "idle" | "listening" | "transcribing" | "thinking" | "confirming" | "error";

type VoiceProviderProps = {
  audioUnderstandingModel: string;
  dispatchAction: (action: DesktopAction) => Promise<void>;
};

const WINDOW_ALIASES: Record<string, WindowKey> = {
  chat: "chat",
  browser: "browser",
  finder: "finder",
  files: "finder",
  settings: "settings",
  integrations: "integrations",
  skills: "skills",
  plugins: "plugins",
  terminal: "terminal",
  shell: "terminal",
  tasks: "tasks",
  jobs: "tasks",
  sheets: "sheets",
  spreadsheet: "sheets",
  docs: "docs",
  document: "docs",
  slides: "slides",
  presentation: "slides",
};

const VOICE_URL_ALIASES: Record<string, string> = {
  asana: "https://app.asana.com",
  github: "https://github.com",
  gmail: "https://mail.google.com",
  google: "https://google.com",
  outlook: "https://outlook.office.com",
  teams: "https://teams.microsoft.com",
};

function cleanVoiceTarget(value: string): string {
  return value
    .trim()
    .replace(/^[`"']+/, "")
    .replace(/[`"'.]+$/, "")
    .trim();
}

function urlFromVoiceTarget(target: string): string | null {
  const cleaned = cleanVoiceTarget(target);
  if (!cleaned) return null;
  const lower = cleaned.toLowerCase();
  const searchQuery = lower.match(/^(?:search for|search|look up|find)\s+(.+)$/)?.[1];
  if (searchQuery) {
    return `https://www.google.com/search?q=${encodeURIComponent(searchQuery)}`;
  }
  if (VOICE_URL_ALIASES[lower]) return VOICE_URL_ALIASES[lower];
  if (/^https?:\/\//i.test(cleaned)) return cleaned;
  if (/^[a-z0-9.-]+\.[a-z]{2,}(?:\/\S*)?$/i.test(cleaned)) {
    return `https://${cleaned}`;
  }
  return null;
}

export function resolveVoiceAction(transcript: string): DesktopAction {
  const text = transcript.trim();
  const lower = text.toLowerCase();

  const focusMatch = lower.match(
    /\b(?:focus|show|switch to|open)\s+(chat|browser|finder|files|settings|integrations|skills|plugins|terminal|shell|tasks|jobs|sheets|spreadsheet|docs|document|slides|presentation)\b/,
  );
  if (focusMatch?.[1]) {
    return { type: "focus_window", window: WINDOW_ALIASES[focusMatch[1]] ?? "chat" };
  }

  const fileMatch = text.match(
    /\bopen\s+(?:the\s+)?(?:file\s+)?(.+\.(?:xlsx|xlsm|docx|pptx|pdf|txt|md|csv|html?))\b/i,
  );
  if (fileMatch?.[1]) {
    return { type: "open_workspace_file", path: cleanVoiceTarget(fileMatch[1]) };
  }

  const browserMatch = text.match(
    /\b(?:open|go to|navigate to)\s+(?:a\s+)?(?:new\s+)?(?:browser\s+)?(?:window\s+)?(?:to\s+)?(.+)$/i,
  );
  const url = browserMatch?.[1] ? urlFromVoiceTarget(browserMatch[1]) : null;
  if (url) {
    return { type: "open_browser_url", url };
  }

  return { type: "new_chat_task", prompt: text };
}

function previewForAction(action: DesktopAction): { message: string; confirmLabel: string } | null {
  switch (action.type) {
    case "open_workspace_file":
      return { message: `Open workspace file: ${action.path}?`, confirmLabel: "Open" };
    case "open_workspace_folder":
      return { message: `Open workspace folder: ${action.path || "/"}?`, confirmLabel: "Open" };
    case "open_browser_url":
      return { message: `Open browser URL: ${action.url}?`, confirmLabel: "Open" };
    default:
      return null;
  }
}

export function VoiceProvider({
  audioUnderstandingModel,
  dispatchAction,
}: VoiceProviderProps) {
  const [state, setState] = useState<VoiceState>("idle");
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
    setMessage("Transcribing voice command...");
    try {
      const transcript = await transcribeAudio([attachment]);
      const action = validateDesktopAction(resolveVoiceAction(transcript));
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

  return (
    <>
      <button
        type="button"
        onClick={() => {
          if (recorder.isRecording) {
            recorder.stopRecording();
            return;
          }
          setState("listening");
          setMessage("Listening for a desktop command...");
          setPendingAction(null);
          void recorder.startRecording();
        }}
        disabled={!recorder.isSupported || (busy && !recorder.isRecording)}
        className={clsx(
          "absolute bottom-24 right-5 z-20 inline-flex h-12 w-12 items-center justify-center rounded-2xl border border-white/25 bg-black/40 text-white shadow-2xl backdrop-blur-xl transition",
          recorder.isRecording && "border-red-300/60 bg-red-500/30 text-red-100",
          !recorder.isSupported && "cursor-not-allowed opacity-50",
        )}
        title={recorder.isSupported ? "Voice command" : "Microphone unavailable"}
        aria-label="Voice command"
      >
        {busy && !recorder.isRecording ? (
          <Loader2 className="h-5 w-5 animate-spin" />
        ) : (
          <Mic className="h-5 w-5" />
        )}
      </button>
      <VoiceOverlay
        state={state === "error" || state === "listening" || state === "confirming" ? state : busy ? "transcribing" : "idle"}
        message={message}
        confirmLabel={confirmLabel}
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
