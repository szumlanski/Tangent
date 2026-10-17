# Tangent

A personal Flipboard alternative: your sources, no paywalled articles, one card per story.

Live: https://tangent.szumlanski.com

## How it fits together

- `app/` is the whole web app (one `index.html`, service worker, icons). Cloudflare Pages serves it; pushing to `main` deploys.
- `fetcher/` runs every 15 minutes in GitHub Actions (`.github/workflows/fetch.yml`). For each source it tries RSS, then Google News for that site, then the site's news sitemap, then a page scrape, and uses the first that works. It pulls each article's full text with Mozilla Readability and drops paywalled ones.
- `functions/api/` are Cloudflare Pages Functions: `chart.js` serves stock charts (Yahoo, falling back to Nasdaq and CBOE) and `espn.js` is a cached pass-through to ESPN's scoreboard, rankings and news.
- After fetching, `fetcher/stories.js` groups new articles into stories (one event, several outlets) with free local word matching (`fetcher/match.js`). Claude Haiku 5.5 then summarizes only the multi-outlet stories, once at 2 outlets and again when the count doubles (about $1 a month). Summaries need the `ANTHROPIC_API_KEY` repo secret; grouping does not.
- The same 15-minute job refreshes local trends hourly (Google Trends Florida, local subreddits).
- `fetcher/scout.js` runs weekly (`.github/workflows/scout.yml`) and files new source suggestions; approve them on the Sources page.
- Data lives in Supabase (EG4 Monitor project), in tables prefixed `tangent_`. Schema is in `supabase/migrations/`, starter sources in `supabase/seed_sources.sql`.

## Commands

```
npm ci
npm test               # unit tests for feed parsing and paywall detection
DRY=1 npm run fetch    # full fetch pass, prints results, writes nothing
npm run fetch          # real run, needs SUPABASE_SERVICE_ROLE_KEY
npm run fetch -- wink  # only sources whose name contains "wink"
DRY=1 npm run scout    # find and vet new sources, writes nothing
```

## Adding a source

Insert a row in `tangent_sources`. `kind` is `news`, `blog` or `youtube`; `topic` is one of `solar`, `tech`, `world`, `swfl`, `travel`, `vermont`, `sports` (sports videos feed the Highlights rail).
`strategies` is the order to try (`rss`, `gnews`, `sitemap`, `scrape`). YouTube feeds are `https://www.youtube.com/feeds/videos.xml?channel_id=UC...`.
