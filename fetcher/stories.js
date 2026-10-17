// Stories: group articles about the same event across outlets, then summarize each story.
// Claude Haiku does both. Grouping sees only headlines and teasers; summaries see full text.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import * as db from "./db.js";

const MODEL = "claude-haiku-5-5";
const WINDOW_H = 48;          // a new article can join any story updated in the last 48 hours
const GROUP_BATCH = 120;      // new articles per grouping call
const SUMMARIES_PER_RUN = 80; // the first run backfills; later runs only see a handful
const MEMBER_WORDS = 1200;    // per article fed to the summary (up to 3 articles)
// The app never shows the long dash; built from its code so this file stays free of it.
const DASH = new RegExp("\\s*" + String.fromCharCode(0x2014) + "\\s*", "g");

let client;
const claude = () => (client ||= new Anthropic());

const Grouping = z.object({
  assignments: z.array(z.object({
    article: z.string().describe("The article id, e.g. a123"),
    story: z.string().describe("An existing story id (s45), or a new label (n1, n2, ...) shared by new articles about the same event"),
  })),
});

const Summary = z.object({
  headline: z.string().describe("Neutral headline for the story, under 90 characters"),
  blurb: z.string().describe("One or two plain sentences, under 220 characters: what happened and why it matters"),
  bullets: z.array(z.string()).describe("3 to 5 short bullets with the key facts, numbers, names and dates"),
});

const GROUP_SYSTEM = `You sort news articles into stories. A story is one specific event or development, reported by any number of outlets.
Put an article in an existing story only when it reports the same specific event (same incident, announcement, game, ruling or release), not merely the same topic.
Articles about the same broad subject but different events are different stories. When unsure, start a new story.
Give new stories labels n1, n2, ... and reuse a label for new articles that report the same event as each other.
Return exactly one assignment for every article id you are given.`;

const SUMMARY_SYSTEM = `You write the summary shown on a news card and at the top of the reader.
Use only facts stated in the articles. No opinion, no speculation, no filler like "this article discusses".
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

// The model calls, kept apart so tests can stand in for them.
export const model = {
  async group(stories, articles) {
    const lines = [
      "EXISTING STORIES (last 48 hours):",
      ...(stories.length ? stories.map(s => `s${s.id} [${s.topic}] ${s.headline}`) : ["(none)"]),
      "",
      "NEW ARTICLES:",
      ...articles.map(a => `a${a.id} [${a.topic}] ${a.source}: ${a.title}${a.teaser ? " | " + a.teaser : ""}`),
    ];
    const res = await claude().messages.parse({
      model: MODEL,
      max_tokens: 16000,
      output_config: { effort: "low", format: zodOutputFormat(Grouping) },
      system: GROUP_SYSTEM,
      messages: [{ role: "user", content: lines.join("\n") }],
    });
    if (res.stop_reason === "refusal" || !res.parsed_output) throw new Error(`grouping: ${res.stop_reason}`);
    return res.parsed_output.assignments;
  },
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

// Turn the model's assignments into a plan: label -> article ids. Anything the model
// skipped, duplicated or pointed at an unknown story becomes its own story.
export function plan(articles, stories, assigned) {
  const known = new Set(stories.map(s => "s" + s.id));
  const ids = new Set(articles.map(a => a.id));
  const byArticle = new Map();
  for (const x of assigned) {
    const id = +String(x.article).replace(/^a/, "");
    if (ids.has(id) && !byArticle.has(id)) byArticle.set(id, String(x.story).trim());
  }
  const out = new Map();
  for (const a of articles) {
    let label = byArticle.get(a.id) || `solo${a.id}`;
    if (/^s\d+$/.test(label) ? !known.has(label) : !/^n\d+$/.test(label)) label = `solo${a.id}`;
    if (!out.has(label)) out.set(label, []);
    out.get(label).push(a.id);
  }
  return out;
}

// Assign every unclustered article to an existing or new story.
export async function groupNew(log = console.log) {
  const since = new Date(Date.now() - WINDOW_H * 36e5).toISOString();
  let total = 0;
  for (let round = 0; round < 10; round++) {
    const fresh = await db.unclustered(since, GROUP_BATCH);
    if (!fresh.length) break;
    const stories = await db.recentClusters(since);
    const articles = fresh.map(a => ({
      id: a.id, title: a.title, topic: a.tangent_sources?.topic || "", source: a.tangent_sources?.name || "",
      teaser: (a.excerpt || "").slice(0, 160),
    }));
    let assigned = [];
    try {
      assigned = await model.group(stories, articles);
    } catch (e) {
      log(`  grouping failed, each article becomes its own story: ${e.message}`);
    }
    const p = plan(articles, stories, assigned);
    const byId = new Map(articles.map(a => [a.id, a]));
    const newLabels = [...p.keys()].filter(l => !l.startsWith("s"));
    const created = await db.createClusters(newLabels.map(l => {
      const lead = byId.get(p.get(l)[0]);
      return { topic: lead.topic, headline: lead.title, lead_article_id: lead.id, article_count: p.get(l).length };
    }));
    const idFor = new Map(newLabels.map((l, i) => [l, created[i]?.id]));
    for (const [label, ids] of p) {
      const cid = label.startsWith("s") ? +label.slice(1) : idFor.get(label);
      if (!cid) continue;
      await db.setCluster(ids, cid);
      if (label.startsWith("s")) {
        const s = stories.find(x => x.id === cid);
        await db.updateCluster(cid, { article_count: s.article_count + ids.length, updated_at: new Date().toISOString() });
      }
    }
    const joined = [...p.keys()].filter(l => l.startsWith("s")).length;
    const merged = newLabels.filter(l => p.get(l).length > 1).length;
    log(`  grouped ${articles.length} articles: ${newLabels.length} new stories (${merged} with several outlets), ${joined} joined existing`);
    total += articles.length;
    if (fresh.length < GROUP_BATCH || process.env.DRY === "1") break;
  }
  return total;
}

// Summarize new stories and stories that picked up more outlets.
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
  if (!process.env.ANTHROPIC_API_KEY && process.env.DRY !== "1") {
    log("stories: ANTHROPIC_API_KEY not set, skipping grouping and summaries");
    return;
  }
  log("Stories");
  await groupNew(log);
  await summarizeDue(log);
}
