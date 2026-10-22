// Shared server code for Pages Functions: database calls, session cookies, input checks.
// Runs in Cloudflare Workers and in Node 22 (tests). Uses only Web Crypto and fetch.

export const SB_URL = "https://kyplwgcvbfzyfhiyspsr.supabase.co/rest/v1/";
export const SB_KEY = "sb_publishable_LqD81rhJPP9kVN_Rdw22eQ_jhZ3Hc_r"; // public; the functions check the server secret
export const COOKIE = "tg_sid";
// Readable by the page (not HttpOnly) and carries nothing secret: it only tells the app,
// before it draws, whether to show the feed or the welcome page.
export const SIGNED_IN = "tg_in";
const MAX_AGE = 90 * 864e2; // seconds

const enc = new TextEncoder();
const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), c => c.charCodeAt(0));

async function hmacKey(secret) {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
export async function sign(value, secret) {
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(value));
  return `${value}.${b64url(sig)}`;
}
// Returns the value when the signature is good, else null. Constant time via subtle.verify.
export async function unsign(signed, secret) {
  if (typeof signed !== "string") return null;
  const i = signed.lastIndexOf(".");
  if (i < 1) return null;
  const value = signed.slice(0, i);
  try {
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), fromB64url(signed.slice(i + 1)), enc.encode(value));
    return ok ? value : null;
  } catch { return null; }
}

export function readCookie(request, name) {
  const h = request.headers.get("cookie") || "";
  for (const part of h.split(/;\s*/)) {
    const j = part.indexOf("=");
    if (j > 0 && part.slice(0, j) === name) return decodeURIComponent(part.slice(j + 1));
  }
  return null;
}
export function cookieHeader(name, value, { maxAge = MAX_AGE, path = "/" } = {}) {
  return `${name}=${encodeURIComponent(value)}; Path=${path}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}
export const clearCookie = name => `${name}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
export const signOutCookies = () => [clearCookie(COOKIE), `${SIGNED_IN}=; Path=/; Max-Age=0; Secure; SameSite=Lax`];

// Call a server-secret database function.
export async function rpc(env, fn, args) {
  const r = await fetch(SB_URL + "rpc/" + fn, {
    method: "POST",
    headers: { apikey: SB_KEY, authorization: "Bearer " + SB_KEY, "content-type": "application/json" },
    body: JSON.stringify({ p_secret: env.TANGENT_SERVER_SECRET, ...args }),
  });
  const text = await r.text();
  if (!r.ok) {
    let msg = text;
    try { msg = JSON.parse(text).message || text; } catch {}
    const e = new Error(msg); e.status = r.status; throw e;
  }
  return text ? JSON.parse(text) : null;
}

// ---- input checks ----
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export function checkSignup({ email, name, password }) {
  if (typeof email !== "string" || !EMAIL_RE.test(email.trim()) || email.length > 254) return "Enter a valid email address.";
  if (typeof password !== "string" || password.length < 8) return "Use a password of at least 8 characters.";
  if (password.length > 200) return "That password is too long.";
  if (name != null && (typeof name !== "string" || name.length > 60)) return "Keep your name under 60 characters.";
  return null;
}

// A pasted source: a site, a feed, a YouTube channel or an @handle. Returns an absolute https/http URL or null.
// Private and local addresses are refused, since the fetcher will request whatever is stored.
export function sourceUrl(input) {
  let s = String(input ?? "").trim();
  if (!s || s.length > 300 || /\s/.test(s)) return null;
  if (/^@[\w.-]{2,}$/.test(s)) s = "https://www.youtube.com/" + s;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = "https://" + s;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password || u.port) return null;
  const h = u.hostname.toLowerCase();
  if (!h.includes(".") || /^[\d.]+$/.test(h) || h.includes(":") || /(^|\.)(localhost|local|internal|lan|home|arpa)$/.test(h)) return null;
  u.hash = "";
  return u.toString().replace(/\/$/, "");
}

// Web Push endpoints must belong to a browser's push service, since the fetcher posts to whatever is stored.
const PUSH_HOSTS = /(^|\.)(fcm\.googleapis\.com|android\.googleapis\.com|push\.services\.mozilla\.com|push\.apple\.com|notify\.windows\.com)$/;
export function pushSub(sub) {
  const b64 = v => typeof v === "string" && /^[A-Za-z0-9_-]{8,200}={0,2}$/.test(v);
  try {
    const u = new URL(sub?.endpoint);
    if (u.protocol !== "https:" || !PUSH_HOSTS.test(u.hostname) || sub.endpoint.length > 1000) return null;
  } catch { return null; }
  if (!b64(sub.keys?.p256dh) || !b64(sub.keys?.auth)) return null;
  return { endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth };
}

// ---- sessions ----
export async function startSession(env, request, user) {
  const sid = await rpc(env, "tangent_session_new", { p_user: user.id, p_ua: request.headers.get("user-agent") || "" });
  return [cookieHeader(COOKIE, await sign(sid, env.SESSION_SECRET)), `${SIGNED_IN}=1; Path=/; Max-Age=${MAX_AGE}; Secure; SameSite=Lax`];
}
export async function currentUser(env, request) {
  const raw = readCookie(request, COOKIE);
  const sid = raw && await unsign(raw, env.SESSION_SECRET);
  if (!sid || !/^[0-9a-f-]{36}$/.test(sid)) return { sid: null, user: null };
  const user = await rpc(env, "tangent_session_user", { p_sid: sid });
  return { sid, user };
}

// Cross-site request guard for state-changing calls (SameSite=Lax already blocks most).
export function sameOrigin(request) {
  const origin = request.headers.get("origin");
  if (!origin) return true; // same-origin fetches from older browsers omit it
  return new URL(origin).host === new URL(request.url).host;
}

// Header values may be arrays (several set-cookie lines).
export function json(data, status = 200, headers = {}) {
  const h = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
  // A given header replaces the default (cache-control); arrays (set-cookie) add one line each.
  for (const [k, v] of Object.entries(headers)) [].concat(v).forEach((x, i) => i ? h.append(k, x) : h.set(k, x));
  return new Response(JSON.stringify(data), { status, headers: h });
}

export const clientIp = request => request.headers.get("cf-connecting-ip") || "local";
