import { test } from "node:test";
import assert from "node:assert/strict";
import { signupMessage } from "../fetcher/signups.js";

test("signup message: one user, several, none", () => {
  assert.equal(signupMessage([]), null);
  const one = signupMessage([{ name: "Ann", email: "a@x.com", google_sub: "1" }]);
  assert.equal(one.title, "New Tangent sign-up");
  assert.equal(one.body, "Ann (a@x.com) joined with Google.");
  assert.equal(one.url, "/admin#users");
  const many = signupMessage(["A", "B", "C", "D", "E"].map(n => ({ name: n, email: n + "@x.com" })));
  assert.equal(many.title, "5 new Tangent sign-ups");
  assert.equal(many.body, "A, B, C and 2 more joined.");
});
