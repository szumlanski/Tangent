-- Shelves editor: reorder shelves, and add a pasted site, feed, YouTube channel or topic phrase to a shelf.
-- A new source starts as status 'pending' and enabled = false, so the regular fetch skips it until the
-- vetting step (fetcher) confirms it is readable, fresh and free, then turns it on.

create or replace function public.tangent_order_shelves(p_secret text, p_user uuid, p_ids bigint[])
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.tangent_require(p_secret);
  update public.tangent_shelves s set position = o.i - 1
  from unnest(p_ids) with ordinality as o(id, i)
  where s.id = o.id and s.user_id = p_user and s.removed_at is null;
end $$;

-- p_url: an absolute http(s) address, already checked by the API. p_query: a topic phrase.
-- Reuses a matching source when one exists, so two people pasting the same site share it.
create or replace function public.tangent_request_source(p_secret text, p_user uuid, p_shelf bigint, p_url text, p_query text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  sh public.tangent_shelves;
  src public.tangent_sources;
  raw text;
  norm text;
  host text;
  q text := nullif(lower(regexp_replace(trim(coalesce(p_query, '')), '\s+', ' ', 'g')), '');
begin
  perform public.tangent_require(p_secret);
  select * into sh from public.tangent_shelves where id = p_shelf and user_id = p_user and removed_at is null;
  if not found then raise exception 'not_found'; end if;

  if q is not null then
    norm := 'search:' || left(q, 80);
    select * into src from public.tangent_sources where site_url = norm;
    if not found then
      insert into public.tangent_sources (name, kind, topic, site_url, query, strategies, enabled, status, added_by)
      values (initcap(left(q, 80)), 'search', coalesce(sh.topic, 'custom'), norm, left(q, 80), '{gnews}', false, 'pending', p_user)
      returning * into src;
    end if;
  else
    -- Paths can be case sensitive (YouTube channel IDs), so store as given and compare lowercased.
    raw := regexp_replace(regexp_replace(trim(p_url), '#.*$', ''), '/+$', '');
    norm := lower(raw);
    host := regexp_replace(substring(norm from '^https?://([^/?]+)'), '^www\.', '');
    if host is null then raise exception 'bad_url'; end if;
    select * into src from public.tangent_sources
    where status <> 'rejected' and (
      lower(rtrim(site_url, '/')) = norm or lower(rtrim(feed_url, '/')) = norm
      -- A bare domain matches the same site with or without www.
      or (norm ~ '^https?://[^/]+$' and regexp_replace(lower(rtrim(site_url, '/')), '^https?://(www\.)?', '') = host))
    order by (status = 'active') desc, id limit 1;
    if not found then
      insert into public.tangent_sources (name, kind, topic, site_url, enabled, status, added_by)
      values (host, case when host in ('youtube.com', 'm.youtube.com') then 'youtube' else 'news' end,
        coalesce(sh.topic, 'custom'), raw, false, 'pending', p_user)
      returning * into src;
    end if;
  end if;

  insert into public.tangent_shelf_sources (shelf_id, source_id) values (sh.id, src.id)
  on conflict (shelf_id, source_id) do update set removed_at = null;
  return jsonb_build_object('id', src.id, 'name', src.name, 'kind', src.kind, 'site_url', src.site_url,
    'status', src.status, 'access', src.access, 'note', src.status_note);
end $$;

revoke execute on function public.tangent_order_shelves(text,uuid,bigint[]) from public; grant execute on function public.tangent_order_shelves(text,uuid,bigint[]) to anon;
revoke execute on function public.tangent_request_source(text,uuid,bigint,text,text) from public; grant execute on function public.tangent_request_source(text,uuid,bigint,text,text) to anon;
