import { invoke } from "@tauri-apps/api/core";

const CONTAINER_LOCAL_BROWSER_BASE = "http://container.localhost:19791";
const ONLYOFFICE_DESKTOP_BASE = "http://127.0.0.1:19796";
const ONLYOFFICE_BROWSER_EXTS = new Set(["docx", "xlsx", "pptx"]);
const SPREADSHEET_BROWSER_EXTS = new Set(["xls", "csv"]);
const LOCAL_PREVIEW_HOSTS = new Set([
  "container.localhost",
  "runtime.localhost",
  "localhost",
  "127.0.0.1",
]);

export function workspaceBrowserUrl(path: string): string {
  const ext = path.split("/").filter(Boolean).pop()?.split(".").pop()?.toLowerCase() || "";
  if (ONLYOFFICE_BROWSER_EXTS.has(ext)) {
    return `${ONLYOFFICE_DESKTOP_BASE}/__onlyoffice__/open?path=${encodeURIComponent(path)}`;
  }
  if (SPREADSHEET_BROWSER_EXTS.has(ext)) {
    return `${CONTAINER_LOCAL_BROWSER_BASE}/__workspace_editor__/spreadsheet?path=${encodeURIComponent(path)}`;
  }
  const normalized = path
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");
  return normalized
    ? `${CONTAINER_LOCAL_BROWSER_BASE}/__workspace__/${normalized}`
    : `${CONTAINER_LOCAL_BROWSER_BASE}/__workspace__/`;
}

export function isTrustedLocalPreviewUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }
    const host = parsed.hostname.toLowerCase();
    if (LOCAL_PREVIEW_HOSTS.has(host)) {
      return true;
    }
    return /^p\d+\.localhost$/.test(host);
  } catch {
    return false;
  }
}

export type EmbeddedPreviewSyncRequest = {
  url: string;
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
};

export async function syncEmbeddedPreviewWebview(
  request: EmbeddedPreviewSyncRequest,
): Promise<string> {
  return invoke<string>("sync_embedded_preview_webview", { request });
}

export async function hideEmbeddedPreviewWebview(): Promise<void> {
  await invoke("hide_embedded_preview_webview");
}

export async function reloadEmbeddedPreview(): Promise<void> {
  await invoke("embedded_preview_reload");
}

export async function goEmbeddedPreviewBack(): Promise<void> {
  await invoke("embedded_preview_back");
}

export async function goEmbeddedPreviewForward(): Promise<void> {
  await invoke("embedded_preview_forward");
}
