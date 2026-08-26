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

import { smsSendingEnabled } from './config';
import type { SmsSignup } from './signup-validate';

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
 * ALSO TODO: mint `preferences_token` (HMAC over the new row's id with SMS_PREFERENCES_SECRET —
 * see lib/sms/config.ts) and write one `sms_send_log` row for the confirmation request, with
 * send_type = 'confirm_request', phone_hash + phone_hash_version, and the consent_text_version
 * this signup agreed to.
 */
export async function createPendingSubscriber(
  signup: SmsSignup,
  options: SignupWriteOptions = {}
): Promise<SignupWriteResult> {
  const dryRun = options.dryRun ?? !smsSendingEnabled();
  if (dryRun) return { outcome: 'dry_run', subscriberId: null };
  return { outcome: 'error', subscriberId: null, error: 'not implemented (draft scaffold)' };
}

export type ConfirmationSendOutcome = 'sent' | 'dry_run' | 'error';

export interface ConfirmationSendResult {
  outcome: ConfirmationSendOutcome;
  twilioSid: string | null;
  error?: string;
}

/**
 * Send the one confirmation text (PRD §1.4, §2.1, §2.6).
 *
 * TODO: POST to the Twilio Messages API using TWILIO_MESSAGING_SERVICE_SID, with the §2.6 body:
 *
 *   KIDS FUN: Reply JOIN to confirm weekly kid activity picks for {area}.
 *   Msg&data rates may apply. Reply STOP to opt out anytime.
 *
 * JOIN, NOT YES — this is the one detail here that is not obvious and not negotiable. Twilio's
 * Advanced Opt-Out treats YES (with START and UNSTOP) as a carrier-level resubscribe keyword and
 * can intercept the reply before our webhook ever sees it, which would leave a subscriber who
 * did everything right sitting at `pending` forever. See lib/sms/keywords.ts.
 *
 * EXACTLY ONE MESSAGE. This is a wrong-number and express-consent check, not a drip: a second
 * "did you get our text?" text to a number that has not consented is itself the CASL problem the
 * confirmation exists to avoid. PRD §2.1 puts the reminder in V1, gated on real drop-off data.
 *
 * FAILURE IS NOT A FAILED SIGNUP. The row is already written and already pending; a Twilio error
 * here means the confirmation did not arrive, which the parent can resolve by resubmitting the
 * form or texting START. The route must not tell them the signup failed — see its own comment.
 */
export async function sendConfirmationRequest(
  signup: SmsSignup,
  options: SignupWriteOptions = {}
): Promise<ConfirmationSendResult> {
  const dryRun = options.dryRun ?? !smsSendingEnabled();
  if (dryRun) return { outcome: 'dry_run', twilioSid: null };
  return { outcome: 'error', twilioSid: null, error: 'not implemented (draft scaffold)' };
}
