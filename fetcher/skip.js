// Some local papers' feeds carry the whole wire (AP national, world, pro sports). selectors.skip is a
// regex on the URL path for the sections to leave out, set per source in the database.
export function skipped(source, url) {
  const re = source.selectors?.skip;
  if (!re) return false;
  try { return new RegExp(re, "i").test(new URL(url).pathname); } catch { return false; }
}
