import { test } from "node:test";
import assert from "node:assert/strict";
import { flagsFor, qualityFor } from "../fetcher/classify.js";
import { TAXONOMY } from "../fetcher/taxonomy.js";

test("junk flags", () => {
  assert.deepEqual(flagsFor({ title: "Tyndale Appoints Peter Rego Jr.", excerpt: "CAROL STREAM, Ill.--(BUSINESS WIRE)--Tyndale today...", url: "https://x.com/a" }), ["press_release"]);
  assert.deepEqual(flagsFor({ title: "AP Sports SummaryBrief at 10:02 a.m. EDT", url: "https://x.com/a" }), ["digest"]);
  assert.deepEqual(flagsFor({ title: "How to plan an RV getaway", url: "https://x.com/sponsored/how-to" }), ["sponsored"]);
  assert.deepEqual(flagsFor({ title: "Town Of Essex, Notice Of Public Hearing", url: "https://x.com/a" }), ["listing"]);
  assert.deepEqual(flagsFor({ title: "Cape Coral council votes on traffic lights", url: "https://x.com/news/local/a" }), []);
});

test("quality", () => {
  assert.equal(qualityFor({ kind: "news", image: "x" }, []), 1);
  assert.equal(qualityFor({ kind: "news", image: "x" }, ["press_release"]), 0.3);
  assert.equal(qualityFor({ kind: "news", image: "x", extracted: true, word_count: 800 }, []), 1.1);
});

test("taxonomy keys are unique", () => {
  const keys = TAXONOMY.map(t => t[0]);
  assert.equal(new Set(keys).size, keys.length);
});
