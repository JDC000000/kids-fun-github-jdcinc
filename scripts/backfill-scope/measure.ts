// scripts/backfill-scope/measure.ts — the §3h backfill-scope measurement driver.
//
// READ-ONLY BY CONSTRUCTION. Its only database access is scripts/backfill-scope/readonly-db.ts,
// which runs every statement inside `BEGIN TRANSACTION READ ONLY` and refuses anything that is
// not a SELECT/WITH. This file imports no writer — not upsertOccurrenceAge, not upsertOccurrence,
// nothing from worker/core/ingest.ts. There is no code path from here to a write, and adding one
// would take a deliberate edit to two files.
//
//   bash scripts/backfill-scope/measure.sh                    # summary table to stdout
//   bash scripts/backfill-scope/measure.sh --json out.json    # + full per-row findings
//   bash scripts/backfill-scope/measure.sh --samples 12       # widen the printed examples
//
// DATABASE_URL must be supplied by the caller. The wrapper does not read a credential store and
// does not default to anything: pointing this at production is an explicit act.
import { writeFileSync } from 'node:fs';
import { isAdultOrSeniorOnly } from '../../lib/search/filters/audience';
import { openReadOnly } from './readonly-db';
import {
  classifyActiveNetTitleGate,
  classifyCityCalendar,
  classifyLibraryTitleAge,
  classifyPerfectMind,
  classifyVenueAllAges,
  hasPositiveClaim,
  type RowFinding,
  type StoredRow,
  type Verdict,
} from './fix-classes';

const VERDICTS: Verdict[] = ['stale_3h', 'ambiguous', 'self_heals', 'agrees', 'not_applicable'];

interface FixClass {
  id: string;
  title: string;
  commits: string;
  /** Source families whose rows this fix can touch. Empty = all. */
  families: string[];
  classify: (row: StoredRow) => RowFinding;
}

const FIX_CLASSES: FixClass[] = [
  { id: '2-venue-allages', title: 'venue open-hours fabricated "All ages"', commits: '959d123', families: ['venue_html'], classify: classifyVenueAllAges },
  { id: '3+6-activenet-title-gate', title: 'ActiveNet title-manufactured age claim (gate + unit/date/grade tuning)', commits: 'f15d6c8, 3b29456', families: ['activenet'], classify: classifyActiveNetTitleGate },
  { id: '4-citycalendar-adult-subject', title: 'CityCalendar catch-all audience on an adult-only subject', commits: 'f59cd71', families: ['city_calendar'], classify: classifyCityCalendar },
  { id: '5-perfectmind-noagerestriction', title: 'PerfectMind vendor "no age restriction" overruling the title', commits: '9f95e31', families: ['perfectmind'], classify: classifyPerfectMind },
  { id: '8-library-title-age', title: 'Library title-blindness (age stated in the title was never read)', commits: 'e277d5c', families: ['library_bibliocommons'], classify: classifyLibraryTitleAge },
];

const ROWS_SQL = `
  SELECT o.id                       AS occurrence_id,
         s.family::text             AS family,
         o.activity_name            AS activity_name,
         o.open_hours_state         AS open_hours_state,
         o.last_checked_at          AS last_checked_at,
         (a.occurrence_id IS NOT NULL) AS has_age_row,
         a.age_min_months           AS age_min_months,
         a.age_max_months           AS age_max_months,
         a.age_notes                AS age_notes,
         COALESCE(array_length(a.age_band_matches, 1), 0) AS band_count
    FROM activity_occurrence o
    JOIN activity_series ser ON ser.id = o.series_id
    JOIN source s            ON s.id  = ser.source_id
    LEFT JOIN occurrence_age a ON a.occurrence_id = o.id
   WHERE o.archived_at IS NULL
`;

/**
 * Class 1 (age-fallback, e88ebe8 + 2e6af0f) has no wording to re-derive — it is a question about
 * which PROVENANCE SHAPES exist in the column, so it is answered in SQL rather than by a
 * classifier. The four shapes are mutually exclusive and between them describe every row the
 * LLM age-fallback job has ever touched.
 */
const LLM_SHAPES_SQL = `
  SELECT COUNT(*) FILTER (WHERE age_notes LIKE 'llm-resolved:%')    AS legacy_resolved,
         COUNT(*) FILTER (WHERE age_notes LIKE 'llm-unresolved:%')  AS legacy_unresolved,
         COUNT(*) FILTER (WHERE age_notes LIKE '%(llm-resolved)')   AS current_resolved,
         COUNT(*) FILTER (WHERE age_notes LIKE '%(llm-unresolved)') AS current_unresolved,
         COUNT(*)                                                   AS total_age_rows
    FROM occurrence_age
`;

/**
 * The catalogue-wide facts the report's own caveats depend on. Measured, never assumed:
 * `source_title` and `description_snippet` are the two columns a re-derivation would most want,
 * and their population count is what decides whether this whole exercise is title-only.
 */
const RETENTION_SQL = `
  SELECT COUNT(*)                          AS occurrences,
         COUNT(source_title)               AS with_source_title,
         COUNT(description_snippet)        AS with_description_snippet,
         COUNT(*) FILTER (WHERE last_checked_at > now() - interval '6 hours') AS reingested_last_6h
    FROM activity_occurrence
   WHERE archived_at IS NULL
`;

interface Args {
  json: string | null;
  samples: number;
  /**
   * The instant the currently-deployed worker build started running — read off
   * `bootedAt` in the worker's own public /healthz. A row whose `last_checked_at` is LATER than
   * this was upserted BY that build, so if it still holds a claim that build's parser would not
   * make, §3h is not a prediction about it: it has already been observed surviving a re-ingest.
   * Without this flag every count is a prediction, which is a materially weaker claim — so the
   * report says which it is rather than blurring the two.
   */
  deployedSince: string | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { json: null, samples: 6, deployedSince: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--json') args.json = argv[i + 1] ?? 'backfill-scope.json';
    if (argv[i] === '--samples') args.samples = Number(argv[i + 1] ?? 6);
    if (argv[i] === '--deployed-since') args.deployedSince = argv[i + 1] ?? null;
  }
  return args;
}

/**
 * How many of these rows the SHIPPED search filter already hides on other grounds.
 *
 * WHY THIS BELONGS IN A BACKFILL SCOPE. `isAdultOrSeniorOnly()` is a HARD exclusion applied at
 * read time, and its first test is the listing TITLE — so a row titled "Adult 19yrs+ Swim" is
 * already kept away from parents no matter how wrong its stored age bounds are. Those rows are
 * still wrong and still worth correcting, but the stale value is not currently reaching anyone.
 * A row like "Lynn Creek Youth Centre … (Grade 4-7)" has no adult word, is NOT excluded, and its
 * stale [0, ∞) claim is the only thing between a parent filtering for under-2s and a youth
 * programme. Same defect, very different urgency — and a scope that does not separate them
 * invites correcting 109 rows at equal risk when a much smaller subset carries the live harm.
 */
function maskedBySearchFilter(rows: StoredRow[], findings: RowFinding[]): number {
  const byId = new Map(rows.map((r) => [r.occurrenceId, r]));
  return findings.filter((f) => {
    const row = byId.get(f.occurrenceId);
    if (!row) return false;
    return isAdultOrSeniorOnly({
      activityName: row.activityName,
      ageMinMonths: row.ageMinMonths,
      ageMaxMonths: row.ageMaxMonths,
      ageNotes: row.ageNotes,
    });
  }).length;
}

/** How many of these findings were upserted by the currently-deployed build. */
function observedCount(findings: RowFinding[], deployedSince: string | null): number | null {
  if (!deployedSince) return null;
  const boundary = Date.parse(deployedSince);
  if (Number.isNaN(boundary)) return null;
  return findings.filter((f) => f.lastCheckedAt !== null && Date.parse(f.lastCheckedAt) > boundary).length;
}

function tally(findings: RowFinding[]): Record<Verdict, number> {
  const counts = Object.fromEntries(VERDICTS.map((v) => [v, 0])) as Record<Verdict, number>;
  for (const f of findings) counts[f.verdict] += 1;
  return counts;
}

function tallyReasons(findings: RowFinding[]): Array<[string, number]> {
  const byReason = new Map<string, number>();
  for (const f of findings) byReason.set(f.reason, (byReason.get(f.reason) ?? 0) + 1);
  return [...byReason.entries()].sort((a, b) => b[1] - a[1]);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is required. This tool never guesses a database.');
    process.exit(2);
  }

  const db = await openReadOnly(connectionString);
  try {
    const [retention] = await db.query<Record<string, string>>(RETENTION_SQL);
    const [llm] = await db.query<Record<string, string>>(LLM_SHAPES_SQL);
    const raw = await db.query<Record<string, unknown>>(ROWS_SQL);

    const rows: StoredRow[] = raw.map((r) => ({
      occurrenceId: String(r.occurrence_id),
      family: String(r.family),
      activityName: String(r.activity_name ?? ''),
      openHoursState: (r.open_hours_state as string | null) ?? null,
      hasAgeRow: Boolean(r.has_age_row),
      ageMinMonths: r.age_min_months === null ? null : Number(r.age_min_months),
      ageMaxMonths: r.age_max_months === null ? null : Number(r.age_max_months),
      ageNotes: (r.age_notes as string | null) ?? null,
      bandCount: Number(r.band_count ?? 0),
      lastCheckedAt: r.last_checked_at ? new Date(r.last_checked_at as string).toISOString() : null,
    }));

    console.log('# §3h backfill scope — measured against the connected database\n');
    if (args.deployedSince) {
      console.log(`deployed build running since      ${args.deployedSince}`);
      console.log('  a finding whose row was re-ingested after that instant has ALREADY survived a');
      console.log('  post-fix re-ingest — for those, §3h is observed rather than predicted.\n');
    } else {
      console.log('no --deployed-since given: every count below is a PREDICTION about the next');
      console.log('re-ingest, not an observation of one.\n');
    }
    console.log('## Re-derivation inputs actually retained');
    console.log(`occurrences (not archived)        ${retention.occurrences}`);
    console.log(`with source_title                 ${retention.with_source_title}`);
    console.log(`with description_snippet          ${retention.with_description_snippet}`);
    console.log(`re-ingested in the last 6h        ${retention.reingested_last_6h}`);
    console.log('');

    console.log('## Class 1 — age-fallback provenance shapes (e88ebe8, 2e6af0f)');
    console.log(`occurrence_age rows total         ${llm.total_age_rows}`);
    console.log(`legacy 'llm-resolved: …'          ${llm.legacy_resolved}   (source wording DESTROYED — re-ingest is the only remedy)`);
    console.log(`legacy 'llm-unresolved: …'        ${llm.legacy_unresolved}   (source wording intact; 2e6af0f fixes these at READ time)`);
    console.log(`current '… (llm-resolved)'        ${llm.current_resolved}`);
    console.log(`current '… (llm-unresolved)'      ${llm.current_unresolved}`);
    console.log('');

    const report: Record<string, unknown> = {
      retention,
      llmShapes: llm,
      classes: {},
    };

    for (const fc of FIX_CLASSES) {
      const scope = rows.filter((r) => fc.families.length === 0 || fc.families.includes(r.family));
      const findings = scope.map(fc.classify);
      const counts = tally(findings);
      const withClaim = scope.filter(hasPositiveClaim).length;

      console.log(`## Class ${fc.id} — ${fc.title}`);
      console.log(`commits ${fc.commits} · families ${fc.families.join(', ') || 'all'}`);
      console.log(`rows in scope ${scope.length} · of which hold a positive age claim ${withClaim}`);
      for (const v of VERDICTS) {
        const seen = observedCount(findings.filter((f) => f.verdict === v), args.deployedSince);
        const suffix = seen === null ? '' : `   (${seen} re-ingested by the deployed build — observed, not predicted)`;
        console.log(`  ${v.padEnd(16)} ${counts[v]}${suffix}`);
      }
      const staleFindings = findings.filter((f) => f.verdict === 'stale_3h' || f.verdict === 'ambiguous');
      if (staleFindings.length) {
        const masked = maskedBySearchFilter(scope, staleFindings);
        console.log(`  of the ${staleFindings.length} stale_3h+ambiguous rows, ${masked} are ALREADY hidden by the shipped`);
        console.log(`  adult/senior search exclusion; ${staleFindings.length - masked} are reachable by a parent today.`);
      }
      console.log('  reasons:');
      for (const [reason, n] of tallyReasons(findings)) {
        const seen = observedCount(findings.filter((f) => f.reason === reason), args.deployedSince);
        console.log(`    ${String(n).padStart(6)}${seen === null ? '' : ` (${String(seen).padStart(5)} observed)`}  ${reason}`);
      }

      const notable = findings.filter((f) => f.verdict === 'stale_3h' || f.verdict === 'ambiguous').slice(0, args.samples);
      if (notable.length) {
        console.log('  samples:');
        for (const f of notable) {
          console.log(`    [${f.verdict}] ${JSON.stringify(f.activityName)}`);
          console.log(`        stored : ${f.storedClaim}`);
          console.log(`        derived: ${f.derivedClaim}`);
        }
      }
      console.log('');

      (report.classes as Record<string, unknown>)[fc.id] = {
        title: fc.title,
        commits: fc.commits,
        families: fc.families,
        rowsInScope: scope.length,
        rowsWithPositiveClaim: withClaim,
        counts,
        deployedSince: args.deployedSince,
        observedByDeployedBuild: Object.fromEntries(
          VERDICTS.map((v) => [v, observedCount(findings.filter((f) => f.verdict === v), args.deployedSince)])
        ),
        staleOrAmbiguousMaskedBySearchFilter: maskedBySearchFilter(scope, findings.filter((f) => f.verdict === 'stale_3h' || f.verdict === 'ambiguous')),
        reasons: tallyReasons(findings),
        findings: findings.filter((f) => f.verdict !== 'not_applicable'),
      };
    }

    if (args.json) {
      writeFileSync(args.json, JSON.stringify(report, null, 2));
      console.log(`wrote ${args.json}`);
    }
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
