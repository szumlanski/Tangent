// Free, local enrichment for each article: topic labels by meaning, junk flags by rules, and a
// quality score. The ranking uses all three; nothing here calls a paid API.
import { TAXONOMY } from "./taxonomy.js";
import { embed } from "./embed.js";

let protos;
async function prototypes() {
  return protos ||= (await embed(TAXONOMY.map(t => t[2]))).map((v, i) => ({ key: TAXONOMY[i][0], v }));
}
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

export const TOPIC_MIN = 0.18; // below this similarity a label is not given
export const TOPIC_NEAR = 0.04; // extra labels must be this close to the best one
export async function topicsFor(vec) {
  const sims = (await prototypes()).map(p => [p.key, dot(vec, p.v)]).sort((a, b) => b[1] - a[1]);
  return sims.filter(([, s], i) => s >= TOPIC_MIN && (i === 0 || s >= sims[0][1] - TOPIC_NEAR)).slice(0, 2).map(([k]) => k);
}

const PRESS = /\b(business wire|businesswire|pr ?newswire|globe ?newswire|accesswire|ein presswire|newsfile)\b/i;
const DIGEST = /\b(summarybrief|news in brief|morning news brief|business briefs|daily digest|headlines? (for|at) \d)/i;
const LISTING = /\b(notice of public hearing|legal notice|request for proposals|rfp'?s?\b|lien auction|invitation to bid|child find notice)|^[\w .'-]{0,30}\bevents?\s*(-|:|for\s+\d)/i;
export function flagsFor(row) {
  const text = `${row.title || ""} ${row.excerpt || ""} ${row.opening || ""}`;
  const path = (() => { try { return new URL(row.url).pathname; } catch { return ""; } })();
  const f = [];
  if (PRESS.test(text)) f.push("press_release");
  if (/\/sponsored\//i.test(path) || /^sponsored\b/i.test(row.title || "")) f.push("sponsored");
  if (DIGEST.test(row.title || "")) f.push("digest");
  if (LISTING.test(row.title || "")) f.push("listing");
  if (/\/obituar/i.test(path) || /\bobituary\b/i.test(row.title || "")) f.push("obituary");
  return f;
}

// 1 is an ordinary good story. Junk sinks; long, complete articles get a small lift.
export function qualityFor(row, flags) {
  let q = 1;
  if (flags.includes("press_release")) q *= 0.3;
  if (flags.includes("sponsored")) q *= 0.2;
  if (flags.includes("digest")) q *= 0.4;
  if (flags.includes("listing")) q *= 0.4;
  if (row.kind === "news" && row.extracted && row.word_count >= 400) q *= 1.1;
  if (!row.image && row.kind !== "search") q *= 0.95;
  return Math.round(q * 100) / 100;
}
