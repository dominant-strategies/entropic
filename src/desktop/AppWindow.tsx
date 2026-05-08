import type {
  ComponentType,
  CSSProperties,
  MouseEvent as ReactMouseEvent,
  ReactNode,
} from "react";
import { X } from "lucide-react";
import type { WindowPoint, WindowResizeDirection, WindowSize } from "./windowManager";

type DesktopWindowIcon = ComponentType<{
  className?: string;
  style?: CSSProperties;
}>;

type AppWindowProps = {
  title: string;
  icon: DesktopWindowIcon;
  position: WindowPoint;
  size: WindowSize;
  onClose: () => void;
  onDragStart: (e: ReactMouseEvent<HTMLDivElement>) => void;
  onResizeStart?: (
    direction: WindowResizeDirection,
    e: ReactMouseEvent<HTMLDivElement>,
  ) => void;
  onFocus: () => void;
  zIndex: number;
  active?: boolean;
  glass?: boolean;
  children: ReactNode;
};

const RESIZE_HANDLES: Array<{
  direction: WindowResizeDirection;
  className: string;
}> = [
  { direction: "n", className: "absolute left-4 right-4 top-0 z-20 h-3 cursor-ns-resize" },
  { direction: "s", className: "absolute bottom-0 left-4 right-4 z-20 h-3 cursor-ns-resize" },
  { direction: "e", className: "absolute right-0 top-4 bottom-4 z-20 w-3 cursor-ew-resize" },
  { direction: "w", className: "absolute left-0 top-4 bottom-4 z-20 w-3 cursor-ew-resize" },
  { direction: "nw", className: "absolute left-0 top-0 z-20 h-4 w-4 cursor-nwse-resize" },
  { direction: "ne", className: "absolute right-0 top-0 z-20 h-4 w-4 cursor-nesw-resize" },
  { direction: "se", className: "absolute bottom-0 right-0 z-20 h-4 w-4 cursor-nwse-resize" },
  { direction: "sw", className: "absolute bottom-0 left-0 z-20 h-4 w-4 cursor-nesw-resize" },
];

export function AppWindow({
  title,
  icon: Icon,
  position,
  size,
  onClose,
  onDragStart,
  onResizeStart,
  onFocus,
  zIndex,
  active = true,
  glass = true,
  children,
}: AppWindowProps) {
  return (
    <div
      className="desktop-app-window absolute flex flex-col rounded-xl overflow-hidden animate-scale-in bg-[var(--bg-card)]"
      data-window-active={active ? "true" : "false"}
      style={{
        top: position.y,
        left: position.x,
        width: size.w,
        height: size.h,
        zIndex,
        isolation: "isolate",
        backdropFilter: glass ? "blur(18px)" : "none",
        WebkitBackdropFilter: glass ? "blur(18px)" : "none",
        boxShadow: "0 24px 70px rgba(0,0,0,0.28), 0 0 0 0.5px var(--border-subtle)",
        border: "1px solid var(--border-subtle)",
      }}
      onMouseDownCapture={onFocus}
      onClick={(e) => e.stopPropagation()}
    >
      <div
        className="flex items-center px-3 py-2 flex-shrink-0 relative cursor-grab active:cursor-grabbing bg-[var(--bg-secondary)] select-none"
        style={{
          borderBottom: "1px solid var(--border-subtle)",
        }}
        onMouseDown={onDragStart}
      >
        <div className="flex items-center gap-2 z-10">
          <button
            onClick={onClose}
            className="w-3 h-3 rounded-full hover:opacity-80 group relative"
            style={{ background: "#ff5f57" }}
            title="Close"
          >
            <X className="w-2 h-2 absolute inset-0.5 opacity-0 group-hover:opacity-100 text-black/60" />
          </button>
          <div className="w-3 h-3 rounded-full" style={{ background: "#febc2e" }} />
          <div className="w-3 h-3 rounded-full" style={{ background: "#28c840" }} />
        </div>
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="flex items-center gap-2">
            <Icon className="w-3.5 h-3.5" style={{ color: "var(--purple-accent)" }} />
            <span className="text-xs font-medium" style={{ color: "var(--text-primary)" }}>
              {title}
            </span>
          </div>
        </div>
      </div>
      <div className="flex-1 overflow-hidden bg-[var(--bg-app)]">
        <div className="h-full overflow-auto">{children}</div>
      </div>
      {onResizeStart && (
        <>
          {RESIZE_HANDLES.map((handle) => (
            <div
              key={handle.direction}
              className={handle.className}
              onMouseDown={(e) => onResizeStart(handle.direction, e)}
            />
          ))}
          <div className="pointer-events-none absolute bottom-1 right-1 z-10 h-3 w-3 rounded-sm border-r-2 border-b-2 border-black/25" />
        </>
      )}
    </div>
  );
}
