// Enrich stored articles that have no meaning vector yet: new ones from this round and, at first,
// the backlog. Runs after the fetch each round; a capped batch keeps the round short.
import * as db from "./db.js";
import { embed, toPg } from "./embed.js";
import { topicsFor, flagsFor, qualityFor } from "./classify.js";
import { opening } from "./local.js";

const PER_ROUND = 8000, PAGE = 400;
export async function enrich() {
  if (process.env.DRY === "1") return 0;
  const started = Date.now();
  let done = 0;
  while (done < PER_ROUND && Date.now() - started < 5 * 60e3) {
    const rows = await db.unenriched(PAGE);
    if (!rows.length) break;
    for (const r of rows) r.opening = opening(r.body_html).slice(0, 800);
    const vecs = await embed(rows.map(r => `${r.title || ""}. ${r.excerpt || ""} ${r.opening}`));
    const out = [];
    for (let i = 0; i < rows.length; i++) {
      const flags = flagsFor(rows[i]);
      out.push({ id: rows[i].id, emb: toPg(vecs[i]), topics: await topicsFor(vecs[i]), flags, quality: qualityFor(rows[i], flags) });
    }
    for (let i = 0; i < out.length; i += 100) await db.setEnrichment(out.slice(i, i + 100));
    done += rows.length;
  }
  if (done) console.log(`enrich: ${done} articles in ${Math.round((Date.now() - started) / 1000)}s`);
  return done;
}
