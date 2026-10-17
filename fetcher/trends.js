// Local trends: Google Trends for Florida and the top posts of the day on local Reddit.
import { get } from "./http.js";
import { parseFeed } from "./strategies/rss.js";
import { XMLParser } from "fast-xml-parser";
import { plain } from "./extract.js";

const SUBS = ["fortmyers", "capecoral", "naples", "SWFL", "sanibel"];
const arr = v => (v == null ? [] : Array.isArray(v) ? v : [v]);

async function googleTrends() {
  const r = await get("https://trends.google.com/trending/rss?geo=US-FL");
  if (!r.ok) throw new Error(`gtrends HTTP ${r.status}`);
  const doc = new XMLParser({ ignoreAttributes: true }).parse(r.text);
  return arr(doc.rss?.channel?.item).slice(0, 20).map((it, i) => {
    const news = arr(it["ht:news_item"]).slice(0, 3).map(n => ({
      title: plain(String(n["ht:news_item_title"] ?? "")), url: n["ht:news_item_url"], source: n["ht:news_item_source"],
    }));
    return {
      source: "gtrends", channel: "Florida", rank: i + 1,
      title: String(it.title),
      url: news[0]?.url || `https://www.google.com/search?q=${encodeURIComponent(it.title)}`,
      traffic: it["ht:approx_traffic"] ? String(it["ht:approx_traffic"]) : null,
      image: it["ht:picture"] || null,
      news,
    };
  });
}

// One request for all local subreddits; Reddit throttles bursts.
async function reddit() {
  const r = await get(`https://www.reddit.com/r/${SUBS.join("+")}/top/.rss?t=day&limit=25`);
  if (!r.ok) throw new Error(`reddit HTTP ${r.status}`);
  const rank = {};
  return parseFeed(r.text).map(it => {
    const channel = "r/" + (it.category || "SWFL");
    rank[channel] = (rank[channel] || 0) + 1;
    return { source: "reddit", channel, rank: rank[channel], title: plain(it.title), url: it.url, traffic: null, image: it.image || null, news: null };
  });
}

export async function collectTrends() {
  const out = [];
  for (const job of [googleTrends, reddit]) {
    try { out.push(...(await job())); } catch (e) { console.warn("trends:", e.message); }
  }
  return out;
}
