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
// ── WHAT IS REAL HERE AND WHAT IS A STUB ────────────────────────────────────────────────
// REAL: the deps loading shape, the per-subscriber flow, the dry-run gate, the outcome mapping,
// the empty-week/pause transition wiring, and the PII discipline. All of it runs today.
// STUB: `loadActiveSubscribers`, `applyEmptyWeekState` and `markStoppedViaCarrier`.
// REAL AS OF ROUND 16: `dispatchSms` (lib/sms/twilio-client.ts) issues an actual Twilio Messages
// API call. `recordSmsSend` (lib/sms/send-log.ts) is still a stub. `sms_consent` and `sms_send_log` exist only as unapplied SQL
// (migrations 0034/0035) and nobody on this branch holds write credentials, so each carries the
// exact query it will issue and its non-obvious notes. Same posture as
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
import { smsSendingEnabled } from './config';
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
// Re-exported: this module's own header documents the PII rule `redactPhone` serves, and callers
// have imported it from here since round 4. The rule itself now has one home in lib/sms/redact.ts.
import { redactPhone } from './redact';
export { redactPhone } from './redact';

// ── Re-exported so every existing importer of this module keeps working ─────────────────
// `dispatchSms` and `recordSmsSend` moved to lib/sms/twilio-client.ts and lib/sms/send-log.ts in
// round 16 — see those files' headers for why. They are re-exported rather than left as a
// breaking change because this module is the documented I/O boundary for the weekly send, and
// there is no reason for its own callers to care that two functions changed file.
export {
  dispatchSms,
  twilioClient,
  TWILIO_ERROR_OPTED_OUT,
  type DispatchOutcome,
  type DispatchResult,
} from './twilio-client';
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

// ── Stubs: everything that touches the database or Twilio ───────────────────────────────

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
 * Every `active` subscriber the Friday job should consider. STUB.
 *
 * TODO:
 *   SELECT id, short_ref, phone_number, postal_code, birth_years, category_interests,
 *          consecutive_empty_weeks, preferences_token, consent_text_version
 *     FROM sms_consent
 *    WHERE status = 'active'
 *      AND phone_number IS NOT NULL      -- a purged row is not a subscriber (migration 0034)
 *    ORDER BY id
 *    [LIMIT $1]
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
    `SELECT id, short_ref, phone_number, postal_code, birth_years, category_interests,
            consecutive_empty_weeks, preferences_token, consent_text_version
       FROM sms_consent
      WHERE status = 'active'
        AND phone_number IS NOT NULL
      ORDER BY id
      ${typeof limit === 'number' && limit > 0 ? 'LIMIT $1' : ''}`,
    typeof limit === 'number' && limit > 0 ? [limit] : []
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
 * Occurrence ids this subscriber has already been sent, for the novelty filter. STUB.
 *
 * TODO:
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
export type RecentPickIdsLoader = (subscriberId: string) => Promise<Set<string>>;

export const loadRecentlySentPickIds: RecentPickIdsLoader = async (subscriberId) => {
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
 * Write back `consecutive_empty_weeks` and `status` after a week. STUB.
 *
 * TODO:
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
 * Mark a subscriber stopped because Twilio said they opted out at the carrier (21610). STUB.
 *
 * TODO:
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

// ── The per-subscriber unit ─────────────────────────────────────────────────────────────

export type SubscriberSendStatus =
  | 'sent'
  | 'dry_run'
  | 'empty'
  | 'paused'
  | 'stopped_via_carrier'
  | 'skipped_geocode_failed'
  | 'error';

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
  /** Never contains a number or a body. */
  error?: string;
}

export interface SendSubscriberOptions {
  /** Defaults to !smsSendingEnabled() — a real send requires opting in explicitly. */
  dryRun?: boolean;
  now?: Date;
  deps?: WeeklySmsDeps;
  /** Injected for tests; defaults to the stubbed loader above. */
  loadRecentPickIds?: RecentPickIdsLoader;
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
 * Build and (unless dry-run) send one subscriber's weekly text.
 *
 * The single testable unit; bulk simply loops it. NEVER THROWS — every failure path returns a
 * structured `SubscriberSendResult`, exactly as `sendWeeklyDigestForUser` does, so one
 * subscriber's bad row cannot take down a batch of five hundred.
 *
 * ── AN OPEN QUESTION THIS FUNCTION DOES NOT ANSWER: REPEAT PICKS ────────────────────────
 * The email digest sends only what is NEW since the last send (a watermark over
 * `activity_occurrence.created_at`). PRD §2.2's selection algorithm has no equivalent step: it
 * asks "what is on this weekend", and a weekly public swim is on every weekend. So a subscriber
 * can receive substantially the same picks several Fridays running — while §2.6's own empty-week
 * copy says "Nothing NEW matches your area this week", implying a newness notion the algorithm
 * does not have.
 *
 * NOT SILENTLY FIXED HERE, because inventing a novelty filter would change what the PRD
 * specifies. Flagged instead — and the schema already supports it: `sms_send_log.picks_snapshot`
 * exists precisely so a future run can read last week's occurrence ids and exclude or
 * de-prioritise them. If that becomes the decision, `loadActiveSubscribers` is where the previous
 * snapshot would join in, and `selectWeeklyPicks` would grow one `excludeOccurrenceIds` argument.
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
  // Copied from the subscriber's own row, never defaulted — see SmsSubscriber.consentTextVersion.
  const consentTextVersion = subscriber.consentTextVersion;

  try {
    const deps = options.deps ?? (await loadWeeklySmsDeps());
    const loadRecent = options.loadRecentPickIds ?? loadRecentlySentPickIds;

    // 0. What have they already been sent? PER SUBSCRIBER, so unlike the read model this cannot be
    //    hoisted into `WeeklySmsDeps` — but it IS one indexed read against rows they own, and a
    //    failure here must not cost them their week: an empty set means no novelty filtering,
    //    which degrades to the pre-v2.8 behaviour rather than to no send.
    let excludeOccurrenceIds: Set<string>;
    try {
      excludeOccurrenceIds = await loadRecent(subscriber.id);
    } catch {
      excludeOccurrenceIds = new Set();
    }

    // 1. Build. Pure — geocode, ages, selection, message. May throw only on a missing link secret.
    const plan: WeeklySmsPlan = buildWeeklySms({
      engine: deps.engine,
      now,
      subscriber,
      occurrenceShortRefs: deps.occurrenceShortRefs,
      excludeOccurrenceIds,
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
    };

    // 5. Dispatch.
    const dispatch = await send(phoneNumber, message, { dryRun });

    // 5a. The carrier says this number opted out. Independent of, and faster than, the inbound
    //     webhook mirror (PRD §2.2 step 6). Stop them now, log it, and do NOT apply the
    //     empty-week state — they are not paused, they are stopped.
    if (dispatch.outcome === 'stopped_via_carrier') {
      await bestEffort(() => markStopped(subscriber.id));
      await bestEffort(() =>
        log({
          subscriberId: subscriber.id,
          phoneNumber,
          sendType,
          outcome: 'stopped_via_carrier',
          picksSnapshot: null,
          twilioSid: dispatch.twilioSid,
          consentTextVersion,
        })
      );
      return { ...base, status: 'stopped_via_carrier' };
    }

    if (dispatch.outcome === 'failed') {
      // A failed dispatch changes nothing. The counter must not advance for a message that was
      // never delivered — otherwise a Twilio outage would pause subscribers three weeks later.
      await bestEffort(() =>
        log({
          subscriberId: subscriber.id,
          phoneNumber,
          sendType,
          outcome: 'failed',
          picksSnapshot: null,
          twilioSid: null,
          consentTextVersion,
        })
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
    await bestEffort(() =>
      log({
        subscriberId: subscriber.id,
        phoneNumber,
        sendType,
        outcome: sendType === 'weekly' ? 'sent' : sendType === 'pause_notice' ? 'paused' : 'empty',
        picksSnapshot: picksSnapshot(plan),
        twilioSid: dispatch.twilioSid,
        consentTextVersion,
      })
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
  /** Injected for tests; defaults to the stubbed loader. */
  loadRecentPickIds?: RecentPickIdsLoader;
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
      loadRecentPickIds: options.loadRecentPickIds,
      dispatch: options.dispatch,
      record: options.record,
      markStopped: options.markStopped,
      applyState: options.applyState,
    });
    counts[result.status] += 1;
    totalSegments += result.segments;
    results.push(result);
  }

  return { dryRun, candidates: subscribers.length, counts, totalSegments, results };
}
