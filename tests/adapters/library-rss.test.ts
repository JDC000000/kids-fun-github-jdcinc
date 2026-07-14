import { afterEach, describe, it, expect, vi } from 'vitest';
import { LibraryAdapter, getLibrarySystem } from '../../worker/adapters/library';

// KIDS FUN Task 5 — VPL BiblioCommons RSS/XML live path (ToS-permitted mechanism).
// The library adapter parses the public RSS feed (no login, no headless render),
// deriving venue geo from the bc: namespace so ingest never calls a geocoder.

const VPL_RSS_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:bc="http://bibliocommons.com/rss">
<channel>
<title><![CDATA[Vancouver Public Library — Events]]></title>
<link>https://vpl.bibliocommons.com/events</link>
<description><![CDATA[Upcoming events]]></description>
<language>en-CA</language>
<item>
<title><![CDATA[Baby Storytime]]></title>
<description><![CDATA[<p>Songs and rhymes for babies. For children ages 0-2 with a caregiver.</p><p>Registration Required.</p>]]></description>
<link>https://vpl.bibliocommons.com/events/6a062d43caf93436005bf001</link>
<guid isPermaLink="true">https://vpl.bibliocommons.com/events/6a062d43caf93436005bf001</guid>
<category><![CDATA[Storytimes]]></category>
<category><![CDATA[Babies &amp; Toddlers]]></category>
<category><![CDATA[English]]></category>
<bc:start_date>2026-07-15T17:30:00Z</bc:start_date>
<bc:start_date_local>2026-07-15T10:30</bc:start_date_local>
<bc:end_date>2026-07-15T18:00:00Z</bc:end_date>
<bc:is_cancelled>false</bc:is_cancelled>
<bc:is_virtual>false</bc:is_virtual>
<bc:location><bc:id>MPL</bc:id><bc:name>Mount Pleasant Branch</bc:name><bc:number>1</bc:number><bc:street>Kingsway</bc:street><bc:city>Vancouver</bc:city><bc:zip>V5T 3H7</bc:zip><bc:state></bc:state><bc:country>CA</bc:country><bc:latitude>49.26432743195909</bc:latitude><bc:longitude>-123.1004038834671</bc:longitude><bc:location_details>Meeting Room</bc:location_details></bc:location>
</item>
<item>
<title><![CDATA[Cancelled Program]]></title>
<description><![CDATA[<p>This one is cancelled.</p>]]></description>
<link>https://vpl.bibliocommons.com/events/6a062d43caf93436005bf002</link>
<guid isPermaLink="true">https://vpl.bibliocommons.com/events/6a062d43caf93436005bf002</guid>
<category><![CDATA[Children]]></category>
<bc:start_date>2026-07-16T17:30:00Z</bc:start_date>
<bc:is_cancelled>true</bc:is_cancelled>
<bc:location><bc:name>Central Branch</bc:name><bc:latitude>49.279</bc:latitude><bc:longitude>-123.115</bc:longitude></bc:location>
</item>
</channel>
</rss>`;

describe('Library adapter — VPL BiblioCommons RSS live path (Task 5)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.KIDS_FUN_LIVE_LIBRARY_SYSTEMS;
  });

  it('is live-enabled only when vpl is in KIDS_FUN_LIVE_LIBRARY_SYSTEMS', () => {
    const vpl = getLibrarySystem('vpl')!;
    const adapter = new LibraryAdapter(vpl);
    expect(adapter.isLiveFetchEnabled()).toBe(false);
    process.env.KIDS_FUN_LIVE_LIBRARY_SYSTEMS = 'vpl';
    expect(adapter.isLiveFetchEnabled()).toBe(true);
    expect(vpl.rssEventsUrl).toContain('gateway.bibliocommons.com/v2/libraries/vpl/rss/events');
  });

  it('fetches the RSS feed (not the JSON gateway) and parses venue geo + UTC dates', async () => {
    process.env.KIDS_FUN_LIVE_LIBRARY_SYSTEMS = 'vpl';
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => VPL_RSS_FIXTURE,
    }));
    vi.stubGlobal('fetch', fetchMock);

    const vpl = getLibrarySystem('vpl')!;
    const adapter = new LibraryAdapter(vpl);
    const records = await adapter.extract(await adapter.fetch());

    expect(fetchMock).toHaveBeenCalledOnce();
    const firstFetchCall = fetchMock.mock.calls[0] as unknown[];
    expect(String(firstFetchCall[0])).toContain(
      'gateway.bibliocommons.com/v2/libraries/vpl/rss/events'
    );

    // The cancelled item is skipped.
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      sourceRecordId: '6a062d43caf93436005bf001',
      title: 'Baby Storytime',
      venueName: 'Mount Pleasant Branch',
      venueAddress: '1 Kingsway, Vancouver, BC V5T 3H7',
      venueLat: 49.26432743195909,
      venueLng: -123.1004038834671,
      venueMunicipalityName: 'Vancouver',
      venueDisplayArea: 'Mount Pleasant',
      startDatetimeUtc: '2026-07-15T17:30:00.000Z',
      endDatetimeUtc: '2026-07-15T18:00:00.000Z',
      costStatus: 'free',
      categoryHint: 'storytime',
      sourceUrl: 'https://vpl.bibliocommons.com/events/6a062d43caf93436005bf001',
      bookingUrl: 'https://vpl.bibliocommons.com/events/6a062d43caf93436005bf001',
    });
    expect(records[0].ageText).toContain('ages 0-2');
  });

  it('builds a stable per-system dedup key from the event id', async () => {
    process.env.KIDS_FUN_LIVE_LIBRARY_SYSTEMS = 'vpl';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, statusText: 'OK', text: async () => VPL_RSS_FIXTURE }))
    );
    const adapter = new LibraryAdapter(getLibrarySystem('vpl')!);
    const [record] = await adapter.extract(await adapter.fetch());
    expect(adapter.dedupKeys(record)).toEqual({ key: 'library::vpl::6a062d43caf93436005bf001' });
  });
});
