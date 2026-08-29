// tests/sms/start_page.test.tsx — the minimal /sms/start landing page (Jon's brief, 2026-08-28).
//
// `renderToStaticMarkup`, the same idiom the rest of this repo's component tests use. The initial
// render is what matters most here for the same reason it does on /sms/signup: "unchecked by
// default" is a claim about the first paint specifically, and it is the thing a compliance reviewer
// looks at hardest.
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { StartForm, withoutFieldError } from '@/app/sms/start/_components/StartForm';
import {
  CARRIER_DISCLOSURES,
  CONSENT_CHECKBOX_TEXT,
  SENDER_IDENTITY,
} from '@/lib/sms/consent-copy';
import { START_CTA, START_HEADING } from '@/app/sms/start/copy';
import { SMS_INTEREST_OPTIONS } from '@/lib/sms/interests';
import { hidesSiteChrome } from '@/lib/sms/surfaces';

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

const html = renderToStaticMarkup(<StartForm sparseRegionIds={[]} />);
const text = html.replace(/<[^>]+>/g, ' ');

describe("Jon's copy, verbatim", () => {
  it('is the exact title and call to action he supplied', () => {
    // Quoted, not adapted. If either is reworded, that is a product-owner decision, not a tidy-up.
    expect(START_HEADING).toBe(
      'Fun activities for you and your kids delivered by SMS once per week.'
    );
    expect(START_CTA).toBe(
      "Enter your postal code, kids ages, activity preferences and tel number. We'll do the rest"
    );
  });
});

describe('the four things the brief asks for, and nothing else', () => {
  it('captures postal code, child age, activity preferences and phone number', () => {
    for (const name of ['postal', 'childAge', 'interests', 'phone']) {
      expect(html, name).toContain(`name="${name}"`);
    }
  });

  it('🔴 asks for POSTAL before PHONE — the order Jon wrote, and the order compliance needs', () => {
    // Two reasons this is asserted rather than left to chance. It follows the CTA's own wording,
    // and it preserves Jon's earlier ruling that the coverage check fires BEFORE consent: an
    // out-of-area parent should learn we cannot serve them before being asked to agree to anything.
    expect(html.indexOf('name="postal"')).toBeLessThan(html.indexOf('name="phone"'));
    expect(html.indexOf('name="phone"')).toBeLessThan(html.indexOf('name="consent"'));
  });

  it('offers every interest option, all unchecked', () => {
    // Compared against the ESCAPED label: five of these contain "&" ("Open gym & drop-in sports"),
    // which react-dom/server emits as &amp;. Asserting the raw string would fail on the entity and
    // look like a missing option.
    for (const option of SMS_INTEREST_OPTIONS) {
      expect(text, option.label).toContain(esc(option.label));
    }
    expect(html).not.toMatch(/name="interests"[^>]*checked/);
  });

  it('adds no field beyond the brief', () => {
    // Minimal friction, asserted. A name/email/address creeping in later fails here.
    const names = [...html.matchAll(/name="([^"]+)"/g)].map((m) => m[1]);
    expect([...new Set(names)].sort()).toEqual(
      ['childAge', 'consent', 'interests', 'phone', 'postal'].sort()
    );
  });
});

describe('compliance survived the simplification', () => {
  it('🔴 uses the SHARED consent sentence, byte-identical to /sms/signup', () => {
    // The single most important assertion in this file. The brief allowed condensing the copy; the
    // consent sentence was deliberately NOT condensed, because `sms_consent.consent_text_version`
    // records WHICH WORDING a subscriber agreed to. Two forms with two sentences and one version
    // string would make every stored row ambiguous about which one it meant.
    expect(text).toContain(esc(CONSENT_CHECKBOX_TEXT).replace(/\s+/g, ' ').trim().slice(0, 60));
    expect(html).toContain(esc(CONSENT_CHECKBOX_TEXT));
  });

  it('leaves the consent box UNCHECKED — the basis of express opt-in', () => {
    const box = html.match(/<input[^>]*name="consent"[^>]*>/)?.[0];
    expect(box).toBeTruthy();
    expect(box).not.toContain('checked');
  });

  it('renders every carrier disclosure and the sender identification', () => {
    for (const line of CARRIER_DISCLOSURES) {
      expect(text.replace(/\s+/g, ' '), line).toContain(line.replace(/\s+/g, ' '));
    }
    expect(text).toContain(SENDER_IDENTITY.legalName);
    expect(text).toContain(SENDER_IDENTITY.mailingAddress);
    expect(text).toContain(SENDER_IDENTITY.businessRegistration);
  });

  it('links to the full terms and privacy policy', () => {
    // The brief's own suggested shape for condensing: one checkbox plus a link to the full text.
    expect(html).toContain('href="/terms"');
    expect(html).toContain('href="/privacy"');
  });
});

describe('the page is chrome-free, and only this page is', () => {
  it('suppresses the site chrome on /sms/start', () => {
    expect(hidesSiteChrome('/sms/start')).toBe(true);
  });

  it('🔴 leaves /sms/signup alone — its nav is PRD §2.1 door 2, not an oversight', () => {
    // SiteNav.tsx: "a parent who lands on the signup form from a QR code should still be able to
    // reach the catalogue." This page being bare is a decision about THIS page. If someone later
    // widens the prefix list to all of /sms, that reasoning dies silently — so it fails here first.
    expect(hidesSiteChrome('/sms/signup')).toBe(false);
    expect(hidesSiteChrome('/search')).toBe(false);
    expect(hidesSiteChrome('/')).toBe(false);
  });

  it('does not sweep in a route that merely starts with the same letters', () => {
    expect(hidesSiteChrome('/sms/started')).toBe(false);
    expect(hidesSiteChrome('/sms/start/extra')).toBe(true);
  });
});

describe('stale field errors', () => {
  const errs = [
    { field: 'postal' as const, message: 'out of area' },
    { message: 'network' },
  ];

  it('drops only the corrected field and keeps the general error', () => {
    const after = withoutFieldError(errs, 'postal');
    expect(after.map((e) => e.field)).toEqual([undefined]);
  });

  it('returns the SAME array when there is nothing to drop', () => {
    expect(withoutFieldError(errs, 'phone')).toBe(errs);
  });
});
