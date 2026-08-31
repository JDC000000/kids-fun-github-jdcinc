// app/api/sms/waitlist/route.ts — POST an area-waitlist opt-in.
//
// ═══ A SEPARATE ROUTE FROM /api/sms/signup, DELIBERATELY ═══
// It writes a different table under a different consent, for a different promise. Folding it into
// the signup route would be the first step toward the two consents blurring — one handler that
// sometimes creates a subscriber and sometimes creates a waitlist row, sharing a body shape, is
// one refactor away from sharing a consent record too.
//
// ⛔ NO SEND PATH. This route records an opt-in and returns. It does not import the Twilio client,
// does not compose a message, and cannot dispatch one — the notification is gated behind
// `waitlistNotificationsEnabled()`, which only the Operator flips after their Twilio filing
// recheck. Nothing here is on that path.
import { NextResponse } from 'next/server';
import { smsSignupEnabled } from '@/lib/sms/config';
import { measureSparseRegionIds } from '@/lib/sms/sparse-measure';
import { parseWaitlistBody, type WaitlistFieldError } from '@/lib/sms/waitlist-validate';
import { addToWaitlist } from '@/lib/sms/waitlist-store';
import { withObservedRoute } from '@/lib/observability/route-handler';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs'; // pg pool needs the Node runtime, not edge.

/** Same cap as the signup route: this body is smaller, so the limit is generous by construction. */
const MAX_WAITLIST_PAYLOAD_BYTES = 4096;

function fail(status: number, error: string): NextResponse {
  return NextResponse.json({ ok: false, error }, { status });
}

function failValidation(errors: WaitlistFieldError[]): NextResponse {
  const [first] = errors;
  return NextResponse.json(
    { ok: false, error: first.message, ...(first.field ? { field: first.field } : {}), errors },
    { status: 400 }
  );
}

async function smsWaitlistPost(request: Request): Promise<NextResponse> {
  // Gated on the SAME flag as the signup form, and 404 for the same reason: while the sign-off
  // gate is unrecorded, a public consent-collection endpoint should not exist as far as the
  // outside world is concerned. A waitlist opt-in is still consent collection.
  if (!smsSignupEnabled()) return fail(404, 'not found');

  const declared = Number(request.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > MAX_WAITLIST_PAYLOAD_BYTES) {
    return fail(413, 'payload too large');
  }
  const rawText = await request.text();
  if (Buffer.byteLength(rawText, 'utf8') > MAX_WAITLIST_PAYLOAD_BYTES) {
    return fail(413, 'payload too large');
  }

  let json: unknown;
  try {
    json = rawText.length > 0 ? JSON.parse(rawText) : null;
  } catch {
    return fail(400, 'invalid JSON');
  }

  // MEASURED, not hardcoded, and measured HERE rather than trusted from the client. The browser
  // classifies as somebody types so it can offer the right thing; this recomputes it so a caller
  // cannot enrol a number for an area it does not live in.
  const { ids: sparseRegionIds } = await measureSparseRegionIds();

  const parsed = parseWaitlistBody(json, sparseRegionIds);
  if (!parsed.ok) return failValidation(parsed.errors);

  const result = await addToWaitlist(parsed.entry);
  if (result.outcome === 'error') return fail(500, 'could not save that, please try again');

  // 'added' and 'already_waiting' are the SAME response on purpose. Telling a caller which one
  // happened would answer "is this number already on the list for this area?" for any number
  // somebody cared to type — the same oracle the signup route refuses to build. See
  // app/api/sms/signup/route.ts step 7 and consent-copy.ts's Q5 note.
  return NextResponse.json({ ok: true }, { status: 200 });
}

export const POST = withObservedRoute(smsWaitlistPost, { tags: { route: 'api/sms/waitlist' } });
