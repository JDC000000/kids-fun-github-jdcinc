// tests/search/today-window-exhaustion.test.ts — the "Today is empty by 10pm" defect, pinned.
//
// THREE INDEPENDENT TESTERS reported that `/search?when=today` returns almost nothing — eight
// long-running "any day" items, with roughly sixty genuine same-day events apparently missing.
// All three ran at 22:35–23:10 America/Vancouver. The same query at 06:48 the next morning
// returned 220 correct results, none of which had a past end time.
//
// THE FIRST HYPOTHESIS WAS WRONG AND THIS FILE EXISTS PARTLY TO KEEP IT DEAD. `matchesDate`
// (lib/search/filters/time.ts) was blamed for excluding rows that lack `startDatetimeUtc`. It
// does not: the control case below runs the identical query, at the identical late clock,
// against the UNPRUNED catalogue and gets every event back. The predicate is innocent.
//
// THE ACTUAL MECHANISM is the read model's own visibility rule — `visibleOccurrenceWhereSql()`
// in lib/search/postgres-repository.ts, mirrored for testing in lib/search/occurrence-visibility.ts.
// It prunes the catalogue against `now()`, an INSTANT rather than a day boundary, so an
// occurrence that has ended leaves the catalogue entirely, before any filter runs. `when=today`
// therefore does not mean "what is on today"; it means "what is LEFT of today", and by 22:35 what
// is left is open-hours attractions and still-running multi-day programmes — exactly the eight
// "any day" items the testers saw.
//
// CONFIRMED LONGITUDINALLY AGAINST PRODUCTION, not merely inferred from the reports. The same
// query sampled twice, 24 minutes apart:
//
//                          13:48Z         14:12Z
//     results              220            200          drained by 20, nothing else changed
//     rows already ended   0 of 220       0 of 200     never one, in either sample
//     earliest end         14:15Z         14:15Z       held — because nothing ended in between
//     that floor vs now()  now + 26 min   now + 3 min  now() closing in on it
//
// The middle row is the prune caught in the act, twice, independently. The bottom two rows are
// why: the "floor" is nothing but the next occurrence due to end, so it sits still while nothing
// ends and jumps forward the moment something does. Both properties are pinned below against the
// fixture catalogue, at a spread of clocks.
//
// DO NOT READ A DECAY RATE INTO THAT TABLE, here or anywhere else. Twenty rows in 24 minutes is a
// local burst as a cluster of late-morning sessions ended; averaged across 06:48→22:35 local it is
// closer to a third of that. The rate tracks schedule density and nothing else. What is solid —
// and all this file asserts — is the MECHANISM and the ENDPOINT: roughly eight rows left by about
// 22:35 local, observed independently by three testers.
//
// That behaviour is arguably CORRECT (a parent at 10pm should not be offered a class that ended
// at 2pm) and is deliberately NOT changed here. What was broken is DISCLOSURE: the app collapsed
// to a near-empty list and said nothing, so three testers reasonably concluded it was broken. The
// second half of this file pins the disclosure — see lib/search/day-window.ts.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { SearchEngine } from '../../lib/search/engine';
import { InMemoryListingRepository } from '../../lib/search/repository';
import { RegionHierarchy } from '../../lib/geo/region';
import { REGIONS } from '../../lib/search/__fixtures__/regions';
import { makeListing } from '../../lib/search/__fixtures__/factory';
import { isOccurrenceVisibleAt, pruneEndedOccurrences } from '../../lib/search/occurrence-visibility';
import { describeRequestedDay } from '../../lib/search/day-window';
import { describeBroadening } from '../../app/search/_lib/broadening-notice';
import { describeDayRemainder } from '../../app/search/_lib/day-remainder-notice';
import { localIsoDate, localMinutesOfDay } from '../../lib/search/time/vancouver';
import type { ListingRecord } from '../../lib/search/types';

// ── The clocks ────────────────────────────────────────────────────────────────────────────────
// Monday 17 August 2026 in America/Vancouver (PDT, UTC−7). Both instants are on the SAME local
// day, which is the entire point: nothing about the parent's request changes between them.
const MORNING = new Date('2026-08-17T15:00:00Z'); // 08:00 local Monday
const LATE = new Date('2026-08-18T05:35:00Z'); //    22:35 local Monday — the testers' clock
const LOCAL_DAY = '2026-08-17';

/** local Monday wall time → the UTC instant, at UTC−7. */
const local = (hh: number, mm: number): string => {
  const utcHour = hh + 7;
  const day = utcHour >= 24 ? 18 : 17;
  const h = String(utcHour % 24).padStart(2, '0');
  return `2026-08-${day}T${h}:${String(mm).padStart(2, '0')}:00.000Z`;
};

const timed = (name: string, from: [number, number], to: [number, number]): ListingRecord =>
  makeListing({
    id: `timed-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    activityName: name,
    startDatetimeUtc: local(from[0], from[1]),
    endDatetimeUtc: local(to[0], to[1]),
    statusState: 'confirmed',
    costStatus: 'free',
  });

/** A normal Monday's spread of same-day timed events — morning through late evening. */
const SAME_DAY_EVENTS: ListingRecord[] = [
  timed('Family Storytime', [9, 30], [10, 0]),
  timed('Baby and Toddler Play Time', [10, 0], [11, 0]),
  timed('Public Swim Family', [10, 30], [11, 30]),
  timed('Open Gym Drop-in', [11, 0], [12, 0]),
  timed('Storytime in the Park', [13, 0], [14, 0]),
  timed('Free Play Palace', [14, 0], [15, 30]),
  timed('Public Skate', [15, 30], [16, 30]),
  timed('Family Skate', [16, 0], [17, 0]),
  timed('Public Swim Lane and Leisure', [17, 30], [18, 30]),
  timed('Open Gym Youth Night', [18, 0], [19, 30]),
  timed('Family Play Time', [19, 0], [20, 0]),
  timed('Drop-in Badminton', [20, 0], [21, 0]),
  // The one event still running at 22:35 — so the late-clock collapse is provably the PRUNE
  // rather than "the engine drops everything dated once it is late".
  timed('Late Public Swim', [21, 30], [23, 0]),
];

/** Dateless standing records: a pool and a nature house. Visible every day, indefinitely. */
const OPEN_HOURS: ListingRecord[] = [
  makeListing({
    id: 'open-pool',
    activityName: 'Community Pool Public Swim Hours',
    openHours: true,
    openHoursLabel: 'Daily 6am-9pm',
    statusState: 'confirmed',
  }),
  makeListing({
    id: 'open-nature-house',
    activityName: 'Nature House Drop-in Hours',
    openHours: true,
    openHoursLabel: 'Daily 10am-5pm',
    statusState: 'confirmed',
  }),
];

/** One multi-day programme published as a single occurrence (24 Jun → 1 Sep), mid-run today. */
const MULTI_DAY: ListingRecord = makeListing({
  id: 'summer-programme',
  activityName: 'Summer Reading Play Time',
  startDatetimeUtc: '2026-06-24T17:00:00.000Z',
  endDatetimeUtc: '2026-09-01T23:00:00.000Z',
  statusState: 'confirmed',
});

const CATALOGUE: ListingRecord[] = [...SAME_DAY_EVENTS, ...OPEN_HOURS, MULTI_DAY];

/** The "any day" rows — what a parent sees when the day's timed events have all gone. */
const ANY_DAY_IDS = [...OPEN_HOURS.map((l) => l.id), MULTI_DAY.id];

function searchToday(listings: readonly ListingRecord[], now: Date) {
  const engine = new SearchEngine({
    repository: new InMemoryListingRepository([...listings]),
    regionHierarchy: new RegionHierarchy(REGIONS),
    fixtureBacked: false,
  });
  // minResults: 0 declines the broadening ladder, so what comes back is the RAW filtered set —
  // no padding from adjacent days to obscure what the date filter actually matched.
  return engine.search({ q: '', when: 'today', now, minResults: 0, limit: 100 });
}

const idsOf = (r: { results: { listing: ListingRecord }[] }) => r.results.map((i) => i.listing.id).sort();

/** The same late-evening "Today", asked to fill a browse page — so the ladder actually climbs. */
function broadenedLateSearch() {
  const engine = new SearchEngine({
    repository: new InMemoryListingRepository(pruneEndedOccurrences(CATALOGUE, LATE)),
    regionHierarchy: new RegionHierarchy(REGIONS),
    fixtureBacked: false,
  });
  return engine.search({ q: '', when: 'today', now: LATE, minResults: 60, limit: 100 });
}

describe('the clocks these tests are pinned to', () => {
  it('are the same local Monday, eight in the morning and twenty-five to eleven at night', () => {
    expect(localIsoDate(MORNING)).toBe(LOCAL_DAY);
    expect(localIsoDate(LATE)).toBe(LOCAL_DAY);
    expect(localMinutesOfDay(MORNING)).toBe(8 * 60);
    expect(localMinutesOfDay(LATE)).toBe(22 * 60 + 35);
  });
});

describe('"Today" empties out as the local day advances (the reported defect)', () => {
  it('returns the whole day in the morning', () => {
    const morning = searchToday(pruneEndedOccurrences(CATALOGUE, MORNING), MORNING);
    expect(morning.total).toBe(CATALOGUE.length);
    expect(idsOf(morning)).toEqual([...CATALOGUE].map((l) => l.id).sort());
  });

  // THE REPRO. Same query, same local day, same catalogue — only the clock moves.
  it('collapses at 22:35 to the open-hours and multi-day rows the testers reported', () => {
    const late = searchToday(pruneEndedOccurrences(CATALOGUE, LATE), LATE);

    // Only the "any day" rows plus the one session still running survive.
    expect(idsOf(late)).toEqual([...ANY_DAY_IDS, 'timed-late-public-swim'].sort());
    // Twelve of the day's thirteen timed events are simply gone.
    expect(late.total).toBe(4);
    expect(SAME_DAY_EVENTS.length - 1).toBe(12);
  });

  // THE CONTROL, and the reason the original matchesDate hypothesis is dead. Identical late
  // clock, identical `when=today` request — but the catalogue is NOT pruned. Every event comes
  // back. So the date predicate matches finished events perfectly well; it is never asked.
  it('matches every one of those events at the same late clock when the catalogue is not pruned', () => {
    const unpruned = searchToday(CATALOGUE, LATE);
    expect(unpruned.total).toBe(CATALOGUE.length);
    expect(idsOf(unpruned)).toEqual([...CATALOGUE].map((l) => l.id).sort());
  });

  // ── The two properties production exhibited, 24 minutes apart ───────────────────────────────
  //
  // Sampling live can only ever show that these HELD at two instants. Expressed over a fixture
  // catalogue they can be checked at every instant that matters, which is what turns a pair of
  // observations into a regression guard.

  /** Every dated survivor's end time, as epoch ms. Open-hours rows have none and are excluded. */
  const survivingEndTimes = (now: Date): number[] =>
    pruneEndedOccurrences(CATALOGUE, now)
      .filter((l) => l.endDatetimeUtc != null)
      .map((l) => Date.parse(l.endDatetimeUtc!));

  /** A day's worth of sample clocks, local, spanning first start to after the last end. */
  const SAMPLE_CLOCKS: Array<[number, number]> = [
    [8, 0], [9, 45], [10, 30], [12, 0], [13, 15], [15, 0], [16, 45], [18, 0], [20, 30], [22, 35], [23, 30],
  ];

  // "0 of 220, then 0 of 200." The single most direct evidence there is: an occurrence that has
  // ended is not ranked low or filtered late, it is ABSENT — and absent at every hour, not just
  // at the two production happened to be sampled at.
  it('never retains an occurrence that has already ended, at any hour of the day', () => {
    for (const [hh, mm] of SAMPLE_CLOCKS) {
      const now = new Date(local(hh, mm));
      const alreadyEnded = survivingEndTimes(now).filter((end) => end < now.getTime());
      expect(alreadyEnded, `survivors with a past end time at ${hh}:${String(mm).padStart(2, '0')} local`).toEqual([]);
    }
  });

  // The floor is not a configured value — it is simply the next occurrence due to end, which is
  // why production saw it HOLD at 14:15Z for 24 minutes and why `now()` was visibly closing in on
  // it. It can only ever sit still or jump forward; it can never retreat.
  it('the earliest surviving end time is a floor that holds, then jumps — and never goes backwards', () => {
    const floorAt = (now: Date): number => Math.min(...survivingEndTimes(now));

    let previous = -Infinity;
    for (const [hh, mm] of SAMPLE_CLOCKS) {
      const now = new Date(local(hh, mm));
      const floor = floorAt(now);
      expect(floor, `floor is in the future at ${hh}:${String(mm).padStart(2, '0')} local`).toBeGreaterThanOrEqual(
        now.getTime(),
      );
      expect(floor, 'the floor may hold or jump forward, never retreat').toBeGreaterThanOrEqual(previous);
      previous = floor;
    }
  });

  it('holds the floor still while nothing ends, then jumps past whatever just ended', () => {
    const floorAt = (hh: number, mm: number) => Math.min(...survivingEndTimes(new Date(local(hh, mm))));
    // Nothing ends between 09:00 and 09:45, so the floor sits on the 10:00 storytime — the shape
    // production caught when 13:48Z and 14:12Z both reported an earliest end of 14:15Z.
    expect(floorAt(9, 0)).toBe(Date.parse(local(10, 0)));
    expect(floorAt(9, 45)).toBe(floorAt(9, 0));
    // …and once now() crosses it, that row is gone and the floor moves to the next end time.
    expect(floorAt(10, 1)).toBe(Date.parse(local(11, 0)));
  });

  it('drops each event exactly as it ends, not in a batch at some threshold', () => {
    const at = (hh: number, mm: number) =>
      pruneEndedOccurrences(CATALOGUE, new Date(local(hh, mm))).filter((l) => l.id.startsWith('timed-')).length;
    expect(at(9, 0)).toBe(13); // before anything has ended
    expect(at(12, 0)).toBe(10); // three morning sessions done
    expect(at(17, 0)).toBe(6);
    expect(at(21, 0)).toBe(2); // the 20:00-21:00 badminton ends exactly now, so it is still in
    expect(at(23, 0)).toBe(1); // …as is the 21:30 swim, at its own last minute
    expect(at(23, 1)).toBe(0); // and one minute later the local day holds nothing dated at all
  });
});

// The mirror is only trustworthy while it agrees with the SQL it mirrors. These are the four
// canonical row shapes tests/search/postgres-repository.test.ts drives through real Postgres in
// "excludes an expired dated occurrence even when it also carries an open-hours string".
//
// READ THIS BEFORE TRUSTING THAT SENTENCE. Those Postgres cases are gated behind
// `describe.skipIf(!hasDb)`, so in any run without DATABASE_URL — which is the default, and was
// how this file was developed — the SQL half of the comparison DOES NOT RUN. Only the TypeScript
// half below does. A green suite therefore shows the mirror is self-consistent, not that it still
// matches the query it claims to mirror. The `visibleOccurrenceWhereSql` drift guard further down
// exists precisely to close that gap without a database.
describe('the TypeScript visibility mirror agrees with visibleOccurrenceWhereSql', () => {
  const now = new Date('2026-08-17T20:00:00.000Z');
  const cases: Array<[string, ListingRecord, boolean]> = [
    [
      'an expired dated occurrence that also carries an hours string — the stale date wins',
      makeListing({
        startDatetimeUtc: '2026-08-09T17:00:00.000Z',
        endDatetimeUtc: '2026-08-10T17:00:00.000Z',
        openHours: true,
        openHoursLabel: 'Daily 10am-5pm',
      }),
      false,
    ],
    [
      'the same row without the hours string',
      makeListing({ startDatetimeUtc: '2026-08-09T17:00:00.000Z', endDatetimeUtc: '2026-08-10T17:00:00.000Z' }),
      false,
    ],
    [
      'a multi-week programme mid-run (started long ago, ends in the future)',
      makeListing({ startDatetimeUtc: '2026-07-08T17:00:00.000Z', endDatetimeUtc: '2026-09-03T17:00:00.000Z' }),
      true,
    ],
    [
      'a genuinely dateless standing record',
      makeListing({ startDatetimeUtc: null, endDatetimeUtc: null, openHours: true, openHoursLabel: 'Daily 10am-5pm' }),
      true,
    ],
  ];
  it.each(cases)('%s', (_label, listing, visible) => {
    expect(isOccurrenceVisibleAt(listing, now)).toBe(visible);
  });

  it('judges a dated row on its END, falling back to its start when it has none', () => {
    const startOnly = (start: string) => makeListing({ startDatetimeUtc: start, endDatetimeUtc: null });
    expect(isOccurrenceVisibleAt(startOnly('2026-08-17T19:59:00.000Z'), now)).toBe(false);
    expect(isOccurrenceVisibleAt(startOnly('2026-08-17T20:00:00.000Z'), now)).toBe(true);
  });

  it('drops a row with no date and no standing hours, exactly as COALESCE(NULL, NULL) does', () => {
    expect(isOccurrenceVisibleAt(makeListing({ startDatetimeUtc: null, openHours: false }), now)).toBe(false);
  });
});

// ── The disclosure the defect actually needed (lib/search/day-window.ts) ──────────────────────
describe('the engine reports how much of the requested day is still ahead', () => {
  it('says the day is over at 22:35, and still ahead at 08:00 — for the same request', () => {
    const late = searchToday(pruneEndedOccurrences(CATALOGUE, LATE), LATE);
    expect(late.dateWindow).toEqual({ isoDate: LOCAL_DAY, isToday: true, state: 'day_over' });

    const morning = searchToday(pruneEndedOccurrences(CATALOGUE, MORNING), MORNING);
    expect(morning.dateWindow).toEqual({ isoDate: LOCAL_DAY, isToday: true, state: 'day_ahead' });
  });

  it('reports the day the PARENT asked for, not the one the broadening ladder settled on', () => {
    // A thin late-evening search: the ladder will widen the date window to fill the page. The
    // reported window must still describe Monday, or the notice would explain a day nobody asked
    // about while the chip on screen still says "Today".
    const broadened = broadenedLateSearch();
    expect(broadened.broadening.applied.some((r) => r.key === 'adjacent_date')).toBe(true);
    expect(broadened.dateWindow).toEqual({ isoDate: LOCAL_DAY, isToday: true, state: 'day_over' });
  });

  it('walks day_ahead → day_closing → day_over across one local day', () => {
    const stateAt = (hh: number, mm: number) =>
      describeRequestedDay({ kind: 'today', isoDate: LOCAL_DAY, weekday: null }, new Date(local(hh, mm)))?.state;
    expect(stateAt(8, 0)).toBe('day_ahead');
    expect(stateAt(16, 59)).toBe('day_ahead');
    expect(stateAt(17, 0)).toBe('day_closing'); // the evening day-part opens
    expect(stateAt(21, 59)).toBe('day_closing');
    expect(stateAt(22, 0)).toBe('day_over'); // …and closes; nothing listed can still start
    expect(stateAt(23, 30)).toBe('day_over');
  });

  it('says nothing about a multi-day window — "that day is over" is not a fact about a range', () => {
    expect(
      describeRequestedDay({ kind: 'range', isoDate: LOCAL_DAY, endIsoDate: '2026-08-19', weekday: null }, LATE),
    ).toBeNull();
    expect(describeRequestedDay(null, LATE)).toBeNull();
  });

  it('distinguishes a future day (all ahead) from a past one (all over)', () => {
    const wanted = (iso: string) => describeRequestedDay({ kind: 'explicit', isoDate: iso, weekday: null }, LATE);
    expect(wanted('2026-08-18')).toEqual({ isoDate: '2026-08-18', isToday: false, state: 'day_ahead' });
    expect(wanted('2026-08-16')).toEqual({ isoDate: '2026-08-16', isToday: false, state: 'day_over' });
  });
});

// ── The two disclosure paths, and the gap between them ────────────────────────────────────────
//
// The broadening ladder only runs when the primary set is BELOW the caller's `minResults`. The
// tester's own page sends `minResults: 3` whenever a filter is active, so the reported case —
// eight surviving "any day" rows — cleared the bar and the ladder never ran: no widened window,
// no `kf-broadened` banner, no empty-state explanation. Nothing was suppressed; nothing was ever
// generated. That is the hole the day-remainder notice fills, and these two cases pin which
// mechanism covers which side of it.
describe('a thin late "Today" is disclosed on both sides of the broadening threshold', () => {
  it('when the ladder does NOT run, the day-remainder notice is the only thing that speaks', () => {
    const late = searchToday(pruneEndedOccurrences(CATALOGUE, LATE), LATE);
    // Four results clears a minResults of 3, so every ladder-driven disclosure stays silent…
    expect(late.total).toBeGreaterThanOrEqual(3);
    expect(searchToday(pruneEndedOccurrences(CATALOGUE, LATE), LATE).broadening.applied).toEqual([]);

    const withLadder = new SearchEngine({
      repository: new InMemoryListingRepository(pruneEndedOccurrences(CATALOGUE, LATE)),
      regionHierarchy: new RegionHierarchy(REGIONS),
      fixtureBacked: false,
    }).search({ q: '', when: 'today', now: LATE, minResults: 3, limit: 100 });
    expect(withLadder.broadening.applied).toEqual([]);
    expect(withLadder.broadening.emptyState).toBeNull();
    expect(describeBroadening(withLadder.broadening.applied)).toBeNull();

    // …and this is the state three testers were shown, with nothing on screen to explain it.
    expect(describeDayRemainder(withLadder.dateWindow, { resultCount: withLadder.total })).toMatchObject({
      lede: expect.stringMatching(/over/i),
      offerTomorrow: true,
    });
  });

  // The other side: when the ladder DOES widen the date window, the existing kf-broadened banner
  // already names the exact window it applied. Pinned rather than replaced — a second disclosure
  // mechanism for the same fact is how two surfaces start contradicting each other.
  it('when the ladder DOES widen the window, the existing banner names the widened window', () => {
    const broadened = broadenedLateSearch();
    const notice = describeBroadening(broadened.broadening.applied);
    expect(notice?.changes.some((c) => /^nearby dates \(/.test(c))).toBe(true);
    // The chip a parent still sees says "Today"; the banner must say which days are really below.
    expect(notice?.changes.join(' ')).toContain('Aug 1');
  });
});

// ── Drift guard: the SQL this file's mirror claims to mirror ──────────────────────────────────
//
// WHY A SOURCE-LEVEL TEST, AND WHY IT IS NOT A CONSOLATION PRIZE.
//
// `lib/search/occurrence-visibility.ts` is a hand-written TypeScript copy of a predicate that
// really lives in SQL. Everything this file proves about the "Today empties by 10pm" defect rests
// on the two agreeing. The only test that drives the REAL query is in
// tests/search/postgres-repository.test.ts, behind `describe.skipIf(!hasDb)` — one of 413 tests
// that silently vanish from a run with no DATABASE_URL. So the agreement was pinned exclusively
// by a test that does not run by default, which is the weakest possible place to put it.
//
// The predicate is a string a pure function returns. Its TEXT can be checked with no database at
// all, and a check that always runs is worth more here than one that usually skips. Same approach
// as this file's neighbour tests/search/empty-explain-placement.test.ts.
//
// AST, NOT A TEXT SCAN OVER THE FILE. `visibleOccurrenceWhereSql` carries a long doc comment that
// quotes its own clauses verbatim to explain them; grepping the file would match that prose and
// keep passing over a predicate that had actually changed underneath it.
describe('visibleOccurrenceWhereSql still says what the mirror assumes it says', () => {
  /** The normalised BODY of a named function declaration in postgres-repository.ts. */
  function sqlBodyOf(fnName: string): string {
    const path = fileURLToPath(new URL('../../lib/search/postgres-repository.ts', import.meta.url));
    const source = readFileSync(path, 'utf8');
    const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    let body: string | null = null;
    const walk = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === fnName && node.body) {
        body = node.body.getText(sourceFile);
      }
      node.forEachChild(walk);
    };
    walk(sourceFile);
    if (body == null) {
      throw new Error(
        `No function declaration named ${fnName} in lib/search/postgres-repository.ts. If it was ` +
          `renamed or inlined, update this guard — do not delete it. It is the only check that the ` +
          `SQL and lib/search/occurrence-visibility.ts still agree in a run without a database.`,
      );
    }
    return (body as string).replace(/\s+/g, ' ');
  }

  const sql = sqlBodyOf('visibleOccurrenceWhereSql');

  it('keeps the dateless arm requiring BOTH a null start AND standing hours', () => {
    expect(
      sql,
      'The mirror\'s first arm (`if (startDatetimeUtc == null) return listing.openHours`) is a ' +
        'direct transcription of this clause. Widening it to `open_hours_state IS NOT NULL` alone ' +
        'would resurrect rows carrying a long-dead date behind an hours string — the exact defect ' +
        "postgres-repository.ts's own header documents — and the mirror would no longer agree.",
    ).toContain('(o.start_datetime_utc IS NULL AND o.open_hours_state IS NOT NULL)');
  });

  it('keeps judging a dated row on COALESCE(end, start)', () => {
    expect(
      sql,
      'The mirror falls back from endDatetimeUtc to startDatetimeUtc because of this COALESCE. ' +
        'Change one without the other and the two disagree for every row with no end time.',
    ).toContain('COALESCE(o.end_datetime_utc, o.start_datetime_utc) >= now()');
  });

  // THE ONE THAT MATTERS MOST RIGHT NOW. Replacing the instant with a start-of-day floor is the
  // change under active discussion for this defect, and it is deliberately NOT made here: it
  // would surface finished activities as if they were still bookable. If it is ever made, this
  // must fail loudly rather than let the mirror, this file's repro, and the day-remainder
  // disclosure quietly start describing a product that no longer behaves that way.
  it('still prunes against the INSTANT `now()`, not a day boundary', () => {
    expect(
      /\bnow\(\)/.test(sql) && !/date_trunc|::\s*date\b|current_date/i.test(sql),
      `The catalogue floor is no longer a bare now(). Normalised predicate:\n  ${sql}\n\n` +
        `Three things are built on the instant-floor behaviour and all of them need revisiting ` +
        `together:\n` +
        `  1. lib/search/occurrence-visibility.ts — the mirror, which compares against now().\n` +
        `  2. this file's repro — "Today" collapsing at 22:35 is the floor, caught in the act.\n` +
        `  3. app/search/_lib/day-remainder-notice.ts — its copy tells a parent the list only ` +
        `shows activities that have not ended yet. With a day floor that sentence becomes false, ` +
        `and finished sessions would render as if a parent could still turn up to them.`,
    ).toBe(true);
  });

  it('still excludes archived rows, which is why the mirror has no arm for them', () => {
    expect(
      sql,
      'occurrence-visibility.ts documents that it needs no archived_at arm because archived rows ' +
        'never reach the read model. Drop this and that reasoning stops holding.',
    ).toContain('o.archived_at IS NULL');
  });
});
