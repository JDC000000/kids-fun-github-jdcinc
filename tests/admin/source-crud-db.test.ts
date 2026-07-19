// tests/admin/source-crud-db.test.ts — G-T34-3 source CRUD + audit, DB round-trip.
// Skips when DATABASE_URL is unset (mirrors the other admin DB tests). Proves create +
// edit land the row AND write an admin_audit_log row with the right before/after JSON,
// and that a (family, name) clash raises SourceConflictError.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, query } from '@/lib/db/client';
import { createSource, updateSource, getSourceById, listSources, SourceConflictError } from '@/app/admin/sources/_lib/data';
import { ADMIN_AUDIT_ACTIONS } from '@/lib/admin/audit';
import type { SourceInput } from '@/app/admin/sources/_lib/vocab';

const hasDb = Boolean(process.env.DATABASE_URL);
const FAMILY = 'test_t34p2_src';
const NAME_A = 'CRUD Test Source A';

function input(overrides: Partial<SourceInput> = {}): SourceInput {
  return {
    family: FAMILY,
    name: NAME_A,
    platform: 'test-platform',
    authorityTier: 'manual',
    termsStatus: 'pending',
    robotsStatus: 'pending',
    ingestionMethod: 'manual',
    seasonState: 'unknown',
    healthState: 'unknown',
    baselineCadence: '1 day',
    nearDateCadence: null,
    ...overrides,
  };
}

describe.skipIf(!hasDb)('source CRUD + audit (G-T34-3)', () => {
  let adminId = '';
  const sourceIds: string[] = [];

  beforeAll(async () => {
    const [admin] = await query<{ id: string }>(`INSERT INTO user_profile (id) VALUES (gen_random_uuid()) RETURNING id`);
    adminId = admin.id;
    await query(`INSERT INTO admin_user (user_id, role, active) VALUES ($1, 'admin', true)`, [adminId]);
  });

  afterAll(async () => {
    if (adminId) await query(`DELETE FROM admin_audit_log WHERE admin_user_id = $1`, [adminId]);
    for (const id of sourceIds) await query(`DELETE FROM source WHERE id = $1`, [id]);
    await query(`DELETE FROM source WHERE family = $1`, [FAMILY]);
    if (adminId) {
      await query(`DELETE FROM admin_user WHERE user_id = $1`, [adminId]);
      await query(`DELETE FROM user_profile WHERE id = $1`, [adminId]);
    }
    await closePool();
  });

  it('createSource inserts the row and writes a SOURCE_CREATE audit entry', async () => {
    const created = await createSource(input({ termsStatus: 'allowed', robotsStatus: 'allowed' }), adminId);
    sourceIds.push(created.id);
    expect(created.family).toBe(FAMILY);
    expect(created.termsStatus).toBe('allowed');
    expect(created.baselineCadence).toBe('1 day');

    const roundTrip = await getSourceById(created.id);
    expect(roundTrip?.name).toBe(NAME_A);

    const [audit] = await query<{ action: string; target_table: string; target_id: string; before_json: unknown; after_json: { family: string } }>(
      `SELECT action, target_table, target_id, before_json, after_json FROM admin_audit_log
        WHERE admin_user_id = $1 AND action = $2 ORDER BY created_at DESC LIMIT 1`,
      [adminId, ADMIN_AUDIT_ACTIONS.SOURCE_CREATE]
    );
    expect(audit.target_table).toBe('source');
    expect(audit.target_id).toBe(created.id);
    expect(audit.before_json).toBeNull();
    expect(audit.after_json.family).toBe(FAMILY);
  });

  it('updateSource applies changes and writes a SOURCE_UPDATE audit entry with before/after', async () => {
    const before = await getSourceById(sourceIds[0]);
    expect(before).not.toBeNull();
    const updated = await updateSource(
      sourceIds[0],
      input({ termsStatus: 'summarise_only', baselineCadence: '7 days', healthState: 'degraded' }),
      adminId,
      before!
    );
    expect(updated.termsStatus).toBe('summarise_only');
    expect(updated.baselineCadence).toBe('7 days');
    expect(updated.healthState).toBe('degraded');

    const [audit] = await query<{ before_json: { terms_status: string; termsStatus?: string }; after_json: { termsStatus: string } }>(
      `SELECT before_json, after_json FROM admin_audit_log
        WHERE admin_user_id = $1 AND action = $2 ORDER BY created_at DESC LIMIT 1`,
      [adminId, ADMIN_AUDIT_ACTIONS.SOURCE_UPDATE]
    );
    // snapshots use the camelCase SourceRow shape
    expect((audit.before_json as { termsStatus: string }).termsStatus).toBe('allowed');
    expect(audit.after_json.termsStatus).toBe('summarise_only');
  });

  it('listSources includes the created source', async () => {
    const all = await listSources();
    expect(all.some((s) => s.id === sourceIds[0])).toBe(true);
  });

  it('createSource raises SourceConflictError on a duplicate (family, name)', async () => {
    await expect(createSource(input(), adminId)).rejects.toBeInstanceOf(SourceConflictError);
  });
});
