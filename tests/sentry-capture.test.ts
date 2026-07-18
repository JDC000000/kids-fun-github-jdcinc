// KIDS FUN — G-T37-4 / G6: automated proof that Sentry actually CAPTURES a real
// error raised by app code, through the app's real SDK pipeline.
//
// The sibling tests/sentry-scrub.test.ts unit-tests the scrub *functions* on
// hand-built events. This suite is the missing end-to-end proof: it exercises a
// real Sentry client configured exactly like sentry.server.config.ts (DSN
// enabled, environment, `beforeSend: scrubEvent`, the G-T37-3 ownership tags,
// tracing off, no default PII), throws a genuine Error from an app-style code
// path, captures it the same way the Next server error hook does
// (instrumentation.ts `onRequestError` = Sentry.captureRequestError → the client
// pipeline), then inspects what the SDK would have *delivered* by pinning a spy
// transport in place of the network.
//
// Faithfulness: the app's server SDK IS a `@sentry/node` NodeClient — the same
// class @sentry/nextjs re-exports for the Node runtime — configured with these
// exact options. Building that client explicitly (rather than the global
// `Sentry.init`) gives every test a fully isolated client with no shared global
// state, which is both hermetic and reliable (the global SDK can only be
// initialised once per process). Each test still runs the real error →
// event-processing → beforeSend(scrubEvent) → transport pipeline.
//
// Why hermetic (spy transport) rather than a live network E2E: (1) deterministic,
// offline, CI-safe — no real DSN, no quota, no flake; (2) it asserts the exact
// thing that matters — an app error becomes a well-formed, PII-scrubbed, owned
// Sentry event the SDK hands to its transport for delivery; (3) confirming
// *ingestion* on the Sentry side needs an issue:read-scoped token, which the
// project's internal-integration token does not carry, so it cannot be automated
// today (documented as a follow-up). This locks in — as a repeatable regression
// gate — what the one-off manual delivery proofs only checked once by hand.
import { describe, expect, it } from 'vitest';
import { NodeClient, Scope, defaultStackParser } from '@sentry/node';
import { forEachEnvelopeItem } from '@sentry/core';
import type { Envelope, Event } from '@sentry/core';

import { scrubEvent, EMAIL_MASK, IP_MASK } from '@/sentry.scrub';

// A valid-format but obviously-synthetic DSN — makes `enabled` true so events
// are processed, while the spy transport guarantees nothing leaves the process.
const FAKE_DSN = 'https://examplePublicKey@o0.ingest.sentry.io/0';

// Fake, document-only PII (RFC-5737 / example.com) — never a real value.
const FAKE_EMAIL = 'incident.reporter+leak@example.com';
const FAKE_IPV4 = '203.0.113.42';

/**
 * Build a Sentry client whose options mirror sentry.server.config.ts, bound to a
 * fresh scope carrying the ownership tags the app stamps via `initialScope`. A
 * spy transport records the delivered envelopes instead of sending them. Fully
 * isolated per call — no global SDK state.
 */
function makeCaptureHarness(overrides: Partial<ConstructorParameters<typeof NodeClient>[0]> = {}) {
  const captured: Envelope[] = [];
  const client = new NodeClient({
    dsn: FAKE_DSN,
    enabled: true,
    environment: 'test',
    tracesSampleRate: 0,
    sendDefaultPii: false,
    // Minimal integrations keep the test hermetic (no global process handlers);
    // the exception capture + stack parsing + beforeSend pipeline is unchanged.
    integrations: [],
    stackParser: defaultStackParser,
    // The real production pipeline — the same beforeSend the app ships.
    beforeSend: (event) => scrubEvent(event),
    transport: () => ({
      send: async (envelope: Envelope) => {
        captured.push(envelope);
        return { statusCode: 200 };
      },
      flush: async () => true,
    }),
    ...overrides,
  });
  client.init?.();

  const scope = new Scope();
  scope.setClient(client);
  // Mirrors sentry.server.config.ts `initialScope.tags` (G-T37-3 ownership).
  scope.setTags({ owner_team: 'kids-fun', app_runtime: 'server' });

  return { captured, client, scope };
}

/** Pull the single `event`-type item out of the recorded envelopes. */
function deliveredEvent(captured: Envelope[]): Event | undefined {
  let event: Event | undefined;
  for (const envelope of captured) {
    forEachEnvelopeItem(envelope, (item, type) => {
      if (type === 'event') event = item[1] as Event;
    });
  }
  return event;
}

/** An app-style operation that fails for a real reason (not an inline throw). */
function loadListingOrThrow(id: string): never {
  throw new Error(`listing pipeline failed for id=${id}`);
}

describe('Sentry error capture (G-T37-4) — real SDK pipeline', () => {
  it('captures a genuine thrown Error and hands a well-formed event to the transport', async () => {
    const { captured, client, scope } = makeCaptureHarness();

    try {
      loadListingOrThrow('abc-123');
    } catch (err) {
      scope.captureException(err);
    }
    const flushed = await client.flush(2000);

    expect(flushed).toBe(true);
    // The SDK actually produced and delivered exactly one event envelope.
    expect(captured.length).toBe(1);

    const event = deliveredEvent(captured);
    expect(event).toBeDefined();

    const exception = event!.exception?.values?.[0];
    expect(exception?.type).toBe('Error');
    expect(exception?.value).toBe('listing pipeline failed for id=abc-123');
    // A real, symbolicatable stack trace was attached (proves a live capture,
    // not a synthetic event) — source maps then un-minify it in production.
    expect((exception?.stacktrace?.frames ?? []).length).toBeGreaterThan(0);
    // Environment rides along so issues are attributable to their environment.
    expect(event!.environment).toBe('test');
  });

  it('stamps the ownership tags (G-T37-3) on the delivered event and the scrub keeps them intact', async () => {
    const { captured, client, scope } = makeCaptureHarness();

    scope.captureException(new Error('ownership tag probe'));
    await client.flush(2000);

    const event = deliveredEvent(captured);
    // The deny-list (deepRedact over tags) must NOT mangle benign ownership tags.
    expect(event?.tags?.owner_team).toBe('kids-fun');
    expect(event?.tags?.app_runtime).toBe('server');
  });

  it('runs the PII deny-list on the real capture path (email + IP redacted before delivery)', async () => {
    const { captured, client, scope } = makeCaptureHarness();

    // A real error whose message carries PII — exactly the leak the scrub guards.
    scope.captureException(new Error(`checkout failed for ${FAKE_EMAIL} from ${FAKE_IPV4}`));
    await client.flush(2000);

    const event = deliveredEvent(captured);
    const value = event?.exception?.values?.[0]?.value ?? '';
    // The raw PII never reaches the transport…
    expect(value).not.toContain('example.com');
    expect(value).not.toContain('203.0.113');
    // …it is replaced by the deny-list masks.
    expect(value).toContain(EMAIL_MASK);
    expect(value).toContain(IP_MASK);
  });

  it('never phones home when no DSN is configured (enabled:false on local/CI/test)', async () => {
    // Mirrors the config guard `enabled: Boolean(dsn)` — the silent default that
    // keeps local / CI / test runs from emitting to Sentry.
    const { captured, client, scope } = makeCaptureHarness({ dsn: undefined, enabled: false });

    scope.captureException(new Error('should not be delivered'));
    await client.flush(2000);

    expect(captured.length).toBe(0);
  });
});
