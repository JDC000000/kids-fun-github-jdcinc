// scripts/snapshot/export.ts — produce an anonymised catalogue snapshot from a real database.
//
// ⚠️  THE OPERATOR RUNS THIS, NOT CI. See docs/prod-snapshot-runbook.md.
//     The CI e2e lane deliberately holds no production secret and this tool does not change
//     that: it is a standalone operator utility that takes its connection string from the
//     environment and never writes one anywhere.
//
// GUARANTEES
//   · READ-ONLY. The connection is opened READ ONLY at the session level and every statement
//     runs inside a single `REPEATABLE READ, READ ONLY` transaction — so the snapshot is also
//     point-in-time consistent (a venue and the occurrences referencing it are from the same
//     instant, and FK integrity survives the round trip).
//   · DENY-BY-DEFAULT. Only tables in SNAPSHOT_TABLES are read, and only columns with an
//     explicit policy entry. If a migration has added an unclassified column to an allowlisted
//     table, the schema guard aborts the run BEFORE the first SELECT.
//   · SCRUB BEFORE DISK. Every row is transformed in memory as it streams; a raw value never
//     reaches a file. The `search_tsv` index of the pre-scrub description is not exported at
//     all — the target rebuilds it from the scrubbed text.
//   · NO SECRETS ANYWHERE. The connection string is read from KF_SNAPSHOT_SOURCE_URL, is never
//     printed, never logged, and is not written into the manifest. Progress output names the
//     table and the row count and nothing else.
//
// WHY KF_SNAPSHOT_SOURCE_URL AND NOT DATABASE_URL
// Same reasoning as scripts/search-cap-probe.ts: lib/testing/local-db-guard.ts refuses a
// non-local DATABASE_URL, and no tool should ever be the reason somebody sets
// KIDS_FUN_ALLOW_NONLOCAL_DB=1 and then leaves it set.
//
// USAGE
//   KF_SNAPSHOT_SOURCE_URL='postgres://…' bash scripts/snapshot/export.sh --label production
//     --label NAME   stamped into the manifest (default: "unlabelled")
//     --out DIR      output directory (default: .snapshots/<label>-<timestamp>)
//     --batch N      keyset page size (default 5000)
import { createGzip } from 'node:zlib';
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { Client } from 'pg';
import { SNAPSHOT_TABLES, exportedColumns, policyFingerprint, type TablePolicy } from '../../lib/snapshot/policy';
import { runSchemaGuard } from '../../lib/snapshot/schema-guard';
import { safeErrorMessage } from '../../lib/snapshot/safe-error';
import { selectListSql, transformRow, mergeTally, type RedactionTally } from '../../lib/snapshot/transform';
import {
  SNAPSHOT_FORMAT_VERSION,
  encodeRow,
  sha256,
  type SnapshotManifest,
  type SnapshotRow,
  type TableManifestEntry,
} from '../../lib/snapshot/format';

function argValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function fail(message: string): never {
  console.error(`\n✖ ${message}\n`);
  process.exit(2);
}

/** Rows for one table, in key order, pulled by keyset pagination so memory stays bounded. */
async function* streamTable(
  client: Client,
  policy: TablePolicy,
  batch: number
): AsyncGenerator<SnapshotRow[], void, unknown> {
  const cols = selectListSql(policy);
  let after: string | null = null;

  for (;;) {
    // Explicitly typed: `after` is reassigned from `rows` further down, so an inferred type here
    // is circular and tsc reports TS7022 rather than resolving it.
    const sql: string =
      after === null
        ? `SELECT ${cols} FROM "${policy.table}" ORDER BY "${policy.key}" LIMIT ${batch}`
        : `SELECT ${cols} FROM "${policy.table}" WHERE "${policy.key}" > $1 ORDER BY "${policy.key}" LIMIT ${batch}`;
    const rows: SnapshotRow[] = (await client.query<SnapshotRow>(sql, after === null ? [] : [after])).rows;
    if (rows.length === 0) return;
    yield rows;
    const last: string | null = rows[rows.length - 1][policy.key];
    if (last === null) {
      // Unreachable for a primary key, but a null key would loop forever — say so loudly.
      fail(`${policy.table}: key column "${policy.key}" contained NULL; cannot paginate deterministically.`);
    }
    after = last;
    if (rows.length < batch) return;
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const connectionString = process.env.KF_SNAPSHOT_SOURCE_URL;
  if (!connectionString) {
    fail(
      'KF_SNAPSHOT_SOURCE_URL is not set.\n' +
        '  Set it to the connection string of the database to snapshot (read-only role is enough —\n' +
        '  and is what docs/prod-snapshot-runbook.md tells you to use). It is never printed or stored.'
    );
  }

  const label = argValue(argv, '--label') ?? 'unlabelled';
  const batch = Number(argValue(argv, '--batch') ?? 5000);
  if (!Number.isInteger(batch) || batch < 1 || batch > 50000) fail('--batch must be an integer in 1..50000');

  const startedAt = new Date();
  const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
  const outDir = resolve(argValue(argv, '--out') ?? join('.snapshots', `${label}-${stamp}`));

  const client = new Client({ connectionString });
  await client.connect();

  try {
    // Session-level read-only, then a single consistent read-only transaction for every SELECT.
    // Stable text output settings so the same rows always serialise to the same bytes:
    // UTC timestamps, ISO datestyle, ISO-8601 intervals, full float precision.
    await client.query('SET default_transaction_read_only = on');
    await client.query("SET TIME ZONE 'UTC'");
    await client.query("SET DateStyle = 'ISO, MDY'");
    await client.query("SET IntervalStyle = 'iso_8601'");
    await client.query('SET extra_float_digits = 3');
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');

    console.log('→ schema guard (deny-by-default)');
    // Client satisfies the narrow `query` surface runSchemaGuard uses; the cast keeps the guard
    // usable from both a Pool (tests) and this single consistent Client (export).
    const guard = await runSchemaGuard(client as unknown as Parameters<typeof runSchemaGuard>[0]);
    for (const n of guard.notices) console.warn(`  ! ${n}`);
    if (guard.errors.length > 0) {
      for (const e of guard.errors) console.error(`  ✗ ${e}`);
      fail(
        `${guard.errors.length} schema-policy error(s). NOTHING WAS EXPORTED.\n` +
          '  This is the guard working as designed: the schema has moved and a human has to say what changed.'
      );
    }
    console.log(`  ✔ ${SNAPSHOT_TABLES.length} allowlisted tables, every column classified`);

    mkdirSync(outDir, { recursive: true });

    const entries: TableManifestEntry[] = [];
    let totalRows = 0;
    let totalBytes = 0;

    for (const [i, policy] of SNAPSHOT_TABLES.entries()) {
      const cols = exportedColumns(policy);
      const fileName = `${String(i + 1).padStart(2, '0')}_${policy.table}.ndjson.gz`;
      const filePath = join(outDir, fileName);

      const tally: RedactionTally = {};
      let rows = 0;

      // Generator → gzip → file. Backpressure is handled by pipeline(), so a large table never
      // buffers more than one page plus the gzip window.
      const lines = async function* (): AsyncGenerator<string> {
        for await (const page of streamTable(client, policy, batch)) {
          let chunk = '';
          for (const raw of page) {
            const { row, hits } = transformRow(policy, raw);
            mergeTally(tally, hits);
            chunk += `${encodeRow(cols, row)}\n`;
            rows += 1;
          }
          yield chunk;
        }
      };

      await pipeline(Readable.from(lines()), createGzip({ level: 9 }), createWriteStream(filePath));

      const bytes = readFileSync(filePath);
      entries.push({
        table: policy.table,
        file: fileName,
        rows,
        sha256: sha256(bytes),
        bytes: bytes.byteLength,
        redactions: Object.fromEntries(Object.entries(tally).map(([k, v]) => [k, v ?? 0])),
      });
      totalRows += rows;
      totalBytes += bytes.byteLength;

      const redacted = Object.entries(tally)
        .map(([k, v]) => `${k}=${v}`)
        .join(' ');
      console.log(
        `  + ${policy.table.padEnd(24)} ${String(rows).padStart(8)} rows  ${String(bytes.byteLength).padStart(9)} B` +
          (redacted ? `  [redacted ${redacted}]` : '')
      );
    }

    await client.query('COMMIT');

    // ── SILENT-EMPTY GUARD ───────────────────────────────────────────────────────────
    // Migration 0018 turns on RLS with ZERO policies on every catalogue table. A role that
    // has been granted SELECT but does NOT bypass RLS therefore reads nothing — and reads it
    // successfully. Without this check the run prints twelve cheerful "0 rows" lines, writes a
    // valid manifest, exits 0, and hands over a snapshot that makes every downstream suite
    // green by testing nothing at all. That is the worst possible failure mode for this tool,
    // so it is an error, not a warning. (Verified: a role with SELECT and no BYPASSRLS
    // produces exactly this.)
    if (totalRows === 0 && !argv.includes('--allow-empty')) {
      fail(
        'every allowlisted table came back EMPTY.\n' +
          '  This is almost never a genuinely empty catalogue — it is what a role WITHOUT\n' +
          '  BYPASSRLS sees, because migration 0018 enables row-level security with no policies\n' +
          '  on every catalogue table. Grant the snapshot role BYPASSRLS (see\n' +
          '  docs/prod-snapshot-runbook.md §3) and run again.\n' +
          '  If the source really is empty, re-run with --allow-empty.'
      );
    }
    const occurrences = entries.find((e) => e.table === 'activity_occurrence')?.rows ?? 0;
    if (occurrences === 0 && !argv.includes('--allow-empty')) {
      fail(
        'activity_occurrence came back EMPTY while other tables had rows.\n' +
          '  A snapshot with no occurrences cannot exercise search at all. Check the role can\n' +
          '  read activity_occurrence (RLS + GRANT), or re-run with --allow-empty.'
      );
    }

    const manifest: SnapshotManifest = {
      formatVersion: SNAPSHOT_FORMAT_VERSION,
      label,
      createdAt: startedAt.toISOString(),
      policyFingerprint: sha256(policyFingerprint()),
      schema: guard.fingerprint,
      tables: entries,
      totals: { rows: totalRows, bytes: totalBytes },
    };
    writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

    const seconds = (Date.now() - startedAt.getTime()) / 1000;
    console.log(
      `\n✔ snapshot written to ${outDir}\n` +
        `  ${totalRows} rows, ${(totalBytes / 1024).toFixed(1)} KiB gzipped, ${seconds.toFixed(1)}s\n` +
        `  NEXT: verify it before it goes anywhere —\n` +
        `    bash scripts/snapshot/verify.sh --in ${outDir}`
    );
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  // Never print the error object raw, and never print even its message unsanitised: a pg
  // failure can quote the connection string it was handed, credentials and all.
  console.error(`\n✖ export failed: ${safeErrorMessage(err)}\n`);
  process.exit(1);
});
