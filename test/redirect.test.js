import { test } from "node:test";
import assert from "node:assert/strict";
import { redirectFor } from "../functions/_middleware.js";

test("old addresses redirect page loads to tangentreads.com", () => {
  const r = redirectFor(new Request("https://tangent.szumlanski.com/welcome?a=5"));
  assert.equal(r.status, 301);
  assert.equal(r.headers.get("location"), "https://tangentreads.com/welcome?a=5");
  assert.equal(redirectFor(new Request("https://www.tangentreads.com/")).headers.get("location"), "https://tangentreads.com/");
  assert.equal(redirectFor(new Request("https://tangentreads.com/")), null);
  assert.equal(redirectFor(new Request("https://tangent.szumlanski.com/api/v1/me")), null, "API passes through");
  assert.equal(redirectFor(new Request("https://www.tangentreads.com/api/v1/feedback", { method: "POST" })), null);
});
