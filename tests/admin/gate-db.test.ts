// tests/admin/gate-db.test.ts — G-T34-1 end-to-end: the access combinations
// driven through the REAL gate against a LIVE database.
//
// Unlike gate.test.ts (which stubs requireAdmin/audit), this test stubs ONLY the
// session read (getRequestUser) to inject an identity, then lets the real
// requireAdmin() role check and the real admin_audit_log write run against the
// ephemeral Postgres. It is the data-layer analogue of the task's 4-combination
// live smoke, and it verifies the audit write is actually persisted + queryable.
// Skips when DATABASE_URL is unset.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closePool, query } from '../../lib/db/client';

const hasDb = Boolean(process.env.DATABASE_URL);
// The legacy interim secret (removed 2026-09-24). Set in the env for the cases below to prove it
// is ignored — the gate no longer reads it at all.
const ADMIN_DASHBOARD_TOKEN_ENV = 'ADMIN_DASHBOARD_TOKEN';
const TOKEN = 'gate-db-smoke-token';

// Inject the "signed-in user" without touching Supabase. vi.hoisted so the factory
// can reference the holder despite hoisting.
const session = vi.hoisted(() => ({ user: null as null | { userId: string; email: string | null } }));
vi.mock('../../lib/db/session-user', () => ({ getRequestUser: () => Promise.resolve(session.user) }));

// Real gate, real requireAdmin, real audit writer — only the session is stubbed.
import { resolveAdminAccess } from '../../app/admin/_lib/gate';

interface Ids {
  adminId: string;
  nonAdminId: string;
}

async function viewAuditCount(userId: string): Promise<number> {
  const rows = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM admin_audit_log WHERE admin_user_id = $1`,
    [userId]
  );
  return Number(rows[0].n);
}

describe.skipIf(!hasDb)('admin gate end-to-end over a live DB (G-T34-1, 4 combinations)', () => {
  const ids = {} as Ids;
  let savedToken: string | undefined;

  beforeAll(async () => {
    const [admin] = await query<{ id: string }>(
      `INSERT INTO user_profile (id) VALUES (gen_random_uuid()) RETURNING id`
    );
    ids.adminId = admin.id;
    await query(`INSERT INTO admin_user (user_id, role, active) VALUES ($1, 'superadmin', true)`, [ids.adminId]);

    const [nonAdmin] = await query<{ id: string }>(
      `INSERT INTO user_profile (id) VALUES (gen_random_uuid()) RETURNING id`
    );
    ids.nonAdminId = nonAdmin.id;
  });

  beforeEach(() => {
    savedToken = process.env[ADMIN_DASHBOARD_TOKEN_ENV];
    session.user = null;
  });
  afterEach(() => {
    if (savedToken === undefined) delete process.env[ADMIN_DASHBOARD_TOKEN_ENV];
    else process.env[ADMIN_DASHBOARD_TOKEN_ENV] = savedToken;
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

  // Combo 1 — no session + no token → blocked.
  it('COMBO 1: no session, no token → denied', async () => {
    process.env[ADMIN_DASHBOARD_TOKEN_ENV] = TOKEN;
    session.user = null;
    const grant = await resolveAdminAccess({ surface: 'admin_dashboard' });
    expect(grant).toEqual({ ok: false });
  });

  // Combo 2 — the legacy token is configured, no session → DENIED. Until 2026-09-24 this was the
  // interim shared-secret grant; it is now proof that the fallback is gone.
  it('COMBO 2: legacy token configured, no session → denied (the token fallback is removed)', async () => {
    process.env[ADMIN_DASHBOARD_TOKEN_ENV] = TOKEN;
    session.user = null;
    const grant = await resolveAdminAccess({ surface: 'admin_dashboard' });
    expect(grant).toEqual({ ok: false });
  });

  // Combo 3 — real admin session + no token → granted via the new path + audited.
  it('COMBO 3: real admin session, no token → granted via session AND writes a queryable audit row', async () => {
    delete process.env[ADMIN_DASHBOARD_TOKEN_ENV]; // prove it is NOT the token doing the work
    session.user = { userId: ids.adminId, email: 'admin@example.test' };
    const before = await viewAuditCount(ids.adminId);

    const grant = await resolveAdminAccess({ surface: 'admin_dashboard' });
    expect(grant).toMatchObject({ ok: true, via: 'session', admin: { userId: ids.adminId, role: 'superadmin' } });

    // The access was actually recorded in admin_audit_log and is queryable.
    expect(await viewAuditCount(ids.adminId)).toBe(before + 1);
    const [row] = await query<{ action: string; target_table: string; target_id: string | null }>(
      `SELECT action, target_table, target_id FROM admin_audit_log
         WHERE admin_user_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [ids.adminId]
    );
    expect(row.action).toBe('admin.view');
    expect(row.target_table).toBe('admin_dashboard');
    expect(row.target_id).toBeNull();
  });

  // Combo 4 — real NON-admin session + no token → blocked, nothing audited.
  it('COMBO 4: real non-admin session, no token → denied and nothing is audited', async () => {
    process.env[ADMIN_DASHBOARD_TOKEN_ENV] = TOKEN;
    session.user = { userId: ids.nonAdminId, email: 'user@example.test' };
    const grant = await resolveAdminAccess({ surface: 'admin_dashboard' });
    expect(grant).toEqual({ ok: false });
    expect(await viewAuditCount(ids.nonAdminId)).toBe(0);
  });

  // Former coexistence corner: a signed-in non-admin can NOT fall back to the token any more.
  it('COMBO 4b: non-admin session + legacy token configured → denied, un-audited', async () => {
    process.env[ADMIN_DASHBOARD_TOKEN_ENV] = TOKEN;
    session.user = { userId: ids.nonAdminId, email: 'user@example.test' };
    const grant = await resolveAdminAccess({ surface: 'admin_dashboard' });
    expect(grant).toEqual({ ok: false });
    expect(await viewAuditCount(ids.nonAdminId)).toBe(0);
  });
});
