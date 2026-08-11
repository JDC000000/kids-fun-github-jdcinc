// tests/email/digest_empty_state.test.ts — the digest now RECORDS why a saved search is
// empty instead of dropping it silently.
//
// Before this unit, buildWeeklyDigest ran every saved search with `minResults: 0` (correct —
// an email must not pad itself with non-matches) and, because the engine fused explaining
// with broadening, a saved search that matched nothing produced NOTHING: no section, no
// reason, and — if it was the parent's only saved search — no email in which to say so.
//
// It is NOT a price-filter bug. The cases below are a weekend, a time of day, the Free
// filter and Drop-in; the mechanism is identical for every constraint, which is why this
// unit exists at all.
//
// THE SAFETY PROPERTY: `shouldSend` is unchanged and must stay unchanged. An email still
// requires at least one genuine new match, so no currently-silent parent starts receiving
// mail as a side effect. The "never sends" test below is the guard.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeFixtureEngine, FIXTURE_NOW } from '@/lib/search/__fixtures__/engine';
import { FIXTURE_LISTINGS } from '@/lib/search/__fixtures__/listings';
import { buildWeeklyDigest, type DigestSavedSearch } from '@/lib/email/digest';

const { engine } = makeFixtureEngine();
const ALL_IDS = FIXTURE_LISTINGS.map((l) => l.id);
const STORYTIME_IDS = ['l-storytime-van', 'l-storytime-unknown'];

/**
 * Saved searches that match NOTHING in the fixtures, one per constraint kind, expressed as
 * stored /search params exactly as an /account row holds them.
 */
const BLOCKED_SEARCHES: Array<{ name: string; params: Record<string, unknown>; blocking: string; label: string }> = [
  { name: 'Weekend swim', params: { q: 'swim', when: 'weekend' }, blocking: 'date', label: 'date' },
  { name: 'Evening storytime', params: { q: 'storytime', time: 'evening' }, blocking: 'timeOfDay', label: 'time of day' },
  { name: 'Free swim', params: { q: 'swim', free: '1' }, blocking: 'costFree', label: 'Free filter' },
  { name: 'Drop-in swim', params: { q: 'swim', dropin: '1' }, blocking: 'dropIn', label: 'Drop-in filter' },
];

function build(savedSearches: DigestSavedSearch[], newIds: string[]) {
  return buildWeeklyDigest({
    userId: 'u-1',
    engine,
    savedSearches,
    homePostal: null,
    now: FIXTURE_NOW,
    newOccurrenceIds: new Set(newIds),
  });
}

describe('buildWeeklyDigest — empty saved searches are explained, not swallowed', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://app.example');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(BLOCKED_SEARCHES)(
    'records the blocking constraint for a saved search that matches zero: $name',
    ({ name, params, blocking, label }) => {
      const digest = build([{ id: 'ss-1', name, params }], ALL_IDS);

      expect(digest.sections).toHaveLength(0); // still no empty section — nothing to list
      expect(digest.emptySearches).toHaveLength(1);

      const [empty] = digest.emptySearches;
      expect(empty.savedSearchId).toBe('ss-1');
      expect(empty.label).toBe(name);
      expect(empty.blockingConstraint).toBe(blocking);
      expect(empty.blockingLabel).toBe(label);
      // A link back to the search that can be adjusted.
      expect(empty.searchUrl).toContain('https://app.example/search?');
    },
  );

  it('NEVER makes an email happen: a user whose only saved search matches zero still gets none', () => {
    const digest = build([{ id: 'ss-1', name: 'Weekend swim', params: { q: 'swim', when: 'weekend' } }], ALL_IDS);

    // The reason is recorded...
    expect(digest.emptySearches).toHaveLength(1);
    expect(digest.emptySearches[0].blockingConstraint).toBe('date');
    // ...and it changes NOTHING about whether we write. This is the safety property of the
    // whole unit: reddens if anyone ever lets emptySearches feed shouldSend.
    expect(digest.shouldSend).toBe(false);
    expect(digest.totalActivities).toBe(0);
    expect(digest.sections).toHaveLength(0);
  });

  it('NEVER makes an email happen: many blocked searches are still not a reason to send', () => {
    const digest = build(
      BLOCKED_SEARCHES.map((s, i) => ({ id: `ss-${i}`, name: s.name, params: s.params })),
      ALL_IDS,
    );
    expect(digest.emptySearches).toHaveLength(BLOCKED_SEARCHES.length);
    expect(digest.shouldSend).toBe(false);
    expect(digest.totalActivities).toBe(0);
  });

  it('rides along with an email that IS being sent, without changing the send decision', () => {
    const digest = build(
      [
        { id: 'ss-match', name: 'Storytime', params: { q: 'storytime' } },
        { id: 'ss-blocked', name: 'Weekend swim', params: { q: 'swim', when: 'weekend' } },
      ],
      [...STORYTIME_IDS],
    );

    expect(digest.shouldSend).toBe(true);
    expect(digest.totalActivities).toBeGreaterThan(0);
    expect(digest.sections.map((s) => s.savedSearchId)).toEqual(['ss-match']);
    expect(digest.emptySearches.map((e) => e.savedSearchId)).toEqual(['ss-blocked']);
  });

  it('does NOT name a constraint for a search that matches but has nothing NEW this week', () => {
    // 'storytime' has matches; the "new since last email" set is empty, so the section is
    // dropped. No filter is blocking it, and claiming one would be false.
    const digest = build([{ id: 'ss-1', name: 'Storytime', params: { q: 'storytime' } }], []);
    expect(digest.sections).toHaveLength(0);
    expect(digest.shouldSend).toBe(false);
    expect(digest.emptySearches).toHaveLength(0);
  });

  it('records nothing when every saved search matches', () => {
    const digest = build([{ id: 'ss-1', name: 'Storytime', params: { q: 'storytime' } }], [...STORYTIME_IDS]);
    expect(digest.shouldSend).toBe(true);
    expect(digest.emptySearches).toHaveLength(0);
  });
});
