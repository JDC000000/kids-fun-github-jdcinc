// scripts/snapshot/load.ts — restore a verified snapshot into a LOCAL Postgres.
//
// Composes with scripts/local-db-bootstrap.sh rather than replacing it: bootstrap owns the
// SCHEMA (auth stub + forward migrations), this owns the DATA. scripts/snapshot/load.sh runs
// the two in order for a one-command "empty database → production-shaped database".
//
// SAFETY
//   · Refuses any non-local DATABASE_URL, using the SAME host resolution as
//     lib/testing/local-db-guard.ts and lib/db/pool-config.ts (lib/db/connection-host.ts —
//     which honours a `?host=` override, the exact hole the Round 27 incident went through).
//     A snapshot load TRUNCATES the catalogue; pointing it at staging would be catastrophic,
//     so the refusal has no escape hatch. If you want a remote target, you want a different
//     tool and a different conversation.
//   · Verifies the snapshot's checksums and schema fingerprint before writing anything. A
//     snapshot taken against a different migration set loads rows shaped for a schema that is
//     not this one — the resulting green test run would prove nothing.
//   · Everything happens in ONE transaction. A failure mid-load leaves the database exactly as
//     it was, not half production and half fixtures.
//
// WHAT IT DOES NOT LOAD: search_tsv. It is `derived_drop` in the policy, and the 0010 triggers
// rebuild it from the scrubbed text as rows land — which also proves the trigger chain still
// works end to end, for free.
//
// USAGE
//   DATABASE_URL='postgres://…localhost…' bash scripts/snapshot/load.sh --in .snapshots/<dir>
//     --in DIR              snapshot directory (required)
//     --allow-schema-drift  downgrade a fingerprint mismatch to a warning (LOCAL debugging
//                           only; mirrors migrate.sh's MIGRATE_ALLOW_CHECKSUM_MISMATCH)
//     --skip-verify         skip the PII re-scan (do not: it is seconds, and it is the barrier)
import { createGunzip } from 'node:zlib';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';
import { Client } from 'pg';
import { SNAPSHOT_TABLES, exportedColumns, type TablePolicy } from '../../lib/snapshot/policy';
import { readLiveSchema } from '../../lib/snapshot/schema-guard';
import { decodeRow, describeSchemaDiff, sha256, type SnapshotManifest, type SnapshotRow } from '../../lib/snapshot/format';
import { isLocalDatabaseHost, resolveConnectionHost } from '../../lib/db/connection-host';
import { safeErrorMessage } from '../../lib/snapshot/safe-error';
import { verifySnapshot } from '../../lib/snapshot/verify';

function argValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function fail(message: string): never {
  console.error(`\n✖ ${message}\n`);
  process.exit(2);
}

/**
 * Postgres caps a single statement at 65535 bound parameters. Batch by PARAMETER count, not
 * row count, so a 25-column table cannot silently blow the limit that a 5-column one never
 * reaches.
 */
const MAX_PARAMS_PER_STATEMENT = 60000;

/** Stream a table file line by line. Never materialises a whole table — production's
 * activity_occurrence is the largest thing in this pipeline and buffering it would make peak
 * memory a function of catalogue size for no benefit. */
async function* streamRows(filePath: string): AsyncGenerator<SnapshotRow> {
  const rl = createInterface({ input: createReadStream(filePath).pipe(createGunzip()), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.trim() !== '') yield decodeRow(line);
  }
}

/** Insert every row of `filePath`, batched. Returns the row count actually inserted. */
async function insertStreaming(client: Client, policy: TablePolicy, filePath: string): Promise<number> {
  // Self-referencing FKs (region.parent_id) cannot be satisfied by any single row ordering, and
  // none of this schema's FKs are DEFERRABLE. So: insert with those columns NULL here, and fill
  // them in fixUpSelfReferences() once every row exists.
  const selfRefs = policy.selfRefColumns ?? [];
  const cols = exportedColumns(policy);
  const quoted = cols.map((c) => `"${c}"`).join(', ');
  const rowsPerStatement = Math.max(1, Math.floor(MAX_PARAMS_PER_STATEMENT / cols.length));

  let total = 0;
  let params: (string | null)[] = [];
  let tuples: string[] = [];

  const flush = async (): Promise<void> => {
    if (tuples.length === 0) return;
    await client.query(`INSERT INTO "${policy.table}" (${quoted}) VALUES ${tuples.join(', ')}`, params);
    params = [];
    tuples = [];
  };

  for await (const row of streamRows(filePath)) {
    const placeholders: string[] = [];
    for (const c of cols) {
      // Values are Postgres text representations sent as untyped parameters; the server coerces
      // each to the target column's type. That is what makes the round trip exact for
      // timestamptz, numeric, geography, interval and uuid[] alike.
      params.push(selfRefs.includes(c) ? null : (row[c] ?? null));
      placeholders.push(`$${params.length}`);
    }
    tuples.push(`(${placeholders.join(', ')})`);
    total += 1;
    if (tuples.length >= rowsPerStatement) await flush();
  }
  await flush();
  return total;
}

/** Second pass over the file, filling the self-referencing columns left NULL by the insert. */
async function fixUpSelfReferences(client: Client, policy: TablePolicy, filePath: string): Promise<void> {
  for (const col of policy.selfRefColumns ?? []) {
    let params: (string | null)[] = [];
    let cases: string[] = [];
    const flush = async (): Promise<void> => {
      if (cases.length === 0) return;
      await client.query(
        `UPDATE "${policy.table}" AS t SET "${col}" = v.parent::uuid
           FROM (VALUES ${cases.join(', ')}) AS v(id, parent)
          WHERE t."${policy.key}" = v.id::uuid`,
        params
      );
      params = [];
      cases = [];
    };
    for await (const row of streamRows(filePath)) {
      if (row[col] === null) continue;
      params.push(row[policy.key], row[col]);
      cases.push(`($${params.length - 1}, $${params.length})`);
      if (cases.length >= 1000) await flush();
    }
    await flush();
  }
}

/**
 * Restore `updated_at` to the snapshot's value.
 *
 * FOUND BY scripts/snapshot/roundtrip-check.sh, not by reasoning: after a load,
 * activity_occurrence.updated_at did not match the source. Cause — inserting into
 * occurrence_category_tag fires 0010's `occurrence_category_tag_reindex`, which UPDATEs the
 * occurrence to recompute search_tsv, which in turn fires 0003's `set_updated_at` BEFORE
 * UPDATE trigger and stamps now(). Loading tag rows silently rewrote the modification time of
 * every occurrence that had a tag.
 *
 * `updated_at` is a `preserve` column and freshness logic reads it, so "close enough" is not
 * good enough — a snapshot where every row was modified at load time is a snapshot that cannot
 * test staleness at all. This runs LAST, with user triggers disabled so the restore does not
 * re-trigger the very thing it is undoing. Constraint (FK) triggers are internal and are NOT
 * affected by DISABLE TRIGGER USER, so referential integrity is still enforced throughout.
 */
async function restoreUpdatedAt(client: Client, policy: TablePolicy, filePath: string): Promise<number> {
  if (!exportedColumns(policy).includes('updated_at')) return 0;

  await client.query(`ALTER TABLE "${policy.table}" DISABLE TRIGGER USER`);
  try {
    let fixed = 0;
    let params: (string | null)[] = [];
    let cases: string[] = [];
    const flush = async (): Promise<void> => {
      if (cases.length === 0) return;
      const res = await client.query(
        `UPDATE "${policy.table}" AS t SET updated_at = v.ts::timestamptz
           FROM (VALUES ${cases.join(', ')}) AS v(id, ts)
          WHERE t."${policy.key}" = v.id::uuid AND t.updated_at IS DISTINCT FROM v.ts::timestamptz`,
        params
      );
      fixed += res.rowCount ?? 0;
      params = [];
      cases = [];
    };
    for await (const row of streamRows(filePath)) {
      params.push(row[policy.key], row.updated_at ?? null);
      cases.push(`($${params.length - 1}, $${params.length})`);
      if (cases.length >= 1000) await flush();
    }
    await flush();
    return fixed;
  } finally {
    await client.query(`ALTER TABLE "${policy.table}" ENABLE TRIGGER USER`);
  }
}

/**
 * Every table that has a foreign key pointing INTO the allowlisted set, transitively. TRUNCATE
 * CASCADE would clear these silently; we compute and PRINT them first so "the loader wiped my
 * analytics fixtures" is documented behaviour rather than a surprise.
 */
async function truncationClosure(client: Client, tables: string[]): Promise<string[]> {
  const { rows } = await client.query<{ child: string; parent: string }>(
    `SELECT c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent
       FROM pg_constraint c
       JOIN pg_class r ON r.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = r.relnamespace
      WHERE c.contype = 'f' AND n.nspname = 'public'`
  );
  const closure = new Set(tables);
  let grew = true;
  while (grew) {
    grew = false;
    for (const { child, parent } of rows) {
      if (closure.has(parent) && !closure.has(child)) {
        closure.add(child);
        grew = true;
      }
    }
  }
  return [...closure];
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dir = resolve(argValue(argv, '--in') ?? '');
  if (!dir || !existsSync(join(dir, 'manifest.json'))) fail('--in DIR is required and must contain manifest.json');

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) fail('DATABASE_URL must be set (the LOCAL database to load into)');

  const host = resolveConnectionHost(connectionString);
  if (host === null) fail('DATABASE_URL is not a parseable connection URL — refusing to load into an unverifiable target.');
  if (!isLocalDatabaseHost(host)) {
    fail(
      `DATABASE_URL points at non-local host "${host}". This tool TRUNCATES the catalogue before ` +
        `loading; it will only ever target a local, disposable Postgres. There is no override.`
    );
  }

  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as SnapshotManifest;
  console.log(`→ snapshot "${manifest.label}" taken ${manifest.createdAt} (${manifest.totals.rows} rows)`);

  if (!argv.includes('--skip-verify')) {
    console.log('→ re-verifying snapshot contents before load');
    const { problems, rowsScanned } = await verifySnapshot(dir);
    if (problems.length > 0) {
      for (const p of problems.slice(0, 50)) console.error(`  ✗ ${p}`);
      fail(`${problems.length} verification problem(s). Refusing to load a snapshot that does not verify.`);
    }
    console.log(`  ✔ ${rowsScanned} rows clean`);
  }

  const client = new Client({ connectionString });
  await client.connect();

  try {
    const live = await readLiveSchema(client as unknown as Parameters<typeof readLiveSchema>[0]);
    const { rows: ledger } = await client.query<{ version: string; checksum: string | null }>(
      `SELECT version, checksum FROM schema_migrations ORDER BY version`
    );
    const here = {
      migrations: ledger,
      tables: Object.fromEntries(SNAPSHOT_TABLES.map((t) => [t.table, live.get(t.table) ?? []])),
    };
    const drift = describeSchemaDiff(manifest.schema, here);
    if (drift.length > 0) {
      for (const d of drift) console.error(`  ✗ schema drift: ${d}`);
      if (!argv.includes('--allow-schema-drift')) {
        fail(
          `the snapshot was taken against a different schema than this database has.\n` +
            `  Run 'bash scripts/local-db-bootstrap.sh' to bring this database up to the committed\n` +
            `  migrations, or take a fresh snapshot. --allow-schema-drift downgrades this to a warning\n` +
            `  for LOCAL debugging only — a suite run against a mismatched snapshot proves nothing.`
        );
      }
      console.warn('  ! --allow-schema-drift in effect; continuing despite the differences above');
    }

    const tables = SNAPSHOT_TABLES.map((t) => t.table);
    const closure = await truncationClosure(client, tables);
    const extra = closure.filter((t) => !tables.includes(t));
    if (extra.length > 0) {
      console.log(`→ TRUNCATE will also clear (FK dependents): ${extra.sort().join(', ')}`);
    }

    const startedAt = Date.now();
    await client.query('BEGIN');
    await client.query(`TRUNCATE ${closure.map((t) => `"${t}"`).join(', ')} CASCADE`);

    let loaded = 0;
    for (const policy of SNAPSHOT_TABLES) {
      const entry = manifest.tables.find((e) => e.table === policy.table);
      if (!entry) fail(`manifest has no entry for allowlisted table ${policy.table}`);
      const filePath = join(dir, entry.file);
      if (sha256(readFileSync(filePath)) !== entry.sha256) fail(`${entry.file}: sha256 mismatch`);

      const n = await insertStreaming(client, policy, filePath);
      if (n !== entry.rows) fail(`${policy.table}: manifest says ${entry.rows} rows, file yielded ${n}`);
      await fixUpSelfReferences(client, policy, filePath);
      loaded += n;
      console.log(`  + ${policy.table.padEnd(24)} ${String(n).padStart(8)} rows`);
    }

    // AFTER every table, so the tag-reindex trigger has already done its damage. See
    // restoreUpdatedAt()'s header — this exists because roundtrip-check caught it.
    let restored = 0;
    for (const policy of SNAPSHOT_TABLES) {
      const entry = manifest.tables.find((e) => e.table === policy.table);
      if (entry) restored += await restoreUpdatedAt(client, policy, join(dir, entry.file));
    }
    if (restored > 0) console.log(`  ~ restored updated_at on ${restored} row(s) clobbered by load-time triggers`);

    await client.query('COMMIT');

    // Fresh statistics, so a suite that measures query behaviour sees plans chosen for the
    // snapshot's real cardinalities rather than for an empty table.
    await client.query(`ANALYZE ${tables.map((t) => `"${t}"`).join(', ')}`);

    const [{ missing }] = (
      await client.query<{ missing: string }>(
        `SELECT count(*)::text AS missing FROM activity_occurrence WHERE search_tsv IS NULL`
      )
    ).rows;
    if (missing !== '0') {
      fail(`${missing} occurrence(s) have a NULL search_tsv after load — the 0010 FTS trigger did not fire.`);
    }

    console.log(
      `\n✔ loaded ${loaded} rows in ${((Date.now() - startedAt) / 1000).toFixed(1)}s; search_tsv recomputed by trigger for every occurrence.`
    );
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  console.error(`\n✖ load failed: ${safeErrorMessage(err)}\n`);
  process.exit(1);
});
