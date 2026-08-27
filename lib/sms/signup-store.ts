// lib/sms/signup-store.ts — SCAFFOLD. Persisting a signup, and asking for confirmation.
//
// DRAFT (SMS pivot). Both functions here are deliberate STUBS: a real signature, a documented
// contract, the exact SQL/payload they will issue, and a TODO body. Same posture as
// lib/sms/consent-transitions.ts, and for the same two reasons — the `sms_consent` table exists
// only as UNAPPLIED SQL in supabase/migrations/0034, and nobody on this branch holds write
// credentials for any database. A "working" implementation would be code that has never once run
// against a schema that exists.
//
// WHAT IS REAL ALREADY: the validated `SmsSignup` (lib/sms/signup-validate.ts) is exactly the
// column set of one pending `sms_consent` row, so filling these in is mechanical rather than
// archaeological. Read the SQL in each TODO before implementing — the non-obvious parts are
// written out.

import { query } from '@/lib/db/client';
import { areaLabelForPostal } from '@/lib/geo/postal-fsa';
import { smsSendingEnabled } from './config';
import { renderConfirmRequestMessage } from './message';
import { mintPreferencesToken } from './preferences-token';
import { redactPhone } from './redact';
import type { SmsSignup } from './signup-validate';
import { dispatchSms, type DispatchResult } from './twilio-client';
import { recordSmsSend } from './send-log';

export type SignupWriteOutcome =
  | 'created'
  | 'reactivated'
  | 'dry_run'
  | 'error';

export interface SignupWriteResult {
  outcome: SignupWriteOutcome;
  /** Populated once implemented. Never returned to the browser — see the route. */
  subscriberId: string | null;
  error?: string;
}

export interface SignupWriteOptions {
  /** Defaults to !smsSendingEnabled() — a real write requires opting in explicitly. */
  dryRun?: boolean;
  now?: Date;
  /** Injected for tests; defaults to the shared pool in lib/db/client.ts. */
  query?: typeof query;
}

/**
 * Create (or revive) the pending `sms_consent` row for one signup.
 *
 * TODO: an UPSERT, not an INSERT:
 *
 *   INSERT INTO sms_consent
 *     (phone_number, postal_code, birth_years, category_interests,
 *      status, consent_method, consent_timestamp, consent_text_version, preferences_token)
 *   VALUES ($1, $2, $3, $4, 'pending', $5, now(), $6, $7)
 *   ON CONFLICT (phone_number) DO UPDATE SET
 *     postal_code          = EXCLUDED.postal_code,
 *     birth_years          = EXCLUDED.birth_years,
 *     category_interests   = EXCLUDED.category_interests,
 *     status               = 'pending',
 *     consent_method       = EXCLUDED.consent_method,
 *     consent_timestamp    = now(),
 *     consent_text_version = EXCLUDED.consent_text_version,
 *     confirmed_timestamp  = NULL,
 *     stopped_at           = NULL,
 *     consecutive_empty_weeks = 0
 *   RETURNING id, short_ref;
 *
 * WHY AN UPSERT — the part that is easy to get wrong. `sms_consent` has a UNIQUE index on
 * phone_number (migration 0034), so a plain INSERT raises 23505 for anyone who has submitted
 * this form before: a parent correcting a typo in their postal code, a stopped subscriber
 * signing up again, or someone who simply tapped submit twice. All three are legitimate and none
 * is an error a form should show. Consent is per NUMBER, not per row.
 *
 * RE-STAMPING consent_timestamp AND consent_text_version IS THE POINT, not incidental. This is a
 * fresh act of express consent against whatever wording is on the page today, and the CASL record
 * must say so. Clearing confirmed_timestamp and stopped_at, and resetting the empty-week counter,
 * put the row back at the start of the lifecycle — a resubmission means they have to reply JOIN
 * again, which is correct: re-consent that skipped the double opt-in would not be double opt-in.
 *
 * WHAT MUST NOT HAPPEN HERE: this must never write `status = 'active'`. Only a JOIN reply may do
 * that (lib/sms/consent-transitions.ts), because the whole value of the double opt-in is that
 * nobody can subscribe a phone number they do not hold.
 *
 * ALSO TODO: mint `preferences_token` — an HMAC over the new row's id with SMS_PREFERENCES_SECRET
 * (see lib/sms/config.ts).
 *
 * THE `sms_send_log` ROW FOR THE CONFIRMATION REQUEST IS NOT WRITTEN HERE. An earlier draft of
 * this comment listed it as part of this function's job, which would have produced TWO audit rows
 * for one message once both halves were implemented: `sendConfirmationRequest` below now writes
 * it, on the send it actually performed and with that send's real outcome. A row written here
 * could only ever have claimed 'sent' before anything was sent.
 */
export async function createPendingSubscriber(
  signup: SmsSignup,
  options: SignupWriteOptions = {}
): Promise<SignupWriteResult> {
  const dryRun = options.dryRun ?? !smsSendingEnabled();
  if (dryRun) return { outcome: 'dry_run', subscriberId: null };

  const run = options.query ?? query;

  try {
    // ONE STATEMENT. The upsert and the "was this new?" answer come back together, because doing
    // it as a SELECT-then-INSERT would race two simultaneous submissions of the same number
    // straight into the UNIQUE index — which is exactly the collision the upsert exists to absorb.
    //
    // `xmax = 0` IS THE STANDARD POSTGRES TRICK for "did this row come from the INSERT or the
    // UPDATE branch". On a freshly inserted tuple the xmax system column is 0; on one updated by
    // ON CONFLICT it carries the updating transaction. It is not pretty and it is not in the
    // documentation as an API, but the alternative — a second round trip, or a RETURNING that
    // cannot tell the branches apart — is worse. Asserted directly in the db-lane test.
    const rows = await run<{ id: string; short_ref: string | number; inserted: boolean }>(
      `INSERT INTO sms_consent
         (phone_number, postal_code, birth_years, category_interests,
          status, consent_method, consent_timestamp, consent_text_version)
       VALUES ($1, $2, $3, $4, 'pending', $5, now(), $6)
       ON CONFLICT (phone_number) DO UPDATE SET
         postal_code             = EXCLUDED.postal_code,
         birth_years             = EXCLUDED.birth_years,
         category_interests      = EXCLUDED.category_interests,
         status                  = 'pending',
         consent_method          = EXCLUDED.consent_method,
         consent_timestamp       = now(),
         consent_text_version    = EXCLUDED.consent_text_version,
         confirmed_timestamp     = NULL,
         stopped_at              = NULL,
         consecutive_empty_weeks = 0
       RETURNING id, short_ref, (xmax = 0) AS inserted`,
      [
        signup.phoneNumber,
        signup.postalCode,
        signup.birthYears,
        signup.categoryInterests,
        signup.consentMethod,
        signup.consentTextVersion,
      ]
    );

    const row = rows[0];
    if (!row) {
      // Unreachable with this statement — an upsert always returns its row. Handled rather than
      // asserted, because a silent undefined here would become a confident `subscriberId: null`.
      return { outcome: 'error', subscriberId: null, error: 'upsert returned no row' };
    }

    // ── The preferences token, minted from the id the database just assigned ──
    // SECOND STATEMENT, and it has to be: the token is an HMAC over the row id, and the id does
    // not exist until the insert has run. Generating a uuid client-side to get one round trip
    // would break the upsert — on the conflict branch the row keeps its ORIGINAL id, so a token
    // computed from a locally-invented one would be wrong for the row it landed on.
    //
    // `WHERE preferences_token IS NULL` so a returning subscriber KEEPS THE LINK THEY HAVE. Their
    // old messages still carry it, and re-minting would silently break every one of them.
    const token = mintPreferencesToken(row.id);
    if (token) {
      await run(
        `UPDATE sms_consent SET preferences_token = $2
          WHERE id = $1 AND preferences_token IS NULL`,
        [row.id, token]
      );
    }

    return {
      outcome: row.inserted ? 'created' : 'reactivated',
      subscriberId: row.id,
    };
  } catch (err) {
    // NEVER LET THE NUMBER REACH THE ERROR STRING. Postgres echoes the offending values back on a
    // constraint violation — `Key (phone_number)=(+1604...) already exists` — and this result is
    // returned to a route that reports failures. Same discipline as lib/sms/weekly-send-io.ts.
    return {
      outcome: 'error',
      subscriberId: null,
      error: `write failed: ${redactSqlError(err, signup.phoneNumber)}`,
    };
  }
}

/**
 * A database error, with the subscriber's number taken out of it.
 *
 * Postgres constraint violations quote the offending value: a UNIQUE violation on
 * `phone_number` produces `Key (phone_number)=(+16045550123) already exists`. That string reaches
 * a route's error handling and, from there, a log line.
 *
 * BOTH the code and a scrubbed message, because the code alone is often not enough to act on and
 * the message alone is not safe. The scrub matches the exact E.164 string we hold — a backstop,
 * named as one, exactly like `scrubNumber` in lib/sms/weekly-send-io.ts.
 */
function redactSqlError(err: unknown, phoneNumber: string): string {
  const code = (err as { code?: string })?.code;
  const raw = (err as Error)?.message ?? 'unknown error';
  const scrubbed =
    phoneNumber && raw.includes(phoneNumber)
      ? raw.split(phoneNumber).join(redactPhone(phoneNumber))
      : raw;
  return code ? `[${code}] ${scrubbed}` : scrubbed;
}

export type ConfirmationSendOutcome = 'sent' | 'dry_run' | 'error';

export interface ConfirmationSendResult {
  outcome: ConfirmationSendOutcome;
  twilioSid: string | null;
  /** Segment count of the message that was built, for cost visibility. Populated on a dry run. */
  segments: number;
  /**
   * Twilio's numeric code when it gave one.
   *
   * Surfaced rather than folded into `error` because ONE of these codes means something the
   * generic failure path does not: 21610 is the carrier telling us this number has opted out.
   * See the note on `sendConfirmationRequest`.
   */
  errorCode: number | null;
  /** Never contains the number or the body. */
  error?: string;
}

export interface ConfirmationSendOptions extends SignupWriteOptions {
  /**
   * The id `createPendingSubscriber` just returned, for the audit row.
   *
   * NULLABLE, and legitimately so in exactly two cases: a dry run (which writes no row and needs
   * no id) and this draft scaffold (whose store stub returns null). Once the store is implemented
   * a real `created`/`reactivated` write always carries one, and a failed write never reaches
   * here — the route 503s first.
   */
  subscriberId?: string | null;
  /** Injected for tests; defaults to the shared Twilio seam in weekly-send-io. */
  dispatch?: typeof dispatchSms;
  /** Injected for tests; defaults to the shared send-log writer in weekly-send-io. */
  record?: typeof recordSmsSend;
}

/**
 * Send the one confirmation text (PRD §1.4, §2.1, §2.6).
 *
 * ── WHAT IS REAL HERE, AND WHAT IS STILL A STUB ─────────────────────────────────────────
 * THE MESSAGE IS REAL. `renderConfirmRequestMessage` produces §2.6's approved copy, goes through
 * the same GSM-7 wall as every other template (tests/sms/weekly_send.test.ts), and is built on
 * EVERY path including a dry run — so a verification run in an unconfigured environment renders
 * and costs the exact message a live run would send, and dispatches none of it. Until now this
 * body existed only as the comment below, which is precisely how a message escapes the encoding
 * guard: round 11 found a real bug in that guard by implementing a template against it.
 *
 * STILL STUBS: `dispatchSms` and `recordSmsSend`, shared with the weekly path
 * (lib/sms/weekly-send-io.ts). Same posture as everything else outbound on this branch — Twilio
 * has no credential here and `sms_send_log` is unapplied SQL in migration 0035.
 *
 * ── THE ONE DETAIL THAT IS NOT BOILERPLATE ──────────────────────────────────────────────
 * JOIN, NOT YES. Twilio's Advanced Opt-Out treats YES (with START and UNSTOP) as a carrier-level
 * resubscribe keyword and can intercept the reply before our webhook ever sees it, which would
 * leave a subscriber who did everything right sitting at `pending` forever. See
 * lib/sms/keywords.ts, and `renderConfirmRequestMessage` for the copy itself.
 *
 * EXACTLY ONE MESSAGE. This is a wrong-number and express-consent check, not a drip: a second
 * "did you get our text?" text to a number that has not consented is itself the CASL problem the
 * confirmation exists to avoid. PRD §2.1 puts the reminder in V1, gated on real drop-off data.
 *
 * FAILURE IS NOT A FAILED SIGNUP. The row is already written and already pending; a Twilio error
 * here means the confirmation did not arrive, which the parent can resolve by resubmitting the
 * form or texting START. The route must not tell them the signup failed — see its own comment.
 *
 * ── A 21610 HERE MEANS SOMETHING THE ROUTE CANNOT FIX, AND SHOULD BE READ ───────────────
 * On the weekly path, Twilio error 21610 means an active subscriber opted out at the carrier and
 * we mark them stopped. On THIS path it means something else: the number signing up has ALREADY
 * blocked our sender, so the confirmation text is undeliverable and always will be until they
 * text START or UNSTOP to us themselves — which nothing on the form tells them to do, and which
 * we cannot do on their behalf. The form will say "check your phone" and no message will ever
 * arrive. This function reports the code (`errorCode`) rather than flattening it into a generic
 * failure so that case is at least visible; the product answer to it is flagged, not invented.
 *
 * ── AND SO THIS PATH DELIBERATELY DOES **NOT** CALL `markStoppedViaCarrier` ──────────────
 * Stated outright rather than left to be inferred from the paragraph above. The weekly path and
 * the JOIN welcome both DO call it on a 21610 (round 17 fixed `welcome.ts` for exactly that), so
 * the omission here looks like the same bug and is not one:
 *
 *   • THE ROW IS `pending`, NOT `active`. It was created moments ago by this signup and has never
 *     been confirmed. `loadActiveSubscribers` selects `WHERE status = 'active'`, so nothing will
 *     text this number again on its own — the repeated-rejection failure that makes the weekly
 *     path's write necessary cannot happen here.
 *   • MARKING THEM STOPPED WOULD START THE PURGE CLOCK ON A SIGNUP THEY JUST MADE. `status =
 *     'stopped'` stamps `stopped_at`, and migration 0034's 30-day purge keys off it. So we would
 *     begin deleting the postal code and children's ages a parent gave us thirty seconds earlier,
 *     with express consent, because of a CARRIER state they can clear themselves by texting START.
 *   • IT WOULD ALSO OVERWRITE A FRESH CASL CONSENT RECORD with a status that says the opposite of
 *     what just happened. They did not opt out. They opted IN, to a number that was already
 *     blocked.
 *
 * The honest end state is a `pending` row that never confirms and is purged after 90 days — which
 * is exactly what the schema already does for any signup that never replies JOIN.
 *
 * NEVER THROWS, and nothing it returns carries the number or the body.
 */
export async function sendConfirmationRequest(
  signup: SmsSignup,
  options: ConfirmationSendOptions = {}
): Promise<ConfirmationSendResult> {
  const dryRun = options.dryRun ?? !smsSendingEnabled();
  const send = options.dispatch ?? dispatchSms;
  const log = options.record ?? recordSmsSend;

  // The area is resolved through `areaLabelForPostal` — the SAME resolver the welcome text uses
  // (lib/sms/welcome.ts) and the same FSA table the weekly send geocodes against. One postal code
  // must not be able to produce two different area names in two consecutive messages, which is
  // exactly what a second lookup here would eventually do. Note that `signup.regionId` already
  // holds the resolved municipality; going back through the postal code keeps this call identical
  // to the welcome text's, and tests/sms/confirm_request.test.ts pins that the two agree.
  const message = renderConfirmRequestMessage(areaLabelForPostal(signup.postalCode));

  let dispatched: DispatchResult;
  try {
    dispatched = await send(signup.phoneNumber, message, { dryRun });
  } catch (err) {
    return {
      outcome: 'error',
      twilioSid: null,
      segments: message.segments,
      errorCode: null,
      error: `dispatch threw: ${(err as Error)?.message ?? 'unknown error'}`,
    };
  }

  // A dry run stops here — nothing dispatched, nothing recorded. `sms_send_log` is a record of
  // messages that were SENT (migration 0035 has no `dry_run` column, by design), so a staging
  // run must not leave a CASL audit row claiming a parent was texted.
  if (dispatched.outcome === 'dry_run') {
    return { outcome: 'dry_run', twilioSid: null, segments: message.segments, errorCode: null };
  }

  const failed = dispatched.outcome !== 'sent';

  // The audit row for the FIRST message, which is the one a CASL complaint is most likely to be
  // about: it went to a number that had not yet confirmed. Written with the outcome that actually
  // happened, including a failed attempt — "we tried and Twilio refused" is a materially different
  // answer from "no record", and only one of them is true.
  if (options.subscriberId) {
    try {
      await log({
        subscriberId: options.subscriberId,
        sendType: 'confirm_request',
        outcome:
          dispatched.outcome === 'stopped_via_carrier'
            ? 'stopped_via_carrier'
            : failed
              ? 'failed'
              : 'sent',
        // Weekly sends only — migration 0035's CHECK rejects a snapshot on any other send_type.
        picksSnapshot: null,
        twilioSid: dispatched.twilioSid,
        // The wording THEY agreed to, carried on the validated signup. Copied, never joined.
        consentTextVersion: signup.consentTextVersion,
      });
    } catch {
      // The message may already have gone. Losing the audit row is bad; turning it into a failed
      // signup, after the consent row was written and the text was sent, would be worse.
    }
  }

  if (failed) {
    return {
      outcome: 'error',
      twilioSid: dispatched.twilioSid,
      segments: message.segments,
      errorCode: dispatched.errorCode,
      error: dispatched.error ?? `dispatch outcome: ${dispatched.outcome}`,
    };
  }
  return {
    outcome: 'sent',
    twilioSid: dispatched.twilioSid,
    segments: message.segments,
    errorCode: null,
  };
}
