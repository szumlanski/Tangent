-- The owner-key link is retired (admin accounts replaced it); nothing outside the server may call these.
revoke execute on function public.tangent_check_key(text) from anon, authenticated, public;
revoke execute on function public.tangent_get_feedback(text) from anon, authenticated, public;
revoke execute on function public.tangent_review_suggestion(bigint, text, text) from anon, authenticated, public;
revoke execute on function public.tangent_set_feedback(text, bigint, smallint, boolean) from anon, authenticated, public;
