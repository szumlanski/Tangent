// Meaning vectors for headlines and articles: all-MiniLM-L6-v2 (384 numbers), run locally on the
// CPU through transformers.js. Free, about 3 ms an item; the model (~23 MB) downloads once per job.
import { pipeline, env } from "@huggingface/transformers";

env.cacheDir = new URL("../.cache/models/", import.meta.url).pathname;
let extractor;
export async function embed(texts) {
  extractor ||= await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", { dtype: "q8" });
  const out = [];
  for (let i = 0; i < texts.length; i += 32) {
    const t = await extractor(texts.slice(i, i + 32).map(s => (s || "").slice(0, 1500)), { pooling: "mean", normalize: true });
    out.push(...t.tolist());
  }
  return out;
}
export const toPg = v => "[" + v.map(x => x.toFixed(4)).join(",") + "]";
