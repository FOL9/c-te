import { createFileRoute } from "@tanstack/react-router";
import { handleProxy } from "@/lib/web-proxy.server";

export const Route = createFileRoute("/api/public/proxy")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const raw = new URL(request.url).searchParams.get("url");
        if (!raw) return new Response("Missing url", { status: 400 });
        return handleProxy(request, raw);
      },
    },
  },
});
