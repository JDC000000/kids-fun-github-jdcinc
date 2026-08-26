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

import { useMemo, useState, type FormEvent } from 'react';
import { Button, Input } from '@/components/ui';
import { FIELD_COPY, CONSENT_CHECKBOX_TEXT, PREFERENCES_LINK_LABEL, SUBMITTED_BODY, SUBMITTED_HEADING, WHAT_HAPPENS_NEXT } from '@/lib/sms/consent-copy';
import { SMS_INTEREST_OPTIONS } from '@/lib/sms/interests';
import { MAX_CHILDREN, parseSmsSignupBody, type SmsSignupField } from '@/lib/sms/signup-validate';
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

export function SmsSignupForm({ sparseRegionIds }: SmsSignupFormProps) {
  const [phone, setPhone] = useState('');
  const [postal, setPostal] = useState('');
  const [children, setChildren] = useState<ChildRow[]>([newChildRow()]);
  const [interests, setInterests] = useState<string[]>([]);
  const [consent, setConsent] = useState(false); // UNCHECKED BY DEFAULT — PRD §1.3/§1.4.
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<{ message: string; field?: SmsSignupField } | null>(null);

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
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (phase === 'sending') return;
    setError(null);

    // Same validator the server runs. See this file's header.
    const parsed = parseSmsSignupBody(body(), { now: new Date() });
    if (!parsed.ok) {
      setError({ message: parsed.error, field: parsed.field });
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
          | { error?: string; field?: SmsSignupField }
          | null;
        setPhase('error');
        setError({ message: data?.error ?? `Couldn’t sign you up (${res.status}).`, field: data?.field });
        return;
      }
      setPhase('done');
    } catch {
      setPhase('error');
      setError({ message: 'Network error — please try again.' });
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

  const errFor = (field: SmsSignupField) =>
    error?.field === field ? (
      <p className="kf-sms-signup__err" id={`kf-sms-${field}-err`} role="alert">
        {error.message}
      </p>
    ) : null;

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
          aria-describedby={error?.field === 'phone' ? 'kf-sms-phone-err' : 'kf-sms-phone-help'}
          onChange={(e) => setPhone(e.target.value)}
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
          aria-describedby={error?.field === 'postal' ? 'kf-sms-postal-err' : 'kf-sms-postal-help'}
          onChange={(e) => setPostal(e.target.value)}
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
              name="childAge"
              type="number"
              inputMode="numeric"
              min={0}
              max={18}
              step={1}
              placeholder="e.g. 4"
              value={child.age}
              onChange={(e) =>
                setChildren((rows) =>
                  rows.map((r) => (r.id === child.id ? { ...r, age: e.target.value } : r))
                )
              }
            />
            {/* The last remaining row cannot be removed — one child is the minimum a signup means. */}
            {children.length > 1 && (
              <Button
                type="button"
                variant="ghost"
                onClick={() => setChildren((rows) => rows.filter((r) => r.id !== child.id))}
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
            onClick={() => setChildren((rows) => [...rows, newChildRow()])}
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
            aria-describedby={error?.field === 'consent' ? 'kf-sms-consent-err' : undefined}
            onChange={(e) => setConsent(e.target.checked)}
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

      {/* A failure with no field of its own (network, 503, 404-while-flagged-off). */}
      {error && !error.field && (
        <p className="kf-sms-signup__err" role="alert">
          {error.message}
        </p>
      )}
    </form>
  );
}
