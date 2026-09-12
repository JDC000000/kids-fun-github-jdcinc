// tests/sms/signup_availability.test.ts — the home page's "may I offer signup, and where?"
// helper (TSD §9 M1 T1.3 / AC-04b, AC-12).
//
// ═══ WHY A SECOND HELPER EXISTS NEXT TO signupUrl(), WHICH LOOKS LIKE DUPLICATION ═══
// AC-04b says the address must resolve "through the product's existing signup-address helper,
// not written by hand". Read literally that names `signupUrl()` — and obeying it literally
// would ship a bug. `signupUrl()` returns an ABSOLUTE url because it was built for SMS message
// bodies, where a relative path is meaningless. Dropped into an internal <Link href> that
// absolute url would force a full document load instead of a client-side route transition, and
// on any preview deployment it would point at `siteUrl()` rather than the origin the parent is
// actually on.
//
// So the PATH is extracted to one exported constant and both callers compose from it. Nothing
// is hand-written, there is still exactly one source of truth, and each call site gets the form
// it needs. The tests below hold both ends of that: `signupUrl()`'s output is unchanged to the
// byte, and the new helper returns the path — never the absolute url.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SMS_SIGNUP_PATH, signupUrl, siteUrl } from '@/lib/sms/config';
import { smsSignupAvailability } from '@/lib/sms/availability';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('SMS_SIGNUP_PATH — the one source of truth', () => {
  it('is the reachable signup path, not the 308-redirected legacy one', () => {
    // /sms/signup permanently redirects here (next.config.mjs, 2026-09-01). A link we
    // compose ourselves should not spend a redirect hop.
    expect(SMS_SIGNUP_PATH).toBe('/sms/start');
  });

  it('🔴 signupUrl() is byte-identical to what it returned before the refactor', () => {
    // The refactor is allowed to change how the string is built and NOT what it is. This
    // is the literal pre-refactor expression, written out rather than composed, so a
    // mistake in the composition cannot also be made here.
    vi.stubEnv('SMS_SENDING_ENABLED', 'false');
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://kidsfunapp.ca');
    expect(signupUrl()).toBe('https://kidsfunapp.ca/sms/start');
    expect(signupUrl()).toBe(`${siteUrl()}/sms/start`);
  });

  it('composes signupUrl() FROM the constant, so the two can never drift', () => {
    vi.stubEnv('SMS_SENDING_ENABLED', 'false');
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://preview.example.test');
    expect(signupUrl()).toBe(`${siteUrl()}${SMS_SIGNUP_PATH}`);
  });
});

describe('smsSignupAvailability — flag parity with smsSignupEnabled()', () => {
  // PARITY IS THE REQUIREMENT, NOT AN IMPROVEMENT ON IT. The whole value of this helper is
  // that the home page and /sms/start agree about whether signup is on. A helper that was
  // more lenient than the page's own `notFound()` gate would put a live CTA in front of a
  // 404; one that was stricter would hide a working form. Either way the two surfaces would
  // disagree, which is the single failure AC-12 exists to prevent.
  const UNAVAILABLE = [
    ['unset', undefined],
    ['empty', ''],
    ['whitespace only', '   '],
    ['false', 'false'],
    ['TRUE (wrong case)', 'TRUE'],
    ['True (wrong case)', 'True'],
    ['1', '1'],
    ['yes', 'yes'],
    ['on', 'on'],
  ] as const;

  for (const [label, value] of UNAVAILABLE) {
    it(`🔴 is UNAVAILABLE when SMS_SIGNUP_ENABLED is ${label}`, () => {
      if (value === undefined) vi.stubEnv('SMS_SIGNUP_ENABLED', '');
      else vi.stubEnv('SMS_SIGNUP_ENABLED', value);
      const result = smsSignupAvailability();
      expect(result.available).toBe(false);
      expect(result.href).toBeNull();
    });
  }

  it('is AVAILABLE only on the exact lowercase string "true"', () => {
    vi.stubEnv('SMS_SIGNUP_ENABLED', 'true');
    const result = smsSignupAvailability();
    expect(result.available).toBe(true);
    expect(result.href).toBe(SMS_SIGNUP_PATH);
  });

  it('trims, exactly as the shared env() reader does — no stricter, no looser', () => {
    // ' true ' is ON for every other flag in lib/sms/config.ts because env() trims before
    // comparing. A new flag reader that parsed its input differently from the established
    // one would be its own trap.
    vi.stubEnv('SMS_SIGNUP_ENABLED', '  true  ');
    expect(smsSignupAvailability().available).toBe(true);
  });
});

describe('smsSignupAvailability returns a PATH, and is not coupled to the absolute builder', () => {
  it('never returns an absolute url', () => {
    vi.stubEnv('SMS_SIGNUP_ENABLED', 'true');
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://kidsfunapp.ca');
    const href = smsSignupAvailability().href;
    expect(href).toBe('/sms/start');
    expect(href).not.toMatch(/^https?:\/\//);
  });

  it('🔴 cannot throw the way signupUrl() can — it never reads siteUrl()', () => {
    // siteUrl() THROWS by design when sending is on and NEXT_PUBLIC_SITE_URL is unset or
    // wrong (it refuses to build subscriber links against localhost). That guard is correct
    // for an SMS body and catastrophic on a render path: it would turn a misconfigured env
    // var into a 500 on the product's front door. This asserts the helper is genuinely
    // independent of it — which is the substantive reason AC-04b could not be obeyed
    // literally, not merely a routing preference.
    vi.stubEnv('SMS_SIGNUP_ENABLED', 'true');
    vi.stubEnv('SMS_SENDING_ENABLED', 'true');
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', '');
    expect(() => signupUrl()).toThrow(); // the guard really is armed in this state
    expect(() => smsSignupAvailability()).not.toThrow();
    expect(smsSignupAvailability().href).toBe(SMS_SIGNUP_PATH);
  });
});

describe('the availability result makes a bad render unrepresentable', () => {
  it('🔴 gives no href to link to when unavailable', () => {
    // AC-12's failure mode is "a button that 404s". The unavailable branch carries `null`,
    // not an empty string and not the path-with-a-flag-beside-it, so a caller that ignores
    // `available` still has nothing to put in an href. The type makes the mistake hard; this
    // asserts the value does too.
    vi.stubEnv('SMS_SIGNUP_ENABLED', 'false');
    const result = smsSignupAvailability();
    expect(result.href).toBeNull();
    expect(result.href).not.toBe('');
    expect(result.href).not.toBe(SMS_SIGNUP_PATH);
  });
});
