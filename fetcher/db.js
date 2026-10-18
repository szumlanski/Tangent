// Minimal Supabase REST client using the service role key (fetcher only).
const URL_ = process.env.SUPABASE_URL || "https://kyplwgcvbfzyfhiyspsr.supabase.co";
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
// DRY=1 reads with the public key and prints writes instead of sending them.
const DRY = process.env.DRY === "1";
const PUBLIC_KEY = "sb_publishable_LqD81rhJPP9kVN_Rdw22eQ_jhZ3Hc_r";
export const dryRows = [];
const patch_log = false;

async function rest(path, { method = "GET", body, prefer } = {}) {
  if (DRY && method !== "GET") {
    if (Array.isArray(body)) dryRows.push(...body);
    else if (patch_log) console.log("  patch", path, JSON.stringify(body));
    return null;
  }
  const key = DRY ? PUBLIC_KEY : KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
  const res = await fetch(`${URL_}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      ...(prefer ? { prefer } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`supabase ${method} ${path.split("?")[0]}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json().catch(() => null);
}

export const sources = () => rest("tangent_sources?enabled=eq.true&select=*&order=id");

// Which of these URLs (article or Google News wrapper) are already stored.
export async function known(urls) {
  if (DRY || !urls.length) return new Set();
  return new Set(await rest("rpc/tangent_known_urls", { method: "POST", body: { urls } }));
}

export const insertArticles = rows =>
  rows.length ? rest("tangent_articles?on_conflict=url", { method: "POST", body: rows, prefer: "resolution=ignore-duplicates,return=minimal" }) : null;

export const updateSource = (id, patch) => rest(`tangent_sources?id=eq.${id}`, { method: "PATCH", body: patch, prefer: "return=minimal" });

// Replace the trend snapshot: upsert this run's rows, then drop anything older.
export async function saveTrends(rows) {
  if (!rows.length) return;
  const at = new Date().toISOString();
  await rest("tangent_trends?on_conflict=source,channel,url", {
    method: "POST", body: rows.map(r => ({ ...r, fetched_at: at })), prefer: "resolution=merge-duplicates,return=minimal",
  });
  if (!DRY) await rest(`tangent_trends?fetched_at=lt.${encodeURIComponent(at)}`, { method: "DELETE", prefer: "return=minimal" });
}

export const allSources = () => rest("tangent_sources?select=site_url,feed_url,topic");
export const allSuggestionDomains = async () => DRY ? [] : (await rest("tangent_source_suggestions?select=domain")).map(r => r.domain);
export const insertSuggestions = rows =>
  rows.length ? rest("tangent_source_suggestions?on_conflict=domain", { method: "POST", body: rows, prefer: "resolution=ignore-duplicates,return=minimal" }) : null;
export const recentBodies = () =>
  DRY ? [] : rest("tangent_articles?select=url,body_html,tangent_sources(topic)&extracted=eq.true&order=fetched_at.desc&limit=400");

// ---- stories ----
export const unclustered = (since, limit) =>
  rest(`tangent_articles?select=id,title,excerpt,kind,source_id,tangent_sources(name,topic)&cluster_id=is.null&paywalled=is.false&fetched_at=gte.${encodeURIComponent(since)}&order=fetched_at.asc&limit=${limit}`);
export const recentClustered = since =>
  rest(`tangent_articles?select=id,title,excerpt,source_id,cluster_id&cluster_id=not.is.null&paywalled=is.false&fetched_at=gte.${encodeURIComponent(since)}&limit=3000`);
export async function clusterCounts(ids) {
  if (DRY) return new Map();
  const rows = await rest(`tangent_clusters?select=id,article_count&id=in.(${ids.join(",")})`);
  return new Map(rows.map(r => [r.id, r.article_count]));
}
let fakeId = 1e9;
export async function createClusters(rows) {
  if (!rows.length) return [];
  if (DRY) { dryClusters.push(...rows); return rows.map(() => ({ id: fakeId++ })); }
  return rest("tangent_clusters?select=id", { method: "POST", body: rows, prefer: "return=representation" });
}
export const dryClusters = [];
export const setCluster = (ids, clusterId) =>
  rest(`tangent_articles?id=in.(${ids.join(",")})`, { method: "PATCH", body: { cluster_id: clusterId }, prefer: "return=minimal" });
export const updateCluster = (id, patch) =>
  rest(`tangent_clusters?id=eq.${id}`, { method: "PATCH", body: patch, prefer: "return=minimal" });
export const clustersToSummarize = lim => DRY ? [] : rest("rpc/tangent_clusters_to_summarize", { method: "POST", body: { lim } });
export const clusterMembers = id =>
  rest(`tangent_articles?select=title,excerpt,body_html,extracted,kind,tangent_sources(name)&cluster_id=eq.${id}&paywalled=is.false&order=extracted.desc,published_at.desc&limit=6`);

// ---- push alerts (service key only: these tables have no API policies) ----
const inList = ids => `(${ids.join(",")})`;
export async function config(keys) {
  if (DRY) return {};
  const rows = await rest(`tangent_config?k=in.${inList(keys)}&select=k,v`);
  return Object.fromEntries(rows.map(r => [r.k, r.v]));
}
export const setConfig = (k, v) => rest("tangent_config?on_conflict=k", { method: "POST", body: [{ k, v }], prefer: "resolution=merge-duplicates,return=minimal" });
export const pushSubs = async () => DRY ? [] : rest("tangent_push_subs?disabled_at=is.null&select=id,user_id,endpoint,p256dh,auth,tz");
export const newArticles = async (cursor, since) => (await rest(
  `tangent_articles?select=id,title,excerpt,source_id,cluster_id,published_at,fetched_at,tangent_sources!inner(name)` +
  `&paywalled=is.false&tangent_sources.enabled=is.true&fetched_at=gt.${encodeURIComponent(cursor)}&published_at=gt.${encodeURIComponent(since)}&order=fetched_at.asc&limit=1000`))
  .map(({ tangent_sources, ...a }) => ({ ...a, source_name: tangent_sources?.name || "" }));
export const storyMembers = ids =>
  rest(`tangent_feed?cluster_id=in.${inList(ids)}&select=id,title,source_id,source_name,cluster_id,published_at,image,story_headline&limit=3000`);
export const activeAlerts = ids => rest(`tangent_alerts?removed_at=is.null&enabled=is.true&user_id=in.${inList(ids)}&select=id,user_id,persona_id,kind,phrase,shelf_id,source_id`);
export const usersById = ids => rest(`tangent_users?id=in.${inList(ids)}&deleted_at=is.null&select=id,settings`);
export const shelfSources = async ids => (await rest(
  `tangent_shelf_sources?removed_at=is.null&select=shelf_id,source_id,tangent_shelves!inner(user_id,persona_id,name)` +
  `&tangent_shelves.user_id=in.${inList(ids)}&tangent_shelves.removed_at=is.null`))
  .map(r => ({ shelf_id: r.shelf_id, source_id: r.source_id, user_id: r.tangent_shelves.user_id, persona_id: r.tangent_shelves.persona_id, name: r.tangent_shelves.name }));
export const recentSent = (ids, since) => rest(`tangent_alert_sent?user_id=in.${inList(ids)}&sent_at=gt.${encodeURIComponent(since)}&select=user_id,key,kind,alert_id,sent_at`);
export const guestSubs = async () => DRY ? [] : rest("tangent_guest_subs?disabled_at=is.null&select=id,endpoint,p256dh,auth,tz");
export const markGuestSub = (id, patch) => rest(`tangent_guest_subs?id=eq.${id}`, { method: "PATCH", body: patch, prefer: "return=minimal" });
export const recentGuestSent = (ids, since) => ids.length ? rest(`tangent_guest_sent?sub_id=in.${inList(ids)}&sent_at=gt.${encodeURIComponent(since)}&select=sub_id,key,sent_at`) : [];
export const recordGuestSent = row => rest("tangent_guest_sent?on_conflict=sub_id,key", { method: "POST", body: [row], prefer: "resolution=ignore-duplicates,return=minimal" });
// New accounts since a time, and the push devices of admins (for sign-up notices).
export const newUsers = since => rest(`tangent_users?created_at=gt.${encodeURIComponent(since)}&deleted_at=is.null&select=email,name,google_sub,created_at&order=created_at.asc`);
export const adminPushSubs = async () => DRY ? [] : rest("tangent_push_subs?disabled_at=is.null&select=id,endpoint,p256dh,auth,tangent_users!inner(is_admin)&tangent_users.is_admin=is.true");
export const markSub = (id, patch) => rest(`tangent_push_subs?id=eq.${id}`, { method: "PATCH", body: patch, prefer: "return=minimal" });
export const recordSent = row => rest("tangent_alert_sent?on_conflict=user_id,key", { method: "POST", body: [row], prefer: "resolution=ignore-duplicates,return=minimal" });

// ---- vetting reader-added sources, and per-shelf suggestions ----
export const pendingSources = n => rest(`tangent_sources?status=eq.pending&order=created_at&limit=${n}&select=*`);
export const activeSearchSources = () => rest("tangent_sources?kind=eq.search&status=eq.active&enabled=is.true&select=id,query");
export async function catalogByDomain() {
  const rows = await rest("tangent_sources?status=eq.active&enabled=is.true&kind=neq.search&select=id,site_url");
  const m = new Map();
  for (const r of rows) { try { const d = new URL(r.site_url).hostname.replace(/^www\./, "").toLowerCase(); if (!m.has(d)) m.set(d, r.id); } catch {} }
  return m;
}
export async function saveShelfSuggestions(searchSourceId, outlets) {
  if (!outlets.length) return;
  const shelves = await rest(`tangent_shelf_sources?source_id=eq.${searchSourceId}&removed_at=is.null&select=shelf_id`);
  const at = new Date().toISOString();
  const rows = shelves.flatMap(s => outlets.map(o => ({ shelf_id: s.shelf_id, domain: o.domain, name: o.name, url: o.url, source_id: o.source_id, hits: o.hits, updated_at: at })));
  if (rows.length) await rest("tangent_shelf_suggestions?on_conflict=shelf_id,domain", { method: "POST", body: rows, prefer: "resolution=merge-duplicates,return=minimal" });
}

export const logEvent = (kind, detail) => DRY ? null : rest("tangent_events_log", { method: "POST", body: [{ kind, detail }], prefer: "return=minimal" });

// ---- retention (service key; see retention.js) ----
const count = async (path, opts) => {
  const r = await fetch(`${URL_}/rest/v1/${path}`, { ...opts, headers: { apikey: KEY, authorization: `Bearer ${KEY}`, "content-type": "application/json", prefer: "return=minimal,count=exact" } });
  if (!r.ok) throw new Error(`supabase ${opts.method} ${path.split("?")[0]}: ${r.status} ${await r.text()}`);
  return +(r.headers.get("content-range") || "").split("/")[1] || 0;
};
export const trimBodies = before => count(`tangent_articles?fetched_at=lt.${before}&body_html=not.is.null`, { method: "PATCH", body: JSON.stringify({ body_html: null }) });
export const expiredArticles = async n => (await rest(`tangent_expired_articles?select=id&limit=${n}`)).map(r => r.id);
export const deleteArticles = ids => count(`tangent_articles?id=in.(${ids.join(",")})`, { method: "DELETE" });
export const trimOlder = (table, col, before) => count(`${table}?${col}=lt.${before}`, { method: "DELETE" });
