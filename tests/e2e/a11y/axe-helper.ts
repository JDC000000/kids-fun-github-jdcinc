import { expect, type Page, type TestInfo } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// tests/e2e/a11y/axe-helper.ts — shared axe-core runner for the project-wide WCAG AA
// accessibility AUDIT (Round 17 / Task W → canonical G-T38-4).
//
// AUDIT-ONLY. This helper records EVERY axe-core violation (full detail, nothing
// filtered away) to a durable artifact + the Playwright report + stdout, and it does
// NOT fail a test on violations — this round's job is to FIND and DOCUMENT, not gate
// or fix. The single hard assertion is that axe actually executed on the page, so a
// silently no-op'ing integration can never masquerade as a clean pass.

// axe-core result types, derived from the AxeBuilder API so we don't take a direct
// dependency on the (transitive) axe-core types package.
type AxeResults = Awaited<ReturnType<AxeBuilder['analyze']>>;
type AxeViolation = AxeResults['violations'][number];

// The WCAG 2.0 + 2.1, Level A + AA tag set — i.e. the "WCAG AA" conformance target
// (canonical G-T38-4: WCAG AA accessibility audit). 'best-practice' is intentionally
// excluded so every reported finding maps to a real WCAG success criterion.
export const WCAG_AA_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] as const;

const ARTIFACT_DIR = resolve('tests/e2e/.artifacts/a11y');

export interface RouteAuditResult {
  route: string;
  label: string;
  project: string;
  colorScheme: string;
  url: string;
  violationCount: number;
  /** Sum of affected DOM nodes per axe impact rating (critical/serious/moderate/minor). */
  impactNodeCounts: Record<string, number>;
  violations: AxeViolation[];
}

function slug(s: string): string {
  return s.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'root';
}

/** The WCAG success-criterion tags axe attaches to a rule (e.g. `wcag143` -> 1.4.3). */
export function wcagCriteria(tags: readonly string[]): string[] {
  return tags
    .filter((t) => /^wcag\d{3,4}$/.test(t))
    .map((t) => {
      const digits = t.slice(4);
      // wcag143 -> 1.4.3 ; wcag412 -> 4.1.2 ; wcag1411 -> 1.4.11
      return `${digits[0]}.${digits[1]}.${digits.slice(2)}`;
    });
}

/**
 * Navigate to `route`, run axe-core against the fully-rendered page for the WCAG AA
 * tag set, and persist the FULL violation detail (nothing filtered) to:
 *   - tests/e2e/.artifacts/a11y/<label>--<project>.json  (durable, machine-readable)
 *   - the Playwright HTML report (test attachment)
 *   - the test stdout (one line per violated rule)
 *
 * Never asserts "zero violations" — it asserts only that axe-core genuinely ran.
 */
export async function auditRoute(
  page: Page,
  testInfo: TestInfo,
  route: string,
  label: string,
  /**
   * Optional step run after load and before axe, for a surface that only exists once a
   * parent has interacted — e.g. the mobile filter bottom sheet, which is a modal dialog
   * that no URL can reach. Without this the sweep could only ever audit the closed state,
   * and a dialog's accessibility lives entirely in its open one.
   */
  prepare?: (page: Page) => Promise<void>,
): Promise<RouteAuditResult> {
  await page.goto(route, { waitUntil: 'load' });
  // Give any late client island (e.g. the home "on now" strip) a chance to settle;
  // never let idle-wait flakiness fail an audit — the SSR DOM is already present.
  await page.waitForLoadState('networkidle').catch(() => {});
  if (prepare) await prepare(page);

  const project = testInfo.project.name;
  const colorScheme = /dark/i.test(project) ? 'dark' : 'light';

  const results = await new AxeBuilder({ page }).withTags([...WCAG_AA_TAGS]).analyze();

  // HARD GUARD against a silent no-op: prove axe-core actually ran on this page.
  // (If the integration were mis-wired, testEngine would be undefined / violations
  // would not be an array — that must fail loudly, unlike real content violations.)
  expect(results.testEngine?.name, 'axe-core actually executed on the page').toBe('axe-core');
  expect(Array.isArray(results.violations), 'axe produced a violations array').toBe(true);

  const impactNodeCounts: Record<string, number> = {};
  for (const v of results.violations) {
    const impact = v.impact ?? 'unknown';
    impactNodeCounts[impact] = (impactNodeCounts[impact] ?? 0) + (v.nodes.length || 1);
  }

  const audit: RouteAuditResult = {
    route,
    label,
    project,
    colorScheme,
    url: page.url(),
    violationCount: results.violations.length,
    impactNodeCounts,
    violations: results.violations,
  };

  mkdirSync(ARTIFACT_DIR, { recursive: true });
  const file = resolve(ARTIFACT_DIR, `${slug(label)}--${project}.json`);
  writeFileSync(
    file,
    JSON.stringify(
      { ...audit, testEngine: results.testEngine, timestamp: results.timestamp },
      null,
      2,
    ),
  );
  await testInfo.attach(`a11y-${slug(label)}-${project}`, {
    body: JSON.stringify(audit, null, 2),
    contentType: 'application/json',
  });

  // eslint-disable-next-line no-console
  console.log(
    `[a11y] ${label} [${project}/${colorScheme}] -> ${results.violations.length} violated rule(s)` +
      (results.violations.length
        ? ':\n' +
          results.violations
            .map(
              (v: AxeViolation) =>
                `    - ${v.id} (${v.impact ?? 'n/a'}) x${v.nodes.length} node(s): ${v.help}` +
                ` [WCAG ${wcagCriteria(v.tags).join(', ') || 'n/a'}]`,
            )
            .join('\n')
        : ' — clean'),
  );

  return audit;
}
