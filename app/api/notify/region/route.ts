// app/api/notify/region/route.ts — POST endpoint for the "email me when this area is live"
// capture on /search's sparse-coverage notice (lib/search/coverage.ts).
//
// Mirrors app/api/corrections/route.ts: hand validation (zod is not a dependency), an early +
// hard payload cap, and a small typed body. It differs from that route in exactly one place,
// deliberately — see the write step below.
//
// The area vocabulary is REGION_CHIPS (app/search/_lib/params.ts), the same list the rail
// renders and `parseSearchState` accepts, imported rather than restated for the same reason
// app/api/search/route.ts imports AGE_ORDER/WHEN_OPTIONS: a second copy would let the API
// accept an area the UI can never offer, or reject one it does.
import { NextResponse } from 'next/server';
import { REGION_CHIPS } from '@/app/search/_lib/params';
import {
  MAX_NOTIFY_PAYLOAD_BYTES,
  parseRegionNotifyBody,
  writeRegionNotifySignup,
} from '@/lib/notify/region-signup';
import { captureAndFlush, withObservedRoute } from '@/lib/observability/route-handler';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs'; // pg pool needs the Node runtime, not edge.

const ALLOWED_REGION_CHIP_IDS = REGION_CHIPS.map((c) => c.id);

export const POST = withObservedRoute(notifyRegionPost, { tags: { route: 'api/notify/region' } });

async function notifyRegionPost(request: Request): Promise<NextResponse> {
  // 1. Cheap early reject on declared size before reading the body.
  const declared = Number(request.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > MAX_NOTIFY_PAYLOAD_BYTES) {
    return NextResponse.json({ ok: false, error: 'payload too large' }, { status: 413 });
  }

  // 2. Read + hard-cap the actual body (content-length can be absent or lie).
  const rawText = await request.text();
  if (Buffer.byteLength(rawText, 'utf8') > MAX_NOTIFY_PAYLOAD_BYTES) {
    return NextResponse.json({ ok: false, error: 'payload too large' }, { status: 413 });
  }

  // 3. Parse JSON.
  let json: unknown;
  try {
    json = rawText.length > 0 ? JSON.parse(rawText) : null;
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid JSON' }, { status: 400 });
  }

  // 4. Validate against the rail's own area vocabulary + an email shape.
  const parsed = parseRegionNotifyBody(json, ALLOWED_REGION_CHIP_IDS);
  if (!parsed.ok) {
    return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 });
  }

  // 5. Persist. A FAILED WRITE IS A FAILED REQUEST — the one deliberate difference from
  //    /api/corrections, which returns 202 on a lost write because its UI's optimistic "thanks"
  //    promises nothing. This form promises an email. Answering "thanks, we'll let you know"
  //    over a row that does not exist would be the same defect the honest empty state this form
  //    sits inside was built to end, so a write failure surfaces as a real error the form shows.
  const result = await writeRegionNotifySignup(parsed.value);
  if (!result.ok) {
    await captureAndFlush(new Error('region_notify_signup_write_failed'), undefined, {
      route: 'api/notify/region',
      operation: 'write_region_notify_signup',
    });
    return NextResponse.json({ ok: false, error: 'could not save that just now' }, { status: 503 });
  }

  return NextResponse.json({ ok: true }, { status: 201 });
}
