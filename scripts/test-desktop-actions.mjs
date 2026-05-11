import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

const repoRoot = process.cwd();
function loadTsModule(relativePath) {
  const sourcePath = path.join(repoRoot, relativePath);
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
      URL,
      exports: module.exports,
      module,
      require(specifier) {
        throw new Error(`Unexpected runtime import from ${relativePath}: ${specifier}`);
      },
    },
    { filename: sourcePath },
  );
  return module.exports;
}

const {
  sanitizeWorkspaceActionPath,
  validateBrowserActionUrl,
  validateDesktopAction,
} = loadTsModule("src/desktop/actions.ts");

const {
  resolveDesktopHandoff,
  workspacePathLooksLikeFile,
} = loadTsModule("src/desktop/handoff.ts");

function rejects(message, fn) {
  assert.throws(fn, { message });
}

function sameJson(actual, expected) {
  assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected);
}

assert.equal(sanitizeWorkspaceActionPath(" ./foo//bar/baz.txt "), "foo/bar/baz.txt");
assert.equal(sanitizeWorkspaceActionPath(""), "");
rejects("Workspace path must be relative to the Entropic workspace.", () =>
  sanitizeWorkspaceActionPath("/etc/passwd"),
);
rejects("Workspace path must be relative to the Entropic workspace.", () =>
  sanitizeWorkspaceActionPath("~/secrets"),
);
rejects("Workspace path must be relative to the Entropic workspace.", () =>
  sanitizeWorkspaceActionPath("C:/Users/test/file.txt"),
);
rejects("Workspace path cannot escape the workspace.", () =>
  sanitizeWorkspaceActionPath("../outside.txt"),
);
rejects("Workspace path contains invalid characters.", () =>
  sanitizeWorkspaceActionPath("safe\u0000bad"),
);

sameJson(
  validateDesktopAction({ type: "open_workspace_file", path: " docs/report.md " }),
  { type: "open_workspace_file", path: "docs/report.md" },
);
rejects("Workspace file path is empty.", () =>
  validateDesktopAction({ type: "open_workspace_file", path: "" }),
);
sameJson(
  validateDesktopAction({ type: "open_workspace_folder", path: "" }),
  { type: "open_workspace_folder", path: "" },
);
sameJson(
  validateDesktopAction({ type: "focus_window", window: "chat" }),
  { type: "focus_window", window: "chat" },
);
rejects("Unknown desktop window: root", () =>
  validateDesktopAction({ type: "focus_window", window: "root" }),
);

assert.equal(validateBrowserActionUrl("https://example.com/path"), "https://example.com/path");
assert.equal(
  validateBrowserActionUrl("entropic://signed-preview", {
    isTrustedLocalPreviewUrl: (url) => url === "entropic://signed-preview",
  }),
  "entropic://signed-preview",
);
rejects("Browser URL must be absolute.", () => validateBrowserActionUrl("example.com"));
rejects("Browser URL must use http or https.", () => validateBrowserActionUrl("file:///tmp/x"));
rejects("Local browser URLs must use a trusted Entropic preview URL.", () =>
  validateBrowserActionUrl("http://127.0.0.1:19791"),
);
rejects("Local browser URLs must use a trusted Entropic preview URL.", () =>
  validateBrowserActionUrl("http://192.168.1.10"),
);

sameJson(
  validateDesktopAction({ type: "new_chat_task", prompt: "  hello  ", sessionId: "abc" }),
  { type: "new_chat_task", prompt: "hello", sessionId: "abc", autoSubmit: false },
);
sameJson(
  validateDesktopAction({ type: "new_chat_task", prompt: "  run it  ", autoSubmit: true }),
  { type: "new_chat_task", prompt: "run it", autoSubmit: true },
);
rejects("Chat task prompt is empty.", () =>
  validateDesktopAction({ type: "new_chat_task", prompt: "   " }),
);

assert.equal(workspacePathLooksLikeFile("sales-plan.xlsx"), true);
assert.equal(workspacePathLooksLikeFile("Reports"), false);

sameJson(
  resolveDesktopHandoff({ action: "open", path: "sales-plan.xlsx", looksLikeFile: true }),
  { type: "open_workspace_file", path: "sales-plan.xlsx" },
);
sameJson(
  resolveDesktopHandoff({ action: "open", path: "Reports", looksLikeFile: false }),
  { type: "open_workspace_folder", path: "Reports" },
);
sameJson(
  resolveDesktopHandoff({ action: "preview", path: "notes.md" }),
  { type: "preview_workspace_path", path: "notes.md" },
);
sameJson(
  resolveDesktopHandoff({ action: "browser", url: "https://example.com" }),
  { type: "open_browser_url", url: "https://example.com" },
);
sameJson(
  resolveDesktopHandoff({ action: "browser", path: "index.html" }),
  { type: "open_workspace_in_browser", path: "index.html" },
);
sameJson(resolveDesktopHandoff({ action: "open" }), { type: "ignore" });

console.log("desktop action validator tests passed");
