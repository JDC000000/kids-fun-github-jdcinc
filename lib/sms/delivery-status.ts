// lib/sms/delivery-status.ts — what Twilio tells us happened to a message we sent.
//
// DRAFT (SMS pivot). The other end of the loop lib/sms/twilio-client.ts opens: `dispatchSms`
// hands Twilio a `StatusCallback` URL, and Twilio POSTs back here each time the message changes
// state. app/api/sms/status/route.ts is the thin transport; this holds the parsing and the
// decision, so both are testable without a request.
//
// ── WHY THIS EXISTS NOW AND NOT BEFORE ──────────────────────────────────────────────────
// It was deliberately deferred as "scaffolding on top of scaffolding": there was no real send to
// report a status FROM, so a callback route would have been a webhook for messages that could not
// exist. Round 16 made the dispatch real, and the `StatusCallback` parameter it now sends needs
// somewhere to land.
//
// ── WHAT IT UPDATES, AND WHAT IT DELIBERATELY DOES NOT ──────────────────────────────────
// It writes `sms_send_log.delivery_status` and NOTHING else. Migration 0035's own header already
// settled this: a row is written when we dispatch, "then again when Twilio's status-callback
// webhook reports the carrier's final verdict. That is a late-arriving fact about the same
// message, not a rewrite of history."
//
// So `outcome` is NOT touched. `outcome = 'sent'` records that WE sent it and is the CASL fact —
// what we did, when, under which consent wording. `delivery_status = 'undelivered'` records what
// the carrier then did with it. Collapsing the second into the first would destroy the first: an
// audit asking "did you text this person on this date" would start getting "no" for messages we
// demonstrably sent.
//
// ── IT ALSO DOES NOT STOP ANYONE ────────────────────────────────────────────────────────
// A delivery failure is not an opt-out. Phones are off, numbers get reassigned, carriers drop
// messages. The two paths into `status = 'stopped'` stay exactly the two PRD §2.2 step 6
// specifies: the inbound STOP webhook, and a 21610 at send time. A third path that guessed from
// undelivered receipts would unsubscribe people who never asked to be — and a `30003` (unreachable
// handset) is the most common delivery failure there is.

import { query } from '@/lib/db/client';
import { verifyTwilioSignature } from './twilio-signature';
import { statusCallbackUrl, twilioAuthToken } from './config';

/**
 * `MessageStatus` values Twilio sends. Transcribed from the SDK's own `MessageStatus` union
 * (node_modules/twilio/lib/rest/api/v2010/account/message.d.ts), not from memory.
 *
 * NOT AN ALLOWLIST THAT REJECTS. Twilio's documentation for this callback warns that the
 * properties "vary by messaging channel and event type and are subject to change" and that it
 * "occasionally adds new properties without advance notice". An unknown status is therefore
 * recorded as-is rather than dropped: `sms_send_log.delivery_status` is a plain text column with
 * no CHECK (0035), precisely so a new Twilio state does not become a failed write.
 */
export const KNOWN_DELIVERY_STATUSES: ReadonlySet<string> = new Set([
  'accepted', 'scheduled', 'queued', 'sending', 'sent', 'receiving', 'received',
  'delivered', 'read', 'undelivered', 'failed', 'partially_delivered', 'canceled',
]);

/** Statuses that mean the carrier is done and it did not arrive. */
export const FAILED_DELIVERY_STATUSES: ReadonlySet<string> = new Set([
  'undelivered',
  'failed',
  'canceled',
]);

export interface DeliveryStatusReport {
  /** `MessageSid` — matches `sms_send_log.twilio_sid`, which 0035 indexes for exactly this. */
  twilioSid: string;
  /** `MessageStatus`, recorded verbatim. */
  status: string;
  /** `ErrorCode`, present when the status is failed or undelivered. */
  errorCode: number | null;
}

export type DeliveryStatusOutcome =
  /** Verified, parsed, and the update was applied. */
  | 'applied'
  /** Verified and parsed, but nothing was written because writing is disabled. */
  | 'dry_run'
  /** The signature did not verify, or the environment is unconfigured. Nothing was read. */
  | 'unverified'
  /** Verified but missing `MessageSid` or `MessageStatus`. Nothing to record. */
  | 'malformed'
  /** The write failed. */
  | 'error';

export interface DeliveryStatusResult {
  outcome: DeliveryStatusOutcome;
  report: DeliveryStatusReport | null;
  /** Never contains a phone number or a message body. */
  error?: string;
}

/**
 * Pull the report out of a verified callback body.
 *
 * `MessageSid` FIRST, `SmsSid` AS A FALLBACK. Twilio's own example payload carries both, with
 * identical values — `SmsSid` is the legacy alias. Reading the modern name first and accepting
 * the old one costs one `??` and means a channel that only sends one of them still works.
 *
 * AN UNPARSEABLE `ErrorCode` BECOMES NULL RATHER THAN NaN. It is absent on every successful
 * status, so "not a number" is the normal case, not an exceptional one.
 */
export function parseDeliveryStatus(params: URLSearchParams): DeliveryStatusReport | null {
  const twilioSid = (params.get('MessageSid') ?? params.get('SmsSid') ?? '').trim();
  const status = (params.get('MessageStatus') ?? params.get('SmsStatus') ?? '').trim();
  if (!twilioSid || !status) return null;
  const rawCode = Number(params.get('ErrorCode'));
  return {
    twilioSid,
    status,
    errorCode: Number.isFinite(rawCode) && rawCode !== 0 ? rawCode : null,
  };
}

/**
 * Record the carrier's verdict against the send row.
 *
 * The seam, so the route is testable without a database. The single implementation below is
 * `applyDeliveryStatus`, and it carries the reasoning for the query it issues.
 */
export type DeliveryStatusWriter = (report: DeliveryStatusReport) => Promise<void>;

export const applyDeliveryStatus: DeliveryStatusWriter = async (report) => {
  // ONLY `delivery_status`. Not `outcome` — see this file's header: `outcome` is the CASL record of
  // what WE did, and the callback is a later fact about what the carrier then did with it.
  //
  // KEYED ON `twilio_sid`, which is why 0035 indexes it — `idx_sms_send_log_twilio_sid` exists for
  // this callback and nothing else. NOT on the phone number: `To` is in the payload, but matching
  // on it would hold a number in a route with no need of one AND would hit the wrong row for a
  // number that has since been re-subscribed.
  //
  // NOT AN UPSERT, and a miss is not an error. A dry-run send writes no log row at all, so a
  // callback with nothing to update is an expected outcome; inventing a row from a callback would
  // put an entry in the audit trail that no send ever produced.
  await query(`UPDATE sms_send_log SET delivery_status = $1 WHERE twilio_sid = $2`, [
    report.status,
    report.twilioSid,
  ]);
};

export interface DeliveryStatusOptions {
  /**
   * Defaults to FALSE — this write is deliberately NOT gated on `SMS_SENDING_ENABLED`, unlike
   * every other write on this branch, and the divergence is the point rather than an oversight.
   *
   * A status callback can only ever arrive for a message that was actually sent. If sending were
   * disabled, no message went out and no callback exists to receive. So the flag cannot protect
   * anything here — it can only cause harm: turning sending off would silently discard delivery
   * receipts for messages ALREADY IN FLIGHT, losing the carrier's verdict on real texts to real
   * parents. Recording what happened to a message we already sent is not sending.
   *
   * The flag remains explicit for tests, which need to exercise the parse without a writer.
   */
  dryRun?: boolean;
  /** Injected for tests; defaults to the real writer above. */
  write?: DeliveryStatusWriter;
  /** Injected for tests; defaults to reading the configured token. */
  authToken?: string | null;
  /** Injected for tests; defaults to the configured callback URL. */
  url?: string | null;
}

/**
 * Verify, parse and record one delivery-status callback. NEVER THROWS.
 *
 * THE SIGNATURE CHECK IS FIRST AND FAILS CLOSED, exactly as on the inbound message webhook. This
 * URL is public, and without it anyone who learned it could POST `MessageStatus=delivered` for
 * any SID and corrupt the delivery record — or, more cheaply, discover which SIDs exist.
 *
 * THE PARAMS ARE VERIFIED AS SENT, whatever they are. Twilio warns that it "occasionally adds new
 * properties without advance notice" and that an implementation must "accept and correctly run
 * signature validation on an evolving set of parameters". Verifying over the whole `URLSearchParams`
 * rather than a list of expected fields is what makes that true here by construction.
 */
export async function recordDeliveryStatus(
  params: URLSearchParams,
  signature: string | null,
  options: DeliveryStatusOptions = {}
): Promise<DeliveryStatusResult> {
  const verified = verifyTwilioSignature({
    authToken: options.authToken !== undefined ? options.authToken : twilioAuthToken(),
    url: options.url !== undefined ? options.url : statusCallbackUrl(),
    params,
    signature,
  });
  if (!verified) return { outcome: 'unverified', report: null };

  const report = parseDeliveryStatus(params);
  if (!report) return { outcome: 'malformed', report: null };

  if (options.dryRun) return { outcome: 'dry_run', report };

  try {
    await (options.write ?? applyDeliveryStatus)(report);
    return { outcome: 'applied', report };
  } catch (err) {
    return {
      outcome: 'error',
      report,
      error: (err as Error)?.message ?? 'unknown error',
    };
  }
}
