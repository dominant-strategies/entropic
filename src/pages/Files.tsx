import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Store } from "@tauri-apps/plugin-store";
import {
  Folder,
  FileText,
  FileImage,
  FileCode,
  FileJson,
  File,
  ChevronLeft,
  ChevronRight,
  LayoutGrid,
  List,
  Trash2,
  Eye,
  Plus,
  X,
  ArrowUp,
  MessageSquare,
  Send,
  Loader2,
  Image,
} from "lucide-react";
import {
  getGatewayClient,
  createGatewayClient,
  type GatewayClient,
  type ChatEvent,
} from "../lib/gateway";
import { loadOnboardingData } from "../lib/profile";
import { WALLPAPERS, DEFAULT_WALLPAPER_ID, getWallpaperById } from "../lib/wallpapers";

type WorkspaceFileEntry = {
  name: string;
  path: string;
  is_directory: boolean;
  size: number;
  modified_at: number;
};

type Props = { gatewayRunning: boolean };
type ViewMode = "grid" | "list";
type ChatMessage = { id: string; role: "user" | "assistant"; content: string };

const HIDDEN_FILES = new Set(["HEARTBEAT.md", "IDENTITY.md", "SOUL.md", "TOOLS.md", "AGENTS.md", "USER.md"]);
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"]);
const BINARY_EXTS = new Set(["pdf", "zip", "xlsx", "xls", "docx", "pptx"]);
const GATEWAY_URL = "ws://127.0.0.1:19789";
const GATEWAY_TOKEN = "nova-local-gateway";

type PreviewState =
  | { kind: "text"; name: string; content: string }
  | { kind: "image"; name: string; dataUrl: string }
  | { kind: "binary"; name: string; size: number };

// ── Helpers ──────────────────────────────────────────────────────────

function formatSize(bytes: number): string {
  if (bytes === 0) return "Zero bytes";
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatDate(epochSec: number): string {
  if (!epochSec) return "\u2014";
  const d = new Date(epochSec * 1000);
  const now = new Date();
  if (d.toDateString() === now.toDateString())
    return `Today at ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString())
    return `Yesterday at ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
  return d.toLocaleDateString(undefined, {
    month: "short", day: "numeric",
    year: d.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
    hour: "numeric", minute: "2-digit",
  });
}

function getFileIcon(name: string, isDir: boolean) {
  if (isDir) return Folder;
  const ext = name.split(".").pop()?.toLowerCase() || "";
  if (["png","jpg","jpeg","gif","svg","webp","ico","bmp"].includes(ext)) return FileImage;
  if (["js","ts","jsx","tsx","py","rs","go","c","cpp","h","rb","sh","bash","zsh","css","html","xml"].includes(ext)) return FileCode;
  if (["json","yaml","yml","toml"].includes(ext)) return FileJson;
  if (["md","txt","log","csv","rtf"].includes(ext)) return FileText;
  return File;
}

function getFileColor(name: string, isDir: boolean): string {
  if (isDir) return "#54a3f7";
  const ext = name.split(".").pop()?.toLowerCase() || "";
  if (["png","jpg","jpeg","gif","svg","webp"].includes(ext)) return "#e879a8";
  if (["js","ts","jsx","tsx"].includes(ext)) return "#f0c94d";
  if (["py"].includes(ext)) return "#5b9bd5";
  if (["json","yaml","yml","toml"].includes(ext)) return "#a78bfa";
  if (["md","txt"].includes(ext)) return "#8c8c8c";
  return "#8c8c8c";
}

function FolderIcon({ size = 64, selected = false }: { size?: number; selected?: boolean }) {
  return (
    <svg viewBox="0 0 64 52" width={size} height={size * (52 / 64)} fill="none">
      <path d="M2 8C2 5.79 3.79 4 6 4H22L28 10H58C60.21 10 62 11.79 62 14V46C62 48.21 60.21 50 58 50H6C3.79 50 2 48.21 2 46V8Z" fill={selected ? "#4d94f7" : "#54a3f7"} />
      <path d="M2 14H62V46C62 48.21 60.21 50 58 50H6C3.79 50 2 48.21 2 46V14Z" fill={selected ? "#6ab0ff" : "#7ab8f5"} />
    </svg>
  );
}

// ═════════════════════════════════════════════════════════════════════
export function Files({ gatewayRunning }: Props) {
  const [agentName, setAgentName] = useState("Nova");

  // Wallpaper
  const [wallpaperId, setWallpaperId] = useState(DEFAULT_WALLPAPER_ID);
  const [customWallpaper, setCustomWallpaper] = useState<string | null>(null);
  const [showWallpaperPicker, setShowWallpaperPicker] = useState(false);
  const wallpaperInputRef = useRef<HTMLInputElement>(null);

  // Windows
  const [finderOpen, setFinderOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);

  // Finder drag
  const [finderPos, setFinderPos] = useState({ x: 30, y: 20 });
  const [finderSize, setFinderSize] = useState({ w: 680, h: 460 });
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);

  // Chat window drag
  const [chatPos, setChatPos] = useState({ x: 120, y: 40 });
  const chatDragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);

  // File browser
  const [entries, setEntries] = useState<WorkspaceFileEntry[]>([]);
  const [currentPath, setCurrentPath] = useState("");
  const [history, setHistory] = useState<string[]>([""]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [uploading, setUploading] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const [selected, setSelected] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; entry?: WorkspaceFileEntry } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Chat
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const [chatConnected, setChatConnected] = useState(false);
  const [chatConnecting, setChatConnecting] = useState(false);
  const chatClientRef = useRef<GatewayClient | null>(null);
  const chatSessionRef = useRef<string | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // ── Init ────────────────────────────────────────────────────────────

  useEffect(() => {
    loadOnboardingData().then((d) => {
      if (d?.agentName) setAgentName(d.agentName);
    });
    Store.load("nova-settings.json").then(async (s) => {
      const wp = (await s.get("desktopWallpaper")) as string | null;
      if (wp) setWallpaperId(wp);
      const cwp = (await s.get("desktopCustomWallpaper")) as string | null;
      if (cwp) setCustomWallpaper(cwp);
    }).catch(() => {});
  }, []);

  // Resize finder when container changes
  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver(([e]) => {
      const { width, height } = e.contentRect;
      setFinderSize({ w: Math.min(680, width - 60), h: Math.min(460, height - 80) });
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  async function saveWallpaper(id: string, custom?: string | null) {
    setWallpaperId(id);
    if (custom !== undefined) setCustomWallpaper(custom);
    try {
      const store = await Store.load("nova-settings.json");
      await store.set("desktopWallpaper", id);
      if (custom !== undefined) {
        if (custom) await store.set("desktopCustomWallpaper", custom);
        else await store.delete("desktopCustomWallpaper");
      }
      await store.save();
    } catch {}
  }

  function getWallpaperCss(): string {
    if (wallpaperId === "custom" && customWallpaper) return `url(${customWallpaper})`;
    return getWallpaperById(wallpaperId)?.css || WALLPAPERS[0].css;
  }

  async function handleCustomWallpaperUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]; if (!f) return; e.target.value = "";
    const reader = new FileReader();
    reader.onload = () => { saveWallpaper("custom", reader.result as string); setShowWallpaperPicker(false); };
    reader.readAsDataURL(f);
  }

  // ── Finder drag ─────────────────────────────────────────────────────

  function handleFinderDragStart(e: React.MouseEvent) {
    if ((e.target as HTMLElement).closest("button")) return;
    e.preventDefault();
    dragRef.current = { sx: e.clientX, sy: e.clientY, ox: finderPos.x, oy: finderPos.y };
    function onMove(ev: MouseEvent) {
      if (!dragRef.current) return;
      setFinderPos({
        x: Math.max(0, dragRef.current.ox + ev.clientX - dragRef.current.sx),
        y: Math.max(0, dragRef.current.oy + ev.clientY - dragRef.current.sy),
      });
    }
    function onUp() {
      dragRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  function handleChatDragStart(e: React.MouseEvent) {
    if ((e.target as HTMLElement).closest("button")) return;
    e.preventDefault();
    chatDragRef.current = { sx: e.clientX, sy: e.clientY, ox: chatPos.x, oy: chatPos.y };
    function onMove(ev: MouseEvent) {
      if (!chatDragRef.current) return;
      setChatPos({
        x: Math.max(0, chatDragRef.current.ox + ev.clientX - chatDragRef.current.sx),
        y: Math.max(0, chatDragRef.current.oy + ev.clientY - chatDragRef.current.sy),
      });
    }
    function onUp() {
      chatDragRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  // ── File browser logic ──────────────────────────────────────────────

  const fetchFiles = useCallback(async (path: string) => {
    setLoading(true); setError(null);
    try {
      const result = await invoke<WorkspaceFileEntry[]>("list_workspace_files", { path });
      const filtered = result.filter((e) => !(path === "" && HIDDEN_FILES.has(e.name)));
      filtered.sort((a, b) => a.is_directory !== b.is_directory ? (a.is_directory ? -1 : 1) : a.name.localeCompare(b.name));
      setEntries(filtered);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); setEntries([]); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { if (finderOpen) fetchFiles(currentPath); }, [currentPath, fetchFiles, finderOpen]);
  useEffect(() => { const h = () => setContextMenu(null); window.addEventListener("click", h); return () => window.removeEventListener("click", h); }, []);

  function openFolder(path: string) { setCurrentPath(path); setHistory([path]); setHistoryIndex(0); setFinderOpen(true); setSelected(null); }
  function navigateTo(path: string) { const h = history.slice(0, historyIndex + 1); h.push(path); setHistory(h); setHistoryIndex(h.length - 1); setCurrentPath(path); setSelected(null); }
  function goBack() { if (historyIndex > 0) { setHistoryIndex(historyIndex - 1); setCurrentPath(history[historyIndex - 1]); setSelected(null); } }
  function goForward() { if (historyIndex < history.length - 1) { setHistoryIndex(historyIndex + 1); setCurrentPath(history[historyIndex + 1]); setSelected(null); } }

  function handleEntryClick(entry: WorkspaceFileEntry, e: React.MouseEvent) { e.stopPropagation(); setSelected(entry.path); }
  function handleEntryDoubleClick(entry: WorkspaceFileEntry) { if (entry.is_directory) navigateTo(entry.path); else handleView(entry); }
  function handleContextMenuEntry(entry: WorkspaceFileEntry, e: React.MouseEvent) { e.preventDefault(); e.stopPropagation(); setSelected(entry.path); setContextMenu({ x: e.clientX, y: e.clientY, entry }); }

  async function handleView(entry: WorkspaceFileEntry) {
    const ext = entry.name.split(".").pop()?.toLowerCase() || "";
    try {
      if (IMAGE_EXTS.has(ext)) {
        const base64 = await invoke<string>("read_workspace_file_base64", { path: entry.path });
        const mime =
          ext === "svg"
            ? "image/svg+xml"
            : ext === "jpg" || ext === "jpeg"
              ? "image/jpeg"
              : `image/${ext}`;
        setPreview({ kind: "image", name: entry.name, dataUrl: `data:${mime};base64,${base64}` });
        return;
      }
      if (BINARY_EXTS.has(ext)) {
        setPreview({ kind: "binary", name: entry.name, size: entry.size });
        return;
      }
      const c = await invoke<string>("read_workspace_file", { path: entry.path });
      setPreview({ kind: "text", name: entry.name, content: c });
    } catch (e) {
      setError(`Failed to read: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function handleDelete(entry: WorkspaceFileEntry) {
    if (!confirm(`Move "${entry.name}" to Trash?`)) return;
    try { await invoke("delete_workspace_file", { path: entry.path }); setSelected(null); fetchFiles(currentPath); }
    catch (e) { setError(`Delete failed: ${e instanceof Error ? e.message : String(e)}`); }
  }

  async function handleCreateFolder() {
    const name = prompt("New folder name:"); if (!name?.trim()) return;
    try { const p = currentPath ? `${currentPath}/${name.trim()}` : name.trim(); await invoke<WorkspaceFileEntry[]>("list_workspace_files", { path: p }); fetchFiles(currentPath); }
    catch (e) { setError(`Failed to create folder: ${e instanceof Error ? e.message : String(e)}`); }
  }

  // ── Drag & Drop files ───────────────────────────────────────────────

  function handleDragOver(e: React.DragEvent) { e.preventDefault(); e.stopPropagation(); if (e.dataTransfer.types.includes("Files")) { setDragOver(true); e.dataTransfer.dropEffect = "copy"; } }
  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault(); e.stopPropagation();
    const rect = containerRef.current?.getBoundingClientRect();
    if (rect) { const { clientX: cx, clientY: cy } = e; if (cx < rect.left || cx > rect.right || cy < rect.top || cy > rect.bottom) setDragOver(false); }
  }

  async function uploadFiles(files: globalThis.File[], destPath: string) {
    setUploading(true); setError(null);
    try {
      for (const file of files) {
        const buf = await file.arrayBuffer(); const bytes = new Uint8Array(buf);
        let binary = ""; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
        await invoke("upload_workspace_file", { fileName: file.name, base64: btoa(binary), destPath });
      }
      if (finderOpen) fetchFiles(currentPath);
    } catch (err) { setError(`Upload failed: ${err instanceof Error ? err.message : String(err)}`); }
    finally { setUploading(false); }
  }

  async function handleDrop(e: React.DragEvent) { e.preventDefault(); e.stopPropagation(); setDragOver(false); const f = Array.from(e.dataTransfer.files); if (f.length > 0) uploadFiles(f, finderOpen ? currentPath : ""); }
  async function handleFileInputChange(e: React.ChangeEvent<HTMLInputElement>) { const f = e.target.files?.[0]; if (!f) return; e.target.value = ""; uploadFiles([f], finderOpen ? currentPath : ""); }

  // ── Chat ────────────────────────────────────────────────────────────

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [chatMessages, chatLoading]);

  useEffect(() => {
    if (!chatOpen || !gatewayRunning) return;
    const existing = getGatewayClient();
    if (existing?.isConnected()) { chatClientRef.current = existing; setChatConnected(true); if (!chatSessionRef.current) chatSessionRef.current = existing.createSessionKey(); return; }
    let cancelled = false;
    (async () => {
      setChatConnecting(true);
      try {
        const client = createGatewayClient(GATEWAY_URL, GATEWAY_TOKEN);
        client.on("connected", () => { if (cancelled) return; chatClientRef.current = client; setChatConnected(true); setChatConnecting(false); if (!chatSessionRef.current) chatSessionRef.current = client.createSessionKey(); });
        client.on("disconnected", () => { if (!cancelled) setChatConnected(false); });
        client.on("chat", (ev: ChatEvent) => { if (!cancelled) handleChatEvent(ev); });
        await client.connect();
      } catch { if (!cancelled) setChatConnecting(false); }
    })();
    return () => { cancelled = true; };
  }, [chatOpen, gatewayRunning]);

  function handleChatEvent(event: ChatEvent) {
    if (event.state === "delta" || event.state === "final") {
      const text = event.message?.content?.filter((c: { type: string }) => c.type === "text").map((c: { type: string; text: string }) => c.text).join("") || "";
      if (!text) return;
      setChatMessages((prev) => { const idx = prev.findIndex((m) => m.id === event.runId && m.role === "assistant"); if (idx >= 0) { const u = [...prev]; u[idx] = { ...u[idx], content: text }; return u; } return [...prev, { id: event.runId, role: "assistant", content: text }]; });
      if (event.state === "final") setChatLoading(false);
    } else if (event.state === "error" || event.state === "aborted") setChatLoading(false);
  }

  async function handleChatSend() {
    const text = chatInput.trim();
    if (!text || !chatClientRef.current?.isConnected() || !chatSessionRef.current || chatLoading) return;
    const fileList = entries.map((e) => `${e.is_directory ? "[folder]" : "[file]"} ${e.name}`).join("\n");
    const ctx = `[File context — current directory: /${currentPath || "workspace"}, ${entries.length} items]\n${fileList}\n\nUser question: ${text}`;
    setChatMessages((prev) => [...prev, { id: crypto.randomUUID(), role: "user", content: text }]);
    setChatInput(""); setChatLoading(true);
    try { await chatClientRef.current.sendMessage(chatSessionRef.current, ctx); } catch { setChatLoading(false); }
  }

  // ── Computed ─────────────────────────────────────────────────────────

  const pathSegments = currentPath.split("/").filter(Boolean);
  const folderName = pathSegments.length > 0 ? pathSegments[pathSegments.length - 1] : "Workspace";
  const itemCount = entries.length;
  const wallpaperCss = getWallpaperCss();
  const currentWp = getWallpaperById(wallpaperId);
  const isWpImage = (wallpaperId === "custom" && customWallpaper) || currentWp?.type === "photo";

  // ═══════════════════════════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════════════════════════

  return (
    <div className="h-full flex flex-col select-none relative overflow-hidden">
      {/* Main area */}
      <div className="flex-1 flex overflow-hidden">

        {/* Desktop area */}
        <div
          ref={containerRef}
          className="flex-1 relative overflow-hidden"
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onContextMenu={(e) => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY }); }}
          onClick={() => { setSelected(null); setContextMenu(null); setShowWallpaperPicker(false); }}
        >
          {/* Wallpaper */}
          <div className="absolute inset-0" style={isWpImage ? { backgroundImage: wallpaperCss, backgroundSize: "cover", backgroundPosition: "center" } : { background: wallpaperCss }} />

          {/* Desktop icons */}
          <div className="relative flex-1 p-6 flex flex-col items-start gap-2 h-full">
            <div
              className="flex flex-col items-center w-20 p-2 rounded-xl cursor-default transition-all"
              style={{ background: selected === "__user_folder" ? "rgba(255,255,255,0.18)" : "transparent" }}
              onClick={(e) => { e.stopPropagation(); setSelected("__user_folder"); }}
              onDoubleClick={() => openFolder("")}
            >
              <FolderIcon size={56} selected={selected === "__user_folder"} />
              <span className="text-[11px] text-center leading-tight mt-1 w-full truncate" style={{ color: "white", textShadow: "0 1px 3px rgba(0,0,0,0.6)", fontWeight: selected === "__user_folder" ? 600 : 400 }}>
                {agentName}&apos;s Files
              </span>
            </div>
          </div>

          {/* Drag overlay */}
          {dragOver && (
            <div className="absolute inset-0 z-20 flex items-center justify-center pointer-events-none animate-fade-in" style={{ background: "rgba(0,0,0,0.3)", backdropFilter: "blur(8px)" }}>
              <div className="rounded-3xl px-16 py-12 text-center" style={{ border: "3px dashed rgba(255,255,255,0.7)", background: "rgba(255,255,255,0.08)", boxShadow: "0 0 80px rgba(147,51,234,0.12)" }}>
                <div className="w-20 h-20 mx-auto mb-4 rounded-2xl flex items-center justify-center" style={{ background: "rgba(255,255,255,0.12)" }}>
                  <ArrowUp className="w-10 h-10 animate-bounce" style={{ color: "white" }} />
                </div>
                <p className="text-xl font-semibold" style={{ color: "white", textShadow: "0 2px 8px rgba(0,0,0,0.4)" }}>Drop files to upload</p>
                <p className="text-sm mt-2" style={{ color: "rgba(255,255,255,0.7)" }}>Files will be added to your workspace</p>
              </div>
            </div>
          )}

          {/* Upload spinner */}
          {uploading && (
            <div className="absolute inset-0 z-[60] flex items-center justify-center" style={{ background: "rgba(0,0,0,0.3)", backdropFilter: "blur(4px)" }}>
              <div className="text-center">
                <div className="w-10 h-10 rounded-full border-2 border-white border-t-transparent animate-spin mx-auto mb-3" />
                <p className="text-sm font-medium text-white">Uploading...</p>
              </div>
            </div>
          )}

          {/* ── FLOATING FINDER WINDOW (draggable) ────────────────────── */}
          {finderOpen && (
            <div
              className="absolute z-30 flex flex-col rounded-xl overflow-hidden animate-scale-in"
              style={{
                top: finderPos.y, left: finderPos.x,
                width: finderSize.w, height: finderSize.h,
                boxShadow: "0 22px 70px 4px rgba(0,0,0,0.56), 0 0 0 0.5px rgba(255,255,255,0.1)",
                border: "0.5px solid rgba(255,255,255,0.08)",
              }}
              onClick={(e) => e.stopPropagation()}
            >
              {/* Title bar — drag handle */}
              <div
                className="flex items-center px-3 py-2 flex-shrink-0 relative cursor-grab active:cursor-grabbing"
                style={{ background: "#2d2d2d", borderBottom: "1px solid #1a1a1a" }}
                onMouseDown={handleFinderDragStart}
              >
                <div className="flex items-center gap-2 z-10">
                  <button onClick={() => setFinderOpen(false)} className="w-3 h-3 rounded-full hover:opacity-80 group relative" style={{ background: "#ff5f57" }} title="Close">
                    <X className="w-2 h-2 absolute inset-0.5 opacity-0 group-hover:opacity-100 text-black/60" />
                  </button>
                  <div className="w-3 h-3 rounded-full" style={{ background: "#febc2e" }} />
                  <div className="w-3 h-3 rounded-full" style={{ background: "#28c840" }} />
                </div>
                <div className="flex items-center gap-0.5 ml-3 z-10">
                  <button onClick={goBack} disabled={historyIndex <= 0} className="p-1 rounded disabled:opacity-30 hover:bg-white/10"><ChevronLeft className="w-3.5 h-3.5" style={{ color: "#aaa" }} /></button>
                  <button onClick={goForward} disabled={historyIndex >= history.length - 1} className="p-1 rounded disabled:opacity-30 hover:bg-white/10"><ChevronRight className="w-3.5 h-3.5" style={{ color: "#aaa" }} /></button>
                </div>
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                  <div className="flex items-center gap-2">
                    {currentPath && <button onClick={() => navigateTo(pathSegments.slice(0, -1).join("/"))} className="pointer-events-auto p-0.5 rounded hover:bg-white/10"><ArrowUp className="w-3 h-3" style={{ color: "#888" }} /></button>}
                    <Folder className="w-3.5 h-3.5" style={{ color: "#54a3f7" }} />
                    <span className="text-xs font-medium" style={{ color: "#ccc" }}>{folderName}</span>
                  </div>
                </div>
                <div className="flex items-center gap-0.5 ml-auto z-10">
                  <button onClick={() => setViewMode("grid")} className="p-1 rounded" style={{ color: viewMode === "grid" ? "#fff" : "#666", background: viewMode === "grid" ? "rgba(255,255,255,0.1)" : "transparent" }}><LayoutGrid className="w-3.5 h-3.5" /></button>
                  <button onClick={() => setViewMode("list")} className="p-1 rounded" style={{ color: viewMode === "list" ? "#fff" : "#666", background: viewMode === "list" ? "rgba(255,255,255,0.1)" : "transparent" }}><List className="w-3.5 h-3.5" /></button>
                  <div className="w-px h-3.5 mx-1" style={{ background: "rgba(255,255,255,0.1)" }} />
                  <button onClick={handleCreateFolder} className="p-1 rounded hover:bg-white/10"><Plus className="w-3.5 h-3.5" style={{ color: "#aaa" }} /></button>
                </div>
              </div>

              {/* Path bar */}
              <div className="flex items-center gap-0.5 px-3 py-1 text-[11px] flex-shrink-0 overflow-x-auto" style={{ background: "#252526", borderBottom: "1px solid #1a1a1a", color: "#888" }}>
                <button onClick={() => navigateTo("")} className="px-1.5 py-0.5 rounded hover:bg-white/10 flex-shrink-0" style={{ color: pathSegments.length === 0 ? "#ddd" : "#888" }}>Workspace</button>
                {pathSegments.map((seg, i) => {
                  const segPath = pathSegments.slice(0, i + 1).join("/");
                  return (
                    <span key={segPath} className="flex items-center gap-0.5 flex-shrink-0">
                      <ChevronRight className="w-3 h-3" style={{ color: "#555" }} />
                      <button onClick={() => navigateTo(segPath)} className="px-1.5 py-0.5 rounded hover:bg-white/10" style={{ color: i === pathSegments.length - 1 ? "#ddd" : "#888" }}>{seg}</button>
                    </span>
                  );
                })}
              </div>

              {/* File area */}
              <div
                className="flex-1 overflow-auto relative"
                onClick={() => { setSelected(null); setContextMenu(null); }}
                onDragOver={handleDragOver}
                onDrop={handleDrop}
                style={{ background: "#1e1e1e" }}
              >
                {loading && entries.length === 0 ? (
                  <div className="flex items-center justify-center h-full"><div className="text-center"><div className="w-8 h-8 rounded-full border-2 border-t-transparent animate-spin mx-auto mb-3" style={{ borderColor: "#555", borderTopColor: "transparent" }} /><p className="text-xs" style={{ color: "#888" }}>Loading...</p></div></div>
                ) : entries.length === 0 ? (
                  <div className="flex items-center justify-center h-full"><div className="text-center max-w-xs"><Folder className="w-16 h-16 mx-auto mb-4" style={{ color: "#54a3f7", opacity: 0.3 }} /><p className="text-sm font-medium mb-1" style={{ color: "#ddd" }}>This folder is empty</p><p className="text-xs mb-4" style={{ color: "#888" }}>Drag files here or click + to add</p><button onClick={() => fileInputRef.current?.click()} className="text-xs px-4 py-2 rounded-lg" style={{ background: "rgba(255,255,255,0.1)", color: "#ccc" }}>Choose Files</button></div></div>
                ) : viewMode === "grid" ? (
                  <div className="p-3 grid gap-1" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(84px, 1fr))" }}>
                    {entries.map((entry) => {
                      const Icon = getFileIcon(entry.name, entry.is_directory);
                      const iconColor = getFileColor(entry.name, entry.is_directory);
                      const isSel = selected === entry.path;
                      return (
                        <div key={entry.path} className="flex flex-col items-center p-2 rounded-lg cursor-default" style={{ background: isSel ? "rgba(59,130,246,0.2)" : "transparent" }} onClick={(e) => handleEntryClick(entry, e)} onDoubleClick={() => handleEntryDoubleClick(entry)} onContextMenu={(e) => handleContextMenuEntry(entry, e)}>
                          {entry.is_directory ? <div className="w-11 h-11 flex items-center justify-center mb-1"><FolderIcon size={44} selected={isSel} /></div> : <div className="w-11 h-11 flex items-center justify-center mb-1"><Icon className="w-8 h-8" style={{ color: iconColor }} strokeWidth={1.2} /></div>}
                          <span className="text-[10px] text-center leading-tight w-full px-0.5" style={{ color: isSel ? "#fff" : "#ccc", fontWeight: isSel ? 500 : 400, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", wordBreak: "break-all" }}>{entry.name}</span>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="flex flex-col">
                    <div className="flex items-center gap-3 px-4 py-1.5 text-[11px] font-medium sticky top-0 z-10" style={{ color: "#888", background: "#252526", borderBottom: "1px solid #1a1a1a" }}><span className="flex-1">Name</span><span className="w-28 text-right">Date Modified</span><span className="w-20 text-right">Size</span></div>
                    {entries.map((entry) => {
                      const Icon = getFileIcon(entry.name, entry.is_directory);
                      const iconColor = getFileColor(entry.name, entry.is_directory);
                      const isSel = selected === entry.path;
                      return (
                        <div key={entry.path} className="flex items-center gap-3 px-4 py-1.5 cursor-default" style={{ background: isSel ? "rgba(59,130,246,0.15)" : "transparent", borderBottom: "1px solid #2a2a2a" }} onClick={(e) => handleEntryClick(entry, e)} onDoubleClick={() => handleEntryDoubleClick(entry)} onContextMenu={(e) => handleContextMenuEntry(entry, e)}>
                          <Icon className="w-4 h-4 flex-shrink-0" style={{ color: iconColor }} />
                          <span className="flex-1 text-xs truncate" style={{ color: isSel ? "#fff" : "#ccc", fontWeight: isSel ? 500 : 400 }}>{entry.name}</span>
                          <span className="w-28 text-right text-[11px]" style={{ color: "#666" }}>{formatDate(entry.modified_at)}</span>
                          <span className="w-20 text-right text-[11px]" style={{ color: "#666" }}>{entry.is_directory ? "\u2014" : formatSize(entry.size)}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Status bar */}
              <div className="flex items-center justify-between px-3 py-1 flex-shrink-0 text-[11px]" style={{ background: "#252526", borderTop: "1px solid #1a1a1a", color: "#888" }}>
                <span>{itemCount} item{itemCount !== 1 ? "s" : ""}</span>
                <button onClick={() => fileInputRef.current?.click()} className="hover:underline" style={{ color: "#aaa" }}>Add files...</button>
              </div>
            </div>
          )}

          {/* Context menus */}
          {contextMenu && !contextMenu.entry && (
            <div className="fixed z-50 py-1 rounded-lg min-w-[180px] animate-fade-in" style={{ left: contextMenu.x, top: contextMenu.y, background: "rgba(30,30,30,0.9)", backdropFilter: "blur(20px)", border: "1px solid rgba(255,255,255,0.1)", boxShadow: "0 8px 32px rgba(0,0,0,0.4)" }} onClick={(e) => e.stopPropagation()}>
              <button className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-white/10 text-left text-white/80" onClick={() => { setShowWallpaperPicker(true); setContextMenu(null); }}><Image className="w-3.5 h-3.5" />Change Wallpaper</button>
              <button className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-white/10 text-left text-white/80" onClick={() => { fileInputRef.current?.click(); setContextMenu(null); }}><Plus className="w-3.5 h-3.5" />Add Files</button>
              <button className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-white/10 text-left text-white/80" onClick={() => { openFolder(""); setContextMenu(null); }}><Folder className="w-3.5 h-3.5" />Open Workspace</button>
            </div>
          )}
          {contextMenu && contextMenu.entry && (
            <div className="fixed z-[55] py-1 rounded-lg min-w-[160px] animate-fade-in" style={{ left: contextMenu.x, top: contextMenu.y, background: "rgba(30,30,30,0.95)", backdropFilter: "blur(20px)", border: "1px solid rgba(255,255,255,0.1)", boxShadow: "0 8px 32px rgba(0,0,0,0.5)" }} onClick={(e) => e.stopPropagation()}>
              {!contextMenu.entry.is_directory && <button className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-white/10 text-left text-white/80" onClick={() => { handleView(contextMenu.entry!); setContextMenu(null); }}><Eye className="w-3.5 h-3.5" style={{ color: "#888" }} />Quick Look</button>}
              {contextMenu.entry.is_directory && <button className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-white/10 text-left text-white/80" onClick={() => { navigateTo(contextMenu.entry!.path); setContextMenu(null); }}><Folder className="w-3.5 h-3.5" style={{ color: "#888" }} />Open</button>}
              <div className="my-1" style={{ borderTop: "1px solid rgba(255,255,255,0.08)" }} />
              <button className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-white/10 text-left" style={{ color: "#ff5f57" }} onClick={() => { handleDelete(contextMenu.entry!); setContextMenu(null); }}><Trash2 className="w-3.5 h-3.5" />Move to Trash</button>
            </div>
          )}

          {/* Wallpaper picker */}
          {showWallpaperPicker && (
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-40 p-4 rounded-xl animate-fade-in" style={{ background: "rgba(20,20,20,0.92)", backdropFilter: "blur(20px)", border: "1px solid rgba(255,255,255,0.1)", boxShadow: "0 12px 40px rgba(0,0,0,0.5)" }} onClick={(e) => e.stopPropagation()}>
              <p className="text-xs font-medium mb-2" style={{ color: "rgba(255,255,255,0.6)" }}>Scenic</p>
              <div className="grid grid-cols-4 gap-2 mb-3">
                {WALLPAPERS.filter((wp) => wp.type === "photo").map((wp) => (
                  <button key={wp.id} onClick={() => { saveWallpaper(wp.id, null); setShowWallpaperPicker(false); }} className="w-16 h-10 rounded-lg hover:scale-105 transition-transform overflow-hidden" style={{ backgroundImage: wp.thumbnail ? `url(${wp.thumbnail})` : wp.css, backgroundSize: "cover", backgroundPosition: "center", border: wallpaperId === wp.id ? "2px solid white" : "2px solid transparent", boxShadow: wallpaperId === wp.id ? "0 0 0 1px rgba(255,255,255,0.3)" : "none" }} title={wp.label} />
                ))}
              </div>
              <p className="text-xs font-medium mb-2" style={{ color: "rgba(255,255,255,0.6)" }}>Gradients</p>
              <div className="grid grid-cols-4 gap-2">
                {WALLPAPERS.filter((wp) => wp.type === "gradient").map((wp) => (
                  <button key={wp.id} onClick={() => { saveWallpaper(wp.id, null); setShowWallpaperPicker(false); }} className="w-16 h-10 rounded-lg hover:scale-105 transition-transform" style={{ background: wp.css, border: wallpaperId === wp.id ? "2px solid white" : "2px solid transparent", boxShadow: wallpaperId === wp.id ? "0 0 0 1px rgba(255,255,255,0.3)" : "none" }} title={wp.label} />
                ))}
                <button onClick={() => wallpaperInputRef.current?.click()} className="w-16 h-10 rounded-lg flex items-center justify-center hover:scale-105 transition-transform" style={{ background: customWallpaper ? `url(${customWallpaper})` : "rgba(255,255,255,0.1)", backgroundSize: "cover", backgroundPosition: "center", border: wallpaperId === "custom" ? "2px solid white" : "2px solid transparent" }} title="Custom">{!customWallpaper && <Image className="w-4 h-4" style={{ color: "rgba(255,255,255,0.4)" }} />}</button>
              </div>
              <input ref={wallpaperInputRef} type="file" accept="image/*" className="hidden" onChange={handleCustomWallpaperUpload} />
            </div>
          )}

          {/* File viewer */}
          {preview !== null && (() => {
            const ext = preview.name.split(".").pop()?.toLowerCase() || "";
            const isCode = ["js","ts","jsx","tsx","py","rs","go","c","cpp","h","rb","sh","bash","zsh","css","html","xml","json","yaml","yml","toml","sql","java","kt","swift","php","lua","r","pl","ex","exs","hs","ml","scala","clj","dart","vue","svelte"].includes(ext);
            const isMd = ext === "md";
            const Icon = getFileIcon(preview.name, false);
            const iconColor = getFileColor(preview.name, false);
            const lines = preview.kind === "text" ? preview.content.split("\n") : [];
            const lnw = String(lines.length || 1).length;
            return (
              <div className="absolute inset-0 z-[50] flex items-center justify-center" style={{ background: "rgba(0,0,0,0.45)" }} onClick={() => setPreview(null)}>
                <div className="w-full max-w-3xl mx-6 max-h-[85vh] flex flex-col rounded-xl overflow-hidden animate-fade-in" style={{ boxShadow: "0 22px 70px 4px rgba(0,0,0,0.56)" }} onClick={(e) => e.stopPropagation()}>
                  <div className="flex items-center px-3 py-2.5 flex-shrink-0 relative" style={{ background: "#2d2d2d", borderBottom: "1px solid #1a1a1a" }}>
                    <div className="flex items-center gap-2 z-10">
                      <button onClick={() => setPreview(null)} className="w-3 h-3 rounded-full hover:opacity-80 group relative" style={{ background: "#ff5f57" }}><X className="w-2 h-2 absolute inset-0.5 opacity-0 group-hover:opacity-100 text-black/60" /></button>
                      <div className="w-3 h-3 rounded-full" style={{ background: "#febc2e" }} /><div className="w-3 h-3 rounded-full" style={{ background: "#28c840" }} />
                    </div>
                    <div className="absolute inset-0 flex items-center justify-center pointer-events-none"><div className="flex items-center gap-2"><Icon className="w-3.5 h-3.5" style={{ color: iconColor }} /><span className="text-xs font-medium" style={{ color: "#ccc" }}>{preview.name}</span></div></div>
                  </div>
                  <div className="flex-1 overflow-auto" style={{ background: preview.kind === "text" && (isCode || isMd) ? "#1e1e1e" : "#252526" }}>
                    {preview.kind === "image" && (
                      <div className="p-4 flex items-center justify-center">
                        <img
                          src={preview.dataUrl}
                          alt={preview.name}
                          className="max-w-full max-h-[70vh] rounded-lg shadow-lg"
                        />
                      </div>
                    )}
                    {preview.kind === "binary" && (
                      <div className="p-6 text-sm" style={{ color: "#d4d4d4" }}>
                        <p className="font-medium mb-2">Preview not available</p>
                        <p>This file type isn’t viewable yet.</p>
                        <p className="text-xs mt-2" style={{ color: "#888" }}>
                          {preview.name} · {formatSize(preview.size)}
                        </p>
                      </div>
                    )}
                    {preview.kind === "text" && (
                      (isCode || isMd) ? (
                        <div className="flex text-[13px] font-mono leading-[1.6]">
                          <div className="flex-shrink-0 text-right select-none py-3 pr-3 sticky left-0" style={{ color: "#858585", background: "#1e1e1e", paddingLeft: "12px", minWidth: `${lnw * 0.65 + 1.8}em`, borderRight: "1px solid #2d2d2d" }}>{lines.map((_, i) => <div key={i}>{i + 1}</div>)}</div>
                          <pre className="flex-1 py-3 px-4 whitespace-pre-wrap break-words" style={{ color: "#d4d4d4", tabSize: 4 }}>{preview.content}</pre>
                        </div>
                      ) : (
                        <pre className="p-5 text-[13px] font-mono whitespace-pre-wrap break-words leading-relaxed" style={{ color: "#d4d4d4" }}>{preview.content}</pre>
                      )
                    )}
                  </div>
                  <div className="flex items-center justify-between px-3 py-1 flex-shrink-0 text-[11px]" style={{ background: "#007acc", color: "rgba(255,255,255,0.9)" }}>
                    <span>{ext.toUpperCase() || "TXT"}</span>
                    {preview.kind === "text" ? (
                      <span>{lines.length} lines · {formatSize(new Blob([preview.content]).size)}</span>
                    ) : preview.kind === "image" ? (
                      <span>Image preview</span>
                    ) : (
                      <span>{formatSize(preview.size)}</span>
                    )}
                  </div>
                </div>
              </div>
            );
          })()}

          {/* Error toast */}
          {error && (
            <div className="absolute top-4 left-1/2 -translate-x-1/2 z-[70] flex items-center gap-2 px-4 py-2 rounded-lg text-xs animate-fade-in" style={{ background: "rgba(220,38,38,0.9)", color: "white", backdropFilter: "blur(8px)", boxShadow: "0 4px 20px rgba(0,0,0,0.3)" }} onClick={(e) => e.stopPropagation()}>
              <span className="flex-1">{error}</span>
              <button onClick={() => setError(null)} className="font-medium underline">Dismiss</button>
            </div>
          )}

          {/* ── FLOATING CHAT WINDOW (draggable) ────────────────────── */}
          {chatOpen && (
            <div
              className="absolute z-30 flex flex-col rounded-xl overflow-hidden animate-scale-in"
              style={{
                top: chatPos.y, left: chatPos.x,
                width: 360, height: 420,
                boxShadow: "0 22px 70px 4px rgba(0,0,0,0.56), 0 0 0 0.5px rgba(255,255,255,0.1)",
                border: "0.5px solid rgba(255,255,255,0.08)",
              }}
              onClick={(e) => e.stopPropagation()}
            >
              {/* Title bar — drag handle */}
              <div
                className="flex items-center px-3 py-2 flex-shrink-0 relative cursor-grab active:cursor-grabbing"
                style={{ background: "#2d2d2d", borderBottom: "1px solid #1a1a1a" }}
                onMouseDown={handleChatDragStart}
              >
                <div className="flex items-center gap-2 z-10">
                  <button onClick={() => setChatOpen(false)} className="w-3 h-3 rounded-full hover:opacity-80 group relative" style={{ background: "#ff5f57" }} title="Close">
                    <X className="w-2 h-2 absolute inset-0.5 opacity-0 group-hover:opacity-100 text-black/60" />
                  </button>
                  <div className="w-3 h-3 rounded-full" style={{ background: "#febc2e" }} />
                  <div className="w-3 h-3 rounded-full" style={{ background: "#28c840" }} />
                </div>
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                  <div className="flex items-center gap-2">
                    <MessageSquare className="w-3.5 h-3.5" style={{ color: "#5be579" }} />
                    <span className="text-xs font-medium" style={{ color: "#ccc" }}>Chat</span>
                    {!chatConnected && !chatConnecting && <span className="text-[10px] px-1.5 py-0.5 rounded-full" style={{ background: "rgba(255,255,255,0.1)", color: "#888" }}>offline</span>}
                  </div>
                </div>
              </div>

              {/* Messages */}
              <div className="flex-1 overflow-auto p-3 space-y-2" style={{ background: "#1e1e1e" }}>
                {chatMessages.length === 0 && !chatLoading && (
                  <div className="flex items-center justify-center h-full">
                    <div className="text-center px-4">
                      <MessageSquare className="w-8 h-8 mx-auto mb-2" style={{ color: "#555", opacity: 0.3 }} />
                      <p className="text-xs" style={{ color: "#888" }}>Ask questions about your files</p>
                      <p className="text-[10px] mt-1" style={{ color: "#666" }}>e.g. "What's in config.json?"</p>
                    </div>
                  </div>
                )}
                {chatMessages.map((msg) => (
                  <div key={msg.id} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                    <div className="max-w-[85%] px-3 py-2 rounded-xl text-xs" style={msg.role === "user" ? { background: "#7c3aed", color: "white" } : { background: "#2d2d2d", color: "#d4d4d4" }}>
                      <p className="whitespace-pre-wrap leading-relaxed">{msg.content}</p>
                    </div>
                  </div>
                ))}
                {chatLoading && <div className="flex justify-start"><div className="px-3 py-2 rounded-xl" style={{ background: "#2d2d2d" }}><Loader2 className="w-4 h-4 animate-spin" style={{ color: "#888" }} /></div></div>}
                <div ref={chatEndRef} />
              </div>

              {/* Input */}
              <div className="flex items-center gap-2 px-3 py-2 flex-shrink-0" style={{ background: "#252526", borderTop: "1px solid #1a1a1a" }}>
                <input
                  type="text"
                  className="flex-1 text-xs px-3 py-1.5 rounded-md outline-none"
                  style={{ background: "#1e1e1e", color: "#d4d4d4", border: "1px solid #3a3a3a" }}
                  placeholder={chatConnected ? "Ask about these files..." : "Connecting..."}
                  value={chatInput}
                  disabled={!chatConnected || chatLoading}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleChatSend(); } }}
                />
                <button onClick={handleChatSend} disabled={!chatInput.trim() || !chatConnected || chatLoading} className="p-1.5 rounded-md disabled:opacity-40" style={{ background: "#7c3aed" }}><Send className="w-3.5 h-3.5 text-white" /></button>
              </div>
            </div>
          )}

          {/* ── FLOATING DOCK ─────────────────────────────────────────── */}
          <div
            className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 flex items-end justify-center gap-2 px-2.5 py-1.5 rounded-[22px]"
            style={{
              background: "rgba(255,255,255,0.18)",
              backdropFilter: "blur(40px)",
              WebkitBackdropFilter: "blur(40px)",
              border: "1px solid rgba(255,255,255,0.25)",
              boxShadow: "0 8px 32px rgba(0,0,0,0.35), inset 0 0.5px 0 rgba(255,255,255,0.2)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Finder */}
            <button
              onClick={() => { if (!finderOpen) { setFinderOpen(true); fetchFiles(currentPath || ""); } else { setFinderOpen(false); } }}
              className="group flex flex-col items-center"
              title="Finder"
            >
              <div
                className="w-12 h-12 rounded-[14px] flex items-center justify-center transition-all duration-200 group-hover:scale-[1.15] group-hover:-translate-y-2.5"
                style={{ background: "linear-gradient(180deg, #4dc7f0 0%, #1a9ad7 100%)", boxShadow: "0 3px 10px rgba(26,154,215,0.4)" }}
              >
                <Folder className="w-6 h-6 text-white" />
              </div>
              <div className={`w-1 h-1 rounded-full mt-1 transition-opacity ${finderOpen ? "bg-white/80" : "opacity-0"}`} />
            </button>

            {/* Chat */}
            <button
              onClick={() => setChatOpen(!chatOpen)}
              className="group flex flex-col items-center"
              title="Chat"
            >
              <div
                className="w-12 h-12 rounded-[14px] flex items-center justify-center transition-all duration-200 group-hover:scale-[1.15] group-hover:-translate-y-2.5"
                style={{ background: "linear-gradient(180deg, #5be579 0%, #32b350 100%)", boxShadow: "0 3px 10px rgba(50,179,80,0.4)" }}
              >
                <MessageSquare className="w-6 h-6 text-white" />
              </div>
              <div className={`w-1 h-1 rounded-full mt-1 transition-opacity ${chatOpen ? "bg-white/80" : "opacity-0"}`} />
            </button>

            <div className="w-px self-stretch my-1.5 mx-0.5" style={{ background: "rgba(255,255,255,0.25)" }} />

            {/* Wallpaper */}
            <button
              onClick={() => setShowWallpaperPicker(!showWallpaperPicker)}
              className="group flex flex-col items-center"
              title="Change Wallpaper"
            >
              <div
                className="w-12 h-12 rounded-[14px] flex items-center justify-center transition-all duration-200 group-hover:scale-[1.15] group-hover:-translate-y-2.5"
                style={{ background: "linear-gradient(180deg, #c084fc 0%, #9333ea 100%)", boxShadow: "0 3px 10px rgba(147,51,234,0.4)" }}
              >
                <Image className="w-6 h-6 text-white" />
              </div>
              <div className="w-1 h-1 rounded-full mt-1 opacity-0" />
            </button>

            {/* Add Files */}
            <button
              onClick={() => fileInputRef.current?.click()}
              className="group flex flex-col items-center"
              title="Add Files"
            >
              <div
                className="w-12 h-12 rounded-[14px] flex items-center justify-center transition-all duration-200 group-hover:scale-[1.15] group-hover:-translate-y-2.5"
                style={{ background: "linear-gradient(180deg, #fbbf24 0%, #f59e0b 100%)", boxShadow: "0 3px 10px rgba(245,158,11,0.4)" }}
              >
                <Plus className="w-6 h-6 text-white" />
              </div>
              <div className="w-1 h-1 rounded-full mt-1 opacity-0" />
            </button>

            <input ref={fileInputRef} type="file" className="hidden" onChange={handleFileInputChange} multiple />
          </div>
        </div>
      </div>

    </div>
  );
}
