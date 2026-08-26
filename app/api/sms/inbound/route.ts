// app/api/sms/inbound/route.ts — SCAFFOLD. Twilio inbound-message webhook.
//
// DRAFT (SMS pivot). POST /api/sms/inbound — Twilio POSTs a form-encoded body here whenever a
// subscriber texts our number.
//
// WHAT IS REAL IN THIS FILE AND WHAT IS NOT, stated up front so nobody mistakes the second for
// the first:
//   REAL: the signature verification path, the payload cap, the keyword classification, the
//         enabled/dry-run gate, and the TwiML reply shape. All of it is pure logic or plumbing
//         and all of it runs today.
//   STUB: the four state transitions in lib/sms/consent-transitions.ts. They write to tables
//         that exist only as unapplied SQL (supabase/migrations/0034-0036), so they are no-ops
//         that report what they would have done.
//
// WHY THE SIGNATURE CHECK IS THE FIRST THING THAT HAPPENS. This URL is public and
// unauthenticated and it mutates consent. Anyone who learns it could otherwise POST
// `From=+1604...&Body=JOIN` and manufacture a CASL express-consent record for a number they do
// not own, or POST `Body=STOP` to unsubscribe a stranger. See lib/sms/twilio-signature.ts.
//
// WHY IT REPLIES WITH TwiML EVEN THOUGH IT MOSTLY DOES NOTHING. Twilio parses this response as
// TwiML regardless of what we intend. An empty `<Response></Response>` is the documented way to
// say "received, send no reply" — returning JSON, or an empty body, makes Twilio log a webhook
// error on every single inbound message and surfaces as a red account health metric that has
// nothing to do with our actual behaviour.
//
// STOP / START / HELP ARE ALREADY HANDLED BY TWILIO'S ADVANCED OPT-OUT before this route runs;
// it suppresses the number and sends the standard reply itself. This route MIRRORS the result
// into sms_consent.status so our database does not drift from Twilio's suppression list —
// see lib/sms/keywords.ts for why that mirror is load-bearing rather than bookkeeping.
import { NextResponse } from 'next/server';
import { smsSendingEnabled, twilioAuthToken, webhookPublicUrl } from '@/lib/sms/config';
import { classifyInboundKeyword, type InboundKeyword } from '@/lib/sms/keywords';
import { verifyTwilioSignature } from '@/lib/sms/twilio-signature';
import {
  confirmSubscriber,
  mirrorCarrierStart,
  mirrorCarrierStop,
  recordHelpRequest,
  type TransitionResult,
} from '@/lib/sms/consent-transitions';
import { sendWelcomeText } from '@/lib/sms/welcome';
import { withObservedRoute } from '@/lib/observability/route-handler';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs'; // node:crypto + pg pool need the Node runtime, not edge.

/**
 * Hard cap on the inbound body. A Twilio inbound webhook is a few hundred bytes; 16 KiB is
 * generous by two orders of magnitude and still bounds what an unauthenticated caller can make
 * us buffer before the signature check has had a chance to reject them.
 */
export const MAX_INBOUND_PAYLOAD_BYTES = 16 * 1024;

/** Empty TwiML: "received, reply nothing". Twilio expects this content type. */
function twiml(body = '<Response></Response>', status = 200): NextResponse {
  return new NextResponse(`<?xml version="1.0" encoding="UTF-8"?>${body}`, {
    status,
    headers: { 'content-type': 'text/xml; charset=utf-8' },
  });
}

/**
 * Last 4 digits only, for logs and error context. A full phone number must never reach a log
 * line, a Sentry breadcrumb or an error message — this route is the one place in the codebase
 * that routinely holds one, so the redaction lives here rather than at each call site.
 */
function redactPhone(phone: string): string {
  return phone.length <= 4 ? '****' : `****${phone.slice(-4)}`;
}

export const POST = withObservedRoute(smsInboundPost, { tags: { route: 'api/sms/inbound' } });

async function smsInboundPost(request: Request): Promise<NextResponse> {
  // 1. Cheap early reject on the declared size, before reading anything.
  const declared = Number(request.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > MAX_INBOUND_PAYLOAD_BYTES) {
    return twiml('<Response></Response>', 413);
  }

  // 2. Read the RAW body. It has to be the raw text, not request.formData(), because the
  //    signature is computed over the parameters as sent and we must not let a parse/re-encode
  //    round trip change what we verify.
  const raw = await request.text();
  if (Buffer.byteLength(raw, 'utf8') > MAX_INBOUND_PAYLOAD_BYTES) {
    return twiml('<Response></Response>', 413);
  }
  const params = new URLSearchParams(raw);

  // 3. Authenticate the caller BEFORE looking at a single field of the payload. Fails closed
  //    when TWILIO_AUTH_TOKEN or SMS_WEBHOOK_PUBLIC_URL is unset: an unconfigured environment
  //    rejects everything rather than trusting anything.
  const verified = verifyTwilioSignature({
    authToken: twilioAuthToken(),
    url: webhookPublicUrl(),
    params,
    signature: request.headers.get('x-twilio-signature'),
  });
  if (!verified) {
    // 403, not 401: there is no auth scheme to challenge with. Body is TwiML for consistency,
    // though Twilio treats any non-2xx as a delivery failure and will not render it.
    return twiml('<Response></Response>', 403);
  }

  // 4. Now the payload can be trusted enough to read.
  const from = (params.get('From') ?? '').trim();
  const body = params.get('Body');
  const keyword = classifyInboundKeyword(body);

  if (!from) {
    // Signed but malformed — Twilio always sends From. Nothing to act on.
    return twiml();
  }

  // 5. THE GATE. Defaults to dry-run: unless SMS_SENDING_ENABLED === 'true', every transition
  //    below reports what it WOULD do and mutates nothing. Mirrors lib/email/config.ts's
  //    sendingEnabled(), and matters more here than there — an accidental live run on this
  //    route does not send a wrong email, it rewrites someone's consent record.
  const dryRun = !smsSendingEnabled();

  await dispatch(keyword, from, dryRun);

  // 6. Always TwiML, always 200 once verified. A transition failure is OUR problem to alert on
  //    (withObservedRoute + the structured result), not something to report to Twilio as a
  //    webhook error — a non-2xx here makes Twilio retry, which would replay the transition.
  return twiml();
}

/** Route a classified keyword to its transition, and fire the one send a transition triggers. */
async function dispatch(
  keyword: InboundKeyword,
  from: string,
  dryRun: boolean
): Promise<TransitionResult | null> {
  switch (keyword) {
    case 'join':
      return confirmAndWelcome(from, dryRun);
    case 'stop':
      return mirrorCarrierStop(from, { dryRun });
    case 'start':
      return mirrorCarrierStart(from, { dryRun });
    case 'help':
      return recordHelpRequest(from, { dryRun });
    case 'unknown':
    default:
      // TODO (scaffold): reply with a short human-readable nudge naming the keywords we
      // understand. Deliberately NOT a fuzzy re-match against JOIN — see lib/sms/keywords.ts
      // for why a near-miss must not be promoted into a consent confirmation.
      // `redactPhone(from)` is what any log line about this branch must use.
      void redactPhone(from);
      return null;
  }
}

/**
 * JOIN: apply the transition, then — and ONLY then — send the welcome text (PRD §2.1).
 *
 * ═══ WHY THE SEND LIVES HERE AND NOT INSIDE `confirmSubscriber` ═══
 * `confirmSubscriber` decides against `ConsentRow`, which is `{ id, status, stoppedAt }` and whose
 * own doc says why: "no phone number, no postal code, no birth years. A decision function that
 * cannot see personal data cannot leak it." The welcome text needs a phone number, a postal code,
 * birth years and a preferences token — every one of them a field that type deliberately excludes.
 * Putting the send inside the transition would mean widening `ConsentRow` with exactly the four
 * things it was defined to keep out. So the decision stays PII-free and the send does its own read.
 *
 * ═══ ONLY ON `applied`, AND THAT GUARD IS THE POINT ═══
 * `applied` is the one outcome meaning "a subscription just became active". Every other outcome
 * must send nothing, and the reasons differ:
 *   already_in_state      they were ALREADY active. A JOIN from an active subscriber is normal —
 *                         a parent replying twice, a carrier redelivering — and re-welcoming them
 *                         is the exact duplicate-message failure this ordering prevents.
 *   awaiting_confirmation not reachable from JOIN today (it is START's pending case), but the
 *                         guard is written as a positive test on `applied` rather than a list of
 *                         exclusions, so a future outcome is silent by default rather than
 *                         accidentally triggering a text.
 *   no_such_subscriber    there is nobody to welcome.
 *   dry_run               nothing was written, so nothing should be announced. Passing `dryRun`
 *                         through would ALSO stop the send, but returning early means an
 *                         unconfigured environment does not even perform the lookup.
 *   error                 the transition failed; a welcome would be announcing something that did
 *                         not happen.
 *
 * THE WELCOME NEVER CHANGES WHAT THE WEBHOOK RETURNS. `sendWelcomeText` does not throw, and its
 * result is deliberately discarded: the subscription is already active, which is the part that
 * matters, and a non-2xx here would make Twilio retry the whole inbound message and replay the
 * transition. One lost welcome beats one duplicated confirmation.
 */
async function confirmAndWelcome(from: string, dryRun: boolean): Promise<TransitionResult> {
  const result = await confirmSubscriber(from, { dryRun });
  if (result.outcome === 'applied' && result.subscriberId) {
    await sendWelcomeText(result.subscriberId, { dryRun });
  }
  return result;
}
