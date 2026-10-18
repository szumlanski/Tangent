-- The first app calls after sign-up arrive together; each found no persona and made one, so a new
-- account could end up with two (one holding the shelves picked at sign-up, one shown). A per-user
-- transaction lock makes the check-then-create run one at a time.
create or replace function public.tangent_persona_id(p_user uuid, p_persona bigint)
returns bigint language plpgsql security definer set search_path = '' as $$
declare pid bigint;
begin
  select id into pid from public.tangent_personas where id = p_persona and user_id = p_user and removed_at is null;
  if pid is not null then return pid; end if;
  perform pg_advisory_xact_lock(hashtextextended('tangent_persona:' || p_user::text, 0));
  select id into pid from public.tangent_personas where user_id = p_user and removed_at is null order by position, id limit 1;
  if pid is null then
    insert into public.tangent_personas (user_id, name)
    select p_user, coalesce(nullif(split_part(name, ' ', 1), ''), 'Me') from public.tangent_users where id = p_user
    returning id into pid;
  end if;
  return pid;
end $$;
