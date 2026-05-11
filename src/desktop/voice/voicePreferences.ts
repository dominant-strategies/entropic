export type VoiceSpeechVoice = "neutral" | "warm_female" | "clear_female" | "warm_male" | "deep_male";

export type VoiceSpeechVoiceOption = {
  id: VoiceSpeechVoice;
  label: string;
  description: string;
  managedVoiceId: string;
  openAiVoiceId: string;
};

export const DEFAULT_VOICE_SPEECH_RATE = 1.3;
export const MIN_VOICE_SPEECH_RATE = 0.75;
export const MAX_VOICE_SPEECH_RATE = 1.75;

export const DEFAULT_VOICE_SPEECH_VOICE: VoiceSpeechVoice = "neutral";

export const VOICE_SPEECH_VOICES: VoiceSpeechVoiceOption[] = [
  {
    id: "neutral",
    label: "Alloy",
    description: "Balanced and neutral",
    managedVoiceId: "af_alloy",
    openAiVoiceId: "alloy",
  },
  {
    id: "warm_female",
    label: "Warm Female",
    description: "Softer and warmer",
    managedVoiceId: "af_heart",
    openAiVoiceId: "nova",
  },
  {
    id: "clear_female",
    label: "Clear Female",
    description: "Bright and crisp",
    managedVoiceId: "af_nova",
    openAiVoiceId: "shimmer",
  },
  {
    id: "warm_male",
    label: "Warm Male",
    description: "Relaxed lower tone",
    managedVoiceId: "am_adam",
    openAiVoiceId: "echo",
  },
  {
    id: "deep_male",
    label: "Deep Male",
    description: "Deeper and steadier",
    managedVoiceId: "am_onyx",
    openAiVoiceId: "onyx",
  },
];

export function normalizeVoiceSpeechVoice(value: unknown): VoiceSpeechVoice {
  return VOICE_SPEECH_VOICES.some((voice) => voice.id === value)
    ? value as VoiceSpeechVoice
    : DEFAULT_VOICE_SPEECH_VOICE;
}

export function normalizeVoiceSpeechRate(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_VOICE_SPEECH_RATE;
  return Math.min(MAX_VOICE_SPEECH_RATE, Math.max(MIN_VOICE_SPEECH_RATE, numeric));
}

export function voiceIdForSpeechProvider(
  voice: VoiceSpeechVoice,
  options: { useLocalKeys: boolean },
): string {
  const selected = VOICE_SPEECH_VOICES.find((entry) => entry.id === voice)
    ?? VOICE_SPEECH_VOICES[0];
  return options.useLocalKeys ? selected.openAiVoiceId : selected.managedVoiceId;
}
