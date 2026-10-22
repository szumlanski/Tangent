-- Engine phase 4: tangent_shelf_rank learns from the reader. Same as 0026 plus:
--   taste (persona likes vs dislikes and hides, by meaning), hidden stories and muted sources left out
--   on the server, and "not about this shelf" removing the story and its look-alikes from that shelf.
create or replace function public.tangent_shelf_rank(p_secret text, p_user uuid, p_shelf bigint, p_offset int, p_limit int)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  sh public.tangent_shelves;
  it public.tangent_interests;
  tsq tsquery;
  since timestamptz;
  out jsonb;
  liked extensions.halfvec(384);
  disliked extensions.halfvec(384);
  nl int;
  nd int;
begin
  perform public.tangent_require(p_secret);
  select * into sh from public.tangent_shelves where id = p_shelf and user_id = p_user and removed_at is null;
  if not found then raise exception 'not_found'; end if;
  select * into it from public.tangent_interests where id = sh.interest_id;
  if sh.mode = 'follow' or it.id is null or (it.vec is null and it.terms is null) then
    select coalesce(jsonb_agg(to_jsonb(f)), '[]') into out
    from public.tangent_shelf_feed(p_secret, p_user, p_shelf, null, least(coalesce(p_limit, 40) + coalesce(p_offset, 0), 100)) f;
    return out;
  end if;
  if it.terms is not null then tsq := plainto_tsquery('english', it.terms); end if;
  since := now() - make_interval(days => it.window_days);
  -- Taste: the average meaning of what this persona liked, and of what it voted down or hid
  -- (latest 200 each; needs at least 3 to count).
  select extensions.avg(x.emb::extensions.vector)::extensions.halfvec(384), count(*) into liked, nl from (
    select a.emb from public.tangent_persona_feedback f join public.tangent_articles a on a.id = f.article_id
    where f.persona_id = sh.persona_id and f.vote = 1 and a.emb is not null order by f.at desc limit 200) x;
  select extensions.avg(x.emb::extensions.vector)::extensions.halfvec(384), count(*) into disliked, nd from (
    select a.emb from public.tangent_persona_feedback f join public.tangent_articles a on a.id = f.article_id
    where f.persona_id = sh.persona_id and (f.vote = -1 or f.hidden) and a.emb is not null order by f.at desc limit 200) x;
  if nl < 3 then liked := null; end if;
  if nd < 3 then disliked := null; end if;
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
  ), pin as (
    select a.id from public.tangent_articles a
    join public.tangent_shelf_sources ss on ss.source_id = a.source_id and ss.shelf_id = sh.id and ss.removed_at is null
    where a.published_at > since and not a.paywalled and not a.offtopic
    order by a.published_at desc limit 400
  ), rej as (
    select r.article_id, a.emb from public.tangent_shelf_rejects r join public.tangent_articles a on a.id = r.article_id
    where r.shelf_id = sh.id and r.undone_at is null
  ), cand as (select id from ann union select id from kw union select id from pin),
  scored as (
    select f.*, a.quality, a.flags, a.emb, a.topics, a.engagement,
      coalesce(1 - (a.emb operator(extensions.<=>) it.vec), 0)::real as sim,
      (tsq is not null and a.fts @@ tsq) as kwhit,
      exists (select 1 from pin where pin.id = a.id) as pinned
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
      -- taste: toward stories like the ones liked, away from ones voted down or hidden
      * exp(1.2 * (coalesce(case when liked is not null and r.emb is not null then 1 - (r.emb operator(extensions.<=>) liked) end, 0)
                 - coalesce(case when disliked is not null and r.emb is not null then 1 - (r.emb operator(extensions.<=>) disliked) end, 0))) as score0
    from rel r
    where r.relevance >= it.min_sim
      -- on a phrase shelf, a story that never names the phrase must be clearly about it
      and (r.kwhit or it.kind <> 'phrase' or r.sim >= it.min_sim + 0.12)
      -- a phrase shelf without a vector yet relies on keyword hits only
      and (it.vec is not null or r.kwhit)
      -- the reader's own controls: hidden stories, muted sources, and "not about this shelf" (plus look-alikes)
      and not exists (select 1 from public.tangent_persona_feedback h where h.persona_id = sh.persona_id and h.article_id = r.id and h.hidden)
      and not exists (select 1 from public.tangent_persona_mutes m where m.persona_id = sh.persona_id and m.source_id = r.source_id and m.undone_at is null)
      and not exists (select 1 from rej where rej.article_id = r.id
        or (rej.emb is not null and r.emb is not null and (rej.emb operator(extensions.<=>) r.emb) < 0.25))
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
        case when p.pinned then 'a source on this shelf' end))
    order by p.score desc), '[]') into out
  from page p;
  return out;
end $$;
revoke execute on function public.tangent_shelf_rank(text, uuid, bigint, int, int) from public;
grant execute on function public.tangent_shelf_rank(text, uuid, bigint, int, int) to anon;
