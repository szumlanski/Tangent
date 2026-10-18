// Vetting for sources readers add (a pasted site, feed or YouTube channel, or a topic phrase), and
// suggested sources for each shelf. Runs at the start of every fetch, a few sources at a time.
import { get } from "./http.js";
import { parseFeed } from "./strategies/rss.js";
import { gnews, gsearch, decode } from "./strategies/gnews.js";
import { extract } from "./extract.js";
import { isBlockedDomain } from "./paywall.js";
import * as db from "./db.js";

const DAY = 864e5;
const PER_RUN = 8;            // pending sources vetted per run
const FRESH_DAYS = 60;        // a source must have posted within this many days
// Platforms and aggregators are not outlets, so they are never suggested.
export const SKIP = /(^|\.)(youtube|youtu|facebook|fb|x|twitter|instagram|tiktok|reddit|linkedin|wikipedia|google|msn|yahoo|apple|amazon|bing|github|t|bit|ow|archive|newsbreak|ground|flipboard|smartnews|prnewswire|businesswire|globenewswire|einpresswire|accessnewswire|benzinga|marketscreener|stocktitan)\.(com|org|be|co|ly|news|net|is)$/;
export const domainOf = u => { try { return new URL(u).hostname.replace(/^www\./, "").toLowerCase(); } catch { return null; } };

export async function findFeed(site) {
  try {
    const r = await get(site);
    if (!r.ok) return { feed_url: null, items: null, name: null, site, status: r.status };
    // The address may itself be a feed.
    try { const direct = parseFeed(r.text); if (direct.length) return { feed_url: r.url, items: direct, name: feedTitle(r.text), site: r.url }; } catch {}
    const m = [...r.text.matchAll(/<link[^>]+type=["']application\/(rss|atom)\+xml["'][^>]*>/gi)]
      .map(x => x[0].match(/href=["']([^"']+)["']/i)?.[1]).filter(Boolean);
    // Match the closing quote that opened the value, so "Tom's Guide" keeps its apostrophe.
    const og = r.text.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=(?:"([^"]+)"|'([^']+)')/i);
    const name = (og && (og[1] || og[2]))
      || r.text.match(/<title[^>]*>([^<]{2,80})<\/title>/i)?.[1]?.split(/\s[|:–-]\s/)[0]?.trim();
    for (const href of [...m.map(h => new URL(h, r.url).href), ...["/feed", "/rss", "/feed.xml", "/rss.xml", "/index.xml", "/atom.xml"].map(p => new URL(p, r.url).href)]) {
      try {
        const f = await get(href);
        if (!f.ok) continue;
        const items = parseFeed(f.text);
        if (items.length) return { feed_url: href, items, name, site: r.url };
      } catch {}
    }
    return { feed_url: null, items: null, name, site: r.url };
  } catch {
    return { feed_url: null, items: null, name: null, site, status: 0 };
  }
}
const feedTitle = xml => xml.match(/<title[^>]*>(?:<!\[CDATA\[)?([^<\]]{2,80})/i)?.[1]?.trim() || null;

// YouTube: any channel, @handle or video address resolves to the channel's feed.
async function vetYouTube(url) {
  let channel = url.match(/\/channel\/(UC[\w-]{22})/)?.[1];
  let name = null;
  if (!channel) {
    const r = await get(url);
    if (!r.ok) return { reject: "Could not open that YouTube page." };
    channel = r.text.match(/"(?:channelId|externalId)":"(UC[\w-]{22})"/)?.[1] || r.text.match(/channel\/(UC[\w-]{22})/)?.[1];
    const og = r.text.match(/<meta[^>]+property=["']og:title["'][^>]+content=(?:"([^"]+)"|'([^']+)')/i);
    name = (og && (og[1] || og[2])) || null;
  }
  if (!channel) return { reject: "That is not a YouTube channel." };
  const feed_url = `https://www.youtube.com/feeds/videos.xml?channel_id=${channel}`;
  const f = await get(feed_url);
  const items = f.ok ? parseFeed(f.text) : [];
  if (!items.some(i => i.published && Date.now() - Date.parse(i.published) < FRESH_DAYS * DAY)) return { reject: `No new videos in the last ${FRESH_DAYS} days.` };
  return { ok: { name: name || feedTitle(f.text) || "YouTube channel", kind: "youtube", site_url: `https://www.youtube.com/channel/${channel}`, feed_url, strategies: ["rss"] } };
}

// A site or feed: it needs recent posts and articles that are not locked.
export async function vetUrl(url) {
  const domain = domainOf(url);
  if (!domain) return { reject: "That address does not look like a website." };
  if (/(^|\.)youtube\.com$|(^|\.)youtu\.be$/.test(domain)) return vetYouTube(url);
  if (isBlockedDomain(url)) return { reject: "That site puts most articles behind a paywall." };
  const found = await findFeed(url);
  let items = found.items, strategies = ["rss", "gnews"];
  if (!items) {
    if (found.status === 0) return { reject: "Could not reach that site." };
    items = await gnews({ site_url: `https://${domain}/` }).catch(() => []);
    strategies = ["gnews", "sitemap", "scrape"];
  }
  const recent = (items || []).filter(i => !i.published || Date.now() - Date.parse(i.published) < FRESH_DAYS * DAY);
  if (!recent.length) return { reject: items?.length ? `Nothing new in the last ${FRESH_DAYS} days.` : "Could not find any articles on that site." };
  // Spot-check a few articles. Pages that will not load are fine (the reader links out); locked ones are not.
  let checked = 0, locked = 0;
  for (const it of recent.slice(0, 3)) {
    let u = it.url;
    if (it.gnews) { try { u = await decode(it.gnews); } catch { continue; } }
    const ex = await extract(u).catch(() => null);
    if (!ex) continue;
    checked++;
    if (ex.paywall) locked++;
  }
  if (checked && locked / checked > 0.5) return { reject: "Most of its articles are behind a paywall." };
  const looksBlog = /(substack\.com|wordpress\.com|blogspot\.com|ghost\.io|medium\.com)$/.test(domain) || /\/blog\b/.test(url);
  return { ok: { name: (found.name || domain).slice(0, 80), kind: looksBlog ? "blog" : "news", site_url: found.site || url, feed_url: found.feed_url, strategies } };
}

export async function vetSearch(source) {
  const items = await gsearch(source).catch(() => []);
  if (!items.length) return { reject: "Nothing in the news matches that phrase yet. Try broader words." };
  return { ok: { strategies: ["gsearch"] }, items };
}

// Outlets that keep showing up in a phrase's results, as suggestions for every shelf following it.
export function outletsFrom(items, catalog) {
  const by = new Map();
  for (const it of items) {
    const d = domainOf(it.sourceUrl || "");
    if (!d || SKIP.test(d) || isBlockedDomain(`https://${d}/`)) continue;
    const o = by.get(d) || { domain: d, name: it.sourceTitle || d, url: `https://${d}`, hits: 0 };
    o.hits++;
    by.set(d, o);
  }
  // One mention is noise; an outlet already in the catalog or covering it repeatedly is a real lead.
  return [...by.values()].map(o => ({ ...o, source_id: catalog.get(o.domain) || null }))
    .filter(o => o.source_id || o.hits >= 2).sort((a, b) => b.hits - a.hits).slice(0, 12);
}

export async function vetPending() {
  const pending = await db.pendingSources(PER_RUN);
  if (!pending.length) return;
  const catalog = await db.catalogByDomain();
  for (const s of pending) {
    let v;
    try { v = s.kind === "search" ? await vetSearch(s) : await vetUrl(s.site_url); }
    catch (e) { v = { reject: "Could not check it: " + e.message.slice(0, 100) }; }
    if (v.reject) {
      await db.updateSource(s.id, { status: "rejected", status_note: v.reject, enabled: false });
      console.log(`  vet: rejected ${s.name}: ${v.reject}`);
      continue;
    }
    const patch = { status: "active", status_note: null, enabled: true, ...v.ok };
    // The same feed may already be in the catalog under another address; keep both rows apart by feed.
    try { await db.updateSource(s.id, patch); }
    catch { await db.updateSource(s.id, { status: "active", enabled: true, strategies: v.ok.strategies || s.strategies }); }
    console.log(`  vet: added ${v.ok.name || s.name}`);
    if (v.items) await db.saveShelfSuggestions(s.id, outletsFrom(await gsearch(s, 30).catch(() => v.items), catalog));
  }
}

// Once an hour, refresh suggestions for every shelf that follows a phrase.
export async function refreshSuggestions() {
  const searches = await db.activeSearchSources();
  if (!searches.length) return;
  const catalog = await db.catalogByDomain();
  for (const s of searches) {
    const items = await gsearch(s, 30).catch(() => []);
    if (items.length) await db.saveShelfSuggestions(s.id, outletsFrom(items, catalog));
  }
}
