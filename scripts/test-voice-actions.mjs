import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

const repoRoot = process.cwd();
const sourcePath = path.join(repoRoot, "src/desktop/voice/voiceActions.ts");
const source = fs.readFileSync(sourcePath, "utf8");
const transpiled = ts.transpileModule(source, {
  fileName: sourcePath,
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
  },
});

const module = { exports: {} };
vm.runInNewContext(
  transpiled.outputText,
  {
    encodeURIComponent,
    exports: module.exports,
    module,
    require(specifier) {
      throw new Error(`Unexpected runtime import from voiceActions.ts: ${specifier}`);
    },
  },
  { filename: sourcePath },
);

const {
  chatTaskNeedsConfirmation,
  formatVoiceTaskPrompt,
  messageForMode,
  resolveVoiceAction,
} = module.exports;

function sameJson(actual, expected) {
  assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected);
}

sameJson(resolveVoiceAction("open sales-plan.xlsx"), {
  type: "open_workspace_file",
  path: "sales-plan.xlsx",
});
sameJson(resolveVoiceAction("open roadmap.pptx"), {
  type: "open_workspace_file",
  path: "roadmap.pptx",
});
sameJson(resolveVoiceAction("open sales plan dot xlsx"), {
  type: "open_workspace_file",
  path: "sales-plan.xlsx",
});
sameJson(resolveVoiceAction("open ui smoke xlsx"), {
  type: "open_workspace_file",
  path: "ui-smoke.xlsx",
});
sameJson(resolveVoiceAction("focus Settings"), {
  type: "focus_window",
  window: "settings",
});
sameJson(resolveVoiceAction("show spreadsheet"), {
  type: "focus_window",
  window: "sheets",
});
sameJson(resolveVoiceAction("Open browser and go to Gmail"), {
  type: "open_browser_url",
  url: "https://mail.google.com",
});
sameJson(resolveVoiceAction("Open browser and go to G mail"), {
  type: "open_browser_url",
  url: "https://mail.google.com",
});
sameJson(resolveVoiceAction("Open a new browser window and search for latest Asana docs"), {
  type: "open_browser_url",
  url: "https://www.google.com/search?q=latest%20Asana%20docs",
});
sameJson(resolveVoiceAction("summarize my inbox"), {
  type: "new_chat_task",
  prompt: "summarize my inbox",
});

assert.equal(messageForMode("dictation"), "Listening for dictation...");
assert.equal(messageForMode("command"), "Listening for a desktop command...");
assert.equal(messageForMode("conversation"), "Listening for a conversation turn...");

assert.equal(chatTaskNeedsConfirmation("Voice command: send Alan an Outlook email"), true);
assert.equal(chatTaskNeedsConfirmation("Voice command: move the Asana task to done"), true);
assert.equal(
  chatTaskNeedsConfirmation("Voice command: summarize this note\n- Integrations: Gmail connected"),
  false,
);

const formatted = formatVoiceTaskPrompt("summarize this sheet", "command", {
  focusedWindow: "sheets",
  openWindows: ["finder", "sheets"],
  finderPath: "Reports",
  selectedWorkspaceFile: "Reports/sales-plan.xlsx",
  browser: { title: "Asana", url: "https://app.asana.com" },
  office: { appKind: "sheets", path: "Reports/sales-plan.xlsx", name: "sales-plan.xlsx" },
  integrations: "Asana connected",
});

assert.match(formatted, /^Voice command: summarize this sheet/m);
assert.match(formatted, /^Voice mode: command/m);
assert.match(formatted, /- Focused window: sheets/);
assert.match(formatted, /- Selected workspace file: Reports\/sales-plan\.xlsx/);

console.log("voice action parser tests passed");
