// lib/llm/age-fallback.ts — G-T13-5: LLM fallback for the age wording the deterministic
// parser (worker/core/age.ts) could NOT resolve.
//
// SCOPE: strictly the residue. worker/core/age.ts leaves genuinely-ambiguous free text with
// null bounds and age_notes = 'unresolved: <raw>'. This job targets EXACTLY those rows — it
// is a fallback for the stuck cases, never a replacement for the deterministic path (which
// keeps owning every clear range/keyword/grade/all-ages case).
//
// Fail-closed apply:
//   • resolved AND confidence ≥ AGE_APPLY_MIN_CONFIDENCE → write the band + matches; stamp
//     age_notes='llm-resolved: …' so the row leaves the worklist.
//   • otherwise (not resolved / low confidence / errored / unparseable) → NO-OP on the
//     bounds, but stamp age_notes='llm-unresolved: <raw>' so it isn't reprocessed every
//     night. Half-open interval + band-overlap conventions exactly mirror worker/core/age.ts.
import type { PoolClient } from 'pg';
import { query } from '@/lib/db/client';
import { AGE_APPLY_MIN_CONFIDENCE, JOB_NAMES, batchModel, maxCandidates as configMaxCandidates } from './config';
import type { AnthropicBatchClient, BatchRequest } from './anthropic-client';
import { runBatch } from './batch';
import { withServiceTransaction } from './db';
import { advanceWatermark, recordDecision, recordNonAdvancingRun, runTimestamp, watermarkPredicate } from './watermark';
import { AGE_OUTPUT_CONFIG, buildAgeSystem, buildAgeUser, parseAgeVerdict, textOf, type AgeVerdict } from './prompts';

const UNRESOLVED_PREFIX = 'unresolved:';
/** Large sentinel standing in for an open (null) upper bound in the overlap query. */
const OPEN_BOUND = 2_147_483_647;

export interface AgeCandidate {
  occurrenceId: string;
  activityName: string;
  /** The raw wording the deterministic parser stored (age_notes minus the 'unresolved:' tag). */
  rawAgeText: string;
  customId: string;
}

export type AgeAction = 'apply' | 'no_op';

export interface AgeDecision {
  action: AgeAction;
  ageMinMonths: number | null;
  ageMaxMonths: number | null;
  llmConfidence: number | null;
  reason: string;
}

/** PURE decision: apply only a resolved verdict clearing the confidence bar; else no-op. */
export function decideAge(verdict: AgeVerdict | null): AgeDecision {
  if (!verdict) {
    return { action: 'no_op', ageMinMonths: null, ageMaxMonths: null, llmConfidence: null, reason: 'No usable model verdict.' };
  }
  if (verdict.resolved && verdict.confidence >= AGE_APPLY_MIN_CONFIDENCE) {
    return {
      action: 'apply',
      ageMinMonths: verdict.ageMinMonths,
      ageMaxMonths: verdict.ageMaxMonths,
      llmConfidence: verdict.confidence,
      reason: verdict.reason || 'Confident age resolution.',
    };
  }
  return {
    action: 'no_op',
    ageMinMonths: null,
    ageMaxMonths: null,
    llmConfidence: verdict.confidence,
    reason: verdict.reason || 'Below confidence bar or unresolved.',
  };
}

/** Build the Message-Batches request for one stuck age record (cacheable prefix + volatile body). */
export function buildAgeRequest(candidate: AgeCandidate): BatchRequest {
  return {
    custom_id: candidate.customId,
    params: {
      model: batchModel(),
      max_tokens: 256,
      system: buildAgeSystem(),
      messages: [{ role: 'user', content: buildAgeUser({ activityName: candidate.activityName, rawAgeText: candidate.rawAgeText }) }],
      output_config: AGE_OUTPUT_CONFIG,
    },
  };
}

interface AgeCandidateRow {
  id: string;
  activity_name: string;
  age_notes: string;
}

/** Strip the deterministic parser's 'unresolved:' tag to recover the raw wording. */
function rawFromNotes(notes: string): string {
  const t = notes.trim();
  return t.toLowerCase().startsWith(UNRESOLVED_PREFIX) ? t.slice(UNRESOLVED_PREFIX.length).trim() : t;
}

/** Detect occurrences the deterministic parser left unresolved, changed since the last run. */
export async function detectAgeCandidates(limit = configMaxCandidates()): Promise<AgeCandidate[]> {
  const rows = await query<AgeCandidateRow>(
    `SELECT o.id, o.activity_name, oa.age_notes
       FROM activity_occurrence o
       JOIN occurrence_age oa ON oa.occurrence_id = o.id
      WHERE o.archived_at IS NULL
        AND oa.age_min_months IS NULL
        AND oa.age_max_months IS NULL
        AND oa.age_notes LIKE 'unresolved:%'
        AND ${watermarkPredicate('o', 1)}
      ORDER BY o.created_at
      LIMIT $2::int`,
    [JOB_NAMES.age, limit]
  );
  return rows.map((r) => ({
    occurrenceId: r.id,
    activityName: r.activity_name,
    rawAgeText: rawFromNotes(r.age_notes),
    customId: `age:${r.id}`,
  }));
}

/** age_band ids whose [lower, upper) overlaps [min, maxExcl). Mirrors worker/core/age.ts computeAgeBandMatches, in SQL. */
async function bandMatchIds(client: Pick<PoolClient, 'query'>, min: number | null, max: number | null): Promise<string[]> {
  const lo = min ?? 0;
  const hiExcl = max ?? OPEN_BOUND;
  const res = await client.query<{ id: string }>(
    `SELECT id FROM age_band
      WHERE lower_months_inclusive < $2::int
        AND COALESCE(upper_months_exclusive, $3::int) > $1::int`,
    [lo, hiExcl, OPEN_BOUND]
  );
  return res.rows.map((r) => r.id);
}

/** Apply one age decision transactionally + record the audit row. Returns true if bounds were written. */
export async function applyAgeDecision(candidate: AgeCandidate, decision: AgeDecision): Promise<boolean> {
  return withServiceTransaction(async (client: PoolClient) => {
    if (decision.action === 'apply') {
      const matches = await bandMatchIds(client, decision.ageMinMonths, decision.ageMaxMonths);
      // Guard on the row still being the unresolved residue (idempotent).
      const updated = await client.query(
        `UPDATE occurrence_age
            SET age_min_months = $2, age_max_months = $3, age_band_matches = $4::uuid[], age_notes = $5
          WHERE occurrence_id = $1 AND age_notes LIKE 'unresolved:%'`,
        [candidate.occurrenceId, decision.ageMinMonths, decision.ageMaxMonths, matches, `llm-resolved: ${decision.reason}`.slice(0, 500)]
      );
      await recordDecision(
        {
          jobName: JOB_NAMES.age,
          useCase: 'age',
          targetId: candidate.occurrenceId,
          customId: candidate.customId,
          action: 'apply',
          llmConfidence: decision.llmConfidence,
          detail: { min: decision.ageMinMonths, max: decision.ageMaxMonths, bands: matches.length, reason: decision.reason },
        },
        client
      );
      return (updated.rowCount ?? 0) > 0;
    }

    // no_op: leave bounds null but stamp a terminal marker so we don't reprocess nightly.
    await client.query(
      `UPDATE occurrence_age
          SET age_notes = $2
        WHERE occurrence_id = $1 AND age_notes LIKE 'unresolved:%'`,
      [candidate.occurrenceId, `llm-unresolved: ${candidate.rawAgeText}`.slice(0, 500)]
    );
    await recordDecision(
      {
        jobName: JOB_NAMES.age,
        useCase: 'age',
        targetId: candidate.occurrenceId,
        customId: candidate.customId,
        action: 'no_op',
        llmConfidence: decision.llmConfidence,
        detail: { reason: decision.reason },
      },
      client
    );
    return false;
  });
}

export interface AgeRunResult {
  useCase: 'age';
  considered: number;
  applied: number;
  noOp: number;
  actioned: number;
  submitted: boolean;
}

export interface AgeRunOptions {
  dryRun: boolean;
  pollIntervalMs?: number;
  maxCandidates?: number;
}

/** Orchestrate the age-fallback use case end-to-end for one nightly run. */
export async function runAgeUseCase(client: AnthropicBatchClient, opts: AgeRunOptions): Promise<AgeRunResult> {
  const limit = opts.maxCandidates ?? configMaxCandidates();
  const runStart = await runTimestamp();
  const candidates = await detectAgeCandidates(limit);

  const result: AgeRunResult = { useCase: 'age', considered: candidates.length, applied: 0, noOp: 0, actioned: 0, submitted: false };

  if (opts.dryRun) {
    await recordNonAdvancingRun(JOB_NAMES.age, 'dry_run', { considered: candidates.length, actioned: 0 });
    return result;
  }
  if (candidates.length === 0) {
    await advanceWatermark(JOB_NAMES.age, runStart, { considered: 0, actioned: 0 });
    return result;
  }

  const requests = candidates.map(buildAgeRequest);
  const outcome = await runBatch(client, requests, { pollIntervalMs: opts.pollIntervalMs });
  result.submitted = true;

  for (const candidate of candidates) {
    const item = outcome.results.get(candidate.customId);
    const verdict = item && item.result.type === 'succeeded' ? parseAgeVerdict(textOf(item.result.message.content)) : null;
    const decision = decideAge(verdict);
    const actioned = await applyAgeDecision(candidate, decision);
    if (decision.action === 'apply') result.applied += 1;
    else result.noOp += 1;
    if (actioned) result.actioned += 1;
  }

  if (outcome.timedOut) {
    await recordNonAdvancingRun(JOB_NAMES.age, 'partial', { considered: result.considered, actioned: result.actioned });
  } else {
    await advanceWatermark(JOB_NAMES.age, runStart, { considered: result.considered, actioned: result.actioned });
  }
  return result;
}
