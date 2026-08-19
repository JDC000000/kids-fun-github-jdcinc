// scripts/backfill-scope/review-batch-lib.ts — the pure half of the §3h ActiveNet title-gate
// REVIEW-CANDIDATE batch. No filesystem, no database, no clock: every export here is a total
// function of its arguments, which is what lets tests/backfill-scope/title-gate-review-batch.test.ts
// pin the two claims this artefact actually rests on (the bucket partition, and the masking call).
//
// ── WHY THIS FILE EXISTS, AND WHY IT IS SO NARROW ────────────────────────────────────────────
//
// docs/worker-fix-backfill-scope.md §3.3 and §5 both land on recommendation (c): DIFF-AND-FLAG
// FOR MANUAL REVIEW, explicitly not automated correction. A row is only *provably* §3h-stale if
// today's parser produces nothing for it, and proving that needs the description — which is gone
// (`description_snippet` is NULL on 100% of occurrences; the recheck re-measured it at 0/15,022).
// So nothing downstream of this file may write a production row, and nothing here proposes a
// corrected value. The output is a QUEUE FOR A HUMAN. That is the whole contract.
//
// ── THE ONE NUMBER THIS FILE EXISTS TO GET RIGHT: 633, NOT 2,279 ─────────────────────────────
//
// The recheck's headline for this class is `ambiguous: 2279`, and it is extremely tempting — and
// wrong — to call that "the review queue". It decomposes into three populations with three
// different causes, and only one of them is caused by the fixes under review:
//
//   1,534  activenet:title-rejected-source-of-stored-claim-unknown
//     633  activenet:candidate-title-manufactured-claim          ← THE QUEUE
//     112  activenet:title-admitted-but-bounds-differ-description-unknown
//   -----
//   2,279  = the headline
//
// §6 of the doc states it flatly: *"The 672 are the only bucket worth queueing for review."*
// (672 was the pre-deploy count of this same bucket; see the note on self-healing below.) §3.3
// is equally flat on the largest bucket: *"Do not mechanically clear the 1,154 'source unknown'
// rows: their stored bounds did not come from the title, so this fix is not what made them
// wrong."* Queueing all 2,279 would put ~1,646 rows in front of a reviewer that these commits
// are not responsible for — which wastes the review AND corrupts the finding, because a reviewer
// working that queue would attribute every defect they found to `f15d6c8`/`3b29456`.
//
// The discriminator is `sameBounds(row, parseAgeText(title))`, evaluated by the SHIPPED
// classifier in fix-classes.ts, and it is a real one:
//   • bounds reproduce from the title alone → the stored claim is CONSISTENT with having been
//     manufactured from the title, i.e. consistent with precisely what these fixes withdraw.
//   • bounds do not reproduce → the stored claim came from somewhere else entirely. Whatever is
//     wrong with it, this fix did not cause it and correcting it here would be a different unit
//     of work performed under a false rationale.
//
// ── WHAT THE MOVEMENT 672 → 633 MEANS ────────────────────────────────────────────────────────
//
// The candidate bucket SHRANK post-deploy (672 → 633): §3.3 predicted exactly that self-healing
// once the fixed build completed a full ActiveNet cycle. The aggregate only grew (1,942 → 2,279)
// because the source-unknown bucket grew 1,154 → 1,534, tracking overall ingest growth (10,600 →
// 11,540 rows in scope) — a different and non-§3h population. A naive aggregate reading would
// have reported a regression. It is the opposite.
import { ADULT_ONLY_AGE_MIN_MONTHS, isAdultOrSeniorOnly } from '../../lib/search/filters/audience';

/** The class id this batch is built from. Class 7 (`6637ae5`) is out of scope — see §3.6. */
export const TITLE_GATE_CLASS_ID = '3+6-activenet-title-gate';

/** The bucket that IS the review queue. */
export const CANDIDATE_REASON = 'activenet:candidate-title-manufactured-claim';
/** Excluded: the stored bounds did not come from the title, so these fixes did not cause them. */
export const SOURCE_UNKNOWN_REASON = 'activenet:title-rejected-source-of-stored-claim-unknown';
/** Excluded: the fixed gate still admits the title, so only the unmeasurable class 7 could explain it. */
export const BOUNDS_DIFFER_REASON = 'activenet:title-admitted-but-bounds-differ-description-unknown';

/** One entry of `.classes[<id>].findings` in the recheck JSON, as measure.ts writes it. */
export interface RecheckFinding {
  occurrenceId: string;
  activityName: string;
  lastCheckedAt: string | null;
  storedClaim: string;
  derivedClaim: string;
  verdict: string;
  reason: string;
}

export interface AmbiguousPartition {
  candidates: RecheckFinding[];
  sourceUnknown: RecheckFinding[];
  boundsDiffer: RecheckFinding[];
  /**
   * Any ambiguous row carrying a reason this file does not know about. MUST be empty. It exists
   * so that a future classifier reason cannot silently vanish from the accounting: the caller
   * asserts `unclassified.length === 0` and the identity
   * `candidates + sourceUnknown + boundsDiffer + unclassified === totalAmbiguous` holds by
   * construction, so the 633/1,534/112 split can never quietly stop adding up to the headline.
   */
  unclassified: RecheckFinding[];
  totalAmbiguous: number;
}

/**
 * Split the ambiguous verdict into its three causes. Non-ambiguous verdicts are dropped: the
 * `agrees` and `not_applicable` rows are provably unaffected by these commits and are not review
 * material under any reading.
 */
export function partitionAmbiguous(findings: readonly RecheckFinding[]): AmbiguousPartition {
  const ambiguous = findings.filter((f) => f.verdict === 'ambiguous');
  const part: AmbiguousPartition = {
    candidates: [],
    sourceUnknown: [],
    boundsDiffer: [],
    unclassified: [],
    totalAmbiguous: ambiguous.length,
  };
  for (const f of ambiguous) {
    if (f.reason === CANDIDATE_REASON) part.candidates.push(f);
    else if (f.reason === SOURCE_UNKNOWN_REASON) part.sourceUnknown.push(f);
    else if (f.reason === BOUNDS_DIFFER_REASON) part.boundsDiffer.push(f);
    else part.unclassified.push(f);
  }
  return part;
}

/** The stored age claim, recovered from the finding's own `storedClaim` string. */
export interface StoredClaim {
  hasAgeRow: boolean;
  ageMinMonths: number | null;
  ageMaxMonths: number | null;
  bandCount: number;
  ageNotes: string | null;
}

/**
 * `describeStored()` in fix-classes.ts renders the stored claim as
 *
 *     `[${min ?? '-'}, ${max ?? '∞'}) bands=${n} notes=${JSON.stringify(notes) | 'NULL'}`
 *
 * or the literal `no occurrence_age row`. That rendering is LOSSLESS — `-`/`∞` are unambiguous
 * because a real bound is always numeric, and `age_notes` is JSON-quoted so a note containing a
 * comma or a bracket cannot be confused for structure. So the four inputs `isAdultOrSeniorOnly()`
 * needs are recoverable from the snapshot alone, which is what makes this artefact reproducible
 * without a database (see the header of review-batch.ts on why that matters).
 *
 * Strict on purpose: an unrecognised shape THROWS rather than degrading to "no claim". A silent
 * null here would understate masking, i.e. would over-report rows as parent-reachable, and the
 * whole point of this file is that its counts are trustworthy.
 */
const STORED_CLAIM_RE = /^\[(-?\d+|-), (-?\d+|∞)\) bands=(\d+) notes=(.*)$/s;

export function parseStoredClaim(storedClaim: string): StoredClaim {
  if (storedClaim === 'no occurrence_age row') {
    return { hasAgeRow: false, ageMinMonths: null, ageMaxMonths: null, bandCount: 0, ageNotes: null };
  }
  const m = STORED_CLAIM_RE.exec(storedClaim);
  if (!m) throw new Error(`review-batch: unparseable storedClaim: ${JSON.stringify(storedClaim)}`);
  const [, rawMin, rawMax, rawBands, rawNotes] = m;
  let ageNotes: string | null;
  if (rawNotes === 'NULL') {
    ageNotes = null;
  } else {
    const decoded: unknown = JSON.parse(rawNotes);
    if (typeof decoded !== 'string') {
      throw new Error(`review-batch: storedClaim notes is not a string: ${JSON.stringify(rawNotes)}`);
    }
    ageNotes = decoded;
  }
  return {
    hasAgeRow: true,
    ageMinMonths: rawMin === '-' ? null : Number(rawMin),
    ageMaxMonths: rawMax === '∞' ? null : Number(rawMax),
    bandCount: Number(rawBands),
    ageNotes,
  };
}

/**
 * Severity, ordered worst-first. Deterministic and derived only from the shipped predicate plus
 * the stored bounds — no keyword list of this file's own invention.
 */
export type Severity =
  /** The title itself reads adult/senior-only, yet the stored band starts below the age of
   *  majority. This is §3.3's own headline example: `"1.0-1.5 NTRP - Adult Beginner Tennis
   *  Lessons"` stored as `[0, 24)` — adult tennis labelled for under-2s. */
  | 'A-adult-title-child-band'
  /** An open-ended stored claim (`[x, ∞)`). No age filter can exclude it, so if it is wrong it is
   *  wrong in front of every parent, in every search, simultaneously. */
  | 'B-open-ended-claim'
  /** A stored ceiling at or under 24 months — the narrowest, most confidently-wrong shape a
   *  title-manufactured claim takes, and the one a parent of a baby acts on directly. */
  | 'C-infant-band'
  /** A bounded band with no adult-title conflict. Still a candidate; just not egregious. */
  | 'D-bounded-band';

const SEVERITY_RANK: Record<Severity, number> = {
  'A-adult-title-child-band': 0,
  'B-open-ended-claim': 1,
  'C-infant-band': 2,
  'D-bounded-band': 3,
};

/** A stored ceiling at or below this reads as "babies only". 24 months = the product's 0-2 band. */
export const INFANT_CEILING_MONTHS = 24;

export interface ReviewRow {
  occurrenceId: string;
  activityName: string;
  /** Verbatim from the recheck, so the artefact can always be traced back to its source row. */
  storedClaim: string;
  ageMinMonths: number | null;
  ageMaxMonths: number | null;
  bandCount: number;
  ageNotes: string | null;
  /** Verbatim from the recheck: always `title rejected by the fixed gate` for this bucket. */
  derivedClaim: string;
  whyCandidate: string;
  /** `isAdultOrSeniorOnly()` on the FULL stored row — the shipped read-time hard exclusion. */
  maskedBySearchFilter: boolean;
  /** The inverse. A parent can see this row today, wrong bounds and all. */
  parentReachable: boolean;
  /** `isAdultOrSeniorOnly()` on the TITLE ALONE (age signals nulled) — see titleReadsAdultOnly(). */
  titleReadsAdultOnly: boolean;
  severity: Severity;
  lastCheckedAt: string | null;
  /** True when ingest re-wrote this row AFTER the fixed build booted → observed, not predicted. */
  reIngestedByDeployedBuild: boolean | null;
}

/**
 * Does the TITLE alone read as adult/senior-only?
 *
 * Computed by calling the SHIPPED `isAdultOrSeniorOnly()` with the age signals nulled out, rather
 * than by re-implementing its title regex. §9 of the doc is explicit about why an approximation
 * gets this wrong: the predicate strips a marker prefix, splits on `[,|;\n]`, anchors adult-tag
 * matches per segment, and applies whole-field vetoes (parent-and-child framing, supervision
 * prose). Nulling the two age fields and `ageNotes` leaves exactly the title-driven branches —
 * `PARENT_AND_CHILD` veto then `ADULT_ONLY_TITLE` — with `statesAdultAudience()` short-circuiting
 * on empty notes and `hasOpenEndedAdultAgeFloor()` short-circuiting on a null minimum.
 *
 * This is what makes severity A honest: "adult tennis stored as under-2s" is a conflict between
 * the TITLE's own reading and the STORED band, and it must not be diluted by the age columns that
 * are themselves under suspicion here.
 */
export function titleReadsAdultOnly(activityName: string): boolean {
  return isAdultOrSeniorOnly({
    activityName,
    ageMinMonths: null,
    ageMaxMonths: null,
    ageNotes: null,
  });
}

/**
 * The shipped read-time hard exclusion, applied to the full stored row.
 *
 * WHY THIS MATTERS TO A REVIEW QUEUE. `isAdultOrSeniorOnly()` removes a listing from a children's
 * product outright, before any age filter runs. A row it already hides is still wrong and still
 * worth correcting — but the wrong value is not currently reaching a parent, so it is not urgent.
 * A row it does not hide is the only thing between a parent filtering for under-2s and an adult
 * programme. Same defect, very different urgency; a queue that does not separate them spends a
 * reviewer's attention at a flat rate on unequal harm.
 */
export function maskedBySearchFilter(claim: StoredClaim, activityName: string): boolean {
  return isAdultOrSeniorOnly({
    activityName,
    ageMinMonths: claim.ageMinMonths,
    ageMaxMonths: claim.ageMaxMonths,
    ageNotes: claim.ageNotes,
  });
}

export function severityOf(claim: StoredClaim, adultTitle: boolean): Severity {
  if (adultTitle && claim.ageMinMonths !== null && claim.ageMinMonths < ADULT_ONLY_AGE_MIN_MONTHS) {
    return 'A-adult-title-child-band';
  }
  if (claim.hasAgeRow && claim.ageMaxMonths === null) return 'B-open-ended-claim';
  if (claim.ageMaxMonths !== null && claim.ageMaxMonths <= INFANT_CEILING_MONTHS) return 'C-infant-band';
  return 'D-bounded-band';
}

function describeBounds(claim: StoredClaim): string {
  if (!claim.hasAgeRow) return 'no age row';
  return `[${claim.ageMinMonths ?? '-'}, ${claim.ageMaxMonths ?? '∞'})`;
}

/** Codepoint-order compare. Deliberately not `localeCompare` — the output must be byte-identical
 *  on every machine, so the parent's independent re-derivation can diff it. */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Prioritise the queue. Primary key is PARENT-REACHABLE, because a reviewer working top-down
 * should be retiring live harm first. Severity is secondary, then title, then id — the last two
 * purely so the ordering is total and the file is stable across runs.
 *
 * Note the consequence, and it is deliberate: severity-A rows are, almost by construction, masked
 * (a title that reads adult-only is exactly what `isAdultOrSeniorOnly()` catches), so they sort
 * BELOW the parent-reachable block. That is the correct priority — they are not reaching anyone —
 * but they are also the most legible evidence that these claims were manufactured from titles, so
 * the markdown artefact surfaces them in a dedicated section as well as in the main table.
 */
export function prioritise(rows: readonly ReviewRow[]): ReviewRow[] {
  return [...rows].sort((a, b) => {
    if (a.parentReachable !== b.parentReachable) return a.parentReachable ? -1 : 1;
    const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (bySeverity !== 0) return bySeverity;
    return cmp(a.activityName, b.activityName) || cmp(a.occurrenceId, b.occurrenceId);
  });
}

/** Was this row re-written by the currently-deployed build? Null when no boundary was supplied. */
export function reIngestedSince(lastCheckedAt: string | null, deployedSince: string | null): boolean | null {
  if (!deployedSince) return null;
  const boundary = Date.parse(deployedSince);
  if (Number.isNaN(boundary)) return null;
  if (!lastCheckedAt) return false;
  const seen = Date.parse(lastCheckedAt);
  return Number.isNaN(seen) ? false : seen > boundary;
}

export function buildReviewRow(finding: RecheckFinding, deployedSince: string | null): ReviewRow {
  const claim = parseStoredClaim(finding.storedClaim);
  const adultTitle = titleReadsAdultOnly(finding.activityName);
  const masked = maskedBySearchFilter(claim, finding.activityName);
  return {
    occurrenceId: finding.occurrenceId,
    activityName: finding.activityName,
    storedClaim: finding.storedClaim,
    ageMinMonths: claim.ageMinMonths,
    ageMaxMonths: claim.ageMaxMonths,
    bandCount: claim.bandCount,
    ageNotes: claim.ageNotes,
    derivedClaim: finding.derivedClaim,
    whyCandidate:
      `today's gate REJECTS this title, and parseAgeText(title) alone reproduces the stored bounds ` +
      `${describeBounds(claim)} exactly — consistent with a claim manufactured from the title, which ` +
      `is what f15d6c8/3b29456 withdraw. NOT proof: description_snippet is NULL on 100% of rows, so a ` +
      `description phrase resolving to the same bounds cannot be excluded. Candidate, never confirmed.`,
    maskedBySearchFilter: masked,
    parentReachable: !masked,
    titleReadsAdultOnly: adultTitle,
    severity: severityOf(claim, adultTitle),
    lastCheckedAt: finding.lastCheckedAt,
    reIngestedByDeployedBuild: reIngestedSince(finding.lastCheckedAt, deployedSince),
  };
}

export function buildReviewRows(
  candidates: readonly RecheckFinding[],
  deployedSince: string | null
): ReviewRow[] {
  return prioritise(candidates.map((f) => buildReviewRow(f, deployedSince)));
}

export interface BucketSummary {
  reason: string;
  rows: number;
  masked: number;
  parentReachable: number;
  reIngestedByDeployedBuild: number | null;
}

/** Masking counts for a bucket we are NOT queueing — characterisation only, per the brief. */
export function summariseBucket(
  reason: string,
  findings: readonly RecheckFinding[],
  deployedSince: string | null
): BucketSummary {
  let masked = 0;
  let observed = 0;
  for (const f of findings) {
    if (maskedBySearchFilter(parseStoredClaim(f.storedClaim), f.activityName)) masked += 1;
    if (reIngestedSince(f.lastCheckedAt, deployedSince)) observed += 1;
  }
  return {
    reason,
    rows: findings.length,
    masked,
    parentReachable: findings.length - masked,
    reIngestedByDeployedBuild: deployedSince ? observed : null,
  };
}

// ── rendering ────────────────────────────────────────────────────────────────────────────────

export const CSV_COLUMNS = [
  'priority',
  'occurrence_id',
  'activity_name',
  'stored_claim',
  'age_min_months',
  'age_max_months',
  'band_count',
  'age_notes',
  'fixed_gate_verdict_on_title',
  'severity',
  'parent_reachable',
  'masked_by_search_filter',
  'title_reads_adult_only',
  're_ingested_by_deployed_build',
  'last_checked_at',
  'why_candidate',
  'reviewer_decision',
  'reviewer_notes',
] as const;

function csvCell(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * RFC 4180 CSV. The last two columns are intentionally EMPTY — `reviewer_decision` and
 * `reviewer_notes` are where the human writes back. This file is a worksheet, not a report:
 * shipping it without somewhere to record the decision guarantees the decisions land somewhere
 * this process cannot see. CRLF line endings, because that is what a spreadsheet expects.
 */
export function toCsv(rows: readonly ReviewRow[]): string {
  const lines = [CSV_COLUMNS.join(',')];
  rows.forEach((r, i) => {
    lines.push(
      [
        i + 1,
        r.occurrenceId,
        r.activityName,
        r.storedClaim,
        r.ageMinMonths,
        r.ageMaxMonths,
        r.bandCount,
        r.ageNotes,
        r.derivedClaim,
        r.severity,
        r.parentReachable,
        r.maskedBySearchFilter,
        r.titleReadsAdultOnly,
        r.reIngestedByDeployedBuild === null ? '' : r.reIngestedByDeployedBuild,
        r.lastCheckedAt,
        r.whyCandidate,
        '',
        '',
      ]
        .map(csvCell)
        .join(',')
    );
  });
  return `${lines.join('\r\n')}\r\n`;
}

/** A markdown table cell: pipes escaped, newlines flattened. Titles in this corpus contain `|`
 *  literally (`"| Length Swim (50m) |"`), so this is load-bearing, not defensive. */
export function mdCell(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  return s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/**
 * One REVIEW DECISION, which is not the same thing as one row.
 *
 * ActiveNet publishes a recurring programme as one occurrence per session, so "Baby Jellyfish
 * Playtime - M/Tu/W/Th/F" is 27 occurrence rows carrying one identical claim written by one
 * identical parse of one identical title. A reviewer asked to adjudicate 633 rows one at a time
 * would be answering the same question 27 times and would rightly lose confidence in the queue.
 * Grouping is therefore not cosmetic: it is what turns this artefact from a list into something a
 * person can finish. The per-occurrence file is still emitted alongside, because a correction — if
 * one is ever authorised — has to be applied per occurrence id, not per title.
 */
export interface ReviewGroup {
  activityName: string;
  storedClaim: string;
  severity: Severity;
  parentReachable: boolean;
  occurrences: number;
  reIngestedByDeployedBuild: number | null;
  earliestLastCheckedAt: string | null;
  latestLastCheckedAt: string | null;
  occurrenceIds: string[];
}

/**
 * Collapse the queue to one entry per (title, stored claim). Order is inherited from the
 * already-prioritised row list — the group takes the position of its best-priority member — then
 * larger groups first, because a group of 27 retires 27 rows for the same unit of attention.
 */
export function groupForReview(rows: readonly ReviewRow[]): ReviewGroup[] {
  const groups = new Map<string, ReviewGroup>();
  const firstSeen = new Map<string, number>();
  prioritise(rows).forEach((r, index) => {
    const key = `${r.activityName} ${r.storedClaim}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        activityName: r.activityName,
        storedClaim: r.storedClaim,
        severity: r.severity,
        parentReachable: r.parentReachable,
        occurrences: 0,
        reIngestedByDeployedBuild: r.reIngestedByDeployedBuild === null ? null : 0,
        earliestLastCheckedAt: null,
        latestLastCheckedAt: null,
        occurrenceIds: [],
      };
      groups.set(key, g);
      firstSeen.set(key, index);
    }
    g.occurrences += 1;
    g.occurrenceIds.push(r.occurrenceId);
    if (r.reIngestedByDeployedBuild) g.reIngestedByDeployedBuild = (g.reIngestedByDeployedBuild ?? 0) + 1;
    if (r.lastCheckedAt) {
      if (!g.earliestLastCheckedAt || r.lastCheckedAt < g.earliestLastCheckedAt) g.earliestLastCheckedAt = r.lastCheckedAt;
      if (!g.latestLastCheckedAt || r.lastCheckedAt > g.latestLastCheckedAt) g.latestLastCheckedAt = r.lastCheckedAt;
    }
  });
  return [...groups.entries()]
    .sort(([ka, a], [kb, b]) => {
      if (a.parentReachable !== b.parentReachable) return a.parentReachable ? -1 : 1;
      const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
      if (bySeverity !== 0) return bySeverity;
      if (a.occurrences !== b.occurrences) return b.occurrences - a.occurrences;
      return (firstSeen.get(ka) ?? 0) - (firstSeen.get(kb) ?? 0);
    })
    .map(([, g]) => g);
}

export const GROUP_CSV_COLUMNS = [
  'priority',
  'activity_name',
  'stored_claim',
  'severity',
  'parent_reachable',
  'occurrences',
  're_ingested_by_deployed_build',
  'earliest_last_checked_at',
  'latest_last_checked_at',
  'occurrence_ids',
  'reviewer_decision',
  'reviewer_notes',
] as const;

/** The group-level worksheet — the file a reviewer should actually open first. */
export function toGroupCsv(groups: readonly ReviewGroup[]): string {
  const lines = [GROUP_CSV_COLUMNS.join(',')];
  groups.forEach((g, i) => {
    lines.push(
      [
        i + 1,
        g.activityName,
        g.storedClaim,
        g.severity,
        g.parentReachable,
        g.occurrences,
        g.reIngestedByDeployedBuild === null ? '' : g.reIngestedByDeployedBuild,
        g.earliestLastCheckedAt,
        g.latestLastCheckedAt,
        g.occurrenceIds.join(' '),
        '',
        '',
      ]
        .map(csvCell)
        .join(',')
    );
  });
  return `${lines.join('\r\n')}\r\n`;
}

export interface LiveCrossCheck {
  /** How many of the queued ids were still present and unarchived in production at check time. */
  rowsFound: number;
  rowsMissing: number;
  /** Masking recomputed on the LIVE row rather than the snapshot. */
  maskedLive: number;
  parentReachableLive: number;
  /** Rows where snapshot-masking and live-masking disagree — i.e. the row moved under us. */
  maskingDrift: number;
  driftExamples: string[];
  checkedAt: string;
}

export interface BatchReport {
  classId: string;
  generatedFrom: string;
  deployedSince: string | null;
  headlineAmbiguous: number;
  buckets: {
    candidates: BucketSummary;
    sourceUnknown: BucketSummary;
    boundsDiffer: BucketSummary;
  };
  unclassifiedAmbiguous: number;
  queue: ReviewRow[];
  groups: ReviewGroup[];
  severityTally: Array<[Severity, number]>;
  liveCrossCheck: LiveCrossCheck | null;
}

const SEVERITY_BLURB: Record<Severity, string> = {
  'A-adult-title-child-band':
    'title reads adult/senior-only, stored band starts below 19y — §3.3’s own example shape',
  'B-open-ended-claim': 'stored claim is open-ended `[x, ∞)` — no age filter can exclude it',
  'C-infant-band': 'stored ceiling ≤ 24 months — claims "babies only"',
  'D-bounded-band': 'bounded band, no adult-title conflict',
};

const MD_COLUMNS = [
  '#',
  'severity',
  'parent-reachable',
  'activity name',
  'stored claim',
  "fixed gate's reading of the title",
  're-ingested post-deploy',
  'last checked',
  'occurrence id',
];

/**
 * The human-facing artefact. A CSV is what a reviewer will actually *work* in (it has writeback
 * columns), but a CSV cannot carry the caveat that makes this queue safe to work — that these are
 * CANDIDATES and none of them may be auto-corrected — so the markdown leads with it, and repeats
 * it immediately above the table where a reader who scrolled cannot miss it.
 */
export function toMarkdown(report: BatchReport): string {
  const b = report.buckets;
  const out: string[] = [];
  const push = (line = '') => out.push(line);

  push('# ActiveNet title-gate — REVIEW-CANDIDATE queue (classes 3 + 6, `f15d6c8` / `3b29456`)');
  push();
  push('> **These are CANDIDATES, not confirmed stale rows, and NONE of them may be auto-corrected.**');
  push('> A row is only *provably* §3h-stale if today’s parser produces nothing for it, and proving');
  push('> that needs the description — which production does not retain (`description_snippet` is NULL');
  push('> on 100% of occurrences). Every row below is "the title alone reproduces the stored bounds",');
  push('> which is strong evidence of a title-manufactured claim and is **not** proof. This is the');
  push('> diff-and-flag queue that `docs/worker-fix-backfill-scope.md` §3.3/§5/§6 recommend, nothing more.');
  push();
  push(`Generated from \`${report.generatedFrom}\` · class \`${report.classId}\``);
  if (report.deployedSince) push(`Deployed build booted \`${report.deployedSince}\``);
  push();
  push('## The review population is 633, not 2,279');
  push();
  push('The recheck headline for this class is `ambiguous: 2279`. That is **three** populations with');
  push('three different causes, and only one of them is caused by these commits:');
  push();
  push('| bucket | rows | queued? | masked by the shipped adult/senior filter | reachable by a parent today | re-ingested by the deployed build |');
  push('|---|---:|---|---:|---:|---:|');
  const bucketRow = (s: BucketSummary, queued: string) =>
    `| \`${s.reason}\` | ${s.rows} | ${queued} | ${s.masked} | ${s.parentReachable} | ${s.reIngestedByDeployedBuild ?? 'n/a'} |`;
  push(bucketRow(b.candidates, '**YES — this is the queue**'));
  push(bucketRow(b.sourceUnknown, 'no'));
  push(bucketRow(b.boundsDiffer, 'no'));
  push(`| **total (= the headline \`ambiguous\`)** | **${report.headlineAmbiguous}** | | | | |`);
  push();
  push('**Why the other two are excluded.**');
  push();
  push(`*\`${SOURCE_UNKNOWN_REASON}\` (${b.sourceUnknown.rows} rows).* The fixed gate rejects the title,`);
  push('but a title-only parse does **not** reproduce the stored bounds — so the stored claim came from');
  push('somewhere other than the title, and these commits are not what made it wrong. §3.3: *"Do not');
  push('mechanically clear the 1,154 ‘source unknown’ rows: their stored bounds did not come from the');
  push('title, so this fix is not what made them wrong."* Queueing them would attribute an unrelated');
  push('defect to this fix. They are counted here and deliberately left alone.');
  push();
  push(`*\`${BOUNDS_DIFFER_REASON}\` (${b.boundsDiffer.rows} rows).* The fixed gate still **admits** the`);
  push('title, so neither `f15d6c8` nor `3b29456` withdraws anything here. Only class 7 (`6637ae5`,');
  push('description-phrase precedence) could explain the difference, and §3.6 rules that class');
  push('structurally unmeasurable — its candidates cannot even be counted. Also left alone.');
  push();
  push('## Masking inside the 633');
  push();
  push(`- **${b.candidates.parentReachable}** of the ${b.candidates.rows} are **reachable by a parent today**.`);
  push(`- **${b.candidates.masked}** are already hidden by the shipped \`isAdultOrSeniorOnly()\` hard exclusion.`);
  push();
  push('This is computed for the candidate bucket **specifically**. The published figure');
  push('`staleOrAmbiguousMaskedBySearchFilter: 64` is across all 2,279 ambiguous rows and is not this');
  push('number; §3.3’s "504" column is *re-ingested by the deployed build*, not parent-reachability.');
  push('The predicate is imported from `lib/search/filters/audience.ts` and called, never reimplemented.');
  push();
  const maskedOutsideQueue = b.sourceUnknown.masked + b.boundsDiffer.masked;
  push('## Doubts about the 633 boundary — read before working the queue');
  push();
  push('The boundary is drawn by one discriminator, evaluated by the shipped classifier:');
  push('`sameBounds(row, parseAgeText(title))`. It is the best available and it is **necessary, not');
  push('sufficient**, and it errs in both directions:');
  push();
  push('- *False positives stay in.* A description phrase that happened to resolve to the same bounds');
  push('  is indistinguishable from a title-manufactured claim once the description is gone. That is');
  push('  the whole reason these are candidates.');
  push('- *False negatives stay out.* A claim that WAS manufactured from a title, but whose bounds were');
  push('  later partly overwritten (a widened band, an added band match), no longer reproduces from the');
  push('  title and lands in `source-unknown` — excluded from this queue by construction, including');
  push('  rows whose stored bounds are obviously wrong on their face.');
  push();
  if (maskedOutsideQueue > 0 && b.candidates.masked === 0) {
    push(`**Every one of the ${maskedOutsideQueue} ambiguous rows this class reports as masked falls OUTSIDE`);
    push('this queue.** That cuts two ways, and both are worth stating: the queue is 100% live-reachable');
    push('(good — no attention is spent on rows nobody can see), and the most visibly-wrong rows in the');
    push('class — the ones whose titles read adult-only — are all in the excluded `source-unknown` bucket,');
    push('so a reader who judges this queue by "does it contain the scary examples from the doc?" will');
    push('conclude it is wrong. It is not: those rows are excluded correctly, because their stored bounds');
    push('did not come from the title and **these commits are not what made them wrong**. They are a');
    push('separate defect deserving a separate unit of work with its own rationale.');
    push();
  }
  const openEnded = report.queue.filter((r) => r.severity === 'B-open-ended-claim').length;
  if (openEnded > 0) {
    push(`**The ${openEnded} open-ended rows deserve particular care, and "correct" may mean "leave alone".**`);
    push('They are `[0, ∞)` with `age_notes = "all-ages"` — i.e. today\'s parser maps the title to an');
    push('all-ages reading, but the fixed GATE refuses the title, so a re-ingest would write no age claim');
    push('at all. "Correcting" one therefore does not narrow a wrong band; it **removes** an all-ages');
    push('marking that may well be right. Judge each on whether the programme really is all-ages, not on');
    push('whether the gate still admits the title.');
    push();
  }
  push('Nothing here changes the recommendation. It sharpens what a reviewer should expect to find:');
  push('a queue of plausible-looking kids programming whose stored band the fixed build would no longer');
  push('assert — not a queue of obvious errors.');
  push();
  push('## Severity mix');
  push();
  push('| severity | rows | meaning |');
  push('|---|---:|---|');
  for (const [sev, n] of report.severityTally) {
    push(`| \`${sev}\` | ${n} | ${SEVERITY_BLURB[sev]} |`);
  }
  push();

  const egregious = report.queue.filter((r) => r.severity === 'A-adult-title-child-band');
  push(`## Egregious shape: adult/senior title, child-age band (${egregious.length})`);
  push();
  push('§3.3 names this shape — `"1.0-1.5 NTRP - Adult Beginner Tennis Lessons"` stored as `[0, 24)`,');
  push('adult tennis labelled for under-2s. Listed here **regardless of masking**, because it is the');
  push('clearest evidence that a stored claim was manufactured from a title.');
  push();
  if (egregious.length === 0) {
    push('**None — and that is structural, not luck.** A title that reads adult-only is exactly what');
    push('`isAdultOrSeniorOnly()` catches on its title branch, so severity A implies masked. Masked is 0');
    push('inside this bucket (see above), therefore severity A is 0 inside this bucket. The tennis row');
    push('§3.3 quotes is real, but it is **not a candidate** — see "Doubts about the 633 boundary".');
  } else {
    push('| activity name | stored claim | parent-reachable | occurrence id |');
    push('|---|---|---|---|');
    for (const r of egregious) {
      push(`| ${mdCell(r.activityName)} | \`${mdCell(r.storedClaim)}\` | ${r.parentReachable ? '**yes**' : 'no'} | \`${r.occurrenceId}\` |`);
    }
  }
  push();
  push(`## The worksheet: ${report.groups.length} decisions, not ${report.queue.length} rows`);
  push();
  push('ActiveNet publishes a recurring programme as one occurrence per session, so the queue collapses');
  push('to one decision per (title, stored claim). Work this table; `titlegate-review-groups.csv` is the');
  push('same thing with writeback columns and the occurrence ids attached.');
  push();
  push('**Candidates. Do not auto-correct. Do not bulk-clear.** If a correction is ever authorised it');
  push('must be re-checked against `isAdultOrSeniorOnly()` first — §9: a note beginning "Adults…" or');
  push('containing "ratio" changes what the search filter concludes, so a correction can silently hide');
  push('a listing it was meant to fix.');
  push();
  push('| # | severity | parent-reachable | occurrences | activity name | stored claim | re-ingested post-deploy | last checked (latest) |');
  push('|---:|---|---|---:|---|---|---:|---|');
  report.groups.forEach((g, i) => {
    push(
      `| ${i + 1} | \`${g.severity}\` | ${g.parentReachable ? '**yes**' : 'no'} | ${g.occurrences} ` +
        `| ${mdCell(g.activityName)} | \`${mdCell(g.storedClaim)}\` ` +
        `| ${g.reIngestedByDeployedBuild ?? 'n/a'} | ${mdCell(g.latestLastCheckedAt)} |`
    );
  });
  push();
  push(`## Per-occurrence queue (${report.queue.length} rows, parent-reachable first)`);
  push();
  push('The same rows, ungrouped — a correction, if ever authorised, applies per occurrence id.');
  push();
  push(`| ${MD_COLUMNS.join(' | ')} |`);
  push(`|${MD_COLUMNS.map(() => '---').join('|')}|`);
  report.queue.forEach((r, i) => {
    push(
      `| ${i + 1} | \`${r.severity}\` | ${r.parentReachable ? '**yes**' : 'no'} | ${mdCell(r.activityName)} ` +
        `| \`${mdCell(r.storedClaim)}\` | ${mdCell(r.derivedClaim)} ` +
        `| ${r.reIngestedByDeployedBuild === null ? 'n/a' : r.reIngestedByDeployedBuild ? 'yes' : 'no'} ` +
        `| ${mdCell(r.lastCheckedAt)} | \`${r.occurrenceId}\` |`
    );
  });
  push();

  if (report.liveCrossCheck) {
    const lc = report.liveCrossCheck;
    push('## Live cross-check (read-only production query)');
    push();
    push('The masking above is computed from the recheck snapshot, so that this artefact is byte-for-byte');
    push('reproducible without a database. Production was then queried READ-ONLY for the same ids and the');
    push('masking recomputed on the live row, purely as a check that the snapshot has not drifted.');
    push();
    push(`- ids queued: **${report.queue.length}** · found live and unarchived: **${lc.rowsFound}** · missing/archived since the snapshot: **${lc.rowsMissing}**`);
    push(`- masked on live values: **${lc.maskedLive}** · parent-reachable on live values: **${lc.parentReachableLive}**`);
    push(`- rows where snapshot and live masking DISAGREE: **${lc.maskingDrift}**`);
    if (lc.driftExamples.length) {
      push();
      for (const ex of lc.driftExamples) push(`  - ${mdCell(ex)}`);
    }
    push();
    push(`Checked at \`${lc.checkedAt}\`.`);
    push();
  }

  push('---');
  push();
  push('Machine-readable form of exactly this data: `titlegate-review-batch.json`.');
  push('Reviewer worksheet with writeback columns: `titlegate-review-batch.csv`.');
  push();
  return `${out.join('\n')}\n`;
}

export function tallySeverity(rows: readonly ReviewRow[]): Array<[Severity, number]> {
  const order: Severity[] = ['A-adult-title-child-band', 'B-open-ended-claim', 'C-infant-band', 'D-bounded-band'];
  return order
    .map((s) => [s, rows.filter((r) => r.severity === s).length] as [Severity, number])
    .filter(([, n]) => n > 0);
}
