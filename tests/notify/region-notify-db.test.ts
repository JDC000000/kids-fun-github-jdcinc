// tests/notify/region-notify-db.test.ts — the waiting-list row really lands, and a parent who
// taps twice is one request, not two.
//
// The unit half (tests/notify/region-notify.test.ts) proves the endpoint refuses bad input and
// REPORTS a write it could not perform. That is only half a promise: a form that says "we will
// email you" also has to have written something down. This is the half that opens the table and
// looks.
//
// Scoped by a unique address per run, so it never reads or deletes another suite's rows.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, query } from '../../lib/db/client';
import { writeRegionNotifySignup } from '../../lib/notify/region-signup';

const hasDb = Boolean(process.env.DATABASE_URL);
// A run-unique local part, so concurrent/repeat runs cannot collide on the unique index.
const stamp = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
const EMAIL = `kf-notify-${stamp}@example.test`;

async function rowsFor(email: string) {
  return query<{ region_chip_id: string; email: string }>(
    `SELECT region_chip_id, email FROM region_notify_signup WHERE lower(email) = lower($1) ORDER BY region_chip_id`,
    [email]
  );
}

describe.skipIf(!hasDb)('region_notify_signup — the waiting list actually records the request', () => {
  beforeAll(async () => {
    await query(`DELETE FROM region_notify_signup WHERE email LIKE $1`, ['kf-notify-%@example.test']);
  });
  afterAll(async () => {
    await query(`DELETE FROM region_notify_signup WHERE email LIKE $1`, ['kf-notify-%@example.test']);
    await closePool();
  });

  it('writes the address against the area it was asked about', async () => {
    expect(await writeRegionNotifySignup({ regionChipId: 'wvan', email: EMAIL })).toEqual({ ok: true });
    const rows = await rowsFor(EMAIL);
    expect(rows).toEqual([{ region_chip_id: 'wvan', email: EMAIL }]);
  });

  it('treats a repeat submission as a success, not a duplicate and not an error', async () => {
    // A parent tapping twice, a double-submit, or a retry after a partial multi-area failure.
    expect(await writeRegionNotifySignup({ regionChipId: 'wvan', email: EMAIL })).toEqual({ ok: true });
    expect(await rowsFor(EMAIL)).toHaveLength(1);
  });

  it('dedupes case-insensitively — a mailbox is one mailbox however it is typed', async () => {
    expect(await writeRegionNotifySignup({ regionChipId: 'wvan', email: EMAIL.toUpperCase() })).toEqual({ ok: true });
    expect(await rowsFor(EMAIL)).toHaveLength(1);
  });

  it('keeps a second AREA as a genuinely separate request', async () => {
    expect(await writeRegionNotifySignup({ regionChipId: 'bby', email: EMAIL })).toEqual({ ok: true });
    expect((await rowsFor(EMAIL)).map((r) => r.region_chip_id)).toEqual(['bby', 'wvan']);
  });

  it('is locked down: RLS on, no policies, and no anon/authenticated grants', async () => {
    // This table holds raw email addresses from anonymous visitors — the most sensitive column
    // added to this schema. tests/rls_public_tables.test.ts enforces the invariant across every
    // public table; this asserts it point-blank for this one, so the reason is recorded next to
    // the data it protects.
    const [meta] = await query<{ rls: boolean; n_policies: number }>(
      `SELECT c.relrowsecurity AS rls,
              (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS n_policies
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = 'region_notify_signup'`
    );
    expect(meta.rls).toBe(true);
    expect(meta.n_policies).toBe(0);

    const grants = await query<{ grantee: string }>(
      `SELECT grantee FROM information_schema.role_table_grants
        WHERE table_schema = 'public' AND table_name = 'region_notify_signup'
          AND grantee IN ('anon', 'authenticated')`
    );
    expect(grants).toEqual([]);
  });
});
