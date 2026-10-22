-- Engine phase 5: regions. A reader adds any number of regions (city, county or ZIP). Each region is a
-- shared place interest covering every town and county within about 25 miles. Its shelf shows stories
-- that name one of those places and are clearly local (they also name the state or county, or come
-- from the region's own local news search). US Census 2023 gazetteer, loaded by the fetcher.

create table if not exists public.tangent_places (
  id bigint generated always as identity primary key,
  kind char(1) not null check (kind in ('p', 'c', 'z')),  -- place, county, ZIP
  name text not null,
  state text,
  lat real not null,
  lon real not null,
  area real
);
alter table public.tangent_places enable row level security;
create index if not exists tangent_places_name on public.tangent_places (lower(name));
create index if not exists tangent_places_latlon on public.tangent_places (lat, lon);

create table if not exists public.tangent_states (abbr text primary key, name text not null);
alter table public.tangent_states enable row level security;
insert into public.tangent_states (abbr, name) values
 ('AL','Alabama'),('AK','Alaska'),('AZ','Arizona'),('AR','Arkansas'),('CA','California'),('CO','Colorado'),('CT','Connecticut'),
 ('DE','Delaware'),('DC','District of Columbia'),('FL','Florida'),('GA','Georgia'),('HI','Hawaii'),('ID','Idaho'),('IL','Illinois'),
 ('IN','Indiana'),('IA','Iowa'),('KS','Kansas'),('KY','Kentucky'),('LA','Louisiana'),('ME','Maine'),('MD','Maryland'),
 ('MA','Massachusetts'),('MI','Michigan'),('MN','Minnesota'),('MS','Mississippi'),('MO','Missouri'),('MT','Montana'),
 ('NE','Nebraska'),('NV','Nevada'),('NH','New Hampshire'),('NJ','New Jersey'),('NM','New Mexico'),('NY','New York'),
 ('NC','North Carolina'),('ND','North Dakota'),('OH','Ohio'),('OK','Oklahoma'),('OR','Oregon'),('PA','Pennsylvania'),
 ('RI','Rhode Island'),('SC','South Carolina'),('SD','South Dakota'),('TN','Tennessee'),('TX','Texas'),('UT','Utah'),
 ('VT','Vermont'),('VA','Virginia'),('WA','Washington'),('WV','West Virginia'),('WI','Wisconsin'),('WY','Wyoming'),('PR','Puerto Rico')
on conflict (abbr) do nothing;

alter table public.tangent_interests
  add column if not exists lat real,
  add column if not exists lon real,
  add column if not exists state text,
  add column if not exists places text[];

-- Distance in miles between two points.
create or replace function public.tangent_miles(lat1 real, lon1 real, lat2 real, lon2 real)
returns real language sql immutable set search_path = '' as $$
  select (3959 * 2 * asin(sqrt(power(sin(radians(lat2 - lat1) / 2), 2)
    + cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lon2 - lon1) / 2), 2))))::real;
$$;

-- Find a region from what the reader typed: a ZIP, "City, ST", "City ST", a county, or a city name.
create or replace function public.tangent_region_search(p_secret text, p_q text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare q text := trim(coalesce(p_q, '')); nm text; st text; z public.tangent_places; out jsonb;
begin
  perform public.tangent_require(p_secret);
  if q ~ '^\d{5}$' then
    select * into z from public.tangent_places where kind = 'z' and name = q limit 1;
    if not found then return '[]'; end if;
    select jsonb_agg(jsonb_build_object('label', p.name || ', ' || p.state, 'lat', p.lat, 'lon', p.lon, 'state', p.state)) into out
    from (select * from public.tangent_places where kind = 'p' and abs(lat - z.lat) < 0.3 and abs(lon - z.lon) < 0.3
          order by public.tangent_miles(lat, lon, z.lat, z.lon) - least(coalesce(area, 0), 30) / 6 limit 1) p;
    return coalesce(out, '[]');
  end if;
  nm := lower(trim(regexp_replace(q, '[, ]+([A-Za-z]{2})$', '')));
  st := upper(substring(q from '[, ]+([A-Za-z]{2})$'));
  if st is not null and not exists (select 1 from public.tangent_states where abbr = st) then st := null; nm := lower(q); end if;
  select coalesce(jsonb_agg(jsonb_build_object('label', r.name || ', ' || r.state, 'lat', r.lat, 'lon', r.lon, 'state', r.state) order by r.rank), '[]') into out
  from (
    select p.*, (case when lower(p.name) = nm then 0 else 1 end) * 1000 - coalesce(p.area, 0) as rank
    from public.tangent_places p
    where p.kind in ('p', 'c') and (st is null or p.state = st) and lower(p.name) like nm || '%' and length(nm) >= 3
    order by rank limit 8) r;
  return out;
end $$;

-- Add a region shelf for this persona: create (or reuse) the shared place interest, then the shelf,
-- then a local news search for the region's main names (pinned to the shelf).
create or replace function public.tangent_add_region(p_secret text, p_user uuid, p_persona bigint, p_label text, p_lat real, p_lon real, p_state text)
returns bigint language plpgsql security definer set search_path = '' as $$
declare pid bigint; k text; iid bigint; sid bigint; src bigint; names text[]; q text; stname text;
begin
  perform public.tangent_require(p_secret);
  pid := public.tangent_persona_id(p_user, p_persona);
  if (select count(*) from public.tangent_shelves where user_id = p_user and removed_at is null) >= 30 then raise exception 'too_many_shelves'; end if;
  if p_lat is null or p_lon is null or p_lat not between -15 and 72 or p_lon not between -180 and -60 then raise exception 'not_found'; end if;
  select name into stname from public.tangent_states where abbr = p_state;
  k := 'place:' || round(p_lat::numeric * 4) / 4 || ',' || round(p_lon::numeric * 4) / 4;
  select array_agg(n order by a desc) into names from (
    select distinct on (lower(name)) name n, coalesce(area, 0) a from public.tangent_places
    where kind in ('p', 'c') and abs(lat - p_lat) < 0.5 and abs(lon - p_lon) < 0.6
      and public.tangent_miles(lat, lon, p_lat, p_lon) <= 25 and (kind = 'c' or coalesce(area, 0) >= 1)
    order by lower(name), area desc) x limit 60;
  insert into public.tangent_interests (key, kind, label, window_days, min_sim, lat, lon, state, places)
  values (k, 'place', left(p_label, 60), 3, 0, p_lat, p_lon, p_state, names)
  on conflict (key) do update set label = public.tangent_interests.label
  returning id into iid;
  insert into public.tangent_shelves (user_id, persona_id, name, topic, position, interest_id, mode)
  values (p_user, pid, left(split_part(p_label, ',', 1), 40), 'region',
    coalesce((select max(position) + 1 from public.tangent_shelves where user_id = p_user and persona_id = pid and removed_at is null), 0), iid, 'interest')
  returning id into sid;
  -- Local news search for the region (Google News, credited to each outlet).
  q := lower(split_part(p_label, ',', 1) || ' ' || coalesce(stname, p_state, ''));
  select id into src from public.tangent_sources where site_url = 'search:' || q;
  if src is null then
    insert into public.tangent_sources (name, kind, topic, site_url, query, strategies, enabled, status, access, added_by)
    values (initcap(q), 'search', 'region', 'search:' || q, q, '{gsearch}', true, 'active', 'free', p_user) returning id into src;
  end if;
  insert into public.tangent_shelf_sources (shelf_id, source_id) values (sid, src) on conflict (shelf_id, source_id) do update set removed_at = null;
  return sid;
end $$;

-- Region shelves link their interest themselves; the general link trigger leaves them alone.
create or replace function public.tangent_link_shelf(p_shelf bigint)
returns bigint language plpgsql security definer set search_path = '' as $$
declare sh public.tangent_shelves; k text; kd text; lbl text; t text; iid bigint; w int; ms real;
begin
  select * into sh from public.tangent_shelves where id = p_shelf;
  if not found then return null; end if;
  if sh.topic = 'region' then return sh.interest_id; end if;
  if sh.query is null and sh.topic in ('swfl', 'vermont') then
    update public.tangent_shelves set mode = 'follow', interest_id = null where id = p_shelf;
    return null;
  end if;
  if sh.query is not null then
    t := public.tangent_phrase_terms(sh.query); k := 'q:' || t; kd := 'phrase'; lbl := sh.query; w := 14; ms := 0.30;
  elsif sh.topic is not null and sh.topic <> 'custom' then
    k := 't:' || sh.topic; kd := 'topic'; lbl := (select name from public.tangent_topics where slug = sh.topic); w := 3; ms := 0.30; t := null;
  else
    t := public.tangent_phrase_terms(sh.name); k := 'q:' || t; kd := 'phrase'; lbl := sh.name; w := 14; ms := 0.30;
  end if;
  insert into public.tangent_interests (key, kind, label, terms, window_days, min_sim)
  values (k, kd, coalesce(lbl, sh.name), t, w, ms)
  on conflict (key) do update set label = public.tangent_interests.label
  returning id into iid;
  update public.tangent_shelves set interest_id = iid, mode = 'interest' where id = p_shelf;
  return iid;
end $$;

-- A region's stories: they name a place in the region and are clearly local (they also name the
-- state or a county of the region, or come from a source pinned to the shelf). Newest and best first,
-- one card per story, gentle per-source damping, the reader's hides and mutes applied.
create or replace function public.tangent_region_rank(p_shelf bigint, p_offset int, p_limit int)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare sh public.tangent_shelves; it public.tangent_interests; tsq tsquery; guard text; stname text; out jsonb;
begin
  select * into sh from public.tangent_shelves where id = p_shelf;
  select * into it from public.tangent_interests where id = sh.interest_id;
  select name into stname from public.tangent_states where abbr = it.state;
  tsq := websearch_to_tsquery('english', (select string_agg('"' || replace(n, '"', '') || '"', ' or ') from unnest(it.places) n));
  guard := '\m(' || concat_ws('|', stname, it.state, (select string_agg(regexp_replace(n, '([.()])', '\\\1', 'g'), '|') from unnest(it.places) n where n ~ ' (County|Parish|Borough)$')) || ')\M';
  with pin as (
    select a.id from public.tangent_articles a
    join public.tangent_shelf_sources ss on ss.source_id = a.source_id and ss.shelf_id = sh.id and ss.removed_at is null
    where a.published_at > now() - interval '3 days' and not a.paywalled and not a.offtopic
  ), kw as (
    select a.id from public.tangent_articles a
    where a.fts @@ tsq and a.published_at > now() - interval '3 days' and not a.paywalled and not a.offtopic
    order by a.published_at desc limit 800
  ), cand as (select id from pin union select id from kw),
  scored as (
    select f.*, a.quality, a.emb, exists (select 1 from pin where pin.id = a.id) pinned,
      exp(-ln(2) * extract(epoch from now() - f.published_at) / 3600 / 24)
        * coalesce(a.quality, 1) * (1 + 0.2 * ln(greatest(coalesce(f.story_size, 1), 1))) as score0
    from cand join public.tangent_articles a on a.id = cand.id join public.tangent_feed f on f.id = cand.id
    where (exists (select 1 from pin where pin.id = a.id)
        or (concat_ws(' ', a.title, a.excerpt, left(regexp_replace(coalesce(a.body_html, ''), '<[^>]+>', ' ', 'g'), 1500)) ~* guard))
      and not exists (select 1 from public.tangent_persona_feedback h where h.persona_id = sh.persona_id and h.article_id = a.id and h.hidden)
      and not exists (select 1 from public.tangent_persona_mutes m where m.persona_id = sh.persona_id and m.source_id = a.source_id and m.undone_at is null)
      and not exists (select 1 from public.tangent_shelf_rejects r where r.shelf_id = sh.id and r.article_id = a.id and r.undone_at is null)
  ), top as (select * from scored order by score0 desc limit 300),
  one as (
    select t.* from top t
    where not exists (select 1 from top u where (u.score0 > t.score0 or (u.score0 = t.score0 and u.id < t.id))
      and (u.cluster_id = t.cluster_id or (u.emb is not null and t.emb is not null and (u.emb operator(extensions.<=>) t.emb) < 0.2)))
  ), div as (
    select o.*, o.score0 * power(0.85, row_number() over (partition by o.source_id order by o.score0 desc) - 1) as score from one o
  ), page as (
    select * from div order by score desc offset greatest(coalesce(p_offset, 0), 0) limit least(greatest(coalesce(p_limit, 40), 1), 100)
  )
  select coalesce(jsonb_agg((to_jsonb(p) - array['quality', 'emb', 'pinned', 'score0'])
    || jsonb_build_object('score', round(p.score::numeric, 4), 'why', 'Local to ' || it.label) order by p.score desc), '[]') into out
  from page p;
  return out;
end $$;

revoke execute on function public.tangent_region_search(text, text) from public;
revoke execute on function public.tangent_add_region(text, uuid, bigint, text, real, real, text) from public;
revoke execute on function public.tangent_region_rank(bigint, int, int) from public, anon, authenticated;
grant execute on function public.tangent_region_search(text, text) to anon;
grant execute on function public.tangent_add_region(text, uuid, bigint, text, real, real, text) to anon;
