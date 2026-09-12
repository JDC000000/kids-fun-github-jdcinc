import { test, expect, type Page, type Request } from '@playwright/test';

// ─────────────────────────────────────────────────────────────────────────────
// The SMS signup CTA actually emits, and never gets in the way (TSD §9 M1 T1.6 / AC-09).
//
// WHY THIS SPEC IS THE TASK RATHER THAN AN EXTRA ON IT
// `trackEvent()` (lib/analytics/client.ts) shipped with the analytics foundation and has been
// called from NOWHERE in this application ever since (TSD §4.4, risk R-08). This CTA is its
// first consumer anywhere in the product, which means its `navigator.sendBeacon`-then-
// `keepalive: fetch` path has never executed — not in production, not in staging, not once.
//
// A unit test cannot close that gap, and it is worth being precise about why. The unit tests in
// tests/home/sms-cta-click.test.tsx MOCK trackEvent, so they prove this component calls it.
// They say nothing about whether calling it does anything, because everything that could
// actually be broken is a thing the mock replaces:
//   • sendBeacon is a browser API with its own failure modes (it returns false when the queue
//     is full and does not throw), and vitest runs in the `node` environment with no jsdom;
//   • the request must survive a NAVIGATION starting in the same tick — the one property
//     sendBeacon exists for, and the one a stubbed function cannot demonstrate;
//   • the POST must be ACCEPTED by the real route, which validates event types against
//     CLIENT_EVENT_TYPES and answers 400 for a server-only one. A mock would happily "send"
//     something the live route rejects, and the funnel would read zero for weeks while every
//     test in the repo stayed green.
//
// ═══ WHAT DRIVING A REAL BROWSER ACTUALLY TAUGHT US, RECORDED BECAUSE IT SHAPED THIS FILE ═══
// A beacon is dispatched by Chromium as `resourceType: 'ping'`, and its body is NOT readable
// from Playwright — both `postData()` and `postDataBuffer()` come back null, because the body
// is a Blob handed to the browser rather than bytes authored by the page. So "assert the beacon
// contained the right eventType" is not a test that can be written, and the first draft of this
// file failed on exactly that rather than on a product defect.
//
// The payload is therefore asserted on the KEEPALIVE-FETCH branch, which is readable — and that
// is a better test than the one originally intended, because it means both of trackEvent's
// never-before-executed transports are exercised here rather than only the first. What the
// beacon branch proves is the part only it can: that the request is really dispatched, really
// survives the navigation, and is really accepted by the live route.
//
// ⚠ REQUIRES SMS_SIGNUP_ENABLED=true on the app under test. With the flag off the home page
// correctly renders NO signup action (AC-12) and there is nothing to click. That is not a silent
// skip below — it is asserted with a message naming the variable, because a spec that quietly
// passed when the CTA was absent would be worse than no spec at all.
// ─────────────────────────────────────────────────────────────────────────────

const ANALYTICS_ENDPOINT = '/api/analytics/event';
const EVENT_TYPE = 'sms_signup_cta_clicked';
/** Server-only by design (TSD §9 M1 T1.1) — the live route must refuse it from a browser. */
const SERVER_ONLY_EVENT_TYPE = 'sms_offer_viewed';

/** POSTs to the analytics route observed on this page, in order. */
function collectAnalyticsPosts(page: Page): Request[] {
  const seen: Request[] = [];
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().includes(ANALYTICS_ENDPOINT)) seen.push(req);
  });
  return seen;
}

const cta = (page: Page) => page.locator(`a.kf-home__sms-cta[href="/sms/start"]`);

async function gotoHomeWithCta(page: Page): Promise<void> {
  await page.goto('/');
  await expect(
    cta(page),
    'no signup CTA on the home page — run this suite with SMS_SIGNUP_ENABLED=true; with the ' +
      'flag off AC-12 correctly renders no action and there is nothing here to prove',
  ).toHaveCount(1);
}

test.describe('the SMS CTA emits through the real transport', () => {
  test('a real click sends exactly ONE event the live route ACCEPTS, and navigates', async ({
    page,
  }) => {
    await gotoHomeWithCta(page);
    const posts = collectAnalyticsPosts(page);

    await cta(page).click();
    await page.waitForURL('**/sms/start');

    // ── the navigation happened ──
    expect(new URL(page.url()).pathname).toBe('/sms/start');

    // ── exactly one request, not at-least-one ──
    // A double emit would inflate the NUMERATOR of the conversion rate this milestone exists
    // to measure, and would do it invisibly — the dashboard would simply show a better number.
    expect(posts, 'one click must produce exactly one analytics POST').toHaveLength(1);

    // ── it really went out as a beacon, which is the thing that survives the navigation ──
    // If trackEvent had silently fallen through to the fetch branch this would read 'fetch' or
    // 'xhr', and the whole reason sendBeacon is preferred (a request that outlives the page)
    // would be untrue without anything failing.
    expect(posts[0].resourceType(), 'the beacon branch of trackEvent should have run').toBe('ping');

    // ── and the REAL route accepted it ──
    // This is the half no mock can reach. POST /api/analytics/event validates against
    // CLIENT_EVENT_TYPES and answers 400 for a server-only type; had T1.1 put this event on the
    // wrong side of that line, every other assertion here would still pass and the funnel would
    // read zero indefinitely. 202 is only reachable AFTER validation succeeds (see the route).
    const response = await posts[0].response();
    expect(response, 'the beacon should reach the server, not be dropped by the browser').toBeTruthy();
    expect(response!.status(), 'the public analytics route must ACCEPT this event type').toBe(202);
  });

  test('🔴 the KEEPALIVE-FETCH fallback sends the right event type', async ({ page }) => {
    // The second of trackEvent's two never-executed transports, and the only one whose body is
    // readable (a beacon's Blob is not exposed to Playwright — see the header). Removing
    // sendBeacon before any page script runs reproduces the real condition this branch exists
    // for: a browser without the API.
    await page.addInitScript(() => {
      // @ts-expect-error — deleting a DOM API to force trackEvent's documented fallback.
      delete Navigator.prototype.sendBeacon;
    });
    await gotoHomeWithCta(page);
    const posts = collectAnalyticsPosts(page);

    await cta(page).click();
    await page.waitForURL('**/sms/start');

    expect(posts).toHaveLength(1);
    expect(posts[0].resourceType(), 'without sendBeacon this must go out as a fetch').not.toBe('ping');

    const raw = posts[0].postData();
    expect(raw, 'the fetch branch authors its own body, so it is readable').toBeTruthy();
    const body = JSON.parse(raw as string) as Record<string, unknown>;
    expect(body.eventType).toBe(EVENT_TYPE);

    // The event's whole content is "somebody tapped it". Anything else would be data sent from
    // a client that can be made to send anything, into the numerator of a conversion rate.
    expect(Object.keys(body)).toEqual(['eventType']);

    const response = await posts[0].response();
    expect(response!.status()).toBe(202);
  });

  test('🔴 the live route REFUSES the server-only half of the pair', async ({ request }) => {
    // The client/server split from T1.1 asserted against the deployed validator rather than
    // against the constant it is derived from. `sms_offer_viewed` is the conversion
    // DENOMINATOR and is emitted during render; if a browser could post it, anything could
    // inflate it and silently depress the measured conversion rate.
    const accepted = await request.post(ANALYTICS_ENDPOINT, { data: { eventType: EVENT_TYPE } });
    expect(accepted.status(), 'the click half must be accepted').toBe(202);

    const refused = await request.post(ANALYTICS_ENDPOINT, {
      data: { eventType: SERVER_ONLY_EVENT_TYPE },
    });
    expect(refused.status(), 'the impression half must NOT be browser-postable').toBe(400);
  });
});

test.describe('the emit never gets in the way of the navigation', () => {
  test('🔴 navigates anyway when the analytics endpoint is dead', async ({ page }) => {
    await gotoHomeWithCta(page);
    // The failure that matters is not a lost row — it is a parent who tapped the product's
    // primary action and went nowhere. Aborting reproduces an analytics outage exactly.
    await page.route(`**${ANALYTICS_ENDPOINT}`, (route) => route.abort('failed'));

    await cta(page).click();
    await page.waitForURL('**/sms/start');
    expect(new URL(page.url()).pathname).toBe('/sms/start');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  });

  test('🔴 navigates without waiting on a HANGING analytics request', async ({ page }) => {
    await gotoHomeWithCta(page);
    // A hung request is the nastier outage than a refused one: nothing errors, so a handler
    // that awaited the emit would simply never navigate — a dead button rather than a broken
    // service, and far harder to diagnose from the outside.
    await page.route(`**${ANALYTICS_ENDPOINT}`, async () => {
      await new Promise(() => {
        /* never settles, for the lifetime of the test */
      });
    });

    const startedAt = Date.now();
    await cta(page).click();
    await page.waitForURL('**/sms/start');
    const elapsed = Date.now() - startedAt;

    expect(new URL(page.url()).pathname).toBe('/sms/start');
    // Generous on purpose: this asserts "did not wait on the network", not a perf budget. An
    // implementation that awaited the hanging emit would never arrive at all.
    expect(elapsed, 'the navigation waited on the analytics request').toBeLessThan(10_000);
  });

  test('🔴 does not emit on a mere page view — only the click counts', async ({ page }) => {
    // The click event is the NUMERATOR. If loading the page emitted it, the conversion rate
    // would read ~100% from the first day and nobody would learn anything from it. (The
    // impression half is emitted SERVER-side and so is correctly invisible to this spec.)
    await gotoHomeWithCta(page);
    const posts = collectAnalyticsPosts(page);
    await page.reload();
    await expect(cta(page)).toHaveCount(1);
    await page.waitForTimeout(500);
    expect(posts).toHaveLength(0);
  });
});
