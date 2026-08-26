// lib/sms/consent-transitions.ts — SCAFFOLD. The four inbound state transitions.
//
// DRAFT (SMS pivot). Every function here is a deliberate STUB: a real signature, a documented
// contract, and a TODO body. Drafting them as no-ops that report what they WOULD have done is
// the honest shape for a branch nobody is allowed to apply migrations for — the tables these
// would write to (sms_consent, sms_send_log) exist only as unapplied SQL in
// supabase/migrations/0034-0036, so a "working" implementation here would be code that has
// never once run against a schema that exists.
//
// WHAT EACH STUB STILL CARRIES, so filling them in is mechanical rather than archaeological:
// the exact status transition, the columns that must move with it, and the one non-obvious
// correctness note per transition. Read those before implementing.
//
// SHAPE TO FOLLOW WHEN IMPLEMENTING: lib/email/weekly.ts. Pure builder split from I/O
// orchestrator, structured result objects instead of thrown exceptions, and dry-run by default
// so an unconfigured environment can never mutate real consent state. Every function below
// already returns a structured result and already accepts the dry-run flag for that reason.

import { smsSendingEnabled } from './config';

export type TransitionOutcome =
  | 'applied'
  | 'dry_run'
  | 'no_such_subscriber'
  | 'already_in_state'
  | 'error';

export interface TransitionResult {
  outcome: TransitionOutcome;
  /** E.164 number the transition was requested for. Never logged in full — see the route. */
  phoneNumber: string;
  /** Populated once implemented; null while stubbed or when no subscriber matched. */
  subscriberId: string | null;
  error?: string;
}

export interface TransitionOptions {
  /** Defaults to !smsSendingEnabled() — a real mutation requires opting in explicitly. */
  dryRun?: boolean;
  now?: Date;
}

function stub(phoneNumber: string, options: TransitionOptions): TransitionResult {
  const dryRun = options.dryRun ?? !smsSendingEnabled();
  return { outcome: dryRun ? 'dry_run' : 'error', phoneNumber, subscriberId: null, error: dryRun ? undefined : 'not implemented (draft scaffold)' };
}

/**
 * JOIN — the CASL express-consent confirmation. OURS, not Twilio's.
 *
 * TODO: UPDATE sms_consent SET status = 'active', confirmed_timestamp = now(), stopped_at = NULL
 *       WHERE phone_number = $1 AND status IN ('pending','stopped','paused').
 *
 * NON-OBVIOUS PART — this is a REACTIVATION, not always a fresh confirmation. sms_consent has a
 * UNIQUE index on phone_number (0034), and a parent who stopped inside the 30-day retention
 * window still owns that row. A JOIN from them must revive the existing row — clearing
 * stopped_at and re-stamping consent_timestamp and consent_text_version with TODAY's wording —
 * rather than INSERTing a second one, which would fail the constraint anyway. Consent is per
 * number, not per row, so re-consent has to be recorded against the number's one row.
 *
 * ALSO: a JOIN from a number with no row at all is not an error to swallow. It means either a
 * purged pending signup (90-day rule) or someone texting JOIN cold. Return
 * 'no_such_subscriber' and let the route reply with the signup link — do NOT create an active
 * subscription from an inbound text alone, because we would then hold no record of what consent
 * language they ever saw, and consent_text_version is NOT NULL for exactly that reason.
 */
export async function confirmSubscriber(
  phoneNumber: string,
  options: TransitionOptions = {}
): Promise<TransitionResult> {
  return stub(phoneNumber, options);
}

/**
 * STOP (and CANCEL/END/QUIT/UNSUBSCRIBE) — mirror Twilio's suppression into our DB.
 *
 * TODO: UPDATE sms_consent SET status = 'stopped', stopped_at = now() WHERE phone_number = $1.
 *
 * NON-OBVIOUS PART — Twilio has ALREADY suppressed the number by the time this runs, and it has
 * already sent the confirmation reply. This write is not what stops the messages; it is what
 * stops our Friday job from selecting a subscriber whose sends will now bounce, and it is what
 * starts the 30-day purge clock (0034's CHECK enforces that a 'stopped' row has a stopped_at,
 * precisely so a missed timestamp here cannot silently exempt a row from the retention promise).
 * A row already 'stopped' is 'already_in_state' — do NOT re-stamp stopped_at, or every repeat
 * STOP would push the purge deadline out.
 */
export async function mirrorCarrierStop(
  phoneNumber: string,
  options: TransitionOptions = {}
): Promise<TransitionResult> {
  return stub(phoneNumber, options);
}

/**
 * START / UNSTOP / YES — mirror Twilio un-suppressing the number.
 *
 * TODO: UPDATE sms_consent SET status = 'active', stopped_at = NULL WHERE phone_number = $1
 *       AND status IN ('stopped','paused').
 *
 * NON-OBVIOUS PART, AND THE ONE MOST LIKELY TO BE GOT WRONG. Twilio treats START as "resume
 * delivery"; CASL treats it as express consent only if there is still a consent record behind
 * it. Those come apart when the 30-day purge has already run: the row's phone_number is NULL,
 * so this UPDATE matches nothing, and un-suppressing at the carrier does not give us back the
 * postal code, ages and interests the weekly send needs. Correct handling is
 * 'no_such_subscriber' plus a reply pointing at the signup form — resuming a subscription we
 * can no longer personalise would send an empty weekly text forever.
 */
export async function mirrorCarrierStart(
  phoneNumber: string,
  options: TransitionOptions = {}
): Promise<TransitionResult> {
  return stub(phoneNumber, options);
}

/**
 * HELP / INFO — Twilio answers this itself with the configured help text.
 *
 * TODO: record the inbound in sms_send_log (send_type is send-side, so this likely wants its
 *       own inbound log or an explicit decision NOT to log it) and change no status.
 *
 * NON-OBVIOUS PART: there is no state change here AT ALL, and that is the point of the stub
 * existing rather than the route silently doing nothing. HELP is the request a confused or
 * annoyed recipient sends immediately before STOP, so the useful thing is that it is
 * observable. Whether it belongs in sms_send_log (which 0035 defines as a record of what WE
 * sent) or in a separate inbound log is an open question this scaffold does not decide.
 */
export async function recordHelpRequest(
  phoneNumber: string,
  options: TransitionOptions = {}
): Promise<TransitionResult> {
  return stub(phoneNumber, options);
}
