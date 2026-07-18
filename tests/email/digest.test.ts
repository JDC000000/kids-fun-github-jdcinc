// tests/email/digest.test.ts — the pure digest builder over the fixture engine.
// No DB/network: matching reuses the real SearchEngine; "new since last email" is
// controlled by the newOccurrenceIds set the caller passes.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeFixtureEngine, FIXTURE_NOW } from '@/lib/search/__fixtures__/engine';
import { buildWeeklyDigest } from '@/lib/email/digest';

const { engine } = makeFixtureEngine();

// The two storytime fixtures (see lib/search/__fixtures__/listings.ts).
const STORYTIME_IDS = ['l-storytime-van', 'l-storytime-unknown'];

function build(newIds: string[], params: Record<string, unknown> = { q: 'storytime' }, perSearchLimit?: number) {
  return buildWeeklyDigest({
    userId: 'u-1',
    engine,
    savedSearches: [{ id: 'ss-1', name: 'Storytime', params }],
    homePostal: null,
    now: FIXTURE_NOW,
    newOccurrenceIds: new Set(newIds),
    perSearchLimit,
  });
}

describe('buildWeeklyDigest', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://app.example');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('surfaces only matches that are NEW since the watermark', () => {
    const digest = build(STORYTIME_IDS);
    expect(digest.shouldSend).toBe(true);
    expect(digest.sections).toHaveLength(1);
    const ids = digest.sections[0].activities.map((a) => a.id);
    expect(ids.length).toBeGreaterThanOrEqual(1);
    expect(ids.length).toBeLessThanOrEqual(STORYTIME_IDS.length);
    for (const id of ids) expect(STORYTIME_IDS).toContain(id);
    for (const a of digest.sections[0].activities) {
      expect(a.url).toBe(`https://app.example/preview/${encodeURIComponent(a.id)}`);
      expect(a.name).toBeTruthy();
    }
    expect(digest.totalActivities).toBe(digest.sections[0].activities.length);
  });

  it('sends nothing when there is nothing new (empty newOccurrenceIds)', () => {
    const digest = build([]);
    expect(digest.shouldSend).toBe(false);
    expect(digest.sections).toHaveLength(0);
    expect(digest.totalActivities).toBe(0);
  });

  it('omits a saved search whose new activities do not match its query', () => {
    // These ids are "new" but they are swim listings, not storytime — so the
    // storytime saved search yields no section.
    const digest = build(['l-publicswim-van', 'l-swim-nvan-evening']);
    expect(digest.shouldSend).toBe(false);
    expect(digest.sections).toHaveLength(0);
  });

  it('caps activities per saved search at perSearchLimit', () => {
    const digest = build(STORYTIME_IDS, { q: 'storytime' }, 1);
    expect(digest.sections[0].activities.length).toBeLessThanOrEqual(1);
  });
});
