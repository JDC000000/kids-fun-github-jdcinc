// app/api/sms/instant-picks/route.ts — the fuller "what's on this weekend" list, generated on
// demand from the preferences page's "Last Friday" section (Instant Picks plan v1.0).
//
// ═══ POST, NOT GET, FOR THE REASON THE PREFERENCES MUTATION ROUTE GIVES ═══
// The token is the credential, and a GET carrying it in the URL lands in access logs, proxy logs
// and — because /u/[preferencesToken] is the kind of URL a messaging client PREFETCHES for a link
// preview — in whatever a preview fetcher keeps. This endpoint changes no consent state, so a GET
// would not be dangerous the way an unsubscribe-by-prefetch would be; but a POST with the token in
// the BODY is the shape that keeps it out of one more log, and there is no reason to accept that
// cost for a request the page makes with fetch() anyway.
//
// It does mean a press is not cacheable. That is correct: the whole promise is "fresh".
//
// ═══ WHAT THIS ENDPOINT WRITES ═══
// One row, ever, and it is a counter: the throttle's `sms_signup_throttle` upsert.
//
// ⚠ IT MUST NEVER WRITE `sms_send_log`, AND THE REASON IS SPECIFIC RATHER THAN TIDINESS. That
// table is what the "Last Friday" panel this button sits inside READS FROM (`findLastWeek` in
// lib/sms/preferences.ts). A press logged there would appear in that panel as though it were a
// text we had sent, corrupting the exact section this feature was added to, and would land in
// PRD §6's send and click-through metrics as a message that never existed. This file imports no
// send-log writer and no Twilio client; tests/sms/instant_picks_no_persistence.test.ts asserts
// that statically, and tests/sms/instant_picks_route.test.ts asserts it behaviourally.
//
// ═══ AND IT SENDS NOTHING ═══
// Page-only, deliberately. The preferences page carries `MESSAGE_FREQUENCY_DISCLOSURE` — "1 message
// per week, plus a one-time confirmation message" — in its legal block: a carrier disclosure that a
// Toll-Free Verification reviewer checks behaviour against. A "text me this" option here would
// contradict a statement rendered on the same page. That is a compliance decision, not a
// preference; see the copy block in lib/sms/consent-copy.ts before adding any send path.
import { NextResponse } from 'next/server';
import { captureAndFlush, withObservedRoute } from '@/lib/observability/route-handler';
import { getServerSearchEngine } from '@/lib/search/server-engine';
import { findInstantPicksSubscriber } from '@/lib/sms/instant-picks-store';
import { checkAndRecordInstantPicks } from '@/lib/sms/instant-picks-throttle';
import { selectInstantPicks, type InstantPick } from '@/lib/sms/instant-picks';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Smaller than the preferences patch — the only field is a token. */
export const MAX_INSTANT_PICKS_PAYLOAD_BYTES = 2 * 1024;

/**
 * The four states the page has copy for, plus the token failure.
 *
 * `unavailable` COVERS BOTH "the engine would not load" AND "the postal code resolves to nowhere",
 * and collapsing those two IS correct here even though lib/sms/weekly-send.ts keeps its own
 * `geocode_failed` separate. That distinction exists so an OPERATOR can see a subscriber stuck in
 * an un-geocodable state in the run summary; a parent reading a button's response cannot act on
 * the difference between "we could not load the catalogue" and "we cannot place your postal code"
 * — both mean "we could not check, try later". The operator-facing half is not lost: a null engine
 * is captured to Sentry below.
 */
type InstantPicksResponseOutcome =
  | 'picks'
  | 'empty'
  | 'unavailable'
  | 'throttled'
  /** A dead, malformed or refused token. ONE value for all of them — see the checks below. */
  | 'not_found'
  /**
   * The request itself was malformed or oversized.
   *
   * Kept DISTINCT from `not_found` even though the page renders both as "we can't check", because
   * they mean different things to whoever is reading a log: `not_found` is a fact about a token,
   * `bad_request` is a fact about a caller. The page never produces one — it posts a fixed shape —
   * so a `bad_request` in the logs is somebody else's script, and labelling that "not found" would
   * hide it among ordinary dead links.
   */
  | 'bad_request';

interface InstantPicksResponse {
  ok: boolean;
  outcome: InstantPicksResponseOutcome;
  picks: InstantPick[];
  areaLabel: string | null;
  widened: boolean;
  interestsDropped: boolean;
}

function respond(
  outcome: InstantPicksResponseOutcome,
  status: number,
  body: Partial<InstantPicksResponse> = {},
  headers?: Record<string, string>
): NextResponse {
  const payload: InstantPicksResponse = {
    ok: outcome === 'picks' || outcome === 'empty',
    outcome,
    picks: [],
    areaLabel: null,
    widened: false,
    interestsDropped: false,
    ...body,
  };
  return NextResponse.json(payload, status === 200 ? undefined : { status, headers });
}

export const POST = withObservedRoute(instantPicksPost, {
  tags: { route: 'api/sms/instant-picks' },
});

async function instantPicksPost(request: Request): Promise<NextResponse> {
  // ── 1. Payload ceiling, declared and actual — same two checks the preferences route makes. ──
  const declared = Number(request.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > MAX_INSTANT_PICKS_PAYLOAD_BYTES) {
    return respond('bad_request', 413);
  }
  const rawText = await request.text();
  if (Buffer.byteLength(rawText, 'utf8') > MAX_INSTANT_PICKS_PAYLOAD_BYTES) {
    return respond('bad_request', 413);
  }

  let json: unknown;
  try {
    json = rawText.length > 0 ? JSON.parse(rawText) : null;
  } catch {
    return respond('bad_request', 400);
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    return respond('bad_request', 400);
  }
  const token = (json as Record<string, unknown>).token;

  // A syntactically impossible token is rejected before it reaches the database — and produces the
  // SAME outcome as a token that simply is not there, so nothing is learned from the difference.
  // Bounds copied from `resolvePreferences` rather than re-derived, so the two cannot drift.
  if (typeof token !== 'string' || token.length < 16 || token.length > 256) {
    return respond('not_found', 404);
  }

  // ── 2. Who is this. One read, and deliberately NOT the one that loads last week's sends. ──
  const resolution = await findInstantPicksSubscriber(token);
  if (resolution.outcome !== 'found') return respond('not_found', 404);

  // ── 3. Throttle. AFTER the token check, so an unauthenticated prober cannot spend a real
  //    subscriber's daily budget, and BEFORE the search, which is the work being protected. ──
  const throttle = await checkAndRecordInstantPicks(resolution.subscriberId);
  if (throttle.degraded) {
    // NOT a failed request — the press was let through on purpose (fail open; see the module). But
    // a limiter that is silently inert is the same as no limiter, and the ways it gets there —
    // migration 0046 unapplied, SMS_PHONE_HASH_SALT unset, the table unreachable — are all states
    // somebody has to be told about rather than infer from a load graph.
    await captureAndFlush(new Error('sms_instant_picks_throttle_degraded'), undefined, {
      route: 'api/sms/instant-picks',
      operation: 'check_instant_picks_throttle',
    });
  }
  if (!throttle.allowed) {
    // THE BODY DOES NOT SAY WHICH LIMIT REFUSED — same posture as the signup route. `retry-after`
    // is the one thing that varies, and it is a header rather than prose so the page's copy never
    // has to be rewritten when the limits are retuned.
    return respond('throttled', 429, {}, { 'retry-after': String(throttle.retryAfterSeconds) });
  }

  // ── 4. The search. `getServerSearchEngine` returns NULL on a genuine load failure rather than
  //    an empty engine, precisely so this cannot be rendered as "nothing this weekend". ──
  const engine = await getServerSearchEngine();
  if (!engine) {
    await captureAndFlush(new Error('sms_instant_picks_engine_unavailable'), undefined, {
      route: 'api/sms/instant-picks',
      operation: 'get_server_search_engine',
    });
    return respond('unavailable', 503);
  }

  const result = selectInstantPicks({
    engine,
    now: new Date(),
    subscriber: resolution.subscriber,
  });

  if (result.outcome === 'unavailable') {
    // The postal code resolves to no covered municipality. Worth an operator's attention for the
    // reason lib/sms/weekly-send.ts gives — the signup form rejects out-of-area postals, so a row
    // in this state predates that check or the FSA table has moved.
    await captureAndFlush(new Error('sms_instant_picks_geocode_failed'), undefined, {
      route: 'api/sms/instant-picks',
      operation: 'select_instant_picks',
    });
    return respond('unavailable', 503);
  }

  // NOTHING IS PERSISTED FROM HERE. The result is serialised to the caller and dropped: no send
  // log row, no click events minted, no counter moved. See this file's header.
  return respond(result.outcome, 200, {
    picks: result.picks,
    areaLabel: result.areaLabel,
    widened: result.widened,
    interestsDropped: result.interestsDropped,
  });
}
