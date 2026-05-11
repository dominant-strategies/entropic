import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = process.cwd();
const verifierPath = path.join(repoRoot, "scripts/verify-voice-manual-log.mjs");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "entropic-voice-log-"));

function line(ts, event, payload) {
  return `[${ts}] [client] ${event} ${JSON.stringify(payload)}`;
}

function writeLog(name, lines) {
  const logPath = path.join(tmpDir, name);
  fs.writeFileSync(logPath, `${lines.join("\n")}\n`);
  return logPath;
}

function runVerifier(logPath, since = 0) {
  return spawnSync(process.execPath, [verifierPath, "--log", logPath, "--since", String(since)], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

try {
  const passingLog = writeLog("passing.log", [
    line(100, "voice.action.confirmation_required", {
      type: "open_workspace_file",
      path: "sales-plan.xlsx",
    }),
    line(101, "voice.action.dispatch", {
      type: "open_workspace_file",
      path: "sales-plan.xlsx",
    }),
    line(102, "office.open.ready", {
      appKind: "sheets",
      path: "sales-plan.xlsx",
    }),
    line(103, "voice.action.confirmation_required", {
      type: "open_browser_url",
      url: "https://github.com",
    }),
    line(104, "voice.action.dispatch", {
      type: "open_browser_url",
      url: "https://github.com",
    }),
    line(105, "voice.action.confirmation_required", {
      type: "new_chat_task",
      autoSubmit: true,
    }),
    line(106, "voice.action.dispatch", {
      type: "new_chat_task",
      autoSubmit: true,
    }),
    line(107, "voice.action.confirmation_required", {
      type: "new_chat_task",
      autoSubmit: true,
    }),
  ]);
  const passing = runVerifier(passingLog, 100);
  assert.equal(passing.status, 0, passing.stderr || passing.stdout);

  const staleOfficeLog = writeLog("stale-office.log", [
    line(100, "office.open.ready", {
      appKind: "sheets",
      path: "sales-plan.xlsx",
    }),
    line(101, "voice.action.confirmation_required", {
      type: "open_workspace_file",
      path: "sales-plan.xlsx",
    }),
    line(102, "voice.action.dispatch", {
      type: "open_workspace_file",
      path: "sales-plan.xlsx",
    }),
    line(103, "voice.action.confirmation_required", {
      type: "open_browser_url",
      url: "https://github.com",
    }),
    line(104, "voice.action.dispatch", {
      type: "open_browser_url",
      url: "https://github.com",
    }),
    line(105, "voice.action.confirmation_required", {
      type: "new_chat_task",
      autoSubmit: true,
    }),
    line(106, "voice.action.dispatch", {
      type: "new_chat_task",
      autoSubmit: true,
    }),
    line(107, "voice.action.confirmation_required", {
      type: "new_chat_task",
      autoSubmit: true,
    }),
  ]);
  const staleOffice = runVerifier(staleOfficeLog, 100);
  assert.equal(staleOffice.status, 1, staleOffice.stdout);

  const filtered = runVerifier(passingLog, 103);
  assert.equal(filtered.status, 1, filtered.stdout);

  console.log("voice manual log verifier fixture tests passed");
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
