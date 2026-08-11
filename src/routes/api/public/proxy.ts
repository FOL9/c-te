import { createFileRoute } from "@tanstack/react-router";

const BLOCKED_HOSTS = [
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "169.254.169.254",
  "[::1]",
];

function isBlocked(target: URL) {
  if (target.protocol !== "http:" && target.protocol !== "https:") return true;
  const host = target.hostname.toLowerCase();
  if (BLOCKED_HOSTS.includes(host)) return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (host.endsWith(".local") || host.endsWith(".internal")) return true;
  return false;
}

const INJECTED = `
<script>
(function () {
  function send(type, payload) {
    try { parent.postMessage(Object.assign({ __safeBrowser: true, type: type }, payload), "*"); } catch (e) {}
  }
  document.addEventListener("click", function (e) {
    var a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
    if (!a) return;
    var href = a.getAttribute("href");
    if (!href || href.startsWith("javascript:") || href.startsWith("#")) return;
    var abs;
    try { abs = new URL(href, document.baseURI).href; } catch (err) { return; }
    if (!/^https?:/.test(abs)) return;
    e.preventDefault();
    send("navigate", { url: abs });
  }, true);
  window.open = function (u) { if (u) send("popup", { url: String(u) }); return null; };
  document.addEventListener("submit", function (e) {
    var f = e.target;
    if (!f || f.method && f.method.toLowerCase() === "post") return;
    try {
      var u = new URL(f.action || document.baseURI, document.baseURI);
      var data = new FormData(f);
      data.forEach(function (v, k) { u.searchParams.set(k, String(v)); });
      e.preventDefault();
      send("navigate", { url: u.href });
    } catch (err) {}
  }, true);
  send("ready", { url: document.baseURI, title: document.title });
})();
</script>
`;

export const Route = createFileRoute("/api/public/proxy")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const raw = new URL(request.url).searchParams.get("url");
        if (!raw) return new Response("Missing url", { status: 400 });

        let target: URL;
        try {
          target = new URL(raw);
        } catch {
          return new Response("Invalid url", { status: 400 });
        }
        if (isBlocked(target)) return new Response("Blocked host", { status: 403 });

        let upstream: Response;
        try {
          upstream = await fetch(target.href, {
            redirect: "follow",
            headers: {
              "user-agent":
                "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
              accept:
                "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
              "accept-language": "en-US,en;q=0.9",
            },
          });
        } catch {
          return new Response("Upstream fetch failed", { status: 502 });
        }

        const contentType = upstream.headers.get("content-type") ?? "application/octet-stream";
        const headers = new Headers();
        headers.set("content-type", contentType);
        headers.set("cache-control", "no-store");
        headers.set("x-proxy-final-url", upstream.url || target.href);
        headers.set("access-control-expose-headers", "x-proxy-final-url");

        if (!contentType.includes("text/html")) {
          return new Response(upstream.body, { status: upstream.status, headers });
        }

        let html = await upstream.text();
        const finalUrl = upstream.url || target.href;
        const base = `<base href="${finalUrl.replace(/"/g, "&quot;")}">`;
        if (/<head[^>]*>/i.test(html)) {
          html = html.replace(/<head([^>]*)>/i, `<head$1>${base}`);
        } else {
          html = base + html;
        }
        html = html.replace(
          /<meta[^>]+http-equiv=["']?content-security-policy["']?[^>]*>/gi,
          "",
        );
        html += INJECTED;

        return new Response(html, { status: upstream.status, headers });
      },
    },
  },
});