// worker/core/adapter.ts — G-T5-1: adapter interface + type contract (TSD §5.1, §5.2).
// D at the edges (fetch/dedup/upsert/provenance/cadence), P at the ambiguous
// middle (age wording, free-text category, duplicate adjudication). Every
// concrete adapter (Adapter A/B/C/D/E/F, worker/adapters/*) implements this
// same shape — normalizeHook is where the deterministic-first / LLM-fallback
// boundary from §5.2 plugs in; adapters whose source is fully structured can
// omit it entirely.

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
export interface AdapterRunDiagnostics {
  /** Machine-readable code, e.g. 'ok' | 'yield_collapse' | 'shape_drift'. */
  code: string;
  /** True when this must fail/degrade the run rather than pass quietly. */
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
