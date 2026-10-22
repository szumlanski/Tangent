// /api/v1/* : accounts, sign-in, shelves, feedback. All personal data goes through here.
// Content (articles, sources) stays public and is read by the app directly from the database.
import {
  rpc, json, sign, unsign, readCookie, cookieHeader, signOutCookies,
  checkSignup, startSession, currentUser, sameOrigin, clientIp, EMAIL_RE, sourceUrl, pushSub,
} from "../../../lib/server.js";

const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const OAUTH_COOKIE = "tg_oauth";

const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const randomToken = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));
const sha256url = async s => b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))));

// Friendly messages for errors the database raises on purpose.
const KNOWN = { forbidden: [403, "Admins only."], not_yourself: [400, "You can't do that to your own account."], bad_action: [400, "Unknown action."], too_many_personas: [400, "You can have up to 8 personas."], last_persona: [400, "You need at least one persona."], too_many_alerts: [400, "You can have up to 50 alerts."], bad_url: [400, "That address does not look like a website."], email_taken: [409, "That email already has an account. Sign in instead."], too_many_shelves: [400, "You can have up to 30 shelves."], not_found: [404, "Not found."] };

async function body(request) {
  try { return await request.json(); } catch { return {}; }
}

const timeZone = tz => typeof tz === "string" && /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/.test(tz) ? tz : null;

// Persona fields from the app. Pictures arrive already shrunk to a small JPEG or WebP data URL.
export function personaInput(b) {
  const p = {};
  if (b.id != null) { if (!Number.isInteger(b.id)) return { error: "Bad persona." }; p.id = b.id; }
  if (b.name != null) { if (typeof b.name !== "string" || !b.name.trim() || b.name.length > 30) return { error: "Use a name of 1 to 30 characters." }; p.name = b.name.trim(); }
  if (b.avatar != null) {
    if (b.avatar !== "" && (typeof b.avatar !== "string" || b.avatar.length > 40000 || !/^data:image\/(jpeg|webp|png);base64,[A-Za-z0-9+/]+=*$/.test(b.avatar))) return { error: "That picture could not be used. Try a different one." };
    p.avatar = b.avatar;
  }
  if (b.emoji != null) { if (typeof b.emoji !== "string" || [...b.emoji].length > 4) return { error: "Pick one emoji." }; p.emoji = b.emoji; }
  if (b.color != null) { if (typeof b.color !== "string" || !/^(#[0-9a-f]{6})?$/i.test(b.color)) return { error: "Bad color." }; p.color = b.color; }
  if (b.settings != null) { if (typeof b.settings !== "object" || JSON.stringify(b.settings).length > 4000) return { error: "Settings too large." }; p.settings = b.settings; }
  return p;
}

// Limit: true when allowed.
const allow = (env, key, limit, windowS) => rpc(env, "tangent_rate_hit", { p_key: key, p_limit: limit, p_window_s: windowS });

const routes = {
  // ---- email and password ----
  async "POST auth/signup"({ env, request, log }) {
    const b = await body(request);
    const problem = checkSignup(b);
    if (problem) return json({ error: problem }, 400);
    if (!(await allow(env, "signup:" + clientIp(request), 10, 3600))) { log("rate_limited", { route: "signup" }); return json({ error: "Too many sign-ups from this network. Try again in an hour." }, 429); }
    const user = await rpc(env, "tangent_signup", { p_email: b.email.trim(), p_name: (b.name || "").trim(), p_password: b.password });
    log("signup", { method: "email" }, user);
    return json({ user }, 200, { "set-cookie": await startSession(env, request, user) });
  },

  async "POST auth/login"({ env, request, log }) {
    const b = await body(request);
    if (typeof b.email !== "string" || typeof b.password !== "string" || !EMAIL_RE.test(b.email.trim())) return json({ error: "Enter your email and password." }, 400);
    const ipOk = await allow(env, "login-ip:" + clientIp(request), 30, 900);
    const emailOk = await allow(env, "login-email:" + b.email.trim().toLowerCase(), 8, 900);
    if (!ipOk || !emailOk) { log("rate_limited", { route: "login", email: b.email.trim().toLowerCase() }); return json({ error: "Too many tries. Wait 15 minutes and try again." }, 429); }
    const user = await rpc(env, "tangent_login", { p_email: b.email.trim(), p_password: b.password });
    if (!user) { log("login_fail", { method: "email", email: b.email.trim().toLowerCase() }); return json({ error: "That email and password don't match." }, 401); }
    log("login", { method: "email" }, user);
    return json({ user }, 200, { "set-cookie": await startSession(env, request, user) });
  },

  async "POST auth/logout"({ env, request, sid, user, log }) {
    const b = await body(request);
    if (user) log("logout", { everywhere: !!b.all });
    if (sid) await rpc(env, "tangent_session_end", { p_sid: sid, p_all: !!b.all });
    return json({ ok: true }, 200, { "set-cookie": signOutCookies() });
  },

  // What the sign-in sheet can offer.
  async "GET auth/config"({ env }) {
    return json({ google: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) });
  },

  // ---- Google ----
  async "GET auth/google"({ env, request }) {
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return json({ error: "Google sign-in is not set up yet. Use email and password for now." }, 503);
    const url = new URL(request.url);
    const state = randomToken(16), verifier = randomToken(32);
    const back = url.searchParams.get("next") || "/";
    const q = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID, redirect_uri: `${url.origin}/api/v1/auth/google/callback`, response_type: "code",
      scope: "openid email profile", state, code_challenge: await sha256url(verifier), code_challenge_method: "S256", prompt: "select_account",
    });
    const cookie = cookieHeader(OAUTH_COOKIE, await sign(JSON.stringify({ state, verifier, back: /^\/(?![/\\])/.test(back) ? back : "/" }), env.SESSION_SECRET), { maxAge: 600, path: "/api/v1/auth/google" });
    return new Response(null, { status: 302, headers: { location: `${GOOGLE_AUTH}?${q}`, "set-cookie": cookie } });
  },

  async "GET auth/google/callback"({ env, request, log }) {
    const url = new URL(request.url);
    const fail = msg => (log("login_fail", { method: "google", reason: msg }), new Response(null, { status: 302, headers: { location: "/welcome?signin_error=" + encodeURIComponent(msg) } }));
    const raw = readCookie(request, OAUTH_COOKIE);
    const saved = raw && await unsign(raw, env.SESSION_SECRET);
    if (!saved) return fail("Sign-in expired. Please try again.");
    const { state, verifier, back } = JSON.parse(saved);
    if (url.searchParams.get("state") !== state) return fail("Sign-in could not be verified. Please try again.");
    if (url.searchParams.get("error")) return fail("Google sign-in was cancelled.");
    const r = await fetch(GOOGLE_TOKEN, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: url.searchParams.get("code") || "", client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: `${url.origin}/api/v1/auth/google/callback`, grant_type: "authorization_code", code_verifier: verifier,
      }),
    });
    if (!r.ok) return fail("Google sign-in failed. Please try again.");
    // The ID token came straight from Google's token endpoint over TLS with our client secret,
    // so its claims can be trusted without re-verifying the signature (OpenID Connect 3.1.3.7).
    const { id_token } = await r.json();
    const claims = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(id_token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0))));
    if (claims.aud !== env.GOOGLE_CLIENT_ID || !["accounts.google.com", "https://accounts.google.com"].includes(claims.iss) || claims.exp * 1000 < Date.now()) return fail("Google sign-in could not be verified.");
    if (!claims.email_verified) return fail("Your Google email is not verified.");
    const user = await rpc(env, "tangent_google", { p_sub: claims.sub, p_email: claims.email, p_name: claims.name || "" });
    log("login", { method: "google" }, user);
    const headers = new Headers({ location: back });
    for (const c of await startSession(env, request, user)) headers.append("set-cookie", c);
    headers.append("set-cookie", `${OAUTH_COOKIE}=; Path=/api/v1/auth/google; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
    return new Response(null, { status: 302, headers });
  },

  // ---- signed-in user ----
  async "GET me"({ env, user, persona, log }) {
    log("open", { persona });
    const me = await rpc(env, "tangent_me", { p_user: user.id, p_persona: persona });
    return json({ ...me, google: !!env.GOOGLE_CLIENT_ID });
  },

  async "POST me/settings"({ env, request, user }) {
    const b = await body(request);
    if (b.settings && JSON.stringify(b.settings).length > 4000) return json({ error: "Settings too large." }, 400);
    return json({ user: await rpc(env, "tangent_save_settings", { p_user: user.id, p_settings: b.settings ?? null, p_name: b.name ?? null }) });
  },

  async "POST me/password"({ env, request, user, log }) {
    const b = await body(request);
    if (typeof b.new !== "string" || b.new.length < 8 || b.new.length > 200) return json({ error: "Use a password of at least 8 characters." }, 400);
    if (!(await allow(env, "pw:" + user.id, 10, 3600))) return json({ error: "Too many tries. Try again later." }, 429);
    const ok = await rpc(env, "tangent_set_password", { p_user: user.id, p_current: b.current ?? null, p_new: b.new });
    log(ok ? "password_change" : "password_fail");
    return ok ? json({ ok: true }) : json({ error: "Your current password is not right." }, 403);
  },

  async "POST me/delete"({ env, request, user, log }) {
    const b = await body(request);
    if (b.confirm !== "DELETE") return json({ error: "Type DELETE to confirm." }, 400);
    await rpc(env, "tangent_close_account", { p_user: user.id });
    log("account_closed");
    return json({ ok: true }, 200, { "set-cookie": signOutCookies() });
  },


  // ---- personas ----
  async "POST personas/save"({ env, request, user, log }) {
    const b = await body(request);
    const p = personaInput(b);
    if (p.error) return json({ error: p.error }, 400);
    const id = await rpc(env, "tangent_persona_save", { p_user: user.id, p_p: p });
    if (!p.id) log("persona_new", { id, name: p.name });
    return json({ id });
  },
  async "POST personas/remove"({ env, request, user, log }) {
    const b = await body(request);
    log("persona_removed", { id: +b.id });
    await rpc(env, "tangent_persona_remove", { p_user: user.id, p_id: +b.id });
    return json({ ok: true });
  },

  // ---- shelves ----
  async "POST shelves/topics"({ env, request, user, persona }) {
    const b = await body(request);
    if (!Array.isArray(b.topics) || b.topics.length > 30) return json({ error: "Pick some topics." }, 400);
    await rpc(env, "tangent_add_topic_shelves", { p_user: user.id, p_persona: persona, p_topics: b.topics.map(String) });
    return json(await rpc(env, "tangent_me", { p_user: user.id, p_persona: persona }));
  },
  async "POST shelves/save"({ env, request, user, persona, log }) {
    const b = await body(request);
    if (!b.id && !(typeof b.name === "string" && b.name.trim())) return json({ error: "Give the shelf a name." }, 400);
    const query = typeof b.query === "string" ? b.query.trim().slice(0, 80) : "";
    const id = await rpc(env, "tangent_save_shelf", { p_user: user.id, p_persona: persona, p_shelf: { id: b.id ?? null, name: b.name ?? null, position: b.position ?? null, query: query || null } });
    // A shelf started from a phrase follows that phrase in the news from the first fetch.
    if (!b.id && query) await rpc(env, "tangent_request_source", { p_user: user.id, p_shelf: id, p_url: null, p_query: query });
    if (!b.id) log("shelf_new", { id, name: b.name, query: query || null });
    return json({ id });
  },
  async "POST shelves/order"({ env, request, user }) {
    const b = await body(request);
    if (!Array.isArray(b.ids) || b.ids.length > 30 || !b.ids.every(Number.isInteger)) return json({ error: "Bad order." }, 400);
    await rpc(env, "tangent_order_shelves", { p_user: user.id, p_ids: b.ids });
    return json({ ok: true });
  },
  // One shelf's stories, newest first, filtered on the server (phrase shelves keep only on-topic items).
  async "GET shelves/feed"({ env, request, user }) {
    const q = new URL(request.url).searchParams, shelf = +q.get("shelf"), before = q.get("before");
    if (!Number.isInteger(shelf) || shelf < 1) return json({ error: "Not found." }, 404);
    if (before && Number.isNaN(Date.parse(before))) return json({ error: "Bad date." }, 400);
    return json({ items: await rpc(env, "tangent_shelf_feed", { p_user: user.id, p_shelf: shelf, p_before: before || null, p_limit: 100 }) });
  },
  // One shelf's stories ranked for its interest from the whole pool, each with a reason ("why").
  async "GET shelves/rank"({ env, request, user }) {
    const q = new URL(request.url).searchParams, shelf = +q.get("shelf"), offset = +(q.get("offset") || 0);
    if (!Number.isInteger(shelf) || shelf < 1) return json({ error: "Not found." }, 404);
    if (!Number.isInteger(offset) || offset < 0 || offset > 500) return json({ error: "Bad offset." }, 400);
    return json({ items: await rpc(env, "tangent_shelf_rank", { p_user: user.id, p_shelf: shelf, p_offset: offset, p_limit: 100 }) });
  },
  // "Not about this shelf": the story (and look-alikes) leave that shelf. undo puts it back.
  async "POST shelves/reject"({ env, request, user, log }) {
    const b = await body(request);
    if (!Number.isInteger(b.shelf) || !Number.isInteger(b.article)) return json({ error: "Not found." }, 404);
    await rpc(env, "tangent_shelf_reject", { p_user: user.id, p_shelf: b.shelf, p_article: b.article, p_undo: !!b.undo });
    log("shelf_reject", { shelf: b.shelf, article: b.article, undo: !!b.undo });
    return json({ ok: true });
  },
  // Hide a source everywhere for this persona (undo shows it again).
  async "POST sources/mute"({ env, request, user, persona, log }) {
    const b = await body(request);
    if (!Number.isInteger(b.source)) return json({ error: "Not found." }, 404);
    await rpc(env, "tangent_mute_source", { p_user: user.id, p_persona: persona, p_source: b.source, p_undo: !!b.undo });
    log("source_mute", { source: b.source, undo: !!b.undo });
    return json({ ok: true });
  },
  async "GET sources/mutes"({ env, user, persona }) {
    return json({ sources: await rpc(env, "tangent_mutes_get", { p_user: user.id, p_persona: persona }) });
  },
  // Regions: find a place from what the reader typed, then add it as a local shelf (any number).
  async "GET regions/search"({ env, request }) {
    const q = (new URL(request.url).searchParams.get("q") || "").trim().slice(0, 60);
    if (q.length < 3) return json({ results: [] });
    return json({ results: await rpc(env, "tangent_region_search", { p_q: q }) });
  },
  async "POST regions/add"({ env, request, user, persona, log }) {
    const b = await body(request);
    const label = typeof b.label === "string" ? b.label.trim().slice(0, 60) : "";
    if (!label || !Number.isFinite(b.lat) || !Number.isFinite(b.lon) || !/^[A-Z]{2}$/.test(b.state || "")) return json({ error: "Pick a place from the list." }, 400);
    const shelf = await rpc(env, "tangent_add_region", { p_user: user.id, p_persona: persona, p_label: label, p_lat: b.lat, p_lon: b.lon, p_state: b.state });
    log("region_add", { label, shelf });
    return json({ shelf });
  },
  // Outlets the fetcher found covering a shelf's phrase (the app adds catalog suggestions itself).
  async "GET shelves/suggestions"({ env, request, user }) {
    const shelf = +new URL(request.url).searchParams.get("shelf");
    if (!Number.isInteger(shelf) || shelf < 1) return json({ error: "Not found." }, 404);
    return json({ suggestions: await rpc(env, "tangent_shelf_suggestions_get", { p_user: user.id, p_shelf: shelf }) });
  },
  async "POST shelves/suggestions/dismiss"({ env, request, user }) {
    const b = await body(request);
    if (typeof b.domain !== "string" || b.domain.length > 200) return json({ error: "Bad request." }, 400);
    await rpc(env, "tangent_shelf_suggestion_dismiss", { p_user: user.id, p_shelf: +b.shelf, p_domain: b.domain });
    return json({ ok: true });
  },
  // Paste a site, feed or YouTube channel, or follow a phrase. New ones are checked by the fetcher before use.
  async "POST shelves/request"({ env, request, user, log }) {
    const b = await body(request);
    const query = typeof b.query === "string" ? b.query.trim() : "";
    const url = query ? null : sourceUrl(b.url);
    if (!query && !url) return json({ error: "Paste a website, feed or YouTube channel address." }, 400);
    if (query.length > 80) return json({ error: "Keep the phrase under 80 characters." }, 400);
    if (!(await allow(env, "src:" + user.id, 40, 86400))) { log("rate_limited", { route: "source_request" }); return json({ error: "That's a lot of new sources for one day. Try again tomorrow." }, 429); }
    const source = await rpc(env, "tangent_request_source", { p_user: user.id, p_shelf: +b.shelf, p_url: url, p_query: query || null });
    log("source_request", { shelf: +b.shelf, url, query: query || null, source: source.id, status: source.status });
    return json({ source });
  },
  async "POST shelves/remove"({ env, request, user, log }) {
    const b = await body(request);
    log("shelf_removed", { id: +b.id });
    await rpc(env, "tangent_remove_shelf", { p_user: user.id, p_shelf: +b.id });
    return json({ ok: true });
  },
  async "POST shelves/source"({ env, request, user }) {
    const b = await body(request);
    await rpc(env, "tangent_shelf_source", { p_user: user.id, p_shelf: +b.shelf, p_source: +b.source, p_add: !!b.add });
    return json({ ok: true });
  },

  // ---- alerts and push ----
  async "GET alerts"({ env, user, persona }) {
    return json(await rpc(env, "tangent_alerts_get", { p_user: user.id, p_persona: persona }));
  },
  async "POST alerts/save"({ env, request, user, persona }) {
    const b = await body(request);
    const a = { id: b.id ?? null, kind: b.kind, enabled: typeof b.enabled === "boolean" ? b.enabled : null };
    if (!a.id) {
      if (!["big", "keyword", "shelf", "source"].includes(b.kind)) return json({ error: "Unknown alert." }, 400);
      if (b.kind === "keyword") {
        const p = typeof b.phrase === "string" ? b.phrase.trim().replace(/\s+/g, " ") : "";
        if (p.length < 2 || p.length > 60) return json({ error: "Use a word or phrase of 2 to 60 characters." }, 400);
        a.phrase = p;
      }
      if (b.kind === "shelf") a.shelf = +b.shelf;
      if (b.kind === "source") a.source = +b.source;
    }
    return json({ id: await rpc(env, "tangent_alert_save", { p_user: user.id, p_persona: persona, p_alert: a }) });
  },
  async "POST alerts/remove"({ env, request, user }) {
    const b = await body(request);
    await rpc(env, "tangent_alert_remove", { p_user: user.id, p_id: +b.id });
    return json({ ok: true });
  },
  async "POST push/subscribe"({ env, request, user, persona, log }) {
    const b = await body(request);
    const sub = pushSub(b.subscription);
    if (!sub) return json({ error: "This browser's notification service is not supported." }, 400);
    const tz = timeZone(b.tz);
    log("push_on", { host: new URL(sub.endpoint).hostname });
    await rpc(env, "tangent_push_subscribe", { p_user: user.id, p_persona: persona, p_endpoint: sub.endpoint, p_p256dh: sub.p256dh, p_auth: sub.auth, p_ua: request.headers.get("user-agent") || "", p_tz: tz });
    return json({ ok: true });
  },
  // Big-story alerts for people without an account. The device keeps its own random key to turn them off.
  async "POST push/guest"({ env, request, log }) {
    const b = await body(request);
    const sub = pushSub(b.subscription);
    if (!sub || typeof b.key !== "string" || !/^[A-Za-z0-9_-]{32,64}$/.test(b.key)) return json({ error: "This browser's notification service is not supported." }, 400);
    if (!(await allow(env, "guestpush:" + clientIp(request), 20, 3600))) { log("rate_limited", { route: "guest_push" }); return json({ error: "Too many tries. Try again later." }, 429); }
    log(b.on === false ? "guest_push_off" : "guest_push_on", { host: new URL(sub.endpoint).hostname });
    await rpc(env, "tangent_guest_push", { p_endpoint: sub.endpoint, p_p256dh: sub.p256dh, p_auth: sub.auth, p_ua: request.headers.get("user-agent") || "", p_tz: timeZone(b.tz), p_key: b.key, p_on: b.on !== false });
    return json({ ok: true });
  },
  async "POST push/unsubscribe"({ env, request, user }) {
    const b = await body(request);
    if (typeof b.endpoint === "string") await rpc(env, "tangent_push_unsubscribe", { p_user: user.id, p_endpoint: b.endpoint });
    return json({ ok: true });
  },

  // ---- admin (the database checks is_admin again on every call) ----
  async "GET admin/overview"({ env, user }) {
    return json(await rpc(env, "tangent_admin_overview", { p_admin: user.id }));
  },
  async "GET admin/users"({ env, request, user }) {
    const q = new URL(request.url).searchParams;
    return json(await rpc(env, "tangent_admin_users", { p_admin: user.id, p_q: (q.get("q") || "").slice(0, 100), p_limit: 100, p_offset: +q.get("offset") || 0 }));
  },
  async "GET admin/log"({ env, request, user }) {
    const q = new URL(request.url).searchParams;
    return json(await rpc(env, "tangent_admin_log", { p_admin: user.id, p_kind: (q.get("kind") || "").slice(0, 40), p_q: (q.get("q") || "").slice(0, 100), p_before: +q.get("before") || null, p_limit: 150 }));
  },
  async "GET admin/sources"({ env, user }) {
    return json(await rpc(env, "tangent_admin_sources", { p_admin: user.id }));
  },
  async "POST admin/user"({ env, request, user, log }) {
    const b = await body(request);
    if (!/^[0-9a-f-]{36}$/.test(b.id || "")) return json({ error: "Bad user." }, 400);
    await rpc(env, "tangent_admin_user_action", { p_admin: user.id, p_user: b.id, p_action: String(b.action) });
    log("admin_action", { target: "user", id: b.id, action: b.action });
    return json({ ok: true });
  },
  async "POST admin/source"({ env, request, user, log }) {
    const b = await body(request);
    await rpc(env, "tangent_admin_source_action", { p_admin: user.id, p_source: +b.id, p_action: String(b.action), p_note: typeof b.note === "string" ? b.note.slice(0, 200) : null });
    log("admin_action", { target: "source", id: +b.id, action: b.action });
    return json({ ok: true });
  },
  async "POST admin/suggestion"({ env, request, user, log }) {
    const b = await body(request);
    const r = await rpc(env, "tangent_admin_suggestion", { p_admin: user.id, p_id: +b.id, p_action: String(b.action) });
    log("admin_action", { target: "suggestion", id: +b.id, action: b.action });
    return json({ result: r });
  },

  // ---- votes and hides ----
  async "GET feedback"({ env, user, persona }) {
    return json(await rpc(env, "tangent_user_feedback", { p_user: user.id, p_persona: persona }));
  },
  async "POST feedback"({ env, request, user, persona }) {
    const b = await body(request);
    const vote = b.vote == null ? null : Math.max(-1, Math.min(1, Math.trunc(b.vote)));
    await rpc(env, "tangent_user_set_feedback", { p_user: user.id, p_persona: persona, p_article: +b.article, p_vote: vote, p_hidden: b.hidden ?? null });
    return json({ ok: true });
  },
};

const PUBLIC = new Set(["POST push/guest", "POST auth/signup", "POST auth/login", "POST auth/logout", "GET auth/config", "GET auth/google", "GET auth/google/callback"]);

export async function onRequest(context) {
  const { request, env, params } = context;
  // Fire-and-forget event log; a logging failure never breaks the request.
  let who = null;
  const log = (kind, detail = {}, user = who) => {
    const p = rpc(env, "tangent_log", { p_kind: kind, p_user: user?.id ?? null, p_ip: clientIp(request), p_ua: request.headers.get("user-agent") || "", p_detail: detail }).catch(() => {});
    context.waitUntil?.(p);
  };
  const path = (params.path || []).join("/");
  const key = `${request.method} ${path}`;
  const handler = routes[key];
  if (!handler) return json({ error: "Not found." }, 404);
  if (request.method === "POST" && !sameOrigin(request)) return json({ error: "Cross-site request refused." }, 403);
  try {
    const { sid, user } = await currentUser(env, request);
    who = user;
    if (!PUBLIC.has(key) && !user) return json({ error: "Please sign in." }, 401, { "set-cookie": signOutCookies() });
    // A ceiling on writes per account, so a stuck script or a stolen session cannot flood the database.
    if (user && request.method === "POST" && !(await allow(env, "w:" + user.id, 300, 3600))) {
      log("rate_limited", { route: key });
      return json({ error: "Too many changes in the last hour. Try again later." }, 429);
    }
    // The device's chosen persona; the database falls back to the first one if it is missing or not theirs.
    const persona = /^\d{1,12}$/.test(request.headers.get("x-persona") || "") ? +request.headers.get("x-persona") : null;
    return await handler({ env, request, sid, user, persona, log });
  } catch (e) {
    const known = KNOWN[e.message];
    if (known) { log("refused", { route: key, reason: e.message }); return json({ error: known[1] }, known[0]); }
    console.error(key, e.message);
    log("server_error", { route: key, message: String(e.message).slice(0, 300) });
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
}
