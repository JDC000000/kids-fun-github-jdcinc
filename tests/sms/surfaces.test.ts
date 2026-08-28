// tests/sms/surfaces.test.ts — which routes count as the SMS product.
//
// PRD §8 item 4: the shared account nav is hidden on these, because an SMS subscriber has no
// account and offering one invites a data relationship the product deliberately does not need
// (Jon: "let's emphasize capturing the least amount of data we need to provide value").
import { describe, expect, it } from 'vitest';
import { isSmsSurface, hidesAccountNav, SMS_SURFACE_PREFIXES } from '@/lib/sms/surfaces';

describe('isSmsSurface', () => {
  it('matches every anonymous SMS page', () => {
    for (const path of [
      '/sms/signup',
      '/u/alice-token-0123456789abcdef',
      '/activity-unavailable',
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
  });
});

describe('hidesAccountNav — a DIFFERENT question from isSmsSurface', () => {
  it('hides on every SMS surface, as before', () => {
    for (const path of ['/sms/signup', '/u/abc123', '/activity-unavailable']) {
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
