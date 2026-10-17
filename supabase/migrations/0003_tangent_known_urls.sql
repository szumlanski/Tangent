-- Which URLs (article or Google News wrapper) are already stored. Fetcher only.
create or replace function public.tangent_known_urls(urls text[])
returns setof text
language sql stable
set search_path = ''
as $$
  select a.url from public.tangent_articles a where a.url = any(urls) or a.origin_url = any(urls)
  union
  select a.origin_url from public.tangent_articles a where a.origin_url = any(urls);
$$;
revoke execute on function public.tangent_known_urls(text[]) from public, anon, authenticated;
grant execute on function public.tangent_known_urls(text[]) to service_role;
