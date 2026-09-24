// lib/sms/throttle.ts — the race-safe counter behind every `sms_signup_throttle` limit.
//
// ═══ WHY THIS FILE EXISTS ═══
// It does not introduce anything. `countAttempt` and `explainRefusal` were written for the signup
// route and lived privately in lib/sms/signup-store.ts; Instant Picks became the second caller, and
// migration 0045's own header had already predicted that and said what to do about it — "the row
// shape and the whole decision statement are identical, and only the limits differ, which is a
// property of the CALLER, not of the storage."
//
// So the statement moved here rather than being copied. That matters more than ordinary DRY: the
// `INSERT ... ON CONFLICT ... WHERE` below is the ONLY thing making this throttle correct under
// concurrency, and its correctness is invisible in a single-threaded test. A second copy would be
// a second thing to get subtly wrong, and nothing would fail until somebody fired fifty requests
// at once in production.
//
// What did NOT move: the limits, the subject hashing, the ordering between subjects, and the
// fail-open decision. Those are per-caller policy and belong beside the caller that sets them —
// see `SIGNUP_THROTTLE_LIMITS` in signup-store.ts and `INSTANT_PICKS_THROTTLE_LIMITS` in
// instant-picks-throttle.ts.

import { query } from '@/lib/db/client';

/**
 * The `sms_signup_throttle.scope` values.
 *
 * ⚠ MIRRORS A DATABASE CHECK CONSTRAINT. Adding a member here is not enough — the column's
 * `CHECK (scope IN (...))` has to admit it too, or every write under the new scope fails.
 * `'instant_picks'` is added by migration 0046; the two send-path scopes by migration 0048.
 *
 * ⚠ AND THE CONSEQUENCE OF GETTING THAT WRONG NOW DIFFERS BY SCOPE, WHICH IS WORTH KNOWING BEFORE
 * YOU ADD THE NEXT ONE. A missing constraint value raises `23514 check_violation`, and what
 * happens next is the CALLER's fail direction, not this file's: the signup and page-render
 * throttles catch it and fail OPEN (an unlimited action plus a Sentry event), while the Instant
 * Picks SEND throttle catches it and fails CLOSED (no text is ever dispatched, silently, until the
 * migration runs). Neither is a crash, so neither shows up as an error — which is exactly why the
 * migration goes first.
 */
export type ThrottleScope =
  | 'phone'
  | 'ip'
  | 'instant_picks'
  /** Per subscriber, for the SMS an Instant Picks press dispatches. Migration 0048. */
  | 'instant_picks_sms'
  /** Per source IP, same send path. Migration 0048. */
  | 'instant_picks_sms_ip'
  /** Per SENDER, the inbound webhook's unknown-keyword auto-reply. Migration 0054. */
  | 'unknown_reply';

/**
 * Count one attempt against one subject, and say whether it is allowed — ATOMICALLY.
 *
 * ═══ THE DECISION AND THE WRITE ARE ONE STATEMENT, AND THAT IS THE WHOLE POINT ═══
 * The readable implementation is `SELECT count(...)` then `INSERT`, and it does not work: two
 * concurrent requests both take their snapshot before either writes, both see the same count, and
 * both are allowed. Serverless is precisely where fifty simultaneous requests are one line of
 * shell, so a check-then-write throttle throttles only polite callers. Putting the INSERT in a
 * CTE of the SELECT does not help either — same snapshot, same race.
 *
 * `ON CONFLICT ... DO UPDATE` takes a ROW LOCK on the conflicting row, so the second request
 * blocks until the first commits and then re-evaluates its `WHERE` against the row the first one
 * just wrote. One round trip, no window.
 *
 * ZERO ROWS RETURNED ⟺ REFUSED. When the `WHERE` is false the conflict action is skipped
 * entirely: nothing is updated and nothing is returned. That also means A REFUSED ATTEMPT DOES
 * NOT MOVE `last_attempt_at`, so hammering cannot extend a caller's own lockout — which matters
 * because the caller retrying three times in a minute is usually a parent who did not get what
 * they asked for, not an attacker.
 */
export async function countAttempt(
  run: typeof query,
  scope: ThrottleScope,
  subjectHash: string,
  perDay: number,
  minIntervalSeconds: number
): Promise<{ allowed: boolean; attempts: number }> {
  const rows = await run<{ attempts: number }>(
    `INSERT INTO sms_signup_throttle (scope, subject_hash)
          VALUES ($1, $2)
     ON CONFLICT (scope, subject_hash, window_date) DO UPDATE
            SET attempts        = sms_signup_throttle.attempts + 1,
                last_attempt_at = now()
          WHERE sms_signup_throttle.attempts < $3
            AND sms_signup_throttle.last_attempt_at <= now() - make_interval(secs => $4::int)
      RETURNING attempts`,
    [scope, subjectHash, perDay, minIntervalSeconds]
  );
  const row = rows[0];
  return { allowed: Boolean(row), attempts: row?.attempts ?? 0 };
}

/**
 * WHY the refused subject was refused, and for how long. Read-only, and only on the refused path.
 *
 * A second query rather than more RETURNING, because there is nothing to return: the whole point
 * of the statement above is that it touches no row when it refuses. This one runs at most once
 * per rejected request, which is the request we are least worried about the cost of.
 *
 * Falls back to the minimum interval if the row has vanished between the two statements (a
 * retention sweep at midnight, essentially), rather than reporting a confident zero.
 */
export async function explainRefusal(
  run: typeof query,
  scope: ThrottleScope,
  subjectHash: string,
  perDay: number,
  minIntervalSeconds: number
): Promise<{ daily: boolean; retryAfterSeconds: number }> {
  const rows = await run<{ attempts: number; since_last: number }>(
    `SELECT attempts, extract(epoch FROM now() - last_attempt_at)::int AS since_last
       FROM sms_signup_throttle
      WHERE scope = $1 AND subject_hash = $2
        AND window_date = (now() AT TIME ZONE 'UTC')::date`,
    [scope, subjectHash]
  );
  const row = rows[0];
  if (!row) return { daily: false, retryAfterSeconds: minIntervalSeconds };
  if (row.attempts >= perDay) {
    // Until the UTC day rolls over, which is when the counter's bucket changes.
    const now = new Date();
    const midnightUtc = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + 1,
      0, 0, 0, 0
    );
    return { daily: true, retryAfterSeconds: Math.max(1, Math.ceil((midnightUtc - now.getTime()) / 1000)) };
  }
  return {
    daily: false,
    retryAfterSeconds: Math.max(1, minIntervalSeconds - Math.max(0, row.since_last)),
  };
}
