// lib/admin/audit.ts — G-T34-2: admin audit-log write helper (TSD §6.1 admin_audit_log; <L3>).
//
// The `admin_audit_log` table already exists (migration 0007_user_admin.sql) and is
// RLS default-deny (migration 0014_admin_rls.sql) — it is only ever meant to be
// written via the service-role pool (lib/db/client.ts `query`, which bypasses RLS
// by design), NEVER via the anon/authenticated REST surface. This module is the
// single application-layer writer every future admin mutation goes through.
//
// Schema recap (0007):
//   admin_user_id  uuid NOT NULL REFERENCES admin_user(user_id)  -- who did it
//   action         text NOT NULL                                 -- what they did
//   target_table   text NOT NULL                                 -- what it touched
//   target_id      uuid                                          -- which row (nullable)
//   before_json    jsonb                                         -- prior state (nullable)
//   after_json     jsonb                                         -- new state (nullable)
//
// FK CONSEQUENCE (important): admin_user_id is NOT NULL and references admin_user.
// An audit row can therefore only be written for a caller who is a real, seeded
// admin (an active admin_user row). The interim shared-secret token path
// (lib/admin/access.ts) has NO admin identity, so token access CANNOT be audited
// here — a further reason that token gate is interim and should be retired once
// real admins are seeded. Callers on the token path must not attempt an audit write.
import { query } from '../db/client';

/**
 * Canonical admin audit actions. Kept as string constants (not an enum) so the
 * column stays free-text/forward-compatible while giving callers a typo-proof set.
 * Phase-1 (T34) only needs the access/view events; mutation actions land with the
 * no-code CRUD console (Phase 2+).
 */
export const ADMIN_AUDIT_ACTIONS = {
  /** A real admin (session + role) viewed an admin surface. Groundwork usage. */
  VIEW: 'admin.view',
} as const;

export interface AdminAuditEntry {
  /** The acting admin's user id. MUST be an active admin_user (FK-enforced). */
  adminUserId: string;
  /** What happened, e.g. ADMIN_AUDIT_ACTIONS.VIEW or a future mutation verb. */
  action: string;
  /**
   * What was touched. For mutations this is the DB table name; for access/view
   * events (no DB row involved) it is the logical admin surface id, e.g.
   * 'admin_dashboard' / 'admin_data_health'. NOT NULL in the schema, so callers
   * must always supply something meaningful.
   */
  targetTable: string;
  /** The specific row id for a mutation. Null/omitted for surface-level events. */
  targetId?: string | null;
  /** Prior state for a mutation (serialized to jsonb). Omitted for reads. */
  before?: unknown;
  /** New state for a mutation (serialized to jsonb). Omitted for reads. */
  after?: unknown;
}

/**
 * Insert one admin_audit_log row via the service pool and return its id.
 *
 * THROWS on failure (bad FK, DB down, …). Use this from mutation paths where a
 * failed audit write should abort the mutation (no un-audited admin change). For
 * the non-critical access-logging path, use {@link recordAdminAccess}, which
 * swallows failures so a logging hiccup can never block a legitimate admin.
 */
export async function writeAdminAudit(entry: AdminAuditEntry): Promise<string> {
  const rows = await query<{ id: string }>(
    `INSERT INTO admin_audit_log
       (admin_user_id, action, target_table, target_id, before_json, after_json)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)
     RETURNING id`,
    [
      entry.adminUserId,
      entry.action,
      entry.targetTable,
      entry.targetId ?? null,
      entry.before === undefined ? null : JSON.stringify(entry.before),
      entry.after === undefined ? null : JSON.stringify(entry.after),
    ]
  );
  return rows[0].id;
}

/**
 * Best-effort record that a real admin accessed an admin surface (Phase-1
 * groundwork: proves the audit mechanism end-to-end before any mutation exists).
 *
 * NON-THROWING by design — mirrors lib/db/auth-admin.ts's best-effort posture:
 * admin *access* must never be blocked by an audit-log write failure (that would
 * be a self-inflicted lockout on the very surface we are trying to protect). A
 * failure is swallowed and reported in the boolean result; the caller proceeds.
 *
 * @returns true if the audit row was written, false if the write failed (logged).
 */
export async function recordAdminAccess(adminUserId: string, surface: string): Promise<boolean> {
  try {
    await writeAdminAudit({
      adminUserId,
      action: ADMIN_AUDIT_ACTIONS.VIEW,
      targetTable: surface,
    });
    return true;
  } catch (err) {
    // Non-sensitive: surface id + error message only, never the admin's session
    // or any secret. Kept observable so a persistently-failing audit path is
    // visible in logs without ever breaking access.
    // eslint-disable-next-line no-console
    console.warn(`[admin-audit] failed to record access to "${surface}": ${(err as Error)?.message ?? 'unknown error'}`);
    return false;
  }
}
