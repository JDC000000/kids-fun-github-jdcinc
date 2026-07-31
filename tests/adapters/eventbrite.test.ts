// tests/adapters/eventbrite.test.ts — G-T10-2: the organizer-scoped Eventbrite family's
// wiring, config invariants and run bounds.
//
// The organizer-SCOPING guarantee itself (no anonymous area query exists, the token never
// leaves the header, four gates keep it off) is proven at compliance rigour in
// tests/compliance/eventbrite-organizer-scope.test.ts. This file covers the ordinary
// adapter concerns that sit around it: registry resolution, the seeded source row, the
// per-run request cap, and the honest-zero invariant.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  EventbriteAdapter,
  EVENTBRITE_ORGANIZERS,
  getEventbriteOrganizer,
  loadEventbriteAdapters,
  organizerTokenEnvVar,
  organizerToken,
  type EventbriteOrganizerConfig,
} from '../../worker/adapters/eventbrite';
import {
  EventbriteRequestCapExceededError,
  fetchOrganizerEvents,
} from '../../worker/adapters/eventbrite/client';
import { buildAdapterRegistry, resolveAdapterForSourceRow } from '../../worker/core/adapter-registry';
import { REQUESTS_PER_MINUTE_BY_FAMILY, clearPolicyState } from '../../worker/health/policy';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  process.env = { ...ORIGINAL_ENV };
  clearPolicyState();
});

const TEST_ORGANIZER: EventbriteOrganizerConfig = {
  organizerKey: 'test_partner',
  organizationId: '987654321098',
  organizerName: 'Test Partner Organizer',
  sourceFamily: 'eventbrite_organizer',
  sourceName: 'Test Partner Organizer Eventbrite',
  municipality: 'Vancouver',
  timezone: 'America/Vancouver',
  authorisationNote: 'SYNTHETIC — test fixture only.',
  tokenEnvVar: organizerTokenEnvVar('test_partner'),
  enabled: true,
  maxRequestsPerRun: 3,
  maxEventsPerRun: 100,
};

describe('G-T10-2 — the honest zero, asserted rather than described', () => {
  it('ships ZERO authorised organizers, so the family registers no adapters', () => {
    // No organizer has authorised KIDS FUN; Eventbrite has no anonymous read path, and the
    // credential store holds no Eventbrite connector (checked 2026-07-31). An entry here
    // is a claim that someone said yes, and must arrive with source-register evidence.
    expect(EVENTBRITE_ORGANIZERS).toEqual([]);
    expect(loadEventbriteAdapters()).toEqual([]);
    expect(getEventbriteOrganizer('anything')).toBeUndefined();
  });

  it('the seeded placeholder source therefore resolves to NO adapter', () => {
    // The same shape as Science World's unbuilt venue row: a seeded source with no
    // adapter resolves to null rather than to something that pretends to work.
    const registry = buildAdapterRegistry();
    expect(
      resolveAdapterForSourceRow(
        {
          family: 'eventbrite_organizer',
          name: 'Organizer-scoped Eventbrite (placeholder — none configured yet)',
        },
        registry
      )
    ).toBeNull();
    // …and nothing else in the registry claims the family either.
    const eventbriteKeys = [...registry.keys()].filter((k) => k.startsWith('eventbrite_organizer::'));
    expect(eventbriteKeys).toEqual([]);
  });

  it('the registration LOOP works — onboarding an organizer is a data change, not code', () => {
    // The loop in adapter-registry.ts iterates an empty list today, so this drives the
    // same construction path with a synthetic config to prove it is wired, not dead.
    const [adapter] = loadEventbriteAdapters([TEST_ORGANIZER]);
    expect(adapter).toBeInstanceOf(EventbriteAdapter);
    expect(adapter.family).toBe('eventbrite_organizer');
    expect(adapter.family, 'family matches the seeded source.family').toBe(
      TEST_ORGANIZER.sourceFamily
    );
  });

  it('the seeded source row exists and is partner-tier', () => {
    const seeds = readFileSync(resolve(process.cwd(), 'supabase/seeds/sources.sql'), 'utf8');
    expect(seeds).toContain("('eventbrite_organizer'");
    expect(seeds).toContain('placeholder — none configured yet');
    // authority_tier 'partner', NOT 'editorial': an organizer describing their own event
    // is first-party. (G-T10-3's manual_candidate gate is editorial-tier only — see
    // tests/ingestion/editorial-candidate.test.ts.)
    expect(seeds).toMatch(/eventbrite_organizer'[^\n]*'partner',\s*'partner'/);
  });
});

describe('G-T10-2 — the token env var contract', () => {
  it('derives a stable, greppable env var name from the organizer key', () => {
    expect(organizerTokenEnvVar('test_partner')).toBe('KIDS_FUN_EVENTBRITE_TOKEN_TEST_PARTNER');
    expect(organizerTokenEnvVar('some-org.name')).toBe('KIDS_FUN_EVENTBRITE_TOKEN_SOME_ORG_NAME');
  });

  it('reads the token fresh from the environment every time (rotation without redeploy)', () => {
    delete process.env[TEST_ORGANIZER.tokenEnvVar];
    expect(organizerToken(TEST_ORGANIZER)).toBeUndefined();
    process.env[TEST_ORGANIZER.tokenEnvVar] = ' tok-1 ';
    expect(organizerToken(TEST_ORGANIZER)).toBe('tok-1');
    process.env[TEST_ORGANIZER.tokenEnvVar] = 'tok-2';
    expect(organizerToken(TEST_ORGANIZER), 'not cached from the first read').toBe('tok-2');
    process.env[TEST_ORGANIZER.tokenEnvVar] = '';
    expect(organizerToken(TEST_ORGANIZER), 'empty is absent, not a credential').toBeUndefined();
  });
});

describe('G-T10-2 — run bounds', () => {
  it('the family declares an explicit polite rate rather than inheriting the default', () => {
    expect(REQUESTS_PER_MINUTE_BY_FAMILY.eventbrite_organizer).toBe(20);
  });

  it('a runaway page walk hits the request cap LOUDLY, never silently truncates', async () => {
    // The failure mode T7/T8 were bitten by: a truncated run that still reports success.
    // A vendor that keeps saying has_more_items must produce a throw, not a short run.
    let n = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation((async () => {
      n += 1;
      return new Response(
        JSON.stringify({
          pagination: { has_more_items: true, continuation: `cursor-${n}` },
          events: [{ id: `e${n}`, name: { text: `Event ${n}` }, start: { utc: '2026-08-01T17:00:00Z' }, status: 'live' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }) as typeof fetch);

    vi.useFakeTimers();
    const pending = fetchOrganizerEvents(TEST_ORGANIZER, 'tok').catch((e) => e);
    await vi.advanceTimersByTimeAsync(120_000);
    const err = await pending;
    vi.useRealTimers();

    expect(err).toBeInstanceOf(EventbriteRequestCapExceededError);
    expect(n, 'stopped exactly at the cap').toBe(TEST_ORGANIZER.maxRequestsPerRun);
  });

  it('a cursor that stops advancing ends the walk with a warning, not an infinite loop', async () => {
    let n = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation((async () => {
      n += 1;
      return new Response(
        JSON.stringify({
          pagination: { has_more_items: true, continuation: 'stuck' },
          events: [{ id: `e${n}`, name: { text: `Event ${n}` }, start: { utc: '2026-08-01T17:00:00Z' }, status: 'live' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }) as typeof fetch);

    vi.useFakeTimers();
    const pending = fetchOrganizerEvents(TEST_ORGANIZER, 'tok');
    await vi.advanceTimersByTimeAsync(120_000);
    const result = await pending;
    vi.useRealTimers();

    expect(result.requestsUsed).toBe(2); // first page, then the repeat that proves it is stuck
    expect(result.warnings.join(' ')).toMatch(/continuation cursor did not advance/);
  });

  it('a non-2xx response fails the run, with no credential in the message', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((async () =>
      new Response('nope', { status: 401, statusText: 'Unauthorized' })) as typeof fetch);
    await expect(fetchOrganizerEvents(TEST_ORGANIZER, 'super-secret-token')).rejects.toThrow(/401/);
    await expect(fetchOrganizerEvents(TEST_ORGANIZER, 'super-secret-token')).rejects.not.toThrow(
      /super-secret-token/
    );
  });

  it('caps the events kept per run and says so when pages were left behind', async () => {
    const small = { ...TEST_ORGANIZER, maxEventsPerRun: 1, maxRequestsPerRun: 5 };
    vi.spyOn(globalThis, 'fetch').mockImplementation((async () =>
      new Response(
        JSON.stringify({
          pagination: { has_more_items: true, continuation: 'more' },
          events: [
            { id: 'a', name: { text: 'A' }, start: { utc: '2026-08-01T17:00:00Z' }, status: 'live' },
            { id: 'b', name: { text: 'B' }, start: { utc: '2026-08-02T17:00:00Z' }, status: 'live' },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )) as typeof fetch);

    const result = await fetchOrganizerEvents(small, 'tok');
    expect(result.events.map((e) => e.id)).toEqual(['a']);
    expect(result.warnings.join(' ')).toMatch(/per-run event cap \(1\) reached/);
  });
});

describe('G-T10-2 — the fixture path is inert', () => {
  it('an un-authorised adapter still extracts a shape-valid record, with no I/O', async () => {
    delete process.env.KIDS_FUN_LIVE_EVENTBRITE;
    const spy = vi.spyOn(globalThis, 'fetch');
    const adapter = new EventbriteAdapter(TEST_ORGANIZER);
    const records = adapter.extract(await adapter.fetch());
    expect(spy).not.toHaveBeenCalled();
    expect(records).toHaveLength(1);
    expect(records[0].title).toBe('Family Craft Drop-In');
    expect(records[0].startDatetimeUtc).toBe('2026-08-12T17:00:00Z');
    expect(records[0].costStatus).toBe('free');
    expect(records[0].ageText).toMatch(/ages 3-6/i);
    expect(records[0].venueMunicipalityName).toBe('Vancouver');
  });

  it('records with no title or no start instant are dropped, not half-ingested', () => {
    const adapter = new EventbriteAdapter(TEST_ORGANIZER);
    const records = adapter.extract([
      { id: '1', name: { text: '' }, start: { utc: '2026-08-01T17:00:00Z' }, status: 'live' },
      { id: '2', name: { text: 'No time' }, status: 'live' },
      { id: '3', name: { text: 'Fine' }, start: { utc: '2026-08-01T17:00:00Z' }, status: 'live' },
    ]);
    expect(records.map((r) => r.sourceRecordId)).toEqual(['3']);
  });
});
