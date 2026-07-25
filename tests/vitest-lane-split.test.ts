// tests/vitest-lane-split.test.ts — H3 drift guard for the two-lane test split.
//
// vitest.workspace.ts routes every test file into one of two lanes: `unit` (parallel) or
// `db` (serial, one file at a time, because those suites share a single Postgres and read
// GLOBAL aggregates around their own writes). The routing is an explicit list, which is
// exactly the kind of thing that rots: add a DB-backed suite, forget the list, and it runs
// concurrently with the other DB suites — silently reintroducing the Round 21 flakiness
// class this split exists to contain, and only on unlucky CI runs.
//
// So the list is not a convention anyone has to remember: this test derives, statically,
// which files CAN execute real SQL and asserts that set is EXACTLY the db lane. It is a
// pure test (no DB, no vitest internals) and runs in the unit lane itself.
//
// The two detection signals, which between them cover every DB suite in the repo today:
//   1. a value import of lib/db/client or lib/db/user-scoped-client (the only modules that
//      construct a pg Pool) that is not neutralised by a vi.mock of the same specifier; and
//   2. the repo-wide DB-gate idiom — `Boolean(process.env.DATABASE_URL)` /
//      `describe.skipIf(!process.env.DATABASE_URL)` — which catches suites that reach
//      Postgres indirectly (route handlers, the evals harness) rather than via an import.
// A `delete process.env.DATABASE_URL` (the "force the no-DB path" idiom) is deliberately
// NOT a signal: those files prove the DB-less branch and never connect.
//
// If this test fails, do not edit the detector to make it pass — move the named file into
// (or out of) DB_INTEGRATION_SUITES in vitest.workspace.ts.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DB_INTEGRATION_SUITES } from '../vitest.workspace';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Mirrors vitest.workspace.ts's TEST_INCLUDE roots. */
const TEST_ROOTS = ['tests', 'app', 'evals', 'components'];

/**
 * This file quotes the very patterns it scans for, so it matches its own source. Exempt it
 * by name (and assert below that it really is in the unit lane) rather than contorting the
 * patterns to be self-avoiding, which would make them harder to read and easier to break.
 */
const SELF = 'tests/vitest-lane-split.test.ts';

/** A value (not type-only) import of a module that constructs a pg Pool. */
const DB_CLIENT_IMPORT =
  /^\s*import\s+(?!type\b)[^;]*?from\s+['"](?:@\/|(?:\.\.\/)+)lib\/db\/(?:client|user-scoped-client)['"]/m;
/** …unless the file mocks that same seam away. */
const DB_CLIENT_MOCK = /vi\.mock\(\s*['"](?:@\/|(?:\.\.\/)+)lib\/db\/(?:client|user-scoped-client)['"]/;
/** The repo's DB-gate idiom: skipIf(!process.env.DATABASE_URL) / Boolean(process.env.DATABASE_URL). */
const DB_GATE = /(?:skipIf\([^)]*|Boolean\(\s*)process\.env\.(?:USER_)?DATABASE_URL/;

function listTestFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'e2e') continue;
        walk(full);
      } else if (/\.test\.tsx?$/.test(entry.name)) {
        found.push(relative(ROOT, full).split(sep).join('/'));
      }
    }
  };
  for (const root of TEST_ROOTS) walk(join(ROOT, root));
  return found.sort();
}

function reachesRealPostgres(file: string): boolean {
  const src = readFileSync(join(ROOT, file), 'utf8');
  return (DB_CLIENT_IMPORT.test(src) && !DB_CLIENT_MOCK.test(src)) || DB_GATE.test(src);
}

describe('vitest lane split (H3)', () => {
  const files = listTestFiles();

  it('discovers the whole suite (no vacuous pass on a bad walk)', () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain('tests/analytics/kpi.test.ts'); // a db-lane sentinel
    expect(files).toContain('tests/smoke.test.ts'); // a unit-lane sentinel
  });

  it('this guard itself stays in the parallel unit lane', () => {
    expect(files).toContain(SELF);
    expect(DB_INTEGRATION_SUITES).not.toContain(SELF);
  });

  it('every test file that can execute real SQL is in the db (serial) lane', () => {
    const missing = files.filter(
      (f) => f !== SELF && reachesRealPostgres(f) && !DB_INTEGRATION_SUITES.includes(f)
    );
    expect(
      missing,
      `these files reach the shared Postgres but are in the parallel unit lane — add them to ` +
        `DB_INTEGRATION_SUITES in vitest.workspace.ts:\n  ${missing.join('\n  ')}`
    ).toEqual([]);
  });

  it('the db lane contains no stale entries and nothing that cannot reach Postgres', () => {
    const known = new Set(files);
    const stale = DB_INTEGRATION_SUITES.filter((f) => !known.has(f));
    expect(stale, `DB_INTEGRATION_SUITES lists files that no longer exist:\n  ${stale.join('\n  ')}`).toEqual([]);

    const overIncluded = DB_INTEGRATION_SUITES.filter((f) => known.has(f) && !reachesRealPostgres(f));
    expect(
      overIncluded,
      `these files are serialised but never touch the database — move them to the unit lane:\n  ` +
        `${overIncluded.join('\n  ')}`
    ).toEqual([]);
  });

  it('the two lanes partition the suite — every file runs exactly once', () => {
    const db = new Set(DB_INTEGRATION_SUITES);
    expect(db.size).toBe(DB_INTEGRATION_SUITES.length); // no duplicates
    const unit = files.filter((f) => !db.has(f));
    expect(unit.length + db.size).toBe(files.length);
  });
});
