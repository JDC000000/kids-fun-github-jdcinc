import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import PrivacyPage from './page';

// Node-env smoke test (no jsdom): render the /privacy page to static markup and
// assert it renders and carries KEY identifying phrases from the Jon-approved policy
// text. Deliberately NOT a verbatim assertion of the whole wording — the approved
// text is a signed-off artifact that may be revised upstream, and a full-text match
// would make this test brittle against any future approved change. It checks the page
// is wired and shows the load-bearing PIPEDA content, not that every word is frozen.

// Tag-stripped, whitespace-collapsed text content of the rendered page.
function textOf(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('/privacy page', () => {
  const html = renderToStaticMarkup(<PrivacyPage />);
  const text = textOf(html);

  it('renders a page with a Privacy Policy heading', () => {
    expect(html).toContain('<h1');
    expect(text).toContain('Privacy Policy');
    expect(text).toContain('KIDS FUN');
  });

  it('states who operates KIDS FUN and the PIPEDA basis', () => {
    expect(text).toContain('KIDS FUN is operated by Jon Cartwright');
    expect(text).toContain(
      'Personal Information Protection and Electronic Documents Act (PIPEDA)',
    );
  });

  it('includes the core policy sections', () => {
    expect(text).toContain('What we collect, and why');
    expect(text).toContain('Anonymous usage data');
    expect(text).toContain('How long we keep it');
    expect(text).toContain('Your choices and rights');
    expect(text).toContain('How to reach us / raise a concern');
  });

  it('discloses the anonymous cookie and both retention windows', () => {
    expect(text).toContain('kf_anon_id');
    expect(text).toContain('about 13 months'); // anonymous usage events
    expect(text).toContain('6 months'); // problem reports (corrected retention window)
  });

  it('names the service providers and the OPC complaint route', () => {
    for (const provider of ['Supabase', 'Resend', 'Sentry', 'Twilio']) {
      expect(text).toContain(provider);
    }
    expect(text).toContain('Office of the Privacy Commissioner of Canada');
  });

  it('no longer names Google as a sign-in provider — the capability is gated', () => {
    // Google was in the list above until 2026-09-12, when sign-in was gated
    // (lib/auth/google-signin-gate.ts). A privacy policy naming a provider we no longer use for a
    // capability visitors no longer have is not a harmless leftover: it is the page telling
    // someone their data goes somewhere it does not, and the one page they are entitled to
    // believe. Asserted as an absence so re-adding it needs a deliberate edit here too.
    expect(text).not.toContain('Google');
  });

  it('routes every PIPEDA right somewhere a visitor can actually reach with no login', () => {
    // The rights section used to send people to "your Account page", which now 404s. A right that
    // resolves to a dead page is not a right. These must point at the SMS preferences page.
    expect(text).not.toContain('Account page');
    expect(text).toContain('preferences page');
  });

  it('exposes a working (interim) contact channel as a mailto link', () => {
    expect(html).toContain('href="mailto:joncartwright00@gmail.com"');
    expect(text).toContain('joncartwright00@gmail.com');
  });

  it('never renders an unresolved placeholder artifact', () => {
    // The effective-date placeholder is a publish-time stamp; until set it must be
    // omitted, never rendered as a visible "[set on publish]" / null / undefined.
    expect(html).not.toContain('[set on publish]');
    expect(html).not.toContain('[[');
    expect(text).not.toContain('Effective date: null');
    expect(text).not.toContain('undefined');
  });
});
