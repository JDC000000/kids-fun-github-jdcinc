// tests/home/sms-offer.test.tsx — the home page's SMS signup offer: fail-safe render (AC-12)
// and the two funnel events (AC-09). TSD §9 M1, T1.4/T1.5/T1.6, consolidated by T1.8.
//
// ═══ THE FAILURE THIS FILE EXISTS TO PREVENT ═══
// SMS_SIGNUP_ENABLED defaults to FALSE and /sms/start calls notFound() unless it is exactly
// 'true'. So the DEFAULT state of this product is a signup page that 404s. A home page that
// advertises it unconditionally is therefore not "mostly right, occasionally wrong" — it is
// wrong by default, and right only while an environment variable happens to be set. That is
// the wrong way round for the product's front door, and it is why the branch below is the
// first thing asserted rather than an edge case at the end.
// ═══ T1.8 — THE MUTATION MATRIX, AND WHY IT IS WRITTEN DOWN ═══
// The TSD's standing F-4 lesson is that a guard does not count as done until one deliberate
// regression run proves a test actually catches it. That pass was run over every guard this
// milestone adds — 22 mutations, each applied to the real source, the suite run, the source
// restored. All 22 turned the suite red. The harness itself is deliberately NOT in the repo
// (it is a throwaway, and a checked-in mutation runner is the kind of thing that rots into
// a job nobody runs); what is kept is the inventory, because the useful artefact is knowing
// WHICH guard each assertion is standing under.
//
//  #   guard                                                        killed by
//  G1  `sms_signup_cta_clicked` ∈ CLIENT_EVENT_TYPES                analytics/catalog.test.ts
//  G2  `sms_offer_viewed` ∉ CLIENT_EVENT_TYPES                      analytics/catalog.test.ts
//  G3  catalog entries name an emit source                          analytics/catalog.test.ts
//  G4  catalog wiring is 'wired' once the emits exist               analytics/catalog.test.ts
//  G5  SMS_SIGNUP_PATH is the reachable path, not the 308           sms/signup_availability
//  G6  signupUrl() composes from that constant                      sms/signup_availability
//  G7  the flag comparison is `=== 'true'`, not truthy              sms/signup_availability
//  G8  the unavailable branch carries no href                       sms/signup_availability
//  G9  availability is not hardcoded available                      sms/signup_availability
//  G10 the page BRANCHES rather than always offering                THIS FILE
//  G11 the degraded branch still renders a statement                THIS FILE
//  G12 `sms_offer_viewed` is emitted only when the offer shows      THIS FILE
//  G13 it is emitted at all                                         THIS FILE
//  G14 the recorder's best-effort try/catch                         THIS FILE
//  G15 the unbackfillable `surface` label                           THIS FILE
//  G16 the CTA really wires onClick  ← found BY this pass, see below  home/sms-cta-click
//  G17 exactly one emit per click                                   home/sms-cta-click
//  G18 the island's try/catch (a broken emit ≠ a dead CTA)          home/sms-cta-click
//  G19 the handler is synchronous and unawaitable                   home/sms-cta-click
//  G20 the event type emitted is the right one                      home/sms-cta-click
//  G21 the CTA is a link, not a button owning the navigation        home/sms-cta-click
//  G22 the 'use client' directive                                   home/sms-cta-click
//
// 🔴 THE PASS EARNED ITS KEEP ON G16. Deleting `onClick={emitSmsSignupCtaClick}` from the
// component left the ENTIRE unit lane green: the handler tests call the function directly, and
// the markup tests read SSR HTML, where a React event handler is not serialised. Nothing
// connected the two, so the CTA could have shipped emitting nothing with every assertion
// passing. tests/home/sms-cta-click.test.tsx now asserts the wiring on the React element.
// The e2e spec was mutation-tested too, against a real build: removing that same onClick turns
// both of its transport tests red, so it is not a toothless smoke test either.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';

// The page's client islands read app-router hooks that have no context under
// renderToStaticMarkup. Neither is what this file is about.
vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {} }),
}));

// <ThreeThings /> is an async server component that awaits the real search engine.
// renderToStaticMarkup is the legacy synchronous renderer and throws on a promise child,
// which would take this whole FILE down rather than one test. Same stub, same reason, as
// tests/nav-destinations.test.tsx.
vi.mock('../../app/_components/ThreeThings', () => ({
  ThreeThings: () => <div data-testid="three-things-stub" />,
}));

// The analytics emitter is mocked at the emit seam — one level ABOVE the pg-backed
// writer — so this file observes exactly what the page asks for without opening a
// database connection, and stays in the parallel `unit` lane.
const emitEvent = vi.hoisted(() =>
  // Typed with rest args rather than emitEvent's real signature so the assertions below can
  // read positional arguments without importing the module this file is mocking away.
  vi.fn(async (..._args: unknown[]) => ({ ok: true })),
);
vi.mock('../../lib/analytics/emit', () => ({ emitEvent }));

const { default: Home } = await import('../../app/page');
const { SMS_SIGNUP_PATH } = await import('../../lib/sms/config');

/** The `sms_offer_viewed` calls made during the last render. */
function offerViewedCalls(): unknown[][] {
  return emitEvent.mock.calls.filter((c) => c[0] === 'sms_offer_viewed');
}

/** Render the home page the way Next does — it is an async server component. */
async function renderHome(): Promise<string> {
  return renderToStaticMarkup((await Home()) as ReactElement);
}

/** Every href the rendered page actually offers. */
function hrefs(html: string): string[] {
  return [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
}

/** Hrefs that would land a parent on the signup page, however they are written. */
function signupHrefs(html: string): string[] {
  return hrefs(html).filter((h) => h.includes('/sms/start') || h.includes('/sms/signup'));
}

/**
 * The offer block itself, extracted by its own markers rather than by a character count —
 * a fixed slice would silently start passing the moment the copy got longer than the window.
 */
function offerBlock(html: string): string {
  const start = html.indexOf('<section class="kf-home__sms');
  expect(start, 'the offer block should always render, in both flag states').toBeGreaterThan(-1);
  const end = html.indexOf('</section>', start);
  expect(end).toBeGreaterThan(start);
  return html.slice(start, end + '</section>'.length);
}

function signupOn(): void {
  vi.stubEnv('SMS_SIGNUP_ENABLED', 'true');
}
function signupOff(value = 'false'): void {
  vi.stubEnv('SMS_SIGNUP_ENABLED', value);
}

beforeEach(() => {
  vi.stubEnv('SMS_SENDING_ENABLED', 'false');
  emitEvent.mockReset();
  emitEvent.mockResolvedValue({ ok: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('AC-12 — the home page never advertises a destination that 404s', () => {
  it('🔴 offers NO action leading to the signup page when the flag is off', async () => {
    signupOff();
    const html = await renderHome();
    expect(signupHrefs(html)).toEqual([]);
  });

  it('🔴 offers no signup action for ANY non-`true` flag value, not just "false"', async () => {
    // Parity with smsSignupEnabled()'s exact comparison. 'TRUE' and '1' are the two a
    // human sets believing they have turned something on; both must degrade, because
    // /sms/start reads the same comparison and would 404 them.
    for (const value of ['', 'TRUE', 'True', '1', 'yes', 'on']) {
      vi.unstubAllEnvs();
      vi.stubEnv('SMS_SENDING_ENABLED', 'false');
      signupOff(value);
      expect(signupHrefs(await renderHome()), `flag=${JSON.stringify(value)}`).toEqual([]);
    }
  });

  it('still renders a complete page when degraded — it does not blank the fold', async () => {
    // Degrading must cost the OFFER, not the page. If the fail-safe path also took out the
    // hero or the search form, "fail safe" would just be a different outage.
    signupOff();
    const html = await renderHome();
    expect(html).toContain('KIDS FUN');
    expect(html).toContain('action="/search"');
    expect(html.length).toBeGreaterThan(1000);
  });

  it('🔴 presents exactly ONE signup action when the flag is on', async () => {
    signupOn();
    const html = await renderHome();
    // Exactly one: two competing "sign up" affordances on the front door is the thing
    // "one primary action" rules out, and a duplicate would also double-count the funnel.
    expect(signupHrefs(html)).toEqual([SMS_SIGNUP_PATH]);
  });

  it('🔴 links to the PATH, never an absolute url', async () => {
    // An absolute href forces a full document load instead of a client-side transition, and
    // on a preview deployment points at siteUrl() rather than the origin the parent is on.
    signupOn();
    const found = signupHrefs(await renderHome());
    // Asserted before the loop, so this cannot pass by iterating over nothing.
    expect(found).toHaveLength(1);
    for (const href of found) {
      expect(href).toBe('/sms/start');
      expect(href).not.toMatch(/^https?:\/\//);
    }
  });

  it('🔴 says something about SMS in both states — degraded is a statement, not a hole', async () => {
    // The degraded branch renders a plain, non-actionable statement rather than nothing:
    // an offer that silently vanishes reads as a layout bug to the next person to look at
    // the page, and gives a parent no idea the thing exists.
    signupOn();
    const on = await renderHome();
    signupOff();
    const off = await renderHome();
    expect(offerBlock(on)).toMatch(/text a week/i);
    expect(offerBlock(off)).toMatch(/text a week/i);
    // …and the degraded statement carries no affordance at all: not a link, not a button,
    // not a form. "Render no signup action" has to mean no action, not a disabled-looking one.
    expect(offerBlock(off)).not.toMatch(/<a |<button |<form |role="button"/);
    // The enabled branch, by contrast, really does carry one.
    expect(offerBlock(on)).toMatch(/<a /);
  });
});

describe('AC-09 (impression half) — sms_offer_viewed counts offers, not renders', () => {
  it('emits exactly one event when the offer is presented', async () => {
    signupOn();
    await renderHome();
    expect(offerViewedCalls()).toHaveLength(1);
  });

  it('🔴 emits NOTHING on the degraded render — the denominator stays honest', async () => {
    // THIS IS THE ASSERTION THE WHOLE EVENT IS FOR. `sms_offer_viewed` is the denominator
    // of the signup conversion rate. A render with no offer on it is not an offer seen, so
    // counting it would add rows that never had any chance of converting and would depress
    // the measured rate from day one — and because the flag defaults to FALSE, the degraded
    // render is the state the product spends most of its life in. The corruption would look
    // exactly like a product result, and would not be fixable afterwards.
    signupOff();
    await renderHome();
    expect(offerViewedCalls()).toHaveLength(0);
    expect(emitEvent).not.toHaveBeenCalled();
  });

  it('emits nothing for any non-`true` flag value, matching the render branch exactly', async () => {
    for (const value of ['', 'TRUE', '1', 'yes']) {
      vi.unstubAllEnvs();
      vi.stubEnv('SMS_SENDING_ENABLED', 'false');
      emitEvent.mockClear();
      signupOff(value);
      await renderHome();
      expect(offerViewedCalls(), `flag=${JSON.stringify(value)}`).toHaveLength(0);
    }
  });

  it('attributes the row to an anonymous session, and to the surface it was shown on', async () => {
    signupOn();
    await renderHome();
    const [type, searchContext, resultSummary, actor] = offerViewedCalls()[0];
    expect(type).toBe('sms_offer_viewed');
    // No search context — this is an impression, not a query.
    expect(searchContext).toBeNull();
    // `surface` is the thing that cannot be backfilled: when M2/M3 add a second place the
    // offer appears, rows written before that point are unattributable without it.
    expect(resultSummary).toMatchObject({ surface: 'home' });
    // An actor, so the event can join the anon session — and a NON-EMPTY one, since a null
    // actor would silently make every impression unattributable to a visit.
    expect(typeof actor).toBe('string');
    expect((actor as string).length).toBeGreaterThan(0);
  });

  it('🔴 carries no PII — only a surface label and the anon id', async () => {
    signupOn();
    await renderHome();
    const [, searchContext, resultSummary] = offerViewedCalls()[0];
    expect(Object.keys(resultSummary as object)).toEqual(['surface']);
    expect(searchContext).toBeNull();
  });
});

describe('best-effort — analytics cannot break the front door', () => {
  it('🔴 renders byte-identical HTML when the write REJECTS', async () => {
    signupOn();
    const healthy = await renderHome();
    emitEvent.mockResolvedValue({ ok: false });
    expect(await renderHome()).toBe(healthy);
  });

  it('🔴 renders byte-identical HTML when the emitter THROWS', async () => {
    // writeAnalyticsEvent promises never to throw, and this asserts the home page does not
    // DEPEND on that promise. The contract is one module away and one refactor from being
    // broken by someone who has never seen this file; the blast radius of believing it here
    // is a 500 on the product's front door, which is not a trade worth making for a row in
    // an analytics table.
    signupOn();
    emitEvent.mockResolvedValue({ ok: true });
    const healthy = await renderHome();
    emitEvent.mockRejectedValue(new Error('pool exhausted'));
    await expect(renderHome()).resolves.toBe(healthy);
  });

  it('🔴 still renders when the emitter throws SYNCHRONOUSLY', async () => {
    // A synchronous throw escapes a bare `await` differently from a rejected promise and is
    // what an import-time/config failure inside the analytics stack actually looks like.
    signupOn();
    emitEvent.mockResolvedValue({ ok: true });
    const healthy = await renderHome();
    emitEvent.mockImplementation(() => {
      throw new Error('analytics module is broken');
    });
    await expect(renderHome()).resolves.toBe(healthy);
  });
});
