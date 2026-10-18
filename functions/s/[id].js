// /s/<article id>: the page a shared Tangent link opens. Rendered here (not in the app) so link previews
// in Messages, Slack and email show the story. Offers two ways in: read it in Tangent without an account,
// or create one. Paywalled articles never appear (the feed view excludes them). Cached at the edge.
import { SB_URL, SB_KEY } from "../../lib/server.js";

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const clip = (s, n) => (s = String(s || "").replace(/\s+/g, " ").trim()).length > n ? s.slice(0, n - 1).trimEnd() + "…" : s;
// The sharer's first name, if the link carries one. Letters only, so it cannot carry markup or links.
export const sharerName = v => /^[\p{L}][\p{L}' .-]{0,29}$/u.test(v || "") ? v.trim() : "";

async function article(id) {
  const r = await fetch(`${SB_URL}tangent_feed?id=eq.${id}&select=id,title,excerpt,image,source_name,author,kind,published_at,summary_short`, {
    headers: { apikey: SB_KEY, authorization: "Bearer " + SB_KEY },
  });
  if (!r.ok) return null;
  const [row] = await r.json();
  if (row?.kind === "search" && row.author) row.source_name = row.author;
  return row || null;
}

export function page(a, { from = "", origin = "https://tangentreads.com" } = {}) {
  const title = a ? clip(a.title, 140) : "Story not found";
  const teaser = a ? clip(a.summary_short || a.excerpt || "", 220) : "";
  const img = a && /^https?:\/\//.test(a.image || "") ? a.image : `${origin}/shot-desktop.jpg`;
  const lead = from ? `${esc(from)} shared this with you on Tangent` : "Shared with you on Tangent";
  const open = a ? `/#a=${a.id}` : "/";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)} · Tangent</title>
<meta name="description" content="${esc(teaser || "Read it on Tangent, the free news reader without paywalls.")}">
<meta property="og:site_name" content="Tangent">
<meta property="og:type" content="article">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(a ? `${a.source_name}${teaser ? ": " + teaser : ""}` : "")}">
<meta property="og:image" content="${esc(img)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#f4f1ec" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0c0d0f" media="(prefers-color-scheme: dark)">
<meta name="referrer" content="no-referrer">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/site.css">
<style>
.share { max-width: 620px; padding-top: 28px; padding-bottom: 56px; }
.from { font-size: 15px; font-weight: 600; color: var(--tint); margin: 0 0 14px; }
.story { background: var(--card); border-radius: 18px; overflow: hidden; border: 1px solid var(--sep); }
.story img { width: 100%; aspect-ratio: 16 / 9; object-fit: cover; background: var(--sep); }
.story .in { padding: 18px 20px 22px; }
.story .src { font-size: 15px; font-weight: 600; color: var(--label-2); }
.story h1 { font-size: 30px; line-height: 1.15; margin: 8px 0 10px; }
.story p { margin: 0; color: var(--label-2); }
.cta { display: grid; gap: 12px; margin-top: 22px; }
.why { margin-top: 26px; font-size: 15px; color: var(--label-2); }
.why b { color: var(--label); }
</style>
</head>
<body>
<header class="mast"><div class="wrap"><a class="logo" href="/welcome"><img class="mark" src="/mark.svg" alt="" width="28" height="30">Tangent</a><nav aria-label="Site"><a href="/welcome#signin">Sign in</a></nav></div></header>
<main class="wrap share">
  <p class="from">${lead}</p>
  ${a ? `<article class="story">${/^https?:\/\//.test(a.image || "") ? `<img src="${esc(a.image)}" alt="">` : ""}<div class="in"><div class="src">${esc(a.source_name)}</div><h1>${esc(title)}</h1>${teaser ? `<p>${esc(teaser)}</p>` : ""}</div></article>`
    : `<article class="story"><div class="in"><h1>That story is no longer available</h1><p>It may have been removed by its publisher. There is plenty more on Tangent.</p></div></article>`}
  <div class="cta">
    <a class="btn primary" href="${open}" id="read">${a ? "Read it in Tangent" : "Open Tangent"}</a>
    <a class="btn" href="/welcome?a=${a ? a.id : ""}#signup">Create a free account</a>
  </div>
  <p class="why"><b>Tangent is a free news reader.</b> It gathers the outlets, blogs and YouTube channels you choose, puts each story on one card instead of six, and leaves out paywalled articles. No account needed to read this one.</p>
</main>
<footer class="site"><div class="wrap"><nav aria-label="Footer"><a href="/welcome">About</a><a href="/help">Help</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a></nav><span>&copy; 2026 Tangent</span></div></footer>
<script>
// Reading without an account: remember the choice so the app opens straight to the story.
document.getElementById("read").addEventListener("click", function () {
  if (!/(^|;\\s*)tg_(in|guest)=1/.test(document.cookie)) document.cookie = "tg_guest=1; Path=/; Max-Age=31536000; Secure; SameSite=Lax";
  try { sessionStorage.setItem("fromShare", "1"); } catch (e) {}
});
</script>
</body>
</html>`;
}

export async function onRequestGet({ request, params, waitUntil }) {
  const url = new URL(request.url);
  const id = String(params.id || "");
  if (!/^\d{1,12}$/.test(id)) return new Response(page(null, { origin: url.origin }), { status: 404, headers: { "content-type": "text/html; charset=utf-8" } });
  const from = sharerName(url.searchParams.get("f"));
  // Cache the page per article and sharer name for ten minutes.
  const cache = caches.default;
  const key = new Request(`${url.origin}/s/${id}?f=${encodeURIComponent(from)}`);
  const hit = await cache.match(key);
  if (hit) return hit;
  const a = await article(id).catch(() => null);
  const res = new Response(page(a, { from, origin: url.origin }), {
    status: a ? 200 : 404,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=600" },
  });
  if (a) waitUntil(cache.put(key, res.clone()));
  return res;
}
