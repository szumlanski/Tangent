-- Subscriber sources: papers with a metered or hard paywall that the reader still wants to follow.
-- Tangent stores only their headline, teaser and photo (locked = true) and links out; it never shows paywalled text.
alter table public.tangent_sources add column access text not null default 'free' check (access in ('free', 'subscriber'));
alter table public.tangent_articles add column locked boolean not null default false;

create or replace view public.tangent_feed with (security_invoker = on) as
select a.id, a.kind, a.url, a.title, a.excerpt, a.image, a.author, a.published_at,
       a.word_count, a.extracted, a.video_id, a.duration_s, a.cluster_id,
       s.id as source_id, s.name as source_name, s.topic, s.site_url,
       c.headline as story_headline, c.summary_short, c.bullets, c.article_count as story_size,
       a.locked
from public.tangent_articles a
join public.tangent_sources s on s.id = a.source_id
left join public.tangent_clusters c on c.id = a.cluster_id
where not a.paywalled and s.enabled;
