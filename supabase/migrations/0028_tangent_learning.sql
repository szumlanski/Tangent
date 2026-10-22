-- Engine phase 4: learning and controls.
--   "Not about this shelf": the story leaves that shelf, and so do near-identical ones.
--   "Hide this source": a persona stops seeing a source anywhere.
--   Taste (in tangent_shelf_rank): each persona's thumbs up, down and hides pull ranking toward or
--   away from similar stories.
-- Undo clears undone_at rather than deleting, like the rest of the schema.
create table if not exists public.tangent_shelf_rejects (
  shelf_id bigint not null references public.tangent_shelves(id) on delete cascade,
  article_id bigint not null references public.tangent_articles(id) on delete cascade,
  at timestamptz not null default now(),
  undone_at timestamptz,
  primary key (shelf_id, article_id)
);
alter table public.tangent_shelf_rejects enable row level security;

create table if not exists public.tangent_persona_mutes (
  persona_id bigint not null references public.tangent_personas(id) on delete cascade,
  source_id bigint not null references public.tangent_sources(id) on delete cascade,
  at timestamptz not null default now(),
  undone_at timestamptz,
  primary key (persona_id, source_id)
);
alter table public.tangent_persona_mutes enable row level security;

create or replace function public.tangent_shelf_reject(p_secret text, p_user uuid, p_shelf bigint, p_article bigint, p_undo boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.tangent_require(p_secret);
  if not exists (select 1 from public.tangent_shelves where id = p_shelf and user_id = p_user and removed_at is null) then raise exception 'not_found'; end if;
  insert into public.tangent_shelf_rejects (shelf_id, article_id, undone_at) values (p_shelf, p_article, case when p_undo then now() end)
  on conflict (shelf_id, article_id) do update set at = now(), undone_at = case when p_undo then now() end;
end $$;

create or replace function public.tangent_mute_source(p_secret text, p_user uuid, p_persona bigint, p_source bigint, p_undo boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare pid bigint;
begin
  perform public.tangent_require(p_secret);
  pid := public.tangent_persona_id(p_user, p_persona);
  insert into public.tangent_persona_mutes (persona_id, source_id, undone_at) values (pid, p_source, case when p_undo then now() end)
  on conflict (persona_id, source_id) do update set at = now(), undone_at = case when p_undo then now() end;
end $$;

-- The persona's muted sources, for the Sources screen.
create or replace function public.tangent_mutes_get(p_secret text, p_user uuid, p_persona bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare pid bigint;
begin
  perform public.tangent_require(p_secret);
  pid := public.tangent_persona_id(p_user, p_persona);
  return coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name) order by s.name)
    from public.tangent_persona_mutes m join public.tangent_sources s on s.id = m.source_id
    where m.persona_id = pid and m.undone_at is null), '[]');
end $$;

revoke execute on function public.tangent_shelf_reject(text, uuid, bigint, bigint, boolean) from public;
revoke execute on function public.tangent_mute_source(text, uuid, bigint, bigint, boolean) from public;
revoke execute on function public.tangent_mutes_get(text, uuid, bigint) from public;
grant execute on function public.tangent_shelf_reject(text, uuid, bigint, bigint, boolean) to anon;
grant execute on function public.tangent_mute_source(text, uuid, bigint, bigint, boolean) to anon;
grant execute on function public.tangent_mutes_get(text, uuid, bigint) to anon;
