// tests/scheduler/healthz.test.ts — the worker's /healthz contract.
//
// Until this file existed there were ZERO tests over worker/src/healthz.ts. "the healthz
// tests still hold" had been offered as reassurance more than once while meaning nothing at
// all, and the endpoint is the only operator-facing signal the ingestion worker has.
//
// Three things are pinned here, in descending order of how expensive getting them wrong is:
//   1. the status code is 200 on EVERY path — see the Fly section on the first `it` below;
//   2. an ABSENT scheduler is not reported as a DISABLED one;
//   3. `globalSchedules: []` no longer means both "nothing scheduled" and "we are blind".
//
// Requests go over a REAL socket rather than through a stubbed ServerResponse, because the
// thing being pinned in (1) is precisely what Fly's prober sees on the wire — a stub whose
// writeHead ignores its arguments could not tell the difference, and that is the exact
// failure mode this file is here to make impossible.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { healthz, deriveGlobalScheduleHealthStatus, type HealthState } from '../../worker/src/healthz';
import type { GlobalScheduleHealthSnapshot, SchedulerMetrics } from '../../worker/src/scheduler';

// ── a real server serving the real handler, exactly as worker/src/index.ts wires it ───────
let server: Server;
let port: number;
/** The state the next request will be served with. Set by `get()`. */
let served: HealthState;

beforeAll(async () => {
  server = createServer((req, res) => healthz(req, res, served));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('server did not bind a port');
  port = addr.port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** GET /healthz with `state` installed, returning what an operator (or Fly) would receive. */
async function get(state: HealthState): Promise<{
  status: number;
  contentType: string | null;
  body: Record<string, unknown>;
}> {
  served = state;
  const res = await fetch(`http://127.0.0.1:${port}/healthz`);
  const text = await res.text();
  return {
    status: res.status,
    contentType: res.headers.get('content-type'),
    body: JSON.parse(text) as Record<string, unknown>,
  };
}

function metrics(overrides: Partial<SchedulerMetrics> = {}): SchedulerMetrics {
  return {
    enabled: true,
    environment: 'staging',
    schedulerTickMs: 60_000,
    pollIntervalMs: 5_000,
    ticks: 3,
    lastTickAt: '2026-01-01T00:00:00.000Z',
    lastEnqueueCount: 0,
    totalEnqueued: 0,
    lastGlobalEnqueueCount: 0,
    totalGlobalEnqueued: 0,
    totalGlobalSlotsSkipped: 0,
    globalBreakersTripped: [],
    globalSchedules: [],
    globalScheduleHealthAt: null,
    globalScheduleHealthError: null,
    jobsProcessed: 0,
    jobsSucceeded: 0,
    jobsFailed: 0,
    lastJobAt: null,
    lastReconcileAt: null,
    totalReconciled: 0,
    lastError: null,
    ...overrides,
  };
}

function snapshot(overrides: Partial<GlobalScheduleHealthSnapshot> = {}): GlobalScheduleHealthSnapshot {
  return {
    jobType: 'corrections_retention',
    status: 'breaker_tripped',
    enabled: true,
    missedRuns: 29,
    consecutiveFailures: 3,
    maxConsecutiveFailures: 3,
    breakerTrippedAt: '2026-01-01T00:00:00.000Z',
    breakerReason: 'long gone',
    nextRunAt: '2026-01-02T00:00:00.000Z',
    lastSuccessAt: null,
    inFlight: false,
    ...overrides,
  };
}

const state = (scheduler: HealthState['scheduler']): HealthState => ({
  chromiumReady: true,
  bootedAt: '2026-01-01T00:00:00.000Z',
  scheduler,
});

describe('/healthz — the status code is 200 on every path (Fly liveness contract)', () => {
  // ── DO NOT "FIX" THIS BY MAKING THE STATUS CODE CONDITIONAL ─────────────────────────────
  // worker/fly.toml:36-41 and worker/fly.production.toml:36-41 BOTH declare
  //     [[http_service.checks]] method = "get" path = "/healthz"
  //                             interval = "30s" timeout = "5s" grace_period = "20s"
  // alongside auto_stop_machines = "suspend" and min_machines_running = 1. Fly polls this
  // path every 30 seconds AS THE MACHINE'S LIVENESS PROBE on BOTH apps.
  //
  // A non-200 therefore does not raise an alert — it makes Fly REPLACE THE MACHINE. So a
  // worker that is unhealthy *because the database is unreachable* would be killed and
  // rebooted every 30 seconds for as long as the database stayed unreachable: a crash loop,
  // in production, on the worker doing real ingestion. Nothing else in this repo simulates
  // Fly's prober, so every other test would stay green while that happened. That is why
  // this case is pinned here rather than left to the comment in worker/src/healthz.ts.
  //
  // Health that an operator or an alert should act on belongs in the BODY, and the rest of
  // this file is about making that body trustworthy. If alerting genuinely needs a non-200
  // surface, that is a separate endpoint and a conscious decision — not an edit here.
  const unhealthy: Array<[string, HealthState]> = [
    ['scheduler state is ABSENT', state(undefined)],
    ['scheduler state is explicitly null', state(null)],
    ['the durable health read has NEVER succeeded (worker is blind)', state(metrics())],
    [
      'the durable health read is FAILING right now',
      state(metrics({ globalScheduleHealthError: 'connection terminated unexpectedly' })),
    ],
    [
      'the durable health is STALE — last read failed, data is from the past',
      state(
        metrics({
          globalSchedules: [snapshot()],
          globalScheduleHealthAt: '2026-01-01T00:00:00.000Z',
          globalScheduleHealthError: 'connection terminated unexpectedly',
          globalBreakersTripped: ['corrections_retention'],
        }),
      ),
    ],
    [
      'a breaker is OPEN and the scheduler is reporting its own last error',
      state(
        metrics({
          globalSchedules: [snapshot()],
          globalScheduleHealthAt: '2026-01-01T00:00:00.000Z',
          globalBreakersTripped: ['corrections_retention'],
          lastError: 'global schedule health: connection terminated unexpectedly',
        }),
      ),
    ],
    ['chromium never became ready', { chromiumReady: false, bootedAt: 'x', scheduler: metrics() }],
    ['the scheduler is disabled', state(metrics({ enabled: false }))],
  ];

  it.each(unhealthy)('returns HTTP 200 when %s', async (_label, s) => {
    const res = await get(s);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('serves JSON and identifies the service on every one of those paths', async () => {
    for (const [, s] of unhealthy) {
      const res = await get(s);
      expect(res.contentType).toBe('application/json');
      expect(res.body.service).toBe('kids-fun-worker');
      expect(typeof res.body.uptimeSeconds).toBe('number');
    }
  });
});

describe('/healthz — an ABSENT scheduler is not a DISABLED one (D-A)', () => {
  // The endpoint used to render a missing scheduler as `{ enabled: false }` — a value that
  // reads as a deliberate configuration ("somebody turned it off") when it actually means
  // "nothing has been heard from the scheduler at all".
  //
  // It is worse than a coincidence of shape: worker/src/scheduler.ts:219 initialises
  // `enabled: true` and NOTHING in the file ever assigns it false, so `enabled: false` on
  // the wire could only EVER have been produced by this unknown branch. The one field an
  // operator would reach for to answer "is the scheduler running?" was, in every case where
  // it said no, reporting an absence of information as a configuration choice.
  //
  // What `known: false` still does NOT say is WHY the scheduler is absent —
  // worker/src/index.ts distinguishes "DATABASE_URL is not set" (:36-40, deliberate) from
  // "startScheduler threw" (:45-51, a failure) and currently tells only the log. Naming
  // that on the wire needs a producer change and a decision about putting failure detail on
  // a publicly-probed endpoint, so it is deliberately left out of this unit.
  it('reports known:false and NO enabled key at all', async () => {
    for (const absent of [undefined, null]) {
      const res = await get(state(absent));
      const scheduler = res.body.scheduler as Record<string, unknown>;
      expect(scheduler.known).toBe(false);
      // Not `enabled: null` — the key is absent, so reading `false` out of the unknown case
      // is impossible rather than merely discouraged.
      expect(Object.hasOwn(scheduler, 'enabled')).toBe(false);
    }
  });

  it('the unknown report is PURE STRUCTURE — no free text can ride along', async () => {
    // THIS RESPONSE IS PUBLIC — confirmed, not suspected. Fly's API and a direct curl of both
    // default hostnames show production and staging each holding a real public IP, with
    // https://kids-fun-worker.fly.dev/healthz (and the staging equivalent) returning HTTP 200
    // and this entire body to anyone, unauthenticated. It is unauthenticated in code
    // (worker/src/index.ts:54-57), bound to every interface (index.ts:80 `server.listen(PORT)`,
    // no host) and published at Fly's edge by both manifests ([http_service] + force_https,
    // fly.toml:29-31, fly.production.toml:29-31).
    //
    // The unknown arm therefore says what it means with a boolean and an absent key. It has
    // no `reason`, no message, no error, no string of any kind. That is not stylistic: a
    // free-text field on a possibly-public endpoint is where the next author interpolates
    // `errMsg(err)`, and a pg driver error routinely names host, port, database and user.
    // If someone adds one, this fails and says so.
    for (const absent of [undefined, null]) {
      const scheduler = (await get(state(absent))).body.scheduler as Record<string, unknown>;
      expect(Object.keys(scheduler)).toEqual(['known']);
      for (const [key, value] of Object.entries(scheduler)) {
        expect(typeof value, `/healthz unknown scheduler grew a string field: ${key}`).not.toBe('string');
      }
    }
  });

  it('reports a deliberately disabled scheduler as known:true, enabled:false', async () => {
    const res = await get(state(metrics({ enabled: false })));
    const scheduler = res.body.scheduler as Record<string, unknown>;
    expect(scheduler.known).toBe(true);
    expect(scheduler.enabled).toBe(false);
  });

  it('THE DEFECT ITSELF: an absent scheduler can never present as a configured-off one', async () => {
    for (const absent of [undefined, null]) {
      const scheduler = (await get(state(absent))).body.scheduler as Record<string, unknown>;
      // This is the reader predicate the endpoint used to answer wrongly: `enabled === false`
      // meant "off" to every operator and every alert that would have been built on it, and
      // it was true for a scheduler nobody had heard from. It must now be unreachable here.
      expect(scheduler.enabled === false, 'an unknown scheduler is reporting itself OFF').toBe(false);
      expect(scheduler.known).toBe(false);
    }
    // …and a scheduler that IS reporting is never mistaken for an absent one, whichever way
    // its `enabled` flag happens to read.
    const reporting = (await get(state(metrics({ enabled: false })))).body.scheduler;
    const unknown = (await get(state(undefined))).body.scheduler;
    expect(JSON.stringify(reporting)).not.toBe(JSON.stringify(unknown));
  });
});

describe('/healthz — an empty globalSchedules is no longer ambiguous (D-B)', () => {
  // `globalSchedules: []` meant BOTH "no global schedules are configured" and "the durable
  // read has never succeeded, so I know nothing". `globalScheduleHealthAt` already carried
  // the difference, but only for a reader who happened to know the convention — and a reader
  // who does not know it treats blindness as a clean bill of health. It is now named.
  it('empty + never read = unknown (the worker is BLIND, not idle)', async () => {
    const res = await get(state(metrics({ globalSchedules: [], globalScheduleHealthAt: null })));
    const scheduler = res.body.scheduler as Record<string, unknown>;
    expect(scheduler.globalScheduleHealthStatus).toBe('unknown');
    expect(scheduler.globalScheduleHealthAt).toBeNull();
  });

  it('empty + read succeeded = fresh (there really are no schedules)', async () => {
    const res = await get(
      state(metrics({ globalSchedules: [], globalScheduleHealthAt: '2026-01-01T00:00:00.000Z' })),
    );
    const scheduler = res.body.scheduler as Record<string, unknown>;
    expect(scheduler.globalScheduleHealthStatus).toBe('fresh');
    expect(scheduler.globalSchedules).toEqual([]);
  });

  it('THE DEFECT ITSELF: the two empty-array cases are now distinguishable', async () => {
    const blind = (await get(state(metrics({ globalScheduleHealthAt: null })))).body
      .scheduler as Record<string, unknown>;
    const idle = (await get(state(metrics({ globalScheduleHealthAt: '2026-01-01T00:00:00.000Z' }))))
      .body.scheduler as Record<string, unknown>;
    expect(blind.globalSchedules).toEqual(idle.globalSchedules); // identical payload…
    expect(blind.globalScheduleHealthStatus).not.toBe(idle.globalScheduleHealthStatus); // …different meaning
  });

  it('read succeeded once but the LAST attempt failed = stale, with last-known-good retained', async () => {
    const res = await get(
      state(
        metrics({
          globalSchedules: [snapshot()],
          globalScheduleHealthAt: '2026-01-01T00:00:00.000Z',
          globalScheduleHealthError: 'connection terminated unexpectedly',
          globalBreakersTripped: ['corrections_retention'],
        }),
      ),
    );
    const scheduler = res.body.scheduler as Record<string, unknown>;
    expect(scheduler.globalScheduleHealthStatus).toBe('stale');
    // worker/src/scheduler.ts's refreshGlobalScheduleHealth deliberately does NOT blank the
    // list on a failed read — a stale alarm is useful, a silently emptied one is the false
    // green again. 'stale' is what tells a reader the list describes globalScheduleHealthAt
    // rather than now.
    expect(scheduler.globalSchedules).toHaveLength(1);
    expect(scheduler.globalBreakersTripped).toEqual(['corrections_retention']);
  });

  it('the derivation is total over the three field combinations', () => {
    expect(
      deriveGlobalScheduleHealthStatus({ globalScheduleHealthAt: null, globalScheduleHealthError: null }),
    ).toBe('unknown');
    // A first read that FAILED is still unknown — an error does not imply data.
    expect(
      deriveGlobalScheduleHealthStatus({ globalScheduleHealthAt: null, globalScheduleHealthError: 'boom' }),
    ).toBe('unknown');
    expect(
      deriveGlobalScheduleHealthStatus({ globalScheduleHealthAt: 'x', globalScheduleHealthError: null }),
    ).toBe('fresh');
    expect(
      deriveGlobalScheduleHealthStatus({ globalScheduleHealthAt: 'x', globalScheduleHealthError: 'boom' }),
    ).toBe('stale');
  });
});

describe('/healthz — the fields other guards poll are still on the wire', () => {
  // tests/scheduler/global-jobs-db.test.ts's awaitDurableHealth and
  // tests/scheduler/__fixtures__/restarted-worker.cjs both poll this body over a real socket
  // and give up on `body.scheduler.globalScheduleHealthAt`. Reshaping the payload could
  // silently defang those real-process guards — they would time out or read undefined
  // rather than fail loudly on the thing they exist to catch. This asserts the contract they
  // depend on, in the lane that runs without a database.
  it('carries the keys the real-process restart proofs read', async () => {
    const res = await get(
      state(metrics({ globalScheduleHealthAt: '2026-01-01T00:00:00.000Z', globalSchedules: [snapshot()] })),
    );
    const scheduler = res.body.scheduler as Record<string, unknown>;
    for (const key of [
      'globalScheduleHealthAt',
      'globalScheduleHealthError',
      'globalSchedules',
      'globalBreakersTripped',
      'ticks',
      'lastGlobalEnqueueCount',
      'enabled',
    ]) {
      expect(Object.hasOwn(scheduler, key), `/healthz stopped serving scheduler.${key}`).toBe(true);
    }
  });

  it('adds ONLY structure on top of the metrics it already served — no new field slips in', async () => {
    // The reported arm spreads SchedulerMetrics verbatim, which already carries `lastError`
    // and `globalScheduleHealthError` — raw driver text that predates this unit and is not
    // this unit's to change in either direction. What must not happen is a THIRD such
    // channel appearing. This pins the exact set of keys /healthz adds to the metrics, so
    // any future addition to the body is a deliberate, visible decision rather than a diff
    // nobody read — on an endpoint confirmed to be serving this payload publicly and
    // unauthenticated on both production and staging today.
    const m = metrics({ globalScheduleHealthAt: '2026-01-01T00:00:00.000Z' });
    const scheduler = (await get(state(m))).body.scheduler as Record<string, unknown>;
    const added = Object.keys(scheduler).filter((k) => !Object.hasOwn(m, k));
    expect(added.sort()).toEqual(['globalScheduleHealthStatus', 'known']);
    // …and the one added string is a closed enum of three constants, not runtime text.
    expect(['unknown', 'fresh', 'stale']).toContain(scheduler.globalScheduleHealthStatus);
  });

  it('the WHOLE body is a fixed key set — nothing new reaches the public edge unnoticed', async () => {
    // The guard above pins the `scheduler` sub-object. This pins the top level, which that
    // one cannot see: a field added next to `scheduler` rather than inside it would reach
    // https://kids-fun-worker.fly.dev/healthz just as publicly and pass every other
    // assertion in this file. The endpoint is confirmed public and unauthenticated on both
    // apps, so the set of things it says is worth stating exactly once, here.
    //
    // If you are adding a key deliberately: change this list, and think about who can read
    // it before you do. `lastError` and `globalScheduleHealthError` already carry raw pg
    // driver text out through `scheduler` — that predates this test and is a separate unit's
    // to remediate, but it is the precedent this list exists to stop repeating.
    for (const s of [state(undefined), state(metrics()), { chromiumReady: false, bootedAt: 'x' }]) {
      const res = await get(s);
      expect(Object.keys(res.body).sort()).toEqual([
        'bootedAt',
        'chromiumReady',
        'scheduler',
        'service',
        'status',
        'uptimeSeconds',
      ]);
    }
  });

  it('echoes the process-level fields unchanged', async () => {
    const res = await get({ chromiumReady: false, bootedAt: '2026-02-03T04:05:06.000Z', scheduler: null });
    expect(res.body.chromiumReady).toBe(false);
    expect(res.body.bootedAt).toBe('2026-02-03T04:05:06.000Z');
  });
});
