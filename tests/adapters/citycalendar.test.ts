import { afterEach, describe, it, expect, vi } from 'vitest';
import { CityCalendarAdapter, getCityCalendar } from '../../worker/adapters/citycalendar';
import { computeAgeBandMatches, parseAgeText } from '../../worker/core/age';

/** The seeded age_band rows (supabase/seeds), so a band assertion reads as bands not ids. */
const BANDS = [
  { id: 'under2', key: 'under2', lowerMonthsInclusive: 0, upperMonthsExclusive: 24 },
  { id: '2-4', key: '2-4', lowerMonthsInclusive: 24, upperMonthsExclusive: 60 },
  { id: '5-9', key: '5-9', lowerMonthsInclusive: 60, upperMonthsExclusive: 120 },
  { id: '10-14', key: '10-14', lowerMonthsInclusive: 120, upperMonthsExclusive: 180 },
  { id: '15+', key: '15+', lowerMonthsInclusive: 180, upperMonthsExclusive: null },
];

/** Minimal well-formed Trumba event; `audiences` omitted = no structured field. */
function trumba(id: number, title: string, description: string, audiences?: string) {
  return {
    eventID: id,
    title,
    description,
    location: '<a href="http://maps.google.com/?q=453+W+12th+Ave%2C+Vancouver%2C+BC">City Hall</a>',
    startDateTime: '2026-08-31T10:00:00',
    startTimeZoneOffset: '-0700',
    canceled: false,
    requiresPayment: false,
    customFields: audiences ? [{ label: 'Audiences', value: audiences }] : [],
  };
}

// KIDS FUN Task 9 — City of Vancouver events calendar (Trumba public JSON feed).
// The city_calendar adapter consumes a municipality's public calendar-syndication
// feed (plain GET, no login / CSRF / CAPTCHA / headless render), attaching
// deterministic venue geo for recurring recreation venues — no geocoder at ingest.

const TRUMBA_FIXTURE = [
  {
    eventID: 204262940,
    seriesID: null,
    title: 'Free Synchronized Swimming Try-it Class for Kids',
    description: 'A free drop-in class for kids ages 6-12 at the pool.',
    location:
      '<a href="http://maps.google.com/?q=Renfrew+Pool%2C+2929+East+22nd+Ave%2C+Vancouver%2C+BC%2C+Canada" target="_blank" rel="noopener">Renfrew Pool, 2929 East 22nd Ave, Vancouver, </a>',
    locationType: 'In-Person',
    startDateTime: '2026-07-18T15:00:00',
    endDateTime: '2026-07-18T16:00:00',
    startTimeZoneOffset: '-0700',
    endTimeZoneOffset: '-0700',
    allDay: false,
    canceled: false,
    requiresPayment: false,
    permaLinkUrl: 'https://www.trumba.com/calendars/city-of-vancouver-events/-/204262940',
    customFields: [{ fieldID: 41996, label: 'Event type', value: 'Sports / run / walk', type: 'text' }],
  },
  {
    eventID: 204574662,
    seriesID: 204574628,
    title: 'FIFA Fan Festival&#8482; Vancouver',
    description: 'A free, accessible Festival for all, from families to devoted football fans.',
    location: '<a href="http://maps.google.com/?q=Hastings+Park%2C+2901+E+Hastings+St%2C+Vancouver%2C+BC">Hastings Park</a>',
    locationType: 'In-Person',
    startDateTime: '2026-07-14T10:00:00',
    endDateTime: '2026-07-14T18:00:00',
    startTimeZoneOffset: '-0700',
    endTimeZoneOffset: '-0700',
    allDay: false,
    canceled: false,
    requiresPayment: false,
    permaLinkUrl: 'https://www.trumba.com/calendars/city-of-vancouver-events/-/204574662',
    customFields: [{ fieldID: 41996, label: 'Event type', value: 'Celebration / festival', type: 'text' }],
  },
  {
    eventID: 204769892,
    title: 'Music in the Park',
    description: 'Free outdoor concert for all ages in the park.',
    location: '<a href="http://maps.google.com/?q=Connaught+Park%2C+2690+Larch+Street%2C+Vancouver">Connaught Park - 2690 Larch Street</a>',
    locationType: 'In-Person',
    startDateTime: '2026-08-08T11:00:00',
    startTimeZoneOffset: '-0700',
    canceled: false,
    requiresPayment: false,
    customFields: [{ fieldID: 41996, label: 'Event type', value: 'Celebration / festival', type: 'text' }],
  },
  {
    eventID: 999999999,
    title: 'Cancelled Program',
    location: '<a href="http://maps.google.com/?q=Trout+Lake+Community+Centre">Trout Lake Community Centre</a>',
    startDateTime: '2026-07-20T10:00:00',
    startTimeZoneOffset: '-0700',
    canceled: true,
    requiresPayment: false,
  },
];

function stubFetchJson(payload: unknown) {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => payload,
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('CityCalendar adapter — City of Vancouver Trumba feed (Task 9)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.KIDS_FUN_LIVE_CITY_CALENDARS;
  });

  it('is live-enabled only when vancouver is in KIDS_FUN_LIVE_CITY_CALENDARS', () => {
    const config = getCityCalendar('vancouver')!;
    const adapter = new CityCalendarAdapter(config);
    expect(adapter.isLiveFetchEnabled()).toBe(false);
    process.env.KIDS_FUN_LIVE_CITY_CALENDARS = 'vancouver';
    expect(adapter.isLiveFetchEnabled()).toBe(true);
    expect(config.feedUrl).toContain('trumba.com/calendars/city-of-vancouver-events.json');
    expect(config.sourceFamily).toBe('city_calendar');
    expect(config.sourceName).toBe('City of Vancouver events calendar');
  });

  it('fetches the public JSON feed and parses UTC dates, deterministic venue geo, cost + dedup key', async () => {
    process.env.KIDS_FUN_LIVE_CITY_CALENDARS = 'vancouver';
    const fetchMock = stubFetchJson(TRUMBA_FIXTURE);

    const config = getCityCalendar('vancouver')!;
    const adapter = new CityCalendarAdapter(config);
    const records = await adapter.extract(await adapter.fetch());

    // The feed URL was hit (single GET), and the cancelled item was dropped.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calledUrl = String((fetchMock.mock.calls[0] as unknown[])[0]);
    expect(calledUrl).toContain('city-of-vancouver-events.json');
    expect(records).toHaveLength(3);

    // Venue label is split on " - " too, so it matches the deterministic geo map.
    const park = records[2];
    expect(park.venueName).toBe('Connaught Park');
    expect(park.venueLat).toBeCloseTo(49.2637, 3);

    const swim = records[0];
    expect(swim.sourceRecordId).toBe('204262940');
    // 10:00-07:00 style conversion: 15:00 local (-0700) => 22:00Z.
    expect(swim.startDatetimeUtc).toBe('2026-07-18T22:00:00.000Z');
    expect(swim.venueName).toBe('Renfrew Pool');
    // Deterministic geo attached from config (no geocoder).
    expect(swim.venueLat).toBeCloseTo(49.2506, 3);
    expect(swim.venueLng).toBeCloseTo(-123.0432, 3);
    expect(swim.venueMunicipalityName).toBe('Vancouver');
    expect(swim.costStatus).toBe('free');
    expect(swim.categoryHint).toBe('public_swim');
    // The fixture description reads "Free swim for kids … ages 6-12 at the pool". This
    // assertion USED to read `toContain('kids')` — i.e. it pinned the very clipping §8e
    // fixes, where AGE_HINT_RE's 30-char window opens on "kids" and closes before the
    // number. The stated range is now preferred, so the age wording is the range itself.
    expect(swim.ageText?.toLowerCase()).toContain('ages 6-12');
    expect(adapter.dedupKeys(swim).key).toBe('city_calendar::vancouver::204262940');

    const fifa = records[1];
    expect(fifa.title).toBe('FIFA Fan Festival™ Vancouver');
    expect(fifa.venueName).toBe('Hastings Park');
    expect(fifa.venueLat).toBeCloseTo(49.2819, 3);
    expect(fifa.categoryHint).toBe('festival_event');
    expect(fifa.sourceUrl).toContain('trumba.com/calendars/city-of-vancouver-events');
  });

  // KIDS FUN Round 13 / Task J — deepen the Trumba adapter on already-live data:
  // (1) venue names split on <br> so the street number never glues onto the name;
  // (2) structured "Audiences" custom field drives ageText; (3) structured
  // "Neighbourhoods" fills displayArea for unmapped venues; (4) deterministic geo
  // match tolerates punctuation/spacing variants.
  const TASKJ_FIXTURE = [
    {
      // <br> separates venue from address -> venue name must be just the first line.
      eventID: 300000001,
      title: 'Lunar New Year Family Craft',
      description: 'Drop-in craft.',
      location:
        '<a href="http://maps.google.com/?q=168+E+Pender+St%2C+Vancouver%2C+BC+V6A+1T3%2C+Canada" target="_blank">Chinatown Storytelling Centre<br />168 E Pender St, Vancouver</a>',
      locationType: 'In-Person',
      startDateTime: '2026-08-01T10:00:00',
      startTimeZoneOffset: '-0700',
      canceled: false,
      requiresPayment: false,
      permaLinkUrl: 'https://www.trumba.com/calendars/city-of-vancouver-events/-/300000001',
      customFields: [
        { label: 'Event type', value: 'Community' },
        { label: 'Neighbourhoods', value: 'Chinatown' },
        { label: 'Audiences', value: 'Families' },
      ],
    },
    {
      // Unmapped one-off venue + structured neighbourhood -> displayArea from feed.
      eventID: 300000002,
      title: 'Preschool Storytime',
      description: 'Come sing along.',
      location: '<a href="http://maps.google.com/?q=1755+Barclay+St%2C+Vancouver%2C+BC">King George Secondary School</a>',
      locationType: 'In-Person',
      startDateTime: '2026-08-02T10:00:00',
      startTimeZoneOffset: '-0700',
      canceled: false,
      requiresPayment: false,
      permaLinkUrl: 'https://www.trumba.com/calendars/city-of-vancouver-events/-/300000002',
      customFields: [
        { label: 'Neighbourhoods', value: 'West End' },
        { label: 'Audiences', value: 'Preschoolers' },
      ],
    },
    {
      // Mapped venue with a punctuation variant + a citywide neighbourhood:
      // geo still resolves (normalized match) and the curated displayArea wins.
      eventID: 300000003,
      title: 'Community Skate',
      description: 'Free skate.',
      location: '<a href="http://maps.google.com/?q=6260+Killarney+St%2C+Vancouver%2C+BC">Killarney Community Centre.</a>',
      locationType: 'In-Person',
      startDateTime: '2026-08-03T10:00:00',
      startTimeZoneOffset: '-0700',
      canceled: false,
      requiresPayment: false,
      permaLinkUrl: 'https://www.trumba.com/calendars/city-of-vancouver-events/-/300000003',
      customFields: [{ label: 'Neighbourhoods', value: 'All of Vancouver' }],
    },
  ];

  it('splits the venue name on <br>, uses structured Audiences/Neighbourhoods, and matches geo tolerantly (Task J)', async () => {
    process.env.KIDS_FUN_LIVE_CITY_CALENDARS = 'vancouver';
    stubFetchJson(TASKJ_FIXTURE);
    const adapter = new CityCalendarAdapter(getCityCalendar('vancouver')!);
    const records = await adapter.extract(await adapter.fetch());
    expect(records).toHaveLength(3);

    // (1) <br> no longer glues the street number onto the venue name.
    const chinatown = records[0];
    expect(chinatown.venueName).toBe('Chinatown Storytelling Centre');
    expect(chinatown.venueAddress).toContain('168 E Pender St');
    // (2) Audiences -> ageText (structured, not a noisy prose window).
    expect(chinatown.ageText).toBe('Families');
    // (3) Neighbourhoods -> displayArea for this unmapped venue.
    expect(chinatown.venueDisplayArea).toBe('Chinatown');

    const school = records[1];
    expect(school.venueName).toBe('King George Secondary School');
    expect(school.ageText).toBe('Preschoolers');
    expect(school.venueDisplayArea).toBe('West End'); // unmapped -> from feed neighbourhood
    expect(school.venueLat).toBeUndefined(); // not in the deterministic geo map

    // (4) Punctuation variant "Killarney Community Centre." still hits the geo map;
    // the curated display area wins over the citywide neighbourhood value.
    const skate = records[2];
    expect(skate.venueLat).toBeCloseTo(49.2214, 3);
    expect(skate.venueLng).toBeCloseTo(-123.0398, 3);
    expect(skate.venueDisplayArea).toBe('Killarney'); // curated, not "All of Vancouver"
  });

  // ── adult subject + catch-all "Audiences" tag → no age claim at all ─────────────────
  //
  // The fixture below is the VERBATIM live Trumba payload for eventID 150181808, captured
  // from https://www.trumba.com/calendars/city-of-vancouver-events.json on 2026-08-18 —
  // the event behind listing 97670289-a949-4ebb-8f47-d33adf92d404, which the safety
  // auditor's adult_subject_child_bands rule reported with ageBandMatches =
  // [under2, 2-4, 5-9, 10-14, 15+]. Root cause is the STRUCTURED field, not the prose
  // fallback: `Audiences` literally reads "All ages", and AGE_HINT_RE matches nothing in
  // this title+description (pinned below), so the fallback never ran.
  const OVERDOSE_FIXTURE = [
    {
      eventID: 150181808,
      seriesID: 150181802,
      title: 'International Overdose Awareness',
      description: 'City Hall&#39;s flag will be at half-mast in honour of&#160;International Overdose Awareness.',
      location:
        '<a href="http://maps.google.com/?q=453+W+12th+Ave%2C+Vancouver%2C+BC+V5Y+1V4%2C+Canada" target="_blank" rel="noopener">City Hall<br />Vancouver City Hall<br />453 W 12th Ave, Vancouver, BC V5Y 1V4, Canada</a>',
      startDateTime: '2026-08-31T01:00:00',
      endDateTime: '2026-09-01T01:00:00',
      startTimeZoneOffset: '-0700',
      endTimeZoneOffset: '-0700',
      allDay: true,
      canceled: false,
      requiresPayment: false,
      permaLinkUrl:
        'https://vancouver.ca/news-calendar/calendar-of-events.aspx?trumbaEmbed=view%3Devent%26eventid%3D150181808',
      customFields: [
        { fieldID: 41996, label: 'Event type', value: 'Community' },
        { fieldID: 43884, label: 'Campaign, project, or topic', value: 'Flag observance' },
        { fieldID: 45689, label: 'Neighbourhoods', value: 'All of Vancouver' },
        { fieldID: 42593, label: 'Audiences', value: 'All ages' },
        { fieldID: 42594, label: 'Languages', value: 'English' },
        { fieldID: 42002, label: 'Organizer type', value: 'City of Vancouver' },
        { fieldID: 42595, label: 'Organizer name', value: 'External Protocol' },
      ],
    },
  ];

  it('withholds a catch-all Audiences tag when the source subject is adult-only (real 150181808 payload)', async () => {
    process.env.KIDS_FUN_LIVE_CITY_CALENDARS = 'vancouver';
    stubFetchJson(OVERDOSE_FIXTURE);
    const adapter = new CityCalendarAdapter(getCityCalendar('vancouver')!);
    const [record] = await adapter.extract(await adapter.fetch());

    // The claim is withheld entirely — not replaced with a different age. Absent wording is
    // a neutral parse signal (worker/core/ingest.ts writes no occurrence_age row), so the
    // listing stays visible and simply stops asserting it is programming for a baby.
    expect(record.ageText).toBeUndefined();
    const parse = parseAgeText(record.ageText);
    expect(parse.resolved).toBe(false);
    expect(computeAgeBandMatches(parse, BANDS)).toEqual([]);

    // The rest of the record is untouched by the age decision.
    expect(record.title).toBe('International Overdose Awareness');
    expect(record.venueName).toBe('City Hall');
    expect(record.venueDisplayArea).toBeUndefined(); // "All of Vancouver" is not an area
  });

  it('pins the pre-fix band explosion, so the fixture proves the fix and not the fixture', () => {
    // What the shipped code produced for this exact row: 'All ages' → [0, ∞) → all five
    // bands, ageMinMonths 0. If this ever stops being the "before" picture, the test above
    // is passing for the wrong reason.
    const before = parseAgeText('All ages');
    expect(before).toMatchObject({ ageMinMonths: 0, ageMaxMonths: null, resolved: true, notes: 'all-ages' });
    expect(computeAgeBandMatches(before, BANDS)).toEqual(['under2', '2-4', '5-9', '10-14', '15+']);

    // And the prose fallback is NOT the culprit: it finds nothing in this event's own text.
    const hay = "International Overdose Awareness City Hall's flag will be at half-mast in honour of International Overdose Awareness.";
    expect(
      /(?:for\s+)?(?:kids|children|families|family|all\s+ages|youth|teens?|tweens?|toddlers?|babies|baby|preschool(?:ers?)?|seniors?|adults?)[^.<\n]{0,30}/i.exec(
        hay
      )
    ).toBeNull();
  });

  it('the prose fallback reads the singular "preschooler", and it resolves to 2-4', async () => {
    // AGE_HINT_RE's `preschool(?:ers?)?` is now spelled the same way worker/core/age.ts's
    // KEYWORD_BANDS is. This regex never actually lost the singular — it has no `\b`, so the
    // trailing `[^.<\n]{0,30}` absorbed the "er" — so what is pinned is the CHAIN: a wording
    // this fallback lifts must be a wording the age table can resolve. An event with no
    // Audiences field is the only way to reach the fallback at all.
    process.env.KIDS_FUN_LIVE_CITY_CALENDARS = 'vancouver';
    stubFetchJson([trumba(1, 'Drop-In Play', 'A weekly session for every preschooler and a grown-up.')]);
    const adapter = new CityCalendarAdapter(getCityCalendar('vancouver')!);
    const [record] = await adapter.extract(await adapter.fetch());

    expect(record.ageText).toBe('preschooler and a grown-up');
    expect(computeAgeBandMatches(parseAgeText(record.ageText), BANDS)).toEqual(['2-4']);
  });

  it('still resolves genuine audience claims, and never second-guesses a source that names a child', async () => {
    process.env.KIDS_FUN_LIVE_CITY_CALENDARS = 'vancouver';
    stubFetchJson([
      // (a) Ordinary catch-all tags with no adult subject — unchanged behaviour.
      trumba(1, 'Music in the Park', 'Free outdoor concert in the park.', 'All ages'),
      trumba(2, 'Lunar New Year Craft', 'Drop-in craft.', 'Families'),
      // (b) A SPECIFIC tag is never eligible for suppression, even beside an adult subject:
      //     the structured-field-over-prose preference is untouched.
      trumba(3, 'Youth Harm Reduction Workshop', 'Peer-led session.', 'Youth'),
      trumba(4, 'Overdose Awareness Info Session', 'For adults only.', 'Adults'),
      // (c) Guards: the source's own words say a child may come, so the catch-all stands.
      trumba(5, 'Kids Grief Support Circle', 'A bereavement group for children.', 'All ages'),
      trumba(6, 'Naloxone Training for Families', 'Learn to respond to an overdose.', 'All ages'),
      // (d) No Audiences field at all — the prose fallback still works as before.
      trumba(7, 'Family Swim', 'Drop-in swim for all ages at the pool.'),
      // (e) A WEAK audit marker ("support group") must NOT suppress at ingest: no
      //     adjudicator here, and those subjects do run as real family programmes.
      trumba(8, 'Community Support Group', 'Monthly meet-up.', 'All ages'),
      // (f) The suppression itself, via a different strong marker + no Audiences field is
      //     not required — this one has the tag, and the description carries the subject.
      trumba(9, 'Flag Lowering', 'Marking the anniversary of a death by suicide.', 'All ages'),
    ]);
    const adapter = new CityCalendarAdapter(getCityCalendar('vancouver')!);
    const byId = new Map((await adapter.extract(await adapter.fetch())).map((r) => [r.sourceRecordId, r]));

    expect(byId.get('1')?.ageText).toBe('All ages');
    expect(byId.get('2')?.ageText).toBe('Families');
    expect(byId.get('3')?.ageText).toBe('Youth');
    expect(byId.get('4')?.ageText).toBe('Adults');
    expect(byId.get('5')?.ageText).toBe('All ages');
    expect(byId.get('6')?.ageText).toBe('All ages');
    // The 30-char window still starts at the TITLE's "Family" and truncates mid-phrase,
    // exactly as it did before this change — the prose path is untouched.
    expect(byId.get('7')?.ageText).toBe('Family Swim Drop-in swim for all age');
    expect(byId.get('8')?.ageText).toBe('All ages');
    expect(byId.get('9')?.ageText).toBeUndefined();

    // The ones that still resolve resolve to the SAME bands as before the fix.
    expect(computeAgeBandMatches(parseAgeText(byId.get('1')!.ageText), BANDS)).toEqual([
      'under2',
      '2-4',
      '5-9',
      '10-14',
      '15+',
    ]);
    expect(computeAgeBandMatches(parseAgeText(byId.get('3')!.ageText), BANDS)).toEqual(['10-14', '15+']);
    expect(computeAgeBandMatches(parseAgeText(byId.get('7')!.ageText), BANDS)).toEqual([
      'under2',
      '2-4',
      '5-9',
      '10-14',
      '15+',
    ]);
  });

  it('does not make a live request when the calendar is not enabled (fixture-only)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const config = getCityCalendar('vancouver')!;
    const adapter = new CityCalendarAdapter(config);
    const records = await adapter.extract(await adapter.fetch());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(records).toHaveLength(1);
    expect(records[0].costStatus).toBe('free');
  });
});

// docs/age-pattern-extraction-scope.md §8e — inside the PROSE fallback, a stated numeric range
// beats AGE_HINT_RE's 30-character keyword window.
//
// THE ROW THIS EXISTS FOR, measured on the live 2026-08-18 Trumba feed, 1 defect in 32:
//   "Free Synchronized Swimming Try-it Class for Kids" — description "a FREE class for kids
//   ages 7-11 who can swim 1 lap unassisted". No structured Audiences field, so the window
//   opened on "for Kids" and closed 30 characters later — before the number — lifting
//   "for Kids Come try Artistic Swimming (S" and scoring it [60,144]: four years too wide at
//   the bottom, one too wide at the top, on a class that requires swimming a lap unassisted.
describe('CityCalendar age wording — a stated range beats the keyword window (§8e)', () => {
  const extract = (events: unknown[]) => new CityCalendarAdapter(getCityCalendar('vancouver')!).extract(events);

  it('lifts "ages 7-11", not the 30 characters that happened to follow "for kids"', () => {
    const [r] = extract([
      trumba(
        1,
        'Free Synchronized Swimming Try-it Class for Kids',
        'Come try Artistic Swimming (Synchronized Swimming)! This is a FREE class for kids ages 7-11 who can swim 1 lap unassisted in deep water.'
      ),
    ]);
    expect(r.ageText).toContain('ages 7-11');
    expect(computeAgeBandMatches(parseAgeText(r.ageText!), BANDS).sort()).toEqual(['10-14', '5-9']);
    // The measured before-state — 5-to-12 — pinned as the thing that must not come back.
    expect(parseAgeText(r.ageText!).ageMinMonths).not.toBe(60);
  });

  it('the STRUCTURED Audiences field still outranks both prose scans', () => {
    // The precedence this adapter already had right, re-asserted so §8e cannot erode it: a
    // curated city tag is a claim about who a programme is for; prose is a scan.
    const [r] = extract([trumba(2, 'Family Day', 'Drop in for ages 7-11 activities and more.', 'All ages')]);
    expect(r.ageText).toBe('All ages');
  });

  it('the adult-subject suppression is untouched — a numeric range is never a catch-all', () => {
    // A stated range is a specific claim, so isCatchAllAudience() is false for it and the
    // suppression branch simply does not apply. The catch-all case still suppresses.
    const [suppressed] = extract([
      trumba(3, 'International Overdose Awareness', "City Hall's flag will be at half-mast.", 'All ages'),
    ]);
    expect(suppressed.ageText).toBeUndefined();
  });

  it('a description with no stated range falls back to the keyword window exactly as before', () => {
    const [r] = extract([trumba(4, 'Music in the Park', 'Free outdoor concert for all ages in the park.')]);
    expect(r.ageText).toBe('for all ages in the park');
  });

  it('a date or a street number in the prose is not read as an age', () => {
    // The `ages`/`grades` word must sit IMMEDIATELY before the number — no bare-range branch
    // here, deliberately. A Trumba description is dense with dates, times and addresses.
    const [r] = extract([
      trumba(5, 'Pop-up Recycling Event', 'Drop off at 453 W 12th Ave, August 24-28, from 9:00-11:00 am.'),
    ]);
    expect(r.ageText).toBeUndefined();
  });
});
