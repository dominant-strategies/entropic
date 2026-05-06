import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export type GeneratedAudioAttachment = {
  fileName: string;
  mimeType: string;
  previewUrl: string;
};

type ChatAudioGenerationResponse = {
  text: string;
  audio: Array<{
    file_name: string;
    mime_type: string;
    url: string;
  }>;
};

export type TextToSpeechOptions = {
  voiceId?: string;
  speed?: number;
};

export function useTextToSpeech(model: string, options: TextToSpeechOptions = {}) {
  const [isGeneratingAudio, setIsGeneratingAudio] = useState(false);

  async function generateSpeech(text: string) {
    const normalizedModel = model.trim();
    if (!normalizedModel) {
      throw new Error("Choose a Text to Speech Model in Settings first.");
    }
    const normalizedText = text.trim();
    if (!normalizedText) {
      throw new Error("Enter text first.");
    }

    setIsGeneratingAudio(true);
    try {
      const response = await invoke<ChatAudioGenerationResponse>("generate_chat_audio", {
        model: normalizedModel,
        text: normalizedText,
        voiceId: options.voiceId,
        speed: options.speed,
      });
      return {
        text: response.text.trim(),
        audio: response.audio.map((audio, index) => ({
          fileName: audio.file_name || `generated-speech-${index + 1}.mp3`,
          mimeType: audio.mime_type || "audio/mpeg",
          previewUrl: audio.url,
        })),
      };
    } finally {
      setIsGeneratingAudio(false);
    }
  }

  return { isGeneratingAudio, generateSpeech };
}
