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
import { smsSendingEnabled, smsSignupEnabled } from '@/lib/sms/config';
import {
  MAX_SIGNUP_PAYLOAD_BYTES,
  parseSmsSignupBody,
  type SmsSignupField,
} from '@/lib/sms/signup-validate';
import { createPendingSubscriber, sendConfirmationRequest } from '@/lib/sms/signup-store';
import { captureAndFlush, withObservedRoute } from '@/lib/observability/route-handler';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs'; // pg pool + node:crypto need the Node runtime, not edge.

interface ErrorBody {
  ok: false;
  error: string;
  field?: SmsSignupField;
}

function fail(status: number, error: string, field?: SmsSignupField): NextResponse {
  const body: ErrorBody = field ? { ok: false, error, field } : { ok: false, error };
  return NextResponse.json(body, { status });
}

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
    return fail(400, parsed.error, parsed.field);
  }

  // 5. Persist as `pending`. STUB — see lib/sms/signup-store.ts.
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

  // 6. Ask them to confirm. The MESSAGE is real (PRD §2.6, GSM-7-guarded); the Twilio dispatch
  //    and the `sms_send_log` write are the same stubbed seams the weekly path uses.
  //
  //    `subscriberId` is passed so the confirmation's audit row can be written against the row
  //    step 5 just created. It is null on a dry run and in the draft scaffold, and the send step
  //    skips the audit row rather than inventing an id — see its own comment.
  //
  //    A FAILED SEND IS **NOT** A FAILED SIGNUP — the one place this route deliberately does the
  //    opposite of step 5. The consent row is already written and already pending; a Twilio
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

  // 7. NOTHING ABOUT THE SUBSCRIBER GOES BACK OUT. No id, no short_ref, no preferences token, no
  //    echo of the phone number. This is an unauthenticated endpoint and the response is read by
  //    whoever made the request, who has not yet proved they hold the number they submitted —
  //    handing back a row id or a preferences token here would make the form a way to obtain a
  //    bearer credential for someone else's number.
  return NextResponse.json(
    {
      ok: true,
      // Honest about what actually happened, so a staging screenshot session cannot mistake a
      // dry run for a live signup. False whenever SMS_SENDING_ENABLED is not 'true'.
      dispatched: smsSendingEnabled() && confirm.outcome === 'sent',
    },
    { status: 201 }
  );
}
