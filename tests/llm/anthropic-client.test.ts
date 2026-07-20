// tests/llm/anthropic-client.test.ts — the injectable client seam: the fake returns
// canned Haiku-shaped JSON keyed by custom_id, and the unprovisioned client throws on any
// call. No network is possible from this module.
import { describe, expect, it } from 'vitest';
import {
  FakeAnthropicBatchClient,
  UnprovisionedAnthropicBatchClient,
  AnthropicClientNotProvisionedError,
  createBatchClientFromEnv,
  mapSdkResult,
  type BatchRequest,
} from '../../lib/llm/anthropic-client';

// Minimal helper: build an SDK-shaped MessageBatchIndividualResponse without importing SDK types.
function sdkItem(custom_id: string, result: unknown) {
  return { custom_id, result } as unknown as Parameters<typeof mapSdkResult>[0];
}

function req(customId: string): BatchRequest {
  return {
    custom_id: customId,
    params: { model: 'claude-haiku-4-5', max_tokens: 64, system: [{ type: 'text', text: 'sys' }], messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] },
  };
}

async function collect(client: FakeAnthropicBatchClient, requests: BatchRequest[]) {
  const handle = await client.messages.batches.create({ requests });
  const status = await client.messages.batches.retrieve(handle.id);
  expect(status.processing_status).toBe('ended');
  const out = new Map<string, unknown>();
  for await (const item of await client.messages.batches.results(handle.id)) out.set(item.custom_id, item);
  return out;
}

describe('FakeAnthropicBatchClient', () => {
  it('returns a succeeded result per request, keyed by custom_id (order-independent)', async () => {
    const client = new FakeAnthropicBatchClient({
      responder: (r) => ({ echoed: r.custom_id }),
    });
    const results = await collect(client, [req('a'), req('b'), req('c')]);
    expect([...results.keys()].sort()).toEqual(['a', 'b', 'c']);
    const b = results.get('b') as { result: { type: string; message: { content: Array<{ text: string }> } } };
    expect(b.result.type).toBe('succeeded');
    expect(JSON.parse(b.result.message.content[0].text)).toEqual({ echoed: 'b' });
  });

  it('a null responder result becomes an errored batch result', async () => {
    const client = new FakeAnthropicBatchClient({ responder: (r) => (r.custom_id === 'boom' ? null : {}) });
    const results = await collect(client, [req('ok'), req('boom')]);
    expect((results.get('ok') as { result: { type: string } }).result.type).toBe('succeeded');
    expect((results.get('boom') as { result: { type: string } }).result.type).toBe('errored');
  });

  it('records submitted batches for assertion', async () => {
    const client = new FakeAnthropicBatchClient();
    await client.messages.batches.create({ requests: [req('x')] });
    expect(client.submitted).toHaveLength(1);
    expect(client.submitted[0][0].custom_id).toBe('x');
  });
});

describe('UnprovisionedAnthropicBatchClient', () => {
  it('throws AnthropicClientNotProvisionedError on every method — no live call is possible', async () => {
    const client = new UnprovisionedAnthropicBatchClient();
    await expect(client.messages.batches.create({ requests: [] })).rejects.toBeInstanceOf(AnthropicClientNotProvisionedError);
    await expect(client.messages.batches.retrieve('x')).rejects.toBeInstanceOf(AnthropicClientNotProvisionedError);
    await expect(client.messages.batches.results('x')).rejects.toBeInstanceOf(AnthropicClientNotProvisionedError);
  });
});

describe('createBatchClientFromEnv', () => {
  it('returns the unprovisioned client (non-live) when no key is present', () => {
    const resolved = createBatchClientFromEnv(null);
    expect(resolved.live).toBe(false);
    expect(resolved.client).toBeInstanceOf(UnprovisionedAnthropicBatchClient);
  });

  it('returns a LIVE real adapter when a key is present (constructing does no network I/O)', () => {
    const resolved = createBatchClientFromEnv('sk-ant-fake-not-used-for-network');
    expect(resolved.live).toBe(true);
    expect(resolved.client).not.toBeInstanceOf(UnprovisionedAnthropicBatchClient);
    // Shape check only — we never call a method here, so no request is made.
    expect(typeof resolved.client.messages.batches.create).toBe('function');
  });
});

describe('mapSdkResult (real-API result decoding)', () => {
  it('maps a succeeded result, keeping only text blocks intact', () => {
    const out = mapSdkResult(
      sdkItem('age-1', { type: 'succeeded', message: { content: [{ type: 'thinking', thinking: 'x' }, { type: 'text', text: '{"resolved":true}' }] } })
    );
    expect(out.custom_id).toBe('age-1');
    expect(out.result.type).toBe('succeeded');
    if (out.result.type === 'succeeded') {
      // thinking block preserved as type-only; text block keeps its text (what textOf reads).
      expect(out.result.message.content).toEqual([{ type: 'thinking' }, { type: 'text', text: '{"resolved":true}' }]);
    }
  });

  it('maps errored / canceled / expired results to their transport-neutral shapes', () => {
    const errored = mapSdkResult(sdkItem('a', { type: 'errored', error: { type: 'error', error: { type: 'invalid_request_error' } } }));
    expect(errored.result).toMatchObject({ type: 'errored', error: { type: 'invalid_request_error' } });
    expect(mapSdkResult(sdkItem('b', { type: 'canceled' })).result.type).toBe('canceled');
    expect(mapSdkResult(sdkItem('c', { type: 'expired' })).result.type).toBe('expired');
  });
});
