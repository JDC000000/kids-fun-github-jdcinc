import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// Venue phone on the detail surface (Jon, 2026-08-01: "show parents the telephone number for
// all venues… make those phone numbers prominent and easily available").
//
// This file guards the two things that can go wrong with a parent-facing phone number, and
// they pull in opposite directions:
//   • NOT SHOWN when it should be — the number is captured for only one source family, so the
//     render is conditional, and a conditional render is exactly what silently disappears.
//   • SHOWN WITH A FALSE CLAIM — 13 of the 36 Vancouver facilities share a line in 6 groups,
//     7 of them satellites answering on a parent centre's main number. Copy that says or
//     implies "call this number about this session" is wrong for those, so the copy is
//     asserted here as a contract, not left to review.
// Third: the value is stored VERBATIM as the source renders it (docs/source-register.md
// §6.3.6) — only the dial target is normalised — so both are pinned separately.
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: unknown; children: unknown; [k: string]: unknown }) => (
    <a href={typeof href === 'string' ? href : String(href ?? '')} {...rest}>
      {children as never}
    </a>
  ),
}));

import { ActivityDetail } from '../../app/preview/_components/ActivityDetail';
import { ACTIVITIES } from '../../app/preview/_data/fixtures';
import { telHref } from '../../app/preview/_data/format';
import { mapListingRecordToActivity } from '../../app/preview/_data/search-api';
import { makeListing } from '../../lib/search/__fixtures__/factory';
import type { Activity } from '../../app/preview/_data/types';

function render(activity: Activity): string {
  return renderToStaticMarkup(
    <ActivityDetail activity={activity} occurrenceId={activity.id} backHref="/search" backLabel="Back" />
  );
}

const WITH_PHONE = ACTIVITIES.find((a) => a.venuePhone)!;
const WITHOUT_PHONE = ACTIVITIES.find((a) => !a.venuePhone)!;

describe('telHref — display stays verbatim, only the dial target is normalised', () => {
  it('strips the source’s punctuation to a dialable string', () => {
    expect(telHref('(604) 555-0142')).toBe('tel:6045550142');
    expect(telHref('604-555-0142')).toBe('tel:6045550142');
  });

  it('keeps a country code the source actually supplied, and never invents one', () => {
    expect(telHref('+1 (604) 555-0177')).toBe('tel:+16045550177');
    expect(telHref('(604) 555-0177')).toBe('tel:6045550177'); // no `+1` grafted on
  });

  it('carries an extension as RFC 3966 `;ext=` rather than dialing a different number', () => {
    // `normaliseVenuePhone` admits `ext.`-suffixed values, so this shape can reach the UI.
    // Concatenating the extension digits would produce tel:60455501425 — a real wrong number.
    expect(telHref('(604) 555-0142 ext. 5')).toBe('tel:6045550142;ext=5');
    expect(telHref('604-555-0142 x201')).toBe('tel:6045550142;ext=201');
  });

  it('returns null for anything that cannot be dialed, so no dead link is rendered', () => {
    expect(telHref('12345')).toBeNull();
    expect(telHref('   ')).toBeNull();
    expect(telHref('ext. 5')).toBeNull();
  });
});

describe('the number is prominent and reachable when the source published one', () => {
  const html = render(WITH_PHONE);

  it('renders the number verbatim — the source’s own rendering, not a reformat', () => {
    expect(html).toContain(WITH_PHONE.venuePhone!);
  });

  it('is a real tap-to-call link, not just text', () => {
    expect(html).toContain(`href="${telHref(WITH_PHONE.venuePhone!)}"`);
  });

  it('sits in the hero, above the status/stat row — "easily available", not buried', () => {
    expect(html.indexOf('kf-phone')).toBeLessThan(html.indexOf('kf-statrow'));
    expect(html.indexOf('kf-phone')).toBeLessThan(html.indexOf('Source &amp; freshness'));
  });

  it('gives assistive tech a self-contained accessible name', () => {
    expect(html).toContain(`aria-label="Call the venue at ${WITH_PHONE.venuePhone}"`);
  });

  it('renders the +1 rendering verbatim too — the one shape that differs across the 36 values', () => {
    const listing = makeListing({ venueName: 'Kitsilano Pool', venuePhone: '+1 (604) 555-0177' });
    const out = render(mapListingRecordToActivity(listing));
    expect(out).toContain('+1 (604) 555-0177');
    expect(out).toContain('href="tel:+16045550177"');
  });
});

describe('the copy claims only what is true of every captured value', () => {
  const html = render(WITH_PHONE);

  it('attributes the number to the VENUE, never to this session', () => {
    expect(html).toContain('Call the venue');
    expect(html).toContain('front desk');
  });

  it('states both real caveats — not session-specific, and shared at multi-facility sites', () => {
    expect(html).toContain('not a line for this specific session');
    expect(html).toContain('may ring the main centre');
  });

  it('never tells a parent to call about this session, which the data cannot support', () => {
    for (const claim of [
      'Call about this session',
      'call about this session',
      'Book by phone',
      'Call to book',
      'Call to register',
      'Register by phone',
    ]) {
      expect(html).not.toContain(claim);
    }
  });

  it('does not name the facility in the call-to-action', () => {
    // 7 of the 36 Vancouver facilities answer on a PARENT centre's number, so
    // "Call {venue}" would be a false claim for exactly those satellites.
    expect(html).not.toContain(`Call ${WITH_PHONE.venue}`);
  });
});

describe('listings with no phone render cleanly — the majority case, not an edge case', () => {
  const html = render(WITHOUT_PHONE);

  it('renders nothing phone-shaped at all: no link, no label, no empty field', () => {
    expect(html).not.toContain('tel:');
    expect(html).not.toContain('kf-phone');
    expect(html).not.toContain('Call the venue');
    expect(html).not.toContain('front desk');
  });

  it('does not regress the rest of the detail page', () => {
    expect(html).toContain('Source &amp; freshness');
    expect(html).toContain('kf-statrow');
    expect(html).toContain('kf-actionbar');
  });

  it('holds for EVERY phone-less fixture, not just the one sampled', () => {
    const phoneless = ACTIVITIES.filter((a) => !a.venuePhone);
    expect(phoneless.length).toBeGreaterThan(0);
    for (const activity of phoneless) {
      expect(render(activity), activity.id).not.toContain('tel:');
    }
  });

  it('drops a stored-but-undialable value rather than rendering a dead link', () => {
    const listing = makeListing({ venueName: 'Old Hall Gym', venuePhone: '12345' });
    const out = render(mapListingRecordToActivity(listing));
    expect(out).not.toContain('tel:');
    expect(out).not.toContain('12345');
  });
});

describe('the search lane actually carries the field to the component', () => {
  it('maps ListingRecord.venuePhone onto Activity.venuePhone', () => {
    const listing = makeListing({ venuePhone: '(604) 555-0142' });
    expect(mapListingRecordToActivity(listing).venuePhone).toBe('(604) 555-0142');
  });

  it('leaves the key absent (not empty-string) when the source published none', () => {
    expect(mapListingRecordToActivity(makeListing({})).venuePhone).toBeUndefined();
  });

  it('survives the JSON hop the /api/search response makes', () => {
    const listing = makeListing({ venuePhone: '(604) 555-0142' });
    const overWire = JSON.parse(JSON.stringify(listing));
    expect(mapListingRecordToActivity(overWire).venuePhone).toBe('(604) 555-0142');
  });
});
