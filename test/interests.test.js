import { test } from "node:test";
import assert from "node:assert/strict";
import { blend, mean, TOPIC_TEXT } from "../fetcher/interests.js";

test("vector blend and mean are unit length", () => {
  const len = v => Math.hypot(...v);
  assert.ok(Math.abs(len(blend([1, 0], [0, 1], 0.4)) - 1) < 1e-9);
  assert.ok(Math.abs(len(mean([[1, 0], [0.6, 0.8]])) - 1) < 1e-9);
});
test("every listed topic has a description", () => {
  for (const k of ["us", "world", "politics", "business", "tech", "science", "health", "climate", "sports", "entertainment", "food", "travel", "solar"]) assert.ok(TOPIC_TEXT[k], k);
});
