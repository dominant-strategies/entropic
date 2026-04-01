import { Store } from "@tauri-apps/plugin-store";

export type DesktopSettingsSnapshot = {
  useLocalKeys?: boolean;
  experimentalDesktop?: boolean;
  selectedModel?: string;
  codeModel?: string;
  imageModel?: string;
  imageGenerationModel?: string;
  showReasoning?: boolean;
  localDebugMode?: boolean;
  localDebugDirectBypass?: boolean;
  localDirectDebugChat?: boolean;
  desktopWallpaper?: string;
  desktopCustomWallpaper?: string;
};

export type LocalModePerformanceSettings = {
  debugMode: boolean;
  debugDirectBypass: boolean;
};

export const DEFAULT_LOCAL_MODE_PERFORMANCE_SETTINGS: LocalModePerformanceSettings = {
  debugMode: false,
  debugDirectBypass: false,
};

const SETTINGS_FILE = "entropic-settings.json";
const REMOVED_SETTING_KEYS = [
  "localDisableTools",
  "localLightweightBootstrap",
  "localLightRuntimeDefaults",
  "localCapturePromptPreview",
] as const;

const SETTING_KEYS = [
  "useLocalKeys",
  "experimentalDesktop",
  "selectedModel",
  "codeModel",
  "imageModel",
  "imageGenerationModel",
  "showReasoning",
  "localDebugMode",
  "localDebugDirectBypass",
  "localDirectDebugChat",
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
    showReasoning: typeof raw?.showReasoning === "boolean" ? raw.showReasoning : true,
    localDebugMode: typeof raw?.localDebugMode === "boolean" ? raw.localDebugMode : undefined,
    localDebugDirectBypass:
      typeof raw?.localDebugDirectBypass === "boolean" ? raw.localDebugDirectBypass : undefined,
    localDirectDebugChat:
      typeof raw?.localDirectDebugChat === "boolean" ? raw.localDirectDebugChat : undefined,
    desktopWallpaper: normalizeString(raw?.desktopWallpaper),
    desktopCustomWallpaper: normalizeString(raw?.desktopCustomWallpaper),
  };
}

export function resolveLocalModePerformanceSettings(
  raw: Partial<DesktopSettingsSnapshot> | null | undefined,
): LocalModePerformanceSettings {
  const legacyDirectDebugChat =
    typeof raw?.localDirectDebugChat === "boolean" ? raw.localDirectDebugChat : undefined;
  return {
    debugMode:
      raw?.localDebugMode ?? legacyDirectDebugChat ?? DEFAULT_LOCAL_MODE_PERFORMANCE_SETTINGS.debugMode,
    debugDirectBypass:
      raw?.localDebugDirectBypass ??
      legacyDirectDebugChat ??
      DEFAULT_LOCAL_MODE_PERFORMANCE_SETTINGS.debugDirectBypass,
  };
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
  const normalizedPatch = normalizeDesktopSettings(patch);
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
    for (const key of REMOVED_SETTING_KEYS) {
      await store.delete(String(key));
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
