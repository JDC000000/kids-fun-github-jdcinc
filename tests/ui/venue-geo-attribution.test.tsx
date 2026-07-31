import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// G-VENUE-3 + QA F1 — where the open-data licence notice renders, and where it must NOT.
//
// The regression this file exists for is specific and was found live, not hypothetically.
// The first implementation rendered the notice on the activity detail panel, resolved by
// VENUE NAME. `worker/adapters/citycalendar/config.ts` independently carries 5 venue names
// byte-identical to the ActiveNet geo table's, with DIFFERENT coordinates (up to ~802 m
// apart), and `resolveVenue()` matches on `lower(name)` first-writer-wins — so a venue row
// a parent sees may hold coordinates from a completely different adapter, or (in fixture
// mode) from a hand-written demo fixture. QA reproduced three live false claims in default
// fixture mode: trout-lake-public-skate, killarney-skate-lessons, l-opengym-van.
//
// The fix is structural rather than a narrower filter: the notice is SITE-WIDE, so it makes
// no per-venue claim at all and cannot misfire. Both halves are asserted here — the notice
// really renders somewhere a parent sees it, AND it no longer renders per venue.
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('../../app/_components/site-footer.css', () => ({}));

import { SiteFooter } from '../../app/_components/SiteFooter';
import { ActivityDetail } from '../../app/preview/_components/ActivityDetail';
import { ACTIVITIES } from '../../app/preview/_data/fixtures';

const OGL = 'Contains information licensed under the Open Government Licence – Vancouver';

describe('G-VENUE-3: the licence notice renders site-wide', () => {
  const html = renderToStaticMarkup(<SiteFooter />);

  it('renders the OGL – Vancouver attribution string verbatim, linked to the licence', () => {
    expect(html).toContain(OGL);
    expect(html).toContain('https://opendata.vancouver.ca/pages/licence/');
  });

  it('renders the ODbL notice for the two OpenStreetMap coordinates', () => {
    expect(html).toContain('OpenStreetMap contributors');
    expect(html).toContain('https://www.openstreetmap.org/copyright');
  });

  it('renders each notice exactly once, not once per venue', () => {
    expect(html.split(OGL).length - 1).toBe(1);
  });

  it('does not regress the footer chrome it was added to', () => {
    expect(html).toContain('KIDS FUN');
    expect(html).toContain('/privacy');
  });
});

describe('QA F1 regression: no per-venue licence claim on the detail surface', () => {
  // The three fixtures QA reproduced the false claim on, by id.
  const REPRODUCTIONS = ['trout-lake-public-skate', 'killarney-skate-lessons'];

  for (const id of REPRODUCTIONS) {
    it(`"${id}" no longer claims OGL licensing for coordinates that are not the City's`, () => {
      const activity = ACTIVITIES.find((a) => a.id === id);
      expect(activity, `fixture ${id} should still exist`).toBeDefined();
      const html = renderToStaticMarkup(
        <ActivityDetail activity={activity!} occurrenceId={id} backHref="/search" backLabel="Back" />
      );
      expect(html).not.toContain(OGL);
      expect(html).not.toContain('opendata.vancouver.ca');
      expect(html).not.toContain('openstreetmap.org');
      // …and the panel it used to sit in is otherwise untouched.
      expect(html).toContain('Source &amp; freshness');
    });
  }

  it('holds for EVERY detail fixture, not just the three QA happened to find', () => {
    for (const activity of ACTIVITIES) {
      const html = renderToStaticMarkup(
        <ActivityDetail
          activity={activity}
          occurrenceId={activity.id}
          backHref="/search"
          backLabel="Back"
        />
      );
      expect(html, activity.id).not.toContain(OGL);
    }
  });
});
