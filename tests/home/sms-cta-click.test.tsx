// tests/home/sms-cta-click.test.tsx — the browser half of the funnel (TSD §9 M1 T1.6, AC-09).
//
// ═══ WHY THIS TASK IS NOT "ADD AN onClick" ═══
// `trackEvent()` has existed in lib/analytics/client.ts since the analytics foundation shipped
// and has been called from NOWHERE in the entire application (TSD §4.4, risk R-08). Its
// sendBeacon-then-keepalive-fetch path has therefore never run in a real browser, in production
// or anywhere else. This CTA is its first consumer, which means the task owns PROVING the path
// works rather than merely calling it.
//
// That proof cannot live here. This project runs vitest in the `node` environment with no jsdom
// (see tests/ui/report-wrong-info-confirm.test.tsx's note), so there is no real click, no real
// navigator.sendBeacon and no real navigation to observe. What this file covers is the part that
// IS testable without a browser: the pure emit handler, and the rendered affordance. The
// end-to-end proof — a real click, a real beacon, a real POST, and a navigation that completes
// anyway when the emit is broken — is tests/e2e/public/sms-cta-analytics.public.spec.ts, and it
// is not optional decoration on this task.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const { trackEvent } = vi.hoisted(() => ({ trackEvent: vi.fn() }));
vi.mock('@/lib/analytics/client', () => ({ trackEvent }));

const { SmsSignupCta, emitSmsSignupCtaClick } = await import('../../app/_components/SmsSignupCta');

afterEach(() => {
  trackEvent.mockReset();
});

describe('emitSmsSignupCtaClick', () => {
  it('🔴 emits exactly ONE event, of the right type', async () => {
    emitSmsSignupCtaClick();
    expect(trackEvent).toHaveBeenCalledTimes(1);
    expect(trackEvent.mock.calls[0][0]).toBe('sms_signup_cta_clicked');
  });

  it('🔴 sends no payload — there is nothing about a tap that is not PII-adjacent', async () => {
    // The event's whole content is "somebody tapped it", and the route derives the anon
    // session from a cookie server-side. Anything added here would be sent from a client that
    // can be made to send anything, into the NUMERATOR of a conversion rate.
    emitSmsSignupCtaClick();
    const payload = trackEvent.mock.calls[0][1];
    expect(payload === undefined || Object.keys(payload as object).length === 0).toBe(true);
  });

  it('🔴 does not throw when the transport is broken — navigation must not be blocked', () => {
    // trackEvent promises to swallow everything, and this asserts the CTA does not DEPEND on
    // that promise. An exception escaping an onClick handler is not a lost analytics row, it
    // is a parent who tapped the product's primary action and went nowhere.
    trackEvent.mockImplementation(() => {
      throw new Error('sendBeacon unavailable');
    });
    expect(() => emitSmsSignupCtaClick()).not.toThrow();
  });

  it('🔴 is SYNCHRONOUS — it cannot be awaited, so it cannot delay a navigation', () => {
    // If this returned a promise, the next person to touch the handler could reasonably
    // `await` it, and the click would then wait on a network call before navigating. Making
    // the return type undefined removes that option rather than documenting against it.
    const returned = emitSmsSignupCtaClick();
    expect(returned).toBeUndefined();
  });
});

describe('<SmsSignupCta /> — the affordance itself', () => {
  it('renders a real link to the path it was given', () => {
    const html = renderToStaticMarkup(<SmsSignupCta href="/sms/start">Get the weekly text</SmsSignupCta>);
    expect(html).toMatch(/<a[^>]+href="\/sms\/start"/);
    expect(html).toContain('Get the weekly text');
  });

  it('🔴 is a LINK, not a button or a form — the emit must not own the navigation', () => {
    // A <button onClick={track(); router.push()}> would make the analytics call sit on the
    // path to the destination: a slow or broken emit becomes a slow or broken navigation, and
    // the whole point of AC-09's "navigation is not delayed or blocked" is that it must not.
    // An <a href> navigates because it is an anchor; the emit rides alongside it.
    const html = renderToStaticMarkup(<SmsSignupCta href="/sms/start">Go</SmsSignupCta>);
    expect(html).not.toMatch(/<button|<form|role="button"/);
  });

  it('🔴 renders nothing that would be lost to a failed emit', () => {
    // Rendering must not depend on trackEvent having been importable or callable.
    trackEvent.mockImplementation(() => {
      throw new Error('boom');
    });
    const html = renderToStaticMarkup(<SmsSignupCta href="/sms/start">Go</SmsSignupCta>);
    expect(html).toMatch(/href="\/sms\/start"/);
  });

  it('🔴 actually WIRES the handler to onClick — found by the T1.8 mutation pass', () => {
    // THIS TEST EXISTS BECAUSE THE MUTATION PASS CAUGHT ITS ABSENCE. Deleting
    // `onClick={emitSmsSignupCtaClick}` from the component left the entire unit lane green:
    // the handler tests call the function directly, and the markup tests read SSR HTML, where
    // a React event handler is not serialised at all. So nothing here connected the two, and
    // the CTA could have shipped emitting nothing while every assertion above still passed.
    //
    // Asserted on the ELEMENT rather than the HTML, because the element is where the wiring
    // exists. Identity, not merely "is a function" — a different handler would emit a
    // different event or nothing, and would satisfy a typeof check.
    const element = SmsSignupCta({ href: '/sms/start', children: 'Go' }) as {
      props: { onClick?: unknown };
    };
    expect(element.props.onClick).toBe(emitSmsSignupCtaClick);
  });

  it('🔴 is a client island — the directive is load-bearing, not cosmetic', () => {
    // lib/analytics/client.ts is itself `use client`. Drop the directive here and this
    // component becomes a server component importing a client module, which is a build
    // failure — but a build failure a long way from the line that caused it.
    const src = readFileSync(
      fileURLToPath(new URL('../../app/_components/SmsSignupCta.tsx', import.meta.url)),
      'utf8',
    );
    expect(src.trimStart().startsWith("'use client'")).toBe(true);
  });
});
