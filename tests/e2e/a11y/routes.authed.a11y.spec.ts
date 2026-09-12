import { test } from '@playwright/test';

// Project-wide WCAG AA accessibility AUDIT — authenticated routes. Runs under the
// `a11y-authed` (light) and `a11y-authed-dark` (dark) projects, reusing the SAME real injected
// Supabase session (storageState) as authed/account.authed.spec.ts. AUDIT-ONLY: records every
// axe-core violation to a durable artifact + the report; never fails on findings, never fixes
// them (Round 17 / Task W → canonical G-T38-4).
//
// ── THERE ARE CURRENTLY NO AUTHENTICATED ROUTES TO AUDIT (2026-09-12) ────────────────────
// This file audited exactly one route, /account, with a saved search seeded so it was measured in
// its populated state. Jon gated Google sign-in ("nobody can sign in with google"), so /account
// now 404s for everyone — including a holder of a real, valid session, which is asserted in
// authed/account.authed.spec.ts. Running axe against it would audit the 404 page, which the anon
// suite already covers and which would silently turn a meaningful audit into a meaningless green.
//
// SKIPPED RATHER THAN DELETED, deliberately:
//   · the `a11y-authed` / `a11y-authed-dark` projects and the session harness they depend on are
//     still wired and working; deleting the only spec that uses them would make them look
//     vestigial to the next reader and invite their removal too;
//   · the authed audit becomes meaningful again the moment ANY authenticated surface returns —
//     un-skipping is then one line plus a route;
//   · a deleted file records nothing about why the coverage went away, and "the a11y audit used
//     to cover more" is exactly the kind of quiet regression this audit exists to prevent.
//
// PUBLIC A11Y COVERAGE IS UNAFFECTED — a11y/routes.anon.a11y.spec.ts audits the real product
// surfaces (and the admin ones via token), and that is where every page a visitor can now reach
// actually lives. Nothing this file used to cover is left unaudited except the page nobody can
// open.
test.describe('a11y audit — authenticated routes', () => {
  test.skip('axe: /account (signed-in, saved search rendered)', async () => {
    // Intentionally empty. See the block comment above: /account is gated and there is no other
    // authenticated route. Restore this body — `auditRoute(page, testInfo, '/account', …)` with
    // its seedSavedSearch/clearSavedSearchById fixture — if the account area ever comes back.
  });
});
