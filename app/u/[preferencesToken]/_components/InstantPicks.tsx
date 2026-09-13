'use client';

// InstantPicks — the "show me more" control inside the preferences page's "Last Friday" section
// (Instant Picks plan v1.0).
//
// ── WHY A CLIENT COMPONENT WHEN ThreeThings IS A SERVER ONE ─────────────────────────────
// ThreeThings answers a question the visitor did not ask, so it must already be there when the
// page paints. This answers one they pressed a button for, so it MUST NOT run on page load: a
// search on every render would spend a rate-limit budget belonging to someone who only came here
// to unsubscribe, and would make the CASL control wait on a catalogue scan. The press is the whole
// point of the interaction, so the fetch belongs on the press.
//
// ── FOUR STATES, ALL SPOKEN ALOUD ───────────────────────────────────────────────────────
// results · nothing-right-now · can't-check · slow-down. `unavailable` is deliberately NOT
// rendered as "nothing found": the two sentences make different claims about the catalogue and
// only one of them would be true. The route keeps them apart for exactly this reason.
//
// ── NOTHING HERE SENDS ANYTHING ─────────────────────────────────────────────────────────
// There is no "text me this" control and there must not be one: the legal block further down this
// same page states "1 message per week, plus a one-time confirmation message", which is a carrier
// disclosure a send button would contradict from a few centimetres away. See the copy block in
// lib/sms/consent-copy.ts.

import { useState } from 'react';
import { Button } from '@/components/ui';
import {
  PREFS_INSTANT_BODY,
  PREFS_INSTANT_BUTTON,
  PREFS_INSTANT_EMPTY,
  PREFS_INSTANT_HEADING,
  PREFS_INSTANT_INTERESTS_DROPPED,
  PREFS_INSTANT_LOADING,
  PREFS_INSTANT_THROTTLED,
  PREFS_INSTANT_UNAVAILABLE,
  PREFS_INSTANT_WIDENED,
  instantPicksResultLine,
} from '@/lib/sms/consent-copy';

interface InstantPick {
  occurrenceId: string;
  rank: number;
  activityName: string;
  venueName: string;
  href: string;
}

interface InstantPicksBody {
  ok?: boolean;
  outcome?: 'picks' | 'empty' | 'unavailable' | 'throttled' | 'not_found';
  picks?: InstantPick[];
  areaLabel?: string | null;
  widened?: boolean;
  interestsDropped?: boolean;
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'picks'; picks: InstantPick[]; areaLabel: string | null; widened: boolean; interestsDropped: boolean }
  | { kind: 'empty' }
  | { kind: 'unavailable' }
  | { kind: 'throttled' };

export function InstantPicks({ token }: { token: string }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });

  async function press() {
    if (phase.kind === 'loading') return;
    setPhase({ kind: 'loading' });
    try {
      const res = await fetch('/api/sms/instant-picks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // The token travels in the BODY, not the URL — a POST path lands in access and proxy logs
        // exactly like a GET path does, and this is one more request that need not put it there.
        body: JSON.stringify({ token }),
      });
      const data = (await res.json().catch(() => null)) as InstantPicksBody | null;

      if (res.status === 429) return setPhase({ kind: 'throttled' });
      // ANY unhandled failure — 404, 503, a body that would not parse — lands on "we can't check",
      // never on "there is nothing". A dead token is vanishingly unlikely here (the page it is
      // rendered on resolved the same token a moment ago), and if it somehow happens, telling a
      // parent their weekend is empty would be a false statement about the catalogue. The one
      // sentence that is true of every one of these cases is that we could not check.
      if (!res.ok || !data?.ok) return setPhase({ kind: 'unavailable' });
      if (data.outcome === 'empty') return setPhase({ kind: 'empty' });
      if (data.outcome !== 'picks' || !data.picks?.length) return setPhase({ kind: 'unavailable' });

      setPhase({
        kind: 'picks',
        picks: data.picks,
        areaLabel: data.areaLabel ?? null,
        widened: Boolean(data.widened),
        interestsDropped: Boolean(data.interestsDropped),
      });
    } catch {
      setPhase({ kind: 'unavailable' });
    }
  }

  return (
    <div className="kf-prefs__instant">
      <h3 className="kf-prefs__instant-heading">{PREFS_INSTANT_HEADING}</h3>
      <p className="kf-prefs__help">{PREFS_INSTANT_BODY}</p>

      {/* PRIMARY, NOT SECONDARY (Jon, 2026-09-13, from a phone screenshot). `secondary` is a
          --kf-surface fill, which in dark mode is #183b24 against a #102316 canvas — a 1.3:1
          step. The one control this whole section exists for rendered as a hairline outline
          rather than a thing to press. `primary` is --kf-leaf on --kf-forest-ink (7.61:1,
          measured), and this IS the primary action of its section: the page's other primary,
          "Save changes", is in a different section and a different job. No new CSS — the
          variant already exists and is already contrast-checked. */}
      <Button
        type="button"
        variant="primary"
        size="sm"
        onClick={press}
        disabled={phase.kind === 'loading'}
        // Names the region the results land in, so a screen reader user who presses this is told
        // where the answer appeared rather than left to hunt for it.
        aria-controls="kf-prefs-instant-result"
      >
        {phase.kind === 'loading' ? PREFS_INSTANT_LOADING : PREFS_INSTANT_BUTTON}
      </Button>

      {/* ONE LIVE REGION FOR EVERY OUTCOME, PRESENT FROM FIRST RENDER. A region that is inserted
          at the same moment it gains content is announced unreliably (the assistive tree has
          nothing to diff against), which would make three of the four states silent for exactly
          the users who most need them read out. `polite` rather than `assertive`: this is an
          answer that was asked for, not an interruption. */}
      <div
        id="kf-prefs-instant-result"
        className="kf-prefs__instant-result"
        role="status"
        aria-live="polite"
      >
        {phase.kind === 'throttled' && <p className="kf-prefs__help">{PREFS_INSTANT_THROTTLED}</p>}
        {phase.kind === 'unavailable' && <p className="kf-prefs__help">{PREFS_INSTANT_UNAVAILABLE}</p>}
        {phase.kind === 'empty' && <p className="kf-prefs__help">{PREFS_INSTANT_EMPTY}</p>}
        {phase.kind === 'picks' && (
          <>
            <p className="kf-prefs__intro">
              {instantPicksResultLine(phase.picks.length, phase.areaLabel)}
            </p>
            {/* The caveat the SELECTOR reported, not one inferred from the result's shape — it
                reports its own degradation precisely so the copy cannot reach a different
                conclusion than the selection did. */}
            {phase.interestsDropped ? (
              <p className="kf-prefs__help">{PREFS_INSTANT_INTERESTS_DROPPED}</p>
            ) : phase.widened ? (
              <p className="kf-prefs__help">{PREFS_INSTANT_WIDENED}</p>
            ) : null}
            {/* THE SAME LIST CLASS THE "LAST FRIDAY" PICKS USE, one section up. These are the same
                kind of thing presented the same way; a second list style would imply a second kind
                of answer. The links are plain /activity/ hrefs rather than short links — see
                `InstantPick.href` in lib/sms/instant-picks.ts for why nothing here is attributed. */}
            <ol className="kf-prefs__picks">
              {phase.picks.map((pick) => (
                <li key={pick.occurrenceId}>
                  <a href={pick.href}>{pick.activityName}</a>
                  {pick.venueName ? <span className="kf-prefs__instant-venue"> · {pick.venueName}</span> : null}
                </li>
              ))}
            </ol>
          </>
        )}
      </div>
    </div>
  );
}
