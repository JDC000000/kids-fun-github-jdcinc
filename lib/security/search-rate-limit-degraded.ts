// lib/security/search-rate-limit-degraded.ts — what the /search rate limit does when its own
// counter table is unreachable (2026-09-24, option C+D of
// documents/kids-fun/search-ratelimit-fail-closed-SCOPE-2026-09-24.md in the Control Room workspace).
//
// ═══ WHY NOT JUST "FAIL CLOSED" ═══
// Until this module, a DB error in lib/security/search-rate-limit.ts let EVERY request through
// (fail open). That silently disabled the protection doing ~95% of the Vercel cost control against
// crawlers walking /search filter permutations. The obvious flip — refuse everything when the
// counter table errors — was rejected, because the limiter can fail while search itself still
// works: the catalogue/alias/region reads are cached per instance, and a migration shipped after
// its code (the 2026-09-22 10:26Z event) breaks ONLY the limiter's table. Fail-closed would turn
// each of those into a full /search outage for real parents.
//
// ═══ WHAT HAPPENS INSTEAD ═══
//   1. DEADLINE — the DB limiter path gets a total time budget. A saturated pool used to make a
//      request wait the full 10s acquire timeout before failing open; now it fails over quickly.
//   2. BREAKER — after repeated DB-limiter failures this instance stops calling the DB limiter for
//      a short window (then lets exactly one probe through). While an outage lasts, the limiter
//      stops adding up to four pool acquires per request to a pool that is already failing — in
//      the 2026-09-24 EMAXCONNSESSION window it was one of the clients competing for it.
//   3. MEMORY FALLBACK — while the DB limiter is unavailable (error, deadline, or breaker open),
//      the SAME four buckets with the SAME limits are evaluated against a bounded, per-instance
//      in-memory counter. A real parent (far below 12/min) never notices; a crawler is still
//      refused, at worst `limit × number of warm instances it lands on`.
// `no_salt` and `no_subject` are NOT handled here and still fail open, unchanged: there is no
// subject to count in either case, and refusing on `no_salt` would take down any environment
// missing the salt (staging has none today).
//
// Everything here is per serverless INSTANCE and deliberately so: no shared state means no new
// dependency that could itself be down during the outage this exists for. State is lost on cold
// start, which only ever makes the fallback more lenient, never stricter than the DB limiter.

/** Total budget for the DB limiter path (all up-to-four statements), in ms. Well above a healthy
 *  round trip (~20ms cross-region × 4) and far below the pool's 10s acquire timeout. */
export const DB_LIMITER_DEADLINE_MS = 1_500;

/** Breaker: this many DB-limiter failures inside BREAKER_FAILURE_WINDOW_MS opens it. More than
 *  one, so a single stale pooled connection (57P01 on a reclaimed backend) cannot trip it. */
export const BREAKER_FAILURE_THRESHOLD = 3;
export const BREAKER_FAILURE_WINDOW_MS = 10_000;
/** How long an open breaker skips the DB limiter before letting one probe through. */
export const BREAKER_OPEN_MS = 15_000;

/** Upper bound on in-memory buckets per instance, so a cookie-dropping, IP-rotating caller cannot
 *  grow memory without bound while the DB limiter is down. Each entry is a short string + 2
 *  numbers; 10k is well under a megabyte. */
export const MEMORY_FALLBACK_MAX_ENTRIES = 10_000;

/** A degraded reason is reported to Sentry at most once per this window, per instance. */
export const DEGRADED_REPORT_INTERVAL_MS = 60_000;

// ── In-memory counter ──────────────────────────────────────────────────────────────────────────

interface MemoryBucket {
  attempts: number;
  expiresAtMs: number;
}

/**
 * Same contract as the DB `countAttempt` in search-rate-limit.ts, so the four-bucket evaluation
 * can run unchanged against either: the first attempt in a window creates the bucket at 1, an
 * attempt under `maxAttempts` increments and is allowed, and a REFUSED attempt leaves the bucket
 * untouched (hammering a closed limit must not extend the caller's own lockout).
 */
export class MemoryRateLimitStore {
  private readonly buckets = new Map<string, MemoryBucket>();

  constructor(private readonly maxEntries: number = MEMORY_FALLBACK_MAX_ENTRIES) {}

  countAttempt(
    scope: string,
    hash: string,
    windowSeconds: number,
    maxAttempts: number,
    nowMs: number
  ): { allowed: boolean; attempts: number } {
    const windowMs = windowSeconds * 1000;
    const windowStartMs = Math.floor(nowMs / windowMs) * windowMs;
    const key = `${scope}|${hash}|${windowStartMs}`;
    const existing = this.buckets.get(key);

    if (!existing) {
      this.makeRoom(nowMs);
      this.buckets.set(key, { attempts: 1, expiresAtMs: windowStartMs + windowMs });
      return { allowed: true, attempts: 1 };
    }
    if (existing.attempts >= maxAttempts) {
      return { allowed: false, attempts: existing.attempts };
    }
    existing.attempts += 1;
    // Re-insert so Map order tracks recency: the oldest key is always the least recently used.
    this.buckets.delete(key);
    this.buckets.set(key, existing);
    return { allowed: true, attempts: existing.attempts };
  }

  get size(): number {
    return this.buckets.size;
  }

  clear(): void {
    this.buckets.clear();
  }

  /** At capacity: drop expired buckets first; if that frees nothing, evict least recently used. */
  private makeRoom(nowMs: number): void {
    if (this.buckets.size < this.maxEntries) return;
    for (const [key, bucket] of this.buckets) {
      if (bucket.expiresAtMs <= nowMs) this.buckets.delete(key);
    }
    while (this.buckets.size >= this.maxEntries) {
      const oldest = this.buckets.keys().next().value;
      if (oldest === undefined) break;
      this.buckets.delete(oldest);
    }
  }
}

// ── Circuit breaker ────────────────────────────────────────────────────────────────────────────

export type BreakerState = 'closed' | 'open' | 'half_open';

export interface BreakerOptions {
  failureThreshold?: number;
  failureWindowMs?: number;
  openMs?: number;
}

/**
 * closed → open after `failureThreshold` failures within `failureWindowMs`.
 * open → half_open once `openMs` has elapsed; exactly ONE caller is let through as the probe,
 * every concurrent caller keeps using the fallback until the probe settles.
 * half_open → closed on probe success, → open (fresh `openMs`) on probe failure.
 */
export class SearchRateLimitBreaker {
  private state: BreakerState = 'closed';
  private failureTimes: number[] = [];
  private openedAtMs = 0;
  private probeInFlight = false;
  private readonly failureThreshold: number;
  private readonly failureWindowMs: number;
  private readonly openMs: number;

  constructor(options: BreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? BREAKER_FAILURE_THRESHOLD;
    this.failureWindowMs = options.failureWindowMs ?? BREAKER_FAILURE_WINDOW_MS;
    this.openMs = options.openMs ?? BREAKER_OPEN_MS;
  }

  currentState(): BreakerState {
    return this.state;
  }

  /** Whether this caller may use the DB limiter now. Claims the probe slot when half-opening. */
  tryAcquire(nowMs: number): boolean {
    if (this.state === 'closed') return true;
    if (this.state === 'open') {
      if (nowMs - this.openedAtMs < this.openMs) return false;
      this.state = 'half_open';
      this.probeInFlight = false;
    }
    if (this.probeInFlight) return false;
    this.probeInFlight = true;
    return true;
  }

  recordSuccess(): void {
    this.reset();
  }

  reset(): void {
    this.state = 'closed';
    this.failureTimes = [];
    this.probeInFlight = false;
  }

  recordFailure(nowMs: number): void {
    if (this.state === 'half_open') {
      this.open(nowMs);
      return;
    }
    if (this.state === 'open') return; // a straggler that started before the breaker opened
    this.failureTimes = this.failureTimes.filter((t) => nowMs - t < this.failureWindowMs);
    this.failureTimes.push(nowMs);
    if (this.failureTimes.length >= this.failureThreshold) this.open(nowMs);
  }

  private open(nowMs: number): void {
    this.state = 'open';
    this.openedAtMs = nowMs;
    this.failureTimes = [];
    this.probeInFlight = false;
  }
}

// ── Degraded-report throttle ───────────────────────────────────────────────────────────────────

/**
 * The route used to `await captureAndFlush` on EVERY degraded request — during an outage that is
 * one Sentry event plus one flush round trip per request, paid in latency and Observability
 * events. This lets each reason through at most once per interval, per instance.
 */
export class DegradedReportThrottle {
  private readonly lastReportedAtMs = new Map<string, number>();

  constructor(private readonly intervalMs: number = DEGRADED_REPORT_INTERVAL_MS) {}

  shouldReport(reason: string, nowMs: number): boolean {
    const last = this.lastReportedAtMs.get(reason);
    if (last !== undefined && nowMs - last < this.intervalMs) return false;
    this.lastReportedAtMs.set(reason, nowMs);
    return true;
  }

  clear(): void {
    this.lastReportedAtMs.clear();
  }
}

// ── Deadline ───────────────────────────────────────────────────────────────────────────────────

export class SearchRateLimitDeadlineError extends Error {
  readonly code = 'SEARCH_RATE_LIMIT_DEADLINE';
  constructor(readonly deadlineMs: number) {
    super(`search rate-limit DB check exceeded its ${deadlineMs}ms deadline`);
    this.name = 'SearchRateLimitDeadlineError';
  }
}

/**
 * A handle the DB limiter path checks before each statement, so that once the deadline has fired
 * the abandoned sequence does not go on to issue its remaining statements.
 */
export interface DeadlineBudget {
  expired: boolean;
}

/**
 * Race `work(budget)` against `deadlineMs`. On expiry: `budget.expired` is set and the returned
 * promise rejects with SearchRateLimitDeadlineError. The in-flight statement is ABANDONED, not
 * cancelled — safe here because every limiter statement is a single autocommit
 * `INSERT … ON CONFLICT`, so there is no open transaction to leave `idle in transaction` (the
 * 2026-09-14 wedge lib/db/client.ts's queryWithTimeout header describes). queryWithTimeout itself
 * is deliberately NOT used: its BEGIN/SET LOCAL/COMMIT wrapper would triple the round trips.
 */
export function withDeadline<T>(work: (budget: DeadlineBudget) => Promise<T>, deadlineMs: number): Promise<T> {
  const budget: DeadlineBudget = { expired: false };
  const running = work(budget);
  // The abandoned promise may still reject after the deadline; never let that go unhandled.
  running.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      budget.expired = true;
      reject(new SearchRateLimitDeadlineError(deadlineMs));
    }, deadlineMs);
  });
  return Promise.race([running, deadline]).finally(() => clearTimeout(timer));
}

// ── Cause, for reporting ───────────────────────────────────────────────────────────────────────

/**
 * A short, non-secret description of WHY the DB limiter failed. The 2026-09-24 Sentry audit could
 * not tell a missing migration from ENOTFOUND from pooler exhaustion because the error was
 * discarded. `code` (pg SQLSTATE or Node errno) is the stable part; the message is truncated and
 * still passes through sentry.scrub.ts's redaction when it is sent.
 */
export function describeLimiterFailure(err: unknown): string {
  if (!(err instanceof Error)) return `non_error:${typeof err}`;
  const code = (err as { code?: unknown }).code;
  const codePart = typeof code === 'string' && code.length > 0 ? code : err.name;
  const message = err.message.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s@/]+@/gi, '<redacted>@').slice(0, 160);
  return `${codePart}: ${message}`;
}

// ── Per-instance state ─────────────────────────────────────────────────────────────────────────

export interface SearchRateLimitDegradedState {
  store: MemoryRateLimitStore;
  breaker: SearchRateLimitBreaker;
  reportThrottle: DegradedReportThrottle;
}

export function createSearchRateLimitDegradedState(
  options: { maxEntries?: number; breaker?: BreakerOptions; reportIntervalMs?: number } = {}
): SearchRateLimitDegradedState {
  return {
    store: new MemoryRateLimitStore(options.maxEntries),
    breaker: new SearchRateLimitBreaker(options.breaker),
    reportThrottle: new DegradedReportThrottle(options.reportIntervalMs),
  };
}

/** The one instance-wide state the route uses. Tests inject their own via the options seams. */
export const defaultSearchRateLimitDegradedState: SearchRateLimitDegradedState =
  createSearchRateLimitDegradedState();

/**
 * Test/ops hook: return this instance's shared state to a cold start — empty memory counters,
 * breaker closed, report throttle cleared. Same role as clearPostgresListingsCache().
 */
export function resetDefaultSearchRateLimitDegradedState(): void {
  defaultSearchRateLimitDegradedState.store.clear();
  defaultSearchRateLimitDegradedState.breaker.reset();
  defaultSearchRateLimitDegradedState.reportThrottle.clear();
}
