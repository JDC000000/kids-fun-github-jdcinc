// tests/scheduler/robots-override-db.test.ts — F-5, the DB half.
//
// THE BUG THIS FILE EXISTS FOR. The robots clearance rule is enforced by TWO independent
// machines that never call each other:
//   • worker/core/source-runner.ts — evaluateLiveFetchGate(), per run, in TypeScript;
//   • worker/scheduler/tiered.ts   — a set-based SQL predicate deciding what is ever
//                                     enqueued at all.
// QA found, while this change was being scoped, that fixing only the first would produce
// the worst possible outcome: NVDPL passes every "is this source allowed?" check a human
// or a log would consult, and the scheduler silently never enqueues it. No error, no
// failed run, no health signal — a source that is enabled and simply never happens.
//
// So the central test here is not "does the override work". It is an EQUIVALENCE: for a
// matrix of source rows spanning every terms/robots/override combination, what the
// scheduler actually enqueues against a real database must match, row for row, what the
// TypeScript gate says. Fix one side only and this goes red naming the exact row. Add a
// third enforcement point later and the matrix is already here to point it at.
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { enqueueDueJobs } from '../../worker/scheduler/tiered';
import { evaluateLiveFetchGate, isRobotsClearedForLiveFetch } from '../../worker/core/terms-gate';
import { loadSourceForIngest } from '../../worker/core/source-runner';
import { getPool, query, closePool } from '../../lib/db/client';

const hasDb = Boolean(process.env.DATABASE_URL);
const TAG = `f5robots_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

interface Case {
  label: string;
  termsStatus: string;
  robotsStatus: string;
  override: string | null;
  /** Stated by hand, not derived — a matrix that computes its own expectation proves nothing. */
  expectRunnable: boolean;
}

/**
 * Every combination that can legally exist in the table, with the verdict written out
 * literally. The 'unknown' pair in the middle is the entire point of F-5: identical
 * robots_status, opposite verdicts, and the ONLY thing separating them is whether a human
 * decision record is actually named.
 */
const CASES: Case[] = [
  { label: 'allowed robots, approved terms (every live source today)', termsStatus: 'summarise_only', robotsStatus: 'allowed', override: null, expectRunnable: true },
  { label: 'allowed robots, terms allowed', termsStatus: 'allowed', robotsStatus: 'allowed', override: null, expectRunnable: true },
  { label: 'pending robots (never checked)', termsStatus: 'summarise_only', robotsStatus: 'pending', override: null, expectRunnable: false },
  { label: 'disallowed robots (read, and it said no)', termsStatus: 'summarise_only', robotsStatus: 'disallowed', override: null, expectRunnable: false },
  { label: 'unknown robots, NO decision — never checked, stays closed', termsStatus: 'summarise_only', robotsStatus: 'unknown', override: null, expectRunnable: false },
  { label: 'unknown robots + decision D-12 — the NVDPL case', termsStatus: 'summarise_only', robotsStatus: 'unknown', override: 'D-12', expectRunnable: true },
  { label: 'unknown robots + decision, but terms still pending', termsStatus: 'pending', robotsStatus: 'unknown', override: 'D-12', expectRunnable: false },
  { label: 'unknown robots + decision, but terms disallowed', termsStatus: 'disallowed', robotsStatus: 'unknown', override: 'D-12', expectRunnable: false },
  { label: 'allowed robots + a stray decision reference (override irrelevant)', termsStatus: 'allowed', robotsStatus: 'allowed', override: 'D-12', expectRunnable: true },
  { label: 'pending robots + a decision reference (override does not apply)', termsStatus: 'summarise_only', robotsStatus: 'pending', override: 'D-12', expectRunnable: false },
  { label: 'terms pending, robots allowed', termsStatus: 'pending', robotsStatus: 'allowed', override: null, expectRunnable: false },
  { label: 'terms blocked, robots allowed', termsStatus: 'blocked', robotsStatus: 'allowed', override: null, expectRunnable: false },
];

describe.skipIf(!hasDb)('F-5 unreadable-robots override: the two enforcement points agree (DB)', () => {
  const ids = new Map<string, string>();

  beforeEach(async () => {
    for (const [i, c] of CASES.entries()) {
      const [row] = await query<{ id: string }>(
        `INSERT INTO source
           (family, name, terms_status, robots_status, robots_override_decision,
            ingestion_method, baseline_cadence, next_check_at)
         VALUES ('noop', $1, $2, $3, $4, 'auto', '1 day', now() - interval '1 minute')
         RETURNING id`,
        [`${TAG} #${i} ${c.label}`, c.termsStatus, c.robotsStatus, c.override]
      );
      ids.set(c.label, row.id);
    }
  });

  afterEach(async () => {
    await query(`DELETE FROM job_queue WHERE source_id IN (SELECT id FROM source WHERE name LIKE $1)`, [`${TAG}%`]);
    await query(`DELETE FROM source WHERE name LIKE $1`, [`${TAG}%`]);
    ids.clear();
  });

  afterAll(async () => {
    await closePool();
  });

  it('the scheduler enqueues exactly the rows the terms gate would allow — row for row', async () => {
    await enqueueDueJobs(getPool());

    const enqueued = new Set(
      (
        await query<{ source_id: string }>(
          `SELECT jq.source_id FROM job_queue jq JOIN source s ON s.id = jq.source_id WHERE s.name LIKE $1`,
          [`${TAG}%`]
        )
      ).map((r) => r.source_id)
    );

    const mismatches: string[] = [];
    for (const c of CASES) {
      const id = ids.get(c.label)!;
      // The gate is read through loadSourceForIngest, NOT from the local `c` fixture: that
      // makes this a test of the real SELECT too. A query that forgets to project
      // robots_override_decision fails the gate on an authorised source, and this is where
      // that surfaces instead of in production.
      const loaded = await loadSourceForIngest(getPool(), { id });
      const gateSaysYes = evaluateLiveFetchGate(loaded, 'production').allowed;
      const schedulerSaysYes = enqueued.has(id);

      if (gateSaysYes !== c.expectRunnable) mismatches.push(`gate disagrees with the stated verdict for: ${c.label} (gate=${gateSaysYes}, expected=${c.expectRunnable})`);
      if (schedulerSaysYes !== c.expectRunnable) mismatches.push(`scheduler disagrees with the stated verdict for: ${c.label} (scheduler=${schedulerSaysYes}, expected=${c.expectRunnable})`);
      if (gateSaysYes !== schedulerSaysYes) mismatches.push(`GATE/SCHEDULER DRIFT — "${c.label}" passes one enforcement point and not the other (gate=${gateSaysYes}, scheduler=${schedulerSaysYes}). A source in this state is "enabled" and silently never runs.`);
    }

    expect(mismatches).toEqual([]);
  });

  it('loadSourceForIngest actually returns the override column (the third-gate trap)', async () => {
    const withOverride = await loadSourceForIngest(getPool(), { id: ids.get('unknown robots + decision D-12 — the NVDPL case')! });
    expect(withOverride.robotsOverrideDecision).toBe('D-12');
    expect(isRobotsClearedForLiveFetch(withOverride)).toBe(true);

    const without = await loadSourceForIngest(getPool(), { id: ids.get('unknown robots, NO decision — never checked, stays closed')! });
    expect(without.robotsOverrideDecision).toBeNull();
    expect(isRobotsClearedForLiveFetch(without)).toBe(false);
  });

  it('an override row that is NOT yet due is still not enqueued (cadence is unaffected)', async () => {
    const id = ids.get('unknown robots + decision D-12 — the NVDPL case')!;
    await query(`UPDATE source SET next_check_at = now() + interval '1 hour' WHERE id = $1`, [id]);

    await enqueueDueJobs(getPool());

    const [{ n }] = await query<{ n: string }>(`SELECT count(*)::text AS n FROM job_queue WHERE source_id = $1`, [id]);
    expect(n).toBe('0');
  });
});

describe.skipIf(!hasDb)('F-5: no source without an override changed behaviour (DB, whole table)', () => {
  afterAll(async () => {
    await closePool();
  });

  // The "provably unchanged" proof the flag asked for, taken against the REAL registry
  // rather than a fixture: for every row that carries no override — which is every row but
  // NVDPL's — the new predicate must return precisely what the pre-change one did
  // (`robots_status = 'allowed'`). Stated as an equivalence so it keeps holding as sources
  // are added, rather than as a snapshot of today's rows that rots on the next seed.
  it('every non-override row evaluates exactly as the old robots_status = allowed rule did', async () => {
    const rows = await query<{
      id: string;
      name: string;
      terms_status: string;
      robots_status: string;
      robots_override_decision: string | null;
    }>(`SELECT id, name, terms_status, robots_status, robots_override_decision FROM source WHERE robots_override_decision IS NULL`);

    expect(rows.length).toBeGreaterThan(0);
    const changed = rows.filter((r) => {
      const source = { id: r.id, termsStatus: r.terms_status, robotsStatus: r.robots_status, robotsOverrideDecision: r.robots_override_decision };
      return isRobotsClearedForLiveFetch(source) !== (r.robots_status === 'allowed');
    });
    expect(changed.map((r) => r.name)).toEqual([]);
  });

  it('the registry grants the override to at most the sources a human deliberately marked', async () => {
    const rows = await query<{ name: string; robots_status: string; robots_override_decision: string }>(
      `SELECT name, robots_status, robots_override_decision FROM source WHERE robots_override_decision IS NOT NULL`
    );
    // Not an assertion that NVDPL's seeded row is present — this suite runs against
    // databases that may or may not have had seeds applied. It asserts the shape of any
    // override that IS present: a real reference, on the one status it may speak for.
    for (const r of rows) {
      expect(r.robots_override_decision.trim(), `${r.name} carries a blank override reference`).not.toBe('');
      expect(r.robots_status, `${r.name} carries an override on robots_status=${r.robots_status}`).toBe('unknown');
    }
  });
});

describe.skipIf(!hasDb)('F-5: the DB refuses states the predicate must never have to reason about', () => {
  const NAME = `${TAG} constraint probe`;

  afterEach(async () => {
    await query(`DELETE FROM source WHERE name = $1`, [NAME]);
  });

  afterAll(async () => {
    await closePool();
  });

  const insert = (robotsStatus: string, decision: string | null, note: string | null): Promise<unknown> =>
    query(
      `INSERT INTO source (family, name, robots_status, robots_override_decision, robots_override_note)
       VALUES ('noop', $1, $2, $3, $4)`,
      [NAME, robotsStatus, decision, note]
    );

  // Belt and braces with the TS/SQL predicates, on purpose: a constraint holds for raw SQL,
  // a future admin action and a DB-backed test, none of which route through the gate.
  it('a BLANK decision reference is rejected at write time', async () => {
    await expect(insert('unknown', '', null)).rejects.toThrow(/source_robots_override_decision_nonblank/);
    await expect(insert('unknown', '   ', null)).rejects.toThrow(/source_robots_override_decision_nonblank/);
  });

  it('a note without a decision is rejected — it would read like an authorisation while granting nothing', async () => {
    await expect(insert('unknown', null, 'risk accepted, see the docs')).rejects.toThrow(
      /source_robots_override_note_needs_decision/
    );
  });

  it('an override may never sit on a source whose robots.txt was read and refused', async () => {
    await expect(insert('disallowed', 'D-12', null)).rejects.toThrow(/source_robots_override_not_on_disallowed/);
  });

  it('the legitimate NVDPL shape is accepted', async () => {
    await expect(insert('unknown', 'D-12', 'robots.txt unreadable; see docs/source-register.md §7 F-5')).resolves.toBeDefined();
  });
});
