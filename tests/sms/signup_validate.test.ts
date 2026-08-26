// tests/sms/signup_validate.test.ts — the public SMS signup validator (pure, no DB, no request).
//
// This is the whole accept/reject surface of the one public endpoint that collects a phone
// number and a child's age, so the negative cases are the point of the file, not an afterthought.
import { describe, expect, it } from 'vitest';
import {
  MAX_CHILDREN,
  MAX_CHILD_AGE_YEARS,
  birthYearFromAge,
  normalizePhoneE164,
  parseSmsSignupBody,
} from '@/lib/sms/signup-validate';
import { CONSENT_TEXT_VERSION } from '@/lib/sms/consent-copy';

/** Friday 2026-08-28, 16:00 PDT. Local year is 2026. */
const NOW = new Date('2026-08-28T23:00:00Z');

function valid(over: Record<string, unknown> = {}) {
  return {
    phone: '604 555 0123',
    postal: 'V5L 1A1', // East Vancouver
    childAges: [4, 7],
    interests: ['public_swim'],
    consent: true,
    ...over,
  };
}

describe('normalizePhoneE164', () => {
  it('accepts the shapes a Canadian actually types', () => {
    for (const raw of [
      '6045550123',
      '604 555 0123',
      '(604) 555-0123',
      '604-555-0123',
      '+1 604 555 0123',
      '1 (604) 555 0123',
      '  604.555.0123  ',
    ]) {
      expect(normalizePhoneE164(raw)).toBe('+16045550123');
    }
  });

  it('rejects the typo class a parent can see and fix', () => {
    expect(normalizePhoneE164('604 555 012')).toBeNull(); // a digit short
    expect(normalizePhoneE164('604 555 01234')).toBeNull(); // a digit long
    expect(normalizePhoneE164('064 555 0123')).toBeNull(); // area code starts 0
    expect(normalizePhoneE164('604 155 0123')).toBeNull(); // exchange starts 1
    expect(normalizePhoneE164('')).toBeNull();
    expect(normalizePhoneE164('not a phone')).toBeNull();
    expect(normalizePhoneE164('+44 20 7946 0958')).toBeNull(); // not NANP
  });

  it('produces a value migration 0034 will accept — asserted against that CHECK verbatim', () => {
    // The regex below is copied from supabase/migrations/0034_sms_consent.sql's
    // `sms_consent_phone_e164` constraint. If the two ever disagree, every signup fails at the
    // database with a constraint violation the form has no way to explain, so the agreement is
    // pinned here rather than discovered in production.
    const MIGRATION_CHECK = /^\+[1-9][0-9]{7,14}$/;
    expect(normalizePhoneE164('604 555 0123')).toMatch(MIGRATION_CHECK);
  });
});

describe('birthYearFromAge', () => {
  it('stores a YEAR, derived at entry, never an age', () => {
    expect(birthYearFromAge(4, NOW)).toBe(2022);
    expect(birthYearFromAge(0, NOW)).toBe(2026);
  });

  it('pins the ACCEPTED year-only imprecision (PRD §1.2) so nobody "fixes" it', () => {
    // A child who turns 5 in December is entered as 5 in January and stored as born in 2021,
    // which reads back as 5 all year. That is the tradeoff for never asking a parent for a
    // minor's date of birth.
    expect(birthYearFromAge(5, new Date('2026-01-02T20:00:00Z'))).toBe(2021);
  });
});

describe('parseSmsSignupBody', () => {
  it('accepts a complete submission and shapes it as an sms_consent row', () => {
    const result = parseSmsSignupBody(valid(), { now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      phoneNumber: '+16045550123',
      postalCode: 'V5L 1A1',
      regionId: 'van',
      birthYears: [2022, 2019], // ages 4 and 7 in 2026 — years, not ages
      categoryInterests: ['public_swim'],
      consentMethod: 'web_form',
      consentTextVersion: CONSENT_TEXT_VERSION,
    });
  });

  it('REQUIRES consent, and checks it before anything else', () => {
    // Checked first on purpose: nothing else about a submission matters if consent is absent,
    // and reporting a phone-number typo to someone who never ticked the box would be asking them
    // to fix the wrong thing.
    const noConsent = parseSmsSignupBody(valid({ consent: false, phone: 'garbage' }), { now: NOW });
    expect(noConsent).toEqual({ ok: false, error: 'consent is required', field: 'consent' });

    for (const value of [undefined, null, 'true', 1, 'on']) {
      const r = parseSmsSignupBody(valid({ consent: value }), { now: NOW });
      expect(r.ok).toBe(false);
    }
  });

  it('normalises the postal code and resolves its municipality', () => {
    const r = parseSmsSignupBody(valid({ postal: 'v7m2k4' }), { now: NOW });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.postalCode).toBe('V7M 2K4');
    expect(r.value.regionId).toBe('nvan');
  });

  it('REJECTS an out-of-coverage postal code rather than warning about it', () => {
    // A postal outside the five covered municipalities resolves to no FSA, so fsaGeocoder returns
    // null, so the weekly send job has no origin and can never select anything — not "few picks",
    // none, ever. Accepting would mean holding a phone number and a child's age under CASL for
    // someone we can demonstrably never serve. See parseSmsSignupBody's own comment.
    const surrey = parseSmsSignupBody(valid({ postal: 'V3S 1A1' }), { now: NOW });
    expect(surrey).toEqual({ ok: false, error: 'out of coverage area', field: 'postal' });

    // A sparse-but-covered municipality is NOT rejected — thin coverage is real coverage.
    const westVan = parseSmsSignupBody(valid({ postal: 'V7V 1A1' }), { now: NOW });
    expect(westVan.ok).toBe(true);
    if (westVan.ok) expect(westVan.value.regionId).toBe('wvan');
  });

  it('rejects a malformed postal code', () => {
    for (const postal of ['', 'V5L', '12345', 'not a postal']) {
      const r = parseSmsSignupBody(valid({ postal }), { now: NOW });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.field).toBe('postal');
    }
  });

  it('requires at least one child and caps the list', () => {
    const none = parseSmsSignupBody(valid({ childAges: [] }), { now: NOW });
    expect(none).toEqual({ ok: false, error: 'add at least one child’s age', field: 'children' });

    const tooMany = parseSmsSignupBody(
      valid({ childAges: Array.from({ length: MAX_CHILDREN + 1 }, () => 5) }),
      { now: NOW }
    );
    expect(tooMany.ok).toBe(false);
    if (!tooMany.ok) expect(tooMany.field).toBe('children');
  });

  it('accepts numeric strings, because <input type="number"> submits one', () => {
    const r = parseSmsSignupBody(valid({ childAges: ['4', '  7  '] }), { now: NOW });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.birthYears).toEqual([2022, 2019]);
  });

  it('rejects an age that is not a whole number in range', () => {
    for (const age of [-1, 4.5, MAX_CHILD_AGE_YEARS + 1, '', 'four', null, {}]) {
      const r = parseSmsSignupBody(valid({ childAges: [age] }), { now: NOW });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.field).toBe('children');
    }
  });

  it('accepts 18 but not 19 — an 18-year-old is still a kid to this catalogue', () => {
    // The audience filter excludes adult-only content from 19 (BC's age of majority), so a 19
    // entered as a "child" would have every match excluded downstream.
    expect(parseSmsSignupBody(valid({ childAges: [18] }), { now: NOW }).ok).toBe(true);
    expect(parseSmsSignupBody(valid({ childAges: [19] }), { now: NOW }).ok).toBe(false);
  });

  it('treats interests as optional and de-duplicates them', () => {
    for (const interests of [undefined, null, []]) {
      const r = parseSmsSignupBody(valid({ interests }), { now: NOW });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.categoryInterests).toEqual([]);
    }
    const dupes = parseSmsSignupBody(valid({ interests: ['skate', 'skate'] }), { now: NOW });
    expect(dupes.ok).toBe(true);
    if (dupes.ok) expect(dupes.value.categoryInterests).toEqual(['skate']);
  });

  it('rejects an unknown interest key rather than silently dropping it', () => {
    // A silently-dropped interest is a filter the subscriber believes is on. It also means the
    // client and the allowlist have drifted, which is worth an error.
    const r = parseSmsSignupBody(valid({ interests: ['underwater_basket_weaving'] }), { now: NOW });
    expect(r).toEqual({ ok: false, error: 'unknown interest', field: 'interests' });
    // 'class_program' is a real seeded category that this form deliberately does NOT offer —
    // see lib/sms/interests.ts. It must be rejected like any other key the form cannot produce.
    expect(parseSmsSignupBody(valid({ interests: ['class_program'] }), { now: NOW }).ok).toBe(false);
  });

  it('defaults consentMethod to web_form and validates it when supplied', () => {
    const d = parseSmsSignupBody(valid(), { now: NOW });
    if (d.ok) expect(d.value.consentMethod).toBe('web_form');

    const email = parseSmsSignupBody(valid({ consentMethod: 'email_link' }), { now: NOW });
    expect(email.ok).toBe(true);
    if (email.ok) expect(email.value.consentMethod).toBe('email_link');

    expect(parseSmsSignupBody(valid({ consentMethod: 'carrier_pigeon' }), { now: NOW }).ok).toBe(false);
  });

  it('never echoes the submitted value back in an error', () => {
    // An error response that repeats input turns a public endpoint into a reflector for
    // arbitrary text. Every message here is about the SHAPE of the problem.
    const r = parseSmsSignupBody(valid({ phone: '<script>alert(1)</script>' }), { now: NOW });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).not.toContain('script');
  });

  it('rejects a non-object body', () => {
    for (const raw of [null, undefined, 'string', 42, []]) {
      expect(parseSmsSignupBody(raw, { now: NOW }).ok).toBe(false);
    }
  });
});
