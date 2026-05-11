export type DesktopHandoffAction = "open" | "preview" | "browser";

export type DesktopHandoff = {
  path?: string;
  url?: string;
  action: DesktopHandoffAction | string;
  looksLikeFile?: boolean;
};

export type DesktopHandoffResolution =
  | { type: "ignore" }
  | { type: "open_browser_url"; url: string }
  | { type: "open_workspace_in_browser"; path: string }
  | { type: "preview_workspace_path"; path: string }
  | { type: "open_workspace_file"; path: string }
  | { type: "open_workspace_folder"; path: string }
  | { type: "show_workspace_path"; path: string; looksLikeFile: boolean };

export function workspacePathLooksLikeFile(path: string): boolean {
  const normalized = path.split("\\").join("/");
  const name = normalized.split("/").filter(Boolean).pop() ?? normalized;
  return name.includes(".");
}

export function resolveDesktopHandoff(handoff: unknown): DesktopHandoffResolution {
  if (!handoff || typeof handoff !== "object") {
    return { type: "ignore" };
  }

  const candidate = handoff as {
    action?: unknown;
    path?: unknown;
    url?: unknown;
    looksLikeFile?: unknown;
  };
  if (typeof candidate.action !== "string") {
    return { type: "ignore" };
  }

  if (
    candidate.action === "browser" &&
    typeof candidate.url === "string" &&
    candidate.url.trim()
  ) {
    return { type: "open_browser_url", url: candidate.url };
  }

  if (typeof candidate.path !== "string") {
    return { type: "ignore" };
  }

  const looksLikeFile =
    typeof candidate.looksLikeFile === "boolean"
      ? candidate.looksLikeFile
      : workspacePathLooksLikeFile(candidate.path);

  if (candidate.action === "browser") {
    return { type: "open_workspace_in_browser", path: candidate.path };
  }
  if (candidate.action === "preview") {
    return { type: "preview_workspace_path", path: candidate.path };
  }
  if (candidate.action === "open") {
    return looksLikeFile
      ? { type: "open_workspace_file", path: candidate.path }
      : { type: "open_workspace_folder", path: candidate.path };
  }

  return { type: "show_workspace_path", path: candidate.path, looksLikeFile };
}
