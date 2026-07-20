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
};

export function requestsPerMinuteFor(family?: string): number {
  if (family && family in REQUESTS_PER_MINUTE_BY_FAMILY) return REQUESTS_PER_MINUTE_BY_FAMILY[family];
  return DEFAULT_REQUESTS_PER_MINUTE;
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
  /** Injectable clock/sleep/fetch for tests. */
  now?: () => number;
  sleepImpl?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
}

/**
 * The single POLITE FETCH seam every live adapter routes through. In order it:
 *   1. refuses if the source is under an active 403/429 backoff (isDisabled),
 *   2. waits out the per-source rate limiter,
 *   3. sends an identified User-Agent + conditional headers (merged under caller headers),
 *   4. records the response status for backoff (403/429 disable, 2xx clears),
 * then returns the Response. `policyKey` is the stable per-source key for rate-limit + backoff
 * state (e.g. 'city_calendar::vancouver').
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
  await getRateLimiter(policyKey, rpm).wait(opts.now, opts.sleepImpl);

  const headers: Record<string, string> = {
    ...buildConditionalHeaders(opts.prevCache),
    ...(init.headers ?? {}),
  };
  // Guarantee an identified UA even if a caller passed its own headers without one.
  if (!headers['User-Agent'] && !headers['user-agent']) headers['User-Agent'] = USER_AGENT;

  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(url, { ...init, headers });
  recordResponse(policyKey, res.status);
  return res;
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
