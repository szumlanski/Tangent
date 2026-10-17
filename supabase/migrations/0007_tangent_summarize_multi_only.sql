-- Summaries are only for stories several outlets covered: once at 2 outlets, again each time the count doubles.
create or replace function public.tangent_clusters_to_summarize(lim int)
returns setof public.tangent_clusters
language sql stable
set search_path = ''
as $$
  select * from public.tangent_clusters
  where article_count >= 2 and (summarized_count = 0 or article_count >= 2 * summarized_count)
  order by updated_at desc
  limit lim;
$$;
