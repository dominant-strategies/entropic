import type { MouseEvent as ReactMouseEvent } from "react";
import { Terminal } from "lucide-react";
import { AppWindow } from "../AppWindow";
import type { WindowPoint, WindowResizeDirection, WindowSize } from "../windowManager";

export const DESKTOP_TERMINAL_EVENT = "desktop-terminal-output";

export type DesktopTerminalStatus = "disconnected" | "ready" | "exited" | "error";

export type DesktopTerminalSnapshot = {
  session_id: string;
  output: string;
  status: Exclude<DesktopTerminalStatus, "disconnected">;
  exit_code: number | null;
  container_name: string;
  workspace_path: string;
};

export type DesktopTerminalEventPayload = {
  session_id: string;
  chunk: string;
  stream: "stdout" | "stderr" | "system";
  status: Exclude<DesktopTerminalStatus, "disconnected">;
  exit_code: number | null;
};

type TerminalAppProps = {
  position: WindowPoint;
  size: WindowSize;
  zIndex: number;
  sessionId: string | null;
  output: string;
  input: string;
  status: DesktopTerminalStatus;
  exitCode: number | null;
  error: string | null;
  bootstrapping: boolean;
  outputRef: { current: HTMLDivElement | null };
  onInputChange: (value: string) => void;
  onClose: () => void;
  onFocus: () => void;
  onDragStart: (event: ReactMouseEvent<HTMLElement>) => void;
  onResizeStart: (
    direction: WindowResizeDirection,
    event: ReactMouseEvent<HTMLDivElement>,
  ) => void;
  onClear: () => void;
  onRestart: () => void;
  onSubmit: () => void;
};

function terminalStatusLabel(
  bootstrapping: boolean,
  status: DesktopTerminalStatus,
  exitCode: number | null,
): string {
  if (bootstrapping) return "Connecting";
  if (status === "ready") return "Live";
  if (status === "exited") return exitCode === null ? "Exited" : `Exited (${exitCode})`;
  if (status === "error") return "Error";
  return "Idle";
}

function terminalStatusTone(bootstrapping: boolean, status: DesktopTerminalStatus): string {
  if (bootstrapping) return "#f59e0b";
  if (status === "ready") return "#22c55e";
  if (status === "error") return "#ef4444";
  return "rgba(148,163,184,0.95)";
}

export function TerminalApp({
  position,
  size,
  zIndex,
  sessionId,
  output,
  input,
  status,
  exitCode,
  error,
  bootstrapping,
  outputRef,
  onInputChange,
  onClose,
  onFocus,
  onDragStart,
  onResizeStart,
  onClear,
  onRestart,
  onSubmit,
}: TerminalAppProps) {
  const label = terminalStatusLabel(bootstrapping, status, exitCode);
  const tone = terminalStatusTone(bootstrapping, status);
  const disabled = bootstrapping || status !== "ready" || !sessionId;

  return (
    <AppWindow
      title="Terminal"
      icon={Terminal}
      position={position}
      size={size}
      zIndex={zIndex}
      onClose={onClose}
      onFocus={onFocus}
      onDragStart={onDragStart}
      onResizeStart={onResizeStart}
    >
      <div className="h-full flex flex-col bg-[#060816] text-[#e5e7eb]">
        <div className="flex items-center justify-between gap-3 px-4 py-2 border-b border-white/10 bg-[#0b1020]">
          <div className="min-w-0 flex items-center gap-3">
            <div
              className="inline-flex items-center gap-2 rounded-full px-2.5 py-1 text-[11px] font-medium"
              style={{ background: "rgba(255,255,255,0.06)", color: "#f8fafc" }}
            >
              <span className="h-2 w-2 rounded-full" style={{ background: tone }} />
              {label}
            </div>
            <span className="truncate text-[11px] text-slate-400">
              OpenClaw runtime shell in `/data/workspace`
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClear}
              className="h-8 px-3 rounded-lg border border-white/10 bg-white/5 text-xs font-medium text-slate-200 hover:bg-white/10"
            >
              Clear
            </button>
            <button
              type="button"
              onClick={onRestart}
              className="h-8 px-3 rounded-lg border border-white/10 bg-white/5 text-xs font-medium text-slate-200 hover:bg-white/10"
            >
              Restart
            </button>
          </div>
        </div>
        <div
          ref={(node) => {
            outputRef.current = node;
          }}
          className="flex-1 overflow-auto px-4 py-3 font-mono text-[12px] leading-6 select-text"
        >
          {output ? (
            <pre className="whitespace-pre-wrap break-words text-[#e5e7eb]">{output}</pre>
          ) : (
            <div className="text-[12px] text-slate-500">
              {bootstrapping
                ? "Starting runtime shell..."
                : "Run commands inside the OpenClaw container workspace."}
            </div>
          )}
        </div>
        <div className="border-t border-white/10 bg-[#0b1020] px-4 py-3">
          {error && (
            <div className="mb-2 rounded-lg border border-red-400/20 bg-red-400/10 px-3 py-2 text-[11px] text-red-100">
              {error}
            </div>
          )}
          <div className="flex items-start gap-3 rounded-2xl border border-white/10 bg-black/25 px-3 py-3">
            <span className="pt-1 font-mono text-sm text-emerald-400">$</span>
            <textarea
              value={input}
              onChange={(event) => onInputChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  onSubmit();
                }
              }}
              disabled={disabled}
              placeholder={
                bootstrapping
                  ? "Starting shell..."
                  : status === "ready"
                    ? "Enter a command"
                    : "Restart the session to run more commands"
              }
              className="min-h-[78px] flex-1 resize-none bg-transparent font-mono text-[13px] leading-6 text-[#f8fafc] outline-none placeholder:text-slate-500 disabled:cursor-not-allowed disabled:opacity-60"
            />
            <button
              type="button"
              onClick={onSubmit}
              disabled={disabled || !input.trim()}
              className="mt-1 h-9 px-4 rounded-xl bg-emerald-500 text-sm font-semibold text-slate-950 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Run
            </button>
          </div>
          <div className="mt-2 flex items-center justify-between gap-3 text-[11px] text-slate-500">
            <span>`Enter` runs the command. `Shift+Enter` adds a new line.</span>
            <span>This shell runs inside the sandbox container, not on your host.</span>
          </div>
        </div>
      </div>
    </AppWindow>
  );
}
