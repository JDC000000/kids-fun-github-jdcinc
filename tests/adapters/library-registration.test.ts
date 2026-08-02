// tests/adapters/library-registration.test.ts — Option A: the BiblioCommons
// registrationRequired boolean, which this adapter has computed since G-T9 and then
// collapsed into `bookingUrl ? url : undefined`, losing both the boolean itself and — more
// importantly — the difference between "the source says no registration" and "the source
// said nothing".
//
// The asymmetry between the two BiblioCommons feeds is the substance here:
//   • the JSON gateway reads a STRUCTURED registrationInfo block → authoritative both ways
//   • the RSS feed regexes free prose            → authoritative only when it MATCHES
// A version of this change that ignored that difference would emit `false` for every RSS
// item whose description happens not to mention registration, i.e. manufacture drop-in
// claims out of silence for the whole feed. That case is pinned below.
import { afterEach, describe, it, expect, vi } from 'vitest';
import { LibraryAdapter, loadLibraryAdapters, registrationAssertion } from '../../worker/adapters/library';
import type { LibrarySystemConfig } from '../../worker/adapters/library/config';

const gatewaySystem: LibrarySystemConfig = {
  systemKey: 'gwreg',
  systemName: 'Gateway Registration Test Library',
  platform: 'bibliocommons',
  sourceFamily: 'library_bibliocommons',
  sourceName: 'Gateway Registration Test Library BiblioEvents',
  feedBaseUrl: 'https://gwreg.bibliocommons.com/events',
  gatewayEventsUrl: 'https://gateway.bibliocommons.com/v2/libraries/gwreg/events',
  liveEventsLimit: 20,
  liveCapable: true,
};

/** One gateway response carrying two events with the registrationInfo blocks given. */
function gatewayBody(events: Array<{ id: string; title: string; registrationInfo: unknown }>) {
  return {
    events: { items: events.map((e) => e.id) },
    entities: {
      events: Object.fromEntries(
        events.map((e) => [
          e.id,
          {
            id: e.id,
            definition: {
              start: '2026-09-24T11:00',
              end: '2026-09-24T11:30',
              title: e.title,
              description: '<p>For children ages 2-5 with a caregiver.</p>',
              branchLocationId: 'S',
              audienceIds: [],
              typeIds: [],
              registrationInfo: e.registrationInfo,
              isCancelled: false,
            },
          },
        ])
      ),
      locations: { S: { name: 'Central Branch' } },
      eventAudiences: {},
      eventTypes: {},
    },
  };
}

function rssFeed(items: Array<{ id: string; title: string; description: string }>): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:bc="http://bibliocommons.com/rss/1.0/modules/event/" version="2.0"><channel>
${items
  .map(
    (i) => `<item>
<title><![CDATA[${i.title}]]></title>
<description><![CDATA[${i.description}]]></description>
<link>https://rssreg.bibliocommons.com/events/${i.id}</link>
<bc:start_date>2026-09-24T18:00:00Z</bc:start_date>
<bc:end_date>2026-09-24T18:30:00Z</bc:end_date>
<bc:is_cancelled>false</bc:is_cancelled>
<bc:location><bc:name>Steveston Library</bc:name><bc:city>Richmond</bc:city></bc:location>
</item>`
  )
  .join('\n')}
</channel></rss>`;
}

const rssSystem: LibrarySystemConfig = {
  systemKey: 'rssreg',
  systemName: 'RSS Registration Test Library',
  platform: 'bibliocommons',
  sourceFamily: 'library_bibliocommons',
  sourceName: 'RSS Registration Test Library BiblioEvents',
  feedBaseUrl: 'https://rssreg.bibliocommons.com/events',
  rssEventsUrl: 'https://rssreg.bibliocommons.com/events/rss',
  liveEventsLimit: 20,
  liveCapable: true,
};

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.KIDS_FUN_LIVE_LIBRARY_SYSTEMS;
});

describe('library (BiblioCommons JSON gateway) — a structured flag, authoritative both ways', () => {
  async function extractGateway(events: Parameters<typeof gatewayBody>[0]) {
    process.env.KIDS_FUN_LIVE_LIBRARY_SYSTEMS = 'gwreg';
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => gatewayBody(events) })));
    const adapter = new LibraryAdapter(gatewaySystem);
    return adapter.extract(await adapter.fetch());
  }

  it('emits registrationRequired=true when the library\'s own booking system demands a login', async () => {
    const [record] = await extractGateway([
      {
        id: 'evt-login',
        title: 'Lego Club',
        registrationInfo: { enabledMethods: ['ONLINE'], loginToRegister: true, maxSeats: 20, cap: 20 },
      },
    ]);
    expect(record.registrationRequired).toBe(true);
    // The pre-existing bookingUrl encoding is UNCHANGED — the boolean is emitted alongside
    // it, not instead of it, because downstream consumers already read the url.
    expect(record.bookingUrl).toBe('https://gwreg.bibliocommons.com/v2/events/evt-login');
  });

  it('emits registrationRequired=FALSE — a positive drop-in claim — when no registration method is enabled', async () => {
    const [record] = await extractGateway([
      {
        id: 'evt-open',
        title: 'Baby Storytime',
        registrationInfo: { enabledMethods: [], loginToRegister: false, maxSeats: null, cap: null },
      },
    ]);
    // The value the old pipeline could NOT express: bookingUrl is absent either way, so
    // "no registration needed" and "we have no idea" used to be the same row.
    expect(record.registrationRequired).toBe(false);
    expect(record.bookingUrl).toBeUndefined();
  });

  it('does NOT treat a bare seat cap as registration — there is no mechanism to register with', async () => {
    // NARROWED in QA round 139 (F-16). An earlier version of this branch asserted `true`
    // here, matching the adapter's pre-existing derivation. That was incoherent, not merely
    // broad: enabledMethods is empty and loginToRegister is false, so the vendor offers NO
    // WAY to register — while maxSeats/cap only say how many people the room holds, which is
    // true of nearly every walk-in library storytime. Because this field now evicts content
    // from the default view, the broad form would have removed real drop-in programming.
    // ONE extractGateway call per test, deliberately: politeFetch enforces a ~3s per-source
    // rate-limit floor, so two live-path fetches in a single `it` blow the 5s default
    // timeout. `maxSeats` gets its own case below rather than being batched in here.
    const [capOnly] = await extractGateway([
      { id: 'evt-cap', title: 'Craft Session', registrationInfo: { enabledMethods: [], loginToRegister: false, maxSeats: null, cap: 12 } },
    ]);
    expect(capOnly.registrationRequired).toBe(false);
    expect(capOnly.bookingUrl).toBeUndefined();
  });

  it('does NOT treat a bare maxSeats as registration either', async () => {
    const [seatsOnly] = await extractGateway([
      { id: 'evt-seats', title: 'Baby Storytime', registrationInfo: { enabledMethods: [], loginToRegister: false, maxSeats: 30, cap: null } },
    ]);
    expect(seatsOnly.registrationRequired).toBe(false);
    expect(seatsOnly.bookingUrl).toBeUndefined();
  });

  it('still flags a capped event that DOES expose a registration method', () => {
    // The narrowing must not go too far the other way: a cap alongside a real enabled method
    // is still registration-required. The cap is simply not what makes it so.
    return extractGateway([
      { id: 'evt-both', title: 'Lego Club', registrationInfo: { enabledMethods: ['ONLINE'], loginToRegister: false, maxSeats: 20, cap: 20 } },
    ]).then(([record]) => {
      expect(record.registrationRequired).toBe(true);
    });
  });

  it('reports both verdicts in one payload rather than collapsing the calendar to a single value', async () => {
    const records = await extractGateway([
      { id: 'a', title: 'Registered Program', registrationInfo: { enabledMethods: ['ONLINE'], loginToRegister: true } },
      { id: 'b', title: 'Turn Up Storytime', registrationInfo: { enabledMethods: [], loginToRegister: false } },
    ]);
    expect(records.map((r) => r.registrationRequired)).toEqual([true, false]);
  });
});

describe('library (BiblioCommons RSS) — prose, authoritative only when it matches', () => {
  async function extractRss(items: Parameters<typeof rssFeed>[0]) {
    process.env.KIDS_FUN_LIVE_LIBRARY_SYSTEMS = 'rssreg';
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => rssFeed(items) })));
    const adapter = new LibraryAdapter(rssSystem);
    return adapter.extract(await adapter.fetch());
  }

  it('emits true when the description actually says registration is required', async () => {
    const [record] = await extractRss([
      { id: 'rss-1', title: 'DUPLO Free Play', description: '<p>Ages 2-5.</p><p>Registration Required.</p>' },
    ]);
    expect(record.registrationRequired).toBe(true);
    expect(record.bookingUrl).toBe('https://rssreg.bibliocommons.com/events/rss-1');
  });

  it('emits UNDEFINED — never false — when the description is simply silent', async () => {
    const [record] = await extractRss([
      { id: 'rss-2', title: 'Family Storytime', description: '<p>Join us for songs and stories.</p>' },
    ]);
    // THE LOAD-BEARING CASE. A regex miss over free prose is silence, not evidence of
    // drop-in. Emitting `false` here would assert "no booking needed" for essentially the
    // entire RSS feed on the strength of a sentence not being present.
    expect(record.registrationRequired).toBeUndefined();
    expect(record.bookingUrl).toBeUndefined();
  });
});

describe('library — the shared assertion helper', () => {
  it('passes a structured verdict through and downgrades a prose miss to unknown', () => {
    const base = { id: 'x', title: 't', branch: 'b', startsAt: '2026-09-24T18:00:00.000Z', ages: 'a', url: 'u' };
    expect(registrationAssertion({ ...base, registrationRequired: true, registrationSignal: 'registration-info' })).toBe(true);
    expect(registrationAssertion({ ...base, registrationRequired: false, registrationSignal: 'registration-info' })).toBe(false);
    expect(registrationAssertion({ ...base, registrationRequired: true, registrationSignal: 'description-prose' })).toBe(true);
    expect(registrationAssertion({ ...base, registrationRequired: false, registrationSignal: 'description-prose' })).toBeUndefined();
  });
});

describe('library — families with no registration signal stay silent', () => {
  it('leaves registrationRequired unset on the generic_rss and Communico paths', async () => {
    const records = (
      await Promise.all(loadLibraryAdapters().map(async (a) => a.extract(await a.fetch())))
    ).flat();
    // NVDPL's generic RSS and the Communico feed publish nothing either way. They must not
    // acquire a drop-in claim just because the field now exists.
    const silent = records.filter((r) => !/Baby Storytime/.test(r.title));
    expect(silent.length).toBeGreaterThan(0);
    expect(silent.every((r) => r.registrationRequired === undefined)).toBe(true);
  });
});
