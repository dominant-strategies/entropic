import type { MouseEvent as ReactMouseEvent } from "react";
import { X } from "lucide-react";
import type {
  WindowPoint,
  WindowResizeDirection,
  WindowSize,
} from "../windowManager";
import { getFileColor, getFileIcon } from "./FileIcons";

export type FilePreviewState =
  | { kind: "text"; name: string; path: string; content: string }
  | { kind: "image"; name: string; path: string; dataUrl: string }
  | { kind: "binary"; name: string; path: string; size: number };

type FilePreviewWindowProps = {
  preview: FilePreviewState;
  position: WindowPoint;
  size: WindowSize;
  zIndex: number;
  formatSize: (size: number) => string;
  onFocus: () => void;
  onDragStart: (event: ReactMouseEvent<HTMLDivElement>) => void;
  onResizeStart: (
    direction: WindowResizeDirection,
    event: ReactMouseEvent<HTMLDivElement>,
  ) => void;
  onClose: () => void;
  onCopyText: () => void | Promise<void>;
  onExport: () => void | Promise<void>;
};

const RESIZE_HANDLES: Array<{
  direction: WindowResizeDirection;
  className: string;
}> = [
  { direction: "n", className: "absolute left-4 right-4 top-0 z-20 h-3 cursor-ns-resize" },
  { direction: "s", className: "absolute bottom-0 left-4 right-4 z-20 h-3 cursor-ns-resize" },
  { direction: "e", className: "absolute bottom-4 right-0 top-4 z-20 w-3 cursor-ew-resize" },
  { direction: "w", className: "absolute bottom-4 left-0 top-4 z-20 w-3 cursor-ew-resize" },
  { direction: "nw", className: "absolute left-0 top-0 z-20 h-4 w-4 cursor-nwse-resize" },
  { direction: "ne", className: "absolute right-0 top-0 z-20 h-4 w-4 cursor-nesw-resize" },
  { direction: "se", className: "absolute bottom-0 right-0 z-20 h-4 w-4 cursor-nwse-resize" },
  { direction: "sw", className: "absolute bottom-0 left-0 z-20 h-4 w-4 cursor-nesw-resize" },
];

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
  position,
  size,
  zIndex,
  formatSize,
  onFocus,
  onDragStart,
  onResizeStart,
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
      className="absolute flex animate-fade-in flex-col overflow-hidden rounded-xl"
      style={{
        top: position.y,
        left: position.x,
        width: size.w,
        height: size.h,
        zIndex,
        boxShadow: "0 22px 70px 4px rgba(0,0,0,0.46)",
        border: "1px solid rgba(255,255,255,0.1)",
      }}
      onMouseDownCapture={onFocus}
      onClick={(event) => event.stopPropagation()}
    >
      <div
        className="relative flex flex-shrink-0 cursor-grab select-none items-center px-3 py-2.5 active:cursor-grabbing"
        style={{ background: "#2d2d2d", borderBottom: "1px solid #1a1a1a" }}
        onMouseDown={onDragStart}
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
      {RESIZE_HANDLES.map((handle) => (
        <div
          key={handle.direction}
          className={handle.className}
          onMouseDown={(event) => onResizeStart(handle.direction, event)}
        />
      ))}
      <div className="pointer-events-none absolute bottom-1 right-1 z-10 h-3 w-3 rounded-sm border-r-2 border-b-2 border-white/25" />
    </div>
  );
}
