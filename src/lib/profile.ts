import { Store } from "@tauri-apps/plugin-store";

export type AgentProfile = {
  name: string;
  avatarDataUrl?: string;
};

const DEFAULT_PROFILE: AgentProfile = {
  name: "Nova",
};

let storePromise: Promise<Store> | null = null;

async function getStore(): Promise<Store> {
  if (!storePromise) {
    storePromise = Store.load("nova-profile.json");
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

export async function isOnboardingComplete(): Promise<boolean> {
  try {
    const store = await getStore();
    const complete = await store.get("onboardingComplete");
    console.log("[profile] onboardingComplete value:", complete, "type:", typeof complete);
    return complete === true;
  } catch (error) {
    console.error("[profile] Failed to check onboarding status:", error);
    // If we can't check, assume not complete
    return false;
  }
}

export async function resetOnboarding(): Promise<void> {
  const store = await getStore();
  await store.delete("onboardingComplete");
  await store.delete("profile");
  await store.delete("onboardingData");
  await store.save();
}

export type OnboardingData = {
  userName: string;
  agentName: string;
  soul: string;
};

export async function saveOnboardingData(data: OnboardingData): Promise<void> {
  const store = await getStore();
  await store.set("onboardingData", data);
  await store.save();
}

export async function loadOnboardingData(): Promise<OnboardingData | null> {
  try {
    const store = await getStore();
    const data = await store.get("onboardingData");
    if (!data || typeof data !== "object") return null;
    return data as OnboardingData;
  } catch {
    return null;
  }
}

export async function setOnboardingComplete(complete: boolean): Promise<void> {
  const store = await getStore();
  await store.set("onboardingComplete", complete);
  await store.save();
}
