// scripts/backfill-scope/activenet-age-backfill-lib.ts — correct ActiveNet's stored ages
// against the source's OWN age field.
//
// Pure functions. No database, no network, no clock — the runner supplies stored rows and the
// source's answer, everything here is a decision about ONE row and is unit-testable without
// either. Same doctrine as m1-withheld-backfill-lib.ts, and deliberately so.
//
// ── HOW THIS DIFFERS FROM THE M1 §3h BACKFILL, WHICH IS THE WHOLE POINT ──────────────────
// §3h could only CLEAR. It was correcting a claim manufactured from a booking flag, and with
// the flag discredited there was nothing left to put in its place, so the honest write was
// NULL. Here there IS something to put in its place: ActiveNet publishes an exact age on the
// activity record (measured 2026-09-12: 400/400 sampled activities carry one). So this tool
// SETS the right answer rather than blanking the wrong one —
//
//     |Public Skate|                         stays all-ages, now attributable   (120 of 227)
//     Wu's Tai Chi                           0-infinity  ->  50 yrs +
//     Karate - Ku Yu Kai Go-Ju Ryu (Adults)  0-infinity  ->  19 yrs +
//     Tae Kwon Do Level 1 & Level 2          0-infinity  ->  6 - 13y11m
//     Ukulele - Jam Circle (All ages)        0-infinity  ->  55 yrs +
//
// — which is a strictly better outcome than §3h could reach, and it is only available because
// the fix that preceded it went and read the field.
//
// ── WHAT IT REFUSES TO DO ────────────────────────────────────────────────────────────────
// It never guesses. A row whose activity the source would not answer for is reported as
// AMBIGUOUS with a real count and left alone — the same discipline the Operator applied by
// hand when they corrected 73 unambiguous PerfectMind rows and left ~55 ambiguous ones.
// It also never CREATES an age row: a row with no stored claim is the ingest path's job on the
// next run, and widening a correction tool into a populator is how a backfill's blast radius
// stops being reviewable.
import type { ActivityAgeBounds } from '../../worker/adapters/activenet/activity-age';

/** One occurrence as production stores it, joined to its occurrence_age row if any. */
export interface StoredAgeRow {
  occurrenceId: string;
  /** ActiveNet's activity id — the first segment of source_record_id, and the lookup key. */
  activityId: number;
  activityName: string;
  hasAgeRow: boolean;
  ageMinMonths: number | null;
  ageMaxMonths: number | null;
  ageNotes: string | null;
  bandCount: number;
}

export type RowAction =
  /** The source states an age and it differs from what is stored. Write the source's answer. */
  | 'set'
  /** Out of scope, for a stated reason. Never written. */
  | 'leave'
  /** The source would not answer for this activity. Counted, never guessed at. */
  | 'ambiguous';

export const REASON = {
  SET_CONTRADICTED: 'set:source-states-an-age-that-contradicts-the-stored-claim',
  LEAVE_AGREES: 'leave:stored-already-equals-the-source-age',
  LEAVE_NO_CLAIM: 'leave:no-age-row-stored-the-next-re-ingest-writes-it',
  LEAVE_SOURCE_SILENT: 'leave:source-publishes-no-age-for-this-activity',
  AMBIGUOUS_LOOKUP_FAILED: 'ambiguous:source-lookup-failed-never-guessed',
  AMBIGUOUS_NO_ACTIVITY_ID: 'ambiguous:no-usable-activity-id-on-the-source-record-id',
} as const;

export interface RowDecision {
  occurrenceId: string;
  activityId: number;
  activityName: string;
  action: RowAction;
  reason: string;
  storedClaim: string;
  sourceClaim: string | null;
  /** The state the write would leave behind, or null when nothing would be written. */
  corrected: ActivityAgeBounds | null;
  /**
   * Does the STORED claim admit someone younger than the source allows?
   *
   * This is the child-safety direction and the reason the tool exists: it is the difference
   * between a listing that is merely imprecise and one that tells a parent an adults-only
   * class suits their baby. Tallied separately so the report leads with it.
   */
  admitsTooYoung: boolean;
}

export function describeBounds(min: number | null, max: number | null, notes?: string | null): string {
  if (min === null && max === null) return notes ? `no bounds (notes: ${notes})` : 'no claim';
  const lo = min === null ? '?' : `${min}mo`;
  const hi = max === null ? '∞' : `${max}mo`;
  return `[${lo}, ${hi})${notes ? ` ${notes}` : ''}`;
}

function sameClaim(row: StoredAgeRow, source: ActivityAgeBounds): boolean {
  return (
    row.ageMinMonths === source.minMonths &&
    row.ageMaxMonths === source.maxMonths &&
    (row.ageNotes ?? null) === (source.notes ?? null)
  );
}

/**
 * `undefined` means the lookup was never attempted or threw; `null` means the source answered
 * and had no age to give. They are different facts and must not collapse into one verdict —
 * conflating "we don't know" with "the source says nothing" is how a backfill quietly writes
 * over rows it never actually verified.
 */
export function planRow(row: StoredAgeRow, source: ActivityAgeBounds | null | undefined): RowDecision {
  const base = {
    occurrenceId: row.occurrenceId,
    activityId: row.activityId,
    activityName: row.activityName,
    storedClaim: row.hasAgeRow
      ? describeBounds(row.ageMinMonths, row.ageMaxMonths, row.ageNotes)
      : 'no age row',
    sourceClaim: source ? describeBounds(source.minMonths, source.maxMonths, source.notes) : null,
    corrected: null as ActivityAgeBounds | null,
    admitsTooYoung: false,
  };

  if (!Number.isFinite(row.activityId) || row.activityId <= 0) {
    return { ...base, action: 'ambiguous', reason: REASON.AMBIGUOUS_NO_ACTIVITY_ID };
  }
  if (source === undefined) {
    return { ...base, action: 'ambiguous', reason: REASON.AMBIGUOUS_LOOKUP_FAILED };
  }
  if (source === null) {
    return { ...base, action: 'leave', reason: REASON.LEAVE_SOURCE_SILENT };
  }
  if (!row.hasAgeRow) {
    return { ...base, action: 'leave', reason: REASON.LEAVE_NO_CLAIM };
  }
  if (sameClaim(row, source)) {
    return { ...base, action: 'leave', reason: REASON.LEAVE_AGREES };
  }

  // A stored min of null is an open floor — it admits newborns, so it is "too young" against
  // any positive source minimum.
  const storedFloor = row.ageMinMonths ?? 0;
  return {
    ...base,
    action: 'set',
    reason: REASON.SET_CONTRADICTED,
    corrected: source,
    admitsTooYoung: storedFloor < source.minMonths,
  };
}

/**
 * What the lookup phase actually managed to ask.
 *
 * `complete: false` is the fact the Operator's hard gate exists to make impossible to miss: a
 * one-shot production correction that stopped half way through, reported as if it had finished,
 * would leave thousands of rows believed-checked and never actually asked about.
 */
export interface LookupPhaseResult {
  answers: Map<number, ActivityAgeBounds | null | undefined>;
  /** False when a fatal portal error stopped the phase before every id was asked. */
  complete: boolean;
  asked: number;
  total: number;
  /** Why it stopped, verbatim, or null when it ran to the end. */
  haltReason: string | null;
}

/**
 * Ask the source about every activity, stopping honestly when it tells us to stop.
 *
 * EXTRACTED FROM THE RUNNER SO IT CAN BE TESTED AT ALL. While this loop lived inside main() the
 * only way to exercise its stop-and-report behaviour was to run the script against a live
 * portal, so the branch that matters most — the one that fires exactly when a production run is
 * going wrong — had never been executed by anything. That is the same dead-branch shape as the
 * defect this function exists to report.
 *
 * A fatal error does NOT become a result. Ids never reached are simply absent from `answers`,
 * so `planRow` sees `undefined` and returns AMBIGUOUS — "we never asked" — rather than `null`,
 * which would mean "the source told us there is no age".
 */
export async function runLookupPhase(
  activityIds: number[],
  resolve: (id: number) => Promise<ActivityAgeBounds | null | undefined>,
  isFatal: (err: unknown) => boolean
): Promise<LookupPhaseResult> {
  const answers = new Map<number, ActivityAgeBounds | null | undefined>();
  for (const id of activityIds) {
    try {
      answers.set(id, await resolve(id));
    } catch (err) {
      if (!isFatal(err)) throw err;
      return {
        answers,
        complete: false,
        asked: answers.size,
        total: activityIds.length,
        haltReason: (err as Error).message,
      };
    }
  }
  return { answers, complete: true, asked: answers.size, total: activityIds.length, haltReason: null };
}

export interface BackfillPlan {
  decisions: RowDecision[];
  toWrite: RowDecision[];
  counts: {
    rows: number;
    set: number;
    leave: number;
    ambiguous: number;
    /** Of the writes, how many close a child-safety gap rather than merely tidy a bound. */
    admitsTooYoung: number;
    /** Of the writes, how many were the manufactured all-ages claim. */
    wasAllAges: number;
    /** Of the writes, how many the SOURCE itself confirms are all-ages (kept, now attributable). */
    staysAllAges: number;
  };
  byReason: Record<string, number>;
  distinctActivities: number;
  /** Carried from the lookup phase so no report can describe a partial run as a complete one. */
  lookupComplete: boolean;
  lookupAsked: number;
  lookupTotal: number;
  haltReason: string | null;
}

/**
 * Takes the LOOKUP RESULT, not a bare lookup function, and that is deliberate: it makes
 * "did we actually manage to ask?" a required input rather than something a caller can forget to
 * carry into the report. The type system now refuses to build a plan that cannot say so.
 */
export function buildPlan(rows: StoredAgeRow[], lookup: LookupPhaseResult): BackfillPlan {
  const decisions = rows.map((r) => planRow(r, lookup.answers.get(r.activityId)));
  const toWrite = decisions.filter((d) => d.action === 'set');
  const byReason: Record<string, number> = {};
  for (const d of decisions) byReason[d.reason] = (byReason[d.reason] ?? 0) + 1;
  return {
    decisions,
    toWrite,
    counts: {
      rows: rows.length,
      set: toWrite.length,
      leave: decisions.filter((d) => d.action === 'leave').length,
      ambiguous: decisions.filter((d) => d.action === 'ambiguous').length,
      admitsTooYoung: toWrite.filter((d) => d.admitsTooYoung).length,
      wasAllAges: toWrite.filter((d) => d.storedClaim.includes('all-ages')).length,
      staysAllAges: toWrite.filter((d) => d.corrected?.notes === 'all-ages').length,
    },
    byReason,
    distinctActivities: new Set(rows.map((r) => r.activityId)).size,
    lookupComplete: lookup.complete,
    lookupAsked: lookup.asked,
    lookupTotal: lookup.total,
    haltReason: lookup.haltReason,
  };
}

/** The activity id is the first segment of `${event_item_id}:${start}:${centre}:${facilities}`. */
export function activityIdFromSourceRecordId(sourceRecordId: string): number {
  const n = Number((sourceRecordId ?? '').split(':')[0]);
  return Number.isFinite(n) ? n : Number.NaN;
}

export const CANDIDATE_ROWS_SQL = `
  SELECT o.id                         AS occurrence_id,
         o.source_record_id           AS source_record_id,
         o.activity_name              AS activity_name,
         (oa.occurrence_id IS NOT NULL) AS has_age_row,
         oa.age_min_months            AS age_min_months,
         oa.age_max_months            AS age_max_months,
         oa.age_notes                 AS age_notes,
         coalesce(array_length(oa.age_band_matches, 1), 0) AS band_count
    FROM occurrence o
    JOIN series s   ON s.id = o.series_id
    JOIN source src ON src.id = s.source_id
    LEFT JOIN occurrence_age oa ON oa.occurrence_id = o.id
   WHERE src.family = 'activenet'
     AND oa.occurrence_id IS NOT NULL
   ORDER BY o.id
`;

/**
 * The pre-state guard re-states the WHOLE stored claim, not just the id.
 *
 * ActiveNet re-ingests continuously, so a row can legitimately change between the plan and the
 * write. If it does, this statement matches zero rows and the run says so rather than
 * clobbering a fresher value. It is also what makes a second run a no-op.
 *
 * WHY `coalesce(...)` AND NOT `IS NOT DISTINCT FROM`, which is the obvious spelling: the stored
 * bounds and notes are nullable and `NULL = NULL` is not true, so a plain `=` would make every
 * open-ended row unmatchable. `IS NOT DISTINCT FROM` fixes that and is rejected by
 * correcting-db.ts's own guard — it contains the token FROM, which that guard refuses in order
 * to block `UPDATE … FROM` join-updates that could touch rows the plan never saw. The guard is
 * right and this statement adapts to it rather than the other way round.
 *
 * The sentinels are values the columns cannot legitimately hold: months are non-negative, and
 * the empty string is not a note this system writes.
 */
export const NULL_MONTHS_SENTINEL = -1;

export const CORRECTION_UPDATE_SQL = `
  UPDATE occurrence_age
     SET age_min_months   = $5,
         age_max_months   = $6,
         age_band_matches = $7::uuid[],
         age_notes        = $8
   WHERE occurrence_id = $1
     AND coalesce(age_min_months, ${NULL_MONTHS_SENTINEL}) = coalesce($2::int, ${NULL_MONTHS_SENTINEL})
     AND coalesce(age_max_months, ${NULL_MONTHS_SENTINEL}) = coalesce($3::int, ${NULL_MONTHS_SENTINEL})
     AND coalesce(age_notes, '') = coalesce($4::text, '')
`;

/** Parameters for CORRECTION_UPDATE_SQL, in order. `bandIds` is computed by the runner from
 *  the corrected bounds against the seeded bands — never hand-written. */
export function correctionParams(
  decision: RowDecision,
  stored: StoredAgeRow,
  bandIds: string[]
): [string, number | null, number | null, string | null, number, number | null, string[], string | null] {
  if (!decision.corrected) throw new Error(`correctionParams called for a non-write decision: ${decision.reason}`);
  return [
    decision.occurrenceId,
    stored.ageMinMonths,
    stored.ageMaxMonths,
    stored.ageNotes ?? null,
    decision.corrected.minMonths,
    decision.corrected.maxMonths,
    bandIds,
    decision.corrected.notes ?? null,
  ];
}
