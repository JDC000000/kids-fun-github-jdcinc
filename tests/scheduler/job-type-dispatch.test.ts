// tests/scheduler/job-type-dispatch.test.ts — worker/core/job-handlers.ts: routing a claimed
// job to the handler registered for its job_queue.job_type.
//
// THE DEFECT. worker/src/scheduler.ts bound ONE handler for every claimed job
// (`makeTermsGatedIngestJobHandler`), whose first statement is
// `if (!job.sourceId) throw new Error('ingest job has no source_id')`
// (worker/core/source-runner.ts:127). A global job — job_type='corrections_retention',
// source_id=NULL — therefore threw on every attempt, retried to max_attempts and
// dead-lettered. Every global job was dead on arrival.
//
// WHAT THIS FILE DELIBERATELY DOES NOT MOCK. source-runner is REAL here, driven through a
// stub pool. Mocking it would have proved only "the dispatcher called the thing I told it
// to call"; using the real one proves the ingest branch still reaches
// loadSourceForIngest() and still applies the terms gate, because those produce error
// strings nothing else in the process can produce. Only lib/corrections/retention is
// mocked — it is the one seam that would otherwise construct a pg Pool, and its real
// behaviour against real Postgres is covered by tests/corrections/retention.test.ts and by
// tests/scheduler/job-dispatch-db.test.ts. worker/health/stale.ts is likewise REAL here: it
// takes the pool it is handed, so the stub is enough to see the statement it emits, and its
// behaviour against real rows is covered by tests/health/stale.test.ts and
// tests/scheduler/job-dispatch-db.test.ts.
//
// No database: the pool is a stub, so this file belongs in the fast `unit` lane and is
// deliberately NOT registered in DB_INTEGRATION_SUITES.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const shared = vi.hoisted(() => ({
  purgeCalls: [] as Array<{ dryRun?: boolean } | undefined>,
  purgeError: null as Error | null,
  dryRunForced: false,
}));

vi.mock('../../lib/corrections/retention', () => ({
  purgeExpiredCorrectionReports: vi.fn(async (options?: { dryRun?: boolean }) => {
    shared.purgeCalls.push(options);
    if (shared.purgeError) throw shared.purgeError;
    return {
      dryRun: options?.dryRun ?? false,
      cutoff: '2026-08-10T00:00:00.000Z',
      expired: 3,
      deleted: options?.dryRun ? 0 : 3,
      batches: 1,
      retentionDays: 183,
      truncated: false,
    };
  }),
}));

vi.mock('../../lib/corrections/retention-config', () => ({
  correctionRetentionDays: vi.fn(() => 183),
  correctionRetentionDryRunForced: vi.fn(() => shared.dryRunForced),
  // F1: the handler now resolves the kill-switch to an EFFECTIVE MODE (value + the reason
  // it resolved that way) so the decision is readable in the worker log instead of being
  // inferred from an env var whose spelling was the original hazard. The real parse and its
  // spelling table are covered by tests/corrections/retention-dry-run-switch.test.ts.
  CORRECTION_RETENTION_DRY_RUN_ENV: 'CORRECTION_RETENTION_DRY_RUN',
  resolveCorrectionRetentionDryRun: vi.fn(() => ({
    dryRun: shared.dryRunForced,
    reason: shared.dryRunForced ? 'explicit_pause' : 'unset',
    raw: shared.dryRunForced ? 'true' : null,
  })),
}));

import {
  buildJobHandlerRegistry,
  makeJobDispatcher,
  UnknownJobTypeError,
  UNKNOWN_JOB_TYPE_ERROR_PREFIX,
} from '../../worker/core/job-handlers';
import type { Job } from '../../worker/core/queue';

/** A pg Pool stand-in that records every statement and returns whatever `rows` is set to. */
function stubPool(rows: Record<string, unknown>[] = []): {
  pool: never;
  queries: string[];
} {
  const queries: string[] = [];
  const pool = {
    query: async (sql: string) => {
      queries.push(sql.replace(/\s+/g, ' ').trim());
      return { rows };
    },
  };
  return { pool: pool as never, queries };
}

/** A pg Pool stand-in whose every statement fails — a database that is simply not there. */
function failingPool(message: string): { pool: never; queries: string[] } {
  const queries: string[] = [];
  const pool = {
    query: async (sql: string) => {
      queries.push(sql.replace(/\s+/g, ' ').trim());
      throw new Error(message);
    },
  };
  return { pool: pool as never, queries };
}

function job(over: Partial<Job> = {}): Job {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    sourceId: null,
    jobType: 'ingest',
    attempts: 1,
    maxAttempts: 5,
    ...over,
  };
}

/** Capture a rejection as a value. Resolving is itself a failure — see the UNKNOWN suite. */
async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected the dispatcher to REJECT, but it resolved');
}

beforeEach(() => {
  shared.purgeCalls.length = 0;
  shared.purgeError = null;
  shared.dryRunForced = false;
});

describe('job_type dispatch — the registry', () => {
  it('registers exactly the job types the worker can run', () => {
    const { pool } = stubPool();
    // A drift guard: dropping a handler, or quietly adding one, is visible here. If you are
    // adding a job type on purpose, add it to this list in the same commit.
    //
    // BEING IN THIS LIST IS A CAPABILITY, NOT AN ENABLEMENT. Both global types are
    // dispatchable as soon as the worker image ships; neither is SCHEDULED, because their
    // global_job_schedule rows ship `enabled = false` (migrations 0028 and 0029). The two
    // facts are asserted in different places on purpose — this one is about the worker,
    // the disabled-row assertions in tests/scheduler/global-jobs-db.test.ts are about the
    // database.
    expect([...buildJobHandlerRegistry(pool, 'staging').keys()].sort()).toEqual([
      'corrections_retention',
      'ingest',
      'stale_occurrence_flip',
    ]);
  });
});

describe("job_type 'ingest' — existing behaviour is preserved, not widened", () => {
  it('still throws on a NULL source_id (an ingest job without a source IS an error)', async () => {
    const { pool, queries } = stubPool();
    const dispatch = makeJobDispatcher(pool, 'staging');
    // If the fix had "fixed" this by tolerating a null sourceId, this expectation fails.
    await expect(dispatch(job({ jobType: 'ingest', sourceId: null }))).rejects.toThrow(
      'ingest job has no source_id'
    );
    expect(queries).toEqual([]); // it fails before touching the database, as before
  });

  it('routes a real ingest job into loadSourceForIngest (not into some new shim)', async () => {
    const { pool, queries } = stubPool([]); // no such source
    const dispatch = makeJobDispatcher(pool, 'staging');
    await expect(
      dispatch(job({ jobType: 'ingest', sourceId: '11111111-1111-4111-8111-111111111111' }))
    ).rejects.toThrow(/source not found/);
    // Proves the REAL source-runner ran: only loadSourceForIngest issues this SELECT.
    expect(queries.join(' ')).toContain('FROM source');
    expect(queries.join(' ')).toContain('terms_status, robots_status, robots_override_decision');
  });

  it('still applies the terms gate — a blocked source is refused', async () => {
    const { pool } = stubPool([
      {
        id: '11111111-1111-4111-8111-111111111111',
        family: 'noop',
        name: 'Blocked Source',
        terms_status: 'blocked',
        robots_status: 'allowed',
        robots_override_decision: null,
      },
    ]);
    const dispatch = makeJobDispatcher(pool, 'staging');
    await expect(
      dispatch(job({ jobType: 'ingest', sourceId: '11111111-1111-4111-8111-111111111111' }))
    ).rejects.toThrow(/staging blocked — terms_status=blocked/);
  });

  it('does not run the retention purge for an ingest job', async () => {
    const { pool } = stubPool();
    const dispatch = makeJobDispatcher(pool, 'staging');
    await expect(dispatch(job({ jobType: 'ingest' }))).rejects.toThrow();
    expect(shared.purgeCalls).toHaveLength(0);
  });
});

describe("job_type 'corrections_retention' — the global job the worker could not run", () => {
  it('runs the REAL shared purge and resolves (source_id IS NULL is legitimate here)', async () => {
    const { pool, queries } = stubPool();
    const dispatch = makeJobDispatcher(pool, 'staging');
    await expect(
      dispatch(job({ jobType: 'corrections_retention', sourceId: null }))
    ).resolves.toBeUndefined();
    expect(shared.purgeCalls).toHaveLength(1);
    // The ingest handler was never consulted: it would have issued a SELECT, or thrown.
    expect(queries).toEqual([]);
  });

  it('honours the CORRECTION_RETENTION_DRY_RUN kill-switch, exactly as the route does', async () => {
    // app/api/corrections/retention/run/route.ts:66 ORs the same forced flag in. An operator
    // kill-switch that stopped deletions on Vercel but not in the worker would be worse than
    // no kill-switch at all.
    shared.dryRunForced = true;
    const { pool } = stubPool();
    await makeJobDispatcher(pool, 'staging')(job({ jobType: 'corrections_retention' }));
    expect(shared.purgeCalls[0]).toEqual({ dryRun: true });
  });

  it('deletes for real by default (the job exists to enforce retention)', async () => {
    const { pool } = stubPool();
    await makeJobDispatcher(pool, 'staging')(job({ jobType: 'corrections_retention' }));
    expect(shared.purgeCalls[0]).toEqual({ dryRun: false });
  });

  it('propagates a purge failure so the queue can retry and dead-letter it', async () => {
    // Swallowing this would mark the row 'done' having deleted nothing — a retention job
    // that silently stops enforcing retention is the worst possible failure mode here.
    shared.purgeError = new Error('connection terminated unexpectedly');
    const { pool } = stubPool();
    await expect(
      makeJobDispatcher(pool, 'staging')(job({ jobType: 'corrections_retention' }))
    ).rejects.toThrow('connection terminated unexpectedly');
  });

  it('logs counts only — never correction_report row contents', async () => {
    const lines: string[] = [];
    const { makeCorrectionsRetentionJobHandler } = await import(
      '../../worker/core/corrections-retention'
    );
    await makeCorrectionsRetentionJobHandler({ logger: { log: (m: string) => lines.push(m) } })(
      job({ jobType: 'corrections_retention' })
    );
    // Two lines now: the EFFECTIVE dry-run mode, logged BEFORE the purge so it exists even
    // if the purge throws (F1), then the counts.
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/effective mode DELETING/);
    expect(lines[1]).toContain('deleted=3');
    // `note` is user-submitted free text; nothing from a row may reach EITHER line.
    for (const line of lines) expect(line).not.toMatch(/note|reporter|occurrence_id/i);
  });
});

describe("job_type 'stale_occurrence_flip' — the flip finally has a caller", () => {
  const FLIP = 'stale_occurrence_flip';

  it('runs the REAL flipStaleOccurrences UPDATE on the pool the registry was built with', async () => {
    // No mock of worker/health/stale.ts, deliberately — mocking it would prove only that the
    // dispatcher called the thing it was told to call. The statement below is one nothing
    // else in the process emits, so seeing it on THIS stub proves both that the real
    // implementation ran and that it ran on the worker's pool rather than opening its own.
    const { pool, queries } = stubPool();
    await expect(
      makeJobDispatcher(pool, 'staging')(job({ jobType: FLIP, sourceId: null }))
    ).resolves.toBeUndefined();

    expect(queries).toHaveLength(1);
    const sql = queries[0];
    expect(sql).toContain('UPDATE activity_occurrence');
    expect(sql).toContain("SET status_state = 'stale'");
    // The predicate's three exclusions, which are what keep the blast radius to "rows
    // nothing has re-checked lately" rather than "every row".
    expect(sql).toContain('o.archived_at IS NULL');
    expect(sql).toContain('o.last_checked_at IS NOT NULL');
    expect(sql).toContain('o.status_state::text = ANY');
    expect(shared.purgeCalls).toHaveLength(0); // and it is not the retention job in disguise
  });

  it('propagates a database failure instead of claiming the demotion happened', async () => {
    // ── TEETH ──────────────────────────────────────────────────────────────────────────
    // Wrap the flip in a try/catch in worker/core/stale-occurrence-flip.ts and this goes
    // red. Returning normally tells worker/src/scheduler.ts to markDone() the queue row AND
    // to close the run ledger as 'success' — which resets consecutive_failures, so a job
    // that fails every single day would look permanently healthy and never trip the breaker.
    // That is the failure mode this job type is supposed to be the RIGHT shape for.
    const { pool } = failingPool('terminating connection due to administrator command');
    await expect(
      makeJobDispatcher(pool, 'staging')(job({ jobType: FLIP }))
    ).rejects.toThrow('terminating connection due to administrator command');
  });

  it('logs the count and NOT the flipped occurrence ids', async () => {
    // flipStaleOccurrences returns one id per changed row; on a first run over a neglected
    // table that is the whole backlog. The handler must not put that list in a log line.
    const lines: string[] = [];
    const flipped = [
      { id: '9f1c6a6e-0000-4000-8000-00000000aaaa' },
      { id: '9f1c6a6e-0000-4000-8000-00000000bbbb' },
    ];
    const { pool } = stubPool(flipped);
    const { makeStaleOccurrenceFlipJobHandler } = await import(
      '../../worker/core/stale-occurrence-flip'
    );
    await makeStaleOccurrenceFlipJobHandler(pool, { logger: { log: (m: string) => lines.push(m) } })(
      job({ jobType: FLIP })
    );

    // Two lines: what is about to happen to real rows (before the UPDATE, so it survives a
    // throw), then the count.
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/demoting past-cadence occurrences/);
    expect(lines[1]).toContain('flipped=2');
    for (const id of flipped) for (const line of lines) expect(line).not.toContain(id.id);
  });

  it('does not reach the ingest handler even though its source_id is NULL', async () => {
    // The exact shape that used to dead-letter: a global job routed to the terms-gated
    // ingest handler, which opens by rejecting a null source_id.
    const { pool } = stubPool();
    await expect(
      makeJobDispatcher(pool, 'staging')(job({ jobType: FLIP, sourceId: null }))
    ).resolves.toBeUndefined();
  });
});

describe('an UNKNOWN job_type fails LOUDLY (it must never be a no-op)', () => {
  const UNKNOWN = 'definitely_not_a_registered_job_type';

  it('REJECTS — it does not resolve, which would mark the row done having done nothing', async () => {
    const { pool } = stubPool();
    const dispatch = makeJobDispatcher(pool, 'staging');
    // ── TEETH ──────────────────────────────────────────────────────────────────────────
    // This is the assertion that makes "treat an unknown job_type as a silent success"
    // impossible to ship. Replace the `throw new UnknownJobTypeError(...)` in
    // worker/core/job-handlers.ts with `return;` and this line fails: `resolves` is exactly
    // the state a no-op produces, and the scheduler would then call markDone() on a job
    // nothing ran. This project has already shipped one silent-success defect through a
    // green suite; this is the tripwire for the next one.
    await expect(dispatch(job({ jobType: UNKNOWN }))).rejects.toThrow(UnknownJobTypeError);
  });

  it('names the offending job_type and what IS registered, so last_error is actionable', async () => {
    const { pool } = stubPool();
    const err = await rejection(makeJobDispatcher(pool, 'staging')(job({ jobType: UNKNOWN })));
    expect(err).toBeInstanceOf(UnknownJobTypeError);
    expect(err.message).toContain(UNKNOWN_JOB_TYPE_ERROR_PREFIX);
    expect(err.message).toContain(UNKNOWN);
    expect(err.message).toContain('corrections_retention, ingest');
    expect((err as UnknownJobTypeError).jobType).toBe(UNKNOWN);
    expect((err as UnknownJobTypeError).jobId).toBe(job().id);
  });

  it('does NOT fall through to the ingest handler', async () => {
    const { pool, queries } = stubPool();
    const err = await rejection(
      makeJobDispatcher(pool, 'staging')(job({ jobType: UNKNOWN, sourceId: null }))
    );
    // Falling through would produce ingest's own message and hide the real cause: an
    // operator reading job_queue.last_error would go hunting for a missing source_id on a
    // job that was never an ingest job.
    expect(err.message).not.toContain('ingest job has no source_id');
    expect(queries).toEqual([]);
    expect(shared.purgeCalls).toHaveLength(0);
  });

  it('an EMPTY job_type is unknown too — it does not quietly default to ingest', async () => {
    // job_queue.job_type is NOT NULL DEFAULT 'ingest' (0011_job_queue.sql:13), but nothing
    // stops an enqueuer writing ''. Defaulting it to ingest would resurrect the original
    // bug in a new disguise.
    const { pool } = stubPool();
    await expect(makeJobDispatcher(pool, 'staging')(job({ jobType: '' }))).rejects.toThrow(
      UnknownJobTypeError
    );
  });

  it("a near-miss type ('correction_retention') is rejected, not fuzzy-matched", async () => {
    const { pool } = stubPool();
    await expect(
      makeJobDispatcher(pool, 'staging')(job({ jobType: 'correction_retention' }))
    ).rejects.toThrow(UnknownJobTypeError);
    expect(shared.purgeCalls).toHaveLength(0);
  });
});
