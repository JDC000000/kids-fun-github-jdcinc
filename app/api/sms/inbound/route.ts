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
import {
  signupUrl,
  smsSendingEnabled,
  stagingReplyBodyAllowed,
  twilioAuthToken,
  webhookPublicUrl,
} from '@/lib/sms/config';
import { isTestDestination } from '@/lib/sms/config';
import { classifyInboundKeyword, type InboundKeyword } from '@/lib/sms/keywords';
import { verifyTwilioSignature } from '@/lib/sms/twilio-signature';
import {
  confirmSubscriber,
  mirrorCarrierStart,
  mirrorCarrierStop,
  recordHelpRequest,
  type TransitionOutcome,
  type TransitionResult,
} from '@/lib/sms/consent-transitions';
// Last 4 digits only, for logs and error context. A full phone number must never reach a log line,
// a Sentry breadcrumb or an error message. IMPORTED, not defined here: an earlier copy in this file
// claimed the redaction "lives here rather than at each call site" while a byte-for-byte identical
// one lived in lib/sms/weekly-send-io.ts. It now genuinely has one home.
import { redactPhone } from '@/lib/sms/redact';
import {
  renderConfirmRequestMessage,
  renderStartSignupInviteMessage,
  renderUnknownKeywordMessage,
} from '@/lib/sms/message';
import { sendWelcomeText } from '@/lib/sms/welcome';
import { markWaitlistUnsubscribed } from '@/lib/sms/waitlist-store';
import { captureAndFlush, withObservedRoute } from '@/lib/observability/route-handler';
import { checkAndRecordUnknownReply, isOwnNumber } from '@/lib/sms/inbound-reply-guard';

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
  const to = (params.get('To') ?? '').trim();
  const body = params.get('Body');
  // ═══ WHICH OF OUR NUMBERS DID THIS ARRIVE AT? ═══
  // `To`, never `From`. The sender is whoever texted us and is not ours to trust; `To` is one of
  // our own provisioned numbers. A row confirmed by a JOIN that landed on a test handset's number
  // is marked is_test, and loadActiveSubscribers() then cannot hand it to the Friday send.
  const markTest = isTestDestination(to);
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

  // ═══ NEVER AUTO-REPLY TO OURSELVES (2026-09-24 loop incident) ═══
  // Our toll-free number and a QA number both webhook here, so each one's reply was the other's
  // unrecognised inbound: ~60 texts in 39s. Transitions still run for our own numbers (QA relies
  // on JOIN/STOP from test handsets); only the TwiML reply is withheld. lib/sms/inbound-reply-guard.ts.
  const ownSender = isOwnNumber(from, to);

  const { reply } = await dispatch(keyword, from, dryRun, markTest, ownSender);

  // 6. Always TwiML, always 200 once verified. A transition failure is OUR problem to alert on
  //    (withObservedRoute + the structured result), not something to report to Twilio as a
  //    webhook error — a non-2xx here makes Twilio retry, which would replay the transition.
  //    `reply` is non-null for exactly one branch today; every other keyword answers in silence.
  return reply ? twiml(messageResponse(reply)) : twiml();
}

/**
 * May a reply body actually go out on this request?
 *
 * THE PRODUCTION RULE IS UNCHANGED: a dry run says nothing. `SMS_SENDING_ENABLED !== 'true'` means
 * "this deployment sends no messages", and until Toll-Free Verification is granted that has to
 * include the one reply this webhook can emit.
 *
 * THE ONE EXCEPTION IS THE LOCAL TESTING HARNESS, where the response goes back to the agent that
 * posted it rather than to Twilio, so nothing reaches a person. `stagingReplyBodyAllowed()`
 * defaults to FALSE everywhere and is deliberately absent from `.env.example`; see its own doc in
 * lib/sms/config.ts for why that absence is load-bearing rather than an oversight.
 *
 * IT IS A SECOND CONDITION, NOT A REPLACEMENT. With sending enabled the reply flows regardless, so
 * this flag is a no-op on any real deployment that is actually sending — it can only ever turn a
 * silence into a visible reply on a deployment that is already dispatching nothing.
 */
function replyBodyPermitted(dryRun: boolean): boolean {
  return !dryRun || stagingReplyBodyAllowed();
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
  dryRun: boolean,
  markTest: boolean,
  ownSender = false
): Promise<InboundDispatch> {
  switch (keyword) {
    case 'join':
      return { result: await confirmAndWelcome(from, dryRun, {}, markTest), reply: null };
    case 'stop': {
      const result = await mirrorCarrierStop(from, { dryRun });
      // ── ADDITIVE, AND DELIBERATELY AFTER ────────────────────────────────────────────────
      // The subscriber transition above is untouched: same call, same options, same result
      // returned. This only ALSO records the opt-out against any area-waitlist rows for the
      // number, which nothing did before — the notification promises "Reply STOP to opt out"
      // and that was previously honoured only by Twilio's carrier-layer block.
      //
      // It runs even when the transition reports `no_such_subscriber`, because that is exactly
      // the waitlist-only case: those numbers have no sms_consent row at all.
      //
      // `markWaitlistUnsubscribed` never throws, by construction. A waitlist write failing must
      // not take down the handler whose real job is a subscriber's CASL opt-out.
      await markWaitlistUnsubscribed(from, { dryRun });
      return { result, reply: null };
    }
    case 'start': {
      const result = await mirrorCarrierStart(from, { dryRun });
      // Built on every path so a broken template fails in a dry run, dropped when sending is off.
      const reply = startReplyFor(result.outcome);
      return { result, reply: replyBodyPermitted(dryRun) && !ownSender ? reply : null };
    }
    case 'help':
      return { result: await recordHelpRequest(from, { dryRun }), reply: null };
    case 'unknown':
    default: {
      // Deliberately NOT a fuzzy re-match against JOIN — see lib/sms/keywords.ts for why a
      // near-miss must not be promoted into a consent confirmation. This reply is the other half
      // of that decision: the near-miss gets told what the actual word is.
      //
      // THERE IS NO LOG LINE HERE, and there used to be a `void redactPhone(from)` pretending
      // otherwise — a computed value nothing consumed, under a comment implying it was logged.
      // Removed rather than wired up: this route has no logging call anywhere, and inventing one
      // for a branch that fires on arbitrary inbound text would be adding a PII-adjacent log with
      // no consumer. `redactPhone` (lib/sms/redact.ts) remains the required shape if one is ever
      // added — see the import.
      const message = renderUnknownKeywordMessage(signupUrl());
      if (!replyBodyPermitted(dryRun) || ownSender) return { result: null, reply: null };
      // ═══ AT MOST ONE OF THESE PER SENDER PER UTC DAY — THE LOOP BOUND ═══
      // This is the only reply this route sends to ARBITRARY text, so it is the one an
      // auto-responder on a parent's phone can ping-pong with indefinitely. Counted only when a
      // reply would really go out, so a plain dry run still touches no table. FAILS CLOSED:
      // no counter, no reply. See lib/sms/inbound-reply-guard.ts.
      const decision = await checkAndRecordUnknownReply(from);
      if (!decision.allowed) {
        if (decision.reason !== 'daily_cap') {
          await captureAndFlush(
            decision.error ?? new Error(`sms_unknown_reply_guard_degraded:${decision.reason}`),
            undefined,
            { route: 'api/sms/inbound', operation: 'unknown_reply_guard', reason: decision.reason }
          );
        }
        return { result: null, reply: null };
      }
      return { result: null, reply: message.body };
    }
  }
}

/**
 * START: what to say back, by what the transition actually found (PRD §2.1 door 2).
 *
 * ═══ THREE OUTCOMES, THREE DIFFERENT FACTS, THREE DIFFERENT ANSWERS ═══
 * Round 5 added `awaiting_confirmation` to the outcome union specifically so this function could
 * exist: "the row is mid-signup" is not "no such subscriber" and not "already active", and its
 * own doc said collapsing it into either "would make the webhook reply with the wrong thing —
 * 'sign up here' or nothing, when the right answer is 'reply JOIN to confirm'." That outcome has
 * been carrying a reply nobody sent for eight rounds.
 *
 *   no_such_subscriber     Nothing holds this number — never signed up, or purged. This is
 *                          §2.1's door 2: a QR code or a poster, and a text into the void. The
 *                          signup link is the entire point of the door.
 *   awaiting_confirmation  They used the form and never replied JOIN. Re-send the confirmation
 *                          request — which is not a new message, it is §2.1's own recovery path:
 *                          "no automated nudge in MVP (resubmitting the form or texting START
 *                          again both work)". Texting START again is the thing that works, and
 *                          this is what makes it work.
 *
 * ═══ WHY EVERY OTHER OUTCOME IS SILENT ═══
 * A POSITIVE TEST on the two that reply, so a future outcome is silent by default rather than
 * accidentally texting somebody — the same shape as `confirmAndWelcome`'s `applied` guard.
 *   already_in_state  They are active. Nothing happened and nothing needs saying.
 *   applied           They were stopped or paused and are now active again. Twilio's Advanced
 *                     Opt-Out has ALREADY sent its own resubscribe confirmation for the stopped
 *                     case, before this webhook ran, so ours would be a duplicate on the one
 *                     exchange a carrier scrutinises most. SEE THE NOTE BELOW — this outcome
 *                     bundles two situations that are not actually alike.
 *   dry_run           Nothing was written, so nothing should be announced. (Belt and braces: the
 *                     caller drops every reply on a dry run anyway, because the two read-only
 *                     outcomes above are reported as themselves even then.)
 *   error / no_change The transition failed, or there was nothing to do.
 *
 * ═══ 🔴 `applied` BUNDLES A PAUSE AND AN OPT-OUT, AND THEY ARE DIFFERENT ═══
 * `decideStart` returns `applied` for BOTH `stopped → active` and `paused → active`. For a
 * stopped subscriber, Twilio already replied. For a PAUSED one it did not — a pause is our own
 * empty-week auto-pause (PRD §2.2 step 7), never a carrier opt-out, so that number was never on
 * Twilio's suppression list and nothing has been said to them at all. Silence is right for one
 * and arguable for the other.
 * NOT RESOLVED HERE, because it cannot be: `TransitionResult` carries the TARGET status
 * (`change.status = 'active'`), never the prior one, so this function cannot tell the two apart.
 * Distinguishing them means widening the transition result and writing a fifth piece of copy —
 * a decision, not a cleanup. Flagged in the round-14 notes.
 *
 * Exported for test: the transition stubs on this branch always resolve to `no_such_subscriber`,
 * so the other outcomes are unreachable end-to-end and would otherwise be untested.
 */
export function startReplyFor(outcome: TransitionOutcome): string | null {
  switch (outcome) {
    case 'no_such_subscriber':
      return renderStartSignupInviteMessage(signupUrl()).body;
    case 'awaiting_confirmation':
      // REUSED, not rewritten. §2.6's approved confirmation-request copy is exactly this message,
      // and `renderConfirmRequestMessage` already degrades its area clause by design. Null rather
      // than a lookup on purpose: this reply rides on the webhook response, which must return
      // fast and must not grow a database read and a new failure mode for one nicety. The area is
      // decoration here; "reply JOIN" is the content.
      return renderConfirmRequestMessage(null).body;
    default:
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
 *
 * ═══ ⚠ OPEN, PRE-LAUNCH: THIS AWAITS A REAL TWILIO CALL BEFORE THE WEBHOOK RESPONDS ═══
 * As of round 16 `sendWelcomeText` issues an actual Messages API request, and this line waits for
 * it. That is currently masked — the subscriber loader is a stub returning null, so the send
 * returns before reaching the network — and it must be decided before the loader is wired.
 *
 * THE BUDGET, from Twilio's own connection-override documentation rather than from memory: the
 * total time for a webhook including retries is capped at 15s (`tt`, max 15000ms, enforced at the
 * maximum when unset). Twilio's default retry policy is `rp=ct` — TCP connect or TLS handshake
 * failure ONLY — with `rc=1`. So a handler that is merely SLOW is not retried by default; that
 * needs `rp` set to `rt` or `all`. The risk is real but narrower than "any slow response is
 * retried", and which of those is true is an Operator console setting.
 *
 * IF A REPLAY DOES HAPPEN, BOTH SHAPES ARE NOW SAFE — and this paragraph used to say the
 * opposite, so read it carefully if you remember the old version.
 *   • A SEQUENTIAL replay: the second `confirmSubscriber` reads `active` and returns
 *     `already_in_state`, which sends nothing.
 *   • A CONCURRENT replay: `applyConsentChange` carries the compare-and-set
 *     (`WHERE id = $1 AND status = $2`) and returns `no_match` when it affects zero rows;
 *     `applyConsentTransition` maps that to `already_in_state` with `change: null`; and
 *     `shouldSendWelcome` below fires only on `applied`. So the loser of the race sends nothing.
 *
 * ⚠ THIS COMMENT WAS STALE AND MISLED A LATER REVIEW INTO SCHEDULING THE FIX A SECOND TIME.
 * It described the hazard as open and named the status predicate as the "cheapest real fix,
 * flagged for a decision". That predicate LANDED in 67105fe, after this note was written in
 * b38a8ff, and nobody came back to this paragraph. Anyone reading only this file would have
 * concluded the product had a live double-send exposure that it does not have. Corrected
 * 2026-09-03. The real SQL is pinned against a live database by "REFUSES the second of two
 * concurrent JOINs — one welcome, not two" in tests/sms/signup_persistence-db.test.ts, and the
 * transition layer's handling of `no_match` by the concurrency block in
 * tests/sms/consent_transitions.test.ts.
 *
 * SEPARATELY, AND STILL OPEN: why the welcome send is still AWAITED inline rather than deferred
 * until after the response. This is about the retry budget above, not about double writes:
 *   • `after()` — Next's supported "work after the response" primitive — DOES NOT EXIST in this
 *     repo's Next 14.2.35. Verified two ways: it is absent from `next/server`'s exports, and
 *     Next's own docs record `unstable_after` arriving in 15.0.0-rc and stabilising in 15.1.0.
 *   • Bare fire-and-forget (dropping the `await`) is worse, not better: on a serverless runtime
 *     the instance may be frozen or reclaimed the moment the response is returned, so the send
 *     would be dropped non-deterministically — a welcome that sometimes arrives, with nothing in
 *     any log to say which times it did not.
 *   • `waitUntil` from `@vercel/functions` is the primitive `after()` wraps, and would work — but
 *     it is not a dependency here and adding it couples this route to one platform.
 *   • A queue is real infrastructure and out of scope for a draft branch.
 * So the send stays inline until one of those becomes available. That is a LATENCY question —
 * how long Twilio waits for this webhook — and no longer a correctness one: a replay that does
 * get through cannot produce a second welcome, per the compare-and-set above.
 */
export async function confirmAndWelcome(
  from: string,
  dryRun: boolean,
  deps: ConfirmAndWelcomeDeps = {},
  markTest = false
): Promise<TransitionResult> {
  const confirm = deps.confirm ?? confirmSubscriber;
  const welcome = deps.welcome ?? sendWelcomeText;
  const result = await confirm(from, { dryRun, markTest });
  if (shouldSendWelcome(result)) {
    await welcome(result.subscriberId!, { dryRun });
  }
  return result;
}

/** Injected for tests; both default to the real functions. */
export interface ConfirmAndWelcomeDeps {
  confirm?: typeof confirmSubscriber;
  welcome?: typeof sendWelcomeText;
}

/**
 * THE GUARD. Exported and pure so it is tested as the SHIPPED code rather than as a copy.
 *
 * It was previously inline in `confirmAndWelcome`, which is unexported, and
 * tests/sms/welcome.test.ts asserted a hand-written re-implementation of the same condition. That
 * is not coverage of anything: a QA pass proved that deleting half of the REAL condition left
 * every relevant test green, because no test ever executed it. A copied assertion tests the copy.
 *
 * The rule itself is unchanged — see `confirmAndWelcome` above for why each outcome is silent.
 */
export function shouldSendWelcome(result: TransitionResult): boolean {
  return result.outcome === 'applied' && Boolean(result.subscriberId);
}
