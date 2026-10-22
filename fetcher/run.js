// One fetch pass over every enabled source. Run by GitHub Actions every 15 min.
import { get, pool } from "./http.js";
import { rss } from "./strategies/rss.js";
import { gnews, gsearch, decode } from "./strategies/gnews.js";
import { sitemap } from "./strategies/sitemap.js";
import { scrape } from "./strategies/scrape.js";
import { ytsearch, hnsearch, redditsearch } from "./strategies/discover.js";
import { extract, plain } from "./extract.js";
import { isBlockedDomain } from "./paywall.js";
import * as db from "./db.js";
import { collectTrends } from "./trends.js";
import { stories } from "./stories.js";
import { alerts } from "./alerts.js";
import { vetPending, refreshSuggestions } from "./vet.js";
import { retention } from "./retention.js";
import { signups } from "./signups.js";
import { skipped } from "./skip.js";
import { localTopic, isLocal, opening } from "./local.js";
import { enrich } from "./enrich.js";
import { refreshInterests } from "./interests.js";

const STRATEGIES = { rss, gnews, gsearch, sitemap, scrape, ytsearch, hnsearch, redditsearch };
const RUN_START = Date.now();
// News goes stale fast; videos and blogs post less often.
// Weekly papers post less often, so news looks back a week; ranking favors fresh stories anyway.
const MAX_AGE = { search: 3 * 864e5, news: 7 * 864e5, blog: 14 * 864e5, youtube: 14 * 864e5, podcast: 14 * 864e5 };
const MAX_NEW_PER_SOURCE = 15;
const ROW_DEFAULTS = {
  origin_url: null, excerpt: null, image: null, author: null, body_html: null, word_count: null,
  extracted: false, paywalled: false, paywall_reason: null, video_id: null, locked: false, offtopic: false, engagement: null,
};

// Try each strategy in order; the first that returns items wins.
async function discover(source) {
  // Channels read their feed; YouTube discovery (no feed) uses its search strategy.
  const order = source.kind === "youtube" && source.feed_url ? ["rss"] : source.strategies;
  const errors = [];
  for (const name of order) {
    if (name === "rss" && !source.feed_url) continue;
    try {
      const items = await STRATEGIES[name](source);
      if (items.length) return { strategy: name, items };
      errors.push(`${name}: empty`);
    } catch (e) {
      errors.push(`${name}: ${e.message}`);
    }
  }
  throw new Error(errors.join("; ") || "no strategies");
}

async function isShort(videoId) {
  const r = await fetch(`https://www.youtube.com/shorts/${videoId}`, { method: "HEAD", redirect: "manual" }).catch(() => null);
  return r?.status === 200;
}

async function processSource(source) {
  try {
    return await processSourceInner(source);
  } catch (e) {
    await db.updateSource(source.id, { last_run_at: new Date().toISOString(), last_error: e.message.slice(0, 500) }).catch(() => {});
    return { source: source.name, error: e.message };
  }
}

async function processSourceInner(source) {
  const started = new Date().toISOString();
  let found;
  try {
    found = await discover(source);
  } catch (e) {
    await db.updateSource(source.id, { last_run_at: started, last_error: e.message.slice(0, 500) });
    return { source: source.name, error: e.message };
  }

  const fresh = found.items.filter(i => i.url && !skipped(source, i.url) && (!i.published || Date.now() - Date.parse(i.published) < MAX_AGE[source.kind]));
  const have = await db.known(fresh.map(i => i.url));
  const todo = fresh.filter(i => !have.has(i.url)).slice(0, MAX_NEW_PER_SOURCE);

  const rows = [];
  let paywalled = 0;
  for (const it of todo) {
    try {
      const row = {
        source_id: source.id,
        kind: source.kind,
        url: it.url,
        origin_url: it.gnews || null,
        title: it.title,
        excerpt: it.excerpt || null,
        image: /^https?:\/\//.test(it.image || "") ? it.image : null,
        author: it.author || null,
        engagement: it.engagement ?? null,
        published_at: it.published ? new Date(it.published).toISOString() : started,
      };
      if (source.kind === "youtube") {
        if (it.videoId && (await isShort(it.videoId))) continue;
        row.video_id = it.videoId;
        rows.push(row);
        continue;
      }
      if (it.gnews) row.url = await decode(it.gnews);
      if (isBlockedDomain(row.url) && source.access !== "subscriber") continue;
      // Subscriber sources: headline, teaser and photo from the feed only, marked locked, link out.
      if (source.access === "subscriber") {
        row.title = plain(row.title);
        row.excerpt = plain(row.excerpt)?.slice(0, 400) || null;
        row.locked = true;
        if (row.title && row.title.length >= 8) rows.push(row);
        continue;
      }

      const ex = await extract(row.url).catch(e => ({ error: e.message }));
      if (ex.paywall) {
        row.paywalled = true;
        row.paywall_reason = ex.paywall;
        paywalled++;
      } else if (!ex.error) {
        row.url = ex.url || row.url;
        // Scraped link text is unreliable; the page's own title is better.
        if (found.strategy === "scrape" || !row.title) row.title = ex.title || row.title;
        row.image = row.image || ex.image;
        row.author = row.author || ex.author;
        row.excerpt = row.excerpt || ex.excerpt?.slice(0, 400) || null;
        if (!it.published && ex.published) row.published_at = new Date(ex.published).toISOString();
        if (ex.bodyHtml && ex.wordCount >= 120) {
          row.body_html = ex.bodyHtml;
          row.word_count = ex.wordCount;
          row.extracted = true;
        }
      }
      row.title = plain(row.title);
      // A blank headline arrives as just the outlet name ("- Lonely Planet"); try the page title instead.
      const bare = t => (t || "").toLowerCase().replace(source.name.toLowerCase(), "").replace(/[^a-z0-9]/g, "");
      if (bare(row.title).length < 8) row.title = plain(ex?.title || "");
      if (bare(row.title).length < 8) continue;
      row.excerpt = plain(row.excerpt)?.slice(0, 400) || null;
      if (!row.title) continue;
      const local = localTopic(source);
      if (local && !isLocal(local, row.title, row.excerpt, opening(row.body_html))) {
        Object.assign(row, { offtopic: true, body_html: null, word_count: null, extracted: false });
      }
      rows.push(row);
    } catch (e) {
      console.warn(`  ${source.name}: ${it.url}: ${e.message}`);
    }
  }

  // A redirect can land two items on the same URL; keep the first. A bulk insert
  // needs identical keys on every row, so fill in the optional columns.
  // Postgres text cannot hold NUL characters, which a few pages contain.
  const clean = r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "string" ? v.replaceAll("\0", "") : v]));
  const unique = [...new Map(rows.map(r => [r.url, clean({ ...ROW_DEFAULTS, ...r })])).values()];
  await db.insertArticles(unique);

  const items_seen = source.items_seen + unique.length;
  const paywall_seen = source.paywall_seen + paywalled;
  const patch = {
    last_run_at: started,
    last_ok_at: started,
    last_strategy: found.strategy,
    last_count: found.items.length,
    last_error: null,
    items_seen,
    paywall_seen,
  };
  if (items_seen >= 10 && paywall_seen / items_seen > 0.8) {
    patch.enabled = false;
    patch.disabled_reason = `auto: ${paywall_seen} of ${items_seen} articles paywalled`;
  }
  await db.updateSource(source.id, patch);
  return { source: source.name, strategy: found.strategy, found: found.items.length, added: unique.length, paywalled };
}

// Sources readers added since the last run: check them first so the good ones are fetched now.
await vetPending().catch(e => console.warn("vet:", e.message));

// Trends move slowly; refresh them on the first run of each hour.
const trends = new Date().getUTCMinutes() < 15 || process.env.TRENDS === "1"
  ? collectTrends().then(db.saveTrends).catch(e => console.warn("trends:", e.message))
  : Promise.resolve();
// Discovery feeds (YouTube search, Hacker News) for every followed phrase.
await db.ensureDiscovery().catch(e => console.warn("discovery:", e.message));
const all = await db.sources();
const only = process.argv[2];
const list = only ? all.filter(s => s.name.toLowerCase().includes(only.toLowerCase())) : all;
console.log(`Fetching ${list.length} sources`);
const results = await pool(list, 6, processSource);
await trends;
for (const r of results) console.log(r.error instanceof Error ? `ERR ${r.error.message}` : JSON.stringify(r));
// Group new articles into stories and summarize them (needs ANTHROPIC_API_KEY).
await stories().catch(e => console.warn("stories:", e.message));

// Meaning vectors, topics, junk flags and quality for new (and backlog) articles; free and local.
const enriched = await enrich().catch(e => (console.warn("enrich:", e.message), 0));
await refreshInterests().catch(e => console.warn("interests:", e.message));

// Push alerts for what just arrived (local matching, no AI).
await alerts().catch(e => console.warn("alerts:", e.message));

// Tell admins about new sign-ups.
await signups().catch(e => console.warn("signups:", e.message));

// Suggested sources for shelves that follow a phrase change slowly; refresh them hourly.
if (new Date().getUTCMinutes() < 15) await refreshSuggestions().catch(e => console.warn("suggestions:", e.message));

// Daily trim of old article text, stories and logs (keeps the shared free database small).
await retention().catch(e => console.warn("retention:", e.message));

// One line per run in the event log, for the admin dashboard.
const failed = results.filter(r => r.error);
await db.logEvent("fetch_run", {
  sources: results.length, failed: failed.length, added: results.reduce((n, r) => n + (r.added || 0), 0),
  paywalled: results.reduce((n, r) => n + (r.paywalled || 0), 0), seconds: Math.round((Date.now() - RUN_START) / 1000),
  failing: failed.slice(0, 10).map(r => r.source), enriched,
}).catch(e => console.warn("log:", e.message));

if (process.env.DRY === "1") {
  const rows = db.dryRows;
  console.log(`\nDRY: ${rows.length} rows, ${rows.filter(r => r.extracted).length} full text, ${rows.filter(r => r.paywalled).length} paywalled, ${rows.filter(r => r.offtopic).length} off topic`);
  for (const r of rows.filter(r => r.offtopic)) console.log(`  off topic: ${r.title}`);
  for (const r of rows.filter(r => r.paywalled)) console.log(`  locked (${r.paywall_reason}): ${r.url}`);
  if (process.env.DRY_OUT) (await import("node:fs")).writeFileSync(process.env.DRY_OUT, JSON.stringify(rows));
}
