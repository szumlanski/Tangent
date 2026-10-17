# Tangent: notes for Claude

- Live site: https://tangent.szumlanski.com (Cloudflare Pages project `tangent`, Git-connected). Pushing to `main` deploys; there is no build step and the output directory is `app/`.
- Always merge finished work to `main` and push to deploy. Do not ask Jason first.
- The web app is `app/index.html` (UI, CSS, JS). Keep it one self-contained file with no outside scripts or fonts so it stays fast and works offline.
- The fetcher is Node in `fetcher/`, run by `.github/workflows/fetch.yml` every 15 min. Run `npm test` and `DRY=1 npm run fetch` before pushing fetcher changes. Behind the cloud proxy, set `NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt`.
- Story grouping and summaries: `fetcher/stories.js`, model `claude-haiku-5-5` (cheap, runs every 15 min). Keep model calls in the exported `model` object so tests can stand in for them.
- `functions/api/chart.js` and `functions/api/espn.js` are Pages Functions (free plan: keep CPU light, cache at the edge). The service worker must never cache `/api/`.
- Approving scout suggestions needs the owner key, opened once per device as `https://tangent.szumlanski.com/#key=...`. Only its SHA-256 is in `tangent_config`.
- Database: Supabase project EG4 Monitor (`kyplwgcvbfzyfhiyspsr`). It is a live customer database for another app. Only ever touch objects prefixed `tangent_`. Add schema changes as new files in `supabase/migrations/`.
- Paywalled articles must never show. Detection is per article in `fetcher/paywall.js` and `fetcher/extract.js`; the `tangent_articles` RLS policy also hides `paywalled = true` rows.
- After changing anything in `app/`, bump `CACHE` in `app/sw.js` (tangent-vN) so installed copies refresh.
- Icons: edit `design/icon.svg` and `design/fav.svg`, then re-render the PNGs. If an icon changes, give the PNGs new file names, because `app/_headers` lets browsers cache PNGs for a week.
- Before pushing, render with Playwright at 390px (light and dark) and 1280px, read the screenshots, and confirm zero console errors and no horizontal scroll.
- Follow `docs/hig-notes.md` (44px targets, 17px body text, 4.5:1 contrast, sentence case). Avoid generic AI-looking design.
- Never use em dashes in UI copy, code comments, commits or replies.
- Free services only. The only key in the page is the Supabase publishable key, which is public by design; RLS guards the data.
