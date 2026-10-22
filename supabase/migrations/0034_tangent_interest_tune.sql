-- Self-tuning relevance bar per interest, nudged by the daily quality check (bounded 0.22 to 0.42).
create or replace function public.tangent_interest_tune(p_id bigint, p_delta real)
returns real language sql security definer set search_path = '' as $$
  update public.tangent_interests set min_sim = least(0.42, greatest(0.22, min_sim + p_delta))
  where id = p_id and kind <> 'place' returning min_sim;
$$;
revoke execute on function public.tangent_interest_tune(bigint, real) from public, anon, authenticated;
grant execute on function public.tangent_interest_tune(bigint, real) to service_role;
