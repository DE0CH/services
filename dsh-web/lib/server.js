// The persistent web UI of Jarvis 4's `dsh` sessions (DeepSeek Harness, DE0CH/deepseek-harness): one stable origin,
// https://dsh.deyaochen.com/ (Cloudflare Access: Deyao), in front of sessions that live on short-lived Fly machines.
//
//   /s/<session id>/…  the session's dsh web UI. Requests go to the session's own origin
//                      https://<session id>-s.deyaochen.com/… with this service's Access service token (dsh-web; the
//                      session hosts admit any service token of the account), WebSockets included. Static files (the
//                      UI's hashed bundles, plugin combo scripts by revision) are kept here, so the shell loads from
//                      this deployment; a paused or gone session gets a page that says so instead of an error.
//   /                  how to open one (the Jarvis 4 app's Remote button links to /s/<id>/).
//
// The session side (DE0CH/jarvis4 session-image harness-dsh.sh, dsh-front.js) hands dsh's launch token to requests
// Access admitted, by a redirect this proxy keeps under the mount; dsh's cookie gets Path=/s/<id>/ so sessions never
// share one. No state: two replicas, either one serves any request.
"use strict";
const http = require("http");
const https = require("https");
const tls = require("tls");

const PORT = +(process.env.PORT || 8095);
const SUFFIX = process.env.SESSION_HOST_SUFFIX || "-s.deyaochen.com";
const ACCESS_ID = process.env.CF_ACCESS_CLIENT_ID || "";
const ACCESS_SECRET = process.env.CF_ACCESS_CLIENT_SECRET || "";
const CACHE_BYTES = +(process.env.CACHE_BYTES || 48 * 1024 * 1024);
const DRAIN_MS = +(process.env.DRAIN_MS || 6000);
const SESSION_ID = /^s[0-9a-f]{16}$/;
const HOP = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer",
  "host", "cf-access-jwt-assertion", "cf-connecting-ip", "cf-ipcountry", "cf-ray", "cf-visitor", "cdn-loop", "x-forwarded-for",
  "x-forwarded-proto", "x-forwarded-host", "x-real-ip"]);

/** "/s/<id>/rest?q" -> {id, rest: "/rest?q"}; null when it isn't a session path. */
function parseMount(url) {
  const m = /^\/s\/([^/?#]+)(\/[^#]*)?$/.exec(url);
  if (!m || !SESSION_ID.test(m[1])) return null;
  return { id: m[1], rest: m[2] || "" };
}

/** A redirect from the session, kept under its mount (relative ones resolve against the request as they are). */
function rewriteLocation(loc, id) {
  if (!loc) return loc;
  const host = `https://${id}${SUFFIX}`;
  if (loc.startsWith(host)) loc = loc.slice(host.length) || "/";
  return loc.startsWith("/") && !loc.startsWith("//") ? `/s/${id}${loc}` : loc;
}

/** dsh's host-only cookie, scoped to this session's mount. */
function rewriteCookie(c, id) {
  let out = c.replace(/;\s*Domain=[^;]*/gi, "");
  out = /;\s*Path=/i.test(out) ? out.replace(/;\s*Path=[^;]*/i, `; Path=/s/${id}/`) : `${out}; Path=/s/${id}/`;
  return out;
}

/** Static files dsh serves the same to every session of a version: the hashed bundles and the revisioned plugin scripts. */
function cacheable(method, rest) {
  if (method !== "GET") return false;
  const path = rest.split("?")[0];
  if (path.startsWith("/api/") || path === "/connect" || path === "/" || path === "/index.html") return false;
  if (path.startsWith("/plugins/")) return /[?&]rev=/.test(rest);
  return /\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.(js|css|woff2?|svg|png|wasm|map)$/.test(path);
}

const cache = new Map(); // rest -> {status, headers, body}; insertion order = LRU order
let cacheSize = 0;
function cachePut(key, entry) {
  if (entry.body.length > CACHE_BYTES / 8) return;
  if (cache.has(key)) { cacheSize -= cache.get(key).body.length; cache.delete(key); }
  cache.set(key, entry); cacheSize += entry.body.length;
  for (const [k, v] of cache) { if (cacheSize <= CACHE_BYTES) break; cache.delete(k); cacheSize -= v.body.length; }
}
function cacheGet(key) {
  const e = cache.get(key);
  if (e) { cache.delete(key); cache.set(key, e); }
  return e;
}

function upstreamHeaders(req, id) {
  const h = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k)) h[k] = v;
  h.host = id + SUFFIX;
  if (h.origin) h.origin = `https://${id}${SUFFIX}`;
  if (h.referer) h.referer = `https://${id}${SUFFIX}/`;
  if (ACCESS_ID) { h["cf-access-client-id"] = ACCESS_ID; h["cf-access-client-secret"] = ACCESS_SECRET; }
  return h;
}

function page(res, status, title, body) {
  const html = `<!doctype html><html><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>${title}</title><style>body{font-family:-apple-system,system-ui,sans-serif;background:#f4f5f7;color:#1a1d21;margin:0;padding:16px;display:flex;justify-content:center}
@media(prefers-color-scheme:dark){body{background:#101216;color:#eceef1}.c{background:#1a1e24!important;border-color:#2a2f37!important}}
.c{background:#fff;border:1px solid #e5e7eb;border-radius:18px;padding:22px;max-width:520px;width:100%;margin-top:10vh}h1{font-size:19px;margin:0 0 10px}p{line-height:1.5}</style></head>
<body><div class=c><h1>${title}</h1>${body}</div></body></html>`;
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(html);
}

function sessionDown(res, id, why) {
  page(res, 503, "This DeepSeek Harness session isn't running",
    `<p>Session <code>${id}</code> is paused or no longer exists (${why}).</p><p>Resume it in the Jarvis 4 app; this page
works again once its machine is up.</p>`);
}

function proxy(req, res, m) {
  const key = m.rest || "/";
  const hit = cacheable(req.method, key) && cacheGet(key);
  if (hit) { res.writeHead(hit.status, hit.headers); return res.end(hit.body); }
  const up = https.request({ host: m.id + SUFFIX, port: 443, method: req.method, path: m.rest || "/",
    headers: upstreamHeaders(req, m.id), timeout: 60000 }, (r) => {
    // a session host that isn't served (tunnel agent gone) or Access refusing our token
    if ([502, 503, 504, 530].includes(r.statusCode) || /cloudflareaccess\.com/.test(r.headers.location || "")) {
      r.resume();
      return sessionDown(res, m.id, `its origin answered ${r.statusCode}`);
    }
    const headers = {};
    for (const [k, v] of Object.entries(r.headers)) if (!HOP.has(k)) headers[k] = v;
    if (headers.location) headers.location = rewriteLocation(headers.location, m.id);
    if (headers["set-cookie"]) headers["set-cookie"] = [].concat(headers["set-cookie"]).map((c) => rewriteCookie(c, m.id));
    if (r.statusCode === 200 && cacheable(req.method, key)) {
      const chunks = [];
      r.on("data", (c) => chunks.push(c));
      r.on("end", () => {
        const body = Buffer.concat(chunks);
        const keep = { ...headers }; delete keep["set-cookie"];
        cachePut(key, { status: 200, headers: keep, body });
        res.writeHead(200, headers); res.end(body);
      });
      return;
    }
    res.writeHead(r.statusCode, headers);
    r.pipe(res);
  });
  up.on("timeout", () => up.destroy(new Error("timeout")));
  up.on("error", (e) => { if (!res.headersSent) sessionDown(res, m.id, e.code || e.message); else res.destroy(); });
  req.pipe(up);
}

let draining = false;
const server = http.createServer((req, res) => {
  if (req.url === "/healthz") { res.writeHead(200); return res.end("ok"); }
  if (req.url === "/readyz") { res.writeHead(draining ? 503 : 200); return res.end(draining ? "draining" : "ok"); }
  const bare = /^\/s\/([^/?#]+)$/.exec(req.url.split("?")[0]);
  if (bare && SESSION_ID.test(bare[1])) { res.writeHead(301, { location: `/s/${bare[1]}/` }); return res.end(); }
  const m = parseMount(req.url);
  if (m) return proxy(req, res, m);
  if (req.url === "/" || req.url.startsWith("/?")) {
    return page(res, 200, "DeepSeek Harness", `<p>Open a <code>dsh</code> session from the Jarvis 4 app (Remote), or go to
<code>/s/&lt;session id&gt;/</code> here.</p>`);
  }
  page(res, 404, "Not found", "<p>Session pages are at <code>/s/&lt;session id&gt;/</code>.</p>");
});

server.on("upgrade", (req, sock, head) => {
  const m = parseMount(req.url);
  if (!m) return sock.destroy();
  const h = upstreamHeaders(req, m.id);
  const up = tls.connect({ host: m.id + SUFFIX, port: 443, servername: m.id + SUFFIX }, () => {
    let out = `${req.method} ${m.rest || "/"} HTTP/1.1\r\nhost: ${m.id}${SUFFIX}\r\nconnection: Upgrade\r\nupgrade: ${req.headers.upgrade}\r\n`;
    for (const [k, v] of Object.entries(h)) if (k !== "host") out += `${k}: ${v}\r\n`;
    up.write(out + "\r\n"); if (head && head.length) up.write(head);
    up.pipe(sock); sock.pipe(up);
  });
  up.on("error", () => sock.destroy()); sock.on("error", () => up.destroy());
});

if (require.main === module) {
  if (!ACCESS_ID || !ACCESS_SECRET) console.warn("[dsh-web] no CF_ACCESS_CLIENT_ID/SECRET: session hosts will refuse every request");
  server.listen(PORT, () => console.log(`[dsh-web] :${PORT} -> https://<session>${SUFFIX}/`));
  process.on("SIGTERM", () => { draining = true; setTimeout(() => server.close(() => process.exit(0)), DRAIN_MS); });
}

module.exports = { parseMount, rewriteLocation, rewriteCookie, cacheable, cachePut, cacheGet, server };
