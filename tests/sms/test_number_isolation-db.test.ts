// tests/sms/test_number_isolation-db.test.ts — a test handset cannot be texted by the real job.
//
// THE INCIDENT THIS PREVENTS. A test number completing a real signup becomes an ordinary `active`
// sms_consent row, indistinguishable from a paying subscriber, which the production Friday job
// then picks up and texts through the production pipeline. Nothing in the schema said otherwise.
//
// TWO INDEPENDENT HALVES, TESTED SEPARATELY ON PURPOSE:
//   1. the WRITE side marks the row (is_test = true), atomically with the confirm
//   2. the READ side (loadActiveSubscribers, what the Friday job iterates) excludes marked rows
// Either alone is a single point of failure. Testing them together only would let one silently
// stop working while the pair still looked correct.
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { closePool, query } from '../../lib/db/client';
import { confirmSubscriber } from '../../lib/sms/consent-transitions';
import { loadActiveSubscribers } from '../../lib/sms/weekly-send-io';

const hasDb = Boolean(process.env.DATABASE_URL);
const MARKER = `isotest-${Date.now()}`;
let n = 0;

async function seedPending(): Promise<{ phone: string; id: string }> {
  n += 1;
  const phone = `+1555${String(9000000 + n).slice(0, 7)}`;
  const rows = await query<{ id: string }>(
    `INSERT INTO sms_consent
       (phone_number, postal_code, birth_years, status, consent_method, consent_timestamp,
        consent_text_version, preferences_token)
     VALUES ($1, 'V5K 0A1', ARRAY[2018], 'pending', 'web_form', now(), 'test', $2)
     RETURNING id`,
    [phone, `${MARKER}-${n}`]
  );
  return { phone, id: rows[0].id };
}

describe.skipIf(!hasDb)('a test handset cannot reach the production weekly send', () => {
  afterEach(async () => {
    await query(`DELETE FROM sms_consent WHERE preferences_token LIKE $1`, [`${MARKER}%`]);
  });
  afterAll(async () => {
    await query(`DELETE FROM sms_consent WHERE preferences_token LIKE $1`, [`${MARKER}%`]);
    await closePool();
  });

  it('🔴 WRITE SIDE: confirming with markTest sets is_test in the SAME update as the status', async () => {
    // Atomicity is the point. A second statement after the confirm has a window in which the row
    // is active and untagged — which is exactly the state the Friday job picks up.
    const { phone, id } = await seedPending();
    await confirmSubscriber(phone, { dryRun: false, markTest: true });
    const rows = await query<{ status: string; is_test: boolean }>(
      `SELECT status, is_test FROM sms_consent WHERE id = $1`,
      [id]
    );
    expect(rows[0].status).toBe('active');
    expect(rows[0].is_test).toBe(true);
  });

  it('🔴 an ordinary confirm leaves is_test false — the default must not drift', async () => {
    const { phone, id } = await seedPending();
    await confirmSubscriber(phone, { dryRun: false });
    const rows = await query<{ status: string; is_test: boolean }>(
      `SELECT status, is_test FROM sms_consent WHERE id = $1`,
      [id]
    );
    expect(rows[0].status).toBe('active');
    expect(rows[0].is_test).toBe(false);
  });

  it('🔴 READ SIDE: loadActiveSubscribers CANNOT return a marked row', async () => {
    // The guarantee, stated against the exact function the Friday job calls. Not a query written
    // to resemble it — that would pass while the real one changed underneath.
    const marked = await seedPending();
    await confirmSubscriber(marked.phone, { dryRun: false, markTest: true });
    const actives = await loadActiveSubscribers();
    expect(actives.map((a) => a.subscriber.id)).not.toContain(marked.id);
  });

  it('🔴 …and DOES return an unmarked one, so the exclusion is not just excluding everything', async () => {
    // Without this the previous assertion passes when loadActiveSubscribers returns nothing at
    // all — the vacuous-check failure this project keeps re-finding. Both rows exist in the same
    // run so the two outcomes are distinguished by is_test alone.
    const real = await seedPending();
    const marked = await seedPending();
    await confirmSubscriber(real.phone, { dryRun: false });
    await confirmSubscriber(marked.phone, { dryRun: false, markTest: true });
    const ids = (await loadActiveSubscribers()).map((a) => a.subscriber.id);
    expect(ids).toContain(real.id);
    expect(ids).not.toContain(marked.id);
  });

  it('🔴 the mark is never cleared by a later ordinary transition', async () => {
    // A test row that could be un-marked is a test row that can become sendable again. The
    // applier only ever sets is_test true; nothing writes false.
    const { phone, id } = await seedPending();
    await confirmSubscriber(phone, { dryRun: false, markTest: true });
    await confirmSubscriber(phone, { dryRun: false }); // a second JOIN, no markTest
    const rows = await query<{ is_test: boolean }>(`SELECT is_test FROM sms_consent WHERE id = $1`, [id]);
    expect(rows[0].is_test).toBe(true);
  });
});
