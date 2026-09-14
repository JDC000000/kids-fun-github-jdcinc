// tests/db_connection_acquire_error.test.ts — the pool-acquire failure has a TYPE, and that
// type's discriminator is pinned against pg-pool's own source.
//
// WHY THIS FILE EXISTS. /admin/operating asks for twelve connections concurrently against a
// pool of five, so seven queue by construction and the acquire window expiring is an ordinary
// outcome, not a pathological one. The page's graceful-degradation branch has to be able to
// RECOGNISE that failure — and pg-pool reports it as a bare `new Error(...)` with no code and
// no subclass, so the only available signal is the message string. A string we do not control.
//
// So the first test below reads pg-pool's source and asserts the literal is still there. If a
// dependency bump reworded it, this fails loudly HERE, naming the cause — instead of silently
// turning every saturated page load back into an anonymous 500 in production.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { ConnectionAcquireError } from '../lib/db/client';
import { CONNECTION_ACQUIRE_TIMEOUT_MS, POOL_MAX } from '../lib/db/pool-config';

describe('ConnectionAcquireError', () => {
  it("pg-pool still throws the message our discriminator matches (drift guard)", () => {
    const require = createRequire(import.meta.url);
    const src = readFileSync(require.resolve('pg-pool'), 'utf8');
    expect(
      src.includes('timeout exceeded when trying to connect'),
      'pg-pool reworded its connect-timeout error — update ConnectionAcquireError to match'
    ).toBe(true);
  });

  it('types the acquire timeout, and says which window and which pool size', () => {
    const err = new ConnectionAcquireError(new Error('timeout exceeded when trying to connect'));
    expect(err).toBeInstanceOf(ConnectionAcquireError);
    expect(err.timedOut).toBe(true);
    expect(err.timeoutMs).toBe(CONNECTION_ACQUIRE_TIMEOUT_MS);
    expect(err.message).toContain(String(CONNECTION_ACQUIRE_TIMEOUT_MS));
    expect(err.message).toContain(String(POOL_MAX));
  });

  // "The pool is busy" and "the database is unreachable" both land here, and they are not the
  // same news. Only the first is the expected-under-load case the page degrades for.
  it('does NOT claim a timeout for an unrelated connection fault, and keeps the cause', () => {
    const cause = new Error('getaddrinfo ENOTFOUND db.example.invalid');
    const err = new ConnectionAcquireError(cause);
    expect(err.timedOut).toBe(false);
    expect(err.message).toContain('ENOTFOUND');
    expect(err.cause).toBe(cause);
  });
});
