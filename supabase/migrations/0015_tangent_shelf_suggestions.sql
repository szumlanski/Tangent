-- Suggested sources per shelf. The fetcher fills this from the outlets that keep covering a shelf's phrase;
-- the app also suggests catalog sources on its own. Dismissing is soft.
create table public.tangent_shelf_suggestions (
  shelf_id     bigint not null references public.tangent_shelves(id) on delete cascade,
  domain       text not null,
  name         text not null,
  url          text not null,
  source_id    bigint references public.tangent_sources(id) on delete set null,
  hits         int not null default 1,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  dismissed_at timestamptz,
  primary key (shelf_id, domain)
);
alter table public.tangent_shelf_suggestions enable row level security;

create or replace function public.tangent_shelf_suggestions_get(p_secret text, p_user uuid, p_shelf bigint)
returns jsonb language plpgsql security definer stable set search_path = '' as $$
begin
  perform public.tangent_require(p_secret);
  if not exists (select 1 from public.tangent_shelves where id = p_shelf and user_id = p_user and removed_at is null) then raise exception 'not_found'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('domain', g.domain, 'name', g.name, 'url', g.url, 'source', g.source_id, 'hits', g.hits) order by g.hits desc, g.name)
    from (select * from public.tangent_shelf_suggestions x
          where x.shelf_id = p_shelf and x.dismissed_at is null
            and not exists (select 1 from public.tangent_shelf_sources ss where ss.shelf_id = p_shelf and ss.removed_at is null and ss.source_id = x.source_id)
            and not exists (select 1 from public.tangent_shelf_sources ss join public.tangent_sources s on s.id = ss.source_id
                            where ss.shelf_id = p_shelf and ss.removed_at is null and regexp_replace(lower(s.site_url), '^https?://(www\.)?([^/]+).*$', '\2') = x.domain)
          order by x.hits desc limit 10) g), '[]'::jsonb);
end $$;

create or replace function public.tangent_shelf_suggestion_dismiss(p_secret text, p_user uuid, p_shelf bigint, p_domain text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.tangent_require(p_secret);
  update public.tangent_shelf_suggestions x set dismissed_at = now()
  from public.tangent_shelves sh where sh.id = x.shelf_id and sh.user_id = p_user and x.shelf_id = p_shelf and x.domain = p_domain;
end $$;

revoke execute on function public.tangent_shelf_suggestions_get(text,uuid,bigint) from public; grant execute on function public.tangent_shelf_suggestions_get(text,uuid,bigint) to anon;
revoke execute on function public.tangent_shelf_suggestion_dismiss(text,uuid,bigint,text) from public; grant execute on function public.tangent_shelf_suggestion_dismiss(text,uuid,bigint,text) to anon;
