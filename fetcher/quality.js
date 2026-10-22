// Daily shelf quality check. For each followed interest, take the top 20 stories the real ranking
// would show and have Claude Haiku rate how well each fits (2 on topic, 1 related, 0 off topic).
// Results go to tangent_quality for the admin dashboard, and each shelf's relevance bar self-tunes.
// Cost: about 20 interests a day at ~1,500 input and ~150 output tokens, roughly $0.15 a month on
// Haiku 5.5; a monthly token cap in tangent_config ("judge_cap", default 3M) stops it regardless.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import * as db from "./db.js";
import { TOPIC_TEXT } from "./interests.js";

const MODEL = "claude-haiku-5-5";
const SAMPLE = 20;
let client;
const claude = () => (client ||= new Anthropic());

const Verdicts = z.object({ scores: z.array(z.object({ n: z.number().int(), score: z.number().int() })) });
const SYSTEM = `You check a news reader's shelf. Given what the shelf is for and a numbered list of stories, rate each story:
2 = clearly about the shelf's subject, 1 = related or partly about it, 0 = off topic.
Judge only fit to the subject, not quality or opinion. Answer for every number.`;

export function summarize(items, scores) {
  const by = new Map(scores.map(s => [s.n, s.score]));
  const vals = items.map((_, i) => Math.max(0, Math.min(2, by.get(i + 1) ?? 1)));
  const good = vals.filter(v => v === 2).length, partial = vals.filter(v => v === 1).length, bad = vals.filter(v => v === 0).length;
  return { sampled: items.length, good, partial, bad, precision: items.length ? (good + partial / 2) / items.length : 0,
    bad_examples: items.filter((_, i) => vals[i] === 0).slice(0, 5).map(x => x.title) };
}

export const judgeModel = {
  async rate(subject, items) {
    const list = items.map((x, i) => `${i + 1}. ${x.title}${x.excerpt ? " | " + x.excerpt.slice(0, 160) : ""}`).join("\n");
    const res = await claude().messages.parse({
      model: MODEL, max_tokens: 2000,
      output_config: { effort: "low", format: zodOutputFormat(Verdicts) },
      system: SYSTEM,
      messages: [{ role: "user", content: `Shelf: ${subject}\n\nStories:\n${list}` }],
    });
    if (res.stop_reason === "refusal" || !res.parsed_output) return null;
    return { scores: res.parsed_output.scores, tokens: res.usage.input_tokens + res.usage.output_tokens };
  },
};

export async function quality() {
  if (process.env.DRY === "1" || !process.env.ANTHROPIC_API_KEY) return;
  const month = new Date().toISOString().slice(0, 7);
  const cfg = await db.config(["quality_at", "judge_used", "judge_cap"]);
  if (cfg.quality_at && Date.now() - Date.parse(cfg.quality_at) < 20 * 36e5) return;
  const used = cfg.judge_used?.startsWith(month + ":") ? +cfg.judge_used.split(":")[1] : 0;
  const cap = +(cfg.judge_cap || 3e6);
  let spent = 0, checked = 0;
  for (const t of await db.qualityTargets()) {
    if (used + spent > cap) { console.log("quality: monthly token cap reached"); break; }
    const items = await db.rankShelf(t.user_id, t.shelf_id, 100).catch(() => []);
    const sample = items.slice(0, SAMPLE);
    if (!sample.length) { await db.saveQuality({ interest_id: t.interest_id, available: 0, sampled: 0, good: 0, partial: 0, bad: 0, precision: 0, bad_examples: [], tokens: 0 }); continue; }
    const subject = t.kind === "topic" ? `${t.label}: ${TOPIC_TEXT[t.key.slice(2)] || t.label}` : t.kind === "place" ? `Local news for ${t.label}` : t.label;
    const r = await judgeModel.rate(subject, sample).catch(e => (console.warn("quality:", e.message), null));
    if (!r) continue;
    spent += r.tokens; checked++;
    await db.saveQuality({ interest_id: t.interest_id, available: items.length, ...summarize(sample, r.scores), tokens: r.tokens });
    // Self-tuning: a shelf with plenty of stories but too many off-topic ones raises its relevance bar a
    // notch; a thin one lowers it (and a thin phrase also looks further back). Bounded both ways.
    const q = summarize(sample, r.scores).precision;
    if (items.length >= 60 && q < 0.75) await db.tuneInterest(t.interest_id, 0.02);
    else if (items.length < 30) { await db.tuneInterest(t.interest_id, -0.02); if (t.kind === "phrase") await db.widenInterest(t.interest_id); }
  }
  await db.setConfig("judge_used", `${month}:${used + spent}`);
  await db.setConfig("quality_at", new Date().toISOString());
  await db.logEvent("quality", { checked, tokens: spent });
  console.log(`quality: ${checked} shelves checked, ${spent} tokens`);
}
