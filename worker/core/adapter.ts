// worker/core/adapter.ts — G-T5-1: adapter interface + type contract (TSD §5.1, §5.2).
// D at the edges (fetch/dedup/upsert/provenance/cadence), P at the ambiguous
// middle (age wording, free-text category, duplicate adjudication). Every
// concrete adapter (Adapter A/B/C/D/E/F, worker/adapters/*) implements this
// same shape — normalizeHook is where the deterministic-first / LLM-fallback
// boundary from §5.2 plugs in; adapters whose source is fully structured can
// omit it entirely.
import type { VenueGeoAuthority } from './venue-geo-authority';

export interface StructuredRecord {
  /** Raw source-native id/slug used to build dedup keys — not the DB row id. */
  sourceRecordId: string;
  title: string;
  venueName?: string;
  venueAddress?: string;
  /**
   * Public contact number for the venue, exactly as the source published it (trimmed,
   * never reformatted — see supabase/migrations/0024_venue_phone.sql for why the
   * canonicalisation decision is deferred to a display layer that does not exist yet).
   * Sparse by design: only the `activenet` family populates it today.
   */
  venuePhone?: string;
  venueLat?: number;
  venueLng?: number;
  /**
   * Where this record's coordinate ranks against the other seven producers that can write
   * the same `venue.geo` column. MANDATORY whenever venueLat/venueLng are set — ingest
   * throws, naming the venue, rather than defaulting, and
   * tests/compliance/venue-geo-authority-declared.test.ts fails the build if an adapter
   * emits a coordinate without one. Declared PER RECORD, not per adapter, because two
   * producers genuinely vary within themselves: activenet's table mixes licensed open-data
   * points with hand-placed ones, and library's BiblioCommons path takes the feed's own
   * `bc:latitude` when it has one and falls back to the curated branch table when it does
   * not. See worker/core/venue-geo-authority.ts.
   */
  venueGeoAuthority?: VenueGeoAuthority;
  /** Stable identifier for where the coordinate came from, e.g. 'activenet:opendata-vancouver'. */
  venueGeoSource?: string;
  /** Licence-notice key the coordinate obliges us to publish ('ogl-vancouver', 'osm-odbl'). */
  venueGeoAttribution?: string;
  venueMunicipalityName?: string;
  venueDisplayArea?: string;
  startDatetimeUtc?: string; // ISO 8601; absent for open-hours records
  endDatetimeUtc?: string;
  openHoursState?: string;
  costMinCad?: number;
  costMaxCad?: number;
  costStatus?: 'known' | 'free' | 'unknown' | 'check_source';
  ageText?: string; // raw free-text age wording — ambiguous, resolved by normalizeHook / T13
  categoryHint?: string;
  sourceUrl: string;
  bookingUrl?: string;
  locationUrl?: string;
  /** Captured payload slice for contract-test fixtures + breakage debugging. */
  raw?: unknown;
}

export interface DedupKey {
  /** Stable key (normalised title+venue+time+URL) used by T14's merge pass. */
  key: string;
}

/**
 * An adapter's own verdict on the run it just completed. Exists because a run over a
 * brittle, unofficial source can SUCCEED and still be broken: the vendor moves a key,
 * the parser yields nothing, and the check run reports a cheerful green over an empty
 * municipality. Only the adapter knows enough to spot that, so it reports it and the
 * ingest runner folds it into the check-run status.
 */
/**
 * An adapter's verdict on the run it just performed.
 *
 * NO `status` FIELD, DELIBERATELY (F-11 decision, 2026-08-02 — read before adding one).
 * Adapters' own verdict types (ActiveNetHealthVerdict, PerfectMindHealthVerdict, …) do carry
 * a `status`, and it is dropped here on purpose rather than by oversight:
 *
 *   1. A run status cannot carry this signal even if we plumbed it through. ingestSource
 *      already derives 'partial' from "some records errored but at least one upserted" — a
 *      cause with nothing to do with health. An adapter-supplied 'partial' would land in the
 *      same bucket as "3 of 900 records had a bad date", so no reader could tell a deliberate
 *      degrade from ordinary per-record noise. Adding a second producer of an ambiguous value
 *      does not create a discriminator.
 *   2. `status` is a DB CHECK enum ('running','success','partial','failed') read by roughly
 *      eight queries across worker/ and lib/ (baseline sampling, last-success laterals, SLA
 *      counts, dashboard laterals, the last_check_at stamp). Widening it is a large blast
 *      radius for no added signal.
 *   3. `alert` is ALREADY the exact boolean an operator needs — "a human should look at this
 *      run" — and every code that fires computes it correctly. Its only defect was that it
 *      was flattened into prose inside the generic `errors` array, unreachable from SQL.
 *
 * So the fix was to persist `alert` as a first-class fact (source_check_run.health_alert_code,
 * migration 0026), not to give adapters a status vocabulary. If a future adapter genuinely
 * needs to force a run to 'failed', that is a separate, deliberate change to ingestSource's
 * status derivation — not a field quietly re-added here.
 */
export interface AdapterRunDiagnostics {
  /** Machine-readable code, e.g. 'ok' | 'yield_collapse' | 'shape_drift'. */
  code: string;
  /**
   * True when a human must look at this run rather than let it pass quietly. Persisted to
   * source_check_run.health_alert_code, which is what the admin attention panel and both
   * SLA success-ratio paths key off.
   */
  alert: boolean;
  /** One line, human-readable, for the health board. */
  detail: string;
}

export interface Adapter {
  /** Unique adapter id — matches `source.family` in the DB (e.g. 'activenet'). */
  readonly family: string;

  /** True only when fetch() will perform an external live network/render request. */
  isLiveFetchEnabled?(): boolean;

  /** (D) Fetch raw payload(s) from the source. */
  fetch(): Promise<unknown[]>;

  /** (D) Parse raw payload into structured records. */
  extract(raw: unknown[]): Promise<StructuredRecord[]> | StructuredRecord[];

  /**
   * (P, optional) Normalise fields extract() couldn't resolve deterministically
   * (free-text age -> months, free-text -> category/tags). Deterministic-first:
   * only call this when the source doesn't expose structured data (§5.2).
   */
  normalizeHook?(record: StructuredRecord): Promise<StructuredRecord> | StructuredRecord;

  /**
   * (D, optional) Self-assess the run just extracted, given the source's trailing
   * record-count baseline (null on a first run). Adapters over official, stable feeds
   * can omit it; adapters over undocumented, unversioned surfaces implement it so a
   * yield collapse or a payload-shape change fails loudly instead of degrading in
   * silence. Called by ingestSource AFTER extract().
   */
  assessRun?(baselineRecordsFound: number | null): AdapterRunDiagnostics | null;

  /** (D) Build a stable dedup key for a structured record. */
  dedupKeys(record: StructuredRecord): DedupKey;
}

/** Reference implementation — proves the interface is satisfiable end-to-end
 *  and gives G-T5-4/5-6 a fixture adapter to exercise the pipeline with. */
export class NoopAdapter implements Adapter {
  readonly family = 'noop';

  async fetch(): Promise<unknown[]> {
    return [{ id: 'noop-fixture-1' }];
  }

  extract(raw: unknown[]): StructuredRecord[] {
    return raw.map((_, i) => ({
      sourceRecordId: `noop-${i}`,
      title: 'Noop Fixture Occurrence',
      startDatetimeUtc: new Date().toISOString(),
      costStatus: 'unknown' as const,
      sourceUrl: 'https://example.org/noop',
    }));
  }

  dedupKeys(record: StructuredRecord): DedupKey {
    return { key: `noop::${record.sourceRecordId}` };
  }
}
