import { useEffect, useRef, type MouseEvent as ReactMouseEvent } from "react";
import { FileText, Image, LayoutGrid } from "lucide-react";
import { AppWindow } from "../AppWindow";
import {
  workspacePathExtension,
  workspacePathName,
} from "../finder/workspacePaths";
import type { WindowPoint, WindowResizeDirection, WindowSize } from "../windowManager";

export type OfficeAppKind = "sheets" | "docs" | "slides";

export type OfficeAppSession = {
  path: string;
  name: string;
  url: string;
  appKind: OfficeAppKind;
  launchToken: string;
};

export type OfficeRecentEntry = {
  path: string;
  name: string;
  openedAt: number;
};

type OfficeAppsProps = {
  open: Record<OfficeAppKind, boolean>;
  sessions: Record<OfficeAppKind, OfficeAppSession | null>;
  recent: Record<OfficeAppKind, OfficeRecentEntry[]>;
  position: Record<OfficeAppKind, WindowPoint>;
  size: Record<OfficeAppKind, WindowSize>;
  zIndex: Record<OfficeAppKind, number>;
  onClose: (kind: OfficeAppKind) => void;
  onFocus: (kind: OfficeAppKind) => void;
  onDragStart: (kind: OfficeAppKind, e: ReactMouseEvent<HTMLDivElement>) => void;
  onResizeStart: (
    kind: OfficeAppKind,
    direction: WindowResizeDirection,
    e: ReactMouseEvent<HTMLDivElement>,
  ) => void;
  onOpenRecent: (path: string) => void;
  onOpenChat: () => void;
};

const OFFICE_KINDS: OfficeAppKind[] = ["sheets", "docs", "slides"];

const OFFICE_META = {
  sheets: { title: "Sheets", icon: LayoutGrid },
  docs: { title: "Docs", icon: FileText },
  slides: { title: "Slides", icon: Image },
} as const;

function formatOfficeDate(epochMs: number): string {
  if (!epochMs) return "-";
  const date = new Date(epochMs);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return `Today at ${date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
  }
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) {
    return `Yesterday at ${date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
  }
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: date.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
    hour: "numeric",
    minute: "2-digit",
  });
}

export function officeAppKindForPath(path: string): OfficeAppKind | null {
  const ext = workspacePathExtension(path);
  if (ext === "xlsx") return "sheets";
  if (ext === "docx") return "docs";
  if (ext === "pptx") return "slides";
  return null;
}

export function officeAppLabel(kind: OfficeAppKind): string {
  return OFFICE_META[kind].title;
}

export function pushOfficeRecentEntry(
  current: OfficeRecentEntry[],
  nextEntry: OfficeRecentEntry,
): OfficeRecentEntry[] {
  return [
    nextEntry,
    ...current.filter((entry) => entry.path !== nextEntry.path),
  ].slice(0, 8);
}

function OfficeHomePanel({
  kind,
  recent,
  onOpenRecent,
  onOpenChat,
}: {
  kind: OfficeAppKind;
  recent: OfficeRecentEntry[];
  onOpenRecent: (path: string) => void;
  onOpenChat: () => void;
}) {
  const title = officeAppLabel(kind);
  const subtitle =
    kind === "sheets"
      ? "Create spreadsheets with chat or reopen recent work."
      : kind === "docs"
        ? "Create documents with chat or reopen recent work."
        : "Create presentations with chat or reopen recent work.";

  return (
    <div className="h-full overflow-auto bg-[linear-gradient(180deg,#f8fafc_0%,#eef5ff_100%)] px-8 py-8">
      <div className="mx-auto flex h-full max-w-3xl flex-col">
        <div className="mb-8">
          <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
            {title}
          </div>
          <h2 className="mt-2 text-3xl font-semibold tracking-tight text-slate-900">{title}</h2>
          <p className="mt-2 max-w-xl text-sm text-slate-600">{subtitle}</p>
        </div>

        {recent.length > 0 ? (
          <div className="rounded-[24px] border border-slate-200 bg-white/85 p-4 shadow-[0_24px_80px_rgba(15,23,42,0.08)] backdrop-blur">
            <div className="mb-3 text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
              Recent
            </div>
            <div className="space-y-2">
              {recent.map((entry) => (
                <button
                  key={entry.path}
                  type="button"
                  onClick={() => onOpenRecent(entry.path)}
                  className="flex w-full items-center justify-between rounded-2xl border border-slate-200 bg-white px-4 py-3 text-left transition hover:border-slate-300 hover:bg-slate-50"
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-slate-900">{entry.name}</div>
                    <div className="truncate text-xs text-slate-500">{entry.path}</div>
                  </div>
                  <div className="ml-4 shrink-0 text-[11px] text-slate-400">
                    {formatOfficeDate(entry.openedAt)}
                  </div>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center">
            <div className="max-w-md rounded-[28px] border border-slate-200 bg-white/92 px-8 py-9 text-center shadow-[0_24px_80px_rgba(15,23,42,0.1)] backdrop-blur">
              <div className="text-lg font-semibold text-slate-900">
                No recent {title.toLowerCase()} yet
              </div>
              <p className="mt-2 text-sm text-slate-600">
                Open chat and ask Entropic to create one for you, then it will appear here.
              </p>
              <button
                type="button"
                onClick={onOpenChat}
                className="mt-5 inline-flex h-11 items-center justify-center rounded-2xl bg-slate-900 px-5 text-sm font-semibold text-white transition hover:bg-slate-800"
              >
                Create With Chat
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function OfficeApps({
  open,
  sessions,
  recent,
  position,
  size,
  zIndex,
  onClose,
  onFocus,
  onDragStart,
  onResizeStart,
  onOpenRecent,
  onOpenChat,
}: OfficeAppsProps) {
  const iframeRefs = useRef<Record<OfficeAppKind, HTMLIFrameElement | null>>({
    sheets: null,
    docs: null,
    slides: null,
  });

  useEffect(() => {
    const focusActiveOfficeIframe = () => {
      window.setTimeout(() => {
        const activeElement = document.activeElement;
        for (const kind of OFFICE_KINDS) {
          if (open[kind] && iframeRefs.current[kind] === activeElement) {
            onFocus(kind);
            return;
          }
        }
      }, 0);
    };

    window.addEventListener("blur", focusActiveOfficeIframe, true);
    window.addEventListener("focusin", focusActiveOfficeIframe, true);
    return () => {
      window.removeEventListener("blur", focusActiveOfficeIframe, true);
      window.removeEventListener("focusin", focusActiveOfficeIframe, true);
    };
  }, [onFocus, open]);

  return (
    <>
      {OFFICE_KINDS.map((kind) => {
        if (!open[kind]) return null;
        const session = sessions[kind];
        const meta = OFFICE_META[kind];
        return (
          <AppWindow
            key={kind}
            title={meta.title}
            icon={meta.icon}
            position={position[kind]}
            size={size[kind]}
            zIndex={zIndex[kind]}
            glass={false}
            onClose={() => onClose(kind)}
            onFocus={() => onFocus(kind)}
            onDragStart={(e) => onDragStart(kind, e)}
            onResizeStart={(direction, e) => onResizeStart(kind, direction, e)}
          >
            <div className="h-full bg-white">
              {session ? (
                <iframe
                  ref={(node) => {
                    iframeRefs.current[kind] = node;
                  }}
                  key={`${session.path}:${session.launchToken}`}
                  src={session.url}
                  title={session.name}
                  className="block h-full w-full border-0 bg-white"
                  allow="clipboard-read; clipboard-write; fullscreen"
                  onFocus={() => onFocus(kind)}
                />
              ) : (
                <OfficeHomePanel
                  kind={kind}
                  recent={recent[kind]}
                  onOpenRecent={onOpenRecent}
                  onOpenChat={onOpenChat}
                />
              )}
            </div>
          </AppWindow>
        );
      })}
    </>
  );
}
