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
import { useLiveSpeechRecognition } from "./useLiveSpeechRecognition";
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
  const captureActiveRef = useRef(false);
  const activeVoiceTurnRef = useRef(0);
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
      if (!conversationActiveRef.current || captureActiveRef.current || voiceResponseActiveRef.current) return;
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

  async function handleTranscriptText(rawTranscript: string, turnId = activeVoiceTurnRef.current) {
    if (turnId !== activeVoiceTurnRef.current || !conversationActiveRef.current) return;
    const transcriptText = cleanRecordedVoiceTranscript(rawTranscript);
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
    if (turnId !== activeVoiceTurnRef.current || !conversationActiveRef.current) return;
    await dispatchVoiceAction(action);
  }

  async function handleRecordedAudio(attachment: RecordedAudioAttachment) {
    const turnId = activeVoiceTurnRef.current;
    setState("transcribing");
    setMessage("Transcribing...");
    try {
      if (turnId !== activeVoiceTurnRef.current || !conversationActiveRef.current) {
        return;
      }
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

      const transcript = await transcribeAudio([attachment]);
      await handleTranscriptText(transcript, turnId);
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

  const liveSpeech = useLiveSpeechRecognition({
    onPartial: (text) => {
      setState("listening");
      setMessage(listeningMessage());
      setTranscript(text);
    },
    onFinal: (text) => {
      setTranscript(text);
    },
    onEnd: (text) => {
      if (!conversationActiveRef.current) return;
      const turnId = activeVoiceTurnRef.current;
      setState("thinking");
      setMessage("Sending...");
      void handleTranscriptText(text, turnId).catch((error) => {
        setVoiceConversationActive(false);
        setState("error");
        setMessage(error instanceof Error ? error.message : "Voice request failed.");
      });
    },
    onError: (error) => {
      setVoiceConversationActive(false);
      setState("error");
      setMessage(error);
    },
  });

  const captureActive = liveSpeech.isListening || recorder.isRecording;
  captureActiveRef.current = captureActive;
  const captureSupported = liveSpeech.isSupported || recorder.isSupported;
  const busy = captureActive || isTranscribing || state === "thinking" || voiceResponseActive;
  const voiceSpeaking = voiceResponseActive && state !== "thinking";
  const canInterruptVoiceReply = voiceSpeaking && captureSupported;
  const canCancelVoiceTurn =
    conversationActive && (captureActive || state === "transcribing" || isTranscribing);
  const busyLabel =
    voiceResponseActive
      ? state === "thinking"
        ? "Thinking"
        : "Replying"
      : captureActive
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
    if (captureActive || voiceResponseActiveRef.current) return;
    activeVoiceTurnRef.current += 1;
    setVoiceConversationActive(true);
    setState("listening");
    setMessage(listeningMessage());
    setTranscript(null);
    window.dispatchEvent(new Event("entropic-voice-capture-started"));
    if (liveSpeech.isSupported && liveSpeech.start()) {
      return;
    }
    void recorder.startRecording();
  }

  function cancelVoiceTurn() {
    activeVoiceTurnRef.current += 1;
    setVoiceConversationActive(false);
    setVoiceResponseIsActive(false);
    liveSpeech.abort();
    recorder.cancelRecording();
    clearVoiceState();
  }

  function interruptVoiceReplyAndStartCapture() {
    setVoiceResponseIsActive(false);
    clearVoiceState();
    startVoiceCapture();
  }

  function stopVoiceCapture() {
    setState("transcribing");
    setMessage("Finalizing...");
    if (liveSpeech.isListening) {
      liveSpeech.stop();
      return;
    }
    recorder.stopRecording();
  }

  function stopVoiceConversation() {
    setVoiceConversationActive(false);
    if (captureActive) {
      stopVoiceCapture();
      return;
    }
    clearVoiceState();
  }

  useEffect(() => {
    if (!shortcut?.trim()) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (!shortcutMatchesEvent(shortcut, event) || busy || captureActive) return;
      event.preventDefault();
      startVoiceCapture();
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [busy, captureActive, shortcut]);

  useEffect(() => {
    function handleVoiceResponseStarted() {
      setVoiceResponseIsActive(true);
      setState("idle");
      setMessage(null);
      if (captureActive) {
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
  }, [captureActive, recorder]);

  return (
    <>
      <div className="absolute bottom-24 right-5 z-20 flex flex-col items-end gap-2">
        <button
          type="button"
          onClick={() => {
            if (canInterruptVoiceReply) {
              interruptVoiceReplyAndStartCapture();
              return;
            }
            if (canCancelVoiceTurn) {
              cancelVoiceTurn();
              return;
            }
            if (voiceResponseActiveRef.current) return;
            if (conversationActive && state === "idle") {
              stopVoiceConversation();
              return;
            }
            startVoiceCapture();
          }}
          disabled={!captureSupported || (busy && !canCancelVoiceTurn && !canInterruptVoiceReply)}
          className={clsx(
            "inline-flex h-12 w-12 items-center justify-center rounded-2xl border border-white/25 bg-black/40 text-white shadow-2xl backdrop-blur-xl transition",
            conversationActive && !captureActive && "border-emerald-300/50 bg-emerald-500/20 text-emerald-100",
            captureActive && "border-red-300/60 bg-red-500/30 text-red-100 shadow-red-500/20",
            captureActive && "animate-pulse",
            voiceResponseActive && !canInterruptVoiceReply && "cursor-not-allowed border-sky-300/50 bg-sky-500/20 text-sky-100 opacity-80",
            canInterruptVoiceReply && "border-[var(--purple-accent)]/60 bg-[var(--purple-accent)]/25 text-white shadow-[0_16px_42px_rgba(91,36,139,0.32)] hover:bg-[var(--purple-accent)]/35",
            !captureSupported && "cursor-not-allowed opacity-50",
          )}
          title={
            captureSupported
              ? canInterruptVoiceReply
                ? "Interrupt reply and speak"
                : canCancelVoiceTurn
                  ? "Stop voice conversation"
                : voiceButtonLabel
              : "Microphone unavailable"
          }
          aria-label={
            canInterruptVoiceReply
              ? "Interrupt reply and speak"
              : canCancelVoiceTurn
                ? "Stop voice conversation"
                : voiceButtonLabel
          }
        >
          {voiceSpeaking ? (
            <Mic className="h-5 w-5 animate-pulse" />
          ) : busy && !captureActive ? (
            <Loader2 className="h-5 w-5 animate-spin" />
          ) : (
            <Mic className="h-5 w-5" />
          )}
        </button>
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
