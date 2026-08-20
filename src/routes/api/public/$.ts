import { createFileRoute } from "@tanstack/react-router";

/** Remembers which upstream base a proxy-relative asset path came from. */
const assetBases = new Map<string, string>();

function baseFromReferer(referer: string | null): string | null {
  if (!referer) return null;
  try {
    const ref = new URL(referer);
    const fromQuery = ref.searchParams.get("url");
    if (fromQuery) return fromQuery;
    return assetBases.get(ref.pathname) ?? null;
  } catch {
    return null;
  }
}

/**
 * Fallback for assets that a proxied page requests relative to the proxy path
 * (e.g. bundlers resolving chunks from `import.meta.url`). Resolves the path
 * against the referring page's proxied target and re-proxies it.
 */
export const Route = createFileRoute("/api/public/$")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const base = baseFromReferer(request.headers.get("referer"));
        if (!base) return new Response("Not found", { status: 404 });
        const here = new URL(request.url);
        const rel = here.pathname.replace(/^\/api\/public\//, "") + here.search;
        let resolved: string;
        try {
          resolved = new URL(rel, base).href;
        } catch {
          return new Response("Not found", { status: 404 });
        }
        assetBases.set(here.pathname, resolved);
        if (assetBases.size > 500) {
          const oldest = assetBases.keys().next().value;
          if (oldest) assetBases.delete(oldest);
        }
        // Redirect to the canonical proxy URL so nested assets requested by this
        // file still carry a referer that identifies their origin.
        return new Response(null, {
          status: 302,
          headers: {
            location: `/api/public/proxy?url=${encodeURIComponent(resolved)}`,
            "cache-control": "no-store",
          },
        });
      },
    },
  },
});
