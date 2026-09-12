// scripts/backfill-scope/correcting-db.ts — the ONE write surface in scripts/backfill-scope/,
// and the deliberate exception to the doctrine stated in readonly-db.ts.
//
// ── WHY THIS FILE EXISTS, AND WHY IT IS A SEPARATE FILE ──────────────────────────────────
// readonly-db.ts records the standing rule this folder was built on: "automated correction at
// scale on live rows is a bigger risk than a stale row sitting there a while longer", which is
// why the Operator corrected 73 PerfectMind rows BY HAND. Tonight's population is ~200 rows of
// a safety-relevant defect and the Operator has asked for a dry-run-capable correction script,
// so the rule is being set aside DELIBERATELY, once, with sign-off — not quietly weakened.
//
// The architecture principle it rests on is NOT set aside, and this file is how that is kept
// true: IDENTIFICATION IS STILL STRUCTURALLY INCAPABLE OF WRITING. The runner plans the batch
// through readonly-db.ts with all three of its locks intact, and this module — the only thing
// that can write — is reached by a DYNAMIC import that does not execute unless `--apply` was
// passed. In a dry run the write surface is never loaded into the process at all. That is a
// stronger statement than "the flag was false", and it is checkable: the import is on one line.
//
// ── WHAT THIS MODULE WILL AND WILL NOT DO ────────────────────────────────────────────────
//   1. IT ACCEPTS ONE STATEMENT, AT OPEN TIME, AND NEVER ANOTHER. There is no `query()` export.
//      A caller cannot hand it SQL per call, because `apply()` takes parameters only. The
//      statement is captured in the closure and the rest of the process has no route to it.
//   2. THE STATEMENT MUST BE A SINGLE-ROW, PRE-STATE-GUARDED UPDATE of occurrence_age.
//      assertCorrectionStatement() below rejects anything else — a different table, a missing
//      `WHERE occurrence_id = $1`, an UPDATE … FROM, a RETURNING, a stacked statement, or an
//      UPDATE carrying no pre-state predicate beyond the id (i.e. one that could clobber a row
//      that changed after the plan was made).
//   3. EVERY APPLY IS ASSERTED TO TOUCH AT MOST ONE ROW. `occurrence_id` is the primary key, so
//      more than one would mean the statement is not the one that was reviewed; the run aborts
//      and the transaction rolls back rather than continuing.
//   4. A HARD ROW CAP, fixed at open time. A logic change that suddenly selects thousands of
//      rows hits the cap and stops instead of running.
//   5. ONE EXPLICIT TRANSACTION for the whole batch, so the correction is all-or-nothing: an
//      error part-way leaves production exactly as it was, and the count in the report is the
//      count in the database.
import { Client } from 'pg';

/** Refuse anything that is not the reviewed shape. Exported so a unit test can drive it. */
export function assertCorrectionStatement(sql: string): void {
  const flat = sql.replace(/\s+/g, ' ').trim();
  if (!/^UPDATE\s+occurrence_age\s+SET\s/i.test(flat)) {
    throw new Error(`correcting-db: refused a statement that is not an UPDATE of occurrence_age:\n${flat.slice(0, 200)}`);
  }
  if (/;\s*\S/.test(flat)) {
    throw new Error('correcting-db: refused stacked statements.');
  }
  if (/\bFROM\b/i.test(flat)) {
    throw new Error('correcting-db: refused an UPDATE … FROM — a join-update can touch rows the plan never saw.');
  }
  if (/\bRETURNING\b/i.test(flat)) {
    throw new Error('correcting-db: refused a RETURNING clause — this surface reports row counts, not rows.');
  }
  if (!/\bWHERE\s+occurrence_id\s*=\s*\$1\b/i.test(flat)) {
    throw new Error('correcting-db: refused an UPDATE whose WHERE does not begin `occurrence_id = $1`.');
  }
  // The pre-state guard is the whole reason a concurrent re-ingest cannot be clobbered. An
  // UPDATE keyed on the id alone would apply to whatever the row has become since the plan was
  // built, which is precisely the failure this tool must not have.
  if (!/\bAND\b/i.test(flat.replace(/^.*\bWHERE\b/i, ''))) {
    throw new Error('correcting-db: refused an UPDATE with no pre-state guard beyond the occurrence id.');
  }
}

export interface CorrectionDb {
  /** Run the one allow-listed statement. Returns rows affected: 1 = applied, 0 = row moved. */
  apply(params: unknown[]): Promise<number>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  end(): Promise<void>;
}

export interface CorrectionDbOptions {
  /** Hard ceiling on how many applies this handle will perform. Exceeding it aborts the run. */
  maxRows: number;
}

/**
 * Open a WRITE connection bound to exactly one statement, and BEGIN the batch transaction.
 *
 * `connectionString` is passed in by the caller (which reads it from the environment) — same
 * posture as readonly-db.ts, so this module cannot silently pick up a different database than
 * the one the Operator intended.
 */
export async function openForCorrection(
  connectionString: string,
  statement: string,
  options: CorrectionDbOptions
): Promise<CorrectionDb> {
  assertCorrectionStatement(statement);
  if (!Number.isInteger(options.maxRows) || options.maxRows <= 0) {
    throw new Error(`correcting-db: maxRows must be a positive integer (got ${options.maxRows}).`);
  }

  const client = new Client({
    connectionString,
    // Supabase presents a managed cert chain Node does not bundle; the wire is still encrypted.
    // Same posture as worker/src/db.ts and readonly-db.ts, for the same reason.
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 20_000,
    statement_timeout: 120_000,
    application_name: 'kf-m1-withheld-backfill-apply',
  });
  await client.connect();
  await client.query('BEGIN');

  let applied = 0;
  let settled = false;

  return {
    async apply(params: unknown[]): Promise<number> {
      if (settled) throw new Error('correcting-db: the batch transaction is already closed.');
      applied += 1;
      if (applied > options.maxRows) {
        throw new Error(
          `correcting-db: row cap of ${options.maxRows} exceeded. The batch is being rolled back — ` +
            're-run with an explicit --max-rows only after re-reading the plan.'
        );
      }
      const { rowCount } = await client.query(statement, params);
      if ((rowCount ?? 0) > 1) {
        throw new Error(
          `correcting-db: one apply touched ${rowCount} rows. occurrence_id is the primary key of ` +
            'occurrence_age, so this is not the statement that was reviewed. Rolling back.'
        );
      }
      return rowCount ?? 0;
    },
    async commit() {
      settled = true;
      await client.query('COMMIT');
    },
    async rollback() {
      settled = true;
      await client.query('ROLLBACK').catch(() => undefined);
    },
    async end() {
      await client.end();
    },
  };
}
