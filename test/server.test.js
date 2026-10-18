import { test } from "node:test";
import assert from "node:assert/strict";
import { sign, unsign, checkSignup, readCookie, cookieHeader, sameOrigin, json, signOutCookies, sourceUrl } from "../lib/server.js";

test("session cookie signature round-trips and rejects tampering", async () => {
  const s = await sign("570253a9-52d9-42f4-94f6-76444ad69918", "k1");
  assert.equal(await unsign(s, "k1"), "570253a9-52d9-42f4-94f6-76444ad69918");
  assert.equal(await unsign(s, "k2"), null, "wrong key");
  assert.equal(await unsign(s.replace("5702", "5703"), "k1"), null, "edited value");
  assert.equal(await unsign("garbage", "k1"), null);
  assert.equal(await unsign(undefined, "k1"), null);
});

test("sign-up validation", () => {
  assert.equal(checkSignup({ email: "a@b.co", password: "01234567" }), null);
  assert.match(checkSignup({ email: "a@b.co", password: "0123456" }), /8 characters/);
  assert.match(checkSignup({ email: "nope", password: "0123456789" }), /valid email/);
  assert.match(checkSignup({ email: "a@b.co", password: "short" }), /8 characters/);
  assert.match(checkSignup({ email: "a@b.co", password: "0123456789", name: "x".repeat(61) }), /60 characters/);
});

test("cookies", () => {
  const req = new Request("https://tangentreads.com/", { headers: { cookie: "a=1; tg_sid=abc.def; b=2" } });
  assert.equal(readCookie(req, "tg_sid"), "abc.def");
  assert.equal(readCookie(req, "missing"), null);
  const c = cookieHeader("tg_sid", "v");
  for (const flag of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/"]) assert.ok(c.includes(flag), flag);
});

test("cross-site POSTs are refused", () => {
  const mk = origin => new Request("https://tangentreads.com/api/v1/feedback", { method: "POST", headers: origin ? { origin } : {} });
  assert.ok(sameOrigin(mk("https://tangentreads.com")));
  assert.ok(sameOrigin(mk(null)));
  assert.ok(!sameOrigin(mk("https://evil.example")));
});

test("json() sends every set-cookie line", () => {
  const r = json({ ok: true }, 200, { "set-cookie": signOutCookies() });
  const lines = r.headers.getSetCookie();
  assert.equal(lines.length, 2);
  assert.ok(lines[0].startsWith("tg_sid=;") && lines[0].includes("HttpOnly"));
  assert.ok(lines[1].startsWith("tg_in=;") && !lines[1].includes("HttpOnly"));
});

test("pasted source addresses", () => {
  assert.equal(sourceUrl("example.com"), "https://example.com");
  assert.equal(sourceUrl("https://www.vtdigger.org/feed/"), "https://www.vtdigger.org/feed");
  assert.equal(sourceUrl("@veritasium"), "https://www.youtube.com/@veritasium");
  assert.equal(sourceUrl("https://www.youtube.com/channel/UCabcDEF#x"), "https://www.youtube.com/channel/UCabcDEF");
  for (const bad of ["", "not a url", "javascript:alert(1)", "ftp://x.com", "http://localhost", "http://127.0.0.1", "http://10.0.0.5/x", "http://[::1]/", "http://x.com:8080", "http://u:p@x.com", "http://printer.local", "intranet"])
    assert.equal(sourceUrl(bad), null, bad);
});
