// lib/llm/anthropic-client.ts — the injectable/mockable Anthropic Message-Batches seam.
//
// The nightly job talks to Anthropic ONLY through the AnthropicBatchClient interface,
// whose shape mirrors the official SDK's Message Batches surface
// (client.messages.batches.create / retrieve / results — NOT live per-request calls).
// Everything downstream (lib/llm/batch.ts, dedup.ts, age-fallback.ts, run.ts) depends on
// this interface, never on a concrete SDK, so:
//   • tests inject FakeAnthropicBatchClient (canned Haiku-shaped JSON, zero network);
//   • production today gets UnprovisionedAnthropicBatchClient, which THROWS on any call —
//     there is no HTTP client anywhere in this module, so a real API request is impossible
//     by accident. The placeholder "key" is a sentinel that fails loudly, never a live key.
//
// FAST-FOLLOW (once the `kids-fun-anthropic` credential lands): add ONE small real adapter
// that wraps `new Anthropic({ apiKey }).messages.batches` behind this same interface and
// return it from createBatchClientFromEnv() when a key is present. No other file changes —
// that is the entire point of this seam.

/** A prompt-cache breakpoint. ttl '1h' keeps a stable prefix warm across a long batch run. */
export interface CacheControl {
  type: 'ephemeral';
  ttl?: '5m' | '1h';
}

/** A system content block (the stable, cacheable prefix lives here). */
export interface SystemBlock {
  type: 'text';
  text: string;
  cache_control?: CacheControl;
}

/** A user message content block (the volatile, per-record content lives here). */
export interface UserBlock {
  type: 'text';
  text: string;
}

export interface BatchMessage {
  role: 'user';
  content: UserBlock[];
}

/** A JSON-schema structured-output constraint (optional; guarantees schema-valid JSON). */
export interface OutputConfig {
  format: {
    type: 'json_schema';
    schema: Record<string, unknown>;
  };
}

/** The per-request Messages params (a subset — exactly what this job uses). */
export interface BatchRequestParams {
  model: string;
  max_tokens: number;
  system: SystemBlock[];
  messages: BatchMessage[];
  output_config?: OutputConfig;
}

/** One request in a batch, keyed by a caller-chosen custom_id (results key back to it). */
export interface BatchRequest {
  custom_id: string;
  params: BatchRequestParams;
}

export type BatchProcessingStatus = 'in_progress' | 'canceling' | 'ended';

export interface BatchHandle {
  id: string;
  processing_status: BatchProcessingStatus;
}

export type BatchResultType = 'succeeded' | 'errored' | 'canceled' | 'expired';

export interface BatchResultMessage {
  content: Array<{ type: string; text?: string }>;
}

/** One result, keyed by custom_id. Results arrive in ANY order — never index by position. */
export interface BatchResultItem {
  custom_id: string;
  result:
    | { type: 'succeeded'; message: BatchResultMessage }
    | { type: 'errored'; error?: { type?: string; message?: string } }
    | { type: 'canceled' }
    | { type: 'expired' };
}

/**
 * The seam. Matches the official SDK's `client.messages.batches` surface so the real
 * adapter is a thin pass-through: create(requests) → poll retrieve(id) until
 * processing_status === 'ended' → results(id) (async-iterable, keyed by custom_id).
 */
export interface AnthropicBatchClient {
  messages: {
    batches: {
      create(body: { requests: BatchRequest[] }): Promise<BatchHandle>;
      retrieve(id: string): Promise<BatchHandle>;
      results(id: string): Promise<AsyncIterable<BatchResultItem>>;
    };
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Fake client — canned Haiku-shaped responses, zero network. For tests + CI.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Produces the response for one request. Tests supply this to control the model's
 * "answer" per custom_id. The returned object is JSON-stringified as the single text
 * block of a succeeded result — exactly the shape our parser reads off a real Haiku
 * response. Return null to simulate a per-record ERROR result.
 */
export type FakeResponder = (req: BatchRequest) => Record<string, unknown> | null;

const DEFAULT_FAKE_RESPONDER: FakeResponder = () => ({});

export interface FakeClientOptions {
  responder?: FakeResponder;
  /** Deterministic id prefix so tests can assert on the batch id if they wish. */
  idPrefix?: string;
}

/**
 * In-memory AnthropicBatchClient. `create` records the requests and returns an immediately
 * "ended" batch; `results` replays the responder's output per request. No timers, no I/O.
 */
export class FakeAnthropicBatchClient implements AnthropicBatchClient {
  readonly submitted: BatchRequest[][] = [];
  private readonly store = new Map<string, BatchRequest[]>();
  private readonly responder: FakeResponder;
  private readonly idPrefix: string;
  private counter = 0;

  constructor(opts: FakeClientOptions = {}) {
    this.responder = opts.responder ?? DEFAULT_FAKE_RESPONDER;
    this.idPrefix = opts.idPrefix ?? 'fake_batch';
  }

  readonly messages = {
    batches: {
      create: async (body: { requests: BatchRequest[] }): Promise<BatchHandle> => {
        const id = `${this.idPrefix}_${++this.counter}`;
        this.store.set(id, body.requests);
        this.submitted.push(body.requests);
        return { id, processing_status: 'ended' as const };
      },
      retrieve: async (id: string): Promise<BatchHandle> => {
        if (!this.store.has(id)) throw new Error(`FakeAnthropicBatchClient: unknown batch ${id}`);
        return { id, processing_status: 'ended' as const };
      },
      results: async (id: string): Promise<AsyncIterable<BatchResultItem>> => {
        const requests = this.store.get(id);
        if (!requests) throw new Error(`FakeAnthropicBatchClient: unknown batch ${id}`);
        const responder = this.responder;
        // Deliberately iterate in REVERSE so tests can't accidentally rely on request
        // order — results must be keyed by custom_id, never by position.
        async function* gen(): AsyncGenerator<BatchResultItem> {
          for (let i = requests!.length - 1; i >= 0; i--) {
            const req = requests![i];
            const answer = responder(req);
            if (answer === null) {
              yield { custom_id: req.custom_id, result: { type: 'errored', error: { type: 'fake_error' } } };
            } else {
              yield {
                custom_id: req.custom_id,
                result: { type: 'succeeded', message: { content: [{ type: 'text', text: JSON.stringify(answer) }] } },
              };
            }
          }
        }
        return gen();
      },
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Unprovisioned client — the safe production default until the credential lands.
// ─────────────────────────────────────────────────────────────────────────────

/** The sentinel "key". It is NOT a credential; any attempt to use this client throws. */
export const UNPROVISIONED_PLACEHOLDER_KEY = 'PLACEHOLDER-kids-fun-anthropic-NOT-PROVISIONED';

export class AnthropicClientNotProvisionedError extends Error {
  constructor() {
    super(
      'Anthropic batch client is not provisioned (credential slug `kids-fun-anthropic` is ' +
        'unset). The nightly job must run detection-only until an operator provisions the ' +
        'Haiku key AND sets LLM_BATCH_ENABLED=true. Refusing to make a live API call.'
    );
    this.name = 'AnthropicClientNotProvisionedError';
  }
}

/**
 * Every method throws. This is what createBatchClientFromEnv() returns while the credential
 * is missing, so an accidental "enabled" run fails loudly and safely instead of silently
 * doing nothing — and, crucially, there is no HTTP code path here at all.
 */
export class UnprovisionedAnthropicBatchClient implements AnthropicBatchClient {
  readonly messages = {
    batches: {
      create: async (_body: { requests: BatchRequest[] }): Promise<BatchHandle> => {
        throw new AnthropicClientNotProvisionedError();
      },
      retrieve: async (_id: string): Promise<BatchHandle> => {
        throw new AnthropicClientNotProvisionedError();
      },
      results: async (_id: string): Promise<AsyncIterable<BatchResultItem>> => {
        throw new AnthropicClientNotProvisionedError();
      },
    },
  };
}

export interface ResolvedBatchClient {
  client: AnthropicBatchClient;
  /** True only when a real, credentialed client is wired. Always false today. */
  live: boolean;
}

/**
 * Resolve the batch client from the environment.
 *
 * TODAY: always returns the unprovisioned client (`live: false`). The real SDK adapter is
 * intentionally NOT wired here yet — that is the fast-follow once `kids-fun-anthropic` is
 * provisioned. The single change then is: `if (apiKey) return { client: makeRealClient(apiKey),
 * live: true }` above the fallback, where makeRealClient wraps `new Anthropic({ apiKey })
 * .messages.batches` behind AnthropicBatchClient. Nothing else changes.
 */
export function createBatchClientFromEnv(_apiKey: string | null): ResolvedBatchClient {
  // No real adapter is wired yet; refuse to pretend otherwise.
  return { client: new UnprovisionedAnthropicBatchClient(), live: false };
}
