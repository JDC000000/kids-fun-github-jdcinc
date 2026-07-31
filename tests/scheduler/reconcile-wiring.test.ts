// tests/scheduler/reconcile-wiring.test.ts — H4 finding H4-A: DRIFT PROTECTION for the
// abandoned-row sweep's wiring and its ordering.
//
// WHY THIS FILE EXISTS. reconcileAbandonedRuns() itself is covered by
// tests/ingestion/reconcile.test.ts against a real database. What was NOT covered was that
// the scheduler actually CALLS it, and calls it in the right place. QA demonstrated the gap
// by disconnecting reconcileOnce() from tickOnce() entirely and running the whole suite:
// 1508 tests, still 100% green. So the self-healing mechanism could be silently unwired, or
// its ordering silently reversed, and nothing would ever say so.
//
// That matters more than a normal wiring test because the failure is SILENT. If the sweep
// stops running, no test breaks and no error is logged — a source that was stranded by a
// crash simply stops updating forever. The whole point of H4 was to stop exactly that class
// of quiet, unattended failure, so the mechanism that prevents it needs its own tripwire.
//
// THE ORDERING IS LOAD-BEARING, not stylistic. An abandoned job sitting at status='running'
// holds idx_job_queue_source_active, and enqueueDueJobs() skips any source with a
// pending/running job as "already in flight". Sweep AFTER enqueue and the stranded source
// stays stranded for another whole tick; sweep BEFORE and it becomes enqueueable on this
// very tick. Reversing these two lines is a one-character-looking change with a real,
// invisible cost — hence an explicit assertion on the order, not just on the calls.
//
// No database: the pool is a stub, so this file belongs in the fast `unit` lane and is
// deliberately NOT registered in DB_INTEGRATION_SUITES.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock is hoisted above the imports, so the shared call log has to be hoisted with it.
const shared = vi.hoisted(() => ({
  calls: [] as string[],
  reconcileError: null as Error | null,
}));

vi.mock('../../worker/core/reconcile', () => ({
  ABANDONED_RUN_THRESHOLD_MS: 30 * 60_000,
  reconcileAbandonedRuns: vi.fn(async () => {
    shared.calls.push('reconcile');
    if (shared.reconcileError) throw shared.reconcileError;
    return { jobsRequeued: 0, jobsDeadLettered: 0, checkRunsFailed: 0 };
  }),
}));

vi.mock('../../worker/scheduler/tiered', () => ({
  enqueueDueJobs: vi.fn(async () => {
    shared.calls.push('enqueue');
    return [];
  }),
}));

// The queue is stubbed so the poll loop spins harmlessly without a database.
vi.mock('../../worker/core/queue', () => ({
  dequeue: vi.fn(async () => null),
  markDone: vi.fn(async () => undefined),
  markFailed: vi.fn(async () => undefined),
}));

import { startScheduler } from '../../worker/src/scheduler';
import { reconcileAbandonedRuns } from '../../worker/core/reconcile';
import { enqueueDueJobs } from '../../worker/scheduler/tiered';

/** Minimal pool stand-in — nothing in this test reaches SQL. */
const stubPool = { query: vi.fn(async () => ({ rows: [] })) } as never;

/**
 * Run the scheduler just long enough for its immediate boot tick, then stop it.
 * Intervals are set far above the test's lifetime so only the boot tick can fire and the
 * assertions cannot be satisfied by a second, later tick.
 */
async function runOneTick(): Promise<void> {
  const controller = new AbortController();
  const handle = startScheduler(stubPool, {
    signal: controller.signal,
    immediate: true,
    schedulerTickMs: 600_000,
    pollIntervalMs: 600_000,
    environment: 'staging',
  });
  try {
    await vi.waitFor(() => expect(shared.calls).toContain('enqueue'), { timeout: 5_000 });
  } finally {
    controller.abort();
    await handle.done;
  }
}

beforeEach(() => {
  shared.calls.length = 0;
  shared.reconcileError = null;
  vi.mocked(reconcileAbandonedRuns).mockClear();
  vi.mocked(enqueueDueJobs).mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('scheduler → reconcile wiring (H4-A drift protection)', () => {
  it('sweeps abandoned rows on the boot tick — the mechanism is actually connected', async () => {
    await runOneTick();
    // Disconnecting reconcileOnce() from tickOnce() fails here and nowhere else.
    expect(reconcileAbandonedRuns).toHaveBeenCalled();
    expect(shared.calls).toContain('reconcile');
  });

  it('sweeps BEFORE enqueueDueJobs within the same tick', async () => {
    await runOneTick();
    const swept = shared.calls.indexOf('reconcile');
    const enqueued = shared.calls.indexOf('enqueue');
    expect(swept).toBeGreaterThanOrEqual(0);
    expect(enqueued).toBeGreaterThanOrEqual(0);
    // Reversing the two lines in tickOnce() fails here. An abandoned 'running' job holds
    // idx_job_queue_source_active, so enqueueDueJobs() would skip that source as in-flight
    // and the crash-stranded source would wait another full tick to recover.
    expect(swept).toBeLessThan(enqueued);
  });

  it('runs the sweep on the IMMEDIATE boot tick, so a restart self-heals at once', async () => {
    // The orphaned rows this recovers are produced by a process dying; the restart that
    // follows is the first opportunity to clean them up, and must not wait a tick interval.
    // schedulerTickMs is 10 minutes here, so only the boot tick can have run.
    await runOneTick();
    expect(reconcileAbandonedRuns).toHaveBeenCalledTimes(1);
  });

  it('passes the real pool through to the sweep', async () => {
    await runOneTick();
    expect(reconcileAbandonedRuns).toHaveBeenCalledWith(stubPool);
  });

  it('a failing sweep still lets the tick enqueue — the sweep is never load-bearing', async () => {
    // Recovery is best-effort; enqueueing is the scheduler's primary duty. A DB hiccup in
    // the sweep must not silently stop the whole ingestion cadence.
    shared.reconcileError = new Error('reconcile boom');
    await runOneTick();
    expect(shared.calls).toContain('reconcile');
    expect(shared.calls).toContain('enqueue');
  });

  it('surfaces a sweep failure on the metrics the health endpoint reads', async () => {
    shared.reconcileError = new Error('reconcile boom');
    const controller = new AbortController();
    const handle = startScheduler(stubPool, {
      signal: controller.signal,
      immediate: true,
      schedulerTickMs: 600_000,
      pollIntervalMs: 600_000,
      environment: 'staging',
    });
    try {
      await vi.waitFor(() => expect(shared.calls).toContain('enqueue'), { timeout: 5_000 });
      // A swallowed error that reports nothing anywhere would be its own silent failure.
      expect(handle.metrics.lastError).toMatch(/reconcile/i);
    } finally {
      controller.abort();
      await handle.done;
    }
  });
});
