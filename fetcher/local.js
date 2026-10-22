// Local sources (SW Florida, Vermont) also run national and world wire stories. A story from a local
// source counts as local only if its headline, teaser or opening text names a place in the region;
// the rest are stored as off topic (so they are not fetched again) and kept out of the feed.
const PLACES = {
  swfl: ["southwest florida", "swfl", "sw florida", "florida", "lee county", "collier", "charlotte county", "hendry", "glades county",
    "desoto county", "sarasota", "fort myers", "ft. myers", "cape coral", "naples", "bonita springs", "estero", "sanibel", "captiva",
    "punta gorda", "port charlotte", "lehigh acres", "immokalee", "marco island", "pine island", "matlacha", "babcock ranch",
    "north port", "englewood", "boca grande", "golden gate estates", "ave maria", "labelle", "clewiston", "fgcu",
    "florida gulf coast", "caloosahatchee", "everglades", "gulf coast", "lee health", "rsw", "fpl", "lcec", "desantis", "tallahassee", "hurricane", "tropical storm", "subtropical storm", "national hurricane center"],
  vermont: ["vermont", "vt.", "burlington", "montpelier", "barre", "rutland", "brattleboro", "bennington", "middlebury",
    "st. albans", "st. johnsbury", "stowe", "waterbury", "winooski", "colchester", "south burlington", "williston", "shelburne",
    "woodstock", "killington", "ludlow", "morrisville", "white river junction", "lake champlain", "green mountain", "upper valley",
    "new hampshire", "dartmouth", "uvm", "northeast kingdom", "chittenden", "windham", "lamoille", "caledonia", "vermonter", "phil scott", "gov. scott", "balint", "peter welch"],
};
const res = Object.fromEntries(Object.entries(PLACES).map(([k, list]) =>
  [k, new RegExp(`(^|[^a-z])(${list.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})($|[^a-z])`, "i")]));

export const localTopic = source => source.selectors?.local && source.kind !== "youtube" && source.access !== "subscriber" && res[source.topic] ? source.topic : null;
export const isLocal = (topic, ...texts) => res[topic].test(texts.filter(Boolean).join(" \n "));
// Opening text of an article body: enough to catch a dateline or the first paragraphs.
export const opening = html => (html || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 1500);
