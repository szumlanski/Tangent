-- Region shelves and their local news searches use the topic "region" (unlisted, never offered as a pick).
insert into public.tangent_topics (slug, name, blurb, position, is_default, listed)
values ('region', 'Local news', 'News from a place you choose', 99, false, false)
on conflict (slug) do nothing;
