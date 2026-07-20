// lib/db/account-data.ts — self-service data EXPORT + account DELETION (Task C,
// M4/G5). PIPEDA-aligned: a signed-in parent can download everything KIDS FUN
// holds about them, and can permanently delete their account.
//
// The single hard rule this module upholds: a user can only ever see or delete
// THEIR OWN rows. Every read and write here runs through withUserContext (the
// RLS-enforcing USER_DATABASE_URL `authenticated` role), NEVER lib/db/client.ts's
// service pool — so owner-only RLS (0013_rls_user.sql, auth.uid() = id/user_id)
// is the real, provable boundary, not an app-level WHERE clause. The explicit
// `id/user_id = $userId` filters below are defense-in-depth on top of that.
//
// WHAT COUNTS AS "the user's data" here is deliberately the set of tables keyed
// to the authenticated identity (auth.uid()): user_profile and saved_search.
// analytics_event / correction_report are keyed to an ANONYMOUS browser-session
// cookie (kf_anon_id), not the account identity — see the privacy review note
// (documents/execution/kids-fun-round10-taskC-privacy-review-2026-07-16.md) for
// why those are honestly out of scope for an account-scoped export/erase.
//
// EXTENSIBILITY: export is driven by the COLLECTORS registry below — adding a new
// user-owned table means adding one collector, and the export picks it up with no
// route change. Deletion is a small explicit list because FK order matters (child
// rows before the parent user_profile); the ordering rule is documented inline.
import { withUserContext, type UserScopedQuery } from './user-scoped-client';
import { resolveRecipientEmail } from '../email/recipients';

export const ACCOUNT_EXPORT_FORMAT = 'kids-fun/account-export';
export const ACCOUNT_EXPORT_VERSION = 1;

/** A single user-owned dataset, read under the RLS-scoped connection. */
interface DataCollector {
  /** Stable key used as the section name in the export document. */
  section: string;
  /** Human-readable description surfaced in the export's manifest. */
  description: string;
  /** Reads this user's rows for the section. MUST scope by userId (RLS also does). */
  collect(db: UserScopedQuery, userId: string): Promise<unknown>;
}

// Order is presentation-only for export (no FK concerns on a read).
const COLLECTORS: readonly DataCollector[] = [
  {
    section: 'profile',
    description:
      'Your saved profile: postal code, children’s ages (in months, legacy — no longer collected), ' +
      'email opt-in, your sign-in email, and account timestamps.',
    async collect(db, userId) {
      const rows = await db.query<Record<string, unknown>>(
        // google_identity is intentionally NOT selected here: as of F-9 it is no
        // longer stored (it only ever duplicated the auth.users email). We still
        // owe the user their email under PIPEDA, so we resolve it live below via
        // the same service-role path the weekly digest uses — never a stale copy.
        // saved_child_ages IS still selected so legacy values (collection stopped
        // in F-8) remain visible to the owner and fully exportable.
        `SELECT id,
                home_postal,
                saved_child_ages,
                email_opt_in,
                ST_AsGeoJSON(home_geo) AS home_geo,
                created_at,
                updated_at
           FROM user_profile
          WHERE id = $1`,
        [userId]
      );
      const row = rows[0] ?? null;
      if (!row) return null;
      // Resolve the sign-in email on-demand (auth.users via the service-role admin
      // API). Env-gated + non-throwing: in local/CI without a service-role key it
      // returns null, exactly like the digest — the export stays consistent.
      const { email } = await resolveRecipientEmail(userId);
      return { ...row, email };
    },
  },
  {
    section: 'saved_searches',
    description: 'Searches you saved (name, query parameters, and when they were created / last run).',
    async collect(db, userId) {
      return db.query<Record<string, unknown>>(
        `SELECT id, query_json, created_at, last_run_at
           FROM saved_search
          WHERE user_id = $1
          ORDER BY created_at`,
        [userId]
      );
    },
  },
];

/** Datasets NOT included in an account export, with an honest reason each. */
const EXCLUDED_DATASETS: readonly { dataset: string; reason: string }[] = [
  {
    dataset: 'analytics_event, correction_report',
    reason:
      'These usage/feedback events are keyed to an anonymous browser-session cookie (kf_anon_id), not to your ' +
      'account identity. They carry no name/email/postal, cannot be reliably linked back to your account, and ' +
      'auto-delete on a 13-month retention window. Linking them to your account just to export them would create ' +
      'more identifiable data than it removes, so they are intentionally left out.',
  },
];

export interface AccountExport {
  format: typeof ACCOUNT_EXPORT_FORMAT;
  version: typeof ACCOUNT_EXPORT_VERSION;
  exported_at: string; // ISO 8601
  user_id: string;
  manifest: {
    included: { section: string; description: string }[];
    excluded: { dataset: string; reason: string }[];
  };
  data: Record<string, unknown>;
}

/**
 * Build the full account export for `userId`. All collectors run inside ONE
 * RLS-scoped transaction, so the export is a consistent, owner-only snapshot —
 * another user's rows are invisible to the query (RLS), never merely filtered.
 */
export async function exportUserData(userId: string): Promise<AccountExport> {
  const data = await withUserContext(userId, async (db) => {
    const out: Record<string, unknown> = {};
    for (const c of COLLECTORS) {
      out[c.section] = await c.collect(db, userId);
    }
    return out;
  });

  return {
    format: ACCOUNT_EXPORT_FORMAT,
    version: ACCOUNT_EXPORT_VERSION,
    exported_at: new Date().toISOString(),
    user_id: userId,
    manifest: {
      included: COLLECTORS.map((c) => ({ section: c.section, description: c.description })),
      excluded: EXCLUDED_DATASETS.map((e) => ({ ...e })),
    },
    data,
  };
}

export interface AccountDeletionResult {
  saved_searches_deleted: number;
  profile_deleted: number;
}

/**
 * Permanently delete the user's account data in ONE RLS-scoped transaction.
 *
 * Deletion order is child-before-parent to respect the FK
 * saved_search.user_id -> user_profile.id: saved_search rows first, then the
 * user_profile row. Both DELETEs are gated by owner-only RLS (auth.uid() = ...),
 * so this can NEVER remove another user's rows. Because it's one transaction it's
 * atomic — if anything fails (e.g. an admin_user FK still references this
 * profile, Postgres error 23503), NOTHING is deleted and the error propagates for
 * the route to translate into an honest message.
 *
 * This is a genuine hard delete (not a soft-delete tombstone): the rows are gone.
 * No schema migration is required — the owner DELETE policies already exist.
 */
export async function deleteUserData(userId: string): Promise<AccountDeletionResult> {
  return withUserContext(userId, async (db) => {
    const savedSearches = await db.query<{ id: string }>(
      `DELETE FROM saved_search WHERE user_id = $1 RETURNING id`,
      [userId]
    );
    const profile = await db.query<{ id: string }>(
      `DELETE FROM user_profile WHERE id = $1 RETURNING id`,
      [userId]
    );
    return {
      saved_searches_deleted: savedSearches.length,
      profile_deleted: profile.length,
    };
  });
}
