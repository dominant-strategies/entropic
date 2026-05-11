import type { KeyboardEvent, RefObject } from "react";

type CreateWorkspaceEntryModalProps = {
  kind: "file" | "folder";
  open: boolean;
  basePath: string;
  value: string;
  busy: boolean;
  inputRef: RefObject<HTMLInputElement>;
  zIndex: number;
  placeholder: string;
  helperText?: string;
  onValueChange: (value: string) => void;
  onCancel: () => void;
  onSubmit: () => void | Promise<void>;
};

export function CreateWorkspaceEntryModal({
  kind,
  open,
  basePath,
  value,
  busy,
  inputRef,
  zIndex,
  placeholder,
  helperText,
  onValueChange,
  onCancel,
  onSubmit,
}: CreateWorkspaceEntryModalProps) {
  if (!open) return null;

  const label = kind === "file" ? "New File" : "New Folder";

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      void onSubmit();
    }
    if (event.key === "Escape" && !busy) {
      onCancel();
    }
  }

  return (
    <div
      className="absolute inset-0 flex items-center justify-center"
      style={{ zIndex, background: "rgba(0,0,0,0.34)", backdropFilter: "blur(6px)" }}
      onClick={() => {
        if (!busy) onCancel();
      }}
    >
      <div
        className="w-full max-w-sm rounded-2xl p-4"
        style={{
          background: "rgba(28,28,30,0.92)",
          border: "1px solid rgba(255,255,255,0.08)",
          boxShadow: "0 24px 60px rgba(0,0,0,0.45)",
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-3">
          <p className="text-sm font-semibold" style={{ color: "#fff" }}>
            {label}
          </p>
          <p className="mt-1 text-xs" style={{ color: "#9a9a9a" }}>
            {basePath ? `Create inside ${basePath}` : "Create in Workspace"}
          </p>
        </div>
        <input
          ref={inputRef}
          type="text"
          value={value}
          disabled={busy}
          onChange={(event) => onValueChange(event.target.value)}
          onKeyDown={handleKeyDown}
          className="w-full rounded-xl px-3 py-2 text-sm outline-none"
          style={{
            background: "rgba(255,255,255,0.08)",
            color: "#fff",
            border: "1px solid rgba(255,255,255,0.12)",
          }}
          placeholder={placeholder}
        />
        {helperText ? (
          <p className="mt-2 text-[11px]" style={{ color: "#8f8f8f" }}>
            {helperText}
          </p>
        ) : null}
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-lg px-3 py-1.5 text-xs"
            style={{ background: "rgba(255,255,255,0.08)", color: "#d0d0d0" }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              void onSubmit();
            }}
            disabled={!value.trim() || busy}
            className="rounded-lg px-3 py-1.5 text-xs font-medium disabled:opacity-50"
            style={{ background: "#54a3f7", color: "#fff" }}
          >
            {busy ? "Creating..." : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}
