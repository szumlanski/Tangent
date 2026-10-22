-- Engine for readers without an account: the starter topic tabs ranked like a shelf (meaning and
-- keyword recall, relevance x quality x freshness x story size x engagement, one card per story, a
-- per-source damper), with no persona. Shared by every guest, so the API caches it at the edge.
insert into public.tangent_interests (key, kind, label, window_days, min_sim)
select 't:' || slug, 'topic', name, 3, 0.30 from public.tangent_topics where listed
on conflict (key) do nothing;

create or replace function public.tangent_topic_rank(p_secret text, p_topic text, p_offset int, p_limit int)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  it public.tangent_interests;
  tsq tsquery;
  since timestamptz;
  out jsonb;
begin
  perform public.tangent_require(p_secret);
  select * into it from public.tangent_interests where key = 't:' || p_topic;
  if it.id is null or it.vec is null then return '[]'; end if;
  since := now() - make_interval(days => it.window_days);
  perform set_config('hnsw.ef_search', '400', true);
  perform set_config('hnsw.iterative_scan', 'relaxed_order', true);

  with ann as (
    select a.id from public.tangent_articles a
    where it.vec is not null and a.emb is not null and a.published_at > since and not a.paywalled and not a.offtopic
    order by a.emb operator(extensions.<=>) it.vec limit 600
  ), kw as (
    select a.id from public.tangent_articles a
    where tsq is not null and a.fts @@ tsq and a.published_at > since and not a.paywalled and not a.offtopic
    order by a.published_at desc limit 400
  ), cand as (select id from ann union select id from kw),
  scored as (
    select f.*, a.quality, a.flags, a.emb, a.topics, a.engagement,
      coalesce(1 - (a.emb operator(extensions.<=>) it.vec), 0)::real as sim,
      (tsq is not null and a.fts @@ tsq) as kwhit,
      false as pinned
    from cand
    join public.tangent_articles a on a.id = cand.id
    join public.tangent_feed f on f.id = cand.id
  ), rel as (
    select s.*, (s.sim + case when s.kwhit then 0.15 else 0 end + case when s.pinned then 0.05 else 0 end) as relevance
    from scored s
  ), ok as (
    select r.*,
      sqrt(greatest(r.relevance - it.min_sim + 0.05, 0))
      * coalesce(r.quality, 1)
      * exp(-ln(2) * extract(epoch from now() - r.published_at) / 3600 / case when r.kind in ('youtube', 'blog', 'podcast') then 72 else 24 end)
      * (1 + 0.2 * ln(greatest(coalesce(r.story_size, 1), 1)))
      -- audience: YouTube views or Hacker News points (discovery feeds), a modest lift
      * (1 + 0.06 * ln(1 + coalesce(r.engagement, 0)::real / case when r.kind = 'youtube' then 1000 else 10 end))
      -- hyper-local items (school sports, town boards, obituaries) rank low unless the shelf names them;
      -- regional shelves follow their own sources and never get here
      * case when not r.kwhit and (r.topics && array['hs-sports', 'local-gov', 'obituaries', 'arts-events'] or r.title ~* '\mhigh school\M')
          then 0.35 else 1 end
      as score0
    from rel r
    where r.relevance >= it.min_sim
      -- on a phrase shelf, a story that never names the phrase must be clearly about it
      and (r.kwhit or it.kind <> 'phrase' or r.sim >= it.min_sim + 0.12)
      -- a phrase shelf without a vector yet relies on keyword hits only
      and (it.vec is not null or r.kwhit)
  ), top as (
    select o.* from ok o order by o.score0 desc limit 400
  ), one as (
    -- one card per story: the same cluster, or near-identical meaning (the same news from several outlets)
    select t.*, (select count(*) from top u where u.id <> t.id and (u.cluster_id = t.cluster_id
        or (u.emb is not null and t.emb is not null and (u.emb operator(extensions.<=>) t.emb) < 0.2))) + 1 as dupes
    from top t
    where not exists (select 1 from top u where (u.score0 > t.score0 or (u.score0 = t.score0 and u.id < t.id))
      and (u.cluster_id = t.cluster_id or (u.emb is not null and t.emb is not null and (u.emb operator(extensions.<=>) t.emb) < 0.2)))
  ), div as (
    select o.*, o.score0 * power(0.85, row_number() over (partition by o.source_id order by o.score0 desc) - 1) as score
    from one o
  ), page as (
    select d.* from div d order by d.score desc offset greatest(coalesce(p_offset, 0), 0) limit least(greatest(coalesce(p_limit, 40), 1), 100)
  )
  select coalesce(jsonb_agg(
    (to_jsonb(p) - array['quality', 'flags', 'emb', 'topics', 'engagement', 'sim', 'kwhit', 'pinned', 'relevance', 'score0', 'dupes'])
    || jsonb_build_object('score', round(p.score::numeric, 4), 'why',
      concat_ws(' · ',
        case when p.kwhit then 'Mentions ' || it.label else 'About ' || it.label end,
        case when greatest(coalesce(p.story_size, 1), p.dupes) > 2 then greatest(coalesce(p.story_size, 1), p.dupes) || ' outlets' end,
        null))
    order by p.score desc), '[]') into out
  from page p;
  return out;
end $$;
revoke execute on function public.tangent_topic_rank(text, text, int, int) from public;
grant execute on function public.tangent_topic_rank(text, text, int, int) to anon;
