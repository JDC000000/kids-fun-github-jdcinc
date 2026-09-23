// lib/search/shared-catalogue-cache.ts — the shared, version-gated catalogue cache behind
// `getCachedPostgresListings` (egress Thread 3, Options B + C, 2026-09-23).
//
// ═══ WHY THIS EXISTS ═══
// The visible catalogue is one un-LIMITed query (~11.5k rows, ~8.4MB on the wire, no compression
// on the Postgres protocol), and before this every Vercel instance loaded it independently on every
// cold start and every TTL expiry. That one query was >= 98% of the database's egress bill. Yet the
// catalogue's CONTENT barely moves: 0 of 12,019 rows changed in a measured 12-minute window with a
// crawl running. Almost every reload re-shipped identical bytes. Full evidence and the rejected
// alternatives: documents/kids-fun-egress/egress-root-cause-solution-plan-2026-09-23.md.
//
// ═══ HOW IT WORKS ═══
// Two things are shared across instances through a `SharedCatalogueStore` (Vercel's Data Cache via
// `unstable_cache` in production — ./next-data-cache-store.ts):
//   1. VERSION PROBE. A content hash of the catalogue, computed INSIDE Postgres (~100 bytes back),
//      recomputed at most once per probe interval. It excludes `last_checked_at` (every crawl bumps
//      it) and uses a fixed visibility cut-off (the start of the current freshness epoch) instead of
//      `now()` — without both, the hash changes constantly and gates nothing (measured).
//   2. SNAPSHOT. The catalogue, brotli-compressed (./catalogue-snapshot.ts), stored under
//      (version, epoch). Whichever instance first misses it loads Postgres once and publishes it;
//      every other instance, cold start or not, reads it from the store instead of the database.
// Each instance also keeps the decoded snapshot in memory and re-checks the shared version at most
// once per probe interval, so a warm instance's steady state costs nothing at all.
//
// ═══ STALENESS — WHAT THIS TRADES, STATED SO IT CAN BE JUDGED ═══
//   · CONTENT (a new, edited, hidden, cancelled or archived listing): reaches every surface within
//     about TWO probe intervals — the shared probe is recomputed once per interval, and an instance
//     re-reads it once per interval. At the 5-minute default that is ~10 minutes: the same budget
//     Option A's 10-minute TTL already spent, and Jon approved.
//   · ENDED OCCURRENCES: none. The snapshot is pruned against each call's own clock (see
//     `visibleAt` below), so an occurrence leaves the list the moment it ends — tighter than the
//     plain TTL cache, which kept ended rows for up to one TTL.
//   · `last_checked_at` ("checked X ago") and the `official_recent` confidence label computed from
//     it: up to one freshness floor (60 minutes by default) plus at most one probe interval of
//     per-instance jitter (below). Every snapshot is keyed to a floor EPOCH, so no snapshot outlives
//     its epoch; this is the backstop that keeps day-scale recency honest when content never changes.
//
// ═══ WHY EACH INSTANCE CROSSES AN EPOCH BOUNDARY AT A DIFFERENT MOMENT ═══
// There is no cross-instance lock in the store: two instances that miss the same key at the same
// time each load Postgres. If every instance changed epoch at the top of the hour, every instance
// active at that moment would miss together — one full load PER INSTANCE per hour, the per-instance
// pattern this module exists to remove. So each instance shifts its epoch boundaries by a fixed
// random offset in [0, probe interval): the earliest instance loads and publishes, and the rest
// arrive seconds-to-minutes later and find the snapshot already there. (Version changes need no
// such help: instances re-read the shared probe on their own request-driven schedules, which are
// already spread out.)
//
// ═══ WHY THE ENGINE CANNOT BE LEFT TO DROP ENDED EVENTS (verified 2026-09-23) ═══
// The design assumed "the engine drops ended events per request". It does not. With no date
// filter, `passesAllFilters` (lib/search/filters/predicate.ts) never looks at the end time; with a
// date filter, `matchesDate` (filters/time.ts) is day-granular, so an event that ended at 10:00 still
// matches `when=today` at 20:00. `pruneEndedOccurrences` (./occurrence-visibility.ts), the exact JS
// mirror of the SQL rule, was only ever called from tests. Before this module, ended rows lingered
// for up to one TTL (the old comment's "only the last-TTL edge" was that edge, not a filter). A
// snapshot that lives for up to an hour would have made that an hour, so the pruning is done here,
// against the same mirror the SQL is already pinned to.
//
// ═══ SAFETY ═══
// Any failure on the shared path — store unavailable (e.g. outside a Next.js request), store error,
// probe error, a snapshot that is missing, corrupt, of the wrong version, too old, or too large —
// falls back to the LEGACY path, i.e. exactly the behaviour before this module (per-instance TTL
// cache over the direct load), and stays there for one probe interval before retrying. The kill
// switch `KIDS_FUN_CATALOGUE_SHARED_CACHE=off` forces the legacy path permanently. The returned
// array has the same shape, the same records and the same frozen-array contract either way.
import type { Pool } from 'pg';
import type { ListingRecord } from './types';
import { isOccurrenceVisibleAt } from './occurrence-visibility';
import {
  CatalogueSnapshotError,
  SNAPSHOT_FORMAT,
  decodeCatalogueSnapshot,
  encodeCatalogueSnapshot,
  type EncodedCatalogueSnapshot,
} from './catalogue-snapshot';
import { resolveIntervalMs } from './ttl-cache';

// ── Configuration ────────────────────────────────────────────────────────────────────────────

/** Kill switch. Unset or `on` → shared cache on; `off` → the pre-existing direct-load path. */
export const SHARED_CACHE_ENV = 'KIDS_FUN_CATALOGUE_SHARED_CACHE';
export const PROBE_INTERVAL_ENV = 'KIDS_FUN_CATALOGUE_PROBE_MS';
export const FRESHNESS_FLOOR_ENV = 'KIDS_FUN_CATALOGUE_FRESHNESS_FLOOR_MS';

/** 5 minutes: content staleness of ~2 intervals ≈ the 10 minutes already approved for Option A. */
export const CATALOGUE_PROBE_DEFAULT_MS = 5 * 60_000;
/** Every probe is a catalogue-sized query of database CPU; below 30s that stops being a probe. */
export const CATALOGUE_PROBE_MIN_MS = 30_000;
export const CATALOGUE_FLOOR_DEFAULT_MS = 60 * 60_000;
export const CATALOGUE_FLOOR_MIN_MS = 60_000;

/**
 * How far instance clocks may disagree before a snapshot's age is treated as impossible. The epoch
 * key already bounds that age (see the check in `doRefresh`); this only absorbs clock skew.
 */
const PUBLISH_CLOCK_SKEW_MS = 60_000;

const warned = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(message);
}

/**
 * Is the shared path on? Unset/`on`/`true`/`1` → yes; `off`/`false`/`0` → no. Anything else is
 * treated as OFF, with a one-time warning: this variable exists to be the safe direction in an
 * incident, so an unreadable value must resolve to the behaviour that predates the shared cache.
 */
export function sharedCatalogueCacheEnabled(): boolean {
  const raw = process.env[SHARED_CACHE_ENV];
  if (raw === undefined) return true;
  const value = raw.trim().toLowerCase();
  if (value === 'on' || value === 'true' || value === '1') return true;
  if (value === 'off' || value === 'false' || value === '0') return false;
  warnOnce(
    `${SHARED_CACHE_ENV}=${raw}`,
    `[catalogue-cache] ${SHARED_CACHE_ENV} is set to ${JSON.stringify(raw)}, which is not on/off. ` +
      `Treating it as OFF (the direct-load path).`
  );
  return false;
}

export function catalogueProbeIntervalMs(): number {
  return resolveIntervalMs(PROBE_INTERVAL_ENV, CATALOGUE_PROBE_DEFAULT_MS, CATALOGUE_PROBE_MIN_MS);
}

export function catalogueFreshnessFloorMs(): number {
  return resolveIntervalMs(FRESHNESS_FLOOR_ENV, CATALOGUE_FLOOR_DEFAULT_MS, CATALOGUE_FLOOR_MIN_MS);
}

/**
 * Namespaces every shared key to one deployment. Vercel's Data Cache outlives deployments, and a
 * snapshot is a serialised `ListingRecord[]` — a deploy that changes that shape (a new field, a
 * changed mapping in rowToListing) must never read a snapshot the previous code wrote. Also keeps
 * preview deployments (which may point at a different database) out of production's entries.
 */
function deploymentNamespace(): string {
  return (
    process.env.VERCEL_DEPLOYMENT_ID ??
    process.env.VERCEL_GIT_COMMIT_SHA ??
    process.env.VERCEL_URL ??
    'local'
  );
}

// ── Seams ────────────────────────────────────────────────────────────────────────────────────

/**
 * A cross-instance memo: return the shared value stored under `key`, running `compute` (and
 * storing its result) only when there is none, or it is older than `ttlMs`. Implementations may
 * serve a value slightly past `ttlMs` while refreshing it (Next's stale-while-revalidate); this
 * module's correctness does not depend on the exact expiry, only its staleness bounds do.
 * Must throw rather than return a wrong value.
 */
export interface SharedCatalogueStore {
  memo<T>(key: readonly string[], ttlMs: number, compute: () => Promise<T>): Promise<T>;
}

/** The pre-existing per-instance TTL cache over the direct load. The fallback, and the kill-switch path. */
export interface LegacyCatalogueCache {
  get(pool: Pool, now: number): Promise<readonly ListingRecord[]>;
  clear(): void;
}

export interface SharedCatalogueCacheDeps {
  store: SharedCatalogueStore;
  legacy: LegacyCatalogueCache;
  /** The direct catalogue load — the SAME function the legacy path uses, so both return identical records. */
  loadListings: (pool: Pool) => Promise<ListingRecord[]>;
  /** Content version of the catalogue as visible from `cutoff` onward (see probePostgresCatalogueVersion). */
  probeVersion: (pool: Pool, cutoff: Date) => Promise<string>;
  /** Source of this instance's epoch jitter (see header). Injectable so tests are deterministic. */
  random?: () => number;
}

// ── The cache ────────────────────────────────────────────────────────────────────────────────

interface VisibleView {
  /** The clock this view was pruned at. */
  at: number;
  /** The view stays exact until this instant: the earliest end among the rows it kept. */
  validThrough: number;
  listings: readonly ListingRecord[];
}

interface CurrentSnapshot {
  version: string;
  epoch: number;
  listings: readonly ListingRecord[];
  /** When this instance last confirmed `version` against the shared probe. */
  confirmedAt: number;
  view: VisibleView | null;
}

export class SharedCatalogueCache {
  private current: CurrentSnapshot | null = null;
  /** One refresh at a time per instance: concurrent cold callers join it (the ttl-cache stampede rule). */
  private refreshing: Promise<CurrentSnapshot> | null = null;
  /** After a shared-path failure, serve the legacy path until this instant. */
  private fallbackUntil = Number.NEGATIVE_INFINITY;
  private fallbackSince = Number.NEGATIVE_INFINITY;
  /** This instance's fixed position inside the probe interval, in [0, 1). See the header. */
  private readonly jitterFraction: number;

  constructor(private readonly deps: SharedCatalogueCacheDeps) {
    const r = (deps.random ?? Math.random)();
    this.jitterFraction = Number.isFinite(r) ? Math.min(Math.max(r, 0), 0.999_999) : 0;
  }

  async get(pool: Pool, now: number): Promise<readonly ListingRecord[]> {
    if (!sharedCatalogueCacheEnabled()) {
      // Kill switch: drop anything the shared path holds, so turning it back on starts clean, and
      // behave exactly as before this module existed.
      this.current = null;
      return this.deps.legacy.get(pool, now);
    }
    // `now >= fallbackSince` so a backwards clock step cannot pin the fallback indefinitely.
    if (now < this.fallbackUntil && now >= this.fallbackSince) return this.deps.legacy.get(pool, now);

    const probeMs = catalogueProbeIntervalMs();
    const floorMs = catalogueFreshnessFloorMs();
    const jitterMs = Math.floor(this.jitterFraction * Math.min(probeMs, floorMs));
    const epoch = Math.floor((now - jitterMs) / floorMs);

    const cur = this.current;
    const age = cur ? now - cur.confirmedAt : -1;
    if (cur && cur.epoch === epoch && age >= 0 && age < probeMs) return visibleAt(cur, now);

    try {
      const next = await this.refresh(pool, now, epoch, probeMs, floorMs);
      // The shared path is serving: release the legacy entry rather than hold two catalogues.
      this.deps.legacy.clear();
      return visibleAt(next, now);
    } catch (err) {
      this.current = null;
      this.fallbackSince = now;
      this.fallbackUntil = now + probeMs;
      const reason = describe(err);
      warnOnce(
        `fallback:${reason}`,
        `[catalogue-cache] shared catalogue cache unavailable (${reason}); serving the direct Postgres load ` +
          `for the next ${probeMs}ms. Further failures with this reason are not logged again by this instance.`
      );
      return this.deps.legacy.get(pool, now);
    }
  }

  /** Test/ops hook: forget the snapshot and any fallback window. */
  clear(): void {
    this.current = null;
    this.refreshing = null;
    this.fallbackUntil = Number.NEGATIVE_INFINITY;
    this.fallbackSince = Number.NEGATIVE_INFINITY;
  }

  private refresh(pool: Pool, now: number, epoch: number, probeMs: number, floorMs: number): Promise<CurrentSnapshot> {
    if (!this.refreshing) {
      const run = this.doRefresh(pool, now, epoch, probeMs, floorMs);
      this.refreshing = run;
      const release = () => {
        if (this.refreshing === run) this.refreshing = null;
      };
      run.then(release, release);
    }
    return this.refreshing;
  }

  private async doRefresh(
    pool: Pool,
    now: number,
    epoch: number,
    probeMs: number,
    floorMs: number
  ): Promise<CurrentSnapshot> {
    const { store, probeVersion } = this.deps;
    const namespace = [
      'kids-fun:catalogue',
      `format=${SNAPSHOT_FORMAT}`,
      `deploy=${deploymentNamespace()}`,
      `floor=${floorMs}`,
      `epoch=${epoch}`,
    ];
    // The cut-off is the epoch's unjittered start: constant for the whole epoch (so the hash moves
    // only when content does), and never later than any request any instance makes inside it —
    // jitter only ever moves an instance's boundary LATER — so every row a request could still see
    // is inside the hashed set.
    const cutoff = new Date(epoch * floorMs);
    const version = await store.memo([...namespace, 'version'], probeMs, () => probeVersion(pool, cutoff));
    if (typeof version !== 'string' || version.length === 0) {
      throw new CatalogueSnapshotError('catalogue version probe returned no version');
    }

    const cur = this.current;
    if (cur && cur.version === version && cur.epoch === epoch) {
      cur.confirmedAt = now;
      return cur;
    }

    // A key is in use for its epoch as seen by EVERY instance: one floor, plus the spread of
    // instance jitters (< one probe interval), plus clock skew. The store entry must live that long.
    // With only `floorMs`, a late-jittered instance cold-starting near the end of its epoch would
    // find the entry "stale", and Next's stale-while-revalidate would spend a full catalogue load
    // regenerating a key nobody will read again.
    const keyLifetimeMs = floorMs + Math.min(probeMs, floorMs) + PUBLISH_CLOCK_SKEW_MS;
    const encoded = await store.memo<EncodedCatalogueSnapshot>(
      [...namespace, 'snapshot', version],
      keyLifetimeMs,
      () => this.publish(pool, version, now)
    );
    const snapshot = await decodeCatalogueSnapshot(encoded, version);
    // Belt and braces on the floor: the epoch key already bounds a snapshot's age to its lifetime;
    // anything outside that did not come from this key's writer as designed, and is not served.
    const snapshotAge = now - snapshot.publishedAt;
    if (snapshotAge > keyLifetimeMs || snapshotAge < -PUBLISH_CLOCK_SKEW_MS) {
      throw new CatalogueSnapshotError(`snapshot published ${snapshotAge}ms ago is outside the ${keyLifetimeMs}ms bound`);
    }

    const next: CurrentSnapshot = { version, epoch, listings: snapshot.listings, confirmedAt: now, view: null };
    this.current = next;
    return next;
  }

  /** Runs only on a shared-store miss: the one full Postgres load this whole epoch/version pays for. */
  private async publish(pool: Pool, version: string, now: number): Promise<EncodedCatalogueSnapshot> {
    const startedAt = Date.now();
    const listings = await this.deps.loadListings(pool);
    const encoded = await encodeCatalogueSnapshot(listings, version, now);
    // One line per full load, so "how many catalogue loads did the shared cache still pay for" is
    // answerable from the runtime logs, not only from pg_stat_statements.
    console.info(
      `[catalogue-cache] published catalogue snapshot version=${version} rows=${encoded.count} ` +
        `bytes=${encoded.brotliBase64.length} ms=${Date.now() - startedAt}`
    );
    return encoded;
  }
}

/**
 * The snapshot as the direct load would return it at `now`: every occurrence that has ended since
 * the snapshot was loaded is dropped, by the same rule as the SQL (see occurrence-visibility.ts).
 *
 * Memoised on the next end time, so the array keeps its identity — which the matcher's per-record
 * memo and the shared-array invariant both rely on — until a row actually leaves it. When nothing
 * has ended, the snapshot array itself is returned.
 */
function visibleAt(cur: CurrentSnapshot, now: number): readonly ListingRecord[] {
  const view = cur.view;
  if (view && now >= view.at && now <= view.validThrough) return view.listings;

  const at = new Date(now);
  const kept: ListingRecord[] = [];
  let validThrough = Number.POSITIVE_INFINITY;
  for (const listing of cur.listings) {
    if (!isOccurrenceVisibleAt(listing, at)) continue;
    kept.push(listing);
    if (listing.startDatetimeUtc != null) {
      const endsAt = Date.parse(listing.endDatetimeUtc ?? listing.startDatetimeUtc);
      if (endsAt < validThrough) validThrough = endsAt;
    }
  }
  const listings = kept.length === cur.listings.length ? cur.listings : Object.freeze(kept);
  cur.view = { at: now, validThrough, listings };
  return listings;
}

/** A log-safe, bounded reason. (Next's own invariant messages embed the whole callback source.) */
function describe(err: unknown): string {
  const name = err instanceof Error ? err.name : 'Error';
  const message = err instanceof Error ? err.message : String(err);
  const firstLine = message.split('\n')[0];
  return `${name}: ${firstLine.length > 160 ? `${firstLine.slice(0, 160)}…` : firstLine}`;
}

/** Test-only hook: forget which warnings have been logged. */
export function resetSharedCatalogueCacheWarnings(): void {
  warned.clear();
}
