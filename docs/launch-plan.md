# Tangent public launch: build plan

Goal: Tangent becomes a public app at https://tangentreads.com. Anyone can sign up (Google or email and password),
pick topics ("shelves"), add any source Tangent can read, search sources, and keep getting new sources found for them.
Jason's decisions (2026-10-18): data stays in the EG4 Monitor Supabase project (`tangent_` tables only), sign-in is
built into Tangent on Cloudflare Pages Functions (not Supabase Auth: EG4's auth trigger would make every Tangent user
an EG4 subscriber), open sign-up, domain tangentreads.com, free services only.

Each loop iteration: take the first unchecked item, build it, test it (unit tests, dry fetch, Playwright at 390px
light/dark and 1280px, zero console errors), deploy to main, check it off here with one line of notes. Never touch
non-`tangent_` objects in the database. Keep API cost near zero (see CLAUDE.md).

## Architecture
- Accounts: `tangent_users` (email, name, bcrypt password via pgcrypto in Postgres so the Worker's 10 ms CPU limit is
  not hit, google_sub, is_admin). Sessions: HMAC-signed cookie (HttpOnly, Secure, SameSite=Lax) made by Pages
  Functions; `tangent_sessions` row per login so sign-out and "sign out everywhere" work.
- Server trust: Pages Functions call SECURITY DEFINER RPCs with a server secret (only its SHA-256 lives in
  `tangent_config`; the secret is a Cloudflare Pages env var set by Claude through the API). No service key in Cloudflare.
- Per-user data: shelves, shelf sources, feedback (votes/hides), settings (teams, tickers). Tables have RLS on and no
  policies: reachable only through the RPCs.
- Content stays global: sources and articles are shared; the fetcher fetches every source any shelf uses.
- Topic shelves: a shelf can carry a search phrase; Tangent adds a "search" source (Google News for that phrase), so a
  new topic has stories within one fetch run, plus discovery suggests real outlets for it.

## Checklist
- [x] 1. Feed loads per shelf/topic from the server (no global 400-newest cap; this is why Vermont was empty).
- [x] 2. More sources for every topic. Vermont first: Manchester Journal, Bennington Banner, Brattleboro Reformer,
      Rutland Herald, Valley News, WCAX, NBC5, Vermont Business Magazine, Addison Independent, Stowe Reporter and others
      that pass the paywall and freshness checks. Then 3 to 6 more per other topic.
- [x] 3. Schema: users, sessions, shelves, shelf_sources, topic catalog (suggested topics with vetted sources), per-user
      feedback and settings, rate limits, server-secret RPCs. Migrate Jason's current data to his admin account.
- [x] 4. Auth API (Pages Functions): sign up, sign in, sign out, session check, Google OAuth (code flow + PKCE),
      password change, account deletion, rate limiting. Unit tests for cookie signing and input validation.
- [ ] 5. App: public landing page, sign-in/sign-up sheet, onboarding (pick suggested topics), signed-in feed per shelf.
- [ ] 6. Shelves editor: add, rename, reorder, delete shelves; add or remove sources per shelf; search the catalog;
      paste any URL or YouTube channel; create a topic shelf from a phrase.
- [ ] 7. Source requests and discovery: pasted URLs and topic phrases are vetted by the fetcher job (feed found,
      fresh, free, readable) and join the catalog; background discovery per shelf topic, suggestions shown per shelf.
- [ ] 8. Per-user feedback and learned ranking (move from owner key to accounts); per-user sports teams and stock tickers.
- [ ] 9. Admin: Jason can remove or disable any source, see user and source counts, retire the owner-key link.
- [ ] 10. Housekeeping for a public app: privacy policy, terms, account deletion, data retention (drop article bodies
      after 21 days, articles after 60) to stay inside the free database, security review of the new endpoints.
- [ ] 11. Domain: tangentreads.com and www attached and live (done 2026-10-18). Remaining: redirect www and tangent.szumlanski.com to tangentreads.com after accounts ship (the owner key is stored per address).

## Steps only Jason can do (collected here, given to him one at a time at the end)
- Approve a purge job for closed accounts. Database changes that DELETE rows are blocked for Claude by a permission
  check, so closing an account scrubs personal data immediately (email, name, password, Google link) and the leftover
  rows stay until a purge migration is approved. Sessions, shelves and shelf sources use soft removal by design.
- Create a Google OAuth client (Google Cloud Console) and paste its ID and secret into Cloudflare.
- Optional: Resend account for password-reset emails (free 3,000/month).

## Log
- 2026-10-18 item 1: app loads each topic's newest 160 (sports 60) separately. Vermont went from 2 visible stories to 82. Shelves (item 6) will move this server-side per user.
- 2026-10-18 domain: Jason registered tangentreads.com; attached apex and www to the Pages project with proxied CNAMEs, apex active and serving.
- 2026-10-18 item 2: +13 Vermont (10 free, plus Manchester Journal, Bennington Banner, Brattleboro Reformer as new 'subscriber' headline-only sources: all their articles are marked paid), +21 across solar, tech, world, SWFL, travel. Fixed a paywall false positive (Piano analytics script on free WCAX pages); news window 3 to 7 days for weekly papers.
- 2026-10-18 item 3: users, sessions, topics, shelves, shelf sources, rate limits, per-user feedback; 22 server-secret functions (secret hash in tangent_config, secret in Cloudflare env via API). End-to-end tested with a throwaway account (closed afterwards). Owner claims admin and old votes by signing in on a device holding the owner key.
- 2026-10-18 item 4: /api/v1 router (lib/server.js + functions/api/v1/[[path]].js): email sign-up/in/out, Google code flow with PKCE (live once Jason adds GOOGLE_CLIENT_ID/SECRET), sessions as HMAC-signed HttpOnly cookies, rate limits per IP and per email, same-origin check on POSTs, shelves, feedback, settings, password change, delete, owner claim. 4 unit tests; 22-step end-to-end run against the real database passed.
