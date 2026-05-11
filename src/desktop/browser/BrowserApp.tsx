import type {
  ClipboardEvent as ReactClipboardEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  RefObject,
  WheelEvent as ReactWheelEvent,
} from "react";
import { ArrowUp, ChevronLeft, ChevronRight, Globe, Loader2, Plus, X } from "lucide-react";
import { AppWindow } from "../AppWindow";
import type { WindowPoint, WindowResizeDirection, WindowSize } from "../windowManager";

export type BrowserAppTab = {
  id: string;
};

export type BrowserInteractiveElement = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
  tag: string;
};

type BrowserAppProps<TTab extends BrowserAppTab> = {
  position: WindowPoint;
  size: WindowSize;
  zIndex: number;
  tabs: TTab[];
  activeTabId: string | null;
  urlInput: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  loadError: string | null;
  loadErrorSummary: string | null;
  usingEmbeddedPreview: boolean;
  embeddedPreviewCovered: boolean;
  snapshotImage: string | null;
  title: string;
  liveConnected: boolean;
  hasRenderableImage: boolean;
  liveStatePresent: boolean;
  snapshotPresent: boolean;
  snapshotWidth: number;
  snapshotHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  interactiveElements: BrowserInteractiveElement[];
  clickingId: string | null;
  viewportRef: RefObject<HTMLDivElement>;
  liveImageRef: RefObject<HTMLImageElement>;
  labelTab: (tab: TTab) => string;
  onClose: () => void;
  onFocus: () => void;
  onDragStart: (e: ReactMouseEvent<HTMLDivElement>) => void;
  onResizeStart: (direction: WindowResizeDirection, e: ReactMouseEvent<HTMLDivElement>) => void;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onUrlInputChange: (value: string) => void;
  onNavigate: (target: string) => void;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
  onOpenExternal: (target: string) => void;
  onCreateTab: () => void;
  onRetry: () => void;
  onDismissError: () => void;
  onLiveFocus: () => void;
  onViewportMouseMove: (e: ReactMouseEvent<HTMLElement>) => void;
  onViewportMouseDown: (e: ReactMouseEvent<HTMLElement>) => void;
  onViewportMouseUp: (e: ReactMouseEvent<HTMLElement>) => void;
  onViewportClick: (clientX: number, clientY: number) => void;
  onViewportWheel: (e: ReactWheelEvent<HTMLElement>) => void;
  onViewportKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => void;
  onViewportPaste: (e: ReactClipboardEvent<HTMLElement>) => void;
  onViewportCopy: (e: ReactClipboardEvent<HTMLElement>) => void;
  onElementClick: (element: BrowserInteractiveElement) => void;
};

export function BrowserApp<TTab extends BrowserAppTab>({
  position,
  size,
  zIndex,
  tabs,
  activeTabId,
  urlInput,
  canGoBack,
  canGoForward,
  loading,
  loadError,
  loadErrorSummary,
  usingEmbeddedPreview,
  embeddedPreviewCovered,
  snapshotImage,
  title,
  liveConnected,
  hasRenderableImage,
  liveStatePresent,
  snapshotPresent,
  snapshotWidth,
  snapshotHeight,
  viewportWidth,
  viewportHeight,
  interactiveElements,
  clickingId,
  viewportRef,
  liveImageRef,
  labelTab,
  onClose,
  onFocus,
  onDragStart,
  onResizeStart,
  onSelectTab,
  onCloseTab,
  onUrlInputChange,
  onNavigate,
  onBack,
  onForward,
  onReload,
  onOpenExternal,
  onCreateTab,
  onRetry,
  onDismissError,
  onLiveFocus,
  onViewportMouseMove,
  onViewportMouseDown,
  onViewportMouseUp,
  onViewportClick,
  onViewportWheel,
  onViewportKeyDown,
  onViewportPaste,
  onViewportCopy,
  onElementClick,
}: BrowserAppProps<TTab>) {
  return (
    <AppWindow
      title="Browser"
      icon={Globe}
      position={position}
      size={size}
      zIndex={zIndex}
      onClose={onClose}
      onFocus={onFocus}
      onDragStart={onDragStart}
      onResizeStart={onResizeStart}
    >
      <div className="h-full flex flex-col bg-[var(--bg-card)]">
        {tabs.length > 1 && (
          <div className="flex items-center gap-2 px-2 py-2 border-b border-[var(--border-subtle)] bg-[var(--bg-secondary)]">
            <div className="flex-1 min-w-0 flex items-center gap-2 overflow-x-auto">
              {tabs.map((tab) => {
                const isActive = tab.id === activeTabId;
                const label = labelTab(tab);
                return (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => onSelectTab(tab.id)}
                    className={`group min-w-0 max-w-[240px] h-9 px-3 rounded-xl border flex items-center gap-2 text-sm transition-colors ${
                      isActive
                        ? "bg-[var(--bg-card)] text-[var(--text-primary)] shadow-sm"
                        : "bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:bg-[var(--system-gray-6)]"
                    }`}
                    style={{ borderColor: isActive ? "var(--border-default)" : "var(--border-subtle)" }}
                    title={label}
                  >
                    <Globe className="w-3.5 h-3.5 shrink-0" />
                    <span className="min-w-0 flex-1 truncate text-left">{label}</span>
                    <span
                      role="button"
                      tabIndex={-1}
                      onClick={(e) => {
                        e.stopPropagation();
                        onCloseTab(tab.id);
                      }}
                      className="shrink-0 rounded-md p-0.5 text-[var(--text-tertiary)] hover:bg-[var(--border-subtle)] hover:text-[var(--text-primary)]"
                      aria-label={`Close ${label}`}
                    >
                      <X className="w-3.5 h-3.5" />
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div className="px-3 py-2 border-b border-[var(--border-subtle)] bg-[var(--system-gray-6)]/70">
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              onNavigate(urlInput);
            }}
          >
            <button
              type="button"
              onClick={onBack}
              disabled={!canGoBack || loading}
              className="h-8 w-8 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)] text-[var(--text-secondary)] disabled:opacity-40"
              title="Back"
            >
              <ChevronLeft className="w-4 h-4 mx-auto" />
            </button>
            <button
              type="button"
              onClick={onForward}
              disabled={!canGoForward || loading}
              className="h-8 w-8 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)] text-[var(--text-secondary)] disabled:opacity-40"
              title="Forward"
            >
              <ChevronRight className="w-4 h-4 mx-auto" />
            </button>
            <button
              type="button"
              onClick={onReload}
              className="h-8 w-8 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)] text-[var(--text-secondary)]"
              title="Reload"
            >
              {loading ? (
                <Loader2 className="w-4 h-4 mx-auto animate-spin" />
              ) : (
                <ArrowUp className="w-4 h-4 mx-auto rotate-90" />
              )}
            </button>
            <input
              type="text"
              value={urlInput}
              onChange={(e) => onUrlInputChange(e.target.value)}
              className="flex-1 h-8 px-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)] text-sm outline-none"
              placeholder="Enter URL"
            />
            <button
              type="submit"
              className="h-8 px-3 rounded-lg bg-[var(--system-blue)] text-white text-sm font-semibold"
            >
              Go
            </button>
            <button
              type="button"
              onClick={() => onOpenExternal(urlInput)}
              className="h-8 px-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)] text-sm font-medium text-[var(--text-primary)]"
            >
              Open
            </button>
            <button
              type="button"
              onClick={onCreateTab}
              className="h-8 w-8 shrink-0 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              title="New tab"
              aria-label="New tab"
            >
              <Plus className="w-4 h-4 mx-auto" />
            </button>
          </form>
        </div>

        {loadError && (
          <div className="px-3 py-3 border-b border-[var(--border-subtle)] bg-red-500/5">
            <div className="rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-red-200">Browser unavailable</p>
                  <p className="mt-1 text-xs leading-relaxed text-red-100/90 break-words">
                    {loadErrorSummary || loadError}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={onRetry}
                    className="h-8 px-3 rounded-lg bg-red-100 text-[11px] font-semibold text-red-900"
                  >
                    Retry
                  </button>
                  <button
                    type="button"
                    onClick={() => onOpenExternal(urlInput)}
                    className="h-8 px-3 rounded-lg border border-white/15 bg-black/10 text-[11px] font-medium text-white/90"
                  >
                    Open externally
                  </button>
                  <button
                    type="button"
                    onClick={onDismissError}
                    className="h-8 px-3 rounded-lg border border-white/15 bg-transparent text-[11px] font-medium text-white/70"
                  >
                    Dismiss
                  </button>
                </div>
              </div>
              {loadError.includes("\n") && (
                <details className="mt-3">
                  <summary className="cursor-pointer text-[11px] font-medium text-red-100/80">
                    Error details
                  </summary>
                  <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-black/20 px-3 py-2 text-[11px] leading-relaxed text-red-50 select-text">
                    {loadError}
                  </pre>
                </details>
              )}
            </div>
          </div>
        )}

        <div className="relative flex-1 bg-[var(--bg-card)]">
          {loading && !snapshotPresent && !liveStatePresent && !usingEmbeddedPreview ? (
            <div className="absolute inset-0 flex items-center justify-center text-sm text-[var(--text-secondary)]">
              <div className="flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" />
                Loading browser session...
              </div>
            </div>
          ) : (usingEmbeddedPreview || snapshotPresent || liveStatePresent) ? (
            <div className="h-full flex flex-col">
              <div
                ref={viewportRef}
                className={
                  usingEmbeddedPreview
                    ? "flex-1 min-h-0 overflow-hidden bg-[var(--bg-card)]"
                    : liveConnected
                      ? "flex-1 min-h-0 overflow-hidden bg-[#0b0b0c] flex items-center justify-center"
                      : "flex-1 min-h-0 overflow-auto bg-[#f5f5f5]"
                }
              >
                {usingEmbeddedPreview ? (
                  <div className="relative w-full h-full overflow-hidden bg-[var(--bg-card)]">
                    {embeddedPreviewCovered && snapshotImage ? (
                      <img
                        src={snapshotImage}
                        alt={title}
                        className="block h-full w-full object-contain select-none"
                        draggable={false}
                        decoding="async"
                      />
                    ) : loading ? (
                      <div className="absolute inset-0 flex items-center justify-center text-sm text-[var(--text-secondary)]">
                        Local preview is loading...
                      </div>
                    ) : null}
                  </div>
                ) : hasRenderableImage ? (
                  <div
                    className={
                      liveConnected
                        ? "relative w-full h-full flex items-center justify-center"
                        : "relative w-full"
                    }
                  >
                    <img
                      ref={liveImageRef}
                      src={snapshotImage || undefined}
                      alt={title}
                      className={
                        liveConnected
                          ? "block max-w-full max-h-full object-contain select-none"
                          : "w-full h-auto block cursor-pointer"
                      }
                      draggable={false}
                      decoding="async"
                      tabIndex={liveConnected ? 0 : -1}
                      onFocus={onLiveFocus}
                      onMouseMove={onViewportMouseMove}
                      onMouseDown={onViewportMouseDown}
                      onMouseUp={onViewportMouseUp}
                      onClick={(event) => {
                        if (!liveConnected) {
                          onViewportClick(event.clientX, event.clientY);
                        }
                      }}
                      onWheel={onViewportWheel}
                      onKeyDown={onViewportKeyDown}
                      onPaste={onViewportPaste}
                      onCopy={onViewportCopy}
                      onContextMenu={(e) => e.preventDefault()}
                    />
                    {!liveConnected && (
                      <div className="pointer-events-none absolute bottom-3 left-3 rounded-full bg-black/70 px-3 py-1.5 text-[11px] font-medium text-white shadow-lg">
                        Snapshot mode: click anywhere on the page if a button is not highlighted.
                      </div>
                    )}
                    {!liveConnected && interactiveElements.map((element) => (
                      <button
                        key={element.id}
                        type="button"
                        title={element.label || element.tag}
                        onClick={() => onElementClick(element)}
                        disabled={Boolean(clickingId) || loading}
                        className="absolute rounded border border-sky-500/80 bg-sky-400/10 hover:bg-sky-400/20 transition-colors disabled:cursor-wait"
                        style={{
                          left: `${(element.x / Math.max(snapshotWidth || viewportWidth, 1)) * 100}%`,
                          top: `${(element.y / Math.max(snapshotHeight || viewportHeight, 1)) * 100}%`,
                          width: `${(element.width / Math.max(snapshotWidth || viewportWidth, 1)) * 100}%`,
                          height: `${(element.height / Math.max(snapshotHeight || viewportHeight, 1)) * 100}%`,
                        }}
                      >
                        <span className="absolute left-0 top-0 -translate-y-full rounded bg-sky-600 px-1.5 py-0.5 text-[10px] font-medium text-white shadow-sm max-w-[240px] truncate">
                          {element.label || element.tag}
                        </span>
                      </button>
                    ))}
                  </div>
                ) : liveConnected ? (
                  <div className="h-full flex items-center justify-center text-sm text-white/60">
                    Waiting for live browser frame...
                  </div>
                ) : (
                  <div className="h-full flex items-center justify-center text-sm text-[var(--text-secondary)]">
                    No browser screenshot available.
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="absolute inset-0 flex items-center justify-center text-sm text-[var(--text-secondary)]">
              Enter a URL to start a browser session.
            </div>
          )}
        </div>
      </div>
    </AppWindow>
  );
}
