-- Engine phase 6: measure shelf quality daily and act on it.
-- The fetcher samples each interest's top 20 stories (through the real ranking), has Claude Haiku
-- rate how well each fits, and stores the result here; the admin dashboard shows it. Thin phrase
-- interests get a longer look-back window automatically.

-- The service role (the fetcher) may call secret-guarded functions; it already has full access.
create or replace function public.tangent_require(p_secret text)
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if coalesce(current_setting('request.jwt.claims', true), '') <> ''
     and (current_setting('request.jwt.claims', true)::jsonb ->> 'role') = 'service_role' then return; end if;
  if not public.tangent_server_ok(p_secret) then raise exception 'forbidden'; end if;
end $$;

create table if not exists public.tangent_quality (
  id bigint generated always as identity primary key,
  interest_id bigint not null references public.tangent_interests(id) on delete cascade,
  at timestamptz not null default now(),
  available int not null,          -- ranked stories the shelf can show
  sampled int not null,
  good int not null,
  partial int not null,
  bad int not null,
  precision real not null,         -- (good + partial / 2) / sampled
  bad_examples jsonb,              -- titles judged off topic
  tokens int
);
alter table public.tangent_quality enable row level security;
create index if not exists tangent_quality_interest_at on public.tangent_quality (interest_id, at desc);

-- One live shelf per interest to sample through (any owner; ranking is per shelf).
create or replace function public.tangent_quality_targets()
returns table (interest_id bigint, kind text, label text, key text, shelf_id bigint, user_id uuid)
language sql security definer set search_path = '' as $$
  select distinct on (i.id) i.id, i.kind, i.label, i.key, s.id, s.user_id
  from public.tangent_interests i
  join public.tangent_shelves s on s.interest_id = i.id and s.removed_at is null and s.mode = 'interest'
  join public.tangent_users u on u.id = s.user_id and u.deleted_at is null
  order by i.id, s.created_at;
$$;

create or replace function public.tangent_quality_save(p_row jsonb)
returns void language sql security definer set search_path = '' as $$
  insert into public.tangent_quality (interest_id, available, sampled, good, partial, bad, precision, bad_examples, tokens)
  values ((p_row->>'interest_id')::bigint, (p_row->>'available')::int, (p_row->>'sampled')::int, (p_row->>'good')::int,
    (p_row->>'partial')::int, (p_row->>'bad')::int, (p_row->>'precision')::real, p_row->'bad_examples', (p_row->>'tokens')::int);
$$;

-- A thin phrase interest looks further back (up to 30 days).
create or replace function public.tangent_interest_widen(p_id bigint)
returns int language sql security definer set search_path = '' as $$
  update public.tangent_interests set window_days = least(window_days * 2, 30) where id = p_id and kind = 'phrase' returning window_days;
$$;

revoke execute on function public.tangent_quality_targets() from public, anon, authenticated;
revoke execute on function public.tangent_quality_save(jsonb) from public, anon, authenticated;
revoke execute on function public.tangent_interest_widen(bigint) from public, anon, authenticated;
grant execute on function public.tangent_quality_targets() to service_role;
grant execute on function public.tangent_quality_save(jsonb) to service_role;
grant execute on function public.tangent_interest_widen(bigint) to service_role;

-- Admin dashboard: latest check per interest, with how many shelves follow it.
create or replace function public.tangent_admin_quality(p_secret text, p_admin uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.tangent_require_admin(p_secret, p_admin);
  return coalesce((select jsonb_agg(x order by x.precision nulls first) from (
    select i.id, i.label, i.kind, i.window_days,
      (select count(*) from public.tangent_shelves s where s.interest_id = i.id and s.removed_at is null) as shelves,
      q.at, q.available, q.sampled, q.good, q.partial, q.bad, q.precision, q.bad_examples
    from public.tangent_interests i
    left join lateral (select * from public.tangent_quality q where q.interest_id = i.id order by q.at desc limit 1) q on true
    where exists (select 1 from public.tangent_shelves s where s.interest_id = i.id and s.removed_at is null)) x), '[]');
end $$;
revoke execute on function public.tangent_admin_quality(text, uuid) from public;
grant execute on function public.tangent_admin_quality(text, uuid) to anon;
