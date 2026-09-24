// lib/sms/instant-picks-store.ts — the ONE read behind an Instant Picks press.
//
// Separate from lib/sms/instant-picks.ts on purpose: that module is pure and imports no database
// seam, which is what lets its "writes nothing, and in particular not sms_send_log" guarantee be
// checked statically rather than trusted. The database touch lives here.
//
// Separate from lib/sms/preferences.ts's `resolvePreferences` too, and that is not duplication:
// that function additionally loads LAST WEEK's send log to build the panel above the button, which
// a press has no use for — reusing it would mean a second, larger read on every press to throw
// most of it away. It also hands back `childAges` (recomputed for display) where the selector needs
// `birthYears`. Different question, different read.

import { query } from '@/lib/db/client';
import type { ConsentStatus } from './consent-transitions';
import type { InstantPicksSubscriber } from './instant-picks';

export type InstantPicksSubscriberResolution =
  | { outcome: 'found'; subscriberId: string; subscriber: InstantPicksSubscriber }
  /**
   * Never existed, malformed, unsubscribed, purged, or the read failed.
   *
   * ONE OUTCOME, exactly like `resolvePreferences`. Distinguishing them would tell a prober which
   * guess was close, and would tell anyone holding an old link whether that person is still a
   * subscriber — which is a fact about somebody else.
   */
  | { outcome: 'not_found' };

export interface InstantPicksLookupOptions {
  /**
   * Injected for tests; defaults to the shared pool in lib/db/client.ts — the same seam
   * `SignupWriteOptions` and `PreferencesDeps` offer, for the same reason. Injecting the query
   * rather than module-mocking the pool is what keeps this module's suite in the parallel `unit`
   * lane (vitest.workspace.ts) instead of the serial DB one.
   */
  query?: typeof query;
}

export type InstantPicksLookup = (
  token: string,
  options?: InstantPicksLookupOptions
) => Promise<InstantPicksSubscriberResolution>;

/**
 * Resolve a preferences token to the fields a press needs. NEVER THROWS.
 *
 * ═══ `consecutive_empty_weeks` IS NOT IN THIS SELECT, AND THAT IS LOAD-BEARING ═══
 * It is the counter `selectWeeklyPicks` turns into `shouldPause`, and the whole failure mode this
 * feature had to avoid is a button press pausing a real subscriber (see INSTANT_PICKS_EMPTY_WEEKS
 * in lib/sms/instant-picks.ts). The wrapper passes a hard zero — but the strongest version of that
 * guard is that THE REAL VALUE IS NEVER IN SCOPE ON THIS PATH AT ALL, so there is nothing for a
 * future edit to "helpfully" wire through. Do not add the column here.
 *
 * ═══ WHO IS REFUSED ═══
 * The same rule the page uses to decide whether to render its edit form — not a second, slightly
 * different one, because a rule enforced in the UI and not on the server is not a rule:
 *   • `status = 'stopped'` — they asked us to stop. Building them a personalised list out of the
 *     data they asked us to stop using is the wrong answer even though nothing is sent.
 *   • PURGED (postal code and birth years both NULL after the 30-day sweep) — there is nothing
 *     left to search with, and the honest answer is that this link has nothing behind it.
 * `pending` and `paused` rows ARE served: they are real rows with real stored preferences, the
 * subscriber asked for this themselves on their own page, and nothing leaves the page.
 *
 * ⛔ THIS IS THE LIST RULE, NOT THE SEND RULE. A `found` here says nothing about whether the press
 * may also TEXT them — `sendInstantPicksText` re-reads `status` and `confirmed_timestamp` itself
 * and texts only confirmed, active subscribers (the 2026-09-24 CASL fix; see that file's header).
 * Do not "simplify" either side by making one reuse the other.
 */
export const findInstantPicksSubscriber: InstantPicksLookup = async (token, options = {}) => {
  const run = options.query ?? query;
  let rows: Array<{
    id: string;
    status: ConsentStatus;
    postal_code: string | null;
    birth_years: number[] | null;
    category_interests: string[] | null;
  }>;
  try {
    rows = await run(
      `SELECT id, status, postal_code, birth_years, category_interests
         FROM sms_consent
        WHERE preferences_token = $1`,
      [token]
    );
  } catch {
    // A read failure is reported as `not_found` rather than surfacing, for the reason
    // `resolvePreferences` gives: this is a public endpoint and "no such token" versus "the
    // database is down" is information a prober would like and a parent cannot use.
    return { outcome: 'not_found' };
  }

  const row = rows[0];
  if (!row) return { outcome: 'not_found' };
  if (row.status === 'stopped') return { outcome: 'not_found' };
  if (row.postal_code == null && row.birth_years == null) return { outcome: 'not_found' };

  return {
    outcome: 'found',
    subscriberId: row.id,
    subscriber: {
      postalCode: row.postal_code,
      // COERCED, NOT DROPPED, the same way loadActiveSubscribers does it: no birth years is a
      // legitimate state and means "search with no age filter", honestly, rather than an error.
      birthYears: row.birth_years ?? [],
      categoryInterests: row.category_interests ?? undefined,
    },
  };
};
