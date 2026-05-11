import { Store } from "@tauri-apps/plugin-store";

export type DesktopSettingsSnapshot = {
  useLocalKeys?: boolean;
  experimentalDesktop?: boolean;
  selectedModel?: string;
  codeModel?: string;
  imageModel?: string;
  imageGenerationModel?: string;
  textToSpeechModel?: string;
  audioUnderstandingModel?: string;
  voiceShortcut?: string;
  voiceSpeechRate?: number;
  voiceSpeechVoice?: string;
  desktopWallpaper?: string;
  desktopCustomWallpaper?: string;
};

const SETTINGS_FILE = "entropic-settings.json";

const SETTING_KEYS = [
  "useLocalKeys",
  "experimentalDesktop",
  "selectedModel",
  "codeModel",
  "imageModel",
  "imageGenerationModel",
  "textToSpeechModel",
  "audioUnderstandingModel",
  "voiceShortcut",
  "voiceSpeechRate",
  "voiceSpeechVoice",
  "desktopWallpaper",
  "desktopCustomWallpaper",
] as const satisfies ReadonlyArray<keyof DesktopSettingsSnapshot>;

type SettingsListener = (snapshot: DesktopSettingsSnapshot) => void;

let storePromise: Promise<Store> | null = null;
let snapshotPromise: Promise<DesktopSettingsSnapshot> | null = null;
let cachedSnapshot: DesktopSettingsSnapshot | null = null;
let writeQueue: Promise<void> = Promise.resolve();
const listeners = new Set<SettingsListener>();

function cloneSnapshot(snapshot: DesktopSettingsSnapshot): DesktopSettingsSnapshot {
  return { ...snapshot };
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : undefined;
  }
  return undefined;
}

function normalizeDesktopSettings(
  raw: Partial<DesktopSettingsSnapshot> | null | undefined,
): DesktopSettingsSnapshot {
  return {
    useLocalKeys: typeof raw?.useLocalKeys === "boolean" ? raw.useLocalKeys : undefined,
    experimentalDesktop:
      typeof raw?.experimentalDesktop === "boolean" ? raw.experimentalDesktop : undefined,
    selectedModel: normalizeString(raw?.selectedModel),
    codeModel: normalizeString(raw?.codeModel),
    imageModel: normalizeString(raw?.imageModel),
    imageGenerationModel: normalizeString(raw?.imageGenerationModel),
    textToSpeechModel: normalizeString(raw?.textToSpeechModel),
    audioUnderstandingModel: normalizeString(raw?.audioUnderstandingModel),
    voiceShortcut: normalizeString(raw?.voiceShortcut),
    voiceSpeechRate: normalizeNumber(raw?.voiceSpeechRate),
    voiceSpeechVoice: normalizeString(raw?.voiceSpeechVoice),
    desktopWallpaper: normalizeString(raw?.desktopWallpaper),
    desktopCustomWallpaper: normalizeString(raw?.desktopCustomWallpaper),
  };
}

function normalizeDesktopSettingsPatch(
  raw: Partial<DesktopSettingsSnapshot>,
): Partial<DesktopSettingsSnapshot> {
  const normalized = normalizeDesktopSettings(raw);
  const patch: Partial<DesktopSettingsSnapshot> = {};
  for (const key of SETTING_KEYS) {
    if (Object.prototype.hasOwnProperty.call(raw, key)) {
      patch[key] = normalized[key] as never;
    }
  }
  return patch;
}

async function getStore(): Promise<Store> {
  if (!storePromise) {
    storePromise = Store.load(SETTINGS_FILE);
  }
  return storePromise;
}

async function readSettingsFromStore(store: Store): Promise<DesktopSettingsSnapshot> {
  const entries = await Promise.all(
    SETTING_KEYS.map(async (key) => [key, await store.get(String(key))] as const),
  );
  const raw: Partial<DesktopSettingsSnapshot> = {};
  for (const [key, value] of entries) {
    (raw as Record<string, unknown>)[key] = value;
  }
  return normalizeDesktopSettings(raw);
}

function publish(snapshot: DesktopSettingsSnapshot) {
  const next = cloneSnapshot(snapshot);
  cachedSnapshot = next;
  for (const listener of listeners) {
    listener(cloneSnapshot(next));
  }
}

export function primeDesktopSettings(snapshot: Partial<DesktopSettingsSnapshot>) {
  publish(normalizeDesktopSettings(snapshot));
}

export async function loadDesktopSettings(opts?: {
  force?: boolean;
}): Promise<DesktopSettingsSnapshot> {
  if (!opts?.force && cachedSnapshot) {
    return cloneSnapshot(cachedSnapshot);
  }
  if (!opts?.force && snapshotPromise) {
    return snapshotPromise.then(cloneSnapshot);
  }

  snapshotPromise = (async () => {
    const store = await getStore();
    const snapshot = await readSettingsFromStore(store);
    publish(snapshot);
    return snapshot;
  })().finally(() => {
    snapshotPromise = null;
  });

  return snapshotPromise.then(cloneSnapshot);
}

export async function updateDesktopSettings(
  patch: Partial<DesktopSettingsSnapshot>,
): Promise<DesktopSettingsSnapshot> {
  const normalizedPatch = normalizeDesktopSettingsPatch(patch);
  const runUpdate = async () => {
    const previous = await loadDesktopSettings();
    const next = normalizeDesktopSettings({ ...previous, ...normalizedPatch });
    const store = await getStore();

    for (const key of SETTING_KEYS) {
      const value = next[key];
      if (value === undefined) {
        await store.delete(String(key));
        continue;
      }
      await store.set(String(key), value);
    }
    await store.save();
    publish(next);
    return cloneSnapshot(next);
  };

  const result = writeQueue.then(runUpdate, runUpdate);
  writeQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export function subscribeDesktopSettings(listener: SettingsListener): () => void {
  listeners.add(listener);
  if (cachedSnapshot) {
    listener(cloneSnapshot(cachedSnapshot));
  }
  return () => {
    listeners.delete(listener);
  };
}
