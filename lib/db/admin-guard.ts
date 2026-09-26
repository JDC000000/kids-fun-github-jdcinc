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

export type AdminRole = 'operator' | 'admin' | 'superadmin' | 'viewer';

// ── WHAT EACH ROLE MAY DO ────────────────────────────────────────────────────────────────────
// Until 2026-09-24 nothing read `role`: every active admin_user row could write and saw full
// personal data. The three HUMAN roles keep exactly that. 'viewer' (migration 0055) is the
// read-only, PII-redacted role for the agent test login (staging only; see
// documents/kids-fun/agent-test-admin-login-SCOPE-2026-09-24.md).
//
// Both capabilities are ALLOW-lists, not "everything except viewer" deny-lists: a role this code
// does not recognise — a typo, a value added to the CHECK later without updating this file, a
// string cast in from the database — gets NEITHER capability. Fail closed.
const WRITE_ROLES: ReadonlySet<string> = new Set<AdminRole>(['operator', 'admin', 'superadmin']);
const PERSONAL_DATA_ROLES: ReadonlySet<string> = new Set<AdminRole>(['operator', 'admin', 'superadmin']);

/** May this admin make changes (the 9 admin server actions, the catalogue-cache bust)? */
export function canWrite(role: string | null | undefined): boolean {
  return typeof role === 'string' && WRITE_ROLES.has(role);
}

/**
 * May this admin see subscribers' personal data unredacted (phone numbers, postal codes, children's
 * birth years and ages, the per-subscriber FSA, free-text correction notes) and run the SMS preview?
 */
export function canSeePersonalData(role: string | null | undefined): boolean {
  return typeof role === 'string' && PERSONAL_DATA_ROLES.has(role);
}

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
