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
- [x] 5. App: professional public landing page (hero, how it works, features, screenshots, FAQ, footer with privacy/terms/help), sign-in/sign-up sheet, onboarding (pick suggested topics), signed-in feed per shelf.
- [x] 5b. Help: public help page (/help) with full FAQ, and an in-app Help and FAQ section in the account menu.
- [x] 6. Shelves editor: add, rename, reorder, delete shelves; add or remove sources per shelf; search the catalog;
      paste any URL or YouTube channel; create a topic shelf from a phrase.
- [ ] 7. Source requests and discovery: pasted URLs and topic phrases are vetted by the fetcher job (feed found,
      fresh, free, readable) and join the catalog; background discovery per shelf topic, suggestions shown per shelf.
- [ ] 8. Per-user feedback and learned ranking (move from owner key to accounts); per-user sports teams and stock tickers.
- [ ] 9. Admin dashboard (Jason asked 2026-10-18): an admin-only page in the app listing users (email, name, sign-in method,
      joined, last seen, shelves, sources added, votes, status) with search; stats (total and active users by day/week,
      sign-ups over time, sessions, votes, hides, source requests, fetch health); robust logging: a `tangent_events_log`
      table written by the API for sign-ups, sign-ins (success and failure, with IP and user agent), sign-outs, password
      changes, account deletions, shelf and source changes, rate-limit hits and server errors, plus fetcher runs; viewable
      and filterable in the dashboard, kept 180 days. Admin actions: disable a user, end their sessions, disable or
      remove any source. Retire the owner-key link once Jason's account is admin.
- [ ] 10. Housekeeping for a public app: privacy policy, terms, account deletion, data retention (drop article bodies
      after 21 days, articles after 60) to stay inside the free database, security review of the new endpoints.
- [ ] 11. Domain: tangentreads.com and www attached and live (done 2026-10-18). Remaining: redirect www and tangent.szumlanski.com to tangentreads.com after accounts ship (the owner key is stored per address).

## Steps only Jason can do (collected here, given to him one at a time at the end)
- Approve a purge job for closed accounts. Database changes that DELETE rows are blocked for Claude by a permission
  check, so closing an account scrubs personal data immediately (email, name, password, Google link) and the leftover
  rows stay until a purge migration is approved. Sessions, shelves and shelf sources use soft removal by design.
- Create a Google OAuth client (Google Cloud Console) and paste its ID and secret into Cloudflare.
- Optional: Resend account for password-reset emails (free 3,000/month).
- Optional: a contact address (for example hello@tangentreads.com via free Cloudflare Email Routing) for the privacy page and publisher removal requests.

## Log
- 2026-10-18 item 1: app loads each topic's newest 160 (sports 60) separately. Vermont went from 2 visible stories to 82. Shelves (item 6) will move this server-side per user.
- 2026-10-18 domain: Jason registered tangentreads.com; attached apex and www to the Pages project with proxied CNAMEs, apex active and serving.
- 2026-10-18 item 2: +13 Vermont (10 free, plus Manchester Journal, Bennington Banner, Brattleboro Reformer as new 'subscriber' headline-only sources: all their articles are marked paid), +21 across solar, tech, world, SWFL, travel. Fixed a paywall false positive (Piano analytics script on free WCAX pages); news window 3 to 7 days for weekly papers.
- 2026-10-18 item 3: users, sessions, topics, shelves, shelf sources, rate limits, per-user feedback; 22 server-secret functions (secret hash in tangent_config, secret in Cloudflare env via API). End-to-end tested with a throwaway account (closed afterwards). Owner claims admin and old votes by signing in on a device holding the owner key.
- 2026-10-18 item 4: /api/v1 router (lib/server.js + functions/api/v1/[[path]].js): email sign-up/in/out, Google code flow with PKCE (live once Jason adds GOOGLE_CLIENT_ID/SECRET), sessions as HMAC-signed HttpOnly cookies, rate limits per IP and per email, same-origin check on POSTs, shelves, feedback, settings, password change, delete, owner claim. 4 unit tests; 22-step end-to-end run against the real database passed.
- 2026-10-18 Jason: hide used an x on cards but a crossed-out eye in the reader; same action, now the eye everywhere.
- 2026-10-18 items 5 and 5b: /welcome landing (hero, how it works, features, real screenshots with publisher photos swapped for color fields, FAQ, footer), /help full FAQ (also loaded into the in-app Help sheet), /privacy, /terms. App: signed-out visitors go to /welcome (tg_in readable cookie, tg_guest for look-around), account menu replaces the Sources button (shelves picker, sources, help, password, sign out, sign out everywhere, delete), onboarding topic picker, tabs and loading per shelf, votes saved per account, owner key claims admin on sign-in. SW no longer serves the app for other pages. Playwright e2e against the real API and database: sign up, pick shelves, vote, help, sign out everywhere, sign in, delete: all pass, zero unexpected console errors, no sideways scroll at 390 light/dark and 1280.
- 2026-10-18 item 6: shelves editor in the account menu: reorder (up/down), new shelf from any phrase (adds a Google News search source), per-shelf rename, sources list, catalog search, paste a site/feed/YouTube channel/@handle (stored pending until item 7's vetting turns it on), remove source, remove shelf. New DB functions tangent_order_shelves and tangent_request_source (0012); API routes shelves/order and shelves/request with address checks (no local or private hosts) and 40/day per user. Fixed two sheet bugs (a quick reopen got blanked or closed). Playwright e2e passed at 390 light, 390 dark and 1280. Closed 7 leftover test accounts.
- 2026-10-18 Jason: password minimum 8 (was 10). Push alerts added: Web Push (VAPID keys in tangent_config, sent by the fetcher after each run with the web-push library), alerts for big stories (4+ outlets within a day, touching your shelves; on by default), words or phrases, shelf updates (at most hourly) and sources; one push per story, daily cap (default 10), quiet hours (default 10 pm to 7 am in the device's time zone), 3 per run. Alerts panel in the account menu; tapping a notification opens the story. Migration 0013; tangent_alert_sent doubles as the notification log for the admin dashboard. Matching is local word matching, so no AI cost. Tests: 6 engine and endpoint unit tests; Playwright e2e at 390 light/dark and 1280 passed.
