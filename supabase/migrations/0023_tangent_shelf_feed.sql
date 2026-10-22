-- Shelf feeds are built on the server. The app used to load the newest 160 items from a shelf's
-- sources and filter on the phone, so a phrase shelf with busy general outlets ("Claude tips" with
-- CBS and AOL) kept only a handful. This returns the shelf's own page, newest first, with the
-- phrase filter applied: news and video must name every non-filler word of the phrase as a whole
-- word (search results too, since news search also returns near misses); blogs added to the
-- shelf count as on topic.
create index if not exists tangent_articles_source_published on public.tangent_articles (source_id, published_at desc);

create or replace function public.tangent_shelf_feed(p_secret text, p_user uuid, p_shelf bigint, p_before timestamptz, p_limit int)
returns setof public.tangent_feed language plpgsql stable security definer set search_path = '' as $$
declare
  sh public.tangent_shelves;
  filler text[] := array['tips','tip','news','latest','update','updates','guide','guides','how','to','best','top','new','the',
    'a','an','and','of','for','on','in','about','tricks'];
  all_words text[];
  words text[];
  pats text[];
begin
  perform public.tangent_require(p_secret);
  select * into sh from public.tangent_shelves where id = p_shelf and user_id = p_user and removed_at is null;
  if not found then raise exception 'not_found'; end if;
  if sh.query is not null then
    select array_agg(w) into all_words from unnest(regexp_split_to_array(lower(sh.query), '[^[:alnum:]+#.-]+')) w where w <> '';
    select array_agg(w) into words from unnest(all_words) w where not (w = any(filler));
    select array_agg('(^|[^[:alnum:]])' || regexp_replace(w, '([.+*?^$(){}|\[\]\\-])', '\\\1', 'g') || '($|[^[:alnum:]])')
      into pats from unnest(coalesce(words, all_words)) w;
  end if;
  return query
    select f.* from public.tangent_feed f
    join public.tangent_shelf_sources ss on ss.source_id = f.source_id and ss.shelf_id = sh.id and ss.removed_at is null
    where f.published_at < coalesce(p_before, now() + interval '1 day')
      and f.published_at > now() - interval '30 days'
      and (pats is null or f.kind = 'blog'
        or (select bool_and(concat_ws(' ', f.story_headline, f.title, f.excerpt) ~* p) from unnest(pats) p))
    order by f.published_at desc
    limit least(greatest(coalesce(p_limit, 60), 1), 100);
end $$;

revoke execute on function public.tangent_shelf_feed(text, uuid, bigint, timestamptz, int) from public;
grant execute on function public.tangent_shelf_feed(text, uuid, bigint, timestamptz, int) to anon;
