// tests/backfill-scope/activenet-age-backfill.test.ts — the correction plan, without a database.
import { describe, it, expect } from 'vitest';
import {
  planRow,
  buildPlan,
  correctionParams,
  activityIdFromSourceRecordId,
  CORRECTION_UPDATE_SQL,
  REASON,
  type StoredAgeRow,
} from '../../scripts/backfill-scope/activenet-age-backfill-lib';
import { assertCorrectionStatement } from '../../scripts/backfill-scope/correcting-db';

const row = (over: Partial<StoredAgeRow> = {}): StoredAgeRow => ({
  occurrenceId: 'occ-1',
  activityId: 622061,
  activityName: 'Karate - Ku Yu Kai Go-Ju Ryu (Adults)',
  hasAgeRow: true,
  ageMinMonths: 0,
  ageMaxMonths: null,
  ageNotes: 'all-ages',
  bandCount: 5,
  ...over,
});

describe('planRow', () => {
  it('corrects the manufactured all-ages claim to the source 19+ floor', () => {
    const d = planRow(row(), { minMonths: 228, maxMonths: null });
    expect(d.action).toBe('set');
    expect(d.reason).toBe(REASON.SET_CONTRADICTED);
    expect(d.corrected).toEqual({ minMonths: 228, maxMonths: null });
    expect(d.admitsTooYoung).toBe(true);
  });

  it('keeps |Public Skate| all-ages when the SOURCE says all-ages — 120 of the 227', () => {
    // Stored is the same claim, so there is nothing to write: it was right all along, and after
    // the parser fix the next re-ingest re-derives it attributably.
    const d = planRow(
      row({ activityName: '|Public Skate|' }),
      { minMonths: 0, maxMonths: null, notes: 'all-ages' }
    );
    expect(d.action).toBe('leave');
    expect(d.reason).toBe(REASON.LEAVE_AGREES);
  });

  it('narrows a children\'s class the parser had opened to everyone (Tae Kwon Do 6-13)', () => {
    const d = planRow(row({ activityName: 'Tae Kwon Do Level 1 & Level 2' }), { minMonths: 72, maxMonths: 167 });
    expect(d.action).toBe('set');
    expect(d.corrected).toEqual({ minMonths: 72, maxMonths: 167 });
    expect(d.admitsTooYoung).toBe(true);
  });

  it('corrects a title-attributed all-ages claim that is really 55+ (Ukulele)', () => {
    const d = planRow(row({ activityName: 'Ukulele - Jam Circle (All ages)' }), { minMonths: 660, maxMonths: null });
    expect(d.action).toBe('set');
    expect(d.admitsTooYoung).toBe(true);
  });

  it('flags a purely cosmetic correction as NOT a child-safety one', () => {
    // Stored floor already at or above the source floor: a real correction, but not the
    // direction that puts a child in an adult room.
    const d = planRow(row({ ageMinMonths: 240, ageMaxMonths: null, ageNotes: null }), { minMonths: 228, maxMonths: null });
    expect(d.action).toBe('set');
    expect(d.admitsTooYoung).toBe(false);
  });

  it('NEVER guesses when the lookup failed', () => {
    const d = planRow(row(), undefined);
    expect(d.action).toBe('ambiguous');
    expect(d.reason).toBe(REASON.AMBIGUOUS_LOOKUP_FAILED);
    expect(d.corrected).toBeNull();
  });

  it('distinguishes "lookup failed" from "source has no age" — they are different facts', () => {
    expect(planRow(row(), undefined).action).toBe('ambiguous');
    expect(planRow(row(), null).action).toBe('leave');
    expect(planRow(row(), null).reason).toBe(REASON.LEAVE_SOURCE_SILENT);
  });

  it('never CREATES an age row — that is the ingest path\'s job', () => {
    const d = planRow(row({ hasAgeRow: false, ageMinMonths: null, ageNotes: null, bandCount: 0 }), {
      minMonths: 228,
      maxMonths: null,
    });
    expect(d.action).toBe('leave');
    expect(d.reason).toBe(REASON.LEAVE_NO_CLAIM);
  });

  it('refuses a row whose source_record_id yields no activity id', () => {
    expect(planRow(row({ activityId: Number.NaN }), { minMonths: 1, maxMonths: null }).action).toBe('ambiguous');
  });
});

describe('buildPlan', () => {
  it('tallies the child-safety subset separately from the total', () => {
    const rows = [
      row({ occurrenceId: 'a', activityId: 1 }),
      row({ occurrenceId: 'b', activityId: 1 }),
      row({ occurrenceId: 'c', activityId: 2, activityName: '|Public Skate|' }),
      row({ occurrenceId: 'd', activityId: 3 }),
    ];
    const source = (id: number) =>
      id === 1 ? { minMonths: 228, maxMonths: null } : id === 2 ? { minMonths: 0, maxMonths: null, notes: 'all-ages' } : undefined;
    const plan = buildPlan(rows, source);
    expect(plan.counts).toMatchObject({ rows: 4, set: 2, leave: 1, ambiguous: 1, admitsTooYoung: 2, wasAllAges: 2 });
    expect(plan.distinctActivities).toBe(3);
    expect(plan.byReason[REASON.SET_CONTRADICTED]).toBe(2);
  });

  it('a second run over already-corrected rows writes nothing', () => {
    const corrected = row({ ageMinMonths: 228, ageMaxMonths: null, ageNotes: null });
    const plan = buildPlan([corrected], () => ({ minMonths: 228, maxMonths: null }));
    expect(plan.counts.set).toBe(0);
    expect(plan.counts.leave).toBe(1);
  });
});

describe('the write statement', () => {
  it('passes correcting-db\'s own guard', () => {
    expect(() => assertCorrectionStatement(CORRECTION_UPDATE_SQL)).not.toThrow();
  });

  it('re-states the whole pre-state, so a concurrent re-ingest is never clobbered', () => {
    expect(CORRECTION_UPDATE_SQL).toMatch(/coalesce\(age_min_months, -1\) = coalesce\(\$2::int, -1\)/);
    expect(CORRECTION_UPDATE_SQL).toMatch(/coalesce\(age_max_months, -1\) = coalesce\(\$3::int, -1\)/);
    expect(CORRECTION_UPDATE_SQL).toMatch(/coalesce\(age_notes, ''\) = coalesce\(\$4::text, ''\)/);
  });

  it('matches a NULL bound at all — a bare `= $3` never would', () => {
    // `age_max_months = NULL` is never true in SQL; every open-ended row (which is every
    // manufactured all-ages row) would be silently unwritable.
    expect(CORRECTION_UPDATE_SQL).not.toMatch(/\bage_max_months\s*=\s*\$3/);
  });

  it('avoids the token FROM, which correcting-db refuses in order to block join-updates', () => {
    expect(CORRECTION_UPDATE_SQL).not.toMatch(/\bFROM\b/i);
  });

  it('builds params in the declared order, pre-state then post-state', () => {
    const stored = row();
    const d = planRow(stored, { minMonths: 228, maxMonths: null });
    expect(correctionParams(d, stored, ['band-15plus'])).toEqual([
      'occ-1', 0, null, 'all-ages', 228, null, ['band-15plus'], null,
    ]);
  });

  it('refuses to build params for a decision that writes nothing', () => {
    const d = planRow(row(), undefined);
    expect(() => correctionParams(d, row(), [])).toThrow(/non-write decision/);
  });
});

describe('activityIdFromSourceRecordId', () => {
  it('takes the first segment of the occurrence identity', () => {
    expect(activityIdFromSourceRecordId('622061:20260913190000:57:487-488')).toBe(622061);
  });
  it('is NaN when there is no usable id, so planRow can refuse it', () => {
    expect(Number.isNaN(activityIdFromSourceRecordId('noid:x:1:2'))).toBe(true);
  });
});
