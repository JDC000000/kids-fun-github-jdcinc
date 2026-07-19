// tests/admin/audit-tx-db.test.ts — G-T34 audit transaction helpers, DB round-trip.
// Proves withAdminTransaction + writeAdminAudit(client) are atomic: if the body throws
// after a mutation + an audit write, BOTH roll back (no un-audited change, no orphaned
// audit); on success the audit row commits. Skips without a DB.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, query } from '@/lib/db/client';
import { withAdminTransaction, writeAdminAudit } from '@/lib/admin/audit';

const hasDb = Boolean(process.env.DATABASE_URL);
const TX_FAMILY = 'test_t34p2_tx';

describe.skipIf(!hasDb)('withAdminTransaction atomicity (G-T34)', () => {
  let adminId = '';

  beforeAll(async () => {
    const [admin] = await query<{ id: string }>(`INSERT INTO user_profile (id) VALUES (gen_random_uuid()) RETURNING id`);
    adminId = admin.id;
    await query(`INSERT INTO admin_user (user_id, role, active) VALUES ($1, 'admin', true)`, [adminId]);
  });

  afterAll(async () => {
    if (adminId) await query(`DELETE FROM admin_audit_log WHERE admin_user_id = $1`, [adminId]);
    await query(`DELETE FROM source WHERE family = $1`, [TX_FAMILY]);
    if (adminId) {
      await query(`DELETE FROM admin_user WHERE user_id = $1`, [adminId]);
      await query(`DELETE FROM user_profile WHERE id = $1`, [adminId]);
    }
    await closePool();
  });

  it('rolls the whole unit back when the body throws', async () => {
    await expect(
      withAdminTransaction(async (client) => {
        await client.query(`INSERT INTO source (family, name) VALUES ($1, 'TX Rollback')`, [TX_FAMILY]);
        await writeAdminAudit({ adminUserId: adminId, action: 'test.tx.rollback', targetTable: 'source' }, client);
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    const src = await query(`SELECT id FROM source WHERE family = $1`, [TX_FAMILY]);
    expect(src).toHaveLength(0);
    const audit = await query(`SELECT id FROM admin_audit_log WHERE admin_user_id = $1 AND action = 'test.tx.rollback'`, [adminId]);
    expect(audit).toHaveLength(0);
  });

  it('commits the audit row when the body succeeds', async () => {
    const id = await withAdminTransaction((client) =>
      writeAdminAudit({ adminUserId: adminId, action: 'test.tx.ok', targetTable: 'source' }, client)
    );
    expect(id).toBeTruthy();
    const audit = await query(`SELECT id FROM admin_audit_log WHERE id = $1`, [id]);
    expect(audit).toHaveLength(1);
  });
});
