-- Local sources (SW Florida, Vermont) also carry national and world wire stories. The fetcher marks
-- those off topic: stored so they are not fetched again, but kept out of the feed.
alter table public.tangent_articles add column if not exists offtopic boolean not null default false;

create or replace view public.tangent_feed with (security_invoker = on) as
 select a.id, a.kind, a.url, a.title, a.excerpt, a.image, a.author, a.published_at, a.word_count, a.extracted,
    a.video_id, a.duration_s, a.cluster_id, s.id as source_id, s.name as source_name, s.topic, s.site_url,
    c.headline as story_headline, c.summary_short, c.bullets, c.article_count as story_size, a.locked
   from public.tangent_articles a
     join public.tangent_sources s on s.id = a.source_id
     left join public.tangent_clusters c on c.id = a.cluster_id
  where not a.paywalled and s.enabled and not a.offtopic;
