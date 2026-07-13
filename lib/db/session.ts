// lib/db/session.ts — G-T6-2: anonymous session context (TSD §3A.1 NR-03/04).
// Search/browse must never require auth. A stable per-browser anon id is
// used only to correlate analytics_event rows (user_or_session) — it is
// NEVER an authorization boundary (no RLS or admin check depends on it).
import { randomUUID } from 'node:crypto';

export const ANON_SESSION_COOKIE = 'kf_anon_id';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Returns the existing anon id if it's a well-formed UUID, else mints a new one. */
export function getOrCreateAnonId(existing: string | undefined | null): string {
  if (existing && UUID_RE.test(existing)) {
    return existing;
  }
  return randomUUID();
}

export interface AnonSessionContext {
  anonId: string;
  isAuthenticated: boolean;
  userId: string | null;
}

/** Resolves the request-scoped session context. Anonymous requests always
 *  succeed (isAuthenticated=false, anonId still set) — search/browse never
 *  gates on this returning an authenticated user. */
export function resolveSessionContext(
  anonCookie: string | undefined | null,
  userId: string | null
): AnonSessionContext {
  return {
    anonId: getOrCreateAnonId(anonCookie),
    isAuthenticated: Boolean(userId),
    userId: userId ?? null,
  };
}
