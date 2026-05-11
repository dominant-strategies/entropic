import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function usage() {
  console.log(`Usage: node scripts/verify-voice-manual-log.mjs [--log <path>] [--since <unix-seconds>]

Checks ~/entropic-runtime.log for the manual Linux real-mic validation gates.
Voice logs intentionally omit raw transcripts, so new_chat_task checks are count-based.`);
}

const args = process.argv.slice(2);
let logPath = path.join(os.homedir(), "entropic-runtime.log");
let since = 0;

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === "--help" || arg === "-h") {
    usage();
    process.exit(0);
  }
  if (arg === "--log") {
    const value = args[i + 1];
    if (!value) throw new Error("--log requires a path");
    logPath = value;
    i += 1;
    continue;
  }
  if (arg === "--since") {
    const value = Number(args[i + 1]);
    if (!Number.isFinite(value)) throw new Error("--since requires a unix timestamp");
    since = value;
    i += 1;
    continue;
  }
  throw new Error(`Unknown argument: ${arg}`);
}

function parseEvents(text) {
  const events = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\[(\d+)\]\s+\[client\]\s+([^\s]+)(?:\s+(.*))?$/);
    if (!match) continue;
    const ts = Number(match[1]);
    if (!Number.isFinite(ts) || ts < since) continue;
    let payload = {};
    if (match[3]?.startsWith("{")) {
      try {
        payload = JSON.parse(match[3]);
      } catch {
        payload = {};
      }
    }
    events.push({ index: events.length, ts, name: match[2], payload, line });
  }
  return events;
}

function eventMatches(event, name, predicate = () => true) {
  return event.name === name && predicate(event.payload, event);
}

function findEvent(events, name, predicate = () => true) {
  return events.find((event) => eventMatches(event, name, predicate)) ?? null;
}

function isAfter(event, previous) {
  return event.ts > previous.ts || (event.ts === previous.ts && event.index > previous.index);
}

function hasEvent(events, name, predicate = () => true) {
  return findEvent(events, name, predicate) !== null;
}

function hasEventAfter(events, previous, name, predicate = () => true) {
  if (!previous) return false;
  return events.some((event) => isAfter(event, previous) && eventMatches(event, name, predicate));
}

function countEvents(events, name, predicate = () => true) {
  return events.filter((event) => event.name === name && predicate(event.payload, event)).length;
}

function printResult(label, passed, detail) {
  const marker = passed ? "PASS" : "FAIL";
  console.log(`${marker} ${label}${detail ? ` - ${detail}` : ""}`);
}

if (!fs.existsSync(logPath)) {
  throw new Error(`Client log not found: ${logPath}`);
}

const events = parseEvents(fs.readFileSync(logPath, "utf8"));
const officeConfirmEvent = findEvent(
  events,
  "voice.action.confirmation_required",
  (payload) => payload.type === "open_workspace_file" && payload.path === "sales-plan.xlsx",
);
const officeDispatchEvent = officeConfirmEvent
  ? findEvent(
      events.filter((event) => isAfter(event, officeConfirmEvent)),
      "voice.action.dispatch",
      (payload) => payload.type === "open_workspace_file" && payload.path === "sales-plan.xlsx",
    )
  : null;
const officeConfirm = officeConfirmEvent !== null;
const officeDispatch = officeDispatchEvent !== null;
const officeReady = hasEventAfter(
  events,
  officeDispatchEvent,
  "office.open.ready",
  (payload) => payload.appKind === "sheets" && payload.path === "sales-plan.xlsx",
);
const browserConfirmEvent = findEvent(
  events,
  "voice.action.confirmation_required",
  (payload) => payload.type === "open_browser_url" && typeof payload.url === "string",
);
const browserDispatch = hasEventAfter(
  events,
  browserConfirmEvent,
  "voice.action.dispatch",
  (payload) => payload.type === "open_browser_url" && typeof payload.url === "string",
);
const browserConfirm = browserConfirmEvent !== null;
const newChatConfirmations = countEvents(
  events,
  "voice.action.confirmation_required",
  (payload) => payload.type === "new_chat_task",
);
const firstNewChatConfirmation = findEvent(
  events,
  "voice.action.confirmation_required",
  (payload) => payload.type === "new_chat_task",
);
const newChatDispatches = firstNewChatConfirmation
  ? countEvents(
      events.filter((event) => isAfter(event, firstNewChatConfirmation)),
      "voice.action.dispatch",
      (payload) => payload.type === "new_chat_task" && payload.autoSubmit === true,
    )
  : 0;
const oldNewChatDispatches = countEvents(
  events,
  "voice.action.dispatch",
  (payload) => payload.type === "new_chat_task" && payload.autoSubmit === true,
);

const checks = [
  {
    label: "Linux real-mic Office open confirmation",
    passed: officeConfirm,
    detail: "expected voice.action.confirmation_required open_workspace_file sales-plan.xlsx",
  },
  {
    label: "Linux real-mic Office open dispatch",
    passed: officeDispatch,
    detail: "expected voice.action.dispatch open_workspace_file sales-plan.xlsx",
  },
  {
    label: "Linux real-mic Office window ready",
    passed: officeReady,
    detail: "expected office.open.ready sheets sales-plan.xlsx",
  },
  {
    label: "Linux real-mic browser confirmation",
    passed: browserConfirm,
    detail: "expected voice.action.confirmation_required open_browser_url",
  },
  {
    label: "Linux real-mic browser dispatch",
    passed: browserDispatch,
    detail: "expected voice.action.dispatch open_browser_url",
  },
  {
    label: "Linux real-mic integration task confirmation",
    passed: newChatConfirmations >= 1,
    detail: `observed ${newChatConfirmations} confirmed new_chat_task event(s)`,
  },
  {
    label: "Linux risky-action confirmation coverage",
    passed: newChatConfirmations >= 2,
    detail: "expected separate integration-task and risky-action confirmations",
  },
  {
    label: "Linux real-mic integration task dispatch",
    passed: newChatDispatches >= 1,
    detail: `observed ${newChatDispatches} dispatched auto-submit new_chat_task event(s) after confirmation (${oldNewChatDispatches} total)`,
  },
];

for (const check of checks) {
  printResult(check.label, check.passed, check.detail);
}

const failed = checks.filter((check) => !check.passed);
if (failed.length > 0) {
  console.error(`\n${failed.length} manual voice validation check(s) failed for ${logPath}.`);
  process.exitCode = 1;
} else {
  console.log(`\nAll manual voice validation log checks passed for ${logPath}.`);
}
