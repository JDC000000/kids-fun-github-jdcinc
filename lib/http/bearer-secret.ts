// lib/http/bearer-secret.ts — shared-secret authentication for operator-only POST endpoints.
//
// The same two helpers app/api/admin/snapshot/refresh/run/route.ts defines inline (kept there
// untouched; it can adopt these when it is next edited).
import { timingSafeEqual } from 'node:crypto';

/** The secret a caller presented: `Authorization: Bearer <secret>`, or `x-cron-secret`. */
export function presentedSecret(request: Request): string | null {
  const auth = request.headers.get('authorization');
  if (auth && auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return request.headers.get('x-cron-secret');
}

/** Constant-time comparison. Length is compared first because timingSafeEqual throws on a mismatch. */
export function secretMatches(presented: string | null, expected: string): boolean {
  if (!presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
