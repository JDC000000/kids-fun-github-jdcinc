// tests/scheduler/__fixtures__/pool-drop-worker.cjs — A REAL, SEPARATE OS PROCESS whose Postgres
// connections get killed out from under it.
//
// WHY A CHILD PROCESS. The defect is that a dropped connection is thrown as an UNCAUGHT exception
// and kills the process. That can only be observed from outside the process: inside vitest's
// worker it would either take the runner down or be swallowed by vitest's own handlers. The parent
// test reads this process's exit code and stdout.
//
// It loads the COMPILED worker (worker/dist/**, built by the test's beforeAll — the same build
// worker/Dockerfile runs), so the pool under test comes from the real createPool() and the queue
// calls are the real worker/core/queue.ts primitives the scheduler uses.
//
// Parameters (env):
//   DATABASE_URL
//   FIXTURE_POOL = 'worker' — createPool() exactly as the worker builds it (the fix under test)
//                | 'bare'   — `new Pool(...)` with no listeners: the pool as it was before the fix
//   FIXTURE_TAG  — unique per run; used as application_name (to find OUR backends in
//                  pg_stat_activity) and as the job_type of every job this process enqueues.
//
// Protocol: one `STEP <json>` line per completed step on stdout, then `ALL_STEPS_OK` and exit 0.
// A crash (the bug) surfaces as a non-zero exit before `ALL_STEPS_OK`.
'use strict';

const path = require('node:path');

const DIST = path.join(__dirname, '..', '..', '..', 'worker', 'dist', 'worker');
const { Pool, Client } = require(require.resolve('pg', { paths: [DIST] }));
const { createPool } = require(path.join(DIST, 'src', 'db.js'));
const { enqueue, dequeue, markDone, pollLoop } = require(path.join(DIST, 'core', 'queue.js'));

const DATABASE_URL = process.env.DATABASE_URL;
const TAG = process.env.FIXTURE_TAG;
const MODE = process.env.FIXTURE_POOL;
if (!DATABASE_URL || !TAG || (MODE !== 'worker' && MODE !== 'bare')) {
  console.error('fixture needs DATABASE_URL, FIXTURE_TAG and FIXTURE_POOL=worker|bare');
  process.exit(64);
}
// pg reads PGAPPNAME for application_name; createPool takes only a connection string.
process.env.PGAPPNAME = TAG;

// Oldest possible scheduled_for, so dequeue() — ORDER BY scheduled_for — claims OUR job first on
// a shared test database even if some other suite left a due row behind. Asserted, not assumed.
const LONG_AGO = new Date('2000-01-01T00:00:00Z');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (name, detail = {}) => console.log(`STEP ${JSON.stringify({ name, ...detail })}`);

async function main() {
  const pool = MODE === 'worker' ? createPool(DATABASE_URL) : new Pool({ connectionString: DATABASE_URL });
  // The killer sits OUTSIDE the pool under test, so killing pool backends never kills it.
  const admin = new Client({ connectionString: DATABASE_URL, application_name: `${TAG}-admin` });
  await admin.connect();
  const ourBackends = async (predicateSql) => {
    const { rows } = await admin.query(
      `SELECT pid FROM pg_stat_activity WHERE application_name = $1 AND ${predicateSql}`,
      [TAG]
    );
    return rows.map((r) => r.pid);
  };
  const terminate = async (pids) => {
    await admin.query('SELECT pg_terminate_backend(pid) FROM unnest($1::int[]) AS pid', [pids]);
  };
  const assertOwnJob = (job, expectedId, where) => {
    if (!job || job.id !== expectedId) {
      throw new Error(`${where}: dequeue claimed ${job ? job.id : 'nothing'}, expected our job ${expectedId}`);
    }
  };

  step('pool_built', { mode: MODE, poolErrorListeners: pool.listenerCount('error') });

  // ── 1. IDLE connection dropped ────────────────────────────────────────────────────────────
  // Two concurrent queries so the pool genuinely holds two idle connections, then kill both.
  await Promise.all([pool.query('SELECT pg_sleep(0.05)'), pool.query('SELECT pg_sleep(0.05)')]);
  const idlePids = await ourBackends(`state = 'idle'`);
  if (idlePids.length === 0) throw new Error('no idle pooled backend found to terminate');
  // Reported BEFORE the kill: without the fix the process can die while terminate() is still
  // awaiting its own reply, and a step printed afterwards would then never appear.
  step('idle_backends_terminated', { pids: idlePids });
  await terminate(idlePids);
  await sleep(750); // the termination arrives asynchronously; give the process time to (not) die

  const jobId = await enqueue(pool, null, TAG, LONG_AGO);
  const job = await dequeue(pool, `${TAG}-worker`);
  assertOwnJob(job, jobId, 'after idle drop');
  await markDone(pool, jobId);
  const done = await admin.query('SELECT status FROM job_queue WHERE id = $1', [jobId]);
  step('queue_works_after_idle_drop', { jobId, status: done.rows[0].status });

  // ── 2. CHECKED-OUT connection dropped between queries (pool.connect(), as global-jobs.ts) ─
  const client = await pool.connect();
  await client.query('BEGIN');
  const { rows: pidRows } = await client.query('SELECT pg_backend_pid() AS pid');
  await terminate([pidRows[0].pid]);
  await sleep(750);
  const afterDrop = await client.query('SELECT 1').then(
    () => 'resolved',
    (err) => `rejected: ${err.message}`
  );
  await client.query('ROLLBACK').catch(() => undefined);
  client.release();
  const probe = await pool.query('SELECT 42 AS ok');
  step('checked_out_drop_survived', { queryOnDeadClient: afterDrop, poolQueryAfter: probe.rows[0].ok });

  // ── 3. The connection running an IN-FLIGHT JOB is dropped ─────────────────────────────────
  // pollLoop is the queue's own claim → handler → markDone/markFailed cycle (same primitives
  // and the same catch-then-markFailed shape as the scheduler's processOneJob). The handler's
  // query is killed mid-execution; the job must come back as a retryable failure, not be
  // stranded in 'running' and not take the process with it.
  // NOT NEW BEHAVIOUR: pool.query carries pg-pool's own per-query error listener, so the pre-fix
  // pool already did exactly this (verified on base 24386b0). Pinned here as a regression guard
  // for the job path, not as evidence for the fix — the fix is what steps 1 and 2 prove.
  const inflightId = await enqueue(pool, null, TAG, LONG_AGO);
  const abort = new AbortController();
  let handlerSawJob = null;
  const marker = `kf_pool_drop_inflight_${TAG.replace(/[^a-z0-9_]/gi, '_')}`;
  const loop = pollLoop(
    pool,
    async (claimed) => {
      // Stop after THIS claim: pollLoop checks the signal only at the top of its loop, so
      // aborting here means exactly one dequeue — it can never go on to claim a job some
      // other suite owns once ours is back to pending.
      abort.abort();
      handlerSawJob = claimed.id;
      if (claimed.id !== inflightId) throw new Error(`claimed foreign job ${claimed.id}`);
      await pool.query(`SELECT pg_sleep(30) AS ${marker}`);
    },
    { intervalMs: 100, signal: abort.signal }
  );
  let inflightKilled = [];
  for (let i = 0; i < 100 && inflightKilled.length === 0; i++) {
    await sleep(100);
    inflightKilled = await ourBackends(`state = 'active' AND query LIKE '%${marker}%'`);
  }
  await terminate(inflightKilled);
  if (inflightKilled.length === 0) throw new Error('in-flight job query never appeared to terminate');
  let row;
  for (let i = 0; i < 50; i++) {
    await sleep(100);
    row = (await admin.query('SELECT status, attempts, last_error FROM job_queue WHERE id = $1', [inflightId])).rows[0];
    if (row.status !== 'running') break;
  }
  await loop;
  if (handlerSawJob !== inflightId) throw new Error(`pollLoop ran ${handlerSawJob}, expected ${inflightId}`);
  step('inflight_job_drop_handled', {
    jobId: inflightId,
    pids: inflightKilled,
    status: row.status,
    attempts: row.attempts,
    lastError: row.last_error,
  });

  const after = await pool.query('SELECT 42 AS ok');
  step('pool_still_serving', { ok: after.rows[0].ok });

  await pool.end();
  await admin.end();
  console.log('ALL_STEPS_OK');
}

main().catch((err) => {
  console.error(`FIXTURE_FAILED ${err && err.stack ? err.stack : err}`);
  process.exit(2);
});
