// lib/search/catalogue-snapshot.ts — the wire format of the SHARED catalogue snapshot.
//
// The shared catalogue cache (./shared-catalogue-cache.ts) hands the whole visible catalogue from
// the one instance that loaded it out of Postgres to every other instance, through a cross-instance
// store (Vercel's Data Cache in production). This module is only the encoding: ListingRecord[] in,
// a small JSON-safe object out, and back again — with every check a reader needs before it trusts
// what came out of a store it does not control.
//
// WHY BROTLI, AND WHY BASE64 AROUND IT
// The catalogue is ~13MB as JSON; Vercel's Data Cache rejects items over 2MB. Brotli at the quality
// chosen below takes the real catalogue to ~0.64MB. `unstable_cache` stores its value with
// JSON.stringify, so the bytes travel as base64 (x4/3, ~0.86MB): well inside the limit, and the
// limit is enforced below rather than assumed.
//
// WHY THE READER VALIDATES SO MUCH
// A snapshot that decodes to the wrong thing is worse than no snapshot: it would be served to every
// surface for up to an hour. So `decodeCatalogueSnapshot` rejects anything it cannot fully account
// for — wrong format, wrong version, a row count that disagrees with the rows, a record without an
// id — and the caller treats a rejection exactly like an unavailable store: it falls back to the
// direct Postgres load.
import { brotliCompress, brotliDecompress, constants as zlibConstants } from 'node:zlib';
import { promisify } from 'node:util';
import type { ListingRecord } from './types';

const compress = promisify(brotliCompress);
const decompress = promisify(brotliDecompress);

/** Bump when the ENCODING changes. (A change to ListingRecord's shape is covered by the deployment id in the store key.) */
export const SNAPSHOT_FORMAT = 1;

/**
 * Largest base64 payload this module will write or read, in characters (= bytes on the wire).
 * Vercel's Data Cache limit is 2MB per item, and the stored item also carries the JSON envelope;
 * 1.8MB leaves room for it. At today's ~0.86MB the catalogue can grow ~2x before this trips —
 * and when it does, the cache falls back to the direct load and says so, rather than failing.
 */
export const MAX_SNAPSHOT_BASE64_CHARS = 1_800_000;

/**
 * Quality 5 of 11, chosen by measurement on the real catalogue (11,556 records, 12.9MB of JSON,
 * 2026-09-23): q5 → 641KB (855KB base64) in 112ms; q9 → 626KB in 295ms; q11 → 564KB in 15.6s.
 * Decoding is ~12ms at every quality. An encode runs on a request path (whichever request first
 * misses the shared store), so q11's 15-second encode would land on a real parent's page load for
 * a 12% smaller item that is nowhere near the size limit either way.
 */
const BROTLI_QUALITY = 5;

/** Guard against a corrupt or hostile payload inflating without bound (today's catalogue: ~13MB). */
const MAX_DECODED_BYTES = 256 * 1024 * 1024;

/** What the shared store holds: JSON-safe, so it survives `unstable_cache`'s JSON.stringify. */
export interface EncodedCatalogueSnapshot {
  format: number;
  /** The catalogue content version this snapshot was published under (the probe's hash). */
  version: string;
  /** Epoch ms at which the rows were loaded from Postgres. */
  publishedAt: number;
  count: number;
  brotliBase64: string;
}

export interface CatalogueSnapshot {
  version: string;
  publishedAt: number;
  /** Frozen, exactly as `getCachedPostgresListings` has always returned it. */
  listings: readonly ListingRecord[];
}

/** A snapshot that must not be written or served. The caller falls back to the direct load. */
export class CatalogueSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogueSnapshotError';
  }
}

export async function encodeCatalogueSnapshot(
  listings: readonly ListingRecord[],
  version: string,
  publishedAt: number
): Promise<EncodedCatalogueSnapshot> {
  assertJsonExact(listings);
  const json = Buffer.from(JSON.stringify(listings), 'utf8');
  const packed = await compress(json, {
    params: {
      [zlibConstants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
      [zlibConstants.BROTLI_PARAM_MODE]: zlibConstants.BROTLI_MODE_TEXT,
      [zlibConstants.BROTLI_PARAM_SIZE_HINT]: json.length,
    },
  });
  const brotliBase64 = packed.toString('base64');
  if (brotliBase64.length > MAX_SNAPSHOT_BASE64_CHARS) {
    // Thrown BEFORE the value is returned to the store, so an oversize snapshot is never cached.
    throw new CatalogueSnapshotError(
      `catalogue snapshot is ${brotliBase64.length} base64 chars (${listings.length} rows, ${json.length} JSON bytes), ` +
        `over the ${MAX_SNAPSHOT_BASE64_CHARS} limit`
    );
  }
  return { format: SNAPSHOT_FORMAT, version, publishedAt, count: listings.length, brotliBase64 };
}

/**
 * Refuse to publish anything JSON would not round-trip EXACTLY.
 *
 * JSON silently rewrites a few values: an `undefined` property disappears (the record loses a
 * key), NaN and ±Infinity become null, -0 becomes 0, and a Date becomes a string. Any of those
 * would make the snapshot's records differ from the direct load's — quietly, on every surface, for
 * up to an hour. `rowToListing` produces none of them today (every column is always selected, and
 * every number is finite-checked or an integer); this makes that a checked fact at the one place it
 * matters instead of an assumption about code that will keep changing. Found, not hypothesised:
 * replaying a real catalogue pull whose SQL predated the `venue_address` column produced
 * `venueAddress: undefined` on every record, and a snapshot that lost the key.
 *
 * Runs only when a snapshot is published (a few dozen times a day), over ~400k values: ~40ms.
 */
function assertJsonExact(value: unknown, path = 'listings'): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new CatalogueSnapshotError(`${path} is ${String(value)}, which JSON cannot carry exactly`);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) assertJsonExact(value[i], `${path}[${i}]`);
    return;
  }
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    for (const key of Object.keys(value)) assertJsonExact((value as Record<string, unknown>)[key], `${path}.${key}`);
    return;
  }
  throw new CatalogueSnapshotError(`${path} is a ${typeof value === 'object' ? 'non-plain object' : typeof value}, which JSON cannot carry exactly`);
}

/**
 * Decode and verify a value read back from the shared store. Throws `CatalogueSnapshotError` for
 * anything that is not a complete, well-formed snapshot of `expectedVersion`.
 */
export async function decodeCatalogueSnapshot(
  value: unknown,
  expectedVersion: string
): Promise<CatalogueSnapshot> {
  if (value == null || typeof value !== 'object') throw new CatalogueSnapshotError('snapshot is not an object');
  const v = value as Partial<EncodedCatalogueSnapshot>;
  if (v.format !== SNAPSHOT_FORMAT) throw new CatalogueSnapshotError(`unknown snapshot format ${String(v.format)}`);
  if (v.version !== expectedVersion) {
    throw new CatalogueSnapshotError(`snapshot version ${String(v.version)} is not the requested ${expectedVersion}`);
  }
  if (typeof v.publishedAt !== 'number' || !Number.isFinite(v.publishedAt)) {
    throw new CatalogueSnapshotError('snapshot has no publishedAt');
  }
  if (typeof v.count !== 'number' || !Number.isInteger(v.count) || v.count < 0) {
    throw new CatalogueSnapshotError('snapshot has no row count');
  }
  if (typeof v.brotliBase64 !== 'string' || v.brotliBase64.length > MAX_SNAPSHOT_BASE64_CHARS) {
    throw new CatalogueSnapshotError('snapshot payload is missing or oversize');
  }

  let listings: unknown;
  try {
    const json = await decompress(Buffer.from(v.brotliBase64, 'base64'), { maxOutputLength: MAX_DECODED_BYTES });
    listings = JSON.parse(json.toString('utf8'));
  } catch (err) {
    throw new CatalogueSnapshotError(`snapshot payload does not decode: ${(err as Error).message}`);
  }
  if (!Array.isArray(listings)) throw new CatalogueSnapshotError('snapshot payload is not an array');
  if (listings.length !== v.count) {
    throw new CatalogueSnapshotError(`snapshot holds ${listings.length} rows but declares ${v.count}`);
  }
  for (const record of listings) {
    if (record == null || typeof record !== 'object' || typeof (record as ListingRecord).id !== 'string') {
      throw new CatalogueSnapshotError('snapshot holds a record without an id');
    }
  }
  return {
    version: v.version,
    publishedAt: v.publishedAt,
    listings: Object.freeze(listings as ListingRecord[]),
  };
}
