// Shared HTTP client. Uses a real browser user agent, follows redirects, and
// honors HTTPS_PROXY when one is set (local dev); GitHub Actions has none.
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

if (process.env.HTTPS_PROXY || process.env.https_proxy) setGlobalDispatcher(new EnvHttpProxyAgent());

export const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

export async function get(url, opts = {}) {
  const r = await getOnce(url, opts);
  // One polite retry on rate limits.
  if (r.status === 429 || r.status === 419 || r.status === 503) {
    await new Promise(ok => setTimeout(ok, 3000));
    return getOnce(url, opts);
  }
  return r;
}

async function getOnce(url, { timeout = 15000, headers = {}, method = "GET", body } = {}) {
  const res = await fetch(url, {
    method,
    body,
    redirect: "follow",
    signal: AbortSignal.timeout(timeout),
    headers: {
      "user-agent": UA,
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,application/rss+xml,*/*;q=0.8",
      "accept-language": "en-US,en;q=0.9",
      ...headers,
    },
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, url: res.url, text };
}

// Run fn over items with at most n in flight.
export async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        try { out[k] = await fn(items[k], k); } catch (e) { out[k] = { error: e }; }
      }
    })
  );
  return out;
}
