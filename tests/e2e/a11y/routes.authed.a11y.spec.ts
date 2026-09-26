import { expect, test } from '@playwright/test';
import { auditRoute } from './axe-helper';
import { readTestUser, seedTestUserAsAdmin } from '../helpers/db';

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
// surfaces, and that is where every page a visitor can now reach
// actually lives. Nothing this file used to cover is left unaudited except the page nobody can
// open.
test.describe('a11y audit — authenticated routes', () => {
  test.skip('axe: /account (signed-in, saved search rendered)', async () => {
    // Intentionally empty. See the block comment above: /account is gated and there is no other
    // authenticated route. Restore this body — `auditRoute(page, testInfo, '/account', …)` with
    // its seedSavedSearch/clearSavedSearchById fixture — if the account area ever comes back.
  });
});

// --- Admin routes (project-wide sweep) -------------------------------------------
// The admin console is reachable ONLY through a signed-in session whose user is an active
// admin_user row (app/admin/_lib/gate.ts). Until 2026-09-24 this sweep lived in the anon spec and
// got in with the interim `?token=` shared secret; that path is removed. It now uses the SAME
// real injected session as the rest of this project, with the test user made an admin in the
// LOCAL e2e database (seedTestUserAsAdmin refuses any non-local DATABASE_URL).
//
// The h1 assertion is kept from the old sweep: a gate/env regression would otherwise turn every
// admin finding into a silent "clean" audit of a Next.js not-found page.
test.describe('a11y audit — admin (session-gated surfaces)', () => {
  test.beforeAll(async () => {
    await seedTestUserAsAdmin(readTestUser().id);
  });

  // /admin/operating is audited in BOTH review modes (?view=day | ?view=month): the grain switches
  // the KPI grid, the section headings and the whole detail table, so one mode does not stand in
  // for the other.
  const ADMIN_ROUTES: { route: string; label: string }[] = [
    { route: '/admin/dashboard', label: 'admin dashboard' },
    { route: '/admin/operating?view=day', label: 'admin operating (daily review)' },
    { route: '/admin/operating?view=month', label: 'admin operating (monthly review)' },
    { route: '/admin/product-health', label: 'admin product-health' },
    { route: '/admin/data-health', label: 'admin data-health' },
  ];

  for (const { route, label } of ADMIN_ROUTES) {
    test(`axe: ${label}`, async ({ page }, testInfo) => {
      const audit = await auditRoute(page, testInfo, route, label);
      await expect(page.locator('h1'), `${route} rendered the real admin surface, not a 404`)
        .toContainText('KIDS FUN');
      expect(audit.url, 'audit ran against the requested admin route').toContain('/admin/');
      expect(audit.url, 'no credential in the audited URL').not.toContain('token=');
    });
  }
});
