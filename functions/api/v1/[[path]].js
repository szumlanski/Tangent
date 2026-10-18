// /api/v1/* : accounts, sign-in, shelves, feedback. All personal data goes through here.
// Content (articles, sources) stays public and is read by the app directly from the database.
import {
  rpc, json, sign, unsign, readCookie, cookieHeader, signOutCookies,
  checkSignup, startSession, currentUser, sameOrigin, clientIp, EMAIL_RE,
} from "../../../lib/server.js";

const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const OAUTH_COOKIE = "tg_oauth";

const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const randomToken = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));
const sha256url = async s => b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))));

// Friendly messages for errors the database raises on purpose.
const KNOWN = { email_taken: [409, "That email already has an account. Sign in instead."], too_many_shelves: [400, "You can have up to 30 shelves."], not_found: [404, "Not found."] };

async function body(request) {
  try { return await request.json(); } catch { return {}; }
}

// Limit: true when allowed.
const allow = (env, key, limit, windowS) => rpc(env, "tangent_rate_hit", { p_key: key, p_limit: limit, p_window_s: windowS });

const routes = {
  // ---- email and password ----
  async "POST auth/signup"({ env, request }) {
    const b = await body(request);
    const problem = checkSignup(b);
    if (problem) return json({ error: problem }, 400);
    if (!(await allow(env, "signup:" + clientIp(request), 10, 3600))) return json({ error: "Too many sign-ups from this network. Try again in an hour." }, 429);
    const user = await rpc(env, "tangent_signup", { p_email: b.email.trim(), p_name: (b.name || "").trim(), p_password: b.password });
    return json({ user }, 200, { "set-cookie": await startSession(env, request, user) });
  },

  async "POST auth/login"({ env, request }) {
    const b = await body(request);
    if (typeof b.email !== "string" || typeof b.password !== "string" || !EMAIL_RE.test(b.email.trim())) return json({ error: "Enter your email and password." }, 400);
    const ipOk = await allow(env, "login-ip:" + clientIp(request), 30, 900);
    const emailOk = await allow(env, "login-email:" + b.email.trim().toLowerCase(), 8, 900);
    if (!ipOk || !emailOk) return json({ error: "Too many tries. Wait 15 minutes and try again." }, 429);
    const user = await rpc(env, "tangent_login", { p_email: b.email.trim(), p_password: b.password });
    if (!user) return json({ error: "That email and password don't match." }, 401);
    return json({ user }, 200, { "set-cookie": await startSession(env, request, user) });
  },

  async "POST auth/logout"({ env, request, sid }) {
    const b = await body(request);
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

  async "GET auth/google/callback"({ env, request }) {
    const url = new URL(request.url);
    const fail = msg => new Response(null, { status: 302, headers: { location: "/welcome?signin_error=" + encodeURIComponent(msg) } });
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
    const headers = new Headers({ location: back });
    for (const c of await startSession(env, request, user)) headers.append("set-cookie", c);
    headers.append("set-cookie", `${OAUTH_COOKIE}=; Path=/api/v1/auth/google; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
    return new Response(null, { status: 302, headers });
  },

  // ---- signed-in user ----
  async "GET me"({ env, user }) {
    const me = await rpc(env, "tangent_me", { p_user: user.id });
    return json({ ...me, google: !!env.GOOGLE_CLIENT_ID });
  },

  async "POST me/settings"({ env, request, user }) {
    const b = await body(request);
    if (b.settings && JSON.stringify(b.settings).length > 4000) return json({ error: "Settings too large." }, 400);
    return json({ user: await rpc(env, "tangent_save_settings", { p_user: user.id, p_settings: b.settings ?? null, p_name: b.name ?? null }) });
  },

  async "POST me/password"({ env, request, user }) {
    const b = await body(request);
    if (typeof b.new !== "string" || b.new.length < 10 || b.new.length > 200) return json({ error: "Use a password of at least 10 characters." }, 400);
    if (!(await allow(env, "pw:" + user.id, 10, 3600))) return json({ error: "Too many tries. Try again later." }, 429);
    const ok = await rpc(env, "tangent_set_password", { p_user: user.id, p_current: b.current ?? null, p_new: b.new });
    return ok ? json({ ok: true }) : json({ error: "Your current password is not right." }, 403);
  },

  async "POST me/delete"({ env, request, user }) {
    const b = await body(request);
    if (b.confirm !== "DELETE") return json({ error: "Type DELETE to confirm." }, 400);
    await rpc(env, "tangent_close_account", { p_user: user.id });
    return json({ ok: true }, 200, { "set-cookie": signOutCookies() });
  },

  // The original owner moves their pre-account votes and admin rights onto this account.
  async "POST me/claim"({ env, request, user }) {
    const b = await body(request);
    const ok = typeof b.key === "string" && await rpc(env, "tangent_claim_owner", { p_user: user.id, p_owner_key: b.key });
    return json({ ok: !!ok });
  },

  // ---- shelves ----
  async "POST shelves/topics"({ env, request, user }) {
    const b = await body(request);
    if (!Array.isArray(b.topics) || b.topics.length > 30) return json({ error: "Pick some topics." }, 400);
    await rpc(env, "tangent_add_topic_shelves", { p_user: user.id, p_topics: b.topics.map(String) });
    return json(await rpc(env, "tangent_me", { p_user: user.id }));
  },
  async "POST shelves/save"({ env, request, user }) {
    const b = await body(request);
    if (!b.id && !(typeof b.name === "string" && b.name.trim())) return json({ error: "Give the shelf a name." }, 400);
    const id = await rpc(env, "tangent_save_shelf", { p_user: user.id, p_shelf: { id: b.id ?? null, name: b.name ?? null, position: b.position ?? null, query: b.query ?? null } });
    return json({ id });
  },
  async "POST shelves/remove"({ env, request, user }) {
    const b = await body(request);
    await rpc(env, "tangent_remove_shelf", { p_user: user.id, p_shelf: +b.id });
    return json({ ok: true });
  },
  async "POST shelves/source"({ env, request, user }) {
    const b = await body(request);
    await rpc(env, "tangent_shelf_source", { p_user: user.id, p_shelf: +b.shelf, p_source: +b.source, p_add: !!b.add });
    return json({ ok: true });
  },

  // ---- votes and hides ----
  async "GET feedback"({ env, user }) {
    return json(await rpc(env, "tangent_user_feedback", { p_user: user.id }));
  },
  async "POST feedback"({ env, request, user }) {
    const b = await body(request);
    const vote = b.vote == null ? null : Math.max(-1, Math.min(1, Math.trunc(b.vote)));
    await rpc(env, "tangent_user_set_feedback", { p_user: user.id, p_article: +b.article, p_vote: vote, p_hidden: b.hidden ?? null });
    return json({ ok: true });
  },
};

const PUBLIC = new Set(["POST auth/signup", "POST auth/login", "POST auth/logout", "GET auth/config", "GET auth/google", "GET auth/google/callback"]);

export async function onRequest(context) {
  const { request, env, params } = context;
  const path = (params.path || []).join("/");
  const key = `${request.method} ${path}`;
  const handler = routes[key];
  if (!handler) return json({ error: "Not found." }, 404);
  if (request.method === "POST" && !sameOrigin(request)) return json({ error: "Cross-site request refused." }, 403);
  try {
    const { sid, user } = await currentUser(env, request);
    if (!PUBLIC.has(key) && !user) return json({ error: "Please sign in." }, 401, { "set-cookie": signOutCookies() });
    return await handler({ env, request, sid, user });
  } catch (e) {
    const known = KNOWN[e.message];
    if (known) return json({ error: known[1] }, known[0]);
    console.error(key, e.message);
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
}
