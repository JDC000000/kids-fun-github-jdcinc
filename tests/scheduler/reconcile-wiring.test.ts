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
  globalEnqueueError: null as Error | null,
  /** What the mocked global producer returns — lets a test drive the skipped-slot counter
   *  without a database. */
  globalTick: { enqueued: [] as unknown[], skipped: [] as unknown[] },
  /** What the mocked DURABLE health reader returns, and whether it fails. */
  health: [] as unknown[],
  healthError: null as Error | null,
}));

vi.mock('../../worker/core/reconcile', () => ({
  ABANDONED_RUN_THRESHOLD_MS: 30 * 60_000,
  reconcileAbandonedRuns: vi.fn(async () => {
    shared.calls.push('reconcile');
    if (shared.reconcileError) throw shared.reconcileError;
    return {
      jobsRequeued: 0,
      jobsDeadLettered: 0,
      checkRunsFailed: 0,
      globalJobRuns: { abandoned: 0, resolvedSuccessful: 0, breakersTripped: [] },
    };
  }),
}));

vi.mock('../../worker/scheduler/tiered', () => ({
  enqueueDueJobs: vi.fn(async () => {
    shared.calls.push('enqueue');
    return [];
  }),
}));

// The GLOBAL (source-less) producer. Same drift-protection argument as enqueueDueJobs
// below, and a sharper one: it is the only thing that ever enqueues the retention purge,
// so if it were silently unwired the schedule would simply never run and no test — and no
// log line — would say so.
vi.mock('../../worker/scheduler/global-jobs', () => ({
  enqueueDueGlobalJobs: vi.fn(async () => {
    shared.calls.push('enqueue-global');
    if (shared.globalEnqueueError) throw shared.globalEnqueueError;
    return shared.globalTick;
  }),
}));

// The queue is stubbed so the poll loop spins harmlessly without a database.
vi.mock('../../worker/core/queue', () => ({
  dequeue: vi.fn(async () => null),
  markDone: vi.fn(async () => undefined),
  markFailed: vi.fn(async () => undefined),
  resolveWorkerId: vi.fn(() => 'test-worker'),
}));

// The run ledger, likewise: no database in this file.
//
// readGlobalJobScheduleHealth is the DURABLE health reader, and it needs the same drift
// protection as the producers above for the same reason, one turn of the screw further on:
// Unit 1 shipped a consumer with no producer, Unit 2 shipped this READER WITH NO CALLER —
// it existed, it was correct, it was tested, and nothing in the runtime ever invoked it, so
// /healthz reported a clean bill of health after every restart while a tripped breaker had
// stopped the compliance purge. Unwire it again and only this file says so.
vi.mock('../../worker/core/global-job-schedule', () => ({
  claimGlobalJobRun: vi.fn(async () => false),
  finishGlobalJobRun: vi.fn(async () => null),
  readGlobalJobScheduleHealth: vi.fn(async () => {
    shared.calls.push('read-health');
    if (shared.healthError) throw shared.healthError;
    return shared.health;
  }),
}));

import { startScheduler, type SchedulerMetrics } from '../../worker/src/scheduler';
import { reconcileAbandonedRuns } from '../../worker/core/reconcile';
import { enqueueDueJobs } from '../../worker/scheduler/tiered';
import { enqueueDueGlobalJobs } from '../../worker/scheduler/global-jobs';
import { readGlobalJobScheduleHealth } from '../../worker/core/global-job-schedule';

/** Minimal pool stand-in — nothing in this test reaches SQL. */
const stubPool = { query: vi.fn(async () => ({ rows: [] })) } as never;

/**
 * Run the scheduler just long enough for its immediate boot tick, then stop it, and hand back
 * the metrics that tick left behind. Intervals are set far above the test's lifetime so only
 * the boot tick can fire and the assertions cannot be satisfied by a second, later tick —
 * which is what makes an exact `toBe(1)` on a per-tick counter safe here.
 */
async function runOneTick(): Promise<SchedulerMetrics> {
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
  return handle.metrics;
}

beforeEach(() => {
  shared.calls.length = 0;
  shared.reconcileError = null;
  shared.globalEnqueueError = null;
  shared.globalTick = { enqueued: [], skipped: [] };
  shared.health = [];
  shared.healthError = null;
  vi.mocked(reconcileAbandonedRuns).mockClear();
  vi.mocked(enqueueDueJobs).mockClear();
  vi.mocked(enqueueDueGlobalJobs).mockClear();
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

  it('runs the GLOBAL producer on the same tick — the retention purge has a producer at all', async () => {
    // Unit 1 shipped a consumer with no producer. If enqueueDueGlobalJobs() were ever
    // disconnected from tickOnce() the schedule would simply never fire, silently, and
    // nothing else in the suite would notice.
    await runOneTick();
    expect(enqueueDueGlobalJobs).toHaveBeenCalled();
    expect(shared.calls).toContain('enqueue-global');
  });

  it('sweeps BEFORE the global producer within the same tick', async () => {
    // Same load-bearing ordering as the tiered producer, for a sharper reason: the sweep is
    // what releases a global_job_run lock held by a dead worker, and that lock is the ONLY
    // thing that stops the schedule being enqueued. Sweep after and a crash-stranded
    // schedule waits an extra tick every tick.
    await runOneTick();
    const swept = shared.calls.indexOf('reconcile');
    const enqueuedGlobal = shared.calls.indexOf('enqueue-global');
    expect(swept).toBeGreaterThanOrEqual(0);
    expect(enqueuedGlobal).toBeGreaterThanOrEqual(0);
    expect(swept).toBeLessThan(enqueuedGlobal);
  });

  it('the two producers are independent — a failing tiered enqueue still runs the global one', async () => {
    // They read different tables and fail for different reasons. One lane silently
    // stopping the other is the coupled failure this project keeps finding.
    vi.mocked(enqueueDueJobs).mockImplementationOnce(async () => {
      shared.calls.push('enqueue');
      throw new Error('tiered boom');
    });
    await runOneTick();
    expect(shared.calls).toContain('enqueue-global');
  });

  it('a failing global producer is recorded and never crashes the tick', async () => {
    shared.globalEnqueueError = new Error('global boom');
    const controller = new AbortController();
    const handle = startScheduler(stubPool, {
      signal: controller.signal,
      immediate: true,
      schedulerTickMs: 600_000,
      pollIntervalMs: 600_000,
      environment: 'staging',
    });
    try {
      await vi.waitFor(() => expect(shared.calls).toContain('enqueue-global'), { timeout: 5_000 });
      await vi.waitFor(() => expect(handle.metrics.lastError).toMatch(/global/i), { timeout: 5_000 });
    } finally {
      controller.abort();
      await handle.done;
    }
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

// ── THE SWEEP'S AGE, WHICH IS A DIFFERENT QUESTION FROM WHAT THE SWEEP FOUND ────────────
//
// `lastReconcileAt` / `totalReconciled` are stamped ONLY inside `if (total > 0)`. That is
// correct for what they mean — "when did the sweep last reclaim something" — and useless for
// the question an operator actually asks first: IS THE SWEEP STILL RUNNING. A healthy system
// reclaims nothing, tick after tick, so it reported `lastReconcileAt: null` forever, which is
// byte-identical on https://kids-fun-worker.fly.dev/healthz to a sweep that had never run at
// all. Same defect class as `enabled: false` for an absent scheduler and `globalSchedules: []`
// for a blind one: a benign-looking value standing in for "I don't know".
//
// `lastReconcileAttemptAt` / `reconcileAttempts` answer the age question and ONLY the age
// question. The tests below pin the split in both directions, because the cheap wrong fix is
// to widen `lastReconcileAt` to mean "the sweep ran" and lose the found-work signal entirely.
//
// The mocked sweep in this file returns all-zeros by default — i.e. the healthy steady state
// is this file's DEFAULT, which is exactly the state that used to be unreportable.
describe('scheduler → reconcile sweep age (the sweep runs even when it finds nothing)', () => {
  it('stamps the attempt when the sweep finds NOTHING — the healthy steady state has an age', async () => {
    // THE DEFECT, DIRECTLY. Move either line out of reconcileOnce()'s `finally` and back
    // under `if (total > 0)` and this is the test that fails.
    const m = await runOneTick();
    expect(reconcileAbandonedRuns).toHaveBeenCalledTimes(1);
    expect(shared.calls).toContain('reconcile');

    expect(m.reconcileAttempts).toBe(1);
    expect(m.lastReconcileAttemptAt).not.toBeNull();
    expect(Date.parse(m.lastReconcileAttemptAt as string)).not.toBeNaN();

    // …and the found-work fields are untouched, because nothing WAS found. If these two ever
    // start reporting a swept-but-empty tick, the endpoint has lost the ability to say
    // "recovery actually had to do something", which is the whole reason they exist.
    expect(m.lastReconcileAt).toBeNull();
    expect(m.totalReconciled).toBe(0);
  });

  it('stamps the attempt when the sweep THREW — proving it is the finally, not the happy path', async () => {
    // The error path swallows deliberately (scheduler.ts: "never let the sweep take the tick
    // down"), so before this the ONLY trace of a failing sweep was `lastError` — which the
    // poll loop and the tick loop also write and overwrite. A sweep that has been throwing
    // every tick for an hour must still show an age that moves.
    shared.reconcileError = new Error('reconcile boom');
    const m = await runOneTick();
    expect(m.reconcileAttempts).toBe(1);
    expect(m.lastReconcileAttemptAt).not.toBeNull();
    expect(m.lastReconcileAt).toBeNull();
  });

  it('counts ATTEMPTS, one per tick — not a boolean, not a count of what it found', async () => {
    // A short tick so more than one sweep really happens. `reconcileAttempts` rising while
    // `totalReconciled` stays 0 is the reading that says "recovery is alive and idle", and it
    // is the reading that was impossible before.
    const controller = new AbortController();
    const handle = startScheduler(stubPool, {
      signal: controller.signal,
      immediate: true,
      schedulerTickMs: 40,
      pollIntervalMs: 600_000,
      environment: 'staging',
    });
    try {
      await vi.waitFor(() => expect(handle.metrics.reconcileAttempts).toBeGreaterThanOrEqual(3), {
        timeout: 5_000,
      });
      expect(vi.mocked(reconcileAbandonedRuns).mock.calls.length).toBe(
        handle.metrics.reconcileAttempts
      );
      expect(handle.metrics.totalReconciled).toBe(0);
      expect(handle.metrics.lastReconcileAt).toBeNull();
    } finally {
      controller.abort();
      await handle.done;
    }
  });

  it('still stamps lastReconcileAt when the sweep DOES reclaim rows — the other question survives', async () => {
    // The guard against the cheap wrong fix. If someone "simplifies" by folding
    // lastReconcileAt into the finally, the test above catches it; if someone deletes the
    // `if (total > 0)` stamp altogether, this one does. Nothing else in the suite covered
    // lastReconcileAt's positive direction at all.
    vi.mocked(reconcileAbandonedRuns).mockImplementationOnce(async () => {
      shared.calls.push('reconcile');
      return {
        jobsRequeued: 2,
        jobsDeadLettered: 1,
        checkRunsFailed: 1,
        globalJobRuns: { abandoned: 1, resolvedSuccessful: 0, breakersTripped: [] },
      };
    });
    const m = await runOneTick();
    expect(m.lastReconcileAt).not.toBeNull();
    expect(m.totalReconciled).toBe(5);
    // Both clocks stamped on a tick that found work — the fields are independent, not
    // alternatives.
    expect(m.lastReconcileAttemptAt).not.toBeNull();
    expect(m.reconcileAttempts).toBe(1);
  });
});

// ── THE DURABLE HEALTH READER'S WIRING ──────────────────────────────────────────────────
describe('scheduler → durable global-schedule health wiring', () => {
  const TRIPPED = {
    jobType: 'corrections_retention',
    status: 'breaker_tripped',
    enabled: true,
    cadenceSeconds: 86_400,
    nextRunAt: new Date('2026-07-01T00:00:00Z'),
    lastRunAt: null,
    lastSuccessAt: null,
    consecutiveFailures: 3,
    maxConsecutiveFailures: 3,
    breakerTrippedAt: new Date('2026-07-01T00:00:00Z'),
    breakerReason: 'failure: boom',
    lastRunSlot: null,
    inFlight: false,
    missedRuns: 29,
    observedAt: new Date('2026-08-01T00:00:00Z'),
  };

  async function bootAndWait(opts: {
    immediate: boolean;
    schedulerTickMs?: number;
  }): Promise<{
    metrics: ReturnType<typeof startScheduler>['metrics'];
    stop: () => Promise<void>;
  }> {
    const controller = new AbortController();
    const handle = startScheduler(stubPool, {
      signal: controller.signal,
      immediate: opts.immediate,
      schedulerTickMs: opts.schedulerTickMs ?? 600_000,
      pollIntervalMs: 600_000,
      environment: 'staging',
    });
    await vi.waitFor(() => expect(shared.calls).toContain('read-health'), { timeout: 5_000 });
    return {
      metrics: handle.metrics,
      stop: async () => {
        controller.abort();
        await handle.done;
      },
    };
  }

  it('reads durable health on the boot tick and folds it into the /healthz metrics', async () => {
    shared.health = [TRIPPED];
    const booted = await bootAndWait({ immediate: true });
    try {
      expect(readGlobalJobScheduleHealth).toHaveBeenCalledWith(stubPool);
      expect(booted.metrics.globalScheduleHealthAt).not.toBeNull();
      expect(booted.metrics.globalScheduleHealthError).toBeNull();
      expect(booted.metrics.globalBreakersTripped).toEqual(['corrections_retention']);
      expect(booted.metrics.globalSchedules).toEqual([
        {
          jobType: 'corrections_retention',
          status: 'breaker_tripped',
          enabled: true,
          missedRuns: 29,
          consecutiveFailures: 3,
          maxConsecutiveFailures: 3,
          breakerTrippedAt: '2026-07-01T00:00:00.000Z',
          breakerReason: 'failure: boom',
          nextRunAt: '2026-07-01T00:00:00.000Z',
          lastSuccessAt: null,
          inFlight: false,
        },
      ]);
    } finally {
      await booted.stop();
    }
  });

  it('reads it even when `immediate` is false — the report is not gated on the WRITE', async () => {
    // `immediate` decides whether this process enqueues on boot. Reporting what the database
    // already says is a pure SELECT, and an operator restarting after an incident must not
    // wait a whole tick interval to find out the schedule is stopped.
    shared.health = [TRIPPED];
    const booted = await bootAndWait({ immediate: false });
    try {
      expect(shared.calls).not.toContain('enqueue'); // it really did skip the tick
      expect(booted.metrics.globalBreakersTripped).toEqual(['corrections_retention']);
    } finally {
      await booted.stop();
    }
  });

  it('reads AFTER the producer, so the report reflects this tick’s own writes', async () => {
    shared.health = [TRIPPED];
    const booted = await bootAndWait({ immediate: true });
    try {
      expect(shared.calls.indexOf('enqueue-global')).toBeLessThan(
        shared.calls.indexOf('read-health')
      );
    } finally {
      await booted.stop();
    }
  });

  it('counts SKIPPED cadence slots from both halves of the tick', async () => {
    // The only place the skip count is visible without reading the ledger by hand. An
    // outage that jumps 30 daily slots is correct for the level-triggered purge and silent
    // data loss for any edge-triggered job put on this producer later.
    shared.globalTick = {
      enqueued: [
        {
          jobType: 'a',
          scheduleId: 's1',
          runId: 'r1',
          jobId: 'j1',
          scheduledFor: new Date('2026-07-01T00:00:00Z'),
          nextRunAt: new Date('2026-08-01T00:00:00Z'),
          skippedSlots: 30,
        },
      ],
      skipped: [
        {
          jobType: 'b',
          scheduleId: 's2',
          scheduledFor: new Date('2026-07-01T00:00:00Z'),
          reason: 'slot_already_served',
          nextRunAt: new Date('2026-08-01T00:00:00Z'),
          skippedSlots: 4,
        },
      ],
    };
    const booted = await bootAndWait({ immediate: true });
    try {
      expect(booted.metrics.totalGlobalSlotsSkipped).toBe(34);
      expect(booted.metrics.lastGlobalEnqueueCount).toBe(1);
    } finally {
      await booted.stop();
    }
  });

  it('a FAILING health read is reported and does NOT blank the last known state', async () => {
    // The false green, one level up: replacing a stale alarm with an empty list because the
    // read failed is indistinguishable from "everything is fine", which is the whole defect.
    shared.health = [TRIPPED];
    // A short tick so a SECOND read really happens — the point is what the second one does
    // to the state the first one left.
    const booted = await bootAndWait({ immediate: true, schedulerTickMs: 40 });
    try {
      expect(booted.metrics.globalBreakersTripped).toEqual(['corrections_retention']);

      shared.healthError = new Error('connection terminated');
      shared.calls.length = 0;
      await vi.waitFor(
        () => expect(booted.metrics.globalScheduleHealthError).toMatch(/connection terminated/),
        { timeout: 5_000 }
      );
      expect(booted.metrics.globalBreakersTripped).toEqual(['corrections_retention']);
      expect(booted.metrics.globalSchedules).toHaveLength(1);
      expect(booted.metrics.lastError).toMatch(/global schedule health/);
    } finally {
      await booted.stop();
    }
  });
});
