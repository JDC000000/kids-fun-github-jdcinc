import { test } from '@playwright/test';
import { auditRoute } from './axe-helper';
import { clearSavedSearchById, readTestUser, seedSavedSearch } from '../helpers/db';

// Project-wide WCAG AA accessibility AUDIT — authenticated routes. Runs under the
// `a11y-authed` (light) and `a11y-authed-dark` (dark) projects, reusing the SAME real
// injected Supabase session (storageState) as authed/account.authed.spec.ts. AUDIT-ONLY:
// records every axe-core violation to a durable artifact + the report; never fails on
// findings, never fixes them (Round 17 / Task W → canonical G-T38-4).

test.describe('a11y audit — authenticated routes', () => {
  test('axe: /account (signed-in, saved search rendered)', async ({ page }, testInfo) => {
    // Seed one saved search so the account page is audited in its POPULATED state (the
    // saved-search list items, not just the empty state). Owner-level fixture write,
    // cleaned up after — the app still reads it back through its RLS path (see helpers/db).
    const { id: userId } = readTestUser();
    const name = `A11y audit ${testInfo.project.name} ${testInfo.testId}`;
    const savedId = await seedSavedSearch(userId, name);
    try {
      await auditRoute(page, testInfo, '/account', 'account (authed)');
    } finally {
      await clearSavedSearchById(savedId);
    }
  });
});
