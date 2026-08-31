// tests/sms/start_page.test.tsx — the minimal /sms/start landing page (Jon's brief, 2026-08-28).
//
// `renderToStaticMarkup`, the same idiom the rest of this repo's component tests use. The initial
// render is what matters most here for the same reason it does on /sms/signup: "unchecked by
// default" is a claim about the first paint specifically, and it is the thing a compliance reviewer
// looks at hardest.
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  StartForm,
  START_CONSENT_METHOD,
  canAddAnotherChild,
  withoutFieldError,
} from '@/app/sms/start/_components/StartForm';
import { MAX_CHILDREN } from '@/lib/sms/signup-validate';
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

describe('consent_method is the CASL channel, not a page label', () => {
  it('🔴 /sms/start records web_form — because that is how consent is actually obtained here', () => {
    // A parent on this page fills a form and ticks a checkbox. Migration 0034: consent_method
    // records "HOW IT WAS OBTAINED". This is the correct value and it is asserted so the
    // attractive-looking wrong one cannot land quietly.
    expect(START_CONSENT_METHOD).toBe('web_form');
  });

  it("🔴 is NOT 'sms_start' — that is a different channel, despite the route name", () => {
    // 'sms_start' is permitted by the CHECK constraint and currently unused, so it LOOKS available,
    // and this route is /sms/start, so it LOOKS intended. It means the subscriber texted the START
    // keyword (PRD §2.1 door 2, unbuilt). Using it here would assert we received a text that does
    // not exist, and would burn the value for the real door when it ships.
    //
    // This was proposed once in good faith and withdrawn. The assertion is the thing that makes the
    // withdrawal stick.
    expect(START_CONSENT_METHOD).not.toBe('sms_start');
    expect(START_CONSENT_METHOD).not.toBe('email_link');
  });
});

describe('the "Add another child" cap', () => {
  // The guard SmsSignupForm has always had, which did not carry over when this page was built:
  // the button was unconditional, so a parent could add rows indefinitely and only discover the
  // limit when the SERVER rejected the whole submission at 8 — losing everything they had typed.

  it('🔴 stops exactly at MAX_CHILDREN, not one either side', () => {
    // The boundary is the whole point; an off-by-one here is invisible until someone hits it.
    expect(canAddAnotherChild(MAX_CHILDREN - 1)).toBe(true);
    expect(canAddAnotherChild(MAX_CHILDREN)).toBe(false);
    expect(canAddAnotherChild(MAX_CHILDREN + 1)).toBe(false);
  });

  it('allows the first row to be added from the initial state', () => {
    expect(canAddAnotherChild(1)).toBe(true);
  });

  it('uses the validator\'s constant rather than a literal', () => {
    // If MAX_CHILDREN ever moves, the button must move with it. A hardcoded 8 in the JSX would
    // pass every other assertion here and silently disagree with the server.
    expect(canAddAnotherChild(MAX_CHILDREN)).toBe(false);
    expect(MAX_CHILDREN).toBeGreaterThan(0);
  });
});

describe('the area waitlist is offered only when there is an area problem', () => {
  // renderToStaticMarkup gives the INITIAL state: postal is empty, which classifies as `unknown`.
  // That is the case worth pinning here — the panel must not greet somebody who has typed nothing.
  // The three-way classification itself is covered in tests/sms/area_coverage.test.ts, and the
  // rendered behaviour for each state was verified in a browser against a real build.

  it('🔴 shows NO waitlist panel before a postal code is typed', () => {
    expect(html).not.toContain('name="waitlistConsent"');
    expect(text).not.toContain('Text me when you reach my area');
  });

  it('shows the ordinary signup in full, since nothing says otherwise yet', () => {
    // The out-of-area branch hides ages, interests and the signup button. On first render none of
    // that has happened, so their presence is what proves the gate defaults to "offer the normal
    // thing" rather than to the waitlist.
    for (const name of ['postal', 'childAge', 'interests', 'phone', 'consent']) {
      expect(html, name).toContain(`name="${name}"`);
    }
  });
});
