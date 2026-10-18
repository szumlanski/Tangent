import { test } from "node:test";
import assert from "node:assert/strict";
import { outletsFrom, SKIP } from "../fetcher/vet.js";

test("phrase results become outlet suggestions, skipping platforms and paywalled sites", () => {
  const it = (title, url) => ({ sourceTitle: title, sourceUrl: url });
  const items = [it("The Verge", "https://www.theverge.com"), it("The Verge", "https://www.theverge.com"), it("MakeUseOf", "https://www.makeuseof.com"),
    it("YouTube", "https://www.youtube.com"), it("WSJ", "https://www.wsj.com"), it("Yahoo", "https://www.yahoo.com"), { sourceTitle: "x" }];
  const out = outletsFrom(items, new Map([["theverge.com", 42]]));
  // MakeUseOf appears once and is not in the catalog, so it is not suggested yet.
  assert.deepEqual(out.map(o => [o.domain, o.hits, o.source_id]), [["theverge.com", 2, 42]]);
  assert.ok(SKIP.test("youtube.com") && !SKIP.test("theverge.com"));
});
