-- Accounts, sessions, shelves and per-user data for the public app.
-- Every table here has RLS on and no policies: the API cannot read or write them directly.
-- Cloudflare Pages Functions reach them only through the SECURITY DEFINER functions below,
-- which all require the server secret (only its SHA-256 is stored, in tangent_config).
-- Passwords are bcrypt-hashed inside Postgres (pgcrypto), never in the Worker.

create table public.tangent_users (
  id            uuid primary key default gen_random_uuid(),
  email         text not null,
  name          text not null default '',
  password_hash text,
  google_sub    text unique,
  is_admin      boolean not null default false,
  settings      jsonb not null default '{}',
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz
);
create unique index tangent_users_email_idx on public.tangent_users (lower(email));

create table public.tangent_sessions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.tangent_users(id) on delete cascade,
  user_agent   text,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  expires_at   timestamptz not null default now() + interval '90 days'
);
create index tangent_sessions_user_idx on public.tangent_sessions (user_id);

-- Suggested topics shown at sign-up. Picking one makes a shelf with that topic's sources.
create table public.tangent_topics (
  slug        text primary key,
  name        text not null,
  blurb       text not null default '',
  query       text,             -- search phrase that also feeds the shelf
  position    int not null default 0,
  is_default  boolean not null default false
);

create table public.tangent_shelves (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references public.tangent_users(id) on delete cascade,
  name       text not null,
  position   int not null default 0,
  topic      text references public.tangent_topics(slug) on delete set null,
  query      text,             -- a topic phrase ("woodworking") that feeds the shelf via search
  created_at timestamptz not null default now()
);
create index tangent_shelves_user_idx on public.tangent_shelves (user_id, position);

create table public.tangent_shelf_sources (
  shelf_id  bigint not null references public.tangent_shelves(id) on delete cascade,
  source_id bigint not null references public.tangent_sources(id) on delete cascade,
  primary key (shelf_id, source_id)
);
create index tangent_shelf_sources_source_idx on public.tangent_shelf_sources (source_id);

-- Login and sign-up throttling.
create table public.tangent_rate (
  key          text primary key,
  window_start timestamptz not null default now(),
  hits         int not null default 0
);

-- Sources can now be requested by users, and a "search" source follows a topic phrase.
alter table public.tangent_sources drop constraint if exists tangent_sources_kind_check;
alter table public.tangent_sources add constraint tangent_sources_kind_check check (kind in ('news','blog','youtube','podcast','search'));
alter table public.tangent_sources
  add column query text,
  add column status text not null default 'active' check (status in ('pending','active','rejected')),
  add column status_note text,
  add column added_by uuid references public.tangent_users(id) on delete set null;

-- Feedback becomes per user.
alter table public.tangent_feedback add column user_id uuid references public.tangent_users(id) on delete cascade;

alter table public.tangent_users enable row level security;
alter table public.tangent_sessions enable row level security;
alter table public.tangent_topics enable row level security;
alter table public.tangent_shelves enable row level security;
alter table public.tangent_shelf_sources enable row level security;
alter table public.tangent_rate enable row level security;
create policy tangent_topics_read on public.tangent_topics for select to anon, authenticated using (true);

-- One row per user per article. Rows from before accounts have no user until the owner claims them.
alter table public.tangent_feedback drop constraint tangent_feedback_pkey;
alter table public.tangent_feedback add constraint tangent_feedback_user_article unique nulls not distinct (user_id, article_id);

-- Suggested topics: today's shelves.
insert into public.tangent_topics (slug, name, blurb, query, position, is_default) values
  ('world',   'World',      'AP, Reuters, BBC, NPR, The Guardian and more',            null, 0, true),
  ('tech',    'Tech & AI',  'Ars Technica, The Verge, TechCrunch, AI labs, YouTube',   null, 1, true),
  ('solar',   'Solar & energy', 'Electrek, pv magazine, Canary Media, Utility Dive',    null, 2, false),
  ('swfl',    'SW Florida', 'WINK, NBC2, Fox 4, News-Press, Cape Coral Breeze',         null, 3, false),
  ('travel',  'Travel',     'Atlas Obscura, AFAR, Conde Nast Traveler, The Points Guy', null, 4, false),
  ('vermont', 'Vermont',    'VTDigger, Seven Days, Valley News, WCAX and local papers', null, 5, false),
  ('sports',  'Sports',     'Highlights from the NFL, college football, NBA, MLB',      null, 6, false)
on conflict do nothing;
