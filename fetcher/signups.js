// Tells admins about new sign-ups with a push to their devices. Runs after each fetch, so it lags by up to 15 min.
import webpush from "web-push";
import * as db from "./db.js";

// One notification per run: a single sign-up by name, or a count.
export function signupMessage(users) {
  if (!users.length) return null;
  const who = u => u.name || u.email;
  const via = u => (u.google_sub ? " with Google" : "");
  const body = users.length === 1 ? `${who(users[0])} (${users[0].email}) joined${via(users[0])}.`
    : `${users.slice(0, 3).map(who).join(", ")}${users.length > 3 ? ` and ${users.length - 3} more` : ""} joined.`;
  return { title: users.length === 1 ? "New Tangent sign-up" : `${users.length} new Tangent sign-ups`, body, url: "/admin#users", tag: "signups" };
}

export async function signups() {
  if (process.env.DRY === "1") return;
  const now = new Date().toISOString();
  const cfg = await db.config(["signups_at", "vapid_public", "vapid_private"]);
  // First run starts from now so old accounts are not announced.
  if (!cfg.signups_at) return db.setConfig("signups_at", now);
  const users = await db.newUsers(cfg.signups_at);
  if (!users.length) return;
  const msg = signupMessage(users);
  const devices = await db.adminPushSubs();
  webpush.setVapidDetails("https://tangentreads.com", cfg.vapid_public, cfg.vapid_private);
  let ok = 0;
  for (const d of devices) {
    try {
      await webpush.sendNotification({ endpoint: d.endpoint, keys: { p256dh: d.p256dh, auth: d.auth } }, JSON.stringify(msg), { TTL: 24 * 3600 });
      ok++;
    } catch (e) {
      if ([404, 410].includes(e.statusCode)) await db.markSub(d.id, { disabled_at: now, failed_at: now });
    }
  }
  await db.setConfig("signups_at", users.at(-1).created_at);
  console.log(`signups: ${users.length} new, pushed to ${ok} admin devices`);
}
