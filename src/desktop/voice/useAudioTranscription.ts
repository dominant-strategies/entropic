import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export type AudioTranscriptionAttachment = {
  fileName: string;
  mimeType: string;
  content: string;
};

type ChatAudioTranscriptionResponse = {
  text: string;
};

export function cleanRecordedVoiceTranscript(text: string) {
  return text
    .replace(/^voice-note-[^\n:]+\.(?:webm|wav|m4a|mp3|mp4|ogg):\s*/i, "")
    .trim();
}

export function useAudioTranscription(model: string) {
  const [isTranscribing, setIsTranscribing] = useState(false);

  async function transcribeAudio(attachments: AudioTranscriptionAttachment[]) {
    const normalizedModel = model.trim();
    if (!normalizedModel) {
      throw new Error("Choose an Audio Understanding Model in Settings first.");
    }
    if (attachments.length === 0) {
      throw new Error("Attach audio first.");
    }

    setIsTranscribing(true);
    try {
      const response = await invoke<ChatAudioTranscriptionResponse>("transcribe_chat_audio", {
        model: normalizedModel,
        attachments: attachments.map((attachment) => ({
          file_name: attachment.fileName,
          mime_type: attachment.mimeType,
          content: attachment.content,
        })),
      });
      const text = response.text.trim();
      if (!text) {
        throw new Error("The audio transcription completed, but no text was returned.");
      }
      return text;
    } finally {
      setIsTranscribing(false);
    }
  }

  return { isTranscribing, transcribeAudio };
}
