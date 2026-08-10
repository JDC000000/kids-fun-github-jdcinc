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
//   • a MISSING scheduler was rendered `{ enabled: false }`, byte-identical to a scheduler
//     an operator had deliberately turned OFF; and
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
 *   'unknown' — the read has NEVER succeeded (`globalScheduleHealthAt === null`), so
 *               `globalSchedules: []` means the worker is BLIND, not that nothing is
 *               scheduled. Alerting that treats this as healthy is the original defect.
 *   'fresh'   — the last read succeeded. `[]` here really does mean "no schedules".
 *   'stale'   — a read succeeded once but the LAST attempt failed. `globalSchedules` is
 *               deliberately left standing rather than blanked (worker/src/scheduler.ts's
 *               refreshGlobalScheduleHealth catch), so it is last-known-good as of
 *               `globalScheduleHealthAt` — not a description of now.
 */
export type GlobalScheduleHealthStatus = 'unknown' | 'fresh' | 'stale';

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
 * tests/scheduler/healthz.test.ts pins the unknown arm to structural values only, and pins
 * THREE key sets, each written out as a hard-coded literal that a human has to edit:
 *   • the six TOP-LEVEL keys of the body;
 *   • the keys THIS FILE adds to the metrics (`known`, `globalScheduleHealthStatus`);
 *   • the FULL key set of the `known: true` arm — the only one of the three that catches a
 *     field added to `SchedulerMetrics` in worker/src/scheduler.ts. The first two are blind
 *     to it (one pins the top level, and a producer field arrives inside `scheduler`; the
 *     other pins the DIFFERENCE against the metrics, which removes a producer field by
 *     construction), and the producer path is exactly how `lastError` and
 *     `globalScheduleHealthError` arrived here.
 * So widening this payload costs a deliberate edit to a named list, in all three directions.
 *
 * What none of those pin is VALUES, or anything NESTED. Whatever text the producer writes
 * into `lastError` / `globalScheduleHealthError` goes out verbatim, and
 * `globalSchedules[].breakerReason` is free text that no assertion in that file looks at.
 * Keys, not values, is the deliberate stopping point: a guard that compared values would
 * copy the leak it caught into the CI log. Remediating those fields is a separate unit's job
 * and no guard here has done it.
 */
export type SchedulerReport =
  | { known: false }
  | (SchedulerMetrics & { known: true; globalScheduleHealthStatus: GlobalScheduleHealthStatus });

export function deriveGlobalScheduleHealthStatus(
  metrics: Pick<SchedulerMetrics, 'globalScheduleHealthAt' | 'globalScheduleHealthError'>,
): GlobalScheduleHealthStatus {
  if (metrics.globalScheduleHealthAt === null) return 'unknown';
  return metrics.globalScheduleHealthError === null ? 'fresh' : 'stale';
}

/**
 * Project the scheduler's metrics for /healthz, or say plainly that there are none.
 *
 * Exported so that the one place this convention is encoded is a function every reader can
 * call, rather than a rule each reader has to remember.
 */
export function schedulerReport(scheduler: SchedulerMetrics | null | undefined): SchedulerReport {
  // No scheduler state is attached to this process, so its status is UNKNOWN — which is NOT
  // the same as a scheduler that was deliberately disabled (that reports known:true with
  // enabled:false). Said with a boolean and an absent key rather than a sentence; see the
  // note on SchedulerReport for why no prose goes on this endpoint.
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
