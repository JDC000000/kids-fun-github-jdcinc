// tests/backfill-scope/citycalendar-recon.test.ts — the §3.4 CityCalendar reconciliation.
//
// These tests drive the REAL shipped CityCalendarAdapter, not a stub of it. That is the whole
// point of the unit: a reconciliation that re-implemented `namesAdultOnlySubject` would prove
// only that two copies of a regex agree with each other. Every `records` array below is the
// output of `new CityCalendarAdapter(getCityCalendar('vancouver')!).extract(...)`, so when a
// test asserts "the suppression fires", it is asserting something about `f59cd71` as it ships.
//
// No database. No network. Pure inputs → pure findings, which is why this file belongs in the
// `unit` lane and is not listed in vitest.workspace.ts's DB_INTEGRATION_SUITES.
import { describe, expect, it } from 'vitest';
import { CityCalendarAdapter } from '@/worker/adapters/citycalendar';
import { getCityCalendar } from '@/worker/adapters/citycalendar/config';
import type { StructuredRecord } from '@/worker/core/adapter';
import { parseAgeText, parseAudienceLabels } from '@/worker/core/age';
import {
  OPEN_POPULATION_BUCKET,
  buildEvidence,
  indexFeedByEventId,
  indexRecordsBySourceRecordId,
  ingestAgeParse,
  observeRow,
  priorMeasurementBucket,
  reconcileAll,
  reconcileRow,
  storedProvenance,
  tallyReasons,
  tallyVerdicts,
  type StoredCityCalendarRow,
  type TrumbaEventLike,
} from '@/scripts/backfill-scope/citycalendar-recon';

const config = getCityCalendar('vancouver');
if (!config) throw new Error('vancouver city-calendar config missing — the fixture below is meaningless without it');
const adapter = new CityCalendarAdapter(config);

/** Drive the shipped extract() exactly as the driver (and worker/core/ingest.ts) does. */
function extract(events: TrumbaEventLike[]): StructuredRecord[] {
  return adapter.extract(events as unknown[]);
}

function event(overrides: Partial<TrumbaEventLike> & { eventID: number | string }): TrumbaEventLike {
  return {
    title: 'Some Event',
    description: '',
    startDateTime: '2026-09-01T10:00:00',
    canceled: false,
    ...overrides,
  };
}

function storedRow(overrides: Partial<StoredCityCalendarRow> = {}): StoredCityCalendarRow {
  return {
    occurrenceId: '00000000-0000-0000-0000-000000000001',
    sourceRecordId: '900001',
    activityName: 'Some Event',
    hasAgeRow: false,
    ageMinMonths: null,
    ageMaxMonths: null,
    ageNotes: null,
    bandCount: 0,
    lastCheckedAt: '2026-08-19T05:00:00.000Z',
    lastResolvedAgeFactAt: null,
    ...overrides,
  };
}

/** A stored row holding the catch-all claim `parseAgeText('All ages')` produces: [0, ∞). */
function allAgesRow(overrides: Partial<StoredCityCalendarRow> = {}): StoredCityCalendarRow {
  return storedRow({ hasAgeRow: true, ageMinMonths: 0, ageMaxMonths: null, ageNotes: 'all-ages', bandCount: 5, ...overrides });
}

const AUDIENCES_ALL_AGES = [{ label: 'Audiences', value: 'All ages' }];

describe('the join: eventID → activity_occurrence.source_record_id', () => {
  it('keys on String(eventID), so a numeric feed id joins a text DB column', () => {
    const { byEventId } = indexFeedByEventId([event({ eventID: 150181808 })]);
    expect([...byEventId.keys()]).toEqual(['150181808']);
    expect(byEventId.get('150181808')).toBeDefined();
  });

  it('joins a string eventID identically — the feed publishes both shapes', () => {
    const { byEventId } = indexFeedByEventId([event({ eventID: 'vancouver-fixture-1' })]);
    expect(byEventId.get('vancouver-fixture-1')).toBeDefined();
  });

  it('reports duplicate eventIDs rather than silently keeping the last one', () => {
    const { byEventId, duplicateEventIds } = indexFeedByEventId([
      event({ eventID: 42, title: 'First' }),
      event({ eventID: 42, title: 'Second' }),
      event({ eventID: 42, title: 'Third' }),
    ]);
    expect(duplicateEventIds).toEqual(['42']);
    expect(byEventId.get('42')?.title).toBe('First');
    expect(byEventId.size).toBe(1);
  });

  it('indexes adapter output by the same key the adapter writes, so the two cannot drift', () => {
    const records = extract([event({ eventID: 150181808, title: 'Flag Lowering' })]);
    const byId = indexRecordsBySourceRecordId(records);
    expect(byId.get('150181808')?.title).toBe('Flag Lowering');
  });

  it('joins the whole population end to end and leaves unmatched rows unmatched', () => {
    const events = [event({ eventID: 111, title: 'Live One' })];
    const records = extract(events);
    const { findings } = reconcileAll(
      [storedRow({ occurrenceId: 'a', sourceRecordId: '111' }), storedRow({ occurrenceId: 'b', sourceRecordId: '222' })],
      events,
      records
    );
    expect(findings.map((f) => f.occurrenceId)).toEqual(['a', 'b']);
    expect(findings[0].liveVerdict).toBe('confirms');
    expect(findings[1].liveVerdict).toBe('cannot-speak');
    expect(findings[1].reason).toBe('no-live-counterpart:not-in-current-feed');
  });
});

describe('no-live-counterpart is never read as agreement', () => {
  it('a row absent from the current feed window cannot-speak, even holding a positive claim', () => {
    const finding = reconcileRow({ row: allAgesRow(), event: undefined, record: undefined });
    expect(finding.liveVerdict).toBe('cannot-speak');
    expect(finding.remedy).toBe('unknown');
    expect(finding.reason).toBe('no-live-counterpart:not-in-current-feed');
    // The three things that must NOT happen to an absent row.
    expect(finding.liveVerdict).not.toBe('confirms');
    expect(finding.liveVerdict).not.toBe('contradicts');
    expect(finding.liveEvidence).toBeNull();
  });

  it('a row with no source_record_id cannot be joined, and says so as its own reason', () => {
    const finding = reconcileRow({ row: allAgesRow({ sourceRecordId: null }), event: undefined, record: undefined });
    expect(finding.liveVerdict).toBe('cannot-speak');
    expect(finding.reason).toBe('no-live-counterpart:row-has-no-source-record-id');
  });

  it('an empty-string source_record_id is treated as unjoinable, not as a join to ""', () => {
    const finding = reconcileRow({ row: allAgesRow({ sourceRecordId: '' }), event: undefined, record: undefined });
    expect(finding.reason).toBe('no-live-counterpart:row-has-no-source-record-id');
  });

  it('an event the SHIPPED extract() filter drops cannot-speak, and keeps its evidence', () => {
    // Cancelled: `.filter((e) => e && !e.canceled && e.title && e.startDateTime)`.
    const cancelled = event({ eventID: 900001, canceled: true, customFields: AUDIENCES_ALL_AGES });
    const records = extract([cancelled]);
    expect(records).toHaveLength(0);

    const { findings } = reconcileAll([allAgesRow()], [cancelled], records);
    expect(findings[0].liveVerdict).toBe('cannot-speak');
    expect(findings[0].reason).toBe('no-live-counterpart:dropped-by-shipped-extract-filter');
    // Evidence survives so a reader can see WHY it was dropped, but no verdict is inferred.
    expect(findings[0].liveEvidence?.extractable).toBe(false);
    expect(findings[0].liveEvidence?.suppressionFired).toBeNull();
  });

  it('an event with no startDateTime is dropped by the same shipped filter', () => {
    const undated = { eventID: 900001, title: 'Undated', canceled: false } as TrumbaEventLike;
    const records = extract([undated]);
    expect(records).toHaveLength(0);
    const { findings } = reconcileAll([allAgesRow()], [undated], records);
    expect(findings[0].reason).toBe('no-live-counterpart:dropped-by-shipped-extract-filter');
  });

  it('cannot-speak rows are excluded from both other tallies', () => {
    const { findings } = reconcileAll(
      [allAgesRow({ occurrenceId: 'a' }), allAgesRow({ occurrenceId: 'b', sourceRecordId: '900002' })],
      [],
      []
    );
    expect(tallyVerdicts(findings)).toEqual({ confirms: 0, contradicts: 0, cannotSpeak: 2 });
  });
});

describe('the §3h contradiction — a withdrawn claim that survives every re-ingest', () => {
  it('the flagship overdose row: live description + Audiences make the shipped adapter withhold', () => {
    // The row docs §3.4 names, with the inputs production does not persist restored from the
    // live feed: eventID 150181808, Audiences "All ages", an adult-only subject in the text.
    const live = event({
      eventID: 150181808,
      title: 'International Overdose Awareness',
      description: "City Hall's flag will be at half-mast in honour of International Overdose Awareness.",
      customFields: AUDIENCES_ALL_AGES,
    });
    const records = extract([live]);
    // The shipped adapter — not a copy of it — withholds the wording.
    expect(records[0].ageText).toBeUndefined();

    const row = allAgesRow({ sourceRecordId: '150181808', activityName: 'International Overdose Awareness' });
    const { findings } = reconcileAll([row], [live], records);
    expect(findings[0].liveVerdict).toBe('contradicts');
    expect(findings[0].remedy).toBe('needs_operator_write_3h');
    expect(findings[0].reason).toBe('contradicted:claim-withdrawn-stale-row-survives-reingest');
    expect(findings[0].liveEvidence?.suppressionFired).toBe(true);
  });

  it('withholding against a row with NO positive claim is agreement, not a §3h stale row', () => {
    const live = event({
      eventID: 150181808,
      title: 'International Overdose Awareness',
      description: 'Flag at half-mast for International Overdose Awareness.',
      customFields: AUDIENCES_ALL_AGES,
    });
    const records = extract([live]);
    const row = storedRow({ sourceRecordId: '150181808', hasAgeRow: false });
    const { findings } = reconcileAll([row], [live], records);
    expect(findings[0].liveVerdict).toBe('confirms');
    expect(findings[0].remedy).toBe('none');
    expect(findings[0].reason).toBe('confirmed:no-claim-either-side');
  });

  it('a row that exists but asserts no bounds also confirms — nothing a parent can match on', () => {
    const live = event({
      eventID: 150181808,
      title: 'International Overdose Awareness',
      description: 'Flag at half-mast.',
      customFields: AUDIENCES_ALL_AGES,
    });
    const records = extract([live]);
    const row = storedRow({ sourceRecordId: '150181808', hasAgeRow: true, ageNotes: 'unresolved: something' });
    const { findings } = reconcileAll([row], [live], records);
    expect(findings[0].reason).toBe('confirmed:no-positive-claim-either-side');
  });
});

describe('confirmation and self-healing contradictions', () => {
  it('a catch-all on a subject that is NOT adult-only still resolves, and confirms [0, ∞)', () => {
    const live = event({
      eventID: 206479248,
      title: 'Port Day, presented by the Vancouver Fraser Port Authority',
      description: 'A day of family activities at the port.',
      customFields: AUDIENCES_ALL_AGES,
    });
    const records = extract([live]);
    expect(records[0].ageText).toBe('All ages');
    const parse = parseAgeText('All ages');
    expect(parse).toMatchObject({ ageMinMonths: 0, ageMaxMonths: null, notes: 'all-ages' });

    const { findings } = reconcileAll([allAgesRow({ sourceRecordId: '206479248' })], [live], records);
    expect(findings[0].liveVerdict).toBe('confirms');
    expect(findings[0].reason).toBe('confirmed:bounds-and-notes-match');
  });

  it('different bounds contradict but self-heal — ingest.ts:294 overwrites them unaided', () => {
    const live = event({
      eventID: 900010,
      title: 'Story Time',
      customFields: [{ label: 'Audiences', value: 'Children' }],
    });
    const records = extract([live]);
    expect(records[0].ageText).toBe('Children');
    const row = allAgesRow({ sourceRecordId: '900010', activityName: 'Story Time' });
    const { findings } = reconcileAll([row], [live], records);
    expect(findings[0].liveVerdict).toBe('contradicts');
    expect(findings[0].remedy).toBe('self_heals_on_reingest');
    expect(findings[0].reason).toBe('contradicted:bounds-differ-overwrite-on-reingest');
  });

  it('a claim derived where no row is stored contradicts, and self-heals by being created', () => {
    const live = event({ eventID: 900011, title: 'Story Time', customFields: AUDIENCES_ALL_AGES });
    const records = extract([live]);
    const { findings } = reconcileAll([storedRow({ sourceRecordId: '900011' })], [live], records);
    expect(findings[0].liveVerdict).toBe('contradicts');
    expect(findings[0].remedy).toBe('self_heals_on_reingest');
    expect(findings[0].reason).toBe('contradicted:live-derives-a-claim-where-no-row-is-stored');
  });

  it('matching bounds with different notes is reported, not folded into confirms', () => {
    const live = event({ eventID: 900012, title: 'Open House', customFields: AUDIENCES_ALL_AGES });
    const records = extract([live]);
    const row = allAgesRow({ sourceRecordId: '900012', ageNotes: 'all-ages (llm-resolved)' });
    const { findings } = reconcileAll([row], [live], records);
    expect(findings[0].liveVerdict).toBe('contradicts');
    expect(findings[0].reason).toBe('contradicted:bounds-match-but-notes-differ');
    // …and the provenance flag says the adapter is probably not the author of that string.
    expect(findings[0].storedProvenance).toBe('llm_fallback');
  });

  it('undefined parse notes and a NULL age_notes column are the same stored value', () => {
    // parseAgeText('Children') resolves bounds with no notes; upsertOccurrenceAge writes
    // `parse.notes ?? null`. Comparing undefined against NULL as unequal would manufacture a
    // contradiction out of a TypeScript nicety.
    const live = event({ eventID: 900013, title: 'Kids Club', customFields: [{ label: 'Audiences', value: 'Children' }] });
    const records = extract([live]);
    const parse = parseAgeText('Children');
    expect(parse.notes).toBeUndefined();
    const row = storedRow({
      sourceRecordId: '900013',
      hasAgeRow: true,
      ageMinMonths: parse.ageMinMonths,
      ageMaxMonths: parse.ageMaxMonths,
      ageNotes: null,
    });
    const { findings } = reconcileAll([row], [live], records);
    expect(findings[0].reason).toBe('confirmed:bounds-and-notes-match');
  });
});

describe('suppressionFired is inferred from the shipped control flow, and only when sound', () => {
  it('is true when a present Audiences field yields no ageText — the only branch that can', () => {
    const live = event({
      eventID: 900020,
      title: 'Grief Support Circle',
      description: 'A grief support circle for those who have lost someone.',
      customFields: AUDIENCES_ALL_AGES,
    });
    const [record] = extract([live]);
    expect(record.ageText).toBeUndefined();
    expect(buildEvidence(live, record).suppressionFired).toBe(true);
  });

  it('is false when a present Audiences field survives to become the wording', () => {
    const live = event({ eventID: 900021, title: 'Family Swim', customFields: AUDIENCES_ALL_AGES });
    const [record] = extract([live]);
    expect(buildEvidence(live, record).suppressionFired).toBe(false);
  });

  it('is null — undeterminable — when the Audiences field is absent', () => {
    // With no structured tag the wording comes from the prose scan, so silence is ambiguous
    // between the suppression and the scan simply finding nothing. The module does not guess.
    const live = event({ eventID: 900022, title: 'Chinatown Cleanup', description: 'Come help tidy the neighbourhood.' });
    const [record] = extract([live]);
    expect(record.ageText).toBeUndefined();
    expect(buildEvidence(live, record).suppressionFired).toBeNull();
  });

  it('is null when the Audiences field is present but empty', () => {
    const live = event({ eventID: 900023, title: 'Cleanup', customFields: [{ label: 'Audiences', value: '   ' }] });
    const [record] = extract([live]);
    expect(buildEvidence(live, record).suppressionFired).toBeNull();
  });

  it('carries the raw Audiences value and description size as re-verifiable evidence', () => {
    const live = event({
      eventID: 900024,
      title: 'Port Day',
      description: 'Twelve chars',
      customFields: [{ label: 'audiences', value: 'All ages' }],
    });
    const [record] = extract([live]);
    const evidence = buildEvidence(live, record);
    expect(evidence.audiencesField).toBe('All ages'); // label match is case-insensitive
    expect(evidence.descriptionChars).toBe('Twelve chars'.length);
    expect(evidence.eventId).toBe('900024');
  });
});

describe('the ingest expression is mirrored, not approximated', () => {
  it('prefers ageAudienceLabels when present, exactly as worker/core/ingest.ts:237 does', () => {
    const record = { sourceRecordId: 'x', title: 'x', ageText: 'All ages', ageAudienceLabels: ['Children'] } as StructuredRecord;
    // If this took the ageText branch it would be [0, ∞); the labels branch is narrower, and
    // is the same answer parseAudienceLabels gives for the same list.
    expect(ingestAgeParse(record)).toEqual(parseAudienceLabels(['Children']));
    expect(ingestAgeParse(record)).not.toEqual(parseAgeText('All ages'));
  });

  it('falls through to parseAgeText when the label list is absent or empty', () => {
    const record = { sourceRecordId: 'x', title: 'x', ageText: 'All ages', ageAudienceLabels: [] } as unknown as StructuredRecord;
    expect(ingestAgeParse(record)).toMatchObject({ ageMinMonths: 0, ageMaxMonths: null });
  });

  it('returns null — no occurrence_age row would be written — when there is no wording', () => {
    expect(ingestAgeParse({ sourceRecordId: 'x', title: 'x' } as StructuredRecord)).toBeNull();
  });
});

describe('cross-check against the title-only measurement', () => {
  it('labels a catch-all row the title alone cannot decide as the §6 open population', () => {
    const row = allAgesRow({ activityName: 'International Overdose Awareness Day' });
    // The title DOES carry \boverdose\b, so the title-only classifier can decide this one and
    // puts it in the candidate bucket instead.
    expect(priorMeasurementBucket(row)).toBe('citycalendar:candidate-adult-subject-suppression-description-unknown');

    const innocent = allAgesRow({ activityName: 'Port Day, presented by the Vancouver Fraser Port Authority' });
    expect(priorMeasurementBucket(innocent)).toBe(OPEN_POPULATION_BUCKET);
  });

  it('labels a non-catch-all row with the other bucket the recheck reports', () => {
    const row = storedRow({ hasAgeRow: true, ageMinMonths: 60, ageMaxMonths: 144, ageNotes: null });
    expect(priorMeasurementBucket(row)).toBe('citycalendar:stored-wording-was-not-a-catch-all');
  });

  it('is carried onto every finding, so the report joins back without a hand-copied ID list', () => {
    const live = event({ eventID: 900030, title: 'Port Day', customFields: AUDIENCES_ALL_AGES });
    const { findings } = reconcileAll(
      [allAgesRow({ sourceRecordId: '900030', activityName: 'Port Day' })],
      [live],
      extract([live])
    );
    expect(findings[0].priorBucket).toBe(OPEN_POPULATION_BUCKET);
  });
});

describe('stored provenance', () => {
  it.each([
    ['llm-resolved: ages 5-8', 'llm_fallback'],
    ['llm-unresolved: who knows', 'llm_fallback'],
    ['ages 5-8 (llm-resolved)', 'llm_fallback'],
    ['ages 5-8 (llm-unresolved)', 'llm_fallback'],
    ['all-ages', 'adapter_or_hand'],
    ['unresolved: Set 1', 'adapter_or_hand'],
  ])('reads %s as %s', (notes, expected) => {
    expect(storedProvenance(storedRow({ hasAgeRow: true, ageNotes: notes }))).toBe(expected);
  });

  it('reports no_age_row when there is no occurrence_age row at all', () => {
    expect(storedProvenance(storedRow())).toBe('no_age_row');
  });
});

describe('observation vs prediction', () => {
  const BOOTED = '2026-08-18T21:47:41.402Z';

  it('a row upserted after bootedAt was written BY the deployed build', () => {
    const row = storedRow({ lastCheckedAt: '2026-08-18T21:55:10.645Z' });
    expect(observeRow(row, BOOTED).observedByDeployedBuild).toBe(true);
  });

  it('a row upserted before bootedAt was not', () => {
    const row = storedRow({ lastCheckedAt: '2026-08-12T15:35:21.791Z' });
    expect(observeRow(row, BOOTED).observedByDeployedBuild).toBe(false);
  });

  it('is unknown without a boundary, and unknown for a never-checked row', () => {
    expect(observeRow(storedRow(), null).observedByDeployedBuild).toBeNull();
    expect(observeRow(storedRow({ lastCheckedAt: null }), BOOTED).observedByDeployedBuild).toBeNull();
  });

  it('an unparseable boundary is unknown, never silently treated as the epoch', () => {
    expect(observeRow(storedRow(), 'not-a-date').observedByDeployedBuild).toBeNull();
  });

  it('reads "the last run resolved no age" off provenance, not off the current row value', () => {
    // recordProvenance runs strictly after upsertOccurrence within a run, both with now(),
    // so a fact at-or-after last_checked_at means THAT run resolved an age.
    const resolved = storedRow({
      lastCheckedAt: '2026-08-18T21:55:10.645Z',
      lastResolvedAgeFactAt: '2026-08-18T21:55:10.700Z',
    });
    expect(observeRow(resolved, BOOTED).lastIngestRecordedNoResolvedAge).toBe(false);

    const withheld = storedRow({
      lastCheckedAt: '2026-08-18T21:55:10.645Z',
      lastResolvedAgeFactAt: '2026-08-12T15:35:21.900Z',
    });
    expect(observeRow(withheld, BOOTED).lastIngestRecordedNoResolvedAge).toBe(true);

    const never = storedRow({ lastCheckedAt: '2026-08-18T21:55:10.645Z', lastResolvedAgeFactAt: null });
    expect(observeRow(never, BOOTED).lastIngestRecordedNoResolvedAge).toBe(true);
  });

  it('is unknown when the row has never been checked — there is no "most recent run"', () => {
    const row = storedRow({ lastCheckedAt: null, lastResolvedAgeFactAt: null });
    expect(observeRow(row, BOOTED).lastIngestRecordedNoResolvedAge).toBeNull();
  });

  it('rides along on every finding, threaded through reconcileAll', () => {
    const live = event({ eventID: 900040, title: 'Port Day', customFields: AUDIENCES_ALL_AGES });
    const { findings } = reconcileAll(
      [allAgesRow({ sourceRecordId: '900040', lastCheckedAt: '2026-08-18T21:55:10.645Z' })],
      [live],
      extract([live]),
      BOOTED
    );
    expect(findings[0].observation.observedByDeployedBuild).toBe(true);
    expect(findings[0].observation.lastIngestRecordedNoResolvedAge).toBe(true);
  });

  it('defaults to no boundary when reconcileAll is called without one', () => {
    const { findings } = reconcileAll([storedRow()], [], []);
    expect(findings[0].observation.observedByDeployedBuild).toBeNull();
  });
});

describe('report shape is deterministic', () => {
  it('preserves input row order and sorts reasons by count then name', () => {
    const events = [
      event({ eventID: 1, title: 'A', customFields: AUDIENCES_ALL_AGES }),
      event({ eventID: 2, title: 'B', customFields: AUDIENCES_ALL_AGES }),
    ];
    const records = extract(events);
    const rows = [
      allAgesRow({ occurrenceId: 'r1', sourceRecordId: '1' }),
      allAgesRow({ occurrenceId: 'r2', sourceRecordId: '2' }),
      allAgesRow({ occurrenceId: 'r3', sourceRecordId: '3' }),
    ];
    const first = reconcileAll(rows, events, records);
    const second = reconcileAll(rows, events, records);
    expect(first.findings.map((f) => f.occurrenceId)).toEqual(['r1', 'r2', 'r3']);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(tallyReasons(first.findings)).toEqual([
      ['confirmed:bounds-and-notes-match', 2],
      ['no-live-counterpart:not-in-current-feed', 1],
    ]);
  });

  it('every row lands on exactly one of the three verdicts', () => {
    const events = [
      event({ eventID: 1, title: 'A', customFields: AUDIENCES_ALL_AGES }),
      event({ eventID: 2, title: 'Overdose Awareness Day', description: 'Naloxone training.', customFields: AUDIENCES_ALL_AGES }),
      event({ eventID: 3, title: 'C', canceled: true }),
    ];
    const rows = [
      allAgesRow({ occurrenceId: 'r1', sourceRecordId: '1' }),
      allAgesRow({ occurrenceId: 'r2', sourceRecordId: '2' }),
      allAgesRow({ occurrenceId: 'r3', sourceRecordId: '3' }),
      allAgesRow({ occurrenceId: 'r4', sourceRecordId: '4' }),
    ];
    const { findings } = reconcileAll(rows, events, extract(events));
    const counts = tallyVerdicts(findings);
    expect(counts.confirms + counts.contradicts + counts.cannotSpeak).toBe(rows.length);
    expect(counts).toEqual({ confirms: 1, contradicts: 1, cannotSpeak: 2 });
  });
});
