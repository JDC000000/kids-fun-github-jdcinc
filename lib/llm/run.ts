// lib/llm/run.ts — the nightly LLM-assisted batch job entrypoint.
//
// Mirrors the analytics-retention pattern (T31): the platform `schedule` skill hits a
// secret-guarded POST route (app/api/llm/batch/run) off-peak; that route calls this. It is
// NOT per-request / live-user-facing, and NOT registered through the worker's per-source
// cadence engine (worker/scheduler/cadence.ts) — that engine schedules per-source INGESTION
// crawls; this is a global nightly enrichment/maintenance batch, the analytics-retention
// shape, so it stays a standalone secret-guarded route (reasoning documented in findings).
//
// SAFETY GATE — real Message-Batches submission requires BOTH:
//   1. an explicitly INJECTED client (tests), OR an env-resolved LIVE client, AND
//   2. LLM_BATCH_ENABLED=true and no dry-run kill-switch.
// The env-resolved client is UNPROVISIONED today (throws on use), and LLM_BATCH_ENABLED
// defaults false — so the route path runs DETECTION-ONLY and never makes an API call or a
// write until an operator provisions `kids-fun-anthropic` and flips the switch.
import { anthropicApiKey, batchDryRunForced, batchEnabled } from './config';
import { createBatchClientFromEnv, type AnthropicBatchClient } from './anthropic-client';
import { runDedupUseCase, type DedupRunResult } from './dedup';
import { runAgeUseCase, type AgeRunResult } from './age-fallback';

export type UseCaseName = 'dedup' | 'age';

export interface LlmBatchRunOptions {
  /** Force dry-run (detection-only). */
  dryRun?: boolean;
  /** Which use cases to run (default both). */
  useCases?: UseCaseName[];
  /** Injected batch client (tests). When set, the enable/live gate is bypassed. */
  client?: AnthropicBatchClient;
  /** Poll interval for the batch (tests pass 0). */
  pollIntervalMs?: number;
  /** Override the per-run candidate cap. */
  maxCandidates?: number;
}

export interface LlmBatchRunReport {
  dryRun: boolean;
  enabled: boolean;
  live: boolean;
  useCases: UseCaseName[];
  results: Array<DedupRunResult | AgeRunResult>;
}

export async function runLlmBatchJob(opts: LlmBatchRunOptions = {}): Promise<LlmBatchRunReport> {
  const enabled = batchEnabled();
  const injected = Boolean(opts.client);

  let client: AnthropicBatchClient;
  let live: boolean;
  if (opts.client) {
    client = opts.client;
    live = true; // an injected client is an explicit opt-in to run
  } else {
    const resolved = createBatchClientFromEnv(anthropicApiKey());
    client = resolved.client;
    live = resolved.live;
  }

  const dryRun = batchDryRunForced() || opts.dryRun === true || (!injected && (!enabled || !live));
  const useCases: UseCaseName[] = opts.useCases && opts.useCases.length > 0 ? opts.useCases : ['dedup', 'age'];

  const results: Array<DedupRunResult | AgeRunResult> = [];
  for (const useCase of useCases) {
    if (useCase === 'dedup') {
      results.push(await runDedupUseCase(client, { dryRun, pollIntervalMs: opts.pollIntervalMs, maxCandidates: opts.maxCandidates }));
    } else if (useCase === 'age') {
      results.push(await runAgeUseCase(client, { dryRun, pollIntervalMs: opts.pollIntervalMs, maxCandidates: opts.maxCandidates }));
    }
  }

  return { dryRun, enabled, live, useCases, results };
}
