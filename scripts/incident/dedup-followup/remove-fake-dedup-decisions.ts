// scripts/incident/dedup-followup/remove-fake-dedup-decisions.ts — FIX 2 of 2. OPERATOR TOOL.
//
//   KF_CLEANUP_TARGET_URL='postgres://…' bash scripts/incident/dedup-followup/remove-fake-dedup-decisions.sh
//   …plus --commit --yes-write-production to actually write.
//
// ═══ THE PROBLEM ═══
// While the 2026-09-21 test run held production, it drove the REAL dedup adjudication pipeline.
// That pipeline wrote 49 rows into `llm_batch_decision` — every one job_name='llm_dedup_adjudication',
// use_case='dedup', action='route_to_review' — against 18 REAL production listings. They are a
// machine's verdict recorded during a test, about real data, which no human ever reviewed. Left in
// place they are a false audit trail: anything reading the decision log sees those 18 listings as
// having been assessed and routed.
//
// ═══ SCOPE — WHAT THIS DELETES, AND WHAT IT DELIBERATELY DOES NOT ═══
// DELETES: exactly the 49 decision rows, by explicit id, each re-verified at run time against the
// job_name/use_case/target_id/action/created_at fingerprint recorded in the manifest. Verified
// read-only against production: `llm_batch_decision` contains 49 rows IN TOTAL, all from the
// incident window — so there is no pre-existing decision history to preserve, and the table should
// be empty afterwards. The script asserts that rather than assuming it.
//
// DOES NOT TOUCH the 18 occurrences' `status_state`. Those rows were moved to 'manual_candidate'
// by the same run, and reverting them would hit the identical problem as the 16,561 stale flips:
// the prior state is not recoverable from inside the database (six candidate states, no status
// history, no status provenance), so any revert would be a guess. They are also all PAST-DATED —
// none is user-visible in search today — so there is no urgency justifying a guess. They belong to
// the point-in-time-restore pass, where the real prior value can be read rather than inferred.
// Deleting the decision rows without touching the listings is coherent: it removes a false claim
// about those listings without inventing a replacement claim.
//
// Reversible: all 49 rows are written to a JSON backup with ready-to-run restore SQL first.
import { readFileSync, existsSync } from 'node:fs';
import { Abort, log, parseArgs, require_, runGuarded, writeBackup } from './_harness';

const MANIFEST = 'scripts/incident/dedup-followup/manifest-dedup-followup.json';

interface Decision {
  id: string; job_name: string; use_case: string; target_id: string;
  related_id: string | null; custom_id: string | null; action: string;
  deterministic_score: unknown; llm_confidence: unknown; detail: unknown; created_at: string;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2), MANIFEST);
  if (!existsSync(args.manifestPath)) {
    log(`manifest not found: ${args.manifestPath}\nRun from the repo root, or pass --manifest <path>.`);
    process.exit(2);
  }
  const m = JSON.parse(readFileSync(args.manifestPath, 'utf8')) as {
    decisions: Decision[];
    expected_llm_batch_decision_total_in_table: number;
    distinct_targets: { id: string }[];
  };
  const ids = m.decisions.map((d) => d.id);

  // Pre-connection manifest sanity — its own handler, so an Abort here is a readable refusal
  // rather than an unhandled stack trace (a defect the cleanup script's own rehearsal surfaced).
  try {
    require_(ids.length > 0, 'manifest lists no decisions — nothing to do');
    require_(new Set(ids).size === ids.length, 'manifest contains duplicate decision ids');
  } catch (err) {
    log(`\n✖ ABORTED: ${(err as Error).message}\n  No database connection was opened.`);
    process.exit(1);
  }

  await runGuarded(args, async (c) => {
    const live = (await c.query<Decision>(
      `SELECT id::text, job_name, use_case, target_id::text, action, created_at::text
         FROM llm_batch_decision WHERE id = ANY($1::uuid[])`, [ids]
    )).rows;
    require_(live.length === ids.length,
      `expected ${ids.length} decision rows, found ${live.length} — already cleaned, or the wrong database.`);

    const byId = new Map(live.map((r) => [r.id, r]));
    for (const want of m.decisions) {
      const got = byId.get(want.id);
      require_(!!got, `decision ${want.id} is missing`);
      require_(got!.job_name === want.job_name && got!.use_case === want.use_case && got!.action === want.action,
        `fingerprint drift on ${want.id}: manifest says ${want.job_name}/${want.use_case}/${want.action}, ` +
          `database says ${got!.job_name}/${got!.use_case}/${got!.action} — refusing`);
      require_(got!.target_id === want.target_id, `target drift on ${want.id} — refusing`);
      require_(Date.parse(got!.created_at) === Date.parse(want.created_at), `created_at drift on ${want.id} — refusing`);
    }
    log(`✔ identity verified: ${live.length} decision rows match the manifest exactly`);
    log(`  all action='route_to_review', ${m.distinct_targets.length} distinct real listings targeted`);

    const totalBefore = Number((await c.query<{ n: string }>(`SELECT count(*) n FROM llm_batch_decision`)).rows[0].n);
    const outsideBefore = totalBefore - live.length;
    require_(totalBefore === m.expected_llm_batch_decision_total_in_table,
      `llm_batch_decision holds ${totalBefore} rows, manifest expected ${m.expected_llm_batch_decision_total_in_table} — ` +
        `the table has changed since the manifest was generated. Re-generate it. Refusing.`);
    log(`  llm_batch_decision total: ${totalBefore} (${outsideBefore} outside the manifest — must stay)`);

    // Capture the FULL rows (not just the fingerprint columns) so the backup can restore verbatim.
    const full = (await c.query(
      // detail is jsonb and is selected as ::text on purpose — see writeBackup's jsonbTextColumns.
      `SELECT id::text, job_name, use_case, target_id::text, related_id::text, custom_id, action,
              deterministic_score, llm_confidence, detail::text, created_at::text
         FROM llm_batch_decision WHERE id = ANY($1::uuid[]) ORDER BY created_at, id`, [ids]
    )).rows as Record<string, unknown>[];
    const backup = writeBackup(
      args.backupDir, 'llm_batch_decision-fake-dedup', 'llm_batch_decision', full,
      { kind: 'insert' }, ['detail']
    );
    log(`  backup written: ${backup}`);

    log('\n── deletion ──');
    const del = await c.query(`DELETE FROM llm_batch_decision WHERE id = ANY($1::uuid[])`, [ids]);
    log(`   ${String(del.rowCount).padStart(6)}  llm_batch_decision`);
    require_(del.rowCount === ids.length, `deleted ${del.rowCount}, expected ${ids.length}. Rolling back.`);

    const totalAfter = Number((await c.query<{ n: string }>(`SELECT count(*) n FROM llm_batch_decision`)).rows[0].n);
    require_(totalAfter === outsideBefore,
      `rows outside the manifest were affected (${outsideBefore} → ${totalAfter}). Rolling back.`);
    const remaining = Number((await c.query<{ n: string }>(`SELECT count(*) n FROM llm_batch_decision WHERE id = ANY($1::uuid[])`, [ids])).rows[0].n);
    require_(remaining === 0, `${remaining} manifest rows survived the delete. Rolling back.`);

    // The listings themselves must be exactly as we found them — this script must not move status.
    const targets = m.distinct_targets.map((t) => t.id);
    const stillThere = Number((await c.query<{ n: string }>(`SELECT count(*) n FROM activity_occurrence WHERE id = ANY($1::uuid[])`, [targets])).rows[0].n);
    require_(stillThere === targets.length,
      `${targets.length - stillThere} targeted listing(s) disappeared — this script must never delete listings. Rolling back.`);

    log('\n── verification ──');
    log(`✔ ${del.rowCount} fake decision rows removed`);
    log(`✔ rows outside the manifest untouched: ${totalAfter}`);
    log(`✔ all ${stillThere} targeted listings still present, status_state deliberately unchanged`);
  });
}

void main().catch((e) => {
  log(`\n✖ ${e instanceof Abort ? `ABORTED: ${e.message}` : `FAILED: ${(e as Error).message}`}`);
  process.exit(1);
});
