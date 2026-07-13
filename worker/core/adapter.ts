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
  /** Captured payload slice for contract-test fixtures + breakage debugging. */
  raw?: unknown;
}

export interface DedupKey {
  /** Stable key (normalised title+venue+time+URL) used by T14's merge pass. */
  key: string;
}

export interface Adapter {
  /** Unique adapter id — matches `source.family` in the DB (e.g. 'activenet'). */
  readonly family: string;

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
