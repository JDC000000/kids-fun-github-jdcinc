// tests/scheduler/healthz.test.ts — the worker's /healthz contract.
//
// Until this file existed there were ZERO tests over worker/src/healthz.ts. "the healthz
// tests still hold" had been offered as reassurance more than once while meaning nothing at
// all, and the endpoint is the only operator-facing signal the ingestion worker has.
//
// Five things are pinned here, in descending order of how expensive getting them wrong is:
//   1. the status code is 200 on EVERY path — see the Fly section on the first `it` below;
//   2. the body carries NO FREE TEXT — the D-D block. This endpoint is public and
//      unauthenticated (confirmed, not suspected), and it used to serve raw pg driver text
//      through `lastError`, `globalScheduleHealthError` and the NESTED
//      `globalSchedules[].breakerReason`;
//   3. an ABSENT scheduler is not reported as a DISABLED one;
//   4. `globalSchedules: []` no longer means both "nothing scheduled" and "we are blind";
//   5. `lastReconcileAt: null` no longer means both "the sweep found nothing to do" and "the
//      sweep has never run" — the D-C block.
// (3), (4) and (5) are the same defect three times over: a benign-looking value standing in
// for "I don't know", on an endpoint an operator reaches for when something is already wrong.
// (2) is the mirror image of it — the endpoint saying far MORE than it should, to everyone —
// and its fix is the same discipline: distinguish states with structure, never with prose.
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
    lastErrorKind: null,
    lastErrorAt: null,
    errorCount: 0,
    ...overrides,
  };
}

/**
 * A metrics object where EVERY producer-side free-text field carries a sentinel this file
 * authored, including the one nested inside `globalSchedules`.
 *
 * Used only by the reduction block below. The strings are constants declared here, so an
 * assertion that they are ABSENT from the body can never print anything the test did not
 * already contain — which is the whole reason this is allowed to look at content at all
 * while the four key-set pins stay `Object.keys(...).sort()` and never compare values.
 */
const SENTINEL = {
  lastError: 'SENTINEL_LAST_ERROR_pg_host_db_user',
  globalScheduleHealthError: 'SENTINEL_HEALTH_READ_ERROR_relation_does_not_exist',
  breakerReason: 'SENTINEL_BREAKER_REASON_failure_detail',
} as const;

const poisoned = (): SchedulerMetrics =>
  metrics({
    lastError: SENTINEL.lastError,
    lastErrorKind: 'poll',
    lastErrorAt: '2026-01-01T00:07:00.000Z',
    errorCount: 4,
    globalScheduleHealthAt: '2026-01-01T00:00:00.000Z',
    globalScheduleHealthError: SENTINEL.globalScheduleHealthError,
    globalSchedules: [snapshot({ breakerReason: SENTINEL.breakerReason })],
    globalBreakersTripped: ['corrections_retention'],
  });

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
    // `errMsg(err)`. Measured on a real pool at this commit, a pg error names the DATABASE
    // (`database "x" does not exist`), the ROLE (`password authentication failed for user
    // "postgres"`) and INTERNAL TABLES (`relation "global_job_schedule" does not exist`).
    // This comment used to say "host, port, database and user"; host and port did NOT
    // reproduce — the connection-refused path that would carry them yields an EMPTY message
    // from node-postgres — and table names, the most commonly observed of all, were missing
    // from the list. Corrected from measurement rather than repeated.
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

/**
 * THE PUBLISHED KEY SET OF THE `known: true` ARM — A HARD-CODED LITERAL. KEEP IT ONE.
 *
 * Do NOT rewrite it as `Object.keys(metrics())`, `Object.keys(m)`, or anything read from a
 * runtime value, including anything derived from the projection itself. A derived list
 * enters the expectation in the same instant as the key it is meant to question, and the
 * guard is then green forever while the field sails onto the public edge. Editing this by
 * hand is the deliberate act the guard exists to require.
 *
 * Shared by the two guards that pin it — the full-key-set pin and the allow-list probe —
 * so a hand edit cannot satisfy one and quietly leave the other describing a different
 * contract. See those tests for what each one can and cannot catch.
 */
const REPORTED_ARM_KEYS = [
  'enabled',
  'environment',
  'errorCount',
  'globalBreakersTripped',
  'globalScheduleHealthAt',
  'globalScheduleHealthReadFailed',
  'globalScheduleHealthStatus',
  'globalSchedules',
  'jobsFailed',
  'jobsProcessed',
  'jobsSucceeded',
  'known',
  'lastEnqueueCount',
  'lastErrorAt',
  'lastErrorKind',
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
      // Was `globalScheduleHealthError`, which those guards read as `toBeNull()`. The raw
      // string is no longer published; this boolean is exactly its null-ness, and
      // expectDurableAlarm in global-jobs-db.test.ts was migrated onto it in the same change.
      'globalScheduleHealthReadFailed',
      'globalSchedules',
      'globalBreakersTripped',
      'ticks',
      'lastGlobalEnqueueCount',
      'enabled',
    ]) {
      expect(Object.hasOwn(scheduler, key), `/healthz stopped serving scheduler.${key}`).toBe(true);
    }
  });

  it('the wire ADDS only structure and DROPS exactly the free text — both directions pinned', async () => {
    // ── EXACTLY WHAT THIS ONE COVERS, WHICH IS LESS THAN IT USED TO CLAIM ────────────────
    // It pins the keys /healthz ADDS ON TOP OF the metrics, and the keys it DROPS. Both are
    // DIFFERENCES against `m`, so a field added to `SchedulerMetrics` AND published is on
    // both sides of `added` and is filtered out here BY CONSTRUCTION — this assertion can
    // never report a producer-side addition, however it is tuned. That case is the next
    // test's, and a field added NEXT TO `scheduler` rather than inside it is the one after
    // that. The three are disjoint on purpose; none of them is redundant, and the header
    // comment that used to describe this one as covering "any future addition to the body"
    // was wrong in the exact direction that matters.
    //
    // ── THE `dropped` HALF IS THIS UNIT'S WHOLE POINT, STATED AS A CONTRACT ──────────────
    // Three free-text fields used to ride onto a public unauthenticated endpoint because
    // schedulerReport() spread the metrics object. It now names every key it publishes, so
    // these two are simply not written down (the third, `breakerReason`, is NESTED and is
    // pinned separately below — a flat key set cannot see inside an array element, which is
    // exactly how it stayed public with three green guards over it).
    //
    // If `dropped` shrinks, a raw-driver-text channel just came back. If it grows, a field
    // stopped being published and some reader may be reading `undefined` — check the
    // consumer list in worker/src/healthz.ts's header before accepting either.
    const m = metrics({ globalScheduleHealthAt: '2026-01-01T00:00:00.000Z' });
    const scheduler = (await get(state(m))).body.scheduler as Record<string, unknown>;

    const added = Object.keys(scheduler).filter((k) => !Object.hasOwn(m, k));
    expect(added.sort()).toEqual([
      'globalScheduleHealthReadFailed',
      'globalScheduleHealthStatus',
      'known',
    ]);
    // …and the one added string is a closed enum of three constants, not runtime text.
    expect(['unknown', 'last_read_ok', 'stale']).toContain(scheduler.globalScheduleHealthStatus);
    // …and the one added boolean is a boolean, not a message that happens to be truthy.
    expect(typeof scheduler.globalScheduleHealthReadFailed).toBe('boolean');

    const dropped = Object.keys(m).filter((k) => !Object.hasOwn(scheduler, k));
    expect(dropped.sort()).toEqual(['globalScheduleHealthError', 'lastError']);
  });

  it('the REPORTED arm is a FIXED key set — a producer field cannot reach the wire unannounced', async () => {
    // ── WHY THIS EXISTS WHEN THE GUARD ABOVE LOOKS LIKE IT ALREADY COVERS IT ─────────────
    // That guard computes `Object.keys(scheduler).filter((k) => !Object.hasOwn(m, k))`: what
    // /healthz ADDS to the metrics. A new field on `SchedulerMetrics` (worker/src/scheduler.ts)
    // that is ALSO published is present in `m`, so the filter removes it — not because the
    // threshold is wrong but because that is what the expression computes. The whole-body
    // guard below is blind to it too: it pins the six TOP-LEVEL keys, and a scheduler field
    // arrives INSIDE `scheduler`. So this arm is the only place a published-key change fails.
    //
    // ── WHAT CHANGED UNDER THIS GUARD, AND WHY MOST OF THE OLD TEXT NO LONGER APPLIES ────
    // Until the /healthz body reduction, schedulerReport() built this arm as
    // `{ ...scheduler, known: true, … }` — a SPREAD. That is how `lastError` and
    // `globalScheduleHealthError` reached a public unauthenticated endpoint carrying raw pg
    // driver text: a producer edit published a field with no edit to worker/src/healthz.ts
    // and no reader of it involved. This literal was the ONLY thing standing in that path,
    // and the three defeat vectors recorded below were all about getting past it.
    //
    // schedulerReport() now NAMES EVERY KEY IT PUBLISHES. The producer→wire route is closed
    // by construction, not by this assertion: a field added to SchedulerMetrics and not
    // written into that projection cannot reach the body at all. THIS GUARD THEREFORE PINS A
    // DIFFERENT THING THAN IT USED TO — it pins the PROJECTION, i.e. the deliberate decision
    // about what the public is told. What it catches now:
    //   • a key added to or removed from schedulerReport()'s object literal — fails BY NAME;
    //   • schedulerReport() being "simplified" back to a SPREAD — fails immediately and
    //     loudly, because `lastError` and `globalScheduleHealthError` reappear in the key set
    //     and this literal does not contain them.
    //
    // WHAT IT DOES *NOT* CATCH, AND THIS WAS MEASURED RATHER THAN ASSUMED: A BLOCKLIST.
    // Rewriting the projection as
    //     const { lastError: _a, globalScheduleHealthError: _b, ...rest } = scheduler;
    // — or the equivalent `Omit<SchedulerMetrics, 'lastError' | 'globalScheduleHealthError'>`
    // — produces EXACTLY today's key set, and ran GREEN on all 36 assertions in this file
    // when tried. A blocklist and an allow-list are indistinguishable by their output UNTIL
    // a new producer field exists, at which point the blocklist publishes it and every guard
    // here is still green. That is the original mechanism, re-armed.
    // THE ALLOW-LIST PROBE ABOVE IS THE GUARD THAT SEPARATES THEM, because it brings its own
    // unknown producer field. Do not read this assertion as covering that case.
    //
    // ── THE LIST IS A HARD-CODED LITERAL AND MUST STAY ONE ───────────────────────────────
    // Do NOT rewrite it as `Object.keys(metrics())`, `Object.keys(m)`, or anything else read
    // from a runtime value — including anything derived from the projection itself. A
    // derived list would enter the expectation in the same instant as the key it is meant to
    // question, and this guard would be green forever while the field sailed onto the public
    // edge. Editing the list is the deliberate human act the guard exists to require.
    //
    // ── KEYS ONLY. NEVER `toEqual` ON THE WHOLE OBJECT, NEVER COMPARE VALUES ─────────────
    // A value comparison reads as strictly stronger and is strictly worse here: on the day
    // this guard catches a real leak, it would copy the leaked value into the CI log, which
    // is the thing the guard exists to prevent. Standing project ruling — if you think you
    // need a value compare here, stop and ask. (The reduction block below does assert on
    // content, and it is not an exception to this: it asserts the ABSENCE of sentinels the
    // test file itself declares, so a failure prints a constant from this file and nothing
    // from the object under test.)
    //
    // WHAT THIS STILL DOES NOT PIN: values, and anything NESTED. A flat key set cannot see
    // inside `globalSchedules` entries — which is not a footnote, it is how
    // `breakerReason: string | null` sat on a public endpoint with three green guards over
    // it. That hole is closed by its own pin, in the next test.
    //
    // ── THE THREE DEFEAT VECTORS, RE-MEASURED AT THIS COMMIT ─────────────────────────────
    // The chain used to be: root tsc forces `metrics()` to mirror SchedulerMetrics → the
    // spread carries every fixture key onto the wire → this literal fails by name. Two of
    // the three ways to break that chain worked because of the MIDDLE link. There is no
    // middle link any more, and re-measuring (rather than reasoning) changed the answers:
    //
    //  1. AN OPTIONAL FIELD ON SchedulerMetrics — was: invisible here AND live on the wire.
    //     NOW HARMLESS. `foo?: string` still never forces the fixture to gain the key, so
    //     this key set still cannot see it — but the projection does not publish it either,
    //     so there is nothing to see. Re-measured at this commit: added an optional field to
    //     SchedulerMetrics and set it in the producer → tsc silent, this file green, AND THE
    //     FIELD ABSENT FROM THE BODY. Prefer `T | null` anyway (it keeps the fixture honest
    //     for the tests that read metrics directly), but it is no longer load-bearing for
    //     disclosure.
    //
    //  2. A CAST IN THE FIXTURE — was: the dangerous one; laundered a required producer
    //     field straight onto the wire. NOW CAUGHT, AND CAUGHT HERE. `} as SchedulerMetrics`
    //     still silences tsc, but a fixture missing a key the projection READS produces
    //     `undefined` for that key, JSON.stringify drops it, and this literal fails by name.
    //     Re-measured at this commit: cast the fixture and deleted `ticks` from it → tsc
    //     silent, and this assertion FAILED with `- "ticks"`. The cast is still bad practice
    //     — do not reach for one to quiet a type error, because that error IS the guard —
    //     but it is no longer a silent bypass.
    //
    //  3. LOOSENING THE RETURN-TYPE ANNOTATION on `metrics()` — unchanged, and still does
    //     NOT silently defeat anything: every call site that passes the fixture where a
    //     `SchedulerMetrics` is expected re-checks it structurally and reports its own error.
    //     WHICH tsc is still the part that decides whether you see it: ROOT `tsc --noEmit`
    //     fails; `tsc -p worker/tsconfig.json` STAYS CLEAN, because that project's `include`
    //     is worker-only and this test file is not in it. An author who builds only the
    //     worker sees green and concludes the guard is intact. Keep the annotation.
    //
    // ── A COUNT IN A COMMENT MUST CARRY THE SHA IT WAS MEASURED AT, OR IT ROTS ───────────
    // The previous text stamped "26 call sites, measured at a576bd9" after a bare count had
    // already been falsified by the very commit that wrote it down. No count is quoted here
    // at all: the sentence above ("every call site … reports its own error") stays true as
    // call sites come and go, and that is the property worth writing down.
    //
    // ── EXERCISED FOR REAL, TWICE ────────────────────────────────────────────────────────
    // 2026-08-10, `lastReconcileAttemptAt`/`reconcileAttempts` — the first genuine
    // producer-side addition after this list existed. Order matters, because the middle step
    // looks like the guard failing to work:
    //   1. fields added to SchedulerMetrics ONLY → root `tsc --noEmit` failed HERE, at the
    //      `metrics()` fixture, naming `lastReconcileAttemptAt`;
    //   2. with the producer already carrying both fields and the fixture not yet updated,
    //      THIS FILE RAN GREEN END TO END. Vitest does not typecheck. tsc is the FIRST link
    //      in this chain, not a formality beside it;
    //   3. fixture updated → this assertion failed by name, and the literal was edited by hand.
    // The /healthz body reduction — same sequence for `lastErrorKind`/`lastErrorAt`/
    // `errorCount`: root tsc failed first at the fixture naming `lastErrorKind` (worker tsc
    // stayed clean, exactly as vector 3 warns), then this literal failed by name once the
    // fixture was filled in. Step 2 held again: vitest was green on the un-updated fixture.
    // If you are here because step 1 or step 3 just failed at you: that is this guard doing
    // its job. Add the key to the list deliberately. Do not derive the list; do not cast.
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

  it('THE ALLOW-LIST ITSELF: an unknown producer field does not reach the wire', async () => {
    // ── WHY THIS EXISTS, AND WHY THE OTHER PINS CANNOT DO ITS JOB ────────────────────────
    // Every other guard in this file compares the PUBLISHED key set against a literal. That
    // catches a spread — `{ ...metrics }` re-publishes `lastError` and
    // `globalScheduleHealthError`, which are not in the literal. IT DOES NOT CATCH A
    // BLOCKLIST. `const { lastError: _a, globalScheduleHealthError: _b, ...rest } = metrics`
    // (or `Omit<SchedulerMetrics, 'lastError' | 'globalScheduleHealthError'>`) produces
    // EXACTLY today's correct key set, so every assertion here stays green — and then
    // publishes the NEXT field somebody adds to SchedulerMetrics, which is precisely the
    // mechanism that put raw pg driver text on this endpoint in the first place.
    //
    // MEASURED, not argued: the rest-destructure above was applied to schedulerReport() and
    // all 36 tests in this file passed. A blocklist and an allow-list are indistinguishable
    // by their output UNTIL a new producer field exists — at which point the guard is green
    // and the field is live. So the guard has to bring its own new producer field.
    //
    // It adds one at RUNTIME rather than to `SchedulerMetrics`, deliberately: the type is
    // what a future author edits, and this must fail for them BEFORE they have touched a
    // type, on the strength of the construction alone. Under an allow-list the probe is not
    // published and the key set is unchanged; under a spread OR a blocklist it appears and
    // this fails BY NAME. Keys only — the probe's VALUE is never compared, only its key.
    const withUnknownField = (): SchedulerMetrics => {
      const m = metrics({ globalScheduleHealthAt: '2026-01-01T00:00:00.000Z' });
      // An own enumerable property no line of worker/src/healthz.ts knows about — exactly
      // what a field added to the producer looks like to the projection.
      Object.assign(m, { fieldTheProjectionHasNeverHeardOf: 'PROBE_not_in_the_public_list' });
      return m;
    };

    const probed = withUnknownField();
    expect(
      Object.hasOwn(probed, 'fieldTheProjectionHasNeverHeardOf'),
      'the probe did not attach — this guard would pass vacuously',
    ).toBe(true);

    const scheduler = (await get(state(probed))).body.scheduler as Record<string, unknown>;
    expect(
      Object.keys(scheduler).sort(),
      'worker/src/healthz.ts is publishing a field it does not name — schedulerReport() has ' +
        'become a SPREAD or a BLOCKLIST (rest-destructure / Omit) instead of an enumerated ' +
        'allow-list, so the next field added to SchedulerMetrics ships to the public edge',
    ).toEqual(REPORTED_ARM_KEYS);
  });

  it('a globalSchedules ELEMENT is a fixed key set — the nested route is no longer unwatched', async () => {
    // ── THE HOLE EVERY OTHER GUARD IN THIS FILE ADMITS TO, CLOSED ────────────────────────
    // The three key-set pins around this one are FLAT: they read `Object.keys` of the body
    // and of `scheduler`. None of them can see inside an array element. That is not a
    // theoretical gap — `breakerReason` is raw handler error text (built by
    // worker/core/global-job-schedule.ts's breakerReasonFor as `${outcome}: ${detail}`,
    // where `detail` is the failing handler's own message, so a database fault puts pg
    // driver text in it), and it sat on a public unauthenticated endpoint, INSIDE this
    // array, while every guard in this file was green. A guard set that is honest about
    // where it does not look, and then never closes that place, is just a longer comment.
    //
    // The fixture deliberately supplies a snapshot whose `breakerReason` is populated, so
    // this fails if the projection ever spreads the producer's snapshot instead of naming
    // its fields (worker/src/healthz.ts's publicSnapshot).
    const res = await get(
      state(metrics({ globalScheduleHealthAt: '2026-01-01T00:00:00.000Z', globalSchedules: [snapshot()] })),
    );
    const scheduler = res.body.scheduler as Record<string, unknown>;
    const entries = scheduler.globalSchedules as Array<Record<string, unknown>>;
    expect(entries, 'the fixture stopped reaching the projection').toHaveLength(1);
    expect(
      Object.keys(entries[0]).sort(),
      '/healthz globalSchedules[] changed shape — a key was added to or removed from ' +
        'GlobalScheduleHealthSnapshot and is now nested on a public, unauthenticated endpoint',
    ).toEqual([
      'breakerTrippedAt',
      'consecutiveFailures',
      'enabled',
      'inFlight',
      'jobType',
      'lastSuccessAt',
      'maxConsecutiveFailures',
      'missedRuns',
      'nextRunAt',
      'status',
    ]);
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

describe('/healthz — the body carries no free text (D-D: the public-disclosure reduction)', () => {
  // ── WHAT THIS BLOCK IS FOR ───────────────────────────────────────────────────────────
  // The endpoint is public and unauthenticated on both apps — confirmed by Fly's API and a
  // direct curl of both default hostnames, not inferred. Three free-text channels rode the
  // body, all three carrying text written by a pg driver or a failing job handler:
  //   1. `lastError`, set at seven sites in worker/src/scheduler.ts and cleared on success
  //      at NONE of them, so it was a since-boot HIGH-WATER MARK that stayed on the wire
  //      until the machine restarted. Observed carrying a real job UUID and, after a
  //      migration, a message naming an internal table.
  //   2. `globalScheduleHealthError`, observed serving a raw Postgres error naming an
  //      internal table on live staging.
  //   3. `globalSchedules[].breakerReason`, NESTED — invisible to every flat key-set guard.
  //
  // Auth is not the lever: Fly's prober sends no credential and both manifests health-check
  // this path every 30s, so a 401 crash-loops the worker exactly as a non-200 would. The
  // only lever is WHAT THE BODY SAYS, so the body says it with structure — an enum, a
  // boolean, a timestamp, a counter — and never with a sentence.
  //
  // ── WHY THESE ASSERTIONS MAY LOOK AT CONTENT WHEN THE KEY-SET PINS MAY NOT ───────────
  // The standing ruling is that the key-set guards compare `Object.keys(...).sort()` and
  // never values, because on the day one catches a real leak a value compare copies the
  // leaked value into the CI log. Every sentinel below is a CONSTANT DECLARED IN THIS FILE
  // and every assertion checks for its ABSENCE, so a failure here can only ever print a
  // string this file already contains. The four key-set pins above are untouched.

  it('NO free text reaches the body, even when every producer field is carrying some', async () => {
    const body = JSON.stringify((await get(state(poisoned()))).body);
    for (const [field, value] of Object.entries(SENTINEL)) {
      expect(
        body.includes(value),
        `/healthz is publishing scheduler.${field} — raw driver/handler text on a public, ` +
          'unauthenticated endpoint. See worker/src/healthz.ts schedulerReport/publicSnapshot.',
      ).toBe(false);
    }
  });

  it('and not one value anywhere in it is a string outside a closed, code-owned set', async () => {
    // The generalisation of the test above: rather than hunting for known sentinels, walk
    // the WHOLE body and require every string it contains to be one this codebase chose.
    // A fourth free-text channel — a field nobody has thought of yet, at any depth — fails
    // here without anyone having to predict its name.
    //
    // `jobType` is the one deliberate exception and it is listed by name rather than waved
    // through by a predicate: `global_job_schedule.job_type` is `text NOT NULL UNIQUE` with
    // no CHECK (migration 0028:63, measured), so it is operator/migration-authored config
    // text. It is kept because it is the whole answer to "WHICH job is stopped", and it
    // cannot receive driver output — nothing in the code path writes an error message, a
    // UUID, a hostname or a SQL fragment into that column. Recorded as a trade, not missed.
    const CLOSED_SETS: Record<string, readonly string[]> = {
      status: ['ok', 'breaker_tripped', 'missed', 'running', 'due', 'disabled'],
      service: ['kids-fun-worker'],
      environment: ['staging', 'production'],
      globalScheduleHealthStatus: ['unknown', 'last_read_ok', 'stale'],
      lastErrorKind: [
        'poll',
        'job',
        'tick',
        'global_tick',
        'reconcile',
        'global_schedule_health',
        'global_run_ledger',
      ],
    };
    const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
    /** Keys whose string values are timestamps, and the one identifier kept on purpose. */
    const TIMESTAMPS = ['bootedAt', 'lastTickAt', 'lastJobAt', 'lastReconcileAt',
      'lastReconcileAttemptAt', 'lastErrorAt', 'globalScheduleHealthAt', 'breakerTrippedAt',
      'nextRunAt', 'lastSuccessAt'];
    const JOB_TYPE_KEYS = ['jobType', 'globalBreakersTripped'];

    const offenders: string[] = [];
    const walk = (node: unknown, path: string, key: string): void => {
      if (typeof node === 'string') {
        const closed = CLOSED_SETS[key];
        if (closed?.includes(node)) return;
        if (TIMESTAMPS.includes(key) && ISO.test(node)) return;
        if (JOB_TYPE_KEYS.includes(key)) return;
        // Deliberately reports the PATH, never the value — same reason the key-set pins
        // compare keys: a real leak must not be copied into CI output by the guard.
        offenders.push(path);
        return;
      }
      if (Array.isArray(node)) {
        node.forEach((v, i) => walk(v, `${path}[${i}]`, key));
        return;
      }
      if (node !== null && typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) walk(v, `${path}.${k}`, k);
      }
    };

    // Every state that can reach the wire, including the one carrying free text everywhere.
    for (const s of [state(undefined), state(null), state(metrics()), state(poisoned())]) {
      walk((await get(s)).body, 'body', '');
    }
    expect(
      offenders,
      'a /healthz field is serving a string outside any closed set — if it is deliberate, ' +
        'add it to CLOSED_SETS here and say why on the field in worker/src/healthz.ts',
    ).toEqual([]);
  });

  it('a DB failure is still fully legible: THAT, WHEN, and WHAT CLASS — with no message', async () => {
    // The replacement has to carry what an operator actually needs, or this unit traded a
    // disclosure for a blind endpoint. Poll lane failed four times, most recently at :07.
    const s = (await get(state(poisoned()))).body.scheduler as Record<string, unknown>;
    expect(s.lastErrorKind).toBe('poll'); // WHAT CLASS
    expect(s.lastErrorAt).toBe('2026-01-01T00:07:00.000Z'); // WHEN
    expect(s.errorCount).toBe(4); // THAT, and how much of it
    // …and the durable-health read is separately reported as failing, which `lastErrorKind`
    // cannot be relied on for — any other lane's error overwrites it.
    expect(s.globalScheduleHealthReadFailed).toBe(true);
    expect(s.globalScheduleHealthStatus).toBe('stale');
  });

  it('no errors since boot is DISTINGUISHABLE from an error whose text is withheld', async () => {
    // The failure mode of a reduction is a body that reads clean in both states. It does not.
    const clean = (await get(state(metrics()))).body.scheduler as Record<string, unknown>;
    expect(clean.lastErrorKind).toBeNull();
    expect(clean.lastErrorAt).toBeNull();
    expect(clean.errorCount).toBe(0);

    const failed = (await get(state(poisoned()))).body.scheduler as Record<string, unknown>;
    expect(failed.lastErrorKind).not.toBeNull();
    expect(failed.lastErrorAt).not.toBeNull();
    expect(failed.errorCount).toBeGreaterThan(0);
  });

  it('the error signal is a HIGH-WATER MARK and the timestamp is what makes that readable', async () => {
    // worker/src/scheduler.ts sets these at seven sites and clears them at none, so a
    // healthy worker that failed once an hour ago reports the same KIND as one failing now.
    // That is deliberate — an error an hour ago is information — and it is only safe to
    // read because `lastErrorAt` says which. Pinned so nobody later reads `lastErrorKind`
    // as "currently broken", which is the same false-reading defect as `enabled: false` for
    // an absent scheduler and `lastReconcileAt: null` for a sweep that found nothing.
    const ancient = (await get(state(metrics({
      lastErrorKind: 'reconcile', lastErrorAt: '1999-01-01T00:00:00.000Z', errorCount: 1,
    })))).body.scheduler as Record<string, unknown>;
    const recent = (await get(state(metrics({
      lastErrorKind: 'reconcile', lastErrorAt: '2026-01-01T00:00:00.000Z', errorCount: 1,
    })))).body.scheduler as Record<string, unknown>;
    expect(ancient.lastErrorKind).toEqual(recent.lastErrorKind); // identical class…
    expect(ancient.lastErrorAt).not.toEqual(recent.lastErrorAt); // …separable by the clock
  });

  it('THE BLIND-AT-BOOT CASE: "no read yet" and "the first read FAILED" stay distinguishable', async () => {
    // `globalScheduleHealthStatus` collapses both into 'unknown' — deliberately, because the
    // enum answers a different question. Dropping `globalScheduleHealthError` without
    // replacing it would have made a worker that CANNOT REACH THE DATABASE AT ALL
    // byte-identical to one that booted two seconds ago. The boolean is what separates them.
    const booting = (await get(state(metrics({ globalScheduleHealthAt: null }))))
      .body.scheduler as Record<string, unknown>;
    const blind = (await get(state(metrics({
      globalScheduleHealthAt: null, globalScheduleHealthError: 'connection terminated unexpectedly',
    })))).body.scheduler as Record<string, unknown>;

    expect(booting.globalScheduleHealthStatus).toBe('unknown');
    expect(blind.globalScheduleHealthStatus).toBe('unknown'); // same enum value…
    expect(booting.globalScheduleHealthReadFailed).toBe(false);
    expect(blind.globalScheduleHealthReadFailed).toBe(true); // …different, legible meaning
    expect(JSON.stringify(booting)).not.toBe(JSON.stringify(blind));
  });

  it('the unknown-scheduler arm is still PURE STRUCTURE — one boolean, nothing else', async () => {
    // Unchanged by the reduction and re-asserted here so the whole no-free-text contract is
    // stated in one place: the absent-scheduler arm has no reason, message or error of any
    // kind, and `enabled` is ABSENT rather than false.
    for (const absent of [undefined, null]) {
      const scheduler = (await get(state(absent))).body.scheduler as Record<string, unknown>;
      expect(Object.keys(scheduler)).toEqual(['known']);
      expect(Object.hasOwn(scheduler, 'enabled')).toBe(false);
    }
  });
});
