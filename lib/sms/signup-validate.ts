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
import { CONSENT_TEXT_VERSION, OUT_OF_AREA_NOTICE } from './consent-copy';
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

/** One thing wrong with a submission. */
export interface SignupFieldError {
  message: string;
  field?: SmsSignupField;
}

/**
 * ═══ EVERY FAILURE, NOT THE FIRST ONE (PRD §8 item 2, Jon-approved) ═══
 * This used to short-circuit: the first failing check returned and the rest never ran, so a
 * submission with three problems took three submits to fix, each revealing one more. Jon's ruling,
 * verbatim: *"Yes. Show all errors at once. I approve your recommendation."*
 *
 * `errors` is the whole list. `error` and `field` are `errors[0]`, DERIVED not duplicated, kept so
 * that a caller wanting one message (and the existing HTTP error contract) still has one.
 */
export type SmsSignupParseResult =
  | { ok: true; value: SmsSignup }
  | { ok: false; errors: SignupFieldError[]; error: string; field?: SmsSignupField };

/** Build the failure shape from an accumulated list. Never called with an empty list. */
function failures(errors: SignupFieldError[]): {
  ok: false;
  errors: SignupFieldError[];
  error: string;
  field?: SmsSignupField;
} {
  return { ok: false, errors, error: errors[0].message, field: errors[0].field };
}

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
 * ⚠ THE ERROR MESSAGE USED TO CONTRADICT THIS COMMENT. It said "a 10-digit CANADIAN mobile
 * number", asserting a check this function had deliberately chosen not to perform — so the form
 * claimed a guarantee it did not provide, on a product under Twilio TFV review. Corrected
 * 2026-08-29 by fixing the CLAIM, not by building the area-code table this comment argues against.
 * The two must be kept in agreement: if the behaviour here ever does become nationality-aware, the
 * message is the other half of that change.
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

/**
 * The inverse of `birthYearFromAge`: stored birth years back to ages, AT `now`.
 *
 * LIVES HERE, BESIDE ITS INVERSE, and that is the whole point of moving it — birth-year↔age
 * conversion is one rule with two directions, and the two directions reading the local year two
 * different ways is exactly how they drift apart on New Year's Eve. Both now go through
 * `localIsoDate`, so both agree about what year it is in Vancouver.
 *
 * Callers: the preferences page (showing a subscriber what we hold) and the welcome text (echoing
 * it back at the moment they confirm). Both are showing a parent their own numbers, so both must
 * produce exactly what the picker will use.
 *
 * A negative age — a birth year in the future, which the validator rejects but a hand-edited row
 * could hold — is dropped rather than displayed. "ages -1" is worse than a shorter sentence.
 */
export function agesFromBirthYears(birthYears: readonly number[] | null | undefined, now: Date): number[] {
  if (!birthYears) return [];
  const currentYear = Number(localIsoDate(now).slice(0, 4));
  return birthYears.map((year) => currentYear - year).filter((age) => age >= 0);
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

/** The three fields a subscriber may set at signup AND edit later on the preferences page. */
export interface ProfileFields {
  postalCode: string;
  regionId: CoveredRegionId;
  birthYears: number[];
  categoryInterests: string[];
}

export type ProfileFieldsParseResult =
  | { ok: true; value: ProfileFields }
  | { ok: false; errors: SignupFieldError[]; error: string; field?: SmsSignupField };

/**
 * Validate the postal code, child ages and interests — the fields that are IDENTICAL at signup and
 * on the preferences page (PRD §2.1 and §2.4 list the same three).
 *
 * EXTRACTED SO THERE IS EXACTLY ONE COPY. The preferences page edits the same columns under the
 * same rules, and a second implementation is how "V5L 1A1 was fine when I signed up but is
 * rejected when I edit it" happens. `parseSmsSignupBody` calls this and adds phone + consent on
 * top; `parsePreferencesPatch` (lib/sms/preferences.ts) calls it and adds nothing.
 *
 * Every rule and every message below is unchanged from the signup implementation — this is a
 * move, not a rewrite.
 */
export function parseProfileFields(
  raw: Record<string, unknown>,
  options: ParseOptions
): ProfileFieldsParseResult {
  const errors: SignupFieldError[] = [];

  // ── Postal ──
  // FIRST, AND THAT ORDER IS NOW A RULING RATHER THAN AN ACCIDENT (PRD §8 item 1). See
  // `parseSmsSignupBody` for why coverage has to be reportable before consent is.
  let postalCode: string | null = null;
  let regionId: CoveredRegionId | null = null;
  if (typeof raw.postal !== 'string') {
    errors.push({ message: 'a postal code is required', field: 'postal' });
  } else {
    postalCode = normalizePostal(raw.postal);
    if (!postalCode) {
      errors.push({
        message: 'that does not look like a Canadian postal code',
        field: 'postal',
      });
    } else {
      regionId = regionIdForPostal(postalCode);
      if (!regionId) {
        // THE FULL, FRIENDLY NOTICE, NOT A TERSE CODE — and it lives here rather than being
        // substituted downstream. The BROWSER form calls this same function directly and never
        // goes through the API route, so a parent typing a Surrey postal code used to see a terse
        // internal string while the identical submission through the API got the sentence naming
        // all five municipalities. Two testers and the Operator all found it independently.
        //
        // Fixing it HERE rather than duplicating the substitution client-side removes the string
        // comparison entirely: one copy of this sentence, and no code anywhere that has to
        // recognise an error by its exact text. This is the one rejection that is about US rather
        // than about what they typed, so it is the one that most needs to say what we do cover.
        errors.push({ message: OUT_OF_AREA_NOTICE, field: 'postal' });
      }
    }
  }

  // ── Children ──
  // AT MOST ONE CHILDREN ERROR, not one per row. The rows share a single error node and a single
  // `aria-describedby` target (see lib/sms/form-a11y.ts), so three bad ages produce one message
  // rather than three identical ones stacked under the same fieldset.
  const birthYears: number[] = [];
  if (!Array.isArray(raw.childAges) || raw.childAges.length === 0) {
    errors.push({ message: 'add at least one child’s age', field: 'children' });
  } else if (raw.childAges.length > MAX_CHILDREN) {
    errors.push({ message: `at most ${MAX_CHILDREN} children`, field: 'children' });
  } else {
    let badAge = false;
    for (const entry of raw.childAges) {
      const age = asInteger(entry);
      if (age == null || age < 0 || age > MAX_CHILD_AGE_YEARS) {
        badAge = true;
        break;
      }
      birthYears.push(birthYearFromAge(age, options.now));
    }
    if (badAge) {
      birthYears.length = 0;
      errors.push({
        message: `each age must be a whole number from 0 to ${MAX_CHILD_AGE_YEARS}`,
        field: 'children',
      });
    }
  }

  // ── Interests (optional) ──
  let categoryInterests: string[] = [];
  if (raw.interests != null) {
    if (!Array.isArray(raw.interests)) {
      errors.push({ message: 'interests must be a list', field: 'interests' });
    } else {
      const seen = new Set<string>();
      let unknown = false;
      for (const key of raw.interests) {
        if (typeof key !== 'string' || !isKnownInterestKey(key)) {
          // An unknown key means the client and this allowlist disagree, which is a bug worth
          // surfacing rather than silently dropping — a silently-dropped interest is a filter the
          // subscriber believes is on.
          unknown = true;
          break;
        }
        seen.add(key);
      }
      if (unknown) errors.push({ message: 'unknown interest', field: 'interests' });
      else categoryInterests = [...seen];
    }
  }

  if (errors.length > 0) return failures(errors);
  return {
    ok: true,
    value: {
      postalCode: postalCode as string,
      regionId: regionId as CoveredRegionId,
      birthYears,
      categoryInterests,
    },
  };
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
 *
 * ═══ THE ORDER OF THE LIST IS A RULING, NOT A STYLE CHOICE (PRD §8 items 1+2) ═══
 * CONSENT USED TO BE CHECKED FIRST, and its comment argued the case: "Nothing else about this
 * submission matters if it is not there." That reasoning was sound for a short-circuiting
 * validator and produced a bad outcome anyway — submit an out-of-area postal code with the box
 * unticked and the ONLY thing you were told was "consent is required". So you ticked the box,
 * agreeing to have your children's ages stored, resubmitted, and only THEN learned we cannot serve
 * your area at all. You consented for nothing.
 *
 * Jon ruled on both halves. Item 1, verbatim: *"Move the coverage check earlier so it fires before
 * consent is asked."* Item 2, verbatim: *"Show all errors at once."*
 *
 * So errors accumulate in FORM ORDER — phone, postal, children, interests, consent — which is the
 * order the fields appear on the page, and which puts coverage ahead of consent as required. The
 * two rulings reinforce each other: showing everything at once is what makes "before consent is
 * asked" true no matter which field a person filled in first.
 *
 * CONSENT IS STILL THE ONE THAT BLOCKS THE WRITE. Moving it last in the LIST changes what a person
 * is told, not what is stored: `ok` is false whenever anything failed, so an unticked box still
 * rejects the submission outright. Nothing is persisted for an out-of-area or unconsented signup —
 * see app/api/sms/signup/route.ts.
 */
export function parseSmsSignupBody(raw: unknown, options: ParseOptions): SmsSignupParseResult {
  if (!isPlainObject(raw)) {
    // A whole-body failure, not a field one: there is nothing to enumerate.
    return failures([{ message: 'body must be a JSON object' }]);
  }

  const errors: SignupFieldError[] = [];

  // ── Phone ──
  let phoneNumber: string | null = null;
  if (typeof raw.phone !== 'string') {
    errors.push({ message: 'a mobile number is required', field: 'phone' });
  } else {
    phoneNumber = normalizePhoneE164(raw.phone);
    if (!phoneNumber) {
      errors.push({
        // NOT "Canadian" — the check above deliberately does not verify nationality, and this
        // message used to claim it did. Corrected 2026-08-29 after live testing accepted a US
        // number: the mismatch was real, and the fix was to stop making the claim rather than to
        // start enforcing it. See normalizePhoneE164's comment for why the area-code table that
        // would have been needed was rejected, and why the postal code is the real geographic gate.
        message: 'that does not look like a 10-digit mobile number',
        field: 'phone',
      });
    }
  }

  // ── The profile fields, shared verbatim with the preferences page. ──
  const profile = parseProfileFields(raw, options);
  if (!profile.ok) errors.push(...profile.errors);

  // ── Consent, LAST ──
  if (raw.consent !== true) {
    errors.push({ message: 'consent is required', field: 'consent' });
  }

  // ── Consent method (optional; the three doors all funnel to this one form) ──
  let consentMethod: ConsentMethod = 'web_form';
  if (raw.consentMethod != null) {
    if (
      typeof raw.consentMethod !== 'string' ||
      !CONSENT_METHODS.includes(raw.consentMethod as ConsentMethod)
    ) {
      errors.push({ message: 'unknown consent method' });
    } else {
      consentMethod = raw.consentMethod as ConsentMethod;
    }
  }

  if (errors.length > 0 || !profile.ok) return failures(errors);

  return {
    ok: true,
    value: {
      phoneNumber: phoneNumber as string,
      postalCode: profile.value.postalCode,
      regionId: profile.value.regionId,
      birthYears: profile.value.birthYears,
      categoryInterests: profile.value.categoryInterests,
      consentMethod,
      consentTextVersion: CONSENT_TEXT_VERSION,
    },
  };
}
