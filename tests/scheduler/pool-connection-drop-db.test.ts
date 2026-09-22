// tests/scheduler/pool-connection-drop-db.test.ts — a dropped Postgres connection must not kill
// the worker.
//
// REGRESSION, reproduced 2026-09-22. The worker's pool (worker/src/db.ts createPool) had no
// 'error' listener. pg Pool is an EventEmitter; when the server terminates an IDLE pooled backend
// (Supavisor recycling, failover, pg_terminate_backend) pg-pool re-emits that on the pool, and an
// 'error' emit with no listener is thrown. index.ts's uncaughtException handler then exit(1)'d the
// whole worker. A client checked out via pool.connect() had the same hole one level down.
//
// Everything here runs against the real test Postgres in a real child process — see
// __fixtures__/pool-drop-worker.cjs for why a mock or the runner's own process cannot show this.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closePool, query } from '../../lib/db/client';

const hasDb = Boolean(process.env.DATABASE_URL);
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURE = join(REPO_ROOT, 'tests/scheduler/__fixtures__/pool-drop-worker.cjs');

interface FixtureRun {
  code: number | null;
  stdout: string;
  stderr: string;
  steps: Record<string, Record<string, unknown>>;
}

function runFixture(mode: 'worker' | 'bare', tag: string): Promise<FixtureRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [FIXTURE], {
      cwd: REPO_ROOT,
      env: { ...process.env, FIXTURE_POOL: mode, FIXTURE_TAG: tag },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), 45_000);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      const steps: FixtureRun['steps'] = {};
      for (const line of stdout.split('\n')) {
        if (!line.startsWith('STEP ')) continue;
        const parsed = JSON.parse(line.slice(5)) as { name: string };
        steps[parsed.name] = parsed;
      }
      resolve({ code, stdout, stderr, steps });
    });
  });
}

describe.skipIf(!hasDb)('worker pool — a dropped connection is logged, not fatal', () => {
  const tags: string[] = [];
  const newTag = (): string => {
    const tag = `kf_pool_drop_${randomUUID().slice(0, 8)}`;
    tags.push(tag);
    return tag;
  };

  beforeAll(() => {
    // The same compile worker/Dockerfile runs; the fixture loads worker/dist.
    execFileSync(
      process.execPath,
      [join(REPO_ROOT, 'node_modules/typescript/bin/tsc'), '-p', join(REPO_ROOT, 'worker/tsconfig.json')],
      { cwd: REPO_ROOT, stdio: 'pipe' }
    );
  }, 120_000);

  afterAll(async () => {
    // The in-flight scenario leaves its job 'pending' with a backoff — exactly the behaviour
    // asserted — so it must not be left for another suite's dequeue to claim later.
    if (tags.length > 0) await query(`DELETE FROM job_queue WHERE job_type = ANY($1)`, [tags]);
    await closePool();
  });

  // NEGATIVE CONTROL — the original bug, still demonstrable. If this ever stops crashing, the
  // positive test below is no longer proving anything (e.g. pg started swallowing these itself).
  it('WITHOUT the handlers (the pre-fix pool): killing an idle pooled connection kills the process', async () => {
    const run = await runFixture('bare', newTag());
    expect(run.steps.pool_built?.poolErrorListeners).toBe(0);
    expect(run.steps.idle_backends_terminated, run.stderr).toBeDefined();
    expect(run.code, 'the process must have died').not.toBe(0);
    expect(run.stdout).not.toContain('ALL_STEPS_OK');
    expect(run.steps.queue_works_after_idle_drop).toBeUndefined();
    // Died of the dropped connection itself, not of something incidental.
    expect(run.stderr).toMatch(/terminating connection due to administrator command/);
    expect(run.stderr).not.toContain('FIXTURE_FAILED');
  }, 60_000);

  it('WITH createPool(): every drop is logged, the process lives, and the queue keeps working', async () => {
    const run = await runFixture('worker', newTag());
    const detail = `exit=${run.code}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`;
    expect(run.code, detail).toBe(0);
    expect(run.stdout, detail).toContain('ALL_STEPS_OK');
    expect(run.steps.pool_built.poolErrorListeners).toBeGreaterThan(0);

    // 1. Idle drop: each killed backend gets exactly one log line naming it, and the
    //    queue round-trips a job on the recovered pool.
    const idlePids = run.steps.idle_backends_terminated.pids as number[];
    expect(idlePids.length).toBeGreaterThanOrEqual(1);
    for (const pid of idlePids) {
      const lines = run.stderr.split('\n').filter((l) => l.includes(`backendPid=${pid} `));
      expect(lines, `log lines for backend ${pid}`).toHaveLength(1);
      expect(lines[0]).toMatch(/^\[db\] idle pooled connection died and was discarded/);
      expect(lines[0]).toMatch(/code=57P01 at=\d{4}-\d\d-\d\dT/);
    }
    expect(run.steps.queue_works_after_idle_drop.status).toBe('done');

    // 2. Checked-out drop: the caller gets a rejection instead of the process getting a throw,
    //    and the dead client is discarded rather than handed to the next query.
    expect(run.steps.checked_out_drop_survived.queryOnDeadClient).toMatch(/^rejected: /);
    expect(run.steps.checked_out_drop_survived.poolQueryAfter).toBe(42);
    expect(run.stderr).toMatch(/\[db\] pooled connection died while checked out/);

    // 3. In-flight job: the killed query fails the JOB, which goes back to pending for retry
    //    with the cause recorded — not stranded in 'running', not lost. Pre-existing behaviour
    //    (pool.query already had pg-pool's per-query listener); a regression guard, not the fix.
    const inflight = run.steps.inflight_job_drop_handled;
    expect(inflight.status).toBe('pending');
    expect(inflight.attempts).toBe(1);
    expect(String(inflight.lastError)).toMatch(/terminating connection due to administrator command/);
    expect(run.steps.pool_still_serving.ok).toBe(42);

    // The log lines must never carry the connection string / password.
    expect(run.stderr).not.toContain(process.env.DATABASE_URL as string);
  }, 60_000);
});
