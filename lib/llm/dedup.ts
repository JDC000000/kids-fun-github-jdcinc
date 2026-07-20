// lib/llm/dedup.ts — G-T14-2: conservative, single-pass fuzzy dedup adjudication.
//
// Cross-source duplicate occurrences (same real-world activity ingested from two sources)
// are detected deterministically (same start instant + a title trigram over the blocking
// floor), then adjudicated by Haiku. The apply is fail-closed:
//   • AUTO-MERGE only when the model is ≥ DEDUP_AUTO_MERGE_MIN_CONFIDENCE AND the
//     deterministic title similarity ≥ DEDUP_AUTO_MERGE_MIN_SIMILARITY (defense in depth —
//     never merge on the model's word alone). Merge = archive the lower-authority duplicate
//     + stamp the surviving canonical's reserved dedup_key + write a system audit row.
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
  JOB_NAMES,
  batchModel,
  maxCandidates as configMaxCandidates,
} from './config';
import type { AnthropicBatchClient, BatchRequest } from './anthropic-client';
import { runBatch } from './batch';
import { withServiceTransaction } from './db';
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
  /** Deterministic title trigram similarity (lib/search/text/trigram; pg_trgm-compatible). */
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
      // Archive the duplicate (idempotent: only if still live) …
      const archived = await client.query(
        `UPDATE activity_occurrence
            SET archived_at = now(), last_checked_at = now()
          WHERE id = $1 AND archived_at IS NULL`,
        [decision.duplicateId]
      );
      // … and stamp the surviving canonical's reserved dedup_key (idempotent: only if unset).
      await client.query(
        `UPDATE activity_occurrence
            SET dedup_key = $2, last_checked_at = now()
          WHERE id = $1 AND dedup_key IS NULL`,
        [decision.canonicalId, `dedup:v1:${decision.canonicalId}`]
      );
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
          detail: { reason: decision.reason, canonical: decision.canonicalId },
        },
        client
      );
      return (archived.rowCount ?? 0) > 0;
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
          detail: { reason: decision.reason, suspectedDuplicateOf: decision.canonicalId },
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
