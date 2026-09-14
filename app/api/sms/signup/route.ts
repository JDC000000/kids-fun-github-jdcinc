// app/api/sms/signup/route.ts — the public SMS signup endpoint.
//
// DRAFT (SMS pivot). POST /api/sms/signup — the one destination behind all three of PRD §2.1's
// doors (QR code, "text START", email blast). No login, no account, no session: the phone number
// is the identity, which is the entire premise of this product.
//
// Modelled on app/api/notify/region/route.ts, the closest existing precedent: a no-login public
// form, hand validation (zod is not a dependency), an early and a hard payload cap, and a small
// typed body. It differs in three deliberate places, each marked below.
//
// WHAT IS REAL AND WHAT IS NOT. The flag, the caps, the validation, the response shape and the
// error mapping all run today. `createPendingSubscriber` is a clearly-marked stub in
// lib/sms/signup-store.ts, because `sms_consent` exists only as unapplied SQL and nobody on this
// branch holds write credentials. Same posture as lib/sms/consent-transitions.ts.
// `sendConfirmationRequest` is now half real: it BUILDS §2.6's approved confirmation text on
// every path, dry run included, and only its Twilio dispatch and `sms_send_log` write are stubs.
import { NextResponse } from 'next/server';
import { clientIpFrom } from '@/lib/sms/client-ip';
import { smsSendingEnabled, smsSignupEnabled } from '@/lib/sms/config';
import {
  MAX_SIGNUP_PAYLOAD_BYTES,
  parseSmsSignupBody,
  type SignupFieldError,
  type SmsSignupField,
} from '@/lib/sms/signup-validate';
import {
  checkAndRecordSignupAttempt,
  createPendingSubscriber,
  sendConfirmationRequest,
} from '@/lib/sms/signup-store';
import { captureAndFlush, withObservedRoute } from '@/lib/observability/route-handler';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs'; // pg pool + node:crypto need the Node runtime, not edge.

interface ErrorBody {
  ok: false;
  /** `errors[0].message`. Kept so the existing single-error contract still holds. */
  error: string;
  field?: SmsSignupField;
  /**
   * EVERY validation failure, not just the first (PRD §8 item 2, Jon: "Show all errors at once").
   * Added rather than replacing `error`/`field`, so nothing that already reads this response
   * breaks — those two are now defined as the head of this list.
   */
  errors?: SignupFieldError[];
}

function fail(status: number, error: string, field?: SmsSignupField): NextResponse {
  const body: ErrorBody = field ? { ok: false, error, field } : { ok: false, error };
  return NextResponse.json(body, { status });
}

/** A validation failure, with the whole list attached. */
function failValidation(errors: SignupFieldError[]): NextResponse {
  const [first] = errors;
  return NextResponse.json(
    { ok: false, error: first.message, ...(first.field ? { field: first.field } : {}), errors },
    { status: 400 }
  );
}

/**
 * THE ONE SUCCESS ANSWER THIS ENDPOINT GIVES. Built here, in one place, because two call sites
 * that must be indistinguishable cannot be trusted to stay that way if each writes its own object
 * literal — the previous version of this file proved exactly that.
 *
 * ═══ WHY A BRAND-NEW SIGNUP AND AN ALREADY-ACTIVE ONE COME OUT OF THE SAME FUNCTION ═══
 * A caller of this unauthenticated form has not proved they hold the number they typed. If the two
 * cases differ in ANY way a client can see — an extra field, a different status code, a different
 * `dispatched` value, a different screen — then the form is an oracle: type a stranger's number,
 * read the answer, learn whether they subscribe to us. The throttle in step 5 raises the price of
 * that lookup; only identical answers remove it. So: same status, same keys, same values.
 *
 * `dispatched` IS THE SUBTLE ONE. It reports whether a confirmation SMS left the building, and on
 * the already-active path none is sent — but answering `false` there while a real signup answers
 * `true` restores the whole oracle through the one field that is left, and hands the parent the
 * "we couldn't send that SMS" screen for a subscription that is working perfectly. So that path
 * passes `smsSendingEnabled()`: the value a successful send WOULD have reported in this
 * environment, which keeps the field's dry-run meaning intact (false whenever sending is off,
 * so a staging screenshot still cannot be mistaken for a live signup) without making it a
 * subscriber-status readout.
 */
function signupAccepted(dispatched: boolean): NextResponse {
  return NextResponse.json({ ok: true, dispatched }, { status: 201 });
}

/**
 * What a throttled caller is told. ONE SENTENCE FOR ALL FOUR LIMITS, deliberately.
 *
 * The result carries a `reason` — per-number interval, per-number daily, per-IP interval, per-IP
 * daily — and none of it comes out here. "You have already asked for a text to this number" and
 * "too many numbers from your address" are different facts about different people, and telling
 * the caller which one they hit would let them binary-search a stranger's signup history out of a
 * form they are not authenticated to. The `Retry-After` header is deliberately the only thing
 * that varies, because a caller genuinely needs it and it says nothing about which subject it is
 * counting.
 */
const THROTTLED_MESSAGE = 'Too many signup attempts. Please try again in a few minutes.';

export const POST = withObservedRoute(smsSignupPost, { tags: { route: 'api/sms/signup' } });

async function smsSignupPost(request: Request): Promise<NextResponse> {
  // 1. THE FEATURE GATE, before anything else — including before reading the body.
  //
  //    404, not 403, and that is deliberate: while the sign-off gate (PRD §1.3/§1.4) is not
  //    recorded, this endpoint does not exist as far as the outside world is concerned. A 403
  //    would advertise a disabled consent-collection endpoint on a public host, which is an
  //    invitation to come back and probe it later.
  if (!smsSignupEnabled()) {
    return fail(404, 'not found');
  }

  // 2. Cheap early reject on the declared size, before reading the body.
  const declared = Number(request.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > MAX_SIGNUP_PAYLOAD_BYTES) {
    return fail(413, 'payload too large');
  }

  // 3. Read and hard-cap the actual body (content-length can be absent or lie).
  const rawText = await request.text();
  if (Buffer.byteLength(rawText, 'utf8') > MAX_SIGNUP_PAYLOAD_BYTES) {
    return fail(413, 'payload too large');
  }

  let json: unknown;
  try {
    json = rawText.length > 0 ? JSON.parse(rawText) : null;
  } catch {
    return fail(400, 'invalid JSON');
  }

  // 4. Validate. Pure, and the whole accept/reject surface lives in lib/sms/signup-validate.ts.
  const parsed = parseSmsSignupBody(json, { now: new Date() });
  if (!parsed.ok) {
    // NO SPECIAL CASE HERE ANY MORE. The out-of-area rejection used to be substituted at this line
    // by matching the validator's terse error text; the sentence now comes out of the validator
    // itself, so the browser form — which calls `parseSmsSignupBody` directly and never reaches
    // this route — shows the same words a parent gets from the API. See that function.
    //
    // ALL of them, in form order. A caller reading only `error` still gets the first one.
    return failValidation(parsed.errors);
  }

  // 5. THE THROTTLE, and it goes HERE — after validation, before the write and before the send.
  //
  //    AFTER VALIDATION, so a caller who typed a malformed number cannot spend a real subject's
  //    daily budget by submitting garbage: there is nothing to throttle until we know which number
  //    this is actually about. BEFORE THE WRITE, because both of the things worth preventing are
  //    downstream of this line — the `sms_consent` row this would rewrite, and the text it would
  //    send to whoever holds the number.
  //
  //    WHAT IT PREVENTS. Until this existed, POST /api/sms/signup was a remote control for
  //    somebody else's phone: submit their number, they get a confirmation text, repeat forever.
  //    The person it cost never visited the site and had no way to make it stop. lib/sms/
  //    signup-store.ts has the limits and the reasoning; this route only decides what a refusal
  //    looks like from outside.
  //
  //    429 WITH `Retry-After`, WHICH IS THE ONE THING THAT VARIES. See THROTTLED_MESSAGE for why
  //    the body deliberately does not say WHICH limit was hit.
  const throttle = await checkAndRecordSignupAttempt({
    phoneNumber: parsed.value.phoneNumber,
    ipAddress: clientIpFrom(request.headers),
  });
  if (throttle.degraded) {
    // NOT A FAILED REQUEST — the caller was let through on purpose (see `degraded`). But an
    // abuse throttle that is silently inert is the same as no throttle, and the ways it gets
    // there — migration 0045 unapplied, SMS_PHONE_HASH_SALT unset, the table unreachable — are
    // all states somebody has to be told about rather than discover from a complaint.
    await captureAndFlush(new Error('sms_signup_throttle_degraded'), undefined, {
      route: 'api/sms/signup',
      operation: 'check_signup_throttle',
    });
  }
  if (!throttle.allowed) {
    return NextResponse.json(
      { ok: false, error: THROTTLED_MESSAGE } satisfies ErrorBody,
      { status: 429, headers: { 'retry-after': String(throttle.retryAfterSeconds) } }
    );
  }

  // 6. Persist as `pending`. STUB — see lib/sms/signup-store.ts.
  //
  //    A FAILED WRITE IS A FAILED REQUEST, the same call app/api/notify/region/route.ts makes and
  //    for the same reason: this form promises "we'll text you", and answering "check your phone"
  //    over a row that does not exist is precisely the quiet substitution this product's whole
  //    honest-state posture exists to end. /api/corrections returns 202 on a lost write because
  //    its optimistic thanks promises nothing; this one promises a message.
  const write = await createPendingSubscriber(parsed.value);
  if (write.outcome === 'error') {
    await captureAndFlush(new Error('sms_signup_write_failed'), undefined, {
      route: 'api/sms/signup',
      operation: 'create_pending_subscriber',
    });
    return fail(503, 'could not save that just now');
  }

  // 7. ALREADY AN ACTIVE SUBSCRIBER — nothing is written, nothing is sent, and NOTHING IS SAID.
  //
  //    The store refused to touch the row (see `createPendingSubscriber`): an already-confirmed
  //    number is not re-consented, not re-preferenced and not knocked back to `pending` by an
  //    unauthenticated form post. The matching thing for this route to do is send no confirmation
  //    text, because there is nothing left to confirm — they replied JOIN already and we hold the
  //    `confirmed_timestamp` that proves it.
  //
  //    ⚠ AND THE ANSWER IS THE SAME ONE A BRAND-NEW SIGNUP GETS. An earlier version of this branch
  //    returned `{ ok: true, alreadyActive: true, dispatched: false }` with a 200, and the form
  //    grew a screen for it. That made this endpoint an enumeration oracle — submit any number,
  //    read the response, learn whether that person is one of our subscribers — which is precisely
  //    the disclosure consent-copy.ts's SUBMITTED_BODY note has always refused to build out of
  //    conditional copy. Jon chose the silent behaviour on 2026-09-10: the no-op is real, and it
  //    is also invisible. See `signupAccepted` for what "invisible" has to mean field by field.
  //
  //    THE NO-OP ITSELF IS THE PROTECTION. Behaving identically is only safe because nothing
  //    happens on this path — no row is rewritten and no stranger's handset rings. Silence over a
  //    destructive write would be the worst of both, and is what the store guard prevents.
  //    ⚠ THE ONE RESIDUAL, KNOWN AND DELIBERATELY LEFT OPEN. `dispatched` is not perfectly
  //    symmetric across the two paths, and this is the exact remaining shape of it:
  //
  //      • THIS path always answers `smsSendingEnabled()` — in production, unconditionally
  //        `true`, because no real send is attempted here and so none can fail;
  //      • a genuinely NEW signup answers `smsSendingEnabled() && confirm.outcome === 'sent'`
  //        (step 9), so a REAL Twilio or carrier failure to a brand-new number answers `false`.
  //
  //    So with sending known to be on, observing `dispatched: false` proves the number was NOT
  //    already active. Note which way that runs: it can only ever RULE OUT an existing
  //    subscription, never confirm one, and only in the rare window where a dispatch genuinely
  //    failed. `dispatched: true` — the overwhelmingly common answer — stays ambiguous, and that
  //    ambiguity is the disclosure this branch exists to close. The residual is real, and it is
  //    strictly narrower and weaker than what was closed.
  //
  //    WHY IT WAS ACCEPTED RATHER THAN CLOSED (Operator + Jon, 2026-09-10). Both ways of closing
  //    it cost more than the gap does:
  //      • answer `true` here on a real Twilio failure — that is a lie to a parent about a text
  //        that did not arrive, and it discards the "resubmit, or text START" retry that step 8
  //        deliberately built this route around for genuine failures;
  //      • make THIS path's `dispatched` artificially non-deterministic so it mimics failure
  //        noise — real complexity, and a response field that stops meaning anything, all to
  //        cover a rare case.
  //    tests/sms/signup_route_abuse.test.ts pins this asymmetry as EXPECTED, so it cannot quietly
  //    widen into something worse without a test failing.
  if (write.outcome === 'already_active') {
    return signupAccepted(smsSendingEnabled());
  }

  // 8. Ask them to confirm. The MESSAGE is real (PRD §2.6, GSM-7-guarded); the Twilio dispatch
  //    and the `sms_send_log` write are the same stubbed seams the weekly path uses.
  //
  //    `subscriberId` is passed so the confirmation's audit row can be written against the row
  //    step 6 just created. It is null on a dry run and in the draft scaffold, and the send step
  //    skips the audit row rather than inventing an id — see its own comment.
  //
  //    A FAILED SEND IS **NOT** A FAILED SIGNUP — the one place this route deliberately does the
  //    opposite of step 6. The consent row is already written and already pending; a Twilio
  //    error means the confirmation text did not arrive, which resubmitting the form or texting
  //    START both resolve. Reporting it as a failed signup would be false, and worse, it would
  //    invite the parent to resubmit in a way that looks to them like the first attempt vanished.
  //    It is captured so we find out; it is not shown to them as an error.
  const confirm = await sendConfirmationRequest(parsed.value, {
    subscriberId: write.subscriberId,
  });
  if (confirm.outcome === 'error') {
    await captureAndFlush(new Error('sms_signup_confirmation_send_failed'), undefined, {
      route: 'api/sms/signup',
      operation: 'send_confirmation_request',
    });
  }

  // 9. NOTHING ABOUT THE SUBSCRIBER GOES BACK OUT. No id, no short_ref, no preferences token, no
  //    echo of the phone number. This is an unauthenticated endpoint and the response is read by
  //    whoever made the request, who has not yet proved they hold the number they submitted —
  //    handing back a row id or a preferences token here would make the form a way to obtain a
  //    bearer credential for someone else's number.
  //
  //    `dispatched` is honest about what actually happened, so a staging screenshot session cannot
  //    mistake a dry run for a live signup. False whenever SMS_SENDING_ENABLED is not 'true'.
  return signupAccepted(smsSendingEnabled() && confirm.outcome === 'sent');
}
