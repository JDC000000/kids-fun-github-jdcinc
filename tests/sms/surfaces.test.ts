// tests/sms/surfaces.test.ts — which routes count as the SMS product.
//
// PRD §8 item 4: the shared account nav is hidden on these, because an SMS subscriber has no
// account and offering one invites a data relationship the product deliberately does not need
// (Jon: "let's emphasize capturing the least amount of data we need to provide value").
import { describe, expect, it } from 'vitest';
import { isSmsSurface, SMS_SURFACE_PREFIXES } from '@/lib/sms/surfaces';

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
