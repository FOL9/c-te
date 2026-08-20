import { createFileRoute } from "@tanstack/react-router";

/**
 * Fallback for assets that a proxied page requests relative to the proxy path
 * (e.g. bundlers resolving chunks from `import.meta.url`). Resolves the path
 * against the referring page's proxied target and re-proxies it.
 */
export const Route = createFileRoute("/api/public/$")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const referer = request.headers.get("referer");
        if (!referer) return new Response("Not found", { status: 404 });
        let base: string | null = null;
        try {
          base = new URL(referer).searchParams.get("url");
        } catch {
          base = null;
        }
        if (!base) return new Response("Not found", { status: 404 });
        const here = new URL(request.url);
        const rel = here.pathname.replace(/^\/api\/public\//, "") + here.search;
        let resolved: string;
        try {
          resolved = new URL(rel, base).href;
        } catch {
          return new Response("Not found", { status: 404 });
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
