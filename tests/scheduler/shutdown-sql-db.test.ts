// tests/scheduler/shutdown-sql-db.test.ts — H6 FIX B, QA finding A2: the shutdown SQL,
// executed by REAL Postgres against the real schema.
//
// WHY THIS FILE EXISTS. tests/scheduler/shutdown.test.ts asserts the shape of these two
// statements as substrings against a stub pool — which proves the text says what we meant,
// and nothing about what Postgres does with it. QA demonstrated the gap empirically:
// widening the check-run predicate from
//     started_at >= $2
// to
//     started_at >= $2::timestamptz - interval '365 days'
// leaves that whole suite 16/16 green while silently destroying the ONLY thing that
// predicate exists to guarantee — that a shutdown closes out this process's own claim
// window and nothing else. With it widened, a shutdown would also swallow rows stranded by
// an EARLIER crash and relabel them "shut down cleanly", stealing them from the 30-minute
// reconciliation sweep that is supposed to own them and destroying the audit distinction
// between "we stopped this" and "a process died and we do not know what it wrote".
//
// So the scoping is asserted here against real SQL semantics, where a widening edit fails.
// Ported from QA's preserved harness (documents/kidsfun-qa/h6-qa-harness/qa-h6/), adapted
// to this repo's db-lane conventions: lib/db/client, describe.skipIf, and no INSERT into
// `source` (several suites assert global source-count identities, so this reuses existing
// rows instead of minting its own).
//
// Registered in DB_INTEGRATION_SUITES (vitest.workspace.ts) — it executes real SQL.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { getPool, query, closePool } from '../../lib/db/client';
import { abandonInFlightRuns } from '../../worker/src/shutdown';

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('H6 shutdown SQL against real Postgres (QA A2)', () => {
  /** Two DISTINCT existing sources — the cross-source scoping case needs a neighbour. */
  let sourceA: string;
  let sourceB: string;
  const jobIds: string[] = [];
  const runIds: string[] = [];

  beforeAll(async () => {
    const rows = await query<{ id: string }>(`SELECT id FROM source ORDER BY id LIMIT 2`);
    expect(rows.length, 'this suite needs at least two seeded sources').toBe(2);
    sourceA = rows[0].id;
    sourceB = rows[1].id;
  });

  afterEach(async () => {
    if (runIds.length > 0) {
      await query(`DELETE FROM source_check_run WHERE id = ANY($1::uuid[])`, [runIds]);
      runIds.length = 0;
    }
    if (jobIds.length > 0) {
      await query(`DELETE FROM job_queue WHERE id = ANY($1::uuid[])`, [jobIds]);
      jobIds.length = 0;
    }
  });

  afterAll(async () => {
    await closePool();
  });

  async function seedJob(
    sourceId: string,
    opts: { attempts?: number; maxAttempts?: number; status?: string } = {}
  ): Promise<string> {
    const [row] = await query<{ id: string }>(
      `INSERT INTO job_queue (source_id, job_type, status, attempts, max_attempts, locked_at, locked_by)
       VALUES ($1, 'ingest', $2, $3, $4, now(), 'h6-test-worker') RETURNING id`,
      [sourceId, opts.status ?? 'running', opts.attempts ?? 1, opts.maxAttempts ?? 5]
    );
    jobIds.push(row.id);
    return row.id;
  }

  async function seedCheckRun(sourceId: string, startedAt: Date, status = 'running'): Promise<string> {
    const [row] = await query<{ id: string }>(
      `INSERT INTO source_check_run (source_id, started_at, status) VALUES ($1, $2, $3) RETURNING id`,
      [sourceId, startedAt, status]
    );
    runIds.push(row.id);
    return row.id;
  }

  const runStatus = async (id: string): Promise<string> =>
    (await query<{ status: string }>(`SELECT status FROM source_check_run WHERE id = $1`, [id]))[0].status;

  const jobRow = async (id: string) =>
    (
      await query<{ status: string; locked_at: string | null; locked_by: string | null; last_error: string | null }>(
        `SELECT status, locked_at, locked_by, last_error FROM job_queue WHERE id = $1`,
        [id]
      )
    )[0];

  it('closes ONLY the check run inside this process’s claim window', async () => {
    // THE A2 ASSERTION. Widening `started_at >= $2` by any interval makes `older` flip to
    // 'failed' and fails this test — which the stub-based suite cannot detect at all.
    const claimedAt = new Date(Date.now() - 60_000);
    const job = await seedJob(sourceA);
    const mine = await seedCheckRun(sourceA, new Date(claimedAt.getTime() + 1_000));
    const older = await seedCheckRun(sourceA, new Date(claimedAt.getTime() - 600_000));
    const otherSource = await seedCheckRun(sourceB, new Date(claimedAt.getTime() + 1_000));
    const alreadyDone = await seedCheckRun(sourceA, new Date(claimedAt.getTime() + 2_000), 'success');

    const result = await abandonInFlightRuns(getPool(), [{ jobId: job, sourceId: sourceA, claimedAt }]);

    expect(result).toEqual({ jobs: 1, checkRuns: 1 });
    expect(await runStatus(mine), 'this process’s own run is closed out').toBe('failed');
    // Stranded by an EARLIER crash: not ours to relabel — it belongs to the 30-minute sweep,
    // which records a different (and truthful) cause.
    expect(await runStatus(older), 'a pre-claim run must be left for reconcileAbandonedRuns').toBe('running');
    expect(await runStatus(otherSource), 'another source’s run must be untouched').toBe('running');
    expect(await runStatus(alreadyDone), 'a finished run must not be clobbered').toBe('success');
  });

  it('writes a distinguishable cause and a real duration', async () => {
    const claimedAt = new Date(Date.now() - 30_000);
    const job = await seedJob(sourceA);
    const mine = await seedCheckRun(sourceA, new Date(claimedAt.getTime() + 1_000));

    await abandonInFlightRuns(getPool(), [{ jobId: job, sourceId: sourceA, claimedAt }]);

    const [row] = await query<{ errors: unknown; duration_ms: number | null }>(
      `SELECT errors, duration_ms FROM source_check_run WHERE id = $1`,
      [mine]
    );
    // Distinct from reconcile's 'abandoned_run': the health board must be able to tell a
    // deliberate shutdown from a process that died without saying anything.
    expect(JSON.stringify(row.errors)).toContain('shutdown_abandoned_run');
    expect(row.duration_ms).toBeGreaterThan(0);
  });

  it('clamps duration_ms into int4 for an absurdly old run (the LEAST/GREATEST guard)', async () => {
    // duration_ms is `integer`. Without the clamp this INSERT-then-UPDATE would throw
    // "integer out of range" and take the whole shutdown write with it.
    const claimedAt = new Date(Date.now() - 100 * 24 * 3_600 * 1_000); // 8.64e9 ms >> int4 max
    const job = await seedJob(sourceA);
    const ancient = await seedCheckRun(sourceA, new Date(claimedAt.getTime() + 1_000));

    await abandonInFlightRuns(getPool(), [{ jobId: job, sourceId: sourceA, claimedAt }]);

    const [row] = await query<{ status: string; duration_ms: number }>(
      `SELECT status, duration_ms FROM source_check_run WHERE id = $1`,
      [ancient]
    );
    expect(row.status).toBe('failed');
    expect(Number(row.duration_ms)).toBe(2_147_483_647);
  });

  it('requeues the released job and clears its lock', async () => {
    const job = await seedJob(sourceA, { attempts: 1, maxAttempts: 5 });

    const result = await abandonInFlightRuns(getPool(), [
      { jobId: job, sourceId: sourceA, claimedAt: new Date() },
    ]);

    expect(result.jobs).toBe(1);
    const row = await jobRow(job);
    expect(row.status).toBe('pending'); // claimable again after the restart
    expect(row.locked_at).toBeNull();
    expect(row.locked_by).toBeNull();
    expect(row.last_error).toMatch(/shut down/i);
  });

  it('dead-letters an attempts-exhausted job instead of requeuing it forever', async () => {
    // Mirrors markFailed()/reconcile's policy: a source killed on every attempt must still
    // walk its normal path to dead_letter.
    const job = await seedJob(sourceA, { attempts: 5, maxAttempts: 5 });

    await abandonInFlightRuns(getPool(), [{ jobId: job, sourceId: sourceA, claimedAt: new Date() }]);

    expect((await jobRow(job)).status).toBe('dead_letter');
  });

  it('never touches a job this process does not hold, or one already finalised', async () => {
    const mine = await seedJob(sourceA);
    const notMine = await seedJob(sourceB);
    const finished = await seedJob(sourceA, { status: 'done' });

    const result = await abandonInFlightRuns(getPool(), [
      { jobId: mine, sourceId: sourceA, claimedAt: new Date() },
    ]);

    expect(result.jobs).toBe(1);
    expect((await jobRow(notMine)).status).toBe('running');
    expect((await jobRow(finished)).status).toBe('done');
  });
});
