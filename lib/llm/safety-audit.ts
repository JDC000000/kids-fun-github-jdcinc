// lib/llm/safety-audit.ts — stage 2 of the catalogue safety auditor: Haiku adjudication of
// ONLY the prefilter's candidates.
//
// This is a third use case on the EXISTING batch plumbing, not a second path to Anthropic. It
// reuses, unchanged: the AnthropicBatchClient seam (anthropic-client.ts), the submit/poll/
// collect loop (batch.ts), the model + enablement + cap config (config.ts), and the cacheable
// system-prompt / fail-closed-parser convention (prompts.ts). What it does NOT reuse is
// watermark.ts and the withServiceTransaction writer — deliberately, and this is the one real
// difference from the nightly job:
//
//   THE AUDITOR NEVER WRITES. It reads the public search API and emits a report. There is no
//   row to stamp, no watermark to advance, and no way for a bug in it to change what a parent
//   sees. That is the correct blast radius for a job whose output is "these listings may be
//   mislabelled" — a human decides what to do about each one.
//
// SAFETY GATE, same shape as lib/llm/run.ts: a real submission requires an explicitly injected
// client (tests) OR a live env-resolved client AND LLM_BATCH_ENABLED=true with no dry-run
// kill-switch. With the credential unprovisioned (today) the resolved client throws on use, so
// the audit runs prefilter-only and cannot make an API call by accident.
import {
  anthropicApiKey,
  batchDryRunForced,
  batchEnabled,
  batchModel,
  maxCandidates as configMaxCandidates,
} from './config';
import { createBatchClientFromEnv, type AnthropicBatchClient, type BatchRequest } from './anthropic-client';
import { runBatch } from './batch';
import {
  SAFETY_AUDIT_OUTPUT_CONFIG,
  buildSafetyAuditSystem,
  buildSafetyAuditUser,
  parseSafetyAuditVerdict,
  textOf,
} from './prompts';
import type { AuditVerdict, Candidate, Finding } from '@/lib/audit/types';
import { ruleById } from '@/lib/audit/registry';

/** Build the Message-Batches request for one candidate (cacheable prefix + volatile body). */
export function buildSafetyAuditRequest(candidate: Candidate): BatchRequest {
  const rule = ruleById(candidate.ruleId);
  return {
    custom_id: candidate.customId,
    params: {
      model: batchModel(),
      // 256 is ample for {contradiction, confidence, reason} and bounds a runaway response.
      max_tokens: 256,
      system: buildSafetyAuditSystem(),
      messages: [
        {
          role: 'user',
          content: buildSafetyAuditUser({
            ruleId: candidate.ruleId,
            ruleTitle: rule?.title ?? candidate.ruleId,
            evidence: candidate.signal.evidence.map((e) => ({
              quote: e.quote,
              field: e.field,
              strength: e.strength,
            })),
            title: candidate.listing.source.title,
            description: candidate.listing.source.description,
            ageWording: candidate.listing.source.ageWording,
            venueName: candidate.listing.source.venueName,
            derivedClaim: candidate.signal.derivedClaim,
          }),
        },
      ],
      output_config: SAFETY_AUDIT_OUTPUT_CONFIG,
    },
  };
}

/**
 * Order candidates so that, when the per-run cap bites, what gets adjudicated is what matters
 * most: strong evidence before weak (a strong hit is a probable real finding), then by rule
 * order. Without this the cap would slice arbitrarily and a run could spend its whole budget on
 * "park"-in-a-venue-name noise.
 */
export function prioritise(candidates: Candidate[]): Candidate[] {
  return [...candidates].sort((a, b) => {
    if (a.weakOnly !== b.weakOnly) return a.weakOnly ? 1 : -1;
    if (a.severity !== b.severity) return b.severity - a.severity;
    return a.customId.localeCompare(b.customId);
  });
}

export interface AdjudicateOptions {
  /** Force prefilter-only (no API call, no tokens). */
  dryRun?: boolean;
  /** Injected client (tests). When set, the enable/live gate is bypassed. */
  client?: AnthropicBatchClient;
  pollIntervalMs?: number;
  maxCandidates?: number;
}

export interface AdjudicationResult {
  dryRun: boolean;
  enabled: boolean;
  live: boolean;
  /** How many candidates were actually sent (0 on a dry run). */
  submitted: number;
  /** Candidates dropped by the per-run cap. Reported, never silent. */
  cappedOut: number;
  /** custom_id → verdict, for the ones that came back parseable. */
  verdicts: Map<string, AuditVerdict>;
  /** Sent but errored/expired/unparseable. These stay unadjudicated rather than being guessed. */
  unresolved: number;
  timedOut: boolean;
}

/**
 * Adjudicate the candidate set. On a dry run this returns an empty verdict map and makes no
 * network call at all — the caller then reports prefilter counts, which is the useful,
 * zero-cost mode and the one the Operator gets before enabling anything.
 */
export async function adjudicateCandidates(
  candidates: Candidate[],
  opts: AdjudicateOptions = {}
): Promise<AdjudicationResult> {
  const enabled = batchEnabled();
  const injected = Boolean(opts.client);

  let client: AnthropicBatchClient;
  let live: boolean;
  if (opts.client) {
    client = opts.client;
    live = true;
  } else {
    const resolved = createBatchClientFromEnv(anthropicApiKey());
    client = resolved.client;
    live = resolved.live;
  }

  const dryRun = batchDryRunForced() || opts.dryRun === true || (!injected && (!enabled || !live));

  const limit = opts.maxCandidates ?? configMaxCandidates();
  const ordered = prioritise(candidates);
  const selected = ordered.slice(0, limit);
  const cappedOut = ordered.length - selected.length;

  const result: AdjudicationResult = {
    dryRun,
    enabled,
    live,
    submitted: 0,
    cappedOut,
    verdicts: new Map(),
    unresolved: 0,
    timedOut: false,
  };

  if (dryRun || selected.length === 0) return result;

  const outcome = await runBatch(client, selected.map(buildSafetyAuditRequest), {
    pollIntervalMs: opts.pollIntervalMs,
  });
  result.submitted = selected.length;
  result.timedOut = outcome.timedOut;

  for (const candidate of selected) {
    const item = outcome.results.get(candidate.customId);
    const verdict =
      item && item.result.type === 'succeeded' ? parseSafetyAuditVerdict(textOf(item.result.message.content)) : null;
    if (verdict) result.verdicts.set(candidate.customId, verdict);
    else result.unresolved += 1;
  }

  return result;
}

/**
 * Confidence bar for promoting an adjudicated candidate to a reported finding. Lower than the
 * dedup auto-merge bar (0.9) because nothing here is applied automatically — the action is
 * "show a human this row", which is cheap to be wrong about in the reporting direction and
 * expensive to be wrong about in the silent-drop direction. Kept as one named constant so
 * tuning it against real reviewed output is a deliberate edit.
 */
export const SAFETY_AUDIT_MIN_CONFIDENCE = 0.7;

/** Deep link to the listing a reviewer should open. */
export function previewUrlFor(baseUrl: string, listingId: string): string {
  return new URL(`/activity/${listingId}`, baseUrl).toString();
}

/**
 * Turn candidates + verdicts into findings.
 *
 * The promotion rule is the difference between an auditor people act on and one they mute:
 *   • adjudicated  → keep only what the model called a real contradiction, at or above the
 *                    confidence bar. Its "no" overrides the prefilter's "maybe".
 *   • unadjudicated + STRONG evidence → keep. The words are unambiguous; a run that could not
 *                    reach the model should still surface "Outdoor … Rain/Shine".
 *   • unadjudicated + WEAK evidence only → drop. This is the "park in a venue name" tier, and
 *                    reporting it unreviewed is precisely how an auditor earns a mute.
 */
export function toFindings(
  candidates: Candidate[],
  verdicts: Map<string, AuditVerdict>,
  baseUrl: string,
  minConfidence = SAFETY_AUDIT_MIN_CONFIDENCE
): Finding[] {
  const out: Finding[] = [];
  for (const c of candidates) {
    const rule = ruleById(c.ruleId);
    const verdict = verdicts.get(c.customId) ?? null;

    if (verdict) {
      if (!verdict.contradiction || verdict.confidence < minConfidence) continue;
    } else if (c.weakOnly) {
      continue;
    }

    out.push({
      occurrences: 1,
      ruleId: c.ruleId,
      title: rule?.title ?? c.ruleId,
      severity: c.severity,
      listingId: c.listing.id,
      seriesId: c.listing.seriesId,
      activityName: c.listing.source.title,
      organisation: c.listing.organisation,
      previewUrl: previewUrlFor(baseUrl, c.listing.id),
      sourceUrl: c.listing.sourceUrl,
      evidence: c.signal.evidence,
      derivedClaim: c.signal.derivedClaim,
      verdict,
      adjudicatedBy: verdict ? 'llm' : 'prefilter',
    });
  }
  // Collapse repeats of the SAME programme under the same rule. Keyed by seriesId where the
  // catalogue has one (a repeating class), falling back to the listing id for a one-off.
  const bySeries = new Map<string, Finding>();
  for (const f of out) {
    const key = `${f.ruleId}::${f.seriesId ?? f.listingId}`;
    const existing = bySeries.get(key);
    if (existing) {
      existing.occurrences += 1;
      // Keep the most confident verdict as the representative one.
      if ((f.verdict?.confidence ?? 0) > (existing.verdict?.confidence ?? 0)) existing.verdict = f.verdict;
      continue;
    }
    bySeries.set(key, f);
  }

  // Severity first, then most-repeated, then strongest verdict — the top of the list should be
  // the row a human should open next.
  return [...bySeries.values()].sort(
    (a, b) =>
      b.severity - a.severity ||
      b.occurrences - a.occurrences ||
      (b.verdict?.confidence ?? 0) - (a.verdict?.confidence ?? 0)
  );
}

