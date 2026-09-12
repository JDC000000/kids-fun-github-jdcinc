// scripts/backfill-scope/m1-withheld-backfill-lib.ts — the decision half of the M1
// `no-age-restriction-withheld` correction. PURE: no database, no network, no clock, no
// process.argv. Every rule about WHICH rows are in scope and WHAT their corrected state is
// lives here and is unit-testable without a connection; the runner only moves bytes.
//
// ── WHAT THIS CORRECTS, AND WHY A BACKFILL IS NEEDED AT ALL ──────────────────────────────
// M1 (`3865669` on main, originally `ba3901a`) stopped PerfectMind's `NoAgeRestriction`
// booking flag from being published as an age claim. A worker-side parser fix changes what the
// ingest path WRITES; it does not change what is already written — and when the fixed parser
// concludes "no claim", worker/core/ingest.ts:294 writes NOTHING rather than clearing the stale
// value:
//
//     if (ageParse) { await upsertOccurrenceAge(...); }
//
// So a row that was written as `All ages` → [0, ∞) before M1 keeps that claim through every
// future re-ingest, forever. That is docs/worker-fix-backfill-scope.md §3h, and it is why these
// rows need a write rather than patience. The claim they hold is the exact defect M1 exists to
// stop: a booking-configuration flag read as "suitable for a baby", which matches every age band
// including under2 and puts adult lane swim in front of a parent filtering for a toddler.
//
// ── THE THREE-WAY SPLIT, AND WHY ONLY ONE ARM IS TOUCHED ─────────────────────────────────
// M1's resolveAgeText() answers a flagged record in three ways, and they are three different
// facts about the world, not three shades of one:
//
//   no-age-restriction-contradicted   the title states an age the flag contradicts. Also stale,
//                                     also needs correcting — but it is §3.5's separately
//                                     measured 109-row population with its own review history.
//                                     DELIBERATELY OUT OF SCOPE HERE: counted and reported,
//                                     never written. Mixing two populations into one batch is
//                                     how a reviewed correction becomes an unreviewed one.
//   title-publishes-all-ages          the VENUE published "All ages" in its own title copy
//                                     ("$2 Queer All Ages Skate"). The stored all-ages claim is
//                                     CORRECT and is what M1 still emits today. Touching it
//                                     would delete a real claim — the mirror image of the defect.
//   no-age-restriction-withheld       the flag was the ONLY all-ages evidence. THIS is the
//                                     in-scope set: rows whose claim was manufactured from a
//                                     booking flag and which M1 would never make today.
//
// ── HOW A STORED ROW IS TIED BACK TO THE FLAG ────────────────────────────────────────────
// `NoAgeRestriction` is not retained in any column (no table stores the vendor payload — see
// migrations 0004/0005/0006). The proxy documented in fix-classes.ts is used unchanged:
//
//     occurrence_age.age_notes = 'all-ages'  ⇒  this row came from an all-ages ageText
//
// because worker/core/age.ts writes that literal from exactly one branch, and PerfectMind's only
// all-ages-emitting paths are the flag branch and (post-M1) the title carve-out — which this
// classifier then separates by driving the REAL parser. The proxy's residual is stated, not
// claimed to be zero: PerfectMind's `display-restrictions` / `age-restrictions` fallbacks emit
// `ages <vendor text>`, and vendor text reading "All ages" or "Family" would also land on
// `all-ages` notes with the flag OFF. Those fallbacks are only reached when the structured
// fields are unusable. The runner MEASURES how often they produce text on this family at all
// and prints it beside the count, so the reviewer sees the evidence rather than the assurance.
//
// ── WHAT THE CORRECTED STATE IS ──────────────────────────────────────────────────────────
// The withheld verdict emits `ageText: undefined` → `ageParse` is null → post-M1 ingest writes
// no occurrence_age row at all. The end state this backfill produces is that same silence,
// expressed in the row that already exists: null bounds, no band matches, no notes.
//
// `age_notes` is set to NULL rather than to a provenance string, DELIBERATELY and against
// docs §3.5's suggestion of "an age_notes provenance string". That column is PARENT-FACING:
// app/api/search/route.ts returns `ageNotes` verbatim to unauthenticated callers and drops only
// the two known internal prefixes (`unresolved:` / `audience:` — app/preview/_data/format.ts's
// INTERNAL_AGE_MARKERS). A backfill stamp would not match either, so it would render under
// "Who it's for" on the activity page — the exact leak tests/age-notes-marker-leak.test.ts
// exists to prevent. Provenance belongs in this run's JSON artefact, which is where it is kept.
import { resolveAgeText, type AgeSignalCode } from '../../worker/adapters/perfectmind/parse';
import { parseAgeText } from '../../worker/core/age';
import { isAdultOrSeniorOnly } from '../../lib/search/filters/audience';

/** The literal phrase PerfectMind's flag branch used to emit, pre-M1. */
export const PERFECTMIND_ALL_AGES_TEXT = 'All ages';

/**
 * The stored shape a pre-M1 flag row has, derived by running the REAL parser rather than
 * hard-coded. If worker/core/age.ts ever changes what `All ages` resolves to, this tool stops
 * matching rows and says so loudly at load, instead of silently selecting nothing.
 */
const MANUFACTURED_CLAIM = parseAgeText(PERFECTMIND_ALL_AGES_TEXT);
const manufacturedNotes = MANUFACTURED_CLAIM.notes;
const manufacturedMin = MANUFACTURED_CLAIM.ageMinMonths;

if (manufacturedNotes !== 'all-ages' || manufacturedMin !== 0 || MANUFACTURED_CLAIM.ageMaxMonths !== null) {
  throw new Error(
    `m1-withheld-backfill: parseAgeText(${JSON.stringify(PERFECTMIND_ALL_AGES_TEXT)}) no longer resolves to ` +
      `[0, ∞) notes='all-ages' (got ${JSON.stringify(MANUFACTURED_CLAIM)}). The row-selection proxy and the ` +
      `pre-state guard are both derived from it, so this tool refuses to run until it is re-derived.`
  );
}

/** `age_notes` value that stands in for "this row came from an all-ages ageText". */
export const ALL_AGES_NOTES_PROXY: string = manufacturedNotes;
/** The manufactured lower bound a pre-M1 flag row holds — [0 months, open-ended). */
export const MANUFACTURED_MIN_MONTHS: number = manufacturedMin;

/** What a corrected row holds — the stored expression of "no age claim". */
export const CORRECTED_STATE = {
  ageMinMonths: null,
  ageMaxMonths: null,
  ageBandMatches: [] as string[],
  ageNotes: null,
} as const;

/** One PerfectMind occurrence joined to its occurrence_age row, as production stores it. */
export interface StoredAgeRow {
  occurrenceId: string;
  activityName: string;
  ageMinMonths: number | null;
  ageMaxMonths: number | null;
  ageNotes: string | null;
  bandCount: number;
  lastCheckedAt: string | null;
}

export type RowAction =
  /** In scope: a manufactured all-ages claim M1 would not make today. */
  | 'correct'
  /** Out of scope, for a stated reason. Never written. */
  | 'leave';

/** Stable machine-readable reasons. Tallied in the report so every count is explainable. */
export const REASON = {
  CORRECT: 'correct:flag-only-all-ages-claim-m1-withholds',
  NOT_PROXY: 'leave:age_notes-is-not-the-all-ages-proxy',
  TITLE_PUBLISHES: 'leave:title-publishes-all-ages-the-venue-made-this-claim',
  CONTRADICTED: 'leave:title-contradicts-the-flag-separate-population-see-docs-3.5',
  ALREADY_WITHHELD: 'leave:no-positive-claim-stored-already-consistent-with-m1',
  BOUNDS_DIFFER: 'leave:stored-bounds-are-not-the-manufactured-claim-needs-a-human',
} as const;

export interface RowDecision {
  occurrenceId: string;
  activityName: string;
  action: RowAction;
  reason: string;
  /** What M1's real parser says about this row today. */
  m1Code: AgeSignalCode;
  storedClaim: string;
  /** The state the write would leave behind, or null when nothing would be written. */
  correctedClaim: string | null;
  lastCheckedAt: string | null;
  /** True when the shipped adult/senior search exclusion already hides this row from parents. */
  maskedBySearchFilter: boolean;
}

export function describeStored(row: StoredAgeRow): string {
  const notes = row.ageNotes === null ? 'NULL' : JSON.stringify(row.ageNotes);
  return `[${row.ageMinMonths ?? '-'}, ${row.ageMaxMonths ?? '∞'}) bands=${row.bandCount} notes=${notes}`;
}

const CORRECTED_CLAIM_TEXT = '[-, ∞) bands=0 notes=NULL   (no age claim)';

/** Does the row hold exactly the claim the pre-M1 flag branch manufactured? */
function holdsManufacturedClaim(row: StoredAgeRow): boolean {
  return row.ageMinMonths === MANUFACTURED_MIN_MONTHS && row.ageMaxMonths === null;
}

/** Does the row assert bounds a parent's age filter can match on? */
export function hasPositiveClaim(row: StoredAgeRow): boolean {
  return row.ageMinMonths !== null || row.ageMaxMonths !== null;
}

/**
 * Decide ONE row. Total by construction: every input gets an action and a stated reason, and
 * only one reason produces a write.
 *
 * The order of the checks is load-bearing. The two carve-out codes are settled BEFORE the stored
 * bounds are looked at, because a title-published claim and a contradicted flag are not ours to
 * touch whatever the row happens to hold.
 */
export function planRow(row: StoredAgeRow): RowDecision {
  const base = {
    occurrenceId: row.occurrenceId,
    activityName: row.activityName,
    lastCheckedAt: row.lastCheckedAt,
    storedClaim: describeStored(row),
    maskedBySearchFilter: isAdultOrSeniorOnly({
      activityName: row.activityName,
      ageMinMonths: row.ageMinMonths,
      ageMaxMonths: row.ageMaxMonths,
      ageNotes: row.ageNotes,
    }),
  };

  // Drive the REAL shipped parser with the flag the proxy establishes and the stored title —
  // the same technique fix-classes.ts uses, and for the same reason: a copy of M1's regexes
  // here would measure a snapshot of the fix rather than the fix.
  const verdict = resolveAgeText({ EventName: row.activityName, NoAgeRestriction: true });
  const leave = (reason: string): RowDecision => ({
    ...base,
    action: 'leave',
    reason,
    m1Code: verdict.code,
    correctedClaim: null,
  });

  if (row.ageNotes !== ALL_AGES_NOTES_PROXY) return leave(REASON.NOT_PROXY);
  if (verdict.code === 'title-publishes-all-ages') return leave(REASON.TITLE_PUBLISHES);
  if (verdict.code === 'no-age-restriction-contradicted') return leave(REASON.CONTRADICTED);
  // resolveAgeText() cannot return anything else for a flagged record, but the union has seven
  // other members and this must stay total if a future verdict is added.
  if (verdict.code !== 'no-age-restriction-withheld') return leave(REASON.NOT_PROXY);

  if (!hasPositiveClaim(row)) return leave(REASON.ALREADY_WITHHELD);
  if (!holdsManufacturedClaim(row)) return leave(REASON.BOUNDS_DIFFER);

  return {
    ...base,
    action: 'correct',
    reason: REASON.CORRECT,
    m1Code: verdict.code,
    correctedClaim: CORRECTED_CLAIM_TEXT,
  };
}

export interface BackfillPlan {
  decisions: RowDecision[];
  corrections: RowDecision[];
  byReason: Array<[string, number]>;
  byM1Code: Array<[string, number]>;
  /** Of the in-scope corrections, how many are reachable by a parent searching today. */
  correctionsParentReachable: number;
  /**
   * In-scope rows grouped by listing title, biggest first.
   *
   * WHY THIS IS IN THE REPORT AND NOT JUST THE ROW COUNT. `activity_occurrence` is one row PER
   * DATE, so one weekly public swim is ~9 rows in a two-month window. The published 198 counted
   * FEED RECORDS from a single pull. Without this grouping the two numbers look like a
   * disagreement about the same thing; with it, they are visibly a count of programmes and a
   * count of dated occurrences of those programmes.
   */
  correctionsByTitle: Array<[string, number]>;
}

export function buildPlan(rows: StoredAgeRow[]): BackfillPlan {
  const decisions = rows.map(planRow);
  const corrections = decisions.filter((d) => d.action === 'correct');
  return {
    decisions,
    corrections,
    byReason: tally(decisions.map((d) => d.reason)),
    byM1Code: tally(decisions.map((d) => d.m1Code)),
    correctionsParentReachable: corrections.filter((d) => !d.maskedBySearchFilter).length,
    correctionsByTitle: tally(corrections.map((d) => d.activityName)),
  };
}

function tally(values: string[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

// ── SQL ──────────────────────────────────────────────────────────────────────────────────
//
// Both statements live here, next to the rules they implement, so the pre-state guard is
// assertable by a unit test instead of by reading the runner (the F4 lesson from
// scripts/backfill-venue-geo.ts, pinned by tests/geo/backfill-clobber-guard.test.ts).

/**
 * Every candidate row. `$1` is the notes proxy, passed as a parameter rather than inlined so the
 * value is the one derived from parseAgeText() above and not a second literal that could drift.
 * `archived_at IS NULL` matches the scope predicate every other tool in this folder uses; the
 * archived population is counted separately by CONTEXT_SQL rather than silently dropped.
 */
export const CANDIDATE_ROWS_SQL = `
  SELECT o.id             AS occurrence_id,
         o.activity_name  AS activity_name,
         o.last_checked_at AS last_checked_at,
         a.age_min_months AS age_min_months,
         a.age_max_months AS age_max_months,
         a.age_notes      AS age_notes,
         COALESCE(array_length(a.age_band_matches, 1), 0) AS band_count
    FROM activity_occurrence o
    JOIN activity_series ser ON ser.id = o.series_id
    JOIN source s            ON s.id  = ser.source_id
    JOIN occurrence_age a    ON a.occurrence_id = o.id
   WHERE s.family::text = 'perfectmind'
     AND o.archived_at IS NULL
     AND a.age_notes = $1
   ORDER BY o.id
`;

/**
 * The catalogue facts the report's caveats depend on — measured, never assumed.
 *
 * `prior_operator_corrections` counts the rows the Operator corrected by hand on 2026-08-19 —
 * the contradicted population from docs §3.5. Their `age_notes` now carries an operator stamp
 * instead of `all-ages`, so they have LEFT the proxy, and that is the whole reason this run's
 * `no-age-restriction-contradicted` arm can legitimately read zero. Printed beside the counts so
 * a zero there reads as "already done" rather than "the classifier is broken".
 *
 * (Those stamps are also the leak app/api/search/route.ts describes — "…code fix live in
 * 9f95e31, worker release v24" is one of them, verbatim. They are only kept off the activity
 * page because they happen to start with `unresolved:`. That is the measured precedent for this
 * backfill writing NULL into age_notes rather than a stamp of its own.)
 *
 * `proxy_rows_unresolved_ages` is the evidence for the proxy's purity caveat. PerfectMind's
 * `display-restrictions` / `age-restrictions` fallbacks are the only non-flag paths that could
 * put an all-ages-shaped claim on this family, and both emit an ageText beginning `ages `. Rows
 * whose notes read `unresolved: ages …` are therefore the visible footprint of those two
 * branches firing in production at all. A zero here does not PROVE the proxy is pure (a fallback
 * whose text resolved numerically leaves no notes), but a large number would immediately
 * disprove it — so it is printed either way rather than argued.
 */
export const CONTEXT_SQL = `
  SELECT COUNT(*)                                                        AS perfectmind_occurrences,
         COUNT(a.occurrence_id)                                          AS with_age_row,
         COUNT(*) FILTER (WHERE a.age_notes = $1)                        AS proxy_rows,
         COUNT(*) FILTER (WHERE a.age_notes LIKE 'unresolved: ages %')   AS proxy_rows_unresolved_ages,
         COUNT(*) FILTER (WHERE a.age_notes LIKE 'unresolved: NoAgeRestriction%') AS prior_operator_corrections,
         COUNT(*) FILTER (WHERE o.last_checked_at > now() - interval '6 hours') AS reingested_last_6h
    FROM activity_occurrence o
    JOIN activity_series ser ON ser.id = o.series_id
    JOIN source s            ON s.id  = ser.source_id
    LEFT JOIN occurrence_age a ON a.occurrence_id = o.id
   WHERE s.family::text = 'perfectmind'
     AND o.archived_at IS NULL
`;

/** Archived PerfectMind rows still holding the proxy claim — excluded from the plan, reported. */
export const ARCHIVED_PROXY_SQL = `
  SELECT COUNT(*) AS archived_proxy_rows
    FROM activity_occurrence o
    JOIN activity_series ser ON ser.id = o.series_id
    JOIN source s            ON s.id  = ser.source_id
    JOIN occurrence_age a    ON a.occurrence_id = o.id
   WHERE s.family::text = 'perfectmind'
     AND o.archived_at IS NOT NULL
     AND a.age_notes = $1
`;

/**
 * THE ONE STATEMENT THIS TOOL IS EVER PERMITTED TO WRITE.
 *
 * The WHERE clause re-states the ENTIRE pre-state the decision was made on — not just the id.
 * That is the clobber guard, and it is doing real work here rather than being defensive
 * decoration: PerfectMind re-ingests roughly every two hours (docs §9), so a row can legitimately
 * change between the read-only SELECT that planned this batch and the UPDATE that applies it. If
 * it does — the vendor started publishing a structured MinAge, the LLM age-fallback filled it in,
 * the Operator corrected it by hand — this statement matches ZERO rows and the runner reports the
 * row as skipped. It cannot overwrite a value that arrived after the plan was made.
 *
 * It is also what makes the tool idempotent: a row this statement has already corrected no longer
 * satisfies its own WHERE clause, so a second run finds nothing to do and writes nothing. The
 * SELECT above stops selecting it for the same reason.
 *
 * `$2`/`$3` are the proxy and the manufactured minimum, both derived from parseAgeText() rather
 * than typed in twice.
 */
export const CORRECTION_UPDATE_SQL = `
  UPDATE occurrence_age
     SET age_min_months   = NULL,
         age_max_months   = NULL,
         age_band_matches = '{}'::uuid[],
         age_notes        = NULL
   WHERE occurrence_id  = $1
     AND age_notes      = $2
     AND age_min_months = $3
     AND age_max_months IS NULL
`;

/** Parameters for CORRECTION_UPDATE_SQL, in order. */
export function correctionParams(occurrenceId: string): [string, string, number] {
  return [occurrenceId, ALL_AGES_NOTES_PROXY, MANUFACTURED_MIN_MONTHS];
}

// ── reconciliation against the two published measurements ────────────────────────────────
//
// The brief's "~198" and this tool's count are measurements of DIFFERENT POPULATIONS, and the
// difference is structural rather than an error in either. Both published anchors are printed
// beside today's number so a reviewer can see which one they are comparing against.

export interface Anchor {
  label: string;
  value: number;
  measuredOn: string;
  note: string;
}

export const PUBLISHED_ANCHORS: Anchor[] = [
  {
    label: 'M1 commit ba3901a / handoff — flag-only records in the FEED',
    value: 198,
    measuredOn: '2026-08-18 live NVRC pull, 1,146 occurrences',
    note:
      'A count of records the VENDOR SERVED that day (293 flagged = 95 contradicted + 198 not), ' +
      'before the title-publishes carve-out was split out of the 198. It is not a count of stored rows.',
  },
  {
    label: 'docs/worker-fix-backfill-scope.md §3.5 — stored proxy rows still believing the flag',
    value: 260,
    measuredOn: '2026-08-19, against production',
    note:
      'Of 369 stored proxy rows, 109 were contradicted and 260 "flag still believed". Under M1 those ' +
      '260 split into title-publishes-all-ages + no-age-restriction-withheld, so THIS is the anchor ' +
      'a stored-row count is comparable to — and it is larger than 198 because stale rows accumulate ' +
      'from records that have since left the feed.',
  },
];

/** Why a stored-row count legitimately differs from either published figure. */
export const RECONCILIATION_NOTES: string[] = [
  'THE UNITS DIFFER, and this is the largest single term. 198 counted FEED RECORDS in one pull; this counts STORED OCCURRENCE ROWS, and activity_occurrence holds one row per DATE over a ~2-month window. The per-title grouping above shows the two side by side — read the distinct-title count against 198, not the row count.',
  'The contradicted arm reading zero is not a classifier failure: the Operator corrected that population by hand on 2026-08-19 (three batches, stamped into age_notes), which moved those rows out of the all-ages proxy exactly as docs §3.5 predicted. The count is printed above as "previously corrected by the Operator".',
  'The feed is rolling: PerfectMind publishes a moving ~4-week window, so records the 2026-08-18 pull saw have since left it and new ones have arrived. A row that leaves the feed keeps its stale claim and stays in this count.',
  'The proxy cannot see rows the Operator hand-corrected: their age_notes is no longer "all-ages", so the 73-row stopgap (19 of which survived, docs §9) drops out of every count on both sides.',
  'lib/llm/age-fallback.ts rewrites age_notes on rows it resolves; any flag row it touched leaves the proxy too.',
  'Archived occurrences are excluded from the plan (reported separately) — the 2026-08-18 feed measurement had no archival dimension at all.',
  'M1 has been deployed since 2026-09-11 23:03 UTC, so no NEW manufactured claims have been written since; this population can only shrink from here, never grow.',
];
