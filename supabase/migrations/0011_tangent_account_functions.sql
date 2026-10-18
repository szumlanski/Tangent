-- Server functions for accounts and per-user data, as applied (2026-10-18).
-- Every function takes the server secret first and checks it with tangent_require.
-- Called only by Cloudflare Pages Functions; granted to anon because they authenticate by the secret.
-- Removals are soft (revoked_at / removed_at / deleted_at), so no function deletes rows.
-- Closing an account scrubs personal data at once; purging the leftover rows is a separate, approved job.

alter table public.tangent_sessions add column if not exists revoked_at timestamptz;
alter table public.tangent_shelves add column if not exists removed_at timestamptz;
alter table public.tangent_shelf_sources add column if not exists removed_at timestamptz;
alter table public.tangent_users add column if not exists deleted_at timestamptz;

create or replace function public.tangent_server_ok(p_secret text)
returns boolean language sql security definer stable set search_path = '' as $$
  select coalesce(encode(extensions.digest(p_secret, 'sha256'), 'hex') = (select v from public.tangent_config where k = 'server_secret_sha256'), false);
$$;

create or replace function public.tangent_require(p_secret text)
returns void language plpgsql security definer stable set search_path = '' as $$
begin
  if not public.tangent_server_ok(p_secret) then raise exception 'forbidden'; end if;
end $$;

create or replace function public.tangent_user_json(u public.tangent_users)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('id', u.id, 'email', u.email, 'name', u.name, 'is_admin', u.is_admin,
    'has_password', u.password_hash is not null, 'has_google', u.google_sub is not null, 'settings', u.settings);
$$;

create or replace function public.tangent_rate_hit(p_secret text, p_key text, p_limit int, p_window_s int)
returns boolean language plpgsql security definer set search_path = '' as $$
declare r public.tangent_rate;
begin
  perform public.tangent_require(p_secret);
  insert into public.tangent_rate (key) values (p_key) on conflict (key) do nothing;
  select * into r from public.tangent_rate where key = p_key for update;
  if r.window_start < now() - make_interval(secs => p_window_s) then
    update public.tangent_rate set window_start = now(), hits = 1 where key = p_key;
    return true;
  end if;
  update public.tangent_rate set hits = hits + 1 where key = p_key;
  return r.hits + 1 <= p_limit;
end $$;

create or replace function public.tangent_signup(p_secret text, p_email text, p_name text, p_password text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare u public.tangent_users;
begin
  perform public.tangent_require(p_secret);
  if exists (select 1 from public.tangent_users where lower(email) = lower(trim(p_email))) then raise exception 'email_taken'; end if;
  insert into public.tangent_users (email, name, password_hash)
  values (lower(trim(p_email)), trim(p_name), extensions.crypt(p_password, extensions.gen_salt('bf', 10)))
  returning * into u;
  return public.tangent_user_json(u);
end $$;

create or replace function public.tangent_login(p_secret text, p_email text, p_password text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare u public.tangent_users;
begin
  perform public.tangent_require(p_secret);
  select * into u from public.tangent_users where lower(email) = lower(trim(p_email));
  if not found or u.password_hash is null or u.password_hash <> extensions.crypt(p_password, u.password_hash) then
    return null;
  end if;
  return public.tangent_user_json(u);
end $$;

create or replace function public.tangent_google(p_secret text, p_sub text, p_email text, p_name text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare u public.tangent_users;
begin
  perform public.tangent_require(p_secret);
  select * into u from public.tangent_users where google_sub = p_sub;
  if not found then
    select * into u from public.tangent_users where lower(email) = lower(p_email);
    if found then
      update public.tangent_users set google_sub = p_sub, name = coalesce(nullif(name, ''), p_name) where id = u.id returning * into u;
    else
      insert into public.tangent_users (email, name, google_sub) values (lower(p_email), coalesce(p_name, ''), p_sub) returning * into u;
    end if;
  end if;
  return public.tangent_user_json(u);
end $$;

create or replace function public.tangent_session_new(p_secret text, p_user uuid, p_ua text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare sid uuid;
begin
  perform public.tangent_require(p_secret);
  insert into public.tangent_sessions (user_id, user_agent) values (p_user, left(p_ua, 300)) returning id into sid;
  return sid;
end $$;

create or replace function public.tangent_session_user(p_secret text, p_sid uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.tangent_sessions; u public.tangent_users;
begin
  perform public.tangent_require(p_secret);
  select * into s from public.tangent_sessions where id = p_sid and expires_at > now() and revoked_at is null;
  if not found then return null; end if;
  select * into u from public.tangent_users where id = s.user_id;
  if s.last_used_at < now() - interval '1 day' then
    update public.tangent_sessions set last_used_at = now(), expires_at = now() + interval '90 days' where id = p_sid;
    update public.tangent_users set last_seen_at = now() where id = u.id;
  end if;
  return public.tangent_user_json(u);
end $$;

-- Sign out: this device, or every device.
create or replace function public.tangent_session_end(p_secret text, p_sid uuid, p_all boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare uid uuid;
begin
  perform public.tangent_require(p_secret);
  select user_id into uid from public.tangent_sessions where id = p_sid;
  update public.tangent_sessions set revoked_at = now()
  where revoked_at is null and (id = p_sid or (p_all and user_id = uid));
end $$;

create or replace function public.tangent_set_password(p_secret text, p_user uuid, p_current text, p_new text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare u public.tangent_users;
begin
  perform public.tangent_require(p_secret);
  select * into u from public.tangent_users where id = p_user;
  if u.password_hash is not null and u.password_hash <> extensions.crypt(coalesce(p_current, ''), u.password_hash) then return false; end if;
  update public.tangent_users set password_hash = extensions.crypt(p_new, extensions.gen_salt('bf', 10)) where id = p_user;
  return true;
end $$;

create or replace function public.tangent_save_settings(p_secret text, p_user uuid, p_settings jsonb, p_name text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare u public.tangent_users;
begin
  perform public.tangent_require(p_secret);
  update public.tangent_users set settings = coalesce(p_settings, settings), name = coalesce(nullif(trim(p_name), ''), name)
  where id = p_user returning * into u;
  return public.tangent_user_json(u);
end $$;

-- Everything the app needs at start: user, shelves with their sources.
create or replace function public.tangent_me(p_secret text, p_user uuid)
returns jsonb language plpgsql security definer stable set search_path = '' as $$
begin
  perform public.tangent_require(p_secret);
  return jsonb_build_object(
    'user', (select public.tangent_user_json(u) from public.tangent_users u where u.id = p_user and u.deleted_at is null),
    'shelves', coalesce((
      select jsonb_agg(jsonb_build_object('id', sh.id, 'name', sh.name, 'position', sh.position, 'topic', sh.topic, 'query', sh.query,
        'sources', coalesce((select jsonb_agg(jsonb_build_object('id', so.id, 'name', so.name, 'kind', so.kind, 'site_url', so.site_url,
            'status', so.status, 'access', so.access, 'note', so.status_note) order by so.name)
          from public.tangent_shelf_sources ss join public.tangent_sources so on so.id = ss.source_id
          where ss.shelf_id = sh.id and ss.removed_at is null), '[]'::jsonb))
        order by sh.position, sh.id)
      from public.tangent_shelves sh where sh.user_id = p_user and sh.removed_at is null), '[]'::jsonb));
end $$;

-- Create shelves from suggested topics (sign-up), each with that topic's active sources.
create or replace function public.tangent_add_topic_shelves(p_secret text, p_user uuid, p_topics text[])
returns void language plpgsql security definer set search_path = '' as $$
declare t public.tangent_topics; sid bigint; pos int;
begin
  perform public.tangent_require(p_secret);
  select coalesce(max(position), -1) into pos from public.tangent_shelves where user_id = p_user and removed_at is null;
  for t in select * from public.tangent_topics where slug = any(p_topics) order by position loop
    if exists (select 1 from public.tangent_shelves where user_id = p_user and topic = t.slug and removed_at is null) then continue; end if;
    pos := pos + 1;
    insert into public.tangent_shelves (user_id, name, position, topic, query) values (p_user, t.name, pos, t.slug, t.query) returning id into sid;
    insert into public.tangent_shelf_sources (shelf_id, source_id)
      select sid, s.id from public.tangent_sources s where s.topic = t.slug and s.enabled and s.status = 'active';
  end loop;
end $$;

-- Create, rename or reorder a shelf. p_shelf: {id?, name, position?, query?}
create or replace function public.tangent_save_shelf(p_secret text, p_user uuid, p_shelf jsonb)
returns bigint language plpgsql security definer set search_path = '' as $$
declare sid bigint := (p_shelf->>'id')::bigint; pos int;
begin
  perform public.tangent_require(p_secret);
  if sid is null then
    if (select count(*) from public.tangent_shelves where user_id = p_user and removed_at is null) >= 30 then raise exception 'too_many_shelves'; end if;
    select coalesce(max(position), -1) + 1 into pos from public.tangent_shelves where user_id = p_user and removed_at is null;
    insert into public.tangent_shelves (user_id, name, position, query)
    values (p_user, left(trim(p_shelf->>'name'), 40), pos, nullif(left(trim(p_shelf->>'query'), 80), '')) returning id into sid;
  else
    update public.tangent_shelves set
      name = coalesce(left(nullif(trim(p_shelf->>'name'), ''), 40), name),
      position = coalesce((p_shelf->>'position')::int, position)
    where id = sid and user_id = p_user and removed_at is null;
  end if;
  return sid;
end $$;

create or replace function public.tangent_remove_shelf(p_secret text, p_user uuid, p_shelf bigint)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.tangent_require(p_secret);
  update public.tangent_shelves set removed_at = now() where id = p_shelf and user_id = p_user and removed_at is null;
end $$;

create or replace function public.tangent_shelf_source(p_secret text, p_user uuid, p_shelf bigint, p_source bigint, p_add boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.tangent_require(p_secret);
  if not exists (select 1 from public.tangent_shelves where id = p_shelf and user_id = p_user and removed_at is null) then raise exception 'not_found'; end if;
  if p_add then
    insert into public.tangent_shelf_sources (shelf_id, source_id) values (p_shelf, p_source)
    on conflict (shelf_id, source_id) do update set removed_at = null;
  else
    update public.tangent_shelf_sources set removed_at = now() where shelf_id = p_shelf and source_id = p_source;
  end if;
end $$;

create or replace function public.tangent_user_feedback(p_secret text, p_user uuid)
returns table (article_id bigint, cluster_id bigint, vote smallint, hidden boolean, source_id bigint, topic text, kind text, title text, at timestamptz)
language plpgsql security definer stable set search_path = '' as $$
begin
  perform public.tangent_require(p_secret);
  return query
    select f.article_id, a.cluster_id, f.vote, f.hidden, a.source_id, s.topic, a.kind, a.title, f.at
    from public.tangent_feedback f
    join public.tangent_articles a on a.id = f.article_id
    join public.tangent_sources s on s.id = a.source_id
    where f.user_id = p_user and f.at > now() - interval '365 days'
    order by f.at desc;
end $$;

create or replace function public.tangent_user_set_feedback(p_secret text, p_user uuid, p_article bigint, p_vote smallint, p_hidden boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.tangent_require(p_secret);
  insert into public.tangent_feedback (user_id, article_id, vote, hidden)
  values (p_user, p_article, coalesce(p_vote, 0), coalesce(p_hidden, false))
  on conflict (user_id, article_id) do update set
    vote = coalesce(p_vote, public.tangent_feedback.vote),
    hidden = coalesce(p_hidden, public.tangent_feedback.hidden),
    at = now();
end $$;

-- The original owner (holder of the owner key) claims admin rights and the votes made before accounts.
create or replace function public.tangent_claim_owner(p_secret text, p_user uuid, p_owner_key text)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  perform public.tangent_require(p_secret);
  if not public.tangent_key_ok(p_owner_key) then return false; end if;
  update public.tangent_users set is_admin = true where id = p_user;
  update public.tangent_feedback set user_id = p_user where user_id is null;
  return true;
end $$;

-- Delete account: personal data scrubbed at once, sessions revoked, shelves detached.
create or replace function public.tangent_close_account(p_secret text, p_user uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.tangent_require(p_secret);
  update public.tangent_sessions set revoked_at = now() where user_id = p_user and revoked_at is null;
  update public.tangent_shelves set removed_at = now() where user_id = p_user and removed_at is null;
  update public.tangent_users set email = 'deleted+' || id || '@invalid', name = '', password_hash = null, google_sub = null,
    settings = '{}', is_admin = false, deleted_at = now() where id = p_user;
end $$;

-- Owner-key votes from before accounts (user_id null), updated for per-user uniqueness.
create or replace function public.tangent_set_feedback(p_key text, p_article bigint, p_vote smallint, p_hidden boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.tangent_key_ok(p_key) then raise exception 'bad key'; end if;
  insert into public.tangent_feedback (user_id, article_id, vote, hidden)
  values (null, p_article, coalesce(p_vote, 0), coalesce(p_hidden, false))
  on conflict (user_id, article_id) do update set
    vote = coalesce(p_vote, public.tangent_feedback.vote),
    hidden = coalesce(p_hidden, public.tangent_feedback.hidden),
    at = now();
end $$;

revoke execute on function public.tangent_server_ok(text) from public, anon, authenticated;
revoke execute on function public.tangent_require(text) from public, anon, authenticated;
revoke execute on function public.tangent_user_json(public.tangent_users) from public, anon, authenticated;
revoke execute on function public.tangent_rate_hit(text,text,int,int) from public; grant execute on function public.tangent_rate_hit(text,text,int,int) to anon;
revoke execute on function public.tangent_signup(text,text,text,text) from public; grant execute on function public.tangent_signup(text,text,text,text) to anon;
revoke execute on function public.tangent_login(text,text,text) from public; grant execute on function public.tangent_login(text,text,text) to anon;
revoke execute on function public.tangent_google(text,text,text,text) from public; grant execute on function public.tangent_google(text,text,text,text) to anon;
revoke execute on function public.tangent_session_new(text,uuid,text) from public; grant execute on function public.tangent_session_new(text,uuid,text) to anon;
revoke execute on function public.tangent_session_user(text,uuid) from public; grant execute on function public.tangent_session_user(text,uuid) to anon;
revoke execute on function public.tangent_session_end(text,uuid,boolean) from public; grant execute on function public.tangent_session_end(text,uuid,boolean) to anon;
revoke execute on function public.tangent_set_password(text,uuid,text,text) from public; grant execute on function public.tangent_set_password(text,uuid,text,text) to anon;
revoke execute on function public.tangent_save_settings(text,uuid,jsonb,text) from public; grant execute on function public.tangent_save_settings(text,uuid,jsonb,text) to anon;
revoke execute on function public.tangent_me(text,uuid) from public; grant execute on function public.tangent_me(text,uuid) to anon;
revoke execute on function public.tangent_add_topic_shelves(text,uuid,text[]) from public; grant execute on function public.tangent_add_topic_shelves(text,uuid,text[]) to anon;
revoke execute on function public.tangent_save_shelf(text,uuid,jsonb) from public; grant execute on function public.tangent_save_shelf(text,uuid,jsonb) to anon;
revoke execute on function public.tangent_remove_shelf(text,uuid,bigint) from public; grant execute on function public.tangent_remove_shelf(text,uuid,bigint) to anon;
revoke execute on function public.tangent_shelf_source(text,uuid,bigint,bigint,boolean) from public; grant execute on function public.tangent_shelf_source(text,uuid,bigint,bigint,boolean) to anon;
revoke execute on function public.tangent_user_feedback(text,uuid) from public; grant execute on function public.tangent_user_feedback(text,uuid) to anon;
revoke execute on function public.tangent_user_set_feedback(text,uuid,bigint,smallint,boolean) from public; grant execute on function public.tangent_user_set_feedback(text,uuid,bigint,smallint,boolean) to anon;
revoke execute on function public.tangent_claim_owner(text,uuid,text) from public; grant execute on function public.tangent_claim_owner(text,uuid,text) to anon;
revoke execute on function public.tangent_close_account(text,uuid) from public; grant execute on function public.tangent_close_account(text,uuid) to anon;
