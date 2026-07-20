// lib/llm/category-cost-fallback.ts — G-T13-5 (category/cost extension): LLM fallback for the
// primary CATEGORY and COST that the deterministic pipeline could NOT resolve.
//
// SCOPE: strictly the residue, exactly mirroring the age fallback's shape (lib/llm/age-fallback.ts).
//   • CATEGORY residue — worker/core/taxonomy.ts's classifyPrimaryCategory only maps clear
//     hints/title words into a specific category; anything else lands on the generic
//     'class_program' fallback (certainty 'generic') or, if the id lookup failed, no category at
//     all. We target exactly those rows and try to place them MORE specifically. We NEVER
//     override a confident deterministic classification.
//   • COST residue — worker/core/adapter.ts leaves cost_status='unknown' when the source exposes
//     no structured price. We target exactly those rows and try to extract a concrete cost.
// The deterministic path keeps owning every clear case; this is a fallback for the stuck ones.
//
// Fail-closed apply (per field, independently):
//   • category: apply the resolved specific category only if the record needed one AND the model
//     confidence ≥ CATEGORY_APPLY_MIN_CONFIDENCE AND the key resolves to a primary-eligible
//     category id (reusing worker/core/taxonomy.resolvePrimaryCategoryId — never a parallel lookup).
//   • cost: apply only the CONCRETE outcomes 'free' / 'known' at ≥ COST_APPLY_MIN_CONFIDENCE; a
//     bare 'check_source' hint or anything below the bar is a no-op (cost stays 'unknown').
//   • otherwise → NO-OP; nothing is written but the decision is still audited so the record is
//     not reprocessed (see the idempotency note below).
//
// INCREMENTAL / IDEMPOTENT: like the age fallback we only consider records changed since the last
// successful run (watermarkPredicate). But unlike age — which stamps a terminal marker into
// occurrence_age.age_notes — a resolved category/cost apply does NOT change the deterministic
// trigger (the title still classifies 'generic'; a re-ingest may re-touch the row). So the
// TERMINAL guard here is an ANTI-JOIN on the llm_batch_decision audit trail: once this job has
// recorded ANY decision (apply or no-op) for an occurrence, it is never reconsidered. This needs
// no schema change and keeps the whole feature inside lib/llm/*.
import type { PoolClient } from 'pg';
import { query, getPool } from '@/lib/db/client';
import { classifyPrimaryCategory, resolvePrimaryCategoryId } from '@/worker/core/taxonomy';
import type { StructuredRecord } from '@/worker/core/adapter';
import {
  CATEGORY_APPLY_MIN_CONFIDENCE,
  COST_APPLY_MIN_CONFIDENCE,
  JOB_NAMES,
  batchModel,
  maxCandidates as configMaxCandidates,
} from './config';
import type { AnthropicBatchClient, BatchRequest } from './anthropic-client';
import { runBatch } from './batch';
import { withServiceTransaction } from './db';
import { advanceWatermark, recordDecision, recordNonAdvancingRun, runTimestamp, watermarkPredicate } from './watermark';
import {
  CATEGORY_COST_OUTPUT_CONFIG,
  buildCategoryCostSystem,
  buildCategoryCostUser,
  parseCategoryCostVerdict,
  textOf,
  type AllowedCategoryKey,
  type AllowedCostStatus,
  type CategoryCostVerdict,
} from './prompts';

/**
 * The generic primary-category key the deterministic parser falls back to — derived FROM the
 * taxonomy itself (an empty record classifies to the generic default), so there is no hardcoded
 * copy of the key here to drift from worker/core/taxonomy.ts.
 */
export const FALLBACK_CATEGORY_KEY = classifyPrimaryCategory({ title: '', categoryHint: undefined }).key;

export interface CategoryCostCandidate {
  occurrenceId: string;
  activityName: string;
  description: string | null;
  /** True when the deterministic classifier only mustered the generic fallback (or no) category. */
  needsCategory: boolean;
  /** True when cost_status is still 'unknown'. */
  needsCost: boolean;
  /** The occurrence's current primary_category_id (null or the fallback), for an idempotent guard. */
  currentCategoryId: string | null;
  customId: string;
}

export interface CategoryCostDecision {
  applyCategory: boolean;
  /** The specific category key to write (set only when applyCategory). */
  categoryKey: AllowedCategoryKey | null;
  categoryConfidence: number | null;
  applyCost: boolean;
  costStatus: AllowedCostStatus | null;
  costMinCad: number | null;
  costMaxCad: number | null;
  costConfidence: number | null;
  reason: string;
}

/**
 * PURE decision: apply each field independently, only when the record needed it AND the model
 * cleared that field's confidence bar. Cost applies only the concrete outcomes ('free'/'known');
 * 'check_source', null, or a bad amount is a cost no-op. A null verdict is a full no-op.
 */
export function decideCategoryCost(candidate: CategoryCostCandidate, verdict: CategoryCostVerdict | null): CategoryCostDecision {
  if (!verdict) {
    return {
      applyCategory: false,
      categoryKey: null,
      categoryConfidence: null,
      applyCost: false,
      costStatus: null,
      costMinCad: null,
      costMaxCad: null,
      costConfidence: null,
      reason: 'No usable model verdict.',
    };
  }

  const applyCategory =
    candidate.needsCategory && verdict.primaryCategory !== null && verdict.categoryConfidence >= CATEGORY_APPLY_MIN_CONFIDENCE;

  let applyCost = false;
  let costStatus: AllowedCostStatus | null = null;
  let costMinCad: number | null = null;
  let costMaxCad: number | null = null;
  if (candidate.needsCost && verdict.costConfidence >= COST_APPLY_MIN_CONFIDENCE) {
    if (verdict.costStatus === 'free') {
      applyCost = true;
      costStatus = 'free';
      costMinCad = 0;
      costMaxCad = 0;
    } else if (verdict.costStatus === 'known') {
      const min = verdict.costMinCad;
      const max = verdict.costMaxCad;
      // Require a sound non-negative minimum; a range's upper bound must not be below it.
      if (min !== null && min >= 0 && (max === null || max >= min)) {
        applyCost = true;
        costStatus = 'known';
        costMinCad = min;
        costMaxCad = max;
      }
    }
    // 'check_source' / null → deliberately NOT applied in this conservative first version.
  }

  return {
    applyCategory,
    categoryKey: applyCategory ? verdict.primaryCategory : null,
    categoryConfidence: verdict.categoryConfidence,
    applyCost,
    costStatus,
    costMinCad,
    costMaxCad,
    costConfidence: verdict.costConfidence,
    reason: verdict.reason || 'Category/cost extraction.',
  };
}

/** Build the Message-Batches request for one stuck record (cacheable prefix + volatile body). */
export function buildCategoryCostRequest(candidate: CategoryCostCandidate): BatchRequest {
  return {
    custom_id: candidate.customId,
    params: {
      model: batchModel(),
      max_tokens: 256,
      system: buildCategoryCostSystem(),
      messages: [
        {
          role: 'user',
          content: buildCategoryCostUser({
            activityName: candidate.activityName,
            description: candidate.description,
            needsCategory: candidate.needsCategory,
            needsCost: candidate.needsCost,
          }),
        },
      ],
      output_config: CATEGORY_COST_OUTPUT_CONFIG,
    },
  };
}

interface CategoryCostCandidateRow {
  id: string;
  activity_name: string;
  description_snippet: string | null;
  cost_status: string;
  primary_category_id: string | null;
  category_key: string | null;
}

/**
 * Detect occurrences whose category and/or cost signal is genuinely absent/too weak, changed
 * since the last run, and NOT already decided by this job. SQL pre-filters on the cheap DB
 * signals (cost 'unknown' OR category null/fallback); the authoritative refinement re-runs the
 * deterministic classifier (classifyPrimaryCategory) in TS so we only ask the model about rows
 * the deterministic path really left generic.
 */
export async function detectCategoryCostCandidates(limit = configMaxCandidates()): Promise<CategoryCostCandidate[]> {
  const rows = await query<CategoryCostCandidateRow>(
    `SELECT o.id, o.activity_name, o.description_snippet, o.cost_status::text AS cost_status,
            o.primary_category_id, c.key AS category_key
       FROM activity_occurrence o
       LEFT JOIN category c ON c.id = o.primary_category_id
      WHERE o.archived_at IS NULL
        AND (o.cost_status = 'unknown' OR o.primary_category_id IS NULL OR c.key = $2)
        AND NOT EXISTS (
          SELECT 1 FROM llm_batch_decision d WHERE d.job_name = $1 AND d.target_id = o.id
        )
        AND ${watermarkPredicate('o', 1)}
      ORDER BY o.created_at
      LIMIT $3::int`,
    [JOB_NAMES.categoryCost, FALLBACK_CATEGORY_KEY, limit]
  );

  const candidates: CategoryCostCandidate[] = [];
  for (const r of rows) {
    const storedIsFallbackOrNull = r.primary_category_id === null || r.category_key === FALLBACK_CATEGORY_KEY;
    // Reuse the taxonomy classifier as the authoritative "signal too weak" test: only when the
    // deterministic classifier itself resolves to the generic fallback do we treat the category
    // as needing help. This protects a good hint-derived category the title alone can't reproduce.
    const titleGeneric = classifyPrimaryCategory({ title: r.activity_name, categoryHint: undefined }).certainty === 'generic';
    const needsCategory = storedIsFallbackOrNull && titleGeneric;
    const needsCost = r.cost_status === 'unknown';
    if (!needsCategory && !needsCost) continue; // SQL over-selected via the coarse pre-filter — drop it.

    candidates.push({
      occurrenceId: r.id,
      activityName: r.activity_name,
      description: r.description_snippet,
      needsCategory,
      needsCost,
      currentCategoryId: r.primary_category_id,
      // Anthropic requires custom_id to match `^[a-zA-Z0-9_-]{1,64}$`; `catcost-<uuid>` is 44 chars, all legal.
      customId: `catcost-${r.id}`,
    });
  }
  return candidates;
}

/**
 * Resolve a specific category key to its primary-eligible category id by REUSING
 * worker/core/taxonomy.resolvePrimaryCategoryId — we feed a hint-only synthetic record whose
 * categoryHint IS the model's key; the classifier honours a valid key verbatim, so this returns
 * exactly that key's id (or null → fail-closed no-op). No duplicate category-key lookup lives here.
 */
async function categoryIdForKey(key: AllowedCategoryKey): Promise<string | null> {
  const synthetic: StructuredRecord = { sourceRecordId: '', title: '', sourceUrl: '', categoryHint: key };
  return resolvePrimaryCategoryId(getPool(), synthetic);
}

/**
 * Apply one decision transactionally + record the audit row (the terminal marker for the
 * anti-join). Returns true if any field was actually written. Each field's UPDATE is guarded on
 * the row still being in its unresolved state, so the apply is idempotent even under a retry.
 */
export async function applyCategoryCostDecision(candidate: CategoryCostCandidate, decision: CategoryCostDecision): Promise<boolean> {
  // Resolve the category id up front (a read on static reference data), outside the write txn.
  const categoryId = decision.applyCategory && decision.categoryKey ? await categoryIdForKey(decision.categoryKey) : null;

  return withServiceTransaction(async (client: PoolClient) => {
    let categoryWritten = false;
    let costWritten = false;

    if (decision.applyCategory && categoryId) {
      // Guard: only overwrite while the category is still the null/fallback we detected.
      const upd = await client.query(
        `UPDATE activity_occurrence
            SET primary_category_id = $2
          WHERE id = $1 AND archived_at IS NULL AND primary_category_id IS NOT DISTINCT FROM $3::uuid`,
        [candidate.occurrenceId, categoryId, candidate.currentCategoryId]
      );
      categoryWritten = (upd.rowCount ?? 0) > 0;
    }

    if (decision.applyCost && decision.costStatus) {
      // Guard: only fill a cost while it is still 'unknown'.
      const upd = await client.query(
        `UPDATE activity_occurrence
            SET cost_status = $2::cost_status, cost_min_cad = $3, cost_max_cad = $4
          WHERE id = $1 AND archived_at IS NULL AND cost_status = 'unknown'`,
        [candidate.occurrenceId, decision.costStatus, decision.costMinCad, decision.costMaxCad]
      );
      costWritten = (upd.rowCount ?? 0) > 0;
    }

    const actioned = categoryWritten || costWritten;
    await recordDecision(
      {
        jobName: JOB_NAMES.categoryCost,
        useCase: 'category_cost',
        targetId: candidate.occurrenceId,
        customId: candidate.customId,
        action: actioned ? 'apply' : 'no_op',
        // Report the confidence behind whatever we acted on (category preferred), else the category read.
        llmConfidence: categoryWritten ? decision.categoryConfidence : costWritten ? decision.costConfidence : decision.categoryConfidence,
        detail: {
          reason: decision.reason,
          category: { needed: candidate.needsCategory, applied: categoryWritten, key: categoryWritten ? decision.categoryKey : null, confidence: decision.categoryConfidence },
          cost: {
            needed: candidate.needsCost,
            applied: costWritten,
            status: costWritten ? decision.costStatus : null,
            min: costWritten ? decision.costMinCad : null,
            max: costWritten ? decision.costMaxCad : null,
            confidence: decision.costConfidence,
          },
        },
      },
      client
    );
    return actioned;
  });
}

export interface CategoryCostRunResult {
  useCase: 'category_cost';
  considered: number;
  categoryApplied: number;
  costApplied: number;
  noOp: number;
  actioned: number;
  submitted: boolean;
}

export interface CategoryCostRunOptions {
  dryRun: boolean;
  pollIntervalMs?: number;
  maxCandidates?: number;
}

/** Orchestrate the category+cost fallback use case end-to-end for one nightly run. */
export async function runCategoryCostUseCase(client: AnthropicBatchClient, opts: CategoryCostRunOptions): Promise<CategoryCostRunResult> {
  const limit = opts.maxCandidates ?? configMaxCandidates();
  const runStart = await runTimestamp();
  const candidates = await detectCategoryCostCandidates(limit);

  const result: CategoryCostRunResult = {
    useCase: 'category_cost',
    considered: candidates.length,
    categoryApplied: 0,
    costApplied: 0,
    noOp: 0,
    actioned: 0,
    submitted: false,
  };

  if (opts.dryRun) {
    await recordNonAdvancingRun(JOB_NAMES.categoryCost, 'dry_run', { considered: candidates.length, actioned: 0 });
    return result;
  }
  if (candidates.length === 0) {
    await advanceWatermark(JOB_NAMES.categoryCost, runStart, { considered: 0, actioned: 0 });
    return result;
  }

  const requests = candidates.map(buildCategoryCostRequest);
  const outcome = await runBatch(client, requests, { pollIntervalMs: opts.pollIntervalMs });
  result.submitted = true;

  for (const candidate of candidates) {
    const item = outcome.results.get(candidate.customId);
    // No result this run (e.g. the batch timed out before results were read) → leave the record
    // undecided so the next run reconsiders it; do NOT record a terminal no-op we can't justify.
    if (!item) continue;
    const verdict = item.result.type === 'succeeded' ? parseCategoryCostVerdict(textOf(item.result.message.content)) : null;
    const decision = decideCategoryCost(candidate, verdict);
    const actioned = await applyCategoryCostDecision(candidate, decision);
    if (decision.applyCategory) result.categoryApplied += 1;
    if (decision.applyCost) result.costApplied += 1;
    if (actioned) result.actioned += 1;
    else result.noOp += 1;
  }

  if (outcome.timedOut) {
    await recordNonAdvancingRun(JOB_NAMES.categoryCost, 'partial', { considered: result.considered, actioned: result.actioned });
  } else {
    await advanceWatermark(JOB_NAMES.categoryCost, runStart, { considered: result.considered, actioned: result.actioned });
  }
  return result;
}
