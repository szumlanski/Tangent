// Decide whether an article page is locked. Checked per article, because many
// outlets (Gannett, Substack, Medium) mix free and paid stories.

export const BLOCKED_DOMAINS = [
  "wsj.com", "nytimes.com", "bloomberg.com", "ft.com", "theinformation.com", "economist.com",
  "washingtonpost.com", "barrons.com", "theathletic.com", "newyorker.com", "wired.com",
  "businessinsider.com", "latimes.com", "bostonglobe.com", "theatlantic.com", "hbr.org",
  "seekingalpha.com", "foreignpolicy.com", "politico.com/pro", "eenews.net",
];

const MARKERS = [
  [/tinypass|piano\.io|cdn\.tinypass|tp\.experience/i, "piano"],
  [/zephr/i, "zephr"],
  [/poool\.fr|poool-widget/i, "poool"],
  [/laterpay/i, "laterpay"],
  [/class="[^"]*\b(paywall|regwall|meter-wall|subscriber-only|premium-content|piano-paywall)\b/i, "paywall class"],
  [/"isPremium"\s*:\s*true|"premium"\s*:\s*true/i, "premium flag"],
  [/"audience"\s*:\s*"only_paid"/i, "substack paid"],
  [/This post is for paid subscribers|This post is for paying subscribers/i, "substack paid"],
  [/Member-only story/i, "medium member"],
  [/"gnt_pw"|gnt-paywall|data-paywall/i, "gannett"],
];

// Phrases a truncated, locked article shows. Plain "subscribe" is too common (newsletters).
export const LOCK_TEXT = /(subscribe|sign in|log in) to (continue|keep) reading|already a subscriber|for (paid|paying) subscribers|subscribers only|this article is (exclusive|available) to subscribers/i;

export function isBlockedDomain(url) {
  const u = new URL(url);
  const host = u.hostname.replace(/^www\./, "");
  return BLOCKED_DOMAINS.some(d => {
    const [dh, ...path] = d.split("/");
    const hostHit = host === dh || host.endsWith("." + dh);
    return hostHit && (!path.length || u.pathname.startsWith("/" + path.join("/")));
  });
}

// Returns a reason string if locked, else null. Vendor scripts load on free
// pages too, so they only count when the readable body is truncated.
export function detectPaywall(html, { wordCount = 0 } = {}) {
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    if (/"isAccessibleForFree"\s*:\s*("false"|false)/i.test(m[1])) return "ld+json not free";
  }
  if (/<meta[^>]+(article:content_tier|content_tier)[^>]+content=["'](locked|metered)["']/i.test(html)) return "content_tier meta";
  // Generic vendor scripts (Piano, Zephr...) also run on free sites for analytics, so they only
  // count alongside an actual lock message. Platform markers (Gannett, Substack, Medium) are specific.
  for (const [re, why] of MARKERS) {
    if (!re.test(html)) continue;
    const strong = /gannett|substack|medium|premium flag|paywall class/.test(why);
    if (strong ? wordCount < 200 : wordCount < 200 && LOCK_TEXT.test(html)) return why;
  }
  return null;
}
