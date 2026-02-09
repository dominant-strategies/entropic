import { appDataDir, join } from "@tauri-apps/api/path";
import { Store } from "@tauri-apps/plugin-store";
import { Stronghold } from "@tauri-apps/plugin-stronghold";

const VAULT_FILE = "nova-integrations.hold";
const VAULT_CLIENT = "nova-integrations";
const VAULT_PASSWORD_KEY = "vaultPassword";
const INDEX_KEY = "__integration_index__";
const INTEGRATION_STORE = "nova-integrations.json";

type StrongholdStore = {
  insert: (key: string, value: number[]) => Promise<void>;
  get: (key: string) => Promise<Uint8Array | null>;
  remove: (key: string) => Promise<Uint8Array | null>;
};

type StrongholdSession = {
  stronghold: Stronghold;
  store: StrongholdStore;
};

// Cached session — reused across all vault operations to avoid
// re-initializing the Stronghold instance on every call.
let cachedSession: StrongholdSession | null = null;
let sessionInitPromise: Promise<StrongholdSession> | null = null;

function encodeJson(value: unknown): number[] {
  const encoded = new TextEncoder().encode(JSON.stringify(value));
  return Array.from(encoded);
}

function decodeJson<T>(value: Uint8Array | number[] | null, fallback: T): T {
  if (!value || value.length === 0) return fallback;
  try {
    const decoded = new TextDecoder().decode(
      value instanceof Uint8Array ? value : new Uint8Array(value)
    );
    return JSON.parse(decoded) as T;
  } catch (err) {
    console.warn("[vault] decodeJson failed:", err);
    return fallback;
  }
}

function generatePassword(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function getVaultPassword(): Promise<string> {
  const store = await Store.load(INTEGRATION_STORE);
  let password = (await store.get(VAULT_PASSWORD_KEY)) as string | null;
  if (!password) {
    password = generatePassword();
    await store.set(VAULT_PASSWORD_KEY, password);
    await store.save();
  }
  return password;
}

async function initStrongholdSession(): Promise<StrongholdSession> {
  const vaultDir = await appDataDir();
  const vaultPath = await join(vaultDir, VAULT_FILE);
  const password = await getVaultPassword();
  const stronghold = await Stronghold.load(vaultPath, password);
  let client;
  try {
    client = await stronghold.loadClient(VAULT_CLIENT);
  } catch (err) {
    console.info("[vault] creating new stronghold client (first use or migration):", err);
    client = await stronghold.createClient(VAULT_CLIENT);
  }
  const store = client.getStore() as StrongholdStore;
  return { stronghold, store };
}

async function getStrongholdSession(): Promise<StrongholdSession> {
  if (cachedSession) return cachedSession;
  // Deduplicate concurrent init calls
  if (!sessionInitPromise) {
    sessionInitPromise = initStrongholdSession().then((session) => {
      cachedSession = session;
      sessionInitPromise = null;
      return session;
    }).catch((err) => {
      sessionInitPromise = null;
      throw err;
    });
  }
  return sessionInitPromise;
}

async function loadIndex(store: StrongholdStore): Promise<string[]> {
  const value = await store.get(INDEX_KEY);
  return decodeJson<string[]>(value, []);
}

async function saveIndex(store: StrongholdStore, stronghold: Stronghold, providers: string[]) {
  await store.insert(INDEX_KEY, encodeJson(providers));
  await stronghold.save();
}

export async function saveIntegrationSecret<T extends { provider: string }>(
  provider: string,
  payload: T
): Promise<void> {
  const { stronghold, store } = await getStrongholdSession();
  await store.insert(`integration:${provider}`, encodeJson(payload));
  const index = await loadIndex(store);
  if (!index.includes(provider)) {
    index.push(provider);
    await saveIndex(store, stronghold, index);
  } else {
    await stronghold.save();
  }
}

export async function loadIntegrationSecret<T>(provider: string): Promise<T | null> {
  const { store } = await getStrongholdSession();
  const value = await store.get(`integration:${provider}`);
  return decodeJson<T | null>(value, null);
}

export async function removeIntegrationSecret(provider: string): Promise<void> {
  const { stronghold, store } = await getStrongholdSession();
  await store.remove(`integration:${provider}`);
  const index = await loadIndex(store);
  const next = index.filter((id) => id !== provider);
  await saveIndex(store, stronghold, next);
}

export async function listIntegrationSecrets<T>(): Promise<T[]> {
  const { store } = await getStrongholdSession();
  const index = await loadIndex(store);
  const results: T[] = [];
  for (const provider of index) {
    const value = await store.get(`integration:${provider}`);
    const parsed = decodeJson<T | null>(value, null);
    if (parsed) {
      results.push(parsed);
    }
  }
  return results;
}
