import {
  useCallback,
  useRef,
  useState,
  type MutableRefObject,
  type MouseEvent as ReactMouseEvent,
} from "react";

export type WindowKey =
  | "finder"
  | "chat"
  | "browser"
  | "terminal"
  | "plugins"
  | "skills"
  | "channels"
  | "tasks"
  | "jobs"
  | "logs"
  | "billing"
  | "settings"
  | "preview"
  | "sheets"
  | "docs"
  | "slides"
  | "integrations"
  | "voiceOverlay";

export type WindowPoint = { x: number; y: number };
export type WindowSize = { w: number; h: number };
export type WindowRect = WindowPoint & WindowSize;
export type WindowDragState = { sx: number; sy: number; ox: number; oy: number };
export type WindowResizeDirection = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
export type WindowResizeState = WindowDragState & { ow: number; oh: number };

export const DEFAULT_WINDOW_Z: Record<WindowKey, number> = {
  finder: 60,
  chat: 61,
  browser: 62,
  terminal: 63,
  plugins: 64,
  skills: 65,
  channels: 66,
  tasks: 67,
  jobs: 68,
  logs: 69,
  billing: 70,
  settings: 71,
  sheets: 72,
  docs: 73,
  slides: 74,
  integrations: 75,
  preview: 80,
  voiceOverlay: 90,
};

function maxWindowZ(windowZ: Record<string, number>): number {
  return Math.max(...Object.values(DEFAULT_WINDOW_Z), ...Object.values(windowZ));
}

export function getWindowZ(windowZ: Record<string, number>, key: WindowKey): number {
  return windowZ[key] ?? DEFAULT_WINDOW_Z[key];
}

export function useWindowZStack(initialWindowZ: Record<string, number> = DEFAULT_WINDOW_Z) {
  const zCounter = useRef(maxWindowZ(initialWindowZ));
  const [windowZ, setWindowZ] = useState<Record<string, number>>(initialWindowZ);

  const focusWindow = useCallback((id: string) => {
    setWindowZ((prev) => {
      const nextZ = zCounter.current + 1;
      zCounter.current = nextZ;
      return { ...prev, [id]: nextZ };
    });
  }, []);

  return { windowZ, setWindowZ, zCounter, focusWindow };
}

export function clampWindowFrame(
  bounds: { width: number; height: number },
  position: WindowPoint,
  size: WindowSize,
  minSize: WindowSize,
): { position: WindowPoint; size: WindowSize } {
  const maxWidth = Math.max(minSize.w, Math.floor(bounds.width - 12));
  const maxHeight = Math.max(minSize.h, Math.floor(bounds.height - 12));
  const nextSize = {
    w: Math.min(Math.max(size.w, minSize.w), maxWidth),
    h: Math.min(Math.max(size.h, minSize.h), maxHeight),
  };
  const maxX = Math.max(0, Math.floor(bounds.width - nextSize.w));
  const maxY = Math.max(0, Math.floor(bounds.height - nextSize.h));
  return {
    position: {
      x: Math.min(Math.max(0, position.x), maxX),
      y: Math.min(Math.max(0, position.y), maxY),
    },
    size: nextSize,
  };
}

export function windowRectsIntersect(a: WindowRect, b: WindowRect): boolean {
  return (
    a.x < b.x + b.w &&
    a.x + a.w > b.x &&
    a.y < b.y + b.h &&
    a.y + a.h > b.y
  );
}

export function startDesktopWindowDrag(
  e: ReactMouseEvent<HTMLElement>,
  ref: MutableRefObject<WindowDragState | null>,
  pos: WindowPoint,
  size: WindowSize,
  setPos: (next: WindowPoint) => void,
  getBounds: () => { width: number; height: number } | null | undefined,
  onFocus: () => void,
) {
  if ((e.target as HTMLElement).closest("button")) return;
  e.preventDefault();
  onFocus();
  ref.current = { sx: e.clientX, sy: e.clientY, ox: pos.x, oy: pos.y };

  function onMove(ev: globalThis.MouseEvent) {
    if (!ref.current) return;
    const bounds = getBounds();
    const maxX = bounds ? Math.max(0, Math.floor(bounds.width - size.w)) : Number.POSITIVE_INFINITY;
    const maxY = bounds ? Math.max(0, Math.floor(bounds.height - size.h)) : Number.POSITIVE_INFINITY;
    setPos({
      x: Math.min(Math.max(0, ref.current.ox + ev.clientX - ref.current.sx), maxX),
      y: Math.min(Math.max(0, ref.current.oy + ev.clientY - ref.current.sy), maxY),
    });
  }

  function onUp() {
    ref.current = null;
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
  }

  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}

export function startDesktopWindowResize(
  e: ReactMouseEvent<HTMLElement>,
  direction: WindowResizeDirection,
  ref: MutableRefObject<WindowResizeState | null>,
  pos: WindowPoint,
  size: WindowSize,
  setPos: (next: WindowPoint) => void,
  setSize: (next: WindowSize) => void,
  minSize: WindowSize,
  getBounds: () => { width: number; height: number } | null | undefined,
  onFocus: () => void,
) {
  e.preventDefault();
  e.stopPropagation();
  onFocus();
  ref.current = { sx: e.clientX, sy: e.clientY, ox: pos.x, oy: pos.y, ow: size.w, oh: size.h };

  function onMove(ev: globalThis.MouseEvent) {
    if (!ref.current) return;
    const deltaX = ev.clientX - ref.current.sx;
    const deltaY = ev.clientY - ref.current.sy;
    const bounds = getBounds();
    const maxRight = bounds ? Math.floor(bounds.width - 12) : Number.POSITIVE_INFINITY;
    const maxBottom = bounds ? Math.floor(bounds.height - 12) : Number.POSITIVE_INFINITY;
    const originalLeft = ref.current.ox;
    const originalTop = ref.current.oy;
    const originalRight = ref.current.ox + ref.current.ow;
    const originalBottom = ref.current.oy + ref.current.oh;

    let nextLeft = originalLeft;
    let nextTop = originalTop;
    let nextRight = originalRight;
    let nextBottom = originalBottom;

    if (direction.includes("w")) {
      nextLeft = Math.max(0, Math.min(originalLeft + deltaX, originalRight - minSize.w));
    }
    if (direction.includes("e")) {
      nextRight = Math.max(
        originalLeft + minSize.w,
        Math.min(originalRight + deltaX, maxRight),
      );
    }
    if (direction.includes("n")) {
      nextTop = Math.max(0, Math.min(originalTop + deltaY, originalBottom - minSize.h));
    }
    if (direction.includes("s")) {
      nextBottom = Math.max(
        originalTop + minSize.h,
        Math.min(originalBottom + deltaY, maxBottom),
      );
    }

    setPos({ x: nextLeft, y: nextTop });
    setSize({ w: nextRight - nextLeft, h: nextBottom - nextTop });
  }

  function onUp() {
    ref.current = null;
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
  }

  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}
