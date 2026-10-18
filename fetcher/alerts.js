// Push alerts. Runs after each fetch: matches stories that arrived since the last run against every
// user's alerts (word matching, no AI, no API cost) and sends Web Push to their devices.
import webpush from "web-push";
import * as db from "./db.js";

export const BIG_OUTLETS = 4;      // a story is "big" once this many different outlets cover it
const BIG_FRESH_H = 24;            // ...and its first article is this recent
const SHELF_GAP_MIN = 60;          // shelf alerts: at most one per shelf per hour
const PER_RUN = 3;                 // pushes per user per run; the rest wait for the next story
export const DEFAULTS = { max: 10, quiet: [22, 7] };   // per day; quiet from 10 pm to 7 am local time

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const phraseRe = p => new RegExp(`(^|[^a-z0-9])${esc(p.toLowerCase())}($|[^a-z0-9])`, "i");
const clip = (s, n) => (s = (s || "").replace(/\s+/g, " ").trim()).length > n ? s.slice(0, n - 1).trimEnd() + "…" : s;

export function localHour(tz, now) {
  try { return +new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone: tz || "America/New_York" }).format(now); }
  catch { return now.getUTCHours(); }
}
export function inQuiet(quiet, hour) {
  if (!Array.isArray(quiet) || quiet[0] === quiet[1]) return false;
  const [a, b] = quiet;
  return a < b ? hour >= a && hour < b : hour >= a || hour < b;
}

// Decide what to send. Pure, so tests can feed it plain data.
// articles: new rows {id, title, excerpt, source_id, source_name, cluster_id, published_at}
// bigStories: [{cluster_id, headline, outlets, sources: Set, lead: article}]
// shelves: Map user_id -> [{id, name, sources: Set}]
// sent: Map user_id -> {keys: Set, today: n, shelfLast: Map alert_id -> Date}
export function plan({ articles, bigStories, alerts, users, shelves, sent, tzByUser, now = new Date() }) {
  const out = [];
  const byUser = new Map();
  for (const a of alerts) (byUser.get(a.user_id) || byUser.set(a.user_id, []).get(a.user_id)).push(a);
  for (const [uid, list] of byUser) {
    const prefs = { ...DEFAULTS, ...(users.get(uid)?.settings?.alerts || {}) };
    if (inQuiet(prefs.quiet, localHour(tzByUser.get(uid), now))) continue;
    const s = sent.get(uid) || { keys: new Set(), today: 0, shelfLast: new Map() };
    const mine = shelves.get(uid) || [];
    const mySources = new Set(mine.flatMap(x => [...x.sources]));
    const msgs = [];
    const storyKey = a => a.cluster_id ? "c" + a.cluster_id : "a" + a.id;
    for (const al of list) {
      if (al.kind === "keyword" && al.phrase) {
        const re = phraseRe(al.phrase);
        const seen = new Set();
        for (const a of articles) {
          if (!re.test(`${a.title} ${a.excerpt || ""}`) || seen.has(storyKey(a))) continue;
          seen.add(storyKey(a));
          msgs.push({ rank: 0, key: `kw:${al.id}:${storyKey(a)}`, alert: al, title: `“${al.phrase}” in the news`, body: `${a.source_name}: ${clip(a.title, 140)}`, article: a });
        }
      }
      if (al.kind === "source" && al.source_id) {
        for (const a of articles.filter(a => a.source_id === al.source_id))
          msgs.push({ rank: 1, key: `src:${al.id}:${storyKey(a)}`, alert: al, title: a.source_name, body: clip(a.title, 160), article: a });
      }
      if (al.kind === "big") {
        for (const b of bigStories) {
          if (mine.length && ![...b.sources].some(x => mySources.has(x))) continue;
          msgs.push({ rank: 2, key: `big:${b.cluster_id}`, alert: al, title: `Big story · ${b.outlets} outlets`, body: clip(b.headline || b.lead.title, 160), article: b.lead });
        }
      }
      if (al.kind === "shelf" && al.shelf_id) {
        const shelf = mine.find(x => x.id === al.shelf_id);
        const last = s.shelfLast.get(al.id);
        if (!shelf || (last && now - last < SHELF_GAP_MIN * 6e4)) continue;
        const hits = articles.filter(a => shelf.sources.has(a.source_id));
        if (!hits.length) continue;
        const top = hits[0];
        msgs.push({ rank: 3, key: `shelf:${al.id}:${now.toISOString().slice(0, 13)}`, alert: al,
          title: hits.length > 1 ? `${shelf.name}: ${hits.length} new stories` : shelf.name, body: `${top.source_name}: ${clip(top.title, 140)}`, article: top });
      }
    }
    // Most specific first, one push per story, within the daily and per-run limits.
    msgs.sort((a, b) => a.rank - b.rank);
    const stories = new Set();
    let room = Math.min(PER_RUN, Math.max(0, prefs.max - s.today));
    for (const m of msgs) {
      if (!room) break;
      const sk = m.article.cluster_id ? "c" + m.article.cluster_id : "a" + m.article.id;
      if (s.keys.has(m.key) || stories.has(sk)) continue;
      stories.add(sk); room--;
      out.push({ user_id: uid, key: m.key, alert_id: m.alert.id, kind: m.alert.kind, title: m.title, body: m.body, url: `/#a=${m.article.id}` });
    }
  }
  return out;
}

export async function alerts() {
  if (process.env.DRY === "1") return; // reads private tables; plan() is covered by tests
  const cfg = await db.config(["vapid_public", "vapid_private", "alerts_cursor"]);
  const now = new Date();
  const cursor = cfg.alerts_cursor || new Date(now - 20 * 6e4).toISOString();
  const subs = await db.pushSubs();
  if (!cfg.vapid_private || !subs.length) return db.setConfig("alerts_cursor", now.toISOString());

  const articles = await db.newArticles(cursor, new Date(now - 24 * 36e5).toISOString());
  const nextCursor = articles.length ? articles[articles.length - 1].fetched_at : cursor;
  if (!articles.length) return;

  // Big stories: touched this run, covered by enough different outlets, still fresh.
  const touched = [...new Set(articles.map(a => a.cluster_id).filter(Boolean))];
  const bigStories = [];
  if (touched.length) {
    const members = await db.storyMembers(touched);
    const byC = new Map();
    for (const m of members) (byC.get(m.cluster_id) || byC.set(m.cluster_id, []).get(m.cluster_id)).push(m);
    for (const [cid, ms] of byC) {
      const sources = new Set(ms.map(m => m.source_id));
      const first = ms.reduce((t, m) => m.published_at < t ? m.published_at : t, ms[0].published_at);
      if (sources.size >= BIG_OUTLETS && now - Date.parse(first) < BIG_FRESH_H * 36e5)
        bigStories.push({ cluster_id: cid, headline: ms[0].story_headline, outlets: sources.size, sources, lead: ms.find(m => m.image) || ms[0] });
    }
  }

  const userIds = [...new Set(subs.map(s => s.user_id))];
  const [alertRows, userRows, shelfRows, sentRows] = await Promise.all([
    db.activeAlerts(userIds), db.usersById(userIds), db.shelfSources(userIds), db.recentSent(userIds, new Date(now - 7 * 864e5).toISOString()),
  ]);
  const users = new Map(userRows.map(u => [u.id, u]));
  const shelves = new Map();
  for (const r of shelfRows) {
    const list = shelves.get(r.user_id) || shelves.set(r.user_id, []).get(r.user_id);
    let sh = list.find(x => x.id === r.shelf_id);
    if (!sh) list.push(sh = { id: r.shelf_id, name: r.name, sources: new Set() });
    sh.sources.add(r.source_id);
  }
  const dayAgo = now - 864e5;
  const sent = new Map();
  for (const r of sentRows) {
    const s = sent.get(r.user_id) || sent.set(r.user_id, { keys: new Set(), today: 0, shelfLast: new Map() }).get(r.user_id);
    s.keys.add(r.key);
    if (Date.parse(r.sent_at) > dayAgo) s.today++;
    if (r.kind === "shelf" && r.alert_id) s.shelfLast.set(r.alert_id, new Date(Math.max(+(s.shelfLast.get(r.alert_id) || 0), Date.parse(r.sent_at))));
  }
  const tzByUser = new Map(subs.map(s => [s.user_id, s.tz]));
  const todo = plan({ articles, bigStories, alerts: alertRows.filter(a => users.has(a.user_id)), users, shelves, sent, tzByUser, now });

  webpush.setVapidDetails("https://tangentreads.com", cfg.vapid_public, cfg.vapid_private);
  let pushed = 0;
  for (const m of todo) {
    const devices = subs.filter(s => s.user_id === m.user_id);
    const payload = JSON.stringify({ title: m.title, body: m.body, url: m.url, tag: m.key });
    let ok = 0;
    for (const d of devices) {
      try {
        await webpush.sendNotification({ endpoint: d.endpoint, keys: { p256dh: d.p256dh, auth: d.auth } }, payload, { TTL: 6 * 3600, urgency: m.kind === "big" ? "high" : "normal" });
        ok++;
        await db.markSub(d.id, { last_ok_at: now.toISOString() });
      } catch (e) {
        // 404/410: the browser dropped this subscription for good.
        await db.markSub(d.id, [404, 410].includes(e.statusCode) ? { disabled_at: now.toISOString(), failed_at: now.toISOString() } : { failed_at: now.toISOString() });
      }
    }
    await db.recordSent({ user_id: m.user_id, key: m.key, alert_id: m.alert_id, kind: m.kind, title: m.body, url: m.url, devices: ok });
    pushed += ok;
  }
  await db.setConfig("alerts_cursor", nextCursor);
  console.log(`alerts: ${articles.length} new stories, ${bigStories.length} big, ${todo.length} alerts, ${pushed} pushes`);
}
