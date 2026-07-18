// lib/testing/test-user.ts — the identity of the dedicated E2E test user.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS (named safety requirement #2)
// ─────────────────────────────────────────────────────────────────────────────
// The harness signs in as a REAL Supabase Auth user. That user MUST be
// unmistakably identifiable as a synthetic test account in any audit trail,
// admin view, or database row — never confusable with a real parent's account.
//
// Two independent, enforced markers make it auditable (not just a naming
// convention nobody checks):
//
//   1. A RESERVED, non-deliverable email domain (`@e2e.kids-fun.test`). The
//      `.test` TLD is reserved by RFC 6761 and can never be registered or
//      receive mail, so a human account can never legitimately live on it. The
//      harness REFUSES to operate on any email outside this domain
//      (see isE2ETestEmail + the guard in test-session.ts), so the convention is
//      enforced in code, not by discipline.
//
//   2. A persisted marker object written to the auth user's `app_metadata` AND
//      `user_metadata` at creation time (E2E_TEST_USER_MARKER). Because it lives
//      on the auth.users row (raw_app_meta_data / raw_user_meta_data), it is
//      queryable and shows up in the Supabase admin/Studio user view:
//
//        SELECT id, email, raw_app_meta_data
//        FROM auth.users
//        WHERE raw_app_meta_data ->> 'is_e2e_test_user' = 'true';
//
// This module is under lib/testing/** and is NEVER imported by production code.

/** Reserved (RFC 6761 `.test` TLD), non-deliverable domain — flags the account as synthetic. */
export const E2E_TEST_EMAIL_DOMAIN = 'e2e.kids-fun.test';

/**
 * Persisted audit marker written to the auth user's app_metadata + user_metadata.
 * Queryable from the auth.users row and visible in the Supabase admin user view.
 */
export const E2E_TEST_USER_MARKER = {
  is_e2e_test_user: true,
  created_by: 'kids-fun-e2e-harness',
  purpose: 'automated-testing',
  // Anyone reviewing an audit trail can trace the account back to this code.
  source: 'tests/e2e (Round 14 / Task N)',
} as const;

/**
 * Local-only password for the test user's GoTrue account. This is NOT a secret:
 * it only ever authenticates against a loopback `supabase start` GoTrue (enforced
 * by the supabase-guard default-deny gate), and the test user cannot access any
 * real data. Overridable via env for a bespoke test project. It is never a
 * production credential and never logged.
 */
export const E2E_TEST_USER_PASSWORD =
  process.env.E2E_TEST_USER_PASSWORD || 'e2e-local-stack-only-not-a-secret-4f19c2';

function slug(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'default';
}

/** Build a clearly-flagged test email, e.g. buildTestUserEmail('account') -> "e2e+account@e2e.kids-fun.test". */
export function buildTestUserEmail(label = 'default'): string {
  return `e2e+${slug(label)}@${E2E_TEST_EMAIL_DOMAIN}`;
}

/** True iff `email` belongs to the reserved E2E test domain. The harness enforces this. */
export function isE2ETestEmail(email: string | null | undefined): boolean {
  return !!email && email.toLowerCase().endsWith(`@${E2E_TEST_EMAIL_DOMAIN}`);
}

/** The default account the authed E2E project signs in as. */
export const DEFAULT_TEST_USER = {
  label: 'default',
  email: buildTestUserEmail('default'),
} as const;
