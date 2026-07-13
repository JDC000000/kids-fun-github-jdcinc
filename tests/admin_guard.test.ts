import { describe, it, expect, afterAll } from 'vitest';
import { requireAdmin, NotAdminError } from '../lib/db/admin-guard';
import { query, closePool } from '../lib/db/client';

// G-T6-4 — admin role foundation (TSD §6.1 admin_user; <L3>).
const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('admin guard (G-T6-4)', () => {
  afterAll(async () => {
    await closePool();
  });

  it('rejects when there is no session', async () => {
    await expect(requireAdmin(null)).rejects.toBeInstanceOf(NotAdminError);
  });

  it('rejects a user with no admin_user row', async () => {
    const [user] = await query<{ id: string }>(
      `INSERT INTO user_profile (id) VALUES (gen_random_uuid()) RETURNING id`
    );
    await expect(requireAdmin(user.id)).rejects.toBeInstanceOf(NotAdminError);
  });

  it('rejects an inactive admin', async () => {
    const [user] = await query<{ id: string }>(
      `INSERT INTO user_profile (id) VALUES (gen_random_uuid()) RETURNING id`
    );
    await query(`INSERT INTO admin_user (user_id, role, active) VALUES ($1, 'operator', false)`, [user.id]);
    await expect(requireAdmin(user.id)).rejects.toBeInstanceOf(NotAdminError);
  });

  it('allows an active admin and returns their role', async () => {
    const [user] = await query<{ id: string }>(
      `INSERT INTO user_profile (id) VALUES (gen_random_uuid()) RETURNING id`
    );
    await query(`INSERT INTO admin_user (user_id, role, active) VALUES ($1, 'admin', true)`, [user.id]);
    const admin = await requireAdmin(user.id);
    expect(admin.role).toBe('admin');
    expect(admin.userId).toBe(user.id);
  });
});
