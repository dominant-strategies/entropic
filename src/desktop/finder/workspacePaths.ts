const CONTAINER_LOCAL_BROWSER_BASE = "http://container.localhost:19791";
const HTML_EXTS = new Set(["html", "htm"]);
const ONLYOFFICE_EXTS = new Set(["docx", "xlsx", "pptx"]);

export function workspacePathName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] || "Workspace";
}

export function workspacePathParent(path: string): string {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

export function workspacePathExtension(path: string): string {
  return workspacePathName(path).split(".").pop()?.toLowerCase() || "";
}

export function workspaceBrowserUrl(path: string): string {
  const normalized = path
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");
  return normalized
    ? `${CONTAINER_LOCAL_BROWSER_BASE}/__workspace__/${normalized}`
    : `${CONTAINER_LOCAL_BROWSER_BASE}/__workspace__/`;
}

export function workspaceFileCanOpenInBrowser(path: string): boolean {
  return HTML_EXTS.has(workspacePathExtension(path));
}

export function workspaceFileUsesOnlyOffice(path: string): boolean {
  return ONLYOFFICE_EXTS.has(workspacePathExtension(path));
}

export function workspaceFileIsHtml(path: string): boolean {
  return HTML_EXTS.has(workspacePathExtension(path));
}
