import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFeed } from "../fetcher/strategies/rss.js";
import { detectPaywall, isBlockedDomain } from "../fetcher/paywall.js";
import { extractFromHtml } from "../fetcher/extract.js";

const para = n => Array.from({ length: n }, (_, i) => `<p>Sentence number ${i} about solar inverters and batteries on the grid today.</p>`).join("");

test("parses RSS 2.0 with media image", () => {
  const items = parseFeed(`<rss><channel><item><title>Hello &amp; welcome</title><link>https://a.com/1</link>
    <pubDate>Fri, 17 Oct 2026 10:00:00 GMT</pubDate><media:content url="https://a.com/i.jpg" medium="image"/>
    <description>&lt;p&gt;Teaser&lt;/p&gt;</description></item></channel></rss>`);
  assert.equal(items.length, 1);
  assert.equal(items[0].url, "https://a.com/1");
  assert.equal(items[0].image, "https://a.com/i.jpg");
  assert.equal(items[0].excerpt, "Teaser");
});

test("parses a YouTube Atom feed", () => {
  const items = parseFeed(`<feed xmlns:yt="y" xmlns:media="m"><entry><yt:videoId>abc123</yt:videoId><title>Vid</title>
    <link rel="alternate" href="https://www.youtube.com/watch?v=abc123"/><published>2026-10-16T12:00:00Z</published>
    <author><name>Chan</name></author></entry></feed>`);
  assert.equal(items[0].videoId, "abc123");
  assert.equal(items[0].url, "https://www.youtube.com/watch?v=abc123");
  assert.equal(items[0].image, "https://i.ytimg.com/vi/abc123/hqdefault.jpg");
});

test("ld+json isAccessibleForFree false is locked", () => {
  const html = `<script type="application/ld+json">{"@type":"NewsArticle","isAccessibleForFree":false}</script>`;
  assert.equal(detectPaywall(html, { wordCount: 900 }), "ld+json not free");
});

test("vendor script on a full article is not locked", () => {
  assert.equal(detectPaywall(`<script src="https://cdn.tinypass.com/x.js"></script>`, { wordCount: 800 }), null);
  assert.equal(detectPaywall(`<script src="https://cdn.tinypass.com/x.js"></script>`, { wordCount: 90 }), "piano");
});

test("free article extracts full text and is not locked", () => {
  const html = `<html><head><title>T</title><meta property="og:image" content="https://a.com/i.jpg"></head>
    <body><article><h1>T</h1>${para(40)}</article></body></html>`;
  const r = extractFromHtml(html, "https://a.com/x");
  assert.equal(r.paywall, null);
  assert.ok(r.wordCount > 300);
  assert.equal(r.image, "https://a.com/i.jpg");
});

test("short article with a lock prompt is locked", () => {
  const html = `<html><body><article>${para(4)}<p>Subscribe to continue reading.</p></article></body></html>`;
  assert.equal(extractFromHtml(html, "https://a.com/x").paywall, "lock prompt");
});

test("short article that just mentions subscribing is free", () => {
  const html = `<html><body><article>${para(4)}<p>Subscribe to my newsletter.</p></article></body></html>`;
  assert.equal(extractFromHtml(html, "https://a.com/x").paywall, null);
});

test("blocked domains", () => {
  assert.ok(isBlockedDomain("https://www.wsj.com/a"));
  assert.ok(isBlockedDomain("https://markets.ft.com/a"));
  assert.ok(!isBlockedDomain("https://www.politico.com/news/a"));
  assert.ok(isBlockedDomain("https://www.politico.com/pro/a"));
  assert.ok(!isBlockedDomain("https://electrek.co/a"));
});

test("plain() strips tags, including entity-encoded ones", async () => {
  const { plain } = await import("../fetcher/extract.js");
  assert.equal(plain("&lt;p&gt;Hello &amp; <b>world</b>&lt;/p&gt;"), "Hello & world");
});

test("rows sent in one insert share the same keys", async () => {
  const src = await import("node:fs").then(fs => fs.readFileSync(new URL("../fetcher/run.js", import.meta.url), "utf8"));
  const defaults = src.match(/const ROW_DEFAULTS = (\{[\s\S]*?\});/)[1];
  const keys = Object.keys(Function(`return ${defaults}`)());
  for (const k of ["paywalled", "paywall_reason", "video_id", "body_html", "extracted", "word_count", "origin_url"]) assert.ok(keys.includes(k), k);
});

test("story plan: joins, new groups, and bad labels", async () => {
  const { plan } = await import("../fetcher/stories.js");
  const articles = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }];
  const stories = [{ id: 10, article_count: 2 }];
  const p = plan(articles, stories, [
    { article: "a1", story: "s10" },   // joins existing
    { article: "a2", story: "n1" },    // new story with a3
    { article: "a3", story: "n1" },
    { article: "a4", story: "s999" },  // unknown story id
    { article: "a77", story: "n2" },   // unknown article, ignored
    { article: "a2", story: "s10" },   // duplicate assignment, first wins
  ]);                                   // a5 missing
  assert.deepEqual(p.get("s10"), [1]);
  assert.deepEqual(p.get("n1"), [2, 3]);
  assert.deepEqual(p.get("solo4"), [4]);
  assert.deepEqual(p.get("solo5"), [5]);
  assert.equal(p.size, 4);
});

test("summary text cleanup removes long dashes and tags", async () => {
  const { clean, text } = await import("../fetcher/stories.js");
  assert.equal(clean("Lee Health " + String.fromCharCode(0x2014) + " and United"), "Lee Health, and United");
  assert.equal(text("<p>One &amp; two</p><script>x()</script><p>three four</p>", 3), "One & two ...");
});
