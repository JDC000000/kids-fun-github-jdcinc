import { afterEach, describe, it, expect, vi } from 'vitest';
import { loadLibraryAdapters, LIBRARY_SYSTEMS, LibraryAdapter, getLibrarySystem } from '../../worker/adapters/library';
import type { LibrarySystemConfig } from '../../worker/adapters/library/config';

// G-T9-1/2 — Library adapter scaffold (TSD §5.1 Adapter B).
describe('Library adapter scaffold (G-T9-1/2)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.KIDS_FUN_LIVE_LIBRARY_SYSTEMS;
  });

  it('covers >=2 library systems across both platforms', () => {
    expect(LIBRARY_SYSTEMS.length).toBeGreaterThanOrEqual(2);
    const platforms = new Set(LIBRARY_SYSTEMS.map((s) => s.platform));
    expect(platforms.has('bibliocommons')).toBe(true);
    expect(platforms.has('communico')).toBe(true);
    expect(loadLibraryAdapters().every((a) => a.family === 'library')).toBe(true);
  });

  it('parses BiblioCommons + Communico storytime with branch + age + exact date', async () => {
    // All systems' records across the launch library adapters.
    const all = (
      await Promise.all(loadLibraryAdapters().map(async (a) => a.extract(await a.fetch())))
    ).flat();
    expect(all.every((r) => r.categoryHint === 'storytime')).toBe(true);

    const baby = all.find((r) => r.title === 'Baby Storytime')!; // BiblioCommons
    expect(baby.venueName).toContain('Central'); // branch/location provenance
    expect(baby.ageText).toBe('0-2 years');
    expect(baby.startDatetimeUtc).toBe('2026-07-15T17:30:00.000Z');
    expect(baby.costStatus).toBe('free');

    const toddler = all.find((r) => r.title === 'Toddler Storytime')!; // Communico
    expect(toddler.ageText).toBe('Ages 2-5');
    expect(toddler.venueName).toContain('City Centre');
  });

  // KIDS FUN Task 8 (2026-07-13) — RPL migrated OFF the ToS-ambiguous JSON
  // gateway ONTO the ToS-permitted BiblioCommons RSS/XML feed (same slug
  // `yourlibrary`), reusing Task 5's generic RSS parser. Venue geo now comes
  // from the feed's bc:location block (no config geocoder fallback needed).
  const RPL_RSS_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:bc="http://bibliocommons.com/rss/1.0/modules/event/" version="2.0">
<channel>
<title><![CDATA[Events | Richmond Public Library]]></title>
<link>https://yourlibrary.bibliocommons.com/events</link>
<description><![CDATA[Events RSS feed]]></description>
<language><![CDATA[en-CA]]></language>
<item>
<title><![CDATA[DUPLO Free Play]]></title>
<description><![CDATA[<p>Ideal for children ages 2-5 with a caregiver.</p><p>Registration Required.</p>]]></description>
<link>https://yourlibrary.bibliocommons.com/events/6a2b26b67550c8bf9f5cab8e</link>
<guid isPermaLink="true">https://yourlibrary.bibliocommons.com/events/6a2b26b67550c8bf9f5cab8e</guid>
<category><![CDATA[Children]]></category>
<bc:start_date>2026-09-24T18:00:00Z</bc:start_date>
<bc:end_date>2026-09-24T18:30:00Z</bc:end_date>
<bc:is_cancelled>false</bc:is_cancelled>
<bc:location><bc:id>STV</bc:id><bc:name>Steveston Library (Easthope Hub)</bc:name><bc:number>4320</bc:number><bc:street>Moncton St</bc:street><bc:city>Richmond</bc:city><bc:zip>V7E 6T4</bc:zip><bc:state>BC</bc:state><bc:latitude>49.12546</bc:latitude><bc:longitude>-123.1783832</bc:longitude></bc:location>
</item>
<item>
<title><![CDATA[Cancelled Program]]></title>
<description><![CDATA[<p>Cancelled.</p>]]></description>
<link>https://yourlibrary.bibliocommons.com/events/6a2b26b67550c8bf9f5cab8f</link>
<bc:start_date>2026-09-25T18:00:00Z</bc:start_date>
<bc:is_cancelled>true</bc:is_cancelled>
<bc:location><bc:name>Brighouse</bc:name><bc:latitude>49.163814</bc:latitude><bc:longitude>-123.1409957</bc:longitude></bc:location>
</item>
</channel>
</rss>`;

  it('migrates RPL to the ToS-permitted RSS feed (not the JSON gateway) and parses venue geo from the feed', async () => {
    const rpl = getLibrarySystem('rpl')!;
    // Migration invariant: RSS is configured and the JSON gateway URL is gone,
    // so RPL can never silently fall back onto the ToS-ambiguous gateway path.
    expect(rpl.rssEventsUrl).toContain('gateway.bibliocommons.com/v2/libraries/yourlibrary/rss/events');
    expect(rpl.gatewayEventsUrl).toBeUndefined();

    process.env.KIDS_FUN_LIVE_LIBRARY_SYSTEMS = 'rpl';
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => RPL_RSS_FIXTURE,
    }));
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new LibraryAdapter(rpl);
    const records = await adapter.extract(await adapter.fetch());

    expect(fetchMock).toHaveBeenCalledOnce();
    const firstFetchCall = fetchMock.mock.calls[0] as unknown[];
    expect(String(firstFetchCall[0])).toContain('gateway.bibliocommons.com/v2/libraries/yourlibrary/rss/events');

    // The cancelled item is skipped.
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      sourceRecordId: '6a2b26b67550c8bf9f5cab8e',
      title: 'DUPLO Free Play',
      venueName: 'Steveston Library (Easthope Hub)',
      venueAddress: '4320 Moncton St, Richmond, BC V7E 6T4',
      venueLat: 49.12546, // geo from the feed, not the config fallback
      venueLng: -123.1783832,
      venueMunicipalityName: 'Richmond',
      startDatetimeUtc: '2026-09-24T18:00:00.000Z',
      endDatetimeUtc: '2026-09-24T18:30:00.000Z',
      costStatus: 'free',
      categoryHint: 'indoor_play',
      sourceUrl: 'https://yourlibrary.bibliocommons.com/events/6a2b26b67550c8bf9f5cab8e',
    });
    expect(records[0].ageText).toContain('ages 2-5');
    // Dedup key stays keyed on the RSS event-instance id.
    expect(adapter.dedupKeys(records[0])).toEqual({
      key: 'library::rpl::6a2b26b67550c8bf9f5cab8e',
    });
  });

  it('retains the generic BiblioCommons JSON gateway parser for any gateway-only system', async () => {
    // No launch system uses the JSON gateway after Task 8, but the parser is
    // kept as generic capability; this guards it against silent regression.
    const gatewaySystem: LibrarySystemConfig = {
      systemKey: 'gwonly',
      systemName: 'Gateway-Only Test Library',
      platform: 'bibliocommons',
      sourceFamily: 'library_bibliocommons',
      sourceName: 'Gateway-Only Test Library BiblioEvents',
      feedBaseUrl: 'https://gwonly.bibliocommons.com/events',
      gatewayEventsUrl: 'https://gateway.bibliocommons.com/v2/libraries/gwonly/events',
      liveEventsLimit: 20,
      // `liveCapable` is REQUIRED as of the NVDPL/D-12 change (2026-07-31). The live gate
      // used to read `platform === 'bibliocommons'`, which meant any object with that
      // platform string could live-fetch if the env named it. It now requires an explicit
      // per-system declaration that a reviewed live path exists — strictly fail-closed, and
      // the reason this synthetic system has to opt in here. Not a weakened assertion: the
      // test still proves the gateway parser works, it just has to say so out loud.
      liveCapable: true,
    };
    process.env.KIDS_FUN_LIVE_LIBRARY_SYSTEMS = 'gwonly';
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        events: { items: ['evt-1'] },
        entities: {
          events: {
            'evt-1': {
              id: 'evt-1',
              definition: {
                start: '2026-09-24T11:00',
                end: '2026-09-24T11:30',
                title: 'DUPLO Free Play',
                description: '<p>Ideal for children ages 2-5 with a caregiver.</p><p>No registration needed.</p>',
                branchLocationId: 'S',
                audienceIds: ['aud-preschool'],
                typeIds: ['type-child'],
                registrationInfo: { enabledMethods: [], loginToRegister: false, maxSeats: null, cap: null },
                isCancelled: false,
              },
            },
          },
          locations: { S: { name: 'Central Branch' } },
          eventAudiences: { 'aud-preschool': { name: 'Children-Preschool' } },
          eventTypes: { 'type-child': { name: 'Child Development' } },
        },
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new LibraryAdapter(gatewaySystem);
    const records = adapter.extract(await adapter.fetch());

    expect(fetchMock).toHaveBeenCalledOnce();
    const gwFetchCall = fetchMock.mock.calls[0] as unknown[];
    expect(String(gwFetchCall[0])).toContain('gateway.bibliocommons.com/v2/libraries/gwonly/events');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      sourceRecordId: 'evt-1',
      title: 'DUPLO Free Play',
      venueName: 'Central Branch',
      startDatetimeUtc: '2026-09-24T18:00:00.000Z',
      categoryHint: 'indoor_play',
      sourceUrl: 'https://gwonly.bibliocommons.com/v2/events/evt-1',
    });
    expect(records[0].ageText).toContain('Children-Preschool');
  });
});
