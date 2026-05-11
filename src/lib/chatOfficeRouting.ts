const QUOTED_OFFICE_FILE_RE = /[`"']([^`"']+\.(?:xlsx|docx|pptx))[`"']/i;
const OFFICE_FILE_RE = /((?:\/data\/workspace\/)?[A-Za-z0-9._/-]+\.(?:xlsx|docx|pptx))/i;
const OFFICE_KIND_RE =
  /\b(?:excel|workbook|spreadsheet|sheet|sheets|docx|word document|powerpoint|presentation|slides?|pptx)\b/i;
const OFFICE_ACTION_RE =
  /\b(?:create|generate|make|build|open|view|edit|save|write|format|download)\b/i;
const LOCAL_WORKSPACE_RE =
  /\b(?:entropic workspace|workspace|desktop|local file|locally|\/data\/workspace)\b/i;
const EXTERNAL_DOC_RE =
  /\b(?:google sheets|google docs|google drive|onedrive|sharepoint|microsoft 365|office 365)\b/i;

function explicitOfficeFileName(message: string): string | null {
  const match = QUOTED_OFFICE_FILE_RE.exec(message) ?? OFFICE_FILE_RE.exec(message);
  return match?.[1]?.trim().replace(/^\/data\/workspace\//, "") || null;
}

export function extractWorkspaceOfficeFileName(message: string): string | null {
  return explicitOfficeFileName(message);
}

export function workspaceOfficeRequestWantsDesktopOpen(message: string): boolean {
  return /\b(?:open|view|show|desktop)\b/i.test(message);
}

export function shouldRouteWorkspaceOfficeRequest(message: string): boolean {
  const trimmed = message.trim();
  if (!trimmed) return false;
  const hasOfficeTarget = OFFICE_KIND_RE.test(trimmed) || explicitOfficeFileName(trimmed) !== null;
  if (!hasOfficeTarget || !OFFICE_ACTION_RE.test(trimmed)) {
    return false;
  }
  if (EXTERNAL_DOC_RE.test(trimmed) && !LOCAL_WORKSPACE_RE.test(trimmed)) {
    return false;
  }
  return LOCAL_WORKSPACE_RE.test(trimmed) || explicitOfficeFileName(trimmed) !== null;
}

export function formatWorkspaceOfficeRoutingPrompt(message: string): string {
  const fileName = explicitOfficeFileName(message);
  const targetLine = fileName
    ? `Detected local Office file target: /data/workspace/${fileName}.`
    : "Detected a local Entropic workspace Office request.";

  return [
    "Use the local Entropic workspace Office workflow for this request.",
    targetLine,
    "Use the gateway/container execution environment with workdir `/data/workspace` for local file generation. Prefer Python libraries such as `openpyxl`, `python-docx`, or `python-pptx` for formatted Office artifacts; use `entropic-office api inspect-aio` and `entropic-office api apply-aio` for structured edits to existing `.xlsx`, `.docx`, and `.pptx` files.",
    "For spreadsheet requests that mention formulas, write actual Excel formula cells such as `=D2*E2` and `=SUM(H2:H13)`, not precomputed static values.",
    "Do not use Google Workspace, Google Sheets, Google Docs, Google Drive, OneDrive, Microsoft Graph, Teams, or Outlook tools for a local workspace Office file unless the original user request explicitly asks for those external services.",
    "In the same successful `exec` command that creates or edits a `.xlsx`, `.docx`, or `.pptx` file, also run `entropic-office desktop open /data/workspace/<file>` so Entropic can validate and open it on the desktop. Do not leave the desktop-open command for a later assistant turn.",
    "Do not stop after saying you will create or open the file. Actually create/edit the workspace file, request the desktop open, then report the workspace path and any real tool error.",
    `Original user request: ${message.trim()}`,
  ].join("\n");
}
