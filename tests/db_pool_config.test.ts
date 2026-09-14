import { describe, expect, it } from 'vitest';
import { poolConfigFor } from '../lib/db/pool-config';
import { ADMIN_ANALYTICS_QUERY_TIMEOUT_MS } from '../lib/db/budgets';

describe('poolConfigFor', () => {
  it('does not force SSL for local Postgres', () => {
    expect(poolConfigFor('postgres://postgres:postgres@127.0.0.1:5432/kids_fun').ssl).toBeUndefined();
    expect(poolConfigFor('postgres://postgres:postgres@localhost:5432/kids_fun').ssl).toBeUndefined();
  });

  it('enables SSL for remote/Supabase-style hosts even without sslmode in the secret', () => {
    expect(poolConfigFor('postgres://postgres:secret@db.example.supabase.co:5432/postgres').ssl).toEqual({ rejectUnauthorized: false });
  });

  it('respects an explicit sslmode=disable override', () => {
    expect(poolConfigFor('postgres://postgres:secret@db.example.com:5432/postgres?sslmode=disable').ssl).toBeUndefined();
  });

  // Round 27 F1 regression: SSL must be decided from the host pg will ACTUALLY connect to,
  // honoring a `?host=` override (node-postgres uses pg-connection-string's parse().host).
  // Reading url.hostname alone let a local-looking URL that really lands on remote Supabase
  // disable SSL — the same root-cause gap fixed in lib/testing/local-db-guard.ts.
  it('enables SSL when a ?host= override points at a remote host despite a local hostname', () => {
    expect(
      poolConfigFor('postgres://postgres:secret@127.0.0.1:5432/postgres?host=db.example.supabase.co').ssl
    ).toEqual({ rejectUnauthorized: false });
  });

  it('does not force SSL when a ?host= override points back to local despite a remote hostname', () => {
    expect(
      poolConfigFor('postgres://postgres:secret@db.example.supabase.co:5432/postgres?host=127.0.0.1').ssl
    ).toBeUndefined();
  });

  // 2026-09-14: `connectionTimeoutMillis` was unset, and node-postgres reads unset as WAIT
  // FOREVER. With /admin/operating fanning twelve reads out of one Promise.all, whichever
  // ones queue had no ceiling — so a request could sit on a serverless function indefinitely
  // behind multi-minute scans. A number here, any number, is the fix; the assertion is that
  // it is SET and shorter than a single query's own budget, at whatever POOL_MAX happens to be.
  it('bounds how long a caller may wait for a pooled connection', () => {
    const config = poolConfigFor('postgres://postgres:postgres@127.0.0.1:5432/kids_fun');
    expect(config.connectionTimeoutMillis, 'unset means wait forever — see the constant').toBeGreaterThan(0);
    expect(config.connectionTimeoutMillis).toBeLessThan(ADMIN_ANALYTICS_QUERY_TIMEOUT_MS);
  });

  // Stated rather than inherited: on this deployment the alternative to closing our own
  // idle connections is that the platform reclaims them, which surfaces as
  // `57P01 terminating connection due to administrator command` on the next request to pick
  // one up. The value matches node-postgres's default; pinning it makes it a decision.
  it('closes its own idle connections rather than leaving them to be reclaimed', () => {
    expect(
      poolConfigFor('postgres://postgres:postgres@127.0.0.1:5432/kids_fun').idleTimeoutMillis
    ).toBeGreaterThan(0);
  });
});
