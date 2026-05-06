import {
  File,
  FileCode,
  FileImage,
  FileJson,
  FileText,
  Folder,
  type LucideIcon,
} from "lucide-react";

export function getFileIcon(name: string, isDir: boolean): LucideIcon {
  if (isDir) return Folder;
  const ext = name.split(".").pop()?.toLowerCase() || "";
  if (["png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "bmp"].includes(ext)) {
    return FileImage;
  }
  if (
    ["js", "ts", "jsx", "tsx", "py", "rs", "go", "c", "cpp", "h", "rb", "sh", "bash", "zsh", "css", "html", "xml"].includes(ext)
  ) {
    return FileCode;
  }
  if (["json", "yaml", "yml", "toml"].includes(ext)) return FileJson;
  if (["md", "txt", "log", "csv", "rtf"].includes(ext)) return FileText;
  return File;
}

export function getFileColor(name: string, isDir: boolean): string {
  if (isDir) return "#54a3f7";
  const ext = name.split(".").pop()?.toLowerCase() || "";
  if (["png", "jpg", "jpeg", "gif", "svg", "webp"].includes(ext)) return "#e879a8";
  if (["js", "ts", "jsx", "tsx"].includes(ext)) return "#f0c94d";
  if (ext === "py") return "#5b9bd5";
  if (["json", "yaml", "yml", "toml"].includes(ext)) return "#a78bfa";
  if (["md", "txt"].includes(ext)) return "#8c8c8c";
  return "#8c8c8c";
}

export function FolderIcon({ size = 64, selected = false }: { size?: number; selected?: boolean }) {
  return (
    <svg viewBox="0 0 64 52" width={size} height={size * (52 / 64)} fill="none">
      <path
        d="M2 8C2 5.79 3.79 4 6 4H22L28 10H58C60.21 10 62 11.79 62 14V46C62 48.21 60.21 50 58 50H6C3.79 50 2 48.21 2 46V8Z"
        fill={selected ? "#4d94f7" : "#54a3f7"}
      />
      <path
        d="M2 14H62V46C62 48.21 60.21 50 58 50H6C3.79 50 2 48.21 2 46V14Z"
        fill={selected ? "#6ab0ff" : "#7ab8f5"}
      />
    </svg>
  );
}

export function DesktopFileIcon({
  icon: Icon,
  color,
  active = false,
}: {
  icon: LucideIcon;
  color: string;
  active?: boolean;
}) {
  return (
    <div className="relative h-14 w-12" aria-hidden="true">
      <div
        className="absolute inset-x-0 bottom-0 top-1 rounded-[12px] border"
        style={{
          background: active ? "rgba(244,248,255,0.98)" : "rgba(248,250,253,0.95)",
          borderColor: active ? "rgba(118,176,247,0.75)" : "rgba(207,215,226,0.92)",
          boxShadow: "0 12px 26px rgba(0,0,0,0.18)",
        }}
      />
      <div
        className="absolute right-0 top-1 h-4 w-4 rounded-bl-[10px] rounded-tr-[12px]"
        style={{
          background: active ? "rgba(214,231,255,0.95)" : "rgba(229,235,243,0.98)",
          borderLeft: "1px solid rgba(207,215,226,0.92)",
          borderBottom: "1px solid rgba(207,215,226,0.92)",
        }}
      />
      <Icon
        className="absolute left-1/2 top-[55%] h-6 w-6 -translate-x-1/2 -translate-y-1/2"
        style={{ color }}
        strokeWidth={1.9}
      />
    </div>
  );
}

export function DesktopImagePreviewIcon({
  src,
  active = false,
}: {
  src: string;
  active?: boolean;
}) {
  return (
    <div className="relative h-14 w-14" aria-hidden="true">
      <img
        src={src}
        alt=""
        draggable={false}
        className="absolute inset-0 h-full w-full rounded-[16px] object-cover"
        style={{
          boxShadow: active
            ? "0 0 0 1px rgba(122,184,245,0.8), 0 14px 28px rgba(0,0,0,0.24)"
            : "0 14px 28px rgba(0,0,0,0.2)",
        }}
      />
    </div>
  );
}
