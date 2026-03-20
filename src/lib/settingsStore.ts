import { Store } from "@tauri-apps/plugin-store";

export type DesktopSettingsSnapshot = {
  useLocalKeys?: boolean;
  experimentalDesktop?: boolean;
  selectedModel?: string;
  codeModel?: string;
  imageModel?: string;
  imageGenerationModel?: string;
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
  "desktopWallpaper",
  "desktopCustomWallpaper",
] as const satisfies ReadonlyArray<keyof DesktopSettingsSnapshot>;

type SettingsListener = (snapshot: DesktopSettingsSnapshot) => void;

let storePromise: Promise<Store> | null = null;
let snapshotPromise: Promise<DesktopSettingsSnapshot> | null = null;
let cachedSnapshot: DesktopSettingsSnapshot | null = null;
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
    desktopWallpaper: normalizeString(raw?.desktopWallpaper),
    desktopCustomWallpaper: normalizeString(raw?.desktopCustomWallpaper),
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
