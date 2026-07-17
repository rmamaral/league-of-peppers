/* Roll counter API for league-of-peppers.com
 *
 * GET  /count  -> { total }            read-only, no side effects
 * POST /count  -> { total }            increment, then return the new total
 *
 * State lives in a single KV key. KV is eventually consistent, so the number a
 * visitor sees can lag a few seconds behind the true total. That is fine for a
 * vanity counter; do not use it for anything that needs to be exact.
 *
 * There is no auth and no server-side rate limit: anyone can POST. A KV-based
 * throttle was tried and removed — KV's minimum expirationTtl is 60s, which
 * capped real users at one roll per minute. Since an unauthenticated public
 * endpoint can't be meaningfully protected from inflation anyway, the honest
 * move is to not pretend. The client debounces to avoid double-counting a
 * double-click; that is all. Treat the total as decoration, not analytics —
 * Cloudflare Web Analytics has the real traffic numbers.
 */

const KEY = 'rolls:total';
const ALLOWED_ORIGINS = new Set([
  'https://league-of-peppers.com',
  'https://www.league-of-peppers.com',
  'http://localhost:8000',
]);

const corsHeaders = (origin) => ({
  'Access-Control-Allow-Origin': ALLOWED_ORIGINS.has(origin) ? origin : 'https://league-of-peppers.com',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
});

const json = (body, origin, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...corsHeaders(origin),
    },
  });

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (url.pathname !== '/count') {
      return json({ error: 'not found' }, origin, 404);
    }

    if (request.method === 'GET') {
      const total = Number((await env.COUNTER.get(KEY)) || 0);
      return json({ total }, origin);
    }

    if (request.method === 'POST') {
      // Read-modify-write: concurrent rolls can overwrite each other, so the
      // total undercounts slightly under load. Durable Objects would fix this;
      // for a vanity counter the lost writes are not worth the complexity.
      const total = Number((await env.COUNTER.get(KEY)) || 0) + 1;
      await env.COUNTER.put(KEY, String(total));
      return json({ total }, origin);
    }

    return json({ error: 'method not allowed' }, origin, 405);
  },
};
