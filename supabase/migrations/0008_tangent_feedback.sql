-- Owner feedback: thumbs up/down and permanent hides. Single owner, so no user column.
-- Only reachable through the two key-checked functions below.
create table public.tangent_feedback (
  article_id bigint primary key references public.tangent_articles(id) on delete cascade,
  vote       smallint not null default 0 check (vote in (-1, 0, 1)),
  hidden     boolean not null default false,
  at         timestamptz not null default now()
);
alter table public.tangent_feedback enable row level security; -- no policies: API cannot read it directly

create or replace function public.tangent_key_ok(p_key text)
returns boolean language sql security definer stable set search_path = '' as $$
  select coalesce(encode(extensions.digest(p_key, 'sha256'), 'hex') = (select v from public.tangent_config where k = 'owner_key_sha256'), false);
$$;
revoke execute on function public.tangent_key_ok(text) from public, anon, authenticated;

-- Set a vote and/or hidden flag (null leaves that field as is). Hiding applies to the whole story.
create or replace function public.tangent_set_feedback(p_key text, p_article bigint, p_vote smallint, p_hidden boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.tangent_key_ok(p_key) then raise exception 'bad key'; end if;
  insert into public.tangent_feedback (article_id, vote, hidden)
  values (p_article, coalesce(p_vote, 0), coalesce(p_hidden, false))
  on conflict (article_id) do update set
    vote = coalesce(p_vote, public.tangent_feedback.vote),
    hidden = coalesce(p_hidden, public.tangent_feedback.hidden),
    at = now();
end $$;
revoke execute on function public.tangent_set_feedback(text, bigint, smallint, boolean) from public;
grant execute on function public.tangent_set_feedback(text, bigint, smallint, boolean) to anon, authenticated;

-- Everything the app needs to hide stories and learn: the article's story, source, topic, kind and headline.
create or replace function public.tangent_get_feedback(p_key text)
returns table (article_id bigint, cluster_id bigint, vote smallint, hidden boolean, source_id bigint, topic text, kind text, title text, at timestamptz)
language plpgsql security definer stable set search_path = '' as $$
begin
  if not public.tangent_key_ok(p_key) then raise exception 'bad key'; end if;
  return query
    select f.article_id, a.cluster_id, f.vote, f.hidden, a.source_id, s.topic, a.kind, a.title, f.at
    from public.tangent_feedback f
    join public.tangent_articles a on a.id = f.article_id
    join public.tangent_sources s on s.id = a.source_id
    where f.at > now() - interval '365 days'
    order by f.at desc;
end $$;
revoke execute on function public.tangent_get_feedback(text) from public;
grant execute on function public.tangent_get_feedback(text) to anon, authenticated;
