// scripts/backfill-scope/m1-withheld-backfill.ts — driver for the M1 §3h correction:
// PerfectMind rows whose "All ages" claim was manufactured from the vendor's NoAgeRestriction
// booking flag, and which M1's shipped parser withholds today.
//
//   bash scripts/backfill-scope/m1-withheld-backfill.sh                     # DRY RUN (default)
//   bash scripts/backfill-scope/m1-withheld-backfill.sh --json plan.json    # + full artefact
//   bash scripts/backfill-scope/m1-withheld-backfill.sh --apply             # WRITES. Opt-in.
//
// ── DRY RUN IS THE DEFAULT AND THE WRITE SURFACE IS NOT EVEN LOADED ──────────────────────
// Planning reads production through scripts/backfill-scope/readonly-db.ts, whose three locks
// (server-side `BEGIN TRANSACTION READ ONLY`, a statement-shape guard, and no imported writer)
// are reused here UNCHANGED — this file weakens none of them. The writer lives in its own module
// and is reached by a DYNAMIC `await import('./correcting-db')` that only executes after
// `--apply` has been read off the command line. Without the flag the write surface is never
// loaded into the process, which is a stronger property than a boolean that happened to be false.
//
// Even WITH `--apply`, identification stays read-only: the batch is planned on the read-only
// connection first, printed in full, and only then applied row-by-row through a statement whose
// WHERE clause re-states the entire pre-state it was planned on.
//
// DATABASE_URL must be supplied by the caller. The wrapper reads no credential store and
// defaults to nothing: pointing this at production is an explicit act.
import { writeFileSync } from 'node:fs';
import { openReadOnly } from './readonly-db';
import {
  ALL_AGES_NOTES_PROXY,
  ARCHIVED_PROXY_SQL,
  CANDIDATE_ROWS_SQL,
  CONTEXT_SQL,
  CORRECTION_UPDATE_SQL,
  PUBLISHED_ANCHORS,
  REASON,
  RECONCILIATION_NOTES,
  buildPlan,
  correctionParams,
  type RowDecision,
  type StoredAgeRow,
} from './m1-withheld-backfill-lib';

/**
 * Ceiling on how many rows one `--apply` may touch. Deliberately a little above the population
 * this was built for (597 on 2026-09-12) and far below "the whole table": a logic change that
 * suddenly selects thousands stops here instead of running. Raising it is a command-line act,
 * which is the point — it cannot drift upward quietly.
 */
const DEFAULT_MAX_ROWS = 1000;

interface Args {
  apply: boolean;
  json: string | null;
  maxRows: number;
  samples: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { apply: false, json: null, maxRows: DEFAULT_MAX_ROWS, samples: 4 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--apply' || argv[i] === '--write') args.apply = true;
    if (argv[i] === '--json') args.json = argv[i + 1] ?? 'm1-withheld-backfill.json';
    if (argv[i] === '--max-rows') args.maxRows = Number(argv[i + 1] ?? DEFAULT_MAX_ROWS);
    if (argv[i] === '--samples') args.samples = Number(argv[i + 1] ?? 4);
  }
  return args;
}

function toStoredRow(r: Record<string, unknown>): StoredAgeRow {
  return {
    occurrenceId: String(r.occurrence_id),
    activityName: String(r.activity_name ?? ''),
    ageMinMonths: r.age_min_months === null ? null : Number(r.age_min_months),
    ageMaxMonths: r.age_max_months === null ? null : Number(r.age_max_months),
    ageNotes: (r.age_notes as string | null) ?? null,
    bandCount: Number(r.band_count ?? 0),
    lastCheckedAt: r.last_checked_at ? new Date(r.last_checked_at as string).toISOString() : null,
  };
}

function printRow(d: RowDecision, outcome?: string): void {
  const reach = d.maskedBySearchFilter ? 'masked-by-adult-title-filter' : 'PARENT-REACHABLE';
  console.log(`  ${d.occurrenceId}  ${JSON.stringify(d.activityName)}`);
  console.log(`      before : ${d.storedClaim}   (${reach})`);
  console.log(`      after  : ${d.correctedClaim ?? 'unchanged'}${outcome ? `   [${outcome}]` : ''}`);
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is required. This tool never guesses a database.');
    return 2;
  }

  const db = await openReadOnly(connectionString);
  let plan;
  let context: Record<string, string>;
  let archived: Record<string, string>;
  try {
    [context] = await db.query<Record<string, string>>(CONTEXT_SQL, [ALL_AGES_NOTES_PROXY]);
    [archived] = await db.query<Record<string, string>>(ARCHIVED_PROXY_SQL, [ALL_AGES_NOTES_PROXY]);
    const raw = await db.query<Record<string, unknown>>(CANDIDATE_ROWS_SQL, [ALL_AGES_NOTES_PROXY]);
    plan = buildPlan(raw.map(toStoredRow));
  } finally {
    await db.end();
  }

  console.log('# M1 §3h correction — PerfectMind flag-only "All ages" claims');
  console.log(`# MODE: ${args.apply ? '*** APPLY — THIS RUN WRITES TO THE CONNECTED DATABASE ***' : 'DRY RUN (nothing is written; the write module is not loaded)'}\n`);

  console.log('## Scope actually measured');
  console.log(`perfectmind occurrences (not archived)      ${context.perfectmind_occurrences}`);
  console.log(`  …with an occurrence_age row              ${context.with_age_row}`);
  console.log(`  …with age_notes = '${ALL_AGES_NOTES_PROXY}'  (the NoAgeRestriction proxy)  ${context.proxy_rows}`);
  console.log(`  …re-ingested in the last 6h              ${context.reingested_last_6h}`);
  console.log(`archived rows holding the proxy claim      ${archived.archived_proxy_rows}   (excluded from this plan)`);
  console.log(`previously corrected by the Operator       ${context.prior_operator_corrections}   (2026-08-19 batches; they left the proxy)`);
  console.log('');
  console.log('proxy purity evidence — rows whose age_notes reads \'unresolved: ages …\', the visible');
  console.log('footprint of PerfectMind\'s display-restrictions / age-restrictions fallbacks (the only');
  console.log(`non-flag paths that could reach an all-ages claim):  ${context.proxy_rows_unresolved_ages}`);
  console.log('');

  console.log("## What M1's shipped resolveAgeText() says about each proxy row today");
  for (const [code, n] of plan.byM1Code) console.log(`  ${code.padEnd(34)} ${n}`);
  if (!plan.byM1Code.some(([code]) => code === 'no-age-restriction-contradicted')) {
    console.log('  no-age-restriction-contradicted     0');
    console.log(`     ↑ EXPLAINED, not missing: the Operator corrected that population by hand on`);
    console.log(`       2026-08-19 (${context.prior_operator_corrections} rows still carry the stamp), which moved them out of this`);
    console.log('       proxy. docs §3.5 predicted exactly that. Nothing here re-corrects them.');
  }
  console.log('');
  console.log('## Decisions');
  for (const [reason, n] of plan.byReason) console.log(`  ${String(n).padStart(6)}  ${reason}`);
  console.log('');
  console.log(`IN SCOPE FOR CORRECTION: ${plan.corrections.length} occurrence rows across ${plan.correctionsByTitle.length} distinct listings`);
  console.log(`  of those rows, ${plan.correctionsParentReachable} are reachable by a parent searching today;`);
  console.log(`  ${plan.corrections.length - plan.correctionsParentReachable} are already hidden by the shipped adult/senior title exclusion.`);
  console.log('');
  console.log('  the listings behind those rows (one row per DATE — this is why the row count is the');
  console.log('  bigger number), largest first:');
  for (const [title, n] of plan.correctionsByTitle.slice(0, args.samples * 4)) {
    console.log(`    ${String(n).padStart(4)} × ${JSON.stringify(title)}`);
  }
  if (plan.correctionsByTitle.length > args.samples * 4) {
    console.log(`    … and ${plan.correctionsByTitle.length - args.samples * 4} more listings (full list in --json)`);
  }
  console.log('');

  console.log('## What applying this changes for a parent — read before approving');
  console.log('  Each corrected row stops claiming an age, which is M1\'s intended outcome (silence,');
  console.log('  not a false statement). Two consequences follow mechanically and are worth stating:');
  console.log(`   • it stops matching EVERY age filter, including under2 — that is the defect being fixed;`);
  console.log(`   • isShowableOnFrontDoor() requires ageMinMonths != null (lib/recommend/three-things.ts:532),`);
  console.log(`     so these ${plan.corrections.length} rows also leave the front-door "three things" pool and the weekly SMS`);
  console.log('     picks until a source publishes a real age. Post-M1 ingests already behave this way for');
  console.log('     new rows; this makes the stored ones consistent with them.');
  console.log('');

  console.log('## Reconciliation against the published figures');
  for (const a of PUBLISHED_ANCHORS) {
    const delta = plan.corrections.length - a.value;
    console.log(`  ${a.label}`);
    console.log(`    published ${a.value} (${a.measuredOn}) · measured here ${plan.corrections.length} · delta ${delta >= 0 ? '+' : ''}${delta}`);
    console.log(`    ${a.note}`);
  }
  console.log('  Why a stored-row count legitimately differs from either figure:');
  for (const note of RECONCILIATION_NOTES) console.log(`    • ${note}`);
  console.log('');

  const fitsCap = plan.corrections.length <= args.maxRows;
  console.log(`row cap for --apply: ${args.maxRows} · this plan: ${plan.corrections.length} → ${fitsCap ? 'fits' : 'EXCEEDS THE CAP, --apply would refuse'}`);
  console.log('');

  // PRE-FLIGHT, BEFORE ANY WRITE CONNECTION EXISTS. correcting-db.ts enforces the same cap
  // mid-batch and rolls back, but discovering it there means the Operator watched a batch abort
  // instead of reading one sentence. Checked here so an over-large plan never opens a writer.
  if (args.apply && !fitsCap) {
    console.error(
      `refusing to apply: the plan is ${plan.corrections.length} rows and the cap is ${args.maxRows}. ` +
        'Re-read the plan above, then pass --max-rows explicitly if it is genuinely what you meant.'
    );
    return 3;
  }

  console.log(`## Every row this would change (${plan.corrections.length})`);
  console.log('   before → after, per row. Nothing outside this list is touched.');

  let applied = 0;
  let moved = 0;
  if (!args.apply) {
    for (const d of plan.corrections) printRow(d);
  } else if (plan.corrections.length === 0) {
    console.log('  (nothing to do — no row matched the plan)');
  } else {
    // ── THE ONLY PLACE A WRITE SURFACE ENTERS THIS PROCESS ─────────────────────────────────
    const { openForCorrection } = await import('./correcting-db');
    const write = await openForCorrection(connectionString, CORRECTION_UPDATE_SQL, { maxRows: args.maxRows });
    try {
      for (const d of plan.corrections) {
        const rows = await write.apply(correctionParams(d.occurrenceId));
        if (rows === 1) applied += 1;
        else moved += 1;
        printRow(d, rows === 1 ? 'applied' : 'SKIPPED — the row changed after the plan was built');
      }
      await write.commit();
      console.log(`\n  committed: ${applied} corrected, ${moved} skipped (row moved under the plan).`);
    } catch (err) {
      await write.rollback();
      console.error('\n  ROLLED BACK — nothing was written. Cause:');
      throw err;
    } finally {
      await write.end();
    }
  }
  console.log('');

  const leaves = plan.decisions.filter((d) => d.action === 'leave');
  if (leaves.length) {
    console.log('## Left alone — samples per reason, so the exclusions are reviewable too');
    for (const [reason] of plan.byReason.filter(([r]) => r !== REASON.CORRECT)) {
      const examples = leaves.filter((d) => d.reason === reason).slice(0, args.samples);
      console.log(`  ${reason}`);
      for (const d of examples) console.log(`      ${JSON.stringify(d.activityName)}  ${d.storedClaim}`);
    }
    console.log('');
  }

  if (args.json) {
    writeFileSync(
      args.json,
      JSON.stringify(
        {
          mode: args.apply ? 'apply' : 'dry-run',
          generatedAt: new Date().toISOString(),
          proxy: ALL_AGES_NOTES_PROXY,
          context,
          archived,
          statement: CORRECTION_UPDATE_SQL,
          counts: {
            inScope: plan.corrections.length,
            parentReachable: plan.correctionsParentReachable,
            applied: args.apply ? applied : null,
            skippedRowMoved: args.apply ? moved : null,
            byReason: plan.byReason,
            byM1Code: plan.byM1Code,
            byTitle: plan.correctionsByTitle,
          },
          anchors: PUBLISHED_ANCHORS,
          reconciliationNotes: RECONCILIATION_NOTES,
          decisions: plan.decisions,
        },
        null,
        2
      )
    );
    console.log(`wrote ${args.json}`);
  }

  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
