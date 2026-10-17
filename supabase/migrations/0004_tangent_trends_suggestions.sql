-- Local trends (Google Trends Florida, local Reddit) and the source scout's suggestions.

create table public.tangent_trends (
  id         bigint generated always as identity primary key,
  source     text not null,              -- 'gtrends' | 'reddit'
  channel    text not null,              -- 'Florida' | 'r/fortmyers' ...
  title      text not null,
  url        text not null,
  rank       int not null,
  traffic    text,
  image      text,
  news       jsonb,                       -- related news links for a search trend
  fetched_at timestamptz not null default now(),
  unique (source, channel, url)
);
create index tangent_trends_fetched_idx on public.tangent_trends (fetched_at desc);

create table public.tangent_source_suggestions (
  id          bigint generated always as identity primary key,
  domain      text not null unique,
  name        text not null,
  topic       text not null,
  kind        text not null default 'news',
  site_url    text not null,
  feed_url    text,
  strategies  text[] not null,
  samples     jsonb not null default '[]',  -- [{title,url}]
  free_ratio  real,
  per_week    real,
  reason      text,
  status      text not null default 'pending' check (status in ('pending','added','dismissed')),
  created_at  timestamptz not null default now(),
  reviewed_at timestamptz
);

-- One owner key, stored hashed. The app keeps the key on the device.
create table public.tangent_config (
  k text primary key,
  v text not null
);

alter table public.tangent_trends enable row level security;
alter table public.tangent_source_suggestions enable row level security;
alter table public.tangent_config enable row level security;
create policy tangent_trends_read on public.tangent_trends for select to anon, authenticated using (true);
create policy tangent_suggestions_read on public.tangent_source_suggestions for select to anon, authenticated using (status = 'pending');
-- tangent_config has no policies: unreadable from the API.

-- Approve (adds the source) or dismiss a suggestion. Requires the owner key.
create or replace function public.tangent_review_suggestion(p_id bigint, p_action text, p_key text)
returns text
language plpgsql security definer
set search_path = ''
as $$
declare s public.tangent_source_suggestions;
begin
  if encode(extensions.digest(p_key, 'sha256'), 'hex') is distinct from (select v from public.tangent_config where k = 'owner_key_sha256') then
    raise exception 'bad key';
  end if;
  select * into s from public.tangent_source_suggestions where id = p_id and status = 'pending';
  if not found then return 'gone'; end if;
  if p_action = 'add' then
    insert into public.tangent_sources (name, kind, topic, site_url, feed_url, strategies)
    values (s.name, s.kind, s.topic, s.site_url, s.feed_url, s.strategies)
    on conflict do nothing;
    update public.tangent_source_suggestions set status = 'added', reviewed_at = now() where id = p_id;
  elsif p_action = 'dismiss' then
    update public.tangent_source_suggestions set status = 'dismissed', reviewed_at = now() where id = p_id;
  else
    raise exception 'bad action';
  end if;
  return p_action;
end $$;
revoke execute on function public.tangent_review_suggestion(bigint, text, text) from public;
grant execute on function public.tangent_review_suggestion(bigint, text, text) to anon, authenticated;

-- Lets the app check a key before saving it.
create or replace function public.tangent_check_key(p_key text)
returns boolean
language sql security definer stable
set search_path = ''
as $$
  select encode(extensions.digest(p_key, 'sha256'), 'hex') = (select v from public.tangent_config where k = 'owner_key_sha256');
$$;
revoke execute on function public.tangent_check_key(text) from public;
grant execute on function public.tangent_check_key(text) to anon, authenticated;
