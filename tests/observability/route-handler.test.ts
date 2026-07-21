import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the Sentry facade so the tests observe capture/flush behaviour without a real transport.
// vi.hoisted keeps the spies available inside the hoisted vi.mock factory.
const { captureException, flush, withScope } = vi.hoisted(() => ({
  captureException: vi.fn(),
  flush: vi.fn((_timeout?: number) => Promise.resolve(true)),
  withScope: vi.fn((cb: (scope: { setTags: (t: Record<string, string>) => void }) => void) =>
    cb({ setTags: vi.fn() }),
  ),
}));

vi.mock('@sentry/nextjs', () => ({ captureException, flush, withScope }));

import {
  withObservedRoute,
  captureAndFlush,
  DEFAULT_FLUSH_TIMEOUT_MS,
} from '@/lib/observability/route-handler';

beforeEach(() => {
  captureException.mockClear();
  flush.mockClear();
  flush.mockImplementation(() => Promise.resolve(true));
  withScope.mockClear();
});

describe('withObservedRoute', () => {
  it('passes the success path through untouched, with no capture and no flush', async () => {
    const body = { status: 'ok' };
    const wrapped = withObservedRoute(() => Response.json(body));
    const res = await wrapped();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(body);
    expect(captureException).not.toHaveBeenCalled();
    expect(flush).not.toHaveBeenCalled();
  });

  it('captures a thrown error, flushes, and returns a 500 JSON envelope', async () => {
    const boom = new Error('kaboom');
    const wrapped = withObservedRoute(() => {
      throw boom;
    });
    const res = await wrapped();
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: 'internal_server_error' });
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalledWith(boom, expect.objectContaining({ mechanism: expect.any(Object) }));
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledWith(DEFAULT_FLUSH_TIMEOUT_MS);
  });

  it('AWAITS the flush before returning — the response cannot precede the send (the core guarantee)', async () => {
    let releaseFlush: (v: boolean) => void = () => {};
    flush.mockImplementation(() => new Promise<boolean>((resolve) => {
      releaseFlush = resolve;
    }));
    const wrapped = withObservedRoute(() => {
      throw new Error('slow-send');
    });
    let settled = false;
    const p = wrapped().then(() => {
      settled = true;
    });
    // Let all currently-queued microtasks run; the wrapper must still be blocked on flush.
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseFlush(true);
    await p;
    expect(settled).toBe(true);
  });

  it('honours a custom flush timeout', async () => {
    const wrapped = withObservedRoute(
      () => {
        throw new Error('x');
      },
      { flushTimeoutMs: 8000 },
    );
    await wrapped();
    expect(flush).toHaveBeenCalledWith(8000);
  });

  it('re-throws Next.js redirect() control-flow errors WITHOUT capturing or flushing', async () => {
    const redirect = Object.assign(new Error('redirect'), { digest: 'NEXT_REDIRECT;replace;/login;307;' });
    const wrapped = withObservedRoute(() => {
      throw redirect;
    });
    await expect(wrapped()).rejects.toBe(redirect);
    expect(captureException).not.toHaveBeenCalled();
    expect(flush).not.toHaveBeenCalled();
  });

  it('re-throws Next.js notFound() control-flow errors WITHOUT capturing or flushing', async () => {
    const notFound = Object.assign(new Error('nf'), { digest: 'NEXT_NOT_FOUND' });
    const wrapped = withObservedRoute(() => {
      throw notFound;
    });
    await expect(wrapped()).rejects.toBe(notFound);
    expect(captureException).not.toHaveBeenCalled();
    expect(flush).not.toHaveBeenCalled();
  });

  it('forwards handler arguments (request/context) through the wrapper', async () => {
    const seen: unknown[] = [];
    const wrapped = withObservedRoute((...args: unknown[]) => {
      seen.push(...args);
      return Response.json({ ok: true });
    });
    const req = new Request('https://example.test/api/x');
    const ctx = { params: { id: '1' } };
    await wrapped(req, ctx);
    expect(seen).toEqual([req, ctx]);
  });

  it('applies caller-supplied tags via a dedicated Sentry scope', async () => {
    const setTags = vi.fn();
    withScope.mockImplementationOnce((cb: (scope: { setTags: (t: Record<string, string>) => void }) => void) =>
      cb({ setTags }),
    );
    const wrapped = withObservedRoute(
      () => {
        throw new Error('tagged');
      },
      { tags: { route: 'api/health' } },
    );
    await wrapped();
    expect(setTags).toHaveBeenCalledWith({ route: 'api/health' });
  });
});

describe('captureAndFlush', () => {
  it('captures then flushes (order matters: capture is queued before the flush drains it)', async () => {
    const order: string[] = [];
    captureException.mockImplementationOnce(() => {
      order.push('capture');
    });
    flush.mockImplementationOnce(() => {
      order.push('flush');
      return Promise.resolve(true);
    });
    await captureAndFlush(new Error('e'));
    expect(order).toEqual(['capture', 'flush']);
  });
});
