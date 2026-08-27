// lib/sms/welcome.ts — the one static welcome text, sent when JOIN confirms a subscription.
//
// DRAFT (SMS pivot). PRD §2.1, one sentence, both halves: "JOIN reply (tolerant match) → status =
// active, confirmed_timestamp set → same send path immediately fires one static welcome text (no
// live matching logic — just confirms signup and sets expectations for Friday)."
//
// The first half was built in round 5 (`confirmSubscriber`). This is the second half.
//
// ═══════════════════════════════════════════════════════════════════════════════════════════
// WHY THIS IS A SEPARATE STEP AND NOT PART OF `confirmSubscriber`
// ═══════════════════════════════════════════════════════════════════════════════════════════
//
// Not merely for consistency with the other three transitions — there is a hard reason.
//
// `ConsentRow`, the type `confirmSubscriber` decides against, is `{ id, status, stoppedAt }`, and
// its own doc says why: "Deliberately the minimum: no phone number, no postal code, no birth
// years. A decision function that cannot see personal data cannot leak it into a result object or
// a log line."
//
// The welcome text needs a phone number to send to, a postal code to name the area, birth years to
// name the ages, and a preferences token for the link. **Every one of those is a field
// `ConsentRow` deliberately excludes.** Putting the send inside `confirmSubscriber` would mean
// widening that type with exactly the four things it was defined to keep out, and the round-5
// property — that a consent DECISION cannot leak personal data — would be gone.
//
// So the decision layer stays PII-free and this step does its own read. The route calls it only on
// the `applied` branch of a JOIN, which is the one outcome that means "a subscription just became
// active". `already_in_state` (they were already active), `awaiting_confirmation`,
// `no_such_subscriber` and `error` must all send nothing, and the route's own guard is what
// enforces that.
//
// ONE OTHER THING THE SPLIT BUYS: re-texting somebody who was already active is the exact failure
// this ordering prevents. A JOIN from an active subscriber is a normal event — a parent replying
// twice, a carrier redelivering — and it must be silent.

import { query } from '@/lib/db/client';
import { areaLabelForPostal } from '@/lib/geo/postal-fsa';
import { preferencesUrl as buildPreferencesUrl } from './config';
import { renderWelcomeMessage, type RenderedMessage } from './message';
import { agesFromBirthYears } from './signup-validate';
import { dispatchSms, type DispatchResult } from './twilio-client';
import { recordSmsSend } from './send-log';
import { markStoppedViaCarrier } from './weekly-send-io';
import { smsSendingEnabled } from './config';

/**
 * The `sms_consent` columns the welcome text needs — i.e. precisely the ones `ConsentRow` refuses
 * to carry. Read here, at send time, and never handed back to the decision layer.
 */
export interface WelcomeSubscriber {
  id: string;
  /** E.164. The only field on this row that is a phone number; never returned or logged. */
  phoneNumber: string;
  postalCode: string | null;
  birthYears: number[] | null;
  preferencesToken: string;
  /** Copied verbatim onto the audit row — the wording in force when they consented. */
  consentTextVersion: string;
}

/**
 * Load what the welcome text needs.
 *
 * KEYED ON id, NOT ON THE PHONE NUMBER, even though the inbound webhook only ever had a number to
 * start with. `confirmSubscriber` already resolved that number to exactly one row and returns its
 * id; re-matching on the number here would be a second place that has to get migration 0034's
 * purge semantics right, and would hold the number one layer deeper than it needs to be.
 *
 * NO `status = 'active'` CLAUSE. The status was just set by the transition this is reacting to,
 * and re-asserting it here would introduce a race with nothing to gain: if a STOP landed in
 * between, the honest outcome is that we send a welcome to somebody who has since opted out — one
 * message, in a window of milliseconds — rather than that a real confirmation silently produces no
 * welcome at all. The guard that matters (only send on `applied`) is at the call site.
 */
export type WelcomeSubscriberLookup = (subscriberId: string) => Promise<WelcomeSubscriber | null>;

export const loadWelcomeSubscriber: WelcomeSubscriberLookup = async (subscriberId) => {
  const rows = await query<{
    id: string;
    phone_number: string | null;
    postal_code: string | null;
    birth_years: number[] | null;
    preferences_token: string | null;
    consent_text_version: string;
  }>(
    `SELECT id, phone_number, postal_code, birth_years, preferences_token, consent_text_version
       FROM sms_consent
      WHERE id = $1`,
    [subscriberId]
  );
  const row = rows[0];
  if (!row) return null;

  // NO PHONE NUMBER MEANS NO WELCOME. Migration 0034's 30-day purge NULLs the personal columns in
  // place rather than deleting the row, so a purged subscriber still HAS a row — and `dispatchSms`
  // would be handed `null` as a recipient. The type says `phoneNumber: string`, so this is the
  // line that keeps that true. Reported as "no such subscriber" because that is what it means to
  // this caller: there is nobody left here to welcome.
  if (!row.phone_number) return null;

  return {
    id: row.id,
    phoneNumber: row.phone_number,
    postalCode: row.postal_code,
    birthYears: row.birth_years,
    // A row written before the token was minted, or minted with no secret configured. The welcome
    // still sends; `renderWelcomeMessage` would print a broken link, so the caller gets an empty
    // string and the message degrades rather than lying about where to manage a subscription.
    preferencesToken: row.preferences_token ?? '',
    consentTextVersion: row.consent_text_version,
  };
};

export type WelcomeOutcome =
  /** Rendered and dispatched, and an `sms_send_log` row written. */
  | 'sent'
  /** Rendered and NOT dispatched, because sending is disabled. Nothing written. */
  | 'dry_run'
  /** The subscriber row could not be read. Nothing sent. */
  | 'no_such_subscriber'
  /** Twilio (or the read) failed. Logged as a failed attempt; never retried here. */
  | 'failed';

export interface WelcomeResult {
  outcome: WelcomeOutcome;
  subscriberId: string;
  /** Segment count of the message that was built, for cost visibility. 0 when nothing was built. */
  segments: number;
  /** Never contains the number or the body. */
  error?: string;
}

export interface WelcomeOptions {
  /** Defaults to !smsSendingEnabled() — a real send requires opting in explicitly. */
  dryRun?: boolean;
  now?: Date;
  /** Injected for tests; defaults to the real loader above. */
  loadSubscriber?: WelcomeSubscriberLookup;
  /** Injected for tests; defaults to the shared Twilio seam in weekly-send-io. */
  dispatch?: typeof dispatchSms;
  /** Injected for tests; defaults to the shared send-log writer in weekly-send-io. */
  record?: typeof recordSmsSend;
  /** Injected for tests; defaults to the shared carrier-opt-out writer in weekly-send-io. */
  markStopped?: typeof markStoppedViaCarrier;
}

/**
 * Build and (unless dry-run) send one subscriber's welcome text.
 *
 * NEVER THROWS. A welcome that fails must not turn a successful JOIN into a webhook error — the
 * subscription is already active and that is the part that matters. Twilio would retry a non-2xx
 * response, which would replay the whole inbound message; a swallowed welcome failure costs one
 * message, a replayed webhook costs a duplicated transition.
 *
 * REUSES THE SHARED SEAMS. `dispatchSms` and `recordSmsSend` come from lib/sms/weekly-send-io.ts
 * rather than being reimplemented: one Twilio call site, one `sms_send_log` writer, one place that
 * knows the columns. `SendLogType` already listed `'welcome'` — this is the first caller to use it.
 *
 * DRY RUNS WRITE NOTHING, exactly as on the weekly path: `sms_send_log` is a record of messages
 * that were SENT (migration 0035 has no `dry_run` column, deliberately), so a verification run in
 * an unconfigured environment builds the message and stops.
 */
export async function sendWelcomeText(
  subscriberId: string,
  options: WelcomeOptions = {}
): Promise<WelcomeResult> {
  const dryRun = options.dryRun ?? !smsSendingEnabled();
  const now = options.now ?? new Date();
  const load = options.loadSubscriber ?? loadWelcomeSubscriber;
  const send = options.dispatch ?? dispatchSms;
  const log = options.record ?? recordSmsSend;
  const markStopped = options.markStopped ?? markStoppedViaCarrier;

  let subscriber: WelcomeSubscriber | null;
  try {
    subscriber = await load(subscriberId);
  } catch (err) {
    return {
      outcome: 'failed',
      subscriberId,
      segments: 0,
      error: `lookup failed: ${(err as Error)?.message ?? 'unknown error'}`,
    };
  }
  if (!subscriber) return { outcome: 'no_such_subscriber', subscriberId, segments: 0 };

  // Pure from here to the dispatch. The area label reuses the SAME resolver the weekly send does
  // (lib/geo/postal-fsa) rather than a second one, so the area named in the welcome is the area
  // the picker will actually search. The ages reuse the conversion that lives beside its own
  // inverse, so what they are shown is what was stored.
  const message: RenderedMessage = renderWelcomeMessage({
    areaLabel: areaLabelForPostal(subscriber.postalCode),
    childAges: agesFromBirthYears(subscriber.birthYears, now),
    preferencesUrl: buildPreferencesUrl(subscriber.preferencesToken),
  });

  let dispatched: DispatchResult;
  try {
    dispatched = await send(subscriber.phoneNumber, message, { dryRun });
  } catch (err) {
    return {
      outcome: 'failed',
      subscriberId,
      segments: message.segments,
      error: `dispatch threw: ${(err as Error)?.message ?? 'unknown error'}`,
    };
  }

  // A dry run stops here — nothing dispatched, nothing recorded.
  if (dispatched.outcome === 'dry_run') {
    return { outcome: 'dry_run', subscriberId, segments: message.segments };
  }

  const failed = dispatched.outcome !== 'sent';

  // ── A CARRIER OPT-OUT MUST CHANGE THE SUBSCRIBER'S STATE, NOT JUST THE LOG ──────────────
  // Twilio error 21610 means this number has told the carrier not to hear from us. Logging the
  // outcome and leaving `sms_consent.status` at 'active' would record that we know they opted out
  // and then keep the Friday job selecting them every week — building a message, getting it
  // rejected, and writing an audit trail that says we kept trying to text somebody who had opted
  // out. PRD §2.2 step 6 makes this a send-time safeguard INDEPENDENT of the inbound webhook, and
  // "independent" means every send path has to honour it, not just the weekly one.
  //
  // This was missing here while lib/sms/weekly-send-io.ts did it correctly one branch over, and it
  // was dormant only for as long as `markStoppedViaCarrier` was a stub with no live database. That
  // seam is now real, so this branch is live: without it, a JOIN from a carrier-suppressed number
  // would leave them 'active' forever while the identical Twilio code on a weekly send stopped them
  // properly.
  //
  // BEFORE the log write, matching weekly-send-io's ordering: the state change is the part that
  // protects the subscriber, and the audit row is the part that records it.
  if (dispatched.outcome === 'stopped_via_carrier') {
    try {
      await markStopped(subscriber.id);
    } catch {
      // Best-effort, like everything else on this path. The 21610 is still logged below, so the
      // fact is not lost even when the write is.
    }
  }

  try {
    await log({
      subscriberId: subscriber.id,
      phoneNumber: subscriber.phoneNumber,
      sendType: 'welcome',
      // A carrier-level opt-out at this exact moment is vanishingly unlikely (they just texted
      // JOIN) but it is still a real Twilio outcome, so it is mapped rather than assumed away.
      outcome:
        dispatched.outcome === 'stopped_via_carrier' ? 'stopped_via_carrier' : failed ? 'failed' : 'sent',
      // Weekly sends only — migration 0035's CHECK rejects a snapshot on any other send_type.
      picksSnapshot: null,
      twilioSid: dispatched.twilioSid,
      consentTextVersion: subscriber.consentTextVersion,
    });
  } catch {
    // The message may already have gone. Losing the audit row is bad and is not worth converting
    // into a webhook error that Twilio would retry — see this function's header.
  }

  if (failed) {
    return {
      outcome: 'failed',
      subscriberId,
      segments: message.segments,
      error: dispatched.error ?? `dispatch outcome: ${dispatched.outcome}`,
    };
  }
  return { outcome: 'sent', subscriberId, segments: message.segments };
}
