// Stories: group articles about the same event across outlets (free, local word matching in
// match.js), then have Claude Haiku summarize the stories that several outlets covered.
// Single-outlet stories keep the publisher's own teaser, so they cost nothing.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import * as db from "./db.js";
import { match } from "./match.js";

const MODEL = "claude-haiku-5-5";
const WINDOW_H = 48;          // a new article can join any story updated in the last 48 hours
const SUMMARIES_PER_RUN = 40; // a normal run has a few; the first run backfills
const MEMBER_WORDS = 700;     // per article fed to the summary (up to 3 articles)
// The app never shows the long dash; built from its code so this file stays free of it.
const DASH = new RegExp("\\s*" + String.fromCharCode(0x2014) + "\\s*", "g");

let client;
const claude = () => (client ||= new Anthropic());

const Summary = z.object({
  headline: z.string().describe("Neutral headline for the story, under 90 characters"),
  blurb: z.string().describe("One or two plain sentences, under 220 characters: what happened and why it matters"),
  bullets: z.array(z.string()).describe("3 to 5 short bullets with the key facts, numbers, names and dates"),
});

const SUMMARY_SYSTEM = `You write the summary shown on a news card and at the top of the reader.
Use only facts stated in the articles. Do not add background from your own knowledge: give people the titles and roles the articles give them, and assume the articles are more current than anything you know.
No opinion, no speculation, no filler like "this article discusses".
When outlets disagree on a fact, say so briefly. Write plain American English. Use commas or periods, never long dashes.`;

// Plain text from Readability HTML, capped in words.
export function text(html, words) {
  const t = (html || "").replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&rsquo;/g, "'").replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/\s+/g, " ").trim();
  const w = t.split(" ");
  return w.length > words ? w.slice(0, words).join(" ") + " ..." : t;
}
export const clean = s => (s || "").replace(DASH, ", ").trim();

// The model call, kept apart so tests can stand in for it.
export const model = {
  async summarize(members) {
    const body = members.map((m, i) =>
      `ARTICLE ${i + 1}: ${m.source}\nTITLE: ${m.title}\n${m.body || m.teaser || ""}`).join("\n\n---\n\n");
    const res = await claude().messages.parse({
      model: MODEL,
      max_tokens: 4000,
      output_config: { effort: "low", format: zodOutputFormat(Summary) },
      system: SUMMARY_SYSTEM,
      messages: [{ role: "user", content: body }],
    });
    if (res.stop_reason === "refusal") return null; // record as done so it is not retried every run
    if (!res.parsed_output) throw new Error(`summary: ${res.stop_reason}`);
    return res.parsed_output;
  },
};

// Put every new article in a story: join an existing one, or start a new one.
export async function groupNew(log = console.log) {
  const since = new Date(Date.now() - WINDOW_H * 36e5).toISOString();
  const fresh = await db.unclustered(since, 2000);
  if (!fresh.length) return 0;
  const existing = await db.recentClustered(since);
  const shape = a => ({ id: a.id, title: a.title, teaser: a.excerpt, source_id: a.source_id, cluster_id: a.cluster_id, topic: a.tangent_sources?.topic || "" });
  const F = fresh.map(shape);
  const { joins, groups } = match(existing.map(shape), F);

  const byId = new Map(F.map(a => [a.id, a]));
  const created = await db.createClusters(groups.map(ids => {
    const lead = byId.get(ids[0]);
    return { topic: lead.topic, headline: lead.title, lead_article_id: lead.id, article_count: ids.length };
  }));
  for (let i = 0; i < groups.length; i++) if (created[i]) await db.setCluster(groups[i], created[i].id);

  // Joins: grouped per story so each story's count moves once.
  const perCluster = new Map();
  for (const [id, cid] of joins) perCluster.set(cid, [...(perCluster.get(cid) || []), id]);
  if (perCluster.size) {
    const counts = await db.clusterCounts([...perCluster.keys()]);
    for (const [cid, ids] of perCluster) {
      await db.setCluster(ids, cid);
      await db.updateCluster(cid, { article_count: (counts.get(cid) || 0) + ids.length, updated_at: new Date().toISOString() });
    }
  }
  const multi = groups.filter(g => g.length > 1).length;
  log(`  grouped ${F.length} articles: ${groups.length} new stories (${multi} with several outlets), ${joins.size} joined existing stories`);
  return F.length;
}

// Summarize multi-outlet stories: once when a second outlet arrives, again when the count doubles.
export async function summarizeDue(log = console.log) {
  const due = await db.clustersToSummarize(SUMMARIES_PER_RUN);
  let done = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (due.length) {
      const c = due.shift();
      try {
        const rows = await db.clusterMembers(c.id);
        // Readable text first, then teasers; three outlets is plenty.
        const members = rows
          .map(r => ({ source: r.tangent_sources?.name || "", title: r.title, body: r.extracted ? text(r.body_html, MEMBER_WORDS) : "", teaser: r.excerpt || "" }))
          .sort((a, b) => b.body.length - a.body.length)
          .slice(0, 3);
        const words = members.reduce((n, m) => n + (m.body || m.teaser).split(" ").length, 0);
        const patch = { summarized_count: c.article_count, summarized_at: new Date().toISOString() };
        if (words >= 40) {
          const s = await model.summarize(members);
          if (s) Object.assign(patch, {
            headline: clean(s.headline).slice(0, 140),
            summary_short: clean(s.blurb),
            bullets: s.bullets.map(clean).filter(Boolean).slice(0, 5),
          });
        }
        await db.updateCluster(c.id, patch);
        done++;
      } catch (e) {
        log(`  summary failed for story ${c.id}: ${e.message}`);
      }
    }
  }));
  log(`  summarized ${done} stories`);
  return done;
}

export async function stories(log = console.log) {
  log("Stories");
  await groupNew(log);
  if (process.env.ANTHROPIC_API_KEY) await summarizeDue(log);
  else log("  ANTHROPIC_API_KEY not set, skipping summaries");
}
