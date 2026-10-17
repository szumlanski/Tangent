# Tangent: personal Flipboard-style news app

## Context
Jason wants a Flipboard clone tuned to his own sources, with no paywalled articles, and better than Flipboard. Repo `szumlanski/Tangent` is empty (README only). Branch: `ccr-ff452c17-psm5pu`.

Decisions made:
- Topics: Solar/energy/utilities, Tech/AI, National/world, Local SW Florida, Travel features, Vermont news.
- UX: page-flip on phone, magazine grid on desktop.
- Claude layer: summaries, story dedupe/clustering, learned ranking.
- Phone + desktop, synced. Installable PWA.
- Tap opens in-app clean reader (full text), fallback to original link.
- Paywalled articles are dropped.
- Stack: Cloudflare Pages (app) + Cloudflare Worker cron (fetcher/API) + existing Supabase project **EG4 Monitor** (`kyplwgcvbfzyfhiyspsr`), the only project on the account. No new database.

## Architecture
```
Worker cron (every 15 min)
  -> fetch sources (RSS / sitemap / Google News / HTML scrape)
  -> normalize + extract full text (Readability)
  -> paywall check -> drop
  -> embed (Workers AI) -> cluster duplicates
  -> summarize new clusters (Claude Haiku 5.5)
  -> write to Supabase (tangent_* tables)
Pages PWA  <-> Worker API (/api/feed, /api/article, /api/event) <-> Supabase
```

## Fetching: never "can't fetch"
Each source has an ordered list of strategies; the fetcher falls through until one returns items, and records which one worked.
1. Native RSS/Atom (most sources: Electrek, PV Magazine, Canary Media, Utility Dive, Ars, The Verge, AP, NPR, BBC, VTDigger, VPR, Seven Days, Atlas Obscura, NBC2, WINK, etc.).
2. Google News per-site RSS: `https://news.google.com/rss/search?q=site:example.com+when:2d` (works for nearly any site with no feed; resolve the redirect to the real URL).
3. News sitemap: `/news-sitemap.xml` or `sitemap_index.xml` filtered to last 48 h.
4. HTML list scrape: per-source CSS selector config (stored in DB, editable without redeploy).
5. Full text: fetch article HTML with a real browser UA, run `@mozilla/readability` + `linkedom` in the Worker. If the Worker IP is blocked (403/challenge), retry through a GitHub Actions scheduled job (different IP range) that pushes results to Supabase. Last resort: show RSS teaser + link.

### YouTube and blogs (first-class source types, not just news outlets)
- Source `kind`: `news` | `blog` | `youtube` | `podcast` (later). Any kind can belong to any topic.
- YouTube: channel feed `https://www.youtube.com/feeds/videos.xml?channel_id=UC...` (no API key, no quota). Add by pasting any channel URL or @handle; the Worker resolves the channel ID from the page. Playlists via `?playlist_id=`. Shorts filtered out by default (toggle).
- Video cards: thumbnail with duration, tap plays inline (`youtube-nocookie.com` embed) in the reader. Claude summary from the transcript (caption track); fallback to title + description if no captions. "Skip to the good part" chapter list from the summary with timestamps.
- Blogs: any RSS/Atom. Substack (`/feed`): paid-only posts dropped via `audience`/paywall markers. Medium (`/feed/@user`): member-only posts dropped. Ghost/WordPress handled by the normal paywall checks.
- OPML import/export so you can bring a reader list in one shot.
- Blogs and videos are clustered with news too, so a YouTube breakdown of a story attaches to that story's card as "Video coverage".
- Source health table: last success, strategy used, item count, error. Shown on a Sources page so a dead feed is visible, not silent.

## Paywall filter (per article, not just per domain)
Drop if any of:
- JSON-LD `isAccessibleForFree: false` or `hasPart.isAccessibleForFree: false`.
- Paywall vendor markers in HTML: Piano/Tinypass, Zephr, Poool, Laterpay, `meter`/`regwall` classes, Gannett paywall flags (News-Press is Gannett: free articles kept, locked ones dropped).
- Extracted body under ~150 words while page claims a longer article.
- Domain blocklist (WSJ, NYT, Bloomberg, FT, The Information, etc.) so they are never fetched.
- Per-domain paywall rate is tracked; a domain over 80% locked gets auto-disabled with a note on the Sources page.

## Claude / AI layer
- Embeddings: Workers AI `@cf/baai/bge-base-en-v1.5` (free tier, in-Worker). Cosine > 0.85 within 48 h joins an existing cluster.
- Summaries: `claude-haiku-5-5` per cluster (not per article): 2 line card blurb + 5 bullet full summary, plus "N outlets covering this" list. Only summarize clusters that survive the paywall filter. Est. a few hundred calls/day.
- Ranking: score = recency decay x source weight x topic affinity. Affinity = cosine to a user interest vector built from opens, read time, saves (positive) and quick skips, "less like this", hides (negative). Updated on each event.

## Data (Supabase, EG4 Monitor project, `tangent_` table prefix in `public`, RLS on)
- `tangent_sources` (id, name, kind, topic, url, strategies jsonb, selectors jsonb, enabled, weight, health fields)
- `tangent_articles` (id, source_id, kind, url unique, title, video_id, duration_s, transcript, image, author, published_at, body_html, word_count, paywalled bool, embedding vector(768), cluster_id)
- `tangent_clusters` (id, topic, lead_article_id, summary_short, summary_long, score, updated_at)
- `tangent_events` (user_id, article_id, kind: open/read/save/skip/hide/less, dwell_ms, at)
- `tangent_user_prefs` (user_id, interest_vector, muted_words[], muted_sources[], topic_order[])
- `tangent_saves` (user_id, article_id, at)
- Requires `pgvector` extension (enable if not already).
- Auth: Supabase magic link (single user, you).
- Migration via Supabase MCP `apply_migration`; nothing else in EG4 Monitor is touched.

## Front end (Cloudflare Pages, Vite + vanilla TS or Preact, PWA)
- Topic tabs ("magazines") across the top; "For You" first (ranked mix).
- Phone: full-screen pages, vertical swipe flips with CSS 3D page-turn, 1 to 4 stories per page depending on image/size.
- Desktop: magazine grid, hero story + tiles, keyboard J/K/Space.
- Reader: clean typography, Claude summary at top (collapsible), "Other coverage" from the cluster, Save, Less like this.
- Offline: service worker caches the last loaded feed + saved articles.
- Dark mode, follows system.

## Better than Flipboard
1. No ads, no paywalls, no "sponsored" cards.
2. One card per story, not six copies (dedupe clusters with outlet list).
3. Summary first, read the full piece only if worth it.
4. "Why am I seeing this" on each card, and real controls (mute word, mute source, less like this) that actually work.
5. "New since last visit" divider so you know where you left off.
6. Source health page: you see which feed broke and why, add a source by pasting any URL (auto-detects best strategy).
7. Keyword alerts (e.g. "FPL rate case", "net metering", "NEM", "Powerwall", "hurricane") pinned at top and optionally push-notified.
8. Hurricane mode: when NHC has an active Gulf storm, a SW Florida storm panel (NHC advisories + local outlets) jumps to the top.
9. Video summaries with timestamped chapters, so a 25 min YouTube video becomes a 30 second read with jump links.
10. Filter by kind ("Videos only", "Blogs only") inside any topic.
11. "Ask Claude" box in the reader for follow-up questions about the article.

## Build phases (one commit each, pushed to `ccr-ff452c17-psm5pu`)
1. Scaffold: Vite PWA, Worker, wrangler config, Supabase migration, seed ~40 sources across the 6 topics.
2. Fetcher: strategies 1 to 4, Readability extraction, paywall filter, source health. Cron trigger.
3. Feed API + magazine grid UI + reader. YouTube + blog sources, video cards, OPML import.
4. Phone flip UI, offline, auth/sync.
5. Embeddings, clustering, Claude summaries.
6. Ranking + events, mutes, "new since last visit", keyword alerts.
7. Hurricane mode, Ask Claude, GitHub Actions fallback fetcher.

## What Jason will need to do (one step at a time when we get there)
- Create the Cloudflare Pages project + Worker (or approve via Cloudflare dashboard / `wrangler login`).
- Add secrets: `ANTHROPIC_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`.
- Pick the subdomain (e.g. `news.szumlanski.com`).

## Verification
- `npm run test`: unit tests for paywall detector (fixtures from free vs locked pages), feed parsers, clustering threshold.
- `wrangler dev --test-scheduled` then hit `/__scheduled`: confirm rows land in `tangent_articles` with zero `paywalled=true` shown in `/api/feed`.
- Source health query: every seeded source reports success or a clear error.
- Playwright (preinstalled Chromium) at 390px and 1440px: flip works, grid renders, reader opens, screenshots attached.
