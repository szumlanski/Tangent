-- Admin dashboard and the event log behind it. Additive only.
-- tangent_events_log: one row per notable event (sign-ups, sign-ins and failures with IP and browser,
-- account changes, shelf and source changes, rate limits, server errors, shares, fetch runs).
-- Kept 180 days (trimmed by the fetcher). Only server-secret functions read or write it.

alter table public.tangent_users add column if not exists disabled_at timestamptz;

create table public.tangent_events_log (
  id      bigint generated always as identity primary key,
  at      timestamptz not null default now(),
  kind    text not null,
  user_id uuid references public.tangent_users(id) on delete set null,
  ip      text,
  ua      text,
  detail  jsonb not null default '{}'
);
create index tangent_events_log_at_idx on public.tangent_events_log (at desc);
create index tangent_events_log_kind_idx on public.tangent_events_log (kind, at desc);
create index tangent_events_log_user_idx on public.tangent_events_log (user_id, at desc);
alter table public.tangent_events_log enable row level security;

create or replace function public.tangent_log(p_secret text, p_kind text, p_user uuid, p_ip text, p_ua text, p_detail jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.tangent_require(p_secret);
  insert into public.tangent_events_log (kind, user_id, ip, ua, detail)
  values (left(p_kind, 40), p_user, left(p_ip, 64), left(p_ua, 300), coalesce(p_detail, '{}'));
end $$;

-- Disabled or closed accounts lose their sessions at the next request.
create or replace function public.tangent_session_user(p_secret text, p_sid uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.tangent_sessions; u public.tangent_users;
begin
  perform public.tangent_require(p_secret);
  select * into s from public.tangent_sessions where id = p_sid and expires_at > now() and revoked_at is null;
  if not found then return null; end if;
  select * into u from public.tangent_users where id = s.user_id;
  if u.disabled_at is not null or u.deleted_at is not null then return null; end if;
  if s.last_used_at < now() - interval '1 hour' then
    update public.tangent_sessions set last_used_at = now(), expires_at = now() + interval '90 days' where id = p_sid;
    update public.tangent_users set last_seen_at = now() where id = u.id;
  end if;
  return public.tangent_user_json(u);
end $$;

create or replace function public.tangent_require_admin(p_secret text, p_admin uuid)
returns void language plpgsql security definer stable set search_path = '' as $$
begin
  perform public.tangent_require(p_secret);
  if not exists (select 1 from public.tangent_users where id = p_admin and is_admin and deleted_at is null and disabled_at is null) then
    raise exception 'forbidden';
  end if;
end $$;
revoke execute on function public.tangent_require_admin(text,uuid) from public, anon, authenticated;

create or replace function public.tangent_admin_overview(p_secret text, p_admin uuid)
returns jsonb language plpgsql security definer stable set search_path = '' as $$
begin
  perform public.tangent_require_admin(p_secret, p_admin);
  return jsonb_build_object(
    'users', jsonb_build_object(
      'total', (select count(*) from public.tangent_users where deleted_at is null),
      'disabled', (select count(*) from public.tangent_users where deleted_at is null and disabled_at is not null),
      'closed', (select count(*) from public.tangent_users where deleted_at is not null),
      'google', (select count(*) from public.tangent_users where deleted_at is null and google_sub is not null),
      'new_1d', (select count(*) from public.tangent_users where deleted_at is null and created_at > now() - interval '1 day'),
      'new_7d', (select count(*) from public.tangent_users where deleted_at is null and created_at > now() - interval '7 days'),
      'new_30d', (select count(*) from public.tangent_users where deleted_at is null and created_at > now() - interval '30 days'),
      'active_1d', (select count(distinct s.user_id) from public.tangent_sessions s join public.tangent_users u on u.id = s.user_id where u.deleted_at is null and s.last_used_at > now() - interval '1 day'),
      'active_7d', (select count(distinct s.user_id) from public.tangent_sessions s join public.tangent_users u on u.id = s.user_id where u.deleted_at is null and s.last_used_at > now() - interval '7 days'),
      'active_30d', (select count(distinct s.user_id) from public.tangent_sessions s join public.tangent_users u on u.id = s.user_id where u.deleted_at is null and s.last_used_at > now() - interval '30 days')),
    'signups', (select coalesce(jsonb_agg(jsonb_build_object('day', d::date, 'n', (select count(*) from public.tangent_users u where u.deleted_at is null and u.created_at::date = d::date)) order by d), '[]')
                from generate_series(current_date - 29, current_date, interval '1 day') d),
    'active', (select coalesce(jsonb_agg(jsonb_build_object('day', d::date, 'n', (select count(distinct l.user_id) from public.tangent_events_log l join public.tangent_users u on u.id = l.user_id where u.deleted_at is null and l.at::date = d::date)) order by d), '[]')
                from generate_series(current_date - 29, current_date, interval '1 day') d),
    'usage', jsonb_build_object(
      'personas', (select count(*) from public.tangent_personas where removed_at is null),
      'shelves', (select count(*) from public.tangent_shelves where removed_at is null),
      'votes', (select count(*) from public.tangent_persona_feedback where vote <> 0),
      'hides', (select count(*) from public.tangent_persona_feedback where hidden),
      'alerts', (select count(*) from public.tangent_alerts where removed_at is null and enabled),
      'devices', (select count(*) from public.tangent_push_subs where disabled_at is null),
      'guest_devices', (select count(*) from public.tangent_guest_subs where disabled_at is null),
      'pushes_1d', (select count(*) from public.tangent_alert_sent where sent_at > now() - interval '1 day') + (select count(*) from public.tangent_guest_sent where sent_at > now() - interval '1 day'),
      'pushes_7d', (select count(*) from public.tangent_alert_sent where sent_at > now() - interval '7 days') + (select count(*) from public.tangent_guest_sent where sent_at > now() - interval '7 days'),
      'shares_7d', (select count(*) from public.tangent_events_log where kind = 'share_open' and at > now() - interval '7 days'),
      'logins_failed_1d', (select count(*) from public.tangent_events_log where kind = 'login_fail' and at > now() - interval '1 day'),
      'errors_1d', (select count(*) from public.tangent_events_log where kind = 'server_error' and at > now() - interval '1 day')),
    'content', jsonb_build_object(
      'sources_active', (select count(*) from public.tangent_sources where enabled and status = 'active'),
      'sources_pending', (select count(*) from public.tangent_sources where status = 'pending'),
      'sources_rejected', (select count(*) from public.tangent_sources where status = 'rejected'),
      'sources_failing', (select count(*) from public.tangent_sources where enabled and last_error is not null),
      'sources_disabled', (select count(*) from public.tangent_sources where not enabled and status = 'active'),
      'articles_1d', (select count(*) from public.tangent_articles where fetched_at > now() - interval '1 day'),
      'paywalled_1d', (select count(*) from public.tangent_articles where fetched_at > now() - interval '1 day' and paywalled),
      'stories_summarized_1d', (select count(*) from public.tangent_clusters where summarized_at > now() - interval '1 day'),
      'last_fetch', (select jsonb_build_object('at', at, 'detail', detail) from public.tangent_events_log where kind = 'fetch_run' order by at desc limit 1)));
end $$;

create or replace function public.tangent_admin_users(p_secret text, p_admin uuid, p_q text, p_limit int, p_offset int)
returns jsonb language plpgsql security definer stable set search_path = '' as $$
begin
  perform public.tangent_require_admin(p_secret, p_admin);
  return coalesce((select jsonb_agg(r) from (
    select u.id, u.email, u.name, u.is_admin, u.created_at, u.disabled_at,
      u.password_hash is not null as has_password, u.google_sub is not null as has_google,
      (select max(last_used_at) from public.tangent_sessions s where s.user_id = u.id) as last_seen,
      (select count(*) from public.tangent_sessions s where s.user_id = u.id and s.revoked_at is null and s.expires_at > now()) as sessions,
      (select count(*) from public.tangent_personas p where p.user_id = u.id and p.removed_at is null) as personas,
      (select count(*) from public.tangent_shelves sh where sh.user_id = u.id and sh.removed_at is null) as shelves,
      (select count(*) from public.tangent_sources so where so.added_by = u.id) as sources_added,
      (select count(*) from public.tangent_persona_feedback f join public.tangent_personas p on p.id = f.persona_id where p.user_id = u.id and f.vote <> 0) as votes,
      (select count(*) from public.tangent_push_subs d where d.user_id = u.id and d.disabled_at is null) as devices
    from public.tangent_users u
    where u.deleted_at is null and (coalesce(p_q, '') = '' or u.email ilike '%' || p_q || '%' or u.name ilike '%' || p_q || '%')
    order by u.created_at desc
    limit least(coalesce(p_limit, 50), 200) offset greatest(coalesce(p_offset, 0), 0)) r), '[]');
end $$;

create or replace function public.tangent_admin_log(p_secret text, p_admin uuid, p_kind text, p_q text, p_before bigint, p_limit int)
returns jsonb language plpgsql security definer stable set search_path = '' as $$
begin
  perform public.tangent_require_admin(p_secret, p_admin);
  return coalesce((select jsonb_agg(r) from (
    select l.id, l.at, l.kind, l.ip, l.ua, l.detail, u.email
    from public.tangent_events_log l left join public.tangent_users u on u.id = l.user_id
    where (coalesce(p_kind, '') = '' or l.kind = p_kind)
      and (p_before is null or l.id < p_before)
      and (coalesce(p_q, '') = '' or u.email ilike '%' || p_q || '%' or l.ip = p_q or l.detail::text ilike '%' || p_q || '%')
    order by l.id desc limit least(coalesce(p_limit, 100), 500)) r), '[]');
end $$;

create or replace function public.tangent_admin_sources(p_secret text, p_admin uuid)
returns jsonb language plpgsql security definer stable set search_path = '' as $$
begin
  perform public.tangent_require_admin(p_secret, p_admin);
  return coalesce((select jsonb_agg(r order by r.problem desc, r.topic, r.name) from (
    select s.id, s.name, s.kind, s.topic, s.site_url, s.enabled, s.status, s.status_note, s.disabled_reason, s.access,
      s.last_ok_at, s.last_run_at, s.last_strategy, s.last_count, s.last_error, s.items_seen, s.paywall_seen,
      (select email from public.tangent_users u where u.id = s.added_by) as added_by,
      (select count(distinct ss.shelf_id) from public.tangent_shelf_sources ss where ss.source_id = s.id and ss.removed_at is null) as shelves,
      (s.enabled and s.last_error is not null) as problem
    from public.tangent_sources s) r), '[]');
end $$;

-- p_action: disable, enable, signout (ends every session), admin, unadmin.
create or replace function public.tangent_admin_user_action(p_secret text, p_admin uuid, p_user uuid, p_action text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.tangent_require_admin(p_secret, p_admin);
  if p_user = p_admin and p_action in ('disable', 'unadmin') then raise exception 'not_yourself'; end if;
  if p_action = 'disable' then
    update public.tangent_users set disabled_at = now() where id = p_user;
    update public.tangent_sessions set revoked_at = now() where user_id = p_user and revoked_at is null;
  elsif p_action = 'enable' then update public.tangent_users set disabled_at = null where id = p_user;
  elsif p_action = 'signout' then update public.tangent_sessions set revoked_at = now() where user_id = p_user and revoked_at is null;
  elsif p_action = 'admin' then update public.tangent_users set is_admin = true where id = p_user;
  elsif p_action = 'unadmin' then update public.tangent_users set is_admin = false where id = p_user;
  else raise exception 'bad_action';
  end if;
end $$;

-- p_action: disable, enable, reject (removes it from the catalog for good, with the note).
create or replace function public.tangent_admin_source_action(p_secret text, p_admin uuid, p_source bigint, p_action text, p_note text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.tangent_require_admin(p_secret, p_admin);
  if p_action = 'disable' then update public.tangent_sources set enabled = false, disabled_reason = coalesce(nullif(p_note, ''), 'Turned off by admin') where id = p_source;
  elsif p_action = 'enable' then update public.tangent_sources set enabled = true, disabled_reason = null, status = 'active', last_error = null where id = p_source;
  elsif p_action = 'reject' then update public.tangent_sources set enabled = false, status = 'rejected', status_note = coalesce(nullif(p_note, ''), 'Removed by admin') where id = p_source;
  else raise exception 'bad_action';
  end if;
end $$;

-- Scout suggestions, approved by an admin account (replaces the owner-key link).
create or replace function public.tangent_admin_suggestion(p_secret text, p_admin uuid, p_id bigint, p_action text)
returns text language plpgsql security definer set search_path = '' as $$
declare s public.tangent_source_suggestions;
begin
  perform public.tangent_require_admin(p_secret, p_admin);
  select * into s from public.tangent_source_suggestions where id = p_id and status = 'pending';
  if not found then return 'gone'; end if;
  if p_action = 'add' then
    insert into public.tangent_sources (name, kind, topic, site_url, feed_url, strategies)
    values (s.name, s.kind, s.topic, s.site_url, s.feed_url, s.strategies) on conflict do nothing;
    update public.tangent_source_suggestions set status = 'added', reviewed_at = now() where id = p_id;
  elsif p_action = 'dismiss' then
    update public.tangent_source_suggestions set status = 'dismissed', reviewed_at = now() where id = p_id;
  else raise exception 'bad_action';
  end if;
  return p_action;
end $$;

revoke execute on function public.tangent_log(text,text,uuid,text,text,jsonb) from public; grant execute on function public.tangent_log(text,text,uuid,text,text,jsonb) to anon;
revoke execute on function public.tangent_admin_overview(text,uuid) from public; grant execute on function public.tangent_admin_overview(text,uuid) to anon;
revoke execute on function public.tangent_admin_users(text,uuid,text,int,int) from public; grant execute on function public.tangent_admin_users(text,uuid,text,int,int) to anon;
revoke execute on function public.tangent_admin_log(text,uuid,text,text,bigint,int) from public; grant execute on function public.tangent_admin_log(text,uuid,text,text,bigint,int) to anon;
revoke execute on function public.tangent_admin_sources(text,uuid) from public; grant execute on function public.tangent_admin_sources(text,uuid) to anon;
revoke execute on function public.tangent_admin_user_action(text,uuid,uuid,text) from public; grant execute on function public.tangent_admin_user_action(text,uuid,uuid,text) to anon;
revoke execute on function public.tangent_admin_source_action(text,uuid,bigint,text,text) from public; grant execute on function public.tangent_admin_source_action(text,uuid,bigint,text,text) to anon;
revoke execute on function public.tangent_admin_suggestion(text,uuid,bigint,text) from public; grant execute on function public.tangent_admin_suggestion(text,uuid,bigint,text) to anon;
