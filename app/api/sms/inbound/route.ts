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
// EXACTLY ONE BRANCH SAYS ANYTHING: `unknown`. See `dispatch` for why that reply rides on this
// response as TwiML `<Message>` rather than going out through the REST API the way the JOIN
// welcome does — the short version is that a stranger's reply has no subscriber row to log
// against, and `sms_send_log` cannot represent a message like that.
//
// STOP / START / HELP ARE ALREADY HANDLED BY TWILIO'S ADVANCED OPT-OUT before this route runs;
// it suppresses the number and sends the standard reply itself. This route MIRRORS the result
// into sms_consent.status so our database does not drift from Twilio's suppression list —
// see lib/sms/keywords.ts for why that mirror is load-bearing rather than bookkeeping.
import { NextResponse } from 'next/server';
import { signupUrl, smsSendingEnabled, twilioAuthToken, webhookPublicUrl } from '@/lib/sms/config';
import { classifyInboundKeyword, type InboundKeyword } from '@/lib/sms/keywords';
import { verifyTwilioSignature } from '@/lib/sms/twilio-signature';
import {
  confirmSubscriber,
  mirrorCarrierStart,
  mirrorCarrierStop,
  recordHelpRequest,
  type TransitionResult,
} from '@/lib/sms/consent-transitions';
import { renderUnknownKeywordMessage } from '@/lib/sms/message';
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

/**
 * Escape text for XML ELEMENT CONTENT. Exported for test.
 *
 * NOT optional even though every body this route sends today is a static ASCII template. A TwiML
 * document is XML, and `&` is the character that breaks it — our own §2.6 confirmation copy
 * contains one ("Msg&data rates may apply"), so the first person to route an existing template
 * through this response would produce a malformed document and a Twilio webhook error, for a
 * reason that would not be obvious from the copy. Escaping at the boundary costs nothing.
 *
 * `'` AND `"` ARE DELIBERATELY NOT ESCAPED. Quotes only need escaping inside an ATTRIBUTE value;
 * in element content they are ordinary characters. An earlier draft escaped them too, which is
 * valid XML but turned every apostrophe in our copy into `&apos;` on the wire — harmless, and
 * needless noise in the one artifact a person debugging a webhook actually reads. If this helper
 * is ever reused for an attribute, it needs the quote cases back.
 */
export function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** TwiML that asks Twilio to send one reply to whoever just texted us. */
function messageResponse(body: string): string {
  return `<Response><Message>${escapeXml(body)}</Message></Response>`;
}

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

  const { reply } = await dispatch(keyword, from, dryRun);

  // 6. Always TwiML, always 200 once verified. A transition failure is OUR problem to alert on
  //    (withObservedRoute + the structured result), not something to report to Twilio as a
  //    webhook error — a non-2xx here makes Twilio retry, which would replay the transition.
  //    `reply` is non-null for exactly one branch today; every other keyword answers in silence.
  return reply ? twiml(messageResponse(reply)) : twiml();
}

/** What one inbound message produced: a state transition, a reply, or neither. */
interface InboundDispatch {
  /** The transition that ran, if any. Structured for observability; not returned to Twilio. */
  result: TransitionResult | null;
  /** Body to reply with as TwiML `<Message>`, or null for "received, say nothing". */
  reply: string | null;
}

/**
 * Route a classified keyword to its transition, fire the one send a transition triggers, and
 * decide whether anything is said back.
 *
 * ═══ ONLY `unknown` REPLIES, AND THE OTHER FOUR ARE SILENT ON PURPOSE ═══
 * STOP, START and HELP are handled by Twilio's Advanced Opt-Out BEFORE this route runs: Twilio
 * suppresses or restores the number and sends the standard reply itself. A second reply from us
 * would be a duplicate message on the one exchange a carrier scrutinises most. JOIN answers with
 * the welcome text, which goes out through the REST API because it needs a database read
 * (`sendWelcomeText`). So `unknown` is the only exchange where nobody has said anything yet.
 *
 * ═══ WHY THIS ONE RIDES ON THE WEBHOOK RESPONSE AND THE WELCOME DOES NOT ═══
 * Not a third pattern — it is the first use of the `body` argument `twiml()` has always taken.
 * The welcome uses the REST API for two reasons, and NEITHER applies here:
 *   1. It needs a per-subscriber read (area, ages, preferences token) keyed on the id the
 *      transition resolved. This reply is a static string and does no lookup at all — which is
 *      also what keeps a `dispatch` branch that runs for arbitrary inbound text cheap.
 *   2. It writes an `sms_send_log` row. This one CANNOT: whoever texted us may have no
 *      `sms_consent` row at all, and that table requires `consent_text_version NOT NULL` — a
 *      stranger has no consent, so there is no version to record, and `send_type`'s CHECK
 *      (migration 0035) has no value for an inbound reply either. Logging it would mean
 *      inventing a consent record for someone who never gave one, which is the exact thing this
 *      product's audit trail exists to make impossible.
 * Twilio records the message on its own side, and its suppression list still applies: a reply to
 * a number that has opted out is dropped by Twilio (21610), not sent by us.
 *
 * ═══ IT IS GATED BY THE SAME DRY-RUN FLAG AS EVERYTHING ELSE ═══
 * `SMS_SENDING_ENABLED !== 'true'` means "this deployment sends no messages", and carving out an
 * exception for one short reply would make that invariant unauditable. It also matters right now
 * for a concrete reason: until Toll-Free Verification is granted, outbound traffic from an
 * unverified number is exactly what should not be flowing. The message is still BUILT on every
 * path, so a broken template fails in a dry run rather than only in production.
 */
async function dispatch(
  keyword: InboundKeyword,
  from: string,
  dryRun: boolean
): Promise<InboundDispatch> {
  switch (keyword) {
    case 'join':
      return { result: await confirmAndWelcome(from, dryRun), reply: null };
    case 'stop':
      return { result: await mirrorCarrierStop(from, { dryRun }), reply: null };
    case 'start':
      return { result: await mirrorCarrierStart(from, { dryRun }), reply: null };
    case 'help':
      return { result: await recordHelpRequest(from, { dryRun }), reply: null };
    case 'unknown':
    default: {
      // Deliberately NOT a fuzzy re-match against JOIN — see lib/sms/keywords.ts for why a
      // near-miss must not be promoted into a consent confirmation. This reply is the other half
      // of that decision: the near-miss gets told what the actual word is.
      // `redactPhone(from)` is what any log line about this branch must use.
      void redactPhone(from);
      const message = renderUnknownKeywordMessage(signupUrl());
      return { result: null, reply: dryRun ? null : message.body };
    }
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
