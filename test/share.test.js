import { test } from "node:test";
import assert from "node:assert/strict";
import { page, sharerName } from "../functions/s/[id].js";

test("share page shows the story and both ways in, escaped", () => {
  const html = page({ id: 42, title: 'Storm <script>alert(1)</script> nears "coast"', excerpt: "Teaser", image: "https://img.example/a.jpg", source_name: "WINK" }, { from: "Pat" });
  assert.ok(!html.includes("<script>alert"));
  assert.ok(html.includes("Pat shared this with you on Tangent"));
  assert.ok(html.includes('href="/#a=42"') && html.includes('href="/welcome?a=42#signup"'));
  assert.ok(html.includes('<meta property="og:image" content="https://img.example/a.jpg">'));
});

test("missing story still offers Tangent", () => {
  const html = page(null);
  assert.ok(html.includes("no longer available") && html.includes('href="/"'));
});

test("sharer names are plain words only", () => {
  assert.equal(sharerName("Jason"), "Jason");
  assert.equal(sharerName("Zoë"), "Zoë");
  for (const bad of ["", "<b>x</b>", "http://x", "a".repeat(40), "1234"]) assert.equal(sharerName(bad), "", bad);
});
