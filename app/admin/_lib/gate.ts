// app/admin/_lib/gate.ts — G-T34-1: the real admin access gate (<L3>).
//
// Wires the already-built role gate (lib/db/admin-guard.ts `requireAdmin`) over an
// authenticated session (lib/db/session-user.ts `getRequestUser`, the same session
// read /account and the parent surfaces use) into the admin routes — replacing the
// INTERIM shared-secret token gate (lib/admin/access.ts) as the *primary* path.
//
// ── COEXISTENCE, NOT HARD CUTOVER (production-safety requirement) ───────────────
// Access is granted if EITHER path passes:
//   (1) a signed-in session whose user is an active admin_user row  (the real gate),
//   OR (2) the existing ADMIN_DASHBOARD_TOKEN shared secret          (interim fallback).
// This is deliberate. Until the first real admin_user row is seeded, path (1) never
// matches and the token keeps working EXACTLY as it does today — so wiring the real
// gate carries ZERO regression risk and cannot lock out the current token holder.
// Once real admins are seeded (and verified), the token fallback can be removed in a
// later, separate change; this file is the one place that decision is expressed.
//
// ── WHY A SHARED FUNCTION, NOT app/admin/layout.tsx ────────────────────────────
// A Next.js layout is the tempting "single choke point", but layouts do NOT receive
// `searchParams` — so a layout gate could not read the `?token=` query-param the
// interim gate accepts, silently breaking that access mode (a regression / potential
// lockout for anyone using the URL token). The pages, which DO get searchParams, call
// this one function instead: same single choke point, without dropping the query token.
//
// ── FAIL-SAFE ORDERING ─────────────────────────────────────────────────────────
// The session/role check runs first (preferred, auditable identity) but is wrapped so
// that ANY error on that newer path — DB down, Supabase unconfigured, a non-admin —
// falls through to the token check rather than denying. A hiccup on the new gate can
// never take away access the token would otherwise grant. The token path is a pure
// env-var compare (no DB), so it stays available even if Postgres is unreachable.
import { getRequestUser } from '@/lib/db/session-user';
import { requireAdmin, NotAdminError, type AdminUser } from '@/lib/db/admin-guard';
import { checkAdminDashboardAccess, resolvePresentedToken } from '@/lib/admin/access';
import { recordAdminAccess } from '@/lib/admin/audit';

export type AdminAccessGrant =
  | { ok: true; via: 'session'; admin: AdminUser }
  | { ok: true; via: 'token' }
  | { ok: false };

export interface AdminGateRequest {
  /** Logical admin surface id, for the access audit log, e.g. 'admin_dashboard'. */
  surface: string;
  /** The `x-admin-token` request header value (interim token path). */
  headerToken: string | null | undefined;
  /** The `?token=` query-param value from the page's searchParams (interim path). */
  queryToken: string | string[] | null | undefined;
}

/**
 * Resolve whether the current request may view an admin surface.
 *
 * Returns a discriminated result; the caller decides the consequence (an admin page
 * calls `notFound()` on `{ ok: false }` to keep the route's existence unadvertised —
 * the same fail-closed 404 posture as today).
 *
 * Side effect: on a successful SESSION grant only, records a best-effort admin-access
 * row in admin_audit_log (proves the audit mechanism end-to-end — Phase-1 groundwork).
 * The token path is never audited: it has no admin identity to satisfy the audit FK.
 */
export async function resolveAdminAccess(req: AdminGateRequest): Promise<AdminAccessGrant> {
  // (1) Preferred: real signed-in admin (session + active admin_user row).
  const sessionAdmin = await trySessionAdmin();
  if (sessionAdmin) {
    // Best-effort audit — never blocks access if the write fails.
    await recordAdminAccess(sessionAdmin.userId, req.surface);
    return { ok: true, via: 'session', admin: sessionAdmin };
  }

  // (2) Coexistence fallback: the interim shared-secret token, unchanged.
  const presented = resolvePresentedToken(req.headerToken, req.queryToken);
  if (checkAdminDashboardAccess(presented).ok) {
    return { ok: true, via: 'token' };
  }

  return { ok: false };
}

/**
 * Attempt the session+role path, resolving to the AdminUser on success or `null`
 * on ANY failure (anonymous, non-admin, Supabase unconfigured, DB error). Never
 * throws — the caller must always be able to fall through to the token path.
 */
async function trySessionAdmin(): Promise<AdminUser | null> {
  try {
    const user = await getRequestUser(); // never throws; null when not signed in
    if (!user) return null;
    return await requireAdmin(user.userId); // throws NotAdminError for a non-admin
  } catch (err) {
    if (!(err instanceof NotAdminError)) {
      // A real infrastructure error (e.g. DB unreachable) on the NEW path — do not
      // leak it and do not deny; fall through to the token fallback so this cannot
      // become a lockout. Log for observability (message only, no session/secret).
      // eslint-disable-next-line no-console
      console.warn(`[admin-gate] session/role check errored, falling back to token: ${(err as Error)?.message ?? 'unknown error'}`);
    }
    return null;
  }
}
