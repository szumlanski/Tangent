// RSS 2.0, Atom, and YouTube channel feeds.
import { XMLParser } from "fast-xml-parser";
import { get } from "../http.js";

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@", textNodeName: "#text" });

const arr = v => (v == null ? [] : Array.isArray(v) ? v : [v]);
const txt = v => (v == null ? "" : typeof v === "object" ? String(v["#text"] ?? "") : String(v)).trim();

function atomLink(links) {
  const all = arr(links);
  const alt = all.find(l => !l["@rel"] || l["@rel"] === "alternate") || all[0];
  return alt ? alt["@href"] || txt(alt) : "";
}

function firstImage(it) {
  const media = arr(it["media:content"]).concat(arr(it["media:group"]?.["media:content"]));
  const thumb = arr(it["media:thumbnail"]).concat(arr(it["media:group"]?.["media:thumbnail"]));
  const enc = arr(it.enclosure).find(e => String(e["@type"] || "").startsWith("image"));
  const m = media.find(x => !x["@medium"] || x["@medium"] === "image") || thumb[0] || enc;
  if (m) return m["@url"];
  const html = txt(it["content:encoded"]) || txt(it.description) || txt(it.content);
  return html.match(/<img[^>]+src=["']([^"']+)["']/i)?.[1] || null;
}

const strip = html => html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

export function parseFeed(xml) {
  const doc = parser.parse(xml);
  if (doc.rss || doc["rdf:RDF"]) {
    const ch = doc.rss?.channel || doc["rdf:RDF"];
    return arr(ch.item || doc["rdf:RDF"]?.item).map(it => ({
      url: txt(it.link) || txt(it.guid),
      title: strip(txt(it.title)),
      excerpt: strip(txt(it.description)).slice(0, 400),
      contentHtml: txt(it["content:encoded"]) || null,
      image: firstImage(it),
      author: txt(it["dc:creator"]) || txt(it.author) || null,
      published: txt(it.pubDate) || txt(it["dc:date"]) || null,
      sourceTitle: txt(it.source) || null,
      sourceUrl: it.source?.["@url"] || null,
    }));
  }
  if (doc.feed) {
    return arr(doc.feed.entry).map(it => {
      const videoId = txt(it["yt:videoId"]) || null;
      return {
        url: atomLink(it.link),
        title: strip(txt(it.title)),
        excerpt: strip(txt(it.summary) || txt(it["media:group"]?.["media:description"])).slice(0, 400),
        contentHtml: txt(it.content) || null,
        image: videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : firstImage(it),
        author: txt(it.author?.name) || null,
        published: txt(it.published) || txt(it.updated) || null,
        videoId,
        category: it.category?.["@term"] || null,
      };
    });
  }
  throw new Error("not a feed");
}

export async function rss(source) {
  if (!source.feed_url) throw new Error("no feed_url");
  const r = await get(source.feed_url);
  if (!r.ok) throw new Error(`feed HTTP ${r.status}`);
  return parseFeed(r.text);
}
