// tests/geo/region-vocabulary.test.ts
//
// THE `region=van` ZERO-RESULT BUG, AND THE TWO HALVES OF ITS FIX.
//
// Reported from a beta click-test: a search for content known to exist returned SIX results,
// and adding `region=van` returned ZERO. Not "narrowed to nothing" — every listing suppressed.
//
// ROOT CAUSE. `region=` carried two incompatible id vocabularies depending on which backend was
// mounted. The fixture hierarchy is keyed by SLUGS ('van', 'bby'); the live `region` table is
// keyed by UUIDs. `van` is not a naive user guess — it is an exported typed union member
// (`CoveredRegionId`), the documented example in /api/search's own doc comment, what
// `regionIdForPostal()` returns on the saved-home path, and what every area chip in the rail
// puts in the URL. In database mode it resolved to the literal string 'van', no listing carried
// that tag, and the region predicate rejected everything.
//
// lib/geo/postal-fsa.ts had already identified this hazard for the saved-home path and routed
// around it in 2026. The search region filter had the same hazard, unguarded.
//
// THE FIX HAS TWO HALVES AND BOTH ARE PINNED HERE:
//   1. TRANSLATE the slug vocabulary to whatever ids the mounted hierarchy uses, so below the
//      region layer exactly one vocabulary exists.
//   2. IGNORE an unrecognised value instead of suppressing everything — because (1) only fixes
//      the values the product emits TODAY, and a typo, a stale shared link or a municipality
//      renamed in the `region` table would walk straight back into the same total blackout.
//
// AND THE ANTI-FIX THIS FILE EXISTS TO REJECT: "region filtering never excludes anything" would
// satisfy every zero-result assertion below while silently deleting the feature. The
// still-filters cases are therefore first-class, not an afterthought.

import { describe, it, expect } from 'vitest';
import { RegionHierarchy, matchesRegion, type Region } from '../../lib/geo/region';
import { REGIONS, REGION_IDS } from '../../lib/search/__fixtures__/regions';
import { REGION_LABEL, regionIdForPostal } from '../../lib/geo/postal-fsa';

/** Fixture-mode hierarchy: ids ARE the slugs. */
const slugHierarchy = new RegionHierarchy(REGIONS);

/**
 * Database-mode hierarchy, built to mirror supabase/seeds/regions.sql exactly: the real UUIDs,
 * the real `name` values, the real parent links. This is the shape `loadPostgresRegionHierarchy`
 * produces from the live table, and it is the shape in which the bug appears at all — which is
 * precisely why no existing unit test caught it. Every route/engine test in the suite mocks
 * `getPostgresRegionHierarchy` with the SLUG fixture, so database mode's id vocabulary was
 * never once exercised.
 */
const UUID = {
  metro: '10000000-0000-0000-0000-000000000001',
  van: '10000000-0000-0000-0000-000000000010',
  nvan: '10000000-0000-0000-0000-000000000011',
  wvan: '10000000-0000-0000-0000-000000000012',
  bby: '10000000-0000-0000-0000-000000000013',
  rmd: '10000000-0000-0000-0000-000000000014',
  vanEast: '10000000-0000-0000-0000-000000000020',
  vanWest: '10000000-0000-0000-0000-000000000021',
};
const centroid = { lat: 49.25, lng: -123.1 };
const DB_REGIONS: Region[] = [
  { id: UUID.metro, name: 'Metro Vancouver', level: 'metro', parentId: null, centroid },
  { id: UUID.van, name: 'Vancouver', level: 'municipality', parentId: UUID.metro, centroid },
  { id: UUID.nvan, name: 'North Vancouver', level: 'municipality', parentId: UUID.metro, centroid },
  { id: UUID.wvan, name: 'West Vancouver', level: 'municipality', parentId: UUID.metro, centroid },
  { id: UUID.bby, name: 'Burnaby', level: 'municipality', parentId: UUID.metro, centroid },
  { id: UUID.rmd, name: 'Richmond', level: 'municipality', parentId: UUID.metro, centroid },
  { id: UUID.vanEast, name: 'East Van', level: 'sub_area', parentId: UUID.van, centroid },
  { id: UUID.vanWest, name: 'West Side', level: 'sub_area', parentId: UUID.van, centroid },
];
const dbHierarchy = new RegionHierarchy(DB_REGIONS);

describe('HALF 1 — the slug vocabulary resolves in database mode (the reported bug)', () => {
  it('THE EXACT FAILING CASE: region=van admits a Vancouver-tagged listing in database mode', () => {
    // Before the fix this was `false`, for every listing, which is how a six-result query
    // became a zero-result page.
    expect(matchesRegion([UUID.van, null, null], dbHierarchy, ['van'])).toBe(true);
  });

  it('every covered slug resolves to the right municipality, and only that one', () => {
    const bySlug: Record<string, string> = {
      van: UUID.van, nvan: UUID.nvan, wvan: UUID.wvan, bby: UUID.bby, rmd: UUID.rmd,
    };
    for (const [slug, uuid] of Object.entries(bySlug)) {
      expect(dbHierarchy.resolveChipId(slug), `${slug} resolves`).toBe(uuid);
      expect(matchesRegion([uuid, null, null], dbHierarchy, [slug]), `${slug} admits its own`).toBe(true);
      // …and does NOT admit a different municipality. A resolver that mapped every slug to the
      // same region (or to "everything") would pass the line above and fail this one.
      const other = uuid === UUID.van ? UUID.bby : UUID.van;
      expect(matchesRegion([other, null, null], dbHierarchy, [slug]), `${slug} rejects others`).toBe(false);
    }
  });

  it('a slug still includes its SUB-AREAS in database mode (BR-08 survives translation)', () => {
    // Translation must land on the region and then take its subtree, not just swap one id.
    expect(matchesRegion([UUID.vanEast, null, null], dbHierarchy, ['van'])).toBe(true);
    expect(matchesRegion([UUID.vanWest, null, null], dbHierarchy, ['van'])).toBe(true);
    // A Burnaby listing is not in Vancouver's subtree.
    expect(matchesRegion([UUID.bby, null, null], dbHierarchy, ['van'])).toBe(false);
  });

  it('translation reads the LIVE table name, so a reseed/rename follows the data', () => {
    // Deliberately NOT hard-coded UUIDs: the same slug resolves to whatever id the mounted
    // hierarchy gives the region called "Vancouver".
    const renamed = new RegionHierarchy(
      DB_REGIONS.map((r) => (r.id === UUID.van ? { ...r, id: 'some-other-id' } : r)),
    );
    expect(renamed.resolveChipId('van')).toBe('some-other-id');
  });

  it('name matching is case/space-insensitive but still municipality-scoped', () => {
    const odd = new RegionHierarchy(
      DB_REGIONS.map((r) => (r.id === UUID.nvan ? { ...r, name: '  north   vancouver ' } : r)),
    );
    expect(odd.resolveChipId('nvan')).toBe(UUID.nvan);
    // A sub_area sharing a municipality's name must never win the lookup.
    const shadowed = new RegionHierarchy([
      { id: 'shadow', name: 'Vancouver', level: 'sub_area', parentId: UUID.metro, centroid },
      ...DB_REGIONS,
    ]);
    expect(shadowed.resolveChipId('van')).toBe(UUID.van);
  });

  it('fixture mode is untouched — a known id is returned verbatim, never name-matched', () => {
    expect(slugHierarchy.resolveChipId(REGION_IDS.vancouver)).toBe(REGION_IDS.vancouver);
    expect(slugHierarchy.resolveChipId(REGION_IDS.vanWestSide)).toBe(REGION_IDS.vanWestSide);
    expect(matchesRegion([REGION_IDS.vancouver, null, null], slugHierarchy, ['van'])).toBe(true);
  });

  it('the saved-postal path and the region filter now speak the same vocabulary end to end', () => {
    // regionIdForPostal returns a slug; that slug must be usable as a region chip in BOTH
    // backends. This is the join that was broken: one half of the product produced slugs while
    // the other half could only consume UUIDs.
    const slug = regionIdForPostal('V6K 1A1');
    expect(slug).toBe('van');
    expect(matchesRegion([UUID.van, null, null], dbHierarchy, [slug!])).toBe(true);
    expect(matchesRegion([REGION_IDS.vancouver, null, null], slugHierarchy, [slug!])).toBe(true);
  });

  it('no third vocabulary was invented — the translated set is exactly REGION_LABEL keys', () => {
    expect(RegionHierarchy.coveredSlugs().sort()).toEqual(Object.keys(REGION_LABEL).sort());
  });
});

describe('HALF 2 — an unrecognised region value is ignored, never a blackout', () => {
  const JUNK = ['not-a-region', 'VANCOUVER-BC', '', '  ', 'van2', '00000000-0000-0000-0000-000000000000'];

  it('junk region values return the unfiltered set in BOTH backends', () => {
    for (const junk of JUNK.filter(Boolean)) {
      expect(matchesRegion([UUID.van, null, null], dbHierarchy, [junk]), `db: ${junk}`).toBe(true);
      expect(matchesRegion([REGION_IDS.burnaby, null, null], slugHierarchy, `slug: ${junk}`.length ? [junk] : [])).toBe(true);
    }
  });

  it('a listing with NO region tags at all is not suppressed by an unrecognised value', () => {
    // The nastiest variant: nothing to match against AND nothing recognised to match with.
    expect(matchesRegion([null, null, null], dbHierarchy, ['not-a-region'])).toBe(true);
  });

  it('a UUID from a DIFFERENT deployment degrades to no filter, not to zero results', () => {
    // The shared-link case. A URL minted against another environment's region table carries
    // ids this one has never seen; it must widen, not blank the page.
    expect(matchesRegion([UUID.bby, null, null], dbHierarchy, ['ffffffff-0000-0000-0000-00000000ffff'])).toBe(true);
  });

  it('a mixed selection keeps the half it understands and drops the half it does not', () => {
    // Partial recognition must not become total permissiveness OR total suppression.
    expect(matchesRegion([UUID.van, null, null], dbHierarchy, ['van', 'garbage'])).toBe(true);
    expect(matchesRegion([UUID.bby, null, null], dbHierarchy, ['van', 'garbage'])).toBe(false);
    expect(dbHierarchy.knownChipIds(['van', 'garbage', 'bby'])).toEqual([UUID.van, UUID.bby]);
  });
});

describe('THE ANTI-FIX GUARD — region filtering still genuinely EXCLUDES', () => {
  // Everything above is satisfiable by `matchesRegion() { return true }`. These are the cases
  // that reject that shortcut. If a future change makes the region filter a no-op, this block
  // is what fails.
  it('a recognised selection excludes every listing outside it — slug ids', () => {
    expect(matchesRegion([REGION_IDS.burnaby, null, null], slugHierarchy, ['van'])).toBe(false);
    expect(matchesRegion([REGION_IDS.richmond, null, null], slugHierarchy, ['van', 'nvan'])).toBe(false);
  });

  it('a recognised selection excludes every listing outside it — UUID ids', () => {
    expect(matchesRegion([UUID.rmd, null, null], dbHierarchy, [UUID.van])).toBe(false);
    expect(matchesRegion([UUID.rmd, null, null], dbHierarchy, ['van', 'bby'])).toBe(false);
  });

  it('a sub-area selection does NOT widen back up to its parent municipality', () => {
    expect(matchesRegion([UUID.van, null, null], dbHierarchy, [UUID.vanWest])).toBe(false);
    expect(matchesRegion([UUID.vanEast, null, null], dbHierarchy, [UUID.vanWest])).toBe(false);
    expect(matchesRegion([UUID.vanWest, null, null], dbHierarchy, [UUID.vanWest])).toBe(true);
  });

  it('an EMPTY selection means "no filter", and that is a different code path from "unrecognised"', () => {
    expect(matchesRegion([UUID.rmd, null, null], dbHierarchy, [])).toBe(true);
  });
});
