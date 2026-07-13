// tests/geo/radius-region.test.ts — Radius + region independence (G-T18-3/4, FR-06/07, BR-07/08, T-03/T-04).

import { describe, it, expect } from 'vitest';
import { RegionHierarchy, matchesRegion } from '../../lib/geo/region';
import { REGIONS, REGION_IDS } from '../../lib/search/__fixtures__/regions';
import { makeFixtureEngine, FIXTURE_NOW } from '../../lib/search/__fixtures__/engine';

const hierarchy = new RegionHierarchy(REGIONS);
const eastVan = { lat: 49.26, lng: -123.07 };

describe('region hierarchy chips (BR-08, T-03)', () => {
  it('selecting Vancouver includes its sub-areas', () => {
    const ids = hierarchy.resolveSelectedIds([REGION_IDS.vancouver]);
    expect(ids.has(REGION_IDS.vanEast)).toBe(true);
    expect(ids.has(REGION_IDS.vanWestSide)).toBe(true);
  });

  it('multi-select chips are additive (union), never a single-select', () => {
    const ids = hierarchy.resolveSelectedIds([REGION_IDS.northVan, REGION_IDS.burnaby]);
    expect(ids.has(REGION_IDS.northVan)).toBe(true);
    expect(ids.has(REGION_IDS.burnaby)).toBe(true);
    expect(ids.has(REGION_IDS.vancouver)).toBe(false);
  });

  it('West Side narrows to sub-area only', () => {
    expect(matchesRegion([REGION_IDS.vancouver, REGION_IDS.vanWestSide, null], hierarchy, [REGION_IDS.vanWestSide])).toBe(true);
    expect(matchesRegion([REGION_IDS.vancouver, REGION_IDS.vanEast, null], hierarchy, [REGION_IDS.vanWestSide])).toBe(false);
  });
});

describe('radius surfaces adjacent municipalities independent of chips (FR-06, T-04)', () => {
  const { engine } = makeFixtureEngine();

  it('East Van origin + 10km returns North Van + Burnaby venues with no chip selected', () => {
    const res = engine.search({
      q: 'open gym',
      now: FIXTURE_NOW,
      origin: { mode: 'near_me', coords: eastVan },
      regionChipIds: [], // deliberately none
      minResults: 1,
    });
    const ids = res.results.map((r) => r.listing.id);
    expect(ids).toContain('l-gymplay-nvan'); // North Van, ~6.7km
    expect(ids).toContain('l-familydropin-bby'); // Burnaby, ~6.7km
  });

  it('selecting the Vancouver chip restricts to Vancouver-tagged listings only', () => {
    const res = engine.search({
      q: 'open gym',
      now: FIXTURE_NOW,
      origin: { mode: 'near_me', coords: eastVan },
      regionChipIds: [REGION_IDS.vancouver],
      minResults: 1,
    });
    const ids = res.results.map((r) => r.listing.id);
    expect(ids).toContain('l-opengym-van');
    expect(ids).not.toContain('l-gymplay-nvan'); // North Van excluded by chip
    expect(ids).not.toContain('l-familydropin-bby'); // Burnaby excluded by chip
  });
});
