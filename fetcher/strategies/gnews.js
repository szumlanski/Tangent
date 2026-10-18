// Google News per-site search feed. Works for nearly any site, even ones with no
// feed or that block bots. Google wraps each link; decode() recovers the real URL.
import { get } from "../http.js";
import { parseFeed } from "./rss.js";

const host = u => new URL(u).hostname.replace(/^www\./, "");

export async function decode(gUrl) {
  const id = new URL(gUrl).pathname.split("/").pop();
  const page = await get(`https://news.google.com/rss/articles/${id}`);
  const sig = page.text.match(/data-n-a-sg="([^"]+)"/)?.[1];
  const ts = page.text.match(/data-n-a-ts="([^"]+)"/)?.[1];
  if (!sig || !ts) throw new Error("gnews: no signature");
  const inner = JSON.stringify([
    "garturlreq",
    [["X", "X", ["X", "X"], null, null, 1, 1, "US:en", null, 1, null, null, null, null, null, 0, 1], "X", "X", 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0],
    id, Number(ts), sig,
  ]);
  const body = "f.req=" + encodeURIComponent(JSON.stringify([[["Fbv4je", inner, null, "generic"]]]));
  const r = await get("https://news.google.com/_/DotsSplashUi/data/batchexecute", {
    method: "POST",
    body,
    headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
  });
  const line = r.text.split("\n").find(l => l.includes("garturlres"));
  if (!line) throw new Error("gnews: decode failed");
  return JSON.parse(JSON.parse(line)[0][2])[1];
}

async function search(q, limit = 25) {
  const r = await get(`https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`);
  if (!r.ok) throw new Error(`gnews HTTP ${r.status}`);
  const items = parseFeed(r.text).slice(0, limit);
  // Titles come as "Headline - Outlet"; drop the outlet suffix.
  for (const it of items) {
    if (it.sourceTitle) it.title = it.title.replace(new RegExp(`\\s+-\\s+${it.sourceTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`), "");
    it.excerpt = "";
    it.gnews = it.url;
  }
  return items;
}

export const gnews = source => search(`site:${host(source.site_url)} when:2d`);

// A shelf started from a phrase follows it across every outlet Google News covers.
// The outlet's name rides along as the author, so cards can credit the real publisher.
// A longer look back (days) also returns more items, which is what source suggestions need.
export async function gsearch(source, days = 3) {
  const items = await search(`${source.query} when:${days}d`, days > 3 ? 100 : 25);
  for (const it of items) it.author = it.sourceTitle || null;
  return items;
}
