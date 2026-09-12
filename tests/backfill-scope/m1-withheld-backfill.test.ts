// tests/backfill-scope/m1-withheld-backfill.test.ts — the M1 §3h correction's row-selection
// rules and its clobber guard, pinned WITHOUT a database.
//
// NO CONNECTION IS OPENED HERE, deliberately: this belongs in the `unit` lane so it runs in CI
// and on any machine, and so the rules are checked by their own logic rather than by whatever
// production happens to hold tonight. The two things a live run would add — that the SQL is
// valid and that the real row population is what the report says — are covered by the dry run
// the Operator reviews before applying.
//
// What is pinned here:
//   • the three-way split (correct / venue's own claim / contradicted) on REAL measured titles;
//   • that the batch is idempotent, through a simulator of the UPDATE's own WHERE clause;
//   • that the statement cannot clobber a row that changed after the plan was built;
//   • that the write surface refuses any statement other than the reviewed one.
import { describe, it, expect } from 'vitest';
import {
  ALL_AGES_NOTES_PROXY,
  CORRECTION_UPDATE_SQL,
  MANUFACTURED_MIN_MONTHS,
  REASON,
  buildPlan,
  correctionParams,
  planRow,
  type StoredAgeRow,
} from '../../scripts/backfill-scope/m1-withheld-backfill-lib';
import { assertCorrectionStatement } from '../../scripts/backfill-scope/correcting-db';
import { resolveAgeText } from '../../worker/adapters/perfectmind/parse';

/** A row as production holds it after the pre-M1 flag branch wrote it. */
function manufacturedRow(activityName: string, over: Partial<StoredAgeRow> = {}): StoredAgeRow {
  return {
    occurrenceId: `occ-${activityName.slice(0, 12)}`,
    activityName,
    ageMinMonths: MANUFACTURED_MIN_MONTHS,
    ageMaxMonths: null,
    ageNotes: ALL_AGES_NOTES_PROXY,
    bandCount: 5,
    lastCheckedAt: '2026-09-12T00:00:00.000Z',
    ...over,
  };
}

// Titles measured on the live NVRC pulls and quoted in M1's own commit message, the M1 handoff
// and docs/worker-fix-backfill-scope.md §3.5. Using the real strings is the point: a synthetic
// "Some Class" would pass every version of this gate, including the broken ones.
const FLAG_ONLY_TITLES = [
  'Tai Chi Chuan Delbrook Monday 10:00-11:00am',
  'Recreational Line Dancing Parkgate Tuesday 1:00-2:30pm',
  'Lane Swim Ron Andrews Monday 11:15am-1:00pm',
  '$2 Public Swim Karen Magnussen Saturday 6:30-8:00pm',
  // The T1.3 row the M1 handoff flagged as unsatisfiable: "Family Skate" is marketing warmth,
  // not an age claim, so M1 withholds and this backfill corrects it. Pinned here so the
  // decision is visible rather than incidental.
  'Family Skate New Harry Jerome Wednesday 12:30-2:00pm',
];

const TITLE_STATES_AN_AGE = [
  'Adult 19yrs+ Swim Karen Magnussen Thursday 8:00-9:00am',
  '$3 Open Gym 8yrs+ Parkgate Wednesday 6:15-7:45am',
  'Lynn Creek Youth Centre Tuesday 3:30pm-5:30pm (Grade 4-7)',
];

const VENUE_PUBLISHES_ALL_AGES = [
  '$2 Queer All Ages Skate Karen Magnussen Monday 2:30-3:45pm',
  '$2 Queer All Ages Swim Karen Magnussen Saturday 6:30-8:00pm',
];

describe('M1 withheld-backfill — which rows are in scope', () => {
  it.each(FLAG_ONLY_TITLES)('corrects a flag-only manufactured claim: %s', (title) => {
    const decision = planRow(manufacturedRow(title));
    expect(decision.action).toBe('correct');
    expect(decision.reason).toBe(REASON.CORRECT);
    expect(decision.m1Code).toBe('no-age-restriction-withheld');
  });

  it('every corrected row is one the shipped parser would publish NO age for', () => {
    // The backfill's entire warrant: the corrected state must be what M1 writes today, not a
    // judgement of this script's own. Driving the real parser is what proves that.
    for (const title of FLAG_ONLY_TITLES) {
      expect(resolveAgeText({ EventName: title, NoAgeRestriction: true }).ageText).toBeUndefined();
    }
  });

  it.each(VENUE_PUBLISHES_ALL_AGES)('leaves the venue\'s OWN all-ages claim alone: %s', (title) => {
    // Withholding these would be the mirror image of the defect: discarding a claim somebody
    // made, rather than inventing one nobody made. M1 still emits 'All ages' for them, so the
    // stored row is already correct.
    const decision = planRow(manufacturedRow(title));
    expect(decision.action).toBe('leave');
    expect(decision.reason).toBe(REASON.TITLE_PUBLISHES);
    expect(resolveAgeText({ EventName: title, NoAgeRestriction: true }).ageText).toBe('All ages');
  });

  it.each(TITLE_STATES_AN_AGE)('leaves the contradicted population to its own batch: %s', (title) => {
    // Also stale, also wrong — but it is docs §3.5's separately measured 109-row class with its
    // own review history. This backfill must not silently absorb it.
    const decision = planRow(manufacturedRow(title));
    expect(decision.action).toBe('leave');
    expect(decision.reason).toBe(REASON.CONTRADICTED);
    expect(decision.m1Code).toBe('no-age-restriction-contradicted');
  });

  it('leaves a row whose stored bounds are not the manufactured claim', () => {
    // A hand-correction or an LLM fill-in. Someone made a decision about this row after ingest
    // did; overwriting it would destroy that work.
    const decision = planRow(manufacturedRow('Lengths Ron Andrews Friday 6:00-7:00am', { ageMinMonths: 228 }));
    expect(decision.action).toBe('leave');
    expect(decision.reason).toBe(REASON.BOUNDS_DIFFER);
  });

  it('leaves a row that carries no positive claim at all', () => {
    const decision = planRow(
      manufacturedRow('Lengths Ron Andrews Friday 6:00-7:00am', { ageMinMonths: null, ageMaxMonths: null })
    );
    expect(decision.action).toBe('leave');
    expect(decision.reason).toBe(REASON.ALREADY_WITHHELD);
  });

  it('leaves a row that is outside the NoAgeRestriction proxy', () => {
    const decision = planRow(manufacturedRow('Pickleball 3.0+ Delbrook Monday 9:00-11:00am', { ageNotes: null }));
    expect(decision.action).toBe('leave');
    expect(decision.reason).toBe(REASON.NOT_PROXY);
  });

  it('counts the parent-reachable subset separately from the already-masked one', () => {
    const plan = buildPlan([
      manufacturedRow('Tai Chi Chuan Delbrook Monday 10:00-11:00am'),
      // "Adult" with no number: the title exclusion hides it today, so its stale claim is not
      // currently reaching anyone — still worth correcting, different urgency.
      manufacturedRow('Adult Lane Swim Delbrook Monday 6:00-7:00am'),
    ]);
    expect(plan.corrections).toHaveLength(2);
    expect(plan.correctionsParentReachable).toBe(1);
  });
});

// ── the UPDATE's own WHERE clause, simulated ─────────────────────────────────────────────
//
// A faithful simulator of CORRECTION_UPDATE_SQL's predicate and SET list. It exists so the two
// properties that matter about the statement — idempotence and the refusal to clobber — are
// checked by executing them rather than by reading the SQL. The statement's *shape* is pinned
// separately and mechanically by assertCorrectionStatement below, so the two together cover
// both "it says the right thing" and "the right thing behaves as intended".
interface FakeStoredRow {
  ageMinMonths: number | null;
  ageMaxMonths: number | null;
  ageNotes: string | null;
  bandCount: number;
}

function fakeApply(table: Map<string, FakeStoredRow>, params: [string, string, number]): number {
  const [occurrenceId, notes, minMonths] = params;
  const row = table.get(occurrenceId);
  if (!row) return 0;
  if (row.ageNotes !== notes || row.ageMinMonths !== minMonths || row.ageMaxMonths !== null) return 0;
  table.set(occurrenceId, { ageMinMonths: null, ageMaxMonths: null, ageNotes: null, bandCount: 0 });
  return 1;
}

function tableFrom(rows: StoredAgeRow[]): Map<string, FakeStoredRow> {
  return new Map(
    rows.map((r) => [
      r.occurrenceId,
      { ageMinMonths: r.ageMinMonths, ageMaxMonths: r.ageMaxMonths, ageNotes: r.ageNotes, bandCount: r.bandCount },
    ])
  );
}

function rowsFrom(table: Map<string, FakeStoredRow>, named: StoredAgeRow[]): StoredAgeRow[] {
  return named.map((r) => ({ ...r, ...table.get(r.occurrenceId)! }));
}

describe('M1 withheld-backfill — applying the batch', () => {
  const rows = [
    manufacturedRow('Tai Chi Chuan Delbrook Monday 10:00-11:00am'),
    manufacturedRow('$2 Queer All Ages Skate Karen Magnussen Monday 2:30-3:45pm'),
    manufacturedRow('Adult 19yrs+ Swim Karen Magnussen Thursday 8:00-9:00am'),
    manufacturedRow('Lane Swim Ron Andrews Monday 11:15am-1:00pm'),
  ];

  it('writes exactly the planned rows and nothing else', () => {
    const table = tableFrom(rows);
    const plan = buildPlan(rows);
    const applied = plan.corrections.map((d) => fakeApply(table, correctionParams(d.occurrenceId)));

    expect(plan.corrections).toHaveLength(2);
    expect(applied).toEqual([1, 1]);
    // The venue's own claim and the contradicted row are untouched, byte for byte.
    for (const untouched of [rows[1], rows[2]]) {
      expect(table.get(untouched.occurrenceId)).toEqual({
        ageMinMonths: MANUFACTURED_MIN_MONTHS,
        ageMaxMonths: null,
        ageNotes: ALL_AGES_NOTES_PROXY,
        bandCount: 5,
      });
    }
  });

  it('is idempotent: a second run plans nothing and writes nothing', () => {
    const table = tableFrom(rows);
    for (const d of buildPlan(rows).corrections) fakeApply(table, correctionParams(d.occurrenceId));
    const afterFirst = new Map(table);

    const secondPlan = buildPlan(rowsFrom(table, rows));
    expect(secondPlan.corrections).toHaveLength(0);
    // …and even if a corrected row were replanned by mistake, the statement itself refuses it.
    expect(fakeApply(table, correctionParams(rows[0].occurrenceId))).toBe(0);
    expect(table).toEqual(afterFirst);
  });

  it('refuses to clobber a row that changed after the plan was built', () => {
    // PerfectMind re-ingests roughly every two hours (docs §9) and the LLM age-fallback runs on
    // its own schedule, so this is a real interleaving, not a hypothetical one.
    const table = tableFrom(rows);
    const plan = buildPlan(rows);
    const target = plan.corrections[0].occurrenceId;

    // Between the read-only SELECT and the UPDATE, the vendor starts publishing a real age.
    table.set(target, { ageMinMonths: 60, ageMaxMonths: 120, ageNotes: null, bandCount: 2 });

    expect(fakeApply(table, correctionParams(target))).toBe(0);
    expect(table.get(target)).toEqual({ ageMinMonths: 60, ageMaxMonths: 120, ageNotes: null, bandCount: 2 });
  });

  it('clears every column that carries the claim — bounds, bands and notes', () => {
    const setClause = CORRECTION_UPDATE_SQL.split(/\bWHERE\b/i)[0];
    expect(setClause).toMatch(/age_min_months\s*=\s*NULL/i);
    expect(setClause).toMatch(/age_max_months\s*=\s*NULL/i);
    // The bands are what make a stale row match every age filter; clearing bounds alone would
    // leave the row still answering a search for a six-month-old.
    expect(setClause).toMatch(/age_band_matches\s*=\s*'\{\}'::uuid\[\]/i);
    // NULL, not a provenance stamp: age_notes is returned verbatim to unauthenticated callers
    // by /api/search and only two internal prefixes are stripped there.
    expect(setClause).toMatch(/age_notes\s*=\s*NULL/i);
  });
});

describe('M1 withheld-backfill — the write surface refuses anything but the reviewed statement', () => {
  it('accepts the statement this tool actually runs', () => {
    expect(() => assertCorrectionStatement(CORRECTION_UPDATE_SQL)).not.toThrow();
  });

  it.each([
    ['a different table', `UPDATE activity_occurrence SET archived_at = now() WHERE occurrence_id = $1 AND x = $2`],
    ['a DELETE', `DELETE FROM occurrence_age WHERE occurrence_id = $1`],
    ['no pre-state guard', `UPDATE occurrence_age SET age_notes = NULL WHERE occurrence_id = $1`],
    ['no id predicate', `UPDATE occurrence_age SET age_notes = NULL WHERE age_notes = $1 AND age_min_months = $2`],
    ['a join-update', `UPDATE occurrence_age SET age_notes = NULL FROM activity_occurrence o WHERE occurrence_id = $1 AND o.id = $2`],
    ['a RETURNING clause', `UPDATE occurrence_age SET age_notes = NULL WHERE occurrence_id = $1 AND age_notes = $2 RETURNING *`],
    ['stacked statements', `UPDATE occurrence_age SET age_notes = NULL WHERE occurrence_id = $1 AND age_notes = $2; DROP TABLE occurrence_age`],
  ])('refuses %s', (_label, sql) => {
    expect(() => assertCorrectionStatement(sql)).toThrow();
  });
});
