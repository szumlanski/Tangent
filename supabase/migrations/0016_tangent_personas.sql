-- Personas: several reading profiles under one login (work and personal, or by interest). Each persona has
-- its own name, picture, shelves, votes, hides and alerts. Devices pick a persona; the API passes it as
-- p_persona and every function resolves it with tangent_persona_id (null or foreign falls back to the first).
-- Also: push for people without an account (big-story alerts), keyed by a device secret.
-- Additive only: the older function versions (without p_persona) stay in place but are no longer called,
-- votes per persona live in a new table, and guest devices get their own table.

create table public.tangent_personas (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references public.tangent_users(id) on delete cascade,
  name       text not null,
  avatar     text,               -- small picture as a data: URL (resized in the app, at most ~30 KB)
  emoji      text,
  color      text,
  position   int not null default 0,
  settings   jsonb not null default '{}',
  created_at timestamptz not null default now(),
  removed_at timestamptz
);
create index tangent_personas_user_idx on public.tangent_personas (user_id) where removed_at is null;
alter table public.tangent_personas enable row level security;

alter table public.tangent_shelves add column persona_id bigint references public.tangent_personas(id) on delete cascade;
alter table public.tangent_alerts add column persona_id bigint references public.tangent_personas(id) on delete cascade;

create table public.tangent_persona_feedback (
  persona_id bigint not null references public.tangent_personas(id) on delete cascade,
  article_id bigint not null references public.tangent_articles(id) on delete cascade,
  vote       smallint not null default 0,
  hidden     boolean not null default false,
  at         timestamptz not null default now(),
  primary key (persona_id, article_id)
);
alter table public.tangent_persona_feedback enable row level security;

-- Every open account gets its first persona, which takes over everything it already has.
insert into public.tangent_personas (user_id, name, position)
select id, coalesce(nullif(split_part(name, ' ', 1), ''), 'Me'), 0 from public.tangent_users where deleted_at is null;
update public.tangent_shelves s set persona_id = p.id from public.tangent_personas p where p.user_id = s.user_id;
update public.tangent_alerts a set persona_id = p.id from public.tangent_personas p where p.user_id = a.user_id;
insert into public.tangent_persona_feedback (persona_id, article_id, vote, hidden, at)
select p.id, f.article_id, f.vote, f.hidden, f.at from public.tangent_feedback f join public.tangent_personas p on p.user_id = f.user_id
on conflict do nothing;

-- Guest push: no account, so the device proves ownership with its own random key (only the hash is kept).
create table public.tangent_guest_subs (
  id          bigint generated always as identity primary key,
  endpoint    text not null unique,
  p256dh      text not null,
  auth        text not null,
  key_sha256  text not null,
  user_agent  text,
  tz          text,
  created_at  timestamptz not null default now(),
  last_ok_at  timestamptz,
  failed_at   timestamptz,
  disabled_at timestamptz
);
alter table public.tangent_guest_subs enable row level security;
create table public.tangent_guest_sent (
  sub_id  bigint not null references public.tangent_guest_subs(id) on delete cascade,
  key     text not null,
  title   text,
  url     text,
  sent_at timestamptz not null default now(),
  primary key (sub_id, key)
);
alter table public.tangent_guest_sent enable row level security;

create or replace function public.tangent_persona_id(p_user uuid, p_persona bigint)
returns bigint language plpgsql security definer set search_path = '' as $$
declare pid bigint;
begin
  select id into pid from public.tangent_personas where id = p_persona and user_id = p_user and removed_at is null;
  if pid is null then
    select id into pid from public.tangent_personas where user_id = p_user and removed_at is null order by position, id limit 1;
  end if;
  if pid is null then
    insert into public.tangent_personas (user_id, name)
    select p_user, coalesce(nullif(split_part(name, ' ', 1), ''), 'Me') from public.tangent_users where id = p_user
    returning id into pid;
  end if;
  return pid;
end $$;
revoke execute on function public.tangent_persona_id(uuid,bigint) from public, anon, authenticated;

create or replace function public.tangent_persona_json(p public.tangent_personas)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('id', p.id, 'name', p.name, 'avatar', p.avatar, 'emoji', p.emoji, 'color', p.color, 'settings', p.settings);
$$;

create or replace function public.tangent_me(p_secret text, p_user uuid, p_persona bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare pid bigint;
begin
  perform public.tangent_require(p_secret);
  pid := public.tangent_persona_id(p_user, p_persona);
  return jsonb_build_object(
    'user', (select public.tangent_user_json(u) from public.tangent_users u where u.id = p_user and u.deleted_at is null),
    'persona', pid,
    'personas', (select jsonb_agg(public.tangent_persona_json(p) order by p.position, p.id) from public.tangent_personas p where p.user_id = p_user and p.removed_at is null),
    'shelves', coalesce((
      select jsonb_agg(jsonb_build_object('id', sh.id, 'name', sh.name, 'position', sh.position, 'topic', sh.topic, 'query', sh.query,
        'sources', coalesce((select jsonb_agg(jsonb_build_object('id', so.id, 'name', so.name, 'kind', so.kind, 'site_url', so.site_url,
            'status', so.status, 'access', so.access, 'note', so.status_note) order by so.name)
          from public.tangent_shelf_sources ss join public.tangent_sources so on so.id = ss.source_id
          where ss.shelf_id = sh.id and ss.removed_at is null), '[]'::jsonb))
        order by sh.position, sh.id)
      from public.tangent_shelves sh where sh.user_id = p_user and sh.persona_id = pid and sh.removed_at is null), '[]'::jsonb));
end $$;

-- p_p: {id?, name?, avatar?, emoji?, color?, settings?}. avatar "" clears it. Returns the persona id.
create or replace function public.tangent_persona_save(p_secret text, p_user uuid, p_p jsonb)
returns bigint language plpgsql security definer set search_path = '' as $$
declare pid bigint := (p_p->>'id')::bigint; pos int;
begin
  perform public.tangent_require(p_secret);
  if pid is null then
    if (select count(*) from public.tangent_personas where user_id = p_user and removed_at is null) >= 8 then raise exception 'too_many_personas'; end if;
    select coalesce(max(position), -1) + 1 into pos from public.tangent_personas where user_id = p_user and removed_at is null;
    insert into public.tangent_personas (user_id, name, avatar, emoji, color, position)
    values (p_user, left(coalesce(nullif(trim(p_p->>'name'), ''), 'New persona'), 30), nullif(p_p->>'avatar', ''), nullif(left(p_p->>'emoji', 8), ''), nullif(left(p_p->>'color', 9), ''), pos)
    returning id into pid;
  else
    update public.tangent_personas set
      name = coalesce(left(nullif(trim(p_p->>'name'), ''), 30), name),
      avatar = case when p_p ? 'avatar' then nullif(p_p->>'avatar', '') else avatar end,
      emoji = case when p_p ? 'emoji' then nullif(left(p_p->>'emoji', 8), '') else emoji end,
      color = case when p_p ? 'color' then nullif(left(p_p->>'color', 9), '') else color end,
      settings = coalesce(p_p->'settings', settings)
    where id = pid and user_id = p_user and removed_at is null;
    if not found then raise exception 'not_found'; end if;
  end if;
  return pid;
end $$;

create or replace function public.tangent_persona_remove(p_secret text, p_user uuid, p_id bigint)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.tangent_require(p_secret);
  if (select count(*) from public.tangent_personas where user_id = p_user and removed_at is null) <= 1 then raise exception 'last_persona'; end if;
  update public.tangent_personas set removed_at = now() where id = p_id and user_id = p_user and removed_at is null;
  update public.tangent_shelves set removed_at = now() where persona_id = p_id and user_id = p_user and removed_at is null;
  update public.tangent_alerts set removed_at = now() where persona_id = p_id and user_id = p_user and removed_at is null;
end $$;

create or replace function public.tangent_add_topic_shelves(p_secret text, p_user uuid, p_persona bigint, p_topics text[])
returns void language plpgsql security definer set search_path = '' as $$
declare t public.tangent_topics; sid bigint; pos int; pid bigint;
begin
  perform public.tangent_require(p_secret);
  pid := public.tangent_persona_id(p_user, p_persona);
  select coalesce(max(position), -1) into pos from public.tangent_shelves where persona_id = pid and removed_at is null;
  for t in select * from public.tangent_topics where slug = any(p_topics) order by position loop
    if exists (select 1 from public.tangent_shelves where persona_id = pid and topic = t.slug and removed_at is null) then continue; end if;
    pos := pos + 1;
    insert into public.tangent_shelves (user_id, persona_id, name, position, topic, query) values (p_user, pid, t.name, pos, t.slug, t.query) returning id into sid;
    insert into public.tangent_shelf_sources (shelf_id, source_id)
      select sid, s.id from public.tangent_sources s where s.topic = t.slug and s.enabled and s.status = 'active';
  end loop;
end $$;

create or replace function public.tangent_save_shelf(p_secret text, p_user uuid, p_persona bigint, p_shelf jsonb)
returns bigint language plpgsql security definer set search_path = '' as $$
declare sid bigint := (p_shelf->>'id')::bigint; pos int; pid bigint;
begin
  perform public.tangent_require(p_secret);
  if sid is null then
    pid := public.tangent_persona_id(p_user, p_persona);
    if (select count(*) from public.tangent_shelves where persona_id = pid and removed_at is null) >= 30 then raise exception 'too_many_shelves'; end if;
    select coalesce(max(position), -1) + 1 into pos from public.tangent_shelves where persona_id = pid and removed_at is null;
    insert into public.tangent_shelves (user_id, persona_id, name, position, query)
    values (p_user, pid, left(trim(p_shelf->>'name'), 40), pos, nullif(left(trim(p_shelf->>'query'), 80), '')) returning id into sid;
  else
    update public.tangent_shelves set
      name = coalesce(left(nullif(trim(p_shelf->>'name'), ''), 40), name),
      position = coalesce((p_shelf->>'position')::int, position)
    where id = sid and user_id = p_user and removed_at is null;
  end if;
  return sid;
end $$;

create or replace function public.tangent_user_feedback(p_secret text, p_user uuid, p_persona bigint)
returns table (article_id bigint, cluster_id bigint, vote smallint, hidden boolean, source_id bigint, topic text, kind text, title text, at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare pid bigint;
begin
  perform public.tangent_require(p_secret);
  pid := public.tangent_persona_id(p_user, p_persona);
  return query
    select f.article_id, a.cluster_id, f.vote, f.hidden, a.source_id, s.topic, a.kind, a.title, f.at
    from public.tangent_persona_feedback f
    join public.tangent_articles a on a.id = f.article_id
    join public.tangent_sources s on s.id = a.source_id
    where f.persona_id = pid and f.at > now() - interval '365 days'
    order by f.at desc;
end $$;

create or replace function public.tangent_user_set_feedback(p_secret text, p_user uuid, p_persona bigint, p_article bigint, p_vote smallint, p_hidden boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare pid bigint;
begin
  perform public.tangent_require(p_secret);
  pid := public.tangent_persona_id(p_user, p_persona);
  insert into public.tangent_persona_feedback (persona_id, article_id, vote, hidden)
  values (pid, p_article, coalesce(p_vote, 0), coalesce(p_hidden, false))
  on conflict (persona_id, article_id) do update set
    vote = coalesce(p_vote, public.tangent_persona_feedback.vote),
    hidden = coalesce(p_hidden, public.tangent_persona_feedback.hidden),
    at = now();
end $$;

create or replace function public.tangent_alerts_get(p_secret text, p_user uuid, p_persona bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare pid bigint;
begin
  perform public.tangent_require(p_secret);
  pid := public.tangent_persona_id(p_user, p_persona);
  return jsonb_build_object(
    'alerts', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'kind', a.kind, 'phrase', a.phrase, 'shelf', a.shelf_id,
        'source', a.source_id, 'source_name', s.name, 'enabled', a.enabled) order by a.id)
      from public.tangent_alerts a left join public.tangent_sources s on s.id = a.source_id
      where a.user_id = p_user and a.persona_id = pid and a.removed_at is null), '[]'::jsonb),
    'devices', (select count(*) from public.tangent_push_subs where user_id = p_user and disabled_at is null),
    'recent', coalesce((select jsonb_agg(jsonb_build_object('kind', r.kind, 'title', r.title, 'url', r.url, 'at', r.sent_at) order by r.sent_at desc)
      from (select * from public.tangent_alert_sent where user_id = p_user order by sent_at desc limit 10) r), '[]'::jsonb));
end $$;

create or replace function public.tangent_alert_save(p_secret text, p_user uuid, p_persona bigint, p_alert jsonb)
returns bigint language plpgsql security definer set search_path = '' as $$
declare aid bigint := (p_alert->>'id')::bigint; k text := p_alert->>'kind'; pid bigint;
begin
  perform public.tangent_require(p_secret);
  if aid is not null then
    update public.tangent_alerts set enabled = coalesce((p_alert->>'enabled')::boolean, enabled)
    where id = aid and user_id = p_user and removed_at is null;
    return aid;
  end if;
  pid := public.tangent_persona_id(p_user, p_persona);
  if (select count(*) from public.tangent_alerts where user_id = p_user and removed_at is null) >= 50 then raise exception 'too_many_alerts'; end if;
  if k = 'shelf' and not exists (select 1 from public.tangent_shelves where id = (p_alert->>'shelf')::bigint and user_id = p_user and removed_at is null) then raise exception 'not_found'; end if;
  if k = 'source' and not exists (select 1 from public.tangent_sources where id = (p_alert->>'source')::bigint) then raise exception 'not_found'; end if;
  select id into aid from public.tangent_alerts
  where user_id = p_user and persona_id = pid and removed_at is null and kind = k
    and phrase is not distinct from nullif(lower(trim(p_alert->>'phrase')), '')
    and shelf_id is not distinct from (p_alert->>'shelf')::bigint
    and source_id is not distinct from (p_alert->>'source')::bigint;
  if aid is not null then
    update public.tangent_alerts set enabled = true where id = aid;
    return aid;
  end if;
  insert into public.tangent_alerts (user_id, persona_id, kind, phrase, shelf_id, source_id)
  values (p_user, pid, k, nullif(lower(trim(p_alert->>'phrase')), ''), (p_alert->>'shelf')::bigint, (p_alert->>'source')::bigint)
  returning id into aid;
  return aid;
end $$;

create or replace function public.tangent_push_subscribe(p_secret text, p_user uuid, p_persona bigint, p_endpoint text, p_p256dh text, p_auth text, p_ua text, p_tz text)
returns void language plpgsql security definer set search_path = '' as $$
declare pid bigint;
begin
  perform public.tangent_require(p_secret);
  pid := public.tangent_persona_id(p_user, p_persona);
  insert into public.tangent_push_subs (user_id, endpoint, p256dh, auth, user_agent, tz)
  values (p_user, p_endpoint, p_p256dh, p_auth, left(p_ua, 300), left(p_tz, 60))
  on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
    user_agent = excluded.user_agent, tz = excluded.tz, disabled_at = null, failed_at = null;
  -- The same device may have had big-story alerts as a guest; the account takes over now.
  update public.tangent_guest_subs set disabled_at = now() where endpoint = p_endpoint and disabled_at is null;
  if not exists (select 1 from public.tangent_alerts where user_id = p_user and persona_id = pid and kind = 'big') then
    insert into public.tangent_alerts (user_id, persona_id, kind) values (p_user, pid, 'big');
  end if;
end $$;

-- Guests: big-story alerts on this device, no account. The key is the device's own random secret.
create or replace function public.tangent_guest_push(p_secret text, p_endpoint text, p_p256dh text, p_auth text, p_ua text, p_tz text, p_key text, p_on boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare h text := encode(extensions.digest(p_key, 'sha256'), 'hex');
begin
  perform public.tangent_require(p_secret);
  if p_on then
    insert into public.tangent_guest_subs (endpoint, p256dh, auth, user_agent, tz, key_sha256)
    values (p_endpoint, p_p256dh, p_auth, left(p_ua, 300), left(p_tz, 60), h)
    on conflict (endpoint) do update set p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent,
      tz = excluded.tz, key_sha256 = excluded.key_sha256, disabled_at = null, failed_at = null;
  else
    update public.tangent_guest_subs set disabled_at = now() where endpoint = p_endpoint and key_sha256 = h;
  end if;
end $$;

create or replace function public.tangent_claim_owner(p_secret text, p_user uuid, p_owner_key text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare pid bigint;
begin
  perform public.tangent_require(p_secret);
  if not public.tangent_key_ok(p_owner_key) then return false; end if;
  pid := public.tangent_persona_id(p_user, null);
  update public.tangent_users set is_admin = true where id = p_user;
  update public.tangent_feedback set user_id = p_user where user_id is null;
  insert into public.tangent_persona_feedback (persona_id, article_id, vote, hidden, at)
  select pid, article_id, vote, hidden, at from public.tangent_feedback where user_id = p_user
  on conflict do nothing;
  return true;
end $$;

create or replace function public.tangent_close_account(p_secret text, p_user uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.tangent_require(p_secret);
  update public.tangent_sessions set revoked_at = now() where user_id = p_user and revoked_at is null;
  update public.tangent_shelves set removed_at = now() where user_id = p_user and removed_at is null;
  update public.tangent_push_subs set disabled_at = now() where user_id = p_user and disabled_at is null;
  update public.tangent_alerts set removed_at = now() where user_id = p_user and removed_at is null;
  update public.tangent_personas set removed_at = now(), avatar = null, name = '' where user_id = p_user and removed_at is null;
  update public.tangent_users set email = 'deleted+' || id || '@invalid', name = '', password_hash = null, google_sub = null,
    settings = '{}', is_admin = false, deleted_at = now() where id = p_user;
end $$;

revoke execute on function public.tangent_me(text,uuid,bigint) from public; grant execute on function public.tangent_me(text,uuid,bigint) to anon;
revoke execute on function public.tangent_persona_save(text,uuid,jsonb) from public; grant execute on function public.tangent_persona_save(text,uuid,jsonb) to anon;
revoke execute on function public.tangent_persona_remove(text,uuid,bigint) from public; grant execute on function public.tangent_persona_remove(text,uuid,bigint) to anon;
revoke execute on function public.tangent_add_topic_shelves(text,uuid,bigint,text[]) from public; grant execute on function public.tangent_add_topic_shelves(text,uuid,bigint,text[]) to anon;
revoke execute on function public.tangent_save_shelf(text,uuid,bigint,jsonb) from public; grant execute on function public.tangent_save_shelf(text,uuid,bigint,jsonb) to anon;
revoke execute on function public.tangent_user_feedback(text,uuid,bigint) from public; grant execute on function public.tangent_user_feedback(text,uuid,bigint) to anon;
revoke execute on function public.tangent_user_set_feedback(text,uuid,bigint,bigint,smallint,boolean) from public; grant execute on function public.tangent_user_set_feedback(text,uuid,bigint,bigint,smallint,boolean) to anon;
revoke execute on function public.tangent_alerts_get(text,uuid,bigint) from public; grant execute on function public.tangent_alerts_get(text,uuid,bigint) to anon;
revoke execute on function public.tangent_alert_save(text,uuid,bigint,jsonb) from public; grant execute on function public.tangent_alert_save(text,uuid,bigint,jsonb) to anon;
revoke execute on function public.tangent_push_subscribe(text,uuid,bigint,text,text,text,text,text) from public; grant execute on function public.tangent_push_subscribe(text,uuid,bigint,text,text,text,text,text) to anon;
revoke execute on function public.tangent_guest_push(text,text,text,text,text,text,text,boolean) from public; grant execute on function public.tangent_guest_push(text,text,text,text,text,text,text,boolean) to anon;
