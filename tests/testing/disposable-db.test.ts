// tests/testing/disposable-db.test.ts — unit coverage for the third layer of the 2026-09-21 fix.
// No real database: `pg.Pool` is stubbed, so this runs in the unit lane and asserts the DECISION,
// which is the part that can be wrong in a way that matters.
import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import {
  assertDisposableDatabase,
  DISPOSABLE_MARKER_SCHEMA,
  DISPOSABLE_MARKER_TABLE,
  markerExists,
} from '@/lib/testing/disposable-db';

/** Minimal Pool stub: records every statement, and answers the marker probe with `present`. */
function stubPool(present: boolean) {
  const statements: string[] = [];
  const pool = {
    query: vi.fn(async (text: string) => {
      statements.push(text);
      if (text.includes('to_regclass')) return { rows: [{ ok: present }] };
      return { rows: [] };
    }),
  } as unknown as Pool;
  return { pool, statements };
}

const LOCAL = 'postgres://postgres:postgres@127.0.0.1:54322/postgres';
const REMOTE = 'postgres://u:p@10.0.0.5:5432/db';
const MANAGED = 'postgresql://postgres:p@db.rnqaofjhiqmqaipqpiua.supabase.co:5432/postgres';

describe('disposable-db: loopback auto-provisions (zero friction on the common path)', () => {
  it('creates the marker and allows, without ever probing for it first', async () => {
    const { pool, statements } = stubPool(false);
    await expect(assertDisposableDatabase(pool, LOCAL)).resolves.toBeUndefined();
    expect(statements.some((s) => s.includes(`CREATE SCHEMA IF NOT EXISTS ${DISPOSABLE_MARKER_SCHEMA}`))).toBe(true);
    expect(statements.some((s) => s.includes(`CREATE TABLE IF NOT EXISTS ${DISPOSABLE_MARKER_TABLE}`))).toBe(true);
    // the marker must NOT land in `public` — that is what turned the db lane red (RLS invariant)
    expect(DISPOSABLE_MARKER_TABLE.startsWith('public.')).toBe(false);
    expect(DISPOSABLE_MARKER_TABLE).toContain('.');
    // The INSERT is guarded by NOT EXISTS so repeated runs cannot pile up rows.
    expect(statements.some((s) => s.includes('WHERE NOT EXISTS'))).toBe(true);
  });

  it('treats a ?host= override that lands on loopback as local', async () => {
    const { pool } = stubPool(false);
    await expect(
      assertDisposableDatabase(pool, 'postgres://db.real.supabase.co:5432/db?host=127.0.0.1')
    ).resolves.toBeUndefined();
  });
});

describe('disposable-db: a managed host is refused outright', () => {
  it('throws, and does not create a marker in someone’s production database', async () => {
    const { pool, statements } = stubPool(false);
    await expect(assertDisposableDatabase(pool, MANAGED)).rejects.toThrow(/REFUSING/);
    expect(statements.some((s) => s.includes('CREATE TABLE'))).toBe(false);
  });

  it('is refused even when the URL hides the managed host behind a local-looking hostname', async () => {
    const { pool } = stubPool(true); // marker "present" must not rescue it
    await expect(
      assertDisposableDatabase(pool, 'postgres://127.0.0.1/db?host=db.x.supabase.co')
    ).rejects.toThrow(/managed\/hosted/);
  });
});

describe('disposable-db: a non-local, non-managed host must vouch for itself', () => {
  it('refuses when the marker is absent, and does NOT create one', async () => {
    const { pool, statements } = stubPool(false);
    await expect(assertDisposableDatabase(pool, REMOTE)).rejects.toThrow(/carries no disposability marker/);
    // The whole point: the guard must not manufacture the permission it is checking for.
    expect(statements.some((s) => s.includes('CREATE TABLE'))).toBe(false);
  });

  it('allows when the database already carries the marker', async () => {
    const { pool } = stubPool(true);
    await expect(assertDisposableDatabase(pool, REMOTE)).resolves.toBeUndefined();
  });

  it('tells the reader how to mark it, and warns against marking one they care about', async () => {
    const { pool } = stubPool(false);
    await expect(assertDisposableDatabase(pool, REMOTE)).rejects.toThrow(/CREATE TABLE kf_testing\.kf_disposable_test_db/);
    await expect(assertDisposableDatabase(pool, REMOTE)).rejects.toThrow(/database you care about/);
  });
});

describe('disposable-db: unverifiable target', () => {
  it('fails closed on an unparseable connection string', async () => {
    const { pool } = stubPool(true);
    await expect(assertDisposableDatabase(pool, '::::not-a-url::::')).rejects.toThrow(/not parseable/);
  });
});

describe('disposable-db: markerExists', () => {
  it('asks to_regclass for exactly the marker table', async () => {
    const { pool, statements } = stubPool(true);
    await expect(markerExists(pool)).resolves.toBe(true);
    expect(statements[0]).toContain('to_regclass');
  });
});
