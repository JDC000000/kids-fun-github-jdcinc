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
// STUB: `loadActiveSubscribers`, `dispatchSms`, `recordSmsSend`, `applyEmptyWeekState` and
// `markStoppedViaCarrier`. `sms_consent` and `sms_send_log` exist only as unapplied SQL
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
import type { RenderedMessage } from './message';

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
export async function loadActiveSubscribers(_limit?: number): Promise<ActiveSubscriber[]> {
  // Draft scaffold: sms_consent is unapplied SQL and this branch holds no write credentials.
  return [];
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

export const loadRecentlySentPickIds: RecentPickIdsLoader = async () => {
  // Draft scaffold: sms_send_log is unapplied SQL and this branch holds no read credentials.
  return new Set<string>();
};

export type DispatchOutcome = 'sent' | 'dry_run' | 'stopped_via_carrier' | 'failed';

export interface DispatchResult {
  outcome: DispatchOutcome;
  twilioSid: string | null;
  /** Twilio's numeric error code, when it gave one. Kept for the 21610 branch and the log. */
  errorCode: number | null;
  /** Safe to log — never contains the number or the body. */
  error?: string;
}

/**
 * Twilio error code for "the recipient has opted out at the carrier level".
 *
 * PRD §2.2 step 6 makes this a SEND-TIME SAFEGUARD independent of the inbound webhook: if the
 * STOP webhook was missed or is late, this is how we find out — at the moment we try to text
 * someone who has told the carrier not to hear from us. It is the second of two independent
 * paths into `status = 'stopped'`, and the faster one.
 */
export const TWILIO_ERROR_OPTED_OUT = 21610;

/**
 * Send one message. STUB.
 *
 * TODO: POST https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json with
 *   MessagingServiceSid = TWILIO_MESSAGING_SERVICE_SID, To = the E.164 number, Body = the
 *   rendered body, and a StatusCallback pointing at the delivery-status route. Basic auth with
 *   TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN (lib/sms/config.ts — never logged, never returned).
 *
 * ON `dryRun` IT MUST RETURN WITHOUT DISPATCHING, and it must still return the same result shape,
 * so the whole pipeline is verifiable end-to-end with zero real messages — the posture
 * lib/email/resend.ts takes with its payload.
 *
 * ERROR MAPPING, the one part that is not boilerplate: a 21610 response is NOT a failure to
 * retry. It is the carrier telling us this number has opted out, and the correct handling is to
 * mark the subscriber stopped immediately (see TWILIO_ERROR_OPTED_OUT) rather than to log a
 * failed send and try again next Friday. Every other error code is a genuine 'failed'.
 *
 * NOTHING THIS FUNCTION RETURNS MAY CONTAIN THE NUMBER OR THE BODY — see the file header.
 */
export async function dispatchSms(
  _phoneNumber: string,
  _message: RenderedMessage,
  options: { dryRun: boolean }
): Promise<DispatchResult> {
  if (options.dryRun) return { outcome: 'dry_run', twilioSid: null, errorCode: null };
  return {
    outcome: 'failed',
    twilioSid: null,
    errorCode: null,
    error: 'not implemented (draft scaffold)',
  };
}

export type SendLogOutcome = 'sent' | 'empty' | 'paused' | 'stopped_via_carrier' | 'failed';
export type SendLogType = 'confirm_request' | 'welcome' | 'weekly' | 'empty_week' | 'pause_notice';

export interface RecordSendInput {
  subscriberId: string;
  sendType: SendLogType;
  outcome: SendLogOutcome;
  picksSnapshot: Array<{ occurrence_id: string; rank: number }> | null;
  twilioSid: string | null;
  consentTextVersion: string;
}

/**
 * Append one `sms_send_log` row — the per-subscriber watermark AND the CASL audit trail. STUB.
 *
 * TODO:
 *   INSERT INTO sms_send_log
 *     (subscriber_id, phone_hash, phone_hash_version, send_type, picks_snapshot,
 *      outcome, twilio_sid, consent_text_version)
 *   VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
 *
 * GET THESE FOUR RIGHT — a future implementation copies this shape verbatim:
 *
 *   phone_hash          NOT NULL on EVERY row, including rows whose subscriber still exists.
 *                       Populating it only after a purge would leave the pre-purge history
 *                       unsearchable by number, which is the only way anyone will ever search it
 *                       (migration 0035). Salted with SMS_PHONE_HASH_SALT.
 *   phone_hash_version  The salt generation that produced it. Without it, rotating the salt
 *                       silently makes every historical hash unmatchable, with no error anywhere.
 *   picks_snapshot      Weekly sends ONLY — migration 0035 has a CHECK enforcing it, so passing
 *                       an array on an 'empty_week' row fails the insert. `picksSnapshot()`
 *                       already returns null for every non-'picks' plan.
 *   consent_text_version  The wording in force AT SEND TIME, COPIED not joined. A join would
 *                       report today's wording for a message sent under last year's, which is
 *                       precisely the fact an audit is asking about.
 *
 * DRY RUNS DO NOT REACH HERE AT ALL. `weekly_email_send` carries a `dry_run` column and records
 * both; this table has no such column by design (migration 0035 defines it as a record of
 * messages that were SENT), so the orchestrator simply does not call this on a dry run. Same net
 * effect as the email job's watermark rule — a verification run never moves real state.
 */
export async function recordSmsSend(_input: RecordSendInput): Promise<void> {
  // Draft scaffold: sms_send_log is unapplied SQL.
}

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
  _subscriberId: string,
  _state: EmptyWeekState
): Promise<void> {
  // Draft scaffold: sms_consent is unapplied SQL.
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
export async function markStoppedViaCarrier(_subscriberId: string): Promise<void> {
  // Draft scaffold: sms_consent is unapplied SQL.
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
}

/** Last four digits only. The one shape in which a number may appear in an operational message. */
export function redactPhone(phone: string): string {
  return phone.length <= 4 ? '****' : `****${phone.slice(-4)}`;
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
    const dispatch = await dispatchSms(phoneNumber, message, { dryRun });

    // 5a. The carrier says this number opted out. Independent of, and faster than, the inbound
    //     webhook mirror (PRD §2.2 step 6). Stop them now, log it, and do NOT apply the
    //     empty-week state — they are not paused, they are stopped.
    if (dispatch.outcome === 'stopped_via_carrier') {
      await markStoppedViaCarrier(subscriber.id);
      await recordSmsSend({
        subscriberId: subscriber.id,
        sendType,
        outcome: 'stopped_via_carrier',
        picksSnapshot: null,
        twilioSid: dispatch.twilioSid,
        consentTextVersion,
      });
      return { ...base, status: 'stopped_via_carrier' };
    }

    if (dispatch.outcome === 'failed') {
      // A failed dispatch changes nothing. The counter must not advance for a message that was
      // never delivered — otherwise a Twilio outage would pause subscribers three weeks later.
      await recordSmsSend({
        subscriberId: subscriber.id,
        sendType,
        outcome: 'failed',
        picksSnapshot: null,
        twilioSid: null,
        consentTextVersion,
      });
      return { ...base, status: 'error', error: dispatch.error ?? 'dispatch failed' };
    }

    // 5b. DRY RUN: everything above is real, nothing below happens. No audit row, no counter
    //     move — the same rule the email job applies to its watermark.
    if (dispatch.outcome === 'dry_run') {
      return { ...base, status: 'dry_run' };
    }

    // 6. A real send. Record the audit row and apply the state TOGETHER — a subscriber must never
    //    be paused for a week they were not texted about, nor texted without the log saying so.
    await recordSmsSend({
      subscriberId: subscriber.id,
      sendType,
      outcome: sendType === 'weekly' ? 'sent' : sendType === 'pause_notice' ? 'paused' : 'empty',
      picksSnapshot: picksSnapshot(plan),
      twilioSid: dispatch.twilioSid,
      consentTextVersion,
    });
    await applyEmptyWeekState(subscriber.id, state);

    if (state.pausedNow) return { ...base, status: 'paused' };
    return { ...base, status: plan.outcome === 'picks' ? 'sent' : 'empty' };
  } catch (err) {
    // Never let the message or the number reach an error string.
    return {
      subscriberId: subscriber.id,
      status: 'error',
      pickCount: 0,
      segments: 0,
      error: (err as Error)?.message ?? 'unknown error',
    };
  }
}

// ── Bulk ────────────────────────────────────────────────────────────────────────────────

export interface BulkOptions {
  now?: Date;
  dryRun?: boolean;
  /** Cap the number of candidate subscribers (safety for a first live run). */
  limit?: number;
  /** Injected for tests; defaults to the stubbed loader. */
  loadRecentPickIds?: RecentPickIdsLoader;
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
  const deps = await loadWeeklySmsDeps();
  const subscribers = await loadActiveSubscribers(options.limit);

  const counts = emptyCounts();
  const results: SubscriberSendResult[] = [];
  let totalSegments = 0;

  for (const { subscriber, phoneNumber } of subscribers) {
    const result = await sendWeeklySmsForSubscriber(subscriber, phoneNumber, {
      now,
      dryRun,
      deps,
      loadRecentPickIds: options.loadRecentPickIds,
    });
    counts[result.status] += 1;
    totalSegments += result.segments;
    results.push(result);
  }

  return { dryRun, candidates: subscribers.length, counts, totalSegments, results };
}
