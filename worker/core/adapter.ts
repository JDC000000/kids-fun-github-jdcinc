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
  /**
   * Does the SOURCE say a parent must register/book in advance to attend?
   *
   * DELIBERATELY TRI-STATE, and the third state is the whole point:
   *   `true`      — the source asserts registration/booking is required.
   *   `false`     — the source asserts it is NOT: turn up, no booking. A POSITIVE claim.
   *   `undefined` — the source says nothing. Not "drop-in", not "course" — unknown.
   *
   * A boolean defaulting to `false` would have manufactured a drop-in assertion for the
   * five families that publish no registration signal at all, which is the exact failure
   * docs/kids-fun-dropin-vs-registration-investigation.md was written about: the pipeline
   * believed it had ingested 100% drop-in content while the vendors' own drop-in calendars
   * carried courses. Silence has to stay legible as silence, so `false` is only ever
   * emitted where the source really does distinguish the two.
   *
   * Populated today by `library` (BiblioCommons' structured registrationInfo) and
   * `perfectmind` (drop-in category + BookingType, with a per-record REGISTER override).
   * Sparse by design; consumers MUST treat `undefined` as normal and fall back to
   * lib/search/filters/registration.ts's title heuristic, which is what a row without this
   * field still gets.
   *
   * NOT a capacity signal — this says whether booking is REQUIRED, never whether a spot is
   * left. See supabase/migrations/0027_occurrence_registration_required.sql for why
   * full/waitlist is deliberately a separate, later change.
   */
  registrationRequired?: boolean;
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
