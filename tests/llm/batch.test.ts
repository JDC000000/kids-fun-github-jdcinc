// tests/llm/batch.test.ts — the generic batch orchestration (submit → poll → collect by
// custom_id). Uses the fake client and a stub client; no network, no real timers of note.
import { describe, expect, it } from 'vitest';
import { runBatch } from '../../lib/llm/batch';
import { FakeAnthropicBatchClient, type AnthropicBatchClient, type BatchRequest } from '../../lib/llm/anthropic-client';

function req(customId: string): BatchRequest {
  return {
    custom_id: customId,
    params: { model: 'claude-haiku-4-5', max_tokens: 64, system: [{ type: 'text', text: 's' }], messages: [{ role: 'user', content: [{ type: 'text', text: 'u' }] }] },
  };
}

describe('runBatch', () => {
  it('does not submit and returns empty when there are no requests', async () => {
    const client = new FakeAnthropicBatchClient();
    const out = await runBatch(client, []);
    expect(out.batchId).toBe('');
    expect(out.results.size).toBe(0);
    expect(client.submitted).toHaveLength(0);
  });

  it('collects results into a Map keyed by custom_id regardless of arrival order', async () => {
    const client = new FakeAnthropicBatchClient({ responder: (r) => ({ id: r.custom_id }) });
    const out = await runBatch(client, [req('one'), req('two'), req('three')], { pollIntervalMs: 0 });
    expect([...out.results.keys()].sort()).toEqual(['one', 'three', 'two']);
    expect(out.timedOut).toBe(false);
  });

  it('flags timedOut when the batch never reaches "ended" within maxPolls', async () => {
    const stuck: AnthropicBatchClient = {
      messages: {
        batches: {
          create: async () => ({ id: 'b1', processing_status: 'in_progress' }),
          retrieve: async () => ({ id: 'b1', processing_status: 'in_progress' }),
          results: async () => (async function* () {})(),
        },
      },
    };
    const out = await runBatch(stuck, [req('x')], { pollIntervalMs: 0, maxPolls: 3 });
    expect(out.timedOut).toBe(true);
    expect(out.results.size).toBe(0);
  });
});
