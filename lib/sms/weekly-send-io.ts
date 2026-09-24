// lib/sms/weekly-send-io.ts — orchestrate the Friday send: single subscriber, then bulk.
//
// DRAFT (SMS pivot). The I/O boundary for the feature, mirroring lib/email/weekly.ts field for
// field: a pre-loaded read model (`WeeklySmsDeps` ↔ `WeeklyDeps`), one testable per-subscriber
// unit that NEVER throws (`sendWeeklySmsForSubscriber` ↔ `sendWeeklyDigestForUser`), and a bulk
// driver that simply loops it (`sendWeeklySmsBulk` ↔ `sendWeeklyDigestBulk`).
//
// SAFETY: sending is DRY-RUN unless SMS_SENDING_ENABLED === 'true'. `dryRun` defaults to
// `!smsSendingEnabled()`, so an accidental invocation in an unconfigured environment builds every
// message and dispatches none. Real sends are recorded; dry runs are not — a verification run
// must not move a subscriber's empty-week counter or write a CASL audit row for a message nobody
// received.
//
// ── EVERYTHING HERE IS REAL ─────────────────────────────────────────────────────────────
// The deps loading shape, the per-subscriber flow, the dry-run gate, the outcome mapping, the
// empty-week/pause transition wiring and the PII discipline all run today. So do the database
// seams — `loadActiveSubscribers`, `loadRecentlySent`, `applyEmptyWeekState` and
// `markStoppedViaCarrier` issue their queries against `sms_consent`, `sms_send_log` and
// `activity_occurrence` (migrations 0034/0035, applied by the Operator), and `dispatchSms`
// (lib/sms/twilio-client.ts) issues an actual Twilio Messages API call. Each stays an injectable seam so the orchestration
// is testable without a database; tests/sms/preferences_weekly-db.test.ts covers them for real.
//
// WHAT IS STILL OFF IS THE SENDING ITSELF: SMS_SENDING_ENABLED is deliberately unset, so
// `dispatchSms` returns a dry-run outcome and no row is written. Same posture as
// lib/sms/consent-transitions.ts and lib/sms/signup-store.ts.
//
// ── PII DISCIPLINE, WHICH IS NOT OPTIONAL ON THIS LANE ──────────────────────────────────
// No phone number and no rendered message body may appear in a thrown error, a log line, or a
// returned status object. The email job's run-route sanitises for the same reason
// (app/api/email/weekly/run/route.ts `sanitize`), but the stakes are higher here: the identifier
// IS the phone number, and this module is the one place that routinely holds a batch of them.
// `SubscriberSendResult` therefore carries an id, an outcome and counts — never a number, never a
// body. `redactPhone` exists for the one case where a number has to be mentioned at all.

import { getPool, query } from '@/lib/db/client';
import { SearchEngine } from '@/lib/search/engine';
import { InMemoryListingRepository } from '@/lib/search/repository';
import { loadPostgresListings } from '@/lib/search/postgres-repository';
import { getPostgresAliasResolver } from '@/lib/search/postgres-alias-resolver';
import { getPostgresRegionHierarchy } from '@/lib/search/postgres-region-hierarchy';
import { fsaGeocoder } from '@/lib/geo/postal-fsa';
import { isUuid } from '@/lib/corrections/types';
import { phoneHashSalt, preferencesSecret, smsSendingEnabled } from './config';
import { MissingPhoneHashSaltError } from './phone-hash';
import { MissingPreferencesSecretError } from './preferences-token';
import { nextEmptyWeekState, type EmptyWeekState } from './empty-week';
import {
  buildWeeklySms,
  pauseNoticeFor,
  picksSnapshot,
  weekOutcomeFor,
  type SmsSubscriber,
  type WeeklySmsPlan,
} from './weekly-send';
import { dispatchSms, type DispatchResult } from './twilio-client';
import { recordSmsSend, type SendLogType } from './send-log';
import type { ConsentStatus } from './consent-transitions';
// Re-exported: this module's own header documents the PII rule `redactPhone` serves, and callers
// have imported it from here since round 4. The rule itself now has one home in lib/sms/redact.ts.
import { redactPhone } from './redact';
export { redactPhone } from './redact';

// ── Re-exported so every existing importer of this module keeps working ─────────────────
// `recordSmsSend` moved to lib/sms/send-log.ts in round 16 — see that file's header for why.
//
// THE TWILIO SEAM IS DELIBERATELY *NOT* RE-EXPORTED (P6, 2026-09-24). This module used to
// re-export `dispatchSms` and `twilioClient` from lib/sms/twilio-client.ts, which let any file
// reach Twilio by importing from HERE — invisible to tests/sms/sms_send_paths_consent.test.ts,
// which classifies senders by who imports the seam. Nothing imported them from here, so they
// were removed, and that test now fails if any module re-exports the seam. Import it from
// lib/sms/twilio-client.ts directly, and get classified.
export {
  recordSmsSend,
  type SendLogOutcome,
  type SendLogType,
  type RecordSendInput,
} from './send-log';

// ── Deps: load the read model ONCE, reuse it for every subscriber ───────────────────────

export interface WeeklySmsDeps {
  engine: SearchEngine;
  /** `activity_occurrence.id` → `short_ref`, for minting per-item short links (migration 0037). */
  occurrenceShortRefs: Map<string, number>;
}

/**
 * Load the live search read model plus the occurrence short-ref map, once.
 *
 * Directly mirrors `loadWeeklyDeps` in lib/email/weekly.ts, including its second query: that one
 * loads `id, created_at` for the "new since last send" watermark, this one loads `id, short_ref`
 * for link minting. Same shape, same reason — a bulk run must not issue a lookup per pick per
 * subscriber.
 *
 * `fsaGeocoder` is wired as the geocoder for the same reason the email job wires it: FSA-level
 * origins need no paid geocoder and no signed-in caller.
 */
export async function loadWeeklySmsDeps(): Promise<WeeklySmsDeps> {
  const pool = getPool();
  const [listings, aliasResolver, regionHierarchy, shortRefRows] = await Promise.all([
    loadPostgresListings(pool),
    getPostgresAliasResolver(pool),
    getPostgresRegionHierarchy(pool),
    query<{ id: string; short_ref: string | number }>(
      `SELECT id, short_ref FROM activity_occurrence WHERE archived_at IS NULL`
    ),
  ]);

  const engine = new SearchEngine({
    repository: new InMemoryListingRepository(listings),
    aliasResolver,
    regionHierarchy,
    geocoder: fsaGeocoder,
    fixtureBacked: false,
  });

  // `short_ref` is a bigint; node-postgres hands bigints back as STRINGS to avoid silent
  // precision loss. Number() is exact well past any value this sequence will reach in practice
  // (2^53 vs the token's own 32-bit field), and `encodeShortLink` rejects anything over-range
  // rather than truncating it.
  const occurrenceShortRefs = new Map<string, number>();
  for (const row of shortRefRows) occurrenceShortRefs.set(row.id, Number(row.short_ref));

  return { engine, occurrenceShortRefs };
}

// ── The seams: everything that touches the database or Twilio ───────────────────────────

/**
 * One row from `sms_consent`, split into the part the PURE BUILDER may see and the part it may
 * not.
 *
 * THE PHONE NUMBER IS DELIBERATELY NOT ON `SmsSubscriber`. lib/sms/weekly-send.ts has no business
 * holding one — it geocodes, selects and renders, and none of that needs a number — so the type
 * system is what keeps it out rather than a convention someone has to remember. The number travels
 * beside the subscriber, is handed only to `dispatchSms`, and never reaches a result object, a log
 * line or an error string.
 */
export interface ActiveSubscriber {
  subscriber: SmsSubscriber;
  /** E.164. The ONLY field on this branch that is a phone number. See `redactPhone`. */
  phoneNumber: string;
}

/**
 * How recently a WEEKLY send withholds a subscriber from the next batch.
 *
 * FOUR DAYS, and both bounds matter. It must be long enough to absorb a signup that produced an
 * immediate first send earlier in the same week — a Thursday-evening JOIN is the case that
 * motivated this — and it must be comfortably SHORTER than the seven days between two Fridays,
 * or it would swallow the weekly cadence itself and mute the product. Four sits in the middle
 * with three days of headroom on the side that matters.
 *
 * Exported so the db-lane test can express "older than the window" as a relationship to this
 * number rather than as a second hardcoded 4 that stops matching the day anyone tunes it.
 */
export const RESEND_SUPPRESSION_WINDOW_DAYS = 4;

/**
 * Every `active` subscriber the Friday job should consider.
 *
 * THE QUERY:
 *   SELECT c.id, c.short_ref, c.phone_number, c.postal_code, c.birth_years, c.category_interests,
 *          c.consecutive_empty_weeks, c.preferences_token, c.consent_text_version
 *     FROM sms_consent c
 *    WHERE c.status = 'active'
 *      AND c.confirmed_timestamp IS NOT NULL -- no recorded JOIN, no content (P6, below)
 *      AND c.is_test = false
 *      AND c.phone_number IS NOT NULL    -- a purged row is not a subscriber (migration 0034)
 *      AND NOT EXISTS (                  -- ...and nobody gets texted twice in four days
 *            SELECT 1 FROM sms_send_log l
 *             WHERE l.subscriber_id = c.id
 *               AND l.send_type = 'weekly'
 *               AND l.created_at > now() - make_interval(days => $1::int))
 *    ORDER BY c.id
 *    [LIMIT $2]
 *
 * ═══ THE RECENCY CLAUSE (2026-09-04) ═══
 * Before this, the job texted every active subscriber on every run with no notion of when it had
 * last texted them — no watermark, no week key, nothing. Harmless while a weekly cron was the
 * only trigger; not harmless once a subscriber can ask for their first picks at JOIN, because a
 * Thursday-evening signup would be texted that night and again by the Friday batch fourteen
 * hours later, against a disclosure promising one message a week.
 *
 * IT SUPPRESSES BY WITHHOLDING THE ROW, WHICH IS THE WHOLE DESIGN. A subscriber filtered out here
 * never reaches the send loop, so nothing is dispatched, no `sms_send_log` row is written and
 * `consecutive_empty_weeks` is not touched. Skipping them INSIDE the loop instead would run them
 * through the empty-week path, which writes a row and increments that counter — and three
 * increments auto-pause a subscriber, so the "tidier" placement would march somebody toward a
 * pause for a week they were deliberately not texted about. Pinned by the first two assertions in
 * tests/sms/weekly_recency_suppression-db.test.ts.
 *
 * `send_type = 'weekly'` and not merely "any send": a welcome, a confirmation request or a pause
 * notice must not withhold somebody's picks. Uses `idx_sms_send_log_subscriber (subscriber_id,
 * created_at DESC)` from 0035 — the same index the novelty filter and the click-through recovery
 * already use, so this adds no index and no migration.
 *
 * ⚠ THIS MAKES THE FRIDAY JOB RE-RUNNABLE, which it was not before: a second run inside the
 * window now skips everyone the first run reached, instead of texting them again. That is a
 * behaviour change to an existing job and is intended — a partial-failure re-run was previously
 * unsafe — but it also means a deliberate immediate re-send is no longer possible without
 * shortening this window.
 *
 * ⚠ AND IT CHANGES `scripts/friday-preview-real-subscribers.ts`, which calls this function: run
 * within four days of a real send, the preview now legitimately shows nobody.
 *
 * THAT IS DELIBERATE — SETTLED BY THE OPERATOR, 2026-09-04, AND NOT AN OVERSIGHT TO BE TIDIED.
 * The question was raised explicitly and decided this way: the preview tool's whole purpose is
 * fidelity to what the real Friday job would actually do, and "this subscriber would honestly get
 * nothing right now" is itself correct and useful output — particularly when the thing you are
 * sanity-checking IS the suppression. A bypass would risk masking the exact behaviour someone
 * opened the tool to verify.
 *
 * AN OVERRIDE FLAG WAS CONSIDERED AND DECLINED. Not forgotten, not too hard: judged unnecessary,
 * and cheap to add later if it turns out to be annoying in practice. So if the preview showing
 * nobody has just surprised you, this is the answer, and adding a `--no-suppression` escape hatch
 * is a decision to REOPEN with the Operator rather than an obvious missing feature to supply.
 *
 * ═══ `confirmed_timestamp IS NOT NULL` (P6, 2026-09-24) ═══
 * `active` is not proof of a double opt-in on its own. A PENDING row that texts STOP becomes
 * `stopped` (decideStop accepts any non-stopped row), and a later START revives a stopped row to
 * `active` WITHOUT stamping `confirmed_timestamp` (decideStart: `confirm: false`, correctly — START
 * is not a JOIN). So "never confirmed, now active" is a reachable state, and before this clause the
 * Friday job would have texted it. Instant Picks already refuses it (`hasConfirmedActiveConsent`);
 * this makes the weekly SELECTION agree, so the admin preview and the Friday preview script — which
 * reuse this loader — show exactly who would really be texted. `sendWeeklySmsForSubscriber`
 * re-checks the same rule against its own read of the row; this clause is the first layer, not the
 * only one. Fixing the transition itself is a separate, proposed change (P6c).
 *
 * `phone_number IS NOT NULL` is the non-obvious clause. Migration 0034's 30-day post-stop purge
 * NULLs the personal columns in place rather than deleting the row, so a purged subscriber still
 * has an `sms_consent` row — and if their status were ever left at 'active' by a missed
 * transition, a naive `WHERE status = 'active'` would select someone with no number and no
 * postal code. Filtering on the number rather than trusting the status is the cheap guard.
 *
 * ORDER BY id so a `limit`-capped first live run is deterministic and re-runnable.
 *
 * NOT LOADED, AND WORTH KNOWING WHY NOT: the previous week's `picks_snapshot`. See the
 * "repeat picks" note in the header of `sendWeeklySmsForSubscriber`.
 */
export async function loadActiveSubscribers(limit?: number): Promise<ActiveSubscriber[]> {
  const rows = await query<{
    id: string;
    short_ref: string | number;
    phone_number: string;
    postal_code: string | null;
    birth_years: number[] | null;
    category_interests: string[] | null;
    consecutive_empty_weeks: number;
    preferences_token: string | null;
    consent_text_version: string;
  }>(
    `SELECT c.id, c.short_ref, c.phone_number, c.postal_code, c.birth_years, c.category_interests,
            c.consecutive_empty_weeks, c.preferences_token, c.consent_text_version
       FROM sms_consent c
      WHERE c.status = 'active'
        AND c.confirmed_timestamp IS NOT NULL
        AND c.is_test = false
        AND c.phone_number IS NOT NULL
        AND NOT EXISTS (
              SELECT 1
                FROM sms_send_log l
               WHERE l.subscriber_id = c.id
                 AND l.send_type = 'weekly'
                 AND l.created_at > now() - make_interval(days => $1::int)
            )
      ORDER BY c.id
      ${typeof limit === 'number' && limit > 0 ? 'LIMIT $2' : ''}`,
    typeof limit === 'number' && limit > 0
      ? [RESEND_SUPPRESSION_WINDOW_DAYS, limit]
      : [RESEND_SUPPRESSION_WINDOW_DAYS]
  );

  return rows.map((row) => ({
    // THE NUMBER TRAVELS BESIDE THE SUBSCRIBER, NEVER ON IT. `SmsSubscriber` has no phone field by
    // design — the pure builder geocodes, selects and renders, and none of that needs one, so the
    // type system keeps it out rather than a convention someone has to remember.
    subscriber: {
      id: row.id,
      // bigint comes back as a STRING from node-postgres to avoid silent precision loss. Number()
      // is exact far past anything this sequence will reach, and `encodeShortLink` rejects an
      // out-of-range ref rather than truncating it into a link to the wrong activity.
      shortRef: Number(row.short_ref),
      // COERCED, NOT DROPPED. `SmsSubscriber` requires these; the columns are nullable because
      // the 30-day purge NULLs them in place. The WHERE clause already excludes purged rows via
      // `phone_number IS NOT NULL` (the purge clears all four together), so this only fires for a
      // row that is genuinely anomalous — a number with no postal code.
      //
      // Such a row is passed THROUGH rather than filtered out, on purpose: an empty postal fails
      // to geocode, and `sendWeeklySmsForSubscriber` already reports that as
      // `skipped_geocode_failed` — a visible per-subscriber outcome in the run summary. Dropping
      // the row here would make the same anomaly invisible, which is the worse failure.
      postalCode: row.postal_code ?? '',
      birthYears: row.birth_years ?? [],
      categoryInterests: row.category_interests ?? undefined,
      consecutiveEmptyWeeks: row.consecutive_empty_weeks,
      preferencesToken: row.preferences_token ?? '',
      consentTextVersion: row.consent_text_version,
    },
    phoneNumber: row.phone_number,
  }));
}

/**
 * How many of a subscriber's previous weekly sends the novelty filter looks back over
 * (PRD v2.8 §2.2 step 4 leaves the window to the builder, with "at minimum the immediately
 * prior week" as the floor).
 *
 * ONE SEND, NOT ONE WEEK, and the difference is real: a subscriber who had an empty week has no
 * weekly send from last calendar week at all, so a time-based window would silently look back at
 * nothing and re-serve the picks from a fortnight ago. Counting SENDS looks back at the last thing
 * they actually received, whenever that was.
 *
 * WHY NOT MORE. A longer window makes the text feel fresher and is the obvious instinct — but it
 * interacts badly with the thing PRD §2.1 already worries about. In a sparse municipality the
 * whole eligible set can be a handful of activities, so excluding four weeks of picks can push a
 * subscriber under the floor of 3 every week, and three empty weeks in a row AUTO-PAUSES them
 * (§2.2 step 7). Novelty is a nice-to-have; being auto-paused is losing the subscriber. So this
 * starts at the PRD's floor, where it cannot cause that, and is one constant to raise once real
 * per-municipality data exists. Flagged in the round-7 notes as a tuning question, not a guess.
 */
export const NOVELTY_LOOKBACK_SENDS = 1;

/**
 * Occurrence ids this subscriber has already been sent, for the novelty filter. `loadRecentlySent`
 * below resolves these to their series as well; this is its first step.
 *
 * THE QUERY:
 *   SELECT picks_snapshot
 *     FROM sms_send_log
 *    WHERE subscriber_id = $1
 *      AND send_type = 'weekly'
 *      AND picks_snapshot IS NOT NULL
 *    ORDER BY created_at DESC
 *    LIMIT $2                                  -- NOVELTY_LOOKBACK_SENDS
 *   …then flatten every row's [{ occurrence_id, rank }] into one Set.
 *
 * `send_type = 'weekly'` and `picks_snapshot IS NOT NULL` are the same condition twice, on
 * purpose: migration 0035's CHECK already guarantees only weekly rows carry a snapshot, so either
 * clause alone would do — but stating both means the query still reads correctly if that CHECK is
 * ever relaxed, and it lets the planner use the send-type predicate.
 *
 * DRY RUNS WRITE NO ROW AT ALL (see `recordSmsSend`), so a verification run can never poison a
 * real subscriber's novelty window with picks they were never sent.
 *
 * Uses `idx_sms_send_log_subscriber (subscriber_id, created_at DESC)` from 0035 — the same index
 * the click-through's send-log recovery uses. No new index needed.
 */
export const loadRecentlySentPickIds = async (subscriberId: string): Promise<Set<string>> => {
  const rows = await query<{ picks_snapshot: Array<{ occurrence_id: string; rank: number }> }>(
    `SELECT picks_snapshot
       FROM sms_send_log
      WHERE subscriber_id = $1
        AND send_type = 'weekly'
        AND picks_snapshot IS NOT NULL
      ORDER BY created_at DESC
      LIMIT $2`,
    [subscriberId, NOVELTY_LOOKBACK_SENDS]
  );

  // FLATTENED ACROSS EVERY ROW IN THE WINDOW, not just the newest: with a lookback of more than
  // one send, a pick is "already sent" if it appears in ANY of them.
  const seen = new Set<string>();
  for (const row of rows) {
    for (const pick of row.picks_snapshot ?? []) {
      // Defensive on the shape rather than trusting jsonb: this column is a snapshot written by an
      // older version of the code by definition, so a row from before a shape change must degrade
      // to "nothing to exclude" rather than throwing away a subscriber's whole week.
      if (pick && typeof pick.occurrence_id === 'string') seen.add(pick.occurrence_id);
    }
  }
  return seen;
};

/**
 * The activity series (`activity_occurrence.series_id`) behind a set of sent occurrence ids — the
 * key that lets the novelty filter recognise NEXT week's sitting of a programme sent this week.
 * See `WeeklyPicksInput.excludeSeriesIds` for why the series is the right key.
 *
 * THE QUERY:
 *   SELECT DISTINCT series_id FROM activity_occurrence WHERE id = ANY($1::uuid[])
 *
 * SQL AGAINST THE TABLE, NOT THE READ MODEL. Last week's picks are in the past, and the live read
 * model holds only current and upcoming occurrences, so a lookup there would find almost nothing
 * (measured: 0 of a real subscriber's 10 sent picks were still in it). Primary-key lookup, at most
 * NOVELTY_LOOKBACK_SENDS × MAX_PICKS ids. ARCHIVED ROWS ARE INCLUDED ON PURPOSE: an occurrence
 * archived since it was sent still names its series, and that series may still be running.
 *
 * ONLY UUID-SHAPED IDS REACH THE CAST. `picks_snapshot` is jsonb written by older code, and one
 * malformed entry would make `::uuid[]` throw for the whole array, which would lose the series
 * arm for the subscriber's whole week. It is skipped instead. (It still sits in the occurrence
 * set, where it matches nothing.)
 */
export async function loadSeriesIdsForOccurrences(
  occurrenceIds: Iterable<string>
): Promise<Set<string>> {
  const ids = [...occurrenceIds].filter(isUuid);
  if (ids.length === 0) return new Set();
  const rows = await query<{ series_id: string }>(
    `SELECT DISTINCT series_id FROM activity_occurrence WHERE id = ANY($1::uuid[])`,
    [ids]
  );
  return new Set(rows.map((row) => row.series_id));
}

/** What a subscriber has already been sent, in the two keys the novelty filter excludes on. */
export interface RecentlySent {
  occurrenceIds: Set<string>;
  seriesIds: Set<string>;
  /**
   * False when the series lookup failed. The week then gets the occurrence arm only, the pre-D5
   * behaviour, rather than no novelty at all. Reported as `noveltyDegraded: 'occurrence_only'`.
   */
  seriesResolved: boolean;
}

export type RecentlySentLoader = (subscriberId: string) => Promise<RecentlySent>;

/**
 * The novelty window for one subscriber: `loadRecentlySentPickIds`, then
 * `loadSeriesIdsForOccurrences` over what it returned.
 *
 * THE TWO READS FAIL DIFFERENTLY, ON PURPOSE:
 *   • the SNAPSHOT read throws through. Without it there is nothing to resolve, and the caller
 *     (`sendWeeklySmsForSubscriber`) already turns that into "no novelty this week" instead of
 *     "no send". Same as before D5.
 *   • the SERIES read is caught here and falls back to the occurrence ids alone. The occurrence
 *     ids are already in hand, so a failure in the new query must not throw them away.
 *
 * `seams` exists so the fallback can be tested without breaking a real database.
 */
export async function loadRecentlySent(
  subscriberId: string,
  seams: {
    loadPickIds?: typeof loadRecentlySentPickIds;
    resolveSeries?: typeof loadSeriesIdsForOccurrences;
  } = {}
): Promise<RecentlySent> {
  const occurrenceIds = await (seams.loadPickIds ?? loadRecentlySentPickIds)(subscriberId);
  try {
    const seriesIds = await (seams.resolveSeries ?? loadSeriesIdsForOccurrences)(occurrenceIds);
    return { occurrenceIds, seriesIds, seriesResolved: true };
  } catch {
    return { occurrenceIds, seriesIds: new Set(), seriesResolved: false };
  }
}

/**
 * Write back `consecutive_empty_weeks` and `status` after a week.
 *
 * THE QUERY:
 *   UPDATE sms_consent
 *      SET consecutive_empty_weeks = $2,
 *          status = $3
 *    WHERE id = $1 AND status = 'active'
 *
 * `AND status = 'active'` is a guard, not decoration: between loading the batch and writing this
 * row back, an inbound STOP webhook may have set the subscriber to 'stopped'. Without the guard
 * this UPDATE would quietly resurrect them to 'active' or 'paused' and the Friday job would text
 * someone who opted out mid-run. The inbound path wins; this write simply does not apply.
 */
export async function applyEmptyWeekState(
  subscriberId: string,
  state: EmptyWeekState
): Promise<void> {
  // `AND status = 'active'` IS A GUARD, NOT DECORATION. Between loading the batch and writing this
  // row back, an inbound STOP webhook may have set the subscriber to 'stopped'. Without it this
  // UPDATE would quietly resurrect them to 'active' or 'paused' and the Friday job would have
  // texted someone who opted out mid-run. The inbound path wins; this write simply does not apply.
  await query(
    `UPDATE sms_consent
        SET consecutive_empty_weeks = $2, status = $3
      WHERE id = $1 AND status = 'active'`,
    [subscriberId, state.consecutiveEmptyWeeks, state.status]
  );
}

/**
 * Mark a subscriber stopped because Twilio said they opted out at the carrier (21610).
 *
 * THE QUERY:
 *   UPDATE sms_consent
 *      SET status = 'stopped', stopped_at = COALESCE(stopped_at, now())
 *    WHERE id = $1
 *
 * COALESCE, not a bare `now()`. Migration 0034's 30-day purge clock keys off `stopped_at`, so
 * re-stamping it on a subscriber who already stopped would push their purge deadline out every
 * time the send job hit their number again — a retention promise quietly extended by a retry.
 * Same rule as the inbound STOP mirror in lib/sms/consent-transitions.ts.
 */
export async function markStoppedViaCarrier(subscriberId: string): Promise<void> {
  // COALESCE, not a bare now(). Migration 0034's 30-day purge clock keys off `stopped_at`, so
  // re-stamping it on a subscriber who already stopped would push their purge deadline out every
  // time the send job hit their number again — a retention promise quietly extended by a retry.
  // Same rule as the inbound STOP mirror in lib/sms/consent-transitions.ts.
  //
  // NO STATUS PREDICATE HERE, unlike `applyEmptyWeekState` above, and the asymmetry is deliberate:
  // the carrier has told us this number is suppressed, which is true regardless of what our row
  // currently says. Refusing to record it because the row was already 'paused' would leave our
  // database disagreeing with Twilio's suppression list, which is the exact drift the mirror
  // exists to prevent.
  await query(
    `UPDATE sms_consent
        SET status = 'stopped', stopped_at = COALESCE(stopped_at, now())
      WHERE id = $1`,
    [subscriberId]
  );
}

// ── The consent assertion (P6, 2026-09-24) ──────────────────────────────────────────────

/** The three columns the weekly consent assertion judges, read fresh by the send itself. */
export interface WeeklySendConsentRow {
  status: ConsentStatus;
  confirmedTimestamp: Date | null;
  /** E.164, or NULL once purged. Compared, never logged or returned. */
  phoneNumber: string | null;
}

export type WeeklySendConsentLoader = (subscriberId: string) => Promise<WeeklySendConsentRow | null>;

/**
 * Read one subscriber's consent state straight from `sms_consent`, by id.
 *
 * THE QUERY:
 *   SELECT status, confirmed_timestamp, phone_number FROM sms_consent WHERE id = $1
 *
 * WHY THE SEND READS IT ITSELF. `sendWeeklySmsForSubscriber` is exported and takes a ready-made
 * subscriber plus a phone number. Every caller today picks that pair out of
 * `loadActiveSubscribers`, but nothing forced the next one to: a route with its own row lookup
 * could hand it a PENDING row and it would have texted them (QA of a5a863a, probe P6). The same
 * lesson as Instant Picks' CASL fix — a send must not borrow its consent check from whoever looked
 * the row up — so the send now asks the database, not its caller.
 */
export const loadWeeklySendConsent: WeeklySendConsentLoader = async (subscriberId) => {
  const rows = await query<{
    status: ConsentStatus;
    confirmed_timestamp: Date | null;
    phone_number: string | null;
  }>(`SELECT status, confirmed_timestamp, phone_number FROM sms_consent WHERE id = $1`, [
    subscriberId,
  ]);
  const row = rows[0];
  if (!row) return null;
  return {
    status: row.status,
    confirmedTimestamp: row.confirmed_timestamp,
    phoneNumber: row.phone_number,
  };
};

/**
 * Why a weekly send was refused. Server-log vocabulary only — see `REFUSED_CONSENT_ERROR`.
 * `null` means the send may proceed.
 */
export type WeeklySendConsentRefusal =
  | 'not_found'
  | 'purged'
  | 'number_mismatch'
  | 'status_pending'
  | 'status_paused'
  | 'status_stopped'
  | 'active_unconfirmed'
  | 'consent_read_failed';

/**
 * The weekly CONTENT rule: may this row receive the Friday text at this number?
 *
 * ACTIVE, CONFIRMED, AND THE NUMBER WE ARE ABOUT TO TEXT IS THIS ROW'S NUMBER. Each clause:
 *   • `status === 'active'` — pending has not finished the double opt-in; paused subscribers were
 *     told in writing their texts are paused; stopped withdrew consent.
 *   • `confirmedTimestamp != null` — the recorded JOIN. Not redundant: pending → STOP → START
 *     produces `active` with no confirmation (see `loadActiveSubscribers`), and a restore or a
 *     hand-edited row can too. Fails closed, exactly like Instant Picks' `hasConfirmedActiveConsent`.
 *   • the number matches — otherwise the consent we checked belongs to someone other than the
 *     person we would text. Also catches a purged row (NULL number).
 *
 * DELIBERATELY NOT SHARED WITH `hasConfirmedActiveConsent`, though today they agree (a test pins
 * that). Whether PAUSED subscribers may ask for Instant Picks is an open call for Jon; whichever
 * way it goes, the weekly rule keeps excluding paused, because those subscribers were told their
 * weekly texts are paused. One shared predicate would couple the two decisions.
 *
 * Pure and exported so the shipped rule is what the tests execute.
 */
export function weeklySendConsentRefusal(
  row: WeeklySendConsentRow | null,
  phoneNumber: string
): WeeklySendConsentRefusal | null {
  if (!row) return 'not_found';
  if (row.phoneNumber == null) return 'purged';
  if (row.status === 'pending') return 'status_pending';
  if (row.status === 'paused') return 'status_paused';
  if (row.status === 'stopped') return 'status_stopped';
  if (row.status !== 'active') return 'not_found'; // unreachable under 0034's CHECK; fail closed
  if (row.confirmedTimestamp == null) return 'active_unconfirmed';
  if (row.phoneNumber !== phoneNumber) return 'number_mismatch';
  return null;
}

/**
 * The `error` a refused result carries — and therefore what the run route returns over HTTP.
 * GENERIC ON PURPOSE: the route's own 404 already declines to say whether an id is missing or
 * merely not active ("a fact about a phone number"), so the specific reason goes to the server
 * log only.
 */
export const REFUSED_CONSENT_ERROR = 'consent not active';

/** Refusals that are a normal race (a STOP or a resubmit mid-run) versus ones that mean bad data. */
const ANOMALOUS_REFUSALS: ReadonlySet<WeeklySendConsentRefusal> = new Set([
  'active_unconfirmed',
  'number_mismatch',
  'consent_read_failed',
]);

function logConsentRefusal(subscriberId: string, reason: WeeklySendConsentRefusal): void {
  // Id and reason only — never the number, never a body (see the file header).
  const line = `[sms] weekly send REFUSED — consent check. subscriber=${subscriberId} reason=${reason}`;
  if (ANOMALOUS_REFUSALS.has(reason)) {
    // eslint-disable-next-line no-console -- deliberate: a content send refused for bad consent data
    // must not be silent, and lib/sms has no logger of its own (same as `bestEffortAudit`).
    console.error(line);
  } else {
    // eslint-disable-next-line no-console -- as above; an expected race, logged at a lower level.
    console.warn(line);
  }
}

// ── The per-subscriber unit ─────────────────────────────────────────────────────────────

export type SubscriberSendStatus =
  | 'sent'
  | 'dry_run'
  | 'empty'
  | 'paused'
  | 'stopped_via_carrier'
  | 'skipped_geocode_failed'
  /** The consent assertion refused this subscriber: nothing built, sent, logged or changed. */
  | 'refused_consent'
  | 'error';

/**
 * How the novelty filter was weakened for one subscriber's week, when it was:
 *   • 'occurrence_only' — the series lookup failed, so only exact occurrences were excluded (the
 *     pre-D5 filter). Recurring programmes from last week can repeat.
 *   • 'unavailable'     — last week's snapshot could not be read, so nothing was excluded.
 * Neither costs the subscriber their week; both are worth knowing about.
 */
export type NoveltyDegradation = 'occurrence_only' | 'unavailable';

/**
 * What one subscriber's run produced. SAFE TO LOG AND TO RETURN OVER HTTP — see the file header.
 * No phone number, no message body. `segments` and `pickCount` are the useful numbers.
 */
export interface SubscriberSendResult {
  subscriberId: string;
  status: SubscriberSendStatus;
  pickCount: number;
  /** Segment count of the message that was built, for cost visibility. 0 when nothing was built. */
  segments: number;
  /** How far the selection had to degrade — 'none' | 'widened' | 'widened_and_interests_dropped'. */
  degradation?: string;
  /** Occurrences the selector wanted to link directly but could not — a stale short-ref map. */
  unlinkableCount?: number;
  /**
   * How many candidates the novelty filter removed as already-sent.
   *
   * Surfaced all the way to the run route because it is the number that distinguishes "this
   * municipality is thin" from "we have already sent them everything it has" — two very different
   * problems that produce the same empty week.
   */
  novelExcluded?: number;
  /**
   * Set only when this week's novelty filter was weaker than designed — see `NoveltyDegradation`.
   * Absent on a normal week. A guard nobody can see failing is a guard nobody can fix.
   */
  noveltyDegraded?: NoveltyDegradation;
  /** Never contains a number or a body. */
  error?: string;
}

export interface SendSubscriberOptions {
  /** Defaults to !smsSendingEnabled() — a real send requires opting in explicitly. */
  dryRun?: boolean;
  now?: Date;
  deps?: WeeklySmsDeps;
  /** Injected for tests; defaults to the real loader above. */
  loadRecentlySent?: RecentlySentLoader;
  /**
   * The three write/send seams, injected for tests.
   *
   * ADDED IN ROUND 17 BECAUSE THIS FUNCTION HAD NO DIRECT TEST AT ALL — it was only ever mocked
   * wholesale by tests/sms/weekly_run_route.test.ts. Its 21610 handling was the CORRECT half of
   * the pair round 17's review found (lib/sms/welcome.ts was missing the state change), and
   * "correct" was an assertion nobody had ever run. lib/sms/welcome.ts and lib/sms/signup-store.ts
   * have carried the same three seams since they were written; this aligns the weekly path with
   * them rather than inventing an idiom.
   */
  dispatch?: typeof dispatchSms;
  record?: typeof recordSmsSend;
  markStopped?: typeof markStoppedViaCarrier;
  applyState?: typeof applyEmptyWeekState;
  /** Injected for tests; defaults to `loadWeeklySendConsent`. See the consent assertion above. */
  loadConsent?: WeeklySendConsentLoader;
}

/**
 * Run a post-dispatch write and swallow whatever it throws.
 *
 * ═══ WHY THESE WRITES MUST NOT REACH THE OUTER CATCH ═══
 * Everything below the dispatch is bookkeeping about a message that HAS ALREADY BEEN SENT (or
 * already been refused by the carrier). Letting one of them throw into the function's outer
 * `catch` does two separate kinds of damage:
 *
 *   1. IT LEAKS. That catch returns `error: (err as Error)?.message` verbatim, and
 *      app/api/sms/weekly/run/route.ts passes `r.error` through to the HTTP response unfiltered.
 *      These three are the only calls in the function that hand a phone number to a database, and
 *      many drivers echo the offending row's identifying values back in a constraint-violation
 *      message. That is a phone number in an HTTP response.
 *   2. IT LIES. A message that genuinely went, or a carrier opt-out we genuinely detected, would
 *      be reported as `status: 'error'` because the AUDIT WRITE afterwards failed. The true
 *      outcome — the one the subscriber experienced — is discarded in favour of a fact about our
 *      own bookkeeping.
 *
 * lib/sms/welcome.ts and lib/sms/signup-store.ts have wrapped the equivalent calls since they were
 * written, with the same reasoning. This is that, applied to the path that had it first and
 * somehow never got it.
 *
 * SILENT IS DELIBERATE AND IS NOT "IGNORED". The dispatch result is already the return value, so
 * a lost audit row is visible as a mismatch between `sms_send_log` and Twilio's own console rather
 * than as nothing at all — and there is no honest alternative here: the message cannot be unsent.
 */
async function bestEffort(write: () => Promise<unknown>): Promise<void> {
  try {
    await write();
  } catch {
    // See above. A bookkeeping failure must not rewrite what happened to the subscriber.
  }
}

/**
 * The same swallow, for the AUDIT write specifically — but LOUD.
 *
 * ═══ WHY A VARIANT AND NOT A CHANGE TO `bestEffort` ═══
 * `bestEffort` also wraps `markStopped` and `applyState`, which are STATE writes. Those are
 * genuinely fine to lose quietly: they are idempotent, next week's run re-derives them, and a
 * failed one costs a subscriber one miscounted empty week. The AUDIT write is not like that —
 * `sms_send_log` is the CASL evidence that we texted a number, it cannot be re-derived after the
 * fact, and losing one is unrecoverable. Changing `bestEffort` universally would make the
 * recoverable failures as noisy as the unrecoverable one and teach whoever reads the logs to
 * ignore all of them.
 *
 * ═══ WHY IT STILL DOES NOT THROW ═══
 * The block above `bestEffort` is not decoration: throwing here would (1) report `status: 'error'`
 * for a message the subscriber genuinely received, and (2) put a driver error string — which can
 * contain the phone number — into an HTTP response. Both were real, documented reasons. The
 * message cannot be unsent, so the honest outcome is still "the send happened", and the failure
 * belongs in the LOG rather than in the result.
 *
 * The pre-flight in `sendWeeklySmsBulk` is what makes the salt case unreachable BEFORE any message
 * goes out. This is the second layer, for everything the pre-flight cannot know about — a
 * connection lost mid-run, a constraint violation, a permissions change.
 *
 * ═══ SCRUBBED TWICE, AND THE SECOND PASS IS NOT BELT-AND-BRACES ═══
 * A pg driver error can quote the parameters it failed on, and one of them is an E.164 number. The
 * obvious scrub is `scrubNumber(detail, context.phoneNumber)` — THIS SUBSCRIBER'S number — and it
 * is not enough. A unique-violation raised while writing subscriber B's row names the CONFLICTING
 * row's value, which is ANOTHER SUBSCRIBER'S NUMBER, and a context-keyed scrub cannot see it.
 *
 * That is not hypothetical: it was caught by reading this function's own output in
 * tests/sms/weekly_send_bulk.test.ts, which simulates exactly that error. The log line read
 * `DETAIL: Key (phone)=(+16045550001) already exists.` — a raw number, from the fix meant to stop
 * raw numbers reaching logs.
 *
 * So the second pass is pattern-based and subscriber-agnostic: ANY E.164-shaped run of digits is
 * redacted to its last four, whoever it belongs to.
 */
async function bestEffortAudit(
  write: () => Promise<unknown>,
  context: { stage: string; subscriberId: string; phoneNumber: string }
): Promise<void> {
  try {
    await write();
  } catch (err) {
    const raw = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    // Pass 1: this subscriber's number, which we know exactly. Pass 2: anything else E.164-shaped
    // — a conflicting row's number, a number embedded in a constraint detail. See above.
    const detail = scrubAnyNumber(scrubNumber(raw, context.phoneNumber));
    // eslint-disable-next-line no-console -- deliberate: an unrecoverable CASL audit-write failure
    // must not be silent, and lib/sms has no logger of its own. See the block above.
    console.error(
      `[sms] AUDIT WRITE FAILED — sms_send_log row lost for a message that was sent. ` +
        `stage=${context.stage} subscriber=${context.subscriberId} error=${detail}`
    );
  }
}

/**
 * Refuse to start a real send that cannot be audited, or whose unsubscribe link would not work.
 *
 * ═══ WHY THIS EXISTS, AND WHY IT IS NOT A PER-MESSAGE CHECK ═══
 * Both failures below are ALREADY detected somewhere — and both are detected too late to matter.
 * `recordSmsSend` throws `MissingPhoneHashSaltError`, but only AFTER the dispatch, inside
 * `bestEffortAudit`. `mintPreferencesToken` returns null, but at SIGNUP, silently and correctly.
 * Neither can stop a message going out. Checking once, before anything is dispatched, is what
 * converts "every text ships broken and the run reports success" into a refusal to start.
 *
 * ═══ TWO SECRETS, AND EXACTLY TWO ═══
 * SMS_PHONE_HASH_SALT      — without it, `sms_send_log` cannot be written and the CASL audit trail
 *                            silently does not exist for any message in the run.
 * SMS_PREFERENCES_SECRET   — without it, `preferences_token` is never minted, `preferencesUrl('')`
 *                            renders a bare `/u/`, and every message carries an unsubscribe link
 *                            that 404s. lib/sms/config.ts's own comment: "a message that renders
 *                            without it is a message that must not be sent."
 *
 * SMS_SHORT_LINK_SECRET IS DELIBERATELY NOT HERE. `encodeShortLink` already throws hard when it is
 * unset (short-link.ts:130-132), inside `buildWeeklySms`, which runs BEFORE any dispatch — so it
 * is already fail-closed by an existing convention and nothing is sent. Adding it would duplicate
 * a guarantee that already holds, and a redundant check invites the reader to assume the other two
 * were redundant as well.
 *
 * ═══ IT ASKS `preferencesSecret()`, NOT `process.env` ═══
 * Deliberately the SAME call `mintPreferencesToken` makes, so the guard tracks the mint function
 * rather than a raw variable name. If that truthiness check ever changes — a minimum length, a
 * format check, a rename — this moves with it instead of drifting into a guard that passes while
 * the thing it guards fails. A check that can silently stop matching what it protects is worse
 * than no check, because it reads as protection.
 *
 * ═══ A DRY RUN IS EXEMPT, AND THAT IS LOAD-BEARING, NOT A LOOPHOLE ═══
 * `dispatchSms` returns `{ outcome: 'dry_run' }` as its FIRST branch (twilio-client.ts:161),
 * before the client check, so a dry run reaches neither a log write nor a real subscriber's phone.
 * Gating dry runs would break every verification run on every unconfigured machine — including
 * this branch's own, where neither secret has ever been set and neither needed to be. The guard
 * fires on exactly the case that matters: a run that will really text somebody.
 */
export function assertSendPreconditions(dryRun: boolean): void {
  if (dryRun) return;
  if (!phoneHashSalt()) throw new MissingPhoneHashSaltError();
  if (!preferencesSecret()) throw new MissingPreferencesSecretError();
}

/**
 * Build and (unless dry-run) send one subscriber's weekly text.
 *
 * The single testable unit; bulk simply loops it. NEVER THROWS — every failure path returns a
 * structured `SubscriberSendResult`, exactly as `sendWeeklyDigestForUser` does, so one
 * subscriber's bad row cannot take down a batch of five hundred.
 *
 * ── REPEAT PICKS: THE NOVELTY FILTER ─────────────────────────────────────────────────────
 * The email digest sends only what is NEW since the last send (a watermark over
 * `activity_occurrence.created_at`). PRD §2.2 asks "what is on this weekend" instead, and a weekly
 * public swim is on every weekend, so without a filter a subscriber gets the same picks every
 * Friday. PRD v2.8 §2.2 step 4 added one: step 0 below reads the previous weekly send's
 * `picks_snapshot` and `selectWeeklyPicks` excludes what it held. Since D5 (2026-09-24) that is
 * excluded by activity SERIES as well as by occurrence. The occurrence id alone changes every
 * week for a recurring programme, which is how "same venues every week" got through the
 * original filter. See `loadRecentlySent` and `WeeklyPicksInput.excludeSeriesIds`.
 *
 * ── ⛔ CONSENT IS CHECKED HERE, NOT TRUSTED FROM THE CALLER (P6, 2026-09-24) ─────────────
 * Step −1 re-reads this subscriber's row and refuses unless it is active, confirmed, and holds the
 * number we were handed (`weeklySendConsentRefusal`). It runs BEFORE the read model, the build,
 * the dispatch and every write, and it runs on dry runs too — a dry run that reported `dry_run` for
 * a pending row would misstate what a real run does.
 *
 * A REFUSAL IS A RESULT, NOT A THROW. This function is contractually never-throws and the bulk loop
 * has no try/catch, so a throw would abort the batch at the first refused row. A refused subscriber
 * gets `status: 'refused_consent'`: no message, no `sms_send_log` row (nobody was texted), no
 * empty-week increment (three of those auto-pause someone), no state change. A failed consent read
 * refuses too — if consent cannot be shown, nothing is sent.
 */
export async function sendWeeklySmsForSubscriber(
  subscriber: SmsSubscriber,
  phoneNumber: string,
  options: SendSubscriberOptions = {}
): Promise<SubscriberSendResult> {
  const now = options.now ?? new Date();
  const dryRun = options.dryRun ?? !smsSendingEnabled();
  const send = options.dispatch ?? dispatchSms;
  const log = options.record ?? recordSmsSend;
  const markStopped = options.markStopped ?? markStoppedViaCarrier;
  const applyState = options.applyState ?? applyEmptyWeekState;
  const loadConsent = options.loadConsent ?? loadWeeklySendConsent;
  // Copied from the subscriber's own row, never defaulted — see SmsSubscriber.consentTextVersion.
  const consentTextVersion = subscriber.consentTextVersion;

  // −1. ⛔ THE CONSENT ASSERTION. Before anything else — see the header above.
  let refusal: WeeklySendConsentRefusal | null;
  try {
    refusal = weeklySendConsentRefusal(await loadConsent(subscriber.id), phoneNumber);
  } catch {
    // The driver's message is not kept: it could quote the parameters it failed on.
    refusal = 'consent_read_failed';
  }
  if (refusal) {
    logConsentRefusal(subscriber.id, refusal);
    return {
      subscriberId: subscriber.id,
      status: 'refused_consent',
      pickCount: 0,
      segments: 0,
      error: REFUSED_CONSENT_ERROR,
    };
  }

  try {
    const deps = options.deps ?? (await loadWeeklySmsDeps());
    const loadRecent = options.loadRecentlySent ?? loadRecentlySent;

    // 0. What have they already been sent? PER SUBSCRIBER, so unlike the read model this cannot be
    //    hoisted into `WeeklySmsDeps` — but it IS two indexed reads against rows they own, and a
    //    failure here must not cost them their week: empty sets mean no novelty filtering,
    //    which degrades to the pre-v2.8 behaviour rather than to no send. A failure of the series
    //    read alone is handled inside the loader (occurrence arm only). Either way it is reported
    //    as `noveltyDegraded`, so a weaker filter is visible rather than silent.
    let recent: RecentlySent;
    let noveltyDegraded: NoveltyDegradation | undefined;
    try {
      recent = await loadRecent(subscriber.id);
      if (!recent.seriesResolved) noveltyDegraded = 'occurrence_only';
    } catch {
      recent = { occurrenceIds: new Set(), seriesIds: new Set(), seriesResolved: false };
      noveltyDegraded = 'unavailable';
    }

    // 1. Build. Pure — geocode, ages, selection, message. May throw only on a missing link secret.
    const plan: WeeklySmsPlan = buildWeeklySms({
      engine: deps.engine,
      now,
      subscriber,
      occurrenceShortRefs: deps.occurrenceShortRefs,
      excludeOccurrenceIds: recent.occurrenceIds,
      excludeSeriesIds: recent.seriesIds,
    });

    // 2. Decide what this week does to the counter and the status.
    const state = nextEmptyWeekState(subscriber.consecutiveEmptyWeeks, weekOutcomeFor(plan));

    // 3. A postal code that does not resolve: send nothing, change nothing, surface it.
    //    Deliberately NOT an empty week — see lib/sms/weekly-send.ts's header.
    if (plan.outcome === 'geocode_failed') {
      return {
        subscriberId: subscriber.id,
        status: 'skipped_geocode_failed',
        pickCount: 0,
        segments: 0,
        error: 'postal code resolves to no covered municipality',
      };
    }

    // 4. The third consecutive empty week sends the pause notice INSTEAD of a third empty text.
    const message =
      state.message === 'pause_notice' ? pauseNoticeFor(subscriber) : plan.message;
    if (!message || state.message === 'none') {
      return { subscriberId: subscriber.id, status: 'error', pickCount: 0, segments: 0, error: 'no message to send' };
    }

    const sendType: SendLogType =
      state.message === 'pause_notice' ? 'pause_notice' : state.message === 'empty_week' ? 'empty_week' : 'weekly';
    const pickCount = plan.picks?.picks.length ?? 0;
    const base = {
      subscriberId: subscriber.id,
      pickCount,
      segments: message.segments,
      degradation: plan.picks?.degradation,
      ...(plan.unlinkableOccurrenceIds.length > 0
        ? { unlinkableCount: plan.unlinkableOccurrenceIds.length }
        : {}),
      ...(plan.picks?.novelExcluded ? { novelExcluded: plan.picks.novelExcluded } : {}),
      ...(noveltyDegraded ? { noveltyDegraded } : {}),
    };

    // 5. Dispatch.
    const dispatch = await send(phoneNumber, message, { dryRun });

    // 5a. The carrier says this number opted out. Independent of, and faster than, the inbound
    //     webhook mirror (PRD §2.2 step 6). Stop them now, log it, and do NOT apply the
    //     empty-week state — they are not paused, they are stopped.
    if (dispatch.outcome === 'stopped_via_carrier') {
      await bestEffort(() => markStopped(subscriber.id));
      await bestEffortAudit(
        () =>
          log({
            subscriberId: subscriber.id,
            phoneNumber,
            sendType,
            outcome: 'stopped_via_carrier',
            picksSnapshot: null,
            twilioSid: dispatch.twilioSid,
            consentTextVersion,
          }),
        { stage: 'stopped_via_carrier', subscriberId: subscriber.id, phoneNumber }
      );
      return { ...base, status: 'stopped_via_carrier' };
    }

    if (dispatch.outcome === 'failed') {
      // A failed dispatch changes nothing. The counter must not advance for a message that was
      // never delivered — otherwise a Twilio outage would pause subscribers three weeks later.
      await bestEffortAudit(
        () =>
          log({
            subscriberId: subscriber.id,
            phoneNumber,
            sendType,
            outcome: 'failed',
            picksSnapshot: null,
            twilioSid: null,
            consentTextVersion,
          }),
        { stage: 'dispatch_failed', subscriberId: subscriber.id, phoneNumber }
      );
      return { ...base, status: 'error', error: dispatch.error ?? 'dispatch failed' };
    }

    // 5b. DRY RUN: everything above is real, nothing below happens. No audit row, no counter
    //     move — the same rule the email job applies to its watermark.
    if (dispatch.outcome === 'dry_run') {
      return { ...base, status: 'dry_run' };
    }

    // 6. A real send. Record the audit row and apply the state TOGETHER — a subscriber must never
    //    be paused for a week they were not texted about, nor texted without the log saying so.
    await bestEffortAudit(
      () =>
        log({
          subscriberId: subscriber.id,
          phoneNumber,
          sendType,
          outcome: sendType === 'weekly' ? 'sent' : sendType === 'pause_notice' ? 'paused' : 'empty',
          picksSnapshot: picksSnapshot(plan),
          twilioSid: dispatch.twilioSid,
          consentTextVersion,
        }),
      { stage: 'sent', subscriberId: subscriber.id, phoneNumber }
    );
    await bestEffort(() => applyState(subscriber.id, state));

    if (state.pausedNow) return { ...base, status: 'paused' };
    return { ...base, status: plan.outcome === 'picks' ? 'sent' : 'empty' };
  } catch (err) {
    // Never let the message or the number reach an error string.
    //
    // WHAT CAN STILL REACH HERE, now that the three post-dispatch writes are wrapped: the deps
    // load (catalogue reads — no phone number in that query), the pure build, and nothing else.
    // `dispatchSms` does not throw; it catches internally and returns a result. So no code path
    // that HOLDS the number can land in this catch any more — which is the actual fix, and the
    // scrub below is only a backstop.
    return {
      subscriberId: subscriber.id,
      status: 'error',
      pickCount: 0,
      segments: 0,
      error: scrubNumber((err as Error)?.message ?? 'unknown error', phoneNumber),
    };
  }
}

/**
 * Replace the subscriber's E.164 number with its redacted form if it somehow appears in an error.
 *
 * A BACKSTOP, AND NAMED ONE. It matches only the exact string we hold, so a driver that formatted
 * the number differently would slip past it. It is not a substitute for keeping the number out of
 * error text in the first place — see the catch above for why nothing that holds it can get here
 * — it is the cheap second barrier for the case where that reasoning is wrong.
 */
/**
 * Redact EVERY E.164-shaped number in a string, not just one we can name.
 *
 * `scrubNumber` needs to be told which number to look for. This does not — which is the only way
 * to catch a number that arrived from somewhere we were not holding, such as the conflicting row
 * quoted in a unique-violation's DETAIL. Deliberately conservative about what counts: a leading
 * `+` and 8-15 digits is the E.164 shape migration 0034's CHECK enforces, so this cannot chew
 * through timestamps, ids or short_refs.
 */
function scrubAnyNumber(text: string): string {
  return text.replace(/\+[1-9]\d{7,14}/g, (m) => redactPhone(m));
}

function scrubNumber(text: string, phoneNumber: string): string {
  return phoneNumber && text.includes(phoneNumber)
    ? text.split(phoneNumber).join(redactPhone(phoneNumber))
    : text;
}

// ── Bulk ────────────────────────────────────────────────────────────────────────────────

export interface BulkOptions {
  now?: Date;
  dryRun?: boolean;
  /** Cap the number of candidate subscribers (safety for a first live run). */
  limit?: number;
  /** Injected for tests; defaults to the real loader. */
  loadRecentlySent?: RecentlySentLoader;
  /**
   * The batch's own two loads, and the four per-subscriber write seams, injected for tests.
   *
   * ADDED IN ROUND 19 BECAUSE THIS FUNCTION COULD NOT BE CALLED IN A TEST AT ALL. `loadDeps` hits
   * Postgres unconditionally on the first line, so any direct call threw before reaching a single
   * assertion — which is why the only reference to `sendWeeklySmsBulk` anywhere in the suite was a
   * `vi.mock` that replaced it. A driver that cannot be executed is a driver whose behaviour is
   * assumed rather than known.
   *
   * `loadDeps` IS INJECTED RATHER THAN `deps` DIRECTLY, deliberately: handing in a ready-made read
   * model would make the "load once per batch, never once per subscriber" property untestable,
   * because there would be no call to count. See tests/sms/weekly_send_bulk.test.ts.
   */
  loadDeps?: typeof loadWeeklySmsDeps;
  loadSubscribers?: typeof loadActiveSubscribers;
  dispatch?: typeof dispatchSms;
  record?: typeof recordSmsSend;
  markStopped?: typeof markStoppedViaCarrier;
  applyState?: typeof applyEmptyWeekState;
  loadConsent?: WeeklySendConsentLoader;
}

export interface BulkSummary {
  dryRun: boolean;
  candidates: number;
  counts: Record<SubscriberSendStatus, number>;
  /** Total segments across every message built — the week's cost, visible rather than inferred. */
  totalSegments: number;
  results: SubscriberSendResult[];
}

function emptyCounts(): Record<SubscriberSendStatus, number> {
  return {
    sent: 0,
    dry_run: 0,
    empty: 0,
    paused: 0,
    stopped_via_carrier: 0,
    skipped_geocode_failed: 0,
    refused_consent: 0,
    error: 0,
  };
}

/**
 * Send to every active subscriber. Loads the read model ONCE and reuses it.
 *
 * SERIAL, like the email job: a weekly cadence over a low-hundreds list is not a throughput
 * problem, and serial keeps the load gentle on both the database and the messaging API. It also
 * means a `limit`-capped first live run sends to exactly the first N and stops, rather than to
 * N-ish depending on how the concurrency landed.
 *
 * Dry-run unless explicitly enabled — see `sendWeeklySmsForSubscriber`.
 */
export async function sendWeeklySmsBulk(options: BulkOptions = {}): Promise<BulkSummary> {
  const now = options.now ?? new Date();
  const dryRun = options.dryRun ?? !smsSendingEnabled();

  // ── THE PRE-FLIGHT: refuse to start a real run we could not audit ──────────────────────
  // BEFORE the subscriber load, before the read model, before any dispatch. A missing
  // SMS_PHONE_HASH_SALT would otherwise be discovered one subscriber at a time, AFTER each text
  // had already gone out, by a throw that `bestEffortAudit` catches — every message delivered and
  // every CASL audit row silently lost, with the run still reporting success. Failing the whole
  // job once, loudly, before the first text, is the only point at which this is still recoverable.
  // Exempt on a dry run — see `assertSendPreconditions`.
  assertSendPreconditions(dryRun);

  // THE READ MODEL IS LOADED ONCE FOR THE WHOLE BATCH, never once per subscriber — the design
  // decision this function exists to enforce (round 4, mirroring lib/email/weekly.ts). `deps` is
  // then passed into every per-subscriber call, which is what stops `loadWeeklySmsDeps` being
  // re-entered five hundred times. Pinned by a test that counts the calls rather than trusting it.
  //
  // SUBSCRIBERS FIRST, THEN THE READ MODEL — reordered in round 21 (pre-approved). It used to load
  // deps first, unconditionally, so a week with zero active subscribers pulled the entire listing
  // catalogue, alias resolver and region hierarchy out of Postgres for nothing. Reachable every
  // week before launch and any week the product is paused.
  const subscribers = await (options.loadSubscribers ?? loadActiveSubscribers)(options.limit);
  if (subscribers.length === 0) {
    // Nothing to send to, so nothing to build a message from. Returns the same shape as any other
    // run — an empty batch is a normal Friday, not an error.
    return { dryRun, candidates: 0, counts: emptyCounts(), totalSegments: 0, results: [] };
  }
  const deps = await (options.loadDeps ?? loadWeeklySmsDeps)();

  const counts = emptyCounts();
  const results: SubscriberSendResult[] = [];
  let totalSegments = 0;

  for (const { subscriber, phoneNumber } of subscribers) {
    // NEVER THROWS — `sendWeeklySmsForSubscriber` returns a structured result on every failure
    // path, which is what keeps one bad row from taking down a batch of five hundred. That is a
    // property of the CALLEE, not of this loop: there is no try/catch here, and if that contract
    // were ever broken the batch would abort mid-run. Asserted from this side too, in
    // tests/sms/weekly_send_bulk.test.ts, so the dependency is checked rather than assumed.
    const result = await sendWeeklySmsForSubscriber(subscriber, phoneNumber, {
      now,
      dryRun,
      deps,
      loadRecentlySent: options.loadRecentlySent,
      dispatch: options.dispatch,
      record: options.record,
      markStopped: options.markStopped,
      applyState: options.applyState,
      // A refused subscriber comes back as `refused_consent` and the loop simply moves on — the
      // same one-bad-row-cannot-sink-the-batch contract as every other outcome.
      loadConsent: options.loadConsent,
    });
    counts[result.status] += 1;
    totalSegments += result.segments;
    results.push(result);
  }

  return { dryRun, candidates: subscribers.length, counts, totalSegments, results };
}
