'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { trackEvent } from '@/lib/analytics/client';

// app/_components/SmsSignupCta.tsx — the home page's primary SMS signup action, and the
// browser half of the front-door funnel (TSD §9 M1 T1.6 / AC-09).
//
// ═══ WHY THIS IS A CLIENT ISLAND AND THE REST OF THE OFFER IS NOT ═══
// The offer block in app/page.tsx is server-rendered; only this one anchor ships JavaScript.
// The event has to be fired from the browser because the CTA is an internal <Link> — the
// server never sees the click, so there is no server-side vantage point to emit from. Keeping
// the island down to the anchor keeps that cost to the anchor.
//
// ═══ trackEvent's FIRST CONSUMER, ANYWHERE IN THIS PRODUCT (TSD §4.4, risk R-08) ═══
// lib/analytics/client.ts has existed since the analytics foundation shipped and has been
// called from nowhere, so its sendBeacon-then-keepalive-fetch path has never actually run.
// That is why the e2e spec (tests/e2e/public/sms-cta-analytics.public.spec.ts) drives a real
// browser and watches for the real request rather than trusting a unit mock — a mocked
// trackEvent would prove this file calls it and nothing about whether calling it works.

/**
 * Fire the click event. Extracted and exported so it is directly testable: this project runs
 * vitest in the `node` environment with no jsdom, so there is no real click to simulate.
 *
 * SYNCHRONOUS, RETURNING void, DELIBERATELY. If this returned a promise, the next person to
 * touch the handler could reasonably await it, and the parent's tap would then wait on a
 * network call before going anywhere. An unawaitable return type removes that option instead
 * of documenting against it.
 *
 * THE try/catch IS NOT REDUNDANT WITH trackEvent's OWN. trackEvent swallows everything and
 * promises never to throw — but it has never run in production, and an exception escaping an
 * onClick handler is not a lost analytics row: it is a parent who tapped the product's primary
 * action and went nowhere. The cost of this guard is three lines; the cost of being wrong about
 * a promise nothing has ever exercised is the conversion this whole milestone measures.
 */
export function emitSmsSignupCtaClick(): void {
  try {
    trackEvent('sms_signup_cta_clicked');
  } catch {
    /* Never block the navigation. A missing analytics row is not worth a dead CTA. */
  }
}

export interface SmsSignupCtaProps {
  /** The internal signup path, from lib/sms/availability.ts. Never an absolute url. */
  href: string;
  children: ReactNode;
}

/**
 * An ANCHOR, not a button with a router.push(). The distinction is the requirement, not a
 * styling choice: a button would put the analytics call on the path to the destination, so a
 * slow or failed emit would become a slow or failed navigation. A link navigates because it is
 * a link; the emit rides alongside it and the browser does not wait for it.
 */
export function SmsSignupCta({ href, children }: SmsSignupCtaProps) {
  return (
    <Link className="kf-home__sms-cta" href={href} onClick={emitSmsSignupCtaClick}>
      {children}
    </Link>
  );
}
