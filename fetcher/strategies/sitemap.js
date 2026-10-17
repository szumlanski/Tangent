// News sitemaps: /news-sitemap.xml, or the newest child of sitemap_index.xml.
import { XMLParser } from "fast-xml-parser";
import { get } from "../http.js";

const parser = new XMLParser({ ignoreAttributes: true });
const arr = v => (v == null ? [] : Array.isArray(v) ? v : [v]);
const DAY = 864e5;

async function load(url) {
  const r = await get(url);
  return r.ok && r.text.includes("<") ? parser.parse(r.text) : null;
}

export async function sitemap(source) {
  const base = new URL(source.site_url).origin;
  const tries = source.selectors?.sitemap ? [source.selectors.sitemap] : ["/news-sitemap.xml", "/sitemap_news.xml", "/sitemap-news.xml", "/sitemap.xml", "/sitemap_index.xml"];
  for (const path of tries) {
    let doc = await load(new URL(path, base).href).catch(() => null);
    if (!doc) continue;
    if (doc.sitemapindex) {
      const kids = arr(doc.sitemapindex.sitemap).filter(s => /news|post|article/i.test(s.loc));
      const pick = (kids.length ? kids : arr(doc.sitemapindex.sitemap))
        .sort((a, b) => String(b.lastmod || "").localeCompare(String(a.lastmod || "")))[0];
      doc = pick ? await load(pick.loc).catch(() => null) : null;
    }
    const urls = arr(doc?.urlset?.url);
    const items = urls
      .map(u => ({
        url: u.loc,
        title: u["news:news"]?.["news:title"] || "",
        published: u["news:news"]?.["news:publication_date"] || u.lastmod || null,
        image: u["image:image"]?.["image:loc"] || null,
      }))
      .filter(i => i.published && Date.now() - Date.parse(i.published) < 2 * DAY);
    if (items.length) return items.slice(0, 30);
  }
  throw new Error("no usable sitemap");
}
