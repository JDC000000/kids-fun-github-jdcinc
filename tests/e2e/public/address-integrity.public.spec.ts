import { test, expect, type APIRequestContext } from '@playwright/test';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';

import { liveCategoryDestinations, destinationHref } from '../../../app/_lib/nav-destinations';
import { BARE_CHROME_PREFIXES } from '../../../lib/sms/surfaces';

// ─────────────────────────────────────────────────────────────────────────────
// EVERY EXISTING ADDRESS STILL WORKS (TSD v1.2 §9 M4 T4.3 / AC-08, AC-08b, AC-11, AC-19).
//
// The home page was rebuilt around the SMS offer, the site nav was re-cut and the stylesheet was
// reworked. Mod Spec Delta 14 is the promise this file enforces: "Every existing page and address
// — retain, no deletions." Nothing in M2/M3 was supposed to move a URL, and this is the sweep that
// says so rather than assuming it.
//
// ═══ STATUS CODES ARE READ FROM `request`, NOT FROM `page.goto` ═══
// A browser follows redirects and reports the FINAL response. That is exactly wrong for AC-08b,
// which is a statement about the hop itself: `/sms/signup` must answer 308 and point at
// `/sms/start`. Followed, a 308 and a plain 200 are indistinguishable. Every status below is
// therefore taken from Playwright's APIRequestContext with redirects disabled.
//
// ═══ 🔴 AC-08b IS A NON-DELETION GUARD ON A PHYSICAL ASSET ═══
// The `/sms/signup` redirect is the only thing keeping ALREADY-PRINTED QR CODES and externally
// shared links working. It looks exactly like dead weight to anyone tidying up a route list, and
// it cannot be un-printed. That is why it has an acceptance criterion of its own.
//
// ═══ 🔴 AND IT IS BAKED IN AT BUILD TIME (TSD §4.9) ═══
// `next.config.mjs`'s `redirects()` is compiled into `.next/routes-manifest.json` when the app is
// BUILT. The config file says so itself: "a restart does not pick it up. Verifying this in a
// running deployment means a REDEPLOY, not a bounce." So a green result here is only worth
// anything if the server under test was BUILT from the code under test. Locally that is checked
// below (`assertManifestIsFresh`). Against a deployed origin the filesystem is not visible, which
// is what scripts/release/verify-sms-front-door.sh exists for (T4.4) — it proves freshness from
// the live commit SHA instead, and REFUSES to report a pass without it.
// ─────────────────────────────────────────────────────────────────────────────

/** Requests made with redirects OFF — the only way to see a 308 rather than its destination. */
async function status(request: APIRequestContext, path: string) {
  const res = await request.get(path, { maxRedirects: 0, failOnStatusCode: false });
  return { status: res.status(), location: res.headers()['location'] ?? null };
}

/**
 * LOCAL-ONLY GUARD AGAINST THE §4.9 TRAP: the running build must be newer than the config whose
 * redirects it is being asked to prove.
 *
 * Only meaningful when the app under test is this working tree's own `next start`. Against any
 * other origin it no-ops and says so, rather than pretending to have checked.
 */
function manifestFreshness(): { checked: boolean; reason: string } {
  const baseURL = process.env.E2E_BASE_URL || 'http://127.0.0.1:3000';
  const isLoopback = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(baseURL);
  if (!isLoopback) {
    return {
      checked: false,
      reason: `E2E_BASE_URL=${baseURL} is not this working tree — build freshness cannot be ` +
        'proven from the filesystem. Use scripts/release/verify-sms-front-door.sh (T4.4), which ' +
        'proves it from the live commit SHA.',
    };
  }
  try {
    const config = statSync(resolve('next.config.mjs')).mtimeMs;
    const manifest = statSync(resolve('.next/routes-manifest.json')).mtimeMs;
    return manifest >= config
      ? { checked: true, reason: 'routes-manifest.json is newer than next.config.mjs' }
      : {
          checked: false,
          reason:
            '🔴 STALE BUILD. .next/routes-manifest.json is OLDER than next.config.mjs, so the ' +
            'server under test is serving redirects compiled from an earlier version of that ' +
            'file. Any result for /sms/signup below is a FALSE reading in either direction. ' +
            'Run `npm run build` — a restart does not fix this (TSD §4.9).',
        };
  } catch {
    return { checked: false, reason: 'no .next/routes-manifest.json — nothing built in this tree' };
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// AC-08 — the addresses that must simply keep working.
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The category search is derived from `app/_lib/nav-destinations.ts` rather than typed here, for
 * the reason that file exists: a hand-copied category URL is how the nav and the home page drifted
 * apart in the first place. Whatever the product currently offers as a category is what gets swept.
 */
const CATEGORY_SEARCH = destinationHref(liveCategoryDestinations()[0]);

const MUST_BE_200: readonly { path: string; why: string }[] = [
  { path: '/', why: 'the front door itself' },
  { path: '/search', why: 'AC-08 — search' },
  { path: CATEGORY_SEARCH, why: 'AC-08 — a category search, taken from the shared destination list' },
  // The fixture id, resolvable with no database, for the same reason the a11y sweep uses it:
  // the result must not depend on what happens to be in the catalogue today.
  { path: '/activity/templeton-family-swim', why: 'AC-08 — an activity detail page' },
  { path: '/coverage-status', why: 'AC-08 — coverage status (and the home page links straight to it)' },
  { path: '/privacy', why: 'AC-08 + AC-13 — privacy policy' },
  { path: '/terms', why: 'AC-08 + AC-13 — terms of service' },
];

test.describe('AC-08 — every existing address still answers', () => {
  for (const { path, why } of MUST_BE_200) {
    test(`200: ${path}`, async ({ request }) => {
      const { status: code, location } = await status(request, path);
      expect(
        code,
        `${path} answered ${code}${location ? ` → ${location}` : ''}. ${why}. Mod Spec Delta 14: ` +
          'every existing page and address is retained — no deletions, no moves',
      ).toBe(200);
    });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// /account — LISTED BY AC-08, BUT DELIBERATELY NOT ASSERTED 200.
// ═════════════════════════════════════════════════════════════════════════════

test.describe('/account — gated elsewhere, and NOT a regression from this work', () => {
  /*
   * TSD §9 T4.3, verbatim: "⚠ Do not assert 200. AC-08 lists it, but Jon's product-wide sign-in
   * ruling gates it — the page redirects anonymous visitors into a sign-in that no longer exists
   * (X-2, §0.2). Assert whatever the sign-in-removal workstream defines, and do not treat a
   * non-200 as a regression caused by this work."
   *
   * THE SIGN-IN-REMOVAL WORKSTREAM OWNS THE EXPECTED STATUS, and it already asserts it in
   * tests/e2e/public/account-redirect.public.spec.ts (a hard 404, via lib/auth/google-signin-gate
   * .ts). Restating "404" here would fork that expectation into two files that can disagree, and
   * the next change to that workstream would break a homepage spec for no reason.
   *
   * What THIS scope can legitimately assert is the pair of properties its own changes could
   * plausibly have broken, neither of which depends on which status the other workstream picks:
   * the route still resolves deterministically (no 5xx), and it still does not hand a visitor to
   * an auth provider.
   */
  test('resolves deliberately — no 5xx — whatever status the sign-in ruling settled on', async ({
    request,
  }) => {
    const { status: code, location } = await status(request, '/account');
    expect(
      code,
      `/account answered ${code}. This scope does not own its status (see account-redirect.public` +
        '.spec.ts) — but a 5xx would mean the route stopped resolving at all, which this work ' +
        'could have caused and nothing else would catch',
    ).toBeLessThan(500);
    expect(
      location ?? '',
      '/account must not hand a visitor to an auth provider — sign-in was removed product-wide',
    ).not.toMatch(/auth\/v1\/authorize|accounts\.google\.com|auth\/signin/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// AC-08 (/sms/start) + AC-12 — the flag, and the two surfaces agreeing about it.
// ═════════════════════════════════════════════════════════════════════════════

test.describe('/sms/start — 200 when signup is enabled, 404 when it is not', () => {
  test('the status matches SMS_SIGNUP_ENABLED, and 404 is correct behaviour not a failure', async ({
    request,
  }) => {
    const flag = process.env.SMS_SIGNUP_ENABLED;
    const { status: code } = await status(request, '/sms/start');

    // The route has exactly two legitimate answers. Anything else — a 500, a redirect, a 403 —
    // is a real defect regardless of the flag, and is worth separating from the flag question.
    expect(
      [200, 404],
      `/sms/start answered ${code}. app/sms/start/page.tsx either renders or calls notFound(); ` +
        'there is no third branch, so this is a fault rather than a flag state',
    ).toContain(code);

    expect(
      code,
      `/sms/start answered ${code} with SMS_SIGNUP_ENABLED=${JSON.stringify(flag)} in the TEST ` +
        'process. TSD §9 T4.3: 200 when the flag is exactly "true", 404 when it is not — 404 is ' +
        'CORRECT BEHAVIOUR, not a failure. If these disagree, the likeliest cause is env drift ' +
        'between this process and the app server rather than a product bug: run the suite through ' +
        'scripts/e2e/run-e2e.sh, which sources .env.e2e.local into both.',
    ).toBe(flag === 'true' ? 200 : 404);
  });

  test('🔴 AC-12 — the front door and the destination cannot disagree', async ({ request }) => {
    /*
     * THE ENV-INDEPENDENT HALF, and the one that actually protects the product. The test above
     * can be defeated by the test process and the app server reading different environments; this
     * one cannot, because both facts come from the same running server.
     *
     * The failure AC-12 exists to prevent is precisely a disagreement: a home page advertising a
     * destination that 404s. Since the flag defaults to FALSE, that is the product's DEFAULT
     * state unless something keeps the two surfaces in step — which is what lib/sms/availability
     * .ts does by delegating to the same `smsSignupEnabled()` the destination uses.
     */
    const { status: startStatus } = await status(request, '/sms/start');
    const home = await request.get('/', { failOnStatusCode: false });
    const html = await home.text();

    const homeOffersSignup = html.includes('kf-home__sms-cta');
    const destinationLives = startStatus === 200;

    expect(
      homeOffersSignup,
      destinationLives
        ? '/sms/start serves, but the home page renders NO signup action — the front door is ' +
          'hiding a working product'
        : '🔴 /sms/start 404s while the home page still renders a signup CTA. This is AC-12\'s ' +
          'exact failure: the product\'s entire front door leads nowhere',
    ).toBe(destinationLives);

    // And when it is off, the fail-safe branch must still SAY something rather than render a
    // mystery gap — a dead-looking button is explicitly ruled out, an explanation is not.
    if (!destinationLives) {
      expect(
        html,
        'with signup off the home page must degrade to a statement, not to silence (AC-12)',
      ).toContain('kf-home__sms--unavailable');
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// AC-08b — the redirect that keeps printed QR codes alive.
// ═════════════════════════════════════════════════════════════════════════════

test.describe('AC-08b — /sms/signup still permanently redirects to /sms/start', () => {
  test('🔴 308 → /sms/start, asserted WITHOUT following it, against a build that is not stale', async ({
    request,
  }, testInfo) => {
    const fresh = manifestFreshness();
    testInfo.annotations.push({ type: 'build-freshness', description: fresh.reason });
    // eslint-disable-next-line no-console
    console.log(`[AC-08b] build freshness: ${fresh.checked ? 'OK' : 'NOT PROVEN'} — ${fresh.reason}`);
    expect(
      fresh.reason,
      'refusing to report a result for a build-time redirect against a demonstrably stale build',
    ).not.toContain('STALE BUILD');

    const { status: code, location } = await status(request, '/sms/signup');

    expect(
      code,
      `/sms/signup answered ${code}, not 308. This redirect is the ONLY thing keeping ` +
        'already-printed QR codes and externally shared links working (AC-08b, Mod Spec Delta ' +
        '14) — it cannot be un-printed.\n' +
        '    Two causes, and they need different fixes:\n' +
        '      1. it was removed from next.config.mjs — restore it; it is load-bearing, not dead ' +
        'weight;\n' +
        '      2. 🔴 the server under test was RESTARTED rather than REDEPLOYED. redirects() is ' +
        'baked into .next/routes-manifest.json at BUILD time (TSD §4.9), so a bounce serves the ' +
        'old manifest and this reads the previous release. Rebuild and redeploy, then re-run.',
    ).toBe(308);

    // 308 and not 301/302: a permanent redirect that also preserves the METHOD. Nothing POSTs to
    // this path today, but a permanent redirect outlives that assumption.
    expect(
      new URL(location ?? '', 'http://localhost').pathname,
      `the hop must land on /sms/start, not ${location}`,
    ).toBe('/sms/start');
  });

  test('the query string survives the hop, so attribution is not silently dropped', async ({
    request,
  }) => {
    // Next carries query strings across a redirect with no `:path*` wildcard. Printed and shared
    // links carry utm parameters; losing them would look like a traffic collapse in the funnel
    // this milestone exists to measure, not like a routing change.
    const { status: code, location } = await status(request, '/sms/signup?utm_source=qr&utm_medium=print');
    expect(code).toBe(308);
    const url = new URL(location ?? '', 'http://localhost');
    expect(url.pathname).toBe('/sms/start');
    expect(url.searchParams.get('utm_source'), 'utm_source was dropped by the hop').toBe('qr');
    expect(url.searchParams.get('utm_medium'), 'utm_medium was dropped by the hop').toBe('print');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// AC-11 — CORRECTED METHOD (TSD §4.3, finding F-6).
// ═════════════════════════════════════════════════════════════════════════════

test.describe('AC-11 — the signup surfaces still render with no site chrome', () => {
  /*
   * 🔴 AC-11'S STATED METHOD IS IMPOSSIBLE, AND THE TSD SAYS SO (F-6, §4.3). The criterion reads
   * "Load BOTH; confirm chrome is still suppressed." `/sms/signup` cannot be loaded to inspect its
   * chrome — a request never reaches a page, it is turned around by a 308 before any render. A
   * spec written to the literal method would either follow the redirect and silently audit
   * /sms/start twice while claiming to have checked two pages, or fail forever for a reason that
   * is not a defect.
   *
   * CORRECTED METHOD, per the TSD:
   *   • /sms/start — really load it, and confirm no nav and no sign-in control.
   *   • /sms/signup — assert its ENTRY REMAINS in BARE_CHROME_PREFIXES, as defence-in-depth
   *     against the redirect ever being removed. If AC-08b's redirect were dropped, that page
   *     becomes reachable again and must still come up bare; the list is what guarantees it.
   *     tests/sms/surfaces.test.ts covers the predicate itself — this is the M4-level restatement
   *     of the dependency, so the two criteria fail together rather than one silently covering the
   *     other.
   */
  test('/sms/start renders bare — no nav, no footer, no sign-in control', async ({ page }) => {
    const res = await page.goto('/sms/start');
    test.skip(
      res?.status() === 404,
      'signup is disabled on this server (SMS_SIGNUP_ENABLED is not "true"), so there is no page ' +
        'to inspect. The status itself is asserted in the /sms/start block above — this is not a ' +
        'silent pass.',
    );

    await expect(page.locator('header.kf-nav'), 'the site nav is back on the signup page').toHaveCount(0);
    await expect(page.locator('nav[aria-label="Main"]')).toHaveCount(0);
    await expect(page.locator('footer')).toHaveCount(0);
    await expect(
      page.getByText(/sign in/i),
      'a sign-in control on a page whose whole premise is "no account" (Jon, PRD §8 item 4)',
    ).toHaveCount(0);
    // Positive control: prove we were looking at the real page, not at a 404 with no chrome.
    await expect(page.locator('h1')).toHaveText(/delivered by SMS once per week/i);
  });

  test('/sms/signup keeps its BARE_CHROME_PREFIXES entry — defence in depth behind AC-08b', () => {
    expect(
      BARE_CHROME_PREFIXES,
      'if the AC-08b redirect were ever removed, /sms/signup becomes reachable again and would ' +
        'render with full site chrome — undoing a deliberate conversion decision (Jon, 2026-09-01)',
    ).toContain('/sms/signup');
    expect(BARE_CHROME_PREFIXES, 'the primary signup landing page must stay bare too').toContain(
      '/sms/start',
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// AC-19 / DC-02 — the "three things" capability still exists.
// ═════════════════════════════════════════════════════════════════════════════

test.describe('AC-19 — "three things" was not deleted by the restructure (DC-02)', () => {
  test('the capability is present — asserted as presence, never as particular listings', async ({
    page,
  }) => {
    /*
     * 🔴 PRESENCE, NOT CONTENT, AND THAT IS A REQUIREMENT RATHER THAN A WEAK TEST (TSD assumption
     * A-5). Two other open KIDS FUN workstreams edit this component's SELECTION logic
     * (lib/recommend/three-things.ts). A spec that pinned which activities come back would fail on
     * their work and be read as a homepage regression — so it asserts only what DC-02 actually
     * protects: that the capability still exists in the product.
     *
     * It is also load-bearing for more than DC-02: ThreeThings calls getServerSearchEngine() in
     * process, which is WHY app/page.tsx is force-dynamic, which is why the AC-12 flag read and
     * the AC-09 impression are free and why a flag flip needs no rebuild (TSD §4.1, A-2). Removing
     * it would look like a content change and would quietly take those properties with it.
     */
    await page.goto('/', { waitUntil: 'load' });

    await expect(page.locator('.kf-home__proof'), 'the proof block is gone from the home page')
      .toHaveCount(1);
    await expect(
      page.locator('.kf-home__pick'),
      'the "three things" capability renders three slots — however they are currently selected',
    ).toHaveCount(3);

    // The FRAMING is load-bearing for the 90/10 ratio (TSD §6.3): headed "browse some activities"
    // these three cards read as search content and spend the whole 10% budget on their own;
    // headed as a sample of the weekly text they are SMS proof and sit inside the 90%. The same
    // component lands on either side of the ratio depending on this one heading.
    await expect(page.locator('#kf-home-proof')).toHaveText(/weekly text/i);
  });
});
