// Free story matching: two articles are the same story when their headlines (and the start
// of their teasers) share enough rare words. Words are weighted by how unusual they are across
// the last two days of articles, so "Lee Health UnitedHealthcare" counts and "Florida" barely does.

const STOP = new Set(("a an and are as at be been but by for from has have he her his how in into is it its " +
  "of on or our over says said she that the their them they this to up was we were what when where which who " +
  "why will with you your new after about more than just can could would should may now not no out all also " +
  "here there one two get gets got make makes made first last year years day days week today news video watch " +
  "report reports update live latest").split(" "));

export function words(s) {
  return (s || "").toLowerCase()
    .replace(/[‘’']/g, "")
    .replace(/[^a-z0-9$%.]+/g, " ")
    .split(" ")
    .map(w => w.replace(/^\.+|\.+$/g, ""))
    .filter(w => w.length > 2 && !STOP.has(w));
}

// Headline words count double; the teaser adds its first 25 words.
function bag(a) {
  const m = new Map();
  for (const w of words(a.title)) m.set(w, (m.get(w) || 0) + 2);
  for (const w of words(a.teaser).slice(0, 25)) m.set(w, (m.get(w) || 0) + 1);
  return m;
}

export const SAME_STORY = 0.32; // cosine on rare-word weights, tuned on real feeds
const MIN_SHARED = 3;           // and at least this many rare words in common
const MIN_TITLE_SHARED = 2;     // two of them in the headlines themselves

// Group articles. `existing` carry a cluster id; `fresh` do not. Returns Map(freshId -> clusterId
// of an existing article) for joins, and an array of groups (arrays of fresh ids) for new stories.
export function match(existing, fresh) {
  const all = [...existing, ...fresh];
  const df = new Map();
  const bags = new Map(all.map(a => [a.id, bag(a)]));
  for (const b of bags.values()) for (const w of b.keys()) df.set(w, (df.get(w) || 0) + 1);
  const N = all.length;
  const idf = w => Math.log((N + 1) / ((df.get(w) || 0) + 1));
  const titles = new Map(all.map(a => [a.id, new Set(words(a.title))]));
  const vecs = new Map();
  for (const [id, b] of bags) {
    const v = new Map();
    let norm = 0;
    for (const [w, tf] of b) { const x = tf * idf(w); v.set(w, x); norm += x * x; }
    vecs.set(id, { v, norm: Math.sqrt(norm) || 1 });
  }
  const sim = (a, b) => {
    const A = vecs.get(a), B = vecs.get(b);
    let dot = 0, shared = 0;
    for (const [w, x] of A.v) { const y = B.v.get(w); if (y) { dot += x * y; if (idf(w) > 1.5) shared++; } }
    const tb = titles.get(b);
    const titleShared = [...titles.get(a)].filter(w => tb.has(w) && idf(w) > 1.5).length;
    return { s: dot / (A.norm * B.norm), shared, titleShared };
  };

  const joins = new Map();
  const groups = []; // [{ ids: [...] }]
  // A story is several outlets on one event, so an article never matches its own outlet's
  // posts (that is how one channel's highlight videos would all lump together).
  const pool = existing.map(a => ({ id: a.id, source: a.source_id, cluster: a.cluster_id }));
  for (const a of fresh) {
    let best = null;
    for (const p of pool) {
      if (p.source === a.source_id) continue;
      const { s, shared, titleShared } = sim(a.id, p.id);
      if (s >= SAME_STORY && shared >= MIN_SHARED && titleShared >= MIN_TITLE_SHARED && (!best || s > best.s)) best = { ...p, s };
    }
    if (best?.cluster) joins.set(a.id, best.cluster);
    else if (best?.group) best.group.ids.push(a.id);
    else { const g = { ids: [a.id] }; groups.push(g); pool.push({ id: a.id, source: a.source_id, group: g }); continue; }
    pool.push({ id: a.id, source: a.source_id, cluster: best.cluster, group: best.group });
  }
  return { joins, groups: groups.map(g => g.ids) };
}
