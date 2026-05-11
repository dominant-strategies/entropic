import type { ReactNode } from "react";
import { ArrowUp, Eye, FileText, Folder, Globe, Image, Plus, Terminal, Trash2 } from "lucide-react";

export type DesktopContextMenuEntry = {
  name: string;
  path: string;
  is_directory: boolean;
  size: number;
  modified_at: number;
};

export type DesktopContextMenuState = {
  x: number;
  y: number;
  entry?: DesktopContextMenuEntry;
};

type DesktopContextMenusProps = {
  contextMenu: DesktopContextMenuState | null;
  desktopBasePath: string;
  currentPath: string;
  finderOpen: boolean;
  zIndex: number;
  onClose: () => void;
  onCreateFile: (basePath: string) => void;
  onCreateFolder: (basePath: string) => void;
  onOpenBrowser: () => void;
  onOpenTerminal: () => void;
  onChangeWallpaper: () => void;
  onAddFiles: () => void;
  onOpenWorkspace: () => void;
  onOpenEntry: (entry: DesktopContextMenuEntry) => void;
  onOpenEntryInBrowser: (entry: DesktopContextMenuEntry) => void | Promise<void>;
  onQuickLook: (entry: DesktopContextMenuEntry) => void;
  onExport: (entry: DesktopContextMenuEntry) => void | Promise<void>;
  onCopyPath: (path: string) => void | Promise<void>;
  onDelete: (entry: DesktopContextMenuEntry) => void;
  canOpenInBrowser: (path: string) => boolean;
};

function menuStyle(x: number, y: number, zIndex: number, opacity = 0.9) {
  return {
    left: x,
    top: y,
    zIndex,
    background: `rgba(30,30,30,${opacity})`,
    backdropFilter: "blur(20px)",
    border: "1px solid rgba(255,255,255,0.1)",
    boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
  };
}

function MenuButton({
  children,
  danger,
  onClick,
}: {
  children: ReactNode;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-white/80 hover:bg-white/10"
      style={danger ? { color: "#ff5f57" } : undefined}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function DesktopContextMenus({
  contextMenu,
  desktopBasePath,
  currentPath,
  finderOpen,
  zIndex,
  onClose,
  onCreateFile,
  onCreateFolder,
  onOpenBrowser,
  onOpenTerminal,
  onChangeWallpaper,
  onAddFiles,
  onOpenWorkspace,
  onOpenEntry,
  onOpenEntryInBrowser,
  onQuickLook,
  onExport,
  onCopyPath,
  onDelete,
  canOpenInBrowser,
}: DesktopContextMenusProps) {
  if (!contextMenu) return null;

  const closeAfter = (action: () => void | Promise<void>) => {
    const result = action();
    onClose();
    return result;
  };

  if (!contextMenu.entry) {
    const targetPath = finderOpen ? currentPath : desktopBasePath;
    return (
      <div
        className="fixed min-w-[180px] animate-fade-in rounded-lg py-1"
        style={menuStyle(contextMenu.x, contextMenu.y, zIndex)}
        onClick={(event) => event.stopPropagation()}
      >
        <MenuButton onClick={() => closeAfter(() => onCreateFile(targetPath))}>
          <FileText className="h-3.5 w-3.5" />
          New File
        </MenuButton>
        <MenuButton onClick={() => closeAfter(() => onCreateFolder(targetPath))}>
          <Plus className="h-3.5 w-3.5" />
          New Folder
        </MenuButton>
        <MenuButton onClick={() => closeAfter(onOpenBrowser)}>
          <Globe className="h-3.5 w-3.5" />
          Open Browser
        </MenuButton>
        <MenuButton onClick={() => closeAfter(onOpenTerminal)}>
          <Terminal className="h-3.5 w-3.5" />
          Open Terminal
        </MenuButton>
        <MenuButton onClick={() => closeAfter(onChangeWallpaper)}>
          <Image className="h-3.5 w-3.5" />
          Change Wallpaper
        </MenuButton>
        <MenuButton onClick={() => closeAfter(onAddFiles)}>
          <Plus className="h-3.5 w-3.5" />
          Add Files
        </MenuButton>
        <MenuButton onClick={() => closeAfter(onOpenWorkspace)}>
          <Folder className="h-3.5 w-3.5" />
          Open Workspace
        </MenuButton>
      </div>
    );
  }

  const entry = contextMenu.entry;
  return (
    <div
      className="fixed min-w-[160px] animate-fade-in rounded-lg py-1"
      style={menuStyle(contextMenu.x, contextMenu.y, zIndex + 1, 0.95)}
      onClick={(event) => event.stopPropagation()}
    >
      <MenuButton onClick={() => closeAfter(() => onOpenEntry(entry))}>
        <Folder className="h-3.5 w-3.5" style={{ color: "#888" }} />
        Open
      </MenuButton>
      {entry.is_directory ? (
        <MenuButton onClick={() => closeAfter(() => onCreateFile(entry.path))}>
          <FileText className="h-3.5 w-3.5" style={{ color: "#888" }} />
          New File Here
        </MenuButton>
      ) : null}
      {entry.is_directory ? (
        <MenuButton onClick={() => closeAfter(() => onCreateFolder(entry.path))}>
          <Plus className="h-3.5 w-3.5" style={{ color: "#888" }} />
          New Folder Here
        </MenuButton>
      ) : null}
      {!entry.is_directory && canOpenInBrowser(entry.path) ? (
        <MenuButton onClick={() => closeAfter(() => onOpenEntryInBrowser(entry))}>
          <Globe className="h-3.5 w-3.5" style={{ color: "#888" }} />
          Open in Browser
        </MenuButton>
      ) : null}
      {!entry.is_directory ? (
        <MenuButton onClick={() => closeAfter(() => onQuickLook(entry))}>
          <Eye className="h-3.5 w-3.5" style={{ color: "#888" }} />
          Quick Look
        </MenuButton>
      ) : null}
      {!entry.is_directory ? (
        <MenuButton onClick={() => closeAfter(() => onExport(entry))}>
          <ArrowUp className="h-3.5 w-3.5 rotate-45" style={{ color: "#888" }} />
          Export...
        </MenuButton>
      ) : null}
      <MenuButton onClick={() => closeAfter(() => onCopyPath(entry.path))}>
        <FileText className="h-3.5 w-3.5" style={{ color: "#888" }} />
        Copy Path
      </MenuButton>
      <div className="my-1 border-t border-white/[0.08]" />
      <MenuButton danger onClick={() => closeAfter(() => onDelete(entry))}>
        <Trash2 className="h-3.5 w-3.5" />
        Move to Trash
      </MenuButton>
    </div>
  );
}
