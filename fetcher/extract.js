// Fetch an article and pull clean readable text with Mozilla Readability.
import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";
import { get } from "./http.js";
import { detectPaywall } from "./paywall.js";

const meta = (doc, ...names) => {
  for (const n of names) {
    const el = doc.querySelector(`meta[property="${n}"], meta[name="${n}"]`);
    if (el?.getAttribute("content")) return el.getAttribute("content").trim();
  }
  return null;
};

// Text only: decode entities, drop tags, collapse whitespace.
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "\u2026", rsquo: "\u2019", lsquo: "\u2018", rdquo: "\u201d", ldquo: "\u201c", ndash: "\u2013", mdash: "\u2014" };
const decode = s => s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) =>
  e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENT[e.toLowerCase()] ?? m);
const untag = s => s.replace(/<[^>]*>/g, " ");

export function plain(s) {
  if (!s) return s;
  return untag(decode(untag(decode(s)))).replace(/\s+/g, " ").trim();
}

// Phrases a truncated, locked article ends with. Plain "subscribe" is too common.
const LOCK_TEXT = /(subscribe|sign in|log in) to (continue|keep) reading|already a subscriber|for (paid|paying) subscribers|subscribers only|this article is (exclusive|available) to subscribers/i;

export function extractFromHtml(html, url) {
  const { document } = parseHTML(html);
  const info = {
    title: meta(document, "og:title", "twitter:title") || document.querySelector("title")?.textContent?.trim() || null,
    image: meta(document, "og:image", "twitter:image"),
    published: meta(document, "article:published_time", "og:article:published_time", "pubdate", "date", "parsely-pub-date"),
    author: meta(document, "author", "article:author"),
    excerpt: meta(document, "og:description", "description"),
  };
  let article = null;
  try {
    article = new Readability(document, { charThreshold: 300 }).parse();
  } catch {}
  const text = article?.textContent || "";
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  const paywall = detectPaywall(html, { wordCount }) || (wordCount < 250 && LOCK_TEXT.test(text) ? "lock prompt" : null);
  return {
    ...info,
    title: info.title || article?.title || null,
    author: info.author || article?.byline || null,
    excerpt: info.excerpt || article?.excerpt || null,
    bodyHtml: article?.content || null,
    wordCount,
    paywall,
    url,
  };
}

export async function extract(url) {
  const r = await get(url, { timeout: 20000 });
  if (r.status === 402) return { url: r.url, paywall: "HTTP 402", wordCount: 0 };
  if (!r.ok) throw new Error(`article HTTP ${r.status}`);
  return extractFromHtml(r.text, r.url);
}
