'use client';

// SmsSignupForm — the public SMS signup form (PRD §2.1).
//
// DRAFT (SMS pivot). Closest existing precedent: app/search/_components/RegionNotifyForm.tsx —
// a no-login form that collects contact details and posts them to a route that writes one row.
// The posture is carried over wholesale, including the part that matters most:
//
//   NO OPTIMISTIC ACKNOWLEDGEMENT. This form says "we'll text you", so it may only say so once
//   the server has confirmed the consent row exists. RegionNotifyForm makes the same call for
//   the same reason, and contrasts itself with the corrections control, which shows its thanks
//   whether or not the write landed — a correction is a gift, and losing it costs the parent
//   nothing they were promised. A signup promises a message.
//
// ── ONE VALIDATOR, BOTH SIDES ────────────────────────────────────────────────────────────
// The inline errors come from `parseSmsSignupBody` — the SAME pure function the API route
// enforces with. Not a client-side approximation of it. A second, friendlier copy is how a form
// ends up accepting something the server then rejects with a message nobody wrote for a human,
// or (worse) rejecting something the server would have taken. The server still re-validates from
// scratch and trusts nothing from here; this is about the two answers agreeing, not about
// skipping the server check.
//
// ── CONSENT IS UNCHECKED AND THE BUTTON IS NOT DISABLED ──────────────────────────────────
// Unchecked by default is required (PRD §1.3/§1.4) and is what `useState(false)` gives. The
// submit button is deliberately NOT disabled while it is unchecked: a disabled button explains
// nothing, and a parent who has filled in everything else and cannot work out why the button is
// dead is a lost signup. Submitting with it unticked produces a real, focused error that says
// what to do.

import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Input } from '@/components/ui';
import { FIELD_COPY, CONSENT_CHECKBOX_TEXT, PREFERENCES_LINK_LABEL, SUBMITTED_BODY, SUBMITTED_HEADING, WHAT_HAPPENS_NEXT } from '@/lib/sms/consent-copy';
import { SMS_INTEREST_OPTIONS } from '@/lib/sms/interests';
import {
  MAX_CHILDREN,
  parseSmsSignupBody,
  type SignupFieldError,
  type SmsSignupField,
} from '@/lib/sms/signup-validate';
import { fieldA11y } from '@/lib/sms/form-a11y';
import { sparseAreaNoticeFor } from '@/lib/sms/sparse-areas';

interface SmsSignupFormProps {
  /**
   * Covered municipalities the catalogue is currently thin in, measured server-side (see the
   * page). Passed down rather than fetched so the notice can appear as the parent types the
   * postal code, with no round trip and no loading state on a warning.
   */
  sparseRegionIds: string[];
}

type Phase = 'idle' | 'sending' | 'done' | 'error';

/** One child row. `id` is a stable React key — ages repeat, indices shift when a row is removed. */
interface ChildRow {
  id: number;
  age: string;
}

let nextChildId = 1;
function newChildRow(): ChildRow {
  return { id: nextChildId++, age: '' };
}

// Split once, at module load, so the render path cannot reorder the consent sentence.
const [consentBefore, consentAfter] = CONSENT_CHECKBOX_TEXT.split(PREFERENCES_LINK_LABEL);

/**
 * Drop the error belonging to one field, PRESERVING THE ARRAY IDENTITY when there is nothing to
 * drop.
 *
 * Exported and pure so it can be tested: this component's suite renders with
 * `renderToStaticMarkup` and deliberately carries no @testing-library dependency, so the initial
 * render is the only thing it can observe. The interesting behaviour here happens on the fourth
 * keystroke of a correction, which that harness cannot reach — so the decision lives in a function
 * instead of inside a closure where it would be untestable.
 *
 * The identity guard is not a micro-optimisation. `setErrors` with a fresh array on every
 * keystroke would re-render the whole form for each character typed into a field that has no
 * error at all — which is every field, most of the time.
 */
export function withoutFieldError(
  errors: readonly SignupFieldError[],
  field: SmsSignupField
): readonly SignupFieldError[] {
  return errors.some((e) => e.field === field) ? errors.filter((e) => e.field !== field) : errors;
}

export function SmsSignupForm({ sparseRegionIds }: SmsSignupFormProps) {
  const [phone, setPhone] = useState('');
  const [postal, setPostal] = useState('');
  const [children, setChildren] = useState<ChildRow[]>([newChildRow()]);
  const [interests, setInterests] = useState<string[]>([]);
  const [consent, setConsent] = useState(false); // UNCHECKED BY DEFAULT — PRD §1.3/§1.4.
  const [phase, setPhase] = useState<Phase>('idle');
  // EVERY failure, not the first (PRD §8 item 2, Jon: "Show all errors at once"). The validator
  // returns them in form order, so this list renders top to bottom the way the page reads.
  const [errors, setErrors] = useState<SignupFieldError[]>([]);
  /**
   * Counts SUBMITS, not errors — and it exists so the scroll effect below can tell the two apart.
   * See that effect, and `clearFieldError`, for why keying on `errors` is wrong once errors can
   * disappear while somebody is typing.
   */
  const [submitCount, setSubmitCount] = useState(0);
  const errorFor = (field: SmsSignupField) => errors.find((e) => e.field === field);

  /**
   * ═══ THE STALE ERROR, AND WHY IT LOOKED INTERMITTENT ═══
   * Errors were previously cleared ONLY at the top of `submit`. So after an out-of-area postal
   * code was rejected, correcting it left the rejection sitting under the field it no longer
   * described — the form saying "we don't cover that area" directly beneath a covered one, until
   * a second submit. Reported as intermittent because it resolves itself the moment you resubmit,
   * so whether you ever see it depends only on whether you read the page before pressing again.
   *
   * The postal field made it worst because it carries a SECOND, live signal: `sparseNotice` below
   * recomputes on every keystroke. So the two messages about the same field disagreed on screen
   * at the same time, one fresh and one stale.
   *
   * Returns `current` unchanged when there is nothing to drop, so typing in a field with no error
   * does not queue a re-render on every keystroke.
   */
  function clearFieldError(field: SmsSignupField) {
    setErrors((current) => withoutFieldError(current, field) as SignupFieldError[]);
  }
  // A failure with no field of its own (network, 503, 404-while-flagged-off).
  const generalError = errors.find((e) => !e.field);
  const errorRef = useRef<HTMLParagraphElement | null>(null);

  // BRING THE ERROR TO THE PERSON, rather than expecting them to go and find it. V1 testing
  // compared screenshots and found the out-of-area notice renders next to the POSTAL field, which
  // on a phone is most of a screen above the Submit button they just pressed — so a rejected
  // submit looked like nothing happened at all. Runs on every new error, including the ones that
  // come back from the server after a round trip.
  //
  // `block: 'center'` rather than 'start': the field the error belongs to sits directly above it,
  // and centring brings both into view instead of pinning the message to the top edge with its
  // own field scrolled off.
  //
  // Focus is deliberately NOT moved. The error node carries role="alert", which screen readers
  // announce without being focused; stealing focus mid-correction would fight a sighted keyboard
  // user who is already on their way back to the field.
  // Scrolls to the FIRST error, which — because the validator returns them in form order — is the
  // topmost one on the page. Bringing someone to the bottom of a list of problems would be worse
  // than not scrolling at all.
  //
  // ⚠ KEYED ON `submitCount`, NOT ON `errors` — and that is load-bearing, not a style choice.
  // Now that fixing a field clears its error as you type, an `[errors]` dependency would fire this
  // scroll on the CORRECTION too: land in the postal field, delete one character, and the page
  // yanks itself to whatever error is now topmost, mid-edit. Scrolling belongs to the act of
  // submitting, so it keys on submits.
  //
  // `errors` is read but deliberately not a dependency; the lint exception is the whole point of
  // the comment above.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (submitCount === 0) return; // nothing has been submitted yet
    if (errors.length === 0) return;
    errorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [submitCount]);

  // Recomputed as they type. Pure, no request — see the prop's comment.
  const sparseNotice = useMemo(
    () => sparseAreaNoticeFor(postal, sparseRegionIds),
    [postal, sparseRegionIds]
  );

  function body() {
    return {
      phone,
      postal,
      childAges: children.map((c) => c.age),
      interests,
      consent,
      consentMethod: 'web_form' as const,
    };
  }

  function toggleInterest(key: string) {
    setInterests((current) =>
      current.includes(key) ? current.filter((k) => k !== key) : [...current, key]
    );
    clearFieldError('interests');
  }

  /**
   * The children error belongs to the FIELDSET, not to a row — so any edit to any row clears it,
   * including adding or removing a row. A parent who was told "add at least one child" and then
   * typed an age has answered the objection, whichever row they typed it into.
   */
  function editChildren(update: (rows: ChildRow[]) => ChildRow[]) {
    setChildren(update);
    clearFieldError('children');
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (phase === 'sending') return;
    setErrors([]);
    // Every attempt, including one that produces the SAME errors as the last — otherwise a repeat
    // submit with an unchanged mistake would scroll nowhere and look like nothing happened.
    setSubmitCount((n) => n + 1);

    // Same validator the server runs. See this file's header.
    const parsed = parseSmsSignupBody(body(), { now: new Date() });
    if (!parsed.ok) {
      setErrors(parsed.errors);
      return;
    }

    setPhase('sending');
    try {
      const res = await fetch('/api/sms/signup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body()),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as
          | { error?: string; field?: SmsSignupField; errors?: SignupFieldError[] }
          | null;
        setPhase('error');
        // Prefer the full list; fall back to the single-error contract for any response that does
        // not carry one (a 413, a 503, a 404 while the flag is off).
        setErrors(
          data?.errors?.length
            ? data.errors
            : [{ message: data?.error ?? `Couldn’t sign you up (${res.status}).`, field: data?.field }]
        );
        return;
      }
      setPhase('done');
    } catch {
      setPhase('error');
      setErrors([{ message: 'Network error — please try again.' }]);
    }
  }

  if (phase === 'done') {
    return (
      <div className="kf-sms-signup__done" role="status">
        <h2 className="kf-sms-signup__done-heading">{SUBMITTED_HEADING}</h2>
        <p>{SUBMITTED_BODY}</p>
      </div>
    );
  }

  const errFor = (field: SmsSignupField) => {
    const found = errorFor(field);
    if (!found) return null;
    // The ref goes on the FIRST error only — several nodes claiming it would leave the last one
    // rendered holding it, which is the bottom of the page rather than the top.
    const isFirst = errors[0] === found;
    return (
      <p
        className="kf-sms-signup__err"
        id={`kf-sms-${field}-err`}
        role="alert"
        ref={isFirst ? errorRef : undefined}
      >
        {found.message}
      </p>
    );
  };

  return (
    <form className="kf-sms-signup__form" onSubmit={submit} noValidate>
      {/* ── Phone ── */}
      <div className="kf-sms-signup__field">
        <label className="kf-sms-signup__label" htmlFor="kf-sms-phone">
          {FIELD_COPY.phoneLabel}
        </label>
        <Input
          id="kf-sms-phone"
          type="tel"
          name="phone"
          inputMode="tel"
          autoComplete="tel"
          placeholder="604 555 0123"
          value={phone}
          {...fieldA11y('phone', errorFor('phone')?.field, {
            errorId: 'kf-sms-phone-err',
            helpId: 'kf-sms-phone-help',
          })}
          onChange={(e) => {
            setPhone(e.target.value);
            clearFieldError('phone');
          }}
        />
        <p className="kf-sms-signup__help" id="kf-sms-phone-help">
          {FIELD_COPY.phoneHelp}
        </p>
        {errFor('phone')}
      </div>

      {/* ── Postal ── */}
      <div className="kf-sms-signup__field">
        <label className="kf-sms-signup__label" htmlFor="kf-sms-postal">
          {FIELD_COPY.postalLabel}
        </label>
        <Input
          id="kf-sms-postal"
          type="text"
          name="postal"
          autoComplete="postal-code"
          placeholder="V5L 1A1"
          maxLength={12}
          value={postal}
          {...fieldA11y('postal', errorFor('postal')?.field, {
            errorId: 'kf-sms-postal-err',
            helpId: 'kf-sms-postal-help',
          })}
          onChange={(e) => {
            setPostal(e.target.value);
            clearFieldError('postal');
          }}
        />
        <p className="kf-sms-signup__help" id="kf-sms-postal-help">
          {FIELD_COPY.postalHelp}
        </p>
        {/*
          The sparse-area warning (PRD §2.1), shown BEFORE submit. Setting the expectation now is
          the cheapest churn defence available: the alternative is a West Vancouver parent
          confirming, receiving an empty-week text, and reasonably concluding this does not work.
          It is a warning, never a block — thin coverage is real coverage, and it can improve.
        */}
        {sparseNotice && (
          <p className="kf-sms-signup__notice" role="note">
            {sparseNotice.copy}
          </p>
        )}
        {errFor('postal')}
      </div>

      {/* ── Children ── */}
      <fieldset className="kf-sms-signup__field kf-sms-signup__fieldset">
        <legend className="kf-sms-signup__label">{FIELD_COPY.childrenLabel}</legend>
        <p className="kf-sms-signup__help">{FIELD_COPY.childrenHelp}</p>
        {children.map((child, index) => (
          <div className="kf-sms-signup__child" key={child.id}>
            <label className="kf-sms-signup__child-label" htmlFor={`kf-sms-child-${child.id}`}>
              Child {index + 1}
            </label>
            <Input
              id={`kf-sms-child-${child.id}`}
              className="kf-sms-signup__child-input"
              // The children error belongs to the fieldset, not to one row, so EVERY row is
              // marked — a screen reader user tabbing through has no way to know which age we
              // rejected, and guessing one would be worse than marking the group.
              {...fieldA11y('children', errorFor('children')?.field, { errorId: 'kf-sms-children-err' })}
              name="childAge"
              type="number"
              inputMode="numeric"
              min={0}
              max={18}
              step={1}
              placeholder="e.g. 4"
              value={child.age}
              onChange={(e) =>
                editChildren((rows) =>
                  rows.map((r) => (r.id === child.id ? { ...r, age: e.target.value } : r))
                )
              }
            />
            {/* The last remaining row cannot be removed — one child is the minimum a signup means. */}
            {children.length > 1 && (
              <Button
                type="button"
                variant="ghost"
                onClick={() => editChildren((rows) => rows.filter((r) => r.id !== child.id))}
              >
                <span className="kf-sms-signup__sr-only">
                  {FIELD_COPY.removeChild} child {index + 1}
                </span>
                <span aria-hidden="true">{FIELD_COPY.removeChild}</span>
              </Button>
            )}
          </div>
        ))}
        {children.length < MAX_CHILDREN && (
          <Button
            type="button"
            variant="secondary"
            onClick={() => editChildren((rows) => [...rows, newChildRow()])}
          >
            {FIELD_COPY.addChild}
          </Button>
        )}
        {errFor('children')}
      </fieldset>

      {/* ── Interests (optional) ── */}
      <fieldset className="kf-sms-signup__field kf-sms-signup__fieldset">
        <legend className="kf-sms-signup__label">{FIELD_COPY.interestsLabel}</legend>
        <p className="kf-sms-signup__help">{FIELD_COPY.interestsHelp}</p>
        <div className="kf-sms-signup__interests">
          {SMS_INTEREST_OPTIONS.map((option) => (
            <label className="kf-sms-signup__interest" key={option.key}>
              <input
                type="checkbox"
                name="interests"
                value={option.key}
                checked={interests.includes(option.key)}
                onChange={() => toggleInterest(option.key)}
              />
              <span>{option.label}</span>
            </label>
          ))}
        </div>
        {errFor('interests')}
      </fieldset>

      {/* ── Consent ── */}
      <div className="kf-sms-signup__field">
        <label className="kf-sms-signup__consent">
          <input
            type="checkbox"
            name="consent"
            checked={consent}
            {...fieldA11y('consent', errorFor('consent')?.field, { errorId: 'kf-sms-consent-err' })}
            onChange={(e) => {
              setConsent(e.target.checked);
              clearFieldError('consent');
            }}
          />
          {/*
            The consent sentence is rendered VERBATIM, with the "preferences page" phrase
            emphasised IN PLACE rather than moved. Splitting on the phrase and reassembling
            around it is why: this string is what `consent_text_version` stands for, and a
            component that reorders or drops any of it would make that column point at wording
            no parent ever saw. tests/sms/consent_copy.test.ts asserts the reassembly is lossless.

            It is <strong>, not a link, because the preferences page is token-linked PER
            SUBSCRIBER (PRD §2.4) and therefore has no address until someone is a subscriber. A
            link here would 404 for every reader of this form. Naming the destination satisfies
            §1.3's "where to view/edit/delete"; inventing a URL for it would not.
          */}
          <span>
            {consentBefore}
            <strong>{PREFERENCES_LINK_LABEL}</strong>
            {consentAfter}
          </span>
        </label>
        {errFor('consent')}
      </div>

      <p className="kf-sms-signup__next">{WHAT_HAPPENS_NEXT}</p>

      <Button type="submit" disabled={phase === 'sending'} aria-busy={phase === 'sending'}>
        {phase === 'sending' ? FIELD_COPY.submitting : FIELD_COPY.submit}
      </Button>

      {generalError && (
        <p
          className="kf-sms-signup__err"
          role="alert"
          ref={errors[0] === generalError ? errorRef : undefined}
        >
          {generalError.message}
        </p>
      )}
    </form>
  );
}
