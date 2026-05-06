import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

const repoRoot = process.cwd();
const sourcePath = path.join(repoRoot, "src/lib/chatOfficeRouting.ts");
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
    exports: module.exports,
    module,
    require(specifier) {
      throw new Error(`Unexpected runtime import from chatOfficeRouting.ts: ${specifier}`);
    },
  },
  { filename: sourcePath },
);

const {
  extractWorkspaceOfficeFileName,
  formatWorkspaceOfficeRoutingPrompt,
  shouldRouteWorkspaceOfficeRequest,
  workspaceOfficeRequestWantsDesktopOpen,
} = module.exports;

assert.equal(
  shouldRouteWorkspaceOfficeRequest(
    "Create an Excel workbook in the Entropic workspace called sales-plan.xlsx",
  ),
  true,
);
assert.equal(
  shouldRouteWorkspaceOfficeRequest("After creating it, open sales-plan.xlsx on the desktop"),
  true,
);
assert.equal(shouldRouteWorkspaceOfficeRequest("Create a Google Sheet for pipeline planning"), false);
assert.equal(shouldRouteWorkspaceOfficeRequest("Download the OneDrive file Document3.docx"), false);
assert.equal(shouldRouteWorkspaceOfficeRequest("Summarize my Gmail inbox"), false);
assert.equal(
  extractWorkspaceOfficeFileName("Create an Excel workbook called `sales-plan.xlsx`"),
  "sales-plan.xlsx",
);
assert.equal(workspaceOfficeRequestWantsDesktopOpen("open sales-plan.xlsx on the desktop"), true);
assert.equal(workspaceOfficeRequestWantsDesktopOpen("create sales-plan.xlsx"), false);

const prompt = formatWorkspaceOfficeRoutingPrompt(
  "Create an Excel workbook in the Entropic workspace called sales-plan.xlsx",
);
assert.match(prompt, /Use the local Entropic workspace Office workflow/);
assert.match(prompt, /\/data\/workspace\/sales-plan\.xlsx/);
assert.match(prompt, /Do not use Google Workspace/);
assert.match(prompt, /actual Excel formula cells/);
assert.match(prompt, /entropic-office desktop open/);
assert.match(prompt, /same successful `exec` command/);

console.log("chat Office routing tests passed");
