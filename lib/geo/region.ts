// lib/geo/region.ts — Region hierarchy chip logic (G-T18-3, BR-07/08, FR-06/07, TSD §5B).
//
// Metro Vancouver → Municipality → Sub-area, held as a `parent_id` tree. Area chips
// are MULTI-SELECT and additive (FR-07): selecting Vancouver includes its sub-areas
// (BR-08); two chips union their results. Radius ranking can still surface adjacent
// municipalities within distance even when not chip-selected (FR-06) — that lives in
// radius.ts and stays independent of these chips. Never a 30-item single-select (BR-07).

import type { GeoPoint } from '../search/types';

export type RegionLevel = 'metro' | 'municipality' | 'sub_area';

/** One `region` row (TSD §6.1). */
export interface Region {
  id: string;
  name: string;
  level: RegionLevel;
  parentId: string | null;
  centroid: GeoPoint;
}

/** Region tree with descendant/ancestor resolution for chip logic. */
export class RegionHierarchy {
  private byId = new Map<string, Region>();
  private childrenOf = new Map<string, string[]>();

  constructor(regions: Region[]) {
    for (const r of regions) {
      this.byId.set(r.id, r);
      if (r.parentId) {
        if (!this.childrenOf.has(r.parentId)) this.childrenOf.set(r.parentId, []);
        this.childrenOf.get(r.parentId)!.push(r.id);
      }
    }
  }

  get(id: string): Region | undefined {
    return this.byId.get(id);
  }

  centroid(id: string): GeoPoint | null {
    return this.byId.get(id)?.centroid ?? null;
  }

  /**
   * Every region at one level, ordered by name. Lets consumers derive the chip vocabulary
   * from the hierarchy itself — the area facet counts (lib/search/facets.ts) use this so the
   * rail's area options can come from the data rather than a hard-coded list in the UI.
   *
   * The ordering is this method's own, deliberately NOT the source's: the live `region`
   * query carries no ORDER BY, so row order there is whatever Postgres returns and could
   * differ between cache refreshes — which would silently reshuffle the area chips in front
   * of a parent. Sorted by name (id as tie-break) it is stable everywhere; a UI that wants a
   * different order (by size, by proximity) has the names and can impose its own.
   */
  atLevel(level: RegionLevel): Region[] {
    return [...this.byId.values()]
      .filter((r) => r.level === level)
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }

  /** A region id + all transitive descendants (Vancouver → its sub-areas). */
  descendantIds(id: string): string[] {
    const out: string[] = [];
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop()!;
      out.push(cur);
      for (const child of this.childrenOf.get(cur) ?? []) stack.push(child);
    }
    return out;
  }

  /**
   * Resolve selected chips (multi-select, additive) to the full set of region ids a
   * listing may be tagged to. Union of each chip's subtree (BR-08). Empty selection →
   * empty set (no region constraint).
   */
  resolveSelectedIds(selectedChipIds: string[]): Set<string> {
    const out = new Set<string>();
    for (const chip of selectedChipIds) {
      for (const id of this.descendantIds(chip)) out.add(id);
    }
    return out;
  }
}

/**
 * Region predicate for a listing given selected chips. A listing matches when any of
 * its region tags (municipality / neighbourhood / display area) is in the resolved set.
 * No chips selected → matches everything (region is a refinement, not a gate).
 */
export function matchesRegion(
  listingRegionTags: Array<string | null>,
  hierarchy: RegionHierarchy,
  selectedChipIds: string[],
): boolean {
  if (selectedChipIds.length === 0) return true;
  const allowed = hierarchy.resolveSelectedIds(selectedChipIds);
  return listingRegionTags.some((t) => t != null && allowed.has(t));
}
