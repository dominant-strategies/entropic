import type {
  DragEvent as ReactDragEvent,
  MouseEvent as ReactMouseEvent,
  MutableRefObject,
} from "react";
import {
  DesktopFileIcon,
  DesktopImagePreviewIcon,
  FolderIcon,
  getFileColor,
  getFileIcon,
} from "./FileIcons";

type WorkspaceFileEntry = {
  name: string;
  path: string;
  is_directory: boolean;
  size: number;
  modified_at: number;
};

type DesktopIcon = { id: string; x: number; y: number };

type DesktopIconGridProps = {
  agentName: string;
  entries: WorkspaceFileEntry[];
  desktopIcons: Record<string, DesktopIcon>;
  imagePreviews: Record<string, string>;
  selected: string | null;
  dragDropTarget: string | null;
  iconClickGuardRef: MutableRefObject<boolean>;
  iconIdForPath: (path: string) => string;
  isImageEntry: (entry: WorkspaceFileEntry) => boolean;
  onIconMouseDown: (id: string, event: ReactMouseEvent<HTMLDivElement>) => void;
  onUploadDragOver: (event: ReactDragEvent<HTMLElement>, path: string) => void;
  onUploadDragLeave: (event: ReactDragEvent<HTMLElement>, path?: string) => void;
  onUploadDropToPath: (event: ReactDragEvent<HTMLElement>, path: string) => void;
  onSelectWorkspace: () => void;
  onWorkspaceContextMenu: (event: ReactMouseEvent<HTMLDivElement>) => void;
  onOpenWorkspace: () => void;
  onSelectEntry: (entry: WorkspaceFileEntry) => void;
  onEntryContextMenu: (entry: WorkspaceFileEntry, event: ReactMouseEvent<HTMLDivElement>) => void;
  onOpenEntry: (entry: WorkspaceFileEntry) => void;
};

export function DesktopIconGrid({
  agentName,
  entries,
  desktopIcons,
  imagePreviews,
  selected,
  dragDropTarget,
  iconClickGuardRef,
  iconIdForPath,
  isImageEntry,
  onIconMouseDown,
  onUploadDragOver,
  onUploadDragLeave,
  onUploadDropToPath,
  onSelectWorkspace,
  onWorkspaceContextMenu,
  onOpenWorkspace,
  onSelectEntry,
  onEntryContextMenu,
  onOpenEntry,
}: DesktopIconGridProps) {
  const workspaceIcon = desktopIcons.workspace;

  return (
    <div className="relative flex-1 pt-4 px-0 pb-0 h-full">
      <div
        className="absolute flex flex-col items-center w-20 p-2 rounded-xl cursor-grab active:cursor-grabbing transition-colors duration-100 select-none"
        data-desktop-drop-target=""
        style={{
          left: workspaceIcon?.x ?? 28,
          top: workspaceIcon?.y ?? 72,
          background: selected === "__user_folder"
            ? "rgba(255,255,255,0.18)"
            : dragDropTarget === ""
              ? "rgba(84,163,247,0.18)"
              : "transparent",
          outline: dragDropTarget === "" ? "1px solid rgba(122,184,245,0.6)" : "none",
        }}
        onMouseDown={(event) => onIconMouseDown("workspace", event)}
        onDragOver={(event) => onUploadDragOver(event, "")}
        onDragLeave={(event) => onUploadDragLeave(event, "")}
        onDrop={(event) => onUploadDropToPath(event, "")}
        onClick={(event) => {
          if (iconClickGuardRef.current) return;
          event.stopPropagation();
          onSelectWorkspace();
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onWorkspaceContextMenu(event);
        }}
        onDoubleClick={onOpenWorkspace}
      >
        <FolderIcon size={56} selected={selected === "__user_folder"} />
        <span
          className="text-[11px] text-center leading-tight mt-1 w-full truncate"
          style={{
            color: "white",
            textShadow: "0 1px 3px rgba(0,0,0,0.6)",
            fontWeight: selected === "__user_folder" ? 600 : 400,
          }}
        >
          {agentName}&apos;s Files
        </span>
      </div>

      {entries.map((entry) => {
        const iconKey = iconIdForPath(entry.path);
        const icon = desktopIcons[iconKey];
        const Icon = getFileIcon(entry.name, entry.is_directory);
        const iconColor = getFileColor(entry.name, entry.is_directory);
        const imagePreview = isImageEntry(entry) ? imagePreviews[entry.path] : undefined;
        const isSelected = selected === entry.path;
        const isDropTarget = dragDropTarget === entry.path;

        return (
          <div
            key={entry.path}
            className="absolute flex flex-col items-center w-20 p-2 rounded-xl cursor-grab active:cursor-grabbing transition-colors duration-100 select-none"
            data-desktop-drop-target={entry.is_directory ? entry.path : undefined}
            style={{
              left: icon?.x ?? 28,
              top: icon?.y ?? 192,
              background: isSelected
                ? "rgba(255,255,255,0.18)"
                : isDropTarget
                  ? "rgba(84,163,247,0.18)"
                  : "transparent",
              outline: isDropTarget ? "1px solid rgba(122,184,245,0.6)" : "none",
            }}
            onMouseDown={(event) => onIconMouseDown(iconKey, event)}
            onDragOver={entry.is_directory ? (event) => onUploadDragOver(event, entry.path) : undefined}
            onDragLeave={entry.is_directory ? (event) => onUploadDragLeave(event, entry.path) : undefined}
            onDrop={entry.is_directory ? ((event) => onUploadDropToPath(event, entry.path)) : undefined}
            onClick={(event) => {
              if (iconClickGuardRef.current) return;
              event.stopPropagation();
              onSelectEntry(entry);
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onEntryContextMenu(entry, event);
            }}
            onDoubleClick={() => onOpenEntry(entry)}
          >
            {entry.is_directory ? (
              <FolderIcon size={56} selected={isSelected || isDropTarget} />
            ) : imagePreview ? (
              <DesktopImagePreviewIcon src={imagePreview} active={isSelected || isDropTarget} />
            ) : (
              <div className="w-14 h-14 flex items-center justify-center">
                <DesktopFileIcon icon={Icon} color={iconColor} active={isSelected || isDropTarget} />
              </div>
            )}
            <span
              className="text-[11px] text-center leading-tight mt-1 w-full"
              style={{
                color: "white",
                textShadow: "0 1px 3px rgba(0,0,0,0.6)",
                fontWeight: isSelected ? 600 : 400,
                display: "-webkit-box",
                WebkitLineClamp: 2,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
                wordBreak: "break-word",
              }}
            >
              {entry.name}
            </span>
          </div>
        );
      })}
    </div>
  );
}
