// scripts/incident/dedup-followup/reset-dedup-watermark.ts — FIX 1 of 2. OPERATOR TOOL.
//
//   KF_CLEANUP_TARGET_URL='postgres://…' bash scripts/incident/dedup-followup/reset-dedup-watermark.sh
//   …plus --commit --yes-write-production to actually write.
//
// ═══ THE PROBLEM ═══
// The 2026-09-21 test run left production's `llm_batch_run` row for `llm_dedup_adjudication`
// holding a TEST value: last_watermark = 2026-09-21T18:53:36.054Z, with records_considered=33 /
// records_actioned=8, which are the fixture counts from that run and nothing to do with prod.
//
// lib/llm/watermark.ts builds its incremental predicate as:
//     coalesce((SELECT last_watermark FROM llm_batch_run WHERE job_name = $1), '-infinity')
// so a run only considers records whose greatest(created_at, last_checked_at) is AFTER the
// watermark. With the watermark sitting at 18:53:36 on 2026-09-21, **20,518 real occurrences now
// fall at or below it** and are treated as already-adjudicated. Genuine duplicates among them can
// never be surfaced by an incremental run. The dedup job has not run since, so nothing has
// corrected this on its own.
//
// ═══ WHY DELETING THE ROW IS THE RIGHT FIX, AND NOT A GUESS ═══
// Because of that `coalesce(..., '-infinity')`, a MISSING row is not an error state — it is the
// well-defined "never run" state, and it makes the next run scan everything. So deleting restores
// correct behaviour without inventing a watermark value, which matters: the pre-incident value is
// unknowable (the test's INSERT ... ON CONFLICT DO UPDATE overwrote it in place, and this table
// has no created_at, so we cannot even tell whether a row existed before). Any value we picked
// would be a fabrication wearing a timestamp. The only cost of deleting is that one subsequent
// dedup run does a full scan instead of an incremental one — it does more work, not wrong work.
//
// Reversible: the row is written to a JSON backup with ready-to-run restore SQL before deletion.
import { readFileSync, existsSync } from 'node:fs';
import { Abort, backupRunDir, log, parseArgs, require_, runGuarded, writeBackup } from './_harness';

const MANIFEST = 'scripts/incident/dedup-followup/manifest-dedup-followup.json';
const JOB = 'llm_dedup_adjudication';

interface WatermarkRow {
  job_name: string;
  last_watermark: string;
  last_run_at: string;
  last_status: string;
  records_considered: number;
  records_actioned: number;
  updated_at: string;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2), MANIFEST);
  if (!existsSync(args.manifestPath)) {
    log(`manifest not found: ${args.manifestPath}\nRun from the repo root, or pass --manifest <path>.`);
    process.exit(2);
  }
  const m = JSON.parse(readFileSync(args.manifestPath, 'utf8')) as { watermark_rows: WatermarkRow[] };
  const expected = m.watermark_rows.find((r) => r.job_name === JOB);

  await runGuarded(args, async (c) => {
    require_(!!expected, `manifest has no watermark row for job_name='${JOB}'`);

    const live = (await c.query<WatermarkRow>(
      `SELECT job_name, last_watermark::text, last_run_at::text, last_status,
              records_considered, records_actioned, updated_at::text
         FROM llm_batch_run WHERE job_name = $1`, [JOB]
    )).rows;
    require_(live.length === 1, `expected exactly 1 '${JOB}' row, found ${live.length} — already fixed, or the wrong database.`);
    const row = live[0];

    // Fingerprint check. If the dedup job has RUN since the incident, the watermark is no longer
    // the poisoned value and this script is the wrong tool — abort rather than delete a row that
    // now carries legitimate state.
    require_(
      Date.parse(row.last_watermark) === Date.parse(expected!.last_watermark),
      `watermark drift: manifest expected ${expected!.last_watermark}, database has ${row.last_watermark}. ` +
        `The dedup job has probably run since — the poisoned value is gone and deleting this row would ` +
        `discard real state. Refusing.`
    );
    require_(
      row.records_considered === expected!.records_considered && row.records_actioned === expected!.records_actioned,
      `run-counter drift (considered ${row.records_considered} vs ${expected!.records_considered}, ` +
        `actioned ${row.records_actioned} vs ${expected!.records_actioned}). Refusing.`
    );
    log(`✔ identity verified: '${JOB}' still carries the test watermark ${row.last_watermark}`);

    // How much is currently being skipped — stated as a number, so the effect is legible.
    const skipped = Number((await c.query<{ n: string }>(
      `SELECT count(*) n FROM activity_occurrence
        WHERE greatest(created_at, coalesce(last_checked_at, created_at)) <= $1::timestamptz`,
      [row.last_watermark]
    )).rows[0].n);
    log(`  occurrences currently at/below that watermark (i.e. skipped by an incremental run): ${skipped}`);

    const others = Number((await c.query<{ n: string }>(
      `SELECT count(*) n FROM llm_batch_run WHERE job_name <> $1`, [JOB]
    )).rows[0].n);
    log(`  other llm_batch_run rows present (must be untouched): ${others}`);

    const backup = writeBackup(backupRunDir(args), 'llm_batch_run-dedup-watermark', 'llm_batch_run', [row as unknown as Record<string, unknown>]);
    log(`  backup written: ${backup}`);

    log('\n── deletion ──');
    const del = await c.query(`DELETE FROM llm_batch_run WHERE job_name = $1`, [JOB]);
    log(`   ${String(del.rowCount).padStart(6)}  llm_batch_run (job_name='${JOB}')`);
    require_(del.rowCount === 1, `expected to delete exactly 1 row, deleted ${del.rowCount}. Rolling back.`);

    const remaining = Number((await c.query<{ n: string }>(`SELECT count(*) n FROM llm_batch_run WHERE job_name = $1`, [JOB])).rows[0].n);
    require_(remaining === 0, `the row survived the delete. Rolling back.`);
    const othersAfter = Number((await c.query<{ n: string }>(`SELECT count(*) n FROM llm_batch_run WHERE job_name <> $1`, [JOB])).rows[0].n);
    require_(othersAfter === others, `other llm_batch_run rows changed (${others} → ${othersAfter}). Rolling back.`);

    log('\n── verification ──');
    log(`✔ '${JOB}' watermark row removed → next run resolves to '-infinity' and re-scans everything`);
    log(`✔ ${skipped} occurrences are no longer excluded from dedup consideration`);
    log(`✔ other llm_batch_run rows untouched: ${othersAfter}`);
  });
}

void main().catch((e) => {
  log(`\n✖ ${e instanceof Abort ? `ABORTED: ${e.message}` : `FAILED: ${(e as Error).message}`}`);
  process.exit(1);
});
