// The parent-facing half of the registration/collapsing work: the URL contract, the filter
// control, and what a card actually says.
//
// The behaviour these pin is not negotiable: registration content is OFF unless explicitly asked
// for, and when it IS shown the card says "Registration required" rather than passing as a
// drop-in. The collapsing tests pin the other half — one card, honest about how many slots it
// stands for and over what window.

import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, prefetch: () => {} }),
}));

import { FilterRail } from '@/app/search/_components/FilterRail';
import { ActivityCard } from '@/app/preview/_components/ActivityCard';
import { formatSlotSummary } from '@/app/preview/_data/format';
import { mapSearchItemToActivity } from '@/app/preview/_data/search-api';
import {
  CLEARED_FILTERS,
  DEFAULT_STATE,
  apiQuery,
  hasActiveFilters,
  hasClearableFilters,
  hrefFor,
  parseSearchState,
  type SearchState,
} from '@/app/search/_lib/params';
import type { Activity } from '@/app/preview/_data/types';

const st = (overrides: Partial<SearchState> = {}): SearchState => ({ ...DEFAULT_STATE, ...overrides });

describe('URL contract — the default is drop-in only', () => {
  it('defaults to off, so a bare /search means "no registration courses"', () => {
    expect(DEFAULT_STATE.includeRegistration).toBe(false);
    expect(parseSearchState({}).includeRegistration).toBe(false);
  });

  it('only an explicit opt-in turns it on', () => {
    expect(parseSearchState({ reg: '1' }).includeRegistration).toBe(true);
    expect(parseSearchState({ reg: 'true' }).includeRegistration).toBe(true);
    // Anything else — absent, empty, garbage, an explicit off — stays off.
    expect(parseSearchState({ reg: '0' }).includeRegistration).toBe(false);
    expect(parseSearchState({ reg: '' }).includeRegistration).toBe(false);
    expect(parseSearchState({ reg: 'maybe' }).includeRegistration).toBe(false);
  });

  it('writes `reg` to the page URL only when it is on', () => {
    expect(hrefFor(st())).not.toContain('reg=');
    expect(hrefFor(st({ includeRegistration: true }))).toContain('reg=1');
  });

  it('always states the choice explicitly to the API, so the route never has to guess', () => {
    expect(apiQuery(st())).toContain('includeRegistration=0');
    expect(apiQuery(st({ includeRegistration: true }))).toContain('includeRegistration=1');
  });

  it('never composes the choice into the free-text query', () => {
    // It is an inclusion policy, not something a parent types — so a query mentioning a course
    // must not be able to switch it on.
    expect(apiQuery(st({ q: 'registration course camp' })).includes('includeRegistration=0')).toBe(true);
  });

  it('is reset by "Clear filters" rather than quietly surviving it', () => {
    expect(CLEARED_FILTERS.includeRegistration).toBe(false);
    const cleared = { ...st({ includeRegistration: true }), ...CLEARED_FILTERS };
    expect(cleared.includeRegistration).toBe(false);
  });

  it('offers "Clear filters" when it is the only thing switched on', () => {
    const state = st({ includeRegistration: true });
    // Not a narrowing filter, so it must not make the engine broaden less…
    expect(hasActiveFilters(state)).toBe(false);
    // …but it IS something the parent can undo, so the affordance appears.
    expect(hasClearableFilters(state)).toBe(true);
  });
});

describe('the filter control says what it does', () => {
  const render = (state: SearchState) => renderToStaticMarkup(<FilterRail state={state} savedLocation={null} />);
  const chipTag = (html: string, label: string) => {
    const at = html.indexOf(`>${label}<`);
    if (at === -1) throw new Error(`chip "${label}" not found`);
    return html.slice(html.lastIndexOf('<a', at), at);
  };
  const isActive = (html: string, label: string) => chipTag(html, label).includes('aria-current="true"');

  it('shows the exclusion on the page instead of leaving it invisible', () => {
    const html = render(DEFAULT_STATE);
    expect(html).toContain('>Courses<');
    expect(html).toContain('>Drop-in only<');
    expect(html).toContain('>Include registration courses<');
  });

  it('checkmarks "Drop-in only" by default and follows the state', () => {
    const off = render(DEFAULT_STATE);
    expect(isActive(off, 'Drop-in only')).toBe(true);
    expect(isActive(off, 'Include registration courses')).toBe(false);

    const on = render(st({ includeRegistration: true }));
    expect(isActive(on, 'Include registration courses')).toBe(true);
    expect(isActive(on, 'Drop-in only')).toBe(false);
  });
});

// ── Card rendering ────────────────────────────────────────────────────────────────

const listingDto = {
  id: 'l1',
  activityName: 'Intro to Hockey (8-12yrs)',
  primaryCategoryKey: 'open_gym',
  categoryTags: [],
  venueName: 'Harry Jerome',
  organisation: 'nvrc.ca',
  descriptionSnippet: '',
  suitabilityTags: [],
  startDatetimeUtc: '2026-08-08T22:15:00Z',
  endDatetimeUtc: '2026-08-08T23:00:00Z',
  costStatus: 'free' as const,
  costMinCad: null,
  costMaxCad: null,
  statusState: 'confirmed',
  confidenceLabel: 'official',
  lastCheckedAtUtc: '2026-08-08T12:00:00Z',
  ageMinMonths: 96,
  ageMaxMonths: 144,
  geo: null,
  displayArea: 'North Vancouver',
  neighbourhood: null,
  municipalityId: null,
  sourceUrl: 'https://nvrc.ca/x',
  bookingUrl: null,
  locationUrl: null,
};

describe('a registration card says so', () => {
  it('labels a course "Registration required" on the card face', () => {
    const activity = mapSearchItemToActivity({ listing: listingDto, distanceKm: 1, registrationRequired: true });
    const html = renderToStaticMarkup(<ActivityCard activity={activity} />);
    expect(html).toContain('Registration required');
  });

  it('repeats the label in the accessible name, so it is not a visual-only signal', () => {
    const activity = mapSearchItemToActivity({ listing: listingDto, distanceKm: 1, registrationRequired: true });
    const html = renderToStaticMarkup(<ActivityCard activity={activity} />);
    const ariaLabel = /aria-label="([^"]*)"/.exec(html)?.[1] ?? '';
    expect(ariaLabel).toContain('Registration required');
  });

  it('leaves an ordinary drop-in card untouched', () => {
    const activity = mapSearchItemToActivity({
      listing: { ...listingDto, activityName: 'Public Swim Delbrook', suitabilityTags: ['drop_in'] },
      distanceKm: 1,
    });
    const html = renderToStaticMarkup(<ActivityCard activity={activity} />);
    expect(html).not.toContain('Registration required');
    expect(html).toContain('Drop-in');
  });

  it('classifies locally when the caller sends no verdict (detail/fixture paths)', () => {
    // The detail loader builds an Activity without going through search; a course must still be
    // labelled as one there.
    const activity = mapSearchItemToActivity({ listing: listingDto, distanceKm: 1 });
    expect(activity.registrationRequired).toBe(true);
  });
});

describe('a collapsed card is honest about how many slots it stands for', () => {
  // Every slot carries its OWN cost now (lib/search/collapse.ts), and these three agree with the
  // representative — three slots of one series at one price. Written as a spread of the listing's
  // own cost rather than repeated literals so this fixture cannot drift into DISAGREEING and start
  // exercising the group-cost path in tests that are about slot COUNTS and spans.
  const slotCost = {
    costStatus: listingDto.costStatus,
    costMinCad: listingDto.costMinCad,
    costMaxCad: listingDto.costMaxCad,
  };
  const slots = [
    { id: 'l1', startDatetimeUtc: '2026-08-08T22:15:00Z', endDatetimeUtc: '2026-08-08T22:30:00Z', ...slotCost },
    { id: 'l2', startDatetimeUtc: '2026-08-08T22:30:00Z', endDatetimeUtc: '2026-08-08T22:45:00Z', ...slotCost },
    { id: 'l3', startDatetimeUtc: '2026-08-09T02:15:00Z', endDatetimeUtc: '2026-08-09T02:30:00Z', ...slotCost },
  ];

  it('carries the slot count and the closing edge of the span onto the Activity', () => {
    const activity = mapSearchItemToActivity({
      listing: listingDto,
      distanceKm: 1,
      slots,
      slotSpanEndUtc: '2026-08-09T02:30:00Z',
    });
    expect(activity.slotCount).toBe(3);
    expect(activity.slotEndIso).toBe('2026-08-09T02:30:00Z');
  });

  it('renders "N slots, <start>–<end>" spanning first start to last end', () => {
    const activity = mapSearchItemToActivity({
      listing: listingDto,
      distanceKm: 1,
      slots,
      slotSpanEndUtc: '2026-08-09T02:30:00Z',
    });
    // 22:15Z → 3:15 PM and 02:30Z (next day UTC) → 7:30 PM, both America/Vancouver.
    expect(formatSlotSummary(activity)).toBe('3 slots, 3:15 PM–7:30 PM');
    expect(renderToStaticMarkup(<ActivityCard activity={activity} />)).toContain('3 slots');
  });

  it('leaves a single-slot card reading as one time, not "1 slot"', () => {
    const activity = mapSearchItemToActivity({ listing: listingDto, distanceKm: 1, slots: [slots[0]] });
    expect(activity.slotCount).toBeUndefined();
    expect(formatSlotSummary(activity)).toBeNull();
    expect(renderToStaticMarkup(<ActivityCard activity={activity} />)).not.toContain('slots');
  });

  it('treats a missing slot list as a single slot', () => {
    const activity: Activity = mapSearchItemToActivity({ listing: listingDto, distanceKm: 1 });
    expect(formatSlotSummary(activity)).toBeNull();
  });
});
