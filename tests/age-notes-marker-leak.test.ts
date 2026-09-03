// tests/age-notes-marker-leak.test.ts — internal pipeline markers must never reach a parent.
//
// 621 of 1,687 live listings (36.8%) carry age_notes beginning 'unresolved:', 5 begin 'audience:'.
// At least 12 carry a full engineering changelog — a real git SHA and an internal document slug —
// rendered verbatim on a public page AND returned by /api/search to unauthenticated callers.
import { describe, expect, it } from 'vitest';
import { isInternalAgeMarker } from '../app/preview/_data/format';
import { mapListingRecordToActivity } from '../app/preview/_data/search-api';
import { makeListing } from '../lib/search/__fixtures__/factory';

const CHANGELOG =
  'unresolved: NoAgeRestriction contradicted by title-stated age (operator batch correction ' +
  '2026-08-19, section-3h measurement, code fix live in 9f95e31, worker release v24)';

describe('isInternalAgeMarker', () => {
  it('🔴 catches BOTH prefixes — age-fallback.ts names them together', () => {
    expect(isInternalAgeMarker('unresolved: Games Area')).toBe(true);
    expect(isInternalAgeMarker('audience: Adults')).toBe(true);
    expect(isInternalAgeMarker(CHANGELOG)).toBe(true);
  });

  it('is case- and whitespace-insensitive, as stored values are not guaranteed normalised', () => {
    expect(isInternalAgeMarker('  UNRESOLVED: x')).toBe(true);
    expect(isInternalAgeMarker('Audience: x')).toBe(true);
  });

  it('🔴 does NOT catch a genuine source note', () => {
    // The failure that would matter in the other direction: suppressing real information.
    for (const good of [
      'Under 5 must be accompanied by an adult',
      'All ages welcome',
      'Adults only',           // contains "Adults" but is not the audience: marker
      'Unresolved questions welcome at the desk', // starts with the word, not the marker
    ]) {
      expect(isInternalAgeMarker(good), good).toBe(false);
    }
  });
});

describe('🔴 the mapper drops a marked note WHOLE, not just its prefix', () => {
  it('emits no ageNotes at all for a marked value', () => {
    const a = mapListingRecordToActivity(makeListing({ ageNotes: CHANGELOG } as never));
    expect(a.ageNotes).toBeUndefined();
  });

  it('🔴 the git SHA does not survive anywhere in the mapped object', () => {
    // Stripping only the prefix would leave "…code fix live in 9f95e31, worker release v24",
    // which is why the whole value is dropped rather than trimmed.
    const a = mapListingRecordToActivity(makeListing({ ageNotes: CHANGELOG } as never));
    expect(JSON.stringify(a)).not.toContain('9f95e31');
    expect(JSON.stringify(a)).not.toContain('worker release');
  });

  it('🔴 a GENUINE note still comes through — the guard must discriminate', () => {
    // Without this, "no marker in the output" passes just as well when nothing is emitted at all.
    const a = mapListingRecordToActivity(
      makeListing({ ageNotes: 'Under 5 must be accompanied by an adult' } as never)
    );
    expect(a.ageNotes).toBe('Under 5 must be accompanied by an adult');
  });
});
