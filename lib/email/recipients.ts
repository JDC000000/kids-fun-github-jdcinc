// lib/email/recipients.ts — resolve a user's email address for the digest.
//
// The email address is NOT in our `public` schema — it lives in the Supabase-managed
// auth.users row (see the Task C privacy review). Reaching it requires the Supabase
// Admin API and the SERVICE-ROLE key, exactly like lib/db/auth-admin.ts. This helper
// mirrors that module's posture:
//   • ENV-GATED — only acts when SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are set
//     (staging/prod); otherwise reports attempted:false so local/CI never depends on
//     a real auth backend (tests mock this module).
//   • NON-THROWING — any failure resolves to a structured result.
import { createClient } from '@supabase/supabase-js';

export interface RecipientEmail {
  /** The resolved email, or null if unavailable. */
  email: string | null;
  /** True if a service-role lookup was actually attempted (env configured). */
  attempted: boolean;
  /** Short, non-sensitive reason when email is null. */
  reason?: string;
}

export async function resolveRecipientEmail(userId: string): Promise<RecipientEmail> {
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    return { email: null, attempted: false, reason: 'service-role key not configured in this environment' };
  }

  try {
    const admin = createClient(url, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await admin.auth.admin.getUserById(userId);
    if (error) return { email: null, attempted: true, reason: error.message };
    return { email: data.user?.email ?? null, attempted: true };
  } catch (err) {
    return { email: null, attempted: true, reason: (err as Error)?.message ?? 'unknown error' };
  }
}
