'use client';

// SaveSearchButton — the "Save this search" control on /search (Round 10 / Task B,
// M4/G5). Task 38 shipped the whole saved-search backend (POST/GET/DELETE
// /api/saved-searches, RLS-owner-scoped) but EXPLICITLY deferred the search-page
// save button; this closes that gap.
//
// It POSTs the current, already-serialized filter state to the existing endpoint —
// it does NOT re-derive the API contract (see app/search/_lib/params.ts
// serializeStateToParams for how the page URL becomes the persisted `params`, and
// app/account/_components/SavedSearches.tsx for the sibling GET/DELETE consumer).
//
// Styling: uses the canonical shared primitives (components/ui — Button for the
// save action, Badge for the "Saved" status pill; Round 10 / Task D), so this
// surface stays on-brand and token-driven rather than hand-rolling its own button.
//
// Graceful edges (all required by the task):
//   • signed-out    → the primary action initiates the existing Google OAuth flow
//                     (/auth/signin?next=<this search>), so the parent returns to
//                     the exact same search and can save it. Never a silent error.
//   • already saved → the server computes `initialSaved` (this search's canonical
//                     key already exists in the user's rows) and we render a "Saved"
//                     badge with no button, so no duplicate row is created. The
//                     component is remounted per-search (key={paramsKey} upstream),
//                     so this state is always fresh for the current URL.
//   • session lost  → a 401 mid-session re-surfaces the sign-in action.
//   • DB / network  → an inline, retryable error; nothing is faked.
import { useState } from 'react';
import { Button, Badge } from '@/components/ui';

interface SaveSearchButtonProps {
  /** The current search serialized to its persisted `params` shape (string map). */
  params: Record<string, string>;
  /** Server-suggested friendly name (query text or a filter summary); '' → unnamed. */
  defaultName: string;
  /** Whether a session was present at render time. */
  isSignedIn: boolean;
  /** OAuth sign-in link that returns to this exact search after consent. */
  signInHref: string;
  /** Where the parent manages saved searches (the /account list). */
  accountHref: string;
  /** Server-computed: this exact search is already in the user's saved rows. */
  initialSaved: boolean;
}

type Phase = 'idle' | 'saving' | 'saved' | 'error' | 'signin';

export function SaveSearchButton({
  params,
  defaultName,
  isSignedIn,
  signInHref,
  accountHref,
  initialSaved,
}: SaveSearchButtonProps) {
  const [phase, setPhase] = useState<Phase>(initialSaved ? 'saved' : 'idle');
  const [message, setMessage] = useState('');

  // /auth/signin is a route handler (server redirect into Google OAuth), so it needs
  // a full-page navigation, not client-side routing.
  function goSignIn() {
    window.location.assign(signInHref);
  }

  async function save() {
    setPhase('saving');
    setMessage('');
    try {
      const res = await fetch('/api/saved-searches', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ name: defaultName.trim() === '' ? null : defaultName.trim(), params }),
      });

      if (res.status === 401) {
        // Session lapsed between page render and click — send them back through OAuth.
        setPhase('signin');
        return;
      }

      const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!res.ok || !data?.ok) {
        setPhase('error');
        setMessage(data?.error ?? `Couldn't save (${res.status}).`);
        return;
      }

      setPhase('saved');
    } catch {
      setPhase('error');
      setMessage('Network error — please try again.');
    }
  }

  return (
    <section className="kf-savebar" aria-label="Save this search">
      {!isSignedIn ? (
        <>
          <Button variant="primary" onClick={goSignIn}>
            <span className="kf-savebar__glyph" aria-hidden="true">
              ☆
            </span>
            Save this search
          </Button>
          <span className="kf-savebar__hint">Sign in with Google to save searches and come back to them later.</span>
        </>
      ) : phase === 'saved' ? (
        <>
          <Badge variant="confirmed" role="status">
            <span className="kf-savebar__glyph" aria-hidden="true">
              ★
            </span>
            Saved
          </Badge>
          <a className="kf-savebar__link" href={accountHref}>
            View your saved searches
          </a>
        </>
      ) : phase === 'signin' ? (
        <>
          <span className="kf-savebar__hint kf-savebar__hint--err" role="alert">
            Your session expired.
          </span>
          <Button variant="primary" onClick={goSignIn}>
            Sign in to save
          </Button>
        </>
      ) : (
        <>
          <Button variant="primary" onClick={save} disabled={phase === 'saving'} aria-busy={phase === 'saving'}>
            <span className="kf-savebar__glyph" aria-hidden="true">
              ☆
            </span>
            {phase === 'saving' ? 'Saving…' : 'Save this search'}
          </Button>
          {phase === 'error' && (
            <span className="kf-savebar__hint kf-savebar__hint--err" role="alert">
              {message}
            </span>
          )}
        </>
      )}
    </section>
  );
}
