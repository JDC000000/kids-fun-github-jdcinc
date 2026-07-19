// tests/admin/audit-db.test.ts — G-T34-2 admin audit-log writer, DB round-trip.
//
// Skips when DATABASE_URL is unset (mirrors the other admin DB tests). Proves the
// write actually lands and is queryable with the expected columns, and that the FK
// (admin_audit_log.admin_user_id → admin_user) ties every audit row to a real,
// seeded admin — so the interim token path (no admin identity) genuinely CANNOT be
// audited. FK-safe teardown removes exactly what it inserts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeAdminAudit, recordAdminAccess, ADMIN_AUDIT_ACTIONS } from '../../lib/admin/audit';
import { closePool, query } from '../../lib/db/client';

const hasDb = Boolean(process.env.DATABASE_URL);

interface Ids {
  adminId: string;
  nonAdminId: string;
}

async function auditIdsFor(userId: string): Promise<string[]> {
  const rows = await query<{ id: string }>(
    `SELECT id FROM admin_audit_log WHERE admin_user_id = $1`,
    [userId]
  );
  return rows.map((r) => r.id);
}

describe.skipIf(!hasDb)('admin audit-log writer (G-T34-2)', () => {
  const ids = {} as Ids;

  beforeAll(async () => {
    // A real admin (user_profile + active admin_user) and a plain user (profile only).
    const [admin] = await query<{ id: string }>(
      `INSERT INTO user_profile (id) VALUES (gen_random_uuid()) RETURNING id`
    );
    ids.adminId = admin.id;
    await query(`INSERT INTO admin_user (user_id, role, active) VALUES ($1, 'admin', true)`, [ids.adminId]);

    const [nonAdmin] = await query<{ id: string }>(
      `INSERT INTO user_profile (id) VALUES (gen_random_uuid()) RETURNING id`
    );
    ids.nonAdminId = nonAdmin.id;
  });

  afterAll(async () => {
    if (ids.adminId) {
      await query(`DELETE FROM admin_audit_log WHERE admin_user_id = $1`, [ids.adminId]);
      await query(`DELETE FROM admin_user WHERE user_id = $1`, [ids.adminId]);
    }
    for (const id of [ids.adminId, ids.nonAdminId]) {
      if (id) await query(`DELETE FROM user_profile WHERE id = $1`, [id]);
    }
    await closePool();
  });

  it('writeAdminAudit inserts a queryable row with the expected columns', async () => {
    const targetId = (
      await query<{ id: string }>(`SELECT gen_random_uuid() AS id`)
    )[0].id;
    const auditId = await writeAdminAudit({
      adminUserId: ids.adminId,
      action: 'admin.test.mutation',
      targetTable: 'source',
      targetId,
      before: { enabled: false },
      after: { enabled: true },
    });
    expect(auditId).toBeTruthy();

    const [row] = await query<{
      admin_user_id: string;
      action: string;
      target_table: string;
      target_id: string | null;
      before_json: unknown;
      after_json: unknown;
      created_at: string;
    }>(
      `SELECT admin_user_id, action, target_table, target_id, before_json, after_json, created_at
         FROM admin_audit_log WHERE id = $1`,
      [auditId]
    );
    expect(row.admin_user_id).toBe(ids.adminId);
    expect(row.action).toBe('admin.test.mutation');
    expect(row.target_table).toBe('source');
    expect(row.target_id).toBe(targetId);
    expect(row.before_json).toEqual({ enabled: false });
    expect(row.after_json).toEqual({ enabled: true });
    expect(row.created_at).toBeTruthy();
  });

  it('recordAdminAccess writes a best-effort VIEW row for a real admin (returns true)', async () => {
    const before = await auditIdsFor(ids.adminId);
    const ok = await recordAdminAccess(ids.adminId, 'admin_dashboard');
    expect(ok).toBe(true);

    const [view] = await query<{ action: string; target_table: string; target_id: string | null }>(
      `SELECT action, target_table, target_id FROM admin_audit_log
         WHERE admin_user_id = $1 AND target_table = 'admin_dashboard'
         ORDER BY created_at DESC LIMIT 1`,
      [ids.adminId]
    );
    expect(view.action).toBe(ADMIN_AUDIT_ACTIONS.VIEW);
    expect(view.target_table).toBe('admin_dashboard');
    expect(view.target_id).toBeNull(); // surface-level event: no specific row
    expect((await auditIdsFor(ids.adminId)).length).toBe(before.length + 1);
  });

  it('writeAdminAudit REJECTS a non-admin user id (FK ties audit to real admins)', async () => {
    await expect(
      writeAdminAudit({ adminUserId: ids.nonAdminId, action: ADMIN_AUDIT_ACTIONS.VIEW, targetTable: 'admin_dashboard' })
    ).rejects.toThrow();
  });

  it('recordAdminAccess swallows the FK failure for a non-admin and writes nothing', async () => {
    const ok = await recordAdminAccess(ids.nonAdminId, 'admin_dashboard');
    expect(ok).toBe(false); // best-effort: failure is reported, not thrown
    expect(await auditIdsFor(ids.nonAdminId)).toHaveLength(0);
  });
});
