// app/api/sms/weekly/run/route.ts — POST /api/sms/weekly/run
//
// DRAFT (SMS pivot). The scheduled entrypoint for the Friday send, mirroring
// app/api/email/weekly/run/route.ts almost line for line. Called by the platform's existing
// external scheduler (a CRHQ scheduled agent job — NO new infra; PRD §2.2), which presents a
// shared secret. Also usable ad-hoc for a single subscriber (body { subscriberId }).
//
// AUTH: a bearer / `x-cron-secret` shared secret (SMS_CRON_SECRET), compared in CONSTANT TIME.
// Unconfigured → 503. Fail closed, never open: an unguarded endpoint that dispatches real text
// messages to every subscriber is a materially worse thing to leave open than one that emails.
//
// A SEPARATE SECRET FROM THE EMAIL JOB'S, deliberately (see lib/sms/config.ts). Rotating one must
// not silently disarm the other, and the two have different blast radii.
//
// SAFETY: this route can NEVER send a real text unless SMS_SENDING_ENABLED === 'true'. `dryRun`
// is forced true whenever sending is disabled OR the caller passes { dryRun: true }. There is no
// combination of body parameters that can turn sending on.
//
// PII: the response is sanitised — no phone numbers, no rendered message bodies. Per-subscriber
// status, pick count and segment count only. `SubscriberSendResult` is already built to that
// rule (lib/sms/weekly-send-io.ts), and `sanitize` below is the second, independent barrier:
// this route must not become the place a future field on that type leaks out of.
import { NextResponse } from 'next/server';
import { smsCronSecret, smsSendingEnabled } from '@/lib/sms/config';
import { safeEqual } from '@/lib/sms/safe-compare';
import {
  loadWeeklySmsDeps,
  loadActiveSubscribers,
  sendWeeklySmsBulk,
  sendWeeklySmsForSubscriber,
  type SubscriberSendResult,
} from '@/lib/sms/weekly-send-io';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function presentedSecret(request: Request): string | null {
  const auth = request.headers.get('authorization');
  if (auth && auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return request.headers.get('x-cron-secret');
}

/**
 * The cron gate. Constant-time in the VALUE and in the LENGTH — see lib/sms/safe-compare.ts.
 *
 * THE LENGTH MATTERS MORE HERE than on the signature check: a Twilio signature is a fixed-length
 * digest whose length is public, but the cron secret's is not, and this secret is the only thing
 * between an unauthenticated caller and triggering a live send.
 */
function secretOk(presented: string | null, expected: string): boolean {
  return safeEqual(presented, expected);
}

/**
 * An ALLOWLIST, not a redaction.
 *
 * `sanitize` in the email route strips the two fields it knows are sensitive. This one names the
 * fields that may be returned and drops everything else, because the failure modes are not
 * symmetric: a field added to `SubscriberSendResult` later would pass through a denylist
 * silently, and on this lane the thing that would pass through is a phone number.
 */
function sanitize(r: SubscriberSendResult) {
  return {
    subscriberId: r.subscriberId,
    status: r.status,
    pickCount: r.pickCount,
    segments: r.segments,
    ...(r.degradation ? { degradation: r.degradation } : {}),
    ...(r.unlinkableCount ? { unlinkableCount: r.unlinkableCount } : {}),
    ...(r.novelExcluded ? { novelExcluded: r.novelExcluded } : {}),
    ...(r.error ? { error: r.error } : {}),
  };
}

export async function POST(request: Request): Promise<NextResponse> {
  const expected = smsCronSecret();
  if (!expected) {
    return NextResponse.json(
      { ok: false, error: 'weekly sms trigger not configured' },
      { status: 503 }
    );
  }
  if (!secretOk(presentedSecret(request), expected)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  let body: { subscriberId?: unknown; dryRun?: unknown; limit?: unknown } = {};
  try {
    const raw = await request.text();
    body = raw.length > 0 ? JSON.parse(raw) : {};
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid JSON' }, { status: 400 });
  }

  // A real send requires BOTH the env flag AND that the caller did not force a dry run.
  const dryRun = !smsSendingEnabled() || body.dryRun === true;

  if (typeof body.subscriberId === 'string' && body.subscriberId.trim()) {
    const subscriberId = body.subscriberId.trim();
    // Single-subscriber mode still goes through the same loader, so an ad-hoc run cannot reach a
    // subscriber the bulk job would have excluded (a stopped or purged row — see
    // loadActiveSubscribers' WHERE clause).
    const [deps, candidates] = await Promise.all([loadWeeklySmsDeps(), loadActiveSubscribers()]);
    const found = candidates.find((c) => c.subscriber.id === subscriberId);
    if (!found) {
      // 404, not 400: the id may be perfectly well-formed and simply not be an ACTIVE subscriber.
      // The message does not distinguish "no such row" from "not active" — an authenticated
      // scheduler does not need that, and the distinction is a fact about a phone number.
      return NextResponse.json(
        { ok: false, error: 'no active subscriber with that id' },
        { status: 404 }
      );
    }
    const result = await sendWeeklySmsForSubscriber(found.subscriber, found.phoneNumber, {
      dryRun,
      deps,
    });
    return NextResponse.json({ ok: true, mode: 'single', dryRun, result: sanitize(result) });
  }

  const limit = typeof body.limit === 'number' && body.limit > 0 ? body.limit : undefined;
  const summary = await sendWeeklySmsBulk({ dryRun, limit });
  return NextResponse.json({
    ok: true,
    mode: 'bulk',
    dryRun: summary.dryRun,
    candidates: summary.candidates,
    counts: summary.counts,
    // The week's cost, reported rather than inferred. A copy edit that reintroduces a curly
    // apostrophe triples this number on the same run — see lib/sms/message.ts.
    totalSegments: summary.totalSegments,
    results: summary.results.map(sanitize),
  });
}
