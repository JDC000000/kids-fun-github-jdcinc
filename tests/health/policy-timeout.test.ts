// tests/health/policy-timeout.test.ts — H4: politeFetch request deadline + bounded retry.
//
// THE BUG BEING PROVEN FIXED. On 2026-07-30 the Vancouver ActiveNet ingest job hung with
// status='running' for 8+ minutes, zero records, zero errors: politeFetch called global
// fetch() with no AbortController and no deadline, so a connection that was accepted but
// never answered produced a promise that never settled. The 403/429 breaker never got a
// status to react to and finishCheckRun() was never reached.
//
// These tests therefore assert on ELAPSED TIME, not just on the existence of a constant.
// A test that only checked `DEFAULT_REQUEST_TIMEOUT_MS === 15000` would have passed
// against the broken code.
//
// Lives in its own file (routed to the fast `unit` lane) rather than in policy.test.ts,
// which vitest.workspace.ts pins to the serial db lane — these are real-timer tests and
// do not belong on the critical path.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  politeFetch,
  clearPolicyState,
  PolicyViolationError,
  FetchTimeoutError,
  DEFAULT_REQUEST_TIMEOUT_MS,
  MIN_REQUEST_TIMEOUT_MS,
  MAX_REQUEST_TIMEOUT_MS,
  MAX_REQUEST_ATTEMPTS,
  RETRY_BACKOFF_MS,
  MAX_DEFAULT_FETCH_WALL_CLOCK_MS,
  resolveTimeoutMs,
  USER_AGENT,
} from '../../worker/health/policy';

afterEach(() => {
  clearPolicyState();
  vi.restoreAllMocks();
});

/** A fetch that never settles AND ignores AbortSignal — the harshest case, and the exact
 *  shape of the production hang: nothing about the transport rescues us. */
const neverResolves: typeof fetch = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;

/** A fetch that never settles but DOES honour AbortSignal, like real undici. */
const neverResolvesButAbortable: typeof fetch = ((_url: unknown, init?: { signal?: AbortSignal }) =>
  new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) return;
    if (signal.aborted) {
      reject(signal.reason ?? new DOMException('aborted', 'AbortError'));
      return;
    }
    signal.addEventListener(
      'abort',
      () => reject(signal.reason ?? new DOMException('aborted', 'AbortError')),
      { once: true }
    );
  })) as unknown as typeof fetch;

/** No-op sleep so the retry backoff does not add real seconds to the suite. */
const NO_SLEEP = { sleepImpl: async (): Promise<void> => undefined };

/**
 * The shortest deadline a caller can actually obtain: resolveTimeoutMs clamps anything
 * lower UP to MIN_REQUEST_TIMEOUT_MS, so asking for 50ms silently gets 1000ms. Naming it
 * keeps the wall-clock assertions below honest — an earlier draft asserted against a
 * requested 150ms while really measuring the clamped 1000ms.
 */
const SHORTEST_REAL_DEADLINE_MS = MIN_REQUEST_TIMEOUT_MS;

/** Worst case for a fully-exhausted call at that deadline, plus slack for a loaded CI box. */
const SHORTEST_WORST_CASE_MS = SHORTEST_REAL_DEADLINE_MS * MAX_REQUEST_ATTEMPTS + 3_000;

/**
 * Drive a call that is expected to time out on a FAKE clock and return the rejection.
 *
 * Used for the behavioural assertions (how many attempts, what got aborted, what the
 * breaker recorded) once the real-clock tests above have already established that the
 * deadline genuinely fires in real time. Keeps this file off the suite's critical path
 * without weakening what is proven.
 */
async function timeoutOf(run: () => Promise<unknown>): Promise<unknown> {
  vi.useFakeTimers();
  try {
    const settled = run().then(
      () => {
        throw new Error('expected politeFetch to reject with a timeout, but it resolved');
      },
      (err: unknown) => err
    );
    await vi.advanceTimersByTimeAsync(
      DEFAULT_REQUEST_TIMEOUT_MS * MAX_REQUEST_ATTEMPTS + RETRY_BACKOFF_MS + 1_000
    );
    return await settled;
  } finally {
    vi.useRealTimers();
  }
}

describe('politeFetch request deadline (H4 — the production hang)', () => {
  // ── real clock: the two headline cases ────────────────────────────────────────────
  // These deliberately spend real wall-clock time. A fake-timer test cannot catch a
  // regression where the deadline is never scheduled on the real event loop at all,
  // which is the failure mode being fixed.

  it('a fetch that never resolves AND ignores AbortSignal still fails, bounded (real clock)', async () => {
    // The harshest case and the exact production shape: nothing about the transport
    // rescues us. Before this fix this call never settled — the test would hang here.
    const started = Date.now();

    await expect(
      politeFetch('hang-ignores-signal', 'https://example.org/hang', {}, {
        fetchImpl: neverResolves,
        timeoutMs: SHORTEST_REAL_DEADLINE_MS,
        ...NO_SLEEP,
      })
    ).rejects.toBeInstanceOf(FetchTimeoutError);

    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(SHORTEST_REAL_DEADLINE_MS);
    expect(elapsed).toBeLessThan(SHORTEST_WORST_CASE_MS);
  });

  it('a fetch that hangs but honours AbortSignal is aborted and fails, bounded (real clock)', async () => {
    const started = Date.now();

    await expect(
      politeFetch('hang-abortable', 'https://example.org/hang', {}, {
        fetchImpl: neverResolvesButAbortable,
        timeoutMs: SHORTEST_REAL_DEADLINE_MS,
        ...NO_SLEEP,
      })
    ).rejects.toBeInstanceOf(FetchTimeoutError);

    expect(Date.now() - started).toBeLessThan(SHORTEST_WORST_CASE_MS);
  });

  // ── fake clock: behavioural detail ────────────────────────────────────────────────

  it('really does abort the underlying request rather than just abandoning it', async () => {
    let abortedWith: string | undefined;
    const impl = ((_url: unknown, init?: { signal?: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          abortedWith = (init.signal?.reason as { name?: string } | undefined)?.name;
          reject(init.signal?.reason);
        });
      })) as unknown as typeof fetch;

    const err = await timeoutOf(() =>
      politeFetch('abort-observed', 'https://example.org/hang', {}, { fetchImpl: impl, ...NO_SLEEP })
    );
    expect(err).toBeInstanceOf(FetchTimeoutError);

    // The socket is torn down, not merely orphaned — otherwise we would leak a connection
    // per hang and the "bounded" guarantee would only apply to our own promise.
    expect(abortedWith).toBe('TimeoutError');
  });

  it('retries a timeout exactly once, then gives up (bounded, never a tight loop)', async () => {
    const impl = vi.fn(neverResolves);
    const err = await timeoutOf(() =>
      politeFetch('retry-count', 'https://example.org/hang', {}, { fetchImpl: impl, ...NO_SLEEP })
    );
    expect(err).toBeInstanceOf(FetchTimeoutError);
    expect(impl).toHaveBeenCalledTimes(MAX_REQUEST_ATTEMPTS);
    expect(MAX_REQUEST_ATTEMPTS).toBe(2);
  });

  it('a transient hang that clears on the retry succeeds — the reason a retry exists', async () => {
    let call = 0;
    const impl = ((_url: unknown, init?: { signal?: AbortSignal }) => {
      call += 1;
      if (call === 1) return neverResolvesButAbortable(_url as string, init as RequestInit);
      return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
    }) as unknown as typeof fetch;

    const res = await politeFetch('transient', 'https://example.org/x', {}, {
      fetchImpl: impl,
      timeoutMs: SHORTEST_REAL_DEADLINE_MS,
      ...NO_SLEEP,
    });
    expect(res.status).toBe(200);
    expect(call).toBe(2);
  });

  it('does not retry, and does not blame the source, when the CALLER aborts', async () => {
    // The seasonal watcher passes its own 10s AbortSignal. Composing (not overwriting) it
    // is what keeps that adapter's existing timeout alive; treating its deliberate
    // cancellation as a source fault would wrongly trip the circuit breaker.
    const controller = new AbortController();
    const impl = vi.fn(neverResolvesButAbortable);
    setTimeout(() => controller.abort(new DOMException('caller gave up', 'AbortError')), 50);

    await expect(
      politeFetch('caller-abort', 'https://example.org/x', { signal: controller.signal }, {
        fetchImpl: impl,
        timeoutMs: 10_000,
        ...NO_SLEEP,
      })
    ).rejects.toThrow(/caller gave up/);

    expect(impl).toHaveBeenCalledTimes(1); // not retried
    // ...and the next fetch is NOT blocked, because no transport failure was recorded.
    const ok = vi.fn(async () => new Response('', { status: 200 }));
    await expect(
      politeFetch('caller-abort', 'https://example.org/x', {}, { fetchImpl: ok, ...NO_SLEEP })
    ).resolves.toBeDefined();
  });

  it('forwards a composed signal to fetch, preserving the caller signal', async () => {
    let sawSignal = false;
    const impl = (async (_url: unknown, init?: { signal?: AbortSignal }) => {
      sawSignal = init?.signal instanceof AbortSignal;
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;
    await politeFetch('sig', 'https://example.org', {}, { fetchImpl: impl, ...NO_SLEEP });
    expect(sawSignal).toBe(true);
  });
});

describe('live verification against a REAL unresponsive server (real undici, no fetch mock)', () => {
  // Everything above injects a fetchImpl. These two do not: they stand up an actual TCP
  // listener and go through the real global fetch, which is the code path production uses.
  // Hermetic — loopback only, no external host is contacted.

  async function listen(handler: http.RequestListener): Promise<{ url: string; close: () => void }> {
    const server = http.createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return {
      url: `http://127.0.0.1:${port}/`,
      close: () => {
        server.closeAllConnections?.();
        server.close();
      },
    };
  }

  it('a server that accepts the connection and never replies is bounded', async () => {
    // The production failure reproduced literally: the TCP handshake completes and the
    // server then sends nothing, ever. This is what wedged the Vancouver run for 8+ min.
    const { url, close } = await listen(() => {
      /* deliberately never respond */
    });
    try {
      const started = Date.now();
      await expect(
        politeFetch('live-hang', url, {}, { timeoutMs: SHORTEST_REAL_DEADLINE_MS, ...NO_SLEEP })
      ).rejects.toBeInstanceOf(FetchTimeoutError);
      const elapsed = Date.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(SHORTEST_REAL_DEADLINE_MS);
      expect(elapsed).toBeLessThan(SHORTEST_WORST_CASE_MS);
    } finally {
      close();
    }
  });

  it('a server that sends headers and then stalls the body is also bounded', async () => {
    // Why the abort timer is deliberately NOT cleared once the response headers arrive:
    // otherwise this case — headers fine, body never finishes — would still hang forever,
    // just one step later. The deadline covers the whole exchange.
    const { url, close } = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '1000' });
      res.write('partial'); // ...and never end()
    });
    try {
      const started = Date.now();
      const res = await politeFetch('live-stall', url, {}, {
        timeoutMs: SHORTEST_REAL_DEADLINE_MS,
        ...NO_SLEEP,
      });
      expect(res.status).toBe(200); // headers arrived promptly
      await expect(res.text()).rejects.toThrow(); // the stalled body read is cut off
      expect(Date.now() - started).toBeLessThan(SHORTEST_WORST_CASE_MS);
    } finally {
      close();
    }
  });

  it('a healthy server still succeeds normally through the real fetch path', async () => {
    // Guards the obvious regression: a deadline that fires on a perfectly good response.
    const { url, close } = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
    try {
      const res = await politeFetch('live-ok', url, { headers: { accept: 'application/json' } }, NO_SLEEP);
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ ok: true });
    } finally {
      close();
    }
  });
});

describe('a timed-out source trips the existing circuit breaker', () => {
  it('records a transport failure so the NEXT fetch is refused without touching network', async () => {
    // This is the "do not hammer a hanging source every cadence tick" requirement. The
    // breaker previously only understood 403/429 — i.e. it could only react to a response
    // that arrived, which a hang never provides.
    const err = await timeoutOf(() =>
      politeFetch('breaker', 'https://example.org/hang', {}, { fetchImpl: neverResolves, ...NO_SLEEP })
    );
    expect(err).toBeInstanceOf(FetchTimeoutError);

    const next = vi.fn(async () => new Response('', { status: 200 }));
    await expect(
      politeFetch('breaker', 'https://example.org/hang', {}, { fetchImpl: next, ...NO_SLEEP })
    ).rejects.toBeInstanceOf(PolicyViolationError);
    expect(next).not.toHaveBeenCalled();
  });

  it('arms the breaker ONCE per call, not once per attempt', async () => {
    // Two attempts inside one call must count as one failure, or a single bad run would
    // jump the backoff curve two steps.
    const { recordTransportFailure, clearBackoffState, isDisabled } = await import(
      '../../worker/core/politeness'
    );
    clearBackoffState('curve');
    const err = await timeoutOf(() =>
      politeFetch('curve', 'https://example.org/hang', {}, { fetchImpl: neverResolves, ...NO_SLEEP })
    );
    expect(err).toBeInstanceOf(FetchTimeoutError);

    // One failure => 2^1 = 2 minutes. A second, independent failure => 4 minutes.
    const after = recordTransportFailure('curve');
    expect(after.consecutiveFailures).toBe(2);
    expect(isDisabled('curve')).toBe(true);
  });

  it('a successful response clears a timeout-armed backoff, exactly like a 429', async () => {
    const { recordResponse, isDisabled, recordTransportFailure } = await import(
      '../../worker/core/politeness'
    );
    recordTransportFailure('clears');
    expect(isDisabled('clears')).toBe(true);
    recordResponse('clears', 200);
    expect(isDisabled('clears')).toBe(false);
  });
});

describe('the deadline cannot be switched off', () => {
  it('no caller value — including the careless ones — can yield "no deadline"', () => {
    // An adapter author who never thinks about timeouts is exactly how the production
    // hang happened, so the omitted case and the nonsense cases all resolve to a real
    // bound rather than to Infinity/0/undefined.
    expect(resolveTimeoutMs(undefined)).toBe(DEFAULT_REQUEST_TIMEOUT_MS);
    expect(resolveTimeoutMs(Number.NaN)).toBe(DEFAULT_REQUEST_TIMEOUT_MS);
    expect(resolveTimeoutMs(Number.POSITIVE_INFINITY)).toBe(DEFAULT_REQUEST_TIMEOUT_MS);
    expect(resolveTimeoutMs(0)).toBe(MIN_REQUEST_TIMEOUT_MS);
    expect(resolveTimeoutMs(-1)).toBe(MIN_REQUEST_TIMEOUT_MS);
    expect(resolveTimeoutMs(999_999)).toBe(MAX_REQUEST_TIMEOUT_MS);
    expect(resolveTimeoutMs(5_000)).toBe(5_000); // a sane override is respected
  });

  it('omitting timeoutMs entirely still arms the 15s default (fake clock)', async () => {
    // Proves the DEFAULT path is really wired to a deadline — not merely that a constant
    // exists — without spending 30s of wall clock to do it.
    vi.useFakeTimers();
    try {
      const pending = politeFetch('default-armed', 'https://example.org/hang', {}, {
        fetchImpl: neverResolves,
        ...NO_SLEEP,
      });
      const assertion = expect(pending).rejects.toBeInstanceOf(FetchTimeoutError);
      await vi.advanceTimersByTimeAsync(
        DEFAULT_REQUEST_TIMEOUT_MS * MAX_REQUEST_ATTEMPTS + RETRY_BACKOFF_MS + 1_000
      );
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('states a bounded, explicit worst case', () => {
    expect(DEFAULT_REQUEST_TIMEOUT_MS).toBe(15_000);
    expect(MIN_REQUEST_TIMEOUT_MS).toBe(1_000);
    expect(MAX_REQUEST_TIMEOUT_MS).toBe(60_000);
    expect(RETRY_BACKOFF_MS).toBe(2_000);
    // 6s slowest rate-limit floor + 2x15s + 1x2s.
    expect(MAX_DEFAULT_FETCH_WALL_CLOCK_MS).toBe(38_000);
    // The bound must stay comfortably under a minute: the observed incident sat at 8+
    // minutes, and the scheduler ticks every 60s.
    expect(MAX_DEFAULT_FETCH_WALL_CLOCK_MS).toBeLessThan(60_000);
  });
});

describe('non-regression: the pre-H4 contract still holds', () => {
  it('still sends the identified UA + conditional headers under caller headers', async () => {
    let sent: Record<string, string> = {};
    const impl = (async (_url: unknown, init?: { headers?: Record<string, string> }) => {
      sent = init?.headers ?? {};
      return new Response('[]', { status: 200 });
    }) as unknown as typeof fetch;
    await politeFetch('ua', 'https://example.org/feed', { headers: { accept: 'application/json' } }, {
      fetchImpl: impl,
      prevCache: { etag: 'W/"x"' },
      ...NO_SLEEP,
    });
    expect(sent['User-Agent']).toBe(USER_AGENT);
    expect(sent.accept).toBe('application/json');
    expect(sent['If-None-Match']).toBe('W/"x"');
  });

  it('a caller-supplied UA is preserved and NOT duplicated in another casing', async () => {
    // venue_html passes its own lowercase 'user-agent'. Emitting both keys would be
    // ambiguous on the wire and could silently shadow the intended identity.
    let sent: Record<string, string> = {};
    const impl = (async (_url: unknown, init?: { headers?: Record<string, string> }) => {
      sent = init?.headers ?? {};
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;
    await politeFetch('ua2', 'https://example.org', { headers: { 'user-agent': 'CustomBot/9' } }, {
      fetchImpl: impl,
      ...NO_SLEEP,
    });
    expect(sent['user-agent']).toBe('CustomBot/9');
    expect(sent['User-Agent']).toBeUndefined();
    const uaKeys = Object.keys(sent).filter((k) => k.toLowerCase() === 'user-agent');
    expect(uaKeys).toHaveLength(1);
  });

  it('an EMPTY caller User-Agent does not disable bot identification (QA H4-B)', async () => {
    // Treating any UA KEY as "the caller owns this" let `{'user-agent': ''}` delete the
    // seam's default and send the crawler out unidentified — the single thing the
    // politeness contract is least allowed to get wrong. An empty value now means
    // "no UA supplied", so the identified default still applies.
    for (const empty of ['', '   ']) {
      let sent: Record<string, string> = {};
      const impl = (async (_url: unknown, init?: { headers?: Record<string, string> }) => {
        sent = init?.headers ?? {};
        return new Response('', { status: 200 });
      }) as unknown as typeof fetch;

      await politeFetch(`empty-ua-${empty.length}`, 'https://example.org', {
        headers: { 'user-agent': empty },
      }, { fetchImpl: impl, ...NO_SLEEP });

      const uaKeys = Object.keys(sent).filter((k) => k.toLowerCase() === 'user-agent');
      expect(uaKeys, 'exactly one UA key on the wire').toHaveLength(1);
      expect(sent[uaKeys[0]]).toBe(USER_AGENT);
      expect(sent[uaKeys[0]]).toMatch(/KidsFunBot/i);
    }
  });

  it('a non-timeout transport error still propagates untouched (unchanged behaviour)', async () => {
    const boom = new TypeError('fetch failed: ECONNREFUSED');
    const impl = vi.fn(async () => {
      throw boom;
    }) as unknown as typeof fetch;
    await expect(
      politeFetch('econn', 'https://example.org', {}, { fetchImpl: impl, ...NO_SLEEP })
    ).rejects.toBe(boom);
    // Not retried, and not reclassified as a timeout.
    expect(impl).toHaveBeenCalledTimes(1);
  });

  it('a 403/429 response is still never retried by the new attempt loop', async () => {
    const impl = vi.fn(async () => new Response('', { status: 429 }));
    const res = await politeFetch('429', 'https://example.org', {}, { fetchImpl: impl, ...NO_SLEEP });
    expect(res.status).toBe(429);
    expect(impl).toHaveBeenCalledTimes(1);
  });
});
