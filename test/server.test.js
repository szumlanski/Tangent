import { test } from "node:test";
import assert from "node:assert/strict";
import { sign, unsign, checkSignup, readCookie, cookieHeader, sameOrigin } from "../lib/server.js";

test("session cookie signature round-trips and rejects tampering", async () => {
  const s = await sign("570253a9-52d9-42f4-94f6-76444ad69918", "k1");
  assert.equal(await unsign(s, "k1"), "570253a9-52d9-42f4-94f6-76444ad69918");
  assert.equal(await unsign(s, "k2"), null, "wrong key");
  assert.equal(await unsign(s.replace("5702", "5703"), "k1"), null, "edited value");
  assert.equal(await unsign("garbage", "k1"), null);
  assert.equal(await unsign(undefined, "k1"), null);
});

test("sign-up validation", () => {
  assert.equal(checkSignup({ email: "a@b.co", password: "0123456789" }), null);
  assert.match(checkSignup({ email: "nope", password: "0123456789" }), /valid email/);
  assert.match(checkSignup({ email: "a@b.co", password: "short" }), /10 characters/);
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
