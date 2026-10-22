// Discovery for phrase interests ("Claude", "DaVinci Resolve"): the most-watched YouTube videos of
// the week, Hacker News stories with real discussion, and Reddit's top posts. Each source row holds
// the phrase in `query`. All free and keyless; a provider that refuses (Reddit often does) is skipped.
import { get as http } from "../http.js";

const get = async (url, opts) => { const r = await http(url, opts); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text; };

// Mostly non-Latin titles are skipped; the app is English for now.
const latin = t => (t.match(/[A-Za-z]/g) || []).length >= (t.replace(/\s/g, "").length * 0.6);
const num = s => { const m = String(s || "").replace(/,/g, "").match(/([\d.]+)\s*([KMB])?/i); if (!m) return 0; return Math.round(+m[1] * ({ K: 1e3, M: 1e6, B: 1e9 }[(m[2] || "").toUpperCase()] || 1)); };
// "15h ago", "2 days ago", "3 weeks ago" into a date.
const UNIT = { s: 1e3, sec: 1e3, second: 1e3, m: 6e4, min: 6e4, minute: 6e4, h: 36e5, hr: 36e5, hour: 36e5, d: 864e5, day: 864e5, w: 6048e5, wk: 6048e5, week: 6048e5, mo: 2592e6, month: 2592e6, y: 31536e6, yr: 31536e6, year: 31536e6 };
export const ago = s => { const m = String(s || "").toLowerCase().match(/(\d+)\s*(seconds?|sec|minutes?|min|hours?|hr|days?|weeks?|wk|months?|mo|years?|yr|[smhdwy])\b/); if (!m) return null; const u = UNIT[m[2].replace(/s$/, "")] || UNIT[m[2]]; return u ? new Date(Date.now() - +m[1] * u).toISOString() : null; };

export function parseYouTubeResults(html) {
  const m = html.match(/var ytInitialData = (\{.*?\});<\/script>/s);
  if (!m) return [];
  const out = [];
  const walk = o => {
    if (Array.isArray(o)) return o.forEach(walk);
    if (!o || typeof o !== "object") return;
    const v = o.videoRenderer;
    if (v?.videoId) {
      const title = v.title?.runs?.map(r => r.text).join("") || "";
      const lengthText = v.lengthText?.simpleText || "";
      const secs = lengthText.split(":").reduce((s, x) => s * 60 + +x, 0);
      if (title && latin(title) && secs >= 60) out.push({
        url: `https://www.youtube.com/watch?v=${v.videoId}`, videoId: v.videoId, title,
        author: v.ownerText?.runs?.[0]?.text || null,
        excerpt: v.detailedMetadataSnippets?.[0]?.snippetText?.runs?.map(r => r.text).join("") || v.descriptionSnippet?.runs?.map(r => r.text).join("") || null,
        image: `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
        published: ago(v.publishedTimeText?.simpleText), engagement: num(v.viewCountText?.simpleText),
      });
    }
    for (const k in o) walk(o[k]);
  };
  walk(JSON.parse(m[1]));
  return out;
}

// This week's uploads for the phrase, most viewed first; keep ones with a real audience.
export async function ytsearch(source) {
  const html = await get(`https://www.youtube.com/results?search_query=${encodeURIComponent(source.query)}&sp=CAMSAggD`, { headers: { "accept-language": "en-US,en;q=0.9" } });
  return parseYouTubeResults(html).filter(v => v.engagement >= 1000).slice(0, 20);
}

export async function hnsearch(source) {
  const since = Math.floor(Date.now() / 1000) - 7 * 86400;
  const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(source.query)}&tags=story&hitsPerPage=30&numericFilters=${encodeURIComponent(`points>=25,created_at_i>${since}`)}`;
  const d = JSON.parse(await get(url));
  return d.hits.filter(h => h.title).map(h => ({
    url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`, title: h.title, published: h.created_at,
    author: h.url ? new URL(h.url).hostname.replace(/^www\./, "") : "Hacker News", engagement: h.points,
  }));
}

export async function redditsearch(source) {
  const d = JSON.parse(await get(`https://www.reddit.com/search.json?q=${encodeURIComponent(source.query)}&sort=top&t=week&limit=25&raw_json=1`, { headers: { "user-agent": "tangent-news/1.0 (+https://tangentreads.com)" } }));
  return (d.data?.children || []).map(c => c.data).filter(p => p.score >= 50 && !p.over_18 && latin(p.title)).map(p => ({
    url: p.is_self ? `https://www.reddit.com${p.permalink}` : p.url, title: p.title, published: new Date(p.created_utc * 1000).toISOString(),
    author: `r/${p.subreddit}`, excerpt: p.selftext ? p.selftext.slice(0, 300) : null, engagement: p.score,
  }));
}
