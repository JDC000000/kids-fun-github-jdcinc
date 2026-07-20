// lib/user/profile-validate.ts — input validation for a profile PATCH.
//
// Task 24 (M4). Pure (no pg / no next imports) so it is trivially unit-testable
// and reusable by both the PATCH /api/me route and any future caller. Validates
// ONLY the user-editable columns of user_profile (0007_user_admin.sql):
//   • home_postal      — a saved Canadian postal code (Metro Vancouver focus),
//                         or null/'' to clear it.
//   • email_opt_in     — marketing/notification opt-in flag.
// saved_child_ages was REMOVED as an editable field by F-8 (PIPEDA / Round 25 Task
// WW): the app no longer collects children's ages, so the key is now treated like
// any other unknown field (rejected) — see the Task WW findings doc. Identity
// columns (id, google_identity) and the geocoded home_geo are NOT editable here
// by design — see the Task 24 findings doc.

/** The validated, normalized set of fields a user may change on their profile.
 *  A key is PRESENT only when the caller sent it (PATCH semantics: absent = leave
 *  as-is). `home_postal: null` is a meaningful value — "clear my saved postal". */
export interface ProfilePatch {
  home_postal?: string | null;
  email_opt_in?: boolean;
}

export type ParseResult =
  | { ok: true; value: ProfilePatch }
  | { ok: false; error: string };

// Constraints (exported so tests and the UI can reference the same limits).
export const EDITABLE_KEYS = ['home_postal', 'email_opt_in'] as const;
export const MAX_POSTAL_LEN = 12;

// Lenient Canadian postal-code shape: letter-digit-letter [space] digit-letter-digit.
// We normalize case/spacing before matching, so "v6b1a1" and "V6B 1A1" both pass.
const CA_POSTAL_RE = /^[A-Za-z]\d[A-Za-z]\s?\d[A-Za-z]\d$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Normalize a Canadian postal code to canonical "A1A 1A1" (uppercase, single
 * space). Returns null on anything that isn't a well-formed postal code.
 */
export function normalizePostal(raw: string): string | null {
  const collapsed = raw.trim().replace(/\s+/g, '');
  if (collapsed.length === 0) return null;
  if (!CA_POSTAL_RE.test(collapsed)) return null;
  return `${collapsed.slice(0, 3)} ${collapsed.slice(3)}`.toUpperCase();
}

/**
 * Validate an untrusted JSON body into a ProfilePatch. Rejects (ok:false) on:
 *   • a non-object body,
 *   • an empty patch (no editable field supplied),
 *   • any unknown key (guards against typos silently no-op'ing),
 *   • a malformed value for any supplied field.
 */
export function parseProfilePatch(body: unknown): ParseResult {
  if (!isPlainObject(body)) {
    return { ok: false, error: 'body must be a JSON object' };
  }

  const unknown = Object.keys(body).filter(
    (k) => !(EDITABLE_KEYS as readonly string[]).includes(k)
  );
  if (unknown.length > 0) {
    return { ok: false, error: `unknown field(s): ${unknown.join(', ')}` };
  }

  const patch: ProfilePatch = {};

  if ('home_postal' in body) {
    const v = body.home_postal;
    if (v === null) {
      patch.home_postal = null;
    } else if (typeof v === 'string') {
      if (v.length > MAX_POSTAL_LEN + 4) {
        return { ok: false, error: 'home_postal is too long' };
      }
      if (v.trim() === '') {
        patch.home_postal = null; // empty string clears the saved postal
      } else {
        const normalized = normalizePostal(v);
        if (normalized === null) {
          return { ok: false, error: 'home_postal must be a valid Canadian postal code (e.g. V6B 1A1)' };
        }
        patch.home_postal = normalized;
      }
    } else {
      return { ok: false, error: 'home_postal must be a string or null' };
    }
  }

  if ('email_opt_in' in body) {
    const v = body.email_opt_in;
    if (typeof v !== 'boolean') {
      return { ok: false, error: 'email_opt_in must be a boolean' };
    }
    patch.email_opt_in = v;
  }

  if (Object.keys(patch).length === 0) {
    return { ok: false, error: 'no editable fields supplied' };
  }

  return { ok: true, value: patch };
}
