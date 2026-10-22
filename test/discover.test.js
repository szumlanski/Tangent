import { test } from "node:test";
import assert from "node:assert/strict";
import { parseYouTubeResults, ago } from "../fetcher/strategies/discover.js";

test("relative dates", () => {
  const h = (Date.now() - Date.parse(ago("15h ago"))) / 36e5;
  assert.ok(h > 14.9 && h < 15.1);
  assert.equal(ago("no date"), null);
});

test("YouTube results page parsing keeps real videos with view counts", () => {
  const data = { contents: [{ videoRenderer: { videoId: "abc123", title: { runs: [{ text: "Claude Code in 10 minutes" }] }, ownerText: { runs: [{ text: "Some Channel" }] },
    viewCountText: { simpleText: "24,467 views" }, publishedTimeText: { simpleText: "2 days ago" }, lengthText: { simpleText: "10:05" } } },
    { videoRenderer: { videoId: "short1", title: { runs: [{ text: "Tiny clip" }] }, lengthText: { simpleText: "0:30" } } },
    { videoRenderer: { videoId: "zh1", title: { runs: [{ text: "如何长期稳定使用Claude订阅原理实操" }] }, lengthText: { simpleText: "9:00" } } }] };
  const html = `<script>var ytInitialData = ${JSON.stringify(data)};</script>`;
  const v = parseYouTubeResults(html);
  assert.equal(v.length, 1);
  assert.equal(v[0].videoId, "abc123");
  assert.equal(v[0].engagement, 24467);
  assert.equal(v[0].author, "Some Channel");
});
