import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Globe,
  Home,
  Lock,
  Plus,
  RotateCw,
  Search,
  ShieldAlert,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/safty")({
  head: () => ({
    meta: [
      { title: "Safe Browser — Sandboxed Multi-Tab Web Access" },
      {
        name: "description",
        content:
          "A sandboxed multi-tab browser with per-domain approval, DuckDuckGo search, history and a live status bar.",
      },
      { property: "og:title", content: "Safe Browser — Sandboxed Multi-Tab Web Access" },
      {
        property: "og:description",
        content:
          "Browse inside a proxied sandbox: multiple tabs, domain approval prompts, popup blocking and full navigation history.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: SafeBrowser,
});

type TabStatus = "idle" | "loading" | "loaded" | "blocked" | "error";

type Tab = {
  id: string;
  title: string;
  url: string | null;
  draft: string;
  history: string[];
  historyIndex: number;
  status: TabStatus;
  note: string | null;
};

type PendingApproval = { tabId: string; url: string; from: string | null };

const uid = () => Math.random().toString(36).slice(2, 10);

function newTab(url: string | null = null): Tab {
  return {
    id: uid(),
    title: url ? hostOf(url) : "New Tab",
    url,
    draft: url ?? "",
    history: url ? [url] : [],
    historyIndex: url ? 0 : -1,
    status: url ? "loading" : "idle",
    note: null,
  };
}

function hostOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function toUrl(input: string): string {
  const value = input.trim();
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  const looksLikeDomain = /^[\w-]+(\.[\w-]+)+(\/|$|\?|#)/.test(value) && !value.includes(" ");
  if (looksLikeDomain) return `https://${value}`;
  return `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(value)}`;
}

const proxied = (url: string) => `/api/public/proxy?url=${encodeURIComponent(url)}`;

const QUICK_LINKS = [
  { label: "DuckDuckGo", url: "https://duckduckgo.com/" },
  { label: "Wikipedia", url: "https://en.wikipedia.org/" },
  { label: "Hacker News", url: "https://news.ycombinator.com/" },
  { label: "MDN", url: "https://developer.mozilla.org/" },
];

function SafeBrowser() {
  const [tabs, setTabs] = useState<Tab[]>(() => [newTab()]);
  const [activeId, setActiveId] = useState<string>(() => "");
  const [approvedDomains, setApprovedDomains] = useState<string[]>([]);
  const [pending, setPending] = useState<PendingApproval | null>(null);
  const [blockedPopups, setBlockedPopups] = useState(0);
  const frames = useRef<Record<string, HTMLIFrameElement | null>>({});

  useEffect(() => {
    if (!activeId && tabs[0]) setActiveId(tabs[0].id);
  }, [activeId, tabs]);

  const active = tabs.find((t) => t.id === activeId) ?? tabs[0];

  const patchTab = useCallback((id: string, patch: Partial<Tab>) => {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }, []);

  const commitNavigation = useCallback(
    (tabId: string, url: string) => {
      setTabs((prev) =>
        prev.map((t) => {
          if (t.id !== tabId) return t;
          const history = [...t.history.slice(0, t.historyIndex + 1), url];
          return {
            ...t,
            url,
            draft: url,
            title: hostOf(url),
            history,
            historyIndex: history.length - 1,
            status: "loading",
            note: null,
          };
        }),
      );
    },
    [],
  );

  const requestNavigation = useCallback(
    (tabId: string, rawUrl: string, from: string | null) => {
      const url = toUrl(rawUrl);
      if (!url) return;
      const domain = hostOf(url);
      const sameOrigin = from !== null && hostOf(from) === domain;
      if (sameOrigin || approvedDomains.includes(domain)) {
        commitNavigation(tabId, url);
        return;
      }
      setPending({ tabId, url, from });
    },
    [approvedDomains, commitNavigation],
  );

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      const data = event.data as
        | { __safeBrowser?: boolean; type?: string; url?: string; title?: string }
        | undefined;
      if (!data || data.__safeBrowser !== true) return;
      const entry = Object.entries(frames.current).find(
        ([, frame]) => frame && frame.contentWindow === event.source,
      );
      const tabId = entry?.[0];
      if (!tabId) return;
      const current = tabs.find((t) => t.id === tabId) ?? null;

      if (data.type === "navigate" && data.url) {
        requestNavigation(tabId, data.url, current?.url ?? null);
      } else if (data.type === "popup") {
        setBlockedPopups((n) => n + 1);
        patchTab(tabId, { note: "Popup blocked" });
      } else if (data.type === "ready") {
        patchTab(tabId, {
          status: "loaded",
          title: data.title?.slice(0, 60) || hostOf(current?.url ?? ""),
        });
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [tabs, requestNavigation, patchTab]);

  const openTab = (url: string | null = null) => {
    const tab = newTab(url);
    setTabs((prev) => [...prev, tab]);
    setActiveId(tab.id);
  };

  const closeTab = (id: string) => {
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === id);
      const next = prev.filter((t) => t.id !== id);
      const list = next.length ? next : [newTab()];
      if (id === activeId) {
        const fallback = list[Math.max(0, Math.min(idx, list.length - 1))];
        setActiveId(fallback.id);
      }
      return list;
    });
    delete frames.current[id];
  };

  const go = (delta: number) => {
    if (!active) return;
    const nextIndex = active.historyIndex + delta;
    if (nextIndex < 0 || nextIndex >= active.history.length) return;
    const url = active.history[nextIndex];
    patchTab(active.id, {
      historyIndex: nextIndex,
      url,
      draft: url,
      title: hostOf(url),
      status: "loading",
      note: null,
    });
  };

  const reload = () => {
    if (!active?.url) return;
    const frame = frames.current[active.id];
    patchTab(active.id, { status: "loading" });
    if (frame) frame.src = proxied(active.url);
  };

  const canBack = !!active && active.historyIndex > 0;
  const canForward = !!active && active.historyIndex < active.history.length - 1;
  const secure = active?.url?.startsWith("https://") ?? false;

  const statusText = useMemo(() => {
    if (!active) return "Ready";
    if (active.note) return active.note;
    switch (active.status) {
      case "loading":
        return `Loading ${hostOf(active.url ?? "")}…`;
      case "loaded":
        return `Loaded ${hostOf(active.url ?? "")}`;
      case "blocked":
        return "Navigation blocked";
      case "error":
        return "This page could not be loaded";
      default:
        return "Ready";
    }
  }, [active]);

  return (
    <div className="dark flex h-screen flex-col bg-background text-foreground">
      <header className="border-b border-border bg-card/60">
        {/* Tab strip */}
        <div
          role="tablist"
          aria-label="Browser tabs"
          className="flex items-end gap-1 overflow-x-auto px-2 pt-2"
        >
          {tabs.map((tab) => (
            <div
              key={tab.id}
              role="tab"
              tabIndex={0}
              aria-selected={tab.id === activeId}
              onClick={() => setActiveId(tab.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setActiveId(tab.id);
                }
              }}
              className={cn(
                "group flex min-w-[9rem] max-w-[15rem] cursor-pointer items-center gap-2 rounded-t-lg border border-b-0 border-border px-3 py-2 text-xs transition-colors",
                tab.id === activeId
                  ? "bg-background text-foreground"
                  : "bg-muted/40 text-muted-foreground hover:bg-muted",
              )}
            >
              <Globe
                className={cn("h-3.5 w-3.5 shrink-0", tab.status === "loading" && "animate-pulse")}
                aria-hidden
              />
              <span className="truncate">{tab.title}</span>
              <button
                type="button"
                aria-label={`Close ${tab.title}`}
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(tab.id);
                }}
                className="ml-auto rounded p-0.5 opacity-60 hover:bg-accent hover:opacity-100"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
          <Button
            variant="ghost"
            size="icon"
            aria-label="New tab"
            className="mb-1 h-8 w-8"
            onClick={() => openTab()}
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>

        {/* Toolbar */}
        <div className="flex items-center gap-2 px-3 py-2">
          <Button variant="ghost" size="icon" aria-label="Back" disabled={!canBack} onClick={() => go(-1)}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Forward"
            disabled={!canForward}
            onClick={() => go(1)}
          >
            <ArrowRight className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" aria-label="Reload" disabled={!active?.url} onClick={reload}>
            <RotateCw className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Home"
            onClick={() => active && patchTab(active.id, { url: null, draft: "", status: "idle", title: "New Tab" })}
          >
            <Home className="h-4 w-4" />
          </Button>

          <form
            className="flex flex-1 items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (active) requestNavigation(active.id, active.draft, active.url);
            }}
          >
            <div className="relative flex-1">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                {secure ? <Lock className="h-3.5 w-3.5" /> : <Search className="h-3.5 w-3.5" />}
              </span>
              <Input
                aria-label="Address and search bar"
                value={active?.draft ?? ""}
                placeholder="Search DuckDuckGo or enter a URL"
                onChange={(e) => active && patchTab(active.id, { draft: e.target.value })}
                className="pl-9"
              />
            </div>
            <Button type="submit" size="sm">
              Go
            </Button>
          </form>
        </div>
      </header>

      {/* Viewport */}
      <main className="relative flex-1 overflow-hidden bg-muted/20">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            role="tabpanel"
            hidden={tab.id !== activeId}
            className="absolute inset-0"
            style={{ display: tab.id === activeId ? "block" : "none" }}
          >
            {tab.url ? (
              <iframe
                ref={(el) => {
                  frames.current[tab.id] = el;
                }}
                title={tab.title}
                src={proxied(tab.url)}
                onLoad={() => patchTab(tab.id, { status: "loaded" })}
                onError={() => patchTab(tab.id, { status: "error" })}
                sandbox="allow-scripts allow-forms allow-same-origin"
                referrerPolicy="no-referrer"
                className="h-full w-full border-0 bg-background"
              />
            ) : (
              <NewTabPage
                onSearch={(q) => requestNavigation(tab.id, q, null)}
                onOpen={(url) => requestNavigation(tab.id, url, null)}
              />
            )}
          </div>
        ))}
      </main>

      {/* Status bar */}
      <footer
        role="status"
        aria-live="polite"
        className="flex items-center justify-between gap-4 border-t border-border bg-card/60 px-3 py-1.5 text-xs text-muted-foreground"
      >
        <span className="truncate">{statusText}</span>
        <span className="flex shrink-0 items-center gap-4">
          <span>{tabs.length} tab{tabs.length === 1 ? "" : "s"}</span>
          <span>{approvedDomains.length} approved</span>
          <span>{blockedPopups} popups blocked</span>
          <span className="flex items-center gap-1">
            {secure ? <Lock className="h-3 w-3" /> : <ShieldAlert className="h-3 w-3" />}
            {secure ? "Secure" : "Sandboxed"}
          </span>
        </span>
      </footer>

      {pending && (
        <ApprovalDialog
          pending={pending}
          onCancel={() => setPending(null)}
          onAllow={(remember) => {
            const domain = hostOf(pending.url);
            if (remember) setApprovedDomains((prev) => (prev.includes(domain) ? prev : [...prev, domain]));
            commitNavigation(pending.tabId, pending.url);
            setPending(null);
          }}
        />
      )}
    </div>
  );
}

function NewTabPage({
  onSearch,
  onOpen,
}: {
  onSearch: (query: string) => void;
  onOpen: (url: string) => void;
}) {
  const [query, setQuery] = useState("");
  return (
    <div className="flex h-full flex-col items-center justify-center gap-8 px-6">
      <div className="text-center">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Safe Browser</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Every page loads through a sandboxed proxy. New domains need your approval.
        </p>
      </div>
      <form
        className="flex w-full max-w-xl gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (query.trim()) onSearch(query);
        }}
      >
        <Input
          autoFocus
          aria-label="Search the web with DuckDuckGo"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search DuckDuckGo or enter a URL"
        />
        <Button type="submit">Search</Button>
      </form>
      <div className="flex flex-wrap justify-center gap-2">
        {QUICK_LINKS.map((link) => (
          <Button key={link.url} variant="secondary" size="sm" onClick={() => onOpen(link.url)}>
            {link.label}
          </Button>
        ))}
      </div>
    </div>
  );
}

function ApprovalDialog({
  pending,
  onAllow,
  onCancel,
}: {
  pending: PendingApproval;
  onAllow: (remember: boolean) => void;
  onCancel: () => void;
}) {
  const [remember, setRemember] = useState(true);
  const domain = hostOf(pending.url);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Confirm navigation"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
    >
      <div className="w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-xl">
        <div className="flex items-start gap-3">
          <ShieldAlert className="mt-0.5 h-5 w-5 text-destructive" aria-hidden />
          <div>
            <h2 className="text-base font-semibold text-card-foreground">Open {domain}?</h2>
            <p className="mt-1 break-all text-xs text-muted-foreground">{pending.url}</p>
            {pending.from && (
              <p className="mt-2 text-xs text-muted-foreground">
                Requested by {hostOf(pending.from)}
              </p>
            )}
          </div>
        </div>
        <label className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
            className="h-3.5 w-3.5 accent-current"
          />
          Remember {domain} for this session
        </label>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => onAllow(remember)}>
            Allow
          </Button>
        </div>
      </div>
    </div>
  );
}