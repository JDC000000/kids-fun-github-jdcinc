'use client';

// app/sms/start/_components/StartForm.tsx — the minimal one-goal signup form.
//
// ═══ WHAT THIS SHARES WITH /sms/signup, AND WHY IT SHARES IT ═══
// EVERYTHING that decides an outcome: `parseSmsSignupBody` for validation, POST /api/sms/signup for
// submission, CONSENT_CHECKBOX_TEXT for the sentence a parent agrees to, and the same interest
// options. Nothing about consent, validation or persistence is reimplemented here.
//
// That is not just DRY. A second validator would be a second definition of who we can serve; a
// second consent sentence would make `consent_text_version` ambiguous about which wording a row
// refers to. This page is a different PRESENTATION of one signup, not a second signup.
//
// ── WHAT IS GENUINELY DIFFERENT ─────────────────────────────────────────────────────────
// Field ORDER follows Jon's own call to action — "postal code, kids ages, activity preferences and
// tel number" — rather than the existing form's phone-first order. That also preserves his earlier
// ruling that the coverage check fires BEFORE consent: postal is first, the consent box is last, so
// an out-of-area parent is told so before being asked to agree to anything.
import { type FormEvent, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  CARRIER_DISCLOSURES,
  CONSENT_CHECKBOX_TEXT,
  FIELD_COPY,
  SENDER_IDENTITY,
  SENDER_IDENTITY_LEAD,
  SUBMITTED_BODY,
  SUBMITTED_HEADING,
  SUPPORT_LINE,
  SUPPORT_PHONE_HREF,
} from '@/lib/sms/consent-copy';
import { SMS_INTEREST_OPTIONS } from '@/lib/sms/interests';
import { MAX_CHILDREN, parseSmsSignupBody, type SmsSignupField } from '@/lib/sms/signup-validate';
import { sparseAreaNoticeFor } from '@/lib/sms/sparse-areas';
import { classifyPostalCoverage, offersWaitlist } from '@/lib/sms/area-coverage';
import {
  WAITLIST_CONSENT_TEXT,
  WAITLIST_DONE_BODY,
  WAITLIST_DONE_HEADING,
  WAITLIST_OUT_OF_AREA_CTA,
  WAITLIST_SPARSE_CTA,
  WAITLIST_SUBMIT,
} from '@/lib/sms/waitlist-copy';
import { OUT_OF_AREA_NOTICE } from '@/lib/sms/consent-copy';
import type { CoveredRegionId } from '@/lib/geo/postal-fsa';

interface SignupFieldError {
  field?: SmsSignupField;
  message: string;
}
interface ChildRow {
  id: number;
  age: string;
}
let nextChildId = 1;
const newChildRow = (): ChildRow => ({ id: nextChildId++, age: '' });

export interface StartFormProps {
  sparseRegionIds: readonly CoveredRegionId[];
}

/** Drop one field's error, preserving array identity when there is nothing to drop. */
export function withoutFieldError(
  errors: readonly SignupFieldError[],
  field: SmsSignupField
): readonly SignupFieldError[] {
  return errors.some((e) => e.field === field) ? errors.filter((e) => e.field !== field) : errors;
}

/**
 * ⛔ THIS STAYS 'web_form'. IT IS NOT A LABEL FOR THIS PAGE. ⛔
 *
 * `consent_method` is a CASL EVIDENCE FIELD. Migration 0034's own header: *"CASL requires us to be
 * able to prove, per recipient, that express consent was obtained: HOW IT WAS OBTAINED
 * (`consent_method`), when (`consent_timestamp`), when it was confirmed by the recipient's own
 * reply, and WHICH WORDING they agreed to."* It records the CHANNEL consent arrived through — not
 * which URL somebody landed on.
 *
 * A parent here fills in a form and ticks a checkbox. That is `web_form` consent. It is correct
 * today, and nothing about this page makes it wrong.
 *
 * ── THE TRAP, WHICH LOOKS LIKE A FREE FIX ───────────────────────────────────────────────
 * `'sms_start'` is already permitted by 0034's CHECK constraint and is currently UNUSED, so it
 * looks available — and this route is called /sms/start, which makes it look intended. It is
 * neither. `'sms_start'` means THE SUBSCRIBER TEXTED THE START KEYWORD: PRD §2.1's door 2, a
 * different consent channel, not yet built. The similarity is a naming coincidence created when
 * this route was named, and nothing more.
 *
 * Setting it here would do two separate kinds of damage:
 *   1. It would assert, in the field a CASL audit reads, that we received a text message from this
 *      person's handset — evidence that does not exist and could never be produced.
 *   2. It would BURN THE VALUE. When the real START-keyword door ships, genuine SMS-originated
 *      consents would be indistinguishable from these web-form signups, destroying the exact
 *      distinction the value exists to make.
 *
 * This was proposed once, in good faith, as a way to tell /sms/start signups apart from
 * /sms/signup's. It was withdrawn. If page-level attribution is wanted, it belongs in the analytics
 * lane (/api/analytics/event + the kf_anon_id cookie) or in a NEW enum value added by migration —
 * anywhere except by overloading a compliance field with a reporting concern.
 *
 * Exported and asserted in tests/sms/start_page.test.tsx, because a comment is not an invariant.
 */
export const START_CONSENT_METHOD = 'web_form' as const;

/**
 * Whether another child row may be added.
 *
 * A one-line predicate with its own export, for the same reason START_CONSENT_METHOD has one: the
 * decision was previously a bare comparison inside JSX, where no test could reach it. The original
 * form's identical cap is UNTESTED at the UI layer for exactly that reason — only the server-side
 * limit in signup-validate.ts is covered — so there was nothing to mirror here, and asserting the
 * boundary directly is the cheapest way to make this one real rather than merely present.
 */
export function canAddAnotherChild(count: number): boolean {
  return count < MAX_CHILDREN;
}

export function StartForm({ sparseRegionIds }: StartFormProps) {
  const [postal, setPostal] = useState('');
  const [children, setChildren] = useState<ChildRow[]>([newChildRow()]);
  const [interests, setInterests] = useState<string[]>([]);
  const [phone, setPhone] = useState('');
  const [consent, setConsent] = useState(false); // UNCHECKED BY DEFAULT — PRD §1.3/§1.4.
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState(false);
  const [errors, setErrors] = useState<SignupFieldError[]>([]);
  const [waitlistConsent, setWaitlistConsent] = useState(false); // UNCHECKED — express consent.
  const [waitlistSending, setWaitlistSending] = useState(false);
  const [waitlistDone, setWaitlistDone] = useState(false);
  const [waitlistError, setWaitlistError] = useState<string | null>(null);

  const errorFor = (f: SmsSignupField) => errors.find((e) => e.field === f);
  const generalError = errors.find((e) => !e.field);
  // Same lesson as the existing form (post-launch item 5): a stale error sitting under a corrected
  // field reads as the product being wrong about something the parent already fixed.
  const clearError = (f: SmsSignupField) =>
    setErrors((cur) => withoutFieldError(cur, f) as SignupFieldError[]);

  const sparseNotice = useMemo(
    () => sparseAreaNoticeFor(postal, sparseRegionIds),
    [postal, sparseRegionIds]
  );

  /**
   * Three-way coverage, recomputed as they type. This is what makes the answer arrive DURING typing
   * rather than after a submit-and-reject — Jon: "very upfront with anybody where we don't have
   * data in their area. Tell them ASAP when they try and sign up."
   */
  const coverage = useMemo(
    () => classifyPostalCoverage(postal, sparseRegionIds),
    [postal, sparseRegionIds]
  );
  const showWaitlist = offersWaitlist(coverage);
  /**
   * OUT OF AREA HAS NO ORDINARY PATH, so the form stops offering one. Leaving the ages, interests
   * and signup button on screen would invite somebody to fill in a form we already know we will
   * reject — which is the dead end Jon asked to remove, not a smaller version of it.
   * A SPARSE area keeps everything: thin is not empty, and the waitlist there is an alternative.
   */
  const waitlistOnly = coverage.kind === 'out_of_area';

  async function submitWaitlist() {
    if (waitlistSending) return;
    setWaitlistError(null);
    setWaitlistSending(true);
    try {
      const res = await fetch('/api/sms/waitlist', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phone, postal, consent: waitlistConsent }),
      });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!res.ok || !data?.ok) {
        setWaitlistSending(false);
        setWaitlistError(data?.error ?? `That didn't work (${res.status}).`);
        return;
      }
      setWaitlistDone(true);
    } catch {
      setWaitlistSending(false);
      setWaitlistError('Network error — please try again.');
    }
  }

  const body = () => ({
    phone,
    postal,
    childAges: children.map((c) => c.age),
    interests,
    consent,
    consentMethod: START_CONSENT_METHOD,
  });

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sending) return;
    setErrors([]);
    const parsed = parseSmsSignupBody(body(), { now: new Date() });
    if (!parsed.ok) {
      setErrors(parsed.errors);
      return;
    }
    setSending(true);
    try {
      const res = await fetch('/api/sms/signup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body()),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as {
          error?: string;
          field?: SmsSignupField;
          errors?: SignupFieldError[];
        } | null;
        setSending(false);
        setErrors(
          data?.errors?.length
            ? data.errors
            : [{ message: data?.error ?? `Couldn’t sign you up (${res.status}).`, field: data?.field }]
        );
        return;
      }
      setDone(true);
    } catch {
      setSending(false);
      setErrors([{ message: 'Network error — please try again.' }]);
    }
  }

  if (waitlistDone) {
    return (
      <div className="kf-start__done" role="status">
        <h2 className="kf-start__done-heading">{WAITLIST_DONE_HEADING}</h2>
        <p>{WAITLIST_DONE_BODY}</p>
      </div>
    );
  }

  if (done) {
    return (
      <div className="kf-start__done" role="status">
        <h2 className="kf-start__done-heading">{SUBMITTED_HEADING}</h2>
        <p>{SUBMITTED_BODY}</p>
      </div>
    );
  }

  const err = (field: SmsSignupField, id: string) => {
    const found = errorFor(field);
    if (!found) return null;
    return (
      <p className="kf-start__error" id={id} role="alert">
        {found.message}
      </p>
    );
  };

  return (
    <form className="kf-start__form" onSubmit={submit} noValidate>
      <label className="kf-start__label" htmlFor="kf-start-postal">
        {FIELD_COPY.postalLabel}
      </label>
      <input
        id="kf-start-postal"
        name="postal"
        className="kf-start__input"
        autoComplete="postal-code"
        placeholder="V5L 1A1"
        value={postal}
        aria-invalid={errorFor('postal') ? true : undefined}
        aria-describedby={errorFor('postal') ? 'kf-start-postal-err' : undefined}
        onChange={(e) => {
          setPostal(e.target.value);
          clearError('postal');
        }}
      />
      {err('postal', 'kf-start-postal-err')}
      {sparseNotice && (
        <p className="kf-start__notice" role="note">
          {sparseNotice.copy}
        </p>
      )}

      {/* Hidden when out of area: see `waitlistOnly`. Asking for a child's age to support a
          signup we already know we will reject would be collecting data for nothing. */}
      {!waitlistOnly && (
      <fieldset className="kf-start__fieldset">
        <legend className="kf-start__label">{FIELD_COPY.childrenLabel}</legend>
        {children.map((child, i) => (
          <div className="kf-start__child" key={child.id}>
            <label className="kf-start__child-label" htmlFor={`kf-start-age-${child.id}`}>
              {`Child ${i + 1}`}
            </label>
            <input
              id={`kf-start-age-${child.id}`}
              name="childAge"
              className="kf-start__input kf-start__input--age"
              type="number"
              inputMode="numeric"
              min={0}
              max={18}
              value={child.age}
              aria-invalid={errorFor('children') ? true : undefined}
              onChange={(e) => {
                const v = e.target.value;
                setChildren((rows) => rows.map((r) => (r.id === child.id ? { ...r, age: v } : r)));
                clearError('children');
              }}
            />
            {children.length > 1 && (
              <button
                type="button"
                className="kf-start__remove"
                onClick={() => {
                  setChildren((rows) => rows.filter((r) => r.id !== child.id));
                  clearError('children');
                }}
              >
                Remove
              </button>
            )}
          </div>
        ))}
        {/* Capped at MAX_CHILDREN, the same guard SmsSignupForm has had since it was built. This
            did NOT carry over when this page was written, so the button was unconditional and a
            parent could add rows indefinitely before the SERVER rejected them at 8 — losing
            everything they had typed to an error they were given no way to anticipate. Reusing the
            same constant rather than a literal 8: the limit is the validator's to define. */}
        {canAddAnotherChild(children.length) && (
          <button
            type="button"
            className="kf-start__add"
            onClick={() => {
              setChildren((rows) => [...rows, newChildRow()]);
              clearError('children');
            }}
          >
            Add another child
          </button>
        )}
        {err('children', 'kf-start-children-err')}
      </fieldset>
      )}

      {!waitlistOnly && (
      <fieldset className="kf-start__fieldset">
        <legend className="kf-start__label">{FIELD_COPY.interestsLabel}</legend>
        <div className="kf-start__interests">
          {SMS_INTEREST_OPTIONS.map((option) => (
            <label className="kf-start__check" key={option.key}>
              <input
                type="checkbox"
                name="interests"
                value={option.key}
                checked={interests.includes(option.key)}
                onChange={() => {
                  setInterests((cur) =>
                    cur.includes(option.key)
                      ? cur.filter((k) => k !== option.key)
                      : [...cur, option.key]
                  );
                  clearError('interests');
                }}
              />
              <span>{option.label}</span>
            </label>
          ))}
        </div>
        {err('interests', 'kf-start-interests-err')}
      </fieldset>
      )}

      <label className="kf-start__label" htmlFor="kf-start-phone">
        {FIELD_COPY.phoneLabel}
      </label>
      <input
        id="kf-start-phone"
        name="phone"
        className="kf-start__input"
        type="tel"
        autoComplete="tel"
        placeholder="604 555 0123"
        value={phone}
        aria-invalid={errorFor('phone') ? true : undefined}
        aria-describedby={errorFor('phone') ? 'kf-start-phone-err' : undefined}
        onChange={(e) => {
          setPhone(e.target.value);
          clearError('phone');
        }}
      />
      {err('phone', 'kf-start-phone-err')}

      {/* ═══ THE AREA WAITLIST ═══
          Appears only for the two classifications that have one. For a SPARSE area it sits below a
          full, working signup form — thin is not empty, and Jon's ruling was that the waitlist is an
          alternative there, not a replacement. For OUT OF AREA it is the only thing on the page,
          because there is no ordinary path to offer.

          It reuses the phone and postal already typed rather than asking again: a second copy of
          either would be a second chance to disagree with the first. */}
      {showWaitlist && (
        <div className="kf-start__waitlist">
          {waitlistOnly && <p className="kf-start__notice">{OUT_OF_AREA_NOTICE}</p>}
          <p className="kf-start__waitlist-cta">
            {waitlistOnly ? WAITLIST_OUT_OF_AREA_CTA : WAITLIST_SPARSE_CTA}
          </p>

          {/* Its OWN consent, separate from the signup checkbox above and never a substitute for
              it. Ticking this agrees to one message about one area — not to the weekly text. */}
          <label className="kf-start__consent">
            <input
              type="checkbox"
              name="waitlistConsent"
              checked={waitlistConsent}
              onChange={(e) => {
                setWaitlistConsent(e.target.checked);
                setWaitlistError(null);
              }}
            />
            <span>{WAITLIST_CONSENT_TEXT}</span>
          </label>

          {waitlistError && (
            <p className="kf-start__error" role="alert">
              {waitlistError}
            </p>
          )}

          <button
            type="button"
            className="kf-start__submit kf-start__submit--secondary"
            disabled={waitlistSending}
            onClick={submitWaitlist}
          >
            {waitlistSending ? 'Saving…' : WAITLIST_SUBMIT}
          </button>
        </div>
      )}

      {/* ═══ THE CONSENT SENTENCE IS SHARED, VERBATIM, WITH /sms/signup ═══
          Not condensed, not reworded, not summarised. The layout around it is simplified; the
          sentence a parent agrees to is byte-identical to the other form's, which is what lets one
          CONSENT_TEXT_VERSION stay true for both pages and keeps a consent row unambiguous about
          which wording it refers to. Rewriting it here would have needed a version bump and a way
          to tell two wordings apart in the audit trail. */}
      {!waitlistOnly && (
        <>
      <label className="kf-start__consent">
        <input
          type="checkbox"
          name="consent"
          checked={consent}
          aria-invalid={errorFor('consent') ? true : undefined}
          onChange={(e) => {
            setConsent(e.target.checked);
            clearError('consent');
          }}
        />
        <span>{CONSENT_CHECKBOX_TEXT}</span>
      </label>
      {err('consent', 'kf-start-consent-err')}

      {generalError && (
        <p className="kf-start__error" role="alert">
          {generalError.message}
        </p>
      )}

      <button type="submit" className="kf-start__submit" disabled={sending}>
        {sending ? 'Signing you up…' : 'Start my weekly texts'}
      </button>
        </>
      )}

      {/* CASL/PIPEDA: sender identification and the carrier disclosures. Condensed in PRESENTATION
          — small type, one block — but every required statement is present and unaltered, from the
          same constants the existing form renders. */}
      <div className="kf-start__legal">
        <p className="kf-start__legal-lead">{SENDER_IDENTITY_LEAD}</p>
        <address className="kf-start__identity">
          {SENDER_IDENTITY.legalName}, operating as {SENDER_IDENTITY.operatingAs}
          <br />
          {SENDER_IDENTITY.mailingAddress}
          <br />
          {SENDER_IDENTITY.businessRegistration}
        </address>
        <p>
          {SUPPORT_LINE.split(SENDER_IDENTITY.supportPhone)[0]}
          <a href={SUPPORT_PHONE_HREF}>{SENDER_IDENTITY.supportPhone}</a>
          {SUPPORT_LINE.split(SENDER_IDENTITY.supportPhone)[1]}
        </p>
        <p>{CARRIER_DISCLOSURES.join(' ')}</p>
        <p>
          <Link href="/terms">Terms</Link> · <Link href="/privacy">Privacy</Link>
        </p>
      </div>
    </form>
  );
}
