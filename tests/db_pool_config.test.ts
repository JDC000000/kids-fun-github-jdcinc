import { afterEach, describe, expect, it } from 'vitest';
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

  // ═══ FINDING A (round-5 review) ═══
  // The `?host=` cases above made this file LOOK covered, and item 9 of the review was reported
  // PASS on the strength of them. They all spell a host in the URL. The one call shape nobody
  // tested is the one with NO host in the URL at all, where pg falls back to PGHOST — and that is
  // the shape that disabled SSL on a real Supabase connection.
  describe('the host pg DIALS, not the one the string spells', () => {
    const saved = process.env.PGHOST;
    afterEach(() => {
      if (saved === undefined) delete process.env.PGHOST;
      else process.env.PGHOST = saved;
    });

    it('requires SSL when a hostless URL is dialed via a remote PGHOST', () => {
      process.env.PGHOST = 'db.example.supabase.co';
      expect(poolConfigFor('postgres:///postgres').ssl).toBeDefined();
    });

    it('does not force SSL when PGHOST is loopback (no false positive)', () => {
      process.env.PGHOST = '127.0.0.1';
      expect(poolConfigFor('postgres:///postgres').ssl).toBeUndefined();
    });

    it('lets an explicit URL host win over PGHOST, as pg does', () => {
      process.env.PGHOST = 'db.example.supabase.co';
      expect(poolConfigFor('postgres://postgres:p@127.0.0.1:5432/kids_fun').ssl).toBeUndefined();
    });

    it('fails CLOSED on an unparseable connection string rather than dropping SSL', () => {
      // Previously `return false` out of the URL catch: the least-understood input got the
      // least protection. Requiring TLS against a local server is a loud error; skipping it
      // against a remote one is a cleartext superuser password.
      delete process.env.PGHOST;
      expect(poolConfigFor('::::not-a-url::::').ssl).toBeDefined();
    });

    it('still honours an explicit sslmode=disable (operator intent is not overridden)', () => {
      process.env.PGHOST = 'db.example.supabase.co';
      expect(poolConfigFor('postgres:///postgres?sslmode=disable').ssl).toBeUndefined();
    });
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
