import { test } from '@playwright/test';
import { auditRoute } from './axe-helper';

// Project-wide WCAG AA accessibility AUDIT — anonymous (unauthenticated) routes.
// Runs under the `a11y-anon` (light) and `a11y-anon-dark` (dark) projects. AUDIT-ONLY:
// records every axe-core violation to a durable artifact + the report; it never fails
// on findings and never fixes them (Round 17 / Task W → canonical G-T38-4).
//
// Every route here is one the existing E2E harness already knows how to reach with no
// auth (it mirrors public/*.public.spec.ts) PLUS the home front door (`/`) and the
// canonical /activity/[id] detail route. Detail ids use a visual fixture that resolves
// without a database (app/preview/_data/fixtures.ts), so the audit is stable regardless
// of DB contents — the same reason the existing public specs are DB-independent.

const ANON_ROUTES: { route: string; label: string }[] = [
  { route: '/', label: 'home' },
  { route: '/search', label: 'search (no query)' },
  { route: '/search?q=swim&region=van', label: 'search (query + region filter)' },
  { route: '/preview', label: 'preview shell' },
  { route: '/preview/templeton-family-swim', label: 'preview detail /preview/[id]' },
  { route: '/activity/templeton-family-swim', label: 'activity detail /activity/[id]' },
];

test.describe('a11y audit — anonymous routes', () => {
  for (const { route, label } of ANON_ROUTES) {
    test(`axe: ${label}`, async ({ page }, testInfo) => {
      await auditRoute(page, testInfo, route, label);
    });
  }
});

// --- Admin routes (project-wide sweep) -------------------------------------------
// /admin/dashboard is gated by a shared secret (ADMIN_DASHBOARD_TOKEN) — it is NOT
// session/role-gated, so it needs no auth *plumbing*, only the token present in BOTH
// the app server env and this test env. The E2E harness (scripts/e2e/setup-local-
// supabase.sh) does NOT provision ADMIN_DASHBOARD_TOKEN, so lib/admin/access.ts fails
// closed and the route 404s. Wiring that token is deliberately OUT OF SCOPE for this
// audit-only round — so this is recorded as an explicit AUDIT GAP (a visible skip),
// not silently omitted. A follow-up round can set ADMIN_DASHBOARD_TOKEN and this audit
// then covers /admin/dashboard automatically. See docs/a11y-audit.md.
test.describe('a11y audit — admin (gated; audit gap this round)', () => {
  const adminToken = process.env.ADMIN_DASHBOARD_TOKEN;

  test('axe: /admin/dashboard', async ({ page }, testInfo) => {
    test.skip(
      !adminToken,
      'AUDIT GAP: the E2E harness does not provision ADMIN_DASHBOARD_TOKEN, so ' +
        '/admin/dashboard fails closed (404). Wiring the admin token is out of scope for ' +
        'this audit-only round — set ADMIN_DASHBOARD_TOKEN in the app + test env to enable ' +
        'this audit in a follow-up round. See docs/a11y-audit.md.',
    );
    await auditRoute(page, testInfo, `/admin/dashboard?token=${adminToken}`, 'admin dashboard');
  });
});
