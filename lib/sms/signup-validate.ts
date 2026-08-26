// lib/sms/signup-validate.ts — validate one public SMS signup submission.
//
// DRAFT (SMS pivot). Pure: no `pg`, no `next`, no clock of its own — the same posture as
// lib/user/profile-validate.ts and lib/notify/region-signup.ts, and for the same reason. The
// whole accept/reject surface is unit-testable without a request or a database, and the route
// handler is left holding nothing but transport.
//
// Hand-rolled validation, mirroring lib/notify/region-signup.ts and lib/corrections/validate.ts:
// zod is not a dependency in this repo and this change is not the place to add one.
//
// ── WHAT THIS PRODUCES ───────────────────────────────────────────────────────────────────
// A `SmsSignup` is exactly the column set of one `sms_consent` row at `status = 'pending'`
// (migration 0034) and nothing else. It deliberately does NOT touch, read or resemble
// `user_profile` — this is an anonymous signup path into a new table, not an extension of the
// account system, and `user_profile.saved_child_ages` stays exactly as disabled as it is today
// (PRD §1.2).
//
// ── THE ONE FUNCTION IMPORTED FROM THE ACCOUNT SIDE, AND WHY THAT IS FINE ────────────────
// `normalizePostal` comes from lib/user/profile-validate.ts. That module is IMPORTED, never
// modified, and the function is a pure string normaliser with no account semantics attached: it
// turns "v6b1a1" into "V6B 1A1" and returns null otherwise. A second Canadian postal regex here
// would be a second thing to keep in step with the first, which is the duplication this repo
// argues against everywhere else. Nothing else crosses that boundary.

import { normalizePostal } from '@/lib/user/profile-validate';
import { regionIdForPostal, type CoveredRegionId } from '@/lib/geo/postal-fsa';
import { localIsoDate } from '@/lib/search/time/vancouver';
import { CONSENT_TEXT_VERSION } from './consent-copy';
import { isKnownInterestKey } from './interests';

/** Whole-request payload cap — a sanity ceiling against abuse (matches the corrections route). */
export const MAX_SIGNUP_PAYLOAD_BYTES = 4 * 1024; // 4 KB

/** Longest raw phone string accepted before normalisation. Generous: "+1 (604) 555-0123 ext" is 21. */
export const MAX_PHONE_INPUT_LENGTH = 32;

/**
 * Most children one signup may list. Not a statement about families — a bound on what an
 * anonymous unauthenticated endpoint will accept into an `integer[]` column, and a UI sanity
 * limit. A parent of nine can add the ninth from the preferences page.
 */
export const MAX_CHILDREN = 8;

/**
 * Oldest age this form accepts, in years.
 *
 * 18, not 19, and the difference is the whole point. The product's top age band is `15+` and its
 * adult-only exclusion starts at 19 (`ADULT_ONLY_AGE_MIN_MONTHS`, BC's age of majority), so an
 * 18-year-old is still a kid to this catalogue. Accepting 19 would let an adult be entered as a
 * "child" whose every match is then excluded by the audience filter.
 */
export const MAX_CHILD_AGE_YEARS = 18;

/** How a subscriber reached us (PRD §5 `consent_method`). */
export type ConsentMethod = 'web_form' | 'sms_start' | 'email_link';
const CONSENT_METHODS: readonly ConsentMethod[] = ['web_form', 'sms_start', 'email_link'];

/** A validated signup, shaped as the `sms_consent` row it becomes. */
export interface SmsSignup {
  /** E.164, e.g. "+16045550123". Satisfies migration 0034's `sms_consent_phone_e164` CHECK. */
  phoneNumber: string;
  /** Canonical "A1A 1A1". */
  postalCode: string;
  /** Which covered municipality that postal resolves to. Not a column — used for the response. */
  regionId: CoveredRegionId;
  /** One birth YEAR per child, derived at entry from "how old now" (PRD §1.2). Never an age. */
  birthYears: number[];
  /** Category keys from the form's own allowlist. Empty = no interest filter. */
  categoryInterests: string[];
  consentMethod: ConsentMethod;
  /** The exact wording they agreed to — see lib/sms/consent-copy.ts. */
  consentTextVersion: string;
}

export type SmsSignupParseResult =
  | { ok: true; value: SmsSignup }
  | { ok: false; error: string; field?: SmsSignupField };

/** Which control an error belongs to, so the form can put the message under the right field. */
export type SmsSignupField = 'phone' | 'postal' | 'children' | 'interests' | 'consent';

/**
 * Normalise a typed phone number to E.164, or null if it is not a plausible North American
 * mobile number.
 *
 * WHAT IS CHECKED AND WHAT DELIBERATELY IS NOT. Only a carrier can tell us a number is real and
 * reachable, and every over-strict client-side phone validator in history has rejected somebody's
 * actual number. So this checks the two things that can be known with certainty from the digits
 * alone — the length, and the NANP rule that an area code and an exchange code both begin 2–9 —
 * and admits everything else. Those two catch the whole class of typo a parent can see and fix
 * (a dropped digit, a transposed pair, an area code typed as 064); anything subtler is the
 * confirmation text's job, which is precisely why the confirmation text exists.
 *
 * CANADA VS THE US CANNOT BE DISTINGUISHED HERE and this does not try. Both are +1 and share the
 * numbering plan; separating them means an area-code table that goes stale every time the CRTC
 * issues an overlay. The real geographic gate is the postal code (below), which must resolve to
 * one of five Metro Vancouver municipalities — a US number attached to a V6B postal code is a
 * problem the toll-free number's own delivery will surface, not one to solve with a lookup table.
 *
 * The output shape is chosen to satisfy migration 0034's CHECK (`^\+[1-9][0-9]{7,14}$`)
 * by construction, which tests/sms/signup_validate.test.ts asserts directly against that regex.
 */
export function normalizePhoneE164(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_PHONE_INPUT_LENGTH) return null;
  const digits = trimmed.replace(/\D/g, '');
  // A leading country code 1 is optional in how a Canadian writes their own number.
  const national = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(national)) return null;
  return `+1${national}`;
}

/**
 * Convert a plain "how old are they now" number into the birth YEAR we store.
 *
 * PRD §1.2: the form asks for one number per child and nothing else — no birthday, no month —
 * and we store `current_year - age` so the value does not go stale as the child grows. The
 * conversion happens HERE, at the moment of entry, so an age never reaches the database.
 *
 * The year is read in America/Vancouver rather than UTC: on the evening of December 31st those
 * are different years, and this product is entirely local.
 *
 * The accepted imprecision, recorded at the point it is introduced: with no month, this is right
 * only for a child who has already had this year's birthday. A child who turns 5 in December is
 * entered as 5 in January and stored as if they were born five years ago, which reads back as 5
 * all year. PRD §1.2 accepts that in exchange for never asking a parent for a minor's date of
 * birth. Do not "fix" it by inventing a month.
 */
export function birthYearFromAge(ageYears: number, now: Date): number {
  return Number(localIsoDate(now).slice(0, 4)) - ageYears;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Accept a number or a numeric string — an <input type="number"> submits the latter. */
function asInteger(v: unknown): number | null {
  if (typeof v === 'number') return Number.isInteger(v) ? v : null;
  if (typeof v === 'string') {
    const trimmed = v.trim();
    if (!/^\d{1,3}$/.test(trimmed)) return null;
    return Number(trimmed);
  }
  return null;
}

export interface ParseOptions {
  /** The clock, passed so age→birth-year is reproducible in a test. */
  now: Date;
}

/**
 * Parse and validate an untrusted signup body. Never throws.
 *
 * Error strings describe the SHAPE of the problem and never echo the submitted value back, which
 * is what keeps an error response from turning a public endpoint into a reflector for arbitrary
 * text. Each carries the `field` it belongs to so the form can render it in the right place
 * instead of dumping one message at the top.
 *
 * ── AN OUT-OF-AREA POSTAL CODE IS REJECTED, NOT WARNED ABOUT. THIS IS A JUDGEMENT CALL. ──
 * A postal code outside the five covered municipalities resolves to no FSA in
 * lib/geo/postal-fsa.ts, which means `fsaGeocoder` returns null, which means the weekly send job
 * has no origin and can never select anything for that subscriber — not "few picks", none, ever.
 * Accepting the signup would mean taking a phone number and a child's age from someone we can
 * demonstrably never serve, holding that data under CASL, and texting them an empty week every
 * Friday until they opt out. Rejecting at the form, naming the areas we do cover, is the honest
 * version of the same information.
 *   THIS IS DISTINCT FROM THE SPARSE-AREA CASE, which is a warning and not a rejection: West
 *   Vancouver has thin coverage but real coverage, and it can improve. "Few picks some weeks" and
 *   "nothing, structurally" are different facts and get different treatment.
 *   FLAGGED FOR THE OPERATOR: the PRD does not specify a behaviour for an out-of-area postal
 *   code. If the preference is to capture them as a waiting list instead, `region_notify_signup`
 *   (migration 0033) is the table that already does exactly that, and this rejection is where
 *   that hand-off would go.
 */
export function parseSmsSignupBody(raw: unknown, options: ParseOptions): SmsSignupParseResult {
  if (!isPlainObject(raw)) return { ok: false, error: 'body must be a JSON object' };

  // ── Consent first. Nothing else about this submission matters if it is not there. ──
  if (raw.consent !== true) {
    return { ok: false, error: 'consent is required', field: 'consent' };
  }

  // ── Phone ──
  if (typeof raw.phone !== 'string') {
    return { ok: false, error: 'a mobile number is required', field: 'phone' };
  }
  const phoneNumber = normalizePhoneE164(raw.phone);
  if (!phoneNumber) {
    return {
      ok: false,
      error: 'that does not look like a 10-digit Canadian mobile number',
      field: 'phone',
    };
  }

  // ── Postal ──
  if (typeof raw.postal !== 'string') {
    return { ok: false, error: 'a postal code is required', field: 'postal' };
  }
  const postalCode = normalizePostal(raw.postal);
  if (!postalCode) {
    return { ok: false, error: 'that does not look like a Canadian postal code', field: 'postal' };
  }
  const regionId = regionIdForPostal(postalCode);
  if (!regionId) {
    return { ok: false, error: 'out of coverage area', field: 'postal' };
  }

  // ── Children ──
  if (!Array.isArray(raw.childAges) || raw.childAges.length === 0) {
    return { ok: false, error: 'add at least one child’s age', field: 'children' };
  }
  if (raw.childAges.length > MAX_CHILDREN) {
    return { ok: false, error: `at most ${MAX_CHILDREN} children`, field: 'children' };
  }
  const birthYears: number[] = [];
  for (const entry of raw.childAges) {
    const age = asInteger(entry);
    if (age == null || age < 0 || age > MAX_CHILD_AGE_YEARS) {
      return {
        ok: false,
        error: `each age must be a whole number from 0 to ${MAX_CHILD_AGE_YEARS}`,
        field: 'children',
      };
    }
    birthYears.push(birthYearFromAge(age, options.now));
  }

  // ── Interests (optional) ──
  let categoryInterests: string[] = [];
  if (raw.interests != null) {
    if (!Array.isArray(raw.interests)) {
      return { ok: false, error: 'interests must be a list', field: 'interests' };
    }
    const seen = new Set<string>();
    for (const key of raw.interests) {
      if (typeof key !== 'string' || !isKnownInterestKey(key)) {
        // An unknown key means the client and this allowlist disagree, which is a bug worth
        // surfacing rather than silently dropping — a silently-dropped interest is a filter the
        // subscriber believes is on.
        return { ok: false, error: 'unknown interest', field: 'interests' };
      }
      seen.add(key);
    }
    categoryInterests = [...seen];
  }

  // ── Consent method (optional; the three doors all funnel to this one form) ──
  let consentMethod: ConsentMethod = 'web_form';
  if (raw.consentMethod != null) {
    if (
      typeof raw.consentMethod !== 'string' ||
      !CONSENT_METHODS.includes(raw.consentMethod as ConsentMethod)
    ) {
      return { ok: false, error: 'unknown consent method' };
    }
    consentMethod = raw.consentMethod as ConsentMethod;
  }

  return {
    ok: true,
    value: {
      phoneNumber,
      postalCode,
      regionId,
      birthYears,
      categoryInterests,
      consentMethod,
      consentTextVersion: CONSENT_TEXT_VERSION,
    },
  };
}
