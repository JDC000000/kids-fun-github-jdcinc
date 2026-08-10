// lib/search/ttl-cache.ts — the one implementation of the short in-process TTL cache that the
// three DB-backed search loaders (listing read model, alias resolver, region hierarchy) share.
//
// WHY THIS MODULE EXISTS RATHER THAN THREE COPIES
// The three caches were written independently to the same shape, and each independently carried
// the same two defects. Both are fixed once here:
//
//   1. `Number('')` is 0. A var that is SET BUT EMPTY — trivially produced by a Vercel env entry
//      saved blank, or `KIDS_FUN_LISTING_CACHE_MS=` in a .env — parsed to 0 and passed the old
//      `>= 0` guard, disabling the cache with no error and no log. A silent latency regression
//      nobody would think to look for. Now a blank/whitespace/non-numeric/negative value falls
//      back to the DEFAULT and warns. An explicit `0` still means "disabled" — that is a real
//      operator switch the DB-backed suites depend on.
//   2. Only the RESOLVED value was cached, so N concurrent cold callers each ran a full load.
//      Measured: 20 concurrent cold callers → 20 full catalogue loads. All three caches are
//      awaited in the same `Promise.all` in app/api/search/route.ts, so a cold burst of N
//      requests issued ~3N loads, N of them the expensive 8-join catalogue scan. Worst exactly
//      when it hurts most: at deploy, at scale-out, and at every TTL rollover under load.
//      Caching the in-flight PROMISE collapses that to one load per TTL window.
//
// A REJECTED load is never left in the cache. Caching a rejected promise would turn one transient
// DB blip into a full TTL window of guaranteed 5xx.

/** Env vars already warned about, keyed by `VAR=value`, so a bad value logs once and not per request. */
const warnedFor = new Set<string>();

/**
 * Parse a TTL from the environment, falling back to `defaultMs` for anything that is not a
 * deliberate, usable number.
 *
 * Unset → default, silently (the overwhelmingly common case).
 * Blank, whitespace, non-numeric or negative → default, with a one-time warning so the
 * misconfiguration is diagnosable instead of invisible.
 * `0` → 0, meaning caching disabled. Deliberate and supported.
 */
export function resolveCacheTtlMs(envVar: string, defaultMs: number): number {
  const raw = process.env[envVar];
  if (raw === undefined) return defaultMs;

  const trimmed = raw.trim();
  const parsed = trimmed === '' ? Number.NaN : Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) {
    const key = `${envVar}=${raw}`;
    if (!warnedFor.has(key)) {
      warnedFor.add(key);
      console.warn(
        `[search-cache] ${envVar} is set to ${JSON.stringify(raw)}, which is not a non-negative number. ` +
          `Falling back to the ${defaultMs}ms default. Set it to 0 to disable caching deliberately.`
      );
    }
    return defaultMs;
  }
  return parsed;
}

/** Test-only hook: forget which bad env values have already been warned about. */
export function resetCacheTtlWarnings(): void {
  warnedFor.clear();
}

interface CacheEntry<T> {
  /** The in-flight or settled load. Cached as a PROMISE so concurrent cold callers share one load. */
  value: Promise<T>;
  loadedAt: number;
}

/**
 * A single-slot, time-bounded, stampede-safe cache over one expensive async load.
 *
 * Single-slot is the whole point: each of these caches holds exactly one population — "the entire
 * visible catalogue", "the alias dictionary", "the region hierarchy" — keyed on nothing but time.
 * There is no key because there is nothing to key on.
 */
export class TtlPromiseCache<T> {
  private entry: CacheEntry<T> | null = null;

  /**
   * @param envVar    env var that overrides the TTL (`0` disables caching entirely)
   * @param defaultMs TTL used when `envVar` is unset or unusable
   */
  constructor(
    private readonly envVar: string,
    private readonly defaultMs: number
  ) {}

  /**
   * Return the cached value if it is inside the TTL window, otherwise run `load` and cache the
   * in-flight promise so concurrent callers join it rather than each starting their own.
   */
  async get(load: () => Promise<T>, now: number): Promise<T> {
    const ttl = resolveCacheTtlMs(this.envVar, this.defaultMs);
    if (ttl <= 0) {
      // Caching disabled: load fresh AND do not write, so a previously cached value can never be
      // served after an operator turns the cache off.
      this.entry = null;
      return load();
    }
    if (this.entry && now - this.entry.loadedAt < ttl) return this.entry.value;

    const entry: CacheEntry<T> = { value: load(), loadedAt: now };
    this.entry = entry;
    // Evict on failure so one transient error does not poison the whole TTL window. The `catch`
    // handler is a side branch — the caller still receives (and must handle) the rejection.
    entry.value.catch(() => {
      if (this.entry === entry) this.entry = null;
    });
    return entry.value;
  }

  /** Test/ops hook: drop the cached value so the next access reloads. */
  clear(): void {
    this.entry = null;
  }
}
