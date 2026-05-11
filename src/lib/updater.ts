import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import { updaterEnabled } from "./buildProfile";
import { clientLog } from "./clientLog";

export type UpdaterCheckSource = "startup" | "manual" | "background";

export type UpdaterStatus =
  | {
      kind: "disabled";
      checkedAt: number | null;
      currentVersion: string | null;
      source: UpdaterCheckSource;
    }
  | {
      kind: "checking";
      checkedAt: number | null;
      currentVersion: string | null;
      source: UpdaterCheckSource;
    }
  | {
      kind: "up-to-date";
      checkedAt: number;
      currentVersion: string;
      source: UpdaterCheckSource;
    }
  | {
      kind: "available";
      checkedAt: number;
      currentVersion: string;
      targetVersion: string;
      source: UpdaterCheckSource;
    }
  | {
      kind: "installing";
      checkedAt: number;
      currentVersion: string;
      targetVersion: string;
      source: UpdaterCheckSource;
    }
  | {
      kind: "installed";
      checkedAt: number;
      currentVersion: string;
      targetVersion: string;
      source: UpdaterCheckSource;
    }
  | {
      kind: "error";
      checkedAt: number;
      currentVersion: string | null;
      error: string;
      source: UpdaterCheckSource;
    };

type CheckForUpdatesOptions = {
  source?: UpdaterCheckSource;
  autoInstall?: boolean;
};

const UPDATER_STATUS_STORAGE_KEY = "entropic.updater.status";
const UPDATER_STATUS_EVENT = "entropic-updater-status";

let inFlightCheck: Promise<UpdaterStatus> | null = null;

function compactError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function writeUpdaterStatus(status: UpdaterStatus): UpdaterStatus {
  try {
    window.localStorage.setItem(UPDATER_STATUS_STORAGE_KEY, JSON.stringify(status));
  } catch {
    // Updater status is best-effort only.
  }
  window.dispatchEvent(new CustomEvent<UpdaterStatus>(UPDATER_STATUS_EVENT, { detail: status }));
  return status;
}

export function readUpdaterStatus(): UpdaterStatus | null {
  try {
    const raw = window.localStorage.getItem(UPDATER_STATUS_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as UpdaterStatus) : null;
  } catch {
    return null;
  }
}

export function updaterStatusEventName(): string {
  return UPDATER_STATUS_EVENT;
}

export async function checkForAppUpdates(
  options: CheckForUpdatesOptions = {},
): Promise<UpdaterStatus> {
  const source = options.source ?? "manual";
  const autoInstall = options.autoInstall ?? false;

  if (!updaterEnabled) {
    return writeUpdaterStatus({
      kind: "disabled",
      checkedAt: null,
      currentVersion: null,
      source,
    });
  }

  if (inFlightCheck) {
    return inFlightCheck;
  }

  inFlightCheck = (async () => {
    let currentVersion: string | null = null;
    try {
      currentVersion = await getVersion();
      clientLog("app.updater.check", { currentVersion, source });
      writeUpdaterStatus({
        kind: "checking",
        checkedAt: null,
        currentVersion,
        source,
      });

      const update = await check();
      if (!update) {
        clientLog("app.updater.no_update", { currentVersion, source });
        return writeUpdaterStatus({
          kind: "up-to-date",
          checkedAt: Date.now(),
          currentVersion,
          source,
        });
      }

      const targetVersion = update.version;
      clientLog("app.updater.available", { currentVersion, targetVersion, source });

      if (currentVersion === targetVersion) {
        clientLog("app.updater.loop_prevented", { currentVersion, targetVersion, source });
        return writeUpdaterStatus({
          kind: "up-to-date",
          checkedAt: Date.now(),
          currentVersion,
          source,
        });
      }

      const availableStatus = writeUpdaterStatus({
        kind: "available",
        checkedAt: Date.now(),
        currentVersion,
        targetVersion,
        source,
      });

      if (!autoInstall) {
        return availableStatus;
      }

      clientLog("app.updater.installing", { currentVersion, targetVersion, source });
      writeUpdaterStatus({
        kind: "installing",
        checkedAt: Date.now(),
        currentVersion,
        targetVersion,
        source,
      });

      await update.downloadAndInstall();

      writeUpdaterStatus({
        kind: "installed",
        checkedAt: Date.now(),
        currentVersion,
        targetVersion,
        source,
      });
      clientLog("app.updater.relaunch", { targetVersion, source });
      await relaunch();

      return {
        kind: "installed",
        checkedAt: Date.now(),
        currentVersion,
        targetVersion,
        source,
      };
    } catch (error) {
      const message = compactError(error);
      clientLog("app.updater.failed", { currentVersion, error: message, source });
      return writeUpdaterStatus({
        kind: "error",
        checkedAt: Date.now(),
        currentVersion,
        error: message,
        source,
      });
    } finally {
      inFlightCheck = null;
    }
  })();

  return inFlightCheck;
}
