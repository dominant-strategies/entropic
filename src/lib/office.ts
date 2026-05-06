import { invoke } from "@tauri-apps/api/core";

export type OnlyOfficeStatus = {
  running: boolean;
  ready: boolean;
  publicUrl: string;
  image: string;
  error?: string | null;
};

export type OnlyOfficeSession = {
  path: string;
  url: string;
  fileName: string;
  appKind: "sheets" | "docs" | "slides" | string;
  status: OnlyOfficeStatus;
};

export async function getOnlyOfficeStatus(): Promise<OnlyOfficeStatus> {
  return invoke<OnlyOfficeStatus>("get_onlyoffice_status");
}

export async function ensureOnlyOfficeReady(): Promise<OnlyOfficeStatus> {
  return invoke<OnlyOfficeStatus>("ensure_onlyoffice_ready");
}

export async function createOnlyOfficeSession(path: string): Promise<OnlyOfficeSession> {
  return invoke<OnlyOfficeSession>("create_onlyoffice_session", { path });
}
