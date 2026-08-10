// tests/search/ttl-cache.test.ts — the two properties of the shared TTL cache that are decided by
// a single line each, are invisible from any caller, and survive no refactor unless something
// fails when they go.
//
// The stampede, rejection-eviction, explicit-0 and bad-env behaviours are all driven end to end
// through the real loaders in tests/search/search-read-model-perf.test.ts (and their per-site
// equivalents for the alias and region caches). This file deliberately does NOT repeat them. It
// covers what those tests cannot reach through a loader: an entry-identity race that needs a load
// left in flight across a TTL rollover, and a wall-clock that moves backwards.
//
// Both were found by independent QA — the identity check was verified to be the only new
// concurrency logic that no existing test killed when it was deleted.

import { beforeEach, describe, expect, it } from 'vitest';
import { TtlPromiseCache } from '../../lib/search/ttl-cache';

/** Unset in every environment; these tests exercise the default TTL, not the env override. */
const UNSET_ENV_VAR = 'KIDS_FUN_TTL_CACHE_TEST_MS';
const TTL = 60_000;

beforeEach(() => {
  delete process.env[UNSET_ENV_VAR];
});

describe('TtlPromiseCache', () => {
  it('a superseded load that rejects LATE does not evict the entry that replaced it', async () => {
    // The hazard, in order: load A is still in flight when the TTL rolls over; a caller starts
    // load B, which becomes the live entry; only THEN does A reject. Without the identity check in
    // the rejection handler, A's `catch` clears the cache slot it no longer owns, and every
    // subsequent request inside B's window reloads — a stampede triggered by a failure that had
    // already been superseded, i.e. worst behaviour at the worst moment.
    const cache = new TtlPromiseCache<string>(UNSET_ENV_VAR, TTL);
    let loads = 0;
    let rejectA: (err: Error) => void = () => {};
    const inFlightA = new Promise<string>((_resolve, reject) => {
      rejectA = reject;
    });

    const a = cache.get(() => {
      loads += 1;
      return inFlightA;
    }, 1_000);
    // Attach the expectation NOW: A's rejection must be observed by its caller (and must not
    // surface as an unhandled rejection) regardless of what the cache does with the entry.
    const aRejected = expect(a).rejects.toThrow('late blip');

    const b = await cache.get(() => {
      loads += 1;
      return Promise.resolve('B');
    }, 1_000 + TTL + 1);
    expect(b).toBe('B');

    rejectA(new Error('late blip'));
    await aRejected;

    const afterLateRejection = await cache.get(() => {
      loads += 1;
      return Promise.resolve('C');
    }, 1_000 + TTL + 2);

    expect(afterLateRejection).toBe('B'); // still B's window — 'C' would mean A cleared B's slot
    expect(loads).toBe(2);
  });

  it('reloads after a BACKWARDS clock jump instead of serving the stale entry indefinitely', async () => {
    // `now - loadedAt < ttl` is true for every negative age, so an NTP step correction or a host
    // suspend/resume used to pin the cached catalogue until real time caught up — potentially far
    // longer than the TTL that is supposed to bound it.
    const cache = new TtlPromiseCache<string>(UNSET_ENV_VAR, TTL);
    let loads = 0;
    const load = () => {
      loads += 1;
      return Promise.resolve(`v${loads}`);
    };

    expect(await cache.get(load, 1_000_000)).toBe('v1');
    expect(await cache.get(load, 1_000)).toBe('v2'); // clock stepped backwards: reload, don't pin
    expect(await cache.get(load, 1_500)).toBe('v2'); // and the new entry caches normally from there
    expect(loads).toBe(2);
  });
});
