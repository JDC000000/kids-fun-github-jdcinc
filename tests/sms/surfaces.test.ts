// tests/sms/surfaces.test.ts — which routes count as the SMS product.
//
// PRD §8 item 4: the shared account nav is hidden on these, because an SMS subscriber has no
// account and offering one invites a data relationship the product deliberately does not need
// (Jon: "let's emphasize capturing the least amount of data we need to provide value").
import { describe, expect, it } from 'vitest';
import { isSmsSurface, hidesAccountNav, hidesSiteChrome, SMS_SURFACE_PREFIXES } from '@/lib/sms/surfaces';

describe('isSmsSurface', () => {
  it('matches every anonymous SMS page', () => {
    for (const path of [
      '/sms/signup',
      '/u/alice-token-0123456789abcdef',
      '/activity-unavailable',
      // The "that link did not work" interstitial (mobile audit, 2026-09-11). An SMS surface by
      // this list's own test: reachable only by redirect from /s/{token}, linked from nowhere else.
      '/link-unavailable',
    ]) {
      expect(isSmsSurface(path), path).toBe(true);
    }
  });

  it('does NOT match the rest of the product', () => {
    // The account nav belongs on all of these — hiding it site-wide was never the ruling.
    for (const path of ['/', '/search', '/account', '/privacy', '/terms', '/activity/abc']) {
      expect(isSmsSurface(path), path).toBe(false);
    }
  });

  it('does not sweep in a future route that merely starts with the same letters', () => {
    // `/u/` keeps its trailing slash for exactly this reason.
    expect(isSmsSurface('/updates')).toBe(false);
    expect(isSmsSurface('/user-guide')).toBe(false);
  });

  it('handles a null pathname without throwing', () => {
    // `usePathname()` is typed as string, but a component that guesses wrong here would crash the
    // whole shell rather than just the nav.
    expect(isSmsSurface(null)).toBe(false);
    expect(isSmsSurface(undefined)).toBe(false);
    expect(isSmsSurface('')).toBe(false);
  });

  it('keeps the route map in ONE place', () => {
    expect(SMS_SURFACE_PREFIXES).toContain('/sms');
    expect(SMS_SURFACE_PREFIXES).toContain('/u/');
    expect(SMS_SURFACE_PREFIXES).toContain('/activity-unavailable');
    // 🔴 Both short-link failure interstitials, together. `invalid_token` used to redirect to
    // /search — a shared, chromed, account-bearing page — so the SMS product's route map was
    // silently missing the destination of one of its two failing outcomes.
    expect(SMS_SURFACE_PREFIXES).toContain('/link-unavailable');
  });
});

describe('hidesAccountNav — a DIFFERENT question from isSmsSurface', () => {
  it('hides on every SMS surface, as before', () => {
    for (const path of ['/sms/signup', '/u/abc123', '/activity-unavailable', '/link-unavailable']) {
      expect(hidesAccountNav(path), path).toBe(true);
    }
  });

  it('🎯 also hides on /activity/{id} — the page a weekly-text link resolves to (Jon 2026-08-28)', () => {
    expect(hidesAccountNav('/activity/5e300000-0000-4000-8000-000000000001')).toBe(true);
    expect(hidesAccountNav('/activity/anything')).toBe(true);
  });

  it('🎯 ALSO hides on /search — Jon overrode the recommendation (2026-08-28)', () => {
    // This test previously asserted the OPPOSITE, and said "if this is later ruled to hide too,
    // change the list, not this test's reasoning." That is exactly what happened, so the reasoning
    // is preserved below rather than deleted with the assertion.
    expect(hidesAccountNav('/search')).toBe(true);
    expect(hidesAccountNav('/search?q=swim')).toBe(true);
  });

  it('⚠ and that leaves /search with NO sign-out control — accepted, not overlooked', () => {
    // SaveSearchButton has signed-in / signed-out / session-lost states and starts the OAuth flow,
    // so a signed-in parent can still save a search here while the nav that would let them sign out
    // is hidden. Jon ruled with that cost in front of him and the Operator confirmed closing it is
    // not a precondition.
    //   Asserted so the gap is a RECORDED decision rather than folklore: if someone later "fixes"
    //   it by dropping /search from the list, this test tells them what they are undoing and that
    //   the fix belongs in /search's own UI instead.
    expect(hidesAccountNav('/search')).toBe(true);
  });

  it('🔴 /search is nav-hidden but is STILL NOT an SMS surface', () => {
    // The two-list design earning its keep. Until now both questions had the same answer for every
    // path; /search is the first where they genuinely diverge. One list could not have expressed
    // this without asserting something false about the shape of the product.
    expect(hidesAccountNav('/search')).toBe(true);
    expect(isSmsSurface('/search')).toBe(false);
  });

  it('leaves ordinary web pages alone', () => {
    for (const path of ['/', '/privacy', '/terms', '/account']) {
      expect(hidesAccountNav(path), path).toBe(false);
    }
  });

  it('does not sweep in a lookalike route', () => {
    // Same trailing-slash discipline as isSmsSurface: '/activity/' must not match '/activities'.
    expect(hidesAccountNav('/activities')).toBe(false);
    expect(hidesAccountNav('/updates')).toBe(false);
  });

  it('isSmsSurface still means what its name says — /activity is NOT an SMS surface', () => {
    expect(isSmsSurface('/activity/abc')).toBe(false);
    expect(hidesAccountNav('/activity/abc')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// /u GOES BARE (Jon, 2026-09-03) — AND THE COMPLIANCE CHECK THAT HAD TO COME WITH IT.
//
// surfaces.ts's own comment requires that any page added to BARE_CHROME_PREFIXES be checked for
// this: suppressing chrome removes SiteFooter, which is where the site-wide /privacy and /terms
// links live. app/u/[preferencesToken] has TWO return branches. The "found" state always rendered
// its own copies. The NOT-FOUND state did not, and adding /u without fixing it would have left a
// person holding a dead token with no route to either document — on the page this project calls
// "the CASL unsubscribe path and the PIPEDA access/correction mechanism", i.e. exactly the page
// someone exercising those rights lands on.
// ═══════════════════════════════════════════════════════════════════════════════════════════
describe('🔴 /u renders bare, and neither branch loses its legal links', () => {
  const page = require('node:fs').readFileSync(
    'app/u/[preferencesToken]/page.tsx',
    'utf8'
  ) as string;
  const code = page.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('the preferences hub suppresses site chrome', () => {
    expect(hidesSiteChrome('/u/abc123')).toBe(true);
    expect(hidesSiteChrome('/u')).toBe(true);
  });

  it('🔴 the NOT-FOUND branch carries /privacy and /terms itself', () => {
    // The branch that had neither. Sliced explicitly rather than searching the whole file, because
    // the found branch's links would satisfy a naive whole-file match and hide exactly this gap.
    const notFound = code.slice(
      code.indexOf("resolution.outcome !== 'found'"),
      code.indexOf('const { view } = resolution')
    );
    expect(notFound).toContain('href="/privacy"');
    expect(notFound).toContain('href="/terms"');
  });

  it('🔴 the FOUND branch still carries them too', () => {
    const found = code.slice(code.indexOf('const { view } = resolution'));
    expect(found).toContain('href="/privacy"');
    expect(found).toContain('href="/terms"');
  });

  it('does not quietly bare-chrome the browsing surfaces', () => {
    // surfaces.ts argues /search and /activity stay chromed because they are places a person
    // browses, not single-conversion pages. Jon overruled that for /u specifically; this pins
    // that the exception did not widen.
    expect(hidesSiteChrome('/search')).toBe(false);
    expect(hidesSiteChrome('/activity/abc')).toBe(false);
  });
});
