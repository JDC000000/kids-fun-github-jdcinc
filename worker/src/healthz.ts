import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SchedulerMetrics } from './scheduler';

// ─────────────────────────────────────────────────────────────────────────────────────────
// Liveness/readiness payload for the ingestion worker (G-T1-2 verify: curl /healthz → 200).
//
// ── WHY THIS ALWAYS RETURNS 200, AND WHY MAKING IT CONDITIONAL WOULD CRASH-LOOP PRODUCTION ─
// worker/fly.toml:36-41 and worker/fly.production.toml:36-41 BOTH declare
//     [[http_service.checks]] method="get" path="/healthz" interval="30s" timeout="5s"
// alongside auto_stop_machines="suspend" and min_machines_running=1. Fly polls this exact
// path every 30 seconds AS THE MACHINE'S LIVENESS PROBE. A non-200 here does not raise an
// alert — it makes Fly REPLACE THE MACHINE. So a worker that is unhealthy *because the
// database is unreachable* would be killed and rebooted every 30s for as long as the
// database stayed unreachable: a crash loop, in production, on the worker doing real
// ingestion. Every unit test in this repo would stay green throughout, because nothing here
// simulates Fly's prober.
//
// THEREFORE: the status code is 200 and the top-level `status` is 'ok' on EVERY path,
// including "the scheduler is absent", "the durable health read is failing" and "the
// process has never read durable health at all". Everything an operator or an alert should
// act on lives in the BODY. tests/scheduler/healthz.test.ts pins this deliberately, with
// the reasoning above written into the test body — do not "fix" the 200.
//
// ── WHAT THE BODY MUST NEVER DO: LET A BENIGN VALUE STAND IN FOR "I DON'T KNOW" ───────────
// Two states used to be inexpressible here, and both read as good news:
//   • a MISSING scheduler was rendered `{ enabled: false }` — the old
//     `scheduler: state.scheduler ?? { enabled: false }`. The defect was never a collision of
//     BYTES. `enabled: false` on the wire could only EVER have come from that fallback, because
//     scheduler.ts:219 sets `enabled: true` and nothing anywhere unsets it; and a producer that
//     DID report a disabled scheduler would have sent the whole 22-field metrics object, not a
//     single key. It was a collision of MEANING, in the reader. `scheduler.enabled === false`
//     is the check an operator — or an alert built on this endpoint — reaches for to answer
//     "is the scheduler running?", and every single time the endpoint answered it `false` it
//     was reporting that it had heard nothing at all, in the vocabulary of a deliberate
//     configuration. `known` fixes that by replacing the question, not the value.
//   • `globalSchedules: []` meant both "no schedules are configured" and "the durable read
//     has never succeeded", i.e. the worker is blind.
// Both are now named explicitly — `known` and `globalScheduleHealthStatus` below — so a
// reader does not have to already know the convention to avoid alerting on a false green.
// ─────────────────────────────────────────────────────────────────────────────────────────

export interface HealthState {
  chromiumReady: boolean;
  bootedAt: string;
  scheduler?: SchedulerMetrics | null;
}

/**
 * Whether the durable global-schedule health in `globalSchedules` can be believed, derived
 * from state the scheduler already records. Not a threshold and not a policy — purely a
 * name for a distinction the raw fields already make and readers kept getting wrong.
 *
 *   'unknown'      — the read has NEVER succeeded (`globalScheduleHealthAt === null`), so
 *                    `globalSchedules: []` means the worker is BLIND, not that nothing is
 *                    scheduled. Alerting that treats this as healthy is the original defect.
 *   'last_read_ok' — the last read SUCCEEDED. `[]` here really does mean "no schedules".
 *                    NOT a freshness claim: read `globalScheduleHealthAt` for that. It was
 *                    called 'fresh' until a reader pointed out that no part of the predicate
 *                    below looks at a clock — see the derivation site.
 *   'stale'        — a read succeeded once but the LAST attempt failed. `globalSchedules` is
 *                    deliberately left standing rather than blanked (worker/src/scheduler.ts's
 *                    refreshGlobalScheduleHealth catch), so it is last-known-good as of
 *                    `globalScheduleHealthAt` — not a description of now.
 *
 * The pair therefore names WHETHER THE LAST ATTEMPT WORKED, and nothing else. HOW LONG AGO
 * lives entirely in `globalScheduleHealthAt`, and no value of this enum implies a bound on it.
 */
export type GlobalScheduleHealthStatus = 'unknown' | 'last_read_ok' | 'stale';

/**
 * The `scheduler` sub-object as it appears on the wire.
 *
 * `known: false` carries NO `enabled` key at all — deliberately. Reporting `enabled: false`
 * for a scheduler nobody has heard from is what made "I turned it off" and "I have no idea"
 * indistinguishable, and omitting the key makes reading `false` out of the unknown case
 * impossible rather than merely discouraged.
 *
 * ── WHY THE UNKNOWN ARM IS A BARE BOOLEAN AND NOT A `reason` STRING ──────────────────────
 * THIS RESPONSE IS PUBLIC. Not "might be" — CONFIRMED, by Fly's API and a direct curl of
 * both default hostnames: production and staging each hold a real public IP, and
 * https://kids-fun-worker.fly.dev/healthz (and the staging equivalent) return HTTP 200 with
 * this entire body and NO AUTHENTICATION, to anyone, today. It is unauthenticated in code
 * (worker/src/index.ts:54-57), bound to every interface (index.ts:80 — `server.listen(PORT)`
 * with no host), and published at Fly's edge by both manifests (`[http_service]` +
 * force_https, fly.toml:29-31 and fly.production.toml:29-31).
 *
 * The distinction this type exists to make is therefore carried by STRUCTURE — a boolean, an
 * absent key, an enum — and never by prose. A `reason: string` field would answer the
 * operator's question no better than `known` already does, while standing on a public
 * endpoint as an open invitation for the next author to interpolate `errMsg(err)` into it.
 * The metrics arm already serialises `lastError` and `globalScheduleHealthError`, which for
 * a pg driver error routinely name host, port, database and user (scheduler.ts:489 sets
 * `lastError` from `errMsg(err)` on any poll failure); staging was observed serving a real
 * job UUID and real telemetry through them. THAT DISCLOSURE IS REAL AND LIVE, it predates
 * this file's current shape, and remediating it is a separate unit that is not this one's to
 * pre-empt — but it is exactly why no second free-text channel opens alongside it here.
 *
 * ── EXACTLY WHAT tests/scheduler/healthz.test.ts PINS, AND WHAT IT DOES NOT ───────────────
 * It pins the `known: false` arm to structural values only, plus THREE key sets, each a
 * hard-coded literal a human has to edit:
 *   1. the six TOP-LEVEL keys of the body;
 *   2. the keys THIS FILE adds on top of the metrics (`known`, `globalScheduleHealthStatus`);
 *   3. the FULL key set of the `known: true` arm.
 * (3) is not redundant with (2): (2) is computed as a DIFFERENCE against the metrics fixture,
 * so a field added to `SchedulerMetrics` in worker/src/scheduler.ts is on both sides of that
 * subtraction and disappears from it BY CONSTRUCTION; and (1) cannot see it either, because a
 * producer field arrives INSIDE `scheduler`. That producer route is not a hypothetical gap —
 * it is precisely how `lastError` and `globalScheduleHealthError` put raw pg driver text on
 * this endpoint. Before (3) existed, the one route already known to leak was the one route no
 * guard watched.
 *
 * (3) READS A FIXTURE, NOT THIS FILE, so it holds only while tsc forces that fixture to mirror
 * `SchedulerMetrics`. Two things break the mirror silently and are measured, not theorised: an
 * OPTIONAL field on SchedulerMetrics (never forced into the fixture, so the key set never sees
 * it — the interface has zero optional fields today and that is load-bearing, prefer
 * `T | null`), and a CAST in the fixture (`as SchedulerMetrics` silences tsc outright, even
 * for a required field). The test carries the full reasoning; the constraint is recorded here
 * too because it is a constraint on the PRODUCER TYPE, which is edited from scheduler.ts by
 * people who may never open the test.
 *
 * NONE of the three pins VALUES, and none looks inside a NESTED object. Whatever the producer
 * writes into `lastError` / `globalScheduleHealthError` goes out verbatim, and
 * `globalSchedules[].breakerReason` is free text no assertion inspects. Keys-not-values is a
 * deliberate stopping point, not an oversight: on the day a guard catches a real leak, a value
 * comparison would copy the leaked value into the CI log.
 */
export type SchedulerReport =
  | { known: false }
  | (SchedulerMetrics & { known: true; globalScheduleHealthStatus: GlobalScheduleHealthStatus });

export function deriveGlobalScheduleHealthStatus(
  metrics: Pick<SchedulerMetrics, 'globalScheduleHealthAt' | 'globalScheduleHealthError'>,
): GlobalScheduleHealthStatus {
  // ── THERE IS NO AGE TERM IN THIS FUNCTION. DO NOT READ ONE INTO ITS RESULT ───────────────
  // 'last_read_ok' is `globalScheduleHealthError === null` and NOTHING ELSE. It says the last
  // attempt did not throw; it says nothing whatsoever about WHEN that attempt was. Judge age
  // from `globalScheduleHealthAt`, which is the only field here that carries one — and judge
  // it against the reader's own clock, because this process cannot tell you how long it has
  // been asleep.
  //
  // That is not a hypothetical. worker/fly.toml:32 and worker/fly.production.toml:32 both set
  // `auto_stop_machines = "suspend"`, and a suspended machine RESUMES WITH ITS HEAP INTACT:
  // `metrics.globalScheduleHealthAt` comes back holding whatever instant it held before the
  // suspend, with no failed read to make it 'stale', so this returns 'last_read_ok' over an
  // arbitrarily old timestamp. The value was called 'fresh' until 2026-08-10; the name was a
  // recency word for a predicate with no recency in it, and an alert written from the name
  // rather than from this body would have treated an arbitrarily stale read as current.
  //
  // If a real freshness verdict is ever wanted, it needs (a) a threshold, which is a policy
  // decision, and (b) a clock — so it belongs to whoever is alerting, not here. Adding one to
  // this enum would put a policy on a public, unauthenticated endpoint (see SchedulerReport).
  if (metrics.globalScheduleHealthAt === null) return 'unknown';
  return metrics.globalScheduleHealthError === null ? 'last_read_ok' : 'stale';
}

/**
 * Project the scheduler's metrics for /healthz, or say plainly that there are none.
 *
 * Exported so that the one place this convention is encoded is a function every reader can
 * call, rather than a rule each reader has to remember.
 */
export function schedulerReport(scheduler: SchedulerMetrics | null | undefined): SchedulerReport {
  // No scheduler state is attached to this process, so its status is UNKNOWN — which is NOT
  // the same as a scheduler that was deliberately disabled. A disabled one WOULD report
  // known:true with enabled:false; nothing produces that today, because scheduler.ts:219 sets
  // `enabled: true` and nothing ever unsets it. That arm is a type contract held open for a
  // future producer, not a state you can observe on this endpoint now — the distinction this
  // branch actually makes today is "reporting" versus "not heard from".
  // Said with a boolean and an absent key rather than a sentence; see the note on
  // SchedulerReport for why no prose goes on this endpoint.
  if (scheduler == null) return { known: false };
  return {
    ...scheduler,
    known: true,
    globalScheduleHealthStatus: deriveGlobalScheduleHealthStatus(scheduler),
  };
}

export function healthz(
  _req: IncomingMessage,
  res: ServerResponse,
  state: HealthState,
): void {
  const body = JSON.stringify({
    status: 'ok',
    service: 'kids-fun-worker',
    chromiumReady: state.chromiumReady,
    bootedAt: state.bootedAt,
    uptimeSeconds: Math.round(process.uptime()),
    scheduler: schedulerReport(state.scheduler),
  });
  // 200 unconditionally — see the Fly liveness-probe reasoning at the top of this file.
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(body);
}
