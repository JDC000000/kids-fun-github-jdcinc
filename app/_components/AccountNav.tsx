'use client';

// AccountNav — the minimal account-aware UI touchpoint (Task 21, M4).
//
// Mounted globally in the root layout so a sign-in / sign-out control is
// reachable from any page. It polls GET /api/me once on mount and renders one of
// three states: loading (unobtrusive placeholder), signed-in ("Signed in as X"
// + Sign out), or anonymous ("Sign in with Google"). It never blocks or alters
// page content — search/browse work identically signed in or out.
import { useEffect, useState } from 'react';
import './account-nav.css';

interface MeUser {
  id: string;
  email: string | null;
}

interface MeResponse {
  authenticated: boolean;
  user: MeUser | null;
}

type State = { status: 'loading' } | { status: 'ready'; me: MeResponse };

export function AccountNav() {
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    fetch('/api/me', { credentials: 'same-origin' })
      .then((res) => (res.ok ? (res.json() as Promise<MeResponse>) : Promise.reject(new Error(String(res.status)))))
      .then((me) => {
        if (!cancelled) setState({ status: 'ready', me });
      })
      .catch(() => {
        // Treat any probe failure as anonymous — the control still works.
        if (!cancelled) setState({ status: 'ready', me: { authenticated: false, user: null } });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.status === 'loading') {
    return <nav className="kf-account" aria-label="Account" aria-busy="true" />;
  }

  const { me } = state;

  if (me.authenticated && me.user) {
    const label = me.user.email ?? 'your account';
    return (
      <nav className="kf-account" aria-label="Account">
        <span className="kf-account__who" title={label}>
          Signed in as <strong>{label}</strong>
        </span>
        <a className="kf-account__link" href="/account">
          Account
        </a>
        <a className="kf-account__link" href="/auth/signout">
          Sign out
        </a>
      </nav>
    );
  }

  return (
    <nav className="kf-account" aria-label="Account">
      <a className="kf-account__link kf-account__link--primary" href="/auth/signin">
        Sign in with Google
      </a>
    </nav>
  );
}
