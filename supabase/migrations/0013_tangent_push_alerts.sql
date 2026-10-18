-- Push notifications and alerts. Devices subscribe with Web Push; the fetcher matches new stories against
-- each user's alerts after every run (locally, no AI) and sends the pushes. VAPID keys live in tangent_config
-- (no API policies), read only by the fetcher's service key; the public half is also in the app.
-- Removals are soft (removed_at / disabled_at), like the rest of the account data.

create table public.tangent_push_subs (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references public.tangent_users(id) on delete cascade,
  endpoint    text not null unique,
  p256dh      text not null,
  auth        text not null,
  user_agent  text,
  tz          text,
  created_at  timestamptz not null default now(),
  last_ok_at  timestamptz,
  failed_at   timestamptz,
  disabled_at timestamptz
);
create index tangent_push_subs_user_idx on public.tangent_push_subs (user_id) where disabled_at is null;

-- kind: big (stories many outlets are covering, on your shelves), keyword (a phrase in a headline or teaser),
-- shelf (new stories on one of your shelves), source (new stories from one source).
create table public.tangent_alerts (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references public.tangent_users(id) on delete cascade,
  kind       text not null check (kind in ('big', 'keyword', 'shelf', 'source')),
  phrase     text,
  shelf_id   bigint references public.tangent_shelves(id) on delete cascade,
  source_id  bigint references public.tangent_sources(id) on delete cascade,
  enabled    boolean not null default true,
  created_at timestamptz not null default now(),
  removed_at timestamptz
);
create index tangent_alerts_user_idx on public.tangent_alerts (user_id) where removed_at is null;

-- One row per notification sent: stops repeats and is the log the admin dashboard reads.
create table public.tangent_alert_sent (
  user_id  uuid not null references public.tangent_users(id) on delete cascade,
  key      text not null,
  alert_id bigint references public.tangent_alerts(id) on delete set null,
  kind     text not null,
  title    text,
  url      text,
  devices  int not null default 0,
  sent_at  timestamptz not null default now(),
  primary key (user_id, key)
);
create index tangent_alert_sent_at_idx on public.tangent_alert_sent (sent_at desc);

alter table public.tangent_push_subs enable row level security;
alter table public.tangent_alerts enable row level security;
alter table public.tangent_alert_sent enable row level security;

create or replace function public.tangent_alerts_get(p_secret text, p_user uuid)
returns jsonb language plpgsql security definer stable set search_path = '' as $$
begin
  perform public.tangent_require(p_secret);
  return jsonb_build_object(
    'alerts', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'kind', a.kind, 'phrase', a.phrase, 'shelf', a.shelf_id,
        'source', a.source_id, 'source_name', s.name, 'enabled', a.enabled) order by a.id)
      from public.tangent_alerts a left join public.tangent_sources s on s.id = a.source_id
      where a.user_id = p_user and a.removed_at is null), '[]'::jsonb),
    'devices', (select count(*) from public.tangent_push_subs where user_id = p_user and disabled_at is null),
    'recent', coalesce((select jsonb_agg(jsonb_build_object('kind', r.kind, 'title', r.title, 'url', r.url, 'at', r.sent_at) order by r.sent_at desc)
      from (select * from public.tangent_alert_sent where user_id = p_user order by sent_at desc limit 10) r), '[]'::jsonb));
end $$;

-- p_alert: {id?, kind, phrase?, shelf?, source?, enabled?}. Returns the alert id.
create or replace function public.tangent_alert_save(p_secret text, p_user uuid, p_alert jsonb)
returns bigint language plpgsql security definer set search_path = '' as $$
declare aid bigint := (p_alert->>'id')::bigint; k text := p_alert->>'kind';
begin
  perform public.tangent_require(p_secret);
  if aid is not null then
    update public.tangent_alerts set enabled = coalesce((p_alert->>'enabled')::boolean, enabled)
    where id = aid and user_id = p_user and removed_at is null;
    return aid;
  end if;
  if (select count(*) from public.tangent_alerts where user_id = p_user and removed_at is null) >= 50 then raise exception 'too_many_alerts'; end if;
  if k = 'shelf' and not exists (select 1 from public.tangent_shelves where id = (p_alert->>'shelf')::bigint and user_id = p_user and removed_at is null) then raise exception 'not_found'; end if;
  if k = 'source' and not exists (select 1 from public.tangent_sources where id = (p_alert->>'source')::bigint) then raise exception 'not_found'; end if;
  -- One alert per shelf, source, phrase or "big": saving again just turns it back on.
  select id into aid from public.tangent_alerts
  where user_id = p_user and removed_at is null and kind = k
    and phrase is not distinct from nullif(lower(trim(p_alert->>'phrase')), '')
    and shelf_id is not distinct from (p_alert->>'shelf')::bigint
    and source_id is not distinct from (p_alert->>'source')::bigint;
  if aid is not null then
    update public.tangent_alerts set enabled = true where id = aid;
    return aid;
  end if;
  insert into public.tangent_alerts (user_id, kind, phrase, shelf_id, source_id)
  values (p_user, k, nullif(lower(trim(p_alert->>'phrase')), ''), (p_alert->>'shelf')::bigint, (p_alert->>'source')::bigint)
  returning id into aid;
  return aid;
end $$;

create or replace function public.tangent_alert_remove(p_secret text, p_user uuid, p_id bigint)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.tangent_require(p_secret);
  update public.tangent_alerts set removed_at = now() where id = p_id and user_id = p_user and removed_at is null;
end $$;

-- A device turns on notifications. The first device also turns on big-story alerts.
create or replace function public.tangent_push_subscribe(p_secret text, p_user uuid, p_endpoint text, p_p256dh text, p_auth text, p_ua text, p_tz text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.tangent_require(p_secret);
  insert into public.tangent_push_subs (user_id, endpoint, p256dh, auth, user_agent, tz)
  values (p_user, p_endpoint, p_p256dh, p_auth, left(p_ua, 300), left(p_tz, 60))
  on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
    user_agent = excluded.user_agent, tz = excluded.tz, disabled_at = null, failed_at = null;
  if not exists (select 1 from public.tangent_alerts where user_id = p_user and kind = 'big') then
    insert into public.tangent_alerts (user_id, kind) values (p_user, 'big');
  end if;
end $$;

create or replace function public.tangent_push_unsubscribe(p_secret text, p_user uuid, p_endpoint text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.tangent_require(p_secret);
  update public.tangent_push_subs set disabled_at = now() where endpoint = p_endpoint and user_id = p_user and disabled_at is null;
end $$;

-- Closing an account also stops its devices.
create or replace function public.tangent_close_account(p_secret text, p_user uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.tangent_require(p_secret);
  update public.tangent_sessions set revoked_at = now() where user_id = p_user and revoked_at is null;
  update public.tangent_shelves set removed_at = now() where user_id = p_user and removed_at is null;
  update public.tangent_push_subs set disabled_at = now() where user_id = p_user and disabled_at is null;
  update public.tangent_alerts set removed_at = now() where user_id = p_user and removed_at is null;
  update public.tangent_users set email = 'deleted+' || id || '@invalid', name = '', password_hash = null, google_sub = null,
    settings = '{}', is_admin = false, deleted_at = now() where id = p_user;
end $$;

revoke execute on function public.tangent_alerts_get(text,uuid) from public; grant execute on function public.tangent_alerts_get(text,uuid) to anon;
revoke execute on function public.tangent_alert_save(text,uuid,jsonb) from public; grant execute on function public.tangent_alert_save(text,uuid,jsonb) to anon;
revoke execute on function public.tangent_alert_remove(text,uuid,bigint) from public; grant execute on function public.tangent_alert_remove(text,uuid,bigint) to anon;
revoke execute on function public.tangent_push_subscribe(text,uuid,text,text,text,text,text) from public; grant execute on function public.tangent_push_subscribe(text,uuid,text,text,text,text,text) to anon;
revoke execute on function public.tangent_push_unsubscribe(text,uuid,text) from public; grant execute on function public.tangent_push_unsubscribe(text,uuid,text) to anon;
