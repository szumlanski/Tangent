-- Retention helpers for the fetcher's daily cleanup (the cleanup itself runs in fetcher/retention.js).
-- Articles past the retention window that nobody voted on or hid; votes keep their articles so the
-- learned ranking survives. Readable only with the service key.
create or replace view public.tangent_expired_articles as
select a.id from public.tangent_articles a
where a.fetched_at < now() - interval '14 days'
  and not exists (select 1 from public.tangent_persona_feedback f where f.article_id = a.id)
  and not exists (select 1 from public.tangent_feedback f where f.article_id = a.id)
  and not exists (select 1 from public.tangent_clusters c where c.lead_article_id = a.id and c.updated_at > now() - interval '14 days');
revoke all on public.tangent_expired_articles from public, anon, authenticated;
