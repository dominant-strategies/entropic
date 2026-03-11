import { memo, type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";
import { FolderOpen, Globe } from "lucide-react";

type WorkspaceLinkAction = {
  path: string;
  action: "open" | "browser";
  looksLikeFile: boolean;
  url?: string;
};

type WorkspaceChip = WorkspaceLinkAction & {
  label: string;
};

const CHAT_WORKSPACE_PREFIXES = [
  "/data/.openclaw/workspace",
  "/data/workspace",
  "/home/node/.openclaw/workspace",
];
const LOCAL_BROWSER_HOSTS = new Set(["container.localhost", "runtime.localhost", "localhost", "127.0.0.1"]);
const DESKTOP_LINK_TOKEN_RE = /((?:\/data\/(?:\.openclaw\/)?workspace|\/home\/node\/\.openclaw\/workspace)(?:\/[^\s`"'<>]+)?|(?:https?:\/\/)?(?:container\.localhost|runtime\.localhost|localhost|127\.0\.0\.1)(?::\d+)?(?:[/?#][^\s`"'<>]*)?)/gi;
const WORKSPACE_LINK_SCHEME = "entropic-workspace://";

function splitWorkspaceToken(raw: string) {
  const leading = raw.match(/^[("'`\[]+/)?.[0] || "";
  const trailing = raw.match(/[)"'`\],:;.!?]+$/)?.[0] || "";
  const coreEnd = trailing ? raw.length - trailing.length : raw.length;
  const core = raw.slice(leading.length, coreEnd);
  return { leading, core, trailing };
}

function normalizeWorkspacePath(raw: string): { path: string; looksLikeFile: boolean } | null {
  const { core } = splitWorkspaceToken(raw.trim());
  for (const prefix of CHAT_WORKSPACE_PREFIXES) {
    if (core === prefix) {
      return { path: "", looksLikeFile: false };
    }
    if (core.startsWith(`${prefix}/`)) {
      const path = core.slice(prefix.length + 1);
      const name = path.split("/").filter(Boolean).pop() || "";
      return { path, looksLikeFile: name.includes(".") };
    }
  }
  return null;
}

function resolveWorkspaceChip(raw: string): WorkspaceChip | null {
  const normalized = normalizeWorkspacePath(raw);
  if (!normalized) {
    return null;
  }
  const { core } = splitWorkspaceToken(raw.trim());
  const ext = core.split(".").pop()?.toLowerCase() || "";
  return {
    ...normalized,
    action: ext === "html" || ext === "htm" ? "browser" : "open",
    label: core,
  };
}

function resolveBrowserUrlChip(raw: string): WorkspaceChip | null {
  const { core } = splitWorkspaceToken(raw.trim());
  if (!core) return null;
  const candidate = /^https?:\/\//i.test(core) ? core : `http://${core}`;
  try {
    const parsed = new URL(candidate);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !LOCAL_BROWSER_HOSTS.has(parsed.hostname.toLowerCase())) {
      return null;
    }
    return {
      path: "",
      action: "browser",
      looksLikeFile: false,
      url: parsed.toString(),
      label: core,
    };
  } catch {
    return null;
  }
}

function resolveDesktopLinkChip(raw: string): WorkspaceChip | null {
  return resolveWorkspaceChip(raw) || resolveBrowserUrlChip(raw);
}

function buildDesktopLinkNodes(text: string) {
  const nodes: Array<Record<string, unknown>> = [];
  let cursor = 0;
  DESKTOP_LINK_TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = DESKTOP_LINK_TOKEN_RE.exec(text))) {
    const rawMatch = match[0];
    const start = match.index;
    const end = start + rawMatch.length;

    if (start > cursor) {
      nodes.push({ type: "text", value: text.slice(cursor, start) });
    }

    const desktopChip = resolveDesktopLinkChip(rawMatch);
    if (!desktopChip) {
      nodes.push({ type: "text", value: rawMatch });
      cursor = end;
      continue;
    }

    const { leading, core, trailing } = splitWorkspaceToken(rawMatch);
    if (leading) {
      nodes.push({ type: "text", value: leading });
    }

    nodes.push({
      type: "link",
      url: `${WORKSPACE_LINK_SCHEME}${desktopChip.action}?path=${encodeURIComponent(desktopChip.path)}&file=${desktopChip.looksLikeFile ? "1" : "0"}${desktopChip.url ? `&url=${encodeURIComponent(desktopChip.url)}` : ""}`,
      title: null,
      children: [{ type: "text", value: core }],
    });

    if (trailing) {
      nodes.push({ type: "text", value: trailing });
    }

    cursor = end;
  }

  if (cursor < text.length) {
    nodes.push({ type: "text", value: text.slice(cursor) });
  }

  return nodes.length > 0 ? nodes : [{ type: "text", value: text }];
}

function remarkWorkspaceLinks() {
  const skipChildTraversal = new Set(["link", "definition", "inlineCode", "code", "html"]);

  function visit(node: Record<string, unknown>) {
    const children = Array.isArray(node.children) ? node.children : null;
    if (!children) return;

    const nextChildren: Array<Record<string, unknown>> = [];
    for (const child of children as Array<Record<string, unknown>>) {
      if (child.type === "text" && typeof child.value === "string") {
        nextChildren.push(...buildDesktopLinkNodes(child.value));
        continue;
      }
      if (!skipChildTraversal.has(String(child.type || ""))) {
        visit(child);
      }
      nextChildren.push(child);
    }

    node.children = nextChildren;
  }

  return (tree: Record<string, unknown>) => {
    visit(tree);
  };
}

function parseWorkspaceHref(href?: string | null): WorkspaceLinkAction | null {
  if (!href || !href.startsWith(WORKSPACE_LINK_SCHEME)) {
    return null;
  }
  const actionPart = href.slice(WORKSPACE_LINK_SCHEME.length);
  const [actionRaw, query = ""] = actionPart.split("?", 2);
  if (actionRaw !== "open" && actionRaw !== "browser") {
    return null;
  }
  const params = new URLSearchParams(query);
  return {
    action: actionRaw,
    path: params.get("path") || "",
    looksLikeFile: params.get("file") === "1",
    url: params.get("url") || undefined,
  };
}

function markdownUrlTransform(url: string) {
  if (url.startsWith(WORKSPACE_LINK_SCHEME)) {
    return url;
  }
  return defaultUrlTransform(url);
}

function renderWorkspaceChip(
  workspaceAction: WorkspaceLinkAction,
  label: ReactNode,
  onWorkspaceLinkClick?: (action: WorkspaceLinkAction) => void,
) {
  const isBrowser = workspaceAction.action === "browser";
  const Icon = isBrowser ? Globe : FolderOpen;
  return (
    <a
      href={`${WORKSPACE_LINK_SCHEME}${workspaceAction.action}?path=${encodeURIComponent(workspaceAction.path)}&file=${workspaceAction.looksLikeFile ? "1" : "0"}${workspaceAction.url ? `&url=${encodeURIComponent(workspaceAction.url)}` : ""}`}
      className="mx-0.5 my-0.5 inline-flex max-w-full min-w-0 cursor-pointer items-center gap-2 overflow-hidden rounded-lg border px-2.5 py-1.5 text-[11px] font-semibold align-middle shadow-sm transition-transform hover:-translate-y-px hover:shadow-md"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "0.5rem",
        borderColor: isBrowser ? "rgba(56,189,248,0.38)" : "rgba(148,163,184,0.38)",
        background: isBrowser ? "rgba(56,189,248,0.14)" : "rgba(148,163,184,0.18)",
        color: "inherit",
        textDecoration: "none",
        verticalAlign: "middle",
      }}
      onClick={(event) => {
        event.preventDefault();
        onWorkspaceLinkClick?.(workspaceAction);
      }}
    >
      <span
        className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full"
        style={{
          background: isBrowser ? "rgba(56,189,248,0.22)" : "rgba(148,163,184,0.24)",
          color: isBrowser ? "#0f766e" : "#475569",
        }}
      >
        <Icon className="h-3 w-3" />
      </span>
      <span className="min-w-0 truncate font-mono">{label}</span>
    </a>
  );
}

function buildComponents(
  onWorkspaceLinkClick?: (action: WorkspaceLinkAction) => void,
): Components {
  return {
    p: ({ children }) => <p className="mb-2 break-words last:mb-0">{children}</p>,
    strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
    em: ({ children }) => <em>{children}</em>,
    h1: ({ children }) => <h1 className="text-lg font-bold mb-2 mt-3 first:mt-0">{children}</h1>,
    h2: ({ children }) => <h2 className="text-base font-bold mb-1.5 mt-3 first:mt-0">{children}</h2>,
    h3: ({ children }) => <h3 className="text-sm font-bold mb-1 mt-2 first:mt-0">{children}</h3>,
    ul: ({ children }) => <ul className="list-disc pl-5 mb-2 space-y-0.5">{children}</ul>,
    ol: ({ children }) => <ol className="list-decimal pl-5 mb-2 space-y-0.5">{children}</ol>,
    li: ({ children }) => <li className="leading-relaxed">{children}</li>,
    blockquote: ({ children }) => (
      <blockquote className="border-l-2 border-[var(--text-tertiary)] pl-3 my-2 text-[var(--text-secondary)] italic">
        {children}
      </blockquote>
    ),
    code: ({ className, children }) => {
      const isBlock = className?.includes("language-");
      if (isBlock) {
        return (
          <code className="block max-w-full overflow-x-auto rounded-lg bg-black/5 px-3 py-2 font-mono text-xs whitespace-pre">
            {children}
          </code>
        );
      }
      const inlineText = Array.isArray(children) ? children.join("") : String(children);
      const workspaceChip = resolveDesktopLinkChip(inlineText.trim());
      if (workspaceChip) {
        return renderWorkspaceChip(workspaceChip, workspaceChip.label, onWorkspaceLinkClick);
      }
      return (
        <code className="bg-black/[.07] rounded px-1 py-0.5 text-[0.9em] font-mono">
          {children}
        </code>
      );
    },
    pre: ({ children }) => <div className="my-2">{children}</div>,
    a: ({ href, children }) => {
      const workspaceAction = parseWorkspaceHref(href);
      if (workspaceAction) {
        return renderWorkspaceChip(workspaceAction, children, onWorkspaceLinkClick);
      }
      const browserChip = resolveBrowserUrlChip(href || "");
      if (browserChip) {
        return renderWorkspaceChip(browserChip, children, onWorkspaceLinkClick);
      }
      return (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[var(--purple-accent)] underline underline-offset-2 hover:opacity-80"
        >
          {children}
        </a>
      );
    },
    hr: () => <hr className="border-[var(--glass-border)] my-3" />,
    table: ({ children }) => (
      <div className="overflow-x-auto my-2">
        <table className="text-sm border-collapse w-full">{children}</table>
      </div>
    ),
    th: ({ children }) => (
      <th className="text-left font-semibold px-2 py-1 border-b border-[var(--glass-border)]">
        {children}
      </th>
    ),
    td: ({ children }) => (
      <td className="px-2 py-1 border-b border-[var(--glass-border-subtle)]">{children}</td>
    ),
  };
}

export const MarkdownContent = memo(function MarkdownContent({
  content,
  onWorkspaceLinkClick,
}: {
  content: string;
  onWorkspaceLinkClick?: (action: WorkspaceLinkAction) => void;
}) {
  return (
    <div className="min-w-0 max-w-full break-words">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkWorkspaceLinks]}
        urlTransform={markdownUrlTransform}
        components={buildComponents(onWorkspaceLinkClick)}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});
