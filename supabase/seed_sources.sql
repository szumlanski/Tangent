-- Starter sources. Strategy order matters: the fetcher uses the first that returns items.
insert into public.tangent_sources (name, kind, topic, site_url, feed_url, strategies) values
-- Solar / energy / utilities
('Electrek',            'news',    'solar',   'https://electrek.co',                 'https://electrek.co/feed/',                       '{rss,gnews}'),
('pv magazine USA',     'news',    'solar',   'https://pv-magazine-usa.com',         'https://pv-magazine-usa.com/feed/',               '{rss,gnews}'),
('Canary Media',        'news',    'solar',   'https://www.canarymedia.com',         'https://www.canarymedia.com/rss.rss',             '{rss,gnews}'),
('Utility Dive',        'news',    'solar',   'https://www.utilitydive.com',         'https://www.utilitydive.com/feeds/news/',         '{rss,gnews}'),
('CleanTechnica',       'news',    'solar',   'https://cleantechnica.com',           'https://cleantechnica.com/feed/',                 '{rss,gnews}'),
('Solar Power World',   'news',    'solar',   'https://www.solarpowerworldonline.com','https://www.solarpowerworldonline.com/feed/',    '{rss,gnews}'),
('Will Prowse',         'youtube', 'solar',   'https://www.youtube.com/@WillProwse', 'https://www.youtube.com/feeds/videos.xml?channel_id=UCoj6RxIAQq8kmJme-5dnN0Q', '{rss}'),
('ElectroBOOM',         'youtube', 'solar',   'https://www.youtube.com/@ElectroBOOM','https://www.youtube.com/feeds/videos.xml?channel_id=UCJ0-OtVpF0wOKEqT2Z1HEtA', '{rss}'),
-- Tech / AI
('Ars Technica',        'news',    'tech',    'https://arstechnica.com',             'https://feeds.arstechnica.com/arstechnica/index', '{rss,gnews}'),
('The Verge',           'news',    'tech',    'https://www.theverge.com',            'https://www.theverge.com/rss/index.xml',          '{rss,gnews}'),
('Hacker News',         'news',    'tech',    'https://news.ycombinator.com',        'https://news.ycombinator.com/rss',                '{rss}'),
('Anthropic',           'blog',    'tech',    'https://www.anthropic.com',           null,                                              '{gnews,sitemap}'),
('Simon Willison',      'blog',    'tech',    'https://simonwillison.net',           'https://simonwillison.net/atom/everything/',      '{rss}'),
('Technology Connections','youtube','tech',   'https://www.youtube.com/@TechnologyConnections','https://www.youtube.com/feeds/videos.xml?channel_id=UCy0tKL1T7wFoYcxCe0xjN6Q', '{rss}'),
('Two Minute Papers',   'youtube', 'tech',    'https://www.youtube.com/@TwoMinutePapers','https://www.youtube.com/feeds/videos.xml?channel_id=UCbfYPyITQ-7l4upoX8nvctg', '{rss}'),
('Fireship',            'youtube', 'tech',    'https://www.youtube.com/@Fireship',   'https://www.youtube.com/feeds/videos.xml?channel_id=UCsBjURrPoezykLs9EqgamOA', '{rss}'),
('MKBHD',               'youtube', 'tech',    'https://www.youtube.com/@mkbhd',      'https://www.youtube.com/feeds/videos.xml?channel_id=UCBJycsmduvYEL83R_U4JriQ', '{rss}'),
-- National / world
('AP News',             'news',    'world',   'https://apnews.com',                  null,                                              '{gnews,sitemap}'),
('NPR',                 'news',    'world',   'https://www.npr.org',                 'https://feeds.npr.org/1001/rss.xml',              '{rss,gnews}'),
('BBC World',           'news',    'world',   'https://www.bbc.com',                 'https://feeds.bbci.co.uk/news/world/rss.xml',     '{rss,gnews}'),
('PBS NewsHour',        'news',    'world',   'https://www.pbs.org/newshour',        'https://www.pbs.org/newshour/feeds/rss/headlines','{rss,gnews}'),
('Reuters',             'news',    'world',   'https://www.reuters.com',             null,                                              '{gnews}'),
-- Local SW Florida
('WINK News',           'news',    'swfl',    'https://www.winknews.com',            null,                                              '{gnews,sitemap,scrape}'),
('News-Press',          'news',    'swfl',    'https://www.news-press.com',          null,                                              '{gnews,sitemap}'),
('Gulf Coast News',     'news',    'swfl',    'https://gulfcoastnewsnow.com',        null,                                              '{gnews,sitemap,scrape}'),
('NBC2',                'news',    'swfl',    'https://www.nbc-2.com',               null,                                              '{scrape,sitemap,gnews}'),
('Fox 4 Now',           'news',    'swfl',    'https://www.fox4now.com',             null,                                              '{gnews,sitemap,scrape}'),
('Ryan Hall, Y''all',   'youtube', 'swfl',    'https://www.youtube.com/@ryanhallyall','https://www.youtube.com/feeds/videos.xml?channel_id=UCJHAT3Uvv-g3I8H3GhHWV7w', '{rss}'),
-- Travel
('Atlas Obscura',       'news',    'travel',  'https://www.atlasobscura.com',        'https://www.atlasobscura.com/feeds/latest',       '{rss,gnews}'),
('AFAR',                'news',    'travel',  'https://www.afar.com',                'https://www.afar.com/rss',                        '{rss,gnews}'),
('Lonely Planet',       'news',    'travel',  'https://www.lonelyplanet.com',        null,                                              '{gnews,sitemap}'),
-- Vermont
('VTDigger',            'news',    'vermont', 'https://vtdigger.org',                'https://vtdigger.org/feed/',                      '{rss,gnews}'),
('Seven Days',          'news',    'vermont', 'https://www.sevendaysvt.com',         'https://www.sevendaysvt.com/vermont/Rss.xml',     '{rss,gnews}'),
('Vermont Public',      'news',    'vermont', 'https://www.vermontpublic.org',       null,                                              '{gnews,sitemap}')
on conflict do nothing;

update public.tangent_sources set selectors = '{"list": "a[href^=\"/article/\"]"}'::jsonb where name = 'NBC2';
