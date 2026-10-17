// GET /api/chart?sym=VOO&range=1d
// Price history for the Stocks tab, normalized to { name, last, prev, points: [[ms, price]], source, delayed }.
// Tries Yahoo first (covers everything), then free fallbacks: Nasdaq for stocks, ETFs and the
// Nasdaq Composite, CBOE for the Dow (DJX x 100) and S&P 500 intraday. CBOE has no S&P 500
// history, so longer S&P ranges fall back to SPY's history scaled to the live index level.
// "prev" is always the previous close, for the day's change.

const SYMS = {
  SPX:  { name: "S&P 500",        yahoo: "^GSPC", cboe: "_SPX", proxy: ["SPY", "etf"] },
  COMP: { name: "Nasdaq",         yahoo: "^IXIC", nasdaq: ["COMP", "index"] },
  DJI:  { name: "Dow Jones",      yahoo: "^DJI",  cboe: "_DJX", cboeScale: 100,        nasdaq: null },
  SCHB: { name: "Schwab US Broad Market", yahoo: "SCHB", nasdaq: ["SCHB", "etf"] },
  VOO:  { name: "Vanguard S&P 500", yahoo: "VOO", nasdaq: ["VOO", "etf"] },
  KO:   { name: "Coca-Cola",      yahoo: "KO",    nasdaq: ["KO", "stocks"] },
};
const RANGES = {
  "1d": { yahoo: "range=1d&interval=5m", days: 1, ttl: 60 },
  "7d": { yahoo: "range=7d&interval=30m", days: 7, ttl: 300 },
  "1m": { yahoo: "range=1mo&interval=1d", days: 31, ttl: 900 },
  "6m": { yahoo: "range=6mo&interval=1d", days: 183, ttl: 3600 },
  "1y": { yahoo: "range=1y&interval=1d", days: 366, ttl: 3600 },
  "5y": { yahoo: "range=5y&interval=1wk", days: 1827, ttl: 3600 },
};
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const getJSON = async (url, headers = {}) => {
  const r = await fetch(url, { headers: { "user-agent": UA, accept: "application/json", ...headers } });
  if (!r.ok) throw new Error(`${new URL(url).host} ${r.status}`);
  const t = await r.text();
  if (!t) throw new Error(`${new URL(url).host} empty`);
  return JSON.parse(t);
};
const ymd = d => d.toISOString().slice(0, 10);

async function yahoo(s, rg) {
  const j = await getJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s.yahoo)}?${rg.yahoo}&includePrePost=false`);
  const res = j.chart?.result?.[0];
  if (!res) throw new Error("yahoo no result");
  const close = res.indicators.quote[0].close;
  const points = res.timestamp.map((t, i) => [t * 1000, close[i]]).filter(p => p[1] != null);
  const m = res.meta;
  // chartPreviousClose is the close before the range starts, so it is only the prior close for 1d.
  const prev = rg.days === 1 ? m.chartPreviousClose : m.regularMarketPreviousClose ?? m.previousClose ?? points.at(-2)[1];
  return { last: m.regularMarketPrice, prev, points, source: "Yahoo" };
}

async function nasdaq(s, rg) {
  const [sym, cls] = s.nasdaq;
  const now = new Date();
  const q = rg.days === 1 ? "" : `&fromdate=${ymd(new Date(now - rg.days * 864e5))}&todate=${ymd(now)}`;
  const j = await getJSON(`https://api.nasdaq.com/api/quote/${sym}/chart?assetclass=${cls}${q}`, { origin: "https://www.nasdaq.com", referer: "https://www.nasdaq.com/" });
  const d = j.data;
  if (!d?.chart?.length) throw new Error("nasdaq empty");
  // Intraday rows can arrive out of order (the series wraps), so sort by time.
  let points = d.chart.map(c => [c.x, c.y]).sort((a, b) => a[0] - b[0]);
  if (rg.days === 1) {
    // Intraday includes pre and post market; keep the regular session (x is exchange-local time as UTC ms).
    points = points.filter(([x]) => { const m = new Date(x).getUTCHours() * 60 + new Date(x).getUTCMinutes(); return m >= 570 && m <= 960; });
  }
  const num = v => parseFloat(String(v).replace(/[$,]/g, ""));
  const last = num(d.lastSalePrice);
  return { last, prev: last - num(d.netChange), points, source: "Nasdaq" };
}

async function cboe(s, rg) {
  const kind = rg.days === 1 ? "intraday" : "historical";
  const j = await getJSON(`https://cdn-api.cboe.com/api/global/delayed_quotes/charts/${kind}/${s.cboe}.json`);
  const k = s.cboeScale || 1;
  let points;
  if (kind === "intraday") {
    points = j.data.map(r => [Date.parse(r.datetime + "Z"), r.price.close * k]);
  } else {
    const from = Date.now() - rg.days * 864e5;
    points = j.data.map(r => [Date.parse(r.date + "T16:00:00Z"), +r.close * k]).filter(p => p[0] >= from);
  }
  if (points.length < 2) throw new Error("cboe empty");
  const last = points.at(-1)[1];
  let prev = points.at(-2)[1];
  if (kind === "historical" && rg.days > 400) points = points.filter((_, i) => i % 5 === 0 || i === points.length - 1);
  if (kind === "intraday") {
    const h = await getJSON(`https://cdn-api.cboe.com/api/global/delayed_quotes/charts/historical/${s.cboe}.json`).catch(() => null);
    const rows = h?.data || [];
    // Previous close is the last daily row dated before today's session.
    const day = j.data[0].datetime.slice(0, 10);
    const before = rows.filter(r => r.date < day).at(-1);
    if (before) prev = +before.close * k;
    // No index history (S&P 500): take today's % move from the tracking ETF.
    else if (s.proxy) {
      const etf = await nasdaq({ nasdaq: s.proxy }, RANGES["1d"]);
      prev = last / (etf.last / etf.prev);
    }
  }
  return { last, prev, points, source: "CBOE" };
}

// Shape of SPY's history, at the S&P 500's level (ratio taken from today's prices).
async function proxyScaled(s, rg) {
  const idx = await cboe(s, RANGES["1d"]);
  const etf = await nasdaq({ nasdaq: s.proxy }, rg);
  const etfNow = await nasdaq({ nasdaq: s.proxy }, RANGES["1d"]);
  const k = idx.last / etfNow.last;
  const points = etf.points.map(([t, v]) => [t, v * k]);
  points.push([Date.now(), idx.last]);
  return { last: idx.last, prev: idx.prev, points, source: `${s.proxy[0]} scaled` };
}

export async function onRequestGet({ request, waitUntil }) {
  const url = new URL(request.url);
  const key = (url.searchParams.get("sym") || "").toUpperCase();
  const range = url.searchParams.get("range") || "1d";
  const s = SYMS[key], rg = RANGES[range];
  if (!s || !rg) return Response.json({ error: "unknown sym or range" }, { status: 400 });

  const cache = caches.default;
  const cacheKey = new Request(`https://tangent-cache/chart/${key}/${range}`);
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const tries = [() => yahoo(s, rg)];
  if (s.nasdaq) tries.push(() => nasdaq(s, rg));
  if (s.cboe && (rg.days === 1 || !s.proxy)) tries.push(() => cboe(s, rg));
  if (s.proxy) tries.push(() => proxyScaled(s, rg));
  const errors = [];
  for (const t of tries) {
    try {
      const out = await t();
      if (out.points.length < 2) throw new Error(`${out.source} too few points`);
      const res = Response.json({ sym: key, name: s.name, range, ...out, delayed: true }, {
        headers: { "cache-control": `public, max-age=${rg.ttl}` },
      });
      waitUntil(cache.put(cacheKey, res.clone()));
      return res;
    } catch (e) {
      errors.push(e.message);
    }
  }
  return Response.json({ sym: key, name: s.name, range, error: errors.join("; ") }, { status: 502 });
}
