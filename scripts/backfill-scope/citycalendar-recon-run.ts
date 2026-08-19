// scripts/backfill-scope/citycalendar-recon-run.ts — driver for the §3.4 CityCalendar
// targeted-re-ingest RECONCILIATION. Fetch → drive the real adapter → join → diff → render.
//
// ── THIS TOOL CANNOT WRITE. NOT "DOES NOT" — CANNOT. ──────────────────────────────────────
// Its only database access is scripts/backfill-scope/readonly-db.ts, whose three independent
// locks (§11: server-side `BEGIN TRANSACTION READ ONLY`, a statement-shape guard that also
// rejects data-modifying CTEs and stacked statements, and no imported write surface) are
// reused here UNCHANGED. This file imports no writer: not `upsertOccurrenceAge`, not
// `upsertOccurrence`, nothing from worker/core/ingest.ts. The deliverable is a REPORT.
// Correcting a row is a separate act requiring the Operator's sign-off, and no code path from
// here reaches one.
//
//   bash scripts/backfill-scope/citycalendar-recon.sh                        # summary to stdout
//   bash scripts/backfill-scope/citycalendar-recon.sh --json out.json        # + per-row findings
//   bash scripts/backfill-scope/citycalendar-recon.sh --save-feed feed.json  # capture the feed
//   bash scripts/backfill-scope/citycalendar-recon.sh --feed-file feed.json  # replay a capture
//
// DATABASE_URL must be supplied by the caller. The wrapper reads no credential store and
// defaults to nothing: pointing this at production is an explicit act.
//
// ── WHY --save-feed / --feed-file EXIST ───────────────────────────────────────────────────
// The whole point of this class is that the feed is ROLLING. Two runs an hour apart see
// different events, so a report that only says "we fetched it" is not independently
// re-verifiable — the reviewer would be checking a different feed. `--save-feed` writes the
// exact bytes the run classified; `--feed-file` replays them. Every claim in the JSON report is
// therefore reproducible against a fixed input, which is what the review discipline on this
// project actually requires.
import { readFileSync, writeFileSync } from 'node:fs';
import { CityCalendarAdapter } from '../../worker/adapters/citycalendar';
import { getCityCalendar } from '../../worker/adapters/citycalendar/config';
import type { StructuredRecord } from '../../worker/core/adapter';
import { openReadOnly } from './readonly-db';
import {
  OPEN_POPULATION_BUCKET,
  reconcileAll,
  tallyReasons,
  tallyVerdicts,
  type ReconFinding,
  type StoredCityCalendarRow,
  type TrumbaEventLike,
} from './citycalendar-recon';

const CALENDAR_KEY = 'vancouver';

/**
 * Identify this run on the wire. worker/health/policy.ts's `USER_AGENT` is module-private, and
 * importing `politeFetch` to borrow it would drag in the crawl-backoff state store and the
 * per-source rate limiter — process-global mutable state that has no business inside a
 * one-shot measurement. A single manual GET against a public JSON feed, identified and
 * attributed, is the smaller and more honest thing.
 */
const RECON_USER_AGENT = 'kf-backfill-scope-recon/1.0 (+https://vancouver.ca; read-only reconciliation)';

/**
 * Every non-archived city_calendar occurrence, joined to its occurrence_age row if one exists.
 * Deliberately the SAME scope predicate measure.ts uses (`archived_at IS NULL`) so the row
 * count reconciles against docs §3.4's 49 exactly rather than approximately.
 * `ORDER BY o.id` makes the report byte-stable across runs.
 */
const ROWS_SQL = `
  SELECT o.id                       AS occurrence_id,
         o.source_record_id         AS source_record_id,
         o.activity_name            AS activity_name,
         o.last_checked_at          AS last_checked_at,
         (a.occurrence_id IS NOT NULL) AS has_age_row,
         a.age_min_months           AS age_min_months,
         a.age_max_months           AS age_max_months,
         a.age_notes                AS age_notes,
         COALESCE(array_length(a.age_band_matches, 1), 0) AS band_count,
         (SELECT MAX(p.fetched_at)
            FROM provenance p
           WHERE p.occurrence_id = o.id
             AND p.field = 'age_min_months')            AS last_resolved_age_fact_at
    FROM activity_occurrence o
    JOIN activity_series ser ON ser.id = o.series_id
    JOIN source s            ON s.id  = ser.source_id
    LEFT JOIN occurrence_age a ON a.occurrence_id = o.id
   WHERE s.family::text = 'city_calendar'
     AND o.archived_at IS NULL
   ORDER BY o.id
`;

/**
 * Context the report's own caveats depend on, measured rather than assumed: how many
 * city_calendar rows exist at all, how many are archived out of the scope above, and how many
 * still carry no `source_record_id` (migration 0011 added the column, so pre-0011 rows cannot
 * be joined at all — a join failure that must be reported as its own reason, not as absence
 * from the feed).
 */
const SCOPE_SQL = `
  SELECT COUNT(*)                                                        AS all_rows,
         COUNT(*) FILTER (WHERE o.archived_at IS NOT NULL)               AS archived_rows,
         COUNT(*) FILTER (WHERE o.archived_at IS NULL
                            AND o.source_record_id IS NULL)              AS unjoinable_rows
    FROM activity_occurrence o
    JOIN activity_series ser ON ser.id = o.series_id
    JOIN source s            ON s.id  = ser.source_id
   WHERE s.family::text = 'city_calendar'
`;

interface Args {
  json: string | null;
  feedFile: string | null;
  saveFeed: string | null;
  samples: number;
  /**
   * `bootedAt` from the worker's own public /healthz. Same role as measure.sh's flag: a row
   * last upserted AFTER this instant was written BY the deployed build, which turns statements
   * about it from predictions into observations. Without it the report says so.
   */
  deployedSince: string | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { json: null, feedFile: null, saveFeed: null, samples: 12, deployedSince: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--json') args.json = argv[i + 1] ?? 'citycalendar-recon.json';
    if (argv[i] === '--feed-file') args.feedFile = argv[i + 1] ?? null;
    if (argv[i] === '--save-feed') args.saveFeed = argv[i + 1] ?? null;
    if (argv[i] === '--samples') args.samples = Number(argv[i + 1] ?? 12);
    if (argv[i] === '--deployed-since') args.deployedSince = argv[i + 1] ?? null;
  }
  return args;
}

/**
 * Fetch the whole published feed — NOT `adapter.fetch()`.
 *
 * Three reasons, all of which would corrupt the measurement rather than merely inconvenience it:
 *   1. `adapter.fetch()` slices to `config.liveEventsLimit` (40). That cap is right for an
 *      ingest dry-run and catastrophic for a reconciliation: a feed that grew past 40 would
 *      silently turn joinable rows into `no-live-counterpart`, i.e. manufacture the exact
 *      outcome this report must not manufacture. The cap is checked and LOGGED below instead.
 *   2. It is gated behind `KIDS_FUN_LIVE_CITY_CALENDARS`, an ingest-enablement switch. Setting
 *      an ingest flag to run a read-only measurement is the wrong shape of act.
 *   3. It routes through `politeFetch`, whose crawl-backoff store and rate limiter are
 *      process-global mutable state (see RECON_USER_AGENT above).
 *
 * What is NOT re-implemented is anything that decides an age: `extract()` — and therefore the
 * private `ageText()`, `isCatchAllAudience()` and `namesAdultOnlySubject()` that carry fix
 * `f59cd71` — is driven for real, on the real events, below.
 */
async function fetchFeed(feedUrl: string): Promise<TrumbaEventLike[]> {
  const response = await fetch(feedUrl, {
    headers: { accept: 'application/json', 'user-agent': RECON_USER_AGENT },
  });
  if (!response.ok) {
    throw new Error(`City calendar feed fetch failed: ${response.status} ${response.statusText}`);
  }
  const body: unknown = await response.json();
  if (!Array.isArray(body)) throw new Error('City calendar feed did not return a JSON array.');
  return body as TrumbaEventLike[];
}

function loadFeedFile(path: string): TrumbaEventLike[] {
  const body: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(body)) throw new Error(`${path} does not contain a JSON array.`);
  return body as TrumbaEventLike[];
}

function pct(n: number, total: number): string {
  return total === 0 ? 'n/a' : `${((n / total) * 100).toFixed(1)}%`;
}

function printFinding(f: ReconFinding): void {
  console.log(`    [${f.liveVerdict}/${f.remedy}] ${JSON.stringify(f.activityName)}`);
  console.log(`        occurrence  : ${f.occurrenceId}  eventID=${f.sourceRecordId ?? 'NULL'}`);
  console.log(`        stored      : ${f.storedClaim}  (provenance: ${f.storedProvenance})`);
  console.log(`        derived     : ${f.derivedClaim}`);
  console.log(`        reason      : ${f.reason}`);
  if (f.liveEvidence) {
    const e = f.liveEvidence;
    console.log(
      `        live        : Audiences=${e.audiencesField === null ? 'ABSENT' : JSON.stringify(e.audiencesField)}` +
        ` descChars=${e.descriptionChars} extractable=${e.extractable}` +
        ` suppressionFired=${e.suppressionFired === null ? 'undeterminable' : e.suppressionFired}`
    );
  }
  const o = f.observation;
  console.log(
    `        lastChecked : ${f.lastCheckedAt ?? 'NULL'}` +
      ` byDeployedBuild=${o.observedByDeployedBuild === null ? 'unknown' : o.observedByDeployedBuild}` +
      ` lastResolvedAgeFact=${o.lastResolvedAgeFactAt ?? 'never'}` +
      ` lastIngestResolvedNoAge=${o.lastIngestRecordedNoResolvedAge === null ? 'unknown' : o.lastIngestRecordedNoResolvedAge}`
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is required. This tool never guesses a database.');
    process.exit(2);
  }
  const config = getCityCalendar(CALENDAR_KEY);
  if (!config) {
    console.error(`No city calendar config for key ${CALENDAR_KEY}.`);
    process.exit(2);
    return;
  }

  // The feed first: if it is unreachable there is no reconciliation to run, and no reason to
  // have opened a connection to production at all.
  const events = args.feedFile ? loadFeedFile(args.feedFile) : await fetchFeed(config.feedUrl);
  if (args.saveFeed) writeFileSync(args.saveFeed, JSON.stringify(events, null, 2));

  // THE REAL ADAPTER, THE REAL EVENTS, ONE CALL — exactly as worker/core/ingest.ts drives it.
  const adapter = new CityCalendarAdapter(config);
  const records: StructuredRecord[] = adapter.extract(events as unknown[]);

  const db = await openReadOnly(connectionString);
  let scope: Record<string, string>;
  let rows: StoredCityCalendarRow[];
  try {
    [scope] = await db.query<Record<string, string>>(SCOPE_SQL);
    const raw = await db.query<Record<string, unknown>>(ROWS_SQL);
    rows = raw.map((r) => ({
      occurrenceId: String(r.occurrence_id),
      sourceRecordId: (r.source_record_id as string | null) ?? null,
      activityName: String(r.activity_name ?? ''),
      hasAgeRow: Boolean(r.has_age_row),
      ageMinMonths: r.age_min_months === null ? null : Number(r.age_min_months),
      ageMaxMonths: r.age_max_months === null ? null : Number(r.age_max_months),
      ageNotes: (r.age_notes as string | null) ?? null,
      bandCount: Number(r.band_count ?? 0),
      lastCheckedAt: r.last_checked_at ? new Date(r.last_checked_at as string).toISOString() : null,
      lastResolvedAgeFactAt: r.last_resolved_age_fact_at
        ? new Date(r.last_resolved_age_fact_at as string).toISOString()
        : null,
    }));
  } finally {
    await db.end();
  }

  const { findings, duplicateEventIds } = reconcileAll(rows, events, records, args.deployedSince);
  const counts = tallyVerdicts(findings);
  const openPopulation = findings.filter((f) => f.priorBucket === OPEN_POPULATION_BUCKET);
  const noCounterpart = findings.filter((f) => f.liveVerdict === 'cannot-speak');
  const contradicted = findings.filter((f) => f.liveVerdict === 'contradicts');
  const needsWrite = findings.filter((f) => f.remedy === 'needs_operator_write_3h');

  console.log('# §3.4 CityCalendar targeted re-ingest — RECONCILIATION (read-only, no row written)\n');
  if (args.deployedSince) {
    console.log(`deployed build running since      ${args.deployedSince}`);
    console.log('  a row last upserted after that instant was written BY the deployed build, so');
    console.log('  what it holds is an OBSERVATION of that build rather than a prediction.\n');
  } else {
    console.log('no --deployed-since given: statements about what a re-ingest would do are');
    console.log('PREDICTIONS, not observations of one.\n');
  }
  console.log('## Inputs');
  console.log(`feed                              ${args.feedFile ? `replayed from ${args.feedFile}` : config.feedUrl}`);
  console.log(`events in feed                    ${events.length}`);
  console.log(`events the shipped extract() kept ${records.length}`);
  if (config.liveEventsLimit !== undefined && events.length > config.liveEventsLimit) {
    console.log(
      `NOTE  the feed carries ${events.length} events, MORE than config.liveEventsLimit=${config.liveEventsLimit}.` +
        ' adapter.fetch() would have sliced; this reconciliation deliberately did not.'
    );
  }
  if (duplicateEventIds.length) {
    console.log(`NOTE  duplicate eventIDs in the feed (first wins): ${duplicateEventIds.join(', ')}`);
  }
  console.log(`city_calendar rows, all           ${scope.all_rows}`);
  console.log(`  archived (out of scope)         ${scope.archived_rows}`);
  console.log(`  in scope (archived_at IS NULL)  ${rows.length}`);
  console.log(`  of those, no source_record_id   ${scope.unjoinable_rows}`);
  console.log('');

  console.log('## Verdicts — does the LIVE feed confirm, contradict, or fail to speak to the stored claim?');
  console.log(`confirms                          ${counts.confirms}   (${pct(counts.confirms, rows.length)})`);
  console.log(`contradicts                       ${counts.contradicts}   (${pct(counts.contradicts, rows.length)})`);
  console.log(`cannot-speak                      ${counts.cannotSpeak}   (${pct(counts.cannotSpeak, rows.length)})`);
  console.log('');
  console.log('  cannot-speak is NOT agreement. A rolling calendar feed drops past-dated');
  console.log('  occurrences (docs §3.4), so absence is a property of the feed window and');
  console.log('  carries no information about the row in either direction.');
  console.log('');
  console.log(`of the contradictions, needing an Operator write (§3h stale): ${needsWrite.length}`);
  console.log(`                       self-healing on the next re-ingest  : ${contradicted.length - needsWrite.length}`);
  console.log('');

  console.log('## Reasons');
  for (const [reason, n] of tallyReasons(findings)) {
    console.log(`  ${String(n).padStart(4)}  ${reason}`);
  }
  console.log('');

  if (args.deployedSince) {
    const observed = findings.filter((f) => f.observation.observedByDeployedBuild === true);
    const observedNoResolvedAge = observed.filter((f) => f.observation.lastIngestRecordedNoResolvedAge === true);
    console.log('## What the deployed build has already been observed doing');
    console.log(`rows it upserted                  ${observed.length} of ${rows.length}`);
    console.log(`  of those, its own most recent run recorded NO resolved age fact: ${observedNoResolvedAge.length}`);
    console.log('  (worker/core/ingest.ts:303 appends an age_min_months provenance row only when');
    console.log('   ageParse.resolved, so this is observed from the provenance table rather than');
    console.log('   inferred from the value the row happens to hold now.)');
    console.log('');
  }

  console.log(`## The §6 open population — prior bucket "${OPEN_POPULATION_BUCKET}"`);
  console.log(`rows in that bucket                ${openPopulation.length}`);
  for (const [reason, n] of tallyReasons(openPopulation)) {
    console.log(`  ${String(n).padStart(4)}  ${reason}`);
  }
  console.log('');
  console.log('  row by row:');
  for (const f of openPopulation) printFinding(f);
  console.log('');

  if (contradicted.length) {
    console.log('## Every contradiction, in full');
    for (const f of contradicted.slice(0, args.samples)) printFinding(f);
    if (contradicted.length > args.samples) {
      console.log(`  … ${contradicted.length - args.samples} more (raise --samples, or read the --json)`);
    }
    console.log('');
  }

  console.log('## No live counterpart');
  console.log(`rows                              ${noCounterpart.length}`);
  for (const [reason, n] of tallyReasons(noCounterpart)) {
    console.log(`  ${String(n).padStart(4)}  ${reason}`);
  }
  console.log('');
  console.log('NOTHING HAS BEEN WRITTEN. This is a report. A correction to any row above needs');
  console.log('the Operator\'s sign-off, and this tool has no code path that could apply one.');

  if (args.json) {
    const report = {
      deployedSince: args.deployedSince,
      feedUrl: args.feedFile ? `file:${args.feedFile}` : config.feedUrl,
      feedEvents: events.length,
      feedEventsExtractable: records.length,
      duplicateEventIds,
      scope,
      rowsInScope: rows.length,
      counts,
      remedies: {
        needs_operator_write_3h: needsWrite.length,
        self_heals_on_reingest: findings.filter((f) => f.remedy === 'self_heals_on_reingest').length,
        none: findings.filter((f) => f.remedy === 'none').length,
        unknown: findings.filter((f) => f.remedy === 'unknown').length,
      },
      reasons: tallyReasons(findings),
      openPopulation: {
        bucket: OPEN_POPULATION_BUCKET,
        rows: openPopulation.length,
        reasons: tallyReasons(openPopulation),
        findings: openPopulation,
      },
      noLiveCounterpart: { rows: noCounterpart.length, reasons: tallyReasons(noCounterpart) },
      findings,
    };
    writeFileSync(args.json, JSON.stringify(report, null, 2));
    console.log(`\nwrote ${args.json}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
