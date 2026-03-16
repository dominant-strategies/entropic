type BuildProfile = "local" | "managed";

function normalizeBuildProfile(rawValue: unknown): BuildProfile {
  if (typeof rawValue === "string" && rawValue.trim().toLowerCase() === "managed") {
    return "managed";
  }
  return "local";
}

function trimUrl(rawValue: unknown): string {
  if (typeof rawValue !== "string") {
    return "";
  }
  return rawValue.trim().replace(/\/+$/, "");
}

export const ENTROPIC_BUILD_PROFILE = normalizeBuildProfile(
  import.meta.env.VITE_ENTROPIC_BUILD_PROFILE,
);

export const managedBuild = ENTROPIC_BUILD_PROFILE === "managed";
export const localBuild = ENTROPIC_BUILD_PROFILE === "local";
export const hostedFeaturesEnabled = managedBuild;
export const defaultUseLocalKeys = !hostedFeaturesEnabled;

const configuredSiteUrl = trimUrl(
  (import.meta as ImportMeta & { env?: Record<string, unknown> }).env?.VITE_ENTROPIC_SITE_URL,
);

export const entropicSiteUrl = hostedFeaturesEnabled
  ? configuredSiteUrl || "https://entropic.qu.ai"
  : "";

export function entropicSitePath(path: string): string {
  if (!entropicSiteUrl) {
    return "";
  }
  if (!path.startsWith("/")) {
    return `${entropicSiteUrl}/${path}`;
  }
  return `${entropicSiteUrl}${path}`;
}

export const managedApiUrl = hostedFeaturesEnabled
  ? String(
      (import.meta as ImportMeta & { env?: Record<string, unknown> }).env?.VITE_API_URL || "",
    ).trim() || ((import.meta as ImportMeta).env?.DEV ? "/api" : "")
  : "";

export const updaterEnabled =
  hostedFeaturesEnabled && !Boolean((import.meta as ImportMeta).env?.DEV);
