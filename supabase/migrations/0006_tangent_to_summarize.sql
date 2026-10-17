-- Stories that gained outlets (or are new) since their last summary. Fetcher only.
create or replace function public.tangent_clusters_to_summarize(lim int)
returns setof public.tangent_clusters
language sql stable
set search_path = ''
as $$
  select * from public.tangent_clusters
  where summarized_count < article_count
  order by updated_at desc
  limit lim;
$$;
revoke execute on function public.tangent_clusters_to_summarize(int) from public, anon, authenticated;
grant execute on function public.tangent_clusters_to_summarize(int) to service_role;
