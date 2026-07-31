// worker/core/politeness.ts — G-T5-5: crawl-politeness controls (TSD §5.3 IR-02).
// Per-source rate limiting, retry/backoff, identified user-agent, conditional
// requests, and 403/429 -> disable/backoff. No login/checkout/CAPTCHA flows —
// adapters must never attempt those (enforced by review, not code, since it's
// a "don't build this" constraint rather than a runtime check).

export interface RateLimiterOptions {
  requestsPerMinute: number;
}

/** Simple per-source token-bucket-of-one rate limiter. */
export class RateLimiter {
  private readonly minIntervalMs: number;
  private lastRequestAt = -Infinity;

  constructor(opts: RateLimiterOptions) {
    this.minIntervalMs = 60_000 / Math.max(1, opts.requestsPerMinute);
  }

  /** Resolves once it's safe to make the next request, waiting if necessary. */
  async wait(now: () => number = Date.now, sleepImpl: (ms: number) => Promise<void> = sleep): Promise<void> {
    const nowMs = now();
    const elapsed = nowMs - this.lastRequestAt;
    if (elapsed < this.minIntervalMs) {
      await sleepImpl(this.minIntervalMs - elapsed);
    }
    this.lastRequestAt = now();
  }
}

export interface SourceBackoffState {
  disabledUntil: Date | null;
  consecutiveFailures: number;
}

const backoffState = new Map<string, SourceBackoffState>();

/** The shared growing-backoff curve: 2^n minutes, capped at an hour. One curve for
 *  every "the source is not answering us properly" signal, so an explicit 429 and a
 *  silent hang are punished on the same schedule rather than by two rival policies. */
function penalise(state: SourceBackoffState): void {
  state.consecutiveFailures += 1;
  const backoffMinutes = Math.min(60, 2 ** state.consecutiveFailures);
  state.disabledUntil = new Date(Date.now() + backoffMinutes * 60_000);
}

function stateFor(sourceId: string): SourceBackoffState {
  return backoffState.get(sourceId) ?? { disabledUntil: null, consecutiveFailures: 0 };
}

/** Call after every fetch attempt. 403/429 trip a growing backoff + disable;
 *  a 2xx response clears it. */
export function recordResponse(sourceId: string, statusCode: number): SourceBackoffState {
  const state = stateFor(sourceId);
  if (statusCode === 403 || statusCode === 429) {
    penalise(state);
  } else if (statusCode >= 200 && statusCode < 300) {
    state.consecutiveFailures = 0;
    state.disabledUntil = null;
  }
  backoffState.set(sourceId, state);
  return state;
}

/**
 * Call when a request failed at the TRANSPORT level — it timed out and no HTTP
 * response ever arrived, so recordResponse() has no status code to judge.
 *
 * Why this exists: the 403/429 breaker above can only react to a response. A source
 * that accepts the TCP connection and then never answers produces no status at all,
 * so before this the breaker stayed blind and a permanently-hanging source would be
 * re-dialled on every single cadence tick forever. A hang is at least as strong a
 * "back off from this host" signal as a 429, so it shares the same curve and is
 * cleared by the same thing: the next 2xx.
 */
export function recordTransportFailure(sourceId: string): SourceBackoffState {
  const state = stateFor(sourceId);
  penalise(state);
  backoffState.set(sourceId, state);
  return state;
}

export function isDisabled(sourceId: string): boolean {
  const state = backoffState.get(sourceId);
  if (!state?.disabledUntil) return false;
  return state.disabledUntil.getTime() > Date.now();
}

/** Test/ops helper. */
export function clearBackoffState(sourceId?: string): void {
  if (sourceId) backoffState.delete(sourceId);
  else backoffState.clear();
}

export const USER_AGENT = 'KidsFunBot/1.0 (+https://kidsfun.example/bot; contact: ops@kidsfun.example)';

export interface ConditionalCacheEntry {
  etag?: string;
  lastModified?: string;
}

/** Builds request headers with an identified UA + conditional-request headers
 *  (ETag/If-Modified-Since) when a previous fetch's cache metadata is known. */
export function buildConditionalHeaders(prev?: ConditionalCacheEntry): Record<string, string> {
  const headers: Record<string, string> = { 'User-Agent': USER_AGENT };
  if (prev?.etag) headers['If-None-Match'] = prev.etag;
  if (prev?.lastModified) headers['If-Modified-Since'] = prev.lastModified;
  return headers;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
