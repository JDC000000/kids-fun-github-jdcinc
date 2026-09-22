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
  markerState,
} from '@/lib/testing/disposable-db';

/**
 * Minimal Pool stub, modelling what a REAL database does rather than what the code happens to ask.
 *
 * markerExists now genuinely READS the marker (USAGE + SELECT) instead of merely resolving its name
 * with to_regclass — "this database vouches for itself" should mean the connection can actually
 * read the voucher. So when the marker is absent the stub raises SQLSTATE 42P01 exactly as Postgres
 * would, which is also what pins the error-code handling in markerExists.
 */
function stubPool(present: boolean) {
  const statements: string[] = [];
  const pool = {
    query: vi.fn(async (text: string) => {
      statements.push(text);
      if (/SELECT count\(\*\) FROM/.test(text)) {
        if (present) return { rows: [{ count: '0' }] };
        const err = new Error('relation "kf_testing.kf_disposable_test_db" does not exist') as Error & { code: string };
        err.code = '42P01';
        throw err;
      }
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

describe('disposable-db: loopback provisioning swallows ONLY privilege errors', () => {
  // Found by a per-branch mutation sweep of my own guard surface, not by a reviewer. Deleting
  // `if (!isPrivilegeError(err)) throw err;` from the loopback branch caused ZERO failures, because
  // every existing test exercised either a privilege error or the happy path. The branch is real:
  // without it ANY provisioning failure — a refused connection, a syntax error, a disk-full — is
  // silently swallowed and the guard reports the target as fine.
  it('a NON-privilege failure during provisioning surfaces instead of being swallowed', async () => {
    const pool = {
      query: vi.fn(async () => { throw new Error('ECONNREFUSED 127.0.0.1:54322'); }),
    } as unknown as Pool;
    await expect(
      assertDisposableDatabase(pool, 'postgres://postgres@127.0.0.1:54322/db')
    ).rejects.toThrow(/ECONNREFUSED/);
  });

  // ═══ B-RESIDUAL: the two tests around this one cannot tell the fix from the bug ═══
  // A reviewer re-ran my own original mutation against my own fix instead of trusting it, and
  // found the gap. The ECONNREFUSED case re-throws under BOTH the old substring match and the new
  // SQLSTATE check (its message has no "permission denied" in it), and the genuine-42501 case is
  // swallowed under both. So they pin that a re-throw EXISTS, not that it discriminates.
  //
  // This is the case that separates them: the WORDING of a privilege error with NO SQLSTATE at
  // all. The old `message.includes('permission denied')` swallowed it; only a code-based check
  // re-throws. That matters because anything can put those two words in a message — a proxy, a
  // connection pooler, a wrapper library — and swallowing it silently reports an unverified
  // database as disposable.
  // (Do not merge these with the similarly-named markerExists test further down — that one guards
  // markerState's own SQLSTATE switch, a different call site. Confirmed disjoint by mutation.)
  it('a "permission denied" MESSAGE with no SQLSTATE is re-thrown, not swallowed', async () => {
    const pool = {
      query: vi.fn(async () => { throw new Error('permission denied for table kf_testing.marker'); }),
    } as unknown as Pool;
    await expect(
      assertDisposableDatabase(pool, 'postgres://postgres@127.0.0.1:54322/db')
    ).rejects.toThrow(/permission denied/);
  });

  it('a privilege-WORDED error carrying a different SQLSTATE is also re-thrown', async () => {
    // 42P01 undefined_table: the marker schema is missing, which is a real failure to provision,
    // not a permissions grant we are entitled to tolerate.
    const pool = {
      query: vi.fn(async () => {
        const e = new Error('permission denied — actually the relation does not exist') as Error & { code: string };
        e.code = '42P01';
        throw e;
      }),
    } as unknown as Pool;
    await expect(
      assertDisposableDatabase(pool, 'postgres://postgres@127.0.0.1:54322/db')
    ).rejects.toThrow(/does not exist/);
  });

  it('a privilege failure is still tolerated on loopback (the CI case)', async () => {
    const pool = {
      query: vi.fn(async () => {
        const e = new Error('permission denied for database ci') as Error & { code: string };
        e.code = '42501';
        throw e;
      }),
    } as unknown as Pool;
    await expect(
      assertDisposableDatabase(pool, 'postgres://postgres@127.0.0.1:54322/db')
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

// ═══ F4: 42501 IS NOT EVIDENCE OF EXISTENCE ═══
// Postgres raises the permission error BEFORE it checks whether the relation is there, so this
// SQLSTATE looks identical for "exists, hidden from you" and "never existed". The guard used to
// tell the operator the marker "already exists" and not to create a second one — a claim it could
// not support, and one that leaves a genuinely unmarked database unmarked.
describe('disposable-db: an unlookable schema is reported as unknown, not as present', () => {
  const privErr = () => {
    const e = new Error('permission denied for schema kf_testing') as Error & { code: string };
    e.code = '42501';
    return e;
  };

  it('markerState says indeterminate', async () => {
    const pool = { query: vi.fn(async () => { throw privErr(); }) } as unknown as Pool;
    await expect(markerState(pool)).resolves.toBe('indeterminate');
  });

  it('markerExists stays false — unverifiable is never a pass', async () => {
    const pool = { query: vi.fn(async () => { throw privErr(); }) } as unknown as Pool;
    await expect(markerExists(pool)).resolves.toBe(false);
  });

  it('the refusal does NOT claim the marker exists, and says how to find out', async () => {
    const pool = { query: vi.fn(async () => { throw privErr(); }) } as unknown as Pool;
    const err = await assertDisposableDatabase(pool, REMOTE).catch((e: Error) => e);
    const msg = String((err as Error).message);
    expect(msg).toMatch(/CANNOT BE DETERMINED/);
    expect(msg).toMatch(/to_regclass/);          // tells them how to actually check
    expect(msg).toMatch(/GRANT USAGE ON SCHEMA/); // and both branches of what to do next
    // The specific false claim, in the specific shape it had. Not a substring check on "exists",
    // which the corrected message legitimately still contains while explaining the old error.
    expect(msg).not.toMatch(/Do NOT create a second marker; it already exists/);
  });
});

describe('disposable-db: unverifiable target', () => {
  it('fails closed on an unparseable connection string', async () => {
    const { pool } = stubPool(true);
    await expect(assertDisposableDatabase(pool, '::::not-a-url::::')).rejects.toThrow(/not parseable/);
  });
});

describe('disposable-db: markerExists', () => {
  it('READS the marker table (not merely resolving its name)', async () => {
    const { pool, statements } = stubPool(true);
    await expect(markerExists(pool)).resolves.toBe(true);
    expect(statements[0]).toContain(DISPOSABLE_MARKER_TABLE);
    expect(statements[0]).toMatch(/FROM/);
  });

  it('treats an absent marker (42P01) as "not marked", not as an error', async () => {
    const { pool } = stubPool(false);
    await expect(markerExists(pool)).resolves.toBe(false);
  });

  it('treats an UNREADABLE marker (42501) as "not marked" — cannot verify is not verified', async () => {
    const pool = {
      query: vi.fn(async () => {
        const err = new Error('permission denied for schema kf_testing') as Error & { code: string };
        err.code = '42501';
        throw err;
      }),
    } as unknown as Pool;
    await expect(markerExists(pool)).resolves.toBe(false);
  });

  it('does NOT swallow an unrelated error that merely says "permission denied"', async () => {
    // The old implementation matched on message text, which made its own comment false.
    //
    // ⚠ THIS TEST DOES NOT COVER THE LOOPBACK PROVISIONING BRANCH, despite reading as if it might.
    // It exercises markerExists -> markerState, which has its OWN inline SQLSTATE switch. The
    // separate narrowing in isPrivilegeError() (used only by assertDisposableDatabase's loopback
    // branch) is pinned by the two tests above marked B-RESIDUAL. The paths are disjoint, proved by
    // mutation: breaking isPrivilegeError fails ONLY those two and leaves this one green, and
    // breaking markerState's 42501 branch fails ONLY this one. Two reviewers read this test as
    // already covering the loopback case; it does not.
    const pool = {
      query: vi.fn(async () => { throw new Error('permission denied by some unrelated client layer'); }),
    } as unknown as Pool;
    await expect(markerExists(pool)).rejects.toThrow(/unrelated client layer/);
  });
});
