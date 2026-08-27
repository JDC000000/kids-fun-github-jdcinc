// lib/sms/consent-transitions.ts — the four inbound state transitions (JOIN / STOP / START / HELP).
//
// DRAFT (SMS pivot). The tables these read and write — `sms_consent` (migration 0034) — exist
// only as unapplied SQL, and this branch holds no write credentials. So the DATABASE is stubbed
// and everything else is real: each transition performs a genuine lookup through an injected
// seam, runs a PURE decision function against the row it finds, and hands a fully-formed change
// to a stubbed applier that carries the exact UPDATE it will issue.
//
// That split is the point. Same posture as lib/sms/weekly-send-io.ts's stubs, and the same
// injection idiom `selectWeeklyPicks` uses for `sameParentOrg`: the DECISIONS are unit-testable
// today against every row state, and filling in the two seams is mechanical rather than an
// archaeology project.
//
//   decide*(row)        pure, total, exhaustively tested — the WHERE clause as a function
//   ConsentChange       the SET clause as data, so "do not re-stamp stopped_at" is expressible
//   findByPhone         STUB — one SELECT, injected for tests
//   applyChange         STUB — one UPDATE, injected for tests
//
// ── THE PURGE IS WHY `no_such_subscriber` FALLS OUT RATHER THAN NEEDING A SPECIAL CASE ──
// The lookup's WHERE clause is `phone_number = $1`. Migration 0034's 30-day post-stop purge NULLs
// `phone_number` in place, so a purged row is INVISIBLE to this lookup by construction. A START
// from a number whose row was purged therefore returns null and classifies as
// `no_such_subscriber` — not because anything checks for a purge, but because there is genuinely
// nothing left to find under that number. Same for a JOIN after the 90-day pending purge.
//
// ── SAFETY ──────────────────────────────────────────────────────────────────────────────
// `dryRun` defaults to `!smsSendingEnabled()`, so an unconfigured environment can never mutate
// consent state. It displaces ONLY `applied` — see `runTransition` for why the read-only
// outcomes are reported as themselves even in a dry run.

import { smsSendingEnabled } from './config';

/** `sms_consent.status` (migration 0034). */
export type ConsentStatus = 'pending' | 'active' | 'paused' | 'stopped';

/**
 * The `sms_consent` columns a transition decision needs. Deliberately the minimum: no phone
 * number, no postal code, no birth years. A decision function that cannot see personal data
 * cannot leak it into a result object or a log line.
 */
export interface ConsentRow {
  id: string;
  status: ConsentStatus;
  /** Null unless the subscriber has stopped. The 30-day purge clock keys off this. */
  stoppedAt: Date | null;
}

export type TransitionOutcome =
  /** A change was decided and written. */
  | 'applied'
  /** A change was decided and NOT written, because sending/writing is disabled. */
  | 'dry_run'
  /** No `sms_consent` row holds this number — never signed up, or purged. */
  | 'no_such_subscriber'
  /** The row is already in the state this transition targets. Nothing to write. */
  | 'already_in_state'
  /**
   * ADDED BEYOND THE ORIGINAL FIVE, deliberately — see `decideStart`. A `pending` row receiving
   * START is a real fourth case that the documented UPDATE matches zero rows for, and it is not
   * any of the others: the row EXISTS (so not `no_such_subscriber`) and it is NOT in the state
   * START targets (so not `already_in_state`). Collapsing it into either would make the webhook
   * reply with the wrong thing — "sign up here" or nothing, when the right answer is "reply JOIN
   * to confirm".
   */
  | 'awaiting_confirmation'
  /**
   * ADDED BEYOND THE ORIGINAL FIVE — see `recordHelpRequest`. HELP has no state to transition
   * and, per the recommendation recorded there, nothing to write either. `already_in_state`
   * would be a mislabel: there is no target state to already be in.
   */
  | 'no_change'
  /** The lookup or the write failed. Never contains the number or any personal data. */
  | 'error';

/**
 * What to write. The SET clause as data.
 *
 * `stoppedAt` is a three-way enum rather than a `Date | null`, and that is the whole reason this
 * type exists: "leave it alone" is a DIFFERENT instruction from "set it to null", and the
 * difference is the repeat-STOP bug. A `Date | null` field cannot express "do not touch", so a
 * second STOP would re-stamp `stopped_at` and push the 30-day purge deadline out every time.
 */
export interface ConsentChange {
  subscriberId: string;
  status: ConsentStatus;
  /**
   * The status this change was DECIDED AGAINST — the value `findByPhone` returned a moment ago.
   *
   * ═══ THIS IS THE COMPARE-AND-SET, AND IT IS WHY THE WRITE IS IDEMPOTENT ═══
   * Every transition is read-then-write: `decide*` looks at a row and returns a change. Between
   * those two steps another copy of the same inbound message can do the same thing. The UPDATE
   * used to be `WHERE id = $1` with no predicate on what was read, so BOTH passes wrote and BOTH
   * reported `applied` — and `applied` is what the inbound route keys the welcome text off.
   * Two welcome texts for one JOIN.
   *
   * NOT JOIN-SPECIFIC, which is the reason this lives on the shared type rather than in one
   * decision. `confirmSubscriber`, `mirrorCarrierStop` and `mirrorCarrierStart` all funnel through
   * `runTransition` and this same applier. STOP and START are silent today only because nothing
   * reacts to their `applied` outcome; the race is live on the shared path regardless, and would
   * resurface the first time any caller did react to one.
   *
   * CARRIES THE STATUS THAT WAS READ, not a list of acceptable ones. Each decision already
   * narrowed to exactly one row in exactly one state, so the tightest possible predicate is
   * available for free — and a per-decision list is a second thing to keep in step with the
   * decision itself.
   */
  expectedStatus: ConsentStatus;
  /** 'set' → stamp now(). 'clear' → NULL it. 'leave' → do not touch the column at all. */
  stoppedAt: 'set' | 'clear' | 'leave';
  /** Re-stamp `consent_timestamp` + `consent_text_version` with today's wording. JOIN only. */
  reconsent: boolean;
  /** Stamp `confirmed_timestamp`. JOIN only — it records the double-opt-in reply. */
  confirm: boolean;
}

/** A decision, before any I/O. Pure and total over `ConsentRow | null`. */
export type TransitionDecision =
  | { outcome: 'no_such_subscriber' }
  | { outcome: 'already_in_state'; subscriberId: string }
  | { outcome: 'awaiting_confirmation'; subscriberId: string }
  | { outcome: 'no_change'; subscriberId: string | null }
  | { outcome: 'applied'; subscriberId: string; change: ConsentChange };

export interface TransitionResult {
  outcome: TransitionOutcome;
  /** E.164 number the transition was requested for. Never logged in full — see the route. */
  phoneNumber: string;
  /** The matched row, when one was found. Null when nothing matched. */
  subscriberId: string | null;
  /**
   * The change that was (or in a dry run, would have been) written. Null for every outcome that
   * writes nothing. Reported so a dry run says what it WOULD do rather than merely that it did
   * nothing.
   */
  change: ConsentChange | null;
  /** Never contains the number or any personal data. */
  error?: string;
}

/** One SELECT: the `sms_consent` row holding this number, or null. */
export type SubscriberLookup = (phoneNumber: string) => Promise<ConsentRow | null>;
/**
 * What one UPDATE did.
 *
 * 'applied'  — the row was still in `change.expectedStatus` and was written.
 * 'no_match' — it was not. Somebody else moved it between the read and the write, so this pass
 *              lost the race and must NOT report `applied`. Not an error: the intended end state
 *              has been reached, just not by us.
 */
export type ConsentWriteOutcome = 'applied' | 'no_match';

/**
 * One UPDATE. Reports whether it matched a row; a failure throws and is caught by
 * `runTransition`.
 *
 * REPORTING ROWS-AFFECTED IS THE WHOLE POINT — see `ConsentChange.expectedStatus`. A
 * `Promise<void>` applier cannot express "the compare-and-set failed", so the caller has no way
 * to tell a real transition from a lost race.
 */
export type ConsentChangeApplier = (
  change: ConsentChange,
  now: Date
) => Promise<ConsentWriteOutcome>;

export interface TransitionDeps {
  findByPhone?: SubscriberLookup;
  applyChange?: ConsentChangeApplier;
}

export interface TransitionOptions extends TransitionDeps {
  /** Defaults to !smsSendingEnabled() — a real mutation requires opting in explicitly. */
  dryRun?: boolean;
  now?: Date;
}

// ── The two stubbed seams ───────────────────────────────────────────────────────────────

/**
 * Find the `sms_consent` row for a number. STUB.
 *
 * TODO:
 *   SELECT id, status, stopped_at
 *     FROM sms_consent
 *    WHERE phone_number = $1
 *
 * The number is normalised to E.164 before it ever reaches here (lib/sms/signup-validate.ts
 * mints it that way and migration 0034's CHECK enforces it), so this is an equality match against
 * the UNIQUE index — no normalisation, no LIKE, at most one row.
 *
 * A PURGED ROW IS INVISIBLE HERE, BY CONSTRUCTION, and that is load-bearing rather than
 * incidental: the 30-day purge sets `phone_number = NULL`, so this WHERE clause cannot match it.
 * Every "after the purge" case in the decisions below resolves to null through this function
 * without anything having to test for a purge.
 */
export const findSubscriberByPhone: SubscriberLookup = async () => {
  // Draft scaffold: sms_consent is unapplied SQL and this branch holds no read credentials.
  return null;
};

/**
 * Write one decided change. STUB.
 *
 * TODO — built from the change, so each clause is present only when it should be:
 *
 *   UPDATE sms_consent
 *      SET status = $2
 *        , stopped_at = now()            -- only when change.stoppedAt === 'set'
 *        , stopped_at = NULL             -- only when change.stoppedAt === 'clear'
 *                                        -- OMITTED ENTIRELY when 'leave'
 *        , consent_timestamp = now()     -- only when change.reconsent
 *        , consent_text_version = $3     -- only when change.reconsent (today's wording)
 *        , confirmed_timestamp = now()   -- only when change.confirm
 *        , consecutive_empty_weeks = 0   -- only when change.reconsent (a fresh start)
 *    WHERE id = $1
 *      AND status = $4                   -- change.expectedStatus. THE COMPARE-AND-SET.
 *   RETURNING id;                        -- zero rows => 'no_match'
 *
 * `AND status = $4` IS NOT OPTIONAL AND IS NOT AN OPTIMISATION. Without it two concurrent copies
 * of the same inbound webhook both write and both report `applied`, and `applied` is what the
 * inbound route keys the welcome text off — see `ConsentChange.expectedStatus`. Its two sibling
 * writes have always carried a guard of this shape (`applyEmptyWeekState` has
 * `AND status = 'active'`, `markStoppedViaCarrier` uses `COALESCE(stopped_at, now())`); this one
 * did not, and its own comment explained the `WHERE id` choice on PII grounds without noticing
 * that it had given up idempotency along the way.
 *
 * RETURN 'no_match' WHEN THE UPDATE AFFECTS ZERO ROWS. `pg` exposes this as `result.rowCount`.
 *
 * KEYED ON id, NOT ON THE PHONE NUMBER. The lookup already resolved the number to exactly one
 * row; re-matching on the number here would mean a second place that has to get the purge
 * semantics right, and would hold the number one layer deeper than it needs to be.
 *
 * The service pool writes this (`sms_consent` is default-deny RLS, service-role only — 0034).
 */
export const applyConsentChange: ConsentChangeApplier = async () => {
  // Draft scaffold: sms_consent is unapplied SQL and this branch holds no write credentials.
  // Reports 'applied' so the scaffold behaves as though the compare-and-set succeeded, which is
  // the case a caller must handle correctly anyway.
  return 'applied';
};

// ── The pure decisions ──────────────────────────────────────────────────────────────────

/**
 * JOIN — the CASL express-consent confirmation. OURS, not Twilio's.
 *
 * Mirrors `WHERE phone_number = $1 AND status IN ('pending','stopped','paused')`.
 *
 * THIS IS A REACTIVATION, NOT ALWAYS A FRESH CONFIRMATION. `sms_consent` has a UNIQUE index on
 * phone_number (0034), and a parent who stopped inside the 30-day retention window still owns
 * that row. A JOIN from them REVIVES it — clearing `stopped_at`, re-stamping `consent_timestamp`
 * and `consent_text_version` with today's wording, resetting the empty-week counter — rather than
 * inserting a second row, which would fail the constraint anyway. Consent is per NUMBER, not per
 * row, so re-consent has to be recorded against the number's one row. That is what
 * `reconsent: true` plus `stoppedAt: 'clear'` says.
 *
 * A JOIN FROM A NUMBER WITH NO ROW IS NOT AN ERROR TO SWALLOW. It means a purged pending signup
 * (the 90-day rule) or someone texting JOIN cold. `no_such_subscriber`, and the route replies
 * with the signup link — we must NOT create an active subscription from an inbound text alone,
 * because we would then hold no record of what consent language they ever saw, and
 * `consent_text_version` is NOT NULL for exactly that reason.
 */
export function decideConfirm(row: ConsentRow | null): TransitionDecision {
  if (!row) return { outcome: 'no_such_subscriber' };
  if (row.status === 'active') return { outcome: 'already_in_state', subscriberId: row.id };
  return {
    outcome: 'applied',
    subscriberId: row.id,
    change: {
      subscriberId: row.id,
      expectedStatus: row.status,
      status: 'active',
      stoppedAt: 'clear',
      reconsent: true,
      confirm: true,
    },
  };
}

/**
 * STOP (and CANCEL/END/QUIT/UNSUBSCRIBE) — mirror Twilio's suppression into our database.
 *
 * Mirrors `WHERE phone_number = $1`, with the already-stopped case classified rather than
 * written.
 *
 * TWILIO HAS ALREADY SUPPRESSED THE NUMBER by the time this runs, and has already sent the
 * standard reply. This write is not what stops the messages. It is what stops the Friday job from
 * selecting a subscriber whose sends will now bounce, and it is what starts the 30-day purge
 * clock — 0034's CHECK enforces that a 'stopped' row has a `stopped_at`, precisely so a missed
 * timestamp here cannot silently exempt a row from the retention promise.
 *
 * A ROW ALREADY 'stopped' IS `already_in_state` AND WRITES NOTHING. Re-stamping `stopped_at`
 * would push the purge deadline out on every repeat STOP — and repeat STOPs are normal, because
 * a number that has opted out at the carrier can still have STOP texted at it again. `stoppedAt:
 * 'leave'` does not even appear on this path, because the path returns before there is a change
 * to make.
 */
export function decideStop(row: ConsentRow | null): TransitionDecision {
  if (!row) return { outcome: 'no_such_subscriber' };
  if (row.status === 'stopped') return { outcome: 'already_in_state', subscriberId: row.id };
  return {
    outcome: 'applied',
    subscriberId: row.id,
    change: {
      subscriberId: row.id,
      expectedStatus: row.status,
      status: 'stopped',
      stoppedAt: 'set',
      reconsent: false,
      confirm: false,
    },
  };
}

/**
 * START / UNSTOP / YES — mirror Twilio un-suppressing the number.
 *
 * Mirrors `WHERE phone_number = $1 AND status IN ('stopped','paused')`.
 *
 * THE CASE MOST LIKELY TO BE GOT WRONG. Twilio treats START as "resume delivery"; CASL treats it
 * as express consent only if there is still a consent record behind it. Those come apart once the
 * 30-day purge has run: the row's `phone_number` is NULL, so the lookup finds nothing, and
 * un-suppressing at the carrier does not give us back the postal code, ages and interests the
 * weekly send needs. `no_such_subscriber`, and the route replies with the signup form — resuming
 * a subscription we can no longer personalise would text an empty week forever.
 *
 * THE FOURTH CASE THE ORIGINAL COMMENT DID NOT NAME: a `pending` row. Someone submitted the form,
 * never replied JOIN, and now texts START. The documented UPDATE matches zero rows — correctly,
 * because START IS NOT THE DOUBLE OPT-IN. Activating here would bypass the CASL confirmation
 * entirely, which is the one thing this product's consent design exists to prevent. But it is
 * also not `no_such_subscriber` (the row is right there) and not `already_in_state` (pending is
 * not what START targets), and the webhook's reply differs in all three cases. Hence
 * `awaiting_confirmation`: nothing is written, and the route can say "reply JOIN to confirm".
 */
export function decideStart(row: ConsentRow | null): TransitionDecision {
  if (!row) return { outcome: 'no_such_subscriber' };
  if (row.status === 'active') return { outcome: 'already_in_state', subscriberId: row.id };
  if (row.status === 'pending') return { outcome: 'awaiting_confirmation', subscriberId: row.id };
  return {
    outcome: 'applied',
    subscriberId: row.id,
    change: {
      subscriberId: row.id,
      expectedStatus: row.status,
      status: 'active',
      stoppedAt: 'clear',
      // NOT a re-consent. START is a carrier resume signal, not a fresh express-consent event, so
      // it must not re-stamp consent_timestamp/consent_text_version — that would record a consent
      // act that never happened, in the columns an audit reads.
      reconsent: false,
      confirm: false,
    },
  };
}

// ── The I/O wrapper ─────────────────────────────────────────────────────────────────────

async function runTransition(
  phoneNumber: string,
  decide: (row: ConsentRow | null) => TransitionDecision,
  options: TransitionOptions
): Promise<TransitionResult> {
  const dryRun = options.dryRun ?? !smsSendingEnabled();
  const findByPhone = options.findByPhone ?? findSubscriberByPhone;
  const applyChange = options.applyChange ?? applyConsentChange;
  const now = options.now ?? new Date();

  let row: ConsentRow | null;
  try {
    row = await findByPhone(phoneNumber);
  } catch (err) {
    return {
      outcome: 'error',
      phoneNumber,
      subscriberId: null,
      change: null,
      error: `lookup failed: ${(err as Error)?.message ?? 'unknown error'}`,
    };
  }

  const decision = decide(row);

  // THE READ-ONLY OUTCOMES ARE REPORTED AS THEMSELVES, EVEN IN A DRY RUN. `dry_run` means "we
  // decided a change and did not write it", so it displaces only `applied`. Masking
  // `no_such_subscriber` or `already_in_state` behind it would make a dry run useless for the
  // thing a dry run is for — finding out what would happen — and those two are facts about the
  // database that are true whether or not writing is enabled.
  if (decision.outcome !== 'applied') {
    return {
      outcome: decision.outcome,
      phoneNumber,
      subscriberId: 'subscriberId' in decision ? decision.subscriberId : null,
      change: null,
    };
  }

  if (dryRun) {
    return {
      outcome: 'dry_run',
      phoneNumber,
      subscriberId: decision.subscriberId,
      change: decision.change,
    };
  }

  let written: ConsentWriteOutcome;
  try {
    written = await applyChange(decision.change, now);
  } catch (err) {
    return {
      outcome: 'error',
      phoneNumber,
      subscriberId: decision.subscriberId,
      change: decision.change,
      error: `write failed: ${(err as Error)?.message ?? 'unknown error'}`,
    };
  }

  // THE COMPARE-AND-SET LOST. Another copy of this same inbound message moved the row between our
  // read and our write, so the end state has been reached — by them, not by us. Reporting
  // `already_in_state` is both true and the outcome every caller already handles as "do nothing
  // further": it is exactly what a SEQUENTIAL repeat produces, and a concurrent repeat is the
  // same event arriving twice. `change` is returned as null for the same reason it is on every
  // other non-applied outcome — we wrote nothing.
  if (written === 'no_match') {
    return {
      outcome: 'already_in_state',
      phoneNumber,
      subscriberId: decision.subscriberId,
      change: null,
    };
  }

  return {
    outcome: 'applied',
    phoneNumber,
    subscriberId: decision.subscriberId,
    change: decision.change,
  };
}

/** JOIN — see `decideConfirm`. */
export async function confirmSubscriber(
  phoneNumber: string,
  options: TransitionOptions = {}
): Promise<TransitionResult> {
  return runTransition(phoneNumber, decideConfirm, options);
}

/** STOP and its carrier aliases — see `decideStop`. */
export async function mirrorCarrierStop(
  phoneNumber: string,
  options: TransitionOptions = {}
): Promise<TransitionResult> {
  return runTransition(phoneNumber, decideStop, options);
}

/** START / UNSTOP / YES — see `decideStart`. */
export async function mirrorCarrierStart(
  phoneNumber: string,
  options: TransitionOptions = {}
): Promise<TransitionResult> {
  return runTransition(phoneNumber, decideStart, options);
}

/**
 * HELP / INFO — a true no-op. No lookup, no write, no state change.
 *
 * ═══ RECOMMENDATION, IMPLEMENTED: DO NOT LOG HELP FOR MVP ═══
 *
 * The open question this stub used to carry was whether an inbound HELP belongs in
 * `sms_send_log`, in a new inbound log, or nowhere. Four reasons it is nowhere:
 *
 *   1. `sms_send_log` IS THE WRONG TABLE AND 0035 SAYS SO. Every column is send-side —
 *      `send_type` has no inbound member, `outcome`'s values are send outcomes, and
 *      `picks_snapshot` / `twilio_sid` / `consent_text_version` describe a message WE composed.
 *      Writing an inbound event there means either abusing a send_type or adding one, and it
 *      weakens the table's stated meaning, which is what the CASL argument in that migration's
 *      header rests on.
 *   2. A SEPARATE INBOUND LOG IS REAL SURFACE FOR NO CONSUMER. A migration, its RLS, its
 *      retention rule and its purge — for a signal PRD §6 lists no metric against. MVP measures
 *      growth, CTR and churn; HELP volume is in none of them.
 *   3. TWILIO ALREADY KEEPS IT. Every inbound message is in the Twilio console with full
 *      history, searchable, without us storing anything. At MVP volume that IS the
 *      observability, and it is the same place the Operator already goes to check delivery.
 *   4. DATA MINIMISATION. §1.2's whole posture is holding the minimum that makes the product
 *      work. Storing inbound message events we have no use for cuts directly against it.
 *
 * WHAT WOULD CHANGE THIS: a V1 metric that needs HELP volume correlated with churn — "how many
 * people ask for help immediately before they STOP" is a genuinely interesting question and the
 * one plausible reason to build the inbound log. That is a product decision with a real cost, and
 * it belongs in V1 scope rather than being pre-built here.
 *
 * The status quo is therefore preserved deliberately: Twilio sends the configured help text, our
 * database is untouched, and this returns `no_change` so the route can tell "handled, nothing to
 * do" apart from "we did not recognise that".
 */
export async function recordHelpRequest(
  phoneNumber: string,
  _options: TransitionOptions = {}
): Promise<TransitionResult> {
  return { outcome: 'no_change', phoneNumber, subscriberId: null, change: null };
}
