// tests/geo/postal-fsa.test.ts — Static FSA → area-centroid origin resolver (Task 29).

import { describe, it, expect } from 'vitest';
import {
  fsaOf,
  regionIdForPostal,
  areaLabelForPostal,
  fsaGeocoder,
  FSA_REGION,
  MUNICIPALITY_CENTROID,
} from '../../lib/geo/postal-fsa';

describe('fsaOf', () => {
  it('extracts + normalizes the 3-char FSA from any casing/spacing', () => {
    expect(fsaOf('V6K 1A1')).toBe('V6K');
    expect(fsaOf('v6k1a1')).toBe('V6K');
    expect(fsaOf('  v6k  ')).toBe('V6K');
    expect(fsaOf('V6K')).toBe('V6K');
  });

  it('returns null for malformed or empty input', () => {
    expect(fsaOf('')).toBeNull();
    expect(fsaOf(null)).toBeNull();
    expect(fsaOf(undefined)).toBeNull();
    expect(fsaOf('12A')).toBeNull(); // wrong shape (digit-first)
    expect(fsaOf('AB')).toBeNull(); // too short
  });
});

describe('regionIdForPostal / areaLabelForPostal', () => {
  it('maps covered Metro-Vancouver FSAs to their municipality', () => {
    expect(regionIdForPostal('V6K 1A1')).toBe('van'); // Kitsilano, Vancouver
    expect(regionIdForPostal('V5H 4M1')).toBe('bby'); // Metrotown, Burnaby
    expect(regionIdForPostal('V7M 1A1')).toBe('nvan'); // North Vancouver
    expect(regionIdForPostal('V7T 1A1')).toBe('wvan'); // West Vancouver
    expect(regionIdForPostal('V6X 1A1')).toBe('rmd'); // Richmond
  });

  it('gives a human area label for a covered postal', () => {
    expect(areaLabelForPostal('V7M 1A1')).toBe('North Vancouver');
    expect(areaLabelForPostal('v6k1a1')).toBe('Vancouver');
  });

  it('returns null for an out-of-coverage or invalid postal (no fake origin)', () => {
    expect(regionIdForPostal('V3L 1A1')).toBeNull(); // New Westminster — not covered
    expect(regionIdForPostal('M5V 1A1')).toBeNull(); // Toronto
    expect(regionIdForPostal('not-a-postal')).toBeNull();
    expect(areaLabelForPostal('V3L 1A1')).toBeNull();
    expect(areaLabelForPostal(null)).toBeNull();
  });

  it('every FSA maps to a municipality that has a centroid (no dangling ids)', () => {
    for (const id of Object.values(FSA_REGION)) {
      expect(MUNICIPALITY_CENTROID[id], `centroid for ${id}`).toBeDefined();
    }
  });
});

describe('fsaGeocoder (self-contained, backend-independent)', () => {
  it('resolves a covered postal to its municipality centroid', () => {
    expect(fsaGeocoder.geocodePostal('V7M 1A1')).toEqual(MUNICIPALITY_CENTROID.nvan);
    expect(fsaGeocoder.geocodePostal('V6X 1A1')).toEqual(MUNICIPALITY_CENTROID.rmd);
  });

  it('maps every FSA in a municipality to the same point', () => {
    // Two different Vancouver FSAs → the one Vancouver centroid.
    expect(fsaGeocoder.geocodePostal('V6K 2G8')).toEqual(fsaGeocoder.geocodePostal('V5L 3P9'));
    expect(fsaGeocoder.geocodePostal('V6K 2G8')).toEqual(MUNICIPALITY_CENTROID.van);
  });

  it('returns a real WGS84 GeoPoint ({lng,lat}) — not 0,0 or fabricated precision', () => {
    const p = fsaGeocoder.geocodePostal('V5H 4M1');
    expect(p).not.toBeNull();
    expect(p!.lat).toBeCloseTo(49.2488, 3);
    expect(p!.lng).toBeCloseTo(-122.9805, 3);
  });

  it('returns null (graceful degrade) for an unknown FSA or garbage', () => {
    expect(fsaGeocoder.geocodePostal('V3L 1A1')).toBeNull();
    expect(fsaGeocoder.geocodePostal('garbage')).toBeNull();
  });
});

describe('Burnaby coverage is complete, including the FSA that breaks the pattern', () => {
  // Found in live testing (2026-08-29): a real V3N resident was refused signup by a message that
  // named Burnaby as a covered municipality. V3N is Edmonds / Big Bend in south Burnaby, and it is
  // the ONLY Burnaby FSA that does not start with V5 — which is precisely why a map built by
  // pattern rather than by list missed it.

  it('🔴 maps V3N to Burnaby', () => {
    expect(FSA_REGION.V3N).toBe('bby');
    expect(regionIdForPostal('V3N 1A1')).toBe('bby');
  });

  it('still maps every V5 Burnaby FSA', () => {
    for (const fsa of ['V5A', 'V5B', 'V5C', 'V5E', 'V5G', 'V5H', 'V5J']) {
      expect(FSA_REGION[fsa], fsa).toBe('bby');
    }
  });

  it('does not accidentally claim its New Westminster neighbours', () => {
    // V3L and V3M are New Westminster, not Burnaby. Adding V3N by hand is exactly the moment
    // someone could reach for the neighbouring codes too.
    expect(FSA_REGION.V3L).toBeUndefined();
    expect(FSA_REGION.V3M).toBeUndefined();
  });
});
