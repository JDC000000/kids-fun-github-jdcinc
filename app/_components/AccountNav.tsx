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
        {/* Saved searches were one of the three destinations the desktop nav had no route
            to (Round 31). /account is where they live, alongside the profile, so the label
            names what a parent is actually looking for. It stays in the signed-in branch
            only: /account redirects anonymous visitors to sign-in, and a global nav entry
            that leads to a wall is not navigation. */}
        <a className="kf-account__link" href="/account">
          Saved &amp; profile
        </a>
        {/* Sign-out is a state change → POST, not a GET link (CSRF hardening,
            security-review F-3). A same-site <form> submit reaches the POST-only
            /auth/signout route; native form POST needs no client JS. */}
        <form className="kf-account__signout" method="post" action="/auth/signout">
          <button className="kf-account__link kf-account__button" type="submit">
            Sign out
          </button>
        </form>
      </nav>
    );
  }

  return (
    <nav className="kf-account" aria-label="Account">
      {/* The visible label sheds "with Google" below 768px (see site-nav.css). aria-label carries
          the full wording regardless, so the accessible name never shrinks with the pixels — a
          screen reader still hears which provider it is. Split into spans rather than swapped by
          JS so there is one DOM for both widths and nothing to hydrate. */}
      <a
        className="kf-account__link kf-account__link--primary"
        href="/auth/signin"
        aria-label="Sign in with Google"
      >
        Sign in<span className="kf-account__provider"> with Google</span>
      </a>
    </nav>
  );
}
