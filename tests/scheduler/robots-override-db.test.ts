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
import {
  DECISION_REFERENCE_SQL_PATTERN,
  evaluateLiveFetchGate,
  isDecisionReference,
  isRobotsClearedForLiveFetch,
  robotsClearedForLiveFetchSql,
} from '../../worker/core/terms-gate';
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

/**
 * QA finding F-QA-1 (2026-08-01): the values the first matrix had NO case for.
 *
 * These are the inputs on which PostgreSQL's `btrim()` and JavaScript's `.trim()` disagreed
 * — a tab-only reference read as PRESENT in SQL and ABSENT in TypeScript, so the scheduler
 * enqueued a row the gate then blocked. Real drift between the two enforcement points,
 * through a door the original twelve cases never opened.
 *
 * They are checked against the PREDICATES DIRECTLY rather than by inserting rows, because
 * 0023's CHECK constraint now makes most of them unstorable — which is the fix working, and
 * would otherwise mean this regression could only be tested by first disabling the thing
 * that prevents it. The predicate layer is also strictly the stronger place to check: it is
 * where the bug actually lived, and it keeps holding on a database whose constraint has been
 * dropped.
 *
 * U+00A0 and U+2003 are here for a specific reason: the obvious fix (naming the ASCII
 * whitespace characters inside `btrim`) closes tab and newline while leaving those two
 * producing the identical disagreement.
 */
const PARITY_VALUES: Array<{ label: string; robotsStatus: string; decision: string | null }> = [
  { label: 'a single TAB', robotsStatus: 'unknown', decision: '\t' },
  { label: 'a single NEWLINE', robotsStatus: 'unknown', decision: '\n' },
  { label: 'a carriage return', robotsStatus: 'unknown', decision: '\r' },
  { label: 'a vertical tab', robotsStatus: 'unknown', decision: '\v' },
  { label: 'a form feed', robotsStatus: 'unknown', decision: '\f' },
  { label: 'spaces only', robotsStatus: 'unknown', decision: '   ' },
  { label: 'the empty string', robotsStatus: 'unknown', decision: '' },
  { label: 'U+00A0 no-break space (survives the obvious btrim fix)', robotsStatus: 'unknown', decision: '\u00a0' },
  { label: 'U+2003 em space (survives the obvious btrim fix)', robotsStatus: 'unknown', decision: '\u2003' },
  { label: 'U+FEFF zero-width no-break space', robotsStatus: 'unknown', decision: '\ufeff' },
  { label: 'a padded real reference — must NOT be silently repaired', robotsStatus: 'unknown', decision: '  D-12  ' },
  { label: 'a reference with an inner tab', robotsStatus: 'unknown', decision: 'D-\t12' },
  { label: 'a reference with an inner space', robotsStatus: 'unknown', decision: 'D 12' },
  { label: 'prose in the reference field (that is what the note column is for)', robotsStatus: 'unknown', decision: 'risk accepted, see the docs' },
  { label: 'over the 64-character bound', robotsStatus: 'unknown', decision: 'D'.repeat(65) },
  { label: 'exactly at the 64-character bound', robotsStatus: 'unknown', decision: 'D'.repeat(64) },
  { label: 'a leading punctuation character', robotsStatus: 'unknown', decision: '-D-12' },
  { label: "the real thing, 'D-12'", robotsStatus: 'unknown', decision: 'D-12' },
  { label: "another real shape, 'G-T10-2'", robotsStatus: 'unknown', decision: 'G-T10-2' },
  { label: 'NULL', robotsStatus: 'unknown', decision: null },
  { label: 'a reference on an already-allowed row', robotsStatus: 'allowed', decision: 'D-12' },
  { label: 'a whitespace reference on an already-allowed row', robotsStatus: 'allowed', decision: '\t' },
  { label: 'a reference on a pending row', robotsStatus: 'pending', decision: 'D-12' },
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

describe.skipIf(!hasDb)('F-QA-1: SQL and TS agree on EVERY reference value, storable or not (DB)', () => {
  afterAll(async () => {
    await closePool();
  });

  // The regression test for the finding itself. The SQL predicate is evaluated by Postgres
  // over a VALUES list rather than over inserted rows, so it covers values 0023's constraint
  // now forbids — the drift has to stay closed at the predicate layer too, not only behind
  // the constraint, or a database that skipped 0023 quietly gets the old bug back.
  it('the two engines return the same verdict for every value, including the ones that broke it', async () => {
    const placeholders = PARITY_VALUES.map((_, i) => `($${i * 2 + 1}::text, $${i * 2 + 2}::text)`).join(', ');
    // coalesce(..., false) replicates a WHERE clause exactly: `NULL ~ pattern` is NULL, and
    // WHERE treats not-true as excluded. Making that explicit here rather than relying on
    // the reader knowing it.
    const rows = await query<{ i: number; sql_cleared: boolean }>(
      `SELECT v.i, coalesce(${robotsClearedForLiveFetchSql('v')}, false) AS sql_cleared
         FROM (SELECT row_number() OVER () - 1 AS i, *
                 FROM (VALUES ${placeholders}) AS t(robots_status, robots_override_decision)) AS v`,
      PARITY_VALUES.flatMap((v) => [v.robotsStatus, v.decision])
    );

    const disagreements: string[] = [];
    for (const row of rows) {
      const v = PARITY_VALUES[Number(row.i)];
      const tsCleared = isRobotsClearedForLiveFetch({
        id: 'parity',
        termsStatus: 'summarise_only',
        robotsStatus: v.robotsStatus,
        robotsOverrideDecision: v.decision,
      });
      if (tsCleared !== row.sql_cleared) {
        disagreements.push(`${v.label} (robots_status=${v.robotsStatus}): TypeScript says ${tsCleared}, Postgres says ${row.sql_cleared}`);
      }
    }

    expect(disagreements).toEqual([]);
    expect(rows).toHaveLength(PARITY_VALUES.length);
  });

  it('only the well-formed references clear, and they are the ones we expect', async () => {
    // Guards the other direction: a predicate that returned false for EVERYTHING would pass
    // the agreement test above perfectly.
    const cleared = PARITY_VALUES.filter((v) =>
      isRobotsClearedForLiveFetch({ id: 'p', termsStatus: 'summarise_only', robotsStatus: v.robotsStatus, robotsOverrideDecision: v.decision })
    ).map((v) => v.label);

    expect(cleared.sort()).toEqual(
      [
        'a reference on an already-allowed row',
        'a whitespace reference on an already-allowed row', // cleared by robots_status, not by the reference
        'exactly at the 64-character bound',
        "another real shape, 'G-T10-2'",
        "the real thing, 'D-12'",
      ].sort()
    );
  });

  it('the DB constraint and the TypeScript pattern are literally the same pattern', async () => {
    // The last place these two could drift: the migration hard-codes the pattern (migrations
    // are static SQL and cannot import it), so this reads it back out of the catalog and
    // compares. Edit one copy and forget the other, and this names it.
    const [row] = await query<{ def: string }>(
      `SELECT pg_get_constraintdef(c.oid) AS def
         FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
        WHERE t.relname = 'source' AND c.conname = 'source_robots_override_decision_shape'`
    );
    expect(row, 'migration 0023 has not been applied to this database').toBeDefined();
    expect(row.def).toContain(DECISION_REFERENCE_SQL_PATTERN);

    // …and the pattern is actually the one that rejects whitespace, not just any string.
    expect(isDecisionReference('D-12')).toBe(true);
    expect(isDecisionReference('\t')).toBe(false);
    expect(isDecisionReference(' ')).toBe(false);
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
  // F-QA-1: the constraint no longer asks "is it blank?" — a question Postgres and JavaScript
  // answered differently — but "is it shaped like a decision reference?", which they answer
  // identically. Every value below is one the old btrim()-based constraint ACCEPTED while the
  // TypeScript gate rejected it, i.e. every one of them was a live gate/scheduler drift.
  it.each([
    ['the empty string', ''],
    ['spaces only', '   '],
    ['a single TAB', '\t'],
    ['a single NEWLINE', '\n'],
    ['U+00A0 no-break space', ' '],
    ['U+2003 em space', ' '],
    ['a padded real reference', '  D-12  '],
    ['a reference with an inner space', 'D 12'],
    ['prose instead of a reference', 'risk accepted, see the docs'],
    ['over the 64-character bound', 'D'.repeat(65)],
  ])('a malformed decision reference (%s) is rejected at write time', async (_label, value) => {
    await expect(insert('unknown', value, null)).rejects.toThrow(/source_robots_override_decision_shape/);
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
