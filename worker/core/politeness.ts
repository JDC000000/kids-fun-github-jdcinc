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

/** Call after every fetch attempt. 403/429 trip a growing backoff + disable;
 *  a 2xx response clears it. */
export function recordResponse(sourceId: string, statusCode: number): SourceBackoffState {
  const state = backoffState.get(sourceId) ?? { disabledUntil: null, consecutiveFailures: 0 };
  if (statusCode === 403 || statusCode === 429) {
    state.consecutiveFailures += 1;
    const backoffMinutes = Math.min(60, 2 ** state.consecutiveFailures);
    state.disabledUntil = new Date(Date.now() + backoffMinutes * 60_000);
  } else if (statusCode >= 200 && statusCode < 300) {
    state.consecutiveFailures = 0;
    state.disabledUntil = null;
  }
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
