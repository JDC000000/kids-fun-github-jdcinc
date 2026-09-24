// app/admin/_lib/gate.ts — the admin access gate (<L3>).
//
// Every admin page calls resolveAdminAccess(); every admin WRITE calls resolveSessionAdmin().
// Both resolve the same identity: a signed-in Supabase session (lib/db/session-user.ts
// `getRequestUser`) whose user is an active admin_user row (lib/db/admin-guard.ts `requireAdmin`).
// That is the ONLY way in.
//
// ── THE INTERIM SHARED-SECRET TOKEN IS GONE, AND MUST NOT COME BACK ────────────────────────
// Until 2026-09-24 this gate also accepted ADMIN_DASHBOARD_TOKEN, presented as an `x-admin-token`
// header or — the part that did the damage — a `?token=` query param. A secret in a URL lands in
// browser history, server request logs, Referer headers and screenshots, and this one unlocked
// /admin/sms-subscribers: full subscriber phone numbers, postal codes and children's ages. The
// env var was unset on 2026-09-24 as a PII-exposure fix; this change removes the code that would
// have honoured it again the moment anyone re-set it. A request's URL and headers are now simply
// not an input to this function — AdminGateRequest has no field that could carry a credential.
//
// tests/compliance/admin-no-url-credentials.test.ts pins that structurally (no token plumbing
// anywhere in app/, lib/ or components/) and behaviourally (with ADMIN_DASHBOARD_TOKEN SET, every
// admin page still 404s a request carrying `?token=` and `x-admin-token`). If you need a
// non-interactive way into the console, use a real session for a seeded admin_user — never a
// shared secret, and never a credential in a URL.
//
// ── WHY A SHARED FUNCTION, NOT app/admin/layout.tsx ────────────────────────────────────────
// One choke point, called by every page, so each page decides its own refusal (notFound()) and
// passes its own surface id to the access audit. (The original reason — layouts cannot read
// searchParams, which the token path needed — no longer applies; moving the call into a layout is
// a possible later tidy-up, not something this change needs.)
//
// ── FAIL-CLOSED ─────────────────────────────────────────────────────────────────────────────
// ANY failure on the session/role path — anonymous, non-admin, Supabase unconfigured, database
// unreachable — denies. There is no fallback path any more, so an infrastructure error now means
// "404 until it recovers", which is the correct failure for a console that shows personal data.
import { getRequestUser } from '@/lib/db/session-user';
import { requireAdmin, NotAdminError, type AdminUser } from '@/lib/db/admin-guard';
import { recordAdminAccess } from '@/lib/admin/audit';

export type AdminAccessGrant = { ok: true; via: 'session'; admin: AdminUser } | { ok: false };

export interface AdminGateRequest {
  /** Logical admin surface id, for the access audit log, e.g. 'admin_dashboard'. */
  surface: string;
}

/**
 * Resolve whether the current request may view an admin surface.
 *
 * Returns a discriminated result; the caller decides the consequence (an admin page calls
 * `notFound()` on `{ ok: false }` to keep the route's existence unadvertised).
 *
 * Side effect: on a grant, records a best-effort `admin.view` row in admin_audit_log.
 */
export async function resolveAdminAccess(req: AdminGateRequest): Promise<AdminAccessGrant> {
  const admin = await trySessionAdmin();
  if (!admin) return { ok: false };
  // Best-effort audit — never blocks access if the write fails.
  await recordAdminAccess(admin.userId, req.surface);
  return { ok: true, via: 'session', admin };
}

/**
 * Resolve the acting admin for a MUTATION — the signed-in session + active admin_user row. Returns
 * the AdminUser (whose `userId` satisfies the admin_audit_log FK) or `null` for anyone else. Every
 * admin mutation must be attributable in admin_audit_log, whose admin_user_id is a NOT NULL FK to
 * admin_user. Never throws.
 */
export async function resolveSessionAdmin(): Promise<AdminUser | null> {
  return trySessionAdmin();
}

/**
 * Attempt the session+role path, resolving to the AdminUser on success or `null` on ANY failure
 * (anonymous, non-admin, Supabase unconfigured, DB error). Never throws.
 */
async function trySessionAdmin(): Promise<AdminUser | null> {
  try {
    const user = await getRequestUser(); // never throws; null when not signed in
    if (!user) return null;
    return await requireAdmin(user.userId); // throws NotAdminError for a non-admin
  } catch (err) {
    if (!(err instanceof NotAdminError)) {
      // A real infrastructure error (e.g. DB unreachable). Deny, and log for observability —
      // message only, never the session or any secret.
      // eslint-disable-next-line no-console
      console.warn(`[admin-gate] session/role check errored, denying: ${(err as Error)?.message ?? 'unknown error'}`);
    }
    return null;
  }
}
