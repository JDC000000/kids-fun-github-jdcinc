import { afterEach, describe, it, expect, vi } from 'vitest';
import { loadLibraryAdapters, LIBRARY_SYSTEMS, LibraryAdapter, getLibrarySystem } from '../../worker/adapters/library';

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

  it('live-parses the approved RPL BiblioCommons gateway shape without headless rendering', async () => {
    process.env.KIDS_FUN_LIVE_LIBRARY_SYSTEMS = 'rpl';
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
          locations: { S: { name: 'Steveston Library (Easthope Hub)' } },
          eventAudiences: { 'aud-preschool': { name: 'Children-Preschool' } },
          eventTypes: { 'type-child': { name: 'Child Development' } },
        },
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const rpl = getLibrarySystem('rpl')!;
    const adapter = new LibraryAdapter(rpl);
    const records = adapter.extract(await adapter.fetch());

    expect(fetchMock).toHaveBeenCalledOnce();
    const firstFetchCall = fetchMock.mock.calls[0] as unknown[];
    expect(String(firstFetchCall[0])).toContain('gateway.bibliocommons.com/v2/libraries/yourlibrary/events');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      sourceRecordId: 'evt-1',
      title: 'DUPLO Free Play',
      venueName: 'Steveston Library (Easthope Hub)',
      venueAddress: '4320 Moncton St, Richmond, BC V7E 6T4',
      venueLat: 49.12546,
      venueLng: -123.1783832,
      venueMunicipalityName: 'Richmond',
      venueDisplayArea: 'Steveston',
      startDatetimeUtc: '2026-09-24T18:00:00.000Z',
      endDatetimeUtc: '2026-09-24T18:30:00.000Z',
      costStatus: 'free',
      categoryHint: 'indoor_play',
      sourceUrl: 'https://yourlibrary.bibliocommons.com/v2/events/evt-1',
      locationUrl: 'https://www.google.com/maps/search/?api=1&query=4320%20Moncton%20St%20Richmond%20BC%20V7E%206T4',
    });
    expect(records[0].ageText).toContain('Children-Preschool');
    expect(records[0].ageText).toContain('ages 2-5');
  });
});
