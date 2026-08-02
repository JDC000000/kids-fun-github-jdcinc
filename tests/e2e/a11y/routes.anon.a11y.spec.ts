import { expect, test } from '@playwright/test';
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

interface AnonRoute {
  route: string;
  label: string;
  /** Phone viewport, for a surface that only exists below the 768px breakpoint. */
  viewport?: { width: number; height: number };
  /** Interaction that reveals the surface under audit (see auditRoute's `prepare`). */
  prepare?: (page: import('@playwright/test').Page) => Promise<void>;
}

const ANON_ROUTES: AnonRoute[] = [
  { route: '/', label: 'home' },
  { route: '/search', label: 'search (no query)' },
  { route: '/search?q=swim&region=van', label: 'search (query + region filter)' },
  // Active custom date range (T26 / FR-04, G-T26-1). With both `from` and `to` set the
  // /search page switches from the flat "Confirmed" list to the grouped-by-day view
  // (app/search/page.tsx `DayGroupedResults` → one <h3> day subsection per in-range day
  // plus a trailing "Available any day" open-hours group). This route makes that grouped
  // DOM a DURABLE, committed axe target — the fixture engine (the default search backend,
  // KIDS_FUN_SEARCH_BACKEND unset) seeds listings on FIXED local days 2026-07-13/14/15
  // (lib/search/__fixtures__/listings.ts), so 07-13→07-15 always renders real day
  // subsections + the open-hours group regardless of DB state or the clock. Native
  // `<input type=date>` controls carry no aria-pressed/aria-current, so — unlike the
  // Round-18 link-chip regression — this view introduces no new ARIA attributes; the
  // audit here proves the day-grouped heading/section structure stays WCAG-AA clean.
  {
    route: '/search?from=2026-07-13&to=2026-07-15',
    label: 'search (active date range — grouped by day)',
  },
  { route: '/preview', label: 'preview shell' },
  { route: '/preview/templeton-family-swim', label: 'preview detail /preview/[id]' },
  { route: '/activity/templeton-family-swim', label: 'activity detail /activity/[id]' },
  // Privacy policy (Round 27, PIPEDA F-1). A real, public, DB-independent content
  // page (static approved prose — renders identically regardless of DB state), so it
  // belongs in the anon WCAG-AA sweep in both the light and dark projects.
  { route: '/privacy', label: 'privacy policy' },
  // Mobile filter bottom sheet (Blueprint §04). A modal dialog no URL can reach, on the
  // breakpoint most parents are on — so it needs both a phone viewport AND an interaction
  // to exist at all. Left out, the sweep would report "/search is clean" while never having
  // seen the one component on that page with focus management, aria-modal and a scroll lock.
  // The functional gate on it is hard (search-mobile-filter-sheet.public.spec.ts); this entry
  // adds the durable light+dark artifact the rest of the app already gets.
  {
    route: '/search?region=nvan&when=today&age=5-9',
    label: 'search (mobile filter sheet, open)',
    viewport: { width: 390, height: 844 },
    prepare: async (page) => {
      await page.locator('.kf-mfilters__btn--all').click();
      await page.locator('#kf-msheet-panel[role="dialog"]').waitFor({ state: 'visible' });
    },
  },
];

test.describe('a11y audit — anonymous routes', () => {
  for (const { route, label, viewport, prepare } of ANON_ROUTES) {
    test(`axe: ${label}`, async ({ page }, testInfo) => {
      if (viewport) await page.setViewportSize(viewport);
      await auditRoute(page, testInfo, route, label, prepare);
    });
  }
});

// --- Admin routes (project-wide sweep) -------------------------------------------
// H2 — CLOSES THE LONG-STANDING ADMIN AUDIT GAP.
//
// These routes are gated by app/admin/_lib/gate.ts: a real admin session first, with
// the INTERIM shared secret (ADMIN_DASHBOARD_TOKEN, lib/admin/access.ts) as the
// coexistence fallback. No admin_user row is seeded locally, so the session path never
// matches and the token path is what the harness uses — it needs no auth *plumbing*,
// only the same token in BOTH the app-server env and this test process.
//
// Rounds 17/18 could not audit these: scripts/e2e/setup-local-supabase.sh did not
// provision ADMIN_DASHBOARD_TOKEN, the gate failed closed, every /admin/* route 404'd,
// and the audit recorded a visible skip ("audit gap"). That script now emits a
// loopback-only ADMIN_DASHBOARD_TOKEN and run-e2e.sh sources it before starting both
// the app and Playwright — so the gap is closed rather than re-logged.
//
// The skip below is RETAINED as a safety net (not the expected path): if someone runs
// the a11y projects against a server without the token, every admin route would 404
// and axe would happily report "0 violations" on a Next.js not-found page — a false
// clean. Skipping loudly is the honest failure mode. CI asserts the token IS present.
test.describe('a11y audit — admin (token-gated surfaces)', () => {
  const adminToken = process.env.ADMIN_DASHBOARD_TOKEN;

  // Every token-gated admin surface, including the two charts-heavy KPI dashboards.
  // /admin/operating is audited in BOTH review modes (?view=day | ?view=month): the
  // grain switches the KPI grid, the section headings and the whole detail table, so
  // one mode does not stand in for the other. /admin/product-health has a single mode
  // (no view param) — its variation is the benchmark tile, always rendered.
  const ADMIN_ROUTES: { route: string; label: string }[] = [
    { route: '/admin/dashboard', label: 'admin dashboard' },
    { route: '/admin/operating?view=day', label: 'admin operating (daily review)' },
    { route: '/admin/operating?view=month', label: 'admin operating (monthly review)' },
    { route: '/admin/product-health', label: 'admin product-health' },
    { route: '/admin/data-health', label: 'admin data-health' },
  ];

  for (const { route, label } of ADMIN_ROUTES) {
    test(`axe: ${label}`, async ({ page }, testInfo) => {
      test.skip(
        !adminToken,
        `ADMIN_DASHBOARD_TOKEN is not set in this test process, so ${route} fails closed ` +
          '(404) and auditing it would report a false clean on a not-found page. Run ' +
          '`npm run e2e:setup` (which now provisions the local token) and drive the suite ' +
          'through scripts/e2e/run-e2e.sh, which sources .env.e2e.local. See docs/a11y-audit.md.',
      );
      // Append the token with the correct separator — two of these routes already
      // carry a query string, so a hardcoded "?" would silently drop the view mode.
      const sep = route.includes('?') ? '&' : '?';
      const audit = await auditRoute(page, testInfo, `${route}${sep}token=${adminToken}`, label);

      // Prove we audited the REAL admin page, not a 404. Without this, a gate/env
      // regression turns every admin finding into a silent "clean" — the precise
      // failure mode that let this gap sit un-noticed for several rounds.
      await expect(page.locator('h1'), `${route} rendered the real admin surface, not a 404`)
        .toContainText('KIDS FUN');
      expect(audit.url, 'audit ran against the requested admin route').toContain('/admin/');
    });
  }
});
