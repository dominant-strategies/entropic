import { useEffect, useRef, useState } from "react";
import { Loader2, Mic, Volume2 } from "lucide-react";
import clsx from "clsx";
import type { DesktopAction } from "../actions";
import { validateDesktopAction } from "../actions";
import {
  recordedAudioHasDetectedSpeech,
  useAudioRecorder,
  type RecordedAudioAttachment,
} from "./useAudioRecorder";
import { cleanRecordedVoiceTranscript, useAudioTranscription } from "./useAudioTranscription";
import { VoiceOverlay } from "./VoiceOverlay";
import { clientLog } from "../../lib/clientLog";
import {
  formatVoiceTaskPrompt,
  listeningMessage,
  resolveVoiceAction,
  type VoiceDesktopContext,
} from "./voiceActions";

type VoiceState = "idle" | "listening" | "transcribing" | "thinking" | "error";

type VoiceProviderProps = {
  audioUnderstandingModel: string;
  desktopContext?: VoiceDesktopContext;
  shortcut?: string;
  dispatchAction: (action: DesktopAction) => Promise<void>;
};

function wait(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function voiceActionLogPayload(action: DesktopAction): Record<string, string | boolean | undefined> {
  switch (action.type) {
    case "open_workspace_file":
    case "open_workspace_folder":
      return { type: action.type, path: action.path };
    case "open_browser_url":
      return { type: action.type, url: action.url };
    case "focus_window":
    case "close_window":
      return { type: action.type, window: action.window };
    case "new_chat_task":
      return {
        type: action.type,
        autoSubmit: action.autoSubmit === true,
        speakResponse: action.speakResponse === true,
      };
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
  const [conversationActive, setConversationActive] = useState(false);
  const [voiceResponseActive, setVoiceResponseActive] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<string | null>(null);
  const conversationActiveRef = useRef(false);
  const voiceResponseActiveRef = useRef(false);
  const { isTranscribing, transcribeAudio } = useAudioTranscription(audioUnderstandingModel);

  function clearVoiceState() {
    setState("idle");
    setMessage(null);
    setTranscript(null);
  }

  function setVoiceConversationActive(active: boolean) {
    conversationActiveRef.current = active;
    setConversationActive(active);
  }

  function resumeConversationAfter(delayMs: number) {
    window.setTimeout(() => {
      if (!conversationActiveRef.current || recorder.isRecording || voiceResponseActiveRef.current) return;
      startVoiceCapture();
    }, delayMs);
  }

  async function dispatchVoiceAction(action: DesktopAction) {
    setState("thinking");
    clientLog("voice.action.dispatch", voiceActionLogPayload(action));
    try {
      await dispatchAction(action);
      if (action.type === "new_chat_task" && action.speakResponse === true) {
        setVoiceResponseIsActive(true);
        setState("thinking");
        setMessage("Waiting for response...");
        return;
      }
      clearVoiceState();
      if (conversationActiveRef.current && action.type !== "new_chat_task") {
        resumeConversationAfter(600);
      }
    } catch (error) {
      setVoiceConversationActive(false);
      setState("error");
      setMessage(error instanceof Error ? error.message : "Voice request failed.");
    }
  }

  async function handleRecordedAudio(attachment: RecordedAudioAttachment) {
    setState("transcribing");
    setMessage("Transcribing...");
    try {
      if (!recordedAudioHasDetectedSpeech(attachment)) {
        clientLog("voice.audio.discarded_no_speech", {
          durationMs: attachment.capture.durationMs,
          speechSeen: attachment.capture.speechSeen,
          speechMs: attachment.capture.speechMs,
          peakLevel: attachment.capture.peakLevel,
          autoStopTriggered: attachment.capture.autoStopTriggered,
        });
        setTranscript(null);
        setMessage("I didn't catch that.");
        if (conversationActiveRef.current) {
          resumeConversationAfter(900);
        }
        return;
      }

      const transcriptText = cleanRecordedVoiceTranscript(await transcribeAudio([attachment]));
      setTranscript(transcriptText);
      if (!transcriptText.trim()) {
        setMessage("I didn't catch that.");
        if (conversationActiveRef.current) {
          resumeConversationAfter(900);
        }
        return;
      }

      let action = validateDesktopAction(resolveVoiceAction(transcriptText));
      if (action.type === "new_chat_task") {
        action = {
          ...action,
          prompt: formatVoiceTaskPrompt(action.prompt, desktopContext),
          autoSubmit: true,
          speakResponse: true,
        };
      }
      setMessage(action.type === "new_chat_task" ? "Sending..." : "Running...");
      await wait(250);
      await dispatchVoiceAction(action);
    } catch (error) {
      setVoiceConversationActive(false);
      setState("error");
      setMessage(error instanceof Error ? error.message : "Voice request failed.");
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
      setVoiceConversationActive(false);
      setState("error");
      setMessage(error);
    },
    autoStopOnSilence: {
      levelThreshold: 0.0035,
      silenceLevelThreshold: 0.0025,
      peakSilenceRatio: 0.18,
      noiseFloorMultiplier: 1.35,
      silenceMs: 750,
      minRecordingMs: 500,
      checkIntervalMs: 60,
    },
  });

  const busy = recorder.isRecording || isTranscribing || state === "thinking" || voiceResponseActive;
  const voiceSpeaking = voiceResponseActive && state !== "thinking";
  const busyLabel =
    voiceResponseActive
      ? state === "thinking"
        ? "Thinking"
        : "Replying"
      : recorder.isRecording
        ? "Listening"
        : state === "transcribing" || isTranscribing
          ? "Transcribing"
          : state === "thinking"
            ? "Thinking"
            : null;
  const voiceButtonLabel = busyLabel
    || (conversationActive
      ? "Stop voice conversation"
      : "Start voice conversation");

  function setVoiceResponseIsActive(active: boolean) {
    voiceResponseActiveRef.current = active;
    setVoiceResponseActive(active);
  }

  function startVoiceCapture() {
    if (recorder.isRecording || voiceResponseActiveRef.current) return;
    setVoiceConversationActive(true);
    setState("listening");
    setMessage(listeningMessage());
    setTranscript(null);
    window.dispatchEvent(new Event("entropic-voice-capture-started"));
    void recorder.startRecording();
  }

  function stopVoiceCapture() {
    setState("transcribing");
    setMessage("Finalizing...");
    recorder.stopRecording();
  }

  function stopVoiceConversation() {
    setVoiceConversationActive(false);
    if (recorder.isRecording) {
      stopVoiceCapture();
      return;
    }
    clearVoiceState();
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

  useEffect(() => {
    function handleVoiceResponseStarted() {
      setVoiceResponseIsActive(true);
      setState("idle");
      setMessage(null);
      if (recorder.isRecording) {
        stopVoiceCapture();
      }
    }

    function handleVoiceResponseComplete() {
      setVoiceResponseIsActive(false);
      clearVoiceState();
      if (!conversationActiveRef.current) return;
      resumeConversationAfter(350);
    }

    window.addEventListener("entropic-voice-response-started", handleVoiceResponseStarted);
    window.addEventListener("entropic-voice-response-complete", handleVoiceResponseComplete);
    return () => {
      window.removeEventListener("entropic-voice-response-started", handleVoiceResponseStarted);
      window.removeEventListener("entropic-voice-response-complete", handleVoiceResponseComplete);
    };
  }, [recorder]);

  return (
    <>
      <div className="absolute bottom-24 right-5 z-20 flex flex-col items-end gap-2">
        <button
          type="button"
          onClick={() => {
            if (voiceResponseActiveRef.current) return;
            if (recorder.isRecording) {
              stopVoiceCapture();
              return;
            }
            if (conversationActive && state === "idle") {
              stopVoiceConversation();
              return;
            }
            startVoiceCapture();
          }}
          disabled={!recorder.isSupported || (busy && !recorder.isRecording)}
          className={clsx(
            "inline-flex h-12 w-12 items-center justify-center rounded-2xl border border-white/25 bg-black/40 text-white shadow-2xl backdrop-blur-xl transition",
            conversationActive && !recorder.isRecording && "border-emerald-300/50 bg-emerald-500/20 text-emerald-100",
            recorder.isRecording && "border-red-300/60 bg-red-500/30 text-red-100 shadow-red-500/20",
            recorder.isRecording && "animate-pulse",
            voiceResponseActive && "cursor-not-allowed border-sky-300/50 bg-sky-500/20 text-sky-100 opacity-80",
            !recorder.isSupported && "cursor-not-allowed opacity-50",
          )}
          title={recorder.isSupported ? voiceButtonLabel : "Microphone unavailable"}
          aria-label={voiceButtonLabel}
        >
          {voiceSpeaking ? (
            <Volume2 className="h-5 w-5 animate-pulse" />
          ) : busy && !recorder.isRecording ? (
            <Loader2 className="h-5 w-5 animate-spin" />
          ) : (
            <Mic className="h-5 w-5" />
          )}
        </button>
        {busyLabel && (
          <div
            className={clsx(
              "pointer-events-none flex min-w-[104px] items-center justify-center gap-2 rounded-full border px-3 py-1.5 text-[11px] font-medium tracking-wide shadow-[0_14px_40px_rgba(0,0,0,0.28)] backdrop-blur-2xl",
              "bg-[linear-gradient(135deg,rgba(255,255,255,0.16),rgba(255,255,255,0.04))] text-white/82",
              recorder.isRecording && "border-red-200/20 shadow-red-500/15",
              (state === "transcribing" || isTranscribing) && "border-amber-200/20 shadow-amber-500/15",
              state === "thinking" && !voiceSpeaking && "border-sky-200/20 shadow-sky-500/15",
              voiceSpeaking && "border-emerald-200/20 shadow-emerald-500/15",
            )}
          >
            <span
              className={clsx(
                "h-1.5 w-1.5 rounded-full shadow-[0_0_12px_currentColor]",
                recorder.isRecording && "animate-pulse bg-red-200 text-red-200",
                (state === "transcribing" || isTranscribing) && "animate-pulse bg-amber-200 text-amber-200",
                state === "thinking" && !voiceSpeaking && "animate-pulse bg-sky-200 text-sky-200",
                voiceSpeaking && "animate-pulse bg-emerald-200 text-emerald-200",
              )}
            />
            <span>{busyLabel}</span>
          </div>
        )}
      </div>
      <VoiceOverlay
        state={state === "error" ? state : "idle"}
        message={message}
        transcript={transcript}
        cancelLabel="Cancel"
        onCancel={state === "error" ? clearVoiceState : undefined}
      />
    </>
  );
}
