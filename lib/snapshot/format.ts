// lib/snapshot/format.ts — the on-disk snapshot format, and the schema fingerprint that
// makes a snapshot refuse to load into the wrong schema.
//
// FORMAT: one gzipped NDJSON file per table, plus a manifest.json.
//
// EVERY VALUE IS A STRING OR null. Not "JSON-typed" — deliberately. The export casts every
// column to text in SQL (`col::text`) and the loader hands that text straight back as a query
// parameter. Postgres's text I/O representation is the one encoding guaranteed to round-trip
// every type in this schema exactly, and going through JSON types instead would quietly
// destroy precisely the columns this snapshot exists to protect:
//   • timestamptz → a JS Date is millisecond-precision; production timestamps are microsecond.
//   • numeric(10,2) → a JS number is a float; cost_min_cad would drift in the last cent.
//   • geography → node-postgres has no codec; it would arrive as an opaque string anyway.
//   • interval, uuid[], jsonb → each needs a bespoke encoder, each a place to introduce drift.
// One rule ("text in, text out") replaces five codecs and cannot silently round anything.

import { createHash } from 'node:crypto';

export const SNAPSHOT_FORMAT_VERSION = 2;

/** A row as it appears in an NDJSON file: column → Postgres text representation, or null. */
export type SnapshotRow = Record<string, string | null>;

export interface ColumnFingerprint {
  name: string;
  /** format_type() output, e.g. `timestamp with time zone`, `numeric(10,2)`, `uuid[]`. */
  type: string;
  notNull: boolean;
}

/**
 * What the source database's schema looked like when the snapshot was taken. The loader
 * compares this against the target and refuses a mismatch: loading rows shaped for schema A
 * into schema B produces a green test run that proves nothing.
 */
export interface SchemaFingerprint {
  /** supabase/migrations ledger: every applied version and its checksum, ordered. */
  migrations: { version: string; checksum: string | null }[];
  /** Allowlisted tables only — the fingerprint covers what we export, not the whole database. */
  tables: Record<string, ColumnFingerprint[]>;
}

export interface TableManifestEntry {
  table: string;
  file: string;
  rows: number;
  /** sha256 of the gzipped file as written. */
  sha256: string;
  bytes: number;
  /** Scrub rule → substitutions made across the whole table. Counts only, never content. */
  redactions: Record<string, number>;
}

export interface SnapshotManifest {
  formatVersion: number;
  /** Operator-supplied label, e.g. "production". Never a connection string. */
  label: string;
  createdAt: string;
  /** Digest of lib/snapshot/policy.ts's allowlist + actions at export time. */
  policyFingerprint: string;
  schema: SchemaFingerprint;
  tables: TableManifestEntry[];
  totals: { rows: number; bytes: number };
}

export function sha256(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** Deterministic NDJSON line: keys emitted in the caller's column order, not object order. */
export function encodeRow(columns: string[], row: SnapshotRow): string {
  const ordered: SnapshotRow = {};
  for (const c of columns) ordered[c] = row[c] ?? null;
  return JSON.stringify(ordered);
}

export function decodeRow(line: string): SnapshotRow {
  const parsed: unknown = JSON.parse(line);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('snapshot row is not a JSON object');
  }
  const out: SnapshotRow = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (v === null) out[k] = null;
    else if (typeof v === 'string') out[k] = v;
    else throw new Error(`snapshot column "${k}" is ${typeof v}; every value must be a string or null`);
  }
  return out;
}

/** Stable, human-diffable rendering of a fingerprint — used to explain a mismatch. */
export function describeSchemaDiff(expected: SchemaFingerprint, actual: SchemaFingerprint): string[] {
  const problems: string[] = [];

  const expVersions = expected.migrations.map((m) => m.version);
  const actVersions = actual.migrations.map((m) => m.version);
  for (const v of expVersions) {
    if (!actVersions.includes(v)) problems.push(`migration ${v} was applied when the snapshot was taken but is missing here`);
  }
  for (const v of actVersions) {
    if (!expVersions.includes(v)) problems.push(`migration ${v} is applied here but was not when the snapshot was taken`);
  }

  for (const [table, cols] of Object.entries(expected.tables)) {
    const here = actual.tables[table];
    if (!here) {
      problems.push(`table ${table} is missing here`);
      continue;
    }
    const byName = new Map(here.map((c) => [c.name, c]));
    for (const c of cols) {
      const h = byName.get(c.name);
      if (!h) problems.push(`${table}.${c.name} is missing here`);
      else if (h.type !== c.type) problems.push(`${table}.${c.name} is ${h.type} here, was ${c.type} in the snapshot`);
      else if (h.notNull !== c.notNull)
        problems.push(`${table}.${c.name} nullability differs (snapshot notNull=${c.notNull}, here notNull=${h.notNull})`);
    }
    for (const h of here) {
      if (!cols.some((c) => c.name === h.name)) problems.push(`${table}.${h.name} exists here but not in the snapshot`);
    }
  }
  return problems;
}
