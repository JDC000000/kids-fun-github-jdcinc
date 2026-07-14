'use client';

// AccountForm — the edit form for /account (Task 24, M4).
//
// A minimal controlled form over the three editable user_profile fields. On
// submit it PATCHes /api/me and reflects the result inline (saved / validation
// error / not-signed-in / server error). Children's ages are stored in MONTHS
// (the schema's canonical unit), entered here as a comma-separated list.
import { useState, type FormEvent } from 'react';

interface InitialProfile {
  home_postal: string | null;
  saved_child_ages: number[];
  email_opt_in: boolean;
}

type Status =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'error'; message: string; signin?: boolean };

/** Parse the comma-separated ages field into whole months. Returns an error
 *  string (not throwing) so the form can surface it before hitting the server. */
function parseAges(text: string): { ok: true; ages: number[] } | { ok: false; error: string } {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: true, ages: [] };
  const ages: number[] = [];
  for (const piece of trimmed.split(',')) {
    const token = piece.trim();
    if (token === '') continue;
    const n = Number(token);
    if (!Number.isInteger(n) || n < 0) {
      return { ok: false, error: `"${token}" isn't a whole number of months` };
    }
    ages.push(n);
  }
  return { ok: true, ages };
}

export function AccountForm({ initial }: { initial: InitialProfile }) {
  const [postal, setPostal] = useState(initial.home_postal ?? '');
  const [agesText, setAgesText] = useState(initial.saved_child_ages.join(', '));
  const [optIn, setOptIn] = useState(initial.email_opt_in);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setStatus({ kind: 'saving' });

    const parsedAges = parseAges(agesText);
    if (!parsedAges.ok) {
      setStatus({ kind: 'error', message: parsedAges.error });
      return;
    }

    const body = {
      home_postal: postal.trim() === '' ? null : postal.trim(),
      saved_child_ages: parsedAges.ages,
      email_opt_in: optIn,
    };

    try {
      const res = await fetch('/api/me', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      });

      if (res.status === 401) {
        setStatus({ kind: 'error', message: 'Your session has expired. Please sign in again.', signin: true });
        return;
      }

      const data = (await res.json().catch(() => null)) as
        | { ok: boolean; error?: string; profile?: InitialProfile }
        | null;

      if (!res.ok || !data?.ok) {
        setStatus({ kind: 'error', message: data?.error ?? `Save failed (${res.status}).` });
        return;
      }

      // Reflect the server-normalized values (e.g. tidied postal code).
      if (data.profile) {
        setPostal(data.profile.home_postal ?? '');
        setAgesText((data.profile.saved_child_ages ?? []).join(', '));
        setOptIn(Boolean(data.profile.email_opt_in));
      }
      setStatus({ kind: 'saved' });
    } catch {
      setStatus({ kind: 'error', message: 'Network error — please try again.' });
    }
  }

  const saving = status.kind === 'saving';

  return (
    <form className="kf-account-form" onSubmit={onSubmit} noValidate>
      <div className="kf-account-form__field">
        <label className="kf-account-form__label" htmlFor="home_postal">
          Saved postal code
        </label>
        <input
          id="home_postal"
          name="home_postal"
          className="kf-account-form__input"
          type="text"
          inputMode="text"
          autoComplete="postal-code"
          placeholder="e.g. V6B 1A1"
          value={postal}
          onChange={(e) => setPostal(e.target.value)}
        />
        <p className="kf-account-form__hint">
          Used to remember your area. Leave blank to clear it.
        </p>
      </div>

      <div className="kf-account-form__field">
        <label className="kf-account-form__label" htmlFor="saved_child_ages">
          Children&apos;s ages (in months)
        </label>
        <input
          id="saved_child_ages"
          name="saved_child_ages"
          className="kf-account-form__input"
          type="text"
          inputMode="numeric"
          placeholder="e.g. 18, 36, 60"
          value={agesText}
          onChange={(e) => setAgesText(e.target.value)}
        />
        <p className="kf-account-form__hint">
          Comma-separated, in months (24 = 2 years). Leave blank if you&apos;d rather not say.
        </p>
      </div>

      <div className="kf-account-form__field kf-account-form__field--check">
        <input
          id="email_opt_in"
          name="email_opt_in"
          className="kf-account-form__checkbox"
          type="checkbox"
          checked={optIn}
          onChange={(e) => setOptIn(e.target.checked)}
        />
        <label className="kf-account-form__label kf-account-form__label--inline" htmlFor="email_opt_in">
          Email me occasional updates about new activities
        </label>
      </div>

      <div className="kf-account-form__actions">
        <button className="kf-account-form__submit" type="submit" disabled={saving}>
          {saving ? 'Saving…' : 'Save changes'}
        </button>

        {status.kind === 'saved' && (
          <span className="kf-account-form__msg kf-account-form__msg--ok" role="status">
            Saved.
          </span>
        )}
        {status.kind === 'error' && (
          <span className="kf-account-form__msg kf-account-form__msg--err" role="alert">
            {status.message}
            {status.signin && (
              <>
                {' '}
                <a href="/auth/signin?next=/account">Sign in</a>.
              </>
            )}
          </span>
        )}
      </div>
    </form>
  );
}
