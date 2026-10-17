// Weekly source scout. Finds outlets that keep showing up around your topics,
// vets them (fresh, free, extractable) and files them as suggestions to approve.
import { get } from "./http.js";
import { parseFeed } from "./strategies/rss.js";
import { gnews, decode } from "./strategies/gnews.js";
import { extract } from "./extract.js";
import { isBlockedDomain } from "./paywall.js";
import * as db from "./db.js";

const QUERIES = {
  solar: ["solar energy", "battery storage", "Florida utility rates", "net metering", "home solar"],
  tech: ["artificial intelligence", "Anthropic Claude", "consumer tech"],
  world: ["world news"],
  swfl: ["Fort Myers", "Cape Coral", "Naples Florida", "Lee County Florida", "Charlotte County Florida"],
  travel: ["travel guide", "national parks travel"],
  vermont: ["Vermont"],
  sports: ["Florida Gators", "Michigan State football", "college football"],
};
// Platforms and aggregators are not sources.
const SKIP = /(^|\.)(youtube|youtu|facebook|fb|x|twitter|instagram|tiktok|reddit|linkedin|wikipedia|google|msn|yahoo|apple|amazon|bing|substack|medium|github|t|bit|ow|archive|newsbreak|ground|flipboard|smartnews|prnewswire|businesswire|globenewswire|einpresswire|accessnewswire|benzinga|marketscreener|stocktitan)\.(com|org|be|co|ly|news|net|is)$/;
const PER_TOPIC = 6;
const DAY = 864e5;

const domainOf = u => { try { return new URL(u).hostname.replace(/^www\./, "").toLowerCase(); } catch { return null; } };

async function candidates(known) {
  const tally = {}; // domain -> {topic: {n, why}}
  const add = (domain, topic, why) => {
    if (!domain || known.has(domain) || SKIP.test(domain) || isBlockedDomain("https://" + domain + "/")) return;
    const t = ((tally[domain] ||= {})[topic] ||= { n: 0, why });
    t.n++;
  };
  // 1. Who shows up in Google News for each topic.
  for (const [topic, qs] of Object.entries(QUERIES)) {
    for (const q of qs) {
      try {
        const r = await get(`https://news.google.com/rss/search?q=${encodeURIComponent(q + " when:7d")}&hl=en-US&gl=US&ceid=US:en`);
        for (const it of parseFeed(r.text)) add(domainOf(it.sourceUrl), topic, `In Google News for "${q}"`);
      } catch (e) { console.warn("scout gnews:", q, e.message); }
    }
  }
  // 2. Who your current sources link to.
  for (const a of await db.recentBodies()) {
    const topic = a.tangent_sources?.topic;
    if (!topic) continue;
    const self = domainOf(a.url);
    for (const m of (a.body_html || "").matchAll(/href="(https?:\/\/[^"]+)"/g)) {
      const d = domainOf(m[1]);
      if (d && d !== self) add(d, topic, "Linked from your articles");
    }
  }
  // Best topic per domain, then the top few per topic.
  const best = Object.entries(tally).map(([domain, topics]) => {
    const [topic, t] = Object.entries(topics).sort((a, b) => b[1].n - a[1].n)[0];
    return { domain, topic, n: t.n, why: `${t.why} (${t.n}x this week)` };
  });
  const out = [];
  for (const topic of Object.keys(QUERIES)) {
    out.push(...best.filter(b => b.topic === topic && b.n >= 3).sort((a, b) => b.n - a.n).slice(0, PER_TOPIC));
  }
  return out;
}

async function findFeed(site) {
  try {
    const r = await get(site);
    const m = [...r.text.matchAll(/<link[^>]+type=["']application\/(rss|atom)\+xml["'][^>]*>/gi)]
      .map(x => x[0].match(/href=["']([^"']+)["']/i)?.[1]).filter(Boolean);
    const name = r.text.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)/i)?.[1];
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
    return { feed_url: null, items: null, name: null, site };
  }
}

async function vet(c) {
  const site = `https://${c.domain}/`;
  const found = await findFeed(site);
  let items = found.items, strategies = ["rss", "gnews"];
  if (!items) {
    items = await gnews({ site_url: site }).catch(() => []);
    strategies = ["gnews", "sitemap"];
  }
  const recent = items.filter(i => i.published && Date.now() - Date.parse(i.published) < 7 * DAY);
  if (recent.length < 3) return { ...c, reject: `only ${recent.length} posts this week` };
  // Spot-check a few articles for paywalls and readable text.
  const sample = recent.slice(0, 4);
  let free = 0, readable = 0;
  const samples = [];
  for (const it of sample) {
    let url = it.url;
    if (it.gnews) { try { url = await decode(it.gnews); } catch { continue; } }
    const ex = await extract(url).catch(() => null);
    if (!ex) continue;
    if (!ex.paywall) free++;
    if (!ex.paywall && ex.wordCount >= 150) readable++;
    samples.push({ title: it.title || ex.title, url });
  }
  const free_ratio = sample.length ? free / sample.length : 0;
  if (free_ratio < 0.75 || readable < 2) return { ...c, reject: `free ${free}/${sample.length}, readable ${readable}` };
  return {
    domain: c.domain,
    name: found.name || c.domain,
    topic: c.topic,
    kind: "news",
    site_url: found.site || site,
    feed_url: found.feed_url,
    strategies,
    samples: samples.slice(0, 3),
    free_ratio,
    per_week: recent.length,
    reason: c.why,
  };
}

const known = new Set([
  ...(await db.allSources()).flatMap(s => [s.site_url, s.feed_url]).map(domainOf).filter(Boolean),
  ...(await db.allSuggestionDomains()),
]);
const list = await candidates(known);
console.log(`Vetting ${list.length} candidates`);
const ok = [];
for (const c of list) {
  const v = await vet(c);
  console.log(v.reject ? `  skip ${c.domain}: ${v.reject}` : `  SUGGEST ${v.domain} (${v.topic}) ${v.reason}`);
  if (!v.reject) ok.push(v);
}
await db.insertSuggestions(ok);
console.log(`${ok.length} suggestions filed`);
if (process.env.DRY === "1") console.log(JSON.stringify(db.dryRows.slice(0, 3), null, 1));
