import { useState } from "react";
import { Loader2, Mic } from "lucide-react";
import clsx from "clsx";
import type { DesktopAction } from "../actions";
import type { WindowKey } from "../windowManager";
import { useAudioRecorder, type RecordedAudioAttachment } from "./useAudioRecorder";
import { useAudioTranscription } from "./useAudioTranscription";
import { VoiceOverlay } from "./VoiceOverlay";

type VoiceState = "idle" | "listening" | "transcribing" | "thinking" | "error";

type VoiceProviderProps = {
  enabled: boolean;
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
  if (/^https?:\/\//i.test(cleaned)) return cleaned;
  if (/^[a-z0-9.-]+\.[a-z]{2,}(?:\/\S*)?$/i.test(cleaned)) {
    return `https://${cleaned}`;
  }
  return null;
}

export function resolveVoiceAction(transcript: string): DesktopAction {
  const text = transcript.trim();
  const lower = text.toLowerCase();

  const focusMatch = lower.match(/\b(?:focus|show|switch to|open)\s+(chat|browser|finder|files|settings|integrations|skills|plugins|terminal|shell|tasks|jobs|sheets|spreadsheet|docs|document|slides|presentation)\b/);
  if (focusMatch?.[1]) {
    return { type: "focus_window", window: WINDOW_ALIASES[focusMatch[1]] ?? "chat" };
  }

  const fileMatch = text.match(/\bopen\s+(?:the\s+)?(?:file\s+)?(.+\.(?:xlsx|xlsm|docx|pptx|pdf|txt|md|csv|html?))\b/i);
  if (fileMatch?.[1]) {
    return { type: "open_workspace_file", path: cleanVoiceTarget(fileMatch[1]) };
  }

  const browserMatch = text.match(/\b(?:open|go to|navigate to)\s+(?:a\s+)?(?:new\s+)?(?:browser\s+)?(?:window\s+)?(?:to\s+)?(.+)$/i);
  const url = browserMatch?.[1] ? urlFromVoiceTarget(browserMatch[1]) : null;
  if (url) {
    return { type: "open_browser_url", url };
  }

  return { type: "new_chat_task", prompt: text };
}

export function VoiceProvider({
  enabled,
  audioUnderstandingModel,
  dispatchAction,
}: VoiceProviderProps) {
  const [state, setState] = useState<VoiceState>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const { isTranscribing, transcribeAudio } = useAudioTranscription(audioUnderstandingModel);

  async function handleRecordedAudio(attachment: RecordedAudioAttachment) {
    setState("transcribing");
    setMessage("Transcribing voice command...");
    try {
      const transcript = await transcribeAudio([attachment]);
      const action = resolveVoiceAction(transcript);
      setState("thinking");
      setMessage(`Voice: ${transcript}`);
      await dispatchAction(action);
      setState("idle");
      setMessage(null);
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
    },
  });

  if (!enabled) {
    return null;
  }

  const busy = recorder.isRecording || isTranscribing || state === "thinking";

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
        state={state === "listening" ? "listening" : state === "error" ? "error" : busy ? "transcribing" : "idle"}
        message={message}
        onCancel={
          recorder.isRecording
            ? () => {
                recorder.stopRecording();
                setState("idle");
                setMessage(null);
              }
            : undefined
        }
      />
    </>
  );
}
