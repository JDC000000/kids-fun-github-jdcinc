// tests/sms/preferences_headers.test.ts — the response headers protecting /u/[preferencesToken].
//
// ═══ WHY THIS FILE EXISTS: THE COMMENT WAS TRUE AND THE CODE WAS NOT ═══
// app/u/[preferencesToken]/page.tsx's header block described three protections — `noindex`,
// `no-store` and `no-referrer` — and explained, correctly, why each mattered. Only the first was
// implemented (via `metadata.robots`). The other two were never set anywhere, so the page linked
// out to each of last week's picks while sending the full referring URL — TOKEN INCLUDED — to
// whatever site the parent tapped through to. The token is the sole bearer credential for reading
// a subscriber's data, editing it and unsubscribing.
//
// A documented invariant is not an invariant. These assertions are what makes it one.
import { describe, expect, it } from 'vitest';

interface HeaderRule {
  source: string;
  headers: Array<{ key: string; value: string }>;
}
interface NextConfigLike {
  headers?: () => Promise<HeaderRule[]>;
}

/**
 * THE REAL next.config.mjs, and Next's OWN path matcher.
 *
 * Both are untyped from TypeScript's point of view — Next ships `path-to-regexp` as a compiled
 * internal with no declarations, and the config is plain JS — so each is loaded dynamically and
 * narrowed to the shape this test actually relies on, written down rather than left as `any`.
 *
 * Loading the real config matters: a test against a hand-copied literal would keep passing after
 * somebody edited or deleted the rule it is meant to protect.
 */
async function loadConfig(): Promise<NextConfigLike> {
  const mod = (await import('../../next.config.mjs')) as unknown as {
    default?: NextConfigLike;
  } & NextConfigLike;
  return mod.default ?? mod;
}

async function loadMatcher(): Promise<(source: string) => RegExp> {
  return (await import('next/dist/compiled/path-to-regexp')).pathToRegexp;
}

/** The route we are protecting, and routes that must not be caught by accident. */
const HUB_PATH = '/u/alice-token-0123456789abcdef';

async function rules(): Promise<HeaderRule[]> {
  const config = await loadConfig();
  expect(typeof config.headers).toBe('function');
  return config.headers!();
}

async function hubHeaders(): Promise<Map<string, string>> {
  const pathToRegexp = await loadMatcher();
  const matched = new Map<string, string>();
  for (const rule of await rules()) {
    if (pathToRegexp(rule.source).test(HUB_PATH)) {
      for (const h of rule.headers) matched.set(h.key.toLowerCase(), h.value);
    }
  }
  return matched;
}

describe('/u/[preferencesToken] response headers', () => {
  it('sets Referrer-Policy: no-referrer — the header that closes the token leak', async () => {
    // THE LIVE BUG THIS FIXES. Every outbound link on this page (an activity's own booking page,
    // reachable from the last-week's-picks panel) would otherwise hand the full URL, token
    // included, to that third party in the Referer header — a working credential for somebody
    // else's subscription, delivered to a rec centre's analytics.
    // app/s/[shortId]/route.ts already sets this on its redirect. This page only claimed to.
    expect((await hubHeaders()).get('referrer-policy')).toBe('no-referrer');
  });

  it('sets Cache-Control: no-store — the rendered HTML holds a child\'s ages', async () => {
    // On a shared or family computer the back button must not resurrect them.
    expect((await hubHeaders()).get('cache-control')).toBe('no-store, max-age=0');
  });

  // ═══ THE 2026-08-28 HARDENING (8eaa51e) ═══
  // Same reasoning as the two above, and the same reason for asserting it: this block was added
  // with a long comment explaining each choice, and a comment is exactly what the header at the
  // top of this file says is not an invariant.

  it('🔴 refuses to be framed — via BOTH mechanisms, not just the modern one', async () => {
    // A clickjacked preferences page is a clickjacked UNSUBSCRIBE and DELETE, both one click with
    // no confirmation and no login behind them. The two headers say the same thing to different
    // generations of browser, so dropping either one silently narrows the protection to a subset
    // of visitors — which is the kind of regression nothing else would surface.
    const h = await hubHeaders();
    expect(h.get('content-security-policy')).toBe("frame-ancestors 'none'");
    expect(h.get('x-frame-options')).toBe('DENY');
  });

  it('sets X-Content-Type-Options: nosniff', async () => {
    expect((await hubHeaders()).get('x-content-type-options')).toBe('nosniff');
  });

  it('sets HSTS with NO preload and NO includeSubDomains — the irreversible parts', async () => {
    // Deliberate scope, asserted because it is far easier to "strengthen" this line than to undo
    // it. `preload` is effectively PERMANENT once the domain is submitted to the browser list, and
    // `includeSubDomains` makes a commitment on behalf of every subdomain this config does not own
    // — including any plain-HTTP internal host. Adding either should be a decision someone argues
    // for, not a tidy-up that passes review because it looks like more security.
    const hsts = (await hubHeaders()).get('strict-transport-security');
    expect(hsts).toBe('max-age=31536000');
    expect(hsts).not.toContain('preload');
    expect(hsts).not.toContain('includeSubDomains');
  });

  it('the CSP is frame-ancestors ONLY — a guessed script-src must not appear by accident', async () => {
    // Recorded as a decision, not an oversight. `frame-ancestors` is the one directive that cannot
    // break rendering, because it constrains who may EMBED the page rather than what the page may
    // LOAD. A script-src/style-src policy has to be built against Next's inline runtime and nonce
    // handling and verified in a real browser; a guessed one silently breaks the app's own scripts,
    // which is worse than the gap it closes.
    //
    // So this assertion is a TRIPWIRE, not a ceiling: when the real CSP pass happens it SHOULD fail
    // here, and whoever does it should update this test having verified the policy in a browser.
    const csp = (await hubHeaders()).get('content-security-policy') ?? '';
    expect(csp).not.toMatch(/script-src|style-src|default-src/);
  });

  it('the rule matches the dynamic segment, and only it', async () => {
    // A `source` that silently matched nothing would leave the headers un-set with every
    // assertion above still passing against the literal config. So the pattern itself is
    // exercised with Next's own path matcher.
    const pathToRegexp = await loadMatcher();
    const sources = (await rules()).map((r) => pathToRegexp(r.source));
    const matchesAny = (p: string) => sources.some((re) => re.test(p));

    expect(matchesAny('/u/abc')).toBe(true);
    expect(matchesAny(HUB_PATH)).toBe(true);
    // Not the whole site: these headers are for the page that carries a credential in its URL.
    expect(matchesAny('/search')).toBe(false);
    expect(matchesAny('/u')).toBe(false);
    expect(matchesAny('/u/abc/extra')).toBe(false);
  });

  it('is configured in next.config, not in middleware.ts', async () => {
    // Recorded as a decision. middleware.ts exists for an unrelated analytics-cookie concern and
    // is owned by another workstream; a Server Component page cannot set response headers itself.
    // Next's declarative `headers()` matches dynamic segments and needed neither.
    expect(typeof (await loadConfig()).headers).toBe('function');
  });
});
