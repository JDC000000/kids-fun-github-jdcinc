'use client';

// AccountForm — the edit form for /account (Task 24, M4).
//
// A minimal controlled form over the editable user_profile fields (home postal
// code + email opt-in). On submit it PATCHes /api/me and reflects the result
// inline (saved / validation error / not-signed-in / server error).
//
// F-8 (PIPEDA / Round 25 Task WW): the children's-ages input was REMOVED — the
// app no longer collects children's ages. The field had no functional consumer,
// so dropping it removes an unnecessary PII collection point. (Any legacy value
// already stored stays exportable/deletable via the account tools below.)
import { useState, type FormEvent } from 'react';
import { Button, Input } from '@/components/ui';

interface InitialProfile {
  home_postal: string | null;
  email_opt_in: boolean;
}

type Status =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'error'; message: string; signin?: boolean };

export function AccountForm({ initial }: { initial: InitialProfile }) {
  const [postal, setPostal] = useState(initial.home_postal ?? '');
  const [optIn, setOptIn] = useState(initial.email_opt_in);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setStatus({ kind: 'saving' });

    const body = {
      home_postal: postal.trim() === '' ? null : postal.trim(),
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
        <Input
          id="home_postal"
          name="home_postal"
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
        <Button variant="primary" type="submit" disabled={saving}>
          {saving ? 'Saving…' : 'Save changes'}
        </Button>

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
