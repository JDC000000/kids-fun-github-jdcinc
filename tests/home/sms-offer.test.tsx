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

const { default: Home } = await import('../../app/page');
const { SMS_SIGNUP_PATH } = await import('../../lib/sms/config');

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
