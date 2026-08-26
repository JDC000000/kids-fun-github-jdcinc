// lib/sms/empty-week.ts — the empty-week counter and the pause rule (PRD §2.2 step 6).
//
// DRAFT (SMS pivot). One pure function, in its own file so it is greppable and so the rule can
// be read without reading the orchestration around it. No DB: it takes the counter as it stands
// and returns what the counter and status SHOULD be. The caller applies that through a stub, the
// same posture as lib/sms/consent-transitions.ts.
//
// ── WHY THIS IS NOT A FEW LINES INSIDE THE SEND JOB ──────────────────────────────────────
// It decides whether a subscriber stops receiving the product. That is worth being able to test
// on its own, at every counter value, without standing up an engine and a catalogue — and worth
// being somewhere a reader can find by searching for "pause" rather than by reading a send loop.
//
// ── "3 CONSECUTIVE", AND WHAT THE STORED COUNTER CAN AND CANNOT PROVE ────────────────────
// The PRD says three CONSECUTIVE empty weeks, not three lifetime. `sms_consent
// .consecutive_empty_weeks` is a running counter that is RESET TO 0 by any real send, so
// consecutiveness is enforced by the reset, not by inspecting history — a subscriber who has an
// empty week, then a good week, then two more empty weeks sits at 2 and is not paused.
//
// WHAT THAT SHAPE CANNOT ANSWER, stated plainly because a reader will eventually ask: the column
// holds a COUNT, not a sequence, so nothing in the schema can distinguish "two empties in a row"
// from "two empties three months apart with resets in between" AFTER the fact — the reset
// destroys that history as it goes. That is fine for the rule as specified (the reset IS the
// consecutiveness test, and it is applied at the only moment the information exists) and it is
// worth knowing before someone tries to write a "how often does this subscriber get an empty
// week?" report off this column. That question needs `sms_send_log`, which is append-only and
// does keep the sequence — every attempt writes a row with its outcome (migration 0035).

/** What actually happened for this subscriber this week, as far as the counter is concerned. */
export type WeekOutcome =
  /** Picks were selected and a real weekly message is going out. */
  | 'picks'
  /** Below the floor after both degradation retries. A genuine, searched-for nothing. */
  | 'empty'
  /**
   * We could not run the search at all — today, a postal code that resolves to no covered
   * municipality. NOT the same as `empty`, and the difference is the whole reason this member
   * exists: see `nextEmptyWeekState`.
   */
  | 'not_attempted';

/** Which message, if any, this week produces. */
export type WeekMessageKind = 'weekly' | 'empty_week' | 'pause_notice' | 'none';

export interface EmptyWeekState {
  /** The value to write back to `sms_consent.consecutive_empty_weeks`. */
  consecutiveEmptyWeeks: number;
  /** The value to write back to `sms_consent.status`. Only ever 'active' or 'paused' here. */
  status: 'active' | 'paused';
  /** True when this call is the transition INTO paused — i.e. the notice goes out now. */
  pausedNow: boolean;
  /** Which of the §2.6 message shapes to render. */
  message: WeekMessageKind;
}

/** Consecutive empty weeks that trigger the pause (PRD §2.2 step 6). */
export const EMPTY_WEEKS_BEFORE_PAUSE = 3;

/**
 * The counter and status after this week.
 *
 * PURE, and it decides nothing about delivery — a caller that never sends the message must not
 * apply the state either, or a subscriber would be paused for a week they were never texted
 * about. The orchestrator applies both together or neither.
 *
 * THE THREE BRANCHES:
 *
 *   'picks'         → counter to 0, stay active. A real send is the only thing that resets it,
 *                     which is what makes the count consecutive rather than lifetime.
 *
 *   'empty'         → counter + 1. On reaching EMPTY_WEEKS_BEFORE_PAUSE, status becomes 'paused'
 *                     and the message becomes the pause notice INSTEAD of a third empty-week
 *                     text — three "nothing this week" messages in a row is the product failing
 *                     and then continuing to text about it.
 *
 *   'not_attempted' → NOTHING CHANGES, and no message is sent. This is the branch that is easy
 *                     to get wrong by folding it into 'empty', so: a postal code that does not
 *                     geocode is OUR data problem, not a quiet weekend. Counting it as an empty
 *                     week would pause a subscriber for our defect, and texting them "nothing
 *                     matches your area" would be a claim we never checked. The honest outcome is
 *                     to send nothing, change nothing, and log a failure somebody can act on.
 *
 * A counter that is already at or past the threshold cannot climb further: once paused, the
 * subscriber is not being sent to, so there is no further empty week to count. Guarding it keeps
 * a re-run of the job idempotent instead of inflating the number.
 */
export function nextEmptyWeekState(
  consecutiveEmptyWeeks: number,
  outcome: WeekOutcome
): EmptyWeekState {
  const current = Number.isFinite(consecutiveEmptyWeeks)
    ? Math.max(0, Math.trunc(consecutiveEmptyWeeks))
    : 0;

  if (outcome === 'not_attempted') {
    return {
      consecutiveEmptyWeeks: current,
      status: 'active',
      pausedNow: false,
      message: 'none',
    };
  }

  if (outcome === 'picks') {
    return {
      consecutiveEmptyWeeks: 0,
      status: 'active',
      pausedNow: false,
      message: 'weekly',
    };
  }

  const next = Math.min(current + 1, EMPTY_WEEKS_BEFORE_PAUSE);
  if (next >= EMPTY_WEEKS_BEFORE_PAUSE) {
    return {
      consecutiveEmptyWeeks: next,
      status: 'paused',
      // Only the run that CROSSES the threshold sends the notice. A re-run against an
      // already-paused subscriber must not text them a second pause notice.
      pausedNow: current < EMPTY_WEEKS_BEFORE_PAUSE,
      message: current < EMPTY_WEEKS_BEFORE_PAUSE ? 'pause_notice' : 'none',
    };
  }

  return {
    consecutiveEmptyWeeks: next,
    status: 'active',
    pausedNow: false,
    message: 'empty_week',
  };
}
