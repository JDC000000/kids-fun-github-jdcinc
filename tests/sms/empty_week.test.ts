// tests/sms/empty_week.test.ts — the empty-week counter and the pause rule (PRD §2.2 step 6).
//
// Pure, so the whole transition table is exercised at every counter value without an engine, a
// catalogue or a database. This function decides whether a subscriber stops receiving the
// product, which is why it gets its own file and its own suite.
import { describe, expect, it } from 'vitest';
import { EMPTY_WEEKS_BEFORE_PAUSE, nextEmptyWeekState } from '@/lib/sms/empty-week';

describe('a real send resets the counter', () => {
  it('sets it to 0 from any starting value, and keeps the subscriber active', () => {
    for (const start of [0, 1, 2, 3, 7]) {
      expect(nextEmptyWeekState(start, 'picks')).toEqual({
        consecutiveEmptyWeeks: 0,
        status: 'active',
        pausedNow: false,
        message: 'weekly',
      });
    }
  });
});

describe('the pause rule — 3 CONSECUTIVE, not 3 lifetime', () => {
  it('walks 0 → 1 → 2 without pausing, then pauses on the third', () => {
    const first = nextEmptyWeekState(0, 'empty');
    expect(first).toEqual({
      consecutiveEmptyWeeks: 1,
      status: 'active',
      pausedNow: false,
      message: 'empty_week',
    });

    const second = nextEmptyWeekState(first.consecutiveEmptyWeeks, 'empty');
    expect(second).toEqual({
      consecutiveEmptyWeeks: 2,
      status: 'active',
      pausedNow: false,
      message: 'empty_week',
    });

    const third = nextEmptyWeekState(second.consecutiveEmptyWeeks, 'empty');
    expect(third).toEqual({
      consecutiveEmptyWeeks: EMPTY_WEEKS_BEFORE_PAUSE,
      status: 'paused',
      pausedNow: true,
      // The pause notice REPLACES a third "nothing this week" text. Three of those in a row is
      // the product failing and then continuing to text about it.
      message: 'pause_notice',
    });
  });

  it('does NOT pause on two empties that are not consecutive', () => {
    // empty → good week → empty. The reset in the middle is what makes the count consecutive,
    // so the second empty lands back at 1, not at 2.
    const a = nextEmptyWeekState(0, 'empty');
    expect(a.consecutiveEmptyWeeks).toBe(1);

    const b = nextEmptyWeekState(a.consecutiveEmptyWeeks, 'picks');
    expect(b.consecutiveEmptyWeeks).toBe(0);

    const c = nextEmptyWeekState(b.consecutiveEmptyWeeks, 'empty');
    expect(c.consecutiveEmptyWeeks).toBe(1);
    expect(c.status).toBe('active');
    expect(c.pausedNow).toBe(false);
  });

  it('is idempotent once paused — a re-run does not send a second pause notice', () => {
    // A job that runs twice, or a manual single-subscriber trigger after the bulk run, must not
    // text an already-paused subscriber again or inflate their counter.
    const again = nextEmptyWeekState(EMPTY_WEEKS_BEFORE_PAUSE, 'empty');
    expect(again).toEqual({
      consecutiveEmptyWeeks: EMPTY_WEEKS_BEFORE_PAUSE,
      status: 'paused',
      pausedNow: false,
      message: 'none',
    });
    expect(nextEmptyWeekState(9, 'empty').consecutiveEmptyWeeks).toBe(EMPTY_WEEKS_BEFORE_PAUSE);
  });
});

describe('a week we never actually searched', () => {
  it('changes NOTHING and sends NOTHING', () => {
    // THE BRANCH THAT IS EASY TO GET WRONG BY FOLDING IT INTO 'empty'. A postal code that does
    // not geocode is our data problem, not a quiet weekend: counting it as an empty week would
    // pause a subscriber for our defect, and texting "nothing matches your area" would be a
    // claim about a search that never ran.
    for (const start of [0, 1, 2]) {
      expect(nextEmptyWeekState(start, 'not_attempted')).toEqual({
        consecutiveEmptyWeeks: start,
        status: 'active',
        pausedNow: false,
        message: 'none',
      });
    }
  });

  it('cannot push a subscriber over the pause threshold', () => {
    // Two real empties plus a run we never attempted is still two, so nobody is paused by a
    // geocoding failure — which would be the worst possible reason to stop texting someone.
    const state = nextEmptyWeekState(2, 'not_attempted');
    expect(state.status).toBe('active');
    expect(state.consecutiveEmptyWeeks).toBe(2);
  });
});

describe('defensive input handling', () => {
  it('treats a missing or nonsense counter as 0 rather than propagating it', () => {
    // The counter comes from a database column. NaN or a negative would otherwise turn into a
    // NaN status write or a counter that can never reach the threshold.
    expect(nextEmptyWeekState(Number.NaN, 'empty').consecutiveEmptyWeeks).toBe(1);
    expect(nextEmptyWeekState(-5, 'empty').consecutiveEmptyWeeks).toBe(1);
    expect(nextEmptyWeekState(1.7, 'empty').consecutiveEmptyWeeks).toBe(2);
  });
});
