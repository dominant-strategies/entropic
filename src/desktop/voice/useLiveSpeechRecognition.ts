import { useCallback, useEffect, useRef, useState } from "react";

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  lang: string;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

type SpeechRecognitionErrorEventLike = {
  error?: string;
  message?: string;
};

type SpeechRecognitionResultListLike = {
  length: number;
  item?: (index: number) => SpeechRecognitionResultLike;
  [index: number]: SpeechRecognitionResultLike;
};

type SpeechRecognitionResultLike = {
  isFinal: boolean;
  length: number;
  item?: (index: number) => SpeechRecognitionAlternativeLike;
  [index: number]: SpeechRecognitionAlternativeLike;
};

type SpeechRecognitionAlternativeLike = {
  transcript: string;
};

type SpeechRecognitionEventLike = {
  resultIndex: number;
  results: SpeechRecognitionResultListLike;
};

type LiveSpeechCallbacks = {
  onPartial?: (text: string) => void;
  onFinal?: (text: string) => void;
  onEnd?: (text: string) => void;
  onError?: (message: string) => void;
};

type LiveSpeechStartOptions = {
  lang?: string;
  continuous?: boolean;
  autoRestart?: boolean;
};

function speechRecognitionConstructor(): SpeechRecognitionConstructor | null {
  if (typeof window === "undefined") return null;
  const win = window as Window & typeof globalThis & {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return win.SpeechRecognition ?? win.webkitSpeechRecognition ?? null;
}

function speechResultAt(
  results: SpeechRecognitionResultListLike,
  index: number,
): SpeechRecognitionResultLike | null {
  return results.item?.(index) ?? results[index] ?? null;
}

function speechAlternativeAt(
  result: SpeechRecognitionResultLike,
  index: number,
): SpeechRecognitionAlternativeLike | null {
  return result.item?.(index) ?? result[index] ?? null;
}

function normalizeTranscript(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function useLiveSpeechRecognition(callbacks: LiveSpeechCallbacks = {}) {
  const callbacksRef = useRef(callbacks);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const finalTranscriptRef = useRef("");
  const latestTranscriptRef = useRef("");
  const restartTimerRef = useRef<number | null>(null);
  const startOptionsRef = useRef<LiveSpeechStartOptions>({});
  const stopRequestedRef = useRef(false);
  const shouldRestartRef = useRef(false);
  const [isListening, setIsListening] = useState(false);
  const isSupported = speechRecognitionConstructor() !== null;

  useEffect(() => {
    callbacksRef.current = callbacks;
  }, [callbacks]);

  const reset = useCallback(() => {
    finalTranscriptRef.current = "";
    latestTranscriptRef.current = "";
  }, []);

  const clearRestartTimer = useCallback(() => {
    if (restartTimerRef.current !== null) {
      window.clearTimeout(restartTimerRef.current);
      restartTimerRef.current = null;
    }
  }, []);

  const stop = useCallback(() => {
    stopRequestedRef.current = true;
    shouldRestartRef.current = false;
    clearRestartTimer();
    const recognition = recognitionRef.current;
    if (recognition) {
      recognition.stop();
      return;
    }
    setIsListening(false);
    callbacksRef.current.onEnd?.(latestTranscriptRef.current || finalTranscriptRef.current);
  }, [clearRestartTimer]);

  const abort = useCallback(() => {
    stopRequestedRef.current = true;
    shouldRestartRef.current = false;
    clearRestartTimer();
    recognitionRef.current?.abort();
    recognitionRef.current = null;
    setIsListening(false);
  }, [clearRestartTimer]);

  const startRecognition = useCallback(() => {
    const Recognition = speechRecognitionConstructor();
    if (!Recognition) {
      callbacksRef.current.onError?.("Live speech transcription is not available in this WebView.");
      return false;
    }

    clearRestartTimer();
    const options = startOptionsRef.current;
    const recognition = new Recognition();
    recognitionRef.current = recognition;
    recognition.continuous = options.continuous === true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.lang = options.lang || "en-US";
    recognition.onstart = () => {
      setIsListening(true);
    };
    recognition.onresult = (event) => {
      let interimText = "";
      let sawFinalResult = false;
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = speechResultAt(event.results, index);
        if (!result) continue;
        const transcript = normalizeTranscript(speechAlternativeAt(result, 0)?.transcript ?? "");
        if (!transcript) continue;
        if (result.isFinal) {
          sawFinalResult = true;
          finalTranscriptRef.current = normalizeTranscript(
            `${finalTranscriptRef.current} ${transcript}`,
          );
        } else {
          interimText = normalizeTranscript(`${interimText} ${transcript}`);
        }
      }

      const combined = normalizeTranscript(`${finalTranscriptRef.current} ${interimText}`);
      if (sawFinalResult && finalTranscriptRef.current) {
        callbacksRef.current.onFinal?.(finalTranscriptRef.current);
      }
      if (combined) {
        latestTranscriptRef.current = combined;
        callbacksRef.current.onPartial?.(combined);
      }
    };
    recognition.onerror = (event) => {
      const code = event.error || "speech-recognition";
      if (code === "no-speech" || code === "aborted") return;
      shouldRestartRef.current = false;
      callbacksRef.current.onError?.(event.message || `Speech recognition failed: ${code}`);
    };
    recognition.onend = () => {
      recognitionRef.current = null;
      if (shouldRestartRef.current && !stopRequestedRef.current) {
        restartTimerRef.current = window.setTimeout(() => {
          if (!shouldRestartRef.current || stopRequestedRef.current) return;
          void startRecognition();
        }, 90);
        return;
      }
      setIsListening(false);
      callbacksRef.current.onEnd?.(latestTranscriptRef.current || finalTranscriptRef.current);
    };

    try {
      recognition.start();
      return true;
    } catch (error) {
      recognitionRef.current = null;
      setIsListening(false);
      callbacksRef.current.onError?.(
        error instanceof Error ? error.message : "Failed to start live speech transcription.",
      );
      return false;
    }
  }, [clearRestartTimer]);

  const start = useCallback((options: LiveSpeechStartOptions = {}) => {
    abort();
    reset();
    startOptionsRef.current = options;
    stopRequestedRef.current = false;
    shouldRestartRef.current = options.autoRestart === true || options.continuous === true;
    return startRecognition();
  }, [abort, reset, startRecognition]);

  useEffect(() => () => abort(), [abort]);

  return {
    isSupported,
    isListening,
    start,
    stop,
    abort,
  };
}
