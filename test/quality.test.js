import { test } from "node:test";
import assert from "node:assert/strict";
import { summarize } from "../fetcher/quality.js";

test("quality summary counts and precision", () => {
  const items = [{ title: "a" }, { title: "b" }, { title: "c" }, { title: "d" }];
  const r = summarize(items, [{ n: 1, score: 2 }, { n: 2, score: 2 }, { n: 3, score: 1 }, { n: 4, score: 0 }]);
  assert.deepEqual([r.good, r.partial, r.bad], [2, 1, 1]);
  assert.equal(r.precision, 0.625);
  assert.deepEqual(r.bad_examples, ["d"]);
});
