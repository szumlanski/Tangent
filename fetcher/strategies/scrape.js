// Last resort list scrape. selectors.list picks article links on site_url (or
// selectors.page). Titles and dates are filled in later by extraction.
import { parseHTML } from "linkedom";
import { get } from "../http.js";

export async function scrape(source) {
  const page = source.selectors?.page || source.site_url;
  const r = await get(page);
  if (!r.ok) throw new Error(`scrape HTTP ${r.status}`);
  const { document } = parseHTML(r.text);
  const sel = source.selectors?.list || "article a[href], h2 a[href], h3 a[href]";
  const origin = new URL(r.url).origin;
  const seen = new Set();
  const items = [];
  document.querySelectorAll("style,script,noscript,svg").forEach(n => n.remove());
  for (const a of document.querySelectorAll(sel)) {
    const url = new URL(a.getAttribute("href"), r.url).href.split("#")[0];
    const title = a.textContent.replace(/\s+/g, " ").trim();
    // Article slugs are long ("lee-county-deputies-rescue-3-people"); nav and bio pages are not.
    const slugged = new URL(url).pathname.split("/").some(seg => seg.split("-").length >= 4);
    if (!url.startsWith(origin) || seen.has(url) || title.length < 20 || !slugged) continue;
    seen.add(url);
    items.push({ url, title, published: null });
  }
  if (!items.length) throw new Error("scrape found no links");
  return items.slice(0, 25);
}
