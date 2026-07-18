'use client';

// ResumeSearch — the anon-memory UI (T26 / G-T26-3). Two jobs, one small client island:
//
//   1. WHEN THE PARENT IS SEARCHING (a real query or any active filter/near-me): quietly keep
//      the on-device "last search" up to date, so it can be offered next time. Renders nothing.
//   2. ON A BARE /search LANDING (nothing typed, no filters): if a last search was remembered,
//      offer an EXPLICIT, DISMISSIBLE "pick up where you left off" suggestion.
//
// Deliberately NOT a silent auto-apply: a shared device must never surprise the next person with
// someone else's search. The parent chooses — Resume (re-run it), Not now (hide for this visit,
// keep the memory), or Forget this (erase the memory). All storage is on-device (localStorage);
// no server round-trip, no account, and raw near-me coordinates are never persisted (see
// app/search/_lib/anon-memory.ts). The whole thing degrades to nothing if storage is unavailable.

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui';
import { hrefForParams } from '../_lib/params';
import { type AnonSearchMemory, clearMemory, readMemory, writeMemory } from '../_lib/anon-memory';

interface ResumeSearchProps {
  /** Current search serialized to its privacy-safe param map (serializeStateToParams). */
  currentParams: Record<string, string>;
  /** Short human label for the current search (query text or a filter summary). */
  currentLabel: string;
  /** Whether this page is an active search (a query, or any active filter/near-me origin). */
  hasActiveState: boolean;
}

export function ResumeSearch({ currentParams, currentLabel, hasActiveState }: ResumeSearchProps) {
  const router = useRouter();
  const [memory, setMemory] = useState<AnonSearchMemory | null>(null);
  const [dismissed, setDismissed] = useState(false);

  // Re-run on every navigation (the props change with the URL). `paramsKey` gives a stable
  // primitive dependency so the effect fires when the actual params change, not on identity.
  const paramsKey = JSON.stringify(currentParams);

  useEffect(() => {
    if (hasActiveState) {
      // Actively searching → refresh the remembered search and show no suggestion. writeMemory
      // is a no-op for empty/near-me-only params, so it never clobbers a prior good memory.
      writeMemory(currentParams, currentLabel, Date.now());
      setMemory(null);
      setDismissed(false);
      return;
    }
    // Bare landing → offer to resume the last remembered search, if any.
    setMemory(readMemory());
    setDismissed(false);
    // currentParams is captured via paramsKey; currentLabel/hasActiveState are primitive deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasActiveState, currentLabel, paramsKey]);

  if (hasActiveState || dismissed || !memory) return null;

  const resumeHref = hrefForParams(memory.params);
  const label = memory.label.trim() || 'your last search';

  return (
    <section className="kf-resume" role="region" aria-label="Pick up where you left off">
      <div className="kf-resume__body">
        <p className="kf-resume__eyebrow">Welcome back</p>
        <p className="kf-resume__text">
          Pick up where you left off — <b className="kf-resume__label">{label}</b>?
        </p>
      </div>
      <div className="kf-resume__actions">
        <Button variant="primary" onClick={() => router.push(resumeHref)}>
          <span className="kf-resume__glyph" aria-hidden="true">
            ↩
          </span>
          Resume search
        </Button>
        <button type="button" className="kf-resume__btn" onClick={() => setDismissed(true)}>
          Not now
        </button>
        <button
          type="button"
          className="kf-resume__btn kf-resume__btn--muted"
          onClick={() => {
            clearMemory();
            setMemory(null);
          }}
        >
          Forget this
        </button>
      </div>
    </section>
  );
}
