// tests/sms/unknown_reply_throttle-db.test.ts — the unknown-reply cap against REAL Postgres.
//
// The unit lane (tests/sms/inbound_loop_guard.test.ts) models the upsert in memory. This file is
// what proves the model honest: migration 0054 admits the scope, the real `countAttempt` statement
// allows exactly one reply per sender per UTC day, and — the property no single-threaded test can
// show — a burst of CONCURRENT inbound texts from one auto-responder still yields exactly one.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { query } from '@/lib/db/client';
import { checkAndRecordUnknownReply } from '@/lib/sms/inbound-reply-guard';

const SENDER_A = '+16045557901';
const SENDER_B = '+16045557902';
const SENDER_C = '+16045557903';

async function cleanup(): Promise<void> {
  await query(`DELETE FROM sms_signup_throttle WHERE scope = 'unknown_reply'`);
}

beforeAll(async () => {
  vi.stubEnv('SMS_PHONE_HASH_SALT', 'unknown-reply-db-salt');
  await cleanup();
});
afterAll(async () => {
  await cleanup();
  vi.unstubAllEnvs();
});

describe('unknown_reply throttle on real Postgres', () => {
  it('migration 0054 admits the scope (a check_violation here would fail closed = silent forever)', async () => {
    const [row] = await query<{ def: string }>(
      `SELECT pg_get_constraintdef(c.oid) AS def
         FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
        WHERE t.relname = 'sms_signup_throttle' AND c.contype = 'c'
          AND pg_get_constraintdef(c.oid) ILIKE '%scope%'`
    );
    expect(row.def).toContain('unknown_reply');
  });

  it('allows the first reply to a sender and refuses the second, same day', async () => {
    expect(await checkAndRecordUnknownReply(SENDER_A)).toEqual({ allowed: true });
    expect(await checkAndRecordUnknownReply(SENDER_A)).toEqual({ allowed: false, reason: 'daily_cap' });
    expect(await checkAndRecordUnknownReply(SENDER_A)).toEqual({ allowed: false, reason: 'daily_cap' });
  });

  it('counts per sender', async () => {
    expect(await checkAndRecordUnknownReply(SENDER_B)).toEqual({ allowed: true });
  });

  it('20 concurrent texts from one sender produce exactly ONE allowed reply', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () => checkAndRecordUnknownReply(SENDER_C))
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(1);
    expect(results.filter((r) => !r.allowed && r.reason === 'daily_cap')).toHaveLength(19);
  });

  it('stores a hash, never the number', async () => {
    const rows = await query<{ subject_hash: string }>(
      `SELECT subject_hash FROM sms_signup_throttle WHERE scope = 'unknown_reply'`
    );
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.subject_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(r.subject_hash).not.toContain('604555790');
    }
  });
});
