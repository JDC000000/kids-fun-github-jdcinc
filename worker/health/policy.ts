// worker/health/policy.ts — G-T15-5: per-source terms/robots/crawl policy enforcement AT
// RUNTIME ‹L3›. Two obligations, both enforced here:
//
//   1. TERMS/ROBOTS gate — a source whose terms status is missing/disallowed (or whose
//      robots status disallows) does NOT run in production. This composes the existing
//      canonical gate (worker/core/terms-gate.ts) into a single throwing assertion the
//      fetch seam calls, so enforcement is impossible to forget.
//
//   2. CRAWL POLITENESS — the RateLimiter / 403-429 backoff / identified-UA / conditional
//      (ETag/If-Modified-Since) PRIMITIVES already exist in worker/core/politeness.ts but,
//      per the Round-20 security review + tests/compliance/attribution.test.ts's own NOTE,
//      were NOT wired into any live adapter's real fetch() — only imported by tests. This
//      module is that wiring: politeFetch() is the single polite fetch seam, and the live
//      adapters (citycalendar, library, seasonal) now route their network reads through it.
//
// ‹L3› note on judgment calls: enforcement here is deliberately fail-closed. A source with
// an ambiguous/unknown terms status is treated as NOT-allowed in production (it must be an
// explicit 'allowed'/'summarise_only') rather than guessed — see evaluateSourcePolicy.
import {
  evaluateLiveFetchGate,
  evaluateTermsGate,
  type Environment,
  type SourceTermsInfo,
  type GateDecision,
} from '../core/terms-gate';
import {
  RateLimiter,
  recordResponse,
  recordTransportFailure,
  isDisabled,
  buildConditionalHeaders,
  clearBackoffState,
  USER_AGENT,
  type ConditionalCacheEntry,
} from '../core/politeness';

export type { Environment, SourceTermsInfo, GateDecision };
export { USER_AGENT };

/** Thrown when a source is blocked from running by terms/robots or an active crawl backoff. */
export class PolicyViolationError extends Error {
  constructor(
    message: string,
    readonly policyKey?: string
  ) {
    super(message);
    this.name = 'PolicyViolationError';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Terms / robots runtime enforcement (canonical, delegates to terms-gate).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The canonical runtime decision for "may this source perform a live fetch in this env?".
 * Fail-closed: production requires terms_status ∈ {allowed, summarise_only} AND
 * robots_status = 'allowed'; anything else (pending/unknown/disallowed/blocked) is blocked.
 */
export function evaluateSourcePolicy(source: SourceTermsInfo, env: Environment): GateDecision {
  return evaluateLiveFetchGate(source, env);
}

/** The looser "may this source run at all (fixture/staging review included)?" decision. */
export function evaluateRunPolicy(source: SourceTermsInfo, env: Environment): GateDecision {
  return evaluateTermsGate(source, env);
}

/** Assert a source may perform a live fetch; throws PolicyViolationError if not. */
export function assertLiveFetchAllowed(source: SourceTermsInfo, env: Environment): void {
  const decision = evaluateSourcePolicy(source, env);
  if (!decision.allowed) {
    throw new PolicyViolationError(`policy blocked: ${decision.reason}`, source.id);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Crawl politeness wiring.
// ─────────────────────────────────────────────────────────────────────────────

/** Polite default request rate (a ~3s floor) for a live source with no explicit override. */
export const DEFAULT_REQUESTS_PER_MINUTE = 20;

/** Per-family polite rate floors (config, not per-call magic numbers). Fallback = default. */
export const REQUESTS_PER_MINUTE_BY_FAMILY: Record<string, number> = {
  city_calendar: 20,
  library: 20,
  library_bibliocommons: 20,
  library_communico: 20,
  seasonal: 10, // status pages: gentler, low-value-change
  seasonal_watcher: 10,
  // Museum/attraction HTML pages: one or two GETs per venue-run, so the default floor
  // is ample. Listed explicitly because H4 moved this adapter onto the shared seam.
  venue_html: 20,
  // ActiveCommunities rec portals (T7): the only PAGINATED source we run — ~2N+2
  // requests per tenant-run rather than one. 20/min = a 3s floor, comfortably inside
  // the ">=1s spacing, single-threaded per host" hygiene rule that D-10's engineering
  // conditions require, and the per-run request cap in the tenant config bounds the
  // total. Stated explicitly rather than inherited from the default so the crawl
  // footprint of the highest-volume source is visible in config.
  activenet: 20,
  // PerfectMind BookMe4 widgets (T8): the project's second PAGINATED source — 1 category
  // request plus a cursor walk per drop-in calendar. Same 20/min = 3s floor as ActiveNet,
  // for the same reason (comfortably inside D-10's ">=1s spacing, single-threaded per
  // host" engineering condition), with the per-run request cap in the tenant config
  // bounding the total. Stated explicitly rather than inherited so the crawl footprint of
  // every high-volume source is visible in one table.
  perfectmind: 20,
};

export function requestsPerMinuteFor(family?: string): number {
  if (family && family in REQUESTS_PER_MINUTE_BY_FAMILY) return REQUESTS_PER_MINUTE_BY_FAMILY[family];
  return DEFAULT_REQUESTS_PER_MINUTE;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2a. Request deadline (H4).
//
// THE BUG THIS FIXES, observed in staging 2026-07-30: politeFetch called global
// fetch() with no AbortController and no deadline of any kind. The Vancouver
// ActiveNet job accepted a connection that never produced a response and sat at
// status='running' for 8+ minutes with zero records and zero errors — the fetch
// promise simply never settled, so the 403/429 breaker below never got a status to
// react to, finishCheckRun() was never reached, and the whole ingest run wedged.
// The target site answered in under half a second from outside Fly's network at the
// same moment, so this is a stalled connection, not a down site.
//
// Every request now gets a deadline whether or not its caller thought about one —
// an adapter author forgetting to is precisely how this happened.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Per-request deadline, measured from the moment the request is issued and covering
 * BOTH the wait for response headers and the caller's read of the body.
 *
 * Why 15s:
 *  • Measured behaviour, not a guess — the ActiveCommunities portal answers in <0.5s
 *    from outside Fly (T7's live capture, re-confirmed during this incident). 15s is
 *    ~30x the observed response time, so it cannot fire on a merely-slow-but-alive host.
 *  • It has to cover the heaviest request in the project, not the average one: the
 *    ActiveNet `multicenter/events` POST-as-query returns a tenant's ENTIRE calendar
 *    period in a single response (Vancouver: 10,146 occurrences). 15s leaves room for a
 *    cold server-side search plus streaming that payload. A Trumba JSON feed, a
 *    BiblioCommons RSS document or a status page is far lighter.
 *  • It has to stay small enough that the retry below still lands well inside the 60s
 *    scheduler tick — see MAX_DEFAULT_FETCH_WALL_CLOCK_MS.
 *  • Consistent with the project's existing judgement: the seasonal watcher already
 *    picked 10s for a lightweight status page. This is the same order of magnitude,
 *    set a little higher because as the SHARED default it must also cover the above.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

/**
 * Total attempts per politeFetch call — one initial try plus ONE retry.
 *
 * A retry is worth having because a genuine transient stall (a dropped SYN/ACK, a TLS
 * handshake that dies mid-negotiation) is fixed by simply dialling again. But retrying
 * a hang is the one retry that is guaranteed to be expensive when it does not help, so
 * it is capped at a single extra attempt: the marginal recovery rate of attempt 3 is
 * small and it would push the worst case past half a minute. A source that is genuinely
 * down is meant to fail the run and trip the breaker, not be dialled repeatedly.
 */
export const MAX_REQUEST_ATTEMPTS = 2;

/** Pause between a timed-out attempt and the retry. Matches the ActiveNet client's
 *  TRANSIENT_BACKOFF_BASE_MS so the project has one retry rhythm, not two. */
export const RETRY_BACKOFF_MS = 2_000;

/** Hard floor/ceiling for a caller-supplied `timeoutMs`. The ceiling is what makes
 *  "no request is unbounded" structurally true rather than a convention: there is no
 *  value — not 0, not Infinity, not NaN — that a caller can pass to switch the
 *  deadline off. See resolveTimeoutMs. */
export const MIN_REQUEST_TIMEOUT_MS = 1_000;
export const MAX_REQUEST_TIMEOUT_MS = 60_000;

/** The slowest politeness floor any configured family imposes (seasonal's 10/min → 6s).
 *  Derived from the table above so it cannot drift out of date. */
const SLOWEST_RATE_LIMIT_FLOOR_MS =
  60_000 / Math.min(DEFAULT_REQUESTS_PER_MINUTE, ...Object.values(REQUESTS_PER_MINUTE_BY_FAMILY));

/**
 * WORST-CASE WALL CLOCK for one politeFetch call at the default deadline, stated
 * explicitly because "bounded" is the whole point of this change:
 *
 *   rate-limiter wait (≤6s) + attempt 1 (15s) + backoff (2s) + attempt 2 (15s) = 38s
 *
 * The rate-limiter wait is counted ONCE, not per attempt: attempt 1 burning its full
 * 15s deadline already exceeds every configured per-source interval, so the limiter
 * lets the retry straight through. Asserted in tests/health/policy-timeout.test.ts.
 */
export const MAX_DEFAULT_FETCH_WALL_CLOCK_MS =
  SLOWEST_RATE_LIMIT_FLOOR_MS +
  MAX_REQUEST_ATTEMPTS * DEFAULT_REQUEST_TIMEOUT_MS +
  (MAX_REQUEST_ATTEMPTS - 1) * RETRY_BACKOFF_MS;

/** A request that blew its deadline. Distinct from PolicyViolationError (we chose not
 *  to fetch) — this is "we fetched and the host never answered". */
export class FetchTimeoutError extends Error {
  constructor(
    readonly policyKey: string,
    readonly url: string,
    readonly timeoutMs: number,
    readonly attempts: number
  ) {
    super(
      `fetch timed out after ${timeoutMs}ms on attempt ${attempts} for ${policyKey} at ${url}`
    );
    this.name = 'FetchTimeoutError';
  }
}

/**
 * Resolve a caller's `timeoutMs` to a real deadline. Exported because this is the
 * invariant the whole fix rests on — no input, including the ones a careless caller is
 * most likely to produce (undefined, 0, NaN, Infinity), can yield "no deadline".
 */
export function resolveTimeoutMs(requested?: number): number {
  if (requested == null || !Number.isFinite(requested)) return DEFAULT_REQUEST_TIMEOUT_MS;
  return Math.min(Math.max(requested, MIN_REQUEST_TIMEOUT_MS), MAX_REQUEST_TIMEOUT_MS);
}

/** An abort surfaced by fetch — undici uses AbortError, AbortSignal.timeout TimeoutError. */
function isAbortLike(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name;
  return name === 'AbortError' || name === 'TimeoutError';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * ONE attempt, guaranteed to settle within `timeoutMs`.
 *
 * Two independent mechanisms, deliberately both present:
 *
 *  1. An AbortController, composed with any signal the CALLER passed, so a real fetch
 *     tears the socket down instead of leaking it. Composition matters: the seasonal
 *     watcher already passes its own 10s signal, and overwriting `init.signal` here
 *     would have silently deleted that adapter's existing timeout.
 *
 *  2. A race against the deadline, so politeFetch's own promise settles on time EVEN IF
 *     the underlying fetch implementation ignores AbortSignal entirely. The contract
 *     being fixed is "politeFetch always settles"; making that conditional on the
 *     transport behaving well is exactly the assumption that produced the incident.
 *
 * The abort timer is deliberately NOT cleared when the response headers arrive. It stays
 * armed across the caller's body read, so a host that sends headers and then stalls the
 * body is bounded too. Every adapter reads the body on the next line, so a legitimate
 * response is never cut off; the timer is unref'd, so an armed deadline never holds the
 * process open.
 *
 * WHY NOT JUST BUFFER THE BODY HERE? The tidy-looking alternative — have politeFetch read
 * the body to completion inside the deadline and hand back a memory-backed Response — is
 * rejected on its merits, not as a workaround. It would make a whole-body allocation
 * MANDATORY for every caller of shared infrastructure, and this project's heaviest response
 * is not small: ActiveNet's `multicenter/events` returns a tenant's entire calendar period
 * in a single payload (Vancouver: 10,146 occurrences). Buffering would force that to be
 * fully materialised on every request, for every adapter, to solve a problem the armed
 * timer above already solves at zero allocation cost — and it would additionally discard
 * `Response.url`/redirect metadata by reconstructing the object.
 *
 * So this is a deliberate design choice, not deferred cleanup. Please do not "simplify" it
 * into a buffering implementation. (It would also require rewriting the several existing
 * test doubles that return plain `{ok,status,text}` objects rather than real `Response`s,
 * but that is a symptom of the same over-reach, not the reason.)
 */
async function fetchAttemptWithDeadline(
  doFetch: typeof fetch,
  policyKey: string,
  url: string | URL,
  init: RequestInit & { headers?: Record<string, string> },
  headers: Record<string, string>,
  timeoutMs: number,
  attempt: number
): Promise<Response> {
  const callerSignal = init.signal ?? undefined;
  const controller = new AbortController();
  const onCallerAbort = (): void => controller.abort(callerSignal?.reason);

  if (callerSignal) {
    if (callerSignal.aborted) controller.abort(callerSignal.reason);
    else callerSignal.addEventListener('abort', onCallerAbort, { once: true });
  }

  const abortTimer = setTimeout(() => {
    controller.abort(new DOMException(`politeFetch deadline ${timeoutMs}ms exceeded`, 'TimeoutError'));
  }, timeoutMs);
  abortTimer.unref?.();

  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    deadlineTimer = setTimeout(
      () => reject(new FetchTimeoutError(policyKey, String(url), timeoutMs, attempt)),
      timeoutMs
    );
    deadlineTimer.unref?.();
  });

  try {
    return await Promise.race([doFetch(url, { ...init, headers, signal: controller.signal }), deadline]);
  } catch (err) {
    // The caller's own signal fired: that is a deliberate cancellation by the adapter,
    // not a source fault. Propagate it verbatim, never retry it, never blame the source.
    if (callerSignal?.aborted) throw err;
    if (err instanceof FetchTimeoutError) throw err;
    // Our deadline aborted the socket and fetch rejected before the race timer ran.
    if (isAbortLike(err)) throw new FetchTimeoutError(policyKey, String(url), timeoutMs, attempt);
    // A genuine transport error (DNS, ECONNREFUSED, TLS reject). Unchanged behaviour:
    // it already surfaced promptly and already fails the run — not this fix's business.
    throw err;
  } finally {
    clearTimeout(deadlineTimer);
    callerSignal?.removeEventListener('abort', onCallerAbort);
  }
}

// Per-source rate limiters, keyed by policyKey + rpm so a source keeps its own token bucket
// across calls within a process. Module-scoped like politeness.ts's backoff map.
const limiters = new Map<string, RateLimiter>();

function getRateLimiter(policyKey: string, requestsPerMinute: number): RateLimiter {
  const key = `${policyKey}:${requestsPerMinute}`;
  let rl = limiters.get(key);
  if (!rl) {
    rl = new RateLimiter({ requestsPerMinute });
    limiters.set(key, rl);
  }
  return rl;
}

/** Test/ops helper: reset all per-source politeness state (rate limiters + backoff). */
export function clearPolicyState(): void {
  limiters.clear();
  clearBackoffState();
}

export interface PoliteFetchOptions {
  /** Override the per-source rate (default: requestsPerMinuteFor(family) or the global default). */
  requestsPerMinute?: number;
  family?: string;
  /** Prior fetch's cache metadata → conditional (ETag / If-Modified-Since) request. */
  prevCache?: ConditionalCacheEntry;
  /**
   * Per-request deadline override, clamped to [MIN,MAX]_REQUEST_TIMEOUT_MS. Omitting it
   * (or passing a nonsense value) yields DEFAULT_REQUEST_TIMEOUT_MS — there is no way to
   * opt out of a deadline, by design.
   */
  timeoutMs?: number;
  /** Injectable clock/sleep/fetch for tests. */
  now?: () => number;
  sleepImpl?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
}

/**
 * The single POLITE FETCH seam every live adapter routes through. In order it:
 *   1. refuses if the source is under an active 403/429/timeout backoff (isDisabled),
 *   2. waits out the per-source rate limiter,
 *   3. sends an identified User-Agent + conditional headers (merged under caller headers),
 *   4. applies a hard per-request deadline, retrying ONCE on a timeout (H4),
 *   5. records the outcome for backoff (403/429 disable, 2xx clears, timeout disables),
 * then returns the Response. `policyKey` is the stable per-source key for rate-limit + backoff
 * state (e.g. 'city_calendar::vancouver').
 *
 * Timeout outcome (H4): after the last attempt this records a transport failure — which
 * arms the SAME growing backoff a 429 would — and throws FetchTimeoutError. That throw is
 * what makes the existing machinery work rather than a new parallel path: ingestSource()
 * already catches anything out of adapter.fetch(), so the run lands as a `source_check_run`
 * row with status='failed' and the error text, the scheduler's markFailed() retries the job
 * with its own backoff and eventually dead-letters it, and isDisabled() above makes the next
 * cadence tick refuse without touching the network. Nothing new to remember to call.
 */
export async function politeFetch(
  policyKey: string,
  url: string | URL,
  init: RequestInit & { headers?: Record<string, string> } = {},
  opts: PoliteFetchOptions = {}
): Promise<Response> {
  if (isDisabled(policyKey)) {
    throw new PolicyViolationError(`crawl backoff active for ${policyKey} — refusing to fetch`, policyKey);
  }

  const rpm = opts.requestsPerMinute ?? requestsPerMinuteFor(opts.family);
  const timeoutMs = resolveTimeoutMs(opts.timeoutMs);
  const limiter = getRateLimiter(policyKey, rpm);
  const sleepImpl = opts.sleepImpl ?? sleep;

  const callerHeaders = init.headers ?? {};
  // A caller "owns" the User-Agent only if it supplied a NON-EMPTY one. Requiring a real
  // value (QA finding H4-B) closes the case where `{'user-agent': ''}` would otherwise
  // suppress the seam's default and send the project's crawler out unidentified — the one
  // thing the politeness contract is least allowed to get wrong. An empty value is treated
  // as "no UA supplied", so the identified default still applies.
  const callerUserAgentKeys = Object.keys(callerHeaders).filter((k) => k.toLowerCase() === 'user-agent');
  // String() rather than a bare .trim(): the static type says these are strings, but this is
  // the boundary where an untyped caller (or JSON round-trip) could hand us a number or null,
  // and a throw here would take down a fetch over a header nicety.
  const callerHasUserAgent = callerUserAgentKeys.some((k) => String(callerHeaders[k] ?? '').trim() !== '');
  const conditional = buildConditionalHeaders(opts.prevCache);
  // A caller that supplied its own User-Agent (in ANY casing) owns it — drop the seam's
  // default rather than emitting two differently-cased UA keys, which is ambiguous on the
  // wire and is exactly how one identified UA silently shadows another.
  if (callerHasUserAgent) delete conditional['User-Agent'];
  const headers: Record<string, string> = { ...conditional, ...callerHeaders };
  if (!callerHasUserAgent) {
    // Drop any empty caller UA keys first, so the guaranteed default cannot be re-shadowed
    // by an empty value sitting under a different casing.
    for (const k of callerUserAgentKeys) delete headers[k];
    headers['User-Agent'] = USER_AGENT;
  }

  const doFetch = opts.fetchImpl ?? fetch;
  let lastTimeout: FetchTimeoutError | undefined;

  for (let attempt = 1; attempt <= MAX_REQUEST_ATTEMPTS; attempt += 1) {
    // Politeness is re-applied to the retry, so a retry can never breach the crawl
    // contract — the per-source interval gates attempt 2 exactly like attempt 1.
    await limiter.wait(opts.now, opts.sleepImpl);
    try {
      const res = await fetchAttemptWithDeadline(doFetch, policyKey, url, init, headers, timeoutMs, attempt);
      recordResponse(policyKey, res.status);
      return res;
    } catch (err) {
      // Only a deadline breach is retryable here. A 403/429 arrives as a RESPONSE and is
      // handled by recordResponse above — this must never turn an explicit "go away" into
      // a second request. Real transport errors propagate untouched.
      if (!(err instanceof FetchTimeoutError)) throw err;
      lastTimeout = err;
      if (attempt < MAX_REQUEST_ATTEMPTS) await sleepImpl(RETRY_BACKOFF_MS);
    }
  }

  recordTransportFailure(policyKey);
  throw lastTimeout ?? new FetchTimeoutError(policyKey, String(url), timeoutMs, MAX_REQUEST_ATTEMPTS);
}

/**
 * Full runtime-policy fetch seam: enforce terms/robots for `source` in `env` (throws if
 * blocked, WITHOUT touching the network) and then politeFetch. This is the belt-and-braces
 * seam — a source with disallowed terms status genuinely cannot reach fetch().
 */
export async function guardedLiveFetch(
  source: SourceTermsInfo,
  env: Environment,
  policyKey: string,
  url: string | URL,
  init: RequestInit & { headers?: Record<string, string> } = {},
  opts: PoliteFetchOptions = {}
): Promise<Response> {
  assertLiveFetchAllowed(source, env);
  return politeFetch(policyKey, url, init, { family: source.id, ...opts });
}
