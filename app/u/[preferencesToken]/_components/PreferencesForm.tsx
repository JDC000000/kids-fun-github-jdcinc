'use client';

// PreferencesForm — the editable half of the preferences page (PRD §2.4).
//
// DRAFT (SMS pivot). Three controls, deliberately separated by consequence: edit (reversible),
// unsubscribe (reversible by signing up again), delete (irreversible).
//
// ── REUSES THE SIGNUP FORM'S VALIDATOR, NOT A COPY OF IT ────────────────────────────────
// `parseProfileFields` is the SAME function the signup form and the API route both run. A rule
// enforced at signup and not on edit is a rule that does not exist — "V5L 1A1 was fine when I
// signed up but is rejected when I change it" is exactly the drift a second implementation
// creates. The server re-validates from scratch and trusts nothing from here; this is about the
// two answers agreeing.
//
// ── THE DELETE CONTROL IS TWO-STEP, AND THAT IS LOAD-BEARING ────────────────────────────
// `decideDelete` erases immediately rather than waiting out §1.3's 30-day window, on the argument
// that the grace period exists to catch an ACCIDENT and an explicit request is definitionally not
// one. That argument only holds if the request really is explicit — so the accident guard moves
// here, to a confirmation step, where it stops the mistake instead of giving you a month to notice
// it. Deleting the confirmation step would quietly invalidate the reasoning in `decideDelete`.

import { useState, type FormEvent } from 'react';
import { Button, Input } from '@/components/ui';
import {
  FIELD_COPY,
  PREFS_DELETE,
  PREFS_DELETE_BODY,
  PREFS_DELETE_CANCEL,
  PREFS_DELETE_CONFIRM,
  PREFS_DELETE_HEADING,
  PREFS_DELETED,
  PREFS_EDIT_HEADING,
  PREFS_SAVE,
  PREFS_SAVED,
  PREFS_SAVING,
  PREFS_UNSUBSCRIBE,
  PREFS_UNSUBSCRIBE_BODY,
  PREFS_UNSUBSCRIBE_HEADING,
  PREFS_UNSUBSCRIBED,
} from '@/lib/sms/consent-copy';
import { SMS_INTEREST_OPTIONS } from '@/lib/sms/interests';
import { MAX_CHILDREN, parseProfileFields, type SmsSignupField } from '@/lib/sms/signup-validate';
import type { PreferencesView } from '@/lib/sms/preferences';

interface PreferencesFormProps {
  /** Passed to the POST body, never rendered into the DOM as a value a page scrape would find. */
  token: string;
  view: PreferencesView;
  /** False for a purged or stopped subscriber — nothing left to edit. */
  editable: boolean;
}

type Phase = 'idle' | 'saving' | 'saved' | 'unsubscribed' | 'deleted' | 'error';

interface ChildRow {
  id: number;
  age: string;
}

let nextChildId = 1;
const newChildRow = (age = ''): ChildRow => ({ id: nextChildId++, age });

export function PreferencesForm({ token, view, editable }: PreferencesFormProps) {
  const [postal, setPostal] = useState(view.postalCode ?? '');
  const [children, setChildren] = useState<ChildRow[]>(
    view.childAges.length > 0 ? view.childAges.map((a) => newChildRow(String(a))) : [newChildRow()]
  );
  const [interests, setInterests] = useState<string[]>([...view.categoryInterests]);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<{ message: string; field?: SmsSignupField } | null>(null);

  function profileBody() {
    return { postal, childAges: children.map((c) => c.age), interests };
  }

  async function post(action: 'save' | 'unsubscribe' | 'delete', extra: object = {}) {
    setError(null);
    setPhase('saving');
    try {
      const res = await fetch('/api/sms/preferences', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // The token travels in the BODY, not the URL — a POST path lands in access and proxy logs
        // exactly like a GET path does, and this is the one request that need not put it there.
        body: JSON.stringify({ token, action, ...extra }),
      });
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; error?: string; field?: SmsSignupField }
        | null;
      if (!res.ok || !data?.ok) {
        setPhase('error');
        setError({ message: data?.error ?? `That didn’t work (${res.status}).`, field: data?.field });
        return false;
      }
      setPhase(action === 'save' ? 'saved' : action === 'unsubscribe' ? 'unsubscribed' : 'deleted');
      return true;
    } catch {
      setPhase('error');
      setError({ message: 'Network error — please try again.' });
      return false;
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (phase === 'saving') return;
    // Same validator the route runs. See this file's header.
    const parsed = parseProfileFields(profileBody(), { now: new Date() });
    if (!parsed.ok) {
      setError({ message: parsed.error, field: parsed.field });
      setPhase('error');
      return;
    }
    await post('save', profileBody());
  }

  if (phase === 'deleted') {
    return (
      <p className="kf-prefs__done" role="status">
        {PREFS_DELETED}
      </p>
    );
  }
  if (phase === 'unsubscribed') {
    return (
      <p className="kf-prefs__done" role="status">
        {PREFS_UNSUBSCRIBED}
      </p>
    );
  }

  const errFor = (field: SmsSignupField) =>
    error?.field === field ? (
      <p className="kf-prefs__err" role="alert">
        {error.message}
      </p>
    ) : null;

  return (
    <>
      {editable && (
        <section className="kf-prefs__section">
          <h2 className="kf-prefs__subheading">{PREFS_EDIT_HEADING}</h2>
          <form className="kf-prefs__form" onSubmit={save} noValidate>
            <div className="kf-prefs__field">
              <label className="kf-prefs__label" htmlFor="kf-prefs-postal">
                {FIELD_COPY.postalLabel}
              </label>
              <Input
                id="kf-prefs-postal"
                name="postal"
                type="text"
                autoComplete="postal-code"
                maxLength={12}
                value={postal}
                onChange={(e) => setPostal(e.target.value)}
              />
              {errFor('postal')}
            </div>

            <fieldset className="kf-prefs__field kf-prefs__fieldset">
              <legend className="kf-prefs__label">{FIELD_COPY.childrenLabel}</legend>
              <p className="kf-prefs__help">{FIELD_COPY.childrenHelp}</p>
              {children.map((child, index) => (
                <div className="kf-prefs__child" key={child.id}>
                  <label className="kf-prefs__child-label" htmlFor={`kf-prefs-child-${child.id}`}>
                    Child {index + 1}
                  </label>
                  <Input
                    id={`kf-prefs-child-${child.id}`}
                    className="kf-prefs__child-input"
                    name="childAge"
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={18}
                    step={1}
                    value={child.age}
                    onChange={(e) =>
                      setChildren((rows) =>
                        rows.map((r) => (r.id === child.id ? { ...r, age: e.target.value } : r))
                      )
                    }
                  />
                  {children.length > 1 && (
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => setChildren((rows) => rows.filter((r) => r.id !== child.id))}
                    >
                      {FIELD_COPY.removeChild}
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

            <fieldset className="kf-prefs__field kf-prefs__fieldset">
              <legend className="kf-prefs__label">{FIELD_COPY.interestsLabel}</legend>
              <div className="kf-prefs__interests">
                {SMS_INTEREST_OPTIONS.map((option) => (
                  <label className="kf-prefs__interest" key={option.key}>
                    <input
                      type="checkbox"
                      name="interests"
                      value={option.key}
                      checked={interests.includes(option.key)}
                      onChange={() =>
                        setInterests((current) =>
                          current.includes(option.key)
                            ? current.filter((k) => k !== option.key)
                            : [...current, option.key]
                        )
                      }
                    />
                    <span>{option.label}</span>
                  </label>
                ))}
              </div>
              {errFor('interests')}
            </fieldset>

            <Button type="submit" disabled={phase === 'saving'} aria-busy={phase === 'saving'}>
              {phase === 'saving' ? PREFS_SAVING : PREFS_SAVE}
            </Button>
            {phase === 'saved' && (
              <p className="kf-prefs__ok" role="status">
                {PREFS_SAVED}
              </p>
            )}
            {error && !error.field && (
              <p className="kf-prefs__err" role="alert">
                {error.message}
              </p>
            )}
          </form>
        </section>
      )}

      {/* ── Unsubscribe. One step: it is reversible by signing up again, and CASL wants the
          opt-out to be as frictionless as possible. Adding a confirmation here would be putting
          an obstacle in front of the one control a regulator cares most about. ── */}
      <section className="kf-prefs__section kf-prefs__section--danger">
        <h2 className="kf-prefs__subheading">{PREFS_UNSUBSCRIBE_HEADING}</h2>
        <p className="kf-prefs__help">{PREFS_UNSUBSCRIBE_BODY}</p>
        <Button
          type="button"
          variant="secondary"
          disabled={phase === 'saving'}
          onClick={() => post('unsubscribe')}
        >
          {PREFS_UNSUBSCRIBE}
        </Button>
      </section>

      {/* ── Delete. TWO steps, and the second is not decoration: see this file's header and
          `decideDelete`. The immediate-erasure argument depends on the request being explicit. ── */}
      <section className="kf-prefs__section kf-prefs__section--danger">
        <h2 className="kf-prefs__subheading">{PREFS_DELETE_HEADING}</h2>
        <p className="kf-prefs__help">{PREFS_DELETE_BODY}</p>
        {!confirmingDelete ? (
          <Button type="button" variant="danger" onClick={() => setConfirmingDelete(true)}>
            {PREFS_DELETE}
          </Button>
        ) : (
          <div className="kf-prefs__confirm">
            <Button
              type="button"
              variant="danger"
              disabled={phase === 'saving'}
              onClick={() => post('delete')}
            >
              {PREFS_DELETE_CONFIRM}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setConfirmingDelete(false)}>
              {PREFS_DELETE_CANCEL}
            </Button>
          </div>
        )}
      </section>
    </>
  );
}
