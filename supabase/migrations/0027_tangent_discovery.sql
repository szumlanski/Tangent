-- Engine phase 3: discovery. Every phrase interest someone follows gets its own discovery feeds:
-- YouTube search (most viewed this week) and Hacker News. (Reddit refuses keyless requests; its
-- strategy exists for when an API account is added.) They belong to no shelf; the
-- ranking finds their items by meaning and keyword. View and point counts land in `engagement`.
alter table public.tangent_articles add column if not exists engagement int;

create or replace function public.tangent_ensure_discovery()
returns int language plpgsql security definer set search_path = '' as $$
declare n int := 0; r record; p record;
begin
  for r in select i.* from public.tangent_interests i
    where i.kind = 'phrase' and i.terms is not null
      and exists (select 1 from public.tangent_shelves s where s.interest_id = i.id and s.removed_at is null)
  loop
    for p in select * from (values ('yt', 'youtube', 'ytsearch', 'YouTube'), ('hn', 'news', 'hnsearch', 'Hacker News')) v(code, kind, strat, label)
    loop
      insert into public.tangent_sources (name, kind, topic, site_url, query, strategies, enabled, status, access)
      select r.label || ' · ' || p.label, p.kind, 'custom', 'disc:' || p.code || ':' || r.terms, r.terms, array[p.strat], true, 'active', 'free'
      where not exists (select 1 from public.tangent_sources x where x.site_url = 'disc:' || p.code || ':' || r.terms);
      if found then n := n + 1; end if;
    end loop;
  end loop;
  return n;
end $$;
revoke execute on function public.tangent_ensure_discovery() from public, anon, authenticated;
grant execute on function public.tangent_ensure_discovery() to service_role;
