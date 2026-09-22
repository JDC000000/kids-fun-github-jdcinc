// lib/http/request-context.ts — small, shared helpers for reading identity out of a raw
// `Request` in a route handler, with no framework dependency (`next/headers` needs a request
// scope; this works from a plain `Request` object, which is what both app/api/search/route.ts
// and app/api/analytics/event/route.ts already receive).
//
// Extracted rather than left duplicated: app/api/analytics/event/route.ts had its own private
// `readCookie`. One copy, one thing to get right about cookie parsing (a `=` inside a value,
// surrounding whitespace, `decodeURIComponent` on the value only).
//
// ═══ CLIENT-IP READING LIVES IN lib/sms/client-ip.ts, NOT HERE ═══
// An earlier version of this file had its own `clientIp()` that preferred `x-forwarded-for`'s
// first entry over `x-real-ip` — the OPPOSITE order from lib/sms/client-ip.ts's `clientIpFrom`,
// which deliberately prefers `x-real-ip` (the one value Vercel's edge resolves itself, with the
// least room for a caller to prepend an entry — see that file's header for the full argument).
// Two IP readers with different precedence is exactly the kind of silent divergence
// lib/sms/client-ip.ts's own header warns about ("two copies... a second implementation that
// hashed the whole forwarded-for chain instead of its leftmost entry would still compile, still
// populate the table, and simply count nothing"). Callers here now import `clientIpFrom` from
// that module directly — see app/api/search/route.ts.

/** Read a single cookie value from the request header. Returns undefined when absent. */
export function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get('cookie');
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return undefined;
}

/**
 * Build the header set for an internal, SAME-ORIGIN server-to-server fetch that needs the REAL
 * visitor's identity to survive the hop — e.g. app/search/page.tsx's server component fetching
 * its own `/api/search` route.
 *
 * ═══ WHY THIS EXISTS — THE BUG IT FIXES ═══
 * Node's `fetch()` has no browser cookie jar and no knowledge of the inbound request it is
 * running inside. A plain `fetch(url, { headers: { accept: ... } })` from inside a server
 * component therefore carries NONE of the original visitor's identity: no cookie (so no
 * `kf_anon_id`), no `x-forwarded-for`/`x-real-ip` (so no client IP either). To the route handler
 * on the other end, that request is indistinguishable from the server talking to itself.
 * lib/security/search-rate-limit.ts's whole enforcement depends on reading a real session/IP
 * off the incoming `Request` — without this, EVERY page-originated search shares one degenerate
 * "identity" (or none at all), which is exactly backwards: it either rate-limits/flags every real
 * visitor as one shared bucket, or silently no-ops (degradedReason: 'no_subject') depending on
 * deployment topology. Neither is caught by a test that always passes an explicit session id.
 *
 * The fix: read the INCOMING request's own headers (via `next/headers` `headers()` in the
 * caller) and forward the ones that carry identity — verbatim, not recomputed — onto the outgoing
 * fetch. This is safe specifically BECAUSE the fetch is same-origin (this app calling its own
 * route): there is no cross-origin cookie leak, the same trust boundary already applies.
 *
 * `extra` merges in caller-specific headers (e.g. `accept`) without a second object spread at
 * every call site.
 */
export function forwardedIdentityHeaders(incoming: Headers, extra: Record<string, string> = {}): HeadersInit {
  const out: Record<string, string> = { ...extra };
  const cookie = incoming.get('cookie');
  if (cookie) out.cookie = cookie;
  const forwardedFor = incoming.get('x-forwarded-for');
  if (forwardedFor) out['x-forwarded-for'] = forwardedFor;
  const realIp = incoming.get('x-real-ip');
  if (realIp) out['x-real-ip'] = realIp;
  return out;
}
