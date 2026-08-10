// tests/scheduler/healthz.test.ts — the worker's /healthz contract.
//
// Until this file existed there were ZERO tests over worker/src/healthz.ts. "the healthz
// tests still hold" had been offered as reassurance more than once while meaning nothing at
// all, and the endpoint is the only operator-facing signal the ingestion worker has.
//
// Four things are pinned here, in descending order of how expensive getting them wrong is:
//   1. the status code is 200 on EVERY path — see the Fly section on the first `it` below;
//   2. an ABSENT scheduler is not reported as a DISABLED one;
//   3. `globalSchedules: []` no longer means both "nothing scheduled" and "we are blind";
//   4. `lastReconcileAt: null` no longer means both "the sweep found nothing to do" and "the
//      sweep has never run" — the D-C block.
// (2), (3) and (4) are the same defect three times over: a benign-looking value standing in
// for "I don't know", on an endpoint an operator reaches for when something is already wrong.
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
    lastReconcileAttemptAt: null,
    reconcileAttempts: 0,
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
  // It is worse than a coincidence of shape: worker/src/scheduler.ts:258 initialises
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
    // ── DO NOT DELETE THIS BECAUSE THE STATE IS UNREACHABLE. THAT IS WHY IT IS HERE ────────
    // No producer emits `enabled: false` today: worker/src/scheduler.ts:258 sets it true and
    // nothing ever unsets it. So this pins a TYPE CONTRACT for a producer that does not exist
    // yet — what the reported arm must look like the day something can turn the scheduler off
    // — not a state you can observe on the endpoint now. The distinction the branch actually
    // draws today is "reporting" versus "not heard from", which the two tests around this one
    // cover. Read as documentation of current behaviour it would be wrong; read as the
    // contract it holds open, it is the cheapest guard against the next author reintroducing
    // the collapse by giving the disabled case the unknown case's shape.
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

  it('empty + read succeeded = last_read_ok (there really are no schedules)', async () => {
    const res = await get(
      state(metrics({ globalSchedules: [], globalScheduleHealthAt: '2026-01-01T00:00:00.000Z' })),
    );
    const scheduler = res.body.scheduler as Record<string, unknown>;
    expect(scheduler.globalScheduleHealthStatus).toBe('last_read_ok');
    expect(scheduler.globalSchedules).toEqual([]);
  });

  it('last_read_ok makes NO claim about age — an ancient successful read still reports it', async () => {
    // The value was called 'fresh' until 2026-08-10 and the name was doing work the predicate
    // never did: deriveGlobalScheduleHealthStatus has no age term at all (worker/src/healthz.ts).
    // Both fly manifests set `auto_stop_machines = "suspend"` (fly.toml:32,
    // fly.production.toml:32), so a resumed machine comes back with its heap — and therefore
    // this timestamp — intact and no failed read to mark it 'stale'. An alert written from the
    // old NAME rather than from the timestamp would have called that healthy.
    //
    // This pins the honest reading: the status reports the last ATTEMPT's outcome, and
    // `globalScheduleHealthAt` is the ONLY thing that carries how long ago it was. If someone
    // later adds a staleness threshold to the derivation, this test fails and the decision to
    // put an alerting policy on a public endpoint gets made deliberately.
    const ancient = '1999-01-01T00:00:00.000Z';
    const res = await get(state(metrics({ globalScheduleHealthAt: ancient })));
    const scheduler = res.body.scheduler as Record<string, unknown>;
    expect(scheduler.globalScheduleHealthStatus).toBe('last_read_ok');
    expect(scheduler.globalScheduleHealthAt).toBe(ancient);
    // …and the derivation itself is indifferent to the instant, not merely tolerant of it:
    // two timestamps 27 years apart produce the same verdict.
    expect(
      deriveGlobalScheduleHealthStatus({
        globalScheduleHealthAt: ancient,
        globalScheduleHealthError: null,
      }),
    ).toBe(
      deriveGlobalScheduleHealthStatus({
        globalScheduleHealthAt: '2026-01-01T00:00:00.000Z',
        globalScheduleHealthError: null,
      }),
    );
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
    ).toBe('last_read_ok');
    expect(
      deriveGlobalScheduleHealthStatus({ globalScheduleHealthAt: 'x', globalScheduleHealthError: 'boom' }),
    ).toBe('stale');
  });
});

describe('/healthz — a sweep that found NOTHING is not a sweep that never RAN (D-C)', () => {
  // Third instance of this file's recurring defect, on the abandoned-run sweep.
  // `lastReconcileAt` is stamped only when the sweep reclaims something (worker/src/
  // scheduler.ts's reconcileOnce, `if (total > 0)`), which is the correct meaning for that
  // field and the wrong answer to the question an operator asks first. A healthy worker
  // reclaims nothing week after week, so it served `lastReconcileAt: null` forever — the
  // same bytes a worker whose sweep had never run once would serve.
  //
  // `lastReconcileAttemptAt` / `reconcileAttempts` carry the AGE and the PROGRESS; the pair
  // above still carries WHAT WAS FOUND. What an operator concludes, in one sentence:
  // lastReconcileAttemptAt is when recovery last ran (judged against their own clock, not
  // this process's), and reconcileAttempts: 0 is the only reading that means it is not
  // running at all.
  //
  // These assert VALUES of fields this file's own fixture set, which is a different thing
  // from the key-set pins below — those stay `Object.keys(...).sort()` and never compare
  // values, because on the day one catches a real leak a value compare copies the leaked
  // value into the CI log.
  const NEVER_SWEPT = metrics();
  const SWEPT_FOUND_NOTHING = metrics({
    lastReconcileAttemptAt: '2026-01-01T00:05:00.000Z',
    reconcileAttempts: 240,
  });

  it('never swept = no age and no attempts, and that is the ONLY state that means so', async () => {
    const s = (await get(state(NEVER_SWEPT))).body.scheduler as Record<string, unknown>;
    expect(s.lastReconcileAttemptAt).toBeNull();
    expect(s.reconcileAttempts).toBe(0);
    expect(s.lastReconcileAt).toBeNull();
  });

  it('swept 240 times and reclaimed nothing = the healthy steady state, and it is legible', async () => {
    const s = (await get(state(SWEPT_FOUND_NOTHING))).body.scheduler as Record<string, unknown>;
    expect(s.lastReconcileAttemptAt).toBe('2026-01-01T00:05:00.000Z');
    expect(s.reconcileAttempts).toBe(240);
    // Untouched, because nothing was ever reclaimed. Widening these to mean "the sweep ran"
    // would destroy the found-work signal, which is a genuinely different question.
    expect(s.lastReconcileAt).toBeNull();
    expect(s.totalReconciled).toBe(0);
  });

  it('THE DEFECT ITSELF: the two are now distinguishable on the wire', async () => {
    const never = (await get(state(NEVER_SWEPT))).body.scheduler as Record<string, unknown>;
    const idle = (await get(state(SWEPT_FOUND_NOTHING))).body.scheduler as Record<string, unknown>;
    // Identical on the field an operator used to reach for…
    expect(never.lastReconcileAt).toEqual(idle.lastReconcileAt);
    expect(never.totalReconciled).toEqual(idle.totalReconciled);
    // …and now separable, by a timestamp and an integer. No prose was added to do it: this
    // endpoint is public and unauthenticated (see the note on SchedulerReport).
    expect(never.lastReconcileAttemptAt).not.toEqual(idle.lastReconcileAttemptAt);
    expect(never.reconcileAttempts).not.toEqual(idle.reconcileAttempts);
  });

  it('the two questions stay independent when the sweep DID reclaim rows', async () => {
    const s = (
      await get(
        state(
          metrics({
            lastReconcileAttemptAt: '2026-01-01T00:05:00.000Z',
            reconcileAttempts: 240,
            lastReconcileAt: '2026-01-01T00:03:00.000Z',
            totalReconciled: 7,
          }),
        ),
      )
    ).body.scheduler as Record<string, unknown>;
    // "recovery last ran at :05, and the last time it actually had work was :03, 7 rows so
    // far" — four fields, two questions, no sentence.
    expect(s.lastReconcileAttemptAt).toBe('2026-01-01T00:05:00.000Z');
    expect(s.lastReconcileAt).toBe('2026-01-01T00:03:00.000Z');
    expect(s.reconcileAttempts).toBe(240);
    expect(s.totalReconciled).toBe(7);
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
    // channel appearing.
    //
    // ── EXACTLY WHAT THIS ONE COVERS, WHICH IS LESS THAN IT USED TO CLAIM ────────────────
    // It pins the keys /healthz ADDS ON TOP OF the metrics, and only those. `added` is a
    // DIFFERENCE against `m`, so a field added to `SchedulerMetrics` itself is on both sides
    // of the subtraction and is filtered out here BY CONSTRUCTION — this assertion can never
    // report a producer-side addition, however it is tuned. That case is the next test's,
    // and a field added NEXT TO `scheduler` rather than inside it is the one after that.
    // The three are disjoint on purpose; none of them is redundant, and the header comment
    // that used to describe this one as covering "any future addition to the body" was
    // wrong in the exact direction that matters.
    const m = metrics({ globalScheduleHealthAt: '2026-01-01T00:00:00.000Z' });
    const scheduler = (await get(state(m))).body.scheduler as Record<string, unknown>;
    const added = Object.keys(scheduler).filter((k) => !Object.hasOwn(m, k));
    expect(added.sort()).toEqual(['globalScheduleHealthStatus', 'known']);
    // …and the one added string is a closed enum of three constants, not runtime text.
    expect(['unknown', 'last_read_ok', 'stale']).toContain(scheduler.globalScheduleHealthStatus);
  });

  it('the REPORTED arm is a FIXED key set — a producer field cannot reach the wire unannounced', async () => {
    // ── WHY THIS EXISTS WHEN THE GUARD ABOVE LOOKS LIKE IT ALREADY COVERS IT ─────────────
    // That guard computes `Object.keys(scheduler).filter((k) => !Object.hasOwn(m, k))`: what
    // /healthz ADDS to the metrics. A new field on `SchedulerMetrics` (worker/src/scheduler.ts)
    // is present in `m`, so the filter removes it — not because the threshold is wrong but
    // because that is what the expression computes. The whole-body guard below is blind to it
    // too: it pins the six TOP-LEVEL keys, and a producer field arrives INSIDE `scheduler`.
    //
    // So the producer path was the one route neither guard watched — and it is not a
    // hypothetical route. It is how `lastError` and `globalScheduleHealthError` put raw pg
    // driver text on this endpoint in the first place (worker/src/scheduler.ts:530 assigns
    // `lastError` from `errMsg(err)` on any poll failure, and a pg error routinely names host,
    // port, database and user). This endpoint is confirmed public and unauthenticated on both
    // production and staging.
    //
    // ── THE LIST IS A HARD-CODED LITERAL AND MUST STAY ONE ───────────────────────────────
    // Do NOT rewrite it as `Object.keys(metrics())`, `Object.keys(m)`, or anything else read
    // from a runtime value. That reproduces the exact by-construction flaw above: a new
    // producer key would enter the fixture and the expectation in the SAME INSTANT, and this
    // guard would be green forever while the field sailed onto the public edge. It works
    // precisely BECAUSE the `metrics()` fixture is declared `: SchedulerMetrics`, so tsc
    // FORCES it to gain any new producer field, schedulerReport's spread carries that field
    // onto this arm, and this literal then fails BY NAME. Editing the list is the deliberate
    // human act the guard exists to require.
    //
    // ── KEYS ONLY. NEVER `toEqual` ON THE WHOLE OBJECT, NEVER COMPARE VALUES ─────────────
    // A value comparison reads as strictly stronger and is strictly worse here: on the day
    // this guard catches a real leak, it would copy the leaked value into the CI log, which
    // is the thing the guard exists to prevent. Standing project ruling — if you think you
    // need a value compare here, stop and ask.
    //
    // WHAT THIS STILL DOES NOT PIN: values, and anything NESTED. `globalSchedules` entries
    // carry their own keys, including `breakerReason: string | null`
    // (worker/src/scheduler.ts:62) — free text already on the wire that nothing in this file
    // looks inside.
    //
    // ── THREE WAYS A FUTURE AUTHOR CAN DEFEAT THIS GUARD. ALL THREE MEASURED, NOT REASONED ──
    // This guard reads the FIXTURE's key set, not the producer's. It catches producer drift
    // only because tsc forces `metrics()` to mirror `SchedulerMetrics`. Break the mirror and
    // the guard goes green while the field ships live on a public endpoint:
    //
    //  1. AN OPTIONAL FIELD IS INVISIBLE TO IT. `foo?: string` on SchedulerMetrics never
    //     forces the fixture to gain the key, so `Object.keys` never sees it here — while the
    //     REAL producer object, which does set it, spreads it straight onto the wire through
    //     schedulerReport. Measured: added an optional field + set it in the producer → tsc
    //     SILENT, every test in this file GREEN. SchedulerMetrics has ZERO optional fields
    //     today, and that is not cosmetic — it is the precondition that makes this guard
    //     work. Keep it that way; a field that is genuinely sometimes-absent should be
    //     `T | null`, which is required and therefore forced into the fixture.
    //
    //  2. A CAST LAUNDERS ANYTHING PAST IT, AND THIS IS THE DANGEROUS ONE. Writing
    //     `} as SchedulerMetrics;` at the end of the fixture silences tsc completely.
    //     Measured: added a REQUIRED producer field with the cast in place → tsc SILENT,
    //     every test in this file GREEN, field live. Do not introduce a cast here, and do
    //     not "fix" a type error in this fixture by reaching for one — that error IS the
    //     guard firing.
    //
    //  3. LOOSENING THE RETURN-TYPE ANNOTATION degrades it but, measured, does NOT silently
    //     defeat it: removing `: SchedulerMetrics` from `metrics()` still fails tsc, because
    //     EVERY call site that passes the fixture where a `SchedulerMetrics` is expected
    //     re-checks it structurally and reports its own error. WHICH tsc, though, is the part
    //     that decides whether you ever see it: ROOT `tsc --noEmit` fails (26 such call sites,
    //     measured at a576bd9); `tsc -p worker/tsconfig.json` STAYS CLEAN, because that
    //     project's `include` is worker-only and this test file is not in it. An author who
    //     builds only the worker sees green and concludes the guard is intact. The errors also
    //     move to those call sites and misattribute (they lead with `environment` widening to
    //     `string`), so the real failure is stated confusingly and an author is tempted into
    //     (2) to make it quiet. Keep the annotation — not because it is the only check, but
    //     because it is the one that fails HERE, legibly.
    //
    //     ── A COUNT IN A COMMENT MUST CARRY THE SHA IT WAS MEASURED AT, OR IT ROTS ────────
    //     That "26" is stamped because the number is a property of a moment, not of the
    //     mechanism, and a bare count reads as timeless. Demonstrated at this repo's expense:
    //     it was honestly measured as 21 at 3958e22 and FALSIFIED BY THE VERY COMMIT THAT
    //     WROTE IT DOWN — a576bd9's new D-C block added five more `metrics()` call sites, so
    //     the comment shipped stale in the same diff that introduced it. Prefer the sentence
    //     above, which stays true as call sites come and go; keep the number only as
    //     corroboration, and re-stamp it if you re-measure. The error direction here is
    //     CONSERVATIVE — more call sites fail than the old text claimed, so the guard was
    //     always stronger than advertised — but a comment that is wrong in a safe direction
    //     is still a comment a reader cannot trust.
    //
    // ── EXERCISED FOR REAL, 2026-08-10, BY `lastReconcileAttemptAt`/`reconcileAttempts` ──
    // The first genuine producer-side addition since this list existed. It went exactly as
    // described above, and the ORDER is worth recording because the middle step looks like
    // the guard failing to work:
    //   1. fields added to SchedulerMetrics ONLY → root `tsc --noEmit` failed HERE, at the
    //      `metrics()` fixture, naming `lastReconcileAttemptAt`;
    //   2. with the producer already carrying both fields and the fixture not yet updated,
    //      THIS FILE RAN GREEN END TO END. Vitest does not typecheck, so the fixture still built
    //      the old key set. tsc is the FIRST link in this chain, not a formality beside it —
    //      the runtime pin below cannot see a producer field until tsc has forced the fixture
    //      to carry one. That is exactly why defeat vectors (1) and (2) work;
    //   3. fixture updated → the assertion below failed by name, printing precisely
    //      `+ "lastReconcileAttemptAt"` and `+ "reconcileAttempts"`, and the literal was then
    //      edited by hand.
    // If you are here because step 1 or step 3 just failed at you: that is this guard doing
    // its job. Add the key to the list deliberately. Do not derive the list; do not cast.
    const REPORTED_ARM_KEYS = [
      'enabled',
      'environment',
      'globalBreakersTripped',
      'globalScheduleHealthAt',
      'globalScheduleHealthError',
      'globalScheduleHealthStatus',
      'globalSchedules',
      'jobsFailed',
      'jobsProcessed',
      'jobsSucceeded',
      'known',
      'lastEnqueueCount',
      'lastError',
      'lastGlobalEnqueueCount',
      'lastJobAt',
      'lastReconcileAt',
      'lastReconcileAttemptAt',
      'lastTickAt',
      'pollIntervalMs',
      'reconcileAttempts',
      'schedulerTickMs',
      'ticks',
      'totalEnqueued',
      'totalGlobalEnqueued',
      'totalGlobalSlotsSkipped',
      'totalReconciled',
    ];
    // Every state that reaches the reported arm, so a key present in only one of them is
    // caught as well. `known: true` is asserted first so a state that quietly stopped
    // reaching this arm fails as itself rather than as a key-set mismatch.
    const reported: Array<[string, HealthState]> = [
      ['the durable read has NEVER succeeded', state(metrics())],
      [
        'the durable read succeeded',
        state(metrics({ globalScheduleHealthAt: '2026-01-01T00:00:00.000Z' })),
      ],
      [
        'the durable read is stale',
        state(
          metrics({
            globalSchedules: [snapshot()],
            globalScheduleHealthAt: '2026-01-01T00:00:00.000Z',
            globalScheduleHealthError: 'connection terminated unexpectedly',
            globalBreakersTripped: ['corrections_retention'],
          }),
        ),
      ],
      // Type contract only — no producer emits enabled:false today (scheduler.ts:258). Held in
      // the list so the key set is pinned for that arm too if one ever does.
      ['a scheduler reporting itself disabled', state(metrics({ enabled: false }))],
    ];
    for (const [label, s] of reported) {
      const scheduler = (await get(s)).body.scheduler as Record<string, unknown>;
      expect(scheduler.known, `${label}: this state did not reach the reported arm`).toBe(true);
      expect(
        Object.keys(scheduler).sort(),
        `/healthz scheduler.known:true arm changed shape (${label}) — a key was added to or ` +
          'removed from SchedulerMetrics and is now on a public, unauthenticated endpoint',
      ).toEqual(REPORTED_ARM_KEYS);
    }
  });

  it('the WHOLE body is a fixed key set — nothing new reaches the public edge unnoticed', async () => {
    // The two guards above pin the `scheduler` sub-object — what /healthz adds to the metrics,
    // and the full key set of the reported arm. This pins the TOP LEVEL, which neither of them
    // can see: a field added next to `scheduler` rather than inside it would reach
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
