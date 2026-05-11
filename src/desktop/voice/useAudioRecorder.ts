import { useEffect, useRef, useState } from "react";

export type RecordedAudioAttachment = {
  fileName: string;
  mimeType: string;
  content: string;
  previewUrl: string;
};

type UseAudioRecorderOptions = {
  maxBytes: number;
  onRecorded: (attachment: RecordedAudioAttachment) => void;
  onError: (message: string) => void;
};

function preferredRecordingMimeType(): string {
  if (typeof MediaRecorder === "undefined") {
    return "";
  }
  for (const mimeType of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]) {
    if (MediaRecorder.isTypeSupported(mimeType)) {
      return mimeType;
    }
  }
  return "";
}

function recordingExtensionForMimeType(mimeType: string): string {
  if (mimeType.includes("mp4")) return "m4a";
  if (mimeType.includes("ogg")) return "ogg";
  if (mimeType.includes("wav")) return "wav";
  return "webm";
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const slice = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

export function useAudioRecorder({
  maxBytes,
  onRecorded,
  onError,
}: UseAudioRecorderOptions) {
  const [isRecording, setIsRecording] = useState(false);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const isSupported =
    typeof navigator !== "undefined" &&
    Boolean(navigator.mediaDevices?.getUserMedia) &&
    typeof MediaRecorder !== "undefined";

  function stopStream() {
    const stream = streamRef.current;
    streamRef.current = null;
    if (!stream) return;
    for (const track of stream.getTracks()) {
      track.stop();
    }
  }

  async function startRecording() {
    if (!isSupported) {
      onError("Microphone recording is not available in this environment.");
      return;
    }
    if (isRecording) {
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = preferredRecordingMimeType();
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);

      streamRef.current = stream;
      recorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };
      recorder.onerror = () => {
        setIsRecording(false);
        stopStream();
        chunksRef.current = [];
        recorderRef.current = null;
        onError("Microphone recording failed. Please try again.");
      };
      recorder.onstop = () => {
        const chunks = chunksRef.current;
        const resolvedMimeType = recorder.mimeType || mimeType || "audio/webm";
        chunksRef.current = [];
        recorderRef.current = null;
        setIsRecording(false);
        stopStream();

        if (chunks.length === 0) {
          return;
        }

        void (async () => {
          const blob = new Blob(chunks, { type: resolvedMimeType });
          if (blob.size > maxBytes) {
            onError("Recorded audio is too large. Keep recordings under 5 MB.");
            return;
          }
          const stamp = new Date().toISOString().replace(/[:.]/g, "-");
          onRecorded({
            fileName: `voice-note-${stamp}.${recordingExtensionForMimeType(resolvedMimeType)}`,
            mimeType: resolvedMimeType,
            content: await blobToBase64(blob),
            previewUrl: URL.createObjectURL(blob),
          });
        })().catch((error: unknown) => {
          onError(error instanceof Error ? error.message : "Failed to read recorded audio.");
        });
      };

      recorder.start();
      setIsRecording(true);
    } catch (error) {
      setIsRecording(false);
      stopStream();
      onError(error instanceof Error ? error.message : "Microphone access was denied.");
    }
  }

  function stopRecording() {
    const recorder = recorderRef.current;
    if (!recorder) {
      setIsRecording(false);
      stopStream();
      return;
    }
    if (recorder.state !== "inactive") {
      recorder.stop();
    }
  }

  useEffect(() => {
    return () => {
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        recorder.stop();
      }
      stopStream();
    };
  }, []);

  return {
    isRecording,
    isSupported,
    startRecording,
    stopRecording,
  };
}
