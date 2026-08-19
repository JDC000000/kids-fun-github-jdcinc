// scripts/backfill-scope/review-batch.ts — build the §3h ActiveNet title-gate REVIEW-CANDIDATE
// queue from a recheck report, and (optionally) cross-check it against production READ-ONLY.
//
//   bash scripts/backfill-scope/review-batch.sh --recheck <recheck.json>              # offline
//   DATABASE_URL=... bash scripts/backfill-scope/review-batch.sh --recheck <r.json> --live
//
// NO WRITES, ANYWHERE. This tool proposes no corrected value and touches no production row. Its
// only database access is scripts/backfill-scope/readonly-db.ts — three independent locks, and
// this file weakens none of them: it issues one parameterised SELECT and imports no writer. The
// output is a queue for a human to work, which is recommendation (c) in
// docs/worker-fix-backfill-scope.md §3.3/§5 and the only mechanism with any sign-off behind it.
//
// ── WHY THE DEFAULT IS OFFLINE, AND THE LIVE QUERY IS THE CROSS-CHECK ────────────────────────
//
// The four inputs `isAdultOrSeniorOnly()` reads — title, age_min_months, age_max_months,
// age_notes — are ALL recoverable from the recheck's own `storedClaim` rendering (see
// parseStoredClaim). So masking can be computed from the snapshot alone, and that is what the
// artefact is built from, deliberately:
//
//   • REPRODUCIBLE. The reviewer of this unit re-derives the counts from the same JSON and gets
//     byte-identical output. A number that can only be reproduced by re-querying a live, moving
//     database is a number nobody can check.
//   • ATTRIBUTABLE. The 633/1,534/112 split was decided by the classifier against the snapshot.
//     Computing masking against a row that has since been re-ingested would mix two moments and
//     silently answer a different question than the one the bucket assignment asked.
//
// `--live` then queries production for the same ids and recomputes masking on the CURRENT row,
// and reports the disagreement count. That is the honest way round: the snapshot is the basis,
// and drift is measured and published rather than assumed to be zero.
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openReadOnly } from './readonly-db';
import {
  BOUNDS_DIFFER_REASON,
  CANDIDATE_REASON,
  SOURCE_UNKNOWN_REASON,
  TITLE_GATE_CLASS_ID,
  buildReviewRows,
  groupForReview,
  maskedBySearchFilter,
  partitionAmbiguous,
  summariseBucket,
  tallySeverity,
  toCsv,
  toGroupCsv,
  toMarkdown,
  type BatchReport,
  type LiveCrossCheck,
  type RecheckFinding,
} from './review-batch-lib';

interface Args {
  recheck: string;
  outDir: string;
  classId: string;
  live: boolean;
  deployedSince: string | null;
  driftSamples: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    recheck: '',
    outDir: '.backfill-scope-review',
    classId: TITLE_GATE_CLASS_ID,
    live: false,
    deployedSince: null,
    driftSamples: 10,
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--recheck') args.recheck = argv[i + 1] ?? '';
    if (argv[i] === '--out-dir') args.outDir = argv[i + 1] ?? args.outDir;
    if (argv[i] === '--class') args.classId = argv[i + 1] ?? args.classId;
    if (argv[i] === '--live') args.live = true;
    if (argv[i] === '--deployed-since') args.deployedSince = argv[i + 1] ?? null;
    if (argv[i] === '--drift-samples') args.driftSamples = Number(argv[i + 1] ?? 10);
  }
  return args;
}

interface RecheckClass {
  deployedSince?: string | null;
  counts?: Record<string, number>;
  reasons?: Array<[string, number]>;
  findings?: RecheckFinding[];
}

interface LiveRow {
  occurrence_id: string;
  activity_name: string;
  age_min_months: number | null;
  age_max_months: number | null;
  age_notes: string | null;
}

/** Read-only, parameterised, one statement. `archived_at IS NULL` mirrors measure.ts's scope. */
const LIVE_SQL = `
  SELECT o.id            AS occurrence_id,
         o.activity_name AS activity_name,
         a.age_min_months AS age_min_months,
         a.age_max_months AS age_max_months,
         a.age_notes      AS age_notes
    FROM activity_occurrence o
    LEFT JOIN occurrence_age a ON a.occurrence_id = o.id
   WHERE o.archived_at IS NULL
     AND o.id = ANY($1::uuid[])
`;

async function crossCheckLive(
  connectionString: string,
  rows: ReturnType<typeof buildReviewRows>,
  driftSamples: number,
  checkedAt: string
): Promise<LiveCrossCheck> {
  const db = await openReadOnly(connectionString);
  try {
    const live = await db.query<LiveRow>(LIVE_SQL, [rows.map((r) => r.occurrenceId)]);
    const byId = new Map(live.map((r) => [r.occurrence_id, r]));
    let maskedLive = 0;
    let drift = 0;
    const driftExamples: string[] = [];
    for (const r of rows) {
      const l = byId.get(r.occurrenceId);
      if (!l) continue;
      // `hasAgeRow`/`bandCount` are carried by StoredClaim but are NOT read by
      // isAdultOrSeniorOnly(); only the three age-signal fields and the title are. They are
      // filled from the live row where knowable and left at their neutral values otherwise,
      // rather than guessed, so nothing here can quietly influence the masking answer.
      const liveMasked = maskedBySearchFilter(
        {
          hasAgeRow: l.age_min_months !== null || l.age_max_months !== null || l.age_notes !== null,
          ageMinMonths: l.age_min_months,
          ageMaxMonths: l.age_max_months,
          bandCount: 0,
          ageNotes: l.age_notes,
        },
        l.activity_name
      );
      if (liveMasked) maskedLive += 1;
      if (liveMasked !== r.maskedBySearchFilter) {
        drift += 1;
        if (driftExamples.length < driftSamples) {
          driftExamples.push(
            `${r.occurrenceId} ${JSON.stringify(r.activityName)} — snapshot masked=${r.maskedBySearchFilter}, live masked=${liveMasked}`
          );
        }
      }
    }
    const found = rows.filter((r) => byId.has(r.occurrenceId)).length;
    return {
      rowsFound: found,
      rowsMissing: rows.length - found,
      maskedLive,
      parentReachableLive: found - maskedLive,
      maskingDrift: drift,
      driftExamples,
      checkedAt,
    };
  } finally {
    await db.end();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.recheck) {
    console.error('--recheck <path-to-recheck.json> is required. This tool never guesses its input.');
    process.exit(2);
  }

  const report = JSON.parse(readFileSync(args.recheck, 'utf8')) as { classes?: Record<string, RecheckClass> };
  const cls = report.classes?.[args.classId];
  if (!cls?.findings) {
    console.error(`no findings for class ${args.classId} in ${args.recheck}`);
    process.exit(2);
    return;
  }
  const deployedSince = args.deployedSince ?? cls.deployedSince ?? null;

  const part = partitionAmbiguous(cls.findings);
  // The partition must be TOTAL. A reason this file does not know about would otherwise vanish
  // from the accounting and the split would quietly stop summing to the headline.
  if (part.unclassified.length > 0) {
    const unknown = [...new Set(part.unclassified.map((f) => f.reason))].join(', ');
    console.error(
      `refusing to build a queue: ${part.unclassified.length} ambiguous rows carry unrecognised reasons (${unknown}). ` +
        'The bucket split would not be exhaustive, so the "633 not 2,279" claim could not be made honestly.'
    );
    process.exit(3);
    return;
  }
  // Cross-check the partition against the recheck's OWN reason tally, rather than trusting our
  // filter. Two independent derivations of the same three numbers.
  const declared = new Map(cls.reasons ?? []);
  const mismatches = [
    [CANDIDATE_REASON, part.candidates.length],
    [SOURCE_UNKNOWN_REASON, part.sourceUnknown.length],
    [BOUNDS_DIFFER_REASON, part.boundsDiffer.length],
  ].filter(([reason, n]) => declared.has(reason as string) && declared.get(reason as string) !== n);
  if (mismatches.length) {
    console.error(`bucket counts disagree with the recheck's own reasons tally: ${JSON.stringify(mismatches)}`);
    process.exit(3);
    return;
  }

  const queue = buildReviewRows(part.candidates, deployedSince);
  const buckets = {
    candidates: summariseBucket(CANDIDATE_REASON, part.candidates, deployedSince),
    sourceUnknown: summariseBucket(SOURCE_UNKNOWN_REASON, part.sourceUnknown, deployedSince),
    boundsDiffer: summariseBucket(BOUNDS_DIFFER_REASON, part.boundsDiffer, deployedSince),
  };

  let liveCrossCheck: LiveCrossCheck | null = null;
  if (args.live) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      console.error('--live requires DATABASE_URL. This tool never reads a credential store and never defaults.');
      process.exit(2);
      return;
    }
    liveCrossCheck = await crossCheckLive(connectionString, queue, args.driftSamples, new Date().toISOString());
  }

  const batch: BatchReport = {
    classId: args.classId,
    generatedFrom: args.recheck,
    deployedSince,
    headlineAmbiguous: part.totalAmbiguous,
    buckets,
    unclassifiedAmbiguous: part.unclassified.length,
    queue,
    groups: groupForReview(queue),
    severityTally: tallySeverity(queue),
    liveCrossCheck,
  };

  mkdirSync(args.outDir, { recursive: true });
  const jsonPath = join(args.outDir, 'titlegate-review-batch.json');
  const csvPath = join(args.outDir, 'titlegate-review-batch.csv');
  const groupCsvPath = join(args.outDir, 'titlegate-review-groups.csv');
  const mdPath = join(args.outDir, 'titlegate-review-batch.md');
  writeFileSync(jsonPath, `${JSON.stringify(batch, null, 2)}\n`);
  writeFileSync(csvPath, toCsv(queue));
  writeFileSync(groupCsvPath, toGroupCsv(batch.groups));
  writeFileSync(mdPath, toMarkdown(batch));

  console.log(`§3h ActiveNet title-gate — REVIEW-CANDIDATE batch   (class ${args.classId})`);
  console.log(`  source ${args.recheck}${deployedSince ? ` · deployed build booted ${deployedSince}` : ''}`);
  console.log('');
  console.log(`  headline ambiguous ......................... ${part.totalAmbiguous}`);
  console.log(`    ${String(buckets.sourceUnknown.rows).padStart(5)}  ${SOURCE_UNKNOWN_REASON}   NOT QUEUED`);
  console.log(`    ${String(buckets.candidates.rows).padStart(5)}  ${CANDIDATE_REASON}   ← THE QUEUE`);
  console.log(`    ${String(buckets.boundsDiffer.rows).padStart(5)}  ${BOUNDS_DIFFER_REASON}   NOT QUEUED`);
  console.log('');
  console.log(`  within the ${buckets.candidates.rows} candidates (= ${batch.groups.length} distinct review decisions):`);
  console.log(`    parent-reachable today ................... ${buckets.candidates.parentReachable}`);
  console.log(`    already masked by isAdultOrSeniorOnly() .. ${buckets.candidates.masked}`);
  if (buckets.candidates.reIngestedByDeployedBuild !== null) {
    console.log(`    re-ingested by the deployed build ........ ${buckets.candidates.reIngestedByDeployedBuild} (observed, not predicted)`);
  }
  console.log('');
  console.log('  severity mix:');
  for (const [sev, n] of batch.severityTally) console.log(`    ${String(n).padStart(5)}  ${sev}`);
  console.log('');
  console.log(`  characterised but NOT queued: ${buckets.sourceUnknown.rows} source-unknown ` +
    `(${buckets.sourceUnknown.parentReachable} parent-reachable), ` +
    `${buckets.boundsDiffer.rows} bounds-differ (${buckets.boundsDiffer.parentReachable} parent-reachable)`);
  if (liveCrossCheck) {
    console.log('');
    console.log(`  live cross-check: ${liveCrossCheck.rowsFound} found / ${liveCrossCheck.rowsMissing} missing · ` +
      `masking drift vs snapshot: ${liveCrossCheck.maskingDrift}`);
  }
  console.log('');
  console.log(`  wrote ${jsonPath}`);
  console.log(`  wrote ${csvPath}`);
  console.log(`  wrote ${groupCsvPath}`);
  console.log(`  wrote ${mdPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
