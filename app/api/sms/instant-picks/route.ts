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
// The throttle counters, and — only once every gate in lib/sms/instant-picks-send.ts passes — one
// `sms_send_log` row recording the text that went out. Nothing else. In particular THE LIST IS
// STILL NEVER PERSISTED: the result is serialised to the caller and dropped, and the link in the
// text reopens this page so the parent presses the button again (Jon's D2 ruling, L1).
//
// ⚠ THE `sms_send_log` ROW IS WRITTEN UNDER A NEW `send_type = 'instant_picks'`, AND THAT VALUE IS
// DELIBERATELY ABSENT FROM `findLastWeek`'s IN-LIST (lib/sms/preferences.ts). That discrimination
// is what makes an audit row safe here: the "Last Friday" panel this button sits INSIDE reads that
// table, and a press surfacing there would show a parent their own request as though it were a
// text we had decided to send them — and would land in PRD §6's send metrics as a different kind
// of message than it is. The row also carries `picks_snapshot` NULL, because widening 0035's CHECK
// to allow one would silently break the weekly novelty filter. Both are asserted in
// tests/sms/instant_picks_send_log_invariants.test.ts.
//
// ═══ 🔴 THE SEND IS LIVE IN PRODUCTION, AND IT IS GATED ON CONFIRMED CONSENT ═══
// This block used to say the send "cannot, in any environment" happen. That stopped being true on
// 2026-09-14 (consent v8 + INSTANT_PICKS_SMS_SEND_ENABLED=true). `sendInstantPicksText` refuses
// unless the flag is on, the subscriber is `active` WITH a recorded JOIN confirmation, their
// consent wording is v8+, and the throttle allows it — see lib/sms/instant-picks-send.ts.
// ⚠ `findInstantPicksSubscriber` below is the LIST rule and deliberately serves `pending` and
// `paused` rows; it is NOT a send gate. Treating it as one is how never-confirmed subscribers were
// texted until the 2026-09-24 CASL fix. Every refusal reports `sendStatus: 'not_eligible'`, which
// the page renders as nothing.
import { NextResponse } from 'next/server';
import { captureAndFlush, withObservedRoute } from '@/lib/observability/route-handler';
import { getServerSearchEngine } from '@/lib/search/server-engine';
import { findInstantPicksSubscriber } from '@/lib/sms/instant-picks-store';
import { checkAndRecordInstantPicks } from '@/lib/sms/instant-picks-throttle';
import { selectInstantPicks, type InstantPick } from '@/lib/sms/instant-picks';
import { clientIpFrom } from '@/lib/sms/client-ip';
import {
  sendInstantPicksText,
  type InstantPicksSendStatus,
} from '@/lib/sms/instant-picks-send';

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
  /**
   * What happened to the TEXT, on the one outcome that attempts one. `'not_eligible'` on every
   * other path, and on every path at all while the send is held — see this file's header.
   *
   * A SEPARATE FIELD FROM `outcome`, NOT A SIXTH VALUE OF IT. `outcome` answers "what is on this
   * weekend" and the page's list rendering is driven entirely by it; the send is a second,
   * independent thing that happened to the same press. Folding them together would mean a
   * throttled TEXT could not be reported without also claiming something about the LIST — and the
   * whole graceful-degradation argument for failing the send closed (plan §4.3) is that the list
   * still renders when the text does not.
   */
  sendStatus: InstantPicksSendStatus;
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
    // DEFAULTS TO SILENT. Every early return — bad request, dead token, throttled page press,
    // engine down — carries this without having to remember to, so a new refusal branch cannot
    // accidentally claim a text was sent or failed.
    sendStatus: 'not_eligible',
    ...body,
  };
  return NextResponse.json(payload, status === 200 ? undefined : { status, headers });
}

export const POST = withObservedRoute(instantPicksPost, {
  tags: { route: 'api/sms/instant-picks' },
});

/**
 * The send half, in the one shape that cannot cost the parent their list.
 *
 * ═══ THE TRY/CATCH IS NOT REDUNDANT, THOUGH IT LOOKS IT ═══
 * `sendInstantPicksText` promises never to throw and is tested to that promise. A PROMISE IS NOT A
 * MECHANISM: it holds until somebody adds a line above its first try block, or a dependency starts
 * throwing on import. The cost of being wrong is not one lost text — it is a 500 where a parent
 * would have had their weekend list, on the request whose PRIMARY job was rendering that list.
 * `withObservedRoute` would turn an escaped rejection into exactly that.
 *
 * So the secondary half of this request is contained: it cannot fail the primary half. That is the
 * same asymmetry the send throttle's fail-closed direction rests on, enforced one layer out.
 */
async function attemptSend(
  outcome: InstantPicksResponseOutcome,
  subscriberId: string,
  request: Request
): Promise<{ status: InstantPicksSendStatus; degraded: boolean; error?: string }> {
  if (outcome !== 'picks') return { status: 'not_eligible', degraded: false };
  try {
    return await sendInstantPicksText(subscriberId, {
      ipAddress: clientIpFrom(request.headers),
    });
  } catch (err) {
    // Reported as degraded so the capture below fires: a module that broke its own never-throws
    // contract is exactly the thing nobody should learn about from a bill or a complaint.
    return {
      status: 'failed',
      degraded: true,
      error: `send threw: ${(err as Error)?.name ?? 'unknown'}`,
    };
  }
}

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

  // ── 5. The text. AFTER the list exists, and ONLY when there is a list. ──────────────────
  //
  // ═══ WHY THE SEND IS LAST, AND WHY ITS FAILURE CANNOT REACH THE RESPONSE'S `outcome` ═══
  // The page render is the primary half of this feature and the text is the takeaway. So the list
  // is fully resolved before anything is dispatched, and `sendInstantPicksText` never throws — a
  // held flag, a refused throttle, a Twilio outage and a lost audit row all degrade to a
  // `sendStatus` beside an unchanged list. That is the same asymmetry the send throttle's
  // fail-closed direction rests on (plan §4.3): failing the text costs one channel of a
  // two-channel answer.
  //
  // ═══ ⚠ ONLY ON `picks`, AND THIS IS A DECISION THE PLAN DID NOT MAKE — FLAGGED, NOT BURIED ═══
  // An `empty` outcome means we genuinely found nothing on this weekend. The message says "more to
  // do with the kids this weekend" and links to a page that would show the same nothing, so
  // sending it would be a false sentence, a wasted ~$0.016, and a text a parent would reasonably
  // call spam — against a disclosed cadence of one message a week and from a toll-free number in
  // carrier review. `unavailable` is worse still: we could not check, so we have nothing to say.
  // The plan's task 7 lists the send states without saying which outcomes attempt one; this is the
  // narrow reading, and it is the reversible direction — widening it later is one condition.
  const send = await attemptSend(result.outcome, resolution.subscriberId, request);

  if (send.degraded) {
    // A limiter that cannot run, a dispatch that failed, or an audit row we could not write. NOT
    // raised for an ordinary throttle refusal — a parent hitting 3/day is the system working, and
    // alerting on it would bury the cases that are not. `error` is built by a module that promises
    // never to put a phone number or a message body in it.
    await captureAndFlush(new Error('sms_instant_picks_send_degraded'), undefined, {
      route: 'api/sms/instant-picks',
      operation: 'send_instant_picks_text',
      sendStatus: send.status,
      detail: send.error ?? 'no detail',
    });
  }

  // THE LIST ITSELF IS STILL NOT PERSISTED. The only row this press can produce is the audit
  // record that a text went out — never what was in it. See this file's header.
  return respond(result.outcome, 200, {
    picks: result.picks,
    areaLabel: result.areaLabel,
    widened: result.widened,
    interestsDropped: result.interestsDropped,
    sendStatus: send.status,
  });
}
