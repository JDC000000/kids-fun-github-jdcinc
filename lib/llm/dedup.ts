// lib/llm/dedup.ts — G-T14-2: conservative, single-pass fuzzy dedup adjudication.
//
// Cross-source duplicate occurrences (same real-world activity ingested from two sources)
// are detected deterministically (same start instant + a title trigram over the blocking
// floor), then adjudicated by Haiku. The apply is fail-closed:
//   • AUTO-MERGE only when the model is ≥ DEDUP_AUTO_MERGE_MIN_CONFIDENCE AND the
//     deterministic title similarity ≥ DEDUP_AUTO_MERGE_MIN_SIMILARITY (defense in depth —
//     never merge on the model's word alone). Merge = the REAL provenance-preserving merge
//     (lib/llm/dedup-merge.ts): re-point the lower-authority duplicate's provenance onto the
//     surviving canonical, archive the duplicate, stamp the canonical's reserved dedup_key,
//     + write a system audit row. (G-T14-3 replaced the earlier silent archive that orphaned
//     the duplicate's provenance.)
//   • Otherwise ROUTE TO REVIEW: flag the duplicate as status_state='manual_candidate' so it
//     surfaces in the EXISTING T34 QA queue for a human to confirm/reject (that human action
//     IS audited, via app/admin/qa-queue). We never guess a merge.
//   • A confident "not a duplicate" is SKIPPED (leave both visible — the safe failure mode;
//     over-merging hides a real distinct activity, under-merging just shows a redundant row).
//
// Single conservative pass only — no re-scoring / ensemble / multi-pass (deferred).
import type { PoolClient } from 'pg';
import { query } from '@/lib/db/client';
import { similarity } from '@/lib/search/text/trigram';
import {
  DEDUP_AUTO_MERGE_MIN_CONFIDENCE,
  DEDUP_AUTO_MERGE_MIN_SIMILARITY,
  DEDUP_BLOCKING_MIN_SIMILARITY,
  DEDUP_REVIEW_MIN_SIMILARITY,
  JOB_NAMES,
  batchModel,
  maxCandidates as configMaxCandidates,
} from './config';
import type { AnthropicBatchClient, BatchRequest } from './anthropic-client';
import { runBatch } from './batch';
import { withServiceTransaction } from './db';
import { mergeOccurrencesTx } from './dedup-merge';
import { advanceWatermark, recordDecision, recordNonAdvancingRun, runTimestamp, watermarkPredicate } from './watermark';
import {
  DEDUP_OUTPUT_CONFIG,
  buildDedupSystem,
  buildDedupUser,
  parseDedupVerdict,
  textOf,
  type DedupVerdict,
} from './prompts';

// Higher authority = lower rank. Mirrors source.authority_tier (0003_core_places).
const AUTHORITY_RANK: Record<string, number> = { official: 0, editorial: 1, partner: 2, manual: 3 };
const CONFIDENCE_RANK: Record<string, number> = { high: 0, medium: 1, low: 2, unscored: 3 };

export interface OccurrenceSide {
  id: string;
  name: string;
  description: string | null;
  sourceName: string;
  authorityTier: string;
  confidenceLabel: string;
  createdAt: string;
}

export interface DedupCandidate {
  left: OccurrenceSide;
  right: OccurrenceSide;
  startUtc: string | null;
  /**
   * Deterministic title trigram similarity (lib/search/text/trigram).
   *
   * NOT pg_trgm-compatible, despite that module's header — measured, not assumed. It
   * normalises first, which deletes every non-Latin character, so it disagrees with the
   * pg_trgm score that SELECTED the pair in both directions, and returns 1.0 (the maximum)
   * whenever both titles erase to empty. See DEDUP_REVIEW_MIN_SIMILARITY in ./config for the
   * measurements and what it does and does not put at risk.
   */
  deterministicScore: number;
  /** Stable custom_id for the batch request (order-independent pair key). */
  customId: string;
}

export type DedupAction = 'auto_merge' | 'route_to_review' | 'skip';

export interface DedupDecision {
  action: DedupAction;
  /** The surviving record (kept) — set for auto_merge. */
  canonicalId: string;
  /** The redundant record (archived on auto_merge / flagged on route_to_review). */
  duplicateId: string;
  deterministicScore: number;
  llmConfidence: number | null;
  reason: string;
  /**
   * How the two sides' venue rows relate. A REVIEW SIGNAL recorded alongside the decision so
   * the adjudicated pairs are analysable as a labelled set later — never a filter, and unset
   * on the LLM path, which does not read venue at all. See {@link decideDedupDeterministic}.
   */
  venueSignal?: VenueSignal;
}

/** Lower tuple sorts as the canonical (kept): higher authority, then higher confidence, then older, then smaller id. */
function rank(side: OccurrenceSide): [number, number, number, string] {
  return [
    AUTHORITY_RANK[side.authorityTier] ?? 99,
    CONFIDENCE_RANK[side.confidenceLabel] ?? 99,
    new Date(side.createdAt).getTime(),
    side.id,
  ];
}

/** Choose canonical (kept) vs duplicate (archived/flagged) deterministically. */
export function chooseCanonical(a: OccurrenceSide, b: OccurrenceSide): { canonical: OccurrenceSide; duplicate: OccurrenceSide } {
  const ra = rank(a);
  const rb = rank(b);
  for (let i = 0; i < ra.length; i++) {
    if (ra[i] < rb[i]) return { canonical: a, duplicate: b };
    if (ra[i] > rb[i]) return { canonical: b, duplicate: a };
  }
  return { canonical: a, duplicate: b };
}

/**
 * PURE adjudication decision. Fail-closed: a null verdict (errored / unparseable) routes to
 * human review; a confident non-duplicate is skipped; a merge requires BOTH a high model
 * confidence AND deterministic corroboration.
 */
export function decideDedup(candidate: DedupCandidate, verdict: DedupVerdict | null): DedupDecision {
  const { canonical, duplicate } = chooseCanonical(candidate.left, candidate.right);
  const base = {
    canonicalId: canonical.id,
    duplicateId: duplicate.id,
    deterministicScore: candidate.deterministicScore,
    llmConfidence: verdict?.confidence ?? null,
  };

  if (!verdict) {
    return { ...base, action: 'route_to_review', reason: 'No usable model verdict; routed to human review.' };
  }
  if (!verdict.isDuplicate) {
    return { ...base, action: 'skip', reason: verdict.reason || 'Model judged the records distinct.' };
  }
  const clears =
    verdict.confidence >= DEDUP_AUTO_MERGE_MIN_CONFIDENCE &&
    candidate.deterministicScore >= DEDUP_AUTO_MERGE_MIN_SIMILARITY;
  if (clears) {
    return { ...base, action: 'auto_merge', reason: verdict.reason || 'High-confidence cross-source duplicate.' };
  }
  return { ...base, action: 'route_to_review', reason: verdict.reason || 'Possible duplicate below auto-merge bar.' };
}

// ── Option D: deterministic adjudication, no model ────────────────────────────────────────
//
// Same detector, same apply path, same QA queue — with the model removed from the loop and
// AUTO-MERGE MADE UNREACHABLE RATHER THAN MERELY UNLIKELY. The reason this is a separate
// decider and a separate runner (not a `mode` flag on the pair above) is that a flag leaves
// the merge branch on the same code path, one boolean away; a decider whose RETURN TYPE
// cannot express 'auto_merge' and a runner that takes NO batch client cannot reach it at all,
// and the compiler enforces both.
//
// Measured justification, from a read-only pg_trgm estimate against production: of 626 live
// occurrences, the blocker produces exactly 40 candidate pairs — every one of them Richmond
// Public Library × Vancouver Public Library, and every one of them ABOVE the 0.55 auto-merge
// similarity bar. They are two different library branches running a same-named programme in
// the same half-hour slot: 40 real, distinct events. An auto-merge would archive all 40
// irreversibly and, per dedup-merge.ts's canonicalSourceFamilies, would make each fabricated
// canonical look BETTER corroborated than a true one. A false merge is decisively worse than
// a false split, so this path takes the cheap error visibly and makes the expensive one
// impossible.

/** The deterministic path's action space. 'auto_merge' is excluded BY TYPE, not by policy. */
export type DeterministicDedupAction = Exclude<DedupAction, 'auto_merge'>;

/**
 * A decision reached without a model. Narrows {@link DedupDecision} twice, and both
 * narrowings are load-bearing: `action` cannot be 'auto_merge', and `llmConfidence` is
 * pinned to `null` because nothing was asked and "no opinion" must never be recorded as a
 * number a later reader could threshold on.
 */
export interface DeterministicDedupDecision extends DedupDecision {
  action: DeterministicDedupAction;
  llmConfidence: null;
}

/** How the two sides' venue rows relate. A REVIEW SIGNAL shown to the human — never a filter. */
export type VenueSignal = 'same_venue' | 'different_venue' | 'venue_unknown';

/** Venue identity per occurrence, keyed by occurrence id (absent = no venue on the series). */
export type VenueLookup = ReadonlyMap<string, { venueId: string; venueName: string }>;

function venueSignalFor(candidate: DedupCandidate, venues: VenueLookup): { signal: VenueSignal; note: string } {
  const l = venues.get(candidate.left.id);
  const r = venues.get(candidate.right.id);
  if (!l || !r) return { signal: 'venue_unknown', note: 'venue unknown on at least one side' };
  if (l.venueId === r.venueId) return { signal: 'same_venue', note: `same venue (${l.venueName})` };
  return { signal: 'different_venue', note: `DIFFERENT venue rows — "${l.venueName}" vs "${r.venueName}"` };
}

/**
 * PURE deterministic adjudication — the whole of Option D's judgement.
 *
 * Routes every detected pair at or above {@link DEDUP_REVIEW_MIN_SIMILARITY} to the existing
 * human QA queue and skips the rest. It never merges, and it never can: the return type has
 * no 'auto_merge' member, so a future edit that tries to add one is a compile error rather
 * than a silent escalation of an irreversible action.
 *
 * `venueSignal` is threaded into the reason string the reviewer actually reads (the QA queue
 * renders `detail->>'reason'`). It is DELIBERATELY not a predicate. All 40 real production
 * pairs have populated, differing venue_ids, so excluding on that would "solve" them at a
 * stroke — but `venue` has no unique constraint on any column, so two venue rows may describe
 * one physical place. Venue identity is itself an unresolved problem (G-T14-1). Letting an
 * unresolved key silently decide a merge-or-not question is how a false split becomes
 * invisible; showing it to a human is how it becomes a judgement.
 */
export function decideDedupDeterministic(candidate: DedupCandidate, venues?: VenueLookup): DeterministicDedupDecision {
  const { canonical, duplicate } = chooseCanonical(candidate.left, candidate.right);
  const venue = venueSignalFor(candidate, venues ?? new Map());
  const base = {
    canonicalId: canonical.id,
    duplicateId: duplicate.id,
    deterministicScore: candidate.deterministicScore,
    llmConfidence: null,
    venueSignal: venue.signal,
  } as const;

  // A NaN score fails this comparison and lands in `skip` — the non-mutating branch. That is
  // the fail-safe direction here: the expensive error is a merge, and there is none to reach.
  if (candidate.deterministicScore >= DEDUP_REVIEW_MIN_SIMILARITY) {
    return {
      ...base,
      action: 'route_to_review',
      reason:
        `Deterministic title match ${candidate.deterministicScore.toFixed(2)} at an identical start time, ` +
        `across ${candidate.left.sourceName} and ${candidate.right.sourceName} — ${venue.note}. ` +
        `No model was consulted; a human decides whether these are the same event.`,
    };
  }
  return {
    ...base,
    action: 'skip',
    reason: `Deterministic title similarity ${candidate.deterministicScore.toFixed(2)} below the review floor.`,
  };
}

/** Occurrence → venue for the candidate set, in one round trip. Missing venue_id ⇒ absent. */
async function loadVenues(occurrenceIds: string[]): Promise<VenueLookup> {
  const map = new Map<string, { venueId: string; venueName: string }>();
  if (occurrenceIds.length === 0) return map;
  const rows = await query<{ occurrence_id: string; venue_id: string; venue_name: string }>(
    `SELECT o.id AS occurrence_id, v.id AS venue_id, v.name AS venue_name
       FROM activity_occurrence o
       JOIN activity_series ser ON ser.id = o.series_id
       JOIN venue v ON v.id = ser.venue_id
      WHERE o.id = ANY($1::uuid[])`,
    [occurrenceIds]
  );
  for (const row of rows) map.set(row.occurrence_id, { venueId: row.venue_id, venueName: row.venue_name });
  return map;
}

export interface DedupDetectOnlyRunResult {
  useCase: 'dedup';
  mode: 'deterministic';
  considered: number;
  routedToReview: number;
  skipped: number;
  actioned: number;
  /**
   * Structurally 0 — the literal type is the point. This path has no merge branch, so the
   * field exists only so a caller comparing run results cannot read an ABSENT field as
   * "not measured". If this ever needs to be `number`, something has gone badly wrong.
   */
  autoMerged: 0;
  /** No batch was built, so nothing was submitted. Also a literal type. */
  submitted: false;
}

export interface DedupDetectOnlyRunOptions {
  /** Count candidates and write nothing but the non-advancing run row (observe-only). */
  dryRun?: boolean;
  maxCandidates?: number;
}

/**
 * Run the dedup use case with NO model: detect, adjudicate deterministically, route to the
 * existing human queue. Takes no {@link AnthropicBatchClient}, builds no request and imports
 * no prompt — a live API call is not merely disabled here, it is unrepresentable.
 *
 * Shares JOB_NAMES.dedup's watermark with the LLM runner deliberately: this is the same job
 * with a different adjudicator. `last_status` is stamped distinctly so the run is
 * attributable in llm_batch_run.
 *
 * WHAT THIS RUN ACTUALLY CHANGES — corrected against the columns, because the first version
 * of this comment ("the only state change is status_state → manual_candidate, which the
 * reject action reverses") was wrong on BOTH halves:
 *
 *   1. It writes status_state='manual_candidate' AND OVERWRITES last_checked_at. The prior
 *      value is lost; there is no history column. That matters beyond bookkeeping:
 *      last_checked_at IS THE INPUT TO THE STALE FLIP (worker/health/stale.ts flips rows
 *      whose last_checked_at is older than grace × cadence), so routing a pair for review
 *      silently RESETS ITS STALENESS CLOCK.
 *   2. Reject does NOT restore the prior state — rejectDedupPair sets 'confirmed'. Via
 *      STATUS_CLASS (lib/search/filters/status.ts) that is a visibility RATCHET, not a
 *      round trip: needs_review is 'hidden' (filtered out of results entirely),
 *      manual_candidate is 'expected', confirmed is 'primary'. So a row can go from not
 *      shown at all → shown in the expected section → fully promoted, purely by being
 *      routed and then judged "not a duplicate".
 *
 * Both are recoverable states, and nothing here archives a record, stamps a dedup_key or
 * moves provenance — the irreversible actions remain unreachable. But "nothing changes
 * except a reversible status flag" was not true, and is not claimed here.
 *
 * A SECOND CORRECTION, MEASURED: the claim that routed rows "leave the candidate pool" is
 * only true of the detector's LEFT side. detectDedupCandidates excludes
 * status_state='manual_candidate' when choosing fresh rows, but the right-side JOIN has no
 * status predicate at all (nor a dedup_key one), so a routed row can still be returned as
 * another row's match. And the exclusion does not survive adjudication: a human answering
 * "not a duplicate" sets 'confirmed', which the left side ACCEPTS, while the reject's own
 * last_checked_at bump clears the watermark — so the very next run RE-ROUTES the pair the
 * human just dismissed. Measured on a seeded pair: run 1 routed it, reject returned ok and
 * set 'confirmed', run 2 flagged it manual_candidate again. Nothing marks a pair as
 * adjudicated, so a rejection is not durable. Escalated rather than patched here — the fix
 * is a design decision about where "already judged" is recorded, not a comment.
 */
export async function runDedupDetectOnlyUseCase(
  opts: DedupDetectOnlyRunOptions = {}
): Promise<DedupDetectOnlyRunResult> {
  const limit = opts.maxCandidates ?? configMaxCandidates();
  const runStart = await runTimestamp();
  const candidates = await detectDedupCandidates(limit);

  const result: DedupDetectOnlyRunResult = {
    useCase: 'dedup',
    mode: 'deterministic',
    considered: candidates.length,
    routedToReview: 0,
    skipped: 0,
    actioned: 0,
    autoMerged: 0,
    submitted: false,
  };

  if (opts.dryRun) {
    await recordNonAdvancingRun(JOB_NAMES.dedup, 'dry_run_deterministic', { considered: candidates.length, actioned: 0 });
    return result;
  }
  if (candidates.length === 0) {
    await advanceWatermark(JOB_NAMES.dedup, runStart, { considered: 0, actioned: 0, status: 'ok_deterministic' });
    return result;
  }

  const venues = await loadVenues(candidates.flatMap((c) => [c.left.id, c.right.id]));
  for (const candidate of candidates) {
    const decision = decideDedupDeterministic(candidate, venues);
    // The SAME applyDedupDecision the LLM path uses — but reachable only on its
    // route_to_review / skip branches, because `decision.action` cannot be 'auto_merge'.
    const actioned = await applyDedupDecision(candidate, decision);
    if (decision.action === 'route_to_review') result.routedToReview += 1;
    else result.skipped += 1;
    if (actioned) result.actioned += 1;
  }

  await advanceWatermark(JOB_NAMES.dedup, runStart, {
    considered: result.considered,
    actioned: result.actioned,
    status: 'ok_deterministic',
  });
  return result;
}

/** Build the Message-Batches request for one candidate pair (cacheable prefix + volatile body). */
export function buildDedupRequest(candidate: DedupCandidate): BatchRequest {
  return {
    custom_id: candidate.customId,
    params: {
      model: batchModel(),
      max_tokens: 256,
      system: buildDedupSystem(),
      messages: [
        {
          role: 'user',
          content: buildDedupUser({
            leftSource: candidate.left.sourceName,
            leftName: candidate.left.name,
            leftDescription: candidate.left.description,
            rightSource: candidate.right.sourceName,
            rightName: candidate.right.name,
            rightDescription: candidate.right.description,
            startUtc: candidate.startUtc,
          }),
        },
      ],
      output_config: DEDUP_OUTPUT_CONFIG,
    },
  };
}

interface DedupCandidateRow {
  left_id: string;
  left_name: string;
  left_desc: string | null;
  left_source: string;
  left_authority: string;
  left_conf: string;
  left_created: string;
  right_id: string;
  right_name: string;
  right_desc: string | null;
  right_source: string;
  right_authority: string;
  right_conf: string;
  right_created: string;
  start_utc: string | null;
}

/** Order-independent, INTERNAL pair key so A↔B collapses to one candidate regardless of side. */
function pairKey(idA: string, idB: string): string {
  return idA < idB ? `${idA}|${idB}` : `${idB}|${idA}`;
}

/**
 * The batch request custom_id. Anthropic requires custom_id to match `^[a-zA-Z0-9_-]{1,64}$`,
 * so it can't be the colon-joined pair key (colons are illegal; two UUIDs exceed 64 chars).
 * The fresh left occurrence id is unique per candidate row (DISTINCT ON f.id) and is a UUID
 * (hex + hyphens = 42 chars with the prefix, all legal), so it is a valid, stable key.
 */
function dedupCustomId(leftId: string): string {
  return `dedup-${leftId}`;
}

/**
 * Detect cross-source duplicate candidates changed since the last run. Deterministic
 * blocking: same start instant, different source, title trigram ≥ blocking floor. One best
 * match per fresh left occurrence, de-duplicated to one row per unordered pair.
 */
export async function detectDedupCandidates(limit = configMaxCandidates()): Promise<DedupCandidate[]> {
  const rows = await query<DedupCandidateRow>(
    `WITH fresh AS (
       SELECT o.id, o.series_id, o.activity_name, o.description_snippet,
              o.start_datetime_utc, o.created_at, o.confidence_label,
              ser.source_id, s.name AS source_name, s.authority_tier
         FROM activity_occurrence o
         JOIN activity_series ser ON ser.id = o.series_id
         JOIN source s ON s.id = ser.source_id
        WHERE o.archived_at IS NULL
          AND o.dedup_key IS NULL
          AND o.status_state <> 'manual_candidate'
          AND o.start_datetime_utc IS NOT NULL
          AND ${watermarkPredicate('o', 1)}
        ORDER BY o.created_at
        LIMIT $2::int
     )
     SELECT DISTINCT ON (f.id)
       f.id AS left_id, f.activity_name AS left_name, f.description_snippet AS left_desc,
       f.source_name AS left_source, f.authority_tier AS left_authority, f.confidence_label AS left_conf,
       f.created_at::text AS left_created,
       r.id AS right_id, r.activity_name AS right_name, r.description_snippet AS right_desc,
       rsrc.name AS right_source, rsrc.authority_tier AS right_authority, r.confidence_label AS right_conf,
       r.created_at::text AS right_created,
       f.start_datetime_utc::text AS start_utc
       FROM fresh f
       JOIN activity_occurrence r
         ON r.start_datetime_utc = f.start_datetime_utc
        AND r.archived_at IS NULL
        AND r.id <> f.id
       JOIN activity_series rs ON rs.id = r.series_id AND rs.source_id <> f.source_id
       JOIN source rsrc ON rsrc.id = rs.source_id
      WHERE similarity(f.activity_name, r.activity_name) >= $3::float8
      ORDER BY f.id, similarity(f.activity_name, r.activity_name) DESC, r.id`,
    [JOB_NAMES.dedup, limit, DEDUP_BLOCKING_MIN_SIMILARITY]
  );

  const seen = new Set<string>();
  const candidates: DedupCandidate[] = [];
  for (const row of rows) {
    const key = pairKey(row.left_id, row.right_id);
    if (seen.has(key)) continue; // collapse symmetric A-left/B-left rows to one pair
    seen.add(key);
    candidates.push({
      left: {
        id: row.left_id,
        name: row.left_name,
        description: row.left_desc,
        sourceName: row.left_source,
        authorityTier: row.left_authority,
        confidenceLabel: row.left_conf,
        createdAt: row.left_created,
      },
      right: {
        id: row.right_id,
        name: row.right_name,
        description: row.right_desc,
        sourceName: row.right_source,
        authorityTier: row.right_authority,
        confidenceLabel: row.right_conf,
        createdAt: row.right_created,
      },
      startUtc: row.start_utc,
      // Authoritative deterministic score for the threshold check (in-app, testable).
      deterministicScore: similarity(row.left_name, row.right_name),
      customId: dedupCustomId(row.left_id),
    });
  }
  return candidates;
}

/** Apply one decision transactionally + record the system audit row. Returns true if it actioned a record. */
export async function applyDedupDecision(candidate: DedupCandidate, decision: DedupDecision): Promise<boolean> {
  return withServiceTransaction(async (client: PoolClient) => {
    if (decision.action === 'auto_merge') {
      // Real provenance-preserving merge (G-T14-3): re-point the duplicate's provenance
      // rows onto the canonical, THEN archive the duplicate + stamp the canonical's
      // dedup_key — instead of the original silent archive that orphaned the duplicate's
      // provenance. Idempotent / concurrency-safe via mergeOccurrencesTx's claim guard.
      const outcome = await mergeOccurrencesTx(client, decision.canonicalId, decision.duplicateId);
      await recordDecision(
        {
          jobName: JOB_NAMES.dedup,
          useCase: 'dedup',
          targetId: decision.duplicateId,
          relatedId: decision.canonicalId,
          customId: candidate.customId,
          action: 'auto_merge',
          deterministicScore: decision.deterministicScore,
          llmConfidence: decision.llmConfidence,
          detail: {
            reason: decision.reason,
            canonical: decision.canonicalId,
            mergeStatus: outcome.status,
            provenanceMoved: outcome.provenanceMoved,
          },
        },
        client
      );
      return outcome.status === 'merged';
    }

    if (decision.action === 'route_to_review') {
      // Flag the duplicate into the EXISTING QA queue's review state (idempotent).
      const flagged = await client.query(
        `UPDATE activity_occurrence
            SET status_state = 'manual_candidate', last_checked_at = now()
          WHERE id = $1 AND archived_at IS NULL AND status_state <> 'manual_candidate'`,
        [decision.duplicateId]
      );
      await recordDecision(
        {
          jobName: JOB_NAMES.dedup,
          useCase: 'dedup',
          targetId: decision.duplicateId,
          relatedId: decision.canonicalId,
          customId: candidate.customId,
          action: 'route_to_review',
          deterministicScore: decision.deterministicScore,
          llmConfidence: decision.llmConfidence,
          detail: {
            reason: decision.reason,
            suspectedDuplicateOf: decision.canonicalId,
            // Present only on the deterministic path; omitted rather than null-padded so an
            // LLM-era row is distinguishable from a deterministic one with no venue data.
            ...(decision.venueSignal ? { venueSignal: decision.venueSignal } : {}),
          },
        },
        client
      );
      return (flagged.rowCount ?? 0) > 0;
    }

    // skip — record the (non-)decision for auditability, no mutation.
    await recordDecision(
      {
        jobName: JOB_NAMES.dedup,
        useCase: 'dedup',
        targetId: decision.duplicateId,
        relatedId: decision.canonicalId,
        customId: candidate.customId,
        action: 'skip',
        deterministicScore: decision.deterministicScore,
        llmConfidence: decision.llmConfidence,
        detail: { reason: decision.reason },
      },
      client
    );
    return false;
  });
}

export interface DedupRunResult {
  useCase: 'dedup';
  considered: number;
  autoMerged: number;
  routedToReview: number;
  skipped: number;
  actioned: number;
  submitted: boolean;
}

export interface DedupRunOptions {
  dryRun: boolean;
  pollIntervalMs?: number;
  maxCandidates?: number;
}

/** Orchestrate the dedup use case end-to-end for one nightly run. */
export async function runDedupUseCase(client: AnthropicBatchClient, opts: DedupRunOptions): Promise<DedupRunResult> {
  const limit = opts.maxCandidates ?? configMaxCandidates();
  const runStart = await runTimestamp();
  const candidates = await detectDedupCandidates(limit);

  const result: DedupRunResult = {
    useCase: 'dedup',
    considered: candidates.length,
    autoMerged: 0,
    routedToReview: 0,
    skipped: 0,
    actioned: 0,
    submitted: false,
  };

  if (opts.dryRun) {
    await recordNonAdvancingRun(JOB_NAMES.dedup, 'dry_run', { considered: candidates.length, actioned: 0 });
    return result;
  }
  if (candidates.length === 0) {
    await advanceWatermark(JOB_NAMES.dedup, runStart, { considered: 0, actioned: 0 });
    return result;
  }

  const requests = candidates.map(buildDedupRequest);
  const outcome = await runBatch(client, requests, { pollIntervalMs: opts.pollIntervalMs });
  result.submitted = true;

  for (const candidate of candidates) {
    const item = outcome.results.get(candidate.customId);
    const verdict =
      item && item.result.type === 'succeeded' ? parseDedupVerdict(textOf(item.result.message.content)) : null;
    const decision = decideDedup(candidate, verdict);
    const actioned = await applyDedupDecision(candidate, decision);
    if (decision.action === 'auto_merge') result.autoMerged += 1;
    else if (decision.action === 'route_to_review') result.routedToReview += 1;
    else result.skipped += 1;
    if (actioned) result.actioned += 1;
  }

  if (outcome.timedOut) {
    // Some candidates got no verdict; leaving the watermark UNADVANCED means the next run
    // reconsiders them (the state guards make already-actioned records no-ops).
    await recordNonAdvancingRun(JOB_NAMES.dedup, 'partial', { considered: result.considered, actioned: result.actioned });
  } else {
    await advanceWatermark(JOB_NAMES.dedup, runStart, { considered: result.considered, actioned: result.actioned });
  }
  return result;
}
