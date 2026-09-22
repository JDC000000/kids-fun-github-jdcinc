// tests/scheduler/poll-lane-attribution.test.ts — WHICH CALL a 'poll' error came from, and
// whether the poll lane is failing NOW.
//
// THE INCIDENT THIS PINS (2026-09-22, production, measured from Sentry + /healthz):
//   18:08:48  DB credential rotation leaves the worker's DATABASE_URL wrong. Every lane
//             starts failing with `password authentication failed for user "postgres"`,
//             then the Supabase pooler's `(ECIRCUITBREAKER) too many authentication failures`.
//   18:09:38  An in-flight Burnaby ingest (job 804c4d45…) fails inside finishCheckRun → 'job'.
//   18:09:39  markFailed for that job ALSO fails → escapes processOneJob → recorded as 'poll'.
//             The job row stays status='running' for 3h17m, until the reconcile sweep on the
//             first healthy tick after the fixed-credential reboot (21:27:15) reclaims it.
//   21:26:14  Reboot with the corrected credential. The pooler breaker is still open for
//             ~11s: 7 errors across five lanes, the last three from the poll lane. From
//             21:26:30 on, every query succeeds.
//   21:45+    /healthz still says lastErrorKind 'poll' — a since-boot high-water mark — and it
//             was read as "the poll loop is still failing with the correct credential".
//
// Two things made that misreading possible, and they are what this file pins:
//   1. 'poll' is recorded for three different calls (dequeue, markFailed, and the Sentry
//      report of a job failure) and nothing in the log line or the Sentry event said which.
//      A dequeue failure loses nothing; a markFailed failure STRANDS A CLAIMED JOB in
//      'running' until the sweep's 30-minute threshold. Same label, different consequence.
//   2. Nothing on /healthz described the poll lane's CURRENT state. lastErrorKind is never
//      cleared (deliberately), so a lane that failed for 11s at boot and has been fine for
//      twenty minutes looked identical to one failing right now.
//
// No database: every seam is stubbed, so this file is in the fast `unit` lane.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const shared = vi.hoisted(() => ({
  /** Queue of results for dequeue(): a job, null (idle), or an Error to throw. */
  dequeueScript: [] as Array<unknown>,
  markDoneError: null as Error | null,
  markFailedError: null as Error | null,
  claimError: null as Error | null,
  finishError: null as Error | null,
  dispatchError: null as Error | null,
  /** Throw from the Sentry capture for this operation (to reach the 'report' step). */
  captureThrowsFor: null as string | null,
  captures: [] as Array<{ err: unknown; tags: Record<string, unknown>; extra?: Record<string, unknown> }>,
  markFailedCalls: [] as string[],
}));

vi.mock('../../worker/core/reconcile', () => ({
  ABANDONED_RUN_THRESHOLD_MS: 30 * 60_000,
  reconcileAbandonedRuns: vi.fn(async () => ({
    jobsRequeued: 0,
    jobsDeadLettered: 0,
    checkRunsFailed: 0,
    globalJobRuns: { abandoned: 0, resolvedSuccessful: 0, breakersTripped: [] },
  })),
}));
vi.mock('../../worker/scheduler/tiered', () => ({ enqueueDueJobs: vi.fn(async () => []) }));
vi.mock('../../worker/scheduler/global-jobs', () => ({
  enqueueDueGlobalJobs: vi.fn(async () => ({ enqueued: [], skipped: [] })),
}));
vi.mock('../../worker/core/queue', () => ({
  dequeue: vi.fn(async () => {
    const next = shared.dequeueScript.length > 0 ? shared.dequeueScript.shift() : null;
    if (next instanceof Error) throw next;
    return next ?? null;
  }),
  markDone: vi.fn(async () => {
    if (shared.markDoneError) throw shared.markDoneError;
  }),
  markFailed: vi.fn(async (_pool: unknown, jobId: string) => {
    shared.markFailedCalls.push(jobId);
    if (shared.markFailedError) throw shared.markFailedError;
  }),
  resolveWorkerId: vi.fn(() => 'test-worker'),
}));
vi.mock('../../worker/core/global-job-schedule', () => ({
  claimGlobalJobRun: vi.fn(async () => {
    if (shared.claimError) throw shared.claimError;
    return false;
  }),
  finishGlobalJobRun: vi.fn(async () => {
    if (shared.finishError) throw shared.finishError;
    return null;
  }),
  readGlobalJobScheduleHealth: vi.fn(async () => []),
}));
vi.mock('../../worker/core/job-handlers', () => ({
  makeJobDispatcher: vi.fn(() => async () => {
    if (shared.dispatchError) throw shared.dispatchError;
  }),
}));
vi.mock('../../worker/src/sentry', () => ({
  captureWorkerException: vi.fn(
    async (err: unknown, ctx: { tags?: Record<string, unknown>; extra?: Record<string, unknown> } = {}) => {
      shared.captures.push({ err, tags: ctx.tags ?? {}, extra: ctx.extra });
      if (shared.captureThrowsFor && ctx.tags?.operation === shared.captureThrowsFor) {
        throw new Error('sentry transport exploded');
      }
      return true;
    }
  ),
}));

import { startScheduler, type SchedulerMetrics } from '../../worker/src/scheduler';
import { schedulerReport } from '../../worker/src/healthz';

const stubPool = { query: vi.fn(async () => ({ rows: [] })) } as never;

const JOB = {
  id: '804c4d45-199a-42db-bb69-d9bc285576a4',
  sourceId: 'fce5ecad-fc38-4262-a9c8-9886cb601e65',
  jobType: 'ingest',
  attempts: 1,
  maxAttempts: 5,
};

/** The two pooler errors production actually returned, verbatim. */
const breakerError = (): Error =>
  new Error('(ECIRCUITBREAKER) too many authentication failures, new connections are temporarily blocked');
const authError = (): Error => new Error('password authentication failed for user "postgres"');

let errorLines: string[] = [];

beforeEach(() => {
  shared.dequeueScript = [];
  shared.markDoneError = null;
  shared.markFailedError = null;
  shared.claimError = null;
  shared.finishError = null;
  shared.dispatchError = null;
  shared.captureThrowsFor = null;
  shared.captures = [];
  shared.markFailedCalls = [];
  errorLines = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errorLines.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Boot the scheduler with a fast poll loop, wait until `until(metrics)` holds, stop it.
 * The tick interval is far above the test's lifetime so only the boot tick runs, and the
 * boot tick's stubs never throw — so every recorded error in these tests is the poll lane's.
 */
async function runUntil(until: (m: SchedulerMetrics) => void): Promise<SchedulerMetrics> {
  const controller = new AbortController();
  const handle = startScheduler(stubPool, {
    signal: controller.signal,
    immediate: true,
    schedulerTickMs: 600_000,
    pollIntervalMs: 5,
    environment: 'production',
  });
  try {
    await vi.waitFor(() => until(handle.metrics), { timeout: 5_000 });
  } finally {
    controller.abort();
    await handle.done;
  }
  return handle.metrics;
}

const pollCaptures = () => shared.captures.filter((c) => c.tags.operation === 'poll');

describe("which call a 'poll' error came from", () => {
  it('markFailed failing after a job failure is labelled mark_failed and names the stranded job (the 18:09:39 production sequence)', async () => {
    shared.dequeueScript = [JOB];
    shared.dispatchError = breakerError(); // finishCheckRun inside the ingest hit the pooler breaker
    shared.markFailedError = breakerError(); // …and so did markFailed
    const m = await runUntil(() => expect(pollCaptures()).toHaveLength(1));

    // Both halves are recorded, in the order production recorded them.
    const ops = shared.captures.map((c) => c.tags.operation);
    expect(ops.indexOf('process_job')).toBeGreaterThanOrEqual(0);
    expect(ops.indexOf('process_job')).toBeLessThan(ops.indexOf('poll'));
    expect(m.lastErrorKind).toBe('poll');

    // THE FIX: the poll event says WHICH call and WHICH job.
    const poll = pollCaptures()[0];
    expect(poll.tags.poll_step).toBe('mark_failed');
    expect(poll.extra?.jobId).toBe(JOB.id);
    // The ORIGINAL error reaches Sentry, not a wrapper — its stack is the evidence.
    expect(poll.err).toBe(shared.markFailedError);

    const line = errorLines.find((l) => l.includes('[scheduler] poll error'));
    expect(line).toBeDefined();
    expect(line).toContain('mark_failed');
    expect(line).toContain(JOB.id);
    expect(line).toMatch(/running/); // says what happened to the row
    expect(m.lastError).toContain('mark_failed');
  });

  it('dequeue failing is labelled dequeue and names no job — nothing was claimed', async () => {
    shared.dequeueScript = [authError()];
    await runUntil(() => expect(pollCaptures()).toHaveLength(1));
    const poll = pollCaptures()[0];
    expect(poll.tags.poll_step).toBe('dequeue');
    expect(poll.extra?.jobId).toBeUndefined();
    expect(errorLines.find((l) => l.includes('[scheduler] poll error'))).toContain('dequeue');
  });

  it('the Sentry report of a job failure throwing is labelled report, and markFailed never ran', async () => {
    shared.dequeueScript = [JOB];
    shared.dispatchError = new Error('handler boom');
    shared.captureThrowsFor = 'process_job';
    await runUntil(() => expect(pollCaptures()).toHaveLength(1));
    expect(pollCaptures()[0].tags.poll_step).toBe('report');
    expect(pollCaptures()[0].extra?.jobId).toBe(JOB.id);
    expect(shared.markFailedCalls).toEqual([]); // the job IS stranded — the label must say so
  });
});

describe("what does NOT surface as 'poll' (the suspects from the brief, executed)", () => {
  it('claimGlobalJobRun throwing is a JOB failure, retried by the queue — never poll', async () => {
    shared.dequeueScript = [JOB];
    shared.claimError = breakerError();
    const m = await runUntil((mm) => expect(mm.jobsFailed).toBe(1));
    expect(m.lastErrorKind).toBe('job');
    expect(pollCaptures()).toEqual([]);
    expect(shared.markFailedCalls).toEqual([JOB.id]);
  });

  it('markDone throwing is a JOB failure, retried by the queue — never poll', async () => {
    shared.dequeueScript = [JOB];
    shared.markDoneError = breakerError();
    const m = await runUntil((mm) => expect(mm.jobsFailed).toBe(1));
    expect(m.lastErrorKind).toBe('job');
    expect(pollCaptures()).toEqual([]);
    expect(shared.markFailedCalls).toEqual([JOB.id]);
  });

  it('finishGlobalJobRun (finalizeGlobalRun) throwing is global_run_ledger — never poll', async () => {
    shared.dequeueScript = [JOB];
    shared.finishError = breakerError();
    const m = await runUntil((mm) => expect(mm.lastErrorKind).toBe('global_run_ledger'));
    expect(m.jobsSucceeded).toBe(1);
    expect(pollCaptures()).toEqual([]);
  });
});

describe('the poll lane reports its CURRENT state, not only its high-water mark', () => {
  it('reproduces the 21:26 reboot: 3 breaker errors then recovery — lastErrorKind stays poll, the lane reads healthy', async () => {
    shared.dequeueScript = [breakerError(), breakerError(), breakerError()];
    const m = await runUntil((mm) => {
      expect(mm.errorCount).toBe(3);
      expect(mm.lastPollOkAt).not.toBeNull();
    });

    // The high-water mark is preserved on purpose — this is what /healthz showed at 21:45.
    expect(m.lastErrorKind).toBe('poll');
    expect(m.lastErrorAt).not.toBeNull();

    // …and THIS is what it could not show: the lane is fine now.
    expect(m.consecutivePollErrors).toBe(0);
    expect(Date.parse(m.lastPollOkAt as string)).toBeGreaterThanOrEqual(Date.parse(m.lastErrorAt as string));

    // Both reach the public wire (structure only — a counter and a timestamp).
    const wire = schedulerReport(m);
    if (!wire.known) throw new Error('expected a reported scheduler');
    expect(wire.consecutivePollErrors).toBe(0);
    expect(wire.lastPollOkAt).toBe(m.lastPollOkAt);
  });

  it('counts consecutive failures while the lane is down, and never stamps lastPollOkAt', async () => {
    shared.dequeueScript = Array.from({ length: 500 }, () => authError());
    const m = await runUntil((mm) => expect(mm.consecutivePollErrors).toBeGreaterThanOrEqual(3));
    expect(m.lastPollOkAt).toBeNull();
    expect(m.lastErrorKind).toBe('poll');
    // The WIRE must carry the non-zero count too — a projection pinned to 0 is a false green.
    const wire = schedulerReport(m);
    if (!wire.known) throw new Error('expected a reported scheduler');
    expect(wire.consecutivePollErrors).toBe(m.consecutivePollErrors);
    expect(wire.lastPollOkAt).toBeNull();
  });

  it('a stranded job (markFailed failed) counts as a poll-lane failure, not a success', async () => {
    shared.dequeueScript = [JOB, ...Array.from({ length: 500 }, () => authError())];
    shared.dispatchError = breakerError();
    shared.markFailedError = breakerError();
    const m = await runUntil((mm) => expect(mm.consecutivePollErrors).toBeGreaterThanOrEqual(3));
    expect(m.lastPollOkAt).toBeNull();
  });
});
