-- Google News wrapper link, so a story found via Google News is not decoded twice.
alter table public.tangent_articles add column origin_url text unique;
