import { useEffect, useRef, useState } from "react";
import { clientLog } from "../../lib/clientLog";

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
  autoStopOnSilence?: boolean | Partial<AudioSilenceAutoStopOptions>;
};

type AudioContextConstructor = new () => AudioContext;

type AudioSilenceAutoStopOptions = {
  levelThreshold: number;
  silenceLevelThreshold: number;
  peakSilenceRatio: number;
  noiseFloorMultiplier: number;
  silenceMs: number;
  minRecordingMs: number;
  checkIntervalMs: number;
};

type SilenceDetectorState = AudioSilenceAutoStopOptions & {
  audioContext: AudioContext;
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  samples: Float32Array<ArrayBuffer>;
  intervalId: number;
  startedAt: number;
  speechSeen: boolean;
  silentSince: number | null;
  autoStopTriggered: boolean;
  noiseFloor: number;
  peakLevel: number;
  speechLogged: boolean;
};

type PcmRecorderState = {
  audioContext: AudioContext;
  source: MediaStreamAudioSourceNode;
  processor: ScriptProcessorNode;
  chunks: Float32Array[];
  totalSamples: number;
  sampleRate: number;
};

const DEFAULT_AUDIO_SILENCE_AUTO_STOP: AudioSilenceAutoStopOptions = {
  levelThreshold: 0.006,
  silenceLevelThreshold: 0.004,
  peakSilenceRatio: 0.25,
  noiseFloorMultiplier: 1.6,
  silenceMs: 900,
  minRecordingMs: 700,
  checkIntervalMs: 80,
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

function audioContextConstructor(): AudioContextConstructor | null {
  if (typeof window === "undefined") {
    return null;
  }
  const win = window as Window & typeof globalThis & { webkitAudioContext?: AudioContextConstructor };
  return win.AudioContext || win.webkitAudioContext || null;
}

function normalizeAutoStopOnSilence(
  value: UseAudioRecorderOptions["autoStopOnSilence"],
): AudioSilenceAutoStopOptions | null {
  if (!value) return null;
  if (value === true) return DEFAULT_AUDIO_SILENCE_AUTO_STOP;
  return {
    ...DEFAULT_AUDIO_SILENCE_AUTO_STOP,
    ...value,
  };
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

function roundAudioLevel(level: number): number {
  return Math.round(level * 1000) / 1000;
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

export function useAudioRecorder({
  maxBytes,
  onRecorded,
  onError,
  autoStopOnSilence,
}: UseAudioRecorderOptions) {
  const [isRecording, setIsRecording] = useState(false);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const pcmRecorderRef = useRef<PcmRecorderState | null>(null);
  const silenceDetectorRef = useRef<SilenceDetectorState | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const isSupported =
    typeof navigator !== "undefined" &&
    Boolean(navigator.mediaDevices?.getUserMedia) &&
    (typeof MediaRecorder !== "undefined" || audioContextConstructor() !== null);

  function stopStream() {
    cleanupSilenceDetector();
    const stream = streamRef.current;
    streamRef.current = null;
    if (!stream) return;
    for (const track of stream.getTracks()) {
      track.stop();
    }
  }

  function observeAudioLevel(level: number, observedAt = Date.now()) {
    const detector = silenceDetectorRef.current;
    if (!detector || detector.autoStopTriggered) return;

    detector.peakLevel = Math.max(detector.peakLevel, level);

    if (!detector.speechSeen) {
      detector.noiseFloor = detector.noiseFloor * 0.92 + level * 0.08;
    }

    const speechThreshold = Math.max(
      detector.levelThreshold,
      detector.noiseFloor * detector.noiseFloorMultiplier,
    );
    const silenceThreshold = Math.max(
      detector.silenceLevelThreshold,
      Math.min(
        0.06,
        Math.max(
          detector.noiseFloor * detector.noiseFloorMultiplier,
          detector.peakLevel * detector.peakSilenceRatio,
        ),
      ),
    );

    if (level >= speechThreshold) {
      detector.speechSeen = true;
      detector.silentSince = null;
      if (!detector.speechLogged) {
        detector.speechLogged = true;
        clientLog("voice.audio.speech_detected", {
          level: roundAudioLevel(level),
          speechThreshold: roundAudioLevel(speechThreshold),
          noiseFloor: roundAudioLevel(detector.noiseFloor),
        });
      }
      return;
    }

    if (!detector.speechSeen) return;
    if (level > silenceThreshold) {
      detector.silentSince = null;
      return;
    }
    if (detector.silentSince === null) {
      detector.silentSince = observedAt;
      return;
    }

    if (
      observedAt - detector.startedAt >= detector.minRecordingMs &&
      observedAt - detector.silentSince >= detector.silenceMs
    ) {
      detector.autoStopTriggered = true;
      clientLog("voice.audio.auto_stop", {
        level: roundAudioLevel(level),
        silenceThreshold: roundAudioLevel(silenceThreshold),
        peakLevel: roundAudioLevel(detector.peakLevel),
        elapsedMs: observedAt - detector.startedAt,
      });
      stopRecording();
    }
  }

  function cleanupSilenceDetector() {
    const detector = silenceDetectorRef.current;
    silenceDetectorRef.current = null;
    if (!detector) return;
    window.clearInterval(detector.intervalId);
    detector.source.disconnect();
    void detector.audioContext.close().catch(() => undefined);
  }

  async function startSilenceDetector(stream: MediaStream) {
    const config = normalizeAutoStopOnSilence(autoStopOnSilence);
    if (!config) return;

    const AudioContextCtor = audioContextConstructor();
    if (!AudioContextCtor) return;

    try {
      const audioContext = new AudioContextCtor();
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.2;
      source.connect(analyser);

      const detector: SilenceDetectorState = {
        ...config,
        audioContext,
        source,
        analyser,
        samples: new Float32Array(analyser.fftSize),
        intervalId: 0,
        startedAt: Date.now(),
        speechSeen: false,
        silentSince: null,
        autoStopTriggered: false,
        noiseFloor: 0.0015,
        peakLevel: 0,
        speechLogged: false,
      };
      detector.intervalId = window.setInterval(() => {
        const current = silenceDetectorRef.current;
        if (!current) return;
        current.analyser.getFloatTimeDomainData(current.samples);
        observeAudioLevel(calculateRms(current.samples));
      }, config.checkIntervalMs);
      silenceDetectorRef.current = detector;

      if (audioContext.state === "suspended") {
        await audioContext.resume();
      }
      clientLog("voice.audio.silence_detector.started", {
        speechThreshold: roundAudioLevel(config.levelThreshold),
        silenceMs: config.silenceMs,
        minRecordingMs: config.minRecordingMs,
      });
    } catch {
      cleanupSilenceDetector();
    }
  }

  function cleanupPcmRecorder() {
    const pcmRecorder = pcmRecorderRef.current;
    pcmRecorderRef.current = null;
    if (!pcmRecorder) return null;

    pcmRecorder.processor.onaudioprocess = null;
    pcmRecorder.source.disconnect();
    pcmRecorder.processor.disconnect();
    void pcmRecorder.audioContext.close().catch(() => undefined);
    return pcmRecorder;
  }

  async function startPcmRecording(stream: MediaStream) {
    const AudioContextCtor = audioContextConstructor();
    if (!AudioContextCtor) {
      throw new Error("Microphone recording is not available in this environment.");
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
    };

    processor.onaudioprocess = (event) => {
      const current = pcmRecorderRef.current;
      if (!current) return;

      const input = event.inputBuffer.getChannelData(0);
      current.chunks.push(new Float32Array(input));
      current.totalSamples += input.length;

      const output = event.outputBuffer.getChannelData(0);
      output.fill(0);
    };

    source.connect(processor);
    processor.connect(audioContext.destination);
    pcmRecorderRef.current = pcmRecorder;

    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }

    await startSilenceDetector(stream);
    setIsRecording(true);
  }

  async function finishPcmRecording() {
    const pcmRecorder = cleanupPcmRecorder();
    setIsRecording(false);
    stopStream();

    if (!pcmRecorder || pcmRecorder.totalSamples === 0) {
      onError("No audio was captured. Try again.");
      return;
    }

    const blob = encodePcmChunksAsWav(
      pcmRecorder.chunks,
      pcmRecorder.totalSamples,
      pcmRecorder.sampleRate,
    );
    if (blob.size > maxBytes) {
      onError("Recorded audio is too large. Keep recordings under 5 MB.");
      return;
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    onRecorded({
      fileName: `voice-note-${stamp}.wav`,
      mimeType: "audio/wav",
      content: await blobToBase64(blob),
      previewUrl: URL.createObjectURL(blob),
    });
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
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      streamRef.current = stream;

      let recorder: MediaRecorder | null = null;
      let mimeType = "";
      if (typeof MediaRecorder !== "undefined") {
        try {
          mimeType = preferredRecordingMimeType();
          recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
        } catch {
          recorder = null;
        }
      }

      if (!recorder) {
        await startPcmRecording(stream);
        return;
      }

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
          onError("No audio was captured. Try again.");
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

      try {
        recorder.start();
        await startSilenceDetector(stream);
        setIsRecording(true);
      } catch {
        cleanupSilenceDetector();
        recorderRef.current = null;
        chunksRef.current = [];
        await startPcmRecording(stream);
      }
    } catch (error) {
      setIsRecording(false);
      cleanupPcmRecorder();
      stopStream();
      onError(error instanceof Error ? error.message : "Microphone access was denied.");
    }
  }

  function stopRecording() {
    const recorder = recorderRef.current;
    if (pcmRecorderRef.current) {
      void finishPcmRecording().catch((error: unknown) => {
        onError(error instanceof Error ? error.message : "Failed to read recorded audio.");
      });
      return;
    }
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
      cleanupSilenceDetector();
      cleanupPcmRecorder();
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
