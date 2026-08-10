import type { IncomingMessage, ServerResponse } from 'node:http';
import type { GlobalScheduleHealthSnapshot, SchedulerErrorKind, SchedulerMetrics } from './scheduler';
// The public shape is defined against the DOMAIN types, never by indexed access into the
// producer (`SchedulerMetrics['environment']`). Indexed access reads as harmless and is the
// same defect one level up: it makes the published TYPE whatever the producer happens to
// hold, so widening a producer field to `string` would silently widen the public contract
// with no edit to this file — which is exactly the shape of the bug this unit exists to fix.
import type { Environment } from '../core/terms-gate';
import type { GlobalJobScheduleStatus } from '../core/global-job-schedule';

// ─────────────────────────────────────────────────────────────────────────────────────────
// Liveness/readiness payload for the ingestion worker (G-T1-2 verify: curl /healthz → 200).
//
// ── WHO ACTUALLY READS THIS, MEASURED AT 72b9e19 ─────────────────────────────────────────
// Two audiences, and only one of them reads the body at all:
//   • Fly's prober — worker/fly.toml:36-41 and worker/fly.production.toml:36-41. A
//     `[[http_service.checks]]` with method/path/interval/timeout/grace_period and NO body
//     assertion of any kind: it reads the STATUS CODE and nothing else.
//   • worker/Dockerfile:92-93's HEALTHCHECK — `curl -fsS … || exit 1`. `-f` turns a >=400
//     into a non-zero exit and `-s` discards the body. STATUS CODE ONLY.
//   • a human operator curling it, and the test guards standing in for one
//     (tests/scheduler/healthz.test.ts; global-jobs-db.test.ts's awaitDurableHealth and
//     healthzPayload, which poll a REAL socket on a REAL separate process).
// Nothing else in the repo parses this body. So the body exists for ONE reader — a person
// deciding whether to intervene — and it is sized for that reader and no other.
//
// ── WHY THIS ALWAYS RETURNS 200, AND WHY MAKING IT CONDITIONAL WOULD CRASH-LOOP PRODUCTION ─
// Fly polls this exact path every 30 seconds AS THE MACHINE'S LIVENESS PROBE, on both apps,
// alongside auto_stop_machines="suspend" and min_machines_running=1. A non-200 here does not
// raise an alert — it makes Fly REPLACE THE MACHINE. So a worker that is unhealthy *because
// the database is unreachable* would be killed and rebooted every 30s for as long as the
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
// AUTHENTICATION IS THE SAME TRAP BY ANOTHER ROUTE. Fly's prober sends no credential, so a
// 401 makes the machine unhealthy, which restarts it, forever. Gating this endpoint is
// solvable only with check headers plus secrets across both manifests — a coordinated infra
// change, not a code change. Until that exists, THE ONLY LEVER THIS FILE HAS IS WHAT IT SAYS.
//
// ── THIS RESPONSE IS PUBLIC. CONFIRMED, NOT SUSPECTED. ───────────────────────────────────
// Fly's API and a direct curl of both default hostnames show production and staging each
// holding a real public IP, with https://kids-fun-worker.fly.dev/healthz (and the staging
// equivalent) returning HTTP 200 and this entire body to anyone, unauthenticated. It is
// unauthenticated in code (worker/src/index.ts:54-57), bound to every interface
// (index.ts:80 — `server.listen(PORT)` with no host), and published at Fly's edge by both
// manifests ([http_service] + force_https, fly.toml:29-31, fly.production.toml:29-31).
//
// ── THE RULE THIS FILE ENFORCES: DISTINGUISH STATES WITH STRUCTURE, NEVER WITH PROSE ─────
// An enum, a boolean, a timestamp, a counter, null-versus-empty. An operator needs to know
// THAT something failed, WHEN, and roughly WHAT CLASS. They do not need the driver's
// sentence, and the public does not get it. Three free-text channels used to be here and
// all three are gone from the wire (they survive in the metrics object, the logs and
// Sentry — all authenticated):
//   • `lastError` — raw driver text, set at seven sites in scheduler.ts and cleared at NONE
//     on success, so it was a SINCE-BOOT HIGH-WATER MARK that stayed on the public wire
//     until the machine restarted. Observed carrying a real job UUID, and after a migration
//     a message naming an internal table. Replaced by `lastErrorKind` (closed enum),
//     `lastErrorAt` (so the high-water mark reads as one) and `errorCount`.
//   • `globalScheduleHealthError` — same shape; observed serving a raw Postgres error
//     naming an internal table on live staging. Replaced by the boolean
//     `globalScheduleHealthReadFailed`, which is exactly its null-ness and nothing else.
//   • `globalSchedules[].breakerReason` — free text NESTED inside an array, which is why
//     every flat key-set guard was blind to it. Dropped; `status`, `breakerTrippedAt` and
//     the failure counters already carry THAT/WHEN/CLASS.
//
// ── VERIFIED ON THE REAL WIRE, NOT ONLY IN TESTS ─────────────────────────────────────────
// The compiled worker was booted against a real pg pool and the socket curled in every
// reachable state, recording the actual bytes AND what the process was holding at that
// instant. In all of them the free text was PRESENT internally and ABSENT from the body:
//   • scheduler absent                      → `{"scheduler":{"known":false}}`, nothing else
//   • healthy, durable read succeeded       → status 'last_read_ok', readFailed false
//   • breaker durably tripped, its DB
//     `breaker_reason` holding raw pg text  → body carries status/breakerTrippedAt/counters;
//                                             the reason string appears nowhere in it
//   • schema missing (a REAL pg error:
//     `relation "global_job_schedule" does
//     not exist`)                           → status 'unknown', readFailed TRUE,
//                                             lastErrorKind 'poll', errorCount 14
//   • database unreachable / wrong password
//     / wrong database name                 → same structural signal. The driver's sentence
//                                             stays in the process; WHAT it names varies with
//                                             the fault — the role, the database, or (for a
//                                             single-address host) the host and port. See the
//                                             measurement table on SchedulerMetrics.lastError
//                                             in worker/src/scheduler.ts; it is DNS-dependent
//                                             and the condition is written down there.
// Every one returned HTTP 200, as the Fly contract above requires.
//
// ── AND THE ROOT CAUSE, WHICH WAS THE SPREAD, NOT THE THREE FIELDS ───────────────────────
// This file used to build the reported arm as `{ ...scheduler, known: true, … }`. That
// spread is how all three got here: a field added to `SchedulerMetrics` in scheduler.ts
// reached the public edge in the same commit, with no edit to this file and no reader of
// this file involved. Removing three fields would have left that route open for the fourth.
// schedulerReport() below therefore names EVERY key it publishes, one at a time. A producer
// field that nobody has written a line for here cannot reach the wire at all — not
// "is caught by a test", CANNOT. The test guards are now a second line, not the only one.
//
// ── WHAT THE BODY MUST NEVER DO: LET A BENIGN VALUE STAND IN FOR "I DON'T KNOW" ───────────
// Two states used to be inexpressible here, and both read as good news:
//   • a MISSING scheduler was rendered `{ enabled: false }` — the old
//     `scheduler: state.scheduler ?? { enabled: false }`. The defect was never a collision of
//     BYTES. `enabled: false` on the wire could only EVER have come from that fallback, because
//     scheduler.ts sets `enabled: true` and nothing anywhere unsets it; and a producer that
//     DID report a disabled scheduler would have sent the whole metrics object, not a
//     single key. It was a collision of MEANING, in the reader. `scheduler.enabled === false`
//     is the check an operator — or an alert built on this endpoint — reaches for to answer
//     "is the scheduler running?", and every single time the endpoint answered it `false` it
//     was reporting that it had heard nothing at all, in the vocabulary of a deliberate
//     configuration. `known` fixes that by replacing the question, not the value.
//   • `globalSchedules: []` meant both "no schedules are configured" and "the durable read
//     has never succeeded", i.e. the worker is blind.
// Both are named explicitly — `known` and `globalScheduleHealthStatus` below — so a
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
 *
 * ONE DISTINCTION IT DELIBERATELY COLLAPSES, which is why the wire also carries
 * `globalScheduleHealthReadFailed`: 'unknown' covers BOTH "no read has been attempted or
 * finished yet" (ordinary, for a few seconds after boot) and "the very first read FAILED"
 * (the worker is blind and cannot fix itself). Those want opposite responses from an
 * operator, and the boolean is what separates them.
 */
export type GlobalScheduleHealthStatus = 'unknown' | 'last_read_ok' | 'stale';

/**
 * One global schedule's durable health AS PUBLISHED — `GlobalScheduleHealthSnapshot` minus
 * its free text.
 *
 * A SEPARATE TYPE FROM THE PRODUCER'S ON PURPOSE. The producer type is what the scheduler
 * knows; this is what the world is told, and the two are allowed to differ. Written out
 * field by field so `breakerReason` cannot return by being spread in — it is the channel
 * that was invisible to every guard the project had, because it is NESTED and every guard
 * inspected flat top-level keys.
 *
 * WHAT REPLACES IT, for an operator asking "why is this breaker open?": `status` is the
 * class ('breaker_tripped' vs 'missed' vs 'disabled' …), `breakerTrippedAt` is when, and
 * `consecutiveFailures`/`maxConsecutiveFailures` are the threshold it crossed. The
 * sentence — which is the failing job handler's own error message, so for a database fault
 * it is raw pg driver text — is in `fly logs` and in Sentry.
 *
 * `jobType` IS STILL HERE, AND IT IS THE ONE VALUE ON THIS ENDPOINT THAT CODE DOES NOT
 * BOUND. `global_job_schedule.job_type` is `text NOT NULL UNIQUE` with NO CHECK constraint
 * (migration 0028:63, read), so it is whatever an operator or a migration named the
 * schedule. It is kept because it is the entire answer to "WHICH job is stopped" — reduce
 * it and `globalSchedules` becomes a row of anonymous counters and the operator has to open
 * the database anyway, which is the audience this body exists for.
 *
 * WHY THAT IS SAFE, CHECKED RATHER THAN ASSUMED: it is CONFIG text, never driver output.
 * Every write to that column in the repo was enumerated — the only ones are the two
 * migrations' `INSERT INTO global_job_schedule (job_type, …)` with literal constants
 * (0028:167, 0029:129). No runtime statement writes it: the three UPDATEs that touch this
 * table (worker/scheduler/global-jobs.ts:175, worker/core/global-job-schedule.ts:74 and
 * :458) set cadence/ledger/breaker columns and none of them names `job_type`. So no code
 * path can put an error message, a job UUID, a hostname or a SQL fragment in here; the
 * residual exposure is "an operator named a schedule something sensitive", which is a
 * different and far smaller risk than echoing a driver. A deliberate, recorded trade.
 */
export interface PublicGlobalScheduleSnapshot {
  jobType: string;
  status: GlobalJobScheduleStatus;
  enabled: boolean;
  missedRuns: number;
  consecutiveFailures: number;
  maxConsecutiveFailures: number;
  /** Non-null = the breaker is OPEN and only an operator can close it. WHEN it broke. */
  breakerTrippedAt: string | null;
  nextRunAt: string;
  lastSuccessAt: string | null;
  inFlight: boolean;
}

/**
 * The scheduler's metrics AS PUBLISHED — every key an operator gets, and no others.
 *
 * NOT `SchedulerMetrics`, and not derived from it by any type operator. This is a
 * hand-written list because the whole point is that adding a field to the producer must not
 * add a field here: `Omit<SchedulerMetrics, …>` would re-open exactly the route the spread
 * opened, since a new producer field is neither omitted nor noticed. The one-way street is
 * the design.
 *
 * Everything here is a boolean, a number, an ISO timestamp, a closed enum, or an array of
 * those. There is no field into which a future author can interpolate `errMsg(err)` without
 * changing this type first, and doing that is a visible edit to a file whose entire header
 * is about why they should not.
 */
export interface PublicSchedulerMetrics {
  enabled: boolean;
  environment: Environment;
  schedulerTickMs: number;
  pollIntervalMs: number;
  ticks: number;
  lastTickAt: string | null;
  lastEnqueueCount: number;
  totalEnqueued: number;
  lastGlobalEnqueueCount: number;
  totalGlobalEnqueued: number;
  totalGlobalSlotsSkipped: number;
  /** Job types whose breaker is OPEN per the DATABASE. Same `jobType` note as above. */
  globalBreakersTripped: string[];
  globalSchedules: PublicGlobalScheduleSnapshot[];
  /** When the durable read last SUCCEEDED. Null = never. Judge age against YOUR clock. */
  globalScheduleHealthAt: string | null;
  /**
   * Did the MOST RECENT durable-health read attempt fail? The whole of what
   * `globalScheduleHealthError` said, minus the driver's sentence.
   *
   * Read it WITH `globalScheduleHealthStatus`, which cannot express this on its own:
   *   status 'unknown' + false → no read has come back yet. Normal for a few seconds.
   *   status 'unknown' + true  → the FIRST read failed. The worker is blind and stays blind.
   *   status 'stale'   + true  → it worked once, at `globalScheduleHealthAt`, and not since.
   *   status 'last_read_ok'    → always false; the two are the same fact from both ends.
   */
  globalScheduleHealthReadFailed: boolean;
  jobsProcessed: number;
  jobsSucceeded: number;
  jobsFailed: number;
  lastJobAt: string | null;
  lastReconcileAt: string | null;
  totalReconciled: number;
  lastReconcileAttemptAt: string | null;
  reconcileAttempts: number;
  /**
   * WHICH LANE last recorded an error — the closed enum that replaced the driver's message.
   * Null = no lane has recorded one since boot.
   *
   * A HIGH-WATER MARK, NOT CURRENT STATE. Nothing clears it on success, so it names the
   * last thing that went wrong however long ago that was; `lastErrorAt` is what tells you
   * which. This is preserved on purpose — an error an hour ago is information — but it must
   * be read as "the last one", never as "right now".
   */
  lastErrorKind: SchedulerErrorKind | null;
  /** When `lastErrorKind` was stamped. Null = never. Judge age against YOUR clock. */
  lastErrorAt: string | null;
  /** Errors recorded since boot, all lanes. One blip vs a storm. Monotonic. */
  errorCount: number;
}

/**
 * The `scheduler` sub-object as it appears on the wire.
 *
 * `known: false` carries NO `enabled` key at all — deliberately. Reporting `enabled: false`
 * for a scheduler nobody has heard from is what made "I turned it off" and "I have no idea"
 * indistinguishable, and omitting the key makes reading `false` out of the unknown case
 * impossible rather than merely discouraged.
 *
 * ── WHY THE UNKNOWN ARM IS A BARE BOOLEAN AND NOT A `reason` STRING ──────────────────────
 * Same reason nothing else here is a string: the response is public and unauthenticated
 * (see the file header). A `reason: string` field would answer the operator's question no
 * better than `known` already does, while standing on a public endpoint as an open
 * invitation for the next author to interpolate `errMsg(err)` into it. That is not a
 * hypothesis about this codebase — it is what happened to `lastError`,
 * `globalScheduleHealthError` and `breakerReason`, which is why none of the three is on
 * this endpoint any more.
 *
 * ── WHAT tests/scheduler/healthz.test.ts PINS, AND WHAT IT DOES NOT ───────────────────────
 * FIVE pins, each against a hard-coded literal a human has to edit:
 *   1. the six TOP-LEVEL keys of the body;
 *   2. the keys this file ADDS on top of the metrics, AND the metrics keys it DROPS;
 *   3. the FULL key set of the `known: true` arm;
 *   4. the FULL key set of a `globalSchedules[]` ELEMENT — the nested set that no guard
 *      used to inspect, which is precisely how `breakerReason` sat on a public endpoint
 *      with three green guards over it;
 *   5. THE ALLOW-LIST PROBE — it attaches an own property this file has never heard of to a
 *      metrics object at runtime and requires the published key set to be UNCHANGED.
 *
 * ── WHAT PIN (3) IS FOR NOW, WHICH IS NOT WHAT IT USED TO BE ─────────────────────────────
 * READ THIS BEFORE REASONING ABOUT THE GUARDS, because the old explanation survived a
 * change that invalidated it and would send you the wrong way. When this arm was
 * `{ ...metrics }`, pin (3) was the LAST LINE against a producer field reaching the public
 * edge: (2) is a DIFFERENCE against a metrics fixture, so a key on both sides vanishes from
 * it by construction, and (1) only sees the top level while a producer field arrived INSIDE
 * `scheduler`. Pin (3) was the only one that could see it.
 *
 * A PRODUCER FIELD CANNOT ARRIVE INSIDE `scheduler` ANY MORE. PublicSchedulerMetrics is an
 * enumerated allow-list and schedulerReport() names every key it publishes, so a field added
 * to SchedulerMetrics is simply not published. PIN (3) THEREFORE NO LONGER CATCHES
 * PRODUCER-SIDE ADDITIONS — there is nothing for it to catch, and claiming otherwise would
 * describe a guard doing work the type system already did. What it catches now:
 *   • a key added to or removed from schedulerReport()'s literal / PublicSchedulerMetrics,
 *     i.e. a deliberate change to what the public is told — fails BY NAME;
 *   • a SPREAD revert — `{ ...metrics }` re-publishes `lastError` and
 *     `globalScheduleHealthError`, which are not in the literal, so it fails immediately.
 *
 * IT DOES NOT CATCH A BLOCKLIST, AND THAT IS WHY PIN (5) EXISTS. MEASURED: replacing this
 * projection with `const { lastError: _a, globalScheduleHealthError: _b, ...rest } = metrics`
 * — or the equivalent `Omit<SchedulerMetrics, 'lastError' | 'globalScheduleHealthError'>` —
 * produces EXACTLY today's key set and ran GREEN on every assertion in that file. A
 * blocklist and an allow-list are indistinguishable by output until a new producer field
 * exists, at which point the blocklist publishes it and the guards are still green. Pin (5)
 * is the only one that separates them, because it brings its own unknown field.
 * Pins (1), (2) and (4) are unchanged in character. (2) additionally pins the DROPPED set,
 * which is the only assertion that states this unit's outcome as a contract.
 *
 * ── AND WHAT NONE OF THEM DOES ───────────────────────────────────────────────────────────
 * None of the four pins VALUES. Keys-not-values is a deliberate stopping point, not an
 * oversight: on the day a guard catches a real leak, a value comparison would copy the
 * leaked value into the CI log. TWO assertions in that file do look at content, and neither
 * can print anything from the object under test: one checks the ABSENCE of sentinels the
 * test file itself declares, and one walks the whole body requiring every string to belong
 * to a closed, code-owned set and reports the PATH of an offender rather than its value.
 * That second one is the only guard that would notice free text arriving through a key that
 * is already on the allow-list.
 *
 * Nothing here is a COMPILE-TIME check that PublicSchedulerMetrics stays a subset of
 * anything, and none of these pins is one. That is a separate unit, deliberately sequenced
 * after this one.
 */
export type SchedulerReport = { known: false } | SchedulerReportedArm;

/**
 * The `known: true` arm. `globalScheduleHealthStatus` is declared here rather than on
 * PublicSchedulerMetrics because it is DERIVED by this file rather than projected from the
 * producer — keeping that distinction visible in the type is what lets the "what does
 * /healthz ADD to the metrics" guard mean something.
 */
export type SchedulerReportedArm = PublicSchedulerMetrics & {
  known: true;
  globalScheduleHealthStatus: GlobalScheduleHealthStatus;
};

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
  //
  // IT READS `globalScheduleHealthError` BUT PUBLISHES NOTHING FROM IT. The argument type is
  // still the PRODUCER's field, because the predicate is genuinely "did the last attempt
  // throw" and null-ness is how the producer records that. What crosses to the wire is the
  // three-value enum below and the boolean beside it — never the string.
  if (metrics.globalScheduleHealthAt === null) return 'unknown';
  return metrics.globalScheduleHealthError === null ? 'last_read_ok' : 'stale';
}

/**
 * Project one durable-health snapshot for publication. See PublicGlobalScheduleSnapshot for
 * why `breakerReason` is not here and what carries its meaning instead.
 */
function publicSnapshot(s: GlobalScheduleHealthSnapshot): PublicGlobalScheduleSnapshot {
  return {
    jobType: s.jobType,
    status: s.status,
    enabled: s.enabled,
    missedRuns: s.missedRuns,
    consecutiveFailures: s.consecutiveFailures,
    maxConsecutiveFailures: s.maxConsecutiveFailures,
    breakerTrippedAt: s.breakerTrippedAt,
    nextRunAt: s.nextRunAt,
    lastSuccessAt: s.lastSuccessAt,
    inFlight: s.inFlight,
  };
}

/**
 * Project the scheduler's metrics for /healthz, or say plainly that there are none.
 *
 * Exported so that the one place this convention is encoded is a function every reader can
 * call, rather than a rule each reader has to remember.
 *
 * ── EVERY KEY IS WRITTEN OUT. DO NOT REPLACE THIS WITH A SPREAD. ─────────────────────────
 * `{ ...scheduler, known: true }` is what this used to be, and it is how three separate
 * free-text fields reached a public unauthenticated endpoint without anyone editing this
 * file. The verbosity is the mechanism: a field added to SchedulerMetrics is published only
 * if somebody adds a line here, having read the header. If that feels like duplication,
 * re-read what the duplication is buying — it is the only thing standing between the
 * producer and the open internet, and a test cannot be that thing (a test can only notice).
 */
export function schedulerReport(scheduler: SchedulerMetrics | null | undefined): SchedulerReport {
  // No scheduler state is attached to this process, so its status is UNKNOWN — which is NOT
  // the same as a scheduler that was deliberately disabled. A disabled one WOULD report
  // known:true with enabled:false; nothing produces that today, because scheduler.ts sets
  // `enabled: true` and nothing ever unsets it. That arm is a type contract held open for a
  // future producer, not a state you can observe on this endpoint now — the distinction this
  // branch actually makes today is "reporting" versus "not heard from".
  // Said with a boolean and an absent key rather than a sentence; see the note on
  // SchedulerReport for why no prose goes on this endpoint.
  if (scheduler == null) return { known: false };
  return {
    known: true,
    enabled: scheduler.enabled,
    environment: scheduler.environment,
    schedulerTickMs: scheduler.schedulerTickMs,
    pollIntervalMs: scheduler.pollIntervalMs,
    ticks: scheduler.ticks,
    lastTickAt: scheduler.lastTickAt,
    lastEnqueueCount: scheduler.lastEnqueueCount,
    totalEnqueued: scheduler.totalEnqueued,
    lastGlobalEnqueueCount: scheduler.lastGlobalEnqueueCount,
    totalGlobalEnqueued: scheduler.totalGlobalEnqueued,
    totalGlobalSlotsSkipped: scheduler.totalGlobalSlotsSkipped,
    // Copied, not aliased. `globalSchedules` is already a fresh array (`.map`), and a
    // projection that hands one caller a live reference to the producer's own array while
    // the other gets a copy is an inconsistency waiting to be discovered by a mutation.
    globalBreakersTripped: [...scheduler.globalBreakersTripped],
    globalSchedules: scheduler.globalSchedules.map(publicSnapshot),
    globalScheduleHealthAt: scheduler.globalScheduleHealthAt,
    globalScheduleHealthStatus: deriveGlobalScheduleHealthStatus(scheduler),
    // The string's null-ness, and nothing else that was in the string.
    globalScheduleHealthReadFailed: scheduler.globalScheduleHealthError !== null,
    jobsProcessed: scheduler.jobsProcessed,
    jobsSucceeded: scheduler.jobsSucceeded,
    jobsFailed: scheduler.jobsFailed,
    lastJobAt: scheduler.lastJobAt,
    lastReconcileAt: scheduler.lastReconcileAt,
    totalReconciled: scheduler.totalReconciled,
    lastReconcileAttemptAt: scheduler.lastReconcileAttemptAt,
    reconcileAttempts: scheduler.reconcileAttempts,
    lastErrorKind: scheduler.lastErrorKind,
    lastErrorAt: scheduler.lastErrorAt,
    errorCount: scheduler.errorCount,
    // NOT PUBLISHED, and each one is a channel that WAS publishing until this unit:
    //   scheduler.lastError                  — raw driver text; a since-boot high-water mark
    //   scheduler.globalScheduleHealthError  — raw driver text
    //   scheduler.globalSchedules[].breakerReason — raw handler text, nested (see publicSnapshot)
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
