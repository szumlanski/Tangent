// One address for Tangent: page loads on www.tangentreads.com or the old tangent.szumlanski.com get a
// permanent redirect to tangentreads.com (path, query and all). API calls pass through untouched, so an
// open tab on an old address keeps working until it reloads. app/_routes.json limits this to pages.
export const CANONICAL = "tangentreads.com";
const OLD = new Set(["www.tangentreads.com", "tangent.szumlanski.com"]);

export function redirectFor(request) {
  const url = new URL(request.url);
  if (!OLD.has(url.hostname) || !["GET", "HEAD"].includes(request.method) || url.pathname.startsWith("/api/")) return null;
  url.hostname = CANONICAL; url.protocol = "https:"; url.port = "";
  return Response.redirect(url.toString(), 301);
}

export const onRequest = ctx => redirectFor(ctx.request) || ctx.next();
