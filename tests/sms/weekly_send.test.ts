// tests/sms/weekly_send.test.ts — building one subscriber's Friday text (pure, fixture engine).
//
// Same idiom as the digest and three-things suites: a small catalogue whose every relevant
// property is visible in this file, the REAL SearchEngine over it, and assertions on the message
// that comes out. No DB, no network, no Twilio, no ambient clock.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SearchEngine } from '@/lib/search/engine';
import { InMemoryListingRepository } from '@/lib/search/repository';
import { FixtureAliasResolver } from '@/lib/search/expand';
import { RegionHierarchy } from '@/lib/geo/region';
import { fsaGeocoder } from '@/lib/geo/postal-fsa';
import { REGIONS } from '@/lib/search/__fixtures__/regions';
import { ALIAS_SEED } from '@/lib/search/__fixtures__/aliases';
import { makeListing } from '@/lib/search/__fixtures__/factory';
import type { AgeBandKey, ListingRecord } from '@/lib/search/types';
import {
  assertGsm7Safe,
  estimateSegments,
  isGsm7,
  renderEmptyWeekMessage,
  renderPauseNoticeMessage,
} from '@/lib/sms/message';
import {
  buildWeeklySms,
  pauseNoticeFor,
  picksSnapshot,
  weekOutcomeFor,
  type SmsSubscriber,
} from '@/lib/sms/weekly-send';

/** Friday 2026-08-28, 16:00 PDT — the PRD's send moment. Weekend = Sat 29th + Sun 30th. */
const FRIDAY_4PM = new Date('2026-08-28T23:00:00Z');
const SAT = '2026-08-29';
const SUN = '2026-08-30';

/** The Vancouver municipality centroid fsaGeocoder resolves V5L to. */
const VAN = { lat: 49.2827, lng: -123.1207 };

const NAMES = [
  'Splash Time', 'Story Circle', 'Lego Build', 'Puppet Show', 'Nature Walk', 'Music Makers',
  'Gym Romp', 'Art Studio', 'Chess Club', 'Dance Party',
];

function at(isoDate: string, localHour: number): string {
  return `${isoDate}T${String(localHour + 7).padStart(2, '0')}:00:00Z`;
}

/** N distinct, showable, weekend-dated activities near the Vancouver centroid. */
function catalogue(n: number, over: Partial<ListingRecord> = {}): ListingRecord[] {
  return Array.from({ length: n }, (_, i) =>
    makeListing({
      id: `occ-${i}`,
      activityName: NAMES[i % NAMES.length],
      venueName: `${NAMES[i % NAMES.length]} Centre`,
      statusState: 'confirmed',
      ageMinMonths: 24,
      ageMaxMonths: 120,
      ageBandMatches: ['2-4', '5-9'] as AgeBandKey[],
      geo: { lat: VAN.lat + i * 0.002, lng: VAN.lng },
      startDatetimeUtc: at(i % 2 === 0 ? SAT : SUN, 9 + (i % 6)),
      endDatetimeUtc: at(i % 2 === 0 ? SAT : SUN, 10 + (i % 6)),
      primaryCategoryKey: 'general',
      ...over,
    })
  );
}

function engineOver(listings: ListingRecord[]): SearchEngine {
  return new SearchEngine({
    repository: new InMemoryListingRepository(listings),
    aliasResolver: new FixtureAliasResolver(ALIAS_SEED),
    regionHierarchy: new RegionHierarchy(REGIONS),
    geocoder: fsaGeocoder,
  });
}

function shortRefsFor(listings: ListingRecord[], omit: string[] = []): Map<string, number> {
  const map = new Map<string, number>();
  listings.forEach((l, i) => {
    if (!omit.includes(l.id)) map.set(l.id, 1000 + i);
  });
  return map;
}

function subscriber(over: Partial<SmsSubscriber> = {}): SmsSubscriber {
  return {
    id: 'sub-1',
    shortRef: 42,
    postalCode: 'V5L 1A1', // East Vancouver
    birthYears: [2021, 2018], // 5 and 8 in 2026
    consecutiveEmptyWeeks: 0,
    preferencesToken: '8fJ2q',
    consentTextVersion: '2026-08-26.v1',
    radiusKm: 10,
    ...over,
  };
}

function withConfig() {
  vi.stubEnv('SMS_SHORT_LINK_SECRET', 'test-short-link-secret');
  vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://kidsfun.example');
}

function build(listings: ListingRecord[], over: Partial<SmsSubscriber> = {}, omitRefs: string[] = []) {
  return buildWeeklySms({
    engine: engineOver(listings),
    now: FRIDAY_4PM,
    subscriber: subscriber(over),
    occurrenceShortRefs: shortRefsFor(listings, omitRefs),
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─────────────────────────────────────────────────────────────────────────────

describe('a normal week (>= 3 picks)', () => {
  it('renders the PRD §2.6 shape with the right link counts', () => {
    withConfig();
    const listings = catalogue(6);
    const plan = build(listings);

    expect(plan.outcome).toBe('picks');
    expect(plan.picks?.picks).toHaveLength(6);
    // Top 3 get their own line and their own link; the other 3 fold into "+3 more".
    expect(plan.directOccurrenceIds).toHaveLength(3);
    expect(plan.hubPickCount).toBe(3);

    const body = plan.message?.body ?? '';
    const lines = body.split('\n');
    expect(lines).toHaveLength(6); // opener + 3 picks + "+N more" + STOP

    expect(lines[0]).toBe('KIDS FUN: 6 picks this weekend for ages 5-9 near Vancouver.');
    expect(lines[4]).toBe('+3 more & settings: https://kidsfun.example/u/8fJ2q');
    expect(lines[5]).toBe('Reply STOP to end');

    // Every pick line: a weekday prefix, the name, the venue in brackets, and a short link.
    for (const line of lines.slice(1, 4)) {
      expect(line).toMatch(/^(Sat|Sun): .+ \(.+\) https:\/\/kidsfun\.example\/s\/[0-9A-Za-z]{13}$/);
    }
  });

  it('mints a DIFFERENT link for the same activity for a different subscriber', () => {
    // This is what makes a click attributable to a person rather than to an activity in
    // aggregate — the whole reason the token spends 24 of its 76 bits on a subscriber ref.
    withConfig();
    const listings = catalogue(4);
    const a = build(listings, { shortRef: 42 });
    const b = build(listings, { shortRef: 43 });
    const linkOf = (body: string) => body.split('\n')[1].split(' ').pop();
    expect(linkOf(a.message!.body)).not.toBe(linkOf(b.message!.body));
  });

  it('says "Settings:" rather than "+0 more" when every pick got a direct link', () => {
    // The preferences link must be in EVERY message — it is the unsubscribe path and the
    // access/correction mechanism at once, not a footer that can be dropped when N is 0.
    withConfig();
    const plan = build(catalogue(3));
    const lines = plan.message!.body.split('\n');
    expect(plan.hubPickCount).toBe(0);
    expect(lines[4]).toBe('Settings: https://kidsfun.example/u/8fJ2q');
    expect(plan.message!.body).toContain('/u/8fJ2q');
  });

  it('builds picks_snapshot as occurrence ids + rank, weekly sends only', () => {
    withConfig();
    const plan = build(catalogue(5));
    const snapshot = picksSnapshot(plan);
    expect(snapshot).toHaveLength(5);
    expect(snapshot![0]).toEqual({ occurrence_id: expect.any(String), rank: 1 });
    expect(snapshot!.map((s) => s.rank)).toEqual([1, 2, 3, 4, 5]);
  });

  it('names the ages it searched for, and says so honestly when it knows none', () => {
    withConfig();
    expect(build(catalogue(4), { birthYears: [2024, 2018] }).message!.body).toContain(
      'for ages 2-4 & 5-9'
    );
    // No readable birth year → no age filter was applied, so the opener must not claim one.
    const ageless = build(catalogue(4), { birthYears: [] });
    expect(ageless.ageBands).toEqual([]);
    expect(ageless.message!.body).not.toContain('for ages');
    expect(ageless.message!.body).toContain('picks this weekend near Vancouver');
  });
});

describe('a pick whose occurrence has no short_ref', () => {
  it('loses its direct link and folds into "+N more" — it is NOT dropped from the week', () => {
    // A stale deps map (a row ingested after the map was loaded) must degrade gracefully.
    // Dropping the pick would silently shrink a week for a reason unrelated to the catalogue.
    withConfig();
    const listings = catalogue(6);
    const plan = build(listings, {}, ['occ-0', 'occ-1']);

    expect(plan.outcome).toBe('picks');
    expect(plan.picks?.picks).toHaveLength(6); // still six picks
    expect(plan.directOccurrenceIds).toHaveLength(3); // still three direct links
    expect(plan.directOccurrenceIds).not.toContain('occ-0');
    expect(plan.unlinkableOccurrenceIds).toEqual(expect.arrayContaining(['occ-0', 'occ-1']));
    expect(plan.hubPickCount).toBe(3);
  });
});

describe('an empty week', () => {
  it('renders the honest "nothing new this week" text, not a padded list', () => {
    withConfig();
    const plan = build([]); // nothing in the catalogue at all
    expect(plan.outcome).toBe('empty');
    expect(plan.picks?.outcome).toBe('empty');
    expect(plan.message!.body).toContain('Nothing new matches your area this week');
    expect(plan.message!.body).toContain('https://kidsfun.example/u/8fJ2q');
    expect(plan.message!.body).toContain('Reply STOP to end');
    expect(picksSnapshot(plan)).toBeNull(); // migration 0035 CHECK: weekly sends only
  });

  it('maps to the counter vocabulary as a real, searched-for empty', () => {
    withConfig();
    expect(weekOutcomeFor(build([]))).toBe('empty');
  });
});

describe('a postal code that does not geocode', () => {
  it('is its OWN outcome — no message, no picks, not an empty week', () => {
    // THE DISTINCTION THIS EXISTS FOR. Folding it into "below floor with 0 matches" would text a
    // parent "nothing matches your area this week" about a search that never ran, and would
    // eventually pause them for a defect on our side.
    withConfig();
    const plan = build(catalogue(6), { postalCode: 'V3S 1A1' }); // Surrey — outside coverage
    expect(plan.outcome).toBe('geocode_failed');
    expect(plan.message).toBeNull();
    expect(plan.picks).toBeNull();
    expect(plan.areaLabel).toBeNull();
    expect(picksSnapshot(plan)).toBeNull();
  });

  it('maps to not_attempted, so the counter does not move', () => {
    withConfig();
    expect(weekOutcomeFor(build(catalogue(6), { postalCode: 'V3S 1A1' }))).toBe('not_attempted');
  });

  it('still reports the ages it could compute — the failure is geographic, not demographic', () => {
    withConfig();
    expect(build([], { postalCode: 'V3S 1A1', birthYears: [2021] }).ageBands).toEqual(['5-9']);
  });
});

describe('configuration failures fail LOUDLY', () => {
  it('throws rather than minting a link nobody can verify', () => {
    // Same discipline as lib/email/weekly.ts, where unsubscribeUrl throws for the same reason and
    // the orchestrator's try/catch turns it into a structured error. An unconfigured environment
    // must not send a text carrying an uncheckable link.
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://kidsfun.example');
    expect(() => build(catalogue(4))).toThrow(/SMS_SHORT_LINK_SECRET/);
  });

  it('does NOT throw for an empty week — there is no link to mint', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://kidsfun.example');
    expect(() => build([])).not.toThrow();
  });
});

describe('the pause notice', () => {
  it('is built from the subscriber alone and points at the same hub link', () => {
    withConfig();
    const message = pauseNoticeFor(subscriber());
    expect(message.body).toContain("we've paused your texts");
    expect(message.body).toContain('https://kidsfun.example/u/8fJ2q');
    expect(message.body).toContain('Reply STOP to end');
    expect(message.body).toBe(renderPauseNoticeMessage('https://kidsfun.example/u/8fJ2q').body);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The encoding finding. This is a cost control, not a style preference.
// ─────────────────────────────────────────────────────────────────────────────

describe('SMS encoding and segment cost', () => {
  it('detects the punctuation that silently more than halves a segment', () => {
    expect(isGsm7('KIDS FUN: 6 picks this weekend.')).toBe(true);
    for (const bad of ['—', '–', '’', '“', '”', '…']) {
      expect(isGsm7(`hello ${bad} world`)).toBe(false);
    }
  });

  it('counts GSM-7 at 160/153 and UCS-2 at 70/67', () => {
    expect(estimateSegments('a'.repeat(160))).toEqual({
      encoding: 'GSM-7',
      characters: 160,
      segments: 1,
    });
    expect(estimateSegments('a'.repeat(161)).segments).toBe(2);
    expect(estimateSegments('a'.repeat(70) + '—').segments).toBe(2); // 71 chars, UCS-2
  });

  it('MEASURES the cost of the PRD §2.6 copy rendered verbatim vs GSM-7-safe', () => {
    // PRD §2.6's empty-week example, character for character (em dash + curly apostrophe).
    const url = 'https://kidsfun.example/u/8fJ2q';
    const verbatim =
      `KIDS FUN: Nothing new matches your area this week — check back Friday, or update what ` +
      `you’re into: ${url}\nReply STOP to end`;
    const ours = renderEmptyWeekMessage(url).body;

    const a = estimateSegments(verbatim);
    const b = estimateSegments(ours);

    expect(a.encoding).toBe('UCS-2');
    expect(b.encoding).toBe('GSM-7');
    // Same words, same length to within a character or two — and a materially different bill.
    expect(Math.abs(a.characters - b.characters)).toBeLessThanOrEqual(2);
    expect(b.segments).toBeLessThan(a.segments);
  });

  it('every template this product sends is GSM-7 safe', () => {
    // The wall. If a future copy edit reintroduces a nicer dash, this is where it stops.
    withConfig();
    const url = 'https://kidsfun.example/u/8fJ2q';
    assertGsm7Safe(renderEmptyWeekMessage(url).body);
    assertGsm7Safe(renderPauseNoticeMessage(url).body);
    assertGsm7Safe(build(catalogue(6)).message!.body);
  });

  it('reports the segment count on every rendered message', () => {
    withConfig();
    const plan = build(catalogue(6));
    expect(plan.message!.encoding).toBe('GSM-7');
    expect(plan.message!.segments).toBeGreaterThanOrEqual(1);
    expect(plan.message!.characters).toBe(plan.message!.body.length);
  });
});
