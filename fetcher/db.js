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
