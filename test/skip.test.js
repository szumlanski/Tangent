import { test } from "node:test";
import assert from "node:assert/strict";
import { skipped } from "../fetcher/skip.js";

test("skip rule drops wire sections and keeps local ones", () => {
  const src = { selectors: { skip: "^/(ap|sponsored|theworld)/|^/news/(national|world|business)/|^/sports/pro_national_sports/|^/features/ap-" } };
  const u = p => "https://www.timesargus.com" + p + "/article_x.html";
  for (const p of ["/ap/state/x", "/news/national/x", "/sports/pro_national_sports/x", "/features/ap-entertainment/x"]) assert.equal(skipped(src, u(p)), true, p);
  for (const p of ["/news/local/x", "/sports/local/x", "/opinion/commentary/x", "/obituaries/x"]) assert.equal(skipped(src, u(p)), false, p);
  assert.equal(skipped({}, u("/ap/state/x")), false);
  assert.equal(skipped({ selectors: { skip: "(" } }, u("/ap/x")), false);
});
