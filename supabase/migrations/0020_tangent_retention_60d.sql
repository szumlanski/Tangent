-- The database is on the Pro plan (8 GB), so stories are kept 60 days instead of 14.
create or replace view public.tangent_expired_articles as
select a.id from public.tangent_articles a
where a.fetched_at < now() - interval '60 days'
  and not exists (select 1 from public.tangent_persona_feedback f where f.article_id = a.id)
  and not exists (select 1 from public.tangent_feedback f where f.article_id = a.id)
  and not exists (select 1 from public.tangent_clusters c where c.lead_article_id = a.id and c.updated_at > now() - interval '60 days');
revoke all on public.tangent_expired_articles from public, anon, authenticated;
