// lib/llm/batch.ts — generic Message-Batches orchestration over the AnthropicBatchClient
// seam: submit a set of requests, poll until the batch ends, and collect the results into
// a Map keyed by custom_id (results arrive in ANY order — never index by position).
//
// This is deliberately client-agnostic: the same code drives the FakeAnthropicBatchClient
// in tests (ends immediately, poll interval 0) and, once wired, the real SDK adapter in
// production (polls the real batch until processing_status === 'ended').
import type { AnthropicBatchClient, BatchRequest, BatchResultItem } from './anthropic-client';

/** Abortable-free simple sleep (poll interval). */
export function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface RunBatchOptions {
  /** Milliseconds between poll attempts. Default 30s; tests pass 0. */
  pollIntervalMs?: number;
  /** Max poll attempts before giving up (a runaway backstop). Default 240 (≈2h at 30s). */
  maxPolls?: number;
}

export interface RunBatchOutcome {
  batchId: string;
  /** custom_id → result. */
  results: Map<string, BatchResultItem>;
  /** True if polling exhausted maxPolls before the batch ended (results may be partial). */
  timedOut: boolean;
}

/**
 * Submit `requests` as one batch, poll until it ends, and return the results keyed by
 * custom_id. Returns an empty outcome (and does NOT submit) when there are no requests.
 * Throws if the client throws (e.g. the unprovisioned client) — the caller decides how to
 * record that failure.
 */
export async function runBatch(
  client: AnthropicBatchClient,
  requests: BatchRequest[],
  opts: RunBatchOptions = {}
): Promise<RunBatchOutcome> {
  const results = new Map<string, BatchResultItem>();
  if (requests.length === 0) {
    return { batchId: '', results, timedOut: false };
  }

  const pollIntervalMs = opts.pollIntervalMs ?? 30_000;
  const maxPolls = opts.maxPolls ?? 240;

  const handle = await client.messages.batches.create({ requests });

  let ended = handle.processing_status === 'ended';
  let polls = 0;
  while (!ended) {
    if (polls >= maxPolls) {
      return { batchId: handle.id, results, timedOut: true };
    }
    await sleep(pollIntervalMs);
    const status = await client.messages.batches.retrieve(handle.id);
    ended = status.processing_status === 'ended';
    polls += 1;
  }

  const iterable = await client.messages.batches.results(handle.id);
  for await (const item of iterable) {
    // Key strictly by custom_id — the ONLY reliable join back to the source record.
    results.set(item.custom_id, item);
  }
  return { batchId: handle.id, results, timedOut: false };
}
