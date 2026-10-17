-- Tangent lives inside the EG4 Monitor project. Every object is prefixed tangent_
-- and touches nothing else in the database.

create extension if not exists vector with schema extensions;

create table public.tangent_sources (
  id            bigint generated always as identity primary key,
  name          text not null,
  kind          text not null default 'news' check (kind in ('news','blog','youtube','podcast')),
  topic         text not null,
  site_url      text not null,
  feed_url      text,
  strategies    text[] not null default '{rss,gnews,sitemap,scrape}',
  selectors     jsonb,
  weight        real not null default 1,
  enabled       boolean not null default true,
  disabled_reason text,
  last_ok_at    timestamptz,
  last_run_at   timestamptz,
  last_strategy text,
  last_count    int,
  last_error    text,
  paywall_seen  int not null default 0,
  items_seen    int not null default 0,
  created_at    timestamptz not null default now(),
  unique (site_url, feed_url)
);

create table public.tangent_clusters (
  id              bigint generated always as identity primary key,
  topic           text not null,
  lead_article_id bigint,
  summary_short   text,
  summary_long    text,
  chapters        jsonb,
  score           real not null default 0,
  first_seen_at   timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table public.tangent_articles (
  id            bigint generated always as identity primary key,
  source_id     bigint not null references public.tangent_sources(id) on delete cascade,
  kind          text not null default 'news',
  url           text not null unique,
  title         text not null,
  excerpt       text,
  image         text,
  author        text,
  published_at  timestamptz not null,
  fetched_at    timestamptz not null default now(),
  body_html     text,
  word_count    int,
  extracted     boolean not null default false,
  paywalled     boolean not null default false,
  paywall_reason text,
  video_id      text,
  duration_s    int,
  transcript    text,
  embedding     extensions.vector(768),
  cluster_id    bigint references public.tangent_clusters(id) on delete set null
);
create index tangent_articles_pub_idx on public.tangent_articles (published_at desc);
create index tangent_articles_source_idx on public.tangent_articles (source_id, published_at desc);
create index tangent_articles_cluster_idx on public.tangent_articles (cluster_id);

alter table public.tangent_clusters
  add constraint tangent_clusters_lead_fk foreign key (lead_article_id)
  references public.tangent_articles(id) on delete set null;

create table public.tangent_events (
  id         bigint generated always as identity primary key,
  user_id    uuid not null,
  article_id bigint not null references public.tangent_articles(id) on delete cascade,
  kind       text not null check (kind in ('open','read','save','skip','hide','less')),
  dwell_ms   int,
  at         timestamptz not null default now()
);
create index tangent_events_user_idx on public.tangent_events (user_id, at desc);
create index tangent_events_article_idx on public.tangent_events (article_id);

create table public.tangent_user_prefs (
  user_id         uuid primary key,
  interest_vector extensions.vector(768),
  muted_words     text[] not null default '{}',
  muted_sources   bigint[] not null default '{}',
  topic_order     text[] not null default '{}',
  alert_keywords  text[] not null default '{}',
  last_visit_at   timestamptz,
  updated_at      timestamptz not null default now()
);

create table public.tangent_saves (
  user_id    uuid not null,
  article_id bigint not null references public.tangent_articles(id) on delete cascade,
  at         timestamptz not null default now(),
  primary key (user_id, article_id)
);

-- RLS: news content is public to read; writes only via the service role (fetcher).
-- Per-user tables are locked to their owner.
alter table public.tangent_sources    enable row level security;
alter table public.tangent_clusters   enable row level security;
alter table public.tangent_articles   enable row level security;
alter table public.tangent_events     enable row level security;
alter table public.tangent_user_prefs enable row level security;
alter table public.tangent_saves      enable row level security;

create policy tangent_sources_read  on public.tangent_sources  for select to anon, authenticated using (true);
create policy tangent_clusters_read on public.tangent_clusters for select to anon, authenticated using (true);
create policy tangent_articles_read on public.tangent_articles for select to anon, authenticated using (not paywalled);

create policy tangent_events_own on public.tangent_events for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy tangent_prefs_own  on public.tangent_user_prefs for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy tangent_saves_own  on public.tangent_saves for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

-- Feed view: newest free articles with their source, no heavy columns.
create view public.tangent_feed with (security_invoker = on) as
select a.id, a.kind, a.url, a.title, a.excerpt, a.image, a.author, a.published_at,
       a.word_count, a.extracted, a.video_id, a.duration_s, a.cluster_id,
       s.id as source_id, s.name as source_name, s.topic, s.site_url
from public.tangent_articles a
join public.tangent_sources s on s.id = a.source_id
where not a.paywalled and s.enabled;
