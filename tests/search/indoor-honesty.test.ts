// tests/search/indoor-honesty.test.ts — the "Indoor" / "Rainy-day friendly" claim must be earned.
//
// Guards the two severity-3 child-safety mislabels found in the 15-persona testing cycle, both
// traced to `suitabilityTags()` adding `indoor` for `class_program` — the key that MEANS
// "unclassified". A parent trusting "Indoor / Rainy-day friendly" on a rainy day sends their child
// to outdoor soccer, so these run the REAL chain (DB row → read model → Activity → rendered facts)
// rather than the pure function in isolation: every link in it had a way to reintroduce the claim.

import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { loadPostgresListings, loadPostgresListingById } from '../../lib/search/postgres-repository';
import { readIndoorOutdoor, hasOutdoorMarker, indoorTextVerdict } from '../../lib/search/indoor';
import { mapListingRecordToActivity } from '../../app/preview/_data/search-api';
import { practicalFacts } from '../../app/preview/_data/format';

interface RowOverrides {
  activity_name?: string;
  primary_category_key?: string | null;
  tag_keys?: string[];
  description_snippet?: string;
}

function row(id: string, overrides: RowOverrides = {}) {
  return {
    id,
    series_id: `series-${id}`,
    activity_name: 'Untitled Session',
    primary_category_key: 'class_program',
    tag_keys: [],
    venue_name: 'Test Centre',
    source_name: 'Test Source',
    series_title: 'Test Series',
    source_authority_tier: 'official',
    description_snippet: '',
    start_datetime_utc: '2026-09-01T17:00:00Z',
    end_datetime_utc: '2026-09-01T18:00:00Z',
    open_hours_state: null,
    cost_status: 'free',
    cost_min_cad: null,
    cost_max_cad: null,
    source_url: 'https://example.org/test',
    booking_url: null,
    location_url: null,
    status_state: 'confirmed',
    confidence_label: 'high',
    last_checked_at: '2026-08-18T00:00:00Z',
    age_min_months: null,
    age_max_months: null,
    age_notes: null,
    age_band_keys: [],
    lat: null,
    lng: null,
    municipality_id: null,
    neighbourhood: null,
    display_area: null,
    phone: null,
    ...overrides,
  };
}

function fakePool(rows: ReturnType<typeof row>[]): Pool {
  return { query: async () => ({ rows }) } as unknown as Pool;
}

/** DB row → read model → Activity → the strings the detail page actually prints. */
async function render(overrides: RowOverrides) {
  const listings = await loadPostgresListings(fakePool([row('r1', overrides)]));
  const activity = mapListingRecordToActivity(listings[0]);
  return { listing: listings[0], activity, facts: practicalFacts(activity) };
}

describe('hasOutdoorMarker', () => {
  it('reads the source saying outdoors, however it punctuates it', () => {
    expect(hasOutdoorMarker('Sportball Outdoor Soccer (5-7yrs) Rain/Shine')).toBe(true);
    expect(hasOutdoorMarker('Soccer, rain or shine')).toBe(true);
    expect(hasOutdoorMarker('Soccer — Rain-Shine')).toBe(true);
    expect(hasOutdoorMarker(null, 'Held in the community garden.')).toBe(true);
  });

  it('does not fire on venue NAMES that merely contain a nature word', () => {
    // Every one of these is a real live listing at an INDOOR venue. A marker that fires on a
    // place name buys no safety and costs rainy-day recall, which is why `creek`/`lake`/`track`/
    // `walk` are not markers — see lib/search/indoor.ts.
    expect(hasOutdoorMarker('Lynn Creek Youth Centre Tuesday 5:30pm-7:30pm (Grade 7+)')).toBe(false);
    expect(hasOutdoorMarker('Trout Lake Arena - Stick, Puck & Ring')).toBe(false);
    expect(hasOutdoorMarker('All Candidates Meeting: False Creek Community Centre')).toBe(false);
    expect(hasOutdoorMarker('Parkgate Community Centre Drop-in')).toBe(false); // not \bpark\b
  });

  it('is not stateful across calls', () => {
    // A `g`-flagged regex would alternate true/false here and mislabel every other listing.
    expect(hasOutdoorMarker('Outdoor Soccer')).toBe(true);
    expect(hasOutdoorMarker('Outdoor Soccer')).toBe(true);
  });
});

describe('indoorTextVerdict', () => {
  it('decides only when the words are one-sided', () => {
    expect(indoorTextVerdict('Indoor Free Play')).toBe('indoor');
    expect(indoorTextVerdict('Outdoor Baby & Me Bootcamp')).toBe('outdoor');
  });

  it('abstains when the words say nothing, or say both', () => {
    expect(indoorTextVerdict('Watercolour Basics (7-11yrs)')).toBeNull();
    // Both words present. The sentence has settled nothing, so it casts no vote and the tags /
    // category decide — it must NOT be read as an outdoor veto ("Indoor Playground" is indoors).
    expect(indoorTextVerdict('Indoor/Outdoor Stroller Fitness with Carey')).toBeNull();
    expect(indoorTextVerdict('Indoor Playground Free Play')).toBeNull();
  });
});

describe('suitabilityTags — an unclassified listing is not an indoor listing', () => {
  it('never derives `indoor` from class_program, the "we could not classify this" fallback', async () => {
    const { listing, activity, facts } = await render({ activity_name: 'Watercolour Basics (7-11yrs)' });
    expect(listing.primaryCategoryKey).toBe('class_program');
    expect(listing.suitabilityTags).not.toContain('indoor');
    expect(activity.indoor).toBeNull();
    expect(activity.rainyDay).toBe(false);
    expect(facts).not.toContain('Rainy-day friendly');
  });

  it('degrades an absent claim to NOTHING, never to a fabricated "Outdoor"', async () => {
    const { activity, facts } = await render({ activity_name: 'Watercolour Basics (7-11yrs)' });
    expect(activity.indoor).toBeNull();
    expect(facts).not.toContain('Indoor');
    expect(facts).not.toContain('Outdoor');
  });

  it('does not tag the reported "Rain/Shine" outdoor soccer sessions indoor', async () => {
    for (const name of [
      'Sportball Outdoor Soccer (5-7yrs) Rain/Shine',
      'Sportball Outdoor Parent & Child Soccer (2-3yrs) Rain/Shine',
    ]) {
      const { listing, activity, facts } = await render({ activity_name: name });
      expect(listing.suitabilityTags).not.toContain('indoor');
      expect(activity.indoor).toBe(false);
      expect(activity.rainyDay).toBe(false);
      expect(facts).toContain('Outdoor');
      expect(facts).not.toContain('Indoor');
      expect(facts).not.toContain('Rainy-day friendly');
    }
  });

  it('still tags genuine indoor_play / storytime indoor — no over-correction', async () => {
    for (const key of ['indoor_play', 'storytime']) {
      const { listing, activity, facts } = await render({
        primary_category_key: key,
        activity_name: 'Baby Storytime',
      });
      expect(listing.suitabilityTags).toContain('indoor');
      expect(activity.indoor).toBe(true);
      expect(activity.rainyDay).toBe(true);
      expect(facts).toEqual(expect.arrayContaining(['Indoor', 'Rainy-day friendly']));
    }
  });

  it('vetoes indoor even under storytime/indoor_play when the title says outdoors', async () => {
    // Outdoor storytime is a real thing, so the veto is not `class_program`-specific.
    const { listing, activity, facts } = await render({
      primary_category_key: 'storytime',
      activity_name: 'Storytime in the Park',
    });
    expect(listing.suitabilityTags).not.toContain('indoor');
    expect(activity.indoor).toBe(false);
    expect(facts).toContain('Outdoor');
  });

  it('does not let an outdoor WORD veto an explicit indoor one in the same title', async () => {
    // `playground` and `park` are outdoor markers. A veto that ignored the rest of the sentence
    // would strip `indoor` from precisely the listings that have earned it.
    for (const name of ['Indoor Playground Free Play', 'Indoor Play at Parkgate']) {
      const { listing, activity } = await render({ primary_category_key: 'indoor_play', activity_name: name });
      expect(listing.suitabilityTags).toContain('indoor');
      expect(activity.indoor).toBe(true);
    }
  });

  it('passes the source’s own tags through untouched', async () => {
    // The fix stops INVENTING a claim; it does not start editing what the source said.
    const { listing } = await render({ tag_keys: ['indoor', 'outdoor', 'stroller_friendly'] });
    expect(listing.suitabilityTags).toEqual(expect.arrayContaining(['indoor', 'outdoor', 'stroller_friendly']));
  });

  it('applies to the DETAIL loader too, which is where both findings were seen', async () => {
    // `loadPostgresListingById` is a SEPARATE entry point sharing `rowToListing`, and the two
    // reported listings were observed on their /preview/<id> detail pages — not in a result list.
    // A fix verified only through the list loader would not have proven the page in the report.
    const id = 'd759d82f-e83e-42b4-96c5-cbdb34aa2408'; // the live Sportball occurrence
    const listing = await loadPostgresListingById(
      fakePool([row(id, { activity_name: 'Sportball Outdoor Parent & Child Soccer (2-3yrs) Rain/Shine' })]),
      id,
    );
    expect(listing).not.toBeNull();
    expect(listing?.suitabilityTags).not.toContain('indoor');
    expect(practicalFacts(mapListingRecordToActivity(listing!))).toEqual(['Outdoor']);
  });
});

describe('readIndoorOutdoor', () => {
  const read = (over: Partial<Parameters<typeof readIndoorOutdoor>[0]>) =>
    readIndoorOutdoor({ primaryCategoryKey: 'class_program', tags: [], activityName: '', ...over });

  it('answers unknown when nothing states either way', () => {
    expect(read({ activityName: 'Watercolour Basics' })).toBe('unknown');
  });

  it('answers outdoor from the source’s own words or tag', () => {
    expect(read({ activityName: 'Outdoor Baby & Me Bootcamp' })).toBe('outdoor');
    expect(read({ tags: ['outdoor'] })).toBe('outdoor');
    expect(read({ primaryCategoryKey: 'outdoor_park', activityName: 'Zumba in the Park' })).toBe('outdoor');
  });

  it('answers unknown — not a coin toss — when the source says BOTH', () => {
    // Five such listings are live: "Indoor/Outdoor Stroller Fitness with Carey" carries both tags
    // AND both words in its title, so every tier abstains and the reading falls through.
    expect(read({ tags: ['indoor', 'outdoor'], activityName: 'Indoor/Outdoor Stroller Fitness' })).toBe('unknown');
  });

  it('lets the source’s own words beat an indoor facility category', () => {
    expect(read({ primaryCategoryKey: 'public_swim', activityName: 'Second Beach Outdoor Pool' })).toBe('outdoor');
    expect(read({ primaryCategoryKey: 'public_swim', activityName: 'Public Swim' })).toBe('indoor');
  });

  it('abstains when a tag and a category contradict — two weak signals are not one strong one', () => {
    // 42 live "$3 Open Gym 8yrs+ Parkgate …" listings are exactly this: an `outdoor` tag (read off
    // the venue name) against an indoor-gym category. Neither earns the label.
    expect(read({ primaryCategoryKey: 'open_gym', tags: ['open_gym', 'outdoor'] })).toBe('unknown');
    expect(read({ primaryCategoryKey: 'outdoor_park', tags: ['indoor'] })).toBe('unknown');
  });

  it('uses a lone derived signal when nothing contradicts it', () => {
    expect(read({ tags: ['outdoor'] })).toBe('outdoor');
    expect(read({ tags: ['rainy_day'] })).toBe('indoor');
    expect(read({ primaryCategoryKey: 'open_gym' })).toBe('indoor');
    expect(read({ primaryCategoryKey: 'outdoor_park' })).toBe('outdoor');
  });
});

describe('practicalFacts', () => {
  it('abstains rather than printing a claim for a null reading', () => {
    expect(practicalFacts({ indoor: null, rainyDay: false, dropIn: false })).toEqual([]);
    expect(practicalFacts({ indoor: null, rainyDay: false, dropIn: true })).toEqual(['No registration needed']);
  });
});
