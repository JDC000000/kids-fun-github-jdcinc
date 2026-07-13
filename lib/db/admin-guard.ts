// lib/db/admin-guard.ts — G-T6-4: admin role foundation (TSD §6.1 admin_user; <L3>).
// Foundation for the M5 admin console (not the console itself) — a single
// `requireAdmin` choke point every future admin route/action calls through.
import { query } from './client';

export class NotAdminError extends Error {
  constructor(message = 'not an active admin') {
    super(message);
    this.name = 'NotAdminError';
  }
}

export type AdminRole = 'operator' | 'admin' | 'superadmin';

export interface AdminUser {
  userId: string;
  role: AdminRole;
}

/** Throws NotAdminError unless userId is an active admin_user row. */
export async function requireAdmin(userId: string | null | undefined): Promise<AdminUser> {
  if (!userId) {
    throw new NotAdminError('no session');
  }
  const rows = await query<{ user_id: string; role: string }>(
    `SELECT user_id, role FROM admin_user WHERE user_id = $1 AND active = true`,
    [userId]
  );
  const row = rows[0];
  if (!row) {
    throw new NotAdminError();
  }
  return { userId: row.user_id, role: row.role as AdminRole };
}
