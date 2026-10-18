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
('Hacker News',         'news',    'tech',    'https://news.ycombinator.com',        'https://hnrss.org/frontpage?points=100',          '{rss}'),
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

-- Sports highlights (Sports tab)
insert into public.tangent_sources (name, kind, topic, site_url, feed_url, strategies) values
('NFL','youtube','sports','https://www.youtube.com/@NFL','https://www.youtube.com/feeds/videos.xml?channel_id=UCDVYQ4Zhbm3S2dlz7P1GBDg','{rss}'),
('ESPN College Football','youtube','sports','https://www.youtube.com/@ESPNCFB','https://www.youtube.com/feeds/videos.xml?channel_id=UCzRWWsFjqHk1an4OnVPsl9g','{rss}'),
('House of Highlights','youtube','sports','https://www.youtube.com/@HouseofHighlights','https://www.youtube.com/feeds/videos.xml?channel_id=UCqQo7ewe87aYAe7ub5UqXMw','{rss}'),
('NBA','youtube','sports','https://www.youtube.com/@NBA','https://www.youtube.com/feeds/videos.xml?channel_id=UCWJ2lWNubArHWmf3FIHbfcQ','{rss}'),
('MLB','youtube','sports','https://www.youtube.com/@MLB','https://www.youtube.com/feeds/videos.xml?channel_id=UCoLrcjPV5PbUrUyXq5mjc_A','{rss}'),
('Florida Gators','youtube','sports','https://www.youtube.com/@FloridaGators','https://www.youtube.com/feeds/videos.xml?channel_id=UC97IlakvONh8RBUODRuk4mA','{rss}'),
('MLS','youtube','sports','https://www.youtube.com/@MLS','https://www.youtube.com/feeds/videos.xml?channel_id=UCSZbXT5TLLW_i-5W8FZpFsg','{rss}')
on conflict do nothing;

-- 2026-10-18: more sources per topic (each vetted: feed found, posting weekly, free, readable).
-- Subscriber papers (access = 'subscriber') show headlines only and link out.
insert into public.tangent_sources (name, kind, topic, site_url, feed_url, strategies, selectors, access) values
('Valley News','news','vermont','https://www.vnews.com','https://vnews.com/feed/','{rss,gnews}',null,'free'),
('WCAX','news','vermont','https://www.wcax.com','https://www.wcax.com/arc/outboundfeeds/rss/?outputType=xml','{rss,gnews}',null,'free'),
('NBC5 Vermont','news','vermont','https://www.mynbc5.com',null,'{scrape,gnews}','{"list": "a[href^=\"/article/\"]"}','free'),
('Rutland Herald','news','vermont','https://www.rutlandherald.com',null,'{gnews,sitemap}',null,'free'),
('Times Argus','news','vermont','https://www.timesargus.com','https://www.timesargus.com/search/?f=rss&t=article&l=50&s=start_time&sd=desc','{rss,gnews}',null,'free'),
('Addison Independent','news','vermont','https://www.addisonindependent.com','https://www.addisonindependent.com/feed/','{rss,gnews}',null,'free'),
('Mountain Times','news','vermont','https://mountaintimes.info','https://mountaintimes.info/feed/','{rss,gnews}',null,'free'),
('Vermont Daily Chronicle','news','vermont','https://vermontdailychronicle.com','https://vermontdailychronicle.com/feed/','{rss}',null,'free'),
('Vermont Cynic','news','vermont','https://vtcynic.com','https://vtcynic.com/feed/','{rss}',null,'free'),
('The Charlotte News','news','vermont','https://www.charlottenewsvt.org','https://www.charlottenewsvt.org/feed/','{rss}',null,'free'),
('Manchester Journal','news','vermont','https://www.manchesterjournal.com','https://manchesterjournal.com/local-news/?lab_viewport=rss','{rss}',null,'subscriber'),
('Bennington Banner','news','vermont','https://www.benningtonbanner.com','https://benningtonbanner.com/local-news/?lab_viewport=rss','{rss}',null,'subscriber'),
('Brattleboro Reformer','news','vermont','https://www.reformer.com','https://reformer.com/local-news/?lab_viewport=rss','{rss}',null,'subscriber'),
('ESS News','news','solar','https://www.ess-news.com','https://www.ess-news.com/feed/','{rss,gnews}',null,'free'),
('Solar Builder','news','solar','https://solarbuildermag.com','https://solarbuildermag.com/feed','{rss,gnews}',null,'free'),
('TechCrunch','news','tech','https://techcrunch.com','https://techcrunch.com/feed/','{rss,gnews}',null,'free'),
('Engadget','news','tech','https://www.engadget.com','https://www.engadget.com/category/news/feed/','{rss,gnews}',null,'free'),
('The Register','news','tech','https://www.theregister.com','https://www.theregister.com/feed','{rss,gnews}',null,'free'),
('9to5Google','news','tech','https://9to5google.com','https://9to5google.com/feed/','{rss}',null,'free'),
('9to5Mac','news','tech','https://9to5mac.com','https://9to5mac.com/feed/','{rss}',null,'free'),
('VentureBeat','news','tech','https://venturebeat.com',null,'{gnews,sitemap}',null,'free'),
('Al Jazeera','news','world','https://www.aljazeera.com','https://www.aljazeera.com/xml/rss/all.xml','{rss,gnews}',null,'free'),
('The Guardian','news','world','https://www.theguardian.com/world','https://www.theguardian.com/world/rss','{rss}',null,'free'),
('DW','news','world','https://www.dw.com/en','https://rss.dw.com/rdf/rss-en-all','{rss}',null,'free'),
('CBS News','news','world','https://www.cbsnews.com','https://www.cbsnews.com/latest/rss/main','{rss,gnews}',null,'free'),
('ABC News','news','world','https://abcnews.go.com','https://abcnews.go.com/abcnews/topstories','{rss,gnews}',null,'free'),
('Cape Coral Breeze','news','swfl','https://www.capecoralbreeze.com','https://www.capecoralbreeze.com/feed','{rss,gnews}',null,'free'),
('WGCU','news','swfl','https://www.wgcu.org',null,'{gnews,sitemap}',null,'free'),
('Gulfshore Business','news','swfl','https://www.gulfshorebusiness.com',null,'{gnews,sitemap}',null,'free'),
('Sanibel-Captiva Islander','news','swfl','https://www.captivasanibel.com','https://www.captivasanibel.com/feed','{rss,gnews}',null,'free'),
('Conde Nast Traveler','news','travel','https://www.cntraveler.com','https://www.cntraveler.com/feed/rss','{rss,gnews}',null,'free'),
('Matador Network','news','travel','https://matadornetwork.com','https://matadornetwork.com/feed','{rss,gnews}',null,'free'),
('Travel Off Path','news','travel','https://www.traveloffpath.com','https://www.traveloffpath.com/feed/','{rss}',null,'free'),
('The Points Guy','news','travel','https://thepointsguy.com','https://thepointsguy.com/feed','{rss,gnews}',null,'free')
on conflict do nothing;
