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
  formatVoiceTaskPrompt,
  listeningMessage,
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
sameJson(resolveVoiceAction('open "hello.md" that is on my desktop'), {
  type: "open_workspace_file",
  path: "Desktop/hello.md",
});
sameJson(resolveVoiceAction("open hello dot md on my desktop"), {
  type: "open_workspace_file",
  path: "Desktop/hello.md",
});
sameJson(resolveVoiceAction("open Desktop slash hello dot md on my desktop"), {
  type: "open_workspace_file",
  path: "Desktop/hello.md",
});
sameJson(resolveVoiceAction("focus Settings"), {
  type: "focus_window",
  window: "settings",
});
sameJson(resolveVoiceAction("show spreadsheet window"), {
  type: "focus_window",
  window: "sheets",
});
sameJson(resolveVoiceAction("Open this spreadsheet in Sheets"), {
  type: "focus_window",
  window: "sheets",
});
sameJson(resolveVoiceAction("open slides"), {
  type: "focus_window",
  window: "slides",
});
sameJson(resolveVoiceAction("open presentation"), {
  type: "new_chat_task",
  prompt: "open presentation",
});
sameJson(resolveVoiceAction("show presentation ideas"), {
  type: "new_chat_task",
  prompt: "show presentation ideas",
});
sameJson(resolveVoiceAction("Focus the email window"), {
  type: "focus_window",
  window: "browser",
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
sameJson(resolveVoiceAction("Create a presentation from this sales plan"), {
  type: "new_chat_task",
  prompt: "Create a presentation from this sales plan",
});
sameJson(resolveVoiceAction("Create an Asana task from this paragraph"), {
  type: "new_chat_task",
  prompt: "Create an Asana task from this paragraph",
});
sameJson(resolveVoiceAction("Use the Gmail integration to summarize my inbox"), {
  type: "new_chat_task",
  prompt: "Use the Gmail integration to summarize my inbox",
});
sameJson(resolveVoiceAction("Run the project tests"), {
  type: "new_chat_task",
  prompt: "Run the project tests",
});
sameJson(resolveVoiceAction("Open Settings"), {
  type: "focus_window",
  window: "settings",
});

assert.equal(listeningMessage(), "Listening.");

const formatted = formatVoiceTaskPrompt("summarize this sheet", {
  focusedWindow: "sheets",
  openWindows: ["finder", "sheets"],
  finderPath: "Reports",
  selectedWorkspaceFile: "Reports/sales-plan.xlsx",
  browser: { title: "Asana", url: "https://app.asana.com" },
  office: { appKind: "sheets", path: "Reports/sales-plan.xlsx", name: "sales-plan.xlsx" },
  integrations: "Asana connected",
});

assert.match(formatted, /^Spoken request: summarize this sheet/m);
assert.doesNotMatch(formatted, /^Voice mode:/m);
assert.match(formatted, /- Focused window: sheets/);
assert.match(formatted, /- Selected workspace file: Reports\/sales-plan\.xlsx/);

console.log("voice action parser tests passed");
