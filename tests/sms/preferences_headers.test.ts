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
/** The other SMS-facing pages, which share the same policy. */
const SIGNUP = '/sms/signup';
const START = '/sms/start';

async function rules(): Promise<HeaderRule[]> {
  const config = await loadConfig();
  expect(typeof config.headers).toBe('function');
  return config.headers!();
}

/** Every header that would actually be sent for `path`, collected across all matching rules. */
async function headersFor(path: string): Promise<Map<string, string>> {
  const pathToRegexp = await loadMatcher();
  const matched = new Map<string, string>();
  for (const rule of await rules()) {
    if (pathToRegexp(rule.source).test(path)) {
      for (const h of rule.headers) matched.set(h.key.toLowerCase(), h.value);
    }
  }
  return matched;
}

const hubHeaders = () => headersFor(HUB_PATH);

/**
 * The CSP as a directive → value map, so assertions can name one directive instead of matching
 * substrings of a 300-character string (where "style-src 'self'" also matches inside
 * "style-src-elem", and a missing directive looks identical to a present-but-empty one).
 */
async function csp(path: string): Promise<Map<string, string>> {
  const raw = (await headersFor(path)).get('content-security-policy') ?? '';
  const out = new Map<string, string>();
  for (const part of raw.split(';')) {
    const [name, ...rest] = part.trim().split(/\s+/);
    if (name) out.set(name.toLowerCase(), rest.join(' '));
  }
  return out;
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
    expect((await csp(HUB_PATH)).get('frame-ancestors')).toBe("'none'");
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

  // ═══ THE FULL POLICY (2026-08-28) ═══
  // The tripwire that used to live here asserted the CSP was frame-ancestors ONLY, and it did its
  // job: it failed the moment the real policy landed. Replaced with assertions on the actual
  // directives rather than loosened, which was the whole point of writing it as an exact check.
  //
  // Every value below was MEASURED against a production build served by `next start` and verified
  // in Chromium, not taken from documentation. See next.config.mjs for the measurements.

  it('locks each directive to the value that was actually verified', async () => {
    const d = await csp(HUB_PATH);
    expect(d.get('default-src')).toBe("'self'");
    expect(d.get('base-uri')).toBe("'self'");
    expect(d.get('object-src')).toBe("'none'");
    expect(d.get('form-action')).toBe("'self'");
    expect(d.get('frame-ancestors')).toBe("'none'");
  });

  it("🔴 style-src does NOT carry 'unsafe-inline' — the measurement earned that", async () => {
    // The browser check found ZERO inline <style> blocks and ZERO style="" attributes on both
    // pages, so this directive can be strict. It is the one that gets weakened by reflex, usually
    // by someone adding a single inline style and loosening the policy to match. If that happens,
    // this test should be the thing that argues back.
    const styleSrc = (await csp(HUB_PATH)).get('style-src') ?? '';
    expect(styleSrc).not.toContain("'unsafe-inline'");
    expect(styleSrc).toContain("'self'");
  });

  it("🔴 style-src and font-src are 'self' ONLY — no third-party font origins", async () => {
    // TIGHTENED 2026-08-28 when Manrope moved to next/font. The policy used to allow
    // fonts.googleapis.com and fonts.gstatic.com for an @import that had never actually loaded;
    // self-hosting removed the request, so the allowance went with it.
    //
    // Asserted as an ABSENCE because the easy regression is re-adding a Google Fonts @import and
    // "fixing" the resulting CSP error by widening the policy back out. The correct fix is
    // next/font, which self-hosts and needs no CSP change — so this test should be what makes
    // someone choose between those two rather than take the quicker-looking one.
    const d = await csp(HUB_PATH);
    expect(d.get('style-src')).toBe("'self'");
    expect(d.get('font-src')).toBe("'self'");
    const raw = (await headersFor(HUB_PATH)).get('content-security-policy') ?? '';
    expect(raw).not.toContain('fonts.googleapis.com');
    expect(raw).not.toContain('fonts.gstatic.com');
  });

  it("🔴 NOTHING anywhere may carry 'unsafe-eval'", async () => {
    // The production bundle demonstrably does not need it — verified in a browser, where the app
    // hydrated and stayed interactive with no eval permitted. `next dev` DOES need it for HMR,
    // which is exactly why the policy was measured against a production build; a policy validated
    // in dev would have carried this permanently for no reason.
    const raw = (await headersFor(HUB_PATH)).get('content-security-policy') ?? '';
    expect(raw).not.toContain('unsafe-eval');
  });

  it("documents that script-src 'unsafe-inline' is a KNOWN weakness, not an oversight", async () => {
    // Asserted in the POSITIVE, deliberately. Next 14's App Router inlines its hydration payload
    // and the content differs per request, so hashes are impossible and the strong fix is a
    // per-request nonce minted in middleware.ts — a file owned by another workstream.
    //   Removing this without doing that work would break the app in production, so the assertion
    //   guards against a well-meaning "tighten the CSP" change. When nonces do land, this test
    //   changes together with them, which is the correct coupling.
    expect((await csp(HUB_PATH)).get('script-src')).toBe("'self' 'unsafe-inline'");
  });

  it('applies the SAME policy to both routes', async () => {
    // One page renders a child's data, the other captures consent. A policy that drifted between
    // them would mean the weaker one silently sets the real security posture.
    const hub = await headersFor(HUB_PATH);
    const signup = await headersFor(SIGNUP);
    expect(signup.get('content-security-policy')).toBe(hub.get('content-security-policy'));
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

describe('/sms/signup response headers — the page where CONSENT is captured', () => {

  it('refuses to be framed, by both mechanisms', async () => {
    // The consent argument, not the clickjacking one. A signup form rendered inside somebody
    // else's frame — their heading, their branding, their surrounding claims — is not obviously
    // the express consent CASL requires a record of. `consent_text_version` pins the WORDING a
    // parent agreed to; nothing can pin the page around it except refusing to be embedded.
    const h = await headersFor(SIGNUP);
    expect((await csp(SIGNUP)).get('frame-ancestors')).toBe("'none'");
    expect(h.get('x-frame-options')).toBe('DENY');
    expect(h.get('x-content-type-options')).toBe('nosniff');
    expect(h.get('strict-transport-security')).toBe('max-age=31536000');
  });

  it('🔴 deliberately does NOT take the hub\'s other two headers', async () => {
    // Asserted as ABSENCES so that "apply the same list everywhere" is a decision someone has to
    // argue for rather than a tidy-up.
    //   no-referrer:  this URL carries no credential, unlike /u/{token}. Nothing to leak.
    //   no-store:     public page, nothing personal in its HTML. Making the product's most
    //                 load-sensitive page uncacheable would buy no privacy — what a parent TYPES
    //                 is protected by a POST over TLS, not by a cache header.
    const h = await headersFor(SIGNUP);
    expect(h.has('referrer-policy')).toBe(false);
    expect(h.has('cache-control')).toBe(false);
  });

  it('shares ONE list with the hub rather than a second copy that can drift', async () => {
    // Two hand-maintained copies of a security header list is how one of them silently stops
    // matching the other. Asserted on the values, which is what a drift would actually change.
    const hub = await hubHeaders();
    const signup = await headersFor(SIGNUP);
    for (const key of [
      'content-security-policy',
      'x-frame-options',
      'x-content-type-options',
      'strict-transport-security',
    ]) {
      expect(signup.get(key), key).toBe(hub.get(key));
    }
  });

  it('still matches nothing it should not', async () => {
    expect((await headersFor('/search')).size).toBe(0);
    expect((await headersFor('/sms/signup/extra')).size).toBe(0);
    // The hub keeps its own two, so adding the signup rule did not widen anything.
    expect((await hubHeaders()).get('cache-control')).toBe('no-store, max-age=0');
  });
});

describe('/sms/start — the minimal landing page gets the SAME protection', () => {
  it('🔴 is not a weaker second front door', async () => {
    // It collects exactly what /sms/signup collects — a phone number, a postal code, a child's age
    // — so shipping it behind thinner headers would quietly undo the reasoning that put them on
    // the first form. Asserted against the hub's values rather than restated, so the three pages
    // cannot drift apart one edit at a time.
    const hub = await headersFor(HUB_PATH);
    const start = await headersFor(START);
    for (const key of [
      'content-security-policy',
      'x-frame-options',
      'x-content-type-options',
      'strict-transport-security',
    ]) {
      expect(start.get(key), key).toBe(hub.get(key));
    }
  });

  it('refuses to be framed — the consent argument, on the page that captures consent', async () => {
    expect((await csp(START)).get('frame-ancestors')).toBe("'none'");
    expect((await headersFor(START)).get('x-frame-options')).toBe('DENY');
  });

  it('takes the same policy as the other signup form, exactly', async () => {
    const signup = await headersFor(SIGNUP);
    const start = await headersFor(START);
    expect(start.get('content-security-policy')).toBe(signup.get('content-security-policy'));
  });

  it('still matches nothing it should not', async () => {
    expect((await headersFor('/sms')).size).toBe(0);
    expect((await headersFor('/sms/started')).size).toBe(0);
  });
});
