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

const PROXY_PATH = "/api/public/proxy";
const px = (absUrl: string) => `${PROXY_PATH}?url=${encodeURIComponent(absUrl)}`;

function abs(href: string, baseUrl: string): string | null {
  try {
    const u = new URL(href, baseUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.href;
  } catch {
    return null;
  }
}

function rewriteSrcset(value: string, baseUrl: string) {
  return value
    .split(",")
    .map((part) => {
      const seg = part.trim();
      if (!seg) return seg;
      const [url, ...rest] = seg.split(/\s+/);
      const a = abs(url, baseUrl);
      return [a ? px(a) : url, ...rest].join(" ");
    })
    .join(", ");
}

const URL_ATTRS = ["src", "href", "poster", "data-src", "data-lazy-src", "data-original"];

function rewriteHtml(html: string, baseUrl: string) {
  // attribute URLs
  const attrRe = new RegExp(
    `\\s(${URL_ATTRS.join("|")})\\s*=\\s*("([^"]*)"|'([^']*)')`,
    "gi",
  );
  html = html.replace(attrRe, (match, attr: string, _q: string, dq?: string, sq?: string) => {
    const raw = (dq ?? sq ?? "").trim();
    if (!raw || /^(data:|javascript:|mailto:|about:|blob:|#)/i.test(raw)) return match;
    const a = abs(raw, baseUrl);
    if (!a) return match;
    return ` ${attr}="${px(a).replace(/"/g, "&quot;")}"`;
  });

  // srcset / data-srcset
  html = html.replace(
    /\s(srcset|data-srcset)\s*=\s*("([^"]*)"|'([^']*)')/gi,
    (match, attr: string, _q: string, dq?: string, sq?: string) => {
      const raw = dq ?? sq ?? "";
      if (!raw.trim()) return match;
      return ` ${attr}="${rewriteSrcset(raw, baseUrl).replace(/"/g, "&quot;")}"`;
    },
  );

  // inline <style> blocks
  html = html.replace(
    /<style([^>]*)>([\s\S]*?)<\/style>/gi,
    (_m, attrs: string, css: string) => `<style${attrs}>${rewriteCss(css, baseUrl)}</style>`,
  );

  return html;
}

function rewriteCss(css: string, baseUrl: string) {
  css = css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (match, quote: string, raw: string) => {
    const value = raw.trim();
    if (!value || /^(data:|blob:|#)/i.test(value)) return match;
    const a = abs(value, baseUrl);
    if (!a) return match;
    return `url(${quote}${px(a)}${quote})`;
  });
  css = css.replace(/@import\s+(['"])([^'"]+)\1/gi, (match, quote: string, raw: string) => {
    const a = abs(raw, baseUrl);
    return a ? `@import ${quote}${px(a)}${quote}` : match;
  });
  return css;
}

const INJECTED = `
<script>
(function () {
  var PROXY = ${JSON.stringify(PROXY_PATH)};
  var BASE = document.baseURI;
  function toProxy(u) {
    try {
      if (typeof u !== "string") return u;
      if (!u || u.indexOf(PROXY) === 0) return u;
      if (/^(data:|blob:|javascript:|about:|#)/i.test(u)) return u;
      var a = new URL(u, BASE);
      if (a.protocol !== "http:" && a.protocol !== "https:") return u;
      if (a.origin === location.origin) return u;
      return PROXY + "?url=" + encodeURIComponent(a.href);
    } catch (e) { return u; }
  }
  var _fetch = window.fetch;
  if (_fetch) {
    window.fetch = function (input, init) {
      try {
        if (typeof input === "string") input = toProxy(input);
        else if (input && input.url) input = new Request(toProxy(input.url), input);
      } catch (e) {}
      return _fetch.call(this, input, init);
    };
  }
  var _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    var args = Array.prototype.slice.call(arguments);
    args[1] = toProxy(url);
    return _open.apply(this, args);
  };
  // Rewrite src/href set dynamically by scripts
  try {
    var obs = new MutationObserver(function (muts) {
      muts.forEach(function (m) {
        var nodes = m.type === "attributes" ? [m.target] : Array.prototype.slice.call(m.addedNodes);
        nodes.forEach(function (n) {
          if (!n || n.nodeType !== 1) return;
          var els = [n].concat(Array.prototype.slice.call(n.querySelectorAll ? n.querySelectorAll("[src],[poster]") : []));
          els.forEach(function (el) {
            ["src", "poster"].forEach(function (attr) {
              var v = el.getAttribute && el.getAttribute(attr);
              if (!v) return;
              var p = toProxy(v);
              if (p !== v) el.setAttribute(attr, p);
            });
          });
        });
      });
    });
    obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["src", "poster"] });
  } catch (e) {}
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

        const reqHeaders: Record<string, string> = {
          "user-agent":
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
          accept: request.headers.get("accept") ?? "*/*",
          "accept-language": "en-US,en;q=0.9",
          referer: target.origin + "/",
          origin: target.origin,
        };
        const range = request.headers.get("range");
        if (range) reqHeaders["range"] = range;

        let upstream: Response;
        try {
          upstream = await fetch(target.href, {
            redirect: "follow",
            headers: reqHeaders,
          });
        } catch {
          return new Response("Upstream fetch failed", { status: 502 });
        }

        const contentType = upstream.headers.get("content-type") ?? "application/octet-stream";
        const headers = new Headers();
        headers.set("content-type", contentType);
        headers.set("cache-control", "no-store");
        headers.set("x-proxy-final-url", upstream.url || target.href);
        headers.set("access-control-allow-origin", "*");
        headers.set(
          "access-control-expose-headers",
          "x-proxy-final-url, content-length, content-range, accept-ranges",
        );
        for (const h of ["content-range", "accept-ranges", "content-length", "content-disposition"]) {
          const v = upstream.headers.get(h);
          if (v) headers.set(h, v);
        }

        const finalUrl = upstream.url || target.href;

        if (contentType.includes("text/css")) {
          const css = await upstream.text();
          headers.delete("content-length");
          return new Response(rewriteCss(css, finalUrl), { status: upstream.status, headers });
        }

        if (!contentType.includes("text/html")) {
          return new Response(upstream.body, { status: upstream.status, headers });
        }

        let html = await upstream.text();
        headers.delete("content-length");
        html = rewriteHtml(html, finalUrl);
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