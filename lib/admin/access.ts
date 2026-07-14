// lib/admin/access.ts — TEMPORARY shared-secret gate for the internal admin dashboard (M5, first slice).
//
// ⚠️ INTERIM ACCESS CONTROL ONLY. This is a stopgap so the M5 admin/health
// dashboard can ship a read-only ops view before real role-based admin auth exists.
// Real auth (lib/db/admin-guard.ts `requireAdmin` over an authenticated session) is
// owned by the parallel account/session stream and MUST replace this gate once it
// lands. Do not build durable admin surfaces on top of this token check.
//
// The expected secret is read from the ADMIN_DASHBOARD_TOKEN env var — never
// hardcoded, never committed. If the env var is unset/empty the gate FAILS CLOSED
// (deny everyone) so a misconfigured deploy can never expose the dashboard un-gated.
import { timingSafeEqual } from 'node:crypto';

export const ADMIN_DASHBOARD_TOKEN_ENV = 'ADMIN_DASHBOARD_TOKEN';
export const ADMIN_TOKEN_HEADER = 'x-admin-token';
export const ADMIN_TOKEN_QUERY_PARAM = 'token';

export type AdminAccessDenyReason = 'not_configured' | 'missing_token' | 'bad_token';

export interface AdminAccessResult {
  ok: boolean;
  reason?: AdminAccessDenyReason;
}

/** Constant-time compare that does not leak length via early return. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) {
    // Burn one same-length comparison so a length mismatch costs ~the same as a
    // value mismatch — keeps the timing signal flat.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/**
 * Decide whether a caller may view the admin dashboard, given the token they
 * presented. Pure and DB-free so it is trivially unit-testable. Reads the expected
 * secret from the environment at call time (never caches it).
 */
export function checkAdminDashboardAccess(providedToken: string | null | undefined): AdminAccessResult {
  const expected = process.env[ADMIN_DASHBOARD_TOKEN_ENV];
  if (!expected || expected.length === 0) {
    return { ok: false, reason: 'not_configured' };
  }
  if (!providedToken || providedToken.length === 0) {
    return { ok: false, reason: 'missing_token' };
  }
  if (!safeEqual(providedToken, expected)) {
    return { ok: false, reason: 'bad_token' };
  }
  return { ok: true };
}

/**
 * Pick the presented token, preferring the request header (not logged in URLs)
 * over the query param (browser convenience). A query-param value may arrive as an
 * array if repeated; only a single string is accepted.
 */
export function resolvePresentedToken(
  headerValue: string | null | undefined,
  queryValue: string | string[] | null | undefined
): string | null {
  if (typeof headerValue === 'string' && headerValue.length > 0) return headerValue;
  if (typeof queryValue === 'string' && queryValue.length > 0) return queryValue;
  return null;
}
