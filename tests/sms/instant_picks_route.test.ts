// tests/sms/instant_picks_route.test.ts — what POST /api/sms/instant-picks does in each state.
//
// The store, the throttle and the engine seam are MOCKED: what is under test is the ROUTE's
// decisions — what it asks, in which order, what it refuses, what it says, and above all WHAT IT
// DOES NOT WRITE. No database, no catalogue.
//
// Every module mocked here is one the route imports, so this file never constructs a pool and
// stays in the `unit` lane (vitest.workspace.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/sms/instant-picks-store', () => ({ findInstantPicksSubscriber: vi.fn() }));
vi.mock('@/lib/sms/instant-picks-throttle', () => ({ checkAndRecordInstantPicks: vi.fn() }));
vi.mock('@/lib/search/server-engine', () => ({ getServerSearchEngine: vi.fn() }));
vi.mock('@/lib/sms/instant-picks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/sms/instant-picks')>()),
  selectInstantPicks: vi.fn(),
}));
// The send-log writer is mocked so a call to it would be VISIBLE rather than a database error.
// The route must never reach it DIRECTLY — see §NEVER PERSISTS below.
vi.mock('@/lib/sms/send-log', () => ({ recordSmsSend: vi.fn() }));
// The SEND PATH is mocked because it is a separate unit with its own suite
// (tests/sms/instant_picks_send.test.ts). What is under test HERE is the route's contract with
// it: when it is called, with what, and what the response says about the answer.
vi.mock('@/lib/sms/instant-picks-send', () => ({ sendInstantPicksText: vi.fn() }));
vi.mock('@/lib/observability/route-handler', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/observability/route-handler')>()),
  captureAndFlush: vi.fn(async () => {}),
}));

import { POST } from '@/app/api/sms/instant-picks/route';
import { findInstantPicksSubscriber } from '@/lib/sms/instant-picks-store';
import { checkAndRecordInstantPicks } from '@/lib/sms/instant-picks-throttle';
import { getServerSearchEngine } from '@/lib/search/server-engine';
import { selectInstantPicks } from '@/lib/sms/instant-picks';
import { recordSmsSend } from '@/lib/sms/send-log';
import { sendInstantPicksText } from '@/lib/sms/instant-picks-send';
import { captureAndFlush } from '@/lib/observability/route-handler';
import type { SearchEngine } from '@/lib/search/engine';

const findMock = vi.mocked(findInstantPicksSubscriber);
const throttleMock = vi.mocked(checkAndRecordInstantPicks);
const engineMock = vi.mocked(getServerSearchEngine);
const selectMock = vi.mocked(selectInstantPicks);
const sendLogMock = vi.mocked(recordSmsSend);
const sendMock = vi.mocked(sendInstantPicksText);
const captureMock = vi.mocked(captureAndFlush);

const TOKEN = 'a'.repeat(43); // a plausible preferences token width
const SUBSCRIBER_ID = '11111111-2222-3333-4444-555555555555';

function post(body: unknown = { token: TOKEN }, headers: Record<string, string> = {}): Request {
  return new Request('https://kidsfun.example/api/sms/instant-picks', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const PICK = {
  occurrenceId: 'occ-1',
  rank: 1,
  activityName: 'Splash Time',
  venueName: 'Trout Lake Community Centre',
  href: '/activity/occ-1',
};

beforeEach(() => {
  findMock.mockResolvedValue({
    outcome: 'found',
    subscriberId: SUBSCRIBER_ID,
    subscriber: { postalCode: 'V5L 1A1', birthYears: [2018] },
  });
  throttleMock.mockResolvedValue({
    allowed: true, reason: null, retryAfterSeconds: 0, degraded: false,
  });
  engineMock.mockResolvedValue({} as SearchEngine);
  selectMock.mockReturnValue({
    outcome: 'picks',
    picks: [PICK],
    areaLabel: 'Vancouver',
    emptyReason: null,
    widened: false,
    interestsDropped: false,
  });
  // THE DEFAULT IS THE HELD STATE, because that is what every deployment is in today: the flag is
  // off and no subscriber is on consent v8, so no send is attempted and nothing is said about one.
  sendMock.mockResolvedValue({ status: 'not_eligible', segments: 0, degraded: false });
});
afterEach(() => {
  vi.clearAllMocks();
});

// ═════════════════════════════════════════════════════════════════════════════
// §NEVER PERSISTS — the second of the plan's two named risks, at the route layer.
// ═════════════════════════════════════════════════════════════════════════════
describe('instant picks route · never writes to sms_send_log', () => {
  it('does not record a send on the picks path', async () => {
    await POST(post());
    expect(sendLogMock).not.toHaveBeenCalled();
  });

  it('does not record a send on the empty path either', async () => {
    // The branch most likely to be wired wrong by copying the cron, which logs an `empty_week` row
    // exactly here. A press on a quiet weekend is not an empty WEEK.
    selectMock.mockReturnValue({
      outcome: 'empty', picks: [], areaLabel: 'Vancouver',
      emptyReason: 'nothing_reached', widened: true, interestsDropped: false,
    });
    await POST(post());
    expect(sendLogMock).not.toHaveBeenCalled();
  });

  it('does not record a send on any of the refusal paths', async () => {
    throttleMock.mockResolvedValue({
      allowed: false, reason: 'interval', retryAfterSeconds: 42, degraded: false,
    });
    await POST(post());

    findMock.mockResolvedValue({ outcome: 'not_found' });
    await POST(post());

    expect(sendLogMock).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// §THE PAUSE TRAP, at the route layer. The wrapper's own guards are proven in
// tests/sms/instant_picks.test.ts; this proves the ROUTE cannot reintroduce it — it must not
// read a subscriber's empty-week counter, and must not act on a pause decision.
// ═════════════════════════════════════════════════════════════════════════════
describe('instant picks route · cannot pause anybody', () => {
  it('never hands the selector a non-zero empty-week counter', async () => {
    await POST(post());
    const passed = selectMock.mock.calls[0][0];
    // The route passes the store's subscriber straight through, and that object has no such field
    // by construction (`findInstantPicksSubscriber` does not SELECT the column). If somebody adds
    // it to either, this catches it before the wrapper's hard zero is the only thing standing.
    expect(passed.subscriber).not.toHaveProperty('consecutiveEmptyWeeks');
    expect(JSON.stringify(passed.subscriber)).not.toMatch(/empty.?week/i);
  });

  it('ignores a pause flag even if the selection result grew one', async () => {
    selectMock.mockReturnValue({
      outcome: 'empty', picks: [], areaLabel: 'Vancouver',
      emptyReason: 'nothing_reached', widened: false, interestsDropped: false,
      // @ts-expect-error — deliberately not part of InstantPicks. This is the shape a careless
      // widening of the wrapper's return type would produce; the route must not relay it.
      shouldPause: true,
    });
    const res = await POST(post());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(JSON.stringify(body)).not.toMatch(/pause/i);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// §THE FOUR STATES the page has copy for.
// ═════════════════════════════════════════════════════════════════════════════
describe('instant picks route · results', () => {
  it('returns the picks and the area label', async () => {
    const res = await POST(post());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.outcome).toBe('picks');
    expect(body.picks).toEqual([PICK]);
    expect(body.areaLabel).toBe('Vancouver');
  });

  it('relays the selector’s own degradation flags', async () => {
    selectMock.mockReturnValue({
      outcome: 'picks', picks: [PICK], areaLabel: 'Vancouver',
      emptyReason: null, widened: true, interestsDropped: true,
    });
    const body = await (await POST(post())).json();
    expect(body.widened).toBe(true);
    expect(body.interestsDropped).toBe(true);
  });

  it('names nothing about the subscriber — no token echo, no id, no postal code', async () => {
    const body = await (await POST(post())).json();
    const serialised = JSON.stringify(body);
    expect(serialised).not.toContain(TOKEN);
    expect(serialised).not.toContain(SUBSCRIBER_ID);
    expect(serialised).not.toContain('V5L');
  });
});

describe('instant picks route · nothing right now', () => {
  it('is a 200 with outcome empty — an honest answer, not an error', async () => {
    selectMock.mockReturnValue({
      outcome: 'empty', picks: [], areaLabel: 'Vancouver',
      emptyReason: 'none_showable', widened: true, interestsDropped: false,
    });
    const res = await POST(post());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.outcome).toBe('empty');
    expect(body.picks).toEqual([]);
  });
});

describe('instant picks route · cannot check', () => {
  it('503s when the engine will not load, and never calls it "empty"', async () => {
    // `getServerSearchEngine` returns null rather than an empty engine precisely so this cannot be
    // rendered as "nothing this weekend". The two are different claims about the catalogue.
    engineMock.mockResolvedValue(null);
    const res = await POST(post());
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body.outcome).toBe('unavailable');
    expect(body.ok).toBe(false);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('503s on an un-geocodable postal code, and tells an operator', async () => {
    selectMock.mockReturnValue({
      outcome: 'unavailable', picks: [], areaLabel: null,
      emptyReason: null, widened: false, interestsDropped: false,
    });
    const res = await POST(post());

    expect(res.status).toBe(503);
    expect((await res.json()).outcome).toBe('unavailable');
    expect(captureMock).toHaveBeenCalled();
  });
});

describe('instant picks route · slow down', () => {
  it('429s with Retry-After and no hint about which limit refused', async () => {
    throttleMock.mockResolvedValue({
      allowed: false, reason: 'daily', retryAfterSeconds: 3600, degraded: false,
    });
    const res = await POST(post());
    const body = await res.json();

    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('3600');
    expect(body.outcome).toBe('throttled');
    // The limits are ours; the wait is theirs. Same posture as the signup route.
    expect(JSON.stringify(body)).not.toMatch(/daily|per day|20|interval/i);
  });

  it('does not run the search when refused — the work is what is being protected', async () => {
    throttleMock.mockResolvedValue({
      allowed: false, reason: 'interval', retryAfterSeconds: 42, degraded: false,
    });
    await POST(post());
    expect(engineMock).not.toHaveBeenCalled();
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('alerts when the limiter degraded, but still serves the press', async () => {
    throttleMock.mockResolvedValue({
      allowed: true, reason: null, retryAfterSeconds: 0, degraded: true,
    });
    const res = await POST(post());

    expect(res.status).toBe(200);
    expect(captureMock).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'sms_instant_picks_throttle_degraded' }),
      undefined,
      expect.objectContaining({ route: 'api/sms/instant-picks' })
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// §ORDER AND §TOKEN — who is charged, and what an unknown caller learns.
// ═════════════════════════════════════════════════════════════════════════════
describe('instant picks route · the token is checked BEFORE the limit', () => {
  it('an unknown token does not spend anybody’s budget', async () => {
    findMock.mockResolvedValue({ outcome: 'not_found' });
    const res = await POST(post());

    expect(res.status).toBe(404);
    expect(throttleMock).not.toHaveBeenCalled();
  });

  it('charges the resolved subscriber, not anything from the request', async () => {
    await POST(post());
    expect(throttleMock).toHaveBeenCalledWith(SUBSCRIBER_ID);
  });
});

describe('instant picks route · malformed input', () => {
  it.each([
    ['no token', {}],
    ['a token that is too short', { token: 'abc' }],
    ['a token that is too long', { token: 'a'.repeat(257) }],
    ['a non-string token', { token: 12345 }],
  ])('rejects %s without touching the database', async (_label, body) => {
    const res = await POST(post(body));
    expect(res.status).toBe(404);
    expect(findMock).not.toHaveBeenCalled();
  });

  it('rejects a body that is not JSON, and labels it as the caller’s fault', async () => {
    const res = await POST(post('not json at all'));
    expect(res.status).toBe(400);
    // NOT `not_found`: the page posts a fixed shape, so a malformed body in the logs is somebody
    // else's script and must not hide among ordinary dead links.
    expect((await res.json()).outcome).toBe('bad_request');
    expect(findMock).not.toHaveBeenCalled();
  });

  it('rejects an oversized payload by its declared length alone', async () => {
    const res = await POST(post({ token: TOKEN }, { 'content-length': '999999' }));
    expect(res.status).toBe(413);
    expect(findMock).not.toHaveBeenCalled();
  });

  it('rejects an oversized payload whose declared length lied', async () => {
    const res = await POST(post({ token: TOKEN, junk: 'x'.repeat(4096) }));
    expect(res.status).toBe(413);
    expect(findMock).not.toHaveBeenCalled();
  });

  it('says the same thing for a dead token as for a stopped subscriber', async () => {
    // `findInstantPicksSubscriber` collapses both into `not_found`. Distinguishing them here would
    // tell a prober which guess was close, and tell anyone holding an old link whether that person
    // is still a subscriber — a fact about somebody else.
    findMock.mockResolvedValue({ outcome: 'not_found' });
    const a = await POST(post());
    const aBody = await a.json();

    findMock.mockResolvedValue({ outcome: 'not_found' });
    const b = await POST(post({ token: 'b'.repeat(43) }));
    const bBody = await b.json();

    expect(a.status).toBe(b.status);
    expect(aBody).toEqual(bBody);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// §THE SEND — plan v2.0 tasks 5 and 7, at the route layer.
// ═════════════════════════════════════════════════════════════════════════════
describe('instant picks route · 🔴 while the send is HELD, this route behaves exactly as before', () => {
  it('reports not_eligible and says nothing else about a text', async () => {
    const body = await (await POST(post())).json();
    expect(body.sendStatus).toBe('not_eligible');
    // The component renders nothing for that status, so the page is byte-identical to the
    // page-only build. Asserted here because "the UI happens to ignore it" is a weaker guarantee
    // than "the server says nothing happened".
    expect(JSON.stringify(body)).not.toMatch(/sent|throttled|disabled|failed/);
  });

  it('the response still carries every field the page-only build returned', async () => {
    // A regression here would break the live page, which is deployed and working.
    const body = await (await POST(post())).json();
    expect(Object.keys(body).sort()).toEqual([
      'areaLabel', 'interestsDropped', 'ok', 'outcome', 'picks', 'sendStatus', 'widened',
    ]);
  });

  it('raises nothing to Sentry when the feature is simply held', async () => {
    // 'not_eligible' is the normal state, not an incident. Alerting on it would fire on every
    // press in every environment and bury the states that matter.
    await POST(post());
    expect(captureMock).not.toHaveBeenCalled();
  });
});

describe('instant picks route · when the send path is reached', () => {
  it('attempts a send only on the picks outcome, and passes the caller’s IP', async () => {
    await POST(post({ token: TOKEN }, { 'x-real-ip': '198.51.100.9' }));
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith(SUBSCRIBER_ID, { ipAddress: '198.51.100.9' });
  });

  it('does NOT attempt a send when the weekend is empty', async () => {
    // ⚠ A DECISION THE PLAN DID NOT MAKE, asserted so it is visible rather than incidental. The
    // message says "more to do with the kids this weekend" and links to a page that would show the
    // same nothing — a false sentence, a wasted ~$0.016, and a text a parent would call spam.
    selectMock.mockReturnValue({
      outcome: 'empty', picks: [], areaLabel: 'Vancouver',
      emptyReason: 'none_showable', widened: false, interestsDropped: false,
    });
    const body = await (await POST(post())).json();
    expect(sendMock).not.toHaveBeenCalled();
    expect(body.sendStatus).toBe('not_eligible');
  });

  it('does NOT attempt a send when we could not check at all', async () => {
    selectMock.mockReturnValue({
      outcome: 'unavailable', picks: [], areaLabel: null,
      emptyReason: null, widened: false, interestsDropped: false,
    });
    await POST(post());
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('does NOT attempt a send when the PAGE throttle already refused', async () => {
    // The press never produced a list, so there is nothing to be a takeaway from.
    throttleMock.mockResolvedValue({
      allowed: false, reason: 'interval', retryAfterSeconds: 42, degraded: false,
    });
    await POST(post());
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('does NOT attempt a send for a token that resolved to nobody', async () => {
    findMock.mockResolvedValue({ outcome: 'not_found' });
    await POST(post());
    expect(sendMock).not.toHaveBeenCalled();
  });

  it.each(['sent', 'throttled', 'failed', 'disabled'] as const)(
    'relays sendStatus %s beside an unchanged list',
    async (status) => {
      sendMock.mockResolvedValue({ status, segments: 1, degraded: false });
      const res = await POST(post());
      const body = await res.json();

      // THE LIST IS UNTOUCHED BY THE SEND OUTCOME. This is the whole reason the send throttle is
      // allowed to fail closed: failing the text costs one channel of a two-channel answer.
      expect(res.status).toBe(200);
      expect(body.outcome).toBe('picks');
      expect(body.picks).toEqual([PICK]);
      expect(body.sendStatus).toBe(status);
    }
  );

  it('raises to Sentry when the send reports it could not do its job', async () => {
    sendMock.mockResolvedValue({
      status: 'throttled', segments: 1, degraded: true,
      error: 'send throttle could not run; refused',
    });
    await POST(post());
    expect(captureMock).toHaveBeenCalledTimes(1);
    expect(captureMock.mock.calls[0][0]).toBeInstanceOf(Error);
    expect((captureMock.mock.calls[0][0] as Error).message).toBe('sms_instant_picks_send_degraded');
  });

  it('does NOT raise for an ordinary throttle refusal — that is the system working', async () => {
    sendMock.mockResolvedValue({ status: 'throttled', segments: 1, degraded: false });
    await POST(post());
    expect(captureMock).not.toHaveBeenCalled();
  });

  it('a send that somehow rejected does not take the page down with it', async () => {
    // The module promises never to throw, and is tested to it. A PROMISE IS NOT A MECHANISM — the
    // route contains it anyway, because `withObservedRoute` would turn an escaped rejection into a
    // 500 on the request whose PRIMARY job was rendering this parent's weekend list.
    sendMock.mockRejectedValue(new Error('unexpected'));
    const res = await POST(post());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.outcome).toBe('picks');
    expect(body.picks).toEqual([PICK]);
    expect(body.sendStatus).toBe('failed');
    // ...and it is reported, because a broken never-throws contract is an incident.
    expect(captureMock).toHaveBeenCalledTimes(1);
  });

  it('still never calls the send-log writer directly', async () => {
    sendMock.mockResolvedValue({ status: 'sent', segments: 1, degraded: false });
    await POST(post());
    expect(sendLogMock).not.toHaveBeenCalled();
  });
});
