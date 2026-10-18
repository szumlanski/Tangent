// Daily cleanup so Tangent stays a small guest in the EG4 Monitor database (Pro plan, 8 GB included).
// Full article text is kept three weeks (the reader then links to the original); stories two months,
// except ones someone voted on or hid. Logs and send records are trimmed too. Runs at most once a day.
import * as db from "./db.js";

export const BODY_DAYS = 21;     // full text
export const LOG_DAYS = 180;     // activity and security log (promised in the privacy policy)
export const SENT_DAYS = 90;     // push send records (they only stop repeats)
const DAY = 864e5;

export async function retention({ force = false } = {}) {
  if (process.env.DRY === "1") return;
  const cfg = await db.config(["retention_at"]);
  if (!force && cfg.retention_at && Date.now() - Date.parse(cfg.retention_at) < 20 * 36e5) return;
  const iso = days => encodeURIComponent(new Date(Date.now() - days * DAY).toISOString());
  const out = {};
  out.bodies = await db.trimBodies(iso(BODY_DAYS));
  // Articles: ids from the view (old, no votes or hides), deleted in batches.
  let gone = 0;
  for (let ids = await db.expiredArticles(400); ids.length; ids = await db.expiredArticles(400)) {
    await db.deleteArticles(ids);
    gone += ids.length;
    if (gone > 20000) break; // a backlog clears over several days
  }
  out.articles = gone;
  out.log = await db.trimOlder("tangent_events_log", "at", iso(LOG_DAYS));
  out.sent = await db.trimOlder("tangent_alert_sent", "sent_at", iso(SENT_DAYS));
  out.guest_sent = await db.trimOlder("tangent_guest_sent", "sent_at", iso(SENT_DAYS));
  out.rate = await db.trimOlder("tangent_rate", "window_start", iso(2));
  await db.setConfig("retention_at", new Date().toISOString());
  await db.logEvent("retention", out);
  console.log("retention:", JSON.stringify(out));
}
