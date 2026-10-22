-- Engine phase 1: every article gets a meaning vector (all-MiniLM-L6-v2, computed in the fetcher,
-- free), topic labels, junk flags and a quality score. Vectors are kept 21 days (retention clears
-- them with the article text) to keep the table small.
alter table public.tangent_articles
  add column if not exists emb extensions.halfvec(384),
  add column if not exists topics text[],
  add column if not exists flags text[],
  add column if not exists quality real,
  add column if not exists enriched_at timestamptz;

create index if not exists tangent_articles_emb on public.tangent_articles using hnsw (emb extensions.halfvec_cosine_ops);
create index if not exists tangent_articles_unenriched on public.tangent_articles (fetched_at desc) where enriched_at is null;

-- The fetcher writes enrichment in bulk: [{id, emb: "[...]", topics, flags, quality}, ...].
create or replace function public.tangent_set_enrichment(p_rows jsonb)
returns int language sql security definer set search_path = '' as $$
  with r as (
    select (x->>'id')::bigint id, (x->>'emb')::extensions.halfvec(384) emb,
      array(select jsonb_array_elements_text(coalesce(x->'topics', '[]'))) topics,
      array(select jsonb_array_elements_text(coalesce(x->'flags', '[]'))) flags,
      (x->>'quality')::real quality
    from jsonb_array_elements(p_rows) x)
  , u as (update public.tangent_articles a set emb = r.emb, topics = r.topics, flags = r.flags, quality = r.quality, enriched_at = now()
    from r where a.id = r.id returning 1)
  select count(*)::int from u;
$$;
revoke execute on function public.tangent_set_enrichment(jsonb) from public, anon, authenticated;
grant execute on function public.tangent_set_enrichment(jsonb) to service_role;
