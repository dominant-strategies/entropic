import { Store } from "@tauri-apps/plugin-store";

export type AgentProfile = {
  name: string;
  avatarDataUrl?: string;
};

const DEFAULT_PROFILE: AgentProfile = {
  name: "Zara",
};

let storePromise: Promise<Store> | null = null;

async function getStore(): Promise<Store> {
  if (!storePromise) {
    storePromise = Store.load("zara-profile.json");
  }
  return storePromise;
}

export async function loadProfile(): Promise<AgentProfile> {
  const store = await getStore();
  const raw = await store.get("profile");
  if (!raw || typeof raw !== "object") return DEFAULT_PROFILE;

  const record = raw as Record<string, unknown>;
  const name = typeof record.name === "string" && record.name.trim()
    ? record.name
    : DEFAULT_PROFILE.name;
  const avatarDataUrl =
    typeof record.avatarDataUrl === "string" ? record.avatarDataUrl : undefined;

  return { name, avatarDataUrl };
}

export async function saveProfile(profile: AgentProfile): Promise<void> {
  const store = await getStore();
  await store.set("profile", profile);
  await store.save();
}
