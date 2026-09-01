// lib/sms/twilio-client.ts — the one place this product talks to Twilio's REST API.
//
// DRAFT (SMS pivot). REAL CODE, not a stub: `dispatchSms` builds and issues an actual Messages
// API call through the `twilio` package that has been in package.json since round 1 for exactly
// this. What it still cannot do on this branch is run against a real account — nobody here holds
// a credential — so it is tested the way lib/sms/twilio-signature.ts is: DIFFERENTIALLY, against
// the SDK's own behaviour, by handing the real client a fake HTTP layer and asserting on the
// request it actually produced. See tests/sms/twilio_client.test.ts.
//
// ── WHY THIS MODULE EXISTS RATHER THAN LIVING IN weekly-send-io.ts ──────────────────────
// `dispatchSms` used to be a stub inside lib/sms/weekly-send-io.ts, which top-level imports the
// SearchEngine, the postgres listing repository, the alias resolver and the pg pool. Round 12
// flagged that the signup route and the inbound webhook were both inheriting that whole graph
// through it for no reason other than where the function happened to live.
//
// Making the dispatch REAL is what settled it: this now also drags the Twilio SDK along, and
// three unrelated features would have been importing a search engine and an HTTP client to send
// one text. `recordSmsSend` moved out to lib/sms/send-log.ts for the same reason at the same
// time — moving only one of the two would have left every caller importing weekly-send-io anyway
// and fixed nothing. weekly-send-io re-exports both, so nothing that already imported them broke.
//
// ── NOTHING THIS MODULE RETURNS OR THROWS MAY CARRY THE NUMBER OR THE BODY ──────────────
// This is the file where that rule is hardest to keep, because TWILIO'S OWN ERROR MESSAGES
// CONTAIN THE RECIPIENT'S PHONE NUMBER — error 21211 is literally "The 'To' number +1604... is
// not a valid phone number." Passing `err.message` through into `DispatchResult.error` would have
// piped a subscriber's number straight into every log line and Sentry breadcrumb the send job
// produces, which is precisely what lib/sms/weekly-send-io.ts's PII discipline exists to prevent.
// So the error CODE is reported and the message is discarded. The code is the diagnostic anyway:
// it maps to one documented cause, and it is what Twilio's console is searchable by.

import Twilio from 'twilio';
import type { RenderedMessage } from './message';
import {
  missingTwilioConfig,
  smsSendingEnabled,
  statusCallbackUrl,
  twilioAccountSid,
  twilioAuthToken,
  twilioMessagingServiceSid,
} from './config';
import { captureAndFlush } from '@/lib/observability/route-handler';

/**
 * THE MISSING-CONFIG ALARM, and the incident it exists because of.
 *
 * TWILIO_ACCOUNT_SID / AUTH_TOKEN / MESSAGING_SERVICE_SID were absent from production for days.
 * `dispatchSms` did exactly what it was designed to do — returned `{ outcome: 'failed' }` rather
 * than throwing, so no parent ever saw a 500 — and every confirm-request send failed silently for
 * the whole period. It was found by somebody noticing failed rows in sms_send_log.
 *
 * FAILING CLOSED WAS NEVER THE BUG. Failing closed WITHOUT SAYING SO was. So this adds the saying
 * so and changes no behaviour: the same result is returned, and nothing throws.
 *
 * ═══ WHY HERE AND NOT IN `assertSendPreconditions` ═══
 * That guard is the obvious home — it is the same class of bug (flag on, dependency missing) and
 * it already covers two other secrets. It is the WRONG home, because it runs only on the weekly
 * path, and the sends that actually failed in this incident were CONFIRM-REQUESTS from signup.
 * `dispatchSms` is the one function every send of every type funnels through, so it is the only
 * place a guard covers what actually broke.
 *
 * ═══ WHY IT IS NOT A STARTUP CHECK ═══
 * instrumentation.ts runs per cold start on every lambda, including ones that will never send
 * anything, and would alarm identically on a preview deploy that legitimately has no Twilio
 * credentials. Firing where the send is actually attempted means the alarm's existence IS the
 * evidence that a real message was really lost.
 *
 * ═══ ONCE PER CONFIGURATION, NOT ONCE PER MESSAGE, AND NOT A BOOLEAN ═══
 * A Friday bulk run of five hundred subscribers must not raise five hundred Sentry events. The
 * flag is keyed on WHICH variables are missing rather than being a `hasAlarmed` boolean — the same
 * reasoning as `twilioClient`'s cache key directly below: a process whose environment changes
 * (every test that stubs it) must alarm again for the new state instead of staying silent because
 * it once alarmed about a different one. No reset hook needed.
 *
 * NAMES ONLY. `missingTwilioConfig()` returns variable names and there is no path here that can
 * reach a credential value, a phone number or a message body — see the file header.
 */
let alarmedFor: string | null = null;

async function alarmIfTwilioUnconfigured(): Promise<void> {
  try {
    if (!smsSendingEnabled()) return; // a deliberately-unconfigured environment is not an incident
    const missing = missingTwilioConfig();
    if (missing.length === 0) return;
    const key = missing.join(',');
    if (alarmedFor === key) return;
    alarmedFor = key;
    await captureAndFlush(
      new Error(`SMS_SENDING_ENABLED is true but Twilio is not configured: ${key} unset. Sends are failing silently.`),
      undefined,
      { route: 'lib/sms/twilio-client', operation: 'twilio_config_missing' }
    );
  } catch {
    // An alarm that breaks the send path would be worse than the silence it replaces.
    // `dispatchSms` promises never to throw, and that promise outranks this notification.
  }
}

export type DispatchOutcome = 'sent' | 'dry_run' | 'stopped_via_carrier' | 'failed';

export interface DispatchResult {
  outcome: DispatchOutcome;
  twilioSid: string | null;
  /** Twilio's numeric error code, when it gave one. Kept for the 21610 branch and the log. */
  errorCode: number | null;
  /** Safe to log — never contains the number or the body. See the file header. */
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
 * Message statuses the API can hand back at CREATE time that already mean "this did not go".
 *
 * Ordinarily `create` returns 'queued' or 'accepted' and the verdict arrives later on the status
 * callback. These three are the exceptions, and treating them as success would write a 'sent'
 * audit row for a message Twilio had already given up on.
 */
const CREATE_TIME_FAILURE_STATUSES: ReadonlySet<string> = new Set([
  'failed',
  'undelivered',
  'canceled',
]);

/** Minimal structural view of what we need back from a create call. */
export interface TwilioMessageLike {
  sid: string;
  status: string;
  errorCode?: number | null;
}

/** The one method of the Twilio client this product uses. Injected in tests. */
export interface TwilioMessageSender {
  messages: {
    create(opts: {
      to: string;
      body: string;
      messagingServiceSid: string;
      statusCallback?: string;
    }): Promise<TwilioMessageLike>;
  };
}

let cached: { key: string; client: TwilioMessageSender } | null = null;

/**
 * The configured Twilio client, or null when the credentials are not set.
 *
 * NULL RATHER THAN A THROW. An unconfigured environment must fail closed and quietly: this is
 * called from the Friday job, the signup route and the inbound webhook, and none of them may turn
 * "Twilio is not set up here" into a 500 for a parent.
 *
 * MEMOISED ON THE CREDENTIALS THEMSELVES, not on first call. The SDK client holds a connection
 * pool worth reusing across a bulk run of several hundred sends, but a process that changes
 * TWILIO_ACCOUNT_SID (every test that stubs the environment) must not keep talking to the old
 * account. Keying the cache on the values makes both true without a reset hook.
 */
export function twilioClient(): TwilioMessageSender | null {
  const sid = twilioAccountSid();
  const token = twilioAuthToken();
  if (!sid || !token) return null;
  // The key is a length-and-identity check, not the credentials: `cached` lives in module memory
  // beside the client that already holds them, so this adds no exposure — but it is deliberately
  // not logged, returned or included in an error anywhere.
  const key = `${sid}:${token}`;
  if (cached?.key === key) return cached.client;
  const client = Twilio(sid, token) as unknown as TwilioMessageSender;
  cached = { key, client };
  return client;
}

export interface DispatchOptions {
  dryRun: boolean;
  /** Injected for tests; defaults to the configured client. */
  client?: TwilioMessageSender | null;
}

/**
 * Send one message.
 *
 * ── THE REQUEST ────────────────────────────────────────────────────────────────────────
 * POST https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json with
 * `MessagingServiceSid`, `To`, `Body` and `StatusCallback` — the SDK shapes and signs it; the
 * exact URI and form parameters are pinned in the test against the real client rather than
 * described here.
 *
 * MESSAGING SERVICE, NOT A `From` NUMBER, and it is required rather than optional here. The
 * Messaging Service is what holds the toll-free sender pool, applies Advanced Opt-Out (which is
 * what handles STOP/START/HELP before our webhook ever runs — see lib/sms/keywords.ts), and is
 * what Toll-Free Verification is granted against. Sending from a bare number would bypass all
 * three, so a missing `TWILIO_MESSAGING_SERVICE_SID` is a hard 'failed', not a fallback.
 *
 * ── ON `dryRun` IT RETURNS WITHOUT DISPATCHING, in the same result shape ────────────────
 * The whole pipeline stays verifiable end to end with zero real messages — the posture
 * lib/email/resend.ts takes with its payload. Note the ORDER: the dry-run check comes before the
 * client lookup, so a verification run needs no credentials at all.
 *
 * ── ERROR MAPPING, THE ONE PART THAT IS NOT BOILERPLATE ─────────────────────────────────
 * A 21610 response is NOT a failure to retry. It is the carrier telling us this number has opted
 * out, and the correct handling is to mark the subscriber stopped immediately (see
 * `TWILIO_ERROR_OPTED_OUT`) rather than to log a failed send and try again next Friday. Every
 * other code is a genuine 'failed'.
 *
 * NEVER THROWS, AND NEVER RETURNS THE NUMBER OR THE BODY — see the file header for why the second
 * of those takes real care here specifically.
 */
export async function dispatchSms(
  phoneNumber: string,
  message: RenderedMessage,
  options: DispatchOptions
): Promise<DispatchResult> {
  if (options.dryRun) return { outcome: 'dry_run', twilioSid: null, errorCode: null };

  const client = options.client !== undefined ? options.client : twilioClient();
  if (!client) {
    await alarmIfTwilioUnconfigured();
    return {
      outcome: 'failed',
      twilioSid: null,
      errorCode: null,
      error: 'twilio credentials not configured',
    };
  }

  const messagingServiceSid = twilioMessagingServiceSid();
  if (!messagingServiceSid) {
    await alarmIfTwilioUnconfigured();
    return {
      outcome: 'failed',
      twilioSid: null,
      errorCode: null,
      error: 'twilio messaging service not configured',
    };
  }

  const statusCallback = statusCallbackUrl();

  try {
    const created = await client.messages.create({
      to: phoneNumber,
      body: message.body,
      messagingServiceSid,
      // Omitted rather than sent empty when unconfigured: Twilio validates this parameter, and a
      // blank one would fail the whole send for the sake of a delivery receipt.
      ...(statusCallback ? { statusCallback } : {}),
    });

    if (CREATE_TIME_FAILURE_STATUSES.has(created.status)) {
      const errorCode = created.errorCode ?? null;
      return {
        outcome: errorCode === TWILIO_ERROR_OPTED_OUT ? 'stopped_via_carrier' : 'failed',
        twilioSid: created.sid ?? null,
        errorCode,
        error: `twilio returned status ${created.status}`,
      };
    }

    // 'queued' / 'accepted' / 'sending' / 'sent'. The carrier's verdict arrives later on the
    // status callback (app/api/sms/status/route.ts); accepted-by-Twilio is what "sent" means at
    // this layer, and `sms_send_log.delivery_status` is where the later truth lands.
    return { outcome: 'sent', twilioSid: created.sid ?? null, errorCode: null };
  } catch (err) {
    // `RestException` carries `code`; a transport failure (DNS, TLS, timeout) does not.
    const errorCode = typeof (err as { code?: unknown })?.code === 'number'
      ? ((err as { code: number }).code)
      : null;
    return {
      outcome: errorCode === TWILIO_ERROR_OPTED_OUT ? 'stopped_via_carrier' : 'failed',
      twilioSid: null,
      errorCode,
      // THE MESSAGE IS DISCARDED ON PURPOSE. Twilio's own error strings quote the recipient's
      // number back (21211: "The 'To' number +1604... is not a valid phone number"), and this
      // string reaches log lines and Sentry. The code identifies the cause without the PII.
      error: errorCode === null ? 'twilio request failed' : `twilio error ${errorCode}`,
    };
  }
}
