-- Engine phase 2: a shelf is an interest, not a list of sources. Each shelf links to a shared
-- interest (same phrase or topic = same row for every user). The fetcher gives each interest a
-- meaning vector; tangent_shelf_rank finds, scores and diversifies stories for it from the whole
-- pool. Regional shelves (SW Florida, Vermont) stay in "follow" mode (their own sources) until
-- place interests arrive.

alter table public.tangent_articles
  add column if not exists fts tsvector generated always as (to_tsvector('english', coalesce(title, '') || ' ' || coalesce(excerpt, ''))) stored;
create index if not exists tangent_articles_fts on public.tangent_articles using gin (fts);
create index if not exists tangent_articles_published on public.tangent_articles (published_at desc);

create table if not exists public.tangent_interests (
  id bigint generated always as identity primary key,
  key text not null unique,
  kind text not null check (kind in ('topic', 'phrase', 'place')),
  label text not null,
  terms text,              -- words that must appear for a keyword hit (phrase interests)
  vec extensions.halfvec(384),
  vec_at timestamptz,
  window_days int not null default 4,
  min_sim real not null default 0.33,
  created_at timestamptz not null default now()
);
alter table public.tangent_interests enable row level security;

alter table public.tangent_shelves
  add column if not exists interest_id bigint references public.tangent_interests(id),
  add column if not exists mode text not null default 'interest' check (mode in ('interest', 'follow'));

-- Filler words do not have to appear ("Claude tips" needs only "claude").
create or replace function public.tangent_phrase_terms(p text)
returns text language sql immutable set search_path = '' as $$
  select coalesce(nullif(string_agg(w, ' '), ''), lower(trim(p)))
  from unnest(regexp_split_to_array(lower(coalesce(p, '')), '[^[:alnum:]+#.-]+')) w
  where w <> '' and not (w = any (array['tips','tip','news','latest','update','updates','guide','guides','how','to','best','top',
    'new','the','a','an','and','of','for','on','in','about','tricks']));
$$;

-- Link a shelf to its interest (creating the interest if new). Regional topics follow sources.
create or replace function public.tangent_link_shelf(p_shelf bigint)
returns bigint language plpgsql security definer set search_path = '' as $$
declare sh public.tangent_shelves; k text; kd text; lbl text; t text; iid bigint; w int; ms real;
begin
  select * into sh from public.tangent_shelves where id = p_shelf;
  if not found then return null; end if;
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
revoke execute on function public.tangent_link_shelf(bigint) from public, anon, authenticated;

create or replace function public.tangent_shelf_link_trigger()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform public.tangent_link_shelf(new.id);
  return null;
end $$;
create trigger tangent_shelf_link after insert or update of name, query, topic on public.tangent_shelves
  for each row execute function public.tangent_shelf_link_trigger();

select public.tangent_link_shelf(id) from public.tangent_shelves;

-- Fetcher: interests needing a (fresh) vector, and writing it.
create or replace function public.tangent_interests_pending()
returns setof public.tangent_interests language sql security definer set search_path = '' as $$
  select * from public.tangent_interests i
  where i.vec is null or i.vec_at < now() - interval '6 hours'
    or exists (select 1 from public.tangent_shelves s where s.interest_id = i.id and s.removed_at is null and s.created_at > i.vec_at)
  order by i.vec is not null, i.id limit 50;
$$;
create or replace function public.tangent_set_interest_vec(p_id bigint, p_vec text)
returns void language sql security definer set search_path = '' as $$
  update public.tangent_interests set vec = p_vec::extensions.halfvec(384), vec_at = now() where id = p_id;
$$;
revoke execute on function public.tangent_interests_pending() from public, anon, authenticated;
revoke execute on function public.tangent_set_interest_vec(bigint, text) from public, anon, authenticated;
grant execute on function public.tangent_interests_pending() to service_role;
grant execute on function public.tangent_set_interest_vec(bigint, text) to service_role;
