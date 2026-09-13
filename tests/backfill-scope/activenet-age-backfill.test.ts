// tests/backfill-scope/activenet-age-backfill.test.ts — the correction plan, without a database.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  planRow,
  buildPlan,
  runLookupPhase,
  correctionParams,
  activityIdFromSourceRecordId,
  CORRECTION_UPDATE_SQL,
  MANUFACTURED_MIN_MONTHS,
  ALL_AGES_NOTES_PROXY,
  candidateParams,
  ACTIVENET_ALL_AGES_TEXT,
  REASON,
  type StoredAgeRow,
} from '../../scripts/backfill-scope/activenet-age-backfill-lib';
import { assertCorrectionStatement } from '../../scripts/backfill-scope/correcting-db';
import { parseAgeText } from '../../worker/core/age';
import {
  MANUFACTURED_MIN_MONTHS as M1_MANUFACTURED_MIN_MONTHS,
  ALL_AGES_NOTES_PROXY as M1_ALL_AGES_NOTES_PROXY,
} from '../../scripts/backfill-scope/m1-withheld-backfill-lib';

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
    const plan = buildPlan(rows, {
      answers: new Map<number, any>([
        [1, { minMonths: 228, maxMonths: null }],
        [2, { minMonths: 0, maxMonths: null, notes: 'all-ages' }],
        // id 3 deliberately absent — never asked about
      ]),
      complete: true,
      asked: 2,
      total: 3,
      haltReason: null,
    });
    expect(plan.counts).toMatchObject({ rows: 4, set: 2, leave: 1, ambiguous: 1, admitsTooYoung: 2, wasAllAges: 2 });
    expect(plan.distinctActivities).toBe(3);
    expect(plan.byReason[REASON.SET_CONTRADICTED]).toBe(2);
  });

  it('a second run over already-corrected rows writes nothing', () => {
    const corrected = row({ ageMinMonths: 228, ageMaxMonths: null, ageNotes: null });
    const plan = buildPlan([corrected], {
      answers: new Map<number, any>([[622061, { minMonths: 228, maxMonths: null }]]),
      complete: true,
      asked: 1,
      total: 1,
      haltReason: null,
    });
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


// ── THE HARD GATE: a portal failure must reach the REPORT as "never asked" ────────────────
//
// The Operator blocked the production run on this specific path, and the reviewer's bar is that
// the failure ORIGINATES AT THE FETCH/CLIENT LAYER and propagates — not hand-fed at planRow(),
// which is the boundary that already behaves correctly and is exactly why the original defect
// went unnoticed. So these drive a real stubbed fetch through the real ActiveNetAdapter client,
// the real ActivityAgeResolver, the real runLookupPhase and the real buildPlan.
import { ActivityAgeResolver, isFatalPortalError } from '../../worker/adapters/activenet/activity-age';
import { RequestBudget } from '../../worker/adapters/activenet/client';
import { getTenantConfig } from '../../worker/adapters/activenet/config';
import { clearPolicyState } from '../../worker/health/policy';

describe('a real portal failure reaches the plan as AMBIGUOUS, not as "source has no age"', () => {
  const VANCOUVER = getTenantConfig('vancouver')!;
  const NO_SLEEP = { sleepImpl: async () => {} };
  beforeEach(() => clearPolicyState());

  /** Answers for the listed ids, then returns `status` for every id after that. */
  function portalThatGivesUp(good: Record<number, Record<string, unknown>>, status: number) {
    const asked: number[] = [];
    const impl = (async (input: string | URL) => {
      const id = Number(new URL(String(input)).pathname.split('/').pop());
      asked.push(id);
      const detail = good[id];
      if (!detail) return new Response('stop', { status });
      return new Response(JSON.stringify({ headers: { response_code: '0000' }, body: { detail } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    return { asked, impl };
  }

  const rows = (ids: number[]): StoredAgeRow[] =>
    ids.map((id) => ({
      occurrenceId: `occ-${id}`,
      activityId: id,
      activityName: `Activity ${id}`,
      hasAgeRow: true,
      ageMinMonths: 0,
      ageMaxMonths: null,
      ageNotes: 'all-ages',
      bandCount: 5,
    }));

  it('a 429 part way through stops the phase and marks the run INCOMPLETE', async () => {
    const { asked, impl } = portalThatGivesUp(
      { 1: { age_description: '19 yrs +,', age_min_year: 19 }, 2: { age_description: 'All ages,' } },
      429
    );
    const resolver = new ActivityAgeResolver(VANCOUVER, {
      budget: new RequestBudget('v', 50),
      fetchImpl: impl,
      ...NO_SLEEP,
    });

    const lookup = await runLookupPhase([1, 2, 3, 4], (id) => resolver.resolve(id), isFatalPortalError);

    expect(lookup.complete).toBe(false);
    expect(lookup.asked).toBe(2);
    expect(lookup.total).toBe(4);
    expect(lookup.haltReason).toMatch(/429|rate/i);
    // and it stopped ASKING — it did not keep hammering a portal that just refused
    expect(asked).toEqual([1, 2, 3]);

    const plan = buildPlan(rows([1, 2, 3, 4]), lookup);
    expect(plan.lookupComplete).toBe(false);

    // THE WHOLE POINT: the un-asked rows must be AMBIGUOUS, never "source is silent".
    const byId = new Map(plan.decisions.map((d) => [d.activityId, d]));
    expect(byId.get(3)!.action).toBe('ambiguous');
    expect(byId.get(3)!.reason).toBe(REASON.AMBIGUOUS_LOOKUP_FAILED);
    expect(byId.get(4)!.reason).toBe(REASON.AMBIGUOUS_LOOKUP_FAILED);
    expect(byId.get(3)!.reason).not.toBe(REASON.LEAVE_SOURCE_SILENT);
    expect(plan.counts.ambiguous).toBe(2);
    // the two it DID verify are still corrected — a partial run is not a wasted one
    expect(byId.get(1)!.action).toBe('set');
  });

  it('a 403 block behaves the same way', async () => {
    const { impl } = portalThatGivesUp({ 1: { age_description: '19 yrs +,', age_min_year: 19 } }, 403);
    const resolver = new ActivityAgeResolver(VANCOUVER, { budget: new RequestBudget('v', 50), fetchImpl: impl, ...NO_SLEEP });
    const lookup = await runLookupPhase([1, 2], (id) => resolver.resolve(id), isFatalPortalError);
    expect(lookup.complete).toBe(false);
    expect(buildPlan(rows([1, 2]), lookup).decisions[1].reason).toBe(REASON.AMBIGUOUS_LOOKUP_FAILED);
  });

  it('a REAL request-cap exhaustion stops the phase — the Operator\'s named case', async () => {
    const { impl } = portalThatGivesUp(
      { 1: { age_description: '19 yrs +,', age_min_year: 19 }, 2: { age_description: 'All ages,' }, 3: { age_description: '55 yrs +,', age_min_year: 55 } },
      200
    );
    // cap of 2 => the third lookup raises RequestCapExceededError from inside the client
    const resolver = new ActivityAgeResolver(VANCOUVER, { budget: new RequestBudget('v', 2), fetchImpl: impl, ...NO_SLEEP });
    const lookup = await runLookupPhase([1, 2, 3], (id) => resolver.resolve(id), isFatalPortalError);

    expect(lookup.complete).toBe(false);
    expect(lookup.asked).toBe(2);
    expect(lookup.haltReason).toMatch(/cap/i);
    const plan = buildPlan(rows([1, 2, 3]), lookup);
    expect(plan.lookupComplete).toBe(false);
    expect(plan.decisions[2].reason).toBe(REASON.AMBIGUOUS_LOOKUP_FAILED);
  });

  it('a COMPLETE phase says so, so the flag means something', async () => {
    const { impl } = portalThatGivesUp({ 1: { age_description: '19 yrs +,', age_min_year: 19 } }, 200);
    const resolver = new ActivityAgeResolver(VANCOUVER, { budget: new RequestBudget('v', 50), fetchImpl: impl, ...NO_SLEEP });
    const lookup = await runLookupPhase([1], (id) => resolver.resolve(id), isFatalPortalError);
    expect(lookup.complete).toBe(true);
    expect(lookup.haltReason).toBeNull();
    expect(buildPlan(rows([1]), lookup).lookupComplete).toBe(true);
  });

  it('a NON-fatal error does not stop the run — it is one ambiguous row, not a halt', async () => {
    // 404 on id 2 only: the phase must continue and finish.
    const impl = (async (input: string | URL) => {
      const id = Number(new URL(String(input)).pathname.split('/').pop());
      if (id === 2) return new Response('gone', { status: 404 });
      return new Response(JSON.stringify({ headers: { response_code: '0000' }, body: { detail: { age_description: '19 yrs +,', age_min_year: 19 } } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const resolver = new ActivityAgeResolver(VANCOUVER, { budget: new RequestBudget('v', 50), fetchImpl: impl, ...NO_SLEEP });
    const lookup = await runLookupPhase([1, 2, 3], (id) => resolver.resolve(id), isFatalPortalError);
    expect(lookup.complete).toBe(true);
    expect(lookup.asked).toBe(3);
    const plan = buildPlan(rows([1, 2, 3]), lookup);
    expect(plan.decisions[1].reason).toBe(REASON.AMBIGUOUS_LOOKUP_FAILED);
    expect(plan.decisions[0].action).toBe('set');
  });
});

// ── SQL IDENTIFIERS MUST EXIST IN THE REAL SCHEMA ────────────────────────────────────────
//
// A hardcoded wrong table name is STRUCTURALLY INVISIBLE to a fixture-based suite: every test
// above passes whether the query says `occurrence` or `activity_occurrence`, because none of them
// ever meets a schema. That is the same "an untested branch is a dead branch" shape as tonight's
// other findings, moved down to the SQL layer — and it is exactly how this shipped with TWO wrong
// names (`occurrence` and `series`; Postgres only ever reports the first, so fixing the reported
// one would have failed again on the next run).
//
// This reads the migrations as the source of truth. No database required, so it runs in the normal
// unit lane rather than being skipped like the |db| tests that would otherwise be the only cover.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CANDIDATE_ROWS_SQL as CANDIDATE_SQL } from '../../scripts/backfill-scope/activenet-age-backfill-lib';

function tablesDefinedByMigrations(): Set<string> {
  const dir = join(process.cwd(), 'supabase/migrations');
  const defined = new Set<string>();
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.sql'))) {
    const sql = readFileSync(join(dir, f), 'utf8');
    for (const m of sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?([a-z_]+)/gi)) defined.add(m[1].toLowerCase());
  }
  return defined;
}

/** Table names this query reads or writes. */
function tablesReferencedBy(sql: string): string[] {
  const names = new Set<string>();
  for (const m of sql.matchAll(/\b(?:FROM|JOIN|UPDATE|INTO)\s+([a-z_][a-z0-9_]*)/gi)) {
    names.add(m[1].toLowerCase());
  }
  return [...names];
}

describe('every table the backfill names really exists in the schema', () => {
  const defined = tablesDefinedByMigrations();

  it('the migration scan finds a real schema (guards against a vacuous pass)', () => {
    // If this ever returns nothing, every assertion below passes trivially — the failure mode a
    // coverage check has to rule out about ITSELF first.
    expect(defined.size).toBeGreaterThan(20);
    expect(defined.has('activity_occurrence')).toBe(true);
    expect(defined.has('occurrence_age')).toBe(true);
  });

  it('CANDIDATE_ROWS_SQL references only real tables', () => {
    const referenced = tablesReferencedBy(CANDIDATE_SQL);
    expect(referenced.length).toBeGreaterThan(0);
    const missing = referenced.filter((t) => !defined.has(t));
    expect(missing, `tables named by the query but absent from supabase/migrations: ${missing.join(', ')}`).toEqual([]);
  });

  it('the correction UPDATE targets a real table', () => {
    const missing = tablesReferencedBy(CORRECTION_UPDATE_SQL).filter((t) => !defined.has(t));
    expect(missing, `missing: ${missing.join(', ')}`).toEqual([]);
  });

  it('rejects the exact names that shipped broken', () => {
    // The bare forms are NOT tables in this schema; naming them is the bug this test exists for.
    expect(defined.has('occurrence')).toBe(false);
    expect(defined.has('series')).toBe(false);
    expect(CANDIDATE_SQL).toMatch(/FROM activity_occurrence/);
    expect(CANDIDATE_SQL).toMatch(/JOIN activity_series/);
  });
});


// ── SCOPE IS A SAFETY PROPERTY, NOT A PERFORMANCE ONE ────────────────────────────────────
//
// This query originally filtered on family alone, which selected EVERY ActiveNet occurrence
// carrying any age row — 13,748 rows / 6,974 distinct activities against production — while
// planRow writes a correction for ANY disagreement with the source. That is a materially larger
// action than "correct the rows one parsing bug manufactured" (~227 rows / ~135 activities), and
// it is not the action that was reviewed. Verified end-to-end on a real schema: of five seeded
// ActiveNet rows, only the two carrying the manufactured triple are selected.
describe('the candidate query selects ONLY the manufactured-all-ages population', () => {
  it('pins all three parts of the pattern predicate', () => {
    expect(CANDIDATE_SQL).toMatch(/age_min_months\s*=\s*\$1/);
    expect(CANDIDATE_SQL).toMatch(/age_max_months\s+IS\s+NULL/i);
    expect(CANDIDATE_SQL).toMatch(/age_notes\s*=\s*\$2/);
  });

  it('does not select on source family alone — the defect this guards', () => {
    // Expressed as a count so that removing ANY one of the three conditions fails, not just all.
    const patternConditions = [
      /age_min_months\s*=\s*\$1/,
      /age_max_months\s+IS\s+NULL/i,
      /age_notes\s*=\s*\$2/,
    ].filter((re) => re.test(CANDIDATE_SQL)).length;
    expect(patternConditions, 'all three pattern conditions must be present').toBe(3);
  });

  it('DERIVES the pattern from the real parser rather than a fresh literal', () => {
    // Two files independently agreeing to spell a magic string the same way is a coincidence
    // waiting to lapse. These must come from parseAgeText, so a change there breaks this loudly.
    const derived = parseAgeText(ACTIVENET_ALL_AGES_TEXT);
    expect(derived.notes).toBe(ALL_AGES_NOTES_PROXY);
    expect(derived.ageMinMonths).toBe(MANUFACTURED_MIN_MONTHS);
    expect(derived.ageMaxMonths).toBeNull();
  });

  it('binds those derived values as the query parameters', () => {
    expect(candidateParams()).toEqual([0, 'all-ages']);
  });

  it('matches the shape m1-withheld-backfill already proved', () => {
    // Same triple, same derivation strategy, independently derived from PerfectMind's own phrase.
    expect(MANUFACTURED_MIN_MONTHS).toBe(M1_MANUFACTURED_MIN_MONTHS);
    expect(ALL_AGES_NOTES_PROXY).toBe(M1_ALL_AGES_NOTES_PROXY);
  });

  it('still scopes to the activenet family', () => {
    expect(CANDIDATE_SQL).toMatch(/src\.family\s*=\s*'activenet'/);
  });
});
