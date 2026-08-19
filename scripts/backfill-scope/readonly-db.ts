// scripts/backfill-scope/readonly-db.ts — the ONLY database access this measurement tool has,
// and it cannot write. Not "does not write" — CANNOT.
//
// WHY THIS FILE EXISTS AT ALL. §3h's remediation question is "which stored rows would today's
// fixed parsers disagree with?", and the only honest way to answer it is against production,
// because production is where the stale rows are. That is a read of live parent-facing data by
// a tool whose entire purpose is to reason about correcting it — exactly the situation in which
// an accidental write is most plausible and least acceptable. The Operator's 73-row PerfectMind
// stopgap was done BY HAND, deliberately, on the standing rule that automated correction at
// scale on live rows is a bigger risk than a stale row sitting there a while longer. This module
// is the mechanical expression of that rule.
//
// THREE INDEPENDENT LOCKS, so that defeating this needs a deliberate edit to this file and not
// merely a careless call somewhere else:
//
//   1. POSTGRES-ENFORCED. Every statement runs inside an explicit `BEGIN TRANSACTION READ ONLY`.
//      The server, not this process, rejects INSERT/UPDATE/DELETE/TRUNCATE/COPY-in/DDL with
//      SQLSTATE 25006. A bug in the guard below, a mistake in a caller, or a hostile string
//      still cannot mutate a row: the transaction is read-only before the statement is parsed.
//      The session default is set read-only too, so even a statement issued outside the helper
//      inherits it.
//   2. STATEMENT-SHAPE GUARD. `query()` refuses anything whose first keyword is not SELECT or
//      WITH, refuses a `;` outside a string literal (no statement stacking), and refuses the
//      writing forms of WITH (`WITH … INSERT/UPDATE/DELETE`), which ARE legal in Postgres and
//      would otherwise slip past a naive "starts with WITH" check. This fails FAST and with a
//      readable message, which is what makes the lock useful during development rather than a
//      surprise at runtime.
//   3. NO WRITE SURFACE IS IMPORTED. This module exports `query` and nothing else. It does not
//      import, re-export or wrap `upsertOccurrenceAge`, `upsertOccurrence`, or any other writer
//      in worker/core/. The measurement driver has no route to one.
//
// WHAT IT DELIBERATELY DOES NOT DO: no migration, no temp table, no `SET` beyond the read-only
// characteristic, no advisory lock, no long-lived transaction spanning the whole run. Each query
// is its own short read-only transaction, so this tool cannot hold a lock that would matter to
// the ingestion worker running concurrently against the same database.
import { Client } from 'pg';

/** Postgres error class for "cannot execute X in a read-only transaction". */
export const READ_ONLY_SQLSTATE = '25006';

const SELECT_ONLY = /^\s*(?:select|with)\b/i;
/**
 * A data-modifying CTE — `WITH x AS (...) INSERT ...`, and the `WITH x AS (INSERT ...)` form
 * too. Both are valid Postgres and both write. Lock 1 would stop them regardless; this is here
 * so the failure is a clear message from this file rather than a bare SQLSTATE from the server.
 */
const WRITING_CTE = /\b(?:insert\s+into|update\s+\w|delete\s+from|merge\s+into)\b/i;

/**
 * Reject a `;` that is not inside a single-quoted literal, i.e. statement stacking. Dollar
 * quoting is not handled and does not need to be: a `$$` body would have to survive the
 * SELECT/WITH check above and then Lock 1 anyway.
 */
function hasStatementSeparator(sql: string): boolean {
  let inLiteral = false;
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    if (ch === "'") {
      // '' inside a literal is an escaped quote, not a close.
      if (inLiteral && sql[i + 1] === "'") i += 1;
      else inLiteral = !inLiteral;
    } else if (ch === ';' && !inLiteral) {
      // A trailing `;` with only whitespace after it is a formatting habit, not stacking.
      if (sql.slice(i + 1).trim().length > 0) return true;
    }
  }
  return false;
}

export interface ReadOnlyDb {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  end(): Promise<void>;
}

/**
 * Open a read-only connection. `connectionString` is passed in by the caller (which reads it
 * from the environment) — this module never touches `process.env`, so it cannot silently pick
 * up a different, more privileged URL than the one the operator intended.
 */
export async function openReadOnly(connectionString: string): Promise<ReadOnlyDb> {
  const client = new Client({
    connectionString,
    // Supabase presents a managed cert chain Node does not bundle; the wire is still
    // encrypted. Same posture as worker/src/db.ts, for the same reason.
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 20_000,
    statement_timeout: 120_000,
    application_name: 'kf-backfill-scope-readonly',
  });
  await client.connect();
  // Belt: the session default. Braces: the per-statement transaction below.
  await client.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');

  return {
    async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
      if (!SELECT_ONLY.test(sql)) {
        throw new Error(`readonly-db: refused a statement that is not SELECT/WITH:\n${sql.slice(0, 200)}`);
      }
      if (WRITING_CTE.test(sql)) {
        throw new Error(`readonly-db: refused a data-modifying CTE:\n${sql.slice(0, 200)}`);
      }
      if (hasStatementSeparator(sql)) {
        throw new Error(`readonly-db: refused stacked statements:\n${sql.slice(0, 200)}`);
      }
      await client.query('BEGIN TRANSACTION READ ONLY');
      try {
        const { rows } = await client.query(sql, params);
        return rows as T[];
      } finally {
        // COMMIT on a read-only transaction releases the snapshot; ROLLBACK would do as well.
        await client.query('COMMIT').catch(() => client.query('ROLLBACK').catch(() => undefined));
      }
    },
    async end() {
      await client.end();
    },
  };
}
