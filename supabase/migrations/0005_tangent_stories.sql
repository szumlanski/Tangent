-- Stories: every article joins a cluster (one event, many outlets). Claude Haiku assigns
-- clusters and writes the summary. summarized_count < article_count means "summarize again".
alter table public.tangent_clusters
  add column headline text,
  add column bullets jsonb,
  add column article_count int not null default 0,
  add column summarized_count int not null default 0,
  add column summarized_at timestamptz;
create index tangent_clusters_updated_idx on public.tangent_clusters (updated_at desc);
create index tangent_articles_unclustered_idx on public.tangent_articles (fetched_at desc) where cluster_id is null;

create or replace view public.tangent_feed with (security_invoker = on) as
select a.id, a.kind, a.url, a.title, a.excerpt, a.image, a.author, a.published_at,
       a.word_count, a.extracted, a.video_id, a.duration_s, a.cluster_id,
       s.id as source_id, s.name as source_name, s.topic, s.site_url,
       c.headline as story_headline, c.summary_short, c.bullets, c.article_count as story_size
from public.tangent_articles a
join public.tangent_sources s on s.id = a.source_id
left join public.tangent_clusters c on c.id = a.cluster_id
where not a.paywalled and s.enabled;
