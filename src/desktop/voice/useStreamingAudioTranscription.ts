import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import { cleanRecordedVoiceTranscript } from "./useAudioTranscription";

type StreamingAudioTranscriptionCallbacks = {
  model: string;
  maxBytes: number;
  onPartial?: (text: string) => void;
  onEnd?: (text: string) => void;
  onError?: (message: string) => void;
};

type ChatAudioTranscriptionResponse = {
  text: string;
};

type QueuedAudioChunk = {
  blob: Blob;
  fileName: string;
  mimeType: string;
  speechSeen: boolean;
};

type AudioContextConstructor = new () => AudioContext;

type PcmRecorderState = {
  audioContext: AudioContext;
  source: MediaStreamAudioSourceNode;
  processor: ScriptProcessorNode;
  chunks: Float32Array[];
  totalSamples: number;
  sampleRate: number;
  chunkTimer: number | null;
};

const STREAMING_CHUNK_MS = 2600;
const MIN_CHUNK_BYTES = 700;
const MAX_QUEUED_CHUNKS = 16;
const SPEECH_LEVEL_THRESHOLD = 0.0035;

function audioContextConstructor(): AudioContextConstructor | null {
  if (typeof window === "undefined") return null;
  const win = window as Window & typeof globalThis & {
    webkitAudioContext?: AudioContextConstructor;
  };
  return window.AudioContext ?? win.webkitAudioContext ?? null;
}

function preferredStreamingMimeType() {
  if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported) {
    return "";
  }
  for (const mimeType of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]) {
    if (MediaRecorder.isTypeSupported(mimeType)) return mimeType;
  }
  return "";
}

function shouldPreferPcmRecording(): boolean {
  if (typeof navigator === "undefined") return false;
  const userAgent = navigator.userAgent || "";
  const platform = navigator.platform || "";
  return /linux/i.test(`${platform} ${userAgent}`) && /webkit/i.test(userAgent) && !/chrome|chromium/i.test(userAgent);
}

function audioExtensionForMimeType(mimeType: string) {
  if (mimeType.includes("wav")) return "wav";
  if (mimeType.includes("mp4")) return "m4a";
  if (mimeType.includes("ogg")) return "ogg";
  return "webm";
}

function normalizeStreamingTranscript(text: string) {
  return cleanRecordedVoiceTranscript(text).replace(/\s+/g, " ").trim();
}

function calculateRms(samples: ArrayLike<number>): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index] || 0;
    sum += sample * sample;
  }
  return Math.sqrt(sum / samples.length);
}

function writeAscii(view: DataView, offset: number, value: string) {
  for (let i = 0; i < value.length; i += 1) {
    view.setUint8(offset + i, value.charCodeAt(i));
  }
}

function encodePcmChunksAsWav(chunks: Float32Array[], totalSamples: number, sampleRate: number): Blob {
  const bytesPerSample = 2;
  const channelCount = 1;
  const dataLength = totalSamples * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataLength, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channelCount * bytesPerSample, true);
  view.setUint16(32, channelCount * bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataLength, true);

  let offset = 44;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i += 1) {
      const sample = Math.max(-1, Math.min(1, chunk[i] || 0));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += bytesPerSample;
    }
  }

  return new Blob([view], { type: "audio/wav" });
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Failed to read recorded audio."));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const [, base64 = ""] = result.split(",", 2);
      resolve(base64);
    };
    reader.readAsDataURL(blob);
  });
}

export function useStreamingAudioTranscription(callbacks: StreamingAudioTranscriptionCallbacks) {
  const callbacksRef = useRef(callbacks);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const pcmRecorderRef = useRef<PcmRecorderState | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const levelTimerRef = useRef<number | null>(null);
  const queueRef = useRef<QueuedAudioChunk[]>([]);
  const processingRef = useRef(false);
  const stopRequestedRef = useRef(false);
  const endEmittedRef = useRef(false);
  const chunkSpeechSeenRef = useRef(false);
  const accumulatedTranscriptRef = useRef("");
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);

  const isSupported =
    typeof window !== "undefined" &&
    typeof navigator !== "undefined" &&
    Boolean(navigator.mediaDevices?.getUserMedia) &&
    (typeof MediaRecorder !== "undefined" || audioContextConstructor() !== null);

  useEffect(() => {
    callbacksRef.current = callbacks;
  }, [callbacks]);

  function stopLevelMonitor() {
    if (levelTimerRef.current !== null) {
      window.clearInterval(levelTimerRef.current);
      levelTimerRef.current = null;
    }
    if (audioContextRef.current) {
      void audioContextRef.current.close().catch(() => undefined);
      audioContextRef.current = null;
    }
  }

  function stopStream() {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    stopLevelMonitor();
  }

  function maybeEmitEnd() {
    if (
      !stopRequestedRef.current ||
      endEmittedRef.current ||
      recorderRef.current ||
      pcmRecorderRef.current ||
      processingRef.current ||
      queueRef.current.length > 0
    ) {
      return;
    }
    endEmittedRef.current = true;
    setIsProcessing(false);
    callbacksRef.current.onEnd?.(accumulatedTranscriptRef.current);
  }

  function appendTranscript(rawText: string) {
    const nextSegment = normalizeStreamingTranscript(rawText);
    if (!nextSegment) return;
    accumulatedTranscriptRef.current = normalizeStreamingTranscript(
      `${accumulatedTranscriptRef.current} ${nextSegment}`,
    );
    callbacksRef.current.onPartial?.(accumulatedTranscriptRef.current);
  }

  function enqueueAudioChunk(blob: Blob, mimeType: string, speechSeen: boolean) {
    if (!blob || blob.size === 0) return;
    if (queueRef.current.length >= MAX_QUEUED_CHUNKS) {
      queueRef.current.shift();
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    queueRef.current.push({
      blob,
      fileName: `voice-note-${stamp}.${audioExtensionForMimeType(mimeType)}`,
      mimeType,
      speechSeen,
    });
    void processQueue();
  }

  async function processQueue() {
    if (processingRef.current) return;
    processingRef.current = true;
    setIsProcessing(true);

    try {
      while (queueRef.current.length > 0) {
        const chunk = queueRef.current.shift();
        if (!chunk) continue;
        if (!chunk.speechSeen || chunk.blob.size < MIN_CHUNK_BYTES) {
          continue;
        }
        if (chunk.blob.size > callbacksRef.current.maxBytes) {
          callbacksRef.current.onError?.("Recorded audio chunk is too large. Try shorter dictation.");
          continue;
        }

        const model = callbacksRef.current.model.trim();
        if (!model) {
          callbacksRef.current.onError?.("Choose an Audio Understanding Model in Settings first.");
          continue;
        }

        const content = await blobToBase64(chunk.blob);
        const response = await invoke<ChatAudioTranscriptionResponse>("transcribe_chat_audio", {
          model,
          attachments: [
            {
              file_name: chunk.fileName,
              mime_type: chunk.mimeType,
              content,
            },
          ],
        });
        appendTranscript(response.text);
      }
    } catch (error) {
      callbacksRef.current.onError?.(
        error instanceof Error ? error.message : "Failed to transcribe live audio.",
      );
    } finally {
      processingRef.current = false;
      setIsProcessing(false);
      if (queueRef.current.length > 0) {
        void processQueue();
        return;
      }
      maybeEmitEnd();
    }
  }

  function startLevelMonitor(stream: MediaStream) {
    const AudioContextCtor = audioContextConstructor();
    if (!AudioContextCtor) {
      chunkSpeechSeenRef.current = true;
      return;
    }

    try {
      const audioContext = new AudioContextCtor();
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      audioContextRef.current = audioContext;
      const samples = new Uint8Array(analyser.fftSize);
      levelTimerRef.current = window.setInterval(() => {
        analyser.getByteTimeDomainData(samples);
        let sumSquares = 0;
        for (const sample of samples) {
          const normalized = (sample - 128) / 128;
          sumSquares += normalized * normalized;
        }
        const level = Math.sqrt(sumSquares / samples.length);
        if (level >= SPEECH_LEVEL_THRESHOLD) {
          chunkSpeechSeenRef.current = true;
        }
      }, 60);
      if (audioContext.state === "suspended") {
        void audioContext.resume().catch(() => undefined);
      }
    } catch {
      chunkSpeechSeenRef.current = true;
    }
  }

  function flushPcmChunk() {
    const pcmRecorder = pcmRecorderRef.current;
    if (!pcmRecorder || pcmRecorder.totalSamples === 0) return;

    const chunks = pcmRecorder.chunks;
    const totalSamples = pcmRecorder.totalSamples;
    const speechSeen = chunkSpeechSeenRef.current;
    pcmRecorder.chunks = [];
    pcmRecorder.totalSamples = 0;
    chunkSpeechSeenRef.current = false;

    enqueueAudioChunk(
      encodePcmChunksAsWav(chunks, totalSamples, pcmRecorder.sampleRate),
      "audio/wav",
      speechSeen,
    );
  }

  function cleanupPcmRecorder() {
    const pcmRecorder = pcmRecorderRef.current;
    if (!pcmRecorder) return;
    if (pcmRecorder.chunkTimer !== null) {
      window.clearInterval(pcmRecorder.chunkTimer);
    }
    pcmRecorder.processor.onaudioprocess = null;
    pcmRecorder.processor.disconnect();
    pcmRecorder.source.disconnect();
    void pcmRecorder.audioContext.close().catch(() => undefined);
    pcmRecorderRef.current = null;
  }

  async function startPcmRecorder(stream: MediaStream) {
    const AudioContextCtor = audioContextConstructor();
    if (!AudioContextCtor) {
      callbacksRef.current.onError?.("Live audio transcription is not available in this WebView.");
      return false;
    }

    const audioContext = new AudioContextCtor();
    const source = audioContext.createMediaStreamSource(stream);
    const processor = audioContext.createScriptProcessor(4096, 1, 1);
    const pcmRecorder: PcmRecorderState = {
      audioContext,
      source,
      processor,
      chunks: [],
      totalSamples: 0,
      sampleRate: audioContext.sampleRate,
      chunkTimer: null,
    };
    pcmRecorderRef.current = pcmRecorder;
    processor.onaudioprocess = (event) => {
      if (pcmRecorderRef.current !== pcmRecorder) return;
      const input = event.inputBuffer.getChannelData(0);
      const copy = new Float32Array(input);
      pcmRecorder.chunks.push(copy);
      pcmRecorder.totalSamples += copy.length;
      if (calculateRms(copy) >= SPEECH_LEVEL_THRESHOLD) {
        chunkSpeechSeenRef.current = true;
      }
    };
    source.connect(processor);
    processor.connect(audioContext.destination);
    pcmRecorder.chunkTimer = window.setInterval(flushPcmChunk, STREAMING_CHUNK_MS);
    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }
    setIsRecording(true);
    return true;
  }

  async function start() {
    if (!isSupported) {
      callbacksRef.current.onError?.("Live audio transcription is not available in this WebView.");
      return false;
    }

    stopRequestedRef.current = false;
    endEmittedRef.current = false;
    accumulatedTranscriptRef.current = "";
    queueRef.current = [];
    chunkSpeechSeenRef.current = false;
    setIsProcessing(false);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      streamRef.current = stream;

      if (!shouldPreferPcmRecording() && typeof MediaRecorder !== "undefined") {
        try {
          startLevelMonitor(stream);
          const mimeType = preferredStreamingMimeType();
          const recorder = mimeType
            ? new MediaRecorder(stream, { mimeType })
            : new MediaRecorder(stream);
          const resolvedMimeType = recorder.mimeType || mimeType || "audio/webm";
          recorderRef.current = recorder;
          recorder.ondataavailable = (event) => {
            const speechSeen = chunkSpeechSeenRef.current;
            chunkSpeechSeenRef.current = false;
            enqueueAudioChunk(event.data, resolvedMimeType, speechSeen);
          };
          recorder.onerror = () => {
            callbacksRef.current.onError?.("Live audio recording failed.");
            stop();
          };
          recorder.onstop = () => {
            recorderRef.current = null;
            setIsRecording(false);
            stopStream();
            void processQueue();
          };
          recorder.start(STREAMING_CHUNK_MS);
          setIsRecording(true);
          return true;
        } catch {
          recorderRef.current = null;
          stopLevelMonitor();
        }
      }

      const pcmStarted = await startPcmRecorder(stream);
      if (!pcmStarted) {
        stopStream();
      }
      return pcmStarted;
    } catch (error) {
      recorderRef.current = null;
      cleanupPcmRecorder();
      setIsRecording(false);
      stopStream();
      callbacksRef.current.onError?.(
        error instanceof Error ? error.message : "Microphone access was denied.",
      );
      return false;
    }
  }

  function stop() {
    stopRequestedRef.current = true;
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
      return;
    }
    if (pcmRecorderRef.current) {
      flushPcmChunk();
      cleanupPcmRecorder();
      setIsRecording(false);
      stopStream();
      void processQueue();
      return;
    }
    recorderRef.current = null;
    setIsRecording(false);
    stopStream();
    void processQueue();
  }

  function abort() {
    stopRequestedRef.current = true;
    endEmittedRef.current = true;
    queueRef.current = [];
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
    }
    recorderRef.current = null;
    cleanupPcmRecorder();
    setIsRecording(false);
    setIsProcessing(false);
    stopStream();
  }

  useEffect(() => () => abort(), []);

  return {
    isSupported,
    isRecording,
    isProcessing,
    start,
    stop,
    abort,
  };
}
