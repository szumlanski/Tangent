// GET /api/espn?p=football/nfl/scoreboard
// Same-origin, edge-cached pass-through to ESPN's public site API (its CORS headers are inconsistent).
const OK = /^(football|basketball|hockey|baseball|soccer)\/[a-z0-9.-]+\/(scoreboard|rankings|news|teams\/\d+(\/schedule)?)$/;

export async function onRequestGet({ request, waitUntil }) {
  const url = new URL(request.url);
  const p = url.searchParams.get("p") || "";
  if (!OK.test(p)) return Response.json({ error: "path not allowed" }, { status: 400 });
  const qs = new URLSearchParams(url.searchParams);
  qs.delete("p");
  const target = `https://site.api.espn.com/apis/site/v2/sports/${p}${qs.size ? "?" + qs : ""}`;
  // Scores move fast; rankings, news and schedules less so.
  const ttl = /scoreboard/.test(p) ? 30 : /schedule|teams/.test(p) ? 120 : 600;

  const cache = caches.default;
  const key = new Request("https://tangent-cache/espn/" + p + "?" + qs);
  const hit = await cache.match(key);
  if (hit) return hit;
  const r = await fetch(target, { headers: { "user-agent": "Mozilla/5.0 Tangent", accept: "application/json" } });
  if (!r.ok) return Response.json({ error: `espn ${r.status}` }, { status: 502 });
  const res = new Response(r.body, { headers: { "content-type": "application/json", "cache-control": `public, max-age=${ttl}` } });
  waitUntil(cache.put(key, res.clone()));
  return res;
}
