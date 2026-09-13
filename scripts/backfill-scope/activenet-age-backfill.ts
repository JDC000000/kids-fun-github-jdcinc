// scripts/backfill-scope/activenet-age-backfill.ts — driver for the ActiveNet age correction:
// stored ages re-derived from ActiveNet's OWN activity age field.
//
//   bash scripts/backfill-scope/activenet-age-backfill.sh                  # DRY RUN (default)
//   bash scripts/backfill-scope/activenet-age-backfill.sh --json plan.json # + full artefact
//   bash scripts/backfill-scope/activenet-age-backfill.sh --apply          # WRITES. Opt-in.
//
// ── THE SAFETY POSTURE IS m1-withheld-backfill.ts's, UNCHANGED ───────────────────────────
// Planning reads production through readonly-db.ts with all three of its locks intact. The
// write surface lives in its own module reached by a DYNAMIC `await import('./correcting-db')`
// that only executes after `--apply` is read off the command line, so a dry run never loads it.
// Even with --apply, identification stays read-only: the batch is planned, printed in full, and
// only then applied through a statement whose WHERE re-states the entire pre-state.
//
// ── WHAT IS DIFFERENT, AND WHY IT IS BETTER ──────────────────────────────────────────────
// §3h could only clear. This sets the SOURCE'S OWN ANSWER, so |Public Skate| keeps its
// all-ages (attributably), Wu's Tai Chi becomes 50+, and Tae Kwon Do Level 1 & 2 becomes the
// 6-13 children's class it always was. The price is that planning now makes NETWORK reads of
// the public portal — gated to the affected rows, cached per activity id, and on the adapter's
// own polite client. A row whose activity the portal will not answer for is reported AMBIGUOUS
// and never guessed at.
//
// DATABASE_URL must be supplied by the caller. Pointing this at production is an explicit act.
import { writeFileSync } from 'node:fs';
import { openReadOnly } from './readonly-db';
import {
  CANDIDATE_ROWS_SQL,
  CORRECTION_UPDATE_SQL,
  REASON,
  activityIdFromSourceRecordId,
  buildPlan,
  candidateParams,
  correctionParams,
  runLookupPhase,
  type RowDecision,
  type StoredAgeRow,
} from './activenet-age-backfill-lib';
import { ActivityAgeResolver, isFatalPortalError } from '../../worker/adapters/activenet/activity-age';
import { RequestBudget } from '../../worker/adapters/activenet/client';
import { getTenantConfig } from '../../worker/adapters/activenet/config';
import { computeAgeBandMatches, type AgeBandRow } from '../../worker/core/age';

/** Ceiling on how many rows one --apply may touch. A logic change that suddenly selects
 *  thousands hits this and stops instead of running. */
const DEFAULT_MAX_ROWS = 800;

/**
 * Ceiling on portal requests while planning.
 *
 * THIS COMMENT USED TO CITE THE ADAPTER'S 1.3% GATE RATE AS THE REASON THE CAP WAS GENEROUS, AND
 * THAT WAS THE BUG. The adapter only looks an activity up when allAgesInPlay() says an all-ages
 * claim is at stake; this tool's candidate query has no such gate, so the adapter's cost model
 * never applied here. Importing the cost model without importing the filter is how a 135-activity
 * job was sized at 600 while actually selecting 6,974. The cap is now sized against the real
 * population the CANDIDATE_ROWS_SQL predicate selects, and the predicate is what bounds the work.
 */
const DEFAULT_MAX_LOOKUPS = 600;

interface Args {
  apply: boolean;
  /** Explicitly acknowledge applying a plan whose lookup phase did not finish. */
  allowPartial: boolean;
  json: string | null;
  maxRows: number;
  maxLookups: number;
  tenant: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    apply: false,
    allowPartial: false,
    json: null,
    maxRows: DEFAULT_MAX_ROWS,
    maxLookups: DEFAULT_MAX_LOOKUPS,
    tenant: 'vancouver',
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--apply' || argv[i] === '--write') args.apply = true;
    else if (argv[i] === '--allow-partial') args.allowPartial = true;
    else if (argv[i] === '--json') args.json = argv[++i] ?? null;
    else if (argv[i] === '--max-rows') args.maxRows = Number(argv[++i]);
    else if (argv[i] === '--max-lookups') args.maxLookups = Number(argv[++i]);
    else if (argv[i] === '--tenant') args.tenant = argv[++i] ?? 'vancouver';
  }
  return args;
}

function describe(d: RowDecision): string {
  const flag = d.admitsTooYoung ? ' !! ADMITS TOO YOUNG' : '';
  return `  ${d.activityName.slice(0, 44).padEnd(44)} ${d.storedClaim.padEnd(28)} -> ${d.sourceClaim ?? '(no answer)'}${flag}`;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is not set. Refusing to guess at a database.');
    return 2;
  }
  const tenant = getTenantConfig(args.tenant);
  if (!tenant) {
    console.error(`unknown tenant "${args.tenant}"`);
    return 2;
  }

  console.log('# ActiveNet age backfill — stored ages vs the source\'s own age field');
  console.log(
    `# MODE: ${args.apply ? '*** APPLY — THIS RUN WRITES TO THE CONNECTED DATABASE ***' : 'DRY RUN (nothing is written; the write module is not loaded)'}\n`
  );

  const db = await openReadOnly(connectionString);
  let plan;
  let stored: StoredAgeRow[];
  let bands: AgeBandRow[];
  const resolver = new ActivityAgeResolver(tenant, {
    budget: new RequestBudget(`${tenant.tenantKey}:backfill`, args.maxLookups),
  });

  try {
    bands = (
      await db.query<{
        id: string;
        key: string;
        lower_months_inclusive: number;
        upper_months_exclusive: number | null;
      }>('SELECT id, key, lower_months_inclusive, upper_months_exclusive FROM age_band ORDER BY lower_months_inclusive')
    ).map((b) => ({
      id: b.id,
      key: b.key,
      lowerMonthsInclusive: Number(b.lower_months_inclusive),
      upperMonthsExclusive: b.upper_months_exclusive === null ? null : Number(b.upper_months_exclusive),
    }));

    const raw = await db.query<{
      occurrence_id: string;
      source_record_id: string;
      activity_name: string;
      has_age_row: boolean;
      age_min_months: number | null;
      age_max_months: number | null;
      age_notes: string | null;
      band_count: number;
    }>(CANDIDATE_ROWS_SQL, candidateParams());

    stored = raw.map((r) => ({
      occurrenceId: r.occurrence_id,
      activityId: activityIdFromSourceRecordId(r.source_record_id),
      activityName: r.activity_name,
      hasAgeRow: r.has_age_row,
      ageMinMonths: r.age_min_months === null ? null : Number(r.age_min_months),
      ageMaxMonths: r.age_max_months === null ? null : Number(r.age_max_months),
      ageNotes: r.age_notes,
      bandCount: Number(r.band_count),
    }));
    console.log(`stored activenet rows with an age claim: ${stored.length}`);

    // ── the network phase, over the read-only plan only ──────────────────────────────────
    const ids = [...new Set(stored.map((s) => s.activityId).filter((n) => Number.isFinite(n) && n > 0))];
    console.log(`distinct activities to ask the source about: ${ids.length} (cap ${args.maxLookups})`);
    const lookup = await runLookupPhase(ids, (id) => resolver.resolve(id), isFatalPortalError);
    if (!lookup.complete) {
      console.error(
        `\n*** LOOKUP PHASE STOPPED EARLY after ${lookup.asked}/${lookup.total} activities: ${lookup.haltReason}`
      );
      console.error('*** Rows for the un-asked activities are AMBIGUOUS — never verified, never written.\n');
    }
    console.log(`source answered for ${lookup.asked}/${lookup.total}\n`);

    plan = buildPlan(stored, lookup);
  } finally {
    await db.end();
  }

  const storedById = new Map(stored.map((s) => [s.occurrenceId, s]));

  console.log('## Plan');
  if (!plan.lookupComplete) {
    console.log('  !! PARTIAL RUN — the source stopped answering part way through.');
    console.log(`  !! asked ${plan.lookupAsked} of ${plan.lookupTotal} activities · halted: ${plan.haltReason}`);
    console.log('  !! The un-asked rows are counted as ambiguous below. This is NOT a clean pass.');
  }
  console.log(`  lookup phase        : ${plan.lookupComplete ? 'COMPLETE' : 'INCOMPLETE'} (${plan.lookupAsked}/${plan.lookupTotal} activities asked)`);
  console.log(`  rows examined       : ${plan.counts.rows}`);
  console.log(`  WOULD WRITE         : ${plan.counts.set}`);
  console.log(`    of which admit someone TOO YOUNG : ${plan.counts.admitsTooYoung}   <-- the child-safety subset`);
  console.log(`    of which were the all-ages claim : ${plan.counts.wasAllAges}`);
  console.log(`    of which STAY all-ages (source confirms) : ${plan.counts.staysAllAges}`);
  console.log(`  leave               : ${plan.counts.leave}`);
  console.log(`  ambiguous           : ${plan.counts.ambiguous}  (never guessed at)`);
  console.log('\n## By reason');
  for (const [reason, n] of Object.entries(plan.byReason).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(5)}  ${reason}`);
  }

  const dangerous = plan.toWrite.filter((d) => d.admitsTooYoung);
  console.log(`\n## What applying this changes for a parent (${dangerous.length} rows stop over-admitting)`);
  for (const d of dangerous.slice(0, 25)) console.log(describe(d));
  if (dangerous.length > 25) console.log(`  … and ${dangerous.length - 25} more`);

  const fitsCap = plan.counts.set <= args.maxRows;
  console.log(`\nrow cap for --apply: ${args.maxRows} · this plan: ${plan.counts.set} → ${fitsCap ? 'fits' : 'EXCEEDS THE CAP, --apply would refuse'}`);

  if (args.json) {
    writeFileSync(args.json, JSON.stringify({ mode: args.apply ? 'apply' : 'dry-run', counts: plan.counts, byReason: plan.byReason, decisions: plan.decisions }, null, 2));
    console.log(`\nfull plan written to ${args.json}`);
  }

  if (!args.apply) {
    console.log('\nDRY RUN — nothing was written. Re-run with --apply to write.');
    return 0;
  }
  if (!fitsCap) {
    console.error(`\nrefusing to apply: plan is ${plan.counts.set} rows, cap is ${args.maxRows}.`);
    return 3;
  }
  // A partial plan is still CORRECT for the rows it did verify, so this is not a hard refusal —
  // it is a refusal to let a partial run be mistaken for a finished one. Acknowledging it is one
  // flag; not noticing it should not be possible.
  if (!plan.lookupComplete && !args.allowPartial) {
    console.error(
      `\nrefusing to apply: the lookup phase stopped after ${plan.lookupAsked}/${plan.lookupTotal} ` +
        `activities (${plan.haltReason}). The ${plan.counts.set} planned corrections are sound, but ` +
        `${plan.counts.ambiguous} rows were never asked about and this run must not be recorded as a ` +
        `complete pass. Re-run when the portal is willing, or pass --allow-partial to apply what was verified.`
    );
    return 5;
  }

  const { openForCorrection } = await import('./correcting-db');
  const write = await openForCorrection(connectionString, CORRECTION_UPDATE_SQL, { maxRows: args.maxRows });
  let applied = 0;
  let moved = 0;
  try {
    for (const d of plan.toWrite) {
      const row = storedById.get(d.occurrenceId)!;
      const bandIds = computeAgeBandMatches(
        { ageMinMonths: d.corrected!.minMonths, ageMaxMonths: d.corrected!.maxMonths },
        bands
      );
      const n = await write.apply(correctionParams(d, row, bandIds));
      if (n === 1) applied += 1;
      else moved += 1;
    }
    await write.commit();
  } catch (err) {
    await write.rollback();
    console.error(`\nrolled back — nothing written: ${(err as Error).message}`);
    return 4;
  } finally {
    await write.end();
  }

  console.log(`\nAPPLIED: ${applied} rows corrected · ${moved} skipped (the row changed since planning — re-run to pick them up)`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
