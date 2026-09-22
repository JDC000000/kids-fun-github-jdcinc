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

/**
 * Read a single cookie value from a `Headers` object. Returns undefined when absent OR when the
 * value is not valid percent-encoding.
 *
 * ═══ 🔴 F1 (2026-09-22 independent recheck): decodeURIComponent WAS UNGUARDED HERE ═══
 * `kf_anon_id=%` or any other malformed percent-sequence made THIS THROW, uncaught, before
 * searchGet's own try/catch could see it — a 500 on every request carrying it, directly violating
 * lib/security/search-rate-limit.ts's own stated "never throws" invariant one call up the stack
 * (it never even got the chance to run), and — because app/api/search/route.ts's error path
 * `await`s a Sentry flush — a cheap way to make every 500 slower than it needs to be. A malformed
 * cookie is not an attack signature worth surfacing at all; it degrades to "no cookie", exactly
 * like a missing one, via the same `readCookie(...) ?? null` callers already use.
 *
 * Takes `Headers` (not `Request`) so the same function serves a route handler's `request.headers`
 * AND `next/headers`'s `headers()` result in a server component (app/search/page.tsx) — both
 * satisfy the standard `Headers` interface.
 */
export function readCookie(headers: Headers, name: string): string | undefined {
  const header = headers.get('cookie');
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return undefined; // malformed percent-encoding — treat as absent, never throw
      }
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
 * caller) and forward the ones that carry identity onto the outgoing fetch.
 *
 * ═══ 🟠 F2 (2026-09-22 independent recheck): ONLY the named cookie, NEVER THE WHOLE JAR ═══
 * The first version forwarded the raw `cookie` header verbatim — the visitor's ENTIRE cookie jar,
 * including any httpOnly auth/admin-session cookie, to a URL this app's own code assembles (see
 * app/search/page.tsx's `baseUrl`, and the "safe because same-origin" argument that fix's own
 * header comment made). That argument is only as good as same-origin-ness actually being
 * enforced rather than inferred from an attacker-influenced header — see `baseUrl`'s header for
 * the companion fix (a CONFIGURED target URL, never derived from `Host`). Even with that fixed,
 * forwarding only the ONE cookie this call actually needs is the second, independent layer: a
 * mistake in `baseUrl` in the future costs a leaked `kf_anon_id` (already a non-secret, non-PII
 * value by design — lib/db/session.ts) instead of a leaked session/admin cookie. `sessionCookieName`
 * is a parameter, not a hardcoded `kf_anon_id`, so this module stays free of a dependency on
 * lib/db/session.ts's constant while still only ever forwarding exactly what the caller names.
 *
 * `extra` merges in caller-specific headers (e.g. `accept`) without a second object spread at
 * every call site.
 */
export function forwardedIdentityHeaders(
  incoming: Headers,
  sessionCookieName: string,
  extra: Record<string, string> = {}
): HeadersInit {
  const out: Record<string, string> = { ...extra };
  const sessionId = readCookie(incoming, sessionCookieName);
  if (sessionId !== undefined) out.cookie = `${sessionCookieName}=${encodeURIComponent(sessionId)}`;
  const forwardedFor = incoming.get('x-forwarded-for');
  if (forwardedFor) out['x-forwarded-for'] = forwardedFor;
  const realIp = incoming.get('x-real-ip');
  if (realIp) out['x-real-ip'] = realIp;
  return out;
}
