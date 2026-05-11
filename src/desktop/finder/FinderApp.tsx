import type {
  DragEvent as ReactDragEvent,
  MouseEvent as ReactMouseEvent,
} from "react";
import {
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  FileText,
  Folder,
  LayoutGrid,
  List,
  Plus,
  X,
} from "lucide-react";
import {
  FolderIcon,
  getFileColor,
  getFileIcon,
} from "./FileIcons";
import type { WindowPoint, WindowSize } from "../windowManager";

export type FinderEntry = {
  name: string;
  path: string;
  is_directory: boolean;
  size: number;
  modified_at: number;
};

type FinderViewMode = "grid" | "list";

type FinderAppProps<TEntry extends FinderEntry> = {
  position: WindowPoint;
  size: WindowSize;
  zIndex: number;
  currentPath: string;
  pathSegments: string[];
  folderName: string;
  entries: TEntry[];
  loading: boolean;
  viewMode: FinderViewMode;
  selected: string | null;
  dragDropTarget: string | null;
  historyIndex: number;
  historyLength: number;
  itemCount: number;
  formatDate: (epochSec: number) => string;
  formatSize: (bytes: number) => string;
  onClose: () => void;
  onFocus: () => void;
  onDragStart: (e: ReactMouseEvent<HTMLDivElement>) => void;
  onBack: () => void;
  onForward: () => void;
  onNavigate: (path: string) => void;
  onViewModeChange: (mode: FinderViewMode) => void;
  onCreateFile: (path: string) => void;
  onCreateFolder: (path: string) => void;
  onChooseFiles: () => void;
  onClearSelection: () => void;
  onDragOverPath: (e: ReactDragEvent<HTMLElement>, path: string) => void;
  onDragLeavePath: (e: ReactDragEvent<HTMLElement>, path?: string) => void;
  onDropToPath: (e: ReactDragEvent<HTMLElement>, path: string) => void;
  onEntryClick: (entry: TEntry, e: ReactMouseEvent<HTMLElement>) => void;
  onEntryDoubleClick: (entry: TEntry) => void;
  onEntryContextMenu: (entry: TEntry, e: ReactMouseEvent<HTMLElement>) => void;
};

export function FinderApp<TEntry extends FinderEntry>({
  position,
  size,
  zIndex,
  currentPath,
  pathSegments,
  folderName,
  entries,
  loading,
  viewMode,
  selected,
  dragDropTarget,
  historyIndex,
  historyLength,
  itemCount,
  formatDate,
  formatSize,
  onClose,
  onFocus,
  onDragStart,
  onBack,
  onForward,
  onNavigate,
  onViewModeChange,
  onCreateFile,
  onCreateFolder,
  onChooseFiles,
  onClearSelection,
  onDragOverPath,
  onDragLeavePath,
  onDropToPath,
  onEntryClick,
  onEntryDoubleClick,
  onEntryContextMenu,
}: FinderAppProps<TEntry>) {
  return (
    <div
      className="absolute flex flex-col rounded-xl overflow-hidden animate-scale-in"
      data-desktop-drop-target={currentPath}
      style={{
        top: position.y,
        left: position.x,
        width: size.w,
        height: size.h,
        boxShadow: "0 22px 70px 4px rgba(0,0,0,0.56), 0 0 0 0.5px rgba(255,255,255,0.1)",
        border: "0.5px solid rgba(255,255,255,0.08)",
        zIndex,
      }}
      onMouseDownCapture={onFocus}
      onClick={(e) => e.stopPropagation()}
    >
      <div
        className="flex items-center px-3 py-2 flex-shrink-0 relative cursor-grab active:cursor-grabbing select-none"
        style={{ background: "#2d2d2d", borderBottom: "1px solid #1a1a1a" }}
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
        <div className="flex items-center gap-0.5 ml-3 z-10">
          <button
            onClick={onBack}
            disabled={historyIndex <= 0}
            className="p-1 rounded disabled:opacity-30 hover:bg-white/10"
          >
            <ChevronLeft className="w-3.5 h-3.5" style={{ color: "#aaa" }} />
          </button>
          <button
            onClick={onForward}
            disabled={historyIndex >= historyLength - 1}
            className="p-1 rounded disabled:opacity-30 hover:bg-white/10"
          >
            <ChevronRight className="w-3.5 h-3.5" style={{ color: "#aaa" }} />
          </button>
        </div>
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="flex items-center gap-2">
            {currentPath && (
              <button
                onClick={() => onNavigate(pathSegments.slice(0, -1).join("/"))}
                className="pointer-events-auto p-0.5 rounded hover:bg-white/10"
              >
                <ArrowUp className="w-3 h-3" style={{ color: "#888" }} />
              </button>
            )}
            <Folder className="w-3.5 h-3.5" style={{ color: "#54a3f7" }} />
            <span className="text-xs font-medium" style={{ color: "#ccc" }}>{folderName}</span>
          </div>
        </div>
        <div className="flex items-center gap-0.5 ml-auto z-10">
          <button
            onClick={() => onViewModeChange("grid")}
            className="p-1 rounded"
            style={{
              color: viewMode === "grid" ? "#fff" : "#666",
              background: viewMode === "grid" ? "rgba(255,255,255,0.1)" : "transparent",
            }}
          >
            <LayoutGrid className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => onViewModeChange("list")}
            className="p-1 rounded"
            style={{
              color: viewMode === "list" ? "#fff" : "#666",
              background: viewMode === "list" ? "rgba(255,255,255,0.1)" : "transparent",
            }}
          >
            <List className="w-3.5 h-3.5" />
          </button>
          <div className="w-px h-3.5 mx-1" style={{ background: "rgba(255,255,255,0.1)" }} />
          <button
            onClick={() => onCreateFile(currentPath)}
            className="p-1 rounded hover:bg-white/10"
            title="New file"
          >
            <FileText className="w-3.5 h-3.5" style={{ color: "#aaa" }} />
          </button>
          <button
            onClick={() => onCreateFolder(currentPath)}
            className="p-1 rounded hover:bg-white/10"
          >
            <Plus className="w-3.5 h-3.5" style={{ color: "#aaa" }} />
          </button>
        </div>
      </div>

      <div
        className="flex items-center gap-0.5 px-3 py-1 text-[11px] flex-shrink-0 overflow-x-auto"
        style={{ background: "#252526", borderBottom: "1px solid #1a1a1a", color: "#888" }}
      >
        <button
          onClick={() => onNavigate("")}
          className="px-1.5 py-0.5 rounded hover:bg-white/10 flex-shrink-0"
          style={{ color: pathSegments.length === 0 ? "#ddd" : "#888" }}
        >
          Workspace
        </button>
        {pathSegments.map((seg, i) => {
          const segPath = pathSegments.slice(0, i + 1).join("/");
          return (
            <span key={segPath} className="flex items-center gap-0.5 flex-shrink-0">
              <ChevronRight className="w-3 h-3" style={{ color: "#555" }} />
              <button
                onClick={() => onNavigate(segPath)}
                className="px-1.5 py-0.5 rounded hover:bg-white/10"
                style={{ color: i === pathSegments.length - 1 ? "#ddd" : "#888" }}
              >
                {seg}
              </button>
            </span>
          );
        })}
      </div>

      <div
        className="flex-1 overflow-auto relative"
        onClick={onClearSelection}
        onDragOver={(e) => onDragOverPath(e, currentPath)}
        onDragLeave={(e) => onDragLeavePath(e, currentPath)}
        onDrop={(e) => onDropToPath(e, currentPath)}
        style={{ background: "#1e1e1e" }}
      >
        {loading && entries.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <div
                className="w-8 h-8 rounded-full border-2 border-t-transparent animate-spin mx-auto mb-3"
                style={{ borderColor: "#555", borderTopColor: "transparent" }}
              />
              <p className="text-xs" style={{ color: "#888" }}>Loading...</p>
            </div>
          </div>
        ) : entries.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center max-w-xs">
              <Folder className="w-16 h-16 mx-auto mb-4" style={{ color: "#54a3f7", opacity: 0.3 }} />
              <p className="text-sm font-medium mb-1" style={{ color: "#ddd" }}>This folder is empty</p>
              <p className="text-xs mb-4" style={{ color: "#888" }}>Drag files here or click + to add</p>
              <button
                onClick={onChooseFiles}
                className="text-xs px-4 py-2 rounded-lg"
                style={{ background: "rgba(255,255,255,0.1)", color: "#ccc" }}
              >
                Choose Files
              </button>
            </div>
          </div>
        ) : viewMode === "grid" ? (
          <div className="p-3 grid gap-1" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(84px, 1fr))" }}>
            {entries.map((entry) => {
              const Icon = getFileIcon(entry.name, entry.is_directory);
              const iconColor = getFileColor(entry.name, entry.is_directory);
              const isSelected = selected === entry.path;
              const isDropTarget = dragDropTarget === entry.path;
              return (
                <div
                  key={entry.path}
                  className="flex flex-col items-center p-2 rounded-lg cursor-default"
                  data-desktop-drop-target={entry.is_directory ? entry.path : undefined}
                  style={{
                    background: isSelected
                      ? "rgba(59,130,246,0.2)"
                      : isDropTarget
                        ? "rgba(84,163,247,0.18)"
                        : "transparent",
                    outline: isDropTarget ? "1px solid rgba(122,184,245,0.55)" : "none",
                  }}
                  onClick={(e) => onEntryClick(entry, e)}
                  onDoubleClick={() => onEntryDoubleClick(entry)}
                  onContextMenu={(e) => onEntryContextMenu(entry, e)}
                  onDragOver={entry.is_directory ? (e) => onDragOverPath(e, entry.path) : undefined}
                  onDragLeave={entry.is_directory ? (e) => onDragLeavePath(e, entry.path) : undefined}
                  onDrop={entry.is_directory ? ((e) => onDropToPath(e, entry.path)) : undefined}
                >
                  {entry.is_directory ? (
                    <div className="w-11 h-11 flex items-center justify-center mb-1">
                      <FolderIcon size={44} selected={isSelected || isDropTarget} />
                    </div>
                  ) : (
                    <div className="w-11 h-11 flex items-center justify-center mb-1">
                      <Icon className="w-8 h-8" style={{ color: iconColor }} strokeWidth={1.2} />
                    </div>
                  )}
                  <span
                    className="text-[10px] text-center leading-tight w-full px-0.5"
                    style={{
                      color: isSelected ? "#fff" : "#ccc",
                      fontWeight: isSelected ? 500 : 400,
                      display: "-webkit-box",
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: "vertical",
                      overflow: "hidden",
                      wordBreak: "break-all",
                    }}
                  >
                    {entry.name}
                  </span>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="flex flex-col">
            <div
              className="flex items-center gap-3 px-4 py-1.5 text-[11px] font-medium sticky top-0 z-10"
              style={{ color: "#888", background: "#252526", borderBottom: "1px solid #1a1a1a" }}
            >
              <span className="flex-1">Name</span>
              <span className="w-28 text-right">Date Modified</span>
              <span className="w-20 text-right">Size</span>
            </div>
            {entries.map((entry) => {
              const Icon = getFileIcon(entry.name, entry.is_directory);
              const iconColor = getFileColor(entry.name, entry.is_directory);
              const isSelected = selected === entry.path;
              const isDropTarget = dragDropTarget === entry.path;
              return (
                <div
                  key={entry.path}
                  className="flex items-center gap-3 px-4 py-1.5 cursor-default"
                  data-desktop-drop-target={entry.is_directory ? entry.path : undefined}
                  style={{
                    background: isSelected
                      ? "rgba(59,130,246,0.15)"
                      : isDropTarget
                        ? "rgba(84,163,247,0.18)"
                        : "transparent",
                    borderBottom: "1px solid #2a2a2a",
                    outline: isDropTarget ? "1px solid rgba(122,184,245,0.55)" : "none",
                  }}
                  onClick={(e) => onEntryClick(entry, e)}
                  onDoubleClick={() => onEntryDoubleClick(entry)}
                  onContextMenu={(e) => onEntryContextMenu(entry, e)}
                  onDragOver={entry.is_directory ? (e) => onDragOverPath(e, entry.path) : undefined}
                  onDragLeave={entry.is_directory ? (e) => onDragLeavePath(e, entry.path) : undefined}
                  onDrop={entry.is_directory ? ((e) => onDropToPath(e, entry.path)) : undefined}
                >
                  <Icon className="w-4 h-4 flex-shrink-0" style={{ color: iconColor }} />
                  <span
                    className="flex-1 text-xs truncate"
                    style={{ color: isSelected ? "#fff" : "#ccc", fontWeight: isSelected ? 500 : 400 }}
                  >
                    {entry.name}
                  </span>
                  <span className="w-28 text-right text-[11px]" style={{ color: "#666" }}>
                    {formatDate(entry.modified_at)}
                  </span>
                  <span className="w-20 text-right text-[11px]" style={{ color: "#666" }}>
                    {entry.is_directory ? "-" : formatSize(entry.size)}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div
        className="flex items-center justify-between px-3 py-1 flex-shrink-0 text-[11px]"
        style={{ background: "#252526", borderTop: "1px solid #1a1a1a", color: "#888" }}
      >
        <span>{itemCount} item{itemCount !== 1 ? "s" : ""}</span>
        <button onClick={onChooseFiles} className="hover:underline" style={{ color: "#aaa" }}>
          Add files...
        </button>
      </div>
    </div>
  );
}
