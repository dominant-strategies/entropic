import { X } from "lucide-react";
import { getFileColor, getFileIcon } from "./FileIcons";

export type FilePreviewState =
  | { kind: "text"; name: string; path: string; content: string }
  | { kind: "image"; name: string; path: string; dataUrl: string }
  | { kind: "binary"; name: string; path: string; size: number };

type FilePreviewWindowProps = {
  preview: FilePreviewState;
  zIndex: number;
  formatSize: (size: number) => string;
  onFocus: () => void;
  onClose: () => void;
  onCopyText: () => void | Promise<void>;
  onExport: () => void | Promise<void>;
};

const CODE_EXTENSIONS = new Set([
  "js",
  "ts",
  "jsx",
  "tsx",
  "py",
  "rs",
  "go",
  "c",
  "cpp",
  "h",
  "rb",
  "sh",
  "bash",
  "zsh",
  "css",
  "html",
  "xml",
  "json",
  "yaml",
  "yml",
  "toml",
  "sql",
  "java",
  "kt",
  "swift",
  "php",
  "lua",
  "r",
  "pl",
  "ex",
  "exs",
  "hs",
  "ml",
  "scala",
  "clj",
  "dart",
  "vue",
  "svelte",
]);

export function FilePreviewWindow({
  preview,
  zIndex,
  formatSize,
  onFocus,
  onClose,
  onCopyText,
  onExport,
}: FilePreviewWindowProps) {
  const ext = preview.name.split(".").pop()?.toLowerCase() || "";
  const isCode = CODE_EXTENSIONS.has(ext);
  const isMd = ext === "md";
  const Icon = getFileIcon(preview.name, false);
  const iconColor = getFileColor(preview.name, false);
  const lines = preview.kind === "text" ? preview.content.split("\n") : [];
  const lineNumberWidth = String(lines.length || 1).length;

  return (
    <div
      className="absolute inset-0 flex items-center justify-center"
      style={{ zIndex, background: "rgba(0,0,0,0.45)" }}
      onMouseDownCapture={onFocus}
    >
      <div
        className="mx-6 flex h-[min(85vh,720px)] w-full max-w-3xl animate-fade-in flex-col overflow-hidden rounded-xl"
        style={{ boxShadow: "0 22px 70px 4px rgba(0,0,0,0.56)" }}
        onClick={(event) => event.stopPropagation()}
      >
        <div
          className="relative flex flex-shrink-0 items-center px-3 py-2.5"
          style={{ background: "#2d2d2d", borderBottom: "1px solid #1a1a1a" }}
        >
          <div className="z-10 flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="group relative h-3 w-3 rounded-full hover:opacity-80"
              style={{ background: "#ff5f57" }}
            >
              <X className="absolute inset-0.5 h-2 w-2 text-black/60 opacity-0 group-hover:opacity-100" />
            </button>
            <div className="h-3 w-3 rounded-full" style={{ background: "#febc2e" }} />
            <div className="h-3 w-3 rounded-full" style={{ background: "#28c840" }} />
          </div>
          <div className="z-10 ml-auto flex items-center gap-2">
            {preview.kind === "text" ? (
              <button
                type="button"
                onClick={() => {
                  void onCopyText();
                }}
                className="rounded-lg px-2.5 py-1 text-[11px] font-medium"
                style={{ background: "rgba(255,255,255,0.08)", color: "#d7d7d7" }}
              >
                Copy Text
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => {
                void onExport();
              }}
              className="rounded-lg px-2.5 py-1 text-[11px] font-medium"
              style={{ background: "rgba(84,163,247,0.18)", color: "#e9f3ff" }}
            >
              Export...
            </button>
          </div>
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="flex items-center gap-2">
              <Icon className="h-3.5 w-3.5" style={{ color: iconColor }} />
              <span className="text-xs font-medium" style={{ color: "#ccc" }}>
                {preview.name}
              </span>
            </div>
          </div>
        </div>
        <div
          className="min-h-0 flex-1 overflow-auto"
          style={{ background: preview.kind === "text" && (isCode || isMd) ? "#1e1e1e" : "#252526" }}
        >
          {preview.kind === "image" ? (
            <div className="flex items-center justify-center p-4">
              <img
                src={preview.dataUrl}
                alt={preview.name}
                className="max-h-[70vh] max-w-full rounded-lg shadow-lg"
              />
            </div>
          ) : null}
          {preview.kind === "binary" ? (
            <div className="p-6 text-sm" style={{ color: "#d4d4d4" }}>
              <p className="mb-2 font-medium">Preview not available</p>
              <p>This file type is not viewable yet.</p>
              <p className="mt-2 text-xs" style={{ color: "#888" }}>
                {preview.name} - {formatSize(preview.size)}
              </p>
            </div>
          ) : null}
          {preview.kind === "text" && (isCode || isMd) ? (
            <div className="flex select-text font-mono text-[13px] leading-[1.6]">
              <div
                className="sticky left-0 flex-shrink-0 select-none py-3 pr-3 text-right"
                style={{
                  color: "#858585",
                  background: "#1e1e1e",
                  paddingLeft: "12px",
                  minWidth: `${lineNumberWidth * 0.65 + 1.8}em`,
                  borderRight: "1px solid #2d2d2d",
                }}
              >
                {lines.map((_, index) => (
                  <div key={index}>{index + 1}</div>
                ))}
              </div>
              <pre
                className="flex-1 cursor-text select-text whitespace-pre-wrap break-words px-4 py-3"
                style={{ color: "#d4d4d4", tabSize: 4 }}
              >
                {preview.content}
              </pre>
            </div>
          ) : null}
          {preview.kind === "text" && !isCode && !isMd ? (
            <pre
              className="cursor-text select-text whitespace-pre-wrap break-words p-5 font-mono text-[13px] leading-relaxed"
              style={{ color: "#d4d4d4" }}
            >
              {preview.content}
            </pre>
          ) : null}
        </div>
        <div
          className="flex flex-shrink-0 items-center justify-between px-3 py-1 text-[11px]"
          style={{ background: "#007acc", color: "rgba(255,255,255,0.9)" }}
        >
          <span>{ext.toUpperCase() || "TXT"}</span>
          {preview.kind === "text" ? (
            <span>
              {lines.length} lines - {formatSize(new Blob([preview.content]).size)}
            </span>
          ) : preview.kind === "image" ? (
            <span>Image preview</span>
          ) : (
            <span>{formatSize(preview.size)}</span>
          )}
        </div>
      </div>
    </div>
  );
}
