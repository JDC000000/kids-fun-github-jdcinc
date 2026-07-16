// lib/db/auth-admin.ts — best-effort removal of the Supabase Auth IDENTITY
// (the auth.users row: email + Google identity linkage) on account deletion.
//
// Our application data lives in the `public` schema and is hard-deleted under RLS
// by lib/db/account-data.ts. The user's *login identity*, however, is owned by
// Supabase Auth (the Supabase-managed `auth` schema), which our RLS/data layer
// cannot touch. Fully honouring "delete my account" means also deleting that
// identity so the same Google account starts fresh on any future sign-up.
//
// That requires the Supabase Admin API, which needs the SERVICE-ROLE key — a
// high-privilege secret. This helper is therefore:
//   • ENV-GATED: it only acts when SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are
//     configured (staging/production). Where they aren't (local, CI, or an
//     environment that deliberately withholds the service role), it reports
//     `attempted: false` and the caller records the identity removal as a known,
//     documented gap rather than silently claiming an erasure it didn't perform.
//   • BEST-EFFORT + NON-THROWING: any failure resolves to a structured result so
//     the surrounding deletion flow (which already removed the app data) is never
//     broken by an auth-provider hiccup.
import { createClient } from '@supabase/supabase-js';

export interface AuthIdentityDeletion {
  /** true if a service-role deletion was actually attempted (env configured). */
  attempted: boolean;
  /** true only if the identity was confirmed removed. */
  ok: boolean;
  /** Short, non-sensitive reason when attempted=false or ok=false. */
  reason?: string;
}

export async function deleteAuthIdentity(userId: string): Promise<AuthIdentityDeletion> {
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    return { attempted: false, ok: false, reason: 'service-role key not configured in this environment' };
  }

  try {
    // Admin client: no session persistence / token refresh — one-shot admin call.
    const admin = createClient(url, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { error } = await admin.auth.admin.deleteUser(userId);
    if (error) {
      return { attempted: true, ok: false, reason: error.message };
    }
    return { attempted: true, ok: true };
  } catch (err) {
    return { attempted: true, ok: false, reason: (err as Error)?.message ?? 'unknown error' };
  }
}
