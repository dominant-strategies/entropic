import { Store } from "@tauri-apps/plugin-store";

export type AgentProfile = {
  name: string;
  avatarDataUrl?: string;
};

const DEFAULT_PROFILE_NAME = "Entropic";

const DEFAULT_PROFILE: AgentProfile = {
  name: DEFAULT_PROFILE_NAME,
};

const MARKDOWN_ONLY_TOKEN = /^[*_`~]+$/;

function stripSingleMarkdownWrapper(value: string): string {
  const wrappers: Array<[string, string]> = [
    ["**", "**"],
    ["__", "__"],
    ["*", "*"],
    ["_", "_"],
    ["`", "`"],
  ];
  for (const [left, right] of wrappers) {
    if (value.startsWith(left) && value.endsWith(right) && value.length > left.length + right.length) {
      return value.slice(left.length, value.length - right.length).trim();
    }
  }
  return value;
}

export function sanitizeProfileName(raw: unknown, fallback = DEFAULT_PROFILE_NAME): string {
  const input = typeof raw === "string" ? raw.trim() : "";
  if (!input) return fallback;

  let value = input;
  for (let i = 0; i < 4; i++) {
    const next = stripSingleMarkdownWrapper(value);
    if (next === value) break;
    value = next;
  }

  value = value
    .replace(/^[-+*_`~:\s]+/, "")
    .replace(/[-+*_`~:\s]+$/, "")
    .split(/\s+/)
    .filter((token) => token && !MARKDOWN_ONLY_TOKEN.test(token))
    .join(" ")
    .trim();

  return value || fallback;
}

export function isRenderableAvatarDataUrl(raw: unknown): raw is string {
  if (typeof raw !== "string") return false;
  const value = raw.trim();
  if (!value) return false;
  return /^data:image\//i.test(value) || /^https?:\/\//i.test(value) || /^blob:/i.test(value);
}

export function getProfileInitials(name: string, maxChars = 2): string {
  const clean = sanitizeProfileName(name);
  const parts = clean.split(/\s+/).filter(Boolean);
  const joined = parts.length >= 2 ? `${parts[0][0] ?? ""}${parts[1][0] ?? ""}` : clean.slice(0, maxChars);
  const initials = joined.replace(/[^A-Za-z0-9]/g, "").slice(0, maxChars).toUpperCase();
  if (initials) return initials;
  return DEFAULT_PROFILE_NAME.slice(0, maxChars).toUpperCase();
}

let storePromise: Promise<Store> | null = null;

async function getStore(): Promise<Store> {
  if (!storePromise) {
    storePromise = Store.load("entropic-profile.json");
  }
  return storePromise;
}

export async function loadProfile(): Promise<AgentProfile> {
  const store = await getStore();
  const raw = await store.get("profile");
  if (!raw || typeof raw !== "object") return DEFAULT_PROFILE;

  const record = raw as Record<string, unknown>;
  const name = sanitizeProfileName(record.name, DEFAULT_PROFILE.name);
  const avatarDataUrl = isRenderableAvatarDataUrl(record.avatarDataUrl)
    ? record.avatarDataUrl.trim()
    : undefined;

  return { name, avatarDataUrl };
}

export async function saveProfile(profile: AgentProfile): Promise<void> {
  const store = await getStore();
  const normalized: AgentProfile = {
    name: sanitizeProfileName(profile.name, DEFAULT_PROFILE.name),
    avatarDataUrl: isRenderableAvatarDataUrl(profile.avatarDataUrl)
      ? profile.avatarDataUrl.trim()
      : undefined,
  };
  await store.set("profile", normalized);
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
  userName?: string;
  agentName?: string;
  soul: string;
  completedAt?: string;
};

export async function saveOnboardingData(data: OnboardingData): Promise<void> {
  const store = await getStore();
  await store.set("onboardingData", data);
  await store.save();
}

export async function loadOnboardingData(): Promise<OnboardingData | null> {
  try {
    const store = await getStore();
    const raw = await store.get("onboardingData");
    if (!raw || typeof raw !== "object") return null;
    const data = raw as Record<string, unknown>;
    const soul = typeof data.soul === "string" ? data.soul : "";
    if (!soul.trim()) return null;
    return {
      soul,
      userName: typeof data.userName === "string" ? data.userName : undefined,
      agentName: typeof data.agentName === "string" ? data.agentName : undefined,
      completedAt: typeof data.completedAt === "string" ? data.completedAt : undefined,
    };
  } catch {
    return null;
  }
}

export async function setOnboardingComplete(complete: boolean): Promise<void> {
  const store = await getStore();
  await store.set("onboardingComplete", complete);
  await store.save();
}
