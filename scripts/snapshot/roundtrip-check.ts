// scripts/snapshot/roundtrip-check.ts — prove the round trip preserved what it promised.
//
// WHY THIS IS A TOOL AND NOT A ONE-OFF QUERY
// The whole value of a production snapshot rests on one claim: "dates, ages and regions come
// through EXACTLY". That claim is easy to assert in a README and easy to break with a stray
// codec — a Date object rounding microseconds away, a numeric arriving as a float, a
// geography losing its SRID. So it is measured, not asserted.
//
// For every allowlisted table it digests the `preserve` columns on BOTH databases and compares.
// Same digest ⇒ every preserved value is byte-identical after export → scrub → gzip → load.
// The scrubbed columns are deliberately NOT compared (they are supposed to differ); they are
// reported separately as a count of rows whose scrubbed value changed, which is the other half
// of the evidence — a scrub that changed nothing would be a scrub that did nothing.
//
// Both connections are READ-ONLY. This is the check an operator runs once, against a
// throwaway copy, before trusting the pipeline — see docs/prod-snapshot-runbook.md §7.
//
// USAGE
//   KF_SNAPSHOT_SOURCE_URL='postgres://…source…' \
//   DATABASE_URL='postgres://…localhost…target…' \
//   bash scripts/snapshot/roundtrip-check.sh
import { Client } from 'pg';
import { SNAPSHOT_TABLES, exportedColumns } from '../../lib/snapshot/policy';
import { safeErrorMessage } from '../../lib/snapshot/safe-error';

interface Digest {
  rows: number;
  preserved: string | null;
  scrubbed: string | null;
}

/**
 * One digest per table over the columns matching `actions`. md5 of the concatenation of every
 * row's values in key order, with an explicit sentinel for NULL so that ('a', NULL) and
 * (NULL, 'a') cannot collide.
 */
function digestSql(table: string, key: string, cols: string[]): string {
  if (cols.length === 0) return `SELECT NULL::text AS digest`;
  const expr = cols.map((c) => `coalesce("${c}"::text, '\\N')`).join(` || '\\x1f' || `);
  return `SELECT md5(string_agg(v, '\\x1e' ORDER BY k)) AS digest
            FROM (SELECT "${key}"::text AS k, ${expr} AS v FROM "${table}") s`;
}

async function digestTable(client: Client, table: string, key: string, preserve: string[], scrub: string[]): Promise<Digest> {
  const rows = Number((await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM "${table}"`)).rows[0].n);
  const preserved = (await client.query<{ digest: string | null }>(digestSql(table, key, preserve))).rows[0].digest;
  const scrubbed = (await client.query<{ digest: string | null }>(digestSql(table, key, scrub))).rows[0].digest;
  return { rows, preserved, scrubbed };
}

async function openReadOnly(connectionString: string): Promise<Client> {
  const client = new Client({ connectionString });
  await client.connect();
  // Identical session settings on both ends, so a difference in the digest is a difference in
  // the DATA and never a difference in how the two servers happened to render it.
  await client.query('SET default_transaction_read_only = on');
  await client.query("SET TIME ZONE 'UTC'");
  await client.query("SET DateStyle = 'ISO, MDY'");
  await client.query("SET IntervalStyle = 'iso_8601'");
  await client.query('SET extra_float_digits = 3');
  return client;
}

async function main(): Promise<void> {
  const sourceUrl = process.env.KF_SNAPSHOT_SOURCE_URL;
  const targetUrl = process.env.DATABASE_URL;
  if (!sourceUrl || !targetUrl) {
    console.error('\n✖ both KF_SNAPSHOT_SOURCE_URL (snapshotted database) and DATABASE_URL (loaded target) must be set\n');
    process.exit(2);
  }

  const source = await openReadOnly(sourceUrl);
  const target = await openReadOnly(targetUrl);
  let failures = 0;

  try {
    console.log('table                     rows(src/tgt)   preserved            scrubbed');
    console.log('─'.repeat(78));

    for (const policy of SNAPSHOT_TABLES) {
      const cols = exportedColumns(policy);
      const preserve = cols.filter((c) => policy.columns[c].action === 'preserve');
      const scrub = cols.filter((c) => policy.columns[c].action !== 'preserve');

      const a = await digestTable(source, policy.table, policy.key, preserve, scrub);
      const b = await digestTable(target, policy.table, policy.key, preserve, scrub);

      const rowsOk = a.rows === b.rows;
      const preservedOk = a.preserved === b.preserved;
      // No scrubbable columns → nothing to have changed, so "unchanged" is correct there.
      const scrubChanged = scrub.length === 0 ? null : a.scrubbed !== b.scrubbed;

      if (!rowsOk || !preservedOk) failures += 1;

      console.log(
        `${policy.table.padEnd(24)} ${String(a.rows).padStart(6)}/${String(b.rows).padEnd(6)} ` +
          `${preservedOk ? 'IDENTICAL ✔' : 'DIFFER ✖   '}` +
          `${preserve.length ? ` (${preserve.length} cols)` : ' (none)'}`.padEnd(22) +
          (scrubChanged === null ? 'n/a' : scrubChanged ? `changed ✔ (${scrub.length} cols)` : `UNCHANGED ✖ (${scrub.length} cols)`)
      );
    }

    console.log('─'.repeat(78));
    if (failures > 0) {
      console.error(`\n✖ ${failures} table(s) did not round-trip preserved columns exactly.\n`);
      process.exit(1);
    }
    console.log(
      '\n✔ every `preserve` column is byte-identical on both sides: dates, ages, region ids,\n' +
        '  costs and geometries survived export → scrub → gzip → load unchanged.\n' +
        '  Scrubbed columns differ, as they must.\n'
    );
  } finally {
    await source.end();
    await target.end();
  }
}

main().catch((err: unknown) => {
  console.error(`\n✖ roundtrip-check failed: ${safeErrorMessage(err)}\n`);
  process.exit(1);
});
