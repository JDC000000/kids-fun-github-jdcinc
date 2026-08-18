// app/search/_lib/day-remainder-notice.ts — "today's activities have finished" vs "nothing is on".
//
// THE DEFECT THIS CLOSES. The read model prunes ended occurrences against `now()`
// (lib/search/postgres-repository.ts), so a `when=today` list is what is LEFT of today, never
// what was ON today. At half past ten at night that collapses to open-hours attractions and
// still-running multi-day programmes — and the page said nothing at all, rendering eight "any
// day" items exactly as it would render a genuinely empty city. Three testers read that as a
// broken product, which was the reasonable reading of what they were shown.
//
// "Today has finished" and "there is nothing on today" are completely different facts and this
// derivation's whole job is to stop them rendering identically.
//
// WHAT MAY AND MAY NOT BE SAID. The engine cannot count the activities that ran earlier: they
// left the catalogue before any filter ran. So every sentence below is a statement about the
// LOCAL CLOCK (which the engine knows exactly) or about what the LIST CONTAINS BY CONSTRUCTION
// (which is a property of the query, not a measurement) — never about how busy the day was.
// When the clock cannot separate the two cases, this says so instead of picking one.

import type { RequestedDayWindow } from '@/lib/search/day-window';

export interface DayRemainderNotice {
  /** Short bold opener — the fact, stated first. */
  lede: string;
  /** The honest explanation, and the limit of what is actually known. */
  body: string;
  /**
   * Whether to offer tomorrow as an explicit next step. Only ever true when the requested day IS
   * today, so "tomorrow" is unambiguous — and it is an OFFER, deliberately not the silent
   * broadening the ladder would otherwise perform on the parent's behalf.
   */
  offerTomorrow: boolean;
}

/**
 * Describe a thin or late "Today", or null when there is nothing worth saying.
 *
 * Null is the common case and means render nothing: a well-filled morning search is exactly what
 * a parent expects, and a note on it would be noise.
 */
export function describeDayRemainder(
  window: RequestedDayWindow | null | undefined,
  opts: { resultCount: number },
): DayRemainderNotice | null {
  if (!window) return null;

  if (!window.isToday) {
    // A past date, reachable through a custom range. The list is empty for a structural reason
    // that has nothing to do with how much was on, and saying so is cheap.
    if (window.state === 'day_over') {
      return {
        lede: 'That date has already passed.',
        body: 'We only list activities that have not ended yet, so a date in the past always comes back empty. It is not a sign that nothing was on.',
        offerTomorrow: false,
      };
    }
    // A future day is entirely ahead — an ordinary search with nothing to disclose.
    return null;
  }

  switch (window.state) {
    // Past the last day-part window (22:00). Nothing listed can still be ahead, so a near-empty
    // Today at this hour carries no information about the day itself.
    case 'day_over':
      return {
        lede: 'Today is over.',
        body: 'It is past 10pm in Vancouver, and this list only ever shows activities that have not ended yet. A quiet Today at this hour means the day has run out — not that there was nothing on.',
        offerTomorrow: true,
      };

    // The evening day-part has opened (17:00–22:00). Some of today is genuinely still ahead, so
    // we must NOT claim the day is over — but everything earlier has certainly left the list.
    case 'day_closing':
      return {
        lede: 'This is what is left of today.',
        body: 'It is evening in Vancouver, and this list only shows activities that have not ended yet — anything earlier today is no longer here. We cannot tell you from this page how busy the day was.',
        offerTomorrow: true,
      };

    // Still early enough that "it has all finished" is not available as an explanation. An empty
    // list here is the OTHER fact, and it deserves to be named as such rather than blurred.
    case 'day_ahead':
      if (opts.resultCount > 0) return null;
      return {
        lede: 'Nothing is on today.',
        body: 'Most of today is still ahead, so this is not a case of activities having already finished — we simply have nothing listed for today.',
        offerTomorrow: true,
      };
  }
}
